"""Screenplay speakers, the narrator's own shots, speech that is never cut or made up, outfit lines, undescribed
characters and a cleaner sound mix (mock providers, local FFmpeg).

A (O.S.) or (CONT'D) line became the narrator; a voice-over shared a shot with a talking face and started under it;
words were cut where a clip ended; a dialogue clip with no voice yet played Veo's made-up speech; the night before
leaked into the next morning; WARDROBE lines were ignored; undescribed characters got a new face per keyframe; sound
effects doubled the clips' own; the music pumped under rain; captions drifted after a voice was sped up; clips played
longer than planned; square films got tall clips; one failed scene piece cost the film its music; clips and voices met
the mix at different loudness; and other projects' cast leaked into pronunciations and continuity.
"""
from __future__ import annotations

import types
from pathlib import Path

from fastapi.testclient import TestClient

from app.agents import schemas as S
from app.core import budget, continuity, generation, script_import
from app.db import SessionLocal
from app.models import AudioAsset, Character, Episode, Job, Project, Scene, Shot, Take, User
from app.pipeline import assembler, voice as voice_mod
from app.pipeline import ffmpeg as ff
from app.pipeline.prompting import audio_block, compile_video_prompt
from app.storage import get_storage
from conftest import H, ok, wait_jobs


def _project(c: TestClient, **kw) -> tuple[int, int]:
    # a series in one language: dialogue is voiced first and lip-synced (audio_first), not spoken by Veo
    body = {"concept": "The verandah", "type": "series", "auto_brief": False, "languages": ["en"], **kw}
    p = ok(c.post("/api/projects", headers=H, json=body))
    return p["id"], p["episodes"][0]["id"]


