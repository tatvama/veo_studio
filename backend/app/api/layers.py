"""Timeline layers: extra video & audio tracks over the shots, and the media they use."""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..events import emit
from ..models import Episode, User
from ..pipeline import ffmpeg as ff
from ..pipeline import layers as layerlib
from ..security import current_user, require
from ..storage import get_storage
from .common import get_or_404

router = APIRouter(prefix="/api", tags=["layers"])

KINDS = {  # extension → (kind, max MB)
    "mp4": ("video", 400), "mov": ("video", 400), "webm": ("video", 400), "m4v": ("video", 400),
    "mp3": ("audio", 80), "wav": ("audio", 200), "m4a": ("audio", 80), "aac": ("audio", 80), "ogg": ("audio", 80),
    "flac": ("audio", 200), "png": ("image", 25), "jpg": ("image", 25), "jpeg": ("image", 25), "webp": ("image", 25),
}


def _out(e: Episode) -> dict[str, Any]:
    st = get_storage()
    L = dict(e.layers or {})
    with_urls = lambda clips: [{**c, "url": st.url(c["src"])} for c in clips]  # noqa: E731
    return {"rev": int(L.get("rev") or 0),
            "video": [{**t, "clips": with_urls(t.get("clips") or [])} for t in L.get("video") or []],
            "audio": [{**t, "clips": with_urls(t.get("clips") or [])} for t in L.get("audio") or []],
            "holds": dict(L.get("holds") or {}),
            "media": [{**m, "url": st.url(m["src"]), "thumb_url": st.url(m.get("thumb") or "")} for m in L.get("media") or []]}


@router.get("/episodes/{eid}/layers")
def get_layers(eid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _out(get_or_404(db, Episode, eid))


class LayersIn(BaseModel):
    rev: int
    video: list[dict[str, Any]] = []
    audio: list[dict[str, Any]] = []
    holds: dict[str, Any] | None = None  # {shot_id: seconds} freeze after a shot (timeline "hold" mode); omitted = unchanged


@router.put("/episodes/{eid}/layers")
def put_layers(eid: int, body: LayersIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Save the layers. `rev` must be the one you loaded: if a teammate saved in between, you get 409 and reload."""
    e = get_or_404(db, Episode, eid)
    cur = dict(e.layers or {})
    if int(cur.get("rev") or 0) != body.rev:
        raise HTTPException(409, "The layers were changed by someone else since you loaded them. Reload to see their changes.")
    holds = body.holds if body.holds is not None else cur.get("holds")
    clean = layerlib.clean({"video": body.video, "audio": body.audio, "holds": holds}, e.project_id, cur.get("media"))
    e.layers = {**cur, **clean, "rev": body.rev + 1}
    db.commit()
    emit(db, e.project_id, "episode.updated", {"episode_id": eid, "what": "layers"}, user_id=user.id)
    return _out(e)


@router.post("/episodes/{eid}/media")
async def upload_media(eid: int, file: UploadFile = File(...), user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Add a video, sound or picture the layers can use (B-roll, a logo, a voice-over, a song…)."""
    e = get_or_404(db, Episode, eid)
    name = file.filename or "media"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in KINDS:
        raise HTTPException(400, "Upload a video (mp4, mov, webm), sound (mp3, wav, m4a, ogg, flac) or picture (png, jpg, webp)")
    kind, max_mb = KINDS[ext]
    data = await file.read()
    if len(data) > max_mb * 1024 * 1024:
        raise HTTPException(400, f"That file is too large (max {max_mb} MB for {kind})")
    st = get_storage()
    folder = f"projects/{e.project_id}/layers"
    rel = st.save_bytes(f"{folder}/{uuid.uuid4().hex[:12]}.{ext}", data)
    path = st.abs(rel)
    try:
        duration = 0.0 if kind == "image" else ff.duration(path)
    except Exception:
        raise HTTPException(400, "Couldn't read that file — is it a valid video / sound / picture?")
    thumb = ""
    if kind in ("video", "image"):
        try:
            thumb = st.save_file(f"{folder}/{path.stem}.thumb.jpg", ff.thumbnail(path, path.with_suffix(".thumb.jpg")))
        except Exception:
            thumb = ""
    item = {"src": rel, "kind": kind, "name": name[:80], "duration": round(duration, 3), "thumb": thumb}
    L = dict(e.layers or {})
    L["media"] = [*(L.get("media") or []), item]  # the library doesn't bump rev: it never conflicts with an edit
    e.layers = L
    db.commit()
    emit(db, e.project_id, "episode.updated", {"episode_id": eid, "what": "media"}, user_id=user.id)
    return {**item, "url": st.url(rel), "thumb_url": st.url(thumb)}


class MediaRef(BaseModel):
    src: str


@router.post("/episodes/{eid}/media/remove")
def remove_media(eid: int, body: MediaRef, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e = get_or_404(db, Episode, eid)
    L = dict(e.layers or {})
    used = any(c.get("src") == body.src for k in ("video", "audio") for t in L.get(k) or [] for c in t.get("clips") or [])
    if used:
        raise HTTPException(400, "It's still used on a layer — remove those clips first")
    L["media"] = [m for m in L.get("media") or [] if m.get("src") != body.src]
    e.layers = L
    db.commit()
    emit(db, e.project_id, "episode.updated", {"episode_id": eid, "what": "media"}, user_id=user.id)
    return {"ok": True}
