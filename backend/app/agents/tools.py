"""Tools the Director agent can call. Same functions the UI uses, so the agent can do anything a person can."""
from __future__ import annotations

import io
import json
import re
import shutil
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from sqlalchemy.orm import Session

from .. import catalog
from ..core import budget, continuity, dependencies, generation, jobs, lock as lock_core, studio
from ..db import utcnow
from ..models import AgentMessage, Character, Episode, Location, Project, Scene, Shot, Style, User
from ..pipeline import ffmpeg as ff
from ..pipeline.selection import current, is_real, takes
from ..storage import get_storage


@dataclass
class AgentCtx:
    db: Session
    user: User
    project: Project
    episode: Episode | None
    proposals: list[dict] = field(default_factory=list)
    actions: list[str] = field(default_factory=list)
    confirmations: list[dict] = field(default_factory=list)  # actions waiting for the user's OK (would replace work)
    confirmed: bool = False  # set when the user pressed "Yes, do it" on one of those
    plan: list[dict] = field(default_factory=list)  # the agent's working checklist (update_plan), saved on the reply
    steps: list[dict] = field(default_factory=list)  # tool calls this turn: live progress, then a list on the reply
    turn: int = 0  # id of the user's chat message this turn answers (tags the live progress events)
    attachments: list[dict] = field(default_factory=list)  # pictures sent with this turn's message (core/chat_attachments)

    @property
    def copilot(self) -> bool:
        return self.project.agent_mode != "autopilot"

    def ep(self) -> Episode:
        if self.episode is None:
            self.episode = (self.db.query(Episode).filter(Episode.project_id == self.project.id)
                            .order_by(Episode.number).first())
            if self.episode is None:
                self.episode = Episode(project_id=self.project.id, number=1, title="Episode 1")
                self.db.add(self.episode)
                self.db.commit()
        return self.episode

    def shots(self, codes: list[str] | None = None) -> list[Shot]:
        return generation.episode_shots(self.db, self.ep(), codes=[c.upper() for c in codes] if codes else None)

    def submit(self, specs: list[dict], what: str) -> dict:
        if not specs:
            return {"status": "nothing_to_do", "message": f"No {what} needed."}
        res = jobs.submit(self.db, self.user, self.project, specs, propose=self.copilot)
        entry = {"batch_id": res["batch_id"], "status": res["status"], "total_usd": res["total_usd"], "what": what,
                 "count": len(res["jobs"]), "reason": res.get("reason", "")}
        if res["status"] == "proposed":
            self.proposals.append(entry)
        self.actions.append(f"{what}: {res['status']} ({len(res['jobs'])} jobs, ${res['total_usd']:.2f})")
        return entry


def _shot_brief(db: Session, s: Shot, lang: str) -> dict:
    kf, vid = current(db, s.id, "keyframe"), current(db, s.id, "video")
    return {"code": s.code, "dur": s.duration_s, "framing": s.framing, "action": s.action[:120],
            "lines": len((s.dialogue or {}).get(lang) or []), "keyframe": bool(kf), "video": bool(vid),
            "qc": (vid.qc or {}).get("identity_match") if vid else None, "status": s.status}


# ── tool implementations ─────────────────────────────────────────────────────

def get_project_state(c: AgentCtx) -> dict:
    p, ep = c.project, c.ep()
    db = c.db
    return {
        "project": {"title": p.title, "type": p.type, "aspect": p.aspect, "languages": p.languages,
                    "primary_language": p.primary_language, "quality_mode": p.quality_mode, "agent_mode": p.agent_mode},
        "brief": {k: (p.brief or {}).get(k) for k in ("duration_s", "tone", "audience", "key_message")},
        "episode": {"number": ep.number, "title": ep.title, "hooks": len(ep.hooks or []),
                    "selected_hook": ((ep.hooks or [])[ep.selected_hook]["text"] if ep.selected_hook is not None and ep.hooks else None),
                    "script_scenes": len((ep.script or {}).get("scenes", []))},
        "cast": [{"name": ch.name, "locked": ch.locked} for ch in studio.cast(db, p)],
        "locations": [l.name for l in studio.locations(db, p)],
        "shots": [_shot_brief(db, s, p.primary_language) for s in c.shots()][:60],
        "budget": budget.team_status(db),
        "project_spent_usd": round(budget.spent(db, project_id=p.id), 4),
    }


def update_brief(c: AgentCtx, fields: dict | None = None, **kw) -> dict:
    fields = {**(fields or {}), **kw}
    allowed = {"title", "audience", "tone", "duration_s", "key_message", "cta", "notes", "platform"}
    upd = {k: v for k, v in fields.items() if k in allowed}
    if "title" in upd:
        c.project.title = str(upd.pop("title"))[:200]
    c.project.brief = {**(c.project.brief or {}), **upd}
    c.db.commit()
    c.actions.append("brief updated")
    return {"brief": c.project.brief}


def generate_hooks(c: AgentCtx, n: int = 6, angle: str = "") -> dict:
    hooks = studio.generate_hooks(c.db, c.user, c.ep(), int(n or 6), angle or "")
    c.actions.append(f"{len(hooks)} hooks written")
    return {"hooks": [{"index": i, "text": h["text"], "total": h["total"]} for i, h in enumerate(hooks)]}


def select_hook(c: AgentCtx, index: int = 0) -> dict:
    studio.select_hook(c.db, c.ep(), int(index))
    c.actions.append(f"hook #{index} selected")
    return {"ok": True}


def write_script(c: AgentCtx, instructions: str = "", message_id: int = 0, from_message: bool = False) -> dict:
    brief = ""
    if message_id:  # the user's own brief, word for word (run_tool fills message_id in for from_message)
        m = _user_message(c, message_id)
        if m is None:
            return {"error": f"No message #{message_id} from the user in this chat"}
        from ..core import mentions
        brief = ("\n\nThe user's brief in their own words (keep their names, events, places and any lines they wrote):\n"
                 + mentions.plain(m.content)[:30000])
    sc = studio.generate_script(c.db, c.user, c.ep(), (instructions or "") + brief)
    c.actions.append("script written")
    return {"logline": sc.get("logline"), "scenes": len(sc.get("scenes", []))}


def plan_series(c: AgentCtx, episodes: int = 5) -> dict:
    story = studio.generate_series_arc(c.db, c.user, c.project, int(episodes or 5))
    c.actions.append("season planned")
    return {"logline": story.get("logline"), "episodes": [e["title"] for e in story.get("episodes", [])]}


def build_bible(c: AgentCtx) -> dict:
    r = studio.propose_bible(c.db, c.user, c.project, c.ep())
    c.actions.append("bible proposed")
    return r


def breakdown_shots(c: AgentCtx) -> dict:
    shots = studio.breakdown(c.db, c.user, c.ep())
    c.actions.append(f"{len(shots)} shots planned")
    return {"shots": [s["code"] for s in shots], "total_seconds": sum(s["duration_s"] for s in shots)}


def update_shot(c: AgentCtx, shot_code: str, changes: dict | None = None, **kw) -> dict:
    changes = {**(changes or {}), **kw}
    shots = c.shots([shot_code])
    if not shots:
        return {"error": f"No shot {shot_code}"}
    s = shots[0]
    engine = None
    if "engine" in changes:  # only when the user asked for an engine: checked against the Model Hub
        engine = _video_engine(c.db, str(changes.get("engine") or ""))
        if "error" in engine:
            return engine
    if "include" in changes:  # in or out of the cut: not while someone else has the cut checked out
        from fastapi import HTTPException
        from ..core.desktop import check_cut_fields
        try:
            check_cut_fields(c.db, s, c.user, {"include": bool(changes["include"])})
        except HTTPException as e:
            return {"error": str(e.detail)}
    studio.save_revision(c.db, "shot", s, studio.SHOT_FIELDS, c.user)
    for k in ("framing", "camera", "action", "sfx", "music_cue", "mode", "quality_mode", "voice_mode", "notes", "end_note"):
        if k in changes:
            setattr(s, k, str(changes[k]))
    if "duration_s" in changes and int(changes["duration_s"]) in (4, 6, 8):
        s.duration_s = int(changes["duration_s"])
    if "include" in changes:
        s.include = bool(changes["include"])
    if engine is not None:
        s.engine = engine["id"]
    c.db.commit()
    c.actions.append(f"{s.code} updated" + (f" (engine: {engine['name']})" if engine is not None else ""))
    return {"shot": _shot_brief(c.db, s, c.project.primary_language)}


def set_outfit(c: AgentCtx, character: str, outfit: str, description: str = "", regenerate_keyframes: bool = True) -> dict:
    ch = next((x for x in studio.cast(c.db, c.project) if x.name.lower() == character.lower()), None)
    if not ch:
        return {"error": f"No character named {character}"}
    specs = [generation.outfit_spec(c.db, c.project.id, ch, outfit, description or outfit, c.ep().number)]
    affected = []
    for s in c.shots():
        if ch.id in [int(i) for i in (s.characters or [])]:
            s.outfits = {**(s.outfits or {}), str(ch.id): outfit}
            affected.append(s)
    c.db.commit()
    if regenerate_keyframes:
        specs += generation.keyframe_specs(c.db, c.project, affected)
    r = c.submit(specs, f"outfit '{outfit}' for {ch.name} + {len(affected)} keyframes")
    return {**r, "shots": [s.code for s in affected]}


def generate_keyframes(c: AgentCtx, shot_codes: list[str] | None = None) -> dict:
    shots = c.shots(shot_codes or None)
    return c.submit(generation.keyframe_specs(c.db, c.project, shots, only_missing=not shot_codes), "keyframes")


