"""Creating jobs with budget checks, proposals (agent co-pilot), approvals, cancel/retry."""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..db import utcnow
from ..events import emit
from ..models import Approval, Job, Project, Shot, User, role_rank
from . import budget

ACTIVE = ("proposed", "queued", "running", "awaiting_approval")
SHOT_EXCLUSIVE = {"keyframe", "video", "lipsync", "voicelock", "voice", "omni_edit"}

JOB_LABELS = {
    "byteplus_register": "Register with BytePlus",
    "keyframe": "Keyframe", "video": "Video", "qc": "QC review", "voice": "Voice", "lipsync": "Lip-sync",
    "voicelock": "Voice lock", "music": "Music", "character_sheet": "Character sheet", "character_outfit": "Outfit",
    "character_expressions": "Expressions", "location_images": "Location images", "voice_design": "Voice design",
    "voice_preview": "Voice preview", "omni_edit": "Omni edit", "animatic": "Animatic", "export": "Export",
    "dub": "Dub episode", "autopilot": "Autopilot", "produce": "Produce all", "identity_variations": "Photo variations",
    "design_image": "Poster image",
}


def new_batch_id() -> str:
    return uuid.uuid4().hex[:12]


def spec(type_: str, *, payload: dict | None = None, project_id: int | None = None, episode_id: int | None = None,
         shot_id: int | None = None, estimate: float = 0.0, label: str = "", priority: int = 0) -> dict[str, Any]:
    return {"type": type_, "payload": payload or {}, "project_id": project_id, "episode_id": episode_id,
            "shot_id": shot_id, "estimate": round(estimate, 4), "label": label or JOB_LABELS.get(type_, type_),
            "priority": priority}


def _duplicate(db: Session, s: dict) -> bool:
    if s["type"] not in SHOT_EXCLUSIVE or not s.get("shot_id"):
        return False
    q = db.query(Job).filter(Job.shot_id == s["shot_id"], Job.type == s["type"], Job.status.in_(ACTIVE))
    lang = (s.get("payload") or {}).get("language")
    for j in q.all():
        if (j.payload or {}).get("language") == lang:
            return True
    return False


RUNS = ("autopilot", "produce")  # each makes every missing shot: two at once on one episode would pay twice


def _one_run_per_episode(db: Session, specs: list[dict]) -> None:
    for s in specs:
        if s["type"] in RUNS and s.get("episode_id"):
            other = db.query(Job).filter(Job.episode_id == s["episode_id"], Job.type.in_(RUNS), Job.status.in_(ACTIVE)).first()
            if other:
                raise HTTPException(409, f"{JOB_LABELS.get(other.type, other.type)} is already working on this episode "
                                         f"(job #{other.id}). Wait for it to finish or stop it first.")
        if s["type"] == "dub" and s.get("episode_id"):
            lang = (s.get("payload") or {}).get("language")
            for o in db.query(Job).filter(Job.episode_id == s["episode_id"], Job.type == "dub", Job.status.in_(ACTIVE)).all():
                if (o.payload or {}).get("language") == lang:
                    raise HTTPException(409, f"This episode is already being dubbed into {lang} (job #{o.id}).")


def submit(db: Session, user: User, project: Project | None, specs: list[dict], *, propose: bool = False,
           parent_job_id: int | None = None, skip_budget: bool = False) -> dict[str, Any]:
    """Create jobs. Returns {batch_id, status, total_usd, jobs, skipped, reason}."""
    if role_rank(user.role) < role_rank("creator"):
        raise HTTPException(403, "Your role cannot start generations")
    _one_run_per_episode(db, specs)
    keep, skipped = [], []
    for s in specs:
        (skipped if _duplicate(db, s) else keep).append(s)
    batch = new_batch_id()
    total = round(sum(s["estimate"] for s in keep), 4)
    reason, needs = "", None
    if propose:
        status = "proposed"
    elif skip_budget:
        status = "queued"
    else:
        chk = budget.check(db, user, project, total)
        if chk["ok"]:
            status = "queued"
        elif chk["needs_role"]:
            status, reason, needs = "awaiting_approval", chk["reason"], chk["needs_role"]
        else:
            raise HTTPException(403, chk["reason"])
    jobs = []
    for s in keep:
        j = Job(type=s["type"], status=status, project_id=s.get("project_id") or (project.id if project else None),
                episode_id=s.get("episode_id"), shot_id=s.get("shot_id"), payload=s["payload"], label=s["label"],
                cost_estimate=s["estimate"], batch_id=batch, requested_by=user.id, priority=s.get("priority", 0),
                parent_job_id=parent_job_id)
        db.add(j)
        jobs.append(j)
    db.flush()
    if status == "awaiting_approval":
        summary = ", ".join(sorted({j.label for j in jobs}))[:300] + f" ({len(jobs)} jobs)"
        budget.request_approval(db, batch_id=batch, user=user, project=project, amount=total, reason=reason,
                                needs_role=needs or "producer", summary=summary)
    for j in jobs:
        if j.shot_id and status in ("queued",) and j.type in SHOT_EXCLUSIVE:
            shot = db.get(Shot, j.shot_id)
            if shot:
                shot.generating, shot.locked_by = True, user.id
    if jobs:
        emit(db, project.id if project else None, "jobs.created",
             {"batch_id": batch, "status": status, "count": len(jobs), "total_usd": total}, user_id=user.id, commit=False)
    db.commit()
    return {"batch_id": batch, "status": status, "total_usd": total, "jobs": [j.to_dict() for j in jobs],
            "skipped": len(skipped), "reason": reason}


