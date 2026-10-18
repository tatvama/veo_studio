"""Which takes a change to a shot makes stale (the dependency graph in core/dependencies.py), apart from what it takes
to redo them.

core/dependencies.py serves it too. core/frames.py reads it from here: dependencies imports core/generation (to price
the redo), which imports frames, so reading it from dependencies closes an import cycle. This module imports nothing
of core.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..events import emit
from ..models import Episode, Shot, Take

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
