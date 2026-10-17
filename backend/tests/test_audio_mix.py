"""The film's sound (mock providers, local FFmpeg): the scene's background under lip-synced dialogue, free sound effects
without ElevenLabs, music per scene crossfaded on the cut, and the lip-sync warning in the cost dialog.

Lip-synced dialogue used to lose its clip's rain or room sound (dead silence behind every line), sound effects needed an
ElevenLabs key, one score ran under every scene whatever its mood, and Produce all lip-synced shots with no lip-sync
engine connected without a word.
"""
from __future__ import annotations

import types
from pathlib import Path

from fastapi.testclient import TestClient

from app.agents import tools as T
from app.core import generation
from app.db import SessionLocal
from app.models import AudioAsset, Episode, Job, Project, Scene, Shot, Take, User
from app.pipeline import assembler, sfx_library
from app.pipeline import ffmpeg as ff
from app.storage import get_storage
from conftest import H, ok, wait_jobs


def _project(c: TestClient, **kw) -> tuple[int, int]:
    p = ok(c.post("/api/projects", headers=H, json={"concept": "The Lamp", "type": "short", "auto_brief": False,
                                                    "languages": ["en"], **kw}))
    return p["id"], p["episodes"][0]["id"]


def _clip(out: Path, seconds: float, noise: float | None = 0.3) -> Path:
    """A small real clip: test picture with pink-noise sound (a rainy room), or silent (noise=None)."""
    audio = ["-f", "lavfi", "-i", f"anoisesrc=c=pink:a={noise}:d={seconds}"] if noise else []
    ff.run(["-f", "lavfi", "-i", f"testsrc=size=320x180:rate=24:d={seconds}", *audio, "-shortest", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", *(["-c:a", "aac"] if noise else []), out])
    return out


def _take(db, st, shot: Shot, kind: str, src: Path, user: User, lang: str | None = None, **params) -> Take:
    rel = st.save_file(st.new_path(f"projects/test/{shot.id}/{kind}", src.suffix.lstrip(".")), src)
    t = Take(shot_id=shot.id, kind=kind, language=lang, provider="google", path=rel, duration_s=ff.duration(src),
             selected=True, params=params, created_by=user.id)
    db.add(t)
    db.flush()
    return t


# ── free sound effects ───────────────────────────────────────────────────────

def test_library_maps_words_to_recorded_files():
    names = lambda text: [(s.name, surf) for s, surf in sfx_library.spots_for(text)]  # noqa: E731
    assert names("footsteps on the wooden stairs") == [("footsteps", "wood")]
    assert names("Knock at the door, then footsteps in the snow") == [("knock", ""), ("footsteps", "snow")]
    assert names("a door slams") == [("door closes", "")] and names("the door creaks open") == [("door opens", "")]
    assert names("glass shatters") == [("glass breaks", "")] and names("she drops the plate") == [("plates", "")]
    assert names("a loud thud") == [("thud", "")] and names("rain falls on the roof") == []  # rain isn't a thud
    assert names("engine starts") == [("engine", "")] and names("a match strikes") == [("match strikes", "")]
    assert names("dawn breaks over the field") == []
    assert sfx_library.ambiences_for("heavy rain on a tin roof, thunder") == ["storm"]  # a storm already carries rain
    assert sfx_library.ambiences_for("wind howling over the sea") == ["sea", "wind"]
    assert sfx_library.ambiences_for("the window rattles") == []  # "window" is not wind
    # every spot effect has its recorded files bundled, and the pick is the same for the same shot
    assert sfx_library.library_dir() is not None
    for spot in sfx_library.SPOTS:
        assert sfx_library._spot_files(spot, "wood"), spot.name
    files = sfx_library._spot_files(sfx_library.SPOTS[0], "")
    import random
    a = sfx_library._events(sfx_library.SPOTS[0], files, 4.0, random.Random(7))
    b = sfx_library._events(sfx_library.SPOTS[0], files, 4.0, random.Random(7))
    assert a == b and len(a) == 3  # three raps on the door
    steps = next(s for s in sfx_library.SPOTS if s.pattern == "steps")
    walk = sfx_library._events(steps, sfx_library._spot_files(steps, "wood"), 4.0, random.Random(1))
    assert len(walk) >= 6 and all("footstep_wood" in f.name for f, _, _ in walk)


def test_library_synthesizes_every_ambience(tmp_path: Path):
    for name in sfx_library.AMBIENCES:
        out = sfx_library.synth_ambience([name], 1.5, 11, tmp_path / f"{name}.wav")
        level, peak = ff.measure(out)
        assert abs(ff.duration(out) - 1.5) < 0.05, name
        assert level is not None and -30 < level < -21, (name, level)  # gentle: under the voices
        assert peak is not None and peak <= -0.9, (name, peak)
    both = sfx_library.make_shot_sound("night, crickets", "footsteps on grass", 3.0, 5, tmp_path / "shot.wav")
    assert both and abs(ff.duration(both) - 3.0) < 0.05 and ff.loudness(both) is not None
    assert sfx_library.plan_sound("night, crickets", "footsteps on grass").label == \
        "ambience: night · effects: footsteps on grass"
    assert sfx_library.make_shot_sound("", "a mysterious feeling", 3.0, 5, tmp_path / "none.wav") is None


def test_free_sound_route_saves_tracks(client: TestClient, monkeypatch):
    """No ElevenLabs key: Produce all's sound step is free and makes the shots' sound from the script's notes."""
    c = client
    pid, eid = _project(c)
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [
        {"title": "Hut", "sound": "heavy rain on a tin roof", "shots": [
            {"prompt": "Ravi lights the lamp.", "duration_s": 6, "sfx": "a match strikes"},
            {"prompt": "The flame steadies.", "duration_s": 4}]},
        {"title": "Field", "shots": [{"prompt": "Dawn over the field.", "duration_s": 4},
                                     {"prompt": "Ajji walks in.", "duration_s": 4, "sfx": "footsteps on gravel"}]},
    ]}))
    monkeypatch.setattr(generation, "sound_effects_ready", lambda: False)
    est = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "produce", "steps": ["sound"]}))
    assert [(i["label"], i["usd"]) for i in est["items"]] == [("Sound effects · 3", 0.0)]  # the dawn shot names no sound
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "produce", "steps": ["sound"]}))
    jobs_ = wait_jobs(c, pid, timeout=300)
    assert all(j["status"] == "succeeded" for j in jobs_), [(j["type"], j["error"]) for j in jobs_]
    sfx_job = next(j for j in jobs_ if j["type"] == "sfx")
    assert sfx_job["cost_actual"] == 0
    st = get_storage()
    with SessionLocal() as db:
        shots = db.query(Shot).filter(Shot.episode_id == eid).order_by(Shot.order).all()
        tracks = [s.sfx_track or {} for s in shots]
        assert [bool(t.get("path")) for t in tracks] == [True, True, False, True]
        assert tracks[0]["free"] is True and tracks[0]["volume_db"] == sfx_library.FREE_VOLUME_DB
        assert tracks[0]["prompt"] == "ambience: storm · effects: match strikes"
        assert tracks[3]["prompt"] == "effects: footsteps on grass"
        assert abs(ff.duration(st.abs(tracks[1]["path"])) - 4.0) < 0.05
    again = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "produce", "steps": ["sound"]}))
    assert again["count"] == 0  # only what is missing


