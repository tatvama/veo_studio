"""Jobs, approvals, comments, activity, the Director agent chat, live WebSocket and media files."""
from __future__ import annotations

import asyncio
import re
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..agents import director
from ..core import collab, jobs
from ..db import SessionLocal, get_db, is_network_error
from ..events import emit
from ..models import AgentMessage, Approval, Comment, Episode, Event, Job, Project, User, role_rank
from ..security import COOKIE, current_user, require, user_from_token, ws_user
from ..storage import get_storage
from .common import get_or_404, user_brief

router = APIRouter(tags=["work"])


# ── jobs ─────────────────────────────────────────────────────────────────────

@router.get("/api/jobs")
def list_jobs(project_id: int | None = None, status: str | None = None, limit: int = 100,
              user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = db.query(Job)
    if project_id:
        q = q.filter(Job.project_id == project_id)
    if status == "active":
        q = q.filter(Job.status.in_(("proposed", "queued", "running", "awaiting_approval")))
    elif status:
        q = q.filter(Job.status == status)
    users = {u.id: u for u in db.query(User).all()}
    return [j.to_dict(requested_by_user=user_brief(users.get(j.requested_by)))
            for j in q.order_by(Job.id.desc()).limit(min(limit, 500)).all()]


@router.post("/api/jobs/{jid}/cancel")
def cancel_job(jid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    return jobs.cancel(db, user, get_or_404(db, Job, jid)).to_dict()


@router.post("/api/jobs/{jid}/retry")
def retry_job(jid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    return jobs.retry(db, user, get_or_404(db, Job, jid))


@router.post("/api/batches/{batch_id}/confirm")
def confirm(batch_id: str, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    return jobs.confirm_batch(db, user, batch_id)


@router.post("/api/batches/{batch_id}/cancel")
def cancel_batch(batch_id: str, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    return {"cancelled": jobs.cancel_batch(db, batch_id)}


@router.get("/api/approvals")
def list_approvals(status: str = "pending", user: User = Depends(current_user), db: Session = Depends(get_db)):
    users = {u.id: u for u in db.query(User).all()}
    projects = {p.id: p.title for p in db.query(Project).all()}
    rows = db.query(Approval).filter(Approval.status == status).order_by(Approval.id.desc()).limit(200).all()
    return [a.to_dict(requested_by_user=user_brief(users.get(a.requested_by)), project_title=projects.get(a.project_id, ""),
                      can_decide=role_rank(user.role) >= role_rank(a.needs_role)) for a in rows]


class DecideIn(BaseModel):
    approve: bool


@router.post("/api/approvals/{aid}/decide")
def decide(aid: int, body: DecideIn, request: Request, user: User = Depends(require("producer")), db: Session = Depends(get_db)):
    a = jobs.decide_approval(db, user, aid, body.approve)
    from ..core.audit import audit
    audit(db, user, "approval.approve" if body.approve else "approval.reject", f"approval {aid}",
          {"amount_usd": a.amount_usd}, request=request)
    return a.to_dict()


# ── comments & activity ──────────────────────────────────────────────────────

@router.get("/api/comments")
def list_comments(project_id: int, target_type: str | None = None, target_id: int | None = None,
                  user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = db.query(Comment).filter(Comment.project_id == project_id)
    if target_type:
        q = q.filter(Comment.target_type == target_type)
    if target_id:
        q = q.filter(Comment.target_id == target_id)
    users = {u.id: u for u in db.query(User).all()}
    return [c.to_dict(user=user_brief(users.get(c.user_id)) or {"id": 0, "name": f"{c.guest_name} (client)", "email": "",
                                                                 "role": "viewer"})
            for c in q.order_by(Comment.timecode.is_(None), Comment.timecode, Comment.id).all()]


class CommentIn(BaseModel):
    project_id: int
    target_type: str
    target_id: int
    body: str = Field(min_length=1, max_length=4000)
    timecode: float | None = None
    drawing: list[dict] = []


@router.post("/api/comments")
def add_comment(body: CommentIn, user: User = Depends(require("reviewer")), db: Session = Depends(get_db)):
    names = {m.lower() for m in re.findall(r"@([\w.\-]+)", body.body)}
    mentioned = [u.id for u in db.query(User).all()
                 if (u.name and u.name.split()[0].lower() in names) or u.email.split("@")[0].lower() in names]
    c = Comment(project_id=body.project_id, target_type=body.target_type, target_id=body.target_id, user_id=user.id,
                body=body.body, mentions=mentioned, timecode=body.timecode, drawing=body.drawing[:50])
    db.add(c)
    db.commit()
    emit(db, body.project_id, "comment.created", {"comment_id": c.id, "target_type": c.target_type, "target_id": c.target_id,
                                                  "mentions": mentioned, "by": user.name or user.email,
                                                  "excerpt": body.body[:120]}, user_id=user.id)
    return c.to_dict(user=user_brief(user))


@router.post("/api/comments/{cid}/resolve")
def resolve_comment(cid: int, user: User = Depends(require("reviewer")), db: Session = Depends(get_db)):
    c = get_or_404(db, Comment, cid)
    c.resolved = not c.resolved
    db.commit()
    emit(db, c.project_id, "comment.updated", {"comment_id": c.id})
    return c.to_dict()


ACTIVITY_TYPES = ("jobs.created", "job.updated", "approval.requested", "approval.decided", "comment.created", "shot.updated",
                  "project.created", "export.updated", "budget.alert", "bible.updated")


@router.get("/api/activity")
def activity(project_id: int | None = None, limit: int = 100, user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = db.query(Event).filter(Event.type.in_(ACTIVITY_TYPES))
    if project_id:
        q = q.filter(Event.project_id == project_id)
    users = {u.id: u for u in db.query(User).all()}
    rows = q.order_by(Event.id.desc()).limit(min(limit, 500)).all()
    return [e.to_dict(user=user_brief(users.get(e.user_id))) for e in rows
            if not (e.type == "job.updated" and (e.payload or {}).get("status") == "running")]


@router.get("/api/notifications")
def notifications(since_id: int = 0, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Things that need *this* person: approvals they can decide, @mentions, budget alerts, their failed jobs."""
    out = []
    if role_rank(user.role) >= role_rank("producer"):
        for a in db.query(Approval).filter(Approval.status == "pending").all():
            if role_rank(user.role) >= role_rank(a.needs_role):
                out.append({"type": "approval", "id": a.id, "text": f"Approval needed: ${a.amount_usd:.2f} — {a.summary}",
                            "project_id": a.project_id, "created_at": a.created_at.isoformat() + "Z"})
    for c in db.query(Comment).filter(Comment.id > since_id).order_by(Comment.id.desc()).limit(100).all():
        if user.id in (c.mentions or []):
            out.append({"type": "mention", "id": c.id, "text": c.body[:140], "project_id": c.project_id,
                        "target_type": c.target_type, "target_id": c.target_id, "created_at": c.created_at.isoformat() + "Z"})
    for e in db.query(Event).filter(Event.type == "budget.alert").order_by(Event.id.desc()).limit(3).all():
        out.append({"type": "budget", "id": e.id, "text": f"Team budget reached {e.payload.get('threshold')}%",
                    "created_at": e.created_at.isoformat() + "Z"})
    return sorted(out, key=lambda x: x["created_at"], reverse=True)


# ── Director agent ───────────────────────────────────────────────────────────

@router.get("/api/projects/{pid}/agent/messages")
def agent_messages(pid: int, limit: int = 60, user: User = Depends(current_user), db: Session = Depends(get_db)):
    users = {u.id: u for u in db.query(User).all()}
    rows = (db.query(AgentMessage).filter(AgentMessage.project_id == pid).order_by(AgentMessage.id.desc())
            .limit(min(limit, 300)).all())
    out = []
    for m in reversed(rows):
        d = director.public(m.to_dict(user=user_brief(users.get(m.user_id))))
        for prop in (d.get("data") or {}).get("proposals", []):
            pending = db.query(Job).filter(Job.batch_id == prop["batch_id"], Job.status == "proposed").count()
            prop["pending"] = pending > 0
        out.append(d)
    return out


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    episode_id: int | None = None
    selection: dict | None = None


@router.post("/api/projects/{pid}/agent/chat")
def agent_chat(pid: int, body: ChatIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    p = get_or_404(db, Project, pid)
    ep = db.get(Episode, body.episode_id) if body.episode_id else None
    if ep is not None and ep.project_id != p.id:
        raise HTTPException(404, "Episode not found in this project")
    return director.run(db, user, p, ep, body.message, body.selection)


class ConfirmIn(BaseModel):
    id: str
    approve: bool


@router.post("/api/projects/{pid}/agent/messages/{mid}/confirm")
def agent_confirm(pid: int, mid: int, body: ConfirmIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Answer a Director confirmation card ("Rewrite the script?"): run the action, or leave things as they are."""
    p = get_or_404(db, Project, pid)
    return director.confirm(db, user, p, mid, body.id, body.approve)


# ── live events ──────────────────────────────────────────────────────────────

@router.websocket("/api/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    with SessionLocal() as db:
        user = ws_user(websocket, db)
        last_id = db.query(Event.id).order_by(Event.id.desc()).limit(1).scalar() or 0
    if not user:
        await websocket.close(code=4401)
        return
    project_id: int | None = None
    try:
        q = websocket.query_params.get("project_id")
        project_id = int(q) if q else None
    except ValueError:
        project_id = None
    conn = uuid.uuid4().hex
    if project_id:
        collab.report(conn, user, project_id)

    async def receiver():
        nonlocal project_id
        while True:
            msg = await websocket.receive_json()
            if not isinstance(msg, dict):
                continue
            if "project_id" in msg:
                project_id = msg.get("project_id")
            if msg.get("type") == "presence":  # which view this tab shows and what it is editing
                collab.report(conn, user, project_id, str(msg.get("view") or ""), str(msg.get("editing") or ""))

    recv_task = asyncio.create_task(receiver())
    sent_presence = (-1, None)
    try:
        while True:
            if project_id and sent_presence != (collab.version(), project_id):
                sent_presence = (collab.version(), project_id)
                await websocket.send_json({"type": "presence", "project_id": project_id, "payload": collab.snapshot(project_id)})
            def fetch(last: int):
                with SessionLocal() as db:
                    rows = db.query(Event).filter(Event.id > last).order_by(Event.id).limit(200).all()
                    return [(e.id, e.project_id, e.to_dict()) for e in rows]
            try:
                rows = await asyncio.to_thread(fetch, last_id)
            except Exception as e:
                if not is_network_error(e):
                    raise
                # the database link hiccuped: keep the socket open and try again shortly instead of dropping the tab
                await asyncio.sleep(2.0)
                continue
            for eid, pid, data in rows:
                last_id = eid
                if pid is None or project_id is None or pid == project_id:
                    await websocket.send_json(data)
            if recv_task.done():
                break
            await asyncio.sleep(0.7)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        recv_task.cancel()
        collab.leave(conn)


# ── team presence & edit locks ───────────────────────────────────────────────

LOCK_RE = re.compile(r"^(shot|board):(\d+)$")


def _lock_project(db: Session, target: str) -> int:
    m = LOCK_RE.match(target or "")
    if not m:
        raise HTTPException(400, "target must be shot:<id> or board:<episode id>")
    kind, oid = m.group(1), int(m.group(2))
    from ..models import Shot
    ep = db.get(Episode, db.get(Shot, oid).episode_id) if kind == "shot" and db.get(Shot, oid) else db.get(Episode, oid) if kind == "board" else None
    if not ep:
        raise HTTPException(404, "Nothing to lock")
    return ep.project_id


class LockIn(BaseModel):
    target: str


@router.post("/api/locks")
def take_lock(body: LockIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Start (or keep) editing something: others see it's yours and can't change it until you're done."""
    ok, holder = collab.acquire(body.target, user, _lock_project(db, body.target))
    return {"ok": ok, "holder": holder, "ttl": collab.LOCK_TTL}


@router.post("/api/locks/release")
def drop_lock(body: LockIn, user: User = Depends(current_user)):
    collab.release(body.target, user)
    return {"ok": True}


@router.get("/api/projects/{pid}/presence")
def presence(pid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    get_or_404(db, Project, pid)
    return collab.snapshot(pid)


# ── media (auth-checked) ─────────────────────────────────────────────────────

_MEDIA_AUTH: dict[str, tuple[float, str]] = {}  # session token -> (valid until, role)
MEDIA_AUTH_TTL_S = 60.0


def _media_role(db: Session, token: str | None) -> str | None:
    """The signed-in role for a media request. A page of thumbnails fires dozens of these at once; remembering a checked
    session for a minute saves a database round trip per file. Signing out or a role change applies within a minute."""
    if not token:
        return None
    now = time.monotonic()
    hit = _MEDIA_AUTH.get(token)
    if hit and hit[0] > now:
        return hit[1]
    u = user_from_token(db, token)
    if not u:
        _MEDIA_AUTH.pop(token, None)
        return None
    if len(_MEDIA_AUTH) > 1000:
        _MEDIA_AUTH.clear()
    _MEDIA_AUTH[token] = (now + MEDIA_AUTH_TTL_S, u.role)
    return u.role


@router.get("/media/{path:path}")
def media(path: str, request: Request, db: Session = Depends(get_db)):
    role = _media_role(db, request.cookies.get(COOKIE))
    if not role:
        raise HTTPException(401, "Please log in")
    private = path.replace("\\", "/").lstrip("/").startswith("consents/")
    if private and role_rank(role) < role_rank("producer"):  # signed releases hold personal data
        raise HTTPException(403, "Only a producer can open consent releases")
    st = get_storage()
    try:
        p = st.abs(path)
    except ValueError:
        raise HTTPException(400, "bad path")
    if not p.exists() or not p.is_file():
        raise HTTPException(404, "file not found")
    headers = {"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"}
    if private or p.suffix.lower() in (".html", ".htm", ".svg", ".xml", ".js"):  # never render these inline
        headers["Content-Disposition"] = f'attachment; filename="{p.name}"'
    return FileResponse(p, headers=headers)
