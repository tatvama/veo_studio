"""A script's characters, scene mood/look/sound and voice-over carry through every shot and into the cut (mock providers).

The script's notes used to be pasted into one shot's picture prompt (MOOD:, LIGHTING:, SFX:, MUSIC:), characters made
on import had no look, Produce all made no sound effects and wrote no scene-to-scene continuity, and a voice-over
longer than its clip was cut off in the export.
"""
from __future__ import annotations

import types

from fastapi.testclient import TestClient

from app.agents import tools as T
from app.core import generation
from app.db import SessionLocal
from app.models import Character, Episode, Project, Scene, Shot, Take, User
from app.pipeline import assembler
from app.pipeline.prompting import compile_keyframe_prompt, compile_video_prompt
from app.storage import get_storage
from conftest import H, ok, wait_jobs

SCRIPT = """TITLE: The Lamp
Genre: drama
Logline: A farmer keeps an old promise.
CHARACTERS:
RAVI KUMAR (35) – weathered farmer, grey beard, faded blue kurta
Meera: 30, his wife, green cotton saree, jasmine in her hair

MOOD: quiet, nostalgic
LOOK: warm Kodak film grain, soft contrast

SCENE 1: INT. HUT - NIGHT
One oil lamp. Rain hammers the tin roof.
LIGHTING: a single oil lamp, deep shadows
SOUND: heavy rain on a tin roof
MUSIC: low bansuri flute
SHOT 1 (6s)
VISUAL: Ravi lights the lamp while Meera watches.
SFX: a match strikes
RAVI (whispering): It still works.
SHOT 2
VISUAL: Meera smiles.
VO: Some lights never go out.

SCENE 2: EXT. FIELD - DAWN
MOOD: hopeful
AJJI (70s, silver bun, round glasses) walks through the wet field.
AJJI: The rain is over.
SFX: birds wake up
"""


def _project(c: TestClient, **kw) -> tuple[int, int]:
    p = ok(c.post("/api/projects", headers=H, json={"concept": "The Lamp", "type": "short", "auto_brief": False,
                                                    "languages": ["en"], **kw}))
    return p["id"], p["episodes"][0]["id"]