# ── the lip-sync warning ─────────────────────────────────────────────────────

def test_lipsync_warning_without_a_live_engine(client: TestClient, monkeypatch):
    import app.config as config
    import app.providers.services as services
    from app.core import model_hub
    with SessionLocal() as db:
        assert generation.lipsync_warnings(db, ["SH01"]) == []  # all-mock studio (tests, demos): nothing to warn about
        monkeypatch.setattr(config, "get_settings", lambda: types.SimpleNamespace(mock_providers="auto"))
        fake = types.SimpleNamespace(provider="sync")
        monkeypatch.setattr(model_hub, "candidates", lambda db, chain, modes: [(fake, "lipsync")])
        monkeypatch.setattr(services, "provider_mode", lambda p: "mock")
        assert generation.lipsync_warnings(db, ["SH01"]) == [generation.LIPSYNC_MISSING]
        assert generation.lipsync_warnings(db, []) == []  # nothing to lip-sync
        monkeypatch.setattr(services, "provider_mode", lambda p: "live")
        assert generation.lipsync_warnings(db, ["SH01"]) == []


def test_cost_dialog_warns_before_lip_sync(client: TestClient, monkeypatch):
    c = client
    pid, eid = _project(c, languages=["hi"])  # Hindi dialogue → voice first, then lip-sync
    ravi = ok(c.post("/api/characters", headers=H, json={"name": "Ravi", "project_id": pid}))["id"]
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [{"title": "One", "shots": [
        {"prompt": "Ravi lights the lamp.", "duration_s": 6, "lines": [{"speaker": ravi, "text": "Tonight it moves again."}]}]}]}))
    assert ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "produce"}))["warnings"] == []
    monkeypatch.setattr(generation, "lipsync_ready", lambda db: False)
    est = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "produce"}))
    assert est["warnings"] == [generation.LIPSYNC_MISSING]
    assert ok(c.post(f"/api/episodes/{eid}/estimate", headers=H,
                     json={"action": "produce", "steps": ["keyframes"]}))["warnings"] == []  # no voices step
    st = get_storage()
    with SessionLocal() as db:  # the lipsync batch needs a clip to lip-sync
        shot = db.query(Shot).filter(Shot.episode_id == eid).one()
        _take(db, st, shot, "video", _clip(st.tmp_dir() / "v.mp4", 1.0), db.query(User).first())
        db.commit()
    est = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "lipsync", "language": "hi"}))
    assert est["count"] == 1 and est["warnings"] == [generation.LIPSYNC_MISSING]


