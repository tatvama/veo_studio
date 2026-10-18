"""A price before every paid action: POST /api/estimate prices one single-item action (a shot's extension or end frame,
a take's edit, a character's sheet, a place's pictures, an episode's sound design…) without starting or remembering
anything, in the same shape as the batch estimate the cost dialog shows."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Character, Job
from conftest import H, ok

SCRIPT = """CHARACTERS:
MEERA – 28, a potter, clay on her hands

SCENE 1: INT. POTTERY SHED - DAY
SHOT 1
VISUAL: Meera shapes a pot on the wheel.
MEERA: Almost there.
"""


def _setup(c: TestClient) -> tuple[int, int, int, int]:
    p = ok(c.post("/api/projects", headers=H, json={"concept": "The Pot", "type": "short", "auto_brief": False}))
    pid, eid = p["id"], p["episodes"][0]["id"]
    out = ok(c.post(f"/api/episodes/{eid}/import/parse", headers=H, data={"text": SCRIPT}))
    res = ok(c.post(f"/api/episodes/{eid}/import/apply", headers=H, json={"draft": out["draft"], "mapping": {}}))
    sid = ok(c.get(f"/api/episodes/{eid}/board"))["scenes"][0]["shots"][0]["id"]
    return pid, eid, sid, res["characters"]["Meera"]


def _jobs(pid: int) -> int:
    with SessionLocal() as db:
        return db.query(Job).filter(Job.project_id == pid).count()


def test_every_single_action_has_a_price_and_nothing_starts(client: TestClient):
    c = client
    pid, eid, sid, cid = _setup(c)
    before = _jobs(pid)
    bodies = [
        {"action": "extend", "shot_id": sid, "prompt": "she smiles"},
        {"action": "endframe", "shot_id": sid},
        {"action": "sheet", "character_id": cid, "project_id": pid},
        {"action": "expressions", "character_id": cid, "project_id": pid},
        {"action": "lighting", "character_id": cid, "project_id": pid},
        {"action": "outfit", "character_id": cid, "project_id": pid, "name": "Festival", "description": "a red silk saree"},
        {"action": "variations", "character_id": cid, "project_id": pid, "count": 4},
        {"action": "voice_design", "character_id": cid, "project_id": pid, "language": "en"},
        {"action": "sfx", "episode_id": eid},
        {"action": "table_read", "episode_id": eid},
    ]
    for body in bodies:
        est = ok(c.post("/api/estimate", headers=H, json=body))
        assert est["count"] == 1, body
        assert est["total_usd"] >= 0 and len(est["items"]) == 1 and est["items"][0]["label"]
        assert set(est["budget"]) >= {"ok", "needs_role", "reason"} and "cap_usd" in est["team"]
    assert _jobs(pid) == before  # pricing never starts a job


def test_a_picked_engine_is_checked_but_not_remembered(client: TestClient):
    c = client
    pid, _, _, cid = _setup(c)
    ok(c.post("/api/estimate", headers=H, json={"action": "sheet", "character_id": cid, "project_id": pid, "engine": "auto"}))
    r = c.post("/api/estimate", headers=H, json={"action": "sheet", "character_id": cid, "engine": "nope:not-an-engine"})
    assert r.status_code == 400
    with SessionLocal() as db:
        assert db.get(Character, cid).sheet_engine in ("", None)


def test_bad_requests(client: TestClient):
    c = client
    assert c.post("/api/estimate", headers=H, json={"action": "make-money"}).status_code == 422
    assert c.post("/api/estimate", headers=H, json={"action": "extend"}).status_code == 400  # which shot?
    assert c.post("/api/estimate", headers=H, json={"action": "extend", "shot_id": 999999}).status_code == 404


def test_a_take_edit_is_priced(client: TestClient):
    c = client
    pid, eid, sid, _ = _setup(c)
    # a video take to edit (mock providers make it at no cost)
    ok(c.post(f"/api/shots/{sid}/video", headers=H, json={}))
    from conftest import wait_jobs
    wait_jobs(c, pid)
    shot = ok(c.get(f"/api/shots/{sid}"))
    assert shot["video"], "the mock video was made"
    est = ok(c.post("/api/estimate", headers=H, json={"action": "edit", "take_id": shot["video"]["id"], "instruction": "make it night"}))
    assert est["count"] == 1 and "Edit take" in est["items"][0]["label"]
