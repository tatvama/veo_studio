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


def test_critic_keeps_the_users_script(client: TestClient):
    """The critic pass rewrites a script the AI wrote, but only scores an imported one (its shots follow its words)."""
    from app import settings_store
    from app.core import studio
    from app.models import Episode
    from test_board import MARKED

    c = client
    with SessionLocal() as db:
        settings_store.set_setting(db, "critic_min_score", 11)  # no script passes: the loop always wants a rewrite
        db.commit()
    try:
        def run(eid: int, pid: int) -> dict:
            ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "autopilot", "through": "script"}))
            wait_jobs(c, pid)
            return ok(c.get(f"/api/episodes/{eid}"))

        p = ok(c.post("/api/projects", headers=H, json={"concept": "A kite that refuses to land", "type": "short", "languages": ["en"]}))
        ep = run(p["episodes"][0]["id"], p["id"])
        assert len(ep["critic"]["history"]) == 2  # scored, rewritten, scored again

        p = ok(c.post("/api/projects", headers=H, json={"concept": "Imported", "type": "ad", "auto_brief": False, "languages": ["en"]}))
        pid, eid = p["id"], p["episodes"][0]["id"]
        parsed = ok(c.post(f"/api/episodes/{eid}/import/parse", headers=H, data={"text": MARKED}))
        ok(c.post(f"/api/episodes/{eid}/import/apply", headers=H, json={"draft": parsed["draft"], "mapping": {}, "create_missing": True}))
        before = ok(c.get(f"/api/episodes/{eid}"))["script"]
        ep = run(eid, pid)
        assert len(ep["critic"]["history"]) == 1 and ep["critic"]["overall"]  # scored once, never rewritten
        assert ep["script"] == before
        ap = ok(c.get(f"/api/projects/{pid}"))["autopilot"]
        assert ap["status"] == "finished" and any("kept your script" in l for l in ap["log"])

        with SessionLocal() as db:  # a typed script with no shots yet is the user's too
            e = db.get(Episode, eid)
            proj = db.get(Project, pid)
            assert studio.users_script_reason(db, proj, e) == "shots are already made from it"
            proj.workflow = "script"
            assert studio.users_script_reason(db, proj, e) == "your own script"
            db.rollback()
    finally:
        with SessionLocal() as db:
            settings_store.set_setting(db, "critic_min_score", 7.5)
            db.commit()
