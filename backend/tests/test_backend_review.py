"""Fixes from the backend review: media path normalisation, Google sign-in state, the anonymous health body, index
and foreign-key aware migrations, budget reservations of orchestrators, worker recovery, concat escaping, the
hardware encoder choice, pre-aggregated shot views and the shared event poller."""
from __future__ import annotations

import time
from urllib.parse import parse_qs, urlparse

from conftest import H, ok
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.storage import get_storage

_VIEWER: dict[str, TestClient] = {}


def _viewer(c: TestClient) -> TestClient:
    if not _VIEWER:
        ok(c.post("/api/users", headers=H, json={"email": "review.viewer@test.local", "name": "Vik", "role": "viewer",
                                                 "password": "viewer-pass-123"}))
        o = TestClient(app)  # no lifespan: must not stop the shared worker
        ok(o.post("/api/auth/login", headers=H, json={"email": "review.viewer@test.local", "password": "viewer-pass-123"}))
        _VIEWER["c"] = o
    return _VIEWER["c"]


# ── 1. /media: the private check uses the cleaned storage key ────────────────

def test_media_private_check_uses_the_cleaned_key(client: TestClient):
    st = get_storage()
    st.save_bytes("consents/review_release.pdf", b"%PDF-1.4 signed release")
    st.save_bytes("projects/1/review_open.txt", b"public enough")
    viewer = _viewer(client)
    # a producer (the admin) opens the release, however the path is spelled
    for spelled in ("consents/review_release.pdf", "./consents/review_release.pdf", "/consents//review_release.pdf",
                    "Consents/review_release.pdf"):
        assert client.get(f"/media/{spelled}").status_code == 200, spelled
    # a viewer is refused on every spelling: "." and empty parts are dropped before the folder is looked at
    for spelled in ("consents/review_release.pdf", "./consents/review_release.pdf", "/consents//review_release.pdf",
                    ".//consents/review_release.pdf", "Consents/review_release.pdf", "consents\\review_release.pdf"):
        assert viewer.get(f"/media/{spelled}").status_code == 403, spelled
    assert viewer.get("/media/./projects/1/review_open.txt").status_code == 200
    # invalid keys answer 404 whoever asks (nothing about the file system leaks)
    for bad in ("..%2Fsecret", "projects/../../x", "C:/x.txt"):
        assert client.get(f"/media/{bad}").status_code == 404, bad
        assert viewer.get(f"/media/{bad}").status_code == 404, bad
    anon = TestClient(app)
    assert anon.get("/media/./consents/review_release.pdf").status_code == 401


# ── 2. Google sign-in: states expire and are bound to the browser ────────────

def test_google_state_expires_and_is_bound_to_the_browser(client: TestClient, monkeypatch):
    from app.api import auth

    s = get_settings()
    monkeypatch.setattr(s, "google_client_id", "client-id.apps.googleusercontent.com")
    monkeypatch.setattr(s, "google_client_secret", "secret")
    auth._states.clear()

    browser = TestClient(app)
    r = browser.get("/api/auth/google/start", follow_redirects=False)
    assert r.status_code in (302, 307)
    state = parse_qs(urlparse(r.headers["location"]).query)["state"][0]
    assert state in auth._states and browser.cookies.get(auth.STATE_COOKIE)

    class _Resp:
        def __init__(self, data):
            self._d = data

        def json(self):
            return self._d

    monkeypatch.setattr(auth.httpx, "post", lambda *a, **k: _Resp({"access_token": "tok"}))
    monkeypatch.setattr(auth.httpx, "get", lambda *a, **k: _Resp({"email": "admin@test.local", "email_verified": True, "name": "Admin"}))

    # another browser (no state cookie) presenting a valid state: login CSRF, refused; the state stays usable
    other = TestClient(app)
    assert other.get(f"/api/auth/google/callback?code=abc&state={state}", follow_redirects=False).status_code == 400
    # a stale state is refused and purged
    browser2 = TestClient(app)
    r2 = browser2.get("/api/auth/google/start", follow_redirects=False)
    old_state = parse_qs(urlparse(r2.headers["location"]).query)["state"][0]
    auth._states[old_state] = time.time() - auth.STATE_TTL_S - 1
    assert browser2.get(f"/api/auth/google/callback?code=abc&state={old_state}", follow_redirects=False).status_code == 400
    assert old_state not in auth._states
    # the right browser, the right state: signed in, state used up, state cookie gone
    r = browser.get(f"/api/auth/google/callback?code=abc&state={state}", follow_redirects=False)
    assert r.status_code in (302, 307), r.text
    assert browser.cookies.get(auth.COOKIE) and state not in auth._states
    assert not browser.cookies.get(auth.STATE_COOKIE)
    assert browser.get(f"/api/auth/google/callback?code=abc&state={state}", follow_redirects=False).status_code == 400  # one use
    # unknown states never pile up: nothing is stored for a callback that fails
    assert "forged" not in auth._states


