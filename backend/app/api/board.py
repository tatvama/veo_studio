"""Shot list (manual builder) and script import."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from ..core import board as B
from ..core import script_import, studio
from ..db import get_db
from ..models import Character, Episode, Project, User
from ..security import current_user, require
from .common import character_out, get_or_404

router = APIRouter(prefix="/api", tags=["board"])

SCRIPT_TYPES = (".docx", ".pdf", ".txt", ".md", ".fountain", ".text")
MAX_SCRIPT_MB = 10


def _ctx(db: Session, eid: int) -> tuple[Episode, Project]:
    e = get_or_404(db, Episode, eid)
    return e, db.get(Project, e.project_id)


@router.get("/episodes/{eid}/board")
def get_board(eid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e, p = _ctx(db, eid)
    return B.get_board(db, p, e)


@router.put("/episodes/{eid}/board")
def put_board(eid: int, body: B.Board, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e, p = _ctx(db, eid)
    return B.save_board(db, user, p, e, body)


def _match(db: Session, project: Project, name: str) -> dict | None:
    """Best existing character for a script name: the project's cast first, then the shared library."""
    low = " ".join(name.strip().lower().split())
    if not low:
        return None
    words = set(low.split())
    cast = studio.cast(db, project)
    lib = db.query(Character).filter(Character.shared.is_(True), Character.archived.is_(False)).all()
    for pool, in_project in ((cast, True), (lib, False)):
        for exact in (True, False):
            for c in pool:
                cn = " ".join((c.name or "").strip().lower().split())
                if not cn:
                    continue
                # whole words only: "Ravi" matches "Ravi Kumar", but "Al" never matches "Sally"
                hit = cn == low if exact else (cn.split()[0] == low.split()[0] or words <= set(cn.split())
                                               or set(cn.split()) <= words)
                if hit:
                    return {**character_out(db, c, brief=True), "in_project": in_project}
    return None


@router.post("/episodes/{eid}/import/parse")
async def import_parse(eid: int, file: UploadFile | None = File(None), text: str = Form(""), method: str = Form("auto"),
                       user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Read a script (file or pasted text) into a draft shot list. Nothing is saved until the board is PUT."""
    e, p = _ctx(db, eid)
    if method not in ("auto", "markers", "ai"):
        raise HTTPException(400, "method must be auto, markers or ai")
    source_name = "pasted text"
    if file is not None and file.filename:
        if not file.filename.lower().endswith(SCRIPT_TYPES):
            raise HTTPException(400, f"Upload a Word (.docx), PDF or text file ({', '.join(SCRIPT_TYPES)})")
        data = await file.read()
        if len(data) > MAX_SCRIPT_MB * 1024 * 1024:
            raise HTTPException(400, f"File is too large (max {MAX_SCRIPT_MB} MB)")
        text = script_import.extract_text(file.filename, data)
        source_name = file.filename
    out = script_import.build_draft(db, user, p, text, method)
    for c in out["characters"]:
        c["match"] = _match(db, p, c["name"])
    out["source"] = source_name
    out["text"] = text[: script_import.MAX_CHARS]
    return out