def _clip(out: Path, seconds: float, noise: float | None = 0.3) -> Path:
    """A small real clip: test picture with pink-noise sound, or silent (noise=None)."""
    audio = ["-f", "lavfi", "-i", f"anoisesrc=c=pink:a={noise}:d={seconds}"] if noise else []
    ff.run(["-f", "lavfi", "-i", f"testsrc=size=320x180:rate=24:d={seconds}", *audio, "-shortest", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", *(["-c:a", "aac"] if noise else []), out])
    return out


def _take(db, shot: Shot, kind: str, user: User, src: Path | None = None, lang: str | None = None, secs: float = 0.0,
          **params) -> Take:
    """A selected take: a real file, or a stand-in of `secs` seconds (plan() reads the take's length, not the file)."""
    st = get_storage()
    if src is not None:
        rel = st.save_file(st.new_path(f"projects/test/{shot.id}/{kind}", src.suffix.lstrip(".")), src)
        secs = secs or ff.duration(src)
    else:
        rel = st.save_bytes(st.new_path(f"projects/test/{shot.id}/{kind}", "bin"), b"x")
    t = Take(shot_id=shot.id, kind=kind, language=lang, provider="google", path=rel, duration_s=secs, selected=True,
             params=params, created_by=user.id)
    db.add(t)
    db.flush()
    return t


def _shots(db, eid: int) -> list[Shot]:
    return db.query(Shot).filter(Shot.episode_id == eid, Shot.include.is_(True)).order_by(Shot.order).all()


# ── 1. screenplay speakers ───────────────────────────────────────────────────

SCREENPLAY = """INT. VERANDAH - NIGHT
Vasudha waits by the lamp.

KESAVA (O.S.)
Vasudha! Open the door.

VASUDHA
Who is it?

KESAVA (CONT'D)
It's me, I'm back.

NARRATOR (V.O.)
He had been gone a whole year.

ILANGO (O.C.): Let him in.
VASUDHA (V.O.): I knew he would come.
"""


def test_screenplay_tags_keep_the_speaker():
    draft = script_import.parse_marked(SCREENPLAY)
    shots = draft["scenes"][0]["shots"]
    said = [[(l["speaker"], bool(l.get("off_screen"))) for l in sh["lines"]] for sh in shots]
    assert said == [[("Kesava", True)],  # heard from off-screen: still Kesava, not the narrator
                    [("Vasudha", False)],
                    [("Kesava", False)],  # (CONT'D): the same speaker going on
                    [("VO", False), ("Ilango", True), ("VO", False)]]  # only V.O. is the narrator
    assert "Kesava" not in shots[0]["characters"]  # nobody sees him say it
    assert shots[1]["prompt"] == "The moment continues: Vasudha waits by the lamp."
    assert shots[3]["prompt"].startswith("The moment continues: ") and "Vasudha" in shots[3]["characters"]
    # the CAPS tag in the delivery-note slot, a tag on its own line under the name, and old lower-case forms
    for text, who, off, emotion in (("RAVI (O.S.) (whispering): Hush.", "Ravi", True, "whispering"),
                                    ("RAVI (V.O.): Long ago.", "VO", False, ""),
                                    ("Ravi (off-screen): Here!", "Ravi", True, ""),
                                    ("RAVI (CONT'D): And then?", "Ravi", False, "")):
        line = script_import.parse_marked(f"SCENE 1\n{text}\n")["scenes"][0]["shots"][0]["lines"][0]
        assert (line["speaker"], bool(line.get("off_screen")), line["emotion"]) == (who, off, emotion), text
    cue = script_import.parse_marked("SCENE 1\nRAVI\n(O.S.)\nWho's there?\n")["scenes"][0]["shots"][0]["lines"][0]
    assert cue["speaker"] == "Ravi" and cue["off_screen"] is True


def test_off_screen_lines_are_voiced_not_lip_synced(client: TestClient):
    c = client
    pid, eid = _project(c)
    out = ok(c.post(f"/api/episodes/{eid}/import/parse", headers=H, data={"text": SCREENPLAY}))
    res = ok(c.post(f"/api/episodes/{eid}/import/apply", headers=H, json={"draft": out["draft"], "mapping": {}}))
    kesava = res["characters"]["Kesava"]
    b = ok(c.get(f"/api/episodes/{eid}/board"))
    lines = [sh["lines"] for sh in b["scenes"][0]["shots"]]
    assert lines[0] == [{"speaker": kesava, "text": "Vasudha! Open the door.", "emotion": "", "off_screen": True}]
    assert "off_screen" not in lines[1][0]
    with SessionLocal() as db:
        project = db.get(Project, pid)
        s0, s1, s2, s3 = _shots(db, eid)
        assert s0.dialogue["en"][0]["off_screen"] is True and kesava not in (s0.characters or [])
        assert not budget.Estimator.needs_lipsync(s0, project, "en") and budget.Estimator.voice_only(s0, project, "en")
        assert budget.Estimator.needs_lipsync(s1, project, "en") and not budget.Estimator.voice_only(s1, project, "en")
        heard = compile_video_prompt(db, s0, project)
        assert "Kesava speaks from off-screen: not in the picture, never seen talking." in heard
        assert "lip movement" not in heard and "no audible speech." in heard and "mouths move" not in heard
        seen = compile_video_prompt(db, s1, project)
        assert "Vasudha speaks naturally to camera-side" in seen and "no audible speech; mouths move naturally" in seen
        # Produce all voices the off-screen line (a voice, no lip-sync)
        _, items = generation.produce_plan(db, project, db.get(Episode, eid), _shots(db, eid), ["voices"])
        assert items and items[0]["label"].endswith("· 4")  # two lip-synced lines, one off-screen voice, one voice-over
    # an editor that doesn't know the flag (the shot list) keeps it; one that sends it changes it
    old = {"version": b["version"], "scenes": [{**sc, "shots": [{**sh, "lines": [{k: v for k, v in l.items() if k != "off_screen"}
                                                                               for l in sh["lines"]]} for sh in sc["shots"]]}
                                               for sc in b["scenes"]]}
    b2 = ok(c.put(f"/api/episodes/{eid}/board", headers=H, json=old))
    assert b2["scenes"][0]["shots"][0]["lines"][0]["off_screen"] is True
    b2["scenes"][0]["shots"][0]["lines"][0] = {"speaker": kesava, "text": "Vasudha! Open up.", "emotion": ""}  # retyped
    b2 = ok(c.put(f"/api/episodes/{eid}/board", headers=H, json=b2))
    assert b2["scenes"][0]["shots"][0]["lines"][0]["off_screen"] is True
    b2["scenes"][0]["shots"][0]["lines"][0]["off_screen"] = False
    b3 = ok(c.put(f"/api/episodes/{eid}/board", headers=H, json=b2))
    assert "off_screen" not in b3["scenes"][0]["shots"][0]["lines"][0]


# ── 2. the narrator gets a shot of his own, and never talks over a character ─

def test_voice_over_gets_its_own_shot_unless_shots_are_written():
    implicit = script_import.parse_marked("SCENE 1\nVISUAL: Ravi lights the lamp.\nRAVI: It still works.\n"
                                          "VO: It always had.\nRAVI: Look.\n")["scenes"][0]["shots"]
    assert [[l["speaker"] for l in sh["lines"]] for sh in implicit] == [["Ravi"], ["VO"], ["Ravi"]]
    assert [sh["prompt"] for sh in implicit] == ["Ravi lights the lamp.", *["The moment continues: Ravi lights the lamp."] * 2]
    assert all(sh["characters"] == ["Ravi"] for sh in implicit)
    explicit = script_import.parse_marked("SCENE 1\nSHOT 1\nVISUAL: Ravi lights the lamp.\nRAVI: It still works.\n"
                                          "VO: It always had.\n")["scenes"][0]["shots"]
    assert [[l["speaker"] for l in sh["lines"]] for sh in explicit] == [["Ravi", "VO"]]


def test_narration_waits_for_the_dialogue_and_captions_follow_a_faster_voice(client: TestClient):
    c = client
    pid, eid = _project(c)
    meghna = ok(c.post("/api/characters", headers=H, json={"name": "Meghna", "project_id": pid}))["id"]
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [{"title": "Porch", "shots": [
        {"prompt": "Meghna at the gate.", "duration_s": 6,
         "lines": [{"speaker": meghna, "text": "It still works."}, {"speaker": "VO", "text": "It always had."}]}]}]}))
    with SessionLocal() as db:
        user = db.query(User).first()
        shot = _shots(db, eid)[0]
        _take(db, shot, "video", user, secs=6.0)
        voice = _take(db, shot, "voice", user, lang="en", secs=2.3,
                      spans=[{"text": "It still works.", "character_id": meghna, "start": 0.3, "end": 2.1}])
        _take(db, shot, "narration", user, lang="en", secs=2.0,
              spans=[{"text": "It always had.", "character_id": "NARRATOR", "start": 0.2, "end": 1.8}])
        db.commit()
        ep = db.get(Episode, eid)
        sg = assembler.plan(db, ep, "en", "final", get_storage().tmp_dir(), {"ambience": False})[0][0]
        narr = [e for e in sg.extra_audio if "/narration/" in e[3]]
        assert narr[0][1] == 2.2  # after the last word (2.1 s), not at 0 under the character's line
        assert sg.cues[0][0] == 0.3 and min(c_[0] for c_ in sg.cues if "always" in c_[2]) == 2.4
        assert abs(sg.duration - 6.0) < 0.01
        # lip-synced with the voice sped up 1.25x: the captions and the narration follow the faster words
        _take(db, shot, "lipsync", user, lang="en", secs=6.0, speed_factor=1.25, voice_take_id=voice.id)
        db.commit()
        sg = assembler.plan(db, ep, "en", "final", get_storage().tmp_dir(), {"ambience": False})[0][0]
        assert sg.source_kind == "lipsync" and sg.cues[0][0] == 0.24  # 0.3 s into the voice, 1.25x faster
        assert abs(max(e for s_, e, t in sg.cues if "works" in t) - 2.1 / 1.25) < 0.01
        assert [e[1] for e in sg.extra_audio if "/narration/" in e[3]] == [round(2.1 / 1.25 + 0.1, 3)]


