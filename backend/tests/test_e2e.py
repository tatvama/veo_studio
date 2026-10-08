"""End-to-end pipeline test with mock providers (no API keys, no cost).

Concept → brief → hooks → script → bible → sheets → voices → shots → keyframes → videos (+QC) → voices/lip-sync
→ music → animatic → export → dub into Kannada → export Kannada → agent chat → approvals.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from conftest import H, ok, wait_jobs


def test_full_pipeline(client):
    c = client
    st = ok(c.get("/api/auth/status"))
    assert st["user"]["role"] == "admin"
    prov = ok(c.get("/api/providers"))
    assert all(p["mode"] == "mock" for p in prov)

    p = ok(c.post("/api/projects", headers=H, json={
        "concept": "A young priest discovers the temple lamp moves by itself at night", "type": "series",
        "languages": ["en", "kn"], "primary_language": "en", "style_preset": "Devotional Glow"}))
    pid, eid = p["id"], p["episodes"][0]["id"]
    assert p["brief"].get("key_message")

    hooks = ok(c.post(f"/api/episodes/{eid}/hooks/generate", headers=H, json={"n": 5}))
    assert len(hooks) == 5
    ok(c.post(f"/api/episodes/{eid}/hooks/select", headers=H, json={"index": 0}))
    script = ok(c.post(f"/api/episodes/{eid}/script/generate", headers=H, json={}))
    assert script["scenes"]
    bible = ok(c.post(f"/api/projects/{pid}/bible/propose", headers=H, json={"episode_id": eid}))
    assert "Ravi" in bible["characters_created"]
    chars = ok(c.get(f"/api/characters?project_id={pid}"))
    ravi = next(x for x in chars if x["name"] == "Ravi")

    ok(c.post(f"/api/characters/{ravi['id']}/sheet", headers=H, json={"project_id": pid, "kinds": ["front", "three_quarter"]}))
    ok(c.post(f"/api/characters/{ravi['id']}/voices/design", headers=H, json={"language": "en", "provider": "gemini", "project_id": pid}))
    ok(c.post(f"/api/characters/{ravi['id']}/voices/design", headers=H, json={"language": "kn", "provider": "sarvam", "project_id": pid}))
    locs = ok(c.get(f"/api/locations?project_id={pid}"))
    ok(c.post(f"/api/locations/{locs[0]['id']}/images", headers=H, json={"project_id": pid, "kinds": ["wide"]}))
    jobs = wait_jobs(c, pid)
    ravi = ok(c.get(f"/api/characters/{ravi['id']}"))
    assert len(ravi["assets"]) == 2, ravi["assets"]
    assert {v["language"] for v in ravi["voices"]} == {"en", "kn"}, [(j["type"], j["status"], j["error"]) for j in jobs]

    shots = ok(c.post(f"/api/episodes/{eid}/shots/breakdown", headers=H))
    assert len(shots) >= 4
    est = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "videos"}))
    assert est["count"] == len(shots) and est["budget"]["ok"]

    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "keyframes"}))
    wait_jobs(c, pid)
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "videos"}))
    jobs = wait_jobs(c, pid)
    failed = [j for j in jobs if j["status"] == "failed"]
    assert not failed, failed[:2]
    ep = ok(c.get(f"/api/episodes/{eid}"))
    assert all(s["video"] for s in ep["shots"] if s["include"])
    assert any(s["video"]["qc"] for s in ep["shots"] if s["characters"])

    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "lipsync", "language": "en"}))
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "music"}))
    wait_jobs(c, pid)
    ep = ok(c.get(f"/api/episodes/{eid}"))
    assert ep["music"]
    talking = [s for s in ep["shots"] if s["include"] and s["dialogue"].get("en")]
    assert talking and all(s["lipsync"] for s in talking), [s["code"] for s in talking if not s["lipsync"]]

    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "animatic"}))
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "export", "preset": "draft"}))
    wait_jobs(c, pid)
    ep = ok(c.get(f"/api/episodes/{eid}"))
    ready = [x for x in ep["exports"] if x["status"] == "ready"]
    assert {x["kind"] for x in ready} == {"animatic", "final"}, ep["exports"]
    final = next(x for x in ready if x["kind"] == "final")
    assert final["duration_s"] > 5 and final["srt_url"]
    r = c.get(final["url"])
    assert r.status_code == 200 and len(r.content) > 10_000

    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "dub", "language": "kn", "preset": "draft"}))
    jobs = wait_jobs(c, pid, timeout=300)
    assert not [j for j in jobs if j["status"] == "failed"], [j["error"] for j in jobs if j["status"] == "failed"][:2]
    ep = ok(c.get(f"/api/episodes/{eid}?lang=kn"))
    assert any(s["dialogue"].get("kn") for s in ep["shots"])
    assert any(x["language"] == "kn" and x["status"] == "ready" for x in ep["exports"])

    # Agent (mock) proposes paid work; confirming the batch queues it
    msgs = ok(c.post(f"/api/projects/{pid}/agent/chat", headers=H, json={"message": "generate keyframes for E01-SH01", "episode_id": eid}))
    props = msgs[0]["data"]["proposals"]
    assert props and props[0]["status"] == "proposed"
    ok(c.post(f"/api/batches/{props[0]['batch_id']}/confirm", headers=H))
    wait_jobs(c, pid)

    # Budget: a creator with a tiny limit triggers an approval request when costs are non-zero
    ok(c.post("/api/users", headers=H, json={"email": "creator@test.local", "name": "Priya", "role": "creator",
                                             "password": "creator-pass-1", "monthly_limit_usd": 0.0}))
    summary = ok(c.get("/api/costs/summary"))
    assert "team" in summary
    act = ok(c.get(f"/api/activity?project_id={pid}"))
    assert act


def test_permissions(client):
    c = client
    r = c.post("/api/projects", json={"concept": "no header"})
    assert r.status_code == 403  # CSRF header missing
    anon = TestClient(app)  # no lifespan: must not stop the shared worker
    assert anon.get("/api/projects").status_code == 401
