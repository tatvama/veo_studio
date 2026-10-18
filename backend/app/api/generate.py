"""Every paid action: estimate first, then generate (budget-checked, may need approval)."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import catalog
from ..core import autopilot as autopilot_def
from ..core import budget, collab, generation, jobs, recovery, sheet_engine
from ..db import get_db
from ..models import Character, Episode, Location, Project, Shot, Take, User, VoiceProfile
from ..pipeline.prompting import dialogue_warnings
from ..pipeline.selection import current, has_fresh
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
    ambience: bool | None = None  # renders: the scene's background under dialogue shots whose sound was replaced
    music_per_scene: bool | None = None  # produce / music: one piece per scene (None: two or more scenes, not scored yet)
    steps: list[str] | None = None  # produce: which of generation.PRODUCE_STEPS to run (default all)
    review_looks: bool = False  # produce: stop after new cast looks & voices so they can be checked
    link_scenes: Literal["auto", "never"] = "never"  # produce: a scene that picks up straight from the last starts on its last frame
    pause_after: list[str] | None = None  # autopilot: milestones to stop at for approval
    resume: bool = False  # autopilot: continue the paused run (same target, the stops still ahead)


def _render_options(body: BatchIn, **extra) -> dict:
    opts = {"captions": body.captions, "music": body.music, **extra}
    for k in ("caption_style", "auto_reframe", "sfx", "ambience"):
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
        narr = [s for s in shots if budget.Estimator.voice_only(s, project, lang) and s not in need]
        return generation.lipsync_specs(db, project, need, lang, body.model) + generation.voice_specs(db, project, narr, lang)
    if a == "voicelock":
        return generation.voicelock_specs(db, project, shots)
    if a == "music":
        return [generation.music_spec(db, project, episode, body.prompt, per_scene=bool(body.music_per_scene))]
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
        per_scene = (generation.music_per_scene_default(db, episode) if body.music_per_scene is None
                     else body.music_per_scene)  # decided here, so the run makes what the estimate priced
        total, items = generation.produce_plan(db, project, episode, shots, steps, body.quality, lang, body.link_scenes,
                                               music_per_scene=per_scene)
        if not items:
            return []
        return [jobs.spec("produce", payload={"steps": steps, "shot_ids": body.shot_ids, "quality": body.quality,
                                              "language": body.language, "items": items,
                                              "review_looks": body.review_looks, "link_scenes": body.link_scenes,
                                              "music_per_scene": per_scene},
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
    s["warnings"] = _warnings(db, p, e, body, specs)
    return s


def _warnings(db: Session, project: Project, episode: Episode, body: BatchIn, specs: list[dict]) -> list[str]:
    """What to know before paying, shown in the cost dialog: shots that will be lip-synced with no live lip-sync
    engine connected (their voices would be laid over the clips, lips not matching), or with more than one person on
    screen; lines too long for their clip or spoken by two people (prompting.dialogue_warnings); and people Seedance may
    refuse because they aren't registered with BytePlus."""
    lang = body.language or project.primary_language
    syncing: list = []
    shots = generation.episode_shots(db, episode, body.shot_ids)
    if body.action == "lipsync":
        syncing = [x for x in specs if x["type"] == "lipsync"]
        lip_shots = [s for s in shots if s.id in {x["shot_id"] for x in syncing}]
    elif body.action in ("produce", "autopilot") and specs and (body.action == "autopilot"
                                                                or "voices" in specs[0]["payload"]["steps"]):
        syncing = lip_shots = [s for s in shots if budget.Estimator.needs_lipsync(s, project, lang)
                               and not has_fresh(db, s.id, "lipsync", lang)]
    else:
        lip_shots = []
    out = generation.lipsync_warnings(db, syncing) + generation.speaker_warnings(db, project, lip_shots, lang)
    if body.action in ("produce", "videos", "lipsync", "voices", "autopilot") and specs:
        said = [f"{s.code}: {w}" for s in shots for w in dialogue_warnings(s, lang)]
        out += said[:8] + ([f"… and {len(said) - 8} more like these"] if len(said) > 8 else [])
    making = body.action == "videos" or (body.action == "produce" and specs and "videos" in specs[0]["payload"]["steps"])
    if making or (body.action == "autopilot" and specs):
        out += recovery.seedance_warnings(db, project, [s for s in shots if s.characters], body.quality)
    return out


