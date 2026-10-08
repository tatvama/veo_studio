"""Regression tests for the bug audit: cancelling, take selection, stale lip-sync, script import, board saves."""
from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.core import jobs as jobs_core
from app.core.script_import import parse_marked
from app.db import SessionLocal, utcnow
from app.models import Job, Shot, Take, User
from app.pipeline.selection import current, has_fresh, is_stale
from app.workers.worker import Cancelled, JobContext
from conftest import H, ok
from test_board import _project

LATER = utcnow() + timedelta(days=30)  # parked: the in-process worker must not pick these up


def _shot(c: TestClient) -> tuple[int, int, int]:
    pid, eid = _project(c)
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [
        {"title": "One", "shots": [{"prompt": "A quiet street at dawn.", "duration_s": 8}]}]}))
    with SessionLocal() as db:
        sid = db.query(Shot.id).filter(Shot.episode_id == eid).first()[0]
    return pid, eid, sid


def _job(db, type_: str, status: str = "queued", **kw) -> Job:
    j = Job(type=type_, status=status, label=type_, run_after=LATER, payload=kw.pop("payload", {}), **kw)
    db.add(j)
    db.flush()
    return j


def test_stop_reaches_running_children_and_blocks_new_ones(client: TestClient):
    pid, eid, sid = _shot(client)
    with SessionLocal() as db:
        root = _job(db, "produce", "running", project_id=pid, episode_id=eid, batch_id="audit1")
        kid = _job(db, "video", "running", project_id=pid, shot_id=sid, parent_job_id=root.id, batch_id="audit1")
        qc = _job(db, "qc", "queued", project_id=pid, parent_job_id=kid.id, batch_id="audit1")
        db.commit()
        ids = root.id, kid.id, qc.id
    with SessionLocal() as db:
        jobs_core.cancel_batch(db, "audit1")
    with SessionLocal() as db:
        root, kid, qc = (db.get(Job, i) for i in ids)
        assert root.cancel_requested and kid.cancel_requested and qc.status == "cancelled"
        ctx = JobContext(kid)
    with pytest.raises(Cancelled):  # e.g. QC asking for an auto-retake after "stop all"
        ctx.enqueue_child("video", {"retake_count": 1}, shot_id=sid)
    with SessionLocal() as db:
        db.query(Job).filter(Job.id.in_(ids)).update({"status": "cancelled"})
        db.commit()


def test_resumed_run_reuses_its_waiting_children(client: TestClient):
    pid, eid, sid = _shot(client)
    with SessionLocal() as db:
        root = _job(db, "produce", "running", project_id=pid, episode_id=eid, batch_id="audit2")
        db.commit()
        ctx = JobContext(root)
    a = ctx.enqueue_child("video", {"quality": "saver", "mode": None}, shot_id=sid)
    b = ctx.enqueue_child("video", {"quality": "saver", "mode": None}, shot_id=sid)  # after a restart: same work again
    assert a == b
    with SessionLocal() as db:
        db.query(Job).filter(Job.id.in_((a, root.id))).update({"status": "cancelled"})
        db.commit()


def test_one_produce_per_episode(client: TestClient):
    pid, eid, _ = _shot(client)
    with SessionLocal() as db:
        _job(db, "autopilot", "running", project_id=pid, episode_id=eid)
        db.commit()
        user = db.query(User).first()
        with pytest.raises(Exception) as ei:
            jobs_core.submit(db, user, None, [jobs_core.spec("produce", project_id=pid, episode_id=eid)])
        assert getattr(ei.value, "status_code", 0) == 409
        db.query(Job).filter(Job.episode_id == eid).update({"status": "cancelled"})
        db.commit()


def test_new_video_wins_over_lipsync_of_the_old_one(client: TestClient):
    _, _, sid = _shot(client)
    with SessionLocal() as db:
        old = Take(shot_id=sid, kind="video", path="x/old.mp4", status="ready")
        db.add(old)
        db.flush()
        lip = Take(shot_id=sid, kind="lipsync", language="en", path="x/lip.mp4", status="ready", parent_take_id=old.id,
                   selected=True)
        new = Take(shot_id=sid, kind="video", path="x/new.mp4", status="ready", selected=True)
        db.add_all([lip, new])
        db.commit()
        assert current(db, sid, "video").id == new.id
        assert is_stale(db, lip, new) and not has_fresh(db, sid, "lipsync", "en")


def test_your_retake_on_an_approved_shot_becomes_current(client: TestClient, monkeypatch):
    from app.workers import handlers
    _, _, sid = _shot(client)
    with SessionLocal() as db:
        shot = db.get(Shot, sid)
        shot.status = "approved"
        first = Take(shot_id=sid, kind="video", path="x/a.mp4", status="ready", selected=True)
        db.add(first)
        db.commit()
    monkeypatch.setattr(handlers.ff, "thumbnail", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no ffmpeg")))
    monkeypatch.setattr(handlers.ff, "duration", lambda *a, **k: 8.0)

    class Ctx:
        project_id, job_id, user_id, payload = None, None, None, {}

    with SessionLocal() as db:
        shot = db.get(Shot, sid)
        ctx = Ctx()
        ctx.parent_job_id, ctx.payload = 999, {"retake_count": 1}  # an automatic retake: what you approved stays
        auto = handlers.save_take(db, ctx, shot, "video", b"v", "mp4")
        assert not auto.selected and shot.status == "approved"
        ctx.parent_job_id, ctx.payload = None, {}  # you asked for it
        mine = handlers.save_take(db, ctx, shot, "video", b"v", "mp4")
        db.commit()
        assert mine.selected and shot.status == "video_ready"


def test_import_keeps_wrapped_lines_and_ignores_labels():
    d = parse_marked("SCENE 1: INT. KITCHEN - DAY\nScarlett: Hello there.\nMusic: soft flute\nShots ring out.\n\n"
                     "RAVI\nI have waited so long\nfor this moment.\n")
    shots = d["scenes"][0]["shots"]
    lines = [(l["speaker"], l["text"]) for s in shots for l in s["lines"]]
    assert lines == [("Scarlett", "Hello there."), ("Ravi", "I have waited so long for this moment.")]
    assert len(d["scenes"]) == 1 and "Shots ring out." in " ".join(s["prompt"] for s in shots)


def test_stale_board_save_is_refused(client: TestClient):
    _, eid, _ = _shot(client)
    b = ok(client.get(f"/api/episodes/{eid}/board"))
    v = b["version"]
    scenes = [{"id": sc["id"], "title": sc["title"], "shots": [{"id": s["id"], "prompt": s["prompt"] + " Edited.",
                                                                 "duration_s": s["duration_s"]} for s in sc["shots"]]}
              for sc in b["scenes"]]
    ok(client.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": scenes, "version": v}))
    r = client.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": scenes, "version": v})  # the other tab
    assert r.status_code == 409
