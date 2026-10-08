"""Shot-by-shot builder: project workflow, per-shot video model, and what each model can use from a shot."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.api.hub import video_fit
from conftest import H, ok


def test_video_fit():
    assert video_fit({"modes": ["t2v", "i2v", "ref2v"], "max_refs": 3})["characters"] == "refs"
    assert video_fit({"modes": ["t2v", "i2v", "flf"], "max_refs": 0})["characters"] == "keyframe"
    f = video_fit({"modes": ["t2v"]})
    assert f["characters"] == "none" and f["location"] == "none" and not f["start_frame"]


def test_shot_project_and_engine_per_shot(client: TestClient):
    c = client
    p = ok(c.post("/api/projects", headers=H, json={"concept": "Shot-by-shot project", "type": "ad", "auto_brief": False,
                                                    "languages": ["en"], "workflow": "shots"}))
    assert p["workflow"] == "shots"
    eid = p["episodes"][0]["id"]
    eng = ok(c.get("/api/engines/video"))
    assert eng["engines"] and all("fit" in e for e in eng["engines"])
    veo = next(e for e in eng["engines"] if e["id"] == "google:video_balanced")
    assert veo["fit"]["characters"] == "refs" and veo["fit"]["max_refs"] == 3
    b = ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [
        {"title": "One", "shots": [{"prompt": "A bus stop at night.", "duration_s": 8, "engine": "google:video_balanced"},
                                    {"prompt": "Close on the timetable.", "duration_s": 4}]}]}))
    shots = b["scenes"][0]["shots"]
    assert [s["engine"] for s in shots] == ["google:video_balanced", "auto"]
    r = c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [
        {"title": "One", "shots": [{"prompt": "x", "duration_s": 8, "engine": "nope:model"}]}]})
    assert r.status_code == 400
    assert c.patch(f"/api/projects/{p['id']}", headers=H, json={"workflow": "bogus"}).status_code == 400