# ── 3 + 11. no speech cut, no clip longer than planned ───────────────────────

def test_clips_play_as_planned_and_words_are_never_cut(client: TestClient):
    c = client
    pid, eid = _project(c)
    nanda = ok(c.post("/api/characters", headers=H, json={"name": "Nanda", "project_id": pid}))["id"]
    line = [{"speaker": nanda, "text": "Bring the lamp inside before the rain."}]
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [{"title": "Yard", "shots": [
        {"prompt": "Rain clouds.", "duration_s": 4},
        {"prompt": "The yard, wider.", "duration_s": 8, "extend_to": 15},
        {"prompt": "Nanda calls out.", "duration_s": 4, "lines": line},
        {"prompt": "Nanda again.", "duration_s": 4, "lines": line},
        {"prompt": "Nanda, lip-synced.", "duration_s": 4, "lines": line}]}]}))
    with SessionLocal() as db:
        user = db.query(User).first()
        clouds, wide, laid, short, lips = _shots(db, eid)
        _take(db, clouds, "video", user, secs=8.0)  # Veo made 8 s for a 4 s shot
        _take(db, wide, "video", user, secs=15.4)  # extended
        _take(db, laid, "video", user, secs=8.0)
        _take(db, laid, "voice", user, lang="en", secs=6.0)
        _take(db, short, "video", user, secs=4.0)
        _take(db, short, "voice", user, lang="en", secs=6.0)
        _take(db, lips, "video", user, secs=8.0)
        _take(db, lips, "lipsync", user, lang="en", secs=8.0,
              spans=[])  # no voice take: the words are estimated from the line
        db.commit()
        segs, warnings = assembler.plan(db, db.get(Episode, eid), "en", "final", get_storage().tmp_dir(), {"ambience": False})
        dur = {sg.shot.id: round(sg.duration, 2) for sg in segs}
        assert dur[clouds.id] == 4.0 and dur[wide.id] == 15.0  # trimmed to the plan (the extension's length)
        assert dur[laid.id] == 6.2  # the voice needs more than 4 s: more of the clip plays, nothing held
        assert dur[short.id] == 6.2  # past the 4 s clip: its last frame is held until the words end
        expect = 0.3 + 7 / 2.5 + 0.2  # seven words at English pace, the lead-in and a tail
        assert abs(dur[lips.id] - max(4.0, expect)) < 0.01
        held = [w for w in warnings if "last frame is held" in w]
        assert len(held) == 1 and held[0].startswith(f"{short.code}: the voice runs 6.2s and the clip 4.0s")