# ── the scene's background under dialogue ────────────────────────────────────

def test_background_stays_under_lip_synced_dialogue(client: TestClient):
    c = client
    pid, eid = _project(c)
    ravi = ok(c.post("/api/characters", headers=H, json={"name": "Ravi", "project_id": pid}))["id"]
    line = lambda text: [{"speaker": ravi, "text": text}]  # noqa: E731
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [
        {"title": "Hut", "shots": [{"prompt": "Rain on the roof.", "duration_s": 4},
                                   {"prompt": "Ravi speaks.", "duration_s": 4, "lines": line("It still works.")},
                                   {"prompt": "Ravi again.", "duration_s": 4, "lines": line("Look.")},
                                   {"prompt": "Ravi once more.", "duration_s": 4, "lines": line("See?")}]},
        {"title": "Road", "shots": [{"prompt": "Ravi talks.", "duration_s": 4, "lines": line("Hello.")}]},
    ]}))
    st = get_storage()
    tmp = st.tmp_dir()
    rain, quiet, talk = _clip(tmp / "rain.mp4", 3.0), _clip(tmp / "quiet.mp4", 4.0, noise=None), _clip(tmp / "talk.mp4", 4.0)
    with SessionLocal() as db:
        user = db.query(User).first()
        wide, s2, s3, s4, road = db.query(Shot).filter(Shot.episode_id == eid).order_by(Shot.order).all()
        _take(db, st, wide, "video", rain, user)
        _take(db, st, wide, "video", quiet, user).selected = False  # an older, silent take: not the current one
        for s in (s2, s3, s4, road):
            _take(db, st, s, "video", talk, user)
            _take(db, st, s, "lipsync", talk, user, lang="en")
        s3.sfx_track = {"path": st.save_file(st.new_path(f"projects/{pid}/sfx", "mp4"), rain), "start": 0, "volume_db": -8}
        db.query(Take).filter(Take.shot_id == s4.id, Take.kind == "lipsync").delete()
        _take(db, st, s4, "voicelock", talk, user, lang="en", separation="demucs")  # Demucs kept the background
        db.commit()
        ep = db.get(Episode, eid)
        segs, warnings = assembler.plan(db, ep, "en", "final", tmp, {"ambience": True, "sfx": True})
        by = {sg.shot.id: sg for sg in segs}
        beds = [e for e in by[s2.id].extra_audio if "/ambience/" in e[3]]
        assert len(beds) == 1 and beds[0][2] == assembler.AMBIENCE_GAIN_DB and st.exists(beds[0][3])
        bed = st.abs(beds[0][3])
        assert ff.duration(bed) >= 20 and abs(ff.loudness(bed) - assembler.AMBIENCE_LUFS) < 1.5  # looped, levelled
        assert by[wide.id].extra_audio == []  # the clip keeps its own sound
        assert not [e for e in by[s3.id].extra_audio if "/ambience/" in e[3]]  # its own sound effects carry the scene
        assert by[s4.id].source_kind == "voicelock" and by[s4.id].extra_audio == []
        # the road scene has no clip without dialogue to take its background from
        assert by[road.id].extra_audio == []
        assert [w for w in warnings if "background sound drops out" in w] == [
            f"{road.code}: the scene's background sound drops out under the dialogue (no clip in the scene without "
            "dialogue to take it from): a sound effect for the shot, or a shot without dialogue in the scene, brings it back"]
        again, _ = assembler.plan(db, ep, "en", "final", tmp, {"ambience": True})
        assert [e[3] for e in again[1].extra_audio] == [beds[0][3]]  # made once, kept in storage
        off, w2 = assembler.plan(db, ep, "en", "final", tmp, {"ambience": False})
        assert off[1].extra_audio == [] and not [w for w in w2 if "background sound" in w]
        assert assembler.render_options(db, ep, {})["ambience"] is True
        assert assembler.render_options(db, ep, {"ambience": False})["ambience"] is False
        # the desktop render plan carries the bed by its storage key
        from app.core import desktop
        plan = desktop.render_plan(db, ep, "en", 320, 180)
        seg = next(s for s in plan["segments"] if s["shot_id"] == s2.id)
        assert {"key": beds[0][3], "offset": 0.0, "gain_db": assembler.AMBIENCE_GAIN_DB} in seg["extra_audio"]
        assert beds[0][3] in plan["keys"]


