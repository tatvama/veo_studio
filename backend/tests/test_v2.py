"""v2 features end-to-end (mock providers): Model Hub + router + fallbacks + shootout, audio-driven dialogue,
character identity (LoRA), writers' room (critic loop, scene cards, versions, continuity, table read), growth (marketing,
SFX, brand kit end card, overlays, karaoke captions, search), client review links, audit, prefs, catalog sync."""
from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.core import model_hub
from app.db import SessionLocal
from app.main import app
from app.models import AIModel
from app.providers import fal as fal_api
from app.providers.schema_map import build_param_map, derive_capabilities
from conftest import FIXTURES, H, ok, wait_jobs

FIX = json.loads((FIXTURES / "fal_models.json").read_text(encoding="utf-8"))


def seed_fal_models(status: str = "enabled") -> None:
    with SessionLocal() as db:
        for m in FIX["models"]:
            md = m["metadata"]
            pm = build_param_map(m["openapi"])
            caps = derive_capabilities(md["category"], m["endpoint_id"], pm)
            row = db.get(AIModel, f"fal:{m['endpoint_id']}") or AIModel(id=f"fal:{m['endpoint_id']}", provider="fal",
                                                                         endpoint=m["endpoint_id"])
            row.display_name, row.category, row.task = md["display_name"], md["category"], caps["task"]
            row.param_map, row.capabilities, row.status = pm, caps, status
            row.price_usd, row.price_unit, row.price_source = 0.1, "second", "manual"
            db.merge(row)
        db.commit()


def test_catalog_sync(client, monkeypatch):
    monkeypatch.setattr(fal_api, "list_models", lambda **kw: [{"endpoint_id": m["endpoint_id"], "metadata": m["metadata"]}
                                                              for m in FIX["models"]])
    monkeypatch.setattr(fal_api, "get_openapi", lambda ids, key="": {m["endpoint_id"]: m["openapi"] for m in FIX["models"]
                                                                     if m["endpoint_id"] in ids})
    monkeypatch.setattr(fal_api, "get_pricing", lambda ids, key: {})
    summary = model_hub.sync_catalog()
    assert summary["total"] == len(FIX["models"]) and summary["schemas_mapped"] == len(FIX["models"])
    with SessionLocal() as db:
        kling = db.get(AIModel, "fal:fal-ai/kling-video/v3/pro/image-to-video")
        assert kling.status == "enabled" and kling.task == "video"  # in the default policy → auto-enabled
        assert "i2v" in kling.capabilities["modes"]
        other = db.get(AIModel, "fal:fal-ai/kling-video/ai-avatar/v2/pro")
        assert other.status in ("enabled", "new")