def test_line_length_follows_the_language():
    line = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen"
    ten = " ".join(line.split()[:10])

    def draft():
        return {"scenes": [{"title": "Hut", "shots": [{"prompt": "a", "lines": [{"speaker": "Ravi", "text": ten}], "duration_s": 4},
                                                       {"prompt": "b", "lines": [{"speaker": "Ravi", "text": line}], "duration_s": 8}]}]}
    en, kn = draft(), draft()
    assert script_import.fit_lengths(en, "en") == []  # 17 words at 2.5 a second fit 8 s
    assert [sh["duration_s"] for sh in en["scenes"][0]["shots"]] == [6, 8]
    warnings = script_import.fit_lengths(kn, "kn")  # Kannada says fewer words a second
    assert [sh["duration_s"] for sh in kn["scenes"][0]["shots"]] == [8, 8]
    assert warnings == ["Dialogue too long for one 8-second clip in Hut, shot 2 (about 10s): split it or shorten it."]


# ── 4. no made-up speech ─────────────────────────────────────────────────────

def test_dialogue_without_a_voice_plays_the_background_not_the_clip(client: TestClient):
    c = client
    pid, eid = _project(c)
    oviya = ok(c.post("/api/characters", headers=H, json={"name": "Oviya", "project_id": pid}))["id"]
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [{"title": "Shed", "shots": [
        {"prompt": "Rain on the shed.", "duration_s": 4},
        {"prompt": "Oviya speaks.", "duration_s": 4, "lines": [{"speaker": oviya, "text": "Stay dry."}]}]}]}))
    st = get_storage()
    tmp = st.tmp_dir()
    with SessionLocal() as db:
        user = db.query(User).first()
        rain, talk = _shots(db, eid)
        _take(db, rain, "video", user, _clip(tmp / "rain.mp4", 3.0))
        _take(db, talk, "video", user, _clip(tmp / "talk.mp4", 3.0))
        db.commit()
        project = db.get(Project, pid)
        segs, warnings = assembler.plan(db, db.get(Episode, eid), "en", "final", tmp, {"ambience": True})
        sg = segs[1]
        assert sg.keep_src_audio is False and sg.needs_bed and not sg.own_sound
        assert [e[3].split("/")[2] for e in sg.extra_audio] == ["ambience"]  # the scene's rain instead
        assert any(w.startswith(f"{talk.code}: no en voice yet: the clip's own sound is left out") for w in warnings)
        # the clip itself is asked for moving mouths, not words (its real voice comes later)
        assert "no music, no narration; no audible speech; mouths move naturally." in audio_block(None, talk, "audio_first")
        assert "no audible speech" not in audio_block(None, talk, "native")
        assert "no audible speech" not in audio_block(None, rain, "audio_first")  # nobody speaks there
        assert "no audible speech" in compile_video_prompt(db, talk, project)


# ── 5. the scene before carries what people wear and hold, not its night ─────

def test_carry_over_keeps_outfits_and_props_not_the_time(client: TestClient):
    c = client
    pid, eid = _project(c)
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [
        {"title": "Night", "location": "Paddy hut", "time_of_day": "night", "shots": [{"prompt": "a", "duration_s": 4}]},
        {"title": "Later", "location": "Paddy hut", "shots": [{"prompt": "b", "duration_s": 4}]},
        {"title": "Field", "location": "Rice field", "shots": [{"prompt": "c", "duration_s": 4}]},
        {"title": "Dawn", "location": "Paddy hut", "time_of_day": "dawn", "shots": [{"prompt": "d", "duration_s": 4}]}]}))
    with SessionLocal() as db:
        first, later, field, dawn = db.query(Scene).filter(Scene.episode_id == eid).order_by(Scene.order).all()
        first.end_state = {"characters": {"1": {"name": "Ravi", "outfit": "wet kurta", "state": "holding the lamp"}},
                           "props": ["oil lamp"], "time_of_day": "night", "weather": "heavy rain", "notes": "door left open"}
        db.commit()
        same = continuity.state_text(db, later)
        assert same == ("Ravi: wet kurta, holding the lamp; props: oil lamp; time of day: night; weather: heavy rain; "
                        "notes: door left open")
        for sc in (field, dawn):  # another place, or a time of its own: its own light and sky
            assert continuity.state_text(db, sc) == "Ravi: wet kurta, holding the lamp; props: oil lamp; notes: door left open"


