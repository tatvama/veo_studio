"""Voices that fit the cast, voice-over that fits its clip, a stop to check new looks, scenes that join (mock providers).

New characters from a script had no gender, so every one of them got a male default voice; a voice-over longer than
one clip froze the picture; Produce all went straight from new faces into every shot; and a scene that picks up
straight from the one before started from a fresh frame.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.core import generation, scene_chain
from app.core.script_import import fit_lengths, guess_age, guess_gender
from app.db import SessionLocal
from app.models import Character, Job, Project, Scene, Shot, Take
from app.pipeline.selection import current
from conftest import H, ok, wait_jobs

LONG_VO = ("Every evening the old lamp was lit before the first star, and every evening the whole village gathered "
           "under it to tell the stories their grandparents told them long ago.")  # 31 words: about 13 s

SCRIPT = f"""CHARACTERS:
KAVERI – 30, his wife, green cotton saree
BHASKAR – 35, weathered farmer, grey beard

SCENE 1: INT. KITCHEN HUT - NIGHT
SHOT 1
VISUAL: Kaveri lights the lamp.
VO: {LONG_VO}
SHOT 2 (6s)
VISUAL: Bhaskar looks up.
BHASKAR: It still works.
"""


def _project(c: TestClient, **kw) -> tuple[int, int]:
    p = ok(c.post("/api/projects", headers=H, json={"concept": "The Lamp", "type": "short", "auto_brief": False,
                                                    "languages": ["en"], **kw}))
    return p["id"], p["episodes"][0]["id"]


def test_gender_and_age_from_the_script():
    assert guess_gender("Meera", "30, his wife, green cotton saree") == "female"  # "wife" decides, not "his"
    assert guess_gender("Ravi", "35, weathered farmer, grey beard") == "male"
    assert guess_gender("Ravi", "she says he is late") == ""  # one pronoun each: the script doesn't say
    assert guess_gender("Lata", "runs the shop; she never smiles") == "female"
    assert guess_gender("Ajji", "") == "female" and guess_gender("Appa", "") == "male" and guess_gender("Sam", "") == ""
    assert guess_age("35, farmer") == "35" and guess_age("70s, silver bun") == "70s"
    assert guess_age("a 45-year-old teacher") == "45" and guess_age("in her late 40s") == "late 40s"
    assert guess_age("a farmer with 10 cows") == "" and guess_age("") == ""


def test_voice_over_gets_time_to_finish():
    draft = {"scenes": [{"title": "One", "shots": [
        {"prompt": "a", "lines": [{"speaker": "VO", "text": LONG_VO}], "duration_s": 8},
        {"prompt": "b", "lines": [{"speaker": "VO", "text": "Short and sweet."}], "duration_s": 8},
        {"prompt": "c", "lines": [{"speaker": "VO", "text": LONG_VO}], "duration_s": 6, "_timed": True},
        {"prompt": "d", "lines": [{"speaker": "Ravi", "text": LONG_VO}], "duration_s": 6},
    ]}]}
    warnings = fit_lengths(draft)
    a, b, timed, said = draft["scenes"][0]["shots"]
    assert a["extend_to"] == 15 and "extend_to" not in b  # 31 words ≈ 13 s: one 8 s clip plus an extension
    assert timed["duration_s"] == 6 and timed["extend_to"] == 15 and "_timed" not in timed  # the script's length stays
    assert said["duration_s"] == 8 and "extend_to" not in said  # dialogue is lip-synced: never extended
    assert "2 voice-over line(s)" in warnings[0]


def test_import_sets_voices_lengths_and_produce_stops_to_check(client: TestClient):
    c = client
    pid, eid = _project(c)
    out = ok(c.post(f"/api/episodes/{eid}/import/parse", headers=H, data={"text": SCRIPT}))
    chars = {ch["name"]: ch for ch in out["characters"]}
    assert (chars["Kaveri"]["gender"], chars["Kaveri"]["age"]) == ("female", "30")
    assert (chars["Bhaskar"]["gender"], chars["Bhaskar"]["age"]) == ("male", "35")
    assert any("voice-over line" in w for w in out["warnings"])
    res = ok(c.post(f"/api/episodes/{eid}/import/apply", headers=H, json={"draft": out["draft"], "mapping": {}}))
    with SessionLocal() as db:
        kaveri, bhaskar = db.get(Character, res["characters"]["Kaveri"]), db.get(Character, res["characters"]["Bhaskar"])
        assert (kaveri.gender, kaveri.age) == ("female", "30") and bhaskar.gender == "male"
    b = ok(c.get(f"/api/episodes/{eid}/board"))
    s1, s2 = b["scenes"][0]["shots"]
    assert s1["extend_to"] == 15 and s2["duration_s"] == 6

    # the cost dialog: looks for both, a voice for the one who speaks on screen
    est = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "produce", "steps": ["cast", "keyframes"]}))
    with SessionLocal() as db:
        project = db.get(Project, pid)
        shots = db.query(Shot).filter(Shot.episode_id == eid).all()
        cast = generation.cast_specs(db, project, shots)
    assert [s["type"] for s in cast].count("voice_design") == 1
    assert est["items"][0]["label"] == f"Cast looks & voices · {len(cast)}"

    # it stops after the new looks and voices; carrying on makes the rest, nothing twice
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H,
              json={"action": "produce", "steps": ["cast", "keyframes"], "review_looks": True}))
    jobs = wait_jobs(c, pid, timeout=600)
    prod = next(j for j in jobs if j["type"] == "produce")
    assert prod["status"] == "succeeded" and prod["result"]["paused_after"] == "cast"
    assert not [j for j in jobs if j["type"] == "keyframe"]
    assert ok(c.get(f"/api/episodes/{eid}/board"))["produce_paused"]["after"] == "cast"
    with SessionLocal() as db:
        assert db.query(Job).filter(Job.project_id == pid, Job.type == "voice_design", Job.status == "succeeded").count() == 1
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H,
              json={"action": "produce", "steps": ["cast", "keyframes"], "review_looks": True}))
    jobs = wait_jobs(c, pid, timeout=600)
    assert [j["type"] for j in jobs if j["status"] == "succeeded"].count("keyframe") == 2
    assert ok(c.get(f"/api/episodes/{eid}/board"))["produce_paused"] is None


def test_a_scene_that_picks_up_starts_on_the_last_frame(client: TestClient):
    c = client
    pid, eid = _project(c)
    somu = ok(c.post("/api/characters", headers=H, json={"name": "Somu", "project_id": pid}))["id"]
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [
        {"title": "Porch", "location": "Somu's porch", "time_of_day": "dusk", "shots": [
            {"prompt": "Somu sits on the porch.", "duration_s": 4, "characters": [somu]},
            {"prompt": "Somu stands up.", "duration_s": 4, "characters": [somu]}]},
        {"title": "Porch later", "location": "Somu's porch", "time_of_day": "dusk", "shots": [
            {"prompt": "Somu walks to the gate.", "duration_s": 4, "characters": [somu]}]},
    ]}))
    body = {"action": "produce", "steps": ["keyframes", "videos"], "link_scenes": "auto"}
    est = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json=body))
    assert est["items"][0]["label"] == "Keyframes · 2"  # the third starts from the second's finished clip
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json=body))
    jobs = wait_jobs(c, pid, timeout=600)
    prod = next(j for j in jobs if j["type"] == "produce")
    assert prod["status"] == "succeeded", prod["error"]
    assert prod["result"]["jobs"]["scene_links"] == 1
    with SessionLocal() as db:
        scenes = db.query(Scene).filter(Scene.episode_id == eid).order_by(Scene.order).all()
        last = scene_chain.scene_shots(db, scenes[0])[-1]
        first = scene_chain.scene_shots(db, scenes[1])[0]
        assert first.continuity_from_shot_id == last.id
        kfs = db.query(Take).filter(Take.shot_id == first.id, Take.kind == "keyframe").all()
        assert len(kfs) == 1  # made once, from the finished clip before it
        assert (kfs[0].params or {}).get("continuity_take_id") == current(db, last.id, "video").id
        assert scene_chain.link_status(db, first)["status"] == "ok"
