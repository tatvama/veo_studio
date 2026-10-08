"""Tatvam v3 (mock providers): @mentions, import wizard apply, change impact, Film Map shot links and next shot,
Character Lock / versions / costumes / props, outfit turnarounds + lighting variants, the Google dialogue route
(native Veo speech per language, native dubbing, words QC), Continuity Bible, wardrobe timeline, dashboards, seasons."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.core import lock as lock_core, mentions
from app.db import SessionLocal
from app.models import Character, CharacterAsset, Project, Shot, Take
from app.pipeline import voice as voice_mod
from conftest import H, ok, wait_jobs

MARKED_SCRIPT = """SCENE 1 - INT. TEMPLE COURTYARD - DUSK
VISUAL: Rows of brass lamps on worn stone, a gopuram silhouette far away.
RAVI: I saw him again last night.
MEERA: Then it was not a dream.
SCENE 2 - EXT. FOREST PATH - NIGHT
VISUAL: Ravi walks alone under tall trees, lamp in hand.
VO: The forest had kept its silence for a hundred years.
RAVI: Who is there?
"""


def _project(c: TestClient, **extra) -> tuple[int, int]:
    p = ok(c.post("/api/projects", headers=H, json={"concept": "A temple lamp that moves by itself", "type": "series",
                                                    "languages": ["en", "kn"], **extra}))
    return p["id"], p["episodes"][0]["id"]


# ── mentions ─────────────────────────────────────────────────────────────────

def test_mentions_tokens_and_resolution(client: TestClient):
    c = client
    pid, eid = _project(c)
    ch = ok(c.post("/api/characters", headers=H, json={"name": "Ravi Kumar", "dna_text": "Ravi: 28, lean, cream kurta"}))
    ok(c.post(f"/api/projects/{pid}/cast/{ch['id']}", headers=H))
    tok = mentions.token("character", ch["id"], "Ravi Kumar")
    assert mentions.plain(f"{tok} lights the lamp") == "Ravi Kumar lights the lamp"
    assert mentions.ids(f"{tok} and {tok}", "character") == [ch["id"]]
    cands = ok(c.get(f"/api/projects/{pid}/mentions?q=rav"))
    assert any(x["id"] == ch["id"] and x["kind"] == "character" for x in cands)
    # bare @Ravi resolves to the cast member; an unknown @Meera becomes a new character in the cast
    script = {"logline": "x", "beats": [], "scenes": [{"title": "S1", "location": "Temple", "summary": "", "action": "@Ravi meets @Meera",
                                                      "lines": [{"character": "@Ravi", "line": "Hello", "emotion": ""}]}]}
    ok(c.patch(f"/api/episodes/{eid}", headers=H, json={"script": script}))
    out = ok(c.post(f"/api/episodes/{eid}/script/resolve", headers=H, json={"create_missing": True}))
    assert any(x["name"] == "Meera" for x in out["created"])
    ents = mentions.entities(out["script"])
    assert ch["id"] in ents["character"] and len(ents["character"]) == 2
    assert mentions.plain(out["script"]["scenes"][0]["action"]) == "Ravi Kumar meets Meera"
    quick = ok(c.post("/api/mentions/create", headers=H, json={"kind": "prop", "name": "Oil lamp", "project_id": pid}))
    assert quick["token"].startswith("@[Oil lamp](prop:")
    props = ok(c.get(f"/api/props?project_id={pid}"))
    assert any(p["name"] == "Oil lamp" and p["in_project"] for p in props)


# ── import wizard ────────────────────────────────────────────────────────────

def test_import_apply_creates_cast_board_and_script(client: TestClient):
    c = client
    pid, eid = _project(c, workflow="script")
    parsed = ok(c.post(f"/api/episodes/{eid}/import/parse", headers=H, data={"text": MARKED_SCRIPT, "method": "markers"}))
    assert parsed["stats"]["scenes"] == 2 and {x["name"] for x in parsed["characters"]} >= {"Ravi", "Meera"}
    out = ok(c.post(f"/api/episodes/{eid}/import/apply", headers=H, json={"draft": parsed["draft"], "mapping": {}, "create_missing": True}))
    assert "Meera" in {x["name"] for x in out["created"]} and set(out["characters"]) >= {"Ravi", "Meera"}  # Ravi matched the library
    board = ok(c.get(f"/api/episodes/{eid}/board"))
    shots = [s for sc in board["scenes"] for s in sc["shots"]]
    assert len(shots) >= 3 and any(l["speaker"] == "VO" for s in shots for l in s["lines"])
    ep = ok(c.get(f"/api/episodes/{eid}"))
    toks = mentions.entities(ep["script"])
    assert len(toks["character"]) == 2 and ep["script"]["scenes"][0]["lines"][0]["character"].startswith("@[Ravi](character:")
    assert "brass lamps" in ep["script"]["scenes"][0]["action"]


# ── change impact ────────────────────────────────────────────────────────────

def test_shot_change_marks_takes_stale_and_regenerates(client: TestClient):
    c = client
    pid, eid = _project(c)
    ok(c.post(f"/api/episodes/{eid}/hooks/generate", headers=H, json={"n": 2}))
    ok(c.post(f"/api/episodes/{eid}/hooks/select", headers=H, json={"index": 0}))
    ok(c.post(f"/api/episodes/{eid}/script/generate", headers=H, json={}))
    shots = ok(c.post(f"/api/episodes/{eid}/shots/breakdown", headers=H))
    sid = shots[0]["id"]
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "videos", "shot_ids": [sid]}))
    wait_jobs(c, pid)
    s = ok(c.get(f"/api/shots/{sid}"))
    assert s["keyframe"] and s["video"] and not s["video"]["stale"]
    r = ok(c.patch(f"/api/shots/{sid}", headers=H, json={"action": "He drops the lamp and runs"}))
    assert r["stale_takes"]
    imp = ok(c.get(f"/api/episodes/{eid}/impact"))
    assert imp["counts"].get("video") == 1 and imp["counts"].get("keyframe") == 1 and imp["plan"]
    assert any(x["shot_id"] == sid for x in imp["shots"])
    # a line edit in the script updates the shot that speaks it and flags its voice
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "voices", "shot_ids": [sid], "language": "en"}))
    wait_jobs(c, pid)
    s = ok(c.get(f"/api/shots/{sid}"))
    line = (s["dialogue"].get("en") or [{}])[0].get("line")
    if line:
        ep = ok(c.get(f"/api/episodes/{eid}"))
        script = ep["script"]
        for sc in script["scenes"]:
            for l in sc["lines"]:
                if l["line"].strip() == line.strip():
                    l["line"] = line + " Truly."
        r2 = ok(c.patch(f"/api/episodes/{eid}", headers=H, json={"script": script}))
        assert any(t["shot_id"] == sid for t in r2["script_changes"])
        assert (ok(c.get(f"/api/shots/{sid}"))["dialogue"]["en"][0]["line"]).endswith("Truly.")
    ok(c.post(f"/api/episodes/{eid}/impact/regenerate", headers=H, json={"shot_ids": [sid]}))
    wait_jobs(c, pid)
    s = ok(c.get(f"/api/shots/{sid}"))
    assert not s["video"]["stale"] and not s["keyframe"]["stale"]
    ok(c.post(f"/api/takes/{s['video']['id']}/fresh", headers=H))


# ── Film Map: shot links and next shot ───────────────────────────────────────

def test_next_shot_and_continuity_link(client: TestClient):
    c = client
    pid, eid = _project(c)
    sc = ok(c.post(f"/api/episodes/{eid}/shots", headers=H, json={"action": "Ravi lights the lamp", "framing": "medium", "duration_s": 6}))
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "videos", "shot_ids": [sc["id"]]}))
    wait_jobs(c, pid)
    nxt = ok(c.post(f"/api/shots/{sc['id']}/next", headers=H, json={"action": "He looks up, startled", "mode": "last_frame", "generate": True}))
    n = nxt["shot"]
    assert n["continuity_from_shot_id"] == sc["id"] and n["continuity_mode"] == "last_frame" and n["order"] == sc["order"] + 1
    wait_jobs(c, pid)
    n = ok(c.get(f"/api/shots/{n['id']}"))
    assert n["keyframe"]["params"]["continuity"] is True
    ext = ok(c.post(f"/api/shots/{sc['id']}/next", headers=H, json={"mode": "extend"}))["shot"]
    r = c.patch(f"/api/shots/{ext['id']}", headers=H, json={"continuity_mode": "sideways"})
    assert r.status_code == 400
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "videos", "shot_ids": [ext["id"]]}))
    wait_jobs(c, pid)
    ext = ok(c.get(f"/api/shots/{ext['id']}"))
    assert ext["video"] and ext["video"]["params"]["mode"] == "extend"
    assert ok(c.get(f"/api/shots/{sc['id']}/dialogue-check"))["warnings"] == []


# ── character lock, versions, costumes, sheets ───────────────────────────────

def test_character_lock_versions_costumes_and_sheets(client: TestClient):
    c = client
    pid, eid = _project(c)
    ch = ok(c.post("/api/characters", headers=H, json={"name": "Meera", "dna_text": "Meera: 26, long black hair, green saree",
                                                       "voice_description": "soft alto, unhurried"}))
    cid = ch["id"]
    ok(c.post(f"/api/projects/{pid}/cast/{cid}", headers=H))
    lk = ok(c.put(f"/api/characters/{cid}/lock", headers=H, json={"lock": {"strictness": 0.9, "gestures": "tucks hair behind ear", "bogus": 1}}))
    assert lk["lock"]["strictness"] == 0.9 and "bogus" not in lk["lock"] and "tucks hair" in lk["prompt_text"]
    assert lock_core.face_threshold(lk["lock"], 0.36) > 0.36
    ok(c.patch(f"/api/characters/{cid}", headers=H, json={"name_pronunciation": "MEE-ra", "performance_notes": "speaks with her hands"}))
    # sheet with the back view, an outfit turnaround, lighting variants
    ok(c.post(f"/api/characters/{cid}/sheet", headers=H, json={"project_id": pid}))
    co = ok(c.post(f"/api/characters/{cid}/costumes", headers=H, json={"name": "wedding", "description": "red silk saree with gold border",
                                                                        "episode_from": 2, "episode_to": 2, "project_id": pid}))
    ok(c.post(f"/api/characters/{cid}/lighting", headers=H, json={"project_id": pid}))
    wait_jobs(c, pid)
    full = ok(c.get(f"/api/characters/{cid}"))
    kinds = {a["kind"] for a in full["assets"]}
    assert {"front", "back", "outfit", "lighting"} <= kinds
    outfit_views = {a["view"] for a in full["assets"] if a["kind"] == "outfit"}
    assert {"front", "three_quarter", "full_body"} <= outfit_views
    assert any(x["name"] == "wedding" for x in full["costumes"]) and full["lock_effective"]["strictness"] == 0.9
    costumes = ok(c.get(f"/api/characters/{cid}/costumes"))
    assert len(costumes[0]["images"]) == 3
    # versions: freeze the current look for episodes 1-1, then an older look for 2+
    v1 = ok(c.post(f"/api/characters/{cid}/versions", headers=H, json={"label": "Season 1", "episode_from": 1, "episode_to": 1}))
    v2 = ok(c.post(f"/api/characters/{cid}/versions", headers=H, json={"label": "Older", "episode_from": 2, "dna_text": "Meera: 40, grey streak"}))
    assert ok(c.get(f"/api/characters/{cid}/look?episode=1"))["dna"].startswith("Meera: 26")
    assert ok(c.get(f"/api/characters/{cid}/look?episode=3"))["dna"].startswith("Meera: 40")
    assert ok(c.get(f"/api/characters/{cid}/look"))["version"] is None
    ok(c.post(f"/api/character-versions/{v2['id']}/restore", headers=H))
    assert ok(c.get(f"/api/characters/{cid}"))["dna_text"].startswith("Meera: 40")
    assert len(ok(c.get(f"/api/characters/{cid}/versions"))) == 2 and v1["version"] == 1
    # the prompt for a shot in episode 1 uses the season-1 DNA, the lock text and the voice description
    s = ok(c.post(f"/api/episodes/{eid}/shots", headers=H, json={"action": "Meera turns", "framing": "close-up", "duration_s": 8}))
    ok(c.patch(f"/api/shots/{s['id']}", headers=H, json={"characters": [cid], "outfits": {str(cid): "wedding"},
                                                         "dialogue": {"en": [{"character_id": cid, "line": "I kept the lamp.", "emotion": "softly"}]},
                                                         "voice_mode": "native"}))
    pr = ok(c.get(f"/api/shots/{s['id']}/prompt"))["video_prompt"]
    assert "Meera: 26" in pr and "red silk saree" in pr and "tucks hair" in pr and "pronounced MEE-ra" in pr
    assert "voice: soft alto" in pr and 'says in English, softly: "I kept the lamp."' in pr
    assert pr.index("[DIALOGUE]") < pr.index("[CHARACTERS]")


# ── Google dialogue route: native speech per language, native dubbing, words QC ─────────────────────────────

def test_native_dialogue_route_and_dubbing(client: TestClient):
    c = client
    ok(c.patch("/api/settings", headers=H, json={"native_dialogue_languages": ["en", "kn"], "dub_method": "regenerate",
                                                     "dialogue_method": "native"}))
    try:
        pid, eid = _project(c, quality_mode="balanced")
        ch = ok(c.post("/api/characters", headers=H, json={"name": "Ravi", "dna_text": "Ravi: 28"}))
        ok(c.post(f"/api/projects/{pid}/cast/{ch['id']}", headers=H))
        s = ok(c.post(f"/api/episodes/{eid}/shots", headers=H, json={"action": "Ravi speaks", "framing": "close-up", "duration_s": 8}))
        ok(c.patch(f"/api/shots/{s['id']}", headers=H, json={"characters": [ch["id"]],
                                                             "dialogue": {"en": [{"character_id": ch["id"], "line": "I saw him again.", "emotion": ""}]}}))
        assert ok(c.get(f"/api/shots/{s['id']}"))["effective_voice_mode"] == "native"
        ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "videos", "shot_ids": [s["id"]]}))
        wait_jobs(c, pid)
        s2 = ok(c.get(f"/api/shots/{s['id']}"))
        assert s2["video"]["params"]["native_language"] == "en"
        assert s2["video"]["qc"].get("words", {}).get("word_match", 0) > 0.8 and s2["video"]["qc"]["words_ok"]
        # dubbing into Kannada regenerates the clip with Veo speaking Kannada: a native lip-sync take for kn
        ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "dub", "language": "kn"}))
        wait_jobs(c, pid)
        s3 = ok(c.get(f"/api/shots/{s['id']}?lang=kn"))
        assert s3["lipsync"] and s3["lipsync"]["language"] == "kn" and s3["lipsync"]["params"]["method"] == "native"
        with SessionLocal() as db:
            kn = db.query(Take).filter(Take.shot_id == s["id"], Take.kind == "lipsync", Take.language == "kn").first()
            assert kn and "[DIALOGUE]" in kn.prompt and "says in Kannada" in kn.prompt
    finally:
        ok(c.patch("/api/settings", headers=H, json={"native_dialogue_languages": ["en"], "dub_method": "redub",
                                                         "dialogue_method": "audio_first"}))


def test_pronunciation_dictionary(client: TestClient):
    c = client
    pid, eid = _project(c)
    ok(c.patch(f"/api/projects/{pid}", headers=H, json={"pronunciations": {"Sri Rama": "Shree Raa-ma", "Rama": "Raa-ma"}}))
    ch = ok(c.post("/api/characters", headers=H, json={"name": "Lakshmana", "name_pronunciation": "LUKSH-mun-uh"}))
    with SessionLocal() as db:
        p = db.get(Project, pid)
        assert voice_mod.say(db, p, "Sri Rama calls Rama and Lakshmana home") == "Shree Raa-ma calls Raa-ma and LUKSH-mun-uh home"
        assert voice_mod.say(db, p, "Ramayana") == "Ramayana"  # whole words only


# ── continuity bible, wardrobe timeline, dashboards, seasons ─────────────────

def test_continuity_bible_wardrobe_dashboard_seasons(client: TestClient):
    c = client
    pid, eid = _project(c)
    ok(c.post(f"/api/episodes/{eid}/hooks/generate", headers=H, json={"n": 2}))
    ok(c.post(f"/api/episodes/{eid}/hooks/select", headers=H, json={"index": 0}))
    ok(c.post(f"/api/episodes/{eid}/script/generate", headers=H, json={}))
    ok(c.post(f"/api/episodes/{eid}/scenes/plan", headers=H))
    shots = ok(c.post(f"/api/episodes/{eid}/shots/breakdown", headers=H))
    ep = ok(c.get(f"/api/episodes/{eid}"))
    scenes = ep["scenes"]
    assert scenes
    cid = shots[0]["characters"][0] if shots[0]["characters"] else None
    if cid:
        ok(c.patch(f"/api/scenes/{scenes[0]['id']}", headers=H, json={"wardrobe": {str(cid): "cream kurta"}}))
        if len(scenes) > 1:
            ok(c.patch(f"/api/scenes/{scenes[1]['id']}", headers=H, json={"wardrobe": {str(cid): "wet torn kurta"}}))
    state = ok(c.post(f"/api/scenes/{scenes[0]['id']}/end-state", headers=H))
    assert state["source"] == "ai" and "characters" in state
    ok(c.patch(f"/api/scenes/{scenes[0]['id']}/end-state", headers=H, json={"weather": "light rain"}))
    bible = ok(c.get(f"/api/episodes/{eid}/continuity-bible"))
    assert bible["scenes"][0]["end_state"]["weather"] == "light rain" and bible["scenes"][0]["end_state"]["source"] == "manual"
    if len(scenes) > 1:
        pr = ok(c.get(f"/api/shots/{[s for s in shots if s['scene_id'] == scenes[1]['id']][0]['id']}/prompt"))["video_prompt"] \
            if any(s["scene_id"] == scenes[1]["id"] for s in shots) else ""
        assert "carried over from the previous scene" in pr or pr == ""
    wt = ok(c.get(f"/api/episodes/{eid}/wardrobe"))
    assert "characters" in wt and "breaks" in wt
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "videos", "shot_ids": [shots[0]["id"]]}))
    wait_jobs(c, pid)
    ok(c.post(f"/api/shots/{shots[0]['id']}/approve", headers=H, json={"approved": True}))
    d = ok(c.get(f"/api/episodes/{eid}/dashboard"))
    assert d["shots"]["total"] == len(shots) and d["shots"]["approved"] >= 1 and d["footage"]["approved_s"] > 0
    assert "per_approved_second" in d["spend"] and d["footage"]["regeneration_rate"] >= 0
    pd = ok(c.get(f"/api/projects/{pid}/dashboard"))
    assert pd["shots"]["total"] == d["shots"]["total"] and pd["episodes"][0]["episode_id"] == eid
    seasons = ok(c.get(f"/api/projects/{pid}/seasons"))
    assert seasons[0]["number"] == 1 and seasons[0]["episodes"]
    s2 = ok(c.post(f"/api/projects/{pid}/seasons", headers=H, json={"title": "Second season", "arc": "Return", "episodes": 2}))
    assert s2["number"] == 2 and len(s2["episodes"]) == 2
    ok(c.patch(f"/api/seasons/{s2['id']}", headers=H, json={"status": "writing"}))
    assert c.post(f"/api/projects/{pid}/seasons", headers=H, json={"number": 2}).status_code == 400
