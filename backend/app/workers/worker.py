"""Background worker: claims queued jobs from the DB and runs them in threads.

DB-backed queue (works on SQLite and Postgres, no Redis needed). Per-group concurrency limits keep us
inside provider rate limits. Long Veo operations store their operation name so a restart resumes polling
instead of paying twice.
"""
from __future__ import annotations

import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from typing import Any, Callable

from sqlalchemy import update
from sqlalchemy.orm import Session

from ..config import get_settings
from ..core import budget, ratelimit
from ..db import SessionLocal, utcnow
from ..events import emit, prune
from ..models import Job, Shot
from ..pipeline.ffmpeg import FFmpegError
from ..providers.base import ProviderBlocked, ProviderError, ProviderNotConfigured, RetryableProviderError, Usage
from ..providers.services import Services

HANDLERS: dict[str, Callable[["JobContext"], dict | None]] = {}
ORCHESTRATORS = {"dub", "autopilot", "produce"}
GROUP_OF = {"video": "video", "omni_edit": "video", "lipsync": "lipsync", "voicelock": "audio", "voice": "audio",
            "voice_design": "audio", "voice_preview": "audio", "music": "audio", "sfx": "audio", "table_read": "audio",
            "export": "render", "animatic": "render", "keyframe": "image", "character_sheet": "image",
            "character_outfit": "image", "character_expressions": "image", "location_images": "image", "marketing": "image",
            "qc": "llm", "critic_loop": "llm", "search_index": "llm", "model_sync": "system", "fetch_metrics": "system",
            "publish_youtube": "system", "train_identity": "train", "identity_variations": "image"}
GROUP_LIMITS = {"video": 3, "lipsync": 2, "audio": 4, "render": 2, "image": 4, "llm": 4, "system": 1, "train": 2}
# A rate-limited job waits in the queue up to this many times (back-off grows to 15 min, so about a day:
# long enough for a daily quota to reset at midnight Pacific) before it is retried and failed as usual.
MAX_RATE_LIMIT_WAITS = 100


def handler(name: str):
    def deco(fn):
        HANDLERS[name] = fn
        return fn
    return deco


class Cancelled(Exception):
    pass