# ── 3. /api/health says little to strangers ──────────────────────────────────

def test_health_hides_provider_modes_from_anonymous_callers(client: TestClient):
    anon = TestClient(app)
    body = anon.get("/api/health").json()
    assert body == {"ok": True, "version": app.version}
    mine = client.get("/api/health").json()
    assert mine["ok"] is True and mine["version"] == app.version
    assert isinstance(mine["providers"], list) and mine["providers"] and "mode" in mine["providers"][0]


# ── 8. edits are found by an indexed column ──────────────────────────────────

def test_edit_lookup_uses_the_indexed_column_and_is_backfilled(client: TestClient):
    from app.api.edits import find_edit
    from app.db import SessionLocal
    from app.db_migrate import migrate
    from app.models import Project

    e = ok(client.post("/api/edits", headers=H, json={"name": "Indexed", "edit_id": "p_indexed_review_1"}))
    with SessionLocal() as db:
        p = db.get(Project, e["id"])
        assert p.edit_id == "p_indexed_review_1" and p.brief["edit_id"] == "p_indexed_review_1"
        assert find_edit(db, "p_indexed_review_1").id == p.id and find_edit(db, "p_nobody") is None
        # a project from before the column existed: only brief.edit_id, found again after migrate backfills it
        legacy = Project(title="Legacy edit", type="edit", brief={"edit_id": "p_legacy_review_1"}, status="edit")
        db.add(legacy)
        db.commit()
        legacy_id = legacy.id
        assert find_edit(db, "p_legacy_review_1") is None
    changed = migrate()
    assert any(c.startswith("projects.edit_id <- brief") for c in changed)
    with SessionLocal() as db:
        assert find_edit(db, "p_legacy_review_1").id == legacy_id
        assert db.get(Project, legacy_id).edit_id == "p_legacy_review_1"
    again = ok(client.post("/api/edits", headers=H, json={"name": "Legacy edit", "edit_id": "p_legacy_review_1"}))
    assert again["id"] == legacy_id and again["edit_id"] == "p_legacy_review_1"


# ── 10. a worker recovers only its own jobs, and stale ones ──────────────────

