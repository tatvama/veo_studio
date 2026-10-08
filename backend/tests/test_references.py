"""Generation follows what the user gives: keyframes (theirs or approved), characters, shot references, own photos."""
from __future__ import annotations

import io

from fastapi.testclient import TestClient
from PIL import Image

from app.db import SessionLocal
from app.models import Character, Job, Shot
from app.pipeline.prompting import keyframe_refs
from conftest import H, ok, wait_jobs


def _png(color=(30, 140, 90)) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", (96, 160), color).save(b, "PNG")
    return b.getvalue()


def _setup(c: TestClient) -> tuple[int, int, int, int]:
    p = ok(c.post("/api/projects", headers=H, json={"concept": "Pickle jar ad", "type": "ad", "auto_brief": False, "quality_mode": "saver"}))
    pid, eid = p["id"], p["episodes"][0]["id"]
    cid = ok(c.post("/api/characters", headers=H, json={"name": "Ajji", "project_id": pid}))["id"]
    b = ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [{"title": "Kitchen", "shots": [
        {"prompt": "Ajji opens the jar.", "duration_s": 6, "characters": [cid]}]}]}))
    return pid, eid, cid, b["scenes"][0]["shots"][0]["id"]


def test_video_follows_keyframe_even_if_marked_text_to_video(client: TestClient):
    c = client
    pid, eid, cid, sid = _setup(c)
    with SessionLocal() as db:
        db.get(Shot, sid).mode = "text_to_video"  # what the AI planner used to write
        db.commit()
    ok(c.post(f"/api/shots/{sid}/video", headers=H, json={}))
    wait_jobs(c, pid)
    shot = ok(c.get(f"/api/shots/{sid}"))
    assert shot["video"]["params"]["mode"] == "i2v" and shot["keyframe"]  # a keyframe was made and animated


def test_uploaded_keyframe_and_shot_references(client: TestClient):
    c = client
    pid, eid, cid, sid = _setup(c)
    shot = ok(c.post(f"/api/shots/{sid}/keyframe/upload", headers=H, files={"file": ("mine.png", _png(), "image/png")}))
    assert shot["keyframe"]["provider"] == "upload" and shot["keyframe"]["selected"]
    shot = ok(c.post(f"/api/shots/{sid}/refs", headers=H, files={"file": ("jar.png", _png((200, 60, 20)), "image/png")},
                     data={"label": "pickle jar"}))
    assert shot["ref_images"][0]["label"] == "pickle jar" and shot["ref_images"][0]["url"]
    with SessionLocal() as db:
        labels = [l for l, _ in keyframe_refs(db, db.get(Shot, sid), None)]
    assert "reference: pickle jar" in labels

    ok(c.post(f"/api/shots/{sid}/video", headers=H, json={}))
    jobs = wait_jobs(c, pid)
    assert not any(j["type"] == "keyframe" for j in jobs)  # the uploaded keyframe was used, not replaced
    after = ok(c.get(f"/api/shots/{sid}"))
    assert after["keyframe"]["provider"] == "upload" and after["video"]["params"]["mode"] == "i2v"
    ok(c.delete(f"/api/shots/{sid}/refs/0", headers=H))
    assert ok(c.get(f"/api/shots/{sid}"))["ref_images"] == []


def test_identity_trains_only_on_approved_images(client: TestClient):
    c = client
    pid, eid, cid, sid = _setup(c)
    for col in ((10, 10, 10), (20, 20, 20)):
        ok(c.post(f"/api/characters/{cid}/upload", headers=H, files={"file": ("me.png", _png(col), "image/png")}))
    ch = ok(c.get(f"/api/characters/{cid}"))
    assert ch["training"]["basis"] == "your_photos" and ch["training"]["count"] == 2
    few = c.post(f"/api/characters/{cid}/train", headers=H, json={"project_id": pid})
    assert few.status_code == 400 and "at least 4" in few.json()["detail"]  # no silent filler images

    ok(c.post(f"/api/characters/{cid}/training/variations", headers=H, json={"count": 3, "project_id": pid}))
    wait_jobs(c, pid)
    ch = ok(c.get(f"/api/characters/{cid}"))
    var = [a for a in ch["assets"] if a["kind"] == "training"]
    assert len(var) == 3 and not any(a["approved"] for a in var) and ch["training"]["variations_waiting"] == 3
    for a in var[:2]:
        ok(c.patch(f"/api/character-assets/{a['id']}", headers=H, json={"approved": True}))
    assert ok(c.get(f"/api/characters/{cid}"))["training"]["count"] == 4  # 2 photos + the 2 approved variations

    ok(c.post(f"/api/characters/{cid}/train", headers=H, json={"project_id": pid}))
    wait_jobs(c, pid)
    ident = ok(c.get(f"/api/characters/{cid}"))["identity"]
    assert ident["status"] == "ready" and ident["images"] == 4 and ident["basis"] == "your_photos"


def test_stopped_training_is_not_shown_as_preparing(client: TestClient):
    c = client
    cid = ok(c.post("/api/characters", headers=H, json={"name": "Stuck"}))["id"]
    with SessionLocal() as db:
        j = Job(type="train_identity", status="cancelled", error="Cancelled")
        db.add(j)
        db.flush()
        db.get(Character, cid).identity = {"status": "preparing", "job_id": j.id}
        db.commit()
    assert ok(c.get(f"/api/characters/{cid}"))["identity"]["status"] == "cancelled"
