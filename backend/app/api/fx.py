"""Transitions & effects: the catalog, a shot's effects, apply-to-all, colour LUTs and the exact preview."""
from __future__ import annotations

import hashlib
import json
import shutil
import uuid
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core import collab, studio
from ..db import get_db
from ..events import emit
from ..models import Episode, Project, Shot, User
from ..pipeline import assembler
from ..pipeline import fx as fxlib
from ..security import current_user, require
from ..storage import get_storage
from .common import get_or_404, shot_out

router = APIRouter(prefix="/api", tags=["fx"])
MAX_LUT_MB = 12


def _project_of(db: Session, shot: Shot) -> Project:
    return db.get(Project, db.get(Episode, shot.episode_id).project_id)


def _lut_ids(p: Project) -> set[str]:
    return {str(l.get("id")) for l in p.luts or []}


@router.get("/fx/catalog")
def fx_catalog(user: User = Depends(current_user)):
    return fxlib.catalog()


class FxIn(BaseModel):
    fx: dict[str, Any]


@router.put("/shots/{sid}/fx")
def set_fx(sid: int, body: FxIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Replace a shot's effects (validated). Undo brings the previous ones back."""
    s = get_or_404(db, Shot, sid)
    collab.check_shot(user, s)
    p = _project_of(db, s)
    studio.save_revision(db, "shot", s, studio.SHOT_FIELDS, user)
    s.fx = fxlib.clean(body.fx, _lut_ids(p))
    db.commit()
    emit(db, p.id, "shot.updated", {"shot_id": s.id, "what": "fx"}, user_id=user.id)
    return shot_out(db, s, p)


class ApplyIn(BaseModel):
    fx: dict[str, Any]
    shot_ids: list[int] | None = None  # default: every shot in the cut
    keys: list[str]  # which parts to copy: transition, look, adjust, speed, move, fade_in, fade_out, …


@router.post("/episodes/{eid}/fx/apply")
def apply_fx(eid: int, body: ApplyIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Copy some effects (e.g. the transition and the look) onto many shots at once. Shots a teammate is editing are
    skipped and reported."""
    e = get_or_404(db, Episode, eid)
    p = db.get(Project, e.project_id)
    src = fxlib.clean(body.fx, _lut_ids(p))
    q = db.query(Shot).filter(Shot.episode_id == eid, Shot.include.is_(True)).order_by(Shot.order)
    shots = [s for s in q.all() if not body.shot_ids or s.id in body.shot_ids]
    done, skipped = 0, []
    for i, s in enumerate(shots):
        if collab.holder(f"shot:{s.id}", user):
            skipped.append(s.code)
            continue
        cur = dict(s.fx or {})
        for k in body.keys:
            if k == "transition" and i == 0 and not body.shot_ids:
                continue  # nothing comes before the first shot
            if k in src:
                cur[k] = src[k]
            else:
                cur.pop(k, None)
        s.fx = fxlib.clean(cur, _lut_ids(p))
        done += 1
    db.commit()
    emit(db, p.id, "episode.updated", {"episode_id": eid, "what": "fx"}, user_id=user.id)
    return {"updated": done, "skipped": skipped}


# ── colour LUTs (.cube) ──────────────────────────────────────────────────────

@router.post("/projects/{pid}/luts")
async def add_lut(pid: int, file: UploadFile = File(...), name: str = Form(""), user: User = Depends(require("creator")),
                  db: Session = Depends(get_db)):
    """Upload a colour grade as a .cube 3D LUT (from DaVinci Resolve, Premiere, a LUT pack…)."""
    p = get_or_404(db, Project, pid)
    if not (file.filename or "").lower().endswith(".cube"):
        raise HTTPException(400, "Upload a .cube LUT file")
    data = await file.read()
    if len(data) > MAX_LUT_MB * 1024 * 1024:
        raise HTTPException(400, f"LUT is too large (max {MAX_LUT_MB} MB)")
    text = data[:4096].decode("utf-8", errors="ignore").upper()
    if "LUT_3D_SIZE" not in text:
        raise HTTPException(400, "This isn't a 3D LUT (.cube files from a grading app have a LUT_3D_SIZE line)")
    st = get_storage()
    lid = uuid.uuid4().hex[:10]
    rel = st.save_bytes(f"projects/{pid}/luts/{lid}.cube", data)
    label = (name or (file.filename or "LUT").rsplit(".", 1)[0]).strip()[:60]
    p.luts = [*(p.luts or []), {"id": lid, "name": label, "path": rel}]
    db.commit()
    emit(db, pid, "project.updated", {"what": "luts"}, user_id=user.id)
    return {"id": lid, "name": label}


@router.get("/projects/{pid}/luts")
def list_luts(pid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = get_or_404(db, Project, pid)
    return [{"id": l["id"], "name": l["name"]} for l in p.luts or []]


@router.delete("/projects/{pid}/luts/{lid}")
def remove_lut(pid: int, lid: str, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    p = get_or_404(db, Project, pid)
    p.luts = [l for l in p.luts or [] if str(l.get("id")) != lid]
    db.commit()
    emit(db, pid, "project.updated", {"what": "luts"}, user_id=user.id)
    return {"ok": True}


# ── exact preview ────────────────────────────────────────────────────────────

class PreviewIn(BaseModel):
    fx: dict[str, Any] | None = None  # try effects before saving them; default: the shot's saved effects


@router.post("/shots/{sid}/fx/preview")
def fx_preview(sid: int, body: PreviewIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Render this shot (and the transition from the shot before) with the export's own filters, small and quick."""
    s = get_or_404(db, Shot, sid)
    p = _project_of(db, s)
    st = get_storage()
    fx = fxlib.clean(body.fx if body.fx is not None else s.fx, _lut_ids(p))
    key = hashlib.sha1(json.dumps([fx, s.updated_at.isoformat() if s.updated_at else "", s.id], sort_keys=True).encode()).hexdigest()[:12]
    rel = f"projects/{p.id}/previews/fx_{s.id}_{key}.mp4"
    if not st.exists(rel):
        tmp = st.tmp_dir()
        try:
            out = assembler.preview_fx(db, s, fx, tmp / "preview.mp4")
            st.save_file(rel, out)
        except ValueError as e:
            raise HTTPException(400, str(e))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    return {"url": st.url(rel), "fx": fx}
