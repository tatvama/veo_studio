"""How a long run (Produce all, Autopilot, Scenes in order) runs its children: the spend guard, waiting for them and
their follow-ups (QC, retakes) with a progress note on what they wait for, and the problems they leave (core/problems.py).

It imports nothing from the worker or the handlers (the worker loads every handler module), so the handlers and the
worker can both use it without an import cycle. `ctx` is the run's worker.JobContext.
"""
from __future__ import annotations

import time
from typing import Any

from ..core import problems
from ..db import SessionLocal, utcnow
from ..models import Job

# A run gives up on its children only after this long with nothing moving at all: no child finished, progressed or
# went back to wait for a quota (each quota retry counts as movement, so a day-long wait for Veo's daily quota is fine).
# A child waiting for someone's approval never times out: the run says what it waits for.
STUCK_S = 6 * 3600


class Cancelled(Exception):
    pass


class BudgetStop(Exception):
    """A run's spend guard tripped: queued work is cancelled, running work (already paid) finishes, and the run ends
    with the problem "Stopped at your budget" instead of failing."""


def wait_note(rows: list[Job]) -> str:
    """What the children are waiting for, for the run's progress: a provider's quota (and until when), or an approval."""
    for j in rows:
        if j.status == "awaiting_approval":
            return f"waiting for your approval of {j.label or j.type}"
    now = utcnow()
    for j in rows:
        err = j.error or ""
        if j.status == "queued" and j.run_after and j.run_after > now and err.startswith("Waiting for the "):
            provider = err[len("Waiting for the "):].split(" rate limit", 1)[0][:40]
            return f"waiting for {provider} quota until {j.run_after:%H:%M} UTC"
    return ""


def _run_spend(ctx: Any) -> tuple[float, float]:
    """(spent so far by this run — itself and every job it started, incl. QC and retakes — , the 1.5× guard)."""
    from sqlalchemy import func
    with SessionLocal() as db:
        j = db.get(Job, ctx.job_id)
        spent = float(db.query(func.coalesce(func.sum(Job.cost_actual), 0.0)).filter(Job.batch_id == j.batch_id).scalar() or 0)
        return spent, max(j.cost_estimate * 1.5, 1.0)


def _wait_batch_idle(ctx: Any, guard=None, timeout_s: float = STUCK_S) -> None:
    """Wait for follow-up work of this run (QC, retakes) before the next step. It may wait on a provider quota (the
    progress says until when); it gives up only when nothing has moved for `timeout_s` (STUCK_S)."""
    moved, last_guard, seen = time.time(), 0.0, None
    while True:
        with SessionLocal() as db:
            me = db.get(Job, ctx.job_id)
            rows = db.query(Job).filter(Job.batch_id == me.batch_id, Job.id != ctx.job_id,
                                        Job.status.in_(("queued", "running"))).all()
            mark = [(j.id, j.status, round(j.progress or 0, 2), j.message, j.error, j.attempts, j.run_after) for j in rows]
            note = wait_note(rows)
        if not rows:
            return
        if mark != seen:
            seen, moved = mark, time.time()
        if note:
            ctx.progress(ctx._p, f"Checks and retakes · {note}")
        ctx._watch(guard, last_guard, moved, timeout_s, False)
        if guard and time.time() - last_guard > 10:
            last_guard = time.time()
        time.sleep(2)


class RunLog:
    """One long run's children: queue them, wait for them (and for their QC and retakes), and keep what went wrong
    as problems (core/problems.py), filed under `step`."""

    def __init__(self, ctx: Any, name: str):
        self.ctx, self.name = ctx, name
        self.problems = problems.RunProblems()
        self.step = ""
        self.done: dict[str, int] = {}

    def guard(self) -> None:
        self.ctx.check_cancel()
        spent, cap = _run_spend(self.ctx)
        if spent > cap and spent > 0:
            raise BudgetStop(f"{self.name}: spent ${spent:.2f}, above the approved ${cap:.2f} guard")

    def run(self, specs: list[dict], label: str) -> dict[int, str]:
        """Queue these child jobs and wait for them; returns {job id: status}. Failures become problems."""
        ids = [self.ctx.enqueue_child(s["type"], s["payload"], shot_id=s.get("shot_id"), episode_id=s.get("episode_id"),
                                      estimate=s["estimate"], label=s["label"]) for s in specs]
        ids = [i for i in ids if i]
        if not ids:
            return {}
        st = self.ctx.wait_children(ids, label, guard=self.guard)
        _wait_batch_idle(self.ctx, self.guard)
        self.problems.children(st, self.step or label)
        return st

    def stopped_at_budget(self, again: str) -> None:
        """The spend guard tripped: work already running (and paid) finishes, queued work is cancelled, and the run
        ends with that as a problem instead of failing."""
        self.ctx.stop_at_budget()
        if self.ctx.cancelled():
            from ..core.jobs import cancel_tree
            with SessionLocal() as db:
                cancel_tree(db, [self.ctx.job_id])
                db.commit()
            raise Cancelled()
        reason = problems.BUDGET_STOP.replace("Produce all", again)
        self.problems.add(None, "budget", reason, "What is made is kept and nothing is made twice; raise the budget "
                                                  "first if the run should go further")

    def save(self, announce: bool) -> list[dict]:
        problems.save(self.ctx.project_id, self.ctx.episode_id, self.problems.items, self.ctx.type, self.ctx.job_id,
                      announce)
        return self.problems.items