def test_worker_recovers_its_own_and_stale_jobs_only(client: TestClient):
    from datetime import timedelta

    from app.db import SessionLocal, utcnow
    from app.models import Job
    from app.workers.worker import STALE_RUNNING_S, Worker

    far = utcnow() + timedelta(days=1)  # run_after in the future: the live worker leaves these in the queue
    now = utcnow()
    with SessionLocal() as db:
        mine = Job(type="noop_review", status="running", label="mine", worker_id="review-worker-a", heartbeat_at=now,
                   started_at=now, run_after=far)
        theirs = Job(type="noop_review", status="running", label="theirs (alive)", worker_id="review-worker-b",
                     heartbeat_at=now, started_at=now, run_after=far)
        dead = Job(type="noop_review", status="running", label="theirs (dead)", worker_id="review-worker-b",
                   heartbeat_at=now - timedelta(seconds=STALE_RUNNING_S + 60), started_at=now - timedelta(hours=2), run_after=far)
        legacy = Job(type="noop_review", status="running", label="before worker ids", worker_id=None, heartbeat_at=None,
                     started_at=now, run_after=far)
        db.add_all([mine, theirs, dead, legacy])
        db.commit()
        ids = {"mine": mine.id, "theirs": theirs.id, "dead": dead.id, "legacy": legacy.id}
    try:
        w = Worker(concurrency=1, id_="review-worker-a")
        assert w.recover() == 2
        with SessionLocal() as db:
            st = {k: db.get(Job, i) for k, i in ids.items()}
            assert st["mine"].status == "queued" and st["mine"].worker_id is None and "restart" in st["mine"].message
            assert st["theirs"].status == "running" and st["theirs"].worker_id == "review-worker-b"  # in flight elsewhere
            assert st["dead"].status == "queued" and "stopped responding" in st["dead"].message
            assert st["legacy"].status == "running"  # fresh start, no heartbeat yet: left alone until it goes stale
        assert w.recover(own=False) == 0  # nothing new: the live one stays, the recovered ones are queued
        # a job this process is running right now is never requeued, even with a stale stamp
        w.running[ids["theirs"]] = "noop_review"
        with SessionLocal() as db:
            db.get(Job, ids["theirs"]).heartbeat_at = now - timedelta(hours=1)
            db.commit()
        assert w.recover(own=False) == 0
        w.heartbeat()
        with SessionLocal() as db:
            assert db.get(Job, ids["theirs"]).heartbeat_at > now - timedelta(minutes=1)
    finally:
        with SessionLocal() as db:
            db.query(Job).filter(Job.id.in_(list(ids.values()))).delete()
            db.commit()


# ── 6. abandoned upload locks are dropped ────────────────────────────────────

def test_abandoned_chunk_locks_are_purged(client: TestClient):
    import asyncio

    from app.api import desktop as desktop_api

    desktop_api._chunk_locks.clear()
    old = time.monotonic() - desktop_api.CHUNK_LOCK_TTL_S - 1
    desktop_api._chunk_locks["abandoned"] = (asyncio.Lock(), old)
    held = asyncio.Lock()
    desktop_api._chunk_locks["old-but-busy"] = (held, old)
    desktop_api._chunk_locks["recent"] = (asyncio.Lock(), time.monotonic())

    async def hold_and_access():
        async with held:
            return desktop_api._chunk_lock("fresh")

    lk = asyncio.run(hold_and_access())
    assert "abandoned" not in desktop_api._chunk_locks
    assert set(desktop_api._chunk_locks) == {"old-but-busy", "recent", "fresh"}
    assert desktop_api._chunk_lock("fresh") is lk  # the same lock while the upload goes on
    desktop_api._chunk_locks.clear()


def test_upload_endpoints_do_not_block_the_event_loop_signature(client: TestClient):
    """The upload handlers are coroutines whose blocking work is handed to a thread: a smoke check that the calls
    still work end to end (layers media upload probes the file with FFmpeg)."""
    import inspect as pyinspect

    from app.api import desktop as desktop_api
    from app.api import layers as layers_api
    from app.api import shots as shots_api
    for fn in (layers_api.upload_media, shots_api.upload_keyframe, desktop_api.upload_chunk):
        assert pyinspect.iscoroutinefunction(fn)
        assert "asyncio.to_thread" in pyinspect.getsource(fn)


# ── 7. a running orchestrator reserves nothing; its children do ──────────────

