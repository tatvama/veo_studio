"""Desktop finishing room (docs/DESKTOP.md §2): checkout lock, cut versions, manifest, render plan, render upload,
AI upscale and review notes. The logic lives in core/desktop.py."""
from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import settings_store
from ..core import desktop, jobs
from ..db import get_db
from ..events import emit
from ..models import Comment, CutLock, CutVersion, Episode, Export, Project, Take, User
from ..security import current_user, require
from .common import export_out, get_or_404, take_out, user_brief

router = APIRouter(prefix="/api", tags=["desktop"])


def _iso(dt) -> str | None:
    return dt.isoformat() + "Z" if dt else None


def lock_out(db: Session, lk: CutLock | None, user: User) -> dict | None:
    if lk is None:
        return None
    return {"episode_id": lk.episode_id, "user": user_brief(db.get(User, lk.user_id)), "client": lk.client, "machine": lk.machine,
            "acquired_at": _iso(lk.acquired_at), "heartbeat_at": _iso(lk.heartbeat_at), "mine": lk.user_id == user.id}


def version_out(db: Session, v: CutVersion, full: bool = False, users: dict[int, User] | None = None) -> dict:
    by = (users or {}).get(v.created_by) if users is not None else (db.get(User, v.created_by) if v.created_by else None)
    out = {"id": v.id, "episode_id": v.episode_id, "number": v.number, "note": v.note, "client": v.client,
           "created_by": user_brief(by), "created_at": _iso(v.created_at), "restored_from": v.restored_from, "stats": v.stats or {}}
    if full:
        out["snapshot"] = v.snapshot or {}
    return out


# ── checkout lock (§2.1) ─────────────────────────────────────────────────────