# ── 6. outfit lines ──────────────────────────────────────────────────────────

WARDROBE_SCRIPT = """WARDROBE: Tharun Kumar – white kurta, brown shawl; Revathi (red silk saree)

SCENE 1: INT. HUT - NIGHT
VISUAL: Tharun and Revathi eat in silence.
THARUN: The rice is good.

SCENE 2: EXT. FIELD - DAWN
OUTFIT:
Revathi – green cotton saree, hair tied up
VISUAL: Revathi walks the field.
REVATHI: The rain is over.
"""


def test_wardrobe_lines_dress_the_scenes(client: TestClient):
    draft = script_import.parse_marked(WARDROBE_SCRIPT)
    hut, field = draft["scenes"]
    assert hut["wardrobe"] == {"Tharun": "white kurta, brown shawl", "Revathi": "red silk saree"}  # (the name the lines use)
    assert field["wardrobe"] == {"Tharun": "white kurta, brown shawl", "Revathi": "green cotton saree, hair tied up"}
    assert all("WARDROBE" not in sh["prompt"] and "saree" not in sh["prompt"] for sc in draft["scenes"] for sh in sc["shots"])
    c = client
    pid, eid = _project(c)
    out = ok(c.post(f"/api/episodes/{eid}/import/parse", headers=H, data={"text": WARDROBE_SCRIPT}))
    res = ok(c.post(f"/api/episodes/{eid}/import/apply", headers=H, json={"draft": out["draft"], "mapping": {}}))
    tharun, revathi = res["characters"]["Tharun"], res["characters"]["Revathi"]
    with SessionLocal() as db:
        scenes = db.query(Scene).filter(Scene.episode_id == eid).order_by(Scene.order).all()
        assert scenes[1].wardrobe == {str(tharun): "white kurta, brown shawl", str(revathi): "green cotton saree, hair tied up"}
        walk = next(s for s in _shots(db, eid) if s.scene_id == scenes[1].id)
        assert "In this scene Revathi wears: green cotton saree, hair tied up." in compile_video_prompt(db, walk, db.get(Project, pid))
    # a board save that doesn't send the wardrobe keeps it
    b = ok(c.get(f"/api/episodes/{eid}/board"))
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json=b))
    with SessionLocal() as db:
        assert db.query(Scene).filter(Scene.episode_id == eid).order_by(Scene.order).all()[0].wardrobe[str(revathi)] == "red silk saree"


def test_ai_arranged_scripts_carry_outfits_and_off_screen_lines(client: TestClient, monkeypatch):
    from app.core import studio
    out = S.ImportOut(scenes=[S.ImportScene(title="Hut", wardrobe=["Tharun: white kurta", "Revathi: red saree"], shots=[
        S.ImportShot(prompt="Revathi listens.", characters=["Revathi"],
                     lines=[S.ImportLine(speaker="Tharun", text="Open up!", off_screen=True),
                            S.ImportLine(speaker="Narrator", text="He was back.", off_screen=True)])])])
    monkeypatch.setattr(studio, "_llm", lambda *a, **k: out)
    pid, _ = _project(client)
    with SessionLocal() as db:
        draft = script_import.ai_arrange(db, db.query(User).first(), db.get(Project, pid), "a script")
    sc = draft["scenes"][0]
    assert sc["wardrobe"] == {"Tharun": "white kurta", "Revathi": "red saree"}
    assert sc["shots"][0]["lines"] == [{"speaker": "Tharun", "text": "Open up!", "emotion": "", "off_screen": True},
                                       {"speaker": "VO", "text": "He was back.", "emotion": ""}]
    assert "wardrobe" in S.ImportScene.model_json_schema()["properties"]


# ── 7. characters the script doesn't describe ────────────────────────────────