class JobContext:
    def __init__(self, job: Job):
        self.job_id = job.id
        self.type = job.type
        self.payload: dict[str, Any] = dict(job.payload or {})
        self.result: dict[str, Any] = dict(job.result or {})
        self.project_id = job.project_id
        self.episode_id = job.episode_id
        self.shot_id = job.shot_id
        self.user_id = job.requested_by
        self.parent_job_id = job.parent_job_id
        self.batch_id = job.batch_id
        self.services = Services()
        self._last_progress = 0.0

    # db helpers
    def db(self) -> Session:
        return SessionLocal()

    def progress(self, p: float, message: str = "") -> None:
        now = time.time()
        if now - self._last_progress < 1.0 and p < 1.0:
            return
        self._last_progress = now
        with SessionLocal() as db:
            db.execute(update(Job).where(Job.id == self.job_id).values(progress=max(0.0, min(p, 1.0)), message=message[:500]))
            db.commit()
            emit(db, self.project_id, "job.progress", {"job_id": self.job_id, "progress": p, "message": message})

    def cancelled(self) -> bool:
        with SessionLocal() as db:
            j = db.get(Job, self.job_id)
            return bool(j and j.cancel_requested)

    def check_cancel(self) -> None:
        if self.cancelled():
            raise Cancelled()

    def tick(self, label: str, expected_s: float = 90.0) -> Callable[[float], bool]:
        def on_tick(elapsed: float) -> bool:
            self.progress(min(0.1 + 0.8 * elapsed / expected_s, 0.9), f"{label} ({int(elapsed)}s)")
            return not self.cancelled()
        return on_tick

    def save_result(self, **kw: Any) -> None:
        self.result.update(kw)
        with SessionLocal() as db:
            j = db.get(Job, self.job_id)
            if j:
                j.result = dict(self.result)
                db.commit()

    def cost(self, usage: Usage, db: Session | None = None) -> float:
        own = db is None
        db = db or SessionLocal()
        try:
            budget.record_cost(db, usage, user_id=self.user_id, project_id=self.project_id, job_id=self.job_id)
            j = db.get(Job, self.job_id)
            if j:
                j.cost_actual = round((j.cost_actual or 0) + usage.usd, 5)
            if own:
                db.commit()
            return usage.usd
        finally:
            if own:
                db.close()

    def emit(self, type_: str, payload: dict | None = None) -> None:
        emit(None, self.project_id, type_, payload or {}, user_id=self.user_id)

    # orchestration
    def enqueue_child(self, type_: str, payload: dict, *, shot_id: int | None = None, episode_id: int | None = None,
                      estimate: float = 0.0, label: str = "") -> int:
        from ..core.jobs import JOB_LABELS, SHOT_EXCLUSIVE
        with SessionLocal() as db:
            parent = db.get(Job, self.job_id)
            if not parent or parent.cancel_requested or parent.status == "cancelled":
                raise Cancelled()  # stopped: start no new (paid) work
            # the same work already waiting or running (e.g. this run was resumed after a restart): reuse it
            same = db.query(Job).filter(Job.type == type_, Job.status.in_(("queued", "running", "awaiting_approval")))
            if shot_id:
                same = same.filter(Job.shot_id == shot_id)
            else:
                same = same.filter(Job.parent_job_id == self.job_id, Job.shot_id.is_(None))
            for o in same.all():
                if (type_ in SHOT_EXCLUSIVE and shot_id and (o.payload or {}).get("language") == payload.get("language")
                        and bool((o.payload or {}).get("extend")) == bool(payload.get("extend"))) or (o.payload or {}) == payload:
                    return o.id
            j = Job(type=type_, status="queued", project_id=self.project_id, episode_id=episode_id or self.episode_id,
                    shot_id=shot_id, payload=payload, label=label or JOB_LABELS.get(type_, type_), cost_estimate=estimate,
                    batch_id=parent.batch_id if parent else "", parent_job_id=self.job_id, requested_by=self.user_id,
                    approved_by=parent.approved_by if parent else None)
            db.add(j)
            if shot_id:
                s = db.get(Shot, shot_id)
                if s:
                    s.generating = True
            db.commit()
            emit(db, self.project_id, "jobs.created", {"count": 1, "parent": self.job_id})
            return j.id

    def wait_children(self, ids: list[int], label: str = "Waiting", timeout_s: float = 26 * 3600,
                      guard: Callable[[], None] | None = None) -> dict[int, str]:
        """Wait for child jobs. Long on purpose: a child may wait most of a day for a provider's daily quota.
        `guard` runs every few seconds (e.g. the spend cap); if it raises, or this job is stopped, the children stop too."""
        start, last_guard = time.time(), 0.0
        while True:
            with SessionLocal() as db:
                rows = db.query(Job.id, Job.status).filter(Job.id.in_(ids)).all() if ids else []
            st = {r[0]: r[1] for r in rows}
            done = [i for i, s in st.items() if s in ("succeeded", "failed", "cancelled")]
            self.progress(len(done) / max(len(ids), 1), f"{label}: {len(done)}/{len(ids)} done")
            if len(done) == len(ids):
                return st
            try:
                if self.cancelled():
                    raise Cancelled()
                if guard and time.time() - last_guard > 10:
                    last_guard = time.time()
                    guard()
                if time.time() - start > timeout_s:
                    raise ProviderError("timed out waiting for child jobs")
            except Exception:
                from ..core.jobs import cancel_tree
                with SessionLocal() as db:
                    cancel_tree(db, [self.job_id])
                    db.commit()
                raise
            time.sleep(2)