@router.get("/episodes/{eid}/checkout")
def get_checkout(eid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e = get_or_404(db, Episode, eid)
    lk = desktop.lock_of(db, eid)
    if lk:  # presence mirrors it (after a restart the mirror starts empty)
        from ..core import collab
        collab.set_cut(eid, e.project_id, db.get(User, lk.user_id))
    return {"lock": lock_out(db, lk, user)}


class CheckoutIn(BaseModel):
    client: str = "desktop"
    machine: str = Field("", max_length=200)
    force: bool = False


@router.post("/episodes/{eid}/checkout")
def checkout(eid: int, body: CheckoutIn, request: Request, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Check the cut out: until you check in, cut edits by anyone else are refused. `force` (producers) takes it over."""
    lk = desktop.checkout(db, get_or_404(db, Episode, eid), user, body.client, body.machine, body.force, request)
    return {"lock": lock_out(db, lk, user)}


@router.post("/episodes/{eid}/checkout/heartbeat")
def checkout_heartbeat(eid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    return {"lock": lock_out(db, desktop.heartbeat(db, get_or_404(db, Episode, eid), user), user)}


class CheckinIn(BaseModel):
    note: str = Field("", max_length=2000)


@router.post("/episodes/{eid}/checkin")
def checkin(eid: int, body: CheckinIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Save the cut as a version and free it."""
    return {"version": version_out(db, desktop.checkin(db, get_or_404(db, Episode, eid), user, body.note))}


@router.delete("/episodes/{eid}/checkout")
def release_checkout(eid: int, request: Request, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Free the cut without saving a version (the holder, or a producer)."""
    desktop.release(db, get_or_404(db, Episode, eid), user, request)
    return {"lock": None}


# ── cut versions (§2.2) ──────────────────────────────────────────────────────

@router.get("/episodes/{eid}/versions")
def list_versions(eid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    get_or_404(db, Episode, eid)
    rows = db.query(CutVersion).filter(CutVersion.episode_id == eid).order_by(CutVersion.number.desc()).all()
    users = {u.id: u for u in db.query(User).filter(User.id.in_({v.created_by for v in rows if v.created_by})).all()} if rows else {}
    return [version_out(db, v, users=users) for v in rows]


class VersionIn(BaseModel):
    note: str = Field("", max_length=2000)


@router.post("/episodes/{eid}/versions")
def add_version(eid: int, body: VersionIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Save the cut as a version now (the person who has it checked out, or anyone when nobody has)."""
    e = get_or_404(db, Episode, eid)
    desktop.check_cut(db, eid, user)
    v = desktop.save_version(db, e, user, body.note.strip(), desktop.client_of(db, eid, user))
    db.commit()
    emit(db, e.project_id, "episode.updated", {"episode_id": eid, "what": "versions", "version": v.number}, user_id=user.id)
    return version_out(db, v)


@router.get("/versions/{vid}")
def get_version(vid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return version_out(db, get_or_404(db, CutVersion, vid, "Version"), full=True)


@router.post("/versions/{vid}/restore")
def restore_version(vid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Bring a version back (the current cut is saved as a version first). Returns the new "Restored vN" version."""
    return version_out(db, desktop.restore(db, get_or_404(db, CutVersion, vid, "Version"), user))


# ── manifest & render plan (§2.3, §2.4) ──────────────────────────────────────

@router.get("/projects/{pid}/desktop/manifest")
def manifest(pid: int, scope: str = "approved", episode_id: int | None = None, user: User = Depends(current_user),
             db: Session = Depends(get_db)):
    return desktop.manifest(db, get_or_404(db, Project, pid), scope, episode_id)


@router.get("/episodes/{eid}/render-plan")
def render_plan(eid: int, lang: str | None = None, w: int | None = None, h: int | None = None, fps: int = 24, effects: int = 1,
                captions: int = 1, music: int = 1, upscaled: int = 0, user: User = Depends(current_user),
                db: Session = Depends(get_db)):
    return desktop.render_plan(db, get_or_404(db, Episode, eid), lang, w, h, fps, bool(effects), bool(captions), bool(music),
                               bool(upscaled))


# ── render upload (§2.5) ─────────────────────────────────────────────────────

class UploadIn(BaseModel):
    filename: str = Field("render.mp4", max_length=200)
    size: int
    language: str | None = Field(None, max_length=8)
    preset: str = Field("custom", max_length=40)
    w: int | None = None
    h: int | None = None
    fps: float | None = None
    codec: str = Field("", max_length=40)
    encoder: str = Field("", max_length=60)
    cut_version: int | None = None
    duration_s: float | None = None
    machine: str = Field("", max_length=120)
    fingerprint: str = Field("", max_length=64)  # the render plan's, so review notes can tell if the cut changed since


@router.post("/episodes/{eid}/renders/uploads")
def start_upload(eid: int, body: UploadIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    return desktop.start_upload(db, get_or_404(db, Episode, eid), user, body.model_dump())


_chunk_locks: dict[str, asyncio.Lock] = {}


def _wrong_offset(have: int, msg: str) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": msg, "received": have})


@router.put("/renders/uploads/{uid}")
async def upload_chunk(uid: str, request: Request, offset: int = 0, user: User = Depends(require("creator"))):
    """Append raw bytes at `offset`. A wrong offset answers 409 with how much arrived, so the client resumes there."""
    meta = desktop.upload_meta(uid, user)
    size = int(meta["size"])
    part, _ = desktop.upload_files(uid)
    async with _chunk_locks.setdefault(uid, asyncio.Lock()):
        have = desktop.received(uid)
        if offset != have:
            return _wrong_offset(have, f"Expected the next chunk at byte {have}")
        n, over = have, False
        with open(part, "ab") as f:
            async for chunk in request.stream():
                if n + len(chunk) > size:
                    over = True
                    break
                f.write(chunk)
                n += len(chunk)
            if over:
                f.truncate(have)
        if over:
            raise HTTPException(400, f"More data than the upload's size ({size} bytes)")
    return {"received": n, "size": size}


@router.get("/renders/uploads/{uid}")
def upload_status(uid: str, user: User = Depends(current_user)):
    meta = desktop.upload_meta(uid, user)
    return {"upload_id": uid, "received": desktop.received(uid), "size": int(meta["size"])}


class CompleteIn(BaseModel):
    srt: str | None = None


@router.post("/renders/uploads/{uid}/complete")
def complete_upload(uid: str, body: CompleteIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """The last chunk is in: the render joins the Render Center as the episode's next version."""
    meta = desktop.upload_meta(uid, user)
    have = desktop.received(uid)
    if have != int(meta["size"]):
        return _wrong_offset(have, f"The upload isn't finished: {have} of {meta['size']} bytes received")
    _chunk_locks.pop(uid, None)
    return export_out(desktop.complete_upload(db, uid, user, body.srt))


# ── AI upscale (§2.6) ────────────────────────────────────────────────────────

class UpscaleIn(BaseModel):
    shot_ids: list[int] | None = None
    target_h: int = 2160


@router.post("/episodes/{eid}/upscale/estimate")
def upscale_estimate(eid: int, body: UpscaleIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    return desktop.upscale_plan(db, get_or_404(db, Episode, eid), body.shot_ids, body.target_h)


@router.post("/episodes/{eid}/upscale")
def upscale(eid: int, body: UpscaleIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Queue AI upscale jobs (a paid fal call): the same estimate, budget and approval path as every paid step."""
    e = get_or_404(db, Episode, eid)
    plan = desktop.upscale_plan(db, e, body.shot_ids, body.target_h)
    res = jobs.submit(db, user, db.get(Project, e.project_id), desktop.upscale_specs(e, plan))
    return {**res, "items": plan["items"], "not_upscaled": plan["skipped"]}


@router.post("/takes/{tid}/upscales")
def upload_local_upscale(tid: int, file: UploadFile = File(...), model: str = Form("fast"), machine: str = Form(""),
                         seconds: float = Form(0), user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """A clip the desktop upscaled on its own graphics card (Real-ESRGAN): stored as this video's upscale take. Free."""
    src = get_or_404(db, Take, tid)
    ext = Path(file.filename or "").suffix.lower().lstrip(".")
    ext = ext if ext in ("mp4", "mov", "mkv") else "mp4"
    cap = float(settings_store.get_setting(db, "desktop_upload_max_mb") or 8000) * 1024 * 1024
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp) / f"upscale.{ext}"
        with open(dest, "wb") as f:
            shutil.copyfileobj(file.file, f, 4 * 1024 * 1024)
        if dest.stat().st_size > cap:
            raise HTTPException(413, "That upscale is bigger than the team allows per upload")
        t = desktop.save_local_upscale(db, src, user, dest, ext, {"model": model, "machine": machine, "seconds": seconds})
    return take_out(t)


# ── review notes (§2.7) ──────────────────────────────────────────────────────

@router.get("/episodes/{eid}/review-notes")
def review_notes(eid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Comments on this episode's renders, newest render first. maps_to_cut: the render shows the current cut, so its
    timecodes land on the timeline as they are."""
    e = get_or_404(db, Episode, eid)
    exports = {x.id: x for x in db.query(Export).filter(Export.episode_id == eid).all()}
    rows = (db.query(Comment).filter(Comment.target_type == "export", Comment.target_id.in_(list(exports))).all()
            if exports else [])
    if not rows:
        return []
    fp, cur = desktop.fingerprint(desktop.snapshot(db, e)), desktop.latest_number(db, eid)
    users = {u.id: u for u in db.query(User).filter(User.id.in_({c.user_id for c in rows if c.user_id})).all()}

    def maps(x: Export) -> bool:
        o = x.options or {}
        if o.get("fingerprint"):
            return o["fingerprint"] == fp
        return o.get("cut_version") is not None and int(o["cut_version"]) == cur

    rows.sort(key=lambda c: (-c.target_id, c.timecode is None, c.timecode or 0, c.id))
    return [{"id": c.id, "export_id": c.target_id, "export_version": exports[c.target_id].version,
             "cut_version": (exports[c.target_id].options or {}).get("cut_version"), "timecode": c.timecode, "body": c.body,
             "drawing": c.drawing or [], "author": user_brief(users.get(c.user_id)), "guest_name": c.guest_name,
             "resolved": bool(c.resolved), "created_at": _iso(c.created_at), "maps_to_cut": maps(exports[c.target_id])}
            for c in rows]