def storyboard_frames(c: AgentCtx, scene_numbers: list[int] | None = None, shot_codes: list[str] | None = None,
                      end_frames: bool = True, sync: bool = False, redo: bool = False) -> dict:
    """Start + end frames of these scenes' shots, in order, each following the one before (core/frames.py). With sync
    each shot of a scene starts exactly on the end frame before, so the clips join without a jump."""
    from ..models import Scene
    shots = c.shots(shot_codes or None)
    if scene_numbers:
        ids = {sc.id for sc in c.db.query(Scene).filter(Scene.episode_id == c.ep().id).all()
               if sc.order + 1 in {int(n) for n in scene_numbers}}
        shots = [s for s in shots if s.scene_id in ids]
    if not shots:
        return {"error": "No shots in those scenes"}
    spec, pl = generation.storyboard_spec(c.db, c.project, c.ep(), shots, end_frames=end_frames, sync=sync, redo=redo)
    if not pl["steps"] and not sync:
        return {"status": "nothing_to_do", "message": "Every start and end frame is already made."}
    what = f"storyboard frames ({pl['images']} images, {pl['copies']} synced copies, {pl['engine_label']})"
    return {**c.submit([spec], what), "frames": [f"{st['code']} {'start' if st['kind'] == 'keyframe' else 'end'}"
                                                 for st in pl["steps"]]}


def generate_videos(c: AgentCtx, shot_codes: list[str] | None = None, quality: str = "") -> dict:
    """Shots that continue another one (a Film Map link, or "continue from the previous shot") are made in link order
    (core/scene_chain.py, as Autopilot and the scene runs do): one run makes them wave by wave, so each linked shot
    starts from the finished clip before it. Shots with no link between them are queued at once, as before."""
    from ..core import scene_chain
    q = quality if quality in catalog.QUALITY_MODES else None
    what = f"videos ({q or 'project default'})"
    shots = c.shots(shot_codes or None)
    if not shot_codes:  # all that still need one
        shots = [s for s in shots if not is_real(current(c.db, s.id, "video"))]
    specs = generation.video_specs(c.db, c.project, shots, q)
    waves = scene_chain.waves(c.db, shots)
    if len(waves) <= 1:
        return c.submit(specs, what)
    from ..core.budget import Estimator
    est, ids = Estimator(c.db), {s.id for s in shots}
    total = sum(sp["estimate"] for sp in specs)
    for s in shots:  # a linked shot's keyframe is remade from the clip before it (make_videos_in_order)
        src, kf = scene_chain.source(c.db, s), current(c.db, s.id, "keyframe")
        uploaded = kf is not None and (kf.provider == "upload" or (kf.params or {}).get("uploaded"))
        if src is not None and src.id in ids and not scene_chain.extends(s) and kf is not None and not kf.stale and not uploaded:
            total += est.image(1)
    ep = c.ep()
    spec = jobs.spec("produce", payload={"steps": ["videos"], "shot_ids": [s.id for s in shots], "quality": q,
                                         "remake": bool(shot_codes),
                                         "items": [{"label": f"Videos in link order · {len(shots)}", "usd": round(total, 4)}]},
                     project_id=c.project.id, episode_id=ep.id, estimate=total,
                     label=f"Videos in link order E{ep.number:02} ({len(shots)} shots)")
    out = c.submit([spec], f"{what} in link order")
    return {**out, "order": [[s.code for s in w] for w in waves],
            "note": "Linked shots are made one wave after another, so each starts from the finished clip it continues."}


def produce_all(c: AgentCtx, steps: list[str] | None = None, quality: str = "", music_per_scene: bool | None = None) -> dict:
    """Produce all, as the Shot list's button does: the steps given (default all), only what is still missing, one
    cost approval for the run. After the videos, steps voices + sound + music + export finish the film.
    music_per_scene: one piece of music per scene following its mood (default: with two or more scenes, unless the
    episode is already scored with one piece)."""
    want = [s for s in generation.PRODUCE_STEPS if s in (steps or generation.PRODUCE_STEPS)]
    if not want:
        return {"error": f"steps must be some of {generation.PRODUCE_STEPS}"}
    q = quality if quality in catalog.QUALITY_MODES else None
    ep = c.ep()
    shots = generation.episode_shots(c.db, ep)
    if not shots:
        return {"error": "The shot list is empty: import the script or plan the shots first."}
    per_scene = generation.music_per_scene_default(c.db, ep) if music_per_scene is None else bool(music_per_scene)
    total, items = generation.produce_plan(c.db, c.project, ep, shots, want, q, c.project.primary_language,
                                           music_per_scene=per_scene)
    if not items:
        return {"status": "nothing_to_do", "message": "Everything in those steps is already made."}
    spec = jobs.spec("produce", payload={"steps": want, "shot_ids": None, "quality": q, "language": None, "items": items,
                                         "music_per_scene": per_scene},
                     project_id=c.project.id, episode_id=ep.id, estimate=total,
                     label=f"Produce all E{ep.number:02} ({len(shots)} shots)")
    out = c.submit([spec], "produce all (" + ", ".join(generation.PRODUCE_LABELS[s].lower() for s in want) + ")")
    notes = [] if "sound" not in want or generation.sound_effects_ready() else [
        "No ElevenLabs key: sound effects come free from the bundled library (recorded effects and synthesized "
        "ambience) for the shots whose script names a sound; the clips' own sound carries the rest."]
    if "voices" in want:
        lang = c.project.primary_language
        notes += generation.lipsync_warnings(c.db, [s for s in shots if budget.Estimator.needs_lipsync(s, c.project, lang)])
    return {**out, "steps": [i["label"] for i in items], **({"notes": notes} if notes else {})}


def voice_and_lipsync(c: AgentCtx, language: str = "", shot_codes: list[str] | None = None) -> dict:
    lang = language or c.project.primary_language
    shots = c.shots(shot_codes or None)
    need = [s for s in shots if budget.Estimator.needs_lipsync(s, c.project, lang)]
    narr = [s for s in shots if (s.narration or {}).get(lang) and s not in need]
    specs = generation.lipsync_specs(c.db, c.project, need, lang) + generation.voice_specs(c.db, c.project, narr, lang)
    return c.submit(specs, f"voices & lip-sync [{lang}]")


def generate_music(c: AgentCtx, prompt: str = "") -> dict:
    return c.submit([generation.music_spec(c.db, c.project, c.ep(), prompt or "")], "music")


def make_animatic(c: AgentCtx, language: str = "") -> dict:
    lang = language or c.project.primary_language
    res = jobs.submit(c.db, c.user, c.project, [generation.render_spec(c.project, c.ep(), lang, "animatic", "draft")])
    c.actions.append(f"animatic [{lang}] queued")
    return {"status": res["status"], "batch_id": res["batch_id"]}


def dub_episode(c: AgentCtx, language: str) -> dict:
    lang = language.lower()[:2] if language.lower()[:2] in catalog.LANGUAGES else next(
        (k for k, v in catalog.LANGUAGES.items() if v["name"].lower() == language.lower()), "")
    if not lang:
        return {"error": f"Unknown language {language}. Use one of {list(catalog.LANGUAGES)}"}
    return c.submit([generation.dub_spec(c.db, c.project, c.ep(), lang)], f"dub → {catalog.LANGUAGES[lang]['name']}")


def export_video(c: AgentCtx, language: str = "", preset: str = "") -> dict:
    lang = language or c.project.primary_language
    preset = preset if preset in catalog.EXPORT_PRESETS else ("youtube" if c.project.aspect == "16:9" else "shorts")
    res = jobs.submit(c.db, c.user, c.project, [generation.render_spec(c.project, c.ep(), lang, "final", preset, {"captions": True})])
    c.actions.append(f"export [{lang}/{preset}] queued")
    return {"status": res["status"], "batch_id": res["batch_id"]}


def edit_clip(c: AgentCtx, shot_code: str, instruction: str) -> dict:
    shots = c.shots([shot_code])
    if not shots:
        return {"error": f"No shot {shot_code}"}
    take = current(c.db, shots[0].id, "video")
    if not take:
        return {"error": f"{shot_code} has no video to edit"}
    return c.submit([generation.omni_edit_spec(c.db, c.project, take, instruction)], f"edit {shot_code}")


def make_cutdowns(c: AgentCtx, count: int = 3, seconds: int = 30) -> dict:
    ids = studio.make_cutdowns(c.db, c.user, c.ep(), int(count or 3), int(seconds or 30))
    c.actions.append(f"{len(ids)} cut-downs created")
    return {"cutdown_episode_ids": ids}


def start_autopilot(c: AgentCtx, through: str = "final") -> dict:
    from ..core import autopilot as ap_def
    est = generation.autopilot_estimate(c.db, c.project, c.ep())
    label = ap_def.MILESTONE_BY_ID.get(through, {}).get("label") or ap_def.STAGE_LABELS.get(through, through)
    spec = jobs.spec("autopilot", payload={"through": through}, project_id=c.project.id, episode_id=c.ep().id,
                     estimate=est, label=f"Autopilot → {label}")
    return c.submit([spec], f"autopilot through '{through}'")


# ── one long prompt: pictures, the user's script, scenes in order, engines ───

def _user_message(c: AgentCtx, message_id: Any) -> AgentMessage | None:
    try:
        m = c.db.get(AgentMessage, int(message_id))
    except (TypeError, ValueError):
        return None
    return m if m is not None and m.project_id == c.project.id and m.role == "user" else None


def read_chat_message(c: AgentCtx, message_id: int, offset: int = 0) -> dict:
    """The full text of one of the user's chat messages (a long brief or script), in pieces of 10,000 characters."""
    from ..core import chat_attachments, mentions
    m = _user_message(c, message_id)
    if m is None:
        return {"error": f"No message #{message_id} from the user in this chat"}
    text = mentions.plain(m.content)
    start = max(0, int(offset or 0))
    piece = text[start: start + 10_000]
    nxt = start + len(piece)
    return {"message_id": m.id, "at": m.created_at.isoformat() + "Z" if m.created_at else None, "chars": len(text),
            "offset": start, "text": piece, "next_offset": nxt if nxt < len(text) else None,
            "attachments": [chat_attachments.placeholder(c.db, a) for a in (m.data or {}).get("attachments") or []]}


def look_at_attachment(c: AgentCtx, attachment_id: Any) -> dict:
    from ..core import chat_attachments as CA
    att = CA.get(c.db, c.project, attachment_id)
    if att is None:
        return {"error": f"No attachment #{attachment_id} in this project's chat"}
    entry = {**CA.out(att), "tag": att.tag or None}
    img = CA.model_jpeg(att)
    images = [(CA.label(c.db, entry), img)] if img else []
    return {"attachment_id": att.id, "name": att.filename, "size": f"{att.width}×{att.height}", "tag": CA.tag_text(c.db, att.tag or None),
            "sent_with_message": att.message_id, "pictures": [label for label, _ in images],
            "message": "" if images else "The picture's file can't be read.", "_images": images}


