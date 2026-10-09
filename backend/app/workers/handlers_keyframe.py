"""Keyframe QC: a cheap vision check of every new keyframe, with one automatic retake when it fails.

The check compares the keyframe with the characters' face references and with the scene's anchor keyframe: face
identity, wardrobe, set and lighting match, extra people, bad hands, and any text or watermark. The scores are stored
on the take (take.qc, shown as a badge on keyframe takes). A failing keyframe is retaken once (setting
keyframe_auto_retake) through the normal jobs and cost path, with what was wrong added to the prompt.
"""
from __future__ import annotations

from typing import Any

from .. import settings_store
from ..agents import prompts
from ..agents import schemas as S
from ..core import budget, jobs as jobs_core, lock as lock_core
from ..db import SessionLocal, utcnow
from ..events import emit
from ..models import Character, Episode, Project, Shot, Take, User
from ..pipeline import approved_stills, faces, scene_look
from ..pipeline.prompting import character_refs, look_of, outfit_for
from ..storage import get_storage
from .worker import GROUP_OF, JobContext, handler

GROUP_OF.setdefault("keyframe_qc", "llm")
jobs_core.JOB_LABELS.setdefault("keyframe_qc", "Keyframe QC")
MAX_KEYFRAME_RETAKES = 1
CARRY = ("hero", "engine", "enhance_take_id", "after_shot")  # what a retake repeats from the job that made the keyframe


def queue_qc(ctx: JobContext, take_id: int, shot_id: int, code: str) -> int | None:
    """After a keyframe job saved its take: check it in a child job, so a run waits for it before making videos.
    A keyframe made inside a video job is left to the video's own QC."""
    if ctx.type != "keyframe":
        return None
    with SessionLocal() as db:
        if not settings_store.get_setting(db, "keyframe_qc"):
            return None
    return ctx.enqueue_child("keyframe_qc", {"take_id": take_id, "retake_count": int(ctx.payload.get("retake_count") or 0),
                                             "source": {k: ctx.payload[k] for k in CARRY if ctx.payload.get(k)}},
                             shot_id=shot_id, label=f"Keyframe QC {code}")


def _issues(obj: S.KeyframeQCOut, identity_ok: bool, wardrobe_ok: bool, set_ok: bool, light_ok: bool) -> list[str]:
    """What went wrong, as short instructions for the retake's prompt."""
    out = []
    if not identity_ok:
        out.append("faces must match each character's own image exactly")
    if not wardrobe_ok:
        out.append("clothes must match the character and scene references")
    if not set_ok:
        out.append("same set and layout as the scene anchor")
    if not light_ok:
        out.append("same light direction, time of day and colour palette as the scene anchor")
    if obj.extra_people:
        out.append("no people other than the characters described")
    if obj.hand_issues:
        out.append("anatomically correct hands with five fingers")
    if obj.text_artifacts:
        out.append("no text, logo or watermark anywhere")
    return out


