"""Tatvam Editor's studio side (docs/EDITOR.md §8, §10): an edit's hidden studio project (it carries the AI costs,
budget, approvals and history), media uploads for the AI tools, each tool's price and run, backups of the edit, and the
studio scenes of an imported episode. Tools, prices and schemas live in core/edit_ai.py, backups in core/edit_backups.py;
the jobs in workers/handlers_edit.py. Timeline review comments on an edit use the comments API (api/work.py,
target_type "edit")."""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import settings_store
from ..core import budget, edit_ai, edit_backups, jobs
from ..core.edit_ai import EDIT_TYPE, ToolError
from ..core.edit_backups import BackupError
from ..db import get_db
from ..events import emit
from ..models import EditBackup, Episode, Job, Project, Scene, Shot, User, VoiceProfile, role_rank
from ..pipeline import ffmpeg as ff
from ..security import current_user, require
from ..storage import get_storage
from .common import user_brief

router = APIRouter(prefix="/api", tags=["edits"])


def _iso(dt) -> str | None:
    return dt.isoformat() + "Z" if dt else None


def edit_of(db: Session, pid: int) -> Project:
    p = db.get(Project, pid)
    if p is None or p.type != EDIT_TYPE:
        raise HTTPException(404, "Edit not found")
    return p


def find_edit(db: Session, edit_id: str) -> Project | None:
    for p in db.query(Project).filter(Project.type == EDIT_TYPE).order_by(Project.id).all():
        if (p.brief or {}).get("edit_id") == edit_id:
            return p
    return None


def edit_out(db: Session, p: Project) -> dict:
    return {"id": p.id, "name": p.title, "edit_id": (p.brief or {}).get("edit_id"), "type": p.type,
            "owner": user_brief(db.get(User, p.created_by)) if p.created_by else None,
            "spent_usd": round(budget.spent(db, project_id=p.id), 4), "budget_cap_usd": p.budget_cap_usd,
            "created_at": _iso(p.created_at), "updated_at": _iso(p.updated_at)}


class EditIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    edit_id: str = Field(min_length=4, max_length=80, pattern=r"^[A-Za-z0-9_.:\-]+$")


