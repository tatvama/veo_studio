"""Health checks for containers and platforms such as Coolify.

- GET /api/health/live   the process answers (never touches the database, so a slow database can't restart the app)
- GET /api/health/ready  the database answers and the job worker is alive (503 with details when not)
- python -m app.health api      exit 0 when /api/health/live answers (Docker HEALTHCHECK for the web container)
- python -m app.health worker   exit 0 when the worker's heartbeat is fresh (health check for the worker container)

The worker loop calls `beat()` every pass; the heartbeat is a small file whose modification time is the signal.
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HEARTBEAT = Path(os.environ.get("WORKER_HEARTBEAT_FILE") or Path(tempfile.gettempdir()) / "tatvam-worker.heartbeat")
STALE_AFTER_S = 90.0  # the loop beats every few seconds; a minute and a half of silence means it is stuck or gone
_last_beat = 0.0
STARTED_AT = time.time()


def beat(min_interval_s: float = 5.0) -> None:
    """Record that the worker loop is alive (cheap, rate-limited)."""
    global _last_beat
    now = time.time()
    if now - _last_beat < min_interval_s:
        return
    _last_beat = now
    try:
        HEARTBEAT.touch(exist_ok=True)
        os.utime(HEARTBEAT, (now, now))
    except OSError:
        pass


def heartbeat_age() -> float | None:
    """Seconds since the worker last beat, or None if it never has."""
    try:
        return max(0.0, time.time() - HEARTBEAT.stat().st_mtime)
    except OSError:
        return None


def worker_alive() -> bool:
    age = heartbeat_age()
    return age is not None and age < STALE_AFTER_S


def check_database() -> tuple[bool, float, str]:
    """(ok, milliseconds, error) for a trivial query on a fresh pooled connection."""
    from sqlalchemy import text

    from .db import engine
    t0 = time.perf_counter()
    try:
        with engine.connect() as c:
            c.execute(text("SELECT 1"))
        return True, round((time.perf_counter() - t0) * 1000, 1), ""
    except Exception as e:  # report, don't raise: this feeds a status page
        return False, round((time.perf_counter() - t0) * 1000, 1), f"{type(e).__name__}: {str(e)[:200]}"


def _probe_api(port: int, timeout_s: float = 4.0) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health/live", timeout=timeout_s) as r:
            return r.status == 200
    except Exception:
        return False


def main(argv: list[str]) -> int:
    mode = argv[1] if len(argv) > 1 else "api"
    if mode == "worker":
        age = heartbeat_age()
        ok = age is not None and age < STALE_AFTER_S
        print(f"worker heartbeat {'ok' if ok else 'STALE'}: {'never' if age is None else f'{age:.0f}s ago'}")
        return 0 if ok else 1
    port = int(os.environ.get("PORT", "8100"))
    ok = _probe_api(port)
    print(f"api on :{port} {'ok' if ok else 'NOT answering'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