def add_cast_from_image(c: AgentCtx, attachment_id: Any, name: str, kind: str = "character", description: str = "") -> dict:
    """Make a chat picture the reference of a character, location or prop: found by name in the project (or the one
    the picture was tagged with), else created. Saved exactly like an upload in the Cast step (approved "source")."""
    from ..core import chat_attachments as CA, mentions, reference_images
    from ..models import ProjectProp, Prop, role_rank
    db, p = c.db, c.project
    att = CA.get(db, p, attachment_id)
    if att is None:
        return {"error": f"No attachment #{attachment_id} in this project's chat"}
    kind = (kind or "character").strip().lower()
    if kind not in CA.CAST_KINDS:
        return {"error": "kind must be character, location or prop"}
    name = " ".join((name or "").split())[:120]
    if not name:
        return {"error": "Give the name it should have"}
    data = CA.read_original(att)
    ext = reference_images.sniff(data)
    if not ext:
        return {"error": f"Attachment #{att.id} isn't a PNG, JPG or WEBP picture"}
    row = CA.find_by_name(db, p, kind, name)
    tag = att.tag or {}
    if row is None and tag.get("kind") == kind and tag.get("id") and str(tag.get("name", "")).lower() == name.lower():
        row = CA._entity(db, p, kind, int(tag["id"]))  # the library entry the user picked when tagging it
    created = row is None
    desc = " ".join((description or "").split())[:2000]
    if kind == "character":
        if row is None:
            row = Character(name=name, shared=False, created_by=c.user.id, dna_text=desc or f"{name}: ")
            db.add(row)
            db.flush()
        elif row.locked and role_rank(c.user.role) < role_rank("producer"):
            return {"error": f"{row.name} is locked. Ask a producer to unlock them before adding pictures."}
        elif desc and (row.dna_text or "").strip() in ("", f"{row.name}:"):
            row.dna_text = desc
        studio.link_character(db, p, row)
        db.commit()
        # a chat picture counts as a real person's photo until the user marks it AI-made under Your uploads
        ref = reference_images.save_character_image(db, row, data, ext, user=c.user, label="reference from the Director chat",
                                                    via="director", project_id=p.id)
        saved = f"reference image #{ref.id} (approved)"
    elif kind == "location":
        if row is None:
            row = Location(name=name, description_text=desc or name)
            db.add(row)
            db.flush()
        elif desc and (row.description_text or "").strip() in ("", row.name):
            row.description_text = desc
        studio.link_location(db, p, row)
        db.commit()
        ref = reference_images.save_location_image(db, row, data, ext, label="reference from the Director chat", project_id=p.id)
        saved = f"reference image #{ref.id} (approved)"
    else:
        if row is None:
            row = Prop(name=name, description=desc, shared=False)
            db.add(row)
            db.flush()
        elif desc and not (row.description or "").strip():
            row.description = desc
        if not db.get(ProjectProp, (p.id, row.id)):
            db.add(ProjectProp(project_id=p.id, prop_id=row.id))
        db.commit()
        reference_images.save_prop_image(db, row, data, ext, project_id=p.id)
        saved = "the prop's picture"
    att.tag = {"kind": kind, "id": row.id, "name": row.name, "new": False}
    db.commit()
    c.actions.append(f"{'added' if created else 'updated'} {kind} {row.name} from attachment #{att.id}")
    return {"kind": kind, "id": row.id, "name": row.name, "created": created, "saved": saved,
            "mention": mentions.token(kind, row.id, row.name)}


SHEET_VIEW_NAMES = ("front", "three_quarter", "profile", "full_body", "back")


def make_character_sheets(c: AgentCtx, characters: list[str] | None = None, views: list[str] | None = None) -> dict:
    """Character sheet images (front, three-quarter, full body …) made from each character's reference photo (paid).
    No names = every cast member that has no sheet yet (e.g. only a photo from the chat)."""
    from ..models import CharacterAsset
    db, p = c.db, c.project
    if characters:
        try:
            picked = list(dict.fromkeys(_char(c, n) for n in characters))
        except ValueError as e:
            return {"error": str(e)}
    else:
        picked = [ch for ch in studio.cast(db, p)
                  if not db.query(CharacterAsset).filter(CharacterAsset.character_id == ch.id, CharacterAsset.archived.is_(False),
                                                         CharacterAsset.kind.in_(SHEET_VIEW_NAMES)).count()]
    if not picked:
        return {"status": "nothing_to_do", "message": "Every cast member already has a character sheet."}
    kinds = [v for v in views or [] if v in SHEET_VIEW_NAMES] or ["front", "three_quarter", "full_body"]
    specs = [generation.character_sheet_spec(db, p.id, ch, kinds) for ch in picked]
    out = c.submit(specs, f"character sheets ({', '.join(ch.name for ch in picked)})")
    return {**out, "characters": [ch.name for ch in picked], "views": kinds}


def _script_source(c: AgentCtx, text: str, message_id: Any, start: str, end: str) -> tuple[str, str]:
    """(script text, error): the text given, or a chat message of the user cut between `start` and `end`."""
    from ..core import mentions
    if not (text or "").strip():
        m = _user_message(c, message_id) if message_id else None
        if m is None:
            return "", "Give the script as text, or the chat message it is in (message_id)."
        text = m.content
    text = mentions.plain(text)  # @[Name](character:1) → Name, so the layout parser sees plain speaker names
    for marker, cut in ((start, "start"), (end, "end")):
        marker = (marker or "").strip()
        if not marker:
            continue
        i = text.find(marker)
        if i < 0:
            i = text.lower().find(marker.lower())
        if i < 0:
            return "", f"The {cut} text {marker[:60]!r} isn't in the message: quote it exactly."
        text = text[i:] if cut == "start" else text[: i + len(marker)]
    if not text.strip():
        return "", "The script is empty."
    return text, ""


def import_script(c: AgentCtx, text: str = "", message_id: int = 0, start: str = "", end: str = "", method: str = "auto",
                  create_missing_characters: bool = True) -> dict:
    """The user's own script, laid out word for word as scenes and shots (the Import Wizard): speakers become cast
    (matched to the cast by name, or created), the Story script is written, the shot list replaced."""
    from ..api.board import ImportApplyIn, _match, import_apply
    from ..core import script_import
    if method not in ("auto", "markers", "ai"):
        return {"error": "method must be auto, markers or ai"}
    src, err = _script_source(c, text, message_id, start, end)
    if err:
        return {"error": err}
    db, p, ep = c.db, c.project, c.ep()
    draft = script_import.build_draft(db, c.user, p, src, method)
    mapping: dict[str, Any] = {}
    for ch in draft["characters"]:
        hit = _match(db, p, ch["name"])
        mapping[ch["name"]] = hit["id"] if hit else ("new" if create_missing_characters else "")
    out = import_apply(ep.id, ImportApplyIn(draft=draft["draft"], mapping=mapping, create_missing=create_missing_characters),
                       c.user, db)
    st = draft["stats"]
    c.actions.append(f"script imported ({st.get('scenes')} scenes, {st.get('shots')} shots)")
    return {"scenes": st.get("scenes"), "shots": st.get("shots"), "lines": st.get("lines"), "method": draft.get("method"),
            "warnings": draft.get("warnings") or [], "cast": {n: i for n, i in (out.get("characters") or {}).items()},
            "created_characters": [x["name"] for x in out.get("created") or []],
            "shot_codes": [s.code for s in c.shots()][:80]}


def generate_scenes(c: AgentCtx, scenes: list[int] | None = None, quality: str = "", link_scenes: str = "auto",
                    fix_links: bool = False, pause_after_each_scene: bool = False, plan_only: bool = False) -> dict:
    """Make the videos scene by scene with continuity carried forward (the scene_chain job)."""
    from ..core import scene_chain
    db, p, ep = c.db, c.project, c.ep()
    rows = db.query(Scene).filter(Scene.episode_id == ep.id).order_by(Scene.order, Scene.id).all()
    if not rows:
        return {"error": "No scenes yet: import or write the script, then breakdown_shots."}
    nums = sorted({int(n) for n in scenes or []})
    bad = [n for n in nums if not 1 <= n <= len(rows)]
    if bad:
        return {"error": f"There are {len(rows)} scenes; pick 1..{len(rows)}"}
    picked = [rows[n - 1] for n in nums] if nums else rows
    if link_scenes not in scene_chain.LINK_SCENES:
        return {"error": "link_scenes must be auto, always or never"}
    q = quality if quality in catalog.QUALITY_MODES else None
    plan = scene_chain.plan(db, p, ep, picked, q, bool(fix_links), link_scenes)
    if plan_only or not plan["shots_to_make"]:
        return {**plan, "submitted": False,
                **({"message": "Every shot in these scenes already has its video."} if not plan["shots_to_make"] else {})}
    spec = jobs.spec("scene_chain", payload={"scene_ids": [s.id for s in picked], "quality": q, "fix_links": bool(fix_links),
                                             "link_scenes": link_scenes, "pause_after_each": bool(pause_after_each_scene)},
                     project_id=p.id, episode_id=ep.id, estimate=plan["total_usd"],
                     label=f"Scenes {', '.join(str(s.order + 1) for s in picked)} in order")
    res = c.submit([spec], f"scenes {', '.join(str(s.order + 1) for s in picked)} in order")
    return {**res, "scenes": [{k: s[k] for k in ("scene", "title", "shots", "notes", "usd")} for s in plan["scenes"]],
            "shots_to_make": plan["shots_to_make"]}


VIDEO_MODES = {"t2v", "i2v", "ref2v", "flf", "a2v"}
_ENGINE_FILLER = {"the", "model", "engine", "on", "via", "with", "use", "using", "video", "videos", "by"}