def test_import_keeps_scene_notes_and_cast(client: TestClient):
    c = client
    pid, eid = _project(c)
    out = ok(c.post(f"/api/episodes/{eid}/import/parse", headers=H, data={"text": SCRIPT}))
    assert out["method"] == "markers" and out["draft"]["title"] == "The Lamp"
    chars = {ch["name"]: ch for ch in out["characters"]}
    assert set(chars) == {"Ravi", "Meera", "Ajji"}  # the cover page (Genre, Logline, CHARACTERS) is nobody
    assert chars["Ravi"]["description"] == "35, weathered farmer, grey beard, faded blue kurta"
    assert chars["Meera"]["lines"] == 0 and "green cotton saree" in chars["Meera"]["description"]
    assert chars["Ajji"]["description"] == "70s, silver bun, round glasses"  # from her first appearance
    sc1, sc2 = out["draft"]["scenes"]
    # notes before scene 1 hold for every scene; a scene's own mood wins, its look adds to the film's
    assert sc1["mood"] == "quiet, nostalgic" and sc2["mood"] == "hopeful"
    assert sc1["look"] == "warm Kodak film grain, soft contrast; lighting: a single oil lamp, deep shadows"
    assert sc2["look"] == "warm Kodak film grain, soft contrast"
    assert sc1["sound"] == "heavy rain on a tin roof" and sc1["music"] == "low bansuri flute"
    s1, s2 = sc1["shots"]
    assert s1["sfx"] == "a match strikes" and s1["prompt"] == "Ravi lights the lamp while Meera watches."
    assert s1["characters"] == ["Ravi", "Meera"]  # Meera is in the shot without a line: she keeps her look too
    assert s2["characters"] == ["Meera"] and s2["lines"][0]["speaker"] == "VO"
    assert sc2["shots"][0]["sfx"] == "birds wake up"
    assert all("MOOD" not in sh["prompt"] and "SFX" not in sh["prompt"] for sc in out["draft"]["scenes"] for sh in sc["shots"])

    # Meera already exists with a look of her own: the import never overwrites it
    meera = ok(c.post("/api/characters", headers=H, json={"name": "Meera", "project_id": pid}))["id"]
    with SessionLocal() as db:
        db.get(Character, meera).dna_text = "Meera: her own look"
        db.commit()
    res = ok(c.post(f"/api/episodes/{eid}/import/apply", headers=H, json={"draft": out["draft"], "mapping": {}}))
    assert res["characters"]["Meera"] == meera
    with SessionLocal() as db:
        ravi = db.get(Character, res["characters"]["Ravi"])
        assert ravi.dna_text == "Ravi: 35, weathered farmer, grey beard, faded blue kurta"
        assert db.get(Character, meera).dna_text == "Meera: her own look"
        scenes = db.query(Scene).filter(Scene.episode_id == eid).order_by(Scene.order).all()
        assert (scenes[0].emotion, scenes[0].sound, scenes[0].music) == ("quiet, nostalgic", "heavy rain on a tin roof",
                                                                         "low bansuri flute")
        shots = db.query(Shot).filter(Shot.episode_id == eid).order_by(Shot.order).all()
        assert shots[0].sfx == "a match strikes" and shots[0].characters == [ravi.id, meera]
        project = db.get(Project, pid)
        video = compile_video_prompt(db, shots[0], project)
        # every shot of the scene carries its look, mood and sound; the script's lamp light replaces the stock night light
        assert "look: warm Kodak film grain, soft contrast; lighting: a single oil lamp, deep shadows" in video
        assert "mood: quiet, nostalgic" in video and "warm practical lamps" not in video
        assert "[CHARACTERS] Ravi: 35, weathered farmer" in video
        assert "[AUDIO] Sound effects and ambience: heavy rain on a tin roof; a match strikes; no music" in video
        narr = compile_video_prompt(db, shots[1], project)
        assert "heavy rain on a tin roof" in narr and "no music, no narration" in narr
        assert "look: warm Kodak film grain" in compile_keyframe_prompt(db, shots[1], project, [])
        ep = db.get(Episode, eid)
        assert ep.script["scenes"][0]["mood"] == "quiet, nostalgic"

    # an editor that doesn't send the notes (older tab) keeps them; one that does changes them
    b = ok(c.get(f"/api/episodes/{eid}/board"))
    assert b["scenes"][0]["mood"] == "quiet, nostalgic" and b["scenes"][0]["shots"][0]["sfx"] == "a match strikes"
    old = {"version": b["version"], "scenes": [{k: v for k, v in sc.items() if k not in ("mood", "look", "sound", "music")}
                                               | {"shots": [{k: v for k, v in sh.items() if k != "sfx"} for sh in sc["shots"]]}
                                               for sc in b["scenes"]]}
    b2 = ok(c.put(f"/api/episodes/{eid}/board", headers=H, json=old))
    assert b2["scenes"][0]["sound"] == "heavy rain on a tin roof" and b2["scenes"][0]["shots"][0]["sfx"] == "a match strikes"
    b2["scenes"][1]["sound"] = "dawn birds, distant cowbells"
    b3 = ok(c.put(f"/api/episodes/{eid}/board", headers=H, json=b2))
    assert b3["scenes"][1]["sound"] == "dawn birds, distant cowbells"


def test_the_score_follows_the_scenes(client: TestClient):
    c = client
    pid, eid = _project(c)
    out = ok(c.post(f"/api/episodes/{eid}/import/parse", headers=H, data={"text": SCRIPT}))
    ok(c.post(f"/api/episodes/{eid}/import/apply", headers=H, json={"draft": out["draft"], "mapping": {}}))
    from app.workers.handlers import score_notes
    with SessionLocal() as db:
        notes = score_notes(db, db.get(Episode, eid))
    assert notes.startswith("1) INT. HUT - NIGHT: quiet, nostalgic · low bansuri flute; 2) EXT. FIELD - DAWN: hopeful")