def test_undescribed_characters_get_a_first_look_and_a_warning(client: TestClient):
    assert script_import.starting_look("Ravi", "35", "male") == "Ravi: a 35-year-old man"
    assert script_import.starting_look("Ajji", "70s", "female") == "Ajji: a woman in her 70s"
    assert script_import.starting_look("Tia", "8", "female") == "Tia: an 8-year-old girl"
    assert script_import.starting_look("Sam", "", "") == "" and script_import.starting_look("Kit", "", "male") == "Kit: a man"
    c = client
    pid, eid = _project(c)
    ok(c.post("/api/characters", headers=H, json={"name": "Selvan", "project_id": pid,
                                                   "dna_text": "Selvan: 50, thin, round glasses"}))
    text = "SCENE 1: INT. SHOP - DAY\nVISUAL: Mallika counts coins.\nMALLIKA: Not enough.\nSELVAN: Never is.\nAPPA: Enough!\n"
    out = ok(c.post(f"/api/episodes/{eid}/import/parse", headers=H, data={"text": text}))
    bare = [w for w in out["warnings"] if w.startswith("The script doesn't describe")]
    assert bare == ["The script doesn't describe Mallika, Appa: add a photo or a line about them, or every keyframe makes "
                    "up their face (they start from their name, age and gender)."]  # Selvan has a look already
    for ch in out["draft"]["cast"]:
        if ch["name"] == "Mallika":
            ch.update(gender="female", age="35")  # what the wizard knows of her
    res = ok(c.post(f"/api/episodes/{eid}/import/apply", headers=H, json={"draft": out["draft"], "mapping": {}}))
    with SessionLocal() as db:
        assert db.get(Character, res["characters"]["Mallika"]).dna_text == "Mallika: a 35-year-old woman"
        assert db.get(Character, res["characters"]["Appa"]).dna_text == "Appa: a man"  # a kinship name says who
        assert db.get(Character, res["characters"]["Selvan"]).dna_text == "Selvan: 50, thin, round glasses"


# ── 8. sound effects only where the clip's own sound is gone ─────────────────

def test_sound_effects_never_double_the_clips_own(client: TestClient):
    c = client
    pid, eid = _project(c)
    kavin = ok(c.post("/api/characters", headers=H, json={"name": "Kavin", "project_id": pid}))["id"]
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [{"title": "Well", "sound": "heavy rain", "shots": [
        {"prompt": "Rain on the well.", "duration_s": 4, "sfx": "a bucket clanks"},
        {"prompt": "Kavin speaks.", "duration_s": 4, "sfx": "a bucket clanks",
         "lines": [{"speaker": kavin, "text": "Fetch the rope."}]},
        {"prompt": "The rope.", "duration_s": 4, "sfx": "a bucket clanks"},
        {"prompt": "No clip yet.", "duration_s": 4, "sfx": "a bucket clanks"}]}]}))
    st = get_storage()
    tmp = st.tmp_dir()
    with SessionLocal() as db:
        user = db.query(User).first()
        own, synced, silent, still = _shots(db, eid)
        _take(db, own, "video", user, _clip(tmp / "own.mp4", 2.0))
        _take(db, synced, "video", user, _clip(tmp / "talk.mp4", 2.0))
        _take(db, synced, "lipsync", user, _clip(tmp / "lips.mp4", 2.0), lang="en")
        _take(db, silent, "video", user, _clip(tmp / "mute.mp4", 2.0, noise=None))
        db.commit()
        project, ep = db.get(Project, pid), db.get(Episode, eid)
        assert [generation.keeps_clip_sound(db, project, s) for s in (own, synced, silent, still)] == [True, False, False, False]
        spec, n = generation.sound_step(db, project, ep, _shots(db, eid))
        assert n == 3 and spec["payload"]["shot_ids"] == [synced.id, silent.id, still.id]
    # Produce all's sound step and a run for the episode make no effects for the clip that keeps its own sound
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "produce", "steps": ["sound"]}))
    done = wait_jobs(c, pid, timeout=300)
    assert all(j["status"] == "succeeded" for j in done), [(j["type"], j["error"]) for j in done]
    with SessionLocal() as db:
        tracks = [s.sfx_track or {} for s in _shots(db, eid)]
        assert [bool(t.get("path")) for t in tracks] == [False, True, True, True]
        assert not any(t.get("over_clip") for t in tracks)
    # picked by name, it is made anyway, to go over the clip's own sound
    ok(c.post(f"/api/episodes/{eid}/sfx", headers=H, json={"shot_ids": [own.id]}))
    done = wait_jobs(c, pid, timeout=300)
    assert all(j["status"] == "succeeded" for j in done), [(j["type"], j["error"]) for j in done]
    with SessionLocal() as db:
        own_db = db.get(Shot, own.id)
        assert own_db.sfx_track["over_clip"] is True
        # the export mirrors it: an older track over a clip that keeps its sound stays out, with a warning
        legacy = dict(own_db.sfx_track)
        legacy.pop("over_clip")
        own_db.sfx_track = legacy
        db.commit()
        ep = db.get(Episode, eid)
        segs, warnings = assembler.plan(db, ep, "en", "final", tmp, {"ambience": False, "sfx": True})
        timed, _, _ = assembler.timeline(segs, True, True)
        sfx_in = [any("/sfx/" in e[3] for e in tm.sg.extra_audio) for tm in timed]
        assert sfx_in == [False, True, True, True]
        assert any(w.startswith(f"{own.code}: their sound effects stay out of the mix") for w in warnings)
        own_db.sfx_track = {**legacy, "over_clip": True}
        db.commit()
        segs, warnings = assembler.plan(db, ep, "en", "final", tmp, {"ambience": False, "sfx": True})
        timed, _, _ = assembler.timeline(segs, True, True)
        assert any("/sfx/" in e[3] for e in timed[0].sg.extra_audio)
        assert not [w for w in warnings if "stay out of the mix" in w]