def _video_engine(db: Session, text: str) -> dict:
    """A video engine of the Model Hub from what the user called it ("Seedance 2.0 on BytePlus", an id, "auto").
    {id, name, provider, alternatives} or {error}. A hand-picked engine is used as picked (the Hub's rules)."""
    from ..core import model_hub
    from ..models import AIModel
    from ..providers.services import provider_mode
    raw = " ".join(str(text or "").split())
    low = raw.lower()
    if low in ("", "auto", "automatic", "default"):
        return {"id": "auto", "name": "Automatic (the team's engine policy)", "provider": "", "alternatives": []}
    rows = [m for m in db.query(AIModel).filter(AIModel.task.in_(("video", "avatar")), AIModel.status != "retired").all()
            if set((m.capabilities or {}).get("modes") or []) & VIDEO_MODES]
    hits = [m for m in rows if m.id.lower() == low]
    if not hits:
        words = [w for w in re.split(r"[\s()/,:]+", low) if w and w not in _ENGINE_FILLER]
        hits = [m for m in rows if words and all(w in f"{m.id} {m.display_name} {m.family} {m.provider} {m.maker}".lower()
                                                 for w in words)]
    if not hits:
        usable = sorted({m.display_name for m in rows if m.status == "enabled" and provider_mode(m.provider) != "missing"})
        return {"error": f"No video engine matches {raw!r}. Engines you can pick: {', '.join(usable[:15])}"}
    hits.sort(key=lambda m: (low not in (m.display_name.lower(), (m.family or "").lower()), m.status != "enabled",
                             provider_mode(m.provider) == "missing", not m.builtin, model_hub.PROVIDER_RANK.get(m.provider, 9),
                             len(m.display_name), m.display_name))
    m = hits[0]
    if provider_mode(m.provider) == "missing":
        return {"error": f"{m.display_name} can't run here: there is no {m.provider} API key (an admin adds it in Settings → AI services)."}
    if (m.capabilities or {}).get("usable") is False:
        return {"error": f"{m.display_name} can't be used for shots yet (see the Model Hub)."}
    return {"id": m.id, "name": m.display_name, "provider": m.provider,
            "alternatives": [f"{h.display_name} ({h.id})" for h in hits[1:6]]}


def set_video_engine(c: AgentCtx, engine: str, shot_codes: list[str] | None = None, scene: int = 0) -> dict:
    """Make these shots (a scene's, or every shot of the episode) with one video engine; "auto" goes back to the
    team's policy. Only when the user asked for an engine."""
    pick = _video_engine(c.db, engine)
    if "error" in pick:
        return pick
    if scene:
        rows = c.db.query(Scene).filter(Scene.episode_id == c.ep().id).order_by(Scene.order, Scene.id).all()
        if not 1 <= int(scene) <= len(rows):
            return {"error": f"There are {len(rows)} scenes; pick 1..{len(rows)}"}
        shots = [s for s in c.shots() if s.scene_id == rows[int(scene) - 1].id]
    else:
        shots = c.shots(shot_codes or None)
        missing = sorted({x.upper() for x in shot_codes or []} - {s.code for s in shots})
        if missing:
            return {"error": f"No shot {', '.join(missing)} in this episode"}
    if not shots:
        return {"error": "There are no shots yet: import or write the script and plan the shots first."}
    for s in shots:
        if s.engine != pick["id"]:
            studio.save_revision(c.db, "shot", s, studio.SHOT_FIELDS, c.user)
            s.engine = pick["id"]
    c.db.commit()
    c.actions.append(f"video engine {pick['name']} on {len(shots)} shot{'' if len(shots) == 1 else 's'}")
    from ..core.budget import Estimator
    est = Estimator(c.db)
    return {"engine": pick["id"], "name": pick["name"], "provider": pick["provider"], "shots": [s.code for s in shots],
            "estimate_usd_all_shots": round(sum(est.video(s, c.project) for s in shots), 2),
            "alternatives": pick["alternatives"],
            "note": "Videos made from now on use it; finished takes stay as they are."}


# ── confirmation for actions that replace work ───────────────────────────────
# Free actions run at once, but these would overwrite or pile onto what the user already has, so the Director asks
# first (in both approval modes: this is about the user's work, not money).

def _char(c: AgentCtx, name: str) -> Character:
    low = (name or "").strip().lower()
    for ch in studio.cast(c.db, c.project):
        if ch.name.strip().lower() == low or ch.name.strip().lower().split()[0] == low.split()[0]:
            return ch
    raise ValueError(f"No cast member called {name!r}")


def continuity_state(c: AgentCtx, scene_number: int = 1) -> dict:
    """Write the Continuity Bible entry (state at the end of a scene) with AI."""
    from ..models import Scene
    sc = (c.db.query(Scene).filter(Scene.episode_id == c.ep().id).order_by(Scene.order, Scene.id).all())
    if not sc or scene_number < 1 or scene_number > len(sc):
        return {"error": f"There are {len(sc)} scenes; pick 1..{len(sc)}"}
    state = continuity.end_state(c.db, c.user, c.project, c.ep(), sc[scene_number - 1])
    c.actions.append(f"continuity state written for scene {scene_number}")
    return state


def wardrobe_report(c: AgentCtx) -> dict:
    """Who wears what in every scene, and where an outfit changes without the script saying so."""
    return continuity.wardrobe_timeline(c.db, c.project, c.ep())


def impact_report(c: AgentCtx) -> dict:
    """Everything stale after recent edits (keyframes, videos, voices, lip-syncs) and what redoing it costs."""
    return dependencies.impact(c.db, c.project, c.ep())


def regenerate_stale(c: AgentCtx, shot_codes: list[str] | None = None) -> dict:
    ids = [s.id for s in c.shots(shot_codes)] if shot_codes else None
    specs = dependencies.regenerate_specs(c.db, c.project, c.ep(), ids)
    return c.submit(specs, "regenerate stale takes")


def next_shot(c: AgentCtx, shot_code: str, action: str = "", mode: str = "last_frame", generate: bool = False) -> dict:
    """Add the shot after `shot_code` with the same cast/wardrobe/location, linked by last frame, as an extension, or
    starting exactly on its end frame (end_frame)."""
    src = next((s for s in c.shots([shot_code])), None)
    if not src:
        return {"error": f"No shot {shot_code}"}
    n = studio.add_next_shot(c.db, src, action, mode=mode)
    c.db.commit()
    c.actions.append(f"added {n.code} after {src.code} ({mode})")
    out: dict = {"shot": _shot_brief(c.db, n, c.project.primary_language), "code": n.code}
    if generate:
        out["jobs"] = c.submit(generation.video_specs(c.db, c.project, [n]), f"video {n.code}")
    return out


def lock_character(c: AgentCtx, character: str, lock: dict | None = None, **kw) -> dict:
    """Set the Character Lock (face, body, skin_hair, voice, costume_continuity, gestures, age, lighting, strictness)."""
    ch = _char(c, character)
    data = {**(lock or {}), **kw}
    ch.lock = {k: v for k, v in {**(ch.lock or {}), **data}.items() if k in lock_core.DEFAULT}
    c.db.commit()
    c.actions.append(f"lock updated for {ch.name}")
    return {"character": ch.name, "lock": lock_core.effective(ch), "prompt_text": lock_core.prompt_text(ch)}


def freeze_look(c: AgentCtx, character: str, label: str = "", episode_from: int | None = None, episode_to: int | None = None,
                dna_text: str = "", voice_description: str = "") -> dict:
    """Freeze the character's current look as a version for a range of episodes (how a character ages or changes)."""
    from ..models import CharacterAsset, CharacterVersion
    ch = _char(c, character)
    last = (c.db.query(CharacterVersion).filter(CharacterVersion.character_id == ch.id)
            .order_by(CharacterVersion.version.desc()).first())
    approved = [a.id for a in c.db.query(CharacterAsset).filter(CharacterAsset.character_id == ch.id, CharacterAsset.archived.is_(False),
                                                               CharacterAsset.approved.is_(True)).all()]
    v = CharacterVersion(character_id=ch.id, version=(last.version + 1) if last else 1, label=label or f"v{(last.version + 1) if last else 1}",
                         episode_from=episode_from, episode_to=episode_to, dna_text=dna_text or ch.dna_text,
                         voice_description=voice_description or ch.voice_description, lock=dict(ch.lock or {}), asset_ids=approved,
                         identity=dict(ch.identity or {}), created_by=c.user.id)
    c.db.add(v)
    ch.version = v.version
    c.db.commit()
    c.actions.append(f"froze {ch.name} as {v.label}")
    return v.to_dict()


def add_costume(c: AgentCtx, character: str, name: str, description: str = "", episode_from: int | None = None,
                episode_to: int | None = None, generate: bool = True) -> dict:
    """Give a character a named outfit (3-angle turnaround generated when `generate`)."""
    from ..models import Costume
    ch = _char(c, character)
    row = c.db.query(Costume).filter(Costume.character_id == ch.id, Costume.name == name, Costume.archived.is_(False)).first()
    if row is None:
        row = Costume(character_id=ch.id, name=name)
        c.db.add(row)
    row.description, row.episode_from, row.episode_to = description, episode_from, episode_to
    c.db.commit()
    out: dict = {"costume": row.to_dict()}
    if generate:
        scope = episode_from if episode_from == episode_to else None
        out["jobs"] = c.submit([generation.outfit_spec(c.db, c.project.id, ch, name, description, scope)], f"outfit {name}")
    return out


def set_dialogue_route(c: AgentCtx, method: str = "native", native_languages: list[str] | None = None) -> dict:
    """How dialogue is made for this project: native (Veo speaks the line itself, voice + lips in one pass),
    audio_first (locked TTS voice + lip-sync), audio_driven, voice_lock."""
    if method not in ("native", "audio_first", "audio_driven", "voice_lock", "native_when_possible"):
        return {"error": "method must be native, audio_first, audio_driven, voice_lock or native_when_possible"}
    brief = dict(c.project.brief or {})
    brief["dialogue_method"] = method
    if native_languages is not None:
        brief["native_languages"] = [x for x in native_languages if x in catalog.LANGUAGES]
    c.project.brief = brief
    c.db.commit()
    c.actions.append(f"dialogue route: {method}")
    return {"dialogue_method": method, "native_languages": brief.get("native_languages")}


# ── reading: the Director looks before it changes anything ───────────────────

