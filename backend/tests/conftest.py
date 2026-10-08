"""Shared test setup: isolated temp DB/media, mock providers, one running studio (API + worker) for all tests."""
from __future__ import annotations

import os
import shutil
import tempfile
import time
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="veo_test_"))
os.environ.update({
    "DATABASE_URL": f"sqlite:///{(TMP / 'test.db').as_posix()}",
    "MEDIA_ROOT": str(TMP / "media"),
    "DATA_ROOT": str(TMP / "data"),
    "MOCK_PROVIDERS": "true",
    "STORAGE_BACKEND": "local",  # never write test files to the real bucket from .env
    "APP_SECRET": "test-secret",
    "RUN_WORKER_IN_PROCESS": "true",
    "WORKER_CONCURRENCY": "4",
})

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

H = {"X-Requested-With": "veo-studio"}
FIXTURES = Path(__file__).parent / "fixtures"


def ok(r):
    assert r.status_code < 400, f"{r.status_code}: {r.text[:800]}"
    return r.json()


def wait_jobs(c: TestClient, project_id: int | None, timeout: float = 300) -> list[dict]:
    start = time.time()
    q = f"project_id={project_id}&" if project_id else ""
    active: list = []
    while time.time() - start < timeout:
        active = c.get(f"/api/jobs?{q}status=active").json()
        if not [j for j in active if j["status"] in ("queued", "running")]:
            return c.get(f"/api/jobs?{q}limit=500").json()
        time.sleep(1)
    raise AssertionError(f"jobs still running: {active}")


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        r = c.post("/api/auth/setup", json={"email": "admin@test.local", "name": "Admin", "password": "test-password-1"}, headers=H)
        assert r.status_code == 200, r.text
        yield c
    shutil.rmtree(TMP, ignore_errors=True)