# ── 9. the music ducks under the voices only ─────────────────────────────────

def _window(path: Path, start: float, secs: float, out: Path) -> float | None:
    ff.run(["-ss", f"{start}", "-t", f"{secs}", "-i", path, out])
    return ff.loudness(out)


def test_music_ducks_under_voices_not_under_the_rain(tmp_path: Path):
    voice = ff.write_tone_wav(tmp_path / "voice.wav", 2.0, freq=180)
    seg = lambda voices: types.SimpleNamespace(voices=voices)  # noqa: E731
    timed = [assembler.Timed(seg([(voice, 0.5, 0.0)]), {}, 1.0, 3.0, 0.0, None),
             assembler.Timed(seg([]), {}, 1.0, 3.0, 3.0, None)]
    track = assembler.voice_track(timed, 6.0, tmp_path / "voices.wav")
    assert abs(ff.duration(track) - 6.0) < 0.05
    assert _window(track, 0.6, 1.8, tmp_path / "a.wav") is not None and _window(track, 3.2, 2.5, tmp_path / "b.wav") is None
    assert assembler.voice_track(timed[1:], 6.0, tmp_path / "none.wav") is None  # no voices: nothing to duck for

    music = ff.write_tone_wav(tmp_path / "music.wav", 6.0, freq=220, volume=0.3, syllables=False)
    rain = tmp_path / "rain.wav"
    ff.run(["-f", "lavfi", "-i", "anoisesrc=c=pink:a=0.2:d=6", rain])
    keyed_on_voices = ff.music_bed(music, rain, tmp_path / "m1.wav", 6.0, volume_db=0.0, duck=True, sidechain=track)
    keyed_on_mix = ff.music_bed(music, rain, tmp_path / "m2.wav", 6.0, volume_db=0.0, duck=True, sidechain=rain)  # how it was
    # over the stretch with rain and no voice the music holds its level (keyed on the whole mix it dipped there too);
    # it still dips under the voice
    rain_only = _window(keyed_on_voices, 3.2, 2.0, tmp_path / "w1.wav")
    assert rain_only > _window(keyed_on_mix, 3.2, 2.0, tmp_path / "w2.wav") + 2
    assert _window(keyed_on_voices, 0.8, 1.5, tmp_path / "w3.wav") < rain_only - 3
    # without ducking the cut's own sound is still in the mix (it used to come out as the music alone)
    alone = ff.music_bed(music, None, tmp_path / "m3.wav", 6.0, duck=False)
    assert ff.loudness(ff.music_bed(music, rain, tmp_path / "m4.wav", 6.0, duck=False)) > ff.loudness(alone) + 3


# ── 12. square films ─────────────────────────────────────────────────────────

def test_square_films_get_wide_clips(client: TestClient):
    c = client
    pid, eid = _project(c, aspect="1:1")
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [{"title": "One", "shots": [
        {"prompt": "A brass lamp on a table.", "duration_s": 4}]}]}))
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "videos"}))
    done = wait_jobs(c, pid, timeout=300)
    assert all(j["status"] == "succeeded" for j in done), [(j["type"], j["error"]) for j in done]
    with SessionLocal() as db:
        video = db.query(Take).filter(Take.shot_id == _shots(db, eid)[0].id, Take.kind == "video").one()
        w, h = ff.video_size(get_storage().abs(video.path))
    assert w > h  # 16:9, cropped to the square around the face by the export (not a tall 9:16 clip)


# ── 13. one failed scene piece doesn't cost the film its music ───────────────

