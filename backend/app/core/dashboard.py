"""Production dashboard numbers: progress, footage, spend and the cost of every approved second."""
from __future__ import annotations

from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models import Approval, CostEntry, Episode, Export, Job, Project, Shot, Take
from ..pipeline.selection import current

REMAINING = ("draft", "keyframe_ready")
IN_REVIEW = ("video_ready",)


def episode_dashboard(db: Session, project: Project, episode: Episode) -> dict[str, Any]:
    shots = db.query(Shot).filter(Shot.episode_id == episode.id, Shot.include.is_(True)).order_by(Shot.order, Shot.id).all()
    ids = [s.id for s in shots]
    by_status: dict[str, int] = {}
    for s in shots:
        by_status[s.status] = by_status.get(s.status, 0) + 1
    approved = [s for s in shots if s.status == "approved"]
    approved_s = sum((current(db, s.id, "video").duration_s if current(db, s.id, "video") else 0.0) or s.duration_s for s in approved)
    planned_s = sum(max(s.extend_to or 0, s.duration_s) for s in shots)
    takes = db.query(Take).filter(Take.shot_id.in_(ids)).all() if ids else []
    videos = [t for t in takes if t.kind == "video" and t.status == "ready"]
    generated_s = sum(t.duration_s or 0.0 for t in videos)
    rejected = len([t for t in videos if t.archived])
    shots_with_video = len({t.shot_id for t in videos if not t.archived})
    regen_rate = round((len(videos) - shots_with_video) / shots_with_video, 2) if shots_with_video else 0.0
    stale = len([t for t in takes if t.stale and not t.archived])
    # spend: ledger entries whose job belongs to this episode
    job_ids = [j.id for j in db.query(Job.id).filter(Job.episode_id == episode.id).all()]
    spend_rows = (db.query(CostEntry.provider, func.sum(CostEntry.usd)).filter(CostEntry.job_id.in_(job_ids), CostEntry.mock.is_(False))
                  .group_by(CostEntry.provider).all()) if job_ids else []
    spend = {p or "other": round(float(u or 0), 4) for p, u in spend_rows}
    total = round(sum(spend.values()), 4)
    waste = round(sum(t.cost_usd or 0.0 for t in videos if t.archived), 4)
    pending = db.query(Approval).filter(Approval.project_id == project.id, Approval.status == "pending").count()
    queue = db.query(Job).filter(Job.episode_id == episode.id, Job.type.in_(("export", "animatic")),
                                 Job.status.in_(("queued", "running"))).count()
    active = db.query(Job).filter(Job.episode_id == episode.id, Job.status.in_(("queued", "running"))).count()
    latest_export = (db.query(Export).filter(Export.episode_id == episode.id, Export.kind == "final", Export.status == "ready")
                     .order_by(Export.id.desc()).first())
    remaining_s = max(planned_s - approved_s, 0.0)
    est_remaining = round(remaining_s * (total / approved_s), 2) if approved_s and total else None
    return {
        "episode_id": episode.id, "number": episode.number, "title": episode.title, "status": episode.status,
        "shots": {"total": len(shots), "approved": len(approved), "in_review": sum(by_status.get(k, 0) for k in IN_REVIEW),
                  "remaining": sum(by_status.get(k, 0) for k in REMAINING), "generating": len([s for s in shots if s.generating]),
                  "by_status": by_status},
        "footage": {"planned_s": round(planned_s, 1), "approved_s": round(approved_s, 1), "generated_s": round(generated_s, 1),
                    "rejected_takes": rejected, "regeneration_rate": regen_rate, "stale_takes": stale},
        "spend": {"total_usd": total, "by_provider": spend, "wasted_usd": waste,
                  "per_approved_second": round(total / approved_s, 4) if approved_s else None,
                  "estimated_remaining_usd": est_remaining},
        "queue": {"active_jobs": active, "renders": queue, "pending_approvals": pending},
        "timeline_ready": bool(shots) and all(current(db, s.id, "video") for s in shots),
        "latest_export": {"id": latest_export.id, "preset": latest_export.preset, "language": latest_export.language,
                          "approved": bool(latest_export.approved_by)} if latest_export else None,
    }


def project_dashboard(db: Session, project: Project) -> dict[str, Any]:
    episodes = db.query(Episode).filter(Episode.project_id == project.id).order_by(Episode.season, Episode.number).all()
    eps = [episode_dashboard(db, project, e) for e in episodes]
    spend_rows = (db.query(CostEntry.provider, func.sum(CostEntry.usd)).filter(CostEntry.project_id == project.id, CostEntry.mock.is_(False))
                  .group_by(CostEntry.provider).all())
    spend = {p or "other": round(float(u or 0), 4) for p, u in spend_rows}
    total = round(sum(spend.values()), 4)
    approved_s = sum(e["footage"]["approved_s"] for e in eps)
    return {
        "project_id": project.id, "title": project.title, "type": project.type, "status": project.status,
        "episodes": eps,
        "shots": {k: sum(e["shots"][k] for e in eps) for k in ("total", "approved", "in_review", "remaining", "generating")},
        "footage": {"approved_s": round(approved_s, 1), "generated_s": round(sum(e["footage"]["generated_s"] for e in eps), 1),
                    "stale_takes": sum(e["footage"]["stale_takes"] for e in eps)},
        "spend": {"total_usd": total, "by_provider": spend, "budget_cap_usd": project.budget_cap_usd,
                  "per_approved_second": round(total / approved_s, 4) if approved_s else None},
        "queue": {"active_jobs": sum(e["queue"]["active_jobs"] for e in eps),
                  "pending_approvals": db.query(Approval).filter(Approval.project_id == project.id, Approval.status == "pending").count()},
    }
