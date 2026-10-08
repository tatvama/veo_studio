"""Team presence and edit locks."""
from __future__ import annotations

import time
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.core import collab
from conftest import H, ok
from test_audit_fixes import _shot

RAVI = SimpleNamespace(id=9001, name="Ravi", email="ravi@test.local")
MEERA = SimpleNamespace(id=9002, name="Meera", email="meera@test.local")


def test_locks_are_leases():
    collab.reset()
    assert collab.acquire("shot:1", RAVI, 1) == (True, None)
    ok_, holder = collab.acquire("shot:1", MEERA, 1)
    assert not ok_ and holder["name"] == "Ravi"
    assert collab.acquire("shot:1", RAVI, 1)[0]  # renewing your own lock is fine
    collab.release("shot:1", MEERA)  # someone else can't release it
    assert collab.holder("shot:1", MEERA)["name"] == "Ravi"
    collab._locks["shot:1"]["expires"] = time.time() - 1  # the editing tab went away
    assert collab.holder("shot:1", MEERA) is None and collab.acquire("shot:1", MEERA, 1)[0]
    collab.reset()


def test_presence_groups_tabs_per_person():
    collab.reset()
    collab.report("tab-a", RAVI, 7, "studio", "shot:3")
    collab.report("tab-b", RAVI, 7, "timeline", "")
    collab.report("tab-c", MEERA, 8, "shots", "")
    snap = collab.snapshot(7)
    assert [p["name"] for p in snap["people"]] == ["Ravi"]
    assert set(snap["people"][0]["views"]) == {"studio", "timeline"} and snap["people"][0]["editing"] == ["shot:3"]
    collab.leave("tab-a")
    assert collab.snapshot(7)["people"][0]["editing"] == []
    collab.reset()


def test_someone_elses_lock_blocks_changes(client: TestClient):
    collab.reset()
    pid, eid, sid = _shot(client)
    collab.acquire(f"shot:{sid}", RAVI, pid)
    r = client.patch(f"/api/shots/{sid}", headers=H, json={"action": "A different idea."})
    assert r.status_code == 423 and "Ravi is editing this shot" in r.json()["detail"]
    assert client.post(f"/api/shots/{sid}/keyframe", headers=H, json={}).status_code == 423
    mine = ok(client.post("/api/locks", headers=H, json={"target": f"shot:{sid}"}))
    assert not mine["ok"] and mine["holder"]["name"] == "Ravi"
    collab.release(f"shot:{sid}", RAVI)
    # the board: whoever holds it is the only one who can save the list
    me = ok(client.post("/api/locks", headers=H, json={"target": f"board:{eid}"}))
    assert me["ok"]
    assert ok(client.get(f"/api/projects/{pid}/presence"))["locks"][0]["target"] == f"board:{eid}"
    ok(client.post("/api/locks/release", headers=H, json={"target": f"board:{eid}"}))
    collab.acquire(f"board:{eid}", MEERA, pid)
    b = ok(client.get(f"/api/episodes/{eid}/board"))
    r = client.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": b["scenes"], "version": b["version"]})
    assert r.status_code == 423 and "Meera" in r.json()["detail"]
    assert client.post("/api/locks", headers=H, json={"target": "shot:abc"}).status_code == 400
    collab.reset()
