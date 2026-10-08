"""Autopilot: milestones, approval stops with Continue, honest status when a run ends badly."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Job, Project
from conftest import H, ok, wait_jobs


def test_milestones_pause_and_continue(client: TestClient):
    c = client
    settings = ok(c.get("/api/settings"))
    assert [m["id"] for m in settings["catalog"]["autopilot"]["milestones"]] == ["script", "cast", "storyboard", "final"]

    p = ok(c.post("/api/projects", headers=H, json={"concept": "A lamp that remembers every prayer", "type": "short", "languages": ["en"]}))
    pid, eid = p["id"], p["episodes"][0]["id"]
    est = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "autopilot", "through": "cast", "pause_after": ["script"]}))
    assert est["items"][0]["label"] == "Autopilot → Cast & scenes"
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "autopilot", "through": "cast", "pause_after": ["script"]}))
    wait_jobs(c, pid)

    proj = ok(c.get(f"/api/projects/{pid}"))
    ap = proj["autopilot"]
    assert ap["status"] == "paused" and ap["paused_after"] == "script" and ap["through"] == "cast"
    ep = ok(c.get(f"/api/episodes/{eid}"))
    assert ep["script"]["scenes"] and not ep.get("scenes")  # stopped before the cast milestone
    totals = [h["total"] for h in ep["hooks"]]
    assert ep["selected_hook"] == totals.index(max(totals))  # the best hook, not simply the first

    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "autopilot", "resume": True}))
    wait_jobs(c, pid)
    ap = ok(c.get(f"/api/projects/{pid}"))["autopilot"]
    assert ap["status"] == "finished" and ap["stage"] == "voices"
    assert any("picked the highest-scoring hook" in l for l in ap["log"])  # the log carries over across Continue
    assert ok(c.get(f"/api/characters?project_id={pid}"))  # the cast was built
    again = c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "autopilot", "resume": True})
    assert again.status_code == 400


def test_dead_run_is_not_shown_as_running(client: TestClient):
    c = client
    p = ok(c.post("/api/projects", headers=H, json={"concept": "Status check", "type": "short", "auto_brief": False}))
    with SessionLocal() as db:
        j = Job(type="autopilot", status="failed", project_id=p["id"], error="Autopilot stopped: spent $9, above the guard")
        db.add(j)
        db.flush()
        db.get(Project, p["id"]).autopilot = {"job_id": j.id, "stage": "videos", "status": "running"}
        db.commit()
    ap = ok(c.get(f"/api/projects/{p['id']}"))["autopilot"]
    assert ap["status"] == "failed" and "guard" in ap["error"]