def test_v2_pipeline(client: TestClient):
    c = client
    seed_fal_models()
    hub = ok(c.get("/api/models?task=video"))
    assert any(m["id"] == "google:video_balanced" for m in hub["models"])
    assert any(m["id"].startswith("fal:") for m in hub["models"])
    pol = ok(c.get("/api/models/policy"))
    assert "dialogue" in pol["chains"] and pol["chains"]["video.saver"][0] == "google:video_saver"

    p = ok(c.post("/api/projects", headers=H, json={"concept": "A temple lamp that moves by itself", "type": "series",
                                                    "languages": ["en", "kn"], "quality_mode": "balanced"}))
    pid, eid = p["id"], p["episodes"][0]["id"]
    ok(c.post(f"/api/episodes/{eid}/hooks/generate", headers=H, json={"n": 4}))
    ok(c.post(f"/api/episodes/{eid}/hooks/select", headers=H, json={"index": 0}))
    ok(c.post(f"/api/episodes/{eid}/script/generate", headers=H, json={}))

    # writers' room: critic loop rewrites until the bar, versions are kept
    ok(c.post(f"/api/episodes/{eid}/critic", headers=H, json={"rounds": 2}))
    wait_jobs(c, pid)
    ep = ok(c.get(f"/api/episodes/{eid}"))
    assert ep["critic"]["overall"] >= 7.5 and len(ep["critic"]["history"]) >= 2
    versions = ok(c.get(f"/api/episodes/{eid}/script/versions"))
    assert versions and versions[0]["critic"].get("overall")
    ok(c.patch(f"/api/episodes/{eid}", headers=H, json={"script": {**ep["script"], "logline": "Edited by hand"}}))
    versions = ok(c.get(f"/api/episodes/{eid}/script/versions"))
    assert len(versions) >= 2 and versions[0]["source"] == "manual"
    ok(c.post(f"/api/episodes/{eid}/script/versions/{versions[-1]['id']}/restore", headers=H))
    assert ok(c.get(f"/api/episodes/{eid}"))["script"]["logline"] != "Edited by hand"

    scenes = ok(c.post(f"/api/episodes/{eid}/scenes/plan", headers=H))
    assert scenes and scenes[0]["goal"] and scenes[0]["coverage"]
    ok(c.patch(f"/api/scenes/{scenes[0]['id']}", headers=H, json={"approved": True, "props": ["brass lamp", "bell"]}))

    ok(c.post(f"/api/projects/{pid}/bible/propose", headers=H, json={"episode_id": eid}))
    chars = ok(c.get(f"/api/characters?project_id={pid}"))
    ravi = next(x for x in chars if x["name"] == "Ravi")
    ok(c.post(f"/api/characters/{ravi['id']}/sheet", headers=H, json={"project_id": pid, "kinds": ["front"]}))
    wait_jobs(c, pid)
    ok(c.post(f"/api/characters/{ravi['id']}/train", headers=H, json={"project_id": pid}))
    wait_jobs(c, pid)
    ravi = ok(c.get(f"/api/characters/{ravi['id']}"))
    assert ravi["identity"]["status"] == "ready", ravi["identity"]
    assert any(a["kind"] == "training" for a in ravi["assets"]) and any(a["kind"] == "identity_test" for a in ravi["assets"])

    shots = ok(c.post(f"/api/episodes/{eid}/shots/breakdown", headers=H))
    assert any("[CONTINUITY]" in ok(c.get(f"/api/shots/{s['id']}/prompt"))["video_prompt"] for s in shots)
    rep = ok(c.post(f"/api/episodes/{eid}/continuity", headers=H))
    assert "issues" in rep

    # LoRA keyframe for a single-character shot
    solo = next(s for s in shots if s["characters"] == [ravi["id"]])
    ok(c.post(f"/api/shots/{solo['id']}/keyframe", headers=H, json={}))
    wait_jobs(c, pid)
    kf = ok(c.get(f"/api/shots/{solo['id']}"))["keyframe"]
    assert kf["params"]["engine"].startswith("lora:"), kf["params"]

    # audio-driven dialogue: talking shots come straight from the voice audio
    ok(c.patch("/api/settings", headers=H, json={"dialogue_method": "audio_driven", "caption_style": "karaoke"}))
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "keyframes", "only_missing": True}))
    wait_jobs(c, pid)
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "videos"}))
    jobs = wait_jobs(c, pid)
    assert not [j for j in jobs if j["status"] == "failed"], [(j["label"], j["error"]) for j in jobs if j["status"] == "failed"][:3]
    ep = ok(c.get(f"/api/episodes/{eid}"))
    talking = [s for s in ep["shots"] if s["include"] and s["dialogue"].get("en")]
    silent = [s for s in ep["shots"] if s["include"] and not s["dialogue"].get("en")]
    assert talking and all(s["video"]["params"]["audio_driven"] for s in talking), [s["video"]["params"] for s in talking]
    assert all(s["lipsync"] for s in talking)
    assert all(s["video"]["params"]["engine"] == "minimax/h3-max/lip-sync/image-to-video" or
               s["video"]["params"]["engine"].startswith("fal:") for s in talking)
    assert silent and silent[0]["video"]["params"]["engine"] == "google:video_balanced"
    assert any(s["lipsync"]["qc"].get("lipsync") for s in talking if s["lipsync"]["qc"])

    # per-shot engine + shootout + winner
    engines = ok(c.get(f"/api/shots/{silent[0]['id']}/engines"))["engines"]
    fal_ids = [e["id"] for e in engines if e["id"].startswith("fal:")]
    assert len(fal_ids) >= 2
    ok(c.post(f"/api/shots/{silent[0]['id']}/shootout", headers=H, json={"engines": fal_ids[:2]}))
    wait_jobs(c, pid)
    takes = ok(c.get(f"/api/shots/{silent[0]['id']}"))["takes"]
    shoot = [t for t in takes if t["kind"] == "video" and t["params"].get("shootout")]
    assert len(shoot) == 2 and {t["params"]["engine"] for t in shoot} == set(fal_ids[:2])
    ok(c.post(f"/api/takes/{shoot[1]['id']}/winner", headers=H))
    with SessionLocal() as db:
        assert db.get(AIModel, shoot[1]["params"]["engine"]).wins >= 1
    ok(c.patch(f"/api/shots/{silent[0]['id']}", headers=H, json={"engine": fal_ids[0]}))
    ok(c.post(f"/api/shots/{silent[0]['id']}/video", headers=H, json={}))
    wait_jobs(c, pid)
    assert ok(c.get(f"/api/shots/{silent[0]['id']}"))["video"]["params"]["engine"] == fal_ids[0]

    # lip-sync through the hub (re-dub), table read, sound design, marketing
    ok(c.patch("/api/settings", headers=H, json={"dialogue_method": "audio_first"}))
    ok(c.post(f"/api/shots/{talking[0]['id']}/lipsync", headers=H, json={"language": "en"}))
    ok(c.post(f"/api/episodes/{eid}/table-read", headers=H, json={"language": "en"}))
    ok(c.post(f"/api/episodes/{eid}/sfx", headers=H, json={}))
    ok(c.post(f"/api/episodes/{eid}/marketing", headers=H, json={"platforms": ["youtube_shorts"], "languages": ["en", "kn"]}))
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "music"}))
    jobs = wait_jobs(c, pid)
    assert not [j for j in jobs if j["status"] == "failed"], [(j["label"], j["error"]) for j in jobs if j["status"] == "failed"][:3]
    tr = ok(c.get(f"/api/episodes/{eid}/table-read"))
    assert tr["en"]["lines"] and tr["en"]["url"]
    assert c.get(tr["en"]["url"]).status_code == 200
    mk = ok(c.get(f"/api/episodes/{eid}/marketing"))
    assert mk["copies"] and mk["thumbnail_files"]
    ep = ok(c.get(f"/api/episodes/{eid}"))
    assert any(s["sfx_track"] for s in ep["shots"])
    redub = ok(c.get(f"/api/shots/{talking[0]['id']}"))["lipsync"]
    assert redub["params"]["method"] in ("redub", "audio_driven")

    # brand kit end card + overlays + karaoke captions in the final render
    kit = ok(c.post("/api/brand-kits", headers=H, json={"name": "Temple Tales", "colors": ["#1a0f05", "#F97316"],
                                                        "tagline": "Stories that glow", "cta": "Follow for Part 2",
                                                        "end_card": {"enabled": True, "seconds": 2}}))
    ok(c.patch(f"/api/projects/{pid}", headers=H, json={"brand_kit_id": kit["id"]}))
    ok(c.put(f"/api/shots/{ep['shots'][0]['id']}/overlays", headers=H,
             json={"overlays": [{"text": "Episode 1 — The Lamp", "start": 0.3, "end": 2.5, "kind": "title"}]}))
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "export", "preset": "draft"}))
    wait_jobs(c, pid)
    ep = ok(c.get(f"/api/episodes/{eid}"))
    final = next(x for x in ep["exports"] if x["kind"] == "final" and x["status"] == "ready")
    assert final["duration_s"] > 5 and final["peaks"]
    # the last frame must be the brand end card (dark brand colour)
    from PIL import Image
    from app.pipeline import ffmpeg as ff
    from app.storage import get_storage
    frame = ff.extract_frame(get_storage().abs(final["url"].removeprefix("/media/")), get_storage().tmp_dir() / "last.png", "last")
    r, g, b = Image.open(frame).convert("RGB").resize((1, 1)).getpixel((0, 0))
    assert r < 90 and g < 60 and b < 40, (r, g, b)

    # client review link (no login): watch + timecoded comment with a drawing
    link = ok(c.post(f"/api/exports/{final['id']}/review-links", headers=H, json={"label": "Client cut"}))
    token = link["token"]
    anon = TestClient(app)
    info = ok(anon.get(f"/api/review/{token}"))
    assert info["project"] and anon.get(info["video_url"]).status_code == 200
    ok(anon.post(f"/api/review/{token}/comments", json={"guest_name": "Client", "body": "Make the title bigger",
                                                        "timecode": 1.2, "drawing": [{"color": "#f00", "points": [[0.1, 0.1], [0.3, 0.2]]}]}))
    assert ok(anon.get(f"/api/review/{token}/comments"))[0]["timecode"] == 1.2

    # semantic search, audit log, prefs, trends
    ok(c.post(f"/api/projects/{pid}/search/index", headers=H))
    wait_jobs(c, pid)
    res = ok(c.post("/api/search", headers=H, json={"q": "Ravi lamp", "project_id": pid}))
    assert res["results"]
    assert any(a["action"] == "settings.update" for a in ok(c.get("/api/audit")))
    assert ok(c.patch("/api/me/prefs", headers=H, json={"ui_language": "kn", "onboarding_done": True}))["ui_language"] == "kn"
    assert ok(c.post(f"/api/projects/{pid}/trends", headers=H))["hook_patterns"]


def test_models_paging_and_sort(client: TestClient):
    seed_fal_models()
    full = ok(client.get("/api/models?limit=1000"))
    assert full["total"] == len(full["models"]) >= 20
    page = ok(client.get("/api/models?limit=5&offset=3&sort=name"))
    assert page["total"] == full["total"] and page["offset"] == 3 and len(page["models"]) == 5
    names = [m["display_name"] for m in ok(client.get("/api/models?limit=1000&sort=name"))["models"] if not m["builtin"]]
    assert names == sorted(names)
    assert client.get("/api/models?sort=bogus").status_code == 400
    video = ok(client.get("/api/models?task=video&mode=i2v&limit=1000"))
    assert video["total"] == len(video["models"]) and all("i2v" in m["capabilities"]["modes"] for m in video["models"])
