"""Shot list (manual builder) and script import."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core import board as B
from ..core import script_import, studio
from ..db import get_db
from ..events import emit
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


class ImportApplyIn(BaseModel):
    draft: dict
    mapping: dict[str, int | str] = {}  # script name -> character id, or "new"
    create_missing: bool = True
    write_script: bool = True


@router.post("/episodes/{eid}/import/apply")
def import_apply(eid: int, body: ImportApplyIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Second step of the import wizard: every speaker becomes a cast member (matched or created), the draft becomes
    the shot list, and the episode script is written with @mentions so the Story tab shows who is in each scene."""
    from ..core import mentions
    e, p = _ctx(db, eid)
    draft = body.draft or {}
    scenes = draft.get("scenes") or []
    names: list[str] = []
    for sc in scenes:
        for sh in sc.get("shots") or []:
            for n in sh.get("characters") or []:
                if n not in names:
                    names.append(n)
            for l in sh.get("lines") or []:
                if l.get("speaker") not in ("VO", None, "") and l["speaker"] not in names:
                    names.append(l["speaker"])
    ids: dict[str, int] = {}
    created: list[dict] = []
    for n in names:
        m = body.mapping.get(n)
        ch = None
        if isinstance(m, int) or (isinstance(m, str) and m.isdigit()):
            ch = db.get(Character, int(m))
        elif m in (None, "", "auto"):
            hit = _match(db, p, n)
            ch = db.get(Character, hit["id"]) if hit else None
        if ch is None:
            if not body.create_missing and m != "new":
                raise HTTPException(400, f"No character for {n!r}: map it or allow creating missing characters")
            ch = Character(name=n, shared=False, created_by=user.id)
            db.add(ch)
            db.flush()
            created.append({"id": ch.id, "name": ch.name})
        studio.link_character(db, p, ch)
        ids[n] = ch.id
    board = B.Board(scenes=[B.BoardScene(
        title=sc.get("title", ""), location=sc.get("location", ""), time_of_day=sc.get("time_of_day", ""),
        summary=sc.get("summary", ""),
        shots=[B.BoardShot(prompt=sh.get("prompt", ""), characters=[ids[n] for n in (sh.get("characters") or []) if n in ids],
                           lines=[B.BoardLine(speaker="VO" if l.get("speaker") in ("VO", None, "") else ids[l["speaker"]],
                                              text=l.get("text", ""), emotion=l.get("emotion", "")) for l in (sh.get("lines") or [])],
                           duration_s=sh.get("duration_s") if sh.get("duration_s") in (4, 6, 8) else 8,
                           framing=sh.get("framing", ""), camera=sh.get("camera", ""))
               for sh in (sc.get("shots") or [])]) for sc in scenes])
    out = B.save_board(db, user, p, e, board)
    if body.write_script:
        script_scenes = []
        for sc in scenes:
            lines = []
            visuals = []
            for sh in sc.get("shots") or []:
                if sh.get("prompt"):
                    visuals.append(sh["prompt"].strip())
                for l in sh.get("lines") or []:
                    who = l.get("speaker")
                    tok = "NARRATOR" if who in ("VO", None, "") else mentions.token("character", ids[who], who)
                    lines.append({"character": tok, "line": l.get("text", ""), "emotion": l.get("emotion", "")})
            script_scenes.append({"title": sc.get("title", ""), "location": sc.get("location", ""),
                                  "time_of_day": sc.get("time_of_day", ""), "summary": sc.get("summary", ""),
                                  "action": " ".join(visuals), "lines": lines})
        e.script = {**(e.script or {}), "logline": draft.get("title") or (e.script or {}).get("logline", ""),
                    "beats": (e.script or {}).get("beats", []), "scenes": script_scenes}
        studio.save_script_version(db, e, "manual", user, note="Imported script")
        mentions.attach_entities(db, p, e.script)
        db.commit()
        emit(db, p.id, "episode.updated", {"episode_id": e.id, "what": "script"}, user_id=user.id)
    return {**out, "characters": ids, "created": created}