# ── music per scene ──────────────────────────────────────────────────────────

def _two_scenes(c: TestClient) -> tuple[int, int]:
    pid, eid = _project(c)
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [
        {"title": "Hut", "mood": "quiet, nostalgic", "music": "low bansuri flute",
         "shots": [{"prompt": "Ravi lights the lamp.", "duration_s": 4}, {"prompt": "The flame.", "duration_s": 4}]},
        {"title": "Field", "mood": "hopeful", "shots": [{"prompt": "Dawn over the field.", "duration_s": 6}]},
    ]}))
    return pid, eid


def test_music_per_scene_follows_each_scene(client: TestClient):
    c = client
    pid, eid = _two_scenes(c)
    est = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "produce", "steps": ["music"]}))
    assert [i["label"] for i in est["items"]] == ["Music · 2"]  # two scenes: one piece each (the default)
    score = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H,
                      json={"action": "produce", "steps": ["music"], "music_per_scene": False}))
    assert [i["label"] for i in score["items"]] == ["Music · 1"]
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "produce", "steps": ["music"],
                                                                 "music_per_scene": True}))
    done = wait_jobs(c, pid, timeout=300)
    assert all(j["status"] == "succeeded" for j in done), [(j["type"], j["error"]) for j in done]
    with SessionLocal() as db:
        ep = db.get(Episode, eid)
        scenes = db.query(Scene).filter(Scene.episode_id == eid).order_by(Scene.order).all()
        cues = db.query(AudioAsset).filter(AudioAsset.episode_id == eid, AudioAsset.kind == "music_scene").all()
        assert sorted(a.params["scene_id"] for a in cues) == sorted(sc.id for sc in scenes)
        assert all(a.selected and a.params["theme"].startswith("Bansuri flute") for a in cues)
        assert all(a.prompt.startswith("Bansuri flute") and "Instrumental only" in a.prompt for a in cues)
        assert ep.settings["music_mode"] == "scenes"
        assert generation.music_per_scene_default(db, ep) is True
    again = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "produce", "steps": ["music"]}))
    assert again["count"] == 0  # every scene has its piece

    # the export lays each scene's piece from where the scene starts on the cut, crossfaded, the cut's length
    st = get_storage()
    with SessionLocal() as db:
        ep = db.get(Episode, eid)
        tmp = st.tmp_dir()
        segs, _ = assembler.plan(db, ep, "en", "final", tmp, {"ambience": False})
        timed, _, _ = assembler.timeline(segs, True, True)
        total = timed[-1].start + timed[-1].seg_len
        pieces = assembler.scene_music_plan(db, ep, timed, total)
        cue = {a.params["scene_id"]: a.path for a in assembler.scene_cues(db, ep).values()}
        assert [(p.key, p.start) for p in pieces] == [(cue[scenes[0].id], 0.0), (cue[scenes[1].id], 8.0)]
        assert pieces[0].length == 8.0 + assembler.MUSIC_OVERLAP and pieces[0].fade_out == assembler.MUSIC_FADE_OUT
        assert pieces[1].length == 6.0 and pieces[1].fade_out == 0.0  # the last plays out under the end
        bed = assembler.scene_music(pieces, total, tmp / "bed.wav")
        assert abs(ff.duration(bed) - total) < 0.05 and ff.loudness(bed) is not None
        # a scene with no piece gets the score there; picking the score switches the export back to it
        db.add(AudioAsset(project_id=pid, episode_id=eid, kind="music", path=cues[0].path, selected=True))
        db.query(AudioAsset).filter(AudioAsset.id == next(a.id for a in cues if a.params["scene_id"] == scenes[1].id)).delete()
        db.commit()
        pieces = assembler.scene_music_plan(db, ep, timed, total)
        assert [(p.start, p.offset) for p in pieces] == [(0.0, 0.0), (8.0, 8.0)]  # the score carries on at 8 s
        score_id = db.query(AudioAsset.id).filter(AudioAsset.episode_id == eid, AudioAsset.kind == "music").scalar()
    ok(c.post(f"/api/audio/{score_id}/select", headers=H))
    with SessionLocal() as db:
        ep = db.get(Episode, eid)
        assert ep.settings["music_mode"] == "score" and assembler.scene_music_plan(db, ep, timed, total) == []