@router.post("/edits")
def ensure_edit(body: EditIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """The studio project of an edit (made on its first AI use): found by the edit's id, else made, owned by you.
    It is hidden from the studio's project lists."""
    name = body.name.strip()[:200] or "Untitled edit"
    p = find_edit(db, body.edit_id)
    if p is None:
        p = Project(title=name, type=EDIT_TYPE, concept=f"Tatvam Editor edit “{name}”", aspect="16:9", languages=["en"],
                    primary_language="en", quality_mode=settings_store.get_setting(db, "default_quality_mode") or "saver",
                    agent_mode="copilot", workflow="shots", created_by=user.id, brief={"edit_id": body.edit_id},
                    status="edit")
        db.add(p)
        db.commit()
    elif p.title != name:  # the edit was renamed on the PC
        p.title = name
        db.commit()
    return edit_out(db, p)


@router.get("/edits/{pid}")
def get_edit(pid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return edit_out(db, edit_of(db, pid))


# ── media for the AI tools ───────────────────────────────────────────────────

@router.post("/edits/{pid}/assets")
def upload_asset(pid: int, file: UploadFile = File(...), user: User = Depends(require("creator")),
                 db: Session = Depends(get_db)):
    """A media file an AI tool needs, kept as projects/{pid}/edit_assets/<hash>.<ext> (the same file uploaded twice is
    kept once). Capped by the team's desktop_upload_max_mb."""
    edit_of(db, pid)
    ext = Path(file.filename or "").suffix.lower().lstrip(".")
    kind = edit_ai.kind_of_ext(ext)
    if kind is None:
        raise HTTPException(400, f"Not a video, audio or image file ({ext or 'no extension'})")
    cap = float(settings_store.get_setting(db, "desktop_upload_max_mb") or 8000) * 1024 * 1024
    st = get_storage()
    tmp = st.tmp_dir() / f"upload.{ext}"
    h, n = hashlib.sha1(), 0
    try:
        with open(tmp, "wb") as f:
            while chunk := file.file.read(4 * 1024 * 1024):
                n += len(chunk)
                if n > cap:
                    raise HTTPException(413, "That file is bigger than the team allows per upload")
                h.update(chunk)
                f.write(chunk)
        if not n:
            raise HTTPException(400, "The file is empty")
        duration = ff.duration(tmp) if kind != "image" else 0.0
        w, hh = ff.video_size(tmp) if kind != "audio" else (0, 0)
        if (kind != "image" and duration <= 0) or (kind == "image" and not w):
            raise HTTPException(400, "Couldn't read that file")
        has_audio = kind != "image" and ff.has_audio(tmp)
        key = f"projects/{pid}/edit_assets/{h.hexdigest()[:24]}.{ext}"
        if not st.exists(key):
            st.save_file(key, tmp, move=True)
    finally:
        tmp.unlink(missing_ok=True)
        try:
            tmp.parent.rmdir()
        except OSError:  # not empty or already gone: _tmp is scratch space, so a leftover folder does no harm
            pass
    return {"key": key, "url": st.url(key), "kind": kind, "duration": round(duration, 3), "has_audio": has_audio,
            "width": w, "height": hh, "bytes": n}


# ── AI tools ─────────────────────────────────────────────────────────────────

class ToolIn(BaseModel):
    tool: str = Field(max_length=40)
    params: dict[str, Any] = Field(default_factory=dict)
    what: str = Field("", max_length=120)  # names the clip in the job's label ("Captions: interview.mp4")


def _plan(db: Session, p: Project, body: ToolIn, user: User | None = None) -> dict:
    if user is not None and body.tool in edit_ai.PRODUCER_TOOLS and role_rank(user.role) < role_rank("producer"):
        raise HTTPException(403, "Only a producer can clone a voice (it needs the speaker's consent record)")
    try:
        return edit_ai.plan(db, p, body.tool, body.params, body.what)
    except ToolError as e:
        raise HTTPException(e.status, str(e)) from e


@router.get("/edits/{pid}/ai/tools")
def ai_tools(pid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Every AI tool and whether its provider is ready, plus the languages."""
    edit_of(db, pid)
    from .. import catalog
    return {"tools": edit_ai.tools_status(db), "languages": [{"code": k, "name": v["name"]} for k, v in catalog.LANGUAGES.items()],
            "google_first": settings_store.get_setting(db, "google_first") is not False}


@router.get("/edits/{pid}/ai/voices")
def ai_voices(pid: int, language: str = "en", user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Voices to pick from: the studio's character voices, then each provider's library. `default` is the team's
    voice for the language."""
    edit_of(db, pid)
    from ..models import Character
    from ..providers.services import provider_mode
    from .bible import voice_library
    default = (settings_store.get_setting(db, "tts_provider_by_language") or {}).get(language, "gemini")
    chars = {c.id: c.name for c in db.query(Character).all()}
    studio = [{"provider": v.provider, "voice_id": v.voice_id, "profile_id": v.id, "language": v.language,
               "name": f"{chars.get(v.character_id, 'Voice')} ({v.voice_name or v.voice_id})", "source": "studio"}
              for v in db.query(VoiceProfile).filter(VoiceProfile.voice_id != "").order_by(VoiceProfile.id).all()
              if v.language == language or v.provider in ("gemini", "elevenlabs")]
    providers = []
    for prov in edit_ai.TTS_PROVIDERS:
        mode = provider_mode(prov)
        lib = [] if mode == "missing" else voice_library(prov, language, user)
        providers.append({"provider": prov, "mode": mode,
                          "voices": [{"voice_id": v["id"], "name": v.get("name") or v["id"], "description": v.get("description", "")}
                                     for v in lib if v.get("id")]})
    return {"default": {"provider": default, "voice_id": {"gemini": "Kore", "sarvam": "anand"}.get(default, "")},
            "studio": studio, "providers": providers}


@router.post("/edits/{pid}/ai/estimate")
def ai_estimate(pid: int, body: ToolIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """The price of a tool run, line by line, and whether it would start at once or wait for an approval."""
    p = edit_of(db, pid)
    plan = _plan(db, p, body, user)
    return {**plan, "budget": budget.check(db, user, p, plan["total_usd"]), "team": budget.team_status(db)}


@router.post("/edits/{pid}/ai/run")
def ai_run(pid: int, body: ToolIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Start a tool: one job, through the studio's budgets and approvals (over a limit it waits for a producer)."""
    p = edit_of(db, pid)
    plan = _plan(db, p, body, user)
    res = jobs.submit(db, user, p, [jobs.spec(plan["job"], payload={"tool": plan["tool"], "params": plan["params"]},
                                              project_id=p.id, estimate=plan["total_usd"], label=plan["label"])])
    return {**res, "job_id": res["jobs"][0]["id"] if res["jobs"] else None, "tool": plan["tool"], "items": plan["items"]}


def job_out(j: Job) -> dict:
    st = get_storage()
    r = dict(j.result or {})
    for k in ("outputs", "lines"):
        if isinstance(r.get(k), list):
            r[k] = [{**o, "url": st.url(o["key"])} if isinstance(o, dict) and o.get("key") else o for o in r[k]]
    for k in ("ops", "request_id", "attempts"):
        r.pop(k, None)
    return {"id": j.id, "type": j.type, "status": j.status, "progress": j.progress, "message": j.message, "error": j.error,
            "label": j.label, "batch_id": j.batch_id, "cost_estimate": j.cost_estimate, "cost_actual": j.cost_actual,
            "tool": (j.payload or {}).get("tool"), "result": r, "created_at": _iso(j.created_at),
            "finished_at": _iso(j.finished_at)}


@router.get("/edits/{pid}/ai/jobs")
def ai_jobs(pid: int, limit: int = 50, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """This edit's AI runs, newest first."""
    edit_of(db, pid)
    rows = db.query(Job).filter(Job.project_id == pid).order_by(Job.id.desc()).limit(min(max(limit, 1), 200)).all()
    return [job_out(j) for j in rows]


@router.get("/edits/{pid}/ai/jobs/{jid}")
def ai_job(pid: int, jid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """One run: its status and, once it succeeded, its result (outputs with their media links)."""
    edit_of(db, pid)
    j = db.get(Job, jid)
    if j is None or j.project_id != pid:
        raise HTTPException(404, "Job not found")
    return job_out(j)


# ── backups of the edit ──────────────────────────────────────────────────────

def _backup_of(db: Session, pid: int, bid: int) -> EditBackup:
    b = db.get(EditBackup, bid)
    if b is None or b.project_id != pid:
        raise HTTPException(404, "Backup not found")
    return b


def _backup_out(db: Session, b: EditBackup) -> dict:
    return edit_backups.out(b, user_brief(db.get(User, b.created_by)) if b.created_by else None)


@router.post("/edits/{pid}/backups")
def make_backup(pid: int, file: UploadFile = File(...), device: str = Form(""), note: str = Form(""),
                user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Keeps the edit's .tatvamedit JSON (multipart "file", at most 20 MB) on the studio. The same content is kept once
    (`deduped`); the newest 50 backups stay, plus one a day for 30 days. `device` names the computer it came from."""
    p = edit_of(db, pid)
    data = file.file.read(edit_backups.MAX_BYTES + 1)
    try:
        b, deduped = edit_backups.save(db, p, data, device=device, note=note, user=user)
    except BackupError as e:
        raise HTTPException(e.status, str(e)) from e
    db.commit()
    if not deduped:
        emit(db, p.id, "edit.backup", {"backup_id": b.id, "by": user.name or user.email, "device": b.device}, user_id=user.id)
    return {**_backup_out(db, b), "deduped": deduped}


@router.get("/edits/{pid}/backups")
def list_backups(pid: int, limit: int = 100, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The edit's backups, newest first."""
    edit_of(db, pid)
    rows = (db.query(EditBackup).filter(EditBackup.project_id == pid).order_by(EditBackup.created_at.desc(), EditBackup.id.desc())
            .limit(min(max(limit, 1), 200)).all())
    users = {u.id: u for u in db.query(User).filter(User.id.in_({b.created_by for b in rows if b.created_by})).all()}
    return [edit_backups.out(b, user_brief(users.get(b.created_by))) for b in rows]


@router.get("/edits/{pid}/backups/{bid}")
def download_backup(pid: int, bid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The backup as a .tatvamedit file."""
    edit_of(db, pid)
    b = _backup_of(db, pid, bid)
    st = get_storage()
    if not st.exists(b.key):
        raise HTTPException(404, "That backup's file is gone from the studio")
    safe = "".join(ch if ch.isalnum() or ch in " ._-" else "_" for ch in (b.name or "edit")).strip() or "edit"
    return Response(st.abs(b.key).read_bytes(), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{safe[:80]} {b.created_at:%Y-%m-%d %H%M}.tatvamedit"',
                             "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"})


@router.post("/edits/{pid}/backups/{bid}/restore")
def restore_backup(pid: int, bid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """The backup's edit document, for the PC to write as the edit (nothing changes on the studio)."""
    edit_of(db, pid)
    b = _backup_of(db, pid, bid)
    try:
        doc = edit_backups.load(b)
    except BackupError as e:
        raise HTTPException(e.status, str(e)) from e
    emit(db, pid, "edit.restored", {"backup_id": b.id, "by": user.name or user.email}, user_id=user.id)
    return {"backup": _backup_out(db, b), "project": doc}


# ── the studio scenes of an imported episode (mood per scene) ────────────────

@router.get("/edits/{pid}/episode-scenes")
def episode_scenes(pid: int, episode_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The scenes of a studio episode a sequence was imported from: title, emotion, summary and the codes of their shots
    (the editor names an imported clip after its shot's code), in order."""
    edit_of(db, pid)
    ep = db.get(Episode, episode_id)
    if ep is None:
        raise HTTPException(404, "Episode not found")
    shots = db.query(Shot).filter(Shot.episode_id == ep.id).order_by(Shot.order, Shot.id).all()
    out = []
    for sc in db.query(Scene).filter(Scene.episode_id == ep.id).order_by(Scene.order, Scene.id).all():
        out.append({"id": sc.id, "title": sc.title, "emotion": sc.emotion, "summary": (sc.summary or "")[:2000],
                    "shot_codes": [s.code for s in shots if s.scene_id == sc.id and s.code]})
    return {"episode_id": ep.id, "title": ep.title, "scenes": out}