def _clip(s: Any, n: int) -> str:
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _lang_of(language: str) -> str:
    """A language code from "kn", "kn-IN" or "Kannada" ("" when unknown)."""
    low = (language or "").strip().lower()
    if low in catalog.LANGUAGES or (low[:2] in catalog.LANGUAGES and low[2:3] in ("-", "_")):
        return low[:2]
    return next((k for k, v in catalog.LANGUAGES.items() if v["name"].lower() == low), "")


def _names(db: Session, ids: list[Any] | None) -> list[str]:
    out = []
    for i in ids or []:
        ch = db.get(Character, int(i)) if str(i).isdigit() else None
        out.append(ch.name if ch else str(i))
    return out


def _lines(db: Session, lines: list[dict] | None) -> list[dict]:
    return [{"character": "NARRATOR" if l.get("character_id") == "NARRATOR" else _names(db, [l.get("character_id")])[0],
             "line": l.get("line", ""), "emotion": l.get("emotion", "")} for l in lines or []]


def _qc(qc: dict | None) -> dict | None:
    """The useful part of a QC report: passed or not, the scores, what is wrong and what to fix."""
    if not qc:
        return None
    flags = [k.replace("_", " ") for k in ("extra_people", "hand_issues", "text_artifacts") if qc.get(k)]
    if qc.get("matches_action") is False:
        flags.append("action doesn't match the shot")
    fix = qc.get("fix")
    out: dict[str, Any] = {"passed": qc.get("passed"), "score": qc.get("score"), "identity": qc.get("identity_match"),
                           "wardrobe": qc.get("wardrobe_match"), "set": qc.get("set_match"), "lighting": qc.get("lighting_match"),
                           "notes": qc.get("notes"), "fix": "; ".join(fix) if isinstance(fix, list) else fix, "flags": flags}
    if qc.get("lipsync"):
        out["lipsync"] = {"sync": qc["lipsync"].get("sync_score"), "notes": qc["lipsync"].get("notes")}
    if qc.get("words"):
        out["words"] = {k: qc["words"].get(k) for k in ("heard", "language", "word_match", "notes")}
    return {k: v for k, v in out.items() if v not in (None, "", [])}


def read_script(c: AgentCtx, scene: int = 0) -> dict:
    from ..core import mentions
    ep = c.ep()
    script = mentions.plain_script(ep.script or {})
    scenes = script.get("scenes") or []
    if not scenes:
        return {"episode": ep.number, "script": None, "message": "No script yet: write_script writes one."}
    scene = int(scene or 0)
    if scene and not 1 <= scene <= len(scenes):
        return {"error": f"There are {len(scenes)} scenes; pick 1..{len(scenes)}"}
    hook = (ep.hooks or [])[ep.selected_hook]["text"] if ep.selected_hook is not None and ep.hooks else None
    critic = ep.critic or {}
    out: dict[str, Any] = {
        "episode": ep.number, "title": ep.title, "language": c.project.primary_language, "logline": script.get("logline"),
        "beats": script.get("beats") or [], "hook": hook, "scenes_total": len(scenes),
        "scenes": [{"scene": i, "title": sc.get("title"), "location": sc.get("location"), "time_of_day": sc.get("time_of_day"),
                    "summary": sc.get("summary"), "action": sc.get("action"), "lines": sc.get("lines") or []}
                   for i, sc in enumerate(scenes, 1) if not scene or i == scene],
        "last_review": {"overall": critic.get("overall"), "problems": (critic.get("problems") or [])[:5]} if critic else None,
    }
    if not scene and len(json.dumps(out, ensure_ascii=False)) > 11000:  # too long for one result: the outline first
        for s in out["scenes"]:
            s["line_count"] = len(s.pop("lines"))
            s.pop("action")
        out["note"] = "Long script: this is the outline. Call read_script with scene=N for a scene's action and lines."
    return out


def read_shot(c: AgentCtx, shot_code: str) -> dict:
    s = next(iter(c.shots([shot_code])), None)
    if not s:
        return {"error": f"No shot {shot_code}"}
    db, p = c.db, c.project
    loc = db.get(Location, s.location_id) if s.location_id else None
    sc = db.get(Scene, s.scene_id) if s.scene_id else None
    src = db.get(Shot, s.continuity_from_shot_id) if s.continuity_from_shot_id else None
    return {
        "code": s.code, "scene": sc.order + 1 if sc else None, "scene_title": sc.title if sc else None,
        "duration_s": s.duration_s, "framing": s.framing, "camera": s.camera, "action": s.action,
        "characters": _names(db, s.characters), "location": loc.name if loc else None,
        "outfits": dict(zip(_names(db, list(s.outfits or {})), (s.outfits or {}).values())),
        "dialogue": {lang: _lines(db, ls) for lang, ls in (s.dialogue or {}).items() if ls},
        "narration": {lang: t for lang, t in (s.narration or {}).items() if t},
        "mode": s.mode, "quality": s.quality_mode or p.quality_mode, "voice_mode": s.voice_mode, "engine": s.engine,
        "sfx": s.sfx, "music_cue": s.music_cue, "notes": s.notes, "status": s.status,
        "continues_from": f"{src.code} ({s.continuity_mode})" if src else ("the shot before" if s.continuity_from_prev else None),
        "takes": {kind: [{"take": t.id, "selected": t.selected, "engine": (t.params or {}).get("engine_label") or t.model,
                          "stale": t.stale, "usd": round(t.cost_usd or 0, 3), "qc": _qc(t.qc)} for t in takes(db, s.id, kind)[:3]]
                  for kind in ("keyframe", "video")},
    }


def read_bible(c: AgentCtx) -> dict:
    db, p = c.db, c.project
    style = db.get(Style, p.style_id) if p.style_id else None
    return {
        "cast": [{"name": ch.name, "role": ch.role, "age": ch.age, "gender": ch.gender, "look": ch.dna_text,
                  "voice": ch.voice_description, "locked": ch.locked, "lock": lock_core.prompt_text(ch).strip() or None}
                 for ch in studio.cast(db, p)],
        "locations": [{"name": l.name, "description": l.description_text} for l in studio.locations(db, p)],
        "style": {k: getattr(style, k) for k in ("name", "look", "lens", "grade", "grain", "avoid_list")} if style else None,
    }


# ── seeing: keyframes and video frames as small pictures ─────────────────────
# The pictures ride along under "_images" as (label, JPEG bytes): the Claude loop sends them as image blocks; engines
# that only take text get the result without them (for_json).

LOOK_EDGE, LOOK_QUALITY, LOOK_MAX = 768, 70, 4  # the stored conversation keeps every picture, so they stay small


def _jpeg(path: Any) -> bytes | None:
    try:
        from PIL import Image
        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((LOOK_EDGE, LOOK_EDGE))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=LOOK_QUALITY)
        return buf.getvalue()
    except Exception:  # an unreadable file just isn't shown
        return None


def look_at_shot(c: AgentCtx, shot_code: str) -> dict:
    s = next(iter(c.shots([shot_code])), None)
    if not s:
        return {"error": f"No shot {shot_code}"}
    st = get_storage()
    kf, vid = current(c.db, s.id, "keyframe"), current(c.db, s.id, "video")
    images: list[tuple[str, bytes]] = []
    note = ""
    if kf and st.exists(kf.path):
        img = _jpeg(st.abs(kf.path))
        if img:
            images.append((f"{s.code} keyframe (take {kf.id})", img))
    if vid and st.exists(vid.path):
        tmp = st.tmp_dir()
        try:
            for i, f in enumerate(ff.extract_frames(st.abs(vid.path), tmp, 3), 1):
                img = _jpeg(f)
                if img:
                    images.append((f"{s.code} video, frame {i} of 3 (take {vid.id})", img))
        except (ff.FFmpegError, OSError) as e:
            note = f"Couldn't read frames from the video: {_clip(e, 200)}"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    images = images[:LOOK_MAX]
    return {
        "code": s.code, "framing": s.framing, "camera": s.camera, "action": s.action, "characters": _names(c.db, s.characters),
        "keyframe": {"take": kf.id, "stale": kf.stale, "qc": _qc(kf.qc)} if kf else None,
        "video": {"take": vid.id, "stale": vid.stale, "qc": _qc(vid.qc)} if vid else None,
        "pictures": [label for label, _ in images],
        "message": note or ("" if images else "Nothing to look at yet: this shot has no keyframe or video."),
        "_images": images,
    }


def for_json(out: Any) -> Any:
    """A tool result for an engine that only takes text: the pictures are left out, with a note saying so."""
    if not isinstance(out, dict) or "_images" not in out:
        return out
    n = len(out["_images"] or [])
    out = {k: v for k, v in out.items() if k != "_images"}
    if n:
        out["pictures_omitted"] = f"{n} picture(s) left out: this AI engine can't see them here. Judge from the QC notes."
    return out


# ── writers' room: cheap text passes that review and improve the writing ─────

def critique_script(c: AgentCtx) -> dict:
    ep = c.ep()
    if not (ep.script or {}).get("scenes"):
        return {"error": "There is no script yet: write_script first."}
    r = studio.critique(c.db, c.user, ep)
    studio.save_script_version(c.db, ep, "critic", c.user, note=f"Critic score {r['overall']}", critic=r)
    c.db.commit()
    c.actions.append(f"script reviewed ({r['overall']}/10)")
    return {"overall": r["overall"], "scores": r["scores"], "problems": r["problems"][:8], "strengths": r["strengths"][:4],
            "rewrite_instructions": _clip(r["rewrite_instructions"], 1200)}


def check_continuity(c: AgentCtx) -> dict:
    if not c.shots():
        return {"error": "There are no shots yet: breakdown_shots first."}
    r = studio.continuity_check(c.db, c.user, c.ep())
    rank = {"high": 0, "medium": 1, "low": 2}
    issues = sorted(r.get("issues") or [], key=lambda i: rank.get(str(i.get("severity")).lower(), 3))
    c.actions.append(f"continuity checked ({len(issues)} issue{'' if len(issues) == 1 else 's'})")
    return {"ok": r.get("ok"), "issues_total": len(issues), "issues": issues[:12]}


