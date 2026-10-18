"""The Shots canvas endpoints: step states per shot, failures nothing replaced yet, scene music and scene notes."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import AudioAsset, Job
from conftest import H, ok


def _film(c: TestClient) -> tuple[int, int, dict]:
    p = ok(c.post("/api/projects", headers=H, json={"concept": "Canvas film", "type": "short", "auto_brief": False,
                                                    "languages": ["en"]}))
    pid, eid = p["id"], p["episodes"][0]["id"]
    ravi = ok(c.post("/api/characters", headers=H, json={"name": "Ravi", "project_id": pid}))["id"]
    board = ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [
        {"title": "Kitchen", "location": "Kitchen", "time_of_day": "morning", "summary": "", "mood": "warm",
         "shots": [{"prompt": "Ravi opens the jar", "characters": [ravi], "duration_s": 8,
                    "lines": [{"speaker": ravi, "text": "Fifty years old.", "emotion": "proud"}]},
                   {"prompt": "Steam rises", "duration_s": 6, "lines": [{"speaker": "VO", "text": "Some flavours stay."}]}]},
        {"title": "Garden", "location": "Garden", "time_of_day": "day", "summary": "",
         "shots": [{"prompt": "Mango trees sway", "duration_s": 4, "sfx": "birdsong"}]},
    ]}))
    return pid, eid, board


def test_canvas_steps_failures_and_music(client: TestClient):
    c = client
    pid, eid, board = _film(c)
    kitchen, garden = board["scenes"]
    talk, vo = kitchen["shots"]
    quiet = garden["shots"][0]

    out = ok(c.get(f"/api/episodes/{eid}/canvas", headers=H))
    assert out["episode_id"] == eid and out["language"] == "en"
    shots = {int(k): v for k, v in out["shots"].items()}
    assert set(shots) == {talk["id"], vo["id"], quiet["id"]}
    assert shots[vo["id"]]["voice"] == "need" and shots[vo["id"]]["mouth"] == "none"  # voice-over: heard, no lips
    assert shots[talk["id"]]["voice"] in ("need", "optional") and shots[talk["id"]]["mouth"] in ("need", "optional")
    assert shots[quiet["id"]]["voice"] == "none" and shots[quiet["id"]]["mouth"] == "none"
    assert out["sound_engine"] is True and shots[quiet["id"]]["sound"] == "need"  # mock providers make sound effects
    assert all(not v["problems"] for v in shots.values()) and out["scene_music"] == {}

    # a failed keyframe shows with its reason, until a newer run of that step replaces it
    with SessionLocal() as db:
        db.add(Job(type="keyframe", status="failed", project_id=pid, episode_id=eid, shot_id=talk["id"],
                   error="Safety filter: try another wording", label="Keyframe"))
        db.add(Job(type="video", status="failed", project_id=pid, episode_id=eid, shot_id=vo["id"], error="", label="Video"))
        db.add(AudioAsset(project_id=pid, episode_id=eid, kind="music_scene", prompt="warm strings", path="",
                          duration_s=14.0, params={"scene_id": kitchen["id"]}))
        db.commit()
    out = ok(c.get(f"/api/episodes/{eid}/canvas", headers=H))
    probs = {int(k): v["problems"] for k, v in out["shots"].items()}
    assert probs[talk["id"]]["picture"]["error"] == "Safety filter: try another wording"
    assert probs[talk["id"]]["picture"]["job_id"] > 0
    assert probs[vo["id"]]["video"]["error"]  # an empty error still says something
    assert not probs[quiet["id"]]
    music = {int(k): v for k, v in out["scene_music"].items()}
    assert set(music) == {kitchen["id"]} and music[kitchen["id"]]["duration_s"] == 14.0

    with SessionLocal() as db:
        db.add(Job(type="keyframe", status="succeeded", project_id=pid, episode_id=eid, shot_id=talk["id"], label="Keyframe"))
        db.commit()
    out = ok(c.get(f"/api/episodes/{eid}/canvas", headers=H))
    assert "picture" not in out["shots"][str(talk["id"])]["problems"]  # replaced by the newer run
    assert "video" in out["shots"][str(vo["id"])]["problems"]

    assert c.get("/api/episodes/999999/canvas", headers=H).status_code == 404


def test_scene_notes(client: TestClient):
    c = client
    _, eid, board = _film(c)
    sid = board["scenes"][1]["id"]
    out = ok(c.patch(f"/api/scenes/{sid}/notes", headers=H, json={"mood": "  calm ", "look": "golden hour", "music": "flute"}))
    assert out == {"id": sid, "mood": "calm", "look": "golden hour", "sound": "", "music": "flute"}
    after = ok(c.get(f"/api/episodes/{eid}/board", headers=H))
    sc = after["scenes"][1]
    assert (sc["mood"], sc["look"], sc["sound"], sc["music"]) == ("calm", "golden hour", "", "flute")
    assert after["version"] != board["version"]  # the shot list sees the change
    # left out = unchanged
    ok(c.patch(f"/api/scenes/{sid}/notes", headers=H, json={"sound": "wind"}))
    sc = ok(c.get(f"/api/episodes/{eid}/board", headers=H))["scenes"][1]
    assert (sc["mood"], sc["sound"], sc["music"]) == ("calm", "wind", "flute")
    assert c.patch("/api/scenes/999999/notes", headers=H, json={"mood": "x"}).status_code == 404
