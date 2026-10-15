"""Start and end frames (core/frames.py): a shot's end frame, a scene's storyboard frames, and the image engine a
project's frames are made with (Seedream for a Seedance film …)."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import settings_store
from ..core import collab, frames, generation, jobs, model_hub
from ..db import get_db
from ..events import emit
from ..models import AIModel, Episode, Job, Project, Scene, Shot, Take, User
from ..pipeline.selection import current, select
from ..providers.services import provider_mode
from ..security import current_user, require
from ..storage import get_storage
from .common import get_or_404, shot_out
from .hub import model_out
from .shots import _read_image

router = APIRouter(prefix="/api", tags=["frames"])


# ── the frames engine ────────────────────────────────────────────────────────

@router.get("/projects/{pid}/frames-engines")
def frames_engines(pid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Image engines this project's start and end frames can be made with (they must take reference images), with a
    price per image. "" = Auto: the team's image chain (Google first)."""
    p = get_or_404(db, Project, pid)
    pol = model_hub.policy(db).get("image", [])
    out = []
    for m in frames.image_engines(db):
        d = {k: v for k, v in model_out(m).items() if k in ("id", "provider", "display_name", "family", "tier", "price_label",
                                                             "price_source", "provider_mode", "builtin")}
        d.update(est_usd=round(model_hub.price_for(m), 4), max_refs=int((m.capabilities or {}).get("max_refs") or 0),
                 in_chain=m.id in pol)
        out.append(d)
    out.sort(key=lambda d: (not d["in_chain"], pol.index(d["id"]) if d["in_chain"] else 0, d["provider"] != "google",
                            d["display_name"]))
    first = model_hub.first_choice(db, "image", ["i2i"])
    return {"engines": out, "current": p.frames_engine or "", "auto_first": first[0].id if first else None,
            "google_first": settings_store.get_setting(db, "google_first") is not False}


class FramesEngineIn(BaseModel):
    engine: str = Field("", max_length=200)  # "" = the team's image chain