def plan_scene_cards(c: AgentCtx) -> dict:
    ep = c.ep()
    if not (ep.script or {}).get("scenes"):
        return {"error": "There is no script yet: write_script first."}
    cards = studio.plan_scene_cards(c.db, c.user, ep)
    c.actions.append(f"{len(cards)} scene cards planned")
    return {"scenes": [{"scene": sc["order"] + 1, "title": sc["title"], "goal": _clip(sc["goal"], 160),
                        "turn": _clip(sc["turn"], 160), "emotion": sc["emotion"], "characters": _names(c.db, sc["characters"]),
                        "coverage": (sc.get("coverage") or [])[:8]} for sc in cards]}


def _has_lines(s: Shot, lang: str) -> bool:
    return bool((s.dialogue or {}).get(lang) or (s.narration or {}).get(lang))


def polish_dialogue(c: AgentCtx, language: str = "") -> dict:
    lang = _lang_of(language) if language else c.project.primary_language
    if not lang:
        return {"error": f"Unknown language {language}. Use one of {list(catalog.LANGUAGES)}"}
    name = studio.lang_name(lang)
    shots = [s for s in c.shots() if _has_lines(s, lang)]
    if not shots:
        return {"error": f"There are no {name} lines to polish yet."}
    for s in shots:  # the lines are rewritten in place: keep each shot's old version for Undo
        studio.save_revision(c.db, "shot", s, studio.SHOT_FIELDS, c.user)
    n = studio.native_polish(c.db, c.user, c.ep(), lang)
    c.actions.append(f"{n} {name} lines polished")
    return {"language": lang, "lines_polished": n}


def localize_script(c: AgentCtx, language: str, overwrite: bool = False) -> dict:
    lang = _lang_of(language)
    if not lang:
        return {"error": f"Unknown language {language}. Use one of {list(catalog.LANGUAGES)}"}
    name = studio.lang_name(lang)
    if lang == c.project.primary_language:
        return {"error": f"{name} is the project's main language: there is nothing to translate."}
    kept = 0 if overwrite else sum(1 for s in c.shots() if _has_lines(s, lang))
    n = studio.localize(c.db, c.user, c.ep(), lang, overwrite=bool(overwrite))
    if n:
        c.actions.append(f"{n} lines translated into {name}")
    return {"language": lang, "lines_translated": n, "shots_kept_as_they_were": kept,
            **({"message": f"Shots that already had {name} lines were kept; pass overwrite=true to redo them."} if kept else {})}


MARKETING_PLATFORMS = ["youtube_shorts", "instagram_reels", "youtube", "facebook", "whatsapp_status"]


def marketing_copy(c: AgentCtx, platforms: list[str] | None = None, languages: list[str] | None = None) -> dict:
    p = c.project
    plats = [x for x in platforms or [] if x in MARKETING_PLATFORMS] or (
        ["youtube"] if p.aspect == "16:9" else ["youtube_shorts", "instagram_reels"])
    langs = [x for x in (_lang_of(x) for x in languages or []) if x] or list(p.languages or [p.primary_language])
    pack = studio.marketing_copy(c.db, c.user, c.ep(), plats, langs)
    copies = pack.get("copies") or []
    c.actions.append(f"marketing copy written ({len(copies)} platform/language set{'' if len(copies) == 1 else 's'})")
    return {"copies": [{"platform": x.get("platform"), "language": x.get("language"), "titles": (x.get("titles") or [])[:3],
                        "description": _clip(x.get("description"), 300), "hashtags": (x.get("hashtags") or [])[:8],
                        "pinned_comment": _clip(x.get("pinned_comment"), 200)} for x in copies[:8]],
            "thumbnails": [{"concept": _clip(t.get("concept"), 160), "overlay_text": t.get("overlay_text")}
                           for t in (pack.get("thumbnails") or [])[:3]],
            "posting_tips": (pack.get("posting_tips") or [])[:4]}


# ── the working plan and project memory ──────────────────────────────────────

PLAN_STATUSES = ("todo", "doing", "done")
MEMORY_MAX, MEMORY_CHARS = 40, 300


def update_plan(c: AgentCtx, steps: list | None = None) -> dict:
    plan = []
    for s in (steps or [])[:12]:
        s = {"text": s} if isinstance(s, str) else s
        if isinstance(s, dict) and _clip(s.get("text"), 140):
            plan.append({"text": _clip(s.get("text"), 140), "status": s.get("status") if s.get("status") in PLAN_STATUSES else "todo"})
    c.plan = plan
    return {"ok": True, "steps": len(plan), "done": sum(1 for s in plan if s["status"] == "done")}


def remember(c: AgentCtx, note: str) -> dict:
    text = _clip(note, MEMORY_CHARS)
    if not text:
        return {"error": "The note is empty."}
    notes = list(c.project.agent_memory or [])
    if any(str(n.get("text", "")).lower() == text.lower() for n in notes):
        return {"ok": True, "message": "Already in project memory.", "notes": len(notes)}
    if len(notes) >= MEMORY_MAX:
        return {"error": f"Project memory is full ({MEMORY_MAX} notes). Forget one that no longer matters first."}
    notes.append({"text": text, "at": utcnow().isoformat() + "Z", "by": c.user.name or c.user.email})
    c.project.agent_memory = notes  # a new list, so the JSON column is saved
    c.db.commit()
    c.actions.append(f"noted: {_clip(text, 80)}")
    return {"ok": True, "index": len(notes), "notes": len(notes)}


def forget(c: AgentCtx, index: int) -> dict:
    notes = list(c.project.agent_memory or [])
    i = int(index)
    if not 1 <= i <= len(notes):
        return {"error": f"There are {len(notes)} notes; pick 1..{len(notes)}" if notes else "Project memory is empty."}
    gone = notes.pop(i - 1)
    c.project.agent_memory = notes
    c.db.commit()
    c.actions.append(f"forgot: {_clip(gone.get('text'), 80)}")
    return {"ok": True, "forgot": gone.get("text"), "notes": len(notes)}


def memory_text(project: Project) -> str:
    """The project's saved notes for the Director's turn context ("" when there are none)."""
    notes = [n for n in project.agent_memory or [] if isinstance(n, dict) and n.get("text")]
    if not notes:
        return ""
    return ("Project memory (notes you saved earlier; forget(index) removes one):\n"
            + "\n".join(f"{i}. {n['text']}" for i, n in enumerate(notes, 1)))


# ── live progress labels ─────────────────────────────────────────────────────

_LABELS = {
    "get_project_state": "Checking the project", "read_script": "Reading the script", "read_bible": "Reading the cast and locations",
    "update_brief": "Updating the brief", "generate_hooks": "Writing hooks", "select_hook": "Choosing a hook",
    "write_script": "Writing the script", "plan_series": "Planning the season", "build_bible": "Building the bible",
    "breakdown_shots": "Planning the shots", "generate_keyframes": "Setting up keyframes", "generate_videos": "Setting up videos",
    "storyboard_frames": "Setting up storyboard frames",
    "voice_and_lipsync": "Setting up voices and lip-sync", "generate_music": "Setting up music",
    "make_animatic": "Rendering an animatic", "export_video": "Rendering the export", "make_cutdowns": "Cutting shorts",
    "start_autopilot": "Setting up Autopilot", "wardrobe_report": "Checking the wardrobe", "impact_report": "Checking what is stale",
    "regenerate_stale": "Setting up redos of stale takes", "set_dialogue_route": "Setting the dialogue route",
    "critique_script": "Reviewing the script", "check_continuity": "Checking continuity", "plan_scene_cards": "Planning scene cards",
    "marketing_copy": "Writing marketing copy", "update_plan": "Updating the plan", "remember": "Saving a note to project memory",
    "forget": "Removing a note from project memory", "web_search": "Searching the web",
    "import_script": "Importing your script", "generate_scenes": "Setting up the scenes in order",
    "set_video_engine": "Choosing the video engine", "make_character_sheets": "Setting up character sheets",
    "read_chat_message": "Reading your message", "produce_all": "Setting up Produce all",
}


def step_label(name: str, args: dict | None) -> str:
    """A short, friendly line for the live progress list ("Looking at E01-SH03")."""
    a = args if isinstance(args, dict) else {}
    code = str(a.get("shot_code") or "").upper()
    lang = studio.lang_name(_lang_of(str(a.get("language") or ""))) if a.get("language") else ""
    who = str(a.get("character") or "")
    if name == "look_at_shot" and code:
        return f"Looking at {code}"
    if name in ("read_shot", "update_shot", "edit_clip") and code:
        return {"read_shot": "Reading", "update_shot": "Editing", "edit_clip": "Setting up an edit of"}[name] + f" {code}"
    if name == "next_shot" and code:
        return f"Adding a shot after {code}"
    if name == "web_search" and a.get("query"):
        return f"Searching the web: {_clip(a['query'], 60)}"
    if name in ("polish_dialogue", "localize_script", "dub_episode") and lang:
        return {"polish_dialogue": f"Polishing the {lang} dialogue", "localize_script": f"Translating into {lang}",
                "dub_episode": f"Setting up the {lang} dub"}[name]
    if name in ("set_outfit", "lock_character", "freeze_look", "add_costume") and who:
        return {"set_outfit": f"Changing {who}'s outfit", "lock_character": f"Locking {who}'s look",
                "freeze_look": f"Freezing {who}'s look", "add_costume": f"Adding a costume for {who}"}[name]
    if name == "look_at_attachment" and a.get("attachment_id") is not None:
        return f"Looking at attachment #{a['attachment_id']}"
    if name == "add_cast_from_image" and a.get("name"):
        return f"Adding {_clip(a['name'], 40)} from a picture"
    if name == "continuity_state" and a.get("scene_number"):
        return f"Writing the continuity state of scene {a['scene_number']}"
    return _LABELS.get(name) or name.replace("_", " ").capitalize()


