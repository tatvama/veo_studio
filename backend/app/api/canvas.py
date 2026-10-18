"""The Shots canvas (frontend pages/project/canvas): what its shot nodes and scene groups need beyond the episode.

GET   /api/episodes/{eid}/canvas  per shot, which of the five steps apply (picture, video, voice, mouth sync, sound) and
                                  the last failed run of a step that nothing has replaced since (its reason, to retry);
                                  each scene's own piece of music; whether sound effects and lip-sync can really be made;
                                  the last run's problems that still stand (run_problems).
PATCH /api/scenes/{scid}/notes    a scene's mood, look, sound and music notes (the shot list's scene fields) without
                                  saving the whole shot list.
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core import generation, problems
from ..core.budget import Estimator
from ..db import get_db
from ..events import emit
from ..models import AudioAsset, Episode, Job, Project, Scene, User
from ..pipeline.prompting import effective_voice_mode, shot_lines
from ..security import current_user, require
from .common import get_or_404, url

router = APIRouter(prefix="/api", tags=["canvas"])

# job type → the canvas step it makes
STEP_OF = {"keyframe": "picture", "endframe": "picture", "video": "video", "voice": "voice", "voicelock": "voice",
           "lipsync": "mouth"}


def _iso(at: datetime | None) -> str | None:
    return at.isoformat() if at else None


def _problem(job_id: int, error: str, at: datetime | None) -> dict:
    """A failed step: the job's error and, in plain words, why and what to do next (core/problems.explain); `blocked`
    when a safety filter stopped it (then another engine is the fix)."""
    err = (error or "").strip()
    reason, nxt = problems.explain(err)
    return {"job_id": job_id, "error": err[:300] or "It stopped with an error", "at": _iso(at), "reason": reason,
            "next": nxt, "blocked": err.lower().startswith(problems.BLOCKED.lower())}


@router.get("/episodes/{eid}/canvas")
def canvas(eid: int, lang: str | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e = get_or_404(db, Episode, eid)
    p = db.get(Project, e.project_id)
    lang = lang or p.primary_language
    shots = generation.episode_shots(db, e)
    ids = [s.id for s in shots]
    sound_engine = generation.sound_effects_ready()
    noted = {s.id for s in generation.with_sound_notes(db, shots)}

    out: dict[int, dict] = {}
    for s in shots:
        lines = shot_lines(s, lang)
        narr = bool((s.narration or {}).get(lang))
        vm = effective_voice_mode(s, p, lang)
        # need: the film needs it to be heard / to match · optional: the video engine already speaks the lines
        voice = "need" if narr or (lines and vm not in ("native", "voice_lock")) else ("optional" if lines else "none")
        mouth = "need" if Estimator.needs_lipsync(s, p, lang) else ("optional" if lines else "none")
        has_sound = bool((s.sfx_track or {}).get("path"))
        out[s.id] = {"voice": voice, "mouth": mouth, "voice_mode": vm,
                     # without ElevenLabs, sound effects come free from the library, only for shots whose script names one
                     "sound": "need" if (sound_engine or s.id in noted or has_sound) else "none",
                     "problems": {}}

    # the newest run of each step of each shot: when it failed, nothing has replaced it yet
    if ids:
        seen: set[tuple[int, str]] = set()
        rows = (db.query(Job.id, Job.shot_id, Job.type, Job.status, Job.error, Job.finished_at)
                .filter(Job.shot_id.in_(ids), Job.type.in_(list(STEP_OF))).order_by(Job.id.desc()).all())
        for jid, sid, typ, status, err, at in rows:
            key = (sid, STEP_OF[typ])
            if key in seen:
                continue
            seen.add(key)
            if status == "failed":
                out[sid]["problems"][key[1]] = _problem(jid, err, at)
    # sound effects run for many shots at once: the newest such run, when it failed, for its shots still without sound
    sfx = db.query(Job).filter(Job.episode_id == e.id, Job.type == "sfx").order_by(Job.id.desc()).first()
    if sfx is not None and sfx.status == "failed":
        targets = set((sfx.payload or {}).get("shot_ids") or ids)
        for s in shots:
            if s.id in targets and not (s.sfx_track or {}).get("path"):
                out[s.id]["problems"]["sound"] = _problem(sfx.id, sfx.error, sfx.finished_at)

    # each scene's own piece of music: the picked one, else the newest (as the render uses it)
    music: dict[int, dict] = {}
    for a in (db.query(AudioAsset).filter(AudioAsset.episode_id == e.id, AudioAsset.kind == "music_scene")
              .order_by(AudioAsset.id.desc()).all()):
        sc = (a.params or {}).get("scene_id")
        if sc is None:
            continue
        have = music.get(int(sc))
        if have is None or (a.selected and not have["selected"]):
            music[int(sc)] = {"id": a.id, "url": url(a.path), "duration_s": round(a.duration_s or 0.0, 1), "prompt": a.prompt,
                              "selected": bool(a.selected)}

    return {"episode_id": e.id, "language": lang, "shots": out, "scene_music": music, "sound_engine": sound_engine,
            "lipsync_engine": generation.lipsync_ready(db),
            # what the last run (Make it for me, Autopilot, Scenes in order) couldn't make and still stands, with the
            # one-click fix of each (core/problems.py): the Next bar's problem list, the Overview and the shot nodes
            "run_problems": problems.live(db, e)}


class SceneNotesIn(BaseModel):
    mood: str | None = None
    look: str | None = None
    sound: str | None = None
    music: str | None = None


@router.patch("/scenes/{scid}/notes")
def scene_notes(scid: int, body: SceneNotesIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """The scene's notes that go into every shot of it (same fields and limits as saving the shot list)."""
    sc = get_or_404(db, Scene, scid)
    for field, col, cap in (("mood", "emotion", 200), ("look", "look", 4000), ("sound", "sound", 4000),
                            ("music", "music", 4000)):
        v = getattr(body, field)
        if v is not None:
            setattr(sc, col, v.strip()[:cap])
    db.commit()
    ep = db.get(Episode, sc.episode_id)
    emit(db, ep.project_id, "episode.updated", {"episode_id": ep.id, "what": "scenes"}, user_id=user.id)
    return {"id": sc.id, "mood": sc.emotion or "", "look": sc.look or "", "sound": sc.sound or "", "music": sc.music or ""}
