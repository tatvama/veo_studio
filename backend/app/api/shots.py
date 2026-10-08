"""Shots (edit, reorder, undo, approve) and takes (select, archive)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core import collab, studio
from ..db import get_db
from ..events import emit
from ..models import Episode, Project, Shot, Take, User
from ..pipeline.prompting import compile_keyframe_prompt, compile_video_prompt, keyframe_refs, video_refs
from ..pipeline.selection import select
from ..security import current_user, require
from ..storage import get_storage
from .common import get_or_404, shot_out, take_out

router = APIRouter(prefix="/api", tags=["shots"])


def _project(db: Session, shot: Shot) -> Project:
    return db.get(Project, db.get(Episode, shot.episode_id).project_id)


@router.get("/shots/{sid}")
def get_shot(sid: int, lang: str | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    s = get_or_404(db, Shot, sid)
    p = _project(db, s)
    takes = db.query(Take).filter(Take.shot_id == sid, Take.archived.is_(False)).order_by(Take.id.desc()).all()
    return shot_out(db, s, p, lang) | {"takes": [take_out(t) for t in takes]}


@router.get("/shots/{sid}/prompt")
def shot_prompt(sid: int, lang: str | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    s = get_or_404(db, Shot, sid)
    p = _project(db, s)
    krefs = keyframe_refs(db, s, None)
    return {"video_prompt": compile_video_prompt(db, s, p, lang), "keyframe_prompt": compile_keyframe_prompt(db, s, p, [l for l, _ in krefs]),
            "video_refs": [l for l, _ in video_refs(db, s)], "keyframe_refs": [l for l, _ in krefs]}


class ShotIn(BaseModel):
    scene_id: int | None = None
    after_shot_id: int | None = None
    action: str = ""
    framing: str = "medium shot"
    camera: str = "static"
    duration_s: int = 6


@router.post("/episodes/{eid}/shots")
def add_shot(eid: int, body: ShotIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e = get_or_404(db, Episode, eid)
    order = 10_000
    if body.after_shot_id:
        after = get_or_404(db, Shot, body.after_shot_id)
        order = after.order
        for s in db.query(Shot).filter(Shot.episode_id == eid, Shot.order > after.order).all():
            s.order += 1
        order += 1
    s = Shot(episode_id=eid, scene_id=body.scene_id, order=order, action=body.action, framing=body.framing,
             camera=body.camera, duration_s=body.duration_s if body.duration_s in (4, 6, 8) else 6)
    db.add(s)
    db.flush()
    studio.renumber(db, e)
    db.commit()
    emit(db, e.project_id, "episode.updated", {"episode_id": eid, "what": "shots"}, user_id=user.id)
    return s.to_dict()


class ShotPatch(BaseModel):
    duration_s: int | None = None
    framing: str | None = None
    camera: str | None = None
    action: str | None = None
    characters: list[int] | None = None
    outfits: dict[str, str] | None = None
    location_id: int | None = None
    dialogue: dict[str, list[dict[str, Any]]] | None = None
    narration: dict[str, str] | None = None
    sfx: str | None = None
    music_cue: str | None = None
    mode: str | None = None
    quality_mode: str | None = None
    voice_mode: str | None = None
    engine: str | None = None
    continuity_from_prev: bool | None = None
    include: bool | None = None
    trim_in: float | None = None
    trim_out: float | None = None
    notes: str | None = None
    scene_id: int | None = None
    extend_to: int | None = None
    extend_prompt: str | None = None


@router.patch("/shots/{sid}")
def patch_shot(sid: int, body: ShotPatch, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    s = get_or_404(db, Shot, sid)
    collab.check_shot(user, s)
    data = body.model_dump(exclude_unset=True)
    if "duration_s" in data and data["duration_s"] not in (4, 6, 8):
        raise HTTPException(400, "duration must be 4, 6 or 8 seconds")
    if data.get("quality_mode") == "":
        data["quality_mode"] = None
    if "trim_in" in data or "trim_out" in data:  # always keep at least half a second of the clip
        from ..pipeline.selection import current as cur_take
        v = cur_take(db, s.id, "lipsync", None) or cur_take(db, s.id, "video")
        length = float(v.duration_s) if v and v.duration_s else float(s.duration_s)
        ti = max(0.0, float(data.get("trim_in", s.trim_in) or 0))
        to = max(0.0, float(data.get("trim_out", s.trim_out) or 0))
        if ti + to > length - 0.5:
            raise HTTPException(400, f"Trims leave less than half a second of this {length:.1f}s clip")
        data["trim_in"], data["trim_out"] = round(ti, 3), round(to, 3)
    studio.save_revision(db, "shot", s, studio.SHOT_FIELDS, user)
    for k, v in data.items():
        setattr(s, k, v)
    if s.status == "approved" and any(k in data for k in ("action", "framing", "camera", "characters", "dialogue")):
        s.status = "video_ready"
    db.commit()
    p = _project(db, s)
    emit(db, p.id, "shot.updated", {"shot_id": s.id}, user_id=user.id)
    return shot_out(db, s, p)


@router.post("/shots/{sid}/undo")
def undo_shot(sid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    s = get_or_404(db, Shot, sid)
    collab.check_shot(user, s)
    if not studio.undo(db, "shot", s):
        raise HTTPException(400, "Nothing to undo")
    p = _project(db, s)
    emit(db, p.id, "shot.updated", {"shot_id": s.id}, user_id=user.id)
    return shot_out(db, s, p)


@router.delete("/shots/{sid}")
def delete_shot(sid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    s = get_or_404(db, Shot, sid)
    collab.check_shot(user, s)
    e = db.get(Episode, s.episode_id)
    if db.query(Take).filter(Take.shot_id == sid).count():
        s.include = False  # keep paid media; just drop it from the cut
    else:
        db.delete(s)
    db.flush()
    studio.renumber(db, e)
    db.commit()
    emit(db, e.project_id, "episode.updated", {"episode_id": e.id, "what": "shots"}, user_id=user.id)
    return {"ok": True}


IMG_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}


async def _read_image(file: UploadFile) -> tuple[bytes, str]:
    ext = IMG_TYPES.get((file.content_type or "").split(";")[0])
    if not ext:
        raise HTTPException(400, "Upload a PNG, JPG or WEBP image")
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(400, "Image too large (max 15 MB)")
    return data, ext


@router.post("/shots/{sid}/keyframe/upload")
async def upload_keyframe(sid: int, file: UploadFile = File(...), user: User = Depends(require("creator")),
                          db: Session = Depends(get_db)):
    """Use your own image as this shot's keyframe. It becomes the current keyframe, and the video starts from it."""
    from ..pipeline import ffmpeg as ff

    s = get_or_404(db, Shot, sid)
    collab.check_shot(user, s)
    data, ext = await _read_image(file)
    st = get_storage()
    p = _project(db, s)
    folder = f"projects/{p.id}/shots/{s.id}/keyframe"
    rel = st.save_bytes(st.new_path(folder, ext), data)
    thumb = ""
    try:
        thumb = st.save_file(st.new_path(folder, "jpg"), ff.thumbnail(st.abs(rel), st.abs(rel).with_suffix(".thumb.jpg")))
    except Exception:
        pass
    t = Take(shot_id=s.id, kind="keyframe", provider="upload", model="your image", path=rel, thumb_path=thumb,
             params={"uploaded": True, "filename": (file.filename or "")[:120], "engine_label": "Your image"}, created_by=user.id)
    db.add(t)
    db.flush()
    select(db, t)
    if s.mode == "text_to_video":
        s.mode = "auto"  # a keyframe of your own means: animate this frame
    if s.status in ("draft", "keyframe_ready"):
        s.status = "keyframe_ready"
    db.commit()
    emit(db, p.id, "take.created", {"shot_id": s.id, "take_id": t.id, "kind": "keyframe"}, user_id=user.id)
    return shot_out(db, s, p)