def _needs_confirmation(c: AgentCtx, name: str, args: dict) -> tuple[str, str] | None:
    """(what, detail) when running `name` now would replace existing work; None when it is safe to just do it."""
    ep = c.ep()
    scenes = len((ep.script or {}).get("scenes") or [])
    if name == "write_script" and scenes:
        return ("Rewrite the script",
                f"Replaces the current {scenes}-scene script. The old one stays in Story → Versions, so you can restore it.")
    if name == "breakdown_shots":
        n = len(c.shots())
        if n:
            return ("Re-plan the shot list",
                    f"Replaces the current {n} shots with a new plan. Shots that already have paid takes are dropped from the "
                    "cut, not deleted. To change a few shots, edit them instead.")
    if name == "generate_hooks" and ep.hooks:
        chosen = " and the one you chose" if ep.selected_hook is not None else ""
        return ("Write new hooks", f"Replaces the {len(ep.hooks)} current hooks{chosen}.")
    if name == "select_hook" and scenes and ep.selected_hook is not None and int(args.get("index", 0)) != ep.selected_hook:
        return ("Change the chosen hook", "The script was written for the current hook; you'd want to rewrite it afterwards.")
    if name == "plan_series" and (c.project.story or {}).get("logline"):
        return ("Re-plan the season", "Replaces the season logline, arc and episode outlines.")
    if name == "build_bible":
        cast = studio.cast(c.db, c.project)
        if cast:
            return ("Add characters & places from the script",
                    f"You already have {len(cast)} characters. This adds anyone in the script who isn't in the cast yet "
                    "(it can bring back a character you removed).")
    if name == "make_cutdowns":
        n, secs = int(args.get("count") or 3), int(args.get("seconds") or 30)
        return (f"Cut into {n} shorts", f"Creates {n} new cut-down episodes of about {secs}s each from this episode's shots.")
    if name == "plan_scene_cards":
        planned = [s for s in c.db.query(Scene).filter(Scene.episode_id == ep.id).all() if s.goal or s.approved]
        if planned:
            approved = " (some approved)" if any(s.approved for s in planned) else ""
            return ("Re-plan the scene cards", f"{len(planned)} scenes already have cards{approved}; this rewrites them.")
    if name == "localize_script" and args.get("overwrite"):
        lang = _lang_of(str(args.get("language") or ""))
        had = [s for s in c.shots() if lang and _has_lines(s, lang)]
        if had:
            lname = studio.lang_name(lang)
            return (f"Redo the {lname} translation",
                    f"Translates {len(had)} shots again that already have {lname} lines; edits to those lines are lost.")
    if name == "marketing_copy" and (ep.marketing or {}).get("copies"):
        return ("Write new marketing copy", "Replaces this episode's current titles, descriptions and hashtags.")
    if name == "import_script":
        n = len(c.shots())
        if n:
            return ("Replace the shot list with your script",
                    f"Episode {ep.number} already has {n} shots. Your script becomes the episode's script and shot list; "
                    "shots with paid takes are dropped from the cut, not deleted, and the current script stays in "
                    "Story → Versions.")
        if scenes:
            return ("Replace the script with yours",
                    f"Replaces the current {scenes}-scene script. The old one stays in Story → Versions.")
    if name == "add_cast_from_image" and str(args.get("kind") or "character").lower() == "prop":
        from ..core import chat_attachments
        prop = chat_attachments.find_by_name(c.db, c.project, "prop", str(args.get("name") or ""))
        if prop is not None and prop.path:
            return (f"Replace the picture of {prop.name}", "A prop has one reference picture; this one replaces it.")
    return None


def _prepare(c: AgentCtx, name: str, args: dict) -> dict:
    """Fill in what the model left implicit, so a confirmation card stores everything it needs to run later:
    "this message" becomes the id of the user's message this turn."""
    if name in ("import_script", "write_script") and c.turn and not args.get("message_id"):
        if args.get("from_message") or (name == "import_script" and not str(args.get("text") or "").strip()):
            args = {**args, "message_id": c.turn}
    if name == "import_script":
        args = {k: v for k, v in args.items() if k != "from_message"}
    return args


def run_tool(c: AgentCtx, name: str, args: dict) -> dict:
    """Run a tool, unless it would replace work: then queue a confirmation for the user and tell the model to wait."""
    fn = TOOL_FUNCS.get(name)
    if not fn:
        return {"error": f"unknown tool {name}"}
    args = _prepare(c, name, args)
    if not c.confirmed:
        need = _needs_confirmation(c, name, args)
        if need:
            item = {"id": uuid.uuid4().hex[:12], "tool": name, "args": args, "episode_id": c.ep().id,
                    "what": need[0], "detail": need[1], "status": "pending"}
            c.confirmations.append(item)
            return {"status": "waiting_for_user_confirmation", "what": need[0], "detail": need[1],
                    "message": "Not done yet: this would replace the user's existing work, so a Confirm button is shown under "
                               "your reply. Do not call this tool again now. Tell the user briefly what would be replaced."}
    return fn(c, **args)


TOOL_FUNCS: dict[str, Callable[..., dict]] = {
    "get_project_state": get_project_state, "update_brief": update_brief, "generate_hooks": generate_hooks,
    "select_hook": select_hook, "write_script": write_script, "plan_series": plan_series, "build_bible": build_bible,
    "breakdown_shots": breakdown_shots, "update_shot": update_shot, "set_outfit": set_outfit,
    "generate_keyframes": generate_keyframes, "generate_videos": generate_videos, "voice_and_lipsync": voice_and_lipsync,
    "storyboard_frames": storyboard_frames,
    "generate_music": generate_music, "make_animatic": make_animatic, "dub_episode": dub_episode,
    "export_video": export_video, "edit_clip": edit_clip, "make_cutdowns": make_cutdowns, "start_autopilot": start_autopilot,
    # v3: continuity, change impact, Film Map, Character Lab, dialogue route
    "continuity_state": continuity_state, "wardrobe_report": wardrobe_report, "impact_report": impact_report,
    "regenerate_stale": regenerate_stale, "next_shot": next_shot, "lock_character": lock_character, "freeze_look": freeze_look,
    "add_costume": add_costume, "set_dialogue_route": set_dialogue_route,
    # agentic: read and see the work, review it, keep a plan and project memory
    "read_script": read_script, "read_shot": read_shot, "read_bible": read_bible, "look_at_shot": look_at_shot,
    "critique_script": critique_script, "check_continuity": check_continuity, "plan_scene_cards": plan_scene_cards,
    "polish_dialogue": polish_dialogue, "localize_script": localize_script, "marketing_copy": marketing_copy,
    "update_plan": update_plan, "remember": remember, "forget": forget,
    # one long prompt with pictures: cast from images, the user's script, scenes in order, engines
    "look_at_attachment": look_at_attachment, "add_cast_from_image": add_cast_from_image, "read_chat_message": read_chat_message,
    "import_script": import_script, "generate_scenes": generate_scenes, "set_video_engine": set_video_engine,
    "make_character_sheets": make_character_sheets, "produce_all": produce_all,
}

_codes = {"type": "array", "items": {"type": "string"}, "description": "Shot codes like E01-SH03. Empty = all that still need it."}
_lang = {"type": "string", "enum": list(catalog.LANGUAGES), "description": "en, hi, kn, te or ta"}


def _t(name: str, desc: str, props: dict | None = None, required: list[str] | None = None) -> dict:
    return {"type": "function", "name": name, "description": desc,
            "parameters": {"type": "object", "properties": props or {}, "required": required or []}}


