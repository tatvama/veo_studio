"""Standalone worker process (used by docker-compose `worker` service, with RUN_WORKER_IN_PROCESS=false on the API).

    python -m app.workers.run
"""
from __future__ import annotations

import signal
import time

from ..db import Base, engine
from .worker import start_worker, stop_worker


def main() -> None:
    for attempt in range(10):  # API and worker start together; let whichever is first create the tables
        try:
            Base.metadata.create_all(bind=engine)
            break
        except Exception as e:
            print(f"[worker] waiting for database ({e.__class__.__name__}), retry {attempt + 1}/10")
            time.sleep(3)
    w = start_worker()
    running = True

    def _stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    while running:
        time.sleep(1)
    stop_worker()
    # let in-flight jobs finish their current step; interrupted jobs are re-queued on next start
    w.pool.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