@router.put("/projects/{pid}/frames-engine")
def set_frames_engine(pid: int, body: FramesEngineIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    p = get_or_404(db, Project, pid)
    eid = body.engine.strip()
    if eid:
        m = db.get(AIModel, eid)
        if m is None or m.task != "image" or m.status != "enabled":
            raise HTTPException(400, "Pick an enabled image engine")
        if "i2i" not in ((m.capabilities or {}).get("modes") or []):
            raise HTTPException(400, f"{m.display_name} can't take reference images, so frames would not follow the cast")
    p.frames_engine = eid
    db.commit()
    emit(db, p.id, "project.updated", {"what": ["frames_engine"]}, user_id=user.id)
    return {"frames_engine": eid}


# ── a shot's end frame ───────────────────────────────────────────────────────

def _shot(db: Session, sid: int, user: User) -> tuple[Shot, Project]:
    s = get_or_404(db, Shot, sid)
    collab.check_shot(user, s)
    e = db.get(Episode, s.episode_id)
    return s, db.get(Project, e.project_id)


class EndFrameIn(BaseModel):
    hero: bool = False
    engine: str | None = None  # an image engine for this one frame (default: the project's frames engine)


@router.post("/shots/{sid}/endframe")
def make_end_frame(sid: int, body: EndFrameIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Make this shot's end frame: the same shot seconds later, where the action has got to (Shot.end_note). Its
    start frame is made first when it has none. The video then runs from the start frame to it."""
    s, p = _shot(db, sid, user)
    if body.engine and (m := db.get(AIModel, body.engine)) is not None and m.task != "image":
        raise HTTPException(400, "Pick an image engine")
    return jobs.submit(db, user, p, [generation.endframe_spec(db, p, s, body.hero, body.engine or None)])


@router.post("/shots/{sid}/endframe/upload")
async def upload_end_frame(sid: int, file: UploadFile = File(...), user: User = Depends(require("creator")),
                           db: Session = Depends(get_db)):
    """Use your own image as this shot's end frame: the clip runs from the start frame to it."""
    from ..pipeline import ffmpeg as ff

    s, p = _shot(db, sid, user)
    data, ext = await _read_image(file)
    st = get_storage()
    folder = f"projects/{p.id}/shots/{s.id}/{frames.END}"

    def ingest() -> tuple[str, str]:  # the disk write and the FFmpeg thumbnail: in a thread, off the event loop
        rel = st.save_bytes(st.new_path(folder, ext), data)
        try:
            return rel, st.save_file(st.new_path(folder, "jpg"), ff.thumbnail(st.abs(rel), st.abs(rel).with_suffix(".thumb.jpg")))
        except Exception:
            return rel, ""

    rel, thumb = await asyncio.to_thread(ingest)
    kf = current(db, s.id, "keyframe")
    t = Take(shot_id=s.id, kind=frames.END, provider="upload", model="your image", path=rel, thumb_path=thumb,
             params={"uploaded": True, "filename": (file.filename or "")[:120], "engine_label": "Your image",
                     "start_take_id": kf.id if kf else None}, created_by=user.id)
    db.add(t)
    db.flush()
    select(db, t)
    if s.mode == "text_to_video":
        s.mode = "auto"  # an end frame of your own means: animate from the start frame to this one
    db.commit()
    emit(db, p.id, "take.created", {"shot_id": s.id, "take_id": t.id, "kind": frames.END}, user_id=user.id)
    return shot_out(db, s, p)


@router.delete("/shots/{sid}/endframe")
def clear_end_frame(sid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Stop using an end frame: the clip starts from the start frame only (the end frames stay in the archive). A
    shot that starts on this end frame keeps its own start frame, but the link then waits for a new end frame."""
    s, p = _shot(db, sid, user)
    n = 0
    for t in db.query(Take).filter(Take.shot_id == s.id, Take.kind == frames.END, Take.archived.is_(False)).all():
        t.archived, t.selected = True, False
        n += 1
    db.commit()
    emit(db, p.id, "shot.updated", {"shot_id": s.id}, user_id=user.id)
    return {**shot_out(db, s, p), "archived": n}


# ── a scene's storyboard frames ──────────────────────────────────────────────

class StoryboardIn(BaseModel):
    scene_ids: list[int] | None = None  # these scenes' shots, in order (default: the whole episode)
    shot_ids: list[int] | None = None  # or just these shots
    end_frames: bool = True  # an end frame for every shot (else only where a shot starts on one)
    sync: bool = False  # each shot of a scene after its first starts exactly on the end frame before (synced links)
    redo: bool = False  # remake frames that are already good
    engine: str | None = None  # an image engine for this run (default: the project's frames engine)
    hero: bool = False


def _storyboard_shots(db: Session, ep: Episode, body: StoryboardIn) -> list[Shot]:
    shots = generation.episode_shots(db, ep, body.shot_ids)
    if body.scene_ids:
        order = {sid: i for i, sid in enumerate(
            sc.id for sc in db.query(Scene).filter(Scene.id.in_(body.scene_ids), Scene.episode_id == ep.id)
            .order_by(Scene.order, Scene.id).all())}
        shots = sorted([s for s in shots if s.scene_id in order], key=lambda s: (order[s.scene_id], s.order, s.id))
    if not shots:
        raise HTTPException(400, "No shots to make frames for")
    return shots


def _check_engine(db: Session, engine: str | None) -> str | None:
    if not engine:
        return None
    m = db.get(AIModel, engine)
    if m is None or m.task != "image" or m.status != "enabled" or "i2i" not in ((m.capabilities or {}).get("modes") or []):
        raise HTTPException(400, "Pick an enabled image engine that takes reference images")
    if provider_mode(m.provider) == "missing":
        raise HTTPException(400, f"{m.display_name}: add its API key in Settings first")
    return engine


@router.post("/episodes/{eid}/storyboard-frames/plan")
def storyboard_plan(eid: int, body: StoryboardIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """What a storyboard run would make, frame by frame, and what it costs (nothing is changed)."""
    ep = get_or_404(db, Episode, eid)
    p = db.get(Project, ep.project_id)
    shots = _storyboard_shots(db, ep, body)
    engine = _check_engine(db, body.engine)
    return frames.plan(db, p, shots, end_frames=body.end_frames, redo=body.redo, engine=engine, sync=body.sync,
                       hero=body.hero)


@router.post("/episodes/{eid}/storyboard-frames")
def storyboard_start(eid: int, body: StoryboardIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Make the start and end frames of these shots in order (each frame follows the one before; synced shots start
    on the end frame before). One run per episode at a time."""
    ep = get_or_404(db, Episode, eid)
    p = db.get(Project, ep.project_id)
    if db.query(Job.id).filter(Job.episode_id == ep.id, Job.type == "storyboard_frames",
                               Job.status.in_(jobs.ACTIVE)).first():
        raise HTTPException(409, "A storyboard run is already working on this episode")
    shots = _storyboard_shots(db, ep, body)
    engine = _check_engine(db, body.engine)
    spec, pl = generation.storyboard_spec(db, p, ep, shots, end_frames=body.end_frames, sync=body.sync, redo=body.redo,
                                          engine=engine, hero=body.hero)
    if not pl["steps"] and not body.sync:
        return {"status": "nothing", "plan": pl, "jobs": []}
    return {**jobs.submit(db, user, p, [spec]), "plan": pl}