@router.post("/shots/{sid}/refs")
async def add_shot_ref(sid: int, file: UploadFile = File(...), label: str = Form(""), user: User = Depends(require("creator")),
                       db: Session = Depends(get_db)):
    """Attach a reference image to this shot (a product, a prop, a look). Used for its keyframe and video."""
    s = get_or_404(db, Shot, sid)
    collab.check_shot(user, s)
    if len(s.ref_images or []) >= 4:
        raise HTTPException(400, "A shot can have up to 4 reference images")
    data, ext = await _read_image(file)
    st = get_storage()
    p = _project(db, s)
    rel = st.save_bytes(st.new_path(f"projects/{p.id}/shots/{s.id}/refs", ext), data)
    studio.save_revision(db, "shot", s, studio.SHOT_FIELDS, user)
    s.ref_images = [*(s.ref_images or []), {"path": rel, "label": (label.strip() or (file.filename or "reference").rsplit(".", 1)[0])[:80]}]
    db.commit()
    emit(db, p.id, "shot.updated", {"shot_id": s.id}, user_id=user.id)
    return shot_out(db, s, p)


@router.delete("/shots/{sid}/refs/{index}")
def remove_shot_ref(sid: int, index: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    s = get_or_404(db, Shot, sid)
    collab.check_shot(user, s)
    refs = list(s.ref_images or [])
    if not 0 <= index < len(refs):
        raise HTTPException(404, "No such reference")
    studio.save_revision(db, "shot", s, studio.SHOT_FIELDS, user)
    refs.pop(index)
    s.ref_images = refs
    db.commit()
    p = _project(db, s)
    emit(db, p.id, "shot.updated", {"shot_id": s.id}, user_id=user.id)
    return shot_out(db, s, p)


class ReorderIn(BaseModel):
    shot_ids: list[int]


@router.post("/episodes/{eid}/shots/reorder")
def reorder(eid: int, body: ReorderIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e = get_or_404(db, Episode, eid)
    rows = {s.id: s for s in db.query(Shot).filter(Shot.episode_id == eid).all()}
    for i, sid in enumerate(body.shot_ids, 1):
        if sid in rows:
            rows[sid].order = i
    for s in rows.values():
        if s.id not in body.shot_ids:
            s.order = 5000 + s.order
    studio.renumber(db, e)
    db.commit()
    emit(db, e.project_id, "episode.updated", {"episode_id": eid, "what": "order"}, user_id=user.id)
    return {"ok": True}


class ApproveIn(BaseModel):
    approved: bool = True


@router.post("/shots/{sid}/approve")
def approve_shot(sid: int, body: ApproveIn, user: User = Depends(require("reviewer")), db: Session = Depends(get_db)):
    s = get_or_404(db, Shot, sid)
    s.status = "approved" if body.approved else "video_ready"
    db.commit()
    p = _project(db, s)
    emit(db, p.id, "shot.updated", {"shot_id": s.id, "status": s.status, "by": user.name or user.email}, user_id=user.id)
    return shot_out(db, s, p)


@router.post("/takes/{tid}/select")
def select_take(tid: int, user: User = Depends(require("reviewer")), db: Session = Depends(get_db)):
    t = get_or_404(db, Take, tid)
    select(db, t)
    db.commit()
    s = db.get(Shot, t.shot_id)
    p = _project(db, s)
    emit(db, p.id, "shot.updated", {"shot_id": s.id, "selected_take": t.id}, user_id=user.id)
    return take_out(t)


@router.post("/takes/{tid}/archive")
def archive_take(tid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    t = get_or_404(db, Take, tid)
    t.archived = True
    t.selected = False
    db.commit()
    s = db.get(Shot, t.shot_id)
    emit(db, _project(db, s).id, "shot.updated", {"shot_id": s.id}, user_id=user.id)
    return {"ok": True}
