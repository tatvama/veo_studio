"""What went wrong in a long run (Produce all, Autopilot, Scenes in order), in plain words with what to do next.

A run used to count a failed child as done, finish "succeeded" and let the export fill the gaps with still pictures.
Now each run collects its children's failures as problems: {shot, shot_id, step, reason, next}. The run's result
carries them, the episode keeps the last run's list (Episode.settings["run_problems"], cleared when the next run
starts; the shot list reads it from GET /api/episodes/{eid}/board) and a "run.finished" event tells the screens.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ..db import SessionLocal, utcnow
from ..events import emit
from ..models import Episode, Job, Shot
from ..pipeline.selection import current, is_real

BUDGET_STOP = "Stopped at your budget: press Produce all to continue"
BLOCKED = "Blocked by safety filter"  # the worker's prefix for a safety block (core/recovery.BLOCK_PREFIX)
TRY_ANOTHER = "Soften the action or the words, or try another engine (the shot's Recover options)"


def explain(error: str) -> tuple[str, str]:
    """(reason, next step) in plain words for a job's error message."""
    e = " ".join((error or "").split())
    low = e.lower()
    if low.startswith(BLOCKED.lower()):
        detail = e[len(BLOCKED):].lstrip(": ").split(" Next:")[0].rstrip(". ")[:160]
        return f"A safety filter blocked it{': ' + detail if detail else ''}", TRY_ANOTHER
    if low in ("cancelled", "canceled"):
        return "It was stopped before it finished", "Make it again from the shot"
    if any(w in low for w in ("rate limit", "quota", "resource exhausted", "http 429")):
        return "The provider's quota ran out", "Wait for the quota to reset, then press Produce all again"
    if "no credit" in low or "out of credit" in low or "top up" in low:
        return "The provider has no credit left", "Top up, then run it again"
    if "no api key" in low or "no enabled engine" in low or "picked for this, and it" in low:
        return "No engine is connected for this", "Connect one in Settings → AI services or Model Hub, then run it again"
    if "more than approved" in low:
        return "A pricier engine is waiting for approval", "Approve it in Approvals, or pick another engine"
    if "timed out" in low or "took too long" in low:
        return "It took too long and was given up", "Run it again"
    first = e.split(". ")[0].split("\n")[0][:200] or "It failed"
    return first, "Open the job for the details, then run it again"


def problem(shot: Shot | None, step: str, reason: str, next_: str) -> dict[str, Any]:
    return {"shot": shot.code if shot is not None else "", "shot_id": shot.id if shot is not None else None,
            "step": step, "reason": reason[:300], "next": next_[:300]}


class RunProblems:
    """The problems of one run, in the order they happened (one per shot, step and reason)."""

    def __init__(self, items: list[dict] | None = None):
        self.items: list[dict] = list(items or [])

    def add(self, shot: Shot | None, step: str, reason: str, next_: str) -> None:
        p = problem(shot, step, reason, next_)
        if not any((x["shot_id"], x["step"], x["reason"]) == (p["shot_id"], p["step"], p["reason"]) for x in self.items):
            self.items.append(p)

    def extend(self, items: list[dict]) -> None:
        for p in items:
            if not any((x["shot_id"], x["step"], x["reason"]) == (p["shot_id"], p["step"], p["reason"]) for x in self.items):
                self.items.append(p)

    def children(self, statuses: dict[int, str] | None, step: str) -> int:
        """Record the children that didn't succeed. Returns how many succeeded."""
        statuses = statuses or {}
        bad = [i for i, s in statuses.items() if s in ("failed", "cancelled")]
        if bad:
            with SessionLocal() as db:
                for j in db.query(Job).filter(Job.id.in_(bad)).order_by(Job.id).all():
                    reason, nxt = explain(j.error or j.status)
                    shot = db.get(Shot, j.shot_id) if j.shot_id else None
                    self.add(shot, step, reason if shot is not None else f"{j.label}: {reason}", nxt)
        return sum(1 for s in statuses.values() if s == "succeeded")


def start(episode_id: int | None) -> None:
    """A new run on this episode: the last run's problems are cleared."""
    if not episode_id:
        return
    with SessionLocal() as db:
        ep = db.get(Episode, episode_id)
        if ep is not None and (ep.settings or {}).get("run_problems"):
            ep.settings = {k: v for k, v in (ep.settings or {}).items() if k != "run_problems"}
            db.commit()


def save(project_id: int | None, episode_id: int | None, problems: list[dict], run: str, job_id: int,
         announce: bool = True) -> None:
    """Keep the run's problems on the episode and (announce) tell the screens the run is over."""
    if not episode_id:
        return
    with SessionLocal() as db:
        ep = db.get(Episode, episode_id)
        if ep is None:
            return
        ep.settings = {**(ep.settings or {}), "run_problems": list(problems)}
        db.commit()
    if announce:
        emit(None, project_id, "run.finished", {"episode_id": episode_id, "problems": list(problems), "run": run,
                                                "job_id": job_id, "at": utcnow().isoformat() + "Z"})


def missing_videos(db: Session, shots: list[Shot]) -> list[Shot]:
    """Shots with no clip to show: no video, or only a placeholder made without an API key while one is connected now.
    A 480p draft is a clip (the export shows it), not a gap."""
    out = []
    for s in shots:
        v = current(db, s.id, "video")
        if v is None or not (is_real(v) or (v.params or {}).get("draft")):
            out.append(s)
    return out


def export_skipped(missing: list[Shot]) -> dict[str, Any]:
    n = len(missing)
    codes = ", ".join(s.code for s in missing[:12]) + (" …" if n > 12 else "")
    return problem(None, "export", f"Export skipped: {n} shot{' has' if n == 1 else 's have'} no video ({codes})",
                   "Make the missing videos (press Produce all again), then export; an animatic or draft render "
                   "previews the cut meanwhile")


def qc_problems(db: Session, shots: list[Shot]) -> list[dict]:
    """Problems a QC check wrote on the current clip instead of retaking it (e.g. a line too long for its clip)."""
    out = []
    for s in shots:
        for kind in ("video", "lipsync"):
            for t in ([current(db, s.id, kind)] if kind == "video" else
                      [current(db, s.id, kind, lang) for lang in sorted((s.dialogue or {}).keys())]):
                p = (t.qc or {}).get("problem") if t is not None else None
                if isinstance(p, dict) and p.get("reason"):
                    out.append(problem(s, p.get("step") or "qc", p["reason"], p.get("next") or ""))
    return out


def recent_failures(db: Session, project_id: int, limit: int = 8) -> list[dict]:
    """The project's latest failed jobs, in plain words (for the Director)."""
    rows = (db.query(Job).filter(Job.project_id == project_id, Job.status == "failed")
            .order_by(Job.id.desc()).limit(limit).all())
    out = []
    for j in rows:
        reason, nxt = explain(j.error)
        shot = db.get(Shot, j.shot_id) if j.shot_id else None
        out.append({"job_id": j.id, "what": j.label, "shot": shot.code if shot else "", "reason": reason, "next": nxt,
                    "at": j.finished_at.isoformat() + "Z" if j.finished_at else None})
    return out
