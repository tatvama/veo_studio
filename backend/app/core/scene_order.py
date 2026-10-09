"""Anchor first: keyframes of a scene wait for the scene's anchor keyframe, decided when the worker claims jobs.

keyframe_specs() puts each scene's anchor first and gives the other keyframes of the scene `after_shot` (the anchor's
shot id). The worker does not claim such a keyframe while the anchor's keyframe, its QC or its automatic retake is
waiting to run or running, nor while the anchor's video job is still making the anchor's keyframe (it doesn't wait for
the rest of that video). A video job that has to make its own keyframe first is marked the same way by video_specs().
Nothing holds a worker slot while it waits, scenes don't wait for each other, and the other shots of a scene still run
in parallel once their anchor is done.

The wait never deadlocks and never stalls a batch: an anchor that failed or was cancelled no longer holds anything; one
that backs off for longer than MAX_BACKOFF (rate limit, retry) or runs longer than MAX_RUN releases its shots, which then
go ahead without it; and only an anchor that waits for nobody itself can hold others (no chains, no cycles).
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..models import Job, Take

ANCHOR_WORK = ("keyframe", "keyframe_qc")
FOLLOWERS = ("keyframe", "video")  # job types that may carry after_shot
MAX_RUN = timedelta(minutes=15)
MAX_BACKOFF = timedelta(minutes=2)


def _holding(r: Job, now: datetime) -> bool:
    if r.type in FOLLOWERS and (r.payload or {}).get("after_shot"):
        return False  # that one waits itself: never chain waits
    if r.status == "running":
        return r.started_at is None or now - r.started_at < MAX_RUN
    return r.run_after is None or r.run_after <= now + MAX_BACKOFF


def held_back(db: Session, cands: list[Job], now: datetime) -> set[int]:
    """Ids of the queued jobs in `cands` that should not be claimed yet."""
    waiting: dict[int, int] = {}
    kinds: dict[int, str] = {}
    for j in cands:
        after = (j.payload or {}).get("after_shot") if j.type in FOLLOWERS else None
        if after:
            waiting[j.id], kinds[j.id] = int(after), j.type
    if not waiting:
        return set()
    anchors = set(waiting.values())
    rows = db.query(Job).filter(Job.type.in_((*ANCHOR_WORK, "video")), Job.shot_id.in_(anchors),
                                Job.status.in_(("queued", "running"))).all()
    busy = {r.shot_id for r in rows if r.type in ANCHOR_WORK and _holding(r, now)}
    # an anchor whose video job is still making its keyframe (no usable keyframe yet) holds the scene too
    making = {r.shot_id for r in rows if r.type == "video" and _holding(r, now)} - busy
    if making:
        making -= {sid for (sid,) in db.query(Take.shot_id).filter(Take.shot_id.in_(making), Take.kind == "keyframe",
                                                                     Take.archived.is_(False), Take.status == "ready",
                                                                     Take.stale.is_(False)).distinct()}
    return {jid for jid, sid in waiting.items() if sid in busy or sid in making}
