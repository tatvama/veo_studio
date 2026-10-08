"""The Director's v3 tools (mock providers): next shot, character lock, freeze look, costume, continuity state, impact,
dialogue route. Driven directly through run_tool, as the agent loop would."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.agents import tools as T
from app.db import SessionLocal
from app.models import Episode, Project, Shot, User
from conftest import H, ok, wait_jobs


def test_director_v3_tools(client: TestClient):
    c = client
    p = ok(c.post("/api/projects", headers=H, json={"concept": "A lamp that remembers", "type": "series", "languages": ["en", "kn"]}))
    pid, eid = p["id"], p["episodes"][0]["id"]
    ch = ok(c.post("/api/characters", headers=H, json={"name": "Bhairava", "dna_text": "Bhairava: 35, broad, black beard"}))
    ok(c.post(f"/api/projects/{pid}/cast/{ch['id']}", headers=H))
    s = ok(c.post(f"/api/episodes/{eid}/shots", headers=H, json={"action": "Bhairava enters the hall", "framing": "wide", "duration_s": 8}))
    ok(c.patch(f"/api/shots/{s['id']}", headers=H, json={"characters": [ch["id"]]}))
    ok(c.post(f"/api/episodes/{eid}/hooks/generate", headers=H, json={"n": 2}))
    ok(c.post(f"/api/episodes/{eid}/hooks/select", headers=H, json={"index": 0}))
    ok(c.post(f"/api/episodes/{eid}/script/generate", headers=H, json={}))
    ok(c.post(f"/api/episodes/{eid}/scenes/plan", headers=H))

    with SessionLocal() as db:
        user = db.query(User).filter(User.email == "admin@test.local").first()
        ctx = T.AgentCtx(db=db, user=user, project=db.get(Project, pid), episode=db.get(Episode, eid))
        code = db.get(Shot, s["id"]).code
        out = T.run_tool(ctx, "next_shot", {"shot_code": code, "action": "He kneels at the lamp", "mode": "extend"})
        assert out["code"] and out["shot"]["action"].startswith("He kneels")
        n = db.query(Shot).filter(Shot.episode_id == eid, Shot.code == out["code"]).first()
        assert n.continuity_from_shot_id == s["id"] and n.continuity_mode == "extend" and n.characters == [ch["id"]]
        lk = T.run_tool(ctx, "lock_character", {"character": "Bhairava", "lock": {"strictness": 0.8, "gestures": "strokes his beard", "nope": 1}})
        assert lk["lock"]["strictness"] == 0.8 and "nope" not in lk["lock"] and "strokes his beard" in lk["prompt_text"]
        v = T.run_tool(ctx, "freeze_look", {"character": "Bhairava", "label": "Season 1", "episode_to": 3})
        assert v["version"] == 1 and v["episode_to"] == 3 and v["lock"]["strictness"] == 0.8
        co = T.run_tool(ctx, "add_costume", {"character": "Bhairava", "name": "armour", "description": "bronze scale armour", "generate": True})
        assert co["costume"]["name"] == "armour" and co["jobs"]["status"] in ("proposed", "queued")
        st = T.run_tool(ctx, "continuity_state", {"scene_number": 1})
        assert "characters" in st and st["source"] == "ai"
        assert T.run_tool(ctx, "continuity_state", {"scene_number": 99}).get("error")
        wr = T.run_tool(ctx, "wardrobe_report", {})
        assert "characters" in wr
        route = T.run_tool(ctx, "set_dialogue_route", {"method": "native", "native_languages": ["en", "kn", "xx"]})
        assert route["native_languages"] == ["en", "kn"]
        assert T.run_tool(ctx, "set_dialogue_route", {"method": "telepathy"}).get("error")
        imp = T.run_tool(ctx, "impact_report", {})
        assert "counts" in imp and "plan" in imp
        assert T.run_tool(ctx, "regenerate_stale", {})["status"] == "nothing_to_do"
    wait_jobs(c, pid)
    shot = ok(c.get(f"/api/shots/{s['id']}"))
    assert shot["effective_voice_mode"] in ("none", "native")  # no lines yet; the route is set on the project brief
    proj = ok(c.get(f"/api/projects/{pid}"))
    assert proj["brief"]["dialogue_method"] == "native" and proj["brief"]["native_languages"] == ["en", "kn"]