def test_music_action_and_director_per_scene(client: TestClient):
    c = client
    pid, eid = _two_scenes(c)
    est = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "music", "music_per_scene": True}))
    assert est["count"] == 1 and est["items"][0]["label"] == "Music per scene E01 (2 scenes)"
    with SessionLocal() as db:
        user = db.query(User).filter(User.email == "admin@test.local").first()
        ctx = T.AgentCtx(db=db, user=user, project=db.get(Project, pid), episode=db.get(Episode, eid))
        res = T.run_tool(ctx, "produce_all", {"steps": ["music"], "music_per_scene": False})
        assert res["status"] == "proposed" and res["steps"] == ["Music · 1"]
        prop = db.query(Job).filter(Job.episode_id == eid, Job.type == "produce").one()
        assert prop.payload["music_per_scene"] is False
        prop.status = "cancelled"  # one Produce all per episode at a time
        db.commit()
        res = T.run_tool(ctx, "produce_all", {"steps": ["music"]})
        assert res["steps"] == ["Music · 2"]
    decl = next(d for d in T.TOOL_DECLS if d["name"] == "produce_all")
    assert decl["parameters"]["properties"]["music_per_scene"]["type"] == "boolean"


def test_export_mixes_scene_music_and_background(client: TestClient):
    """A real (draft) export: the scenes' pieces as the music bed and the background under the lip-synced line."""
    c = client
    pid, eid = _project(c)
    meera = ok(c.post("/api/characters", headers=H, json={"name": "Meera", "project_id": pid}))["id"]
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [
        {"title": "Hut", "shots": [{"prompt": "Rain on the roof.", "duration_s": 4},
                                   {"prompt": "Meera speaks.", "duration_s": 4,
                                    "lines": [{"speaker": meera, "text": "It still works."}]}]},
        {"title": "Field", "shots": [{"prompt": "Dawn over the field.", "duration_s": 6}]},
    ]}))
    st = get_storage()
    tmp = st.tmp_dir()
    with SessionLocal() as db:
        user = db.query(User).first()
        shots = db.query(Shot).filter(Shot.episode_id == eid).order_by(Shot.order).all()
        for i, s in enumerate(shots):
            _take(db, st, s, "video", _clip(tmp / f"v{i}.mp4", 2.0), user)
        _take(db, st, shots[1], "lipsync", _clip(tmp / "lip.mp4", 2.0, noise=None), user, lang="en")
        sc = {s.scene_id for s in shots}
        for sid in sc:
            m = tmp / f"m{sid}.wav"
            ff.write_tone_wav(m, 6.0, freq=220 + sid % 50, syllables=False)
            db.add(AudioAsset(project_id=pid, episode_id=eid, kind="music_scene", selected=True, params={"scene_id": sid},
                              path=st.save_file(st.new_path(f"projects/{pid}/music", "wav"), m)))
        ep = db.get(Episode, eid)
        ep.settings = {**(ep.settings or {}), "music_mode": "scenes"}
        db.commit()
        segs, _ = assembler.plan(db, ep, "en", "final", tmp)
        assert [e[3].split("/")[2] for e in segs[1].extra_audio] == ["ambience"]
        out = assembler.render(db, ep, "en", "draft", "final", {"captions": False, "auto_reframe": False},
                               f"projects/{pid}/exports/audio_mix")
    assert "No music track yet" not in out["warnings"]
    assert not [w for w in out["warnings"] if "background sound" in w]
    final = st.abs(out["path"])
    assert ff.has_audio(final) and abs(out["duration"] - 6.0) < 0.3 and ff.loudness(final) is not None
