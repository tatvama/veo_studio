"""Tatvam Editor's studio side (docs/EDITOR.md §8): an edit's hidden studio project (it carries the AI costs, budget,
approvals and history), media uploads for the AI tools, and each tool's price and run. Tools, prices and schemas live
in core/edit_ai.py; the jobs in workers/handlers_edit.py."""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import settings_store
from ..core import budget, edit_ai, jobs
from ..core.edit_ai import EDIT_TYPE, ToolError
from ..db import get_db
from ..models import Job, Project, User, VoiceProfile
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
        except OSError:
            pass
    return {"key": key, "url": st.url(key), "kind": kind, "duration": round(duration, 3), "has_audio": has_audio,
            "width": w, "height": hh, "bytes": n}


# ── AI tools ─────────────────────────────────────────────────────────────────

class ToolIn(BaseModel):
    tool: str = Field(max_length=40)
    params: dict[str, Any] = Field(default_factory=dict)
    what: str = Field("", max_length=120)  # names the clip in the job's label ("Captions: interview.mp4")


def _plan(db: Session, p: Project, body: ToolIn) -> dict:
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
    plan = _plan(db, p, body)
    return {**plan, "budget": budget.check(db, user, p, plan["total_usd"]), "team": budget.team_status(db)}


@router.post("/edits/{pid}/ai/run")
def ai_run(pid: int, body: ToolIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Start a tool: one job, through the studio's budgets and approvals (over a limit it waits for a producer)."""
    p = edit_of(db, pid)
    plan = _plan(db, p, body)
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
