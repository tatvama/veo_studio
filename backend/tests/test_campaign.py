"""Ads & Reels (mock providers): a 2 languages × 2 aspects campaign with a locked brand kit, a cut-down duration,
the stored state + export rows, and the Reels highlight proposals."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Episode, Export
from conftest import H, ok, wait_jobs


def _episode_with_shots(c: TestClient) -> tuple[int, int, int]:
    p = ok(c.post("/api/projects", headers=H, json={"concept": "A temple lamp that moves by itself", "type": "short",
                                                    "languages": ["en"], "primary_language": "en"}))
    pid, eid = p["id"], p["episodes"][0]["id"]
    ch = ok(c.post("/api/characters", headers=H, json={"name": "Ravi", "dna_text": "Ravi: 28, lean, cream kurta"}))
    ok(c.post(f"/api/projects/{pid}/cast/{ch['id']}", headers=H))
    lines = ["The lamp moved again last night.", "Nobody believes me, but I saw it.", "Tonight I will stay awake.", "", "Come with me."]
    for i, line in enumerate(lines):
        s = ok(c.post(f"/api/episodes/{eid}/shots", headers=H, json={"action": f"Shot {i + 1}: Ravi near the lamp", "framing": "medium shot",
                                                                      "duration_s": 8 if i % 2 == 0 else 6}))
        patch = {"characters": [ch["id"]]}
        if line:
            patch["dialogue"] = {"en": [{"character_id": ch["id"], "line": line, "emotion": "quietly"}]}
        else:
            patch["narration"] = {"en": "The lamp flickers in the empty hall."}
        ok(c.patch(f"/api/shots/{s['id']}", headers=H, json=patch))
    return pid, eid, ch["id"]


def test_campaign_variants_and_brand_facts(client: TestClient):
    c = client
    pid, eid, _ = _episode_with_shots(c)
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "keyframes"}))
    wait_jobs(c, pid)
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "videos"}))
    jobs = wait_jobs(c, pid)
    assert not [j for j in jobs if j["status"] == "failed"], [(j["label"], j["error"]) for j in jobs if j["status"] == "failed"][:3]
    ep = ok(c.get(f"/api/episodes/{eid}"))
    shots = [s for s in ep["shots"] if s["include"]]
    ok(c.post(f"/api/shots/{shots[0]['id']}/approve", headers=H, json={"approved": True}))
    ok(c.post(f"/api/shots/{shots[1]['id']}/approve", headers=H, json={"approved": True}))

    kit = ok(c.post("/api/brand-kits", headers=H, json={"name": "Temple Tales", "colors": ["#1a0f05", "#F97316"], "tagline": "Stories that glow",
                                                        "cta": "Follow for Part 2", "end_card": {"enabled": True, "seconds": 2}}))

    # nothing yet
    assert ok(c.get(f"/api/episodes/{eid}/campaign"))["status"] == "none"

    # estimate: a dub for Kannada, a 10 s cut-down, 2 × 2 full-length exports + 2 × 2 cut exports; 90 s is longer than the episode → skipped
    body = {"languages": ["kn"], "aspects": ["9:16", "16:9"], "durations": [10, 90], "brand_kit_id": kit["id"], "cta": "Watch Part 2 now",
            "captions": True, "brief": {"product": "Temple Tales season 1", "audience": "families", "tone": "warm"}}
    est = ok(c.post(f"/api/episodes/{eid}/campaign/estimate", headers=H, json=body))
    kinds = [i["kind"] for i in est["items"]]
    assert kinds.count("dub") == 1 and kinds.count("cutdown") == 1 and kinds.count("export") == 8, est["items"]
    assert est["languages"] == ["en", "kn"] and est["durations"] == [10] and est["skipped_durations"] == [90]
    assert len(est["variants"]) == 8 and est["budget"]["ok"] and est["total_usd"] == 0  # mock providers are free
    assert c.post(f"/api/episodes/{eid}/campaign/estimate", headers=H, json={**body, "aspects": ["4:3"]}).status_code == 400

    r = ok(c.post(f"/api/episodes/{eid}/campaign", headers=H, json=body))
    assert r["status"] == "queued" and r["jobs"][0]["type"] == "campaign"
    assert c.post(f"/api/episodes/{eid}/campaign", headers=H, json=body).status_code == 409  # one at a time
    jobs = wait_jobs(c, pid)
    failed = [j for j in jobs if j["status"] == "failed"]
    assert not failed, [(j["label"], j["error"]) for j in failed][:3]
    assert next(j for j in jobs if j["type"] == "campaign")["status"] == "succeeded"
    assert [j for j in jobs if j["type"] == "dub"] and [j for j in jobs if j["type"] == "export"]

    st = ok(c.get(f"/api/episodes/{eid}/campaign"))
    assert st["status"] == "done" and st["failed"] == 0 and st["started_at"] and st["finished_at"]
    assert st["progress"] == {"done": 8, "failed": 0, "total": 8}
    facts = st["brand_facts"]
    assert facts["brand_kit_id"] == kit["id"] and facts["cta"] == "Watch Part 2 now" and facts["tagline"] == "Stories that glow"
    assert facts["colors"] == ["#1a0f05", "#F97316"] and facts["locked_at"]
    assert st["brief"]["product"] == "Temple Tales season 1"
    grid = {(v["language"], v["aspect"], v["cut"]) for v in st["variants"]}
    assert grid == {(l, a, cut) for l in ("en", "kn") for a in ("9:16", "16:9") for cut in (False, True)}
    for v in st["variants"]:
        assert v["status"] == "ready" and v["export"] and v["export"]["status"] == "ready", v
        assert v["export"]["url"] and v["export"]["preset"] == {"9:16": "shorts", "16:9": "youtube"}[v["aspect"]]
        assert v["export"]["language"] == v["language"]
        assert c.get(v["export"]["url"]).status_code == 200
    cut_ids = {v["export"]["episode_id"] for v in st["variants"] if v["cut"]}
    assert len(cut_ids) == 1 and cut_ids != {eid} and st["cuts"] == {"10": next(iter(cut_ids))}
    assert {v["export"]["episode_id"] for v in st["variants"] if not v["cut"]} == {eid}

    # stored on the episode; the exports carry the locked CTA; the project now speaks Kannada and uses the kit
    with SessionLocal() as db:
        e = db.get(Episode, eid)
        assert e.settings["campaign"]["status"] == "done" and e.settings["campaign"]["brand_facts"]["cta"] == "Watch Part 2 now"
        x = db.get(Export, st["variants"][0]["export_id"])
        assert x.options["cta"] == "Watch Part 2 now" and x.options["brand_kit_id"] == kit["id"] and x.options["auto_reframe"] is True
        cut = db.get(Episode, next(iter(cut_ids)))
        assert cut.kind == "cutdown" and cut.settings["campaign_of"] == eid
    proj = ok(c.get(f"/api/projects/{pid}"))
    assert "kn" in proj["languages"] and proj["brand_kit_id"] == kit["id"]
    kn = ok(c.get(f"/api/episodes/{eid}?lang=kn"))
    assert all(s["dialogue"].get("kn") for s in kn["shots"] if s["dialogue"].get("en"))

    # a second run: Kannada is already dubbed, so the estimate has no dub line unless asked to redub
    est2 = ok(c.post(f"/api/episodes/{eid}/campaign/estimate", headers=H, json={**body, "durations": []}))
    assert "dub" not in [i["kind"] for i in est2["items"]] and len(est2["variants"]) == 4
    est3 = ok(c.post(f"/api/episodes/{eid}/campaign/estimate", headers=H, json={**body, "durations": [], "redub": True}))
    assert [i["kind"] for i in est3["items"]].count("dub") == 1


def test_highlights(client: TestClient):
    c = client
    pid, eid, _ = _episode_with_shots(c)
    assert ok(c.get(f"/api/episodes/{eid}/highlights"))["highlights"]  # works before anything is generated
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "keyframes"}))
    wait_jobs(c, pid)
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "videos"}))
    wait_jobs(c, pid)
    ep = ok(c.get(f"/api/episodes/{eid}"))
    shots = [s for s in ep["shots"] if s["include"]]
    for s in shots[:2]:
        ok(c.post(f"/api/shots/{s['id']}/approve", headers=H, json={"approved": True}))
    res = ok(c.get(f"/api/episodes/{eid}/highlights"))
    hs = res["highlights"]
    assert res["total_s"] == sum(s["duration_s"] for s in shots) and 1 <= len(hs) <= 5
    first = hs[0]
    assert first["start_s"] == 0 and "hook" in first["reasons"] and first["shot_codes"][0] == shots[0]["code"]
    assert first["end_s"] > first["start_s"] and first["seconds"] >= 6 and first["reason"]
    codes = {s["code"] for s in shots}
    for h in hs:
        assert set(h["shot_codes"]) <= codes and h["start_s"] < h["end_s"]
    # windows never overlap
    spans = sorted((h["start_s"], h["end_s"]) for h in hs)
    assert all(a[1] <= b[0] for a, b in zip(spans, spans[1:]))
    # "Cut this" is the existing cut-downs endpoint with the window's length
    r = ok(c.post(f"/api/episodes/{eid}/cutdowns", headers=H, json={"count": 1, "seconds": first["seconds"]}))
    assert len(r["episode_ids"]) == 1
    # empty episode → no highlights
    p2 = ok(c.post("/api/projects", headers=H, json={"concept": "Nothing yet", "type": "short", "languages": ["en"]}))
    assert ok(c.get(f"/api/episodes/{p2['episodes'][0]['id']}/highlights"))["highlights"] == []
