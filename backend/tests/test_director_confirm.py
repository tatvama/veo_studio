"""Director: actions that would replace existing work wait for the user's OK (in both approval modes)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from conftest import H, ok


def _last_assistant(c: TestClient, pid: int) -> dict:
    return [m for m in ok(c.get(f"/api/projects/{pid}/agent/messages")) if m["role"] == "assistant"][-1]


def test_replacing_work_needs_confirmation(client: TestClient):
    c = client
    p = ok(c.post("/api/projects", headers=H, json={"concept": "A lamp that remembers every prayer", "type": "short",
                                                    "agent_mode": "autopilot"}))  # auto-approve still asks before replacing work
    pid, eid = p["id"], p["episodes"][0]["id"]
    ok(c.post(f"/api/episodes/{eid}/script/generate", headers=H, json={}))
    before = ok(c.get(f"/api/episodes/{eid}"))["script"]

    ok(c.post(f"/api/projects/{pid}/agent/chat", headers=H, json={"message": "rewrite the script, darker", "episode_id": eid}))
    m = _last_assistant(c, pid)
    [item] = m["data"]["confirmations"]
    assert item["status"] == "pending" and item["tool"] == "write_script" and "Versions" in item["detail"]
    assert "Confirm below" in m["content"]
    assert ok(c.get(f"/api/episodes/{eid}"))["script"] == before  # nothing changed yet

    done = ok(c.post(f"/api/projects/{pid}/agent/messages/{m['id']}/confirm", headers=H, json={"id": item["id"], "approve": True}))
    assert done["status"] == "done" and done["result"].startswith("Script rewritten")
    assert ok(c.get(f"/api/episodes/{eid}"))["script"]["scenes"]  # (the mock writes the same text, so no new version)
    assert _last_assistant(c, pid)["content"].startswith("Script rewritten")
    twice = c.post(f"/api/projects/{pid}/agent/messages/{m['id']}/confirm", headers=H, json={"id": item["id"], "approve": True})
    assert twice.status_code == 400

    # the first shot plan replaces nothing, so it just runs; planning again asks, and "no" keeps the shots
    ok(c.post(f"/api/projects/{pid}/agent/chat", headers=H, json={"message": "plan the shots", "episode_id": eid}))
    assert not _last_assistant(c, pid)["data"].get("confirmations")
    shots = [s["id"] for s in ok(c.get(f"/api/episodes/{eid}"))["shots"] if s["include"]]
    assert shots
    ok(c.post(f"/api/projects/{pid}/agent/chat", headers=H, json={"message": "plan the shots again", "episode_id": eid}))
    m = _last_assistant(c, pid)
    [item] = m["data"]["confirmations"]
    assert item["tool"] == "breakdown_shots" and f"{len(shots)} shots" in item["detail"]
    no = ok(c.post(f"/api/projects/{pid}/agent/messages/{m['id']}/confirm", headers=H, json={"id": item["id"], "approve": False}))
    assert no["status"] == "declined"
    assert [s["id"] for s in ok(c.get(f"/api/episodes/{eid}"))["shots"] if s["include"]] == shots
