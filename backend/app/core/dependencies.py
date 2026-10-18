"""Change impact: which takes a change makes stale, and what it would take to redo them.

The dependency graph of a shot:
    framing / camera / action / cast / outfits / location / props / references  -> keyframe -> video -> lip-sync, voice lock
    the same, and how the shot ends (end_note)                                   -> end frame -> video
    dialogue[lang]                                                              -> voice[lang] -> lip-sync[lang]
                                                                                -> video made audio-driven or native in that language
    narration[lang]                                                             -> narration[lang]

Nothing is deleted: a stale take keeps playing until a new one replaces it, and the editor decides what to redo.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ..events import emit
from ..models import Character, Costume, Episode, Project, ProjectCast, Scene, Shot, Take
from .generation import endframe_spec, keyframe_specs, lipsync_specs, video_specs, voice_specs

KEYFRAME_FIELDS = {"framing", "camera", "action", "characters", "outfits", "location_id", "prop_ids", "ref_images",
                   "continuity_from_shot_id", "continuity_mode", "continuity_from_prev", "scene_id"}
# an end frame follows the shot's own start frame, not the links (a new start frame is remade after it anyway)
ENDFRAME_FIELDS = ((KEYFRAME_FIELDS - {"continuity_from_shot_id", "continuity_mode", "continuity_from_prev", "scene_id"})
                   | {"end_note"})
VIDEO_FIELDS = KEYFRAME_FIELDS | {"duration_s", "mode", "engine", "quality_mode", "voice_mode", "end_note"}
LABELS = {"framing": "framing", "camera": "camera", "action": "action", "characters": "cast", "outfits": "outfits",
          "location_id": "location", "prop_ids": "props", "ref_images": "references", "duration_s": "duration",
          "mode": "video mode", "engine": "engine", "quality_mode": "quality", "voice_mode": "voice mode",
          "continuity_from_shot_id": "continuity link", "continuity_mode": "continuity link", "continuity_from_prev": "continuity",
          "scene_id": "scene", "end_note": "how it ends"}


def changed_fields(before: dict[str, Any], after: dict[str, Any]) -> set[str]:
    return {k for k in set(before) | set(after) if before.get(k) != after.get(k)}


def _lang_changes(before: dict | None, after: dict | None) -> set[str]:
    b, a = before or {}, after or {}
    return {lang for lang in set(b) | set(a) if (b.get(lang) or []) != (a.get(lang) or [])}


def _mark(db: Session, t: Take, reason: str, out: list[Take]) -> None:
    if t.stale and t.stale_reason:
        if reason not in t.stale_reason:
            t.stale_reason = (t.stale_reason + "; " + reason)[:200]
    else:
        t.stale, t.stale_reason = True, reason[:200]
    out.append(t)


def mark_stale(db: Session, shot: Shot, fields: set[str], dialogue_before: dict | None = None,
               narration_before: dict | None = None, note: str = "", reason: str = "") -> list[Take]:
    """Flag the takes a change to `fields` invalidates. `dialogue_before`/`narration_before` are the old values
    (the shot already holds the new ones) so only the languages that actually changed are flagged. `reason`: the
    words on the pictures and clips instead of "<fields> changed" (e.g. "Ravi's look changed")."""
    takes = db.query(Take).filter(Take.shot_id == shot.id, Take.archived.is_(False), Take.status == "ready").all()
    out: list[Take] = []
    what = ", ".join(sorted(LABELS.get(f, f) for f in fields if f in VIDEO_FIELDS)) or note or "shot changed"
    why = reason or f"{what} changed"
    if fields & KEYFRAME_FIELDS:
        for t in takes:
            if t.kind == "keyframe" and t.provider != "upload":
                _mark(db, t, why, out)
    if fields & ENDFRAME_FIELDS:
        for t in takes:
            if t.kind == "endframe" and t.provider != "upload":
                _mark(db, t, why, out)
    if fields & VIDEO_FIELDS:
        for t in takes:
            if t.kind in ("video", "lipsync", "voicelock"):
                _mark(db, t, why, out)
    if "dialogue" in fields:
        for lang in _lang_changes(dialogue_before, shot.dialogue):
            for t in takes:
                p = t.params or {}
                if t.kind in ("voice", "lipsync", "voicelock") and t.language == lang:
                    _mark(db, t, f"{lang} dialogue changed", out)
                elif t.kind == "video" and (p.get("audio_driven") or p.get("native_language")) and \
                        (p.get("language") or p.get("native_language")) == lang:
                    _mark(db, t, f"{lang} dialogue changed", out)
    if "narration" in fields:
        for lang in _lang_changes(narration_before, shot.narration):
            for t in takes:
                if t.kind == "narration" and t.language == lang:
                    _mark(db, t, f"{lang} narration changed", out)
    if out:
        db.flush()
        emit(db, _project_id(db, shot), "take.updated", {"shot_id": shot.id, "stale": [t.id for t in out]}, commit=False)
    return out


def _project_id(db: Session, shot: Shot) -> int | None:
    e = db.get(Episode, shot.episode_id)
    return e.project_id if e else None


def clear(db: Session, shot_id: int, kind: str, language: str | None = None) -> None:
    """A fresh take of this kind makes the stale flag on its siblings moot (they are superseded, not stale)."""
    q = db.query(Take).filter(Take.shot_id == shot_id, Take.kind == kind, Take.stale.is_(True))
    q = q.filter(Take.language == language) if language is not None else q.filter(Take.language.is_(None))
    for t in q.all():
        t.stale, t.stale_reason = False, ""


def impact(db: Session, project: Project, episode: Episode) -> dict[str, Any]:
    """Everything stale in an episode, grouped by shot, with the cost of redoing it."""
    shots = (db.query(Shot).filter(Shot.episode_id == episode.id, Shot.include.is_(True)).order_by(Shot.order, Shot.id).all())
    groups: list[dict] = []
    counts: dict[str, int] = {}
    for s in shots:
        stale = db.query(Take).filter(Take.shot_id == s.id, Take.stale.is_(True), Take.archived.is_(False)).order_by(Take.id).all()
        if not stale:
            continue
        groups.append({"shot_id": s.id, "code": s.code, "status": s.status,
                       "takes": [{"id": t.id, "kind": t.kind, "language": t.language, "reason": t.stale_reason,
                                  "selected": t.selected} for t in stale]})
        for t in stale:
            counts[t.kind] = counts.get(t.kind, 0) + 1
    specs = regenerate_specs(db, project, episode, [g["shot_id"] for g in groups])
    return {"shots": groups, "counts": counts, "estimate_usd": round(sum(x["estimate"] for x in specs), 4),
            "plan": [{"label": x["label"], "usd": x["estimate"]} for x in specs]}


# ── a character's look changed ───────────────────────────────────────────────

LOOK_KINDS = ("keyframe", "endframe", "video", "lipsync", "voicelock")


def character_shots(db: Session, character_id: int, project_id: int | None = None) -> list[Shot]:
    """The shots in the cut that show this character: in one project, or in every project it is cast in."""
    pids = {project_id} if project_id else {r.project_id for r in db.query(ProjectCast).filter(
        ProjectCast.character_id == character_id).all()}
    if not pids:
        return []
    rows = (db.query(Shot).join(Episode, Episode.id == Shot.episode_id)
            .filter(Episode.project_id.in_(pids), Shot.include.is_(True)).order_by(Episode.number, Shot.order, Shot.id).all())
    return [s for s in rows if str(character_id) in {str(x) for x in s.characters or []}]


def _outfit_in(db: Session, shot: Shot, ch: Character) -> str:
    """The outfit a character wears in this shot: the shot's own pick, else the scene's wardrobe, else the default
    costume (the same rule as pipeline/prompting.outfit_for, kept here so this module needs no prompting import)."""
    o = (shot.outfits or {}).get(str(ch.id))
    if o:
        return o
    scene = db.get(Scene, shot.scene_id) if shot.scene_id else None
    if scene and (scene.wardrobe or {}).get(str(ch.id)):
        return scene.wardrobe[str(ch.id)]
    c = db.query(Costume).filter(Costume.character_id == ch.id, Costume.is_default.is_(True), Costume.archived.is_(False)).first()
    return c.name if c else ""


def character_changed(db: Session, ch: Character, what: str = "look", outfit: str | None = None) -> list[Take]:
    """The character's approved pictures were added, approved or taken away, its lock changed, or (outfit) one of its
    outfits was edited: the keyframes, end frames and clips (and their lip-syncs) of the shots that show them (wearing
    that outfit) are out of date, "Ravi's look changed". Nothing is redone by itself: the impact report lists them with
    the cost of redoing them (character_impact; POST /api/episodes/{eid}/impact/regenerate redoes them). No commit."""
    reason = f"{ch.name}'s {what} changed"
    out: list[Take] = []
    for s in character_shots(db, ch.id):
        if outfit is not None and _outfit_in(db, s, ch) != outfit:
            continue
        out += mark_stale(db, s, {"characters"}, reason=reason)
    return out


def character_impact(db: Session, project: Project, ch: Character) -> dict[str, Any]:
    """The project's shots that show this character and have out-of-date pictures or clips, per episode, with what
    redoing them costs (the same jobs as the episode's impact report)."""
    shown = character_shots(db, ch.id, project.id)
    stale = {sid for (sid,) in db.query(Take.shot_id).filter(
        Take.shot_id.in_([s.id for s in shown]), Take.stale.is_(True), Take.archived.is_(False),
        Take.kind.in_(LOOK_KINDS)).distinct().all()} if shown else set()
    by_ep: dict[int, list[Shot]] = {}
    for s in shown:
        if s.id in stale:
            by_ep.setdefault(s.episode_id, []).append(s)
    episodes, total = [], 0.0
    for eid, shots in by_ep.items():
        ep = db.get(Episode, eid)
        usd = round(sum(x["estimate"] for x in regenerate_specs(db, project, ep, [s.id for s in shots])), 4)
        total += usd
        episodes.append({"episode_id": eid, "number": ep.number, "shot_ids": [s.id for s in shots],
                         "codes": [s.code for s in shots], "estimate_usd": usd})
    episodes.sort(key=lambda e: e["number"])
    return {"character_id": ch.id, "name": ch.name, "shots": [c for e in episodes for c in e["codes"]],
            "shot_ids": [i for e in episodes for i in e["shot_ids"]], "episodes": episodes, "estimate": round(total, 4)}


def regenerate_specs(db: Session, project: Project, episode: Episode, shot_ids: list[int] | None = None,
                     kinds: list[str] | None = None) -> list[dict]:
    """Job specs that replace what is stale: keyframes first (a video job remakes a missing keyframe itself, so a
    shot whose keyframe AND video are stale gets one video job), then voices and lip-syncs per language."""
    shots = (db.query(Shot).filter(Shot.episode_id == episode.id, Shot.include.is_(True)).order_by(Shot.order, Shot.id).all())
    if shot_ids:
        shots = [s for s in shots if s.id in set(shot_ids)]
    want = set(kinds or ["keyframe", "video", "voice", "lipsync"])
    specs: list[dict] = []
    kf_only, vid, end_only, voices, lips = [], [], [], {}, {}
    for s in shots:
        stale = db.query(Take).filter(Take.shot_id == s.id, Take.stale.is_(True), Take.archived.is_(False)).all()
        kinds_here = {t.kind for t in stale}
        if "video" in kinds_here and "video" in want:
            vid.append(s)  # (the video job remakes an out-of-date end frame first too)
        elif "keyframe" in kinds_here and "keyframe" in want:
            kf_only.append(s)
        if "endframe" in kinds_here and "keyframe" in want and "video" not in kinds_here:
            end_only.append(s)
        for t in stale:
            if t.kind in ("voice", "narration") and "voice" in want and t.language:
                voices.setdefault(t.language, []).append(s)
            if t.kind in ("lipsync", "voicelock") and "lipsync" in want and t.language:
                lips.setdefault(t.language, []).append(s)
    specs += keyframe_specs(db, project, kf_only)
    specs += [endframe_spec(db, project, s) for s in end_only]
    specs += video_specs(db, project, vid)
    for lang, ss in voices.items():
        specs += voice_specs(db, project, _uniq(ss), lang)
    for lang, ss in lips.items():
        specs += lipsync_specs(db, project, [s for s in _uniq(ss) if s not in vid], lang)  # a new video re-syncs anyway
    return specs


def _uniq(shots: list[Shot]) -> list[Shot]:
    seen: set[int] = set()
    out = []
    for s in shots:
        if s.id not in seen:
            seen.add(s.id)
            out.append(s)
    return out


def script_line_changes(old_script: dict | None, new_script: dict | None) -> list[tuple[str, str, str]]:
    """Dialogue lines whose words changed between two script versions: (character name, old text, new text).
    Lines are matched by position within their scene, which is how a writer edits them."""
    from . import mentions
    old_sc = (mentions.plain_script(old_script).get("scenes") or [])
    new_sc = (mentions.plain_script(new_script).get("scenes") or [])
    out: list[tuple[str, str, str]] = []
    for a, b in zip(old_sc, new_sc):
        for la, lb in zip(a.get("lines") or [], b.get("lines") or []):
            if (la.get("line") or "").strip() != (lb.get("line") or "").strip() and (la.get("line") or "").strip():
                out.append((lb.get("character") or la.get("character") or "", la.get("line", "").strip(), lb.get("line", "").strip()))
    return out


def apply_script_changes(db: Session, project: Project, episode: Episode, old_script: dict | None,
                         new_script: dict | None) -> list[dict]:
    """Script intelligence: a changed line updates the shot that speaks it and flags its voice, lip-sync and
    spoken-video takes. Returns what was touched for the UI."""
    changes = script_line_changes(old_script, new_script)
    if not changes:
        return []
    lang = project.primary_language
    shots = db.query(Shot).filter(Shot.episode_id == episode.id, Shot.include.is_(True)).all()
    touched: list[dict] = []
    for _who, old, new in changes:
        for s in shots:
            lines = list((s.dialogue or {}).get(lang) or [])
            hit = [i for i, l in enumerate(lines) if (l.get("line") or "").strip() == old]
            if not hit:
                continue
            before = {k: list(v) for k, v in (s.dialogue or {}).items()}
            for i in hit:
                lines[i] = {**lines[i], "line": new}
            s.dialogue = {**(s.dialogue or {}), lang: lines}
            stale = mark_stale(db, s, {"dialogue"}, dialogue_before=before)
            touched.append({"shot_id": s.id, "code": s.code, "old": old, "new": new, "stale_takes": [t.id for t in stale]})
    return touched
