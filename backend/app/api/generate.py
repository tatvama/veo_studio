"""Every paid action: estimate first, then generate (budget-checked, may need approval)."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import catalog
from ..core import autopilot as autopilot_def
from ..core import budget, collab, generation, jobs
from ..db import get_db
from ..models import Episode, Project, Shot, Take, User
from ..pipeline.selection import current
from ..security import current_user, require
from .common import get_or_404

router = APIRouter(prefix="/api", tags=["generate"])


class BatchIn(BaseModel):
    action: str  # keyframes | videos | voices | lipsync | voicelock | music | animatic | export | dub | autopilot
    shot_ids: list[int] | None = None
    only_missing: bool = False
    quality: str | None = None
    mode: str | None = None
    language: str | None = None
    preset: str | None = None
    prompt: str = ""
    captions: bool = True
    music: bool = True
    publish: bool = False
    through: str = "export"
    model: str | None = None
    hero: bool = False
    caption_style: Literal["karaoke", "clean", "boxed", "none"] | None = None
    auto_reframe: bool | None = None
    sfx: bool | None = None
    steps: list[str] | None = None  # produce: which of generation.PRODUCE_STEPS to run (default all)
    pause_after: list[str] | None = None  # autopilot: milestones to stop at for approval
    resume: bool = False  # autopilot: continue the paused run (same target, the stops still ahead)


def _render_options(body: BatchIn, **extra) -> dict:
    opts = {"captions": body.captions, "music": body.music, **extra}
    for k in ("caption_style", "auto_reframe", "sfx"):
        if getattr(body, k) is not None:
            opts[k] = getattr(body, k)
    return opts


def _job_active(db: Session, job_id: int | None) -> bool:
    from ..models import Job
    j = db.get(Job, job_id) if job_id else None
    return bool(j and j.status in ("queued", "running", "awaiting_approval", "proposed"))


def _specs(db: Session, project: Project, episode: Episode, body: BatchIn) -> list[dict]:
    shots = generation.episode_shots(db, episode, body.shot_ids)
    lang = body.language or project.primary_language
    if body.language and body.language not in catalog.LANGUAGES:
        raise HTTPException(400, "unknown language")
    a = body.action
    if a == "keyframes":
        return generation.keyframe_specs(db, project, shots, body.only_missing, body.hero)
    if a == "videos":
        if body.quality and body.quality not in catalog.QUALITY_MODES:
            raise HTTPException(400, "bad quality")
        return generation.video_specs(db, project, shots, body.quality, body.only_missing, body.mode)
    if a == "voices":
        return generation.voice_specs(db, project, shots, lang)
    if a == "lipsync":
        need = [s for s in shots if budget.Estimator.needs_lipsync(s, project, lang) or body.shot_ids]
        narr = [s for s in shots if (s.narration or {}).get(lang) and s not in need]
        return generation.lipsync_specs(db, project, need, lang, body.model) + generation.voice_specs(db, project, narr, lang)
    if a == "voicelock":
        return generation.voicelock_specs(db, project, shots)
    if a == "music":
        return [generation.music_spec(db, project, episode, body.prompt)]
    if a == "animatic":
        return [generation.render_spec(project, episode, lang, "animatic", body.preset or "draft",
                                       _render_options(body))]
    if a == "export":
        preset = body.preset or ("youtube" if project.aspect == "16:9" else "shorts")
        if preset not in catalog.EXPORT_PRESETS:
            raise HTTPException(400, "bad preset")
        return [generation.render_spec(project, episode, lang, "final", preset,
                                       _render_options(body, publish=body.publish))]
    if a == "dub":
        if not body.language or body.language == project.primary_language:
            raise HTTPException(400, "Pick a language different from the primary language")
        return [generation.dub_spec(db, project, episode, body.language, body.preset)]
    if a == "autopilot":
        ap = project.autopilot or {}
        if body.resume:
            if ap.get("status") != "paused":
                raise HTTPException(400, "Autopilot isn't paused")
            order = [m["id"] for m in autopilot_def.MILESTONES]
            done_at = order.index(ap["paused_after"]) if ap.get("paused_after") in order else -1
            through = ap.get("through") or "final"
            pauses = [m for m in (ap.get("pause_after") or []) if m in order and order.index(m) > done_at]
            payload = {"through": through, "pause_after": pauses, "resume": True, "log": (ap.get("log") or [])[-30:]}
        else:
            if ap.get("status") in ("running",) and _job_active(db, ap.get("job_id")):
                raise HTTPException(400, "Autopilot is already running for this project")
            through = body.through
            payload = {"through": through, "pause_after": [m for m in (body.pause_after or []) if m in autopilot_def.MILESTONE_BY_ID]}
        stage = autopilot_def.resolve_through(through)
        label = autopilot_def.MILESTONE_BY_ID.get(through, {}).get("label") or autopilot_def.STAGE_LABELS.get(stage, stage)
        est = generation.autopilot_estimate(db, project, episode)
        return [jobs.spec("autopilot", payload=payload, project_id=project.id, episode_id=episode.id,
                          estimate=est, label=f"Autopilot → {label}{' (continue)' if body.resume else ''}")]
    if a == "produce":
        steps = [s for s in generation.PRODUCE_STEPS if s in (body.steps or generation.PRODUCE_STEPS)]
        if not steps:
            raise HTTPException(400, f"steps must be some of {generation.PRODUCE_STEPS}")
        if body.quality and body.quality not in catalog.QUALITY_MODES:
            raise HTTPException(400, "bad quality")
        if not shots:
            raise HTTPException(400, "The shot list is empty: add or import shots first")
        total, items = generation.produce_plan(db, project, episode, shots, steps, body.quality, lang)
        if not items:
            return []
        return [jobs.spec("produce", payload={"steps": steps, "shot_ids": body.shot_ids, "quality": body.quality,
                                              "language": body.language, "items": items},
                          project_id=project.id, episode_id=episode.id, estimate=total,
                          label=f"Produce all E{episode.number:02} ({len(shots)} shots)")]
    raise HTTPException(400, f"unknown action {a}")


@router.post("/episodes/{eid}/estimate")
def estimate(eid: int, body: BatchIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e = get_or_404(db, Episode, eid)
    p = db.get(Project, e.project_id)
    specs = _specs(db, p, e, body)
    s = generation.summary_for(specs)
    if body.action == "produce" and specs:  # show the run step by step in the cost dialog
        s["items"] = specs[0]["payload"]["items"]
    s["budget"] = budget.check(db, user, p, s["total_usd"])
    s["team"] = budget.team_status(db)
    return s


@router.post("/episodes/{eid}/generate")
def generate(eid: int, body: BatchIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e = get_or_404(db, Episode, eid)
    p = db.get(Project, e.project_id)
    specs = _specs(db, p, e, body)
    if not specs:
        return {"status": "nothing_to_do", "jobs": [], "total_usd": 0, "batch_id": ""}
    return jobs.submit(db, user, p, specs)


# ── single-shot actions ──────────────────────────────────────────────────────

class ShotGenIn(BaseModel):
    quality: str | None = None
    mode: str | None = None
    language: str | None = None
    hero: bool = False
    prompt: str = ""
    model: str | None = None


def _shot_ctx(db: Session, sid: int, user: User | None = None) -> tuple[Shot, Episode, Project]:
    s = get_or_404(db, Shot, sid)
    if user is not None:
        collab.check_shot(user, s)  # don't generate from a shot someone is in the middle of editing
    e = db.get(Episode, s.episode_id)
    return s, e, db.get(Project, e.project_id)


@router.post("/shots/{sid}/keyframe")
def shot_keyframe(sid: int, body: ShotGenIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    s, e, p = _shot_ctx(db, sid, user)
    return jobs.submit(db, user, p, generation.keyframe_specs(db, p, [s], hero=body.hero))


@router.post("/shots/{sid}/video")
def shot_video(sid: int, body: ShotGenIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    s, e, p = _shot_ctx(db, sid, user)
    return jobs.submit(db, user, p, generation.video_specs(db, p, [s], body.quality, mode=body.mode))


@router.post("/shots/{sid}/extend")
def shot_extend(sid: int, body: ShotGenIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    s, e, p = _shot_ctx(db, sid, user)
    if not current(db, s.id, "video"):
        raise HTTPException(400, "Generate a video first")
    return jobs.submit(db, user, p, [generation.extend_spec(db, p, s, body.prompt)])


@router.post("/shots/{sid}/voice")
def shot_voice(sid: int, body: ShotGenIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    s, e, p = _shot_ctx(db, sid, user)
    specs = generation.voice_specs(db, p, [s], body.language or p.primary_language)
    if not specs:
        raise HTTPException(400, "This shot has no dialogue or narration in that language")
    return jobs.submit(db, user, p, specs)


@router.post("/shots/{sid}/lipsync")
def shot_lipsync(sid: int, body: ShotGenIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    s, e, p = _shot_ctx(db, sid, user)
    specs = generation.lipsync_specs(db, p, [s], body.language or p.primary_language, body.model)
    if not specs:
        raise HTTPException(400, "Needs a video and dialogue in that language")
    return jobs.submit(db, user, p, specs)


@router.post("/shots/{sid}/voicelock")
def shot_voicelock(sid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    s, e, p = _shot_ctx(db, sid, user)
    ok, why = generation.voicelock_eligible(db, p, s)
    if not ok:
        raise HTTPException(400, f"Voice lock not possible: {why}")
    return jobs.submit(db, user, p, generation.voicelock_specs(db, p, [s]))


class EditIn(BaseModel):
    instruction: str


@router.post("/takes/{tid}/edit")
def edit_take(tid: int, body: EditIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    t = get_or_404(db, Take, tid)
    if t.kind not in ("video", "lipsync", "voicelock"):
        raise HTTPException(400, "Only video takes can be edited")
    s, e, p = _shot_ctx(db, t.shot_id)
    return jobs.submit(db, user, p, [generation.omni_edit_spec(db, p, t, body.instruction)])