@handler("keyframe_qc")
def keyframe_qc(ctx: JobContext) -> dict:
    st = get_storage()
    p = ctx.payload
    take_id = int(p["take_id"])
    with SessionLocal() as db:
        take = db.get(Take, take_id)
        if take is None or take.archived or not st.exists(take.path):
            return {"skipped": "the keyframe is gone"}
        shot = db.get(Shot, take.shot_id)
        project = db.get(Project, db.get(Episode, shot.episode_id).project_id)
        ep_row = db.get(Episode, shot.episode_id)
        ep_no = ep_row.number if ep_row else None
        ref_imgs: list[bytes] = []
        names: list[str] = []
        dna: list[str] = []
        embs: list[list[float]] = []
        locks: list[dict] = []
        chars = [c for c in (db.get(Character, int(x)) for x in (shot.characters or [])) if c]
        for ch in chars[:3]:
            look = look_of(db, ch, ep_no)
            locks.append(look["lock"])
            dna.append(f"{ch.name}: {look['dna']}")
            e = approved_stills.char_embedding(db, ch)
            if e:
                embs.append(e)
            for a in character_refs(db, ch, outfit_for(db, shot, ch) or None, 1, ep_no):
                if st.exists(a.path):
                    ref_imgs.append(st.abs(a.path).read_bytes())
                    names.append(f"{ch.name}'s face sheet")
        anchor = scene_look.anchor_for(db, shot)
        anchor_path = scene_look.keyframe_of(db, anchor) if anchor else None
        if anchor_path is not None and anchor_path == st.abs(take.path):
            anchor_path = None
        settings = settings_store.all_settings(db)
        kf_path = st.abs(take.path)
        strict = max((float(L.get("strictness", 0.5)) for L in locks), default=0.5)
        user_id, code = ctx.user_id, shot.code
        shot_id, anchor_id = shot.id, anchor.id if anchor else None
        desc = ". ".join(x for x in (shot.framing, shot.action) if x)
        db.commit()
    order = [f"{i + 1}) {n}" for i, n in enumerate(names)]
    if anchor_path is not None:
        order.append(f"{len(order) + 1}) the scene anchor frame")
    order.append(f"{len(order) + 1}) the still to check")
    prompt = (f"Images: {'; '.join(order)}.\nCharacters expected: {' | '.join(dna) or 'none'}\nShot: {desc or 'n/a'}"
              + ("" if anchor_path is not None else "\nNo anchor frame: score set_match and lighting_match 1.0."))
    images = ref_imgs + ([anchor_path.read_bytes()] if anchor_path is not None else []) + [kf_path.read_bytes()]
    obj, usage = ctx.services.llm_json("keyframe_qc", prompts.KEYFRAME_QC, prompt, S.KeyframeQCOut, images=images,
                                       mock_ctx={"take_id": take_id})
    face = faces.best_match_in_frames([kf_path], embs) if chars and embs else {"available": False}
    thr = lock_core.qc_threshold({"strictness": strict}, float(settings.get("qc_threshold") or 0.7))
    fthr = lock_core.face_threshold({"strictness": strict}, float(settings.get("face_match_threshold") or 0.36))
    kthr = float(settings.get("keyframe_qc_threshold") or 0.6)
    if face.get("available") and face.get("similarity") is not None:
        identity_ok = face["similarity"] >= fthr
    else:
        identity_ok = not chars or obj.identity_match >= thr
    wardrobe_ok = not chars or not settings.get("outfit_qc", True) or obj.wardrobe_match >= kthr
    set_ok = anchor_path is None or obj.set_match >= kthr
    light_ok = anchor_path is None or obj.lighting_match >= kthr
    passed = identity_ok and wardrobe_ok and set_ok and light_ok and not (obj.extra_people or obj.hand_issues or obj.text_artifacts)
    scores = ([obj.identity_match, obj.wardrobe_match] if chars else []) + \
             ([obj.set_match, obj.lighting_match] if anchor_path is not None else [])
    fix = _issues(obj, identity_ok, wardrobe_ok, set_ok, light_ok)
    report: dict[str, Any] = {
        "kind": "keyframe", "checked_at": utcnow().isoformat() + "Z", **obj.model_dump(), "face": face,
        "passed": passed, "score": round(min(scores), 3) if scores else 1.0, "identity_ok": identity_ok,
        "outfit_match": wardrobe_ok, "set_ok": set_ok, "lighting_ok": light_ok, "threshold": thr,
        "face_threshold": fthr, "scene_threshold": kthr, "anchor_shot_id": anchor_id,
        "compared_with_anchor": anchor_path is not None, "fix": fix,
    }
    if not chars:  # nobody to recognise: no identity score on the badge
        report.pop("identity_match", None)
    with SessionLocal() as db:
        take = db.get(Take, take_id)
        take.qc = report
        ctx.cost(usage, db)
        db.commit()
        emit(db, ctx.project_id, "take.updated", {"take_id": take_id, "shot_id": shot_id, "qc": {"passed": passed}})
    retakes = int(p.get("retake_count") or 0)
    if passed or not settings.get("keyframe_auto_retake") or retakes >= MAX_KEYFRAME_RETAKES:
        return {"passed": passed}
    source = dict(p.get("source") or {})
    with SessionLocal() as db:
        project = db.get(Project, project.id)
        user = db.get(User, user_id) if user_id else None
        cost = budget.Estimator(db).image(1, hero=bool(source.get("hero") or source.get("enhance_take_id")))
        chk = budget.check(db, user, project, cost) if user else {"ok": False, "reason": "no requester"}
    if not chk.get("ok"):
        return {"passed": False, "retake": None, "reason": chk.get("reason", "")}
    ctx.enqueue_child("keyframe", {**source, "retake_count": retakes + 1, "fix": fix}, shot_id=shot_id, estimate=cost,
                      label=f"Auto-retake {code} (keyframe)")
    return {"passed": False, "retake": "keyframe"}