def test_produce_carries_scenes_and_makes_sound(client: TestClient):
    c = client
    pid, eid = _project(c)
    out = ok(c.post(f"/api/episodes/{eid}/import/parse", headers=H, data={"text": SCRIPT}))
    ok(c.post(f"/api/episodes/{eid}/import/apply", headers=H, json={"draft": out["draft"], "mapping": {}}))
    steps = ["cast", "keyframes", "sound"]
    est = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "produce", "steps": steps}))
    labels = [i["label"] for i in est["items"]]
    # whoever and wherever has no picture yet (other tests may already have pictured a library "Ravi" or a "Hut")
    with SessionLocal() as db:
        from app.models import CharacterAsset, LocationAsset
        shots = db.query(Shot).filter(Shot.episode_id == eid).all()
        char_ids = {int(x) for s in shots for x in (s.characters or [])}
        loc_ids = {s.location_id for s in shots if s.location_id}
        bare_chars = sum(1 for i in char_ids if not db.query(CharacterAsset).filter(CharacterAsset.character_id == i).count())
        bare = sum(1 for lid in loc_ids if not db.query(LocationAsset).filter(LocationAsset.location_id == lid).count())
        voices = len(generation.cast_voice_specs(db, db.get(Project, pid), shots))
    assert len(char_ids) == 3 and bare_chars + bare > 0
    assert labels == [f"Cast looks & voices · {bare_chars + bare + voices}", "Keyframes · 3", "Sound effects · 3"]
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "produce", "steps": steps}))
    jobs = wait_jobs(c, pid, timeout=600)
    prod = next(j for j in jobs if j["type"] == "produce")
    assert prod["status"] == "succeeded", prod["error"]
    kinds = [j["type"] for j in jobs if j["status"] == "succeeded"]
    assert kinds.count("character_sheet") == bare_chars and kinds.count("location_images") == bare and "sfx" in kinds
    with SessionLocal() as db:
        scenes = db.query(Scene).filter(Scene.episode_id == eid).order_by(Scene.order).all()
        assert scenes[0].end_state  # written before the first picture, so scene 2 carries on from scene 1
        shots = db.query(Shot).filter(Shot.episode_id == eid).all()
        assert all((s.sfx_track or {}).get("path") for s in shots)
        later = compile_video_prompt(db, next(s for s in shots if s.scene_id == scenes[1].id), db.get(Project, pid))
        assert "carried over from the previous scene" in later
    # only what is missing: no new looks or sound effects next time
    again = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "produce", "steps": steps}))
    assert again["count"] == 0


def test_no_placeholder_sound_without_a_key(client: TestClient, monkeypatch):
    """Real providers but no ElevenLabs key: no "Sound effects" step and no job saving a hum as the shot's sound."""
    import app.config as config
    import app.providers.services as services
    monkeypatch.setattr(services, "provider_mode", lambda p: "mock")
    monkeypatch.setattr(config, "get_settings", lambda: types.SimpleNamespace(mock_providers="auto"))
    assert generation.sound_effects_ready() is False
    monkeypatch.setattr(config, "get_settings", lambda: types.SimpleNamespace(mock_providers="true"))
    assert generation.sound_effects_ready() is True


def test_long_voice_over_holds_the_last_frame(client: TestClient):
    c = client
    pid, eid = _project(c)
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [{"title": "One", "shots": [
        {"prompt": "The lamp glows.", "duration_s": 4,
         "lines": [{"speaker": "VO", "text": "Some lights never go out, however long the night and however hard the rain."}]},
    ]}]}))
    st = get_storage()
    with SessionLocal() as db:
        shot = db.query(Shot).filter(Shot.episode_id == eid).one()
        user = db.query(User).first()
        for kind, lang, secs in (("video", None, 4.0), ("narration", "en", 7.5)):
            rel = st.save_bytes(st.new_path(f"projects/{pid}/test", "bin"), b"x")
            db.add(Take(shot_id=shot.id, kind=kind, language=lang, provider="google", path=rel, duration_s=secs,
                        selected=True, created_by=user.id))
        db.commit()
        segs, warnings = assembler.plan(db, db.get(Episode, eid), "en", "final", st.tmp_dir())
    assert abs(segs[0].duration - 7.8) < 0.01  # the words end, then the cut moves on
    assert any("voice-over runs 7.8s" in w for w in warnings)


def test_director_finishes_the_film(client: TestClient):
    c = client
    pid, eid = _project(c)
    out = ok(c.post(f"/api/episodes/{eid}/import/parse", headers=H, data={"text": SCRIPT}))
    ok(c.post(f"/api/episodes/{eid}/import/apply", headers=H, json={"draft": out["draft"], "mapping": {}}))
    with SessionLocal() as db:
        user = db.query(User).filter(User.email == "admin@test.local").first()
        ctx = T.AgentCtx(db=db, user=user, project=db.get(Project, pid), episode=db.get(Episode, eid))
        res = T.run_tool(ctx, "produce_all", {"steps": ["voices", "sound", "music", "export"]})
        assert res["status"] == "proposed"
        assert [l.split(" · ")[0] for l in res["steps"]] == ["Voices & lip-sync", "Sound effects", "Music", "Final export"]
        assert "error" in T.run_tool(ctx, "produce_all", {"steps": ["nonsense"]})
    assert "produce_all" in {d["name"] for d in T.TOOL_DECLS}