@router.post("/episodes/{eid}/generate")
def generate(eid: int, body: BatchIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e = get_or_404(db, Episode, eid)
    p = db.get(Project, e.project_id)
    specs = _specs(db, p, e, body)
    if not specs:
        return {"status": "nothing_to_do", "jobs": [], "total_usd": 0, "batch_id": ""}
    return jobs.submit(db, user, p, specs)


# ── a price for one paid action ──────────────────────────────────────────────

QuoteAction = Literal["extend", "endframe", "edit", "enhance", "sheet", "expressions", "lighting", "outfit", "variations",
                      "voice_design", "voice_preview", "location_images", "sfx", "table_read"]


class QuoteIn(BaseModel):
    """One single-item paid action, priced before it runs (batches use /episodes/{eid}/estimate). Each action names the
    item it acts on and takes the options of its own endpoint:
    shot (`shot_id`): extend · endframe; take (`take_id`): edit · enhance; character (`character_id`): sheet · expressions ·
    lighting · outfit · variations · voice_design; `voice_id`: voice_preview; `location_id`: location_images;
    episode (`episode_id`): sfx · table_read."""
    action: QuoteAction
    shot_id: int | None = None
    take_id: int | None = None
    character_id: int | None = None
    location_id: int | None = None
    voice_id: int | None = None
    episode_id: int | None = None
    project_id: int | None = None
    shot_ids: list[int] | None = None
    prompt: str = ""
    instruction: str = ""
    text: str = ""
    hero: bool = False
    engine: str | None = None
    language: str | None = None
    provider: str = "gemini"
    description: str = ""
    name: str = ""
    kinds: list[str] | None = None
    views: list[str] | None = None
    variants: list[str] | None = None
    time_of_day: str = ""
    count: int = 6


def _need(v: int | None, what: str) -> int:
    if v is None:
        raise HTTPException(400, f"{what} is required for this action")
    return v


def _char_engine(db: Session, c: Character, pick: str | None) -> str | None:
    """The engine a character's images would be made with, without remembering a new pick (the paid call does that)."""
    if pick is None:
        return sheet_engine.resolve(db, c, None)
    return None if pick.strip() in sheet_engine.AUTO else sheet_engine.check(db, pick.strip()).id


def _quote_specs(db: Session, body: QuoteIn) -> tuple[Project | None, list[dict]]:
    a = body.action
    if a in ("extend", "endframe"):
        s = get_or_404(db, Shot, _need(body.shot_id, "shot_id"))
        p = db.get(Project, db.get(Episode, s.episode_id).project_id)
        if a == "extend":
            return p, [generation.extend_spec(db, p, s, body.prompt)]
        return p, [generation.endframe_spec(db, p, s, body.hero, body.engine or None)]
    if a in ("edit", "enhance"):
        t = get_or_404(db, Take, _need(body.take_id, "take_id"))
        s = db.get(Shot, t.shot_id)
        p = db.get(Project, db.get(Episode, s.episode_id).project_id)
        return p, [generation.omni_edit_spec(db, p, t, body.instruction) if a == "edit" else generation.enhance_spec(db, p, s, t)]
    p = db.get(Project, body.project_id) if body.project_id else None
    if a == "voice_preview":
        vp = get_or_404(db, VoiceProfile, _need(body.voice_id, "voice_id"))
        return None, [generation.voice_preview_spec(db, vp, body.text)]
    if a == "location_images":
        loc = get_or_404(db, Location, _need(body.location_id, "location_id"))
        return p, [generation.location_images_spec(db, body.project_id, loc, body.kinds, body.time_of_day)]
    if a in ("sfx", "table_read"):
        e = get_or_404(db, Episode, _need(body.episode_id, "episode_id"))
        p = db.get(Project, e.project_id)
        if a == "sfx":
            return p, [generation.sfx_spec(db, p, e, body.shot_ids)]
        lang = body.language or p.primary_language
        if lang not in catalog.LANGUAGES:
            raise HTTPException(400, "unknown language")
        return p, [generation.table_read_spec(db, p, e, lang)]
    c = get_or_404(db, Character, _need(body.character_id, "character_id"))
    if a == "voice_design":
        return p, [generation.voice_design_spec(db, body.project_id, c, body.language or "en", body.provider, body.description)]
    if a == "variations":
        return p, [generation.identity_variations_spec(db, body.project_id, c, max(1, min(body.count, 12)))]
    engine = _char_engine(db, c, body.engine)
    if a == "sheet":
        return p, [generation.character_sheet_spec(db, body.project_id, c, body.kinds, engine)]
    if a == "expressions":
        return p, [generation.expressions_spec(db, body.project_id, c, engine)]
    if a == "lighting":
        return p, [generation.lighting_spec(db, body.project_id, c, body.variants, engine)]
    return p, [generation.outfit_spec(db, body.project_id, c, body.name or "Outfit", body.description, None, body.views, engine)]


@router.post("/estimate")
def quote(body: QuoteIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """What one paid action costs, in the same shape as the batch estimate: shown before the action runs, so nothing
    is spent without a price. Nothing is created or remembered."""
    p, specs = _quote_specs(db, body)
    s = generation.summary_for(specs)
    s["budget"] = budget.check(db, user, p, s["total_usd"])
    s["team"] = budget.team_status(db)
    s["warnings"] = []
    return s


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


@router.post("/takes/{tid}/enhance")
def enhance_take(tid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Re-render this keyframe with the Pro image model: same composition, framing and faces; better detail, skin,
    hands and lighting. Saved as a new take."""
    t = get_or_404(db, Take, tid)
    if t.kind != "keyframe" or t.archived:
        raise HTTPException(400, "Only keyframes can be enhanced")
    s, e, p = _shot_ctx(db, t.shot_id, user)
    return jobs.submit(db, user, p, [generation.enhance_spec(db, p, s, t)])