class Worker:
    def __init__(self, concurrency: int | None = None):
        self.concurrency = concurrency or get_settings().worker_concurrency
        self.pool = ThreadPoolExecutor(max_workers=max(self.concurrency, 2), thread_name_prefix="job")
        # 2 top-level runs at a time; an orchestrator started by another one (Autopilot → Dub) never waits for a slot,
        # or two Autopilots waiting on their Dubs would block each other forever
        self.orch_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="orch")
        self.nested: set[int] = set()
        self.running: dict[int, str] = {}
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        from . import handlers, handlers_growth, handlers_hub, handlers_room  # noqa: F401  (registers handlers)

        self.recover()
        self.thread = threading.Thread(target=self.loop, name="worker-loop", daemon=True)
        self.thread.start()
        print(f"[worker] started with concurrency={self.concurrency}")

    def stop(self) -> None:
        self.stop_event.set()

    def recover(self) -> None:
        with SessionLocal() as db:
            n = 0
            for j in db.query(Job).filter(Job.status == "running").all():
                j.status, j.message = "queued", "Resumed after restart"
                n += 1
            db.commit()
            if n:
                print(f"[worker] re-queued {n} interrupted job(s)")

    def schedule_periodic(self, db: Session) -> None:
        """Daily Model Hub sync (new models appear automatically) and analytics refresh."""
        from ..core import model_hub
        active = ("queued", "running")
        if model_hub.sync_due(db) and not db.query(Job).filter(Job.type == "model_sync", Job.status.in_(active)).count():
            db.add(Job(type="model_sync", status="queued", label="Model Hub sync (daily)"))
        from ..models import Integration
        if db.query(Integration).filter(Integration.provider == "youtube").count():
            recent = db.query(Job).filter(Job.type == "fetch_metrics", Job.created_at > utcnow() - timedelta(hours=24)).count()
            if not recent:
                db.add(Job(type="fetch_metrics", status="queued", label="YouTube analytics (daily)"))
        db.commit()

    def _group_count(self, group: str) -> int:
        return sum(1 for t in self.running.values() if GROUP_OF.get(t, "misc") == group)

    def loop(self) -> None:
        last_prune = 0.0
        while not self.stop_event.is_set():
            try:
                claimed = self.claim()
            except Exception as e:  # keep the loop alive
                print(f"[worker] claim error: {e}")
                claimed = 0
            if time.time() - last_prune > 3600:
                last_prune = time.time()
                try:
                    with SessionLocal() as db:
                        prune(db)
                        self.schedule_periodic(db)
                except Exception as e:
                    print(f"[worker] periodic tasks: {e}")
            time.sleep(0.4 if claimed else 1.0)

    def claim(self) -> int:
        with self.lock:
            regular = sum(1 for t in self.running.values() if t not in ORCHESTRATORS)
            orch = sum(1 for i, t in self.running.items() if t in ORCHESTRATORS and i not in self.nested)
        free_regular = self.concurrency - regular
        free_orch = 2 - orch
        now = utcnow()
        n = 0
        with SessionLocal() as db:
            cands = (db.query(Job).filter(Job.status == "queued")
                     .filter((Job.run_after.is_(None)) | (Job.run_after <= now))
                     .order_by(Job.priority.desc(), Job.id.asc()).limit(300).all())
            for j in cands:
                is_orch = j.type in ORCHESTRATORS
                nested = is_orch and bool(j.parent_job_id)
                if is_orch and not nested and free_orch <= 0:
                    continue
                if not is_orch:
                    if free_regular <= 0:
                        continue
                    g = GROUP_OF.get(j.type, "misc")
                    if g in GROUP_LIMITS and self._group_count(g) >= GROUP_LIMITS[g]:
                        continue
                res = db.execute(update(Job).where(Job.id == j.id, Job.status == "queued")
                                 .values(status="running", started_at=utcnow(), attempts=Job.attempts + 1))
                db.commit()
                if res.rowcount != 1:
                    continue
                with self.lock:
                    self.running[j.id] = j.type
                    if nested:
                        self.nested.add(j.id)
                if is_orch:
                    free_orch -= 0 if nested else 1
                    self.orch_pool.submit(self.run, j.id)
                else:
                    free_regular -= 1
                    self.pool.submit(self.run, j.id)
                n += 1
        return n

    def run(self, job_id: int) -> None:
        with SessionLocal() as db:
            job = db.get(Job, job_id)
            if not job:
                return
            ctx = JobContext(job)
            attempts, max_attempts = job.attempts, job.max_attempts
            emit(db, job.project_id, "job.updated", {"job_id": job.id, "status": "running", "type": job.type})
        fn = HANDLERS.get(ctx.type)
        status, error, result, run_after, refund = "succeeded", "", {}, None, False
        try:
            if not fn:
                raise ProviderError(f"No handler for job type {ctx.type}")
            result = fn(ctx) or {}
        except Cancelled:
            status, error = "cancelled", "Cancelled"
        except ProviderBlocked as e:
            status, error = "failed", f"Blocked by safety filter: {e}"
        except ProviderNotConfigured as e:
            status, error = "failed", str(e)
        except RetryableProviderError as e:
            waits = int(ctx.result.get("rate_limit_waits") or 0)
            if e.rate_limited and waits < MAX_RATE_LIMIT_WAITS:
                # wait in the queue until the provider's rate resets; this does not use up a retry
                wait = e.retry_after if getattr(e, "cooled", False) and e.retry_after else ratelimit.cool(
                    e.provider or "unknown", e.retry_after)
                run_after = utcnow() + timedelta(seconds=max(wait, 5))
                status, refund, result = "queued", True, {"rate_limit_waits": waits + 1}
                error = f"Waiting for the {e.provider or 'provider'} rate limit, retrying at {run_after:%H:%M:%S} UTC. {e}"
            elif attempts < max_attempts:
                status, error = "queued", f"Retrying after error: {e}"
                run_after = utcnow() + timedelta(seconds=min(30 * 2 ** (attempts - 1), 600))
            else:
                status, error = "failed", str(e)
        except FFmpegError as e:
            if attempts < max_attempts:
                status, error = "queued", f"Retrying after error: {e}"
                run_after = utcnow() + timedelta(seconds=min(30 * 2 ** (attempts - 1), 600))
            else:
                status, error = "failed", str(e)
        except ProviderError as e:
            status, error = ("cancelled", "Cancelled") if str(e) == "cancelled" else ("failed", str(e))
        except Exception as e:  # unexpected bug: keep traceback for debugging
            status, error = "failed", f"{type(e).__name__}: {e}\n" + "".join(traceback.format_exc().splitlines(True)[-6:])
        finally:
            with self.lock:
                self.running.pop(job_id, None)
                self.nested.discard(job_id)
        with SessionLocal() as db:
            job = db.get(Job, job_id)
            if job:
                job.status = status
                job.error = error[:4000]
                job.result = {**(job.result or {}), **result}
                job.run_after = run_after
                if refund:
                    job.attempts = max(0, (job.attempts or 1) - 1)
                if status == "succeeded":
                    job.progress, job.message = 1.0, job.message or "Done"
                if status in ("succeeded", "failed", "cancelled"):
                    job.finished_at = utcnow()
                    if job.shot_id:
                        busy = db.query(Job).filter(Job.shot_id == job.shot_id, Job.id != job.id,
                                                    Job.status.in_(("queued", "running"))).count()
                        if not busy:
                            shot = db.get(Shot, job.shot_id)
                            if shot:
                                shot.generating, shot.locked_by = False, None
                db.commit()
                emit(db, job.project_id, "job.updated", {"job_id": job.id, "status": status, "type": job.type,
                                                          "error": error[:300], "shot_id": job.shot_id})


_worker: Worker | None = None


def start_worker() -> Worker:
    global _worker
    if _worker is None:
        _worker = Worker()
        _worker.start()
    return _worker


def stop_worker() -> None:
    if _worker:
        _worker.stop()