def test_music_per_scene_keeps_the_pieces_that_worked(client: TestClient, monkeypatch):
    import app.providers.services as services
    from app.providers.base import ProviderBlocked
    c = client
    pid, eid = _project(c)
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [
        {"title": "Hut", "mood": "quiet", "shots": [{"prompt": "The lamp.", "duration_s": 4}]},
        {"title": "Field", "mood": "hopeful", "shots": [{"prompt": "Dawn.", "duration_s": 4}]}]}))
    real = services.Services.music

    def music(self, prompt: str, seconds: float):
        if "Scene 2:" in prompt:
            raise ProviderBlocked("the prompt was blocked")
        return real(self, prompt, seconds)
    monkeypatch.setattr(services.Services, "music", music)
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "music", "music_per_scene": True}))
    done = wait_jobs(c, pid, timeout=300)
    job = next(j for j in done if j["type"] == "music")
    assert job["status"] == "succeeded", job["error"]
    assert job["result"]["failed"] == ["Field"] and job["result"]["cues"] == 1
    assert job["result"]["warnings"][0].startswith("No music for Field (the prompt was blocked): those scenes are silent")
    with SessionLocal() as db:
        ep = db.get(Episode, eid)
        hut = db.query(Scene).filter(Scene.episode_id == eid).order_by(Scene.order).first()
        assert ep.settings["music_mode"] == "scenes"
        assert [a.params["scene_id"] for a in db.query(AudioAsset).filter(AudioAsset.episode_id == eid).all()] == [hut.id]
        assert db.get(Job, job["id"]).result["music_scene_assets"]  # a retry would not pay for it again


# ── 14. every clip and voice meets the mix at one loudness ───────────────────

def test_clip_sound_and_voices_are_levelled_before_the_mix(tmp_path: Path):
    quiet, loud, faint = tmp_path / "quiet.wav", tmp_path / "loud.wav", tmp_path / "faint.wav"
    for f, a in ((quiet, 0.15), (loud, 0.9), (faint, 0.03)):  # about -31, -15 and -45 LUFS
        ff.run(["-f", "lavfi", "-i", f"anoisesrc=c=pink:a={a}:d=3", f])
    for f in (quiet, loud):
        gain = ff.level_db(f, ff.CLIP_LUFS)
        levelled = tmp_path / f"lv_{f.name}"
        ff.run(["-i", f, "-af", f"volume={gain}dB", levelled])
        assert abs(ff.loudness(levelled) - ff.CLIP_LUFS) < 1.0, (f.name, gain)
    assert ff.level_db(faint, ff.CLIP_LUFS) == 12.0  # lifted at most 12 dB
    assert ff.level_db(ff.silence_wav(tmp_path / "silent.wav", 2.0), ff.CLIP_LUFS) == 0.0  # never pumped into hiss
    assert ff.level_db(tmp_path / "missing.wav", ff.CLIP_LUFS) == 0.0
    # a segment: its clip at the clip level, its narration at the voice level, the scene's bed as it was made
    clip = _clip(tmp_path / "clip.mp4", 2.0, noise=0.6)
    narr = ff.write_tone_wav(tmp_path / "narr.wav", 1.5, volume=0.05)
    sg = assembler.Segment(types.SimpleNamespace(), clip, "video", 2.0, extra_audio=[(narr, 0.5, 0.0, "n"), (loud, 0.0, -14.0, "bed")],
                           own_sound=True, voices=[(narr, 0.5, 0.0)])
    src, over, extra = assembler.segment_levels(sg)
    assert src == ff.level_db(clip, ff.CLIP_LUFS) and src < 0 and over == 0.0
    assert extra[0][2] == ff.level_db(narr, ff.VOICE_LUFS) > 0 and extra[1] == (loud, 0.0, -14.0, "bed")


# ── 15. one project's cast only ──────────────────────────────────────────────

def test_pronunciations_and_continuity_read_the_projects_cast(client: TestClient):
    c = client
    pid, eid = _project(c)
    other, _ = _project(c)
    ok(c.post("/api/characters", headers=H, json={"name": "Jothi", "name_pronunciation": "JOH-thee", "project_id": pid}))
    ok(c.post("/api/characters", headers=H, json={"name": "Kumaran", "name_pronunciation": "KOO-ma-run", "project_id": other}))
    mine = ok(c.post("/api/characters", headers=H, json={"name": "Velan", "project_id": pid}))["id"]
    theirs = ok(c.post("/api/characters", headers=H, json={"name": "Velan", "project_id": other}))["id"]  # made later
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [{"title": "Gate", "shots": [
        {"prompt": "Velan waits.", "duration_s": 4, "characters": [mine]}]}]}))
    with SessionLocal() as db:
        project = db.get(Project, pid)
        assert voice_mod.say(db, project, "Jothi and Kumaran") == "JOH-thee and Kumaran"
        scene = db.query(Scene).filter(Scene.episode_id == eid).one()
        scene.wardrobe = {str(mine): "blue shirt"}
        db.commit()
        state = continuity.end_state(db, db.query(User).first(), project, db.get(Episode, eid), scene)
        assert list(state["characters"]) == [str(mine)] and str(theirs) not in state["characters"]