def confirm_batch(db: Session, user: User, batch_id: str) -> dict[str, Any]:
    jobs = db.query(Job).filter(Job.batch_id == batch_id, Job.status == "proposed").all()
    if not jobs:
        raise HTTPException(404, "Nothing to confirm (already confirmed or cancelled)")
    project = db.get(Project, jobs[0].project_id) if jobs[0].project_id else None
    total = sum(j.cost_estimate for j in jobs)
    chk = budget.check(db, user, project, total)
    if not chk["ok"] and not chk["needs_role"]:
        raise HTTPException(403, chk["reason"])
    status = "queued" if chk["ok"] else "awaiting_approval"
    for j in jobs:
        j.status = status
        j.requested_by = j.requested_by or user.id
    if status == "awaiting_approval":
        budget.request_approval(db, batch_id=batch_id, user=user, project=project, amount=total, reason=chk["reason"],
                                needs_role=chk["needs_role"], summary=f"{len(jobs)} jobs")
    emit(db, project.id if project else None, "jobs.updated", {"batch_id": batch_id, "status": status}, commit=False)
    db.commit()
    return {"batch_id": batch_id, "status": status, "total_usd": round(total, 4), "reason": chk["reason"]}


def decide_approval(db: Session, user: User, approval_id: int, approve: bool) -> Approval:
    a = db.get(Approval, approval_id)
    if not a or a.status != "pending":
        raise HTTPException(404, "Approval not found or already decided")
    if role_rank(user.role) < role_rank(a.needs_role):
        raise HTTPException(403, f"Only a {a.needs_role} can decide this")
    a.status = "approved" if approve else "rejected"
    a.decided_by, a.decided_at = user.id, utcnow()
    for j in db.query(Job).filter(Job.batch_id == a.batch_id, Job.status == "awaiting_approval").all():
        j.status = "queued" if approve else "cancelled"
        j.approved_by = user.id
        r = dict(j.result or {})
        if r.get("extra_asked_usd"):  # a pricier fallback route was asked for mid-run (workers/handlers.run_chain)
            asked = float(r.pop("extra_asked_usd"))
            if approve:
                r["extra_ok_usd"] = round(float(r.get("extra_ok_usd") or 0) + asked, 4)
            j.result = r
        if not approve:
            j.finished_at = utcnow()
    emit(db, a.project_id, "approval.decided", {"approval_id": a.id, "status": a.status, "by": user.name or user.email},
         user_id=user.id, commit=False)
    db.commit()
    return a


def cancel_tree(db: Session, root_ids: list[int]) -> int:
    """Stop these jobs and everything they started (children, QC, auto-retakes, nested runs): waiting ones are
    cancelled at once, running ones are asked to stop. No commit."""
    n, seen, frontier = 0, set(), list(root_ids)
    while frontier:
        rows = db.query(Job).filter(Job.id.in_(frontier) | Job.parent_job_id.in_(frontier)).all()
        frontier = []
        for j in rows:
            if j.id in seen:
                continue
            seen.add(j.id)
            frontier.append(j.id)
            if j.status in ("proposed", "queued", "awaiting_approval"):
                j.status, j.finished_at = "cancelled", utcnow()
                _release_shot(db, j)
                n += 1
            elif j.status == "running" and not j.cancel_requested:
                j.cancel_requested = True
                n += 1
    db.flush()
    return n


def cancel(db: Session, user: User, job: Job) -> Job:
    cancel_tree(db, [job.id])
    emit(db, job.project_id, "job.updated", {"job_id": job.id, "status": job.status}, commit=False)
    db.commit()
    return job


def cancel_batch(db: Session, batch_id: str) -> int:
    ids = [i for (i,) in db.query(Job.id).filter(Job.batch_id == batch_id).all()]
    n = cancel_tree(db, ids) if ids else 0
    db.commit()
    return n


def retry(db: Session, user: User, job: Job) -> dict[str, Any]:
    if job.status not in ("failed", "cancelled"):
        raise HTTPException(400, "Only failed or cancelled jobs can be retried")
    project = db.get(Project, job.project_id) if job.project_id else None
    payload = dict(job.payload or {})
    return submit(db, user, project, [spec(job.type, payload=payload, project_id=job.project_id, episode_id=job.episode_id,
                                           shot_id=job.shot_id, estimate=job.cost_estimate, label=job.label)])


def _release_shot(db: Session, job: Job) -> None:
    if not job.shot_id:
        return
    db.flush()
    still = db.query(Job).filter(Job.shot_id == job.shot_id, Job.id != job.id,
                                 Job.status.in_(("queued", "running"))).count()
    if not still:
        shot = db.get(Shot, job.shot_id)
        if shot:
            shot.generating, shot.locked_by = False, None
