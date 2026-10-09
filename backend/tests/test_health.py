"""Health checks: liveness, readiness (database + worker), and the container probe command."""
from __future__ import annotations

import os
import time

from app import health


def test_live_answers(client):
    r = client.get("/api/health/live")
    assert r.status_code == 200 and r.json()["ok"] is True and "uptime_s" in r.json()


def test_ready_when_database_and_worker_are_fine(client):
    deadline = time.time() + 10
    while not health.worker_alive() and time.time() < deadline:  # the in-process worker beats on its first loop pass
        time.sleep(0.2)
    r = client.get("/api/health/ready")
    body = r.json()
    assert r.status_code == 200 and body["ok"] and body["database"]["ok"] and body["worker"]["ok"] is True


def test_not_ready_when_the_database_fails(client, monkeypatch):
    monkeypatch.setattr(health, "check_database", lambda: (False, 10000.0, "TimeoutError: timed out"))
    r = client.get("/api/health/ready")
    assert r.status_code == 503 and r.json()["database"]["error"].startswith("TimeoutError")
    assert client.get("/api/health/live").status_code == 200  # liveness doesn't care


def test_not_ready_when_the_in_process_worker_is_stuck(client, monkeypatch):
    monkeypatch.setattr(health, "heartbeat_age", lambda: 500.0)
    r = client.get("/api/health/ready")
    assert r.status_code == 503 and r.json()["worker"]["ok"] is False


def test_worker_probe_reads_the_heartbeat(monkeypatch, tmp_path):
    hb = tmp_path / "hb"
    monkeypatch.setattr(health, "HEARTBEAT", hb)
    monkeypatch.setattr(health, "_last_beat", 0.0)
    assert health.main(["health", "worker"]) == 1  # never beat
    health.beat()
    assert hb.exists() and health.main(["health", "worker"]) == 0
    old = time.time() - 600
    os.utime(hb, (old, old))
    assert health.main(["health", "worker"]) == 1  # stale


def test_api_probe(monkeypatch):
    monkeypatch.setattr(health, "_probe_api", lambda port, timeout_s=4.0: True)
    assert health.main(["health", "api"]) == 0
    monkeypatch.setattr(health, "_probe_api", lambda port, timeout_s=4.0: False)
    assert health.main(["health"]) == 1