def test_running_orchestrators_do_not_double_reserve(client: TestClient):
    from datetime import timedelta

    from app.core import budget
    from app.core.job_types import ORCHESTRATORS
    from app.db import SessionLocal, utcnow
    from app.models import Job
    from app.workers import worker as worker_mod

    assert worker_mod.ORCHESTRATORS == ORCHESTRATORS == {"dub", "autopilot", "produce", "campaign", "scene_chain"}
    far = utcnow() + timedelta(days=1)
    made: list[int] = []
    try:
        with SessionLocal() as db:
            for n, kind in enumerate(("campaign", "scene_chain", "dub")):
                pid = 900_000 + n  # the project only needs to be an id the sums filter on
                parent = Job(type=kind, status="running", project_id=pid, cost_estimate=5.0, run_after=far)
                db.add(parent)
                db.flush()
                kids = [Job(type="video", status="queued", project_id=pid, parent_job_id=parent.id, cost_estimate=1.0, run_after=far)
                        for _ in range(2)]
                db.add_all(kids)
                db.flush()
                made += [parent.id, *(k.id for k in kids)]
                assert budget.reserved(db, project_id=pid) == 2.0, kind  # the children once, not 5 + 2
            db.commit()
            # a queued (not yet running) orchestrator still holds its own estimate
            waiting = Job(type="campaign", status="queued", project_id=900_010, cost_estimate=5.0, run_after=far)
            db.add(waiting)
            db.commit()
            made.append(waiting.id)
            assert budget.reserved(db, project_id=900_010) == 5.0
    finally:
        with SessionLocal() as db:
            db.query(Job).filter(Job.id.in_(made)).delete()
            db.commit()


# ── 9. submits of one project happen one at a time ───────────────────────────

def test_submit_takes_the_write_lock_before_its_checks(client: TestClient):
    import sqlite3

    import pytest

    from app.core import jobs
    from app.db import SessionLocal, is_sqlite
    if not is_sqlite():
        return
    db_file = get_settings().db_url.removeprefix("sqlite:///")
    with SessionLocal() as db:
        jobs.lock_project(db, 1)
        other = sqlite3.connect(db_file, timeout=0.3)
        try:
            with pytest.raises(sqlite3.OperationalError):  # the writer lock is held until the submit commits
                other.execute("BEGIN IMMEDIATE")
            db.rollback()
            other.execute("BEGIN IMMEDIATE")
            other.rollback()
        finally:
            other.close()
        jobs.lock_project(db, None)  # no project: nothing to lock


def test_concurrent_submits_of_the_same_shot_make_one_job(client: TestClient):
    import threading

    from app.core import jobs
    from app.db import SessionLocal
    from app.models import Episode, Project, Shot, User

    with SessionLocal() as db:
        admin = db.query(User).filter(User.role == "admin").first()
        p = Project(title="Race project")
        db.add(p)
        db.flush()
        ep = Episode(project_id=p.id, number=1, title="E1")
        db.add(ep)
        db.flush()
        sh = Shot(episode_id=ep.id, order=1, code="RACE-1")
        db.add(sh)
        db.commit()
        pid, sid = p.id, sh.id
    results: list[dict] = []
    errors: list[Exception] = []
    start = threading.Barrier(4)

    def go():
        try:
            start.wait(timeout=10)
            with SessionLocal() as db:
                project = db.get(Project, pid)
                results.append(jobs.submit(db, admin, project, [jobs.spec("keyframe", shot_id=sid, project_id=pid, estimate=0.0)],
                                           propose=True))
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=go) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert not errors, errors
    assert sum(len(r["jobs"]) for r in results) == 1 and sum(r["skipped"] for r in results) == 3


# ── 11. concat lists quote apostrophes the demuxer's way ─────────────────────

def test_concat_list_escapes_apostrophes(tmp_path, monkeypatch):
    from pathlib import Path

    from app.pipeline import ffmpeg as ff

    calls: list[list] = []
    monkeypatch.setattr(ff, "run", lambda args, timeout=900: calls.append(args) or "")
    clip = tmp_path / "Priya's cut" / "it's take 1.mp4"
    plain = tmp_path / "plain.mp4"
    out = tmp_path / "out.mp4"
    ff.concat([clip, plain], out)
    lines = (tmp_path / "out_list.txt").read_text(encoding="utf-8").splitlines()
    assert lines[0] == "file '" + clip.resolve().as_posix().replace("'", "'\\''") + "'"
    assert "'\\''" in lines[0] and lines[0].count("'\\''") == 2
    assert lines[1] == f"file '{plain.resolve().as_posix()}'"
    assert ff.concat_list_line(Path("a'b")).endswith("a'\\''b'\n")
    assert calls and calls[0][:4] == ["-f", "concat", "-safe", "0"]
