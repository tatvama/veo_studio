"""What went wrong in a long run (Produce all, Autopilot, Scenes in order), in plain words with what to do next.

A run used to count a failed child as done, finish "succeeded" and let the export fill the gaps with still pictures.
Now each run collects its children's failures as problems: {shot, shot_id, step, reason, next, action, kind, job_id}.
The run's result carries them, the episode keeps the last run's list (Episode.settings["run_problems"], cleared when
the next run starts; GET /api/episodes/{eid}/board and /canvas return the ones that still stand, live()) and a
"run.finished" event tells the screens.

`action` is the one-click fix the screens put on a problem (the Next bar's problem list, the Overview, the canvas):
  retry     make that step of the shot again (its price first)      engine    try another video engine for the shot
  voice     make the shot's missing voice                           open      open the shot (something to change by hand)
  continue  press Make it for me again (a budget stop, a skipped export, a cast picture or the music that failed)
  ""        nothing to press: read it and act
`kind` is the shot's step it is about (picture, video, voice, mouth, sound; "" for none), `job_id` the failed job.
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

# job type → the shot's step it makes (the canvas's five dots, api/canvas.STEP_OF)
STEP_KIND = {"keyframe": "picture", "endframe": "picture", "video": "video", "voice": "voice", "voicelock": "voice",
             "lipsync": "mouth", "sfx": "sound"}
KIND_TYPES: dict[str, tuple[str, ...]] = {}
for _t, _k in STEP_KIND.items():
    KIND_TYPES[_k] = (*KIND_TYPES.get(_k, ()), _t)
ACTIONS = ("retry", "engine", "voice", "open", "continue", "")


def action_for(job_type: str, error: str, has_shot: bool) -> str:
    """The one-click fix for a failed job of this type (see the module docstring)."""
    if not has_shot:
        return "continue"  # a cast picture, the music, the sound design: the next run makes what is missing
    if job_type == "video" and (error or "").lower().startswith(BLOCKED.lower()):
        return "engine"
    if job_type == "voice":
        return "voice"
    return "retry" if job_type in STEP_KIND else "open"


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


def problem(shot: Shot | None, step: str, reason: str, next_: str, action: str | None = None,
            job: Job | None = None) -> dict[str, Any]:
    """One problem. `action` defaults to "open" for a shot's problem (something to change by hand), else none."""
    act = action if action in ACTIONS else ("open" if shot is not None else "")
    return {"shot": shot.code if shot is not None else "", "shot_id": shot.id if shot is not None else None,
            "step": step, "reason": reason[:300], "next": next_[:300], "action": act,
            "kind": STEP_KIND.get(job.type, "") if job is not None and shot is not None else "",
            "job_id": job.id if job is not None else None}


def _same(a: dict, b: dict) -> bool:
    return (a.get("shot_id"), a.get("step"), a.get("reason")) == (b.get("shot_id"), b.get("step"), b.get("reason"))


class RunProblems:
    """The problems of one run, in the order they happened (one per shot, step and reason)."""

    def __init__(self, items: list[dict] | None = None):
        self.items: list[dict] = list(items or [])

    def add(self, shot: Shot | None, step: str, reason: str, next_: str, action: str | None = None,
            job: Job | None = None) -> None:
        p = problem(shot, step, reason, next_, action, job)
        if not any(_same(x, p) for x in self.items):
            self.items.append(p)

    def extend(self, items: list[dict]) -> None:
        for p in items:
            if not any(_same(x, p) for x in self.items):
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
                    self.add(shot, step, reason if shot is not None else f"{j.label}: {reason}", nxt,
                             action_for(j.type, j.error or "", shot is not None), j)
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
         announce: bool = True, draft: bool = False) -> None:
    """Keep the run's problems on the episode and (announce) tell the screens the run is over (`draft`: a quick 480p
    draft run, so the screens offer the final film next)."""
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
                                                "job_id": job_id, "draft": draft, "at": utcnow().isoformat() + "Z"})


def live(db: Session, episode: Episode) -> list[dict]:
    """The last run's problems that still stand. A shot's failed step that has been made since (a newer job of that
    step succeeded: a retry, another engine) is dropped, and so is a problem of a shot that left the cut. A 480p draft
    doesn't make up for a failed final clip."""
    items = [p for p in (episode.settings or {}).get("run_problems") or [] if isinstance(p, dict)]
    ids = {int(p["shot_id"]) for p in items if p.get("shot_id")}
    if not ids:
        return items
    shots = {s.id: s for s in db.query(Shot).filter(Shot.id.in_(ids)).all()}
    fixed: dict[tuple[int, str], int] = {}  # (shot, step) → the newest job of that step that succeeded
    first = min((int(p["job_id"]) for p in items if p.get("job_id")), default=None)
    if first is not None:
        for jid, sid, typ, payload in (db.query(Job.id, Job.shot_id, Job.type, Job.payload)
                                       .filter(Job.shot_id.in_(ids), Job.type.in_(list(STEP_KIND)),
                                               Job.status == "succeeded", Job.id > first).all()):
            if typ == "video" and ((payload or {}).get("draft") or (payload or {}).get("shootout")):
                continue
            key = (sid, STEP_KIND[typ])
            fixed[key] = max(fixed.get(key, 0), jid)
    out = []
    for p in items:
        sid = p.get("shot_id")
        if sid:
            s = shots.get(int(sid))
            if s is None or not s.include or s.episode_id != episode.id:
                continue
            if p.get("kind") and p.get("job_id") and fixed.get((s.id, p["kind"]), 0) > int(p["job_id"]):
                continue
        out.append(p)
    return out


def missing_videos(db: Session, shots: list[Shot], drafts_ok: bool = False) -> list[Shot]:
    """Shots with no clip to show: no video, or only a placeholder made without an API key while one is connected now.
    A 480p draft counts only for a draft render (`drafts_ok`): for the final film it is a gap still to make."""
    out = []
    for s in shots:
        v = current(db, s.id, "video")
        if v is None or not (is_real(v) or (drafts_ok and (v.params or {}).get("draft"))):
            out.append(s)
    return out


def export_skipped(missing: list[Shot], draft: bool = False) -> dict[str, Any]:
    n = len(missing)
    codes = ", ".join(s.code for s in missing[:12]) + (" …" if n > 12 else "")
    if draft:
        return problem(None, "export", f"Draft render skipped: {n} shot{' has' if n == 1 else 's have'} no clip "
                       f"({codes})", "Make their drafts (press Make it for me again), then render the draft",
                       action="continue")
    return problem(None, "export", f"Export skipped: {n} shot{' has' if n == 1 else 's have'} no video ({codes})",
                   "Make the missing videos (press Produce all again), then export; an animatic or draft render "
                   "previews the cut meanwhile", action="continue")


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