TOOL_DECLS = [
    _t("get_project_state", "Read the current project, episode, cast, shots and budget."),
    _t("update_brief", "Change brief fields.", {"fields": {"type": "object", "description": "title, audience, tone, duration_s, key_message, cta, platform, notes"}}, ["fields"]),
    _t("generate_hooks", "Write N hook options for the opening seconds.", {"n": {"type": "integer"}, "angle": {"type": "string"}}),
    _t("select_hook", "Choose a hook by index.", {"index": {"type": "integer"}}, ["index"]),
    _t("write_script", "Write or rewrite the episode script from the brief. When the user gave a story or treatment in their "
       "message, set from_message=true: their text goes to the writer word for word (don't retype it into instructions).",
       {"instructions": {"type": "string"},
        "from_message": {"type": "boolean", "description": "Use the user's message of this turn as the brief"},
        "message_id": {"type": "integer", "description": "Use an earlier chat message of the user as the brief"}}),
    _t("plan_series", "Plan a season (series projects).", {"episodes": {"type": "integer"}}),
    _t("build_bible", "Create characters, locations and style from the script."),
    _t("breakdown_shots", "Turn the script into a shot list (replaces existing shots)."),
    _t("update_shot", "Edit one shot.", {"shot_code": {"type": "string"}, "changes": {"type": "object",
        "description": "framing, camera, action, end_note (how the shot ends: its end frame), duration_s (4/6/8), "
                       "quality_mode, voice_mode, mode, sfx, music_cue, include, "
                       "engine (only when the user asks for one: a Model Hub engine like 'Seedance 2.0 BytePlus', or 'auto')"}},
       ["shot_code", "changes"]),
    _t("set_outfit", "Give a character a new outfit in this episode and redo their keyframes.",
       {"character": {"type": "string"}, "outfit": {"type": "string"}, "description": {"type": "string"},
        "regenerate_keyframes": {"type": "boolean"}}, ["character", "outfit"]),
    _t("generate_keyframes", "Generate keyframe images (cheap).", {"shot_codes": _codes}),
    _t("storyboard_frames", "Make the storyboard frames of scenes in order (paid, cheap): each shot's start frame and its "
       "end frame (where the shot ends; its clip then runs from start to end frame), each frame following the one before. "
       "sync=true links each shot of a scene to the one before so it starts exactly on that end frame and the clips join "
       "without a jump (for one continuous action). Uses the project's frames engine (e.g. Seedream).",
       {"scene_numbers": {"type": "array", "items": {"type": "integer"}}, "shot_codes": _codes,
        "end_frames": {"type": "boolean"}, "sync": {"type": "boolean"}, "redo": {"type": "boolean"}}),
    _t("generate_videos", "Generate videos for shots (paid). Shots linked to the shot they continue are made in link order, "
       "each from the finished clip before it. For whole scenes prefer generate_scenes.", {"shot_codes": _codes,
        "quality": {"type": "string", "enum": list(catalog.QUALITY_MODES)}}),
    _t("voice_and_lipsync", "Voice the dialogue/narration and lip-sync it (paid).", {"language": _lang, "shot_codes": _codes}),
    _t("produce_all", "Produce all (paid, one approval, only what is missing): character & place looks for cast and "
       "places with no picture, keyframes, videos in link order (each scene carrying the one before), extensions, "
       "voices (voice-over and dialogue, lip-synced), sound effects, music and the final export. After generate_scenes, "
       "steps voices + sound + music + export finish the film.",
       {"steps": {"type": "array", "items": {"type": "string", "enum": list(generation.PRODUCE_STEPS)},
                  "description": "Empty = every step"},
        "quality": {"type": "string", "enum": list(catalog.QUALITY_MODES)},
        "music_per_scene": {"type": "boolean", "description": "One piece of music per scene that follows its mood, on one "
                            "theme, crossfaded (default: on with two or more scenes, unless already scored); false = one "
                            "score for the episode"}}),
    _t("generate_music", "Compose background music for the episode.", {"prompt": {"type": "string"}}),
    _t("make_animatic", "Render a cheap preview from keyframes + voices + music.", {"language": _lang}),
    _t("dub_episode", "Dub the whole episode into another language (adapt script, voices, lip-sync).", {"language": _lang}, ["language"]),
    _t("export_video", "Render the final video.", {"language": _lang, "preset": {"type": "string", "enum": list(catalog.EXPORT_PRESETS)}}),
    _t("edit_clip", "Edit a generated clip with a natural-language instruction (Gemini Omni).",
       {"shot_code": {"type": "string"}, "instruction": {"type": "string"}}, ["shot_code", "instruction"]),
    _t("make_cutdowns", "Cut the episode into N standalone shorts.", {"count": {"type": "integer"}, "seconds": {"type": "integer"}}),
    _t("start_autopilot", "Run the whole pipeline automatically up to a milestone: script, cast (scenes, characters, voices), "
       "storyboard (shot list + keyframes) or final (videos through the finished export).",
       {"through": {"type": "string", "enum": ["script", "cast", "storyboard", "final"]}}),
    # v3
    _t("continuity_state", "Write the Continuity Bible entry for a scene: who wears what, props in hand, time of day, weather at the END of it.",
       {"scene_number": {"type": "integer"}}, ["scene_number"]),
    _t("wardrobe_report", "Who wears what in every scene, with continuity breaks flagged."),
    _t("impact_report", "What became stale after edits (keyframes, videos, voices, lip-syncs) and the cost of redoing it."),
    _t("regenerate_stale", "Redo every stale take (paid).", {"shot_codes": _codes}),
    _t("next_shot", "Add the shot after a given one with the same cast, wardrobe and location, starting from its last frame, "
       "extending its clip, or starting exactly on its end frame (end_frame).",
       {"shot_code": {"type": "string"}, "action": {"type": "string"},
        "mode": {"type": "string", "enum": ["last_frame", "extend", "end_frame"]},
        "generate": {"type": "boolean"}}, ["shot_code"]),
    _t("lock_character", "Set a character's lock: face, body, skin_hair, voice, costume_continuity (booleans), gestures, age, lighting (text), strictness 0-1.",
       {"character": {"type": "string"}, "lock": {"type": "object"}}, ["character", "lock"]),
    _t("freeze_look", "Freeze a character's current look as a version for an episode range (older, new hairstyle, beard...).",
       {"character": {"type": "string"}, "label": {"type": "string"}, "episode_from": {"type": "integer"},
        "episode_to": {"type": "integer"}, "dna_text": {"type": "string"}, "voice_description": {"type": "string"}}, ["character"]),
    _t("add_costume", "Give a character a named outfit with a 3-angle turnaround (paid images).",
       {"character": {"type": "string"}, "name": {"type": "string"}, "description": {"type": "string"},
        "episode_from": {"type": "integer"}, "episode_to": {"type": "integer"}, "generate": {"type": "boolean"}}, ["character", "name"]),
    _t("set_dialogue_route", "Choose how dialogue is made: native (Veo speaks the line itself) or audio_first (locked voice + lip-sync), and which languages Veo may speak.",
       {"method": {"type": "string", "enum": ["native", "audio_first", "audio_driven", "voice_lock", "native_when_possible"]},
        "native_languages": {"type": "array", "items": {"type": "string"}}}, ["method"]),
    # agentic
    _t("read_script", "Read the episode script: logline, beats, hook and every scene with its action and lines. A long script "
       "comes back as an outline; then read one scene at a time.",
       {"scene": {"type": "integer", "description": "1-based scene number. Empty = the whole script."}}),
    _t("read_shot", "Everything about one shot: framing, camera, action, cast, location, outfits, dialogue and narration per "
       "language, mode, quality, and its keyframe / video takes with their QC notes.", {"shot_code": {"type": "string"}}, ["shot_code"]),
    _t("read_bible", "The cast (look description, voice, Character Lock), the locations and the visual style."),
    _t("look_at_shot", "See a shot: its current keyframe and up to 3 frames of its current video, with the QC notes. Use it to "
       "judge the work and to suggest retakes.", {"shot_code": {"type": "string"}}, ["shot_code"]),
    _t("critique_script", "The script editor reviews the current script: scores, specific problems, rewrite instructions. "
       "Changes nothing."),
    _t("check_continuity", "The script supervisor checks the shot list against the scene cards and the cast: wardrobe, prop, "
       "time-of-day and logic breaks, each with a fix. Changes nothing."),
    _t("plan_scene_cards", "Write a scene card for every script scene (goal, conflict, turn, emotion, cast, wardrobe, props, "
       "blocking, coverage plan). The shot breakdown follows the cards."),
    _t("polish_dialogue", "A native speaker's pass over the dialogue and narration in one language, so it sounds natural.",
       {"language": _lang}),
    _t("localize_script", "Translate the dialogue and narration into another language for dubbing. Shots that already have "
       "lines in it are kept unless overwrite is true.", {"language": _lang, "overwrite": {"type": "boolean"}}, ["language"]),
    _t("marketing_copy", "Write titles, descriptions, hashtags, a pinned comment and thumbnail ideas per platform and language.",
       {"platforms": {"type": "array", "items": {"type": "string", "enum": MARKETING_PLATFORMS}},
        "languages": {"type": "array", "items": _lang}}),
    _t("update_plan", "Your working checklist for a multi-step request, shown to the user. Send the whole list every time.",
       {"steps": {"type": "array", "items": {"type": "object", "properties": {
           "text": {"type": "string"}, "status": {"type": "string", "enum": list(PLAN_STATUSES)}}, "required": ["text", "status"]}}},
       ["steps"]),
    _t("remember", "Save a lasting note in project memory: a team preference or decision. Notes come back to you every turn.",
       {"note": {"type": "string", "description": "One short sentence (up to 300 characters)"}}, ["note"]),
    _t("forget", "Remove a note from project memory by its number.", {"index": {"type": "integer"}}, ["index"]),
    # one long prompt with pictures
    _t("look_at_attachment", "See a picture the user attached in this chat (by its attachment id), with the tag they gave it.",
       {"attachment_id": {"type": "integer"}}, ["attachment_id"]),
    _t("add_cast_from_image", "Make an attached picture the reference image of a character, location or prop: the one with "
       "that name in the project, else a new one (added to the project). Saved and approved like an upload in the Cast "
       "step. Free.",
       {"attachment_id": {"type": "integer"}, "name": {"type": "string"},
        "kind": {"type": "string", "enum": ["character", "location", "prop"]},
        "description": {"type": "string", "description": "For a new entry: a concrete visual description from the picture "
                                                         "(a character's age, face, skin, hair, build, outfit; no personality)"}},
       ["attachment_id", "name", "kind"]),
    _t("read_chat_message", "Read the full text of one of the user's chat messages (a long brief or script), 10,000 characters "
       "at a time.", {"message_id": {"type": "integer"}, "offset": {"type": "integer"}}, ["message_id"]),
    _t("import_script", "Import the user's own script word for word (the Import Wizard): scenes and shots laid out as written, "
       "speakers matched to the cast or created, the Story script saved; replaces the shot list. With no text it takes "
       "the user's message of this turn; start / end cut out the script part when the message also has instructions.",
       {"text": {"type": "string", "description": "The script, only when it is not in a chat message"},
        "message_id": {"type": "integer", "description": "An earlier chat message holding the script"},
        "start": {"type": "string", "description": "The exact first words of the script in the message"},
        "end": {"type": "string", "description": "The exact last words of the script in the message"},
        "method": {"type": "string", "enum": ["auto", "markers", "ai"]},
        "create_missing_characters": {"type": "boolean"}}),
    _t("generate_scenes", "Make the videos scene by scene with continuity (paid): for each scene in order the earlier scenes' "
       "end states (wardrobe, props, time of day) go into its prompts, its first shot starts from the last frame of the "
       "scene before when it picks up straight from it, its shots run in link order with QC, then the next scene. "
       "Videos that exist are kept.",
       {"scenes": {"type": "array", "items": {"type": "integer"}, "description": "Scene numbers; empty = all, in order"},
        "quality": {"type": "string", "enum": list(catalog.QUALITY_MODES)},
        "link_scenes": {"type": "string", "enum": ["auto", "always", "never"]},
        "fix_links": {"type": "boolean", "description": "Also remake clips whose link is already broken"},
        "pause_after_each_scene": {"type": "boolean", "description": "Stop after each scene for review; run again to go on"},
        "plan_only": {"type": "boolean", "description": "Only show what would be made and the cost"}}),
    _t("set_video_engine", "Make shots with one video engine of the Model Hub, e.g. 'Seedance 2.0 BytePlus' (or 'auto' for the "
       "team's policy). Only when the user asks for an engine. No shots and no scene = every shot of the episode.",
       {"engine": {"type": "string"}, "shot_codes": _codes, "scene": {"type": "integer"}}, ["engine"]),
    _t("make_character_sheets", "Character sheet images (front, three-quarter, full body …) made from each character's "
       "reference photo, so every angle keeps the face (paid images). No names = cast members without a sheet yet.",
       {"characters": {"type": "array", "items": {"type": "string"}},
        "views": {"type": "array", "items": {"type": "string", "enum": list(SHEET_VIEW_NAMES)}}}),
]
