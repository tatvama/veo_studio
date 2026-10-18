"""The flow's wiring (mock providers, local FFmpeg): problems you can act on, "Try another engine" for any failed shot,
"Quick draft first" (a 480p draft run, then the final film), Make it for me recipes, the desktop render plan's sound
(levelled like the server, music ducked under the voices alone) and a square film's clip edits.
"""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.core import desktop, generation, problems, recipes
from app.db import SessionLocal
from app.models import AudioAsset, Episode, Event, Export, Job, Project, Shot, Take
from app.pipeline import assembler
from app.pipeline import ffmpeg as ff
from app.providers.base import ProviderError
from app.storage import get_storage
from app.workers import handlers
from conftest import H, ok, wait_jobs
from test_fx import _clip


def _project(c: TestClient, **kw) -> tuple[int, int]:
    p = ok(c.post("/api/projects", headers=H, json={"concept": "The Lamp", "type": "short", "auto_brief": False,
                                                    "languages": ["en"], **kw}))
    return p["id"], p["episodes"][0]["id"]


def _shots(c: TestClient, eid: int, n: int = 2) -> list[int]:
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [
        {"title": "Hut", "shots": [{"prompt": f"The lamp, shot {i + 1}.", "duration_s": 4} for i in range(n)]}]}))
    with SessionLocal() as db:
        return [s.id for s in db.query(Shot).filter(Shot.episode_id == eid).order_by(Shot.order).all()]


def _job(db, pid: int, eid: int | None, sid: int | None, type_: str, status: str = "failed", **kw) -> Job:
    j = Job(type=type_, status=status, project_id=pid, episode_id=eid, shot_id=sid, label=kw.pop("label", type_), **kw)
    db.add(j)
    db.flush()
    return j


# ── problems you can act on ──────────────────────────────────────────────────

def test_problems_carry_their_one_click_fix_and_drop_off_once_fixed(client: TestClient):
    c = client
    pid, eid = _project(c)
    a, b = _shots(c, eid)
    with SessionLocal() as db:
        jv = _job(db, pid, eid, a, "video", error="Blocked by safety filter: Veo blocked the video: weapons. Next: soften.")
        jvo = _job(db, pid, eid, b, "voice", error="Request timed out")
        jm = _job(db, pid, eid, None, "music", error="Resource exhausted (quota)")
        jk = _job(db, pid, eid, b, "keyframe", error="ffmpeg failed (1): boom")
        db.commit()
        ids = [jv.id, jvo.id, jm.id, jk.id]
    r = problems.RunProblems()
    assert r.children({i: "failed" for i in ids} | {10**9: "succeeded"}, "Videos") == 1
    got = [(p["shot_id"], p["action"], p["kind"], p["job_id"]) for p in r.items]
    assert got == [(a, "engine", "video", ids[0]), (b, "voice", "voice", ids[1]), (None, "continue", "", ids[2]),
                   (b, "retry", "picture", ids[3])]
    assert r.items[0]["reason"].startswith("A safety filter blocked it") and "another engine" in r.items[0]["next"]
    # a budget stop and a skipped export: press Make it for me again; a shot's note: open it
    assert problems.export_skipped([])["action"] == "continue"
    with SessionLocal() as db:
        assert problems.problem(db.get(Shot, a), "Voices first", "The lines run 9 s", "Split the shot")["action"] == "open"
    problems.save(pid, eid, r.items, "produce", 1, announce=False)

    canvas = ok(c.get(f"/api/episodes/{eid}/canvas"))
    assert [p["job_id"] for p in canvas["run_problems"]] == ids
    vid = canvas["shots"][str(a)]["problems"]["video"]
    assert vid["blocked"] is True and vid["reason"].startswith("A safety filter blocked it") and vid["job_id"] == ids[0]
    assert canvas["shots"][str(b)]["problems"]["voice"]["blocked"] is False
    assert [p["job_id"] for p in ok(c.get(f"/api/episodes/{eid}/board"))["run_problems"]] == ids

    # the shot's video made since (another engine): its problem drops off; a 480p draft doesn't count as the fix
    with SessionLocal() as db:
        _job(db, pid, eid, a, "video", status="succeeded", payload={"draft": True})
        db.commit()
    assert [p["job_id"] for p in ok(c.get(f"/api/episodes/{eid}/canvas"))["run_problems"]] == ids
    with SessionLocal() as db:
        _job(db, pid, eid, a, "video", status="succeeded", payload={"engine": "x"})
        db.commit()
    assert [p["job_id"] for p in ok(c.get(f"/api/episodes/{eid}/canvas"))["run_problems"]] == ids[1:]
    # a shot taken out of the cut: its problems go too (the music's stays)
    ok(c.patch(f"/api/shots/{b}", headers=H, json={"include": False}))
    assert [p["job_id"] for p in ok(c.get(f"/api/episodes/{eid}/board"))["run_problems"]] == [ids[2]]


# ── try another engine, for any failed shot ──────────────────────────────────

def test_try_another_engine_after_any_failure(client: TestClient):
    c = client
    pid, eid = _project(c)
    sid, = _shots(c, eid, 1)
    before = ok(c.get(f"/api/shots/{sid}/alternatives?purpose=recover"))
    assert before["failed"] is None and before["blocked"] is None and len(before["options"]) >= 2
    failed_engine = before["options"][0]["id"]
    with SessionLocal() as db:
        _job(db, pid, eid, sid, "video", error="It took too long and was given up",
             result={"attempts": [{"engine": failed_engine, "mode": "i2v", "error": "timed out"},
                                  {"engine": "x:held", "mode": "i2v", "error": "rate limited, held back 30s"}]})
        db.commit()
    shot = ok(c.get(f"/api/shots/{sid}"))
    assert shot["failed"]["engines"] == [failed_engine] and shot["failed"]["blocked"] is False and shot["blocked"] is None
    alt = ok(c.get(f"/api/shots/{sid}/alternatives?purpose=recover"))
    others = [o["id"] for o in alt["options"]]
    assert alt["failed"]["job_id"] and failed_engine not in others and others
    pick = alt["options"][-1]
    # priced first (POST /api/estimate), then run for this shot only, on the engine picked by hand
    est = ok(c.post("/api/estimate", headers=H, json={"action": "recover", "shot_id": sid, "engine": pick["id"]}))
    assert est["count"] == 1 and pick["display_name"] in est["items"][0]["label"] and "budget" in est
    assert ok(c.post("/api/estimate", headers=H, json={"action": "draft", "shot_id": sid}))["items"][0]["label"].startswith("Draft")
    bad = c.post("/api/estimate", headers=H, json={"action": "recover", "shot_id": sid, "engine": failed_engine})
    assert bad.status_code == 400 and "can't make this shot" in bad.json()["detail"]
    out = ok(c.post(f"/api/shots/{sid}/recover", headers=H, json={"engine": pick["id"]}))
    payload = out["jobs"][0]["payload"]
    assert payload["engine"] == pick["id"] and payload["skip_engines"] == [failed_engine] and payload["recovery"] is True
    wait_jobs(c, pid, timeout=120)
    shot = ok(c.get(f"/api/shots/{sid}"))
    assert shot["failed"] is None and shot["video"]["params"]["engine"] == pick["id"]


# ── quick draft first ────────────────────────────────────────────────────────

def test_quick_draft_run_then_the_final_film(client: TestClient):
    c = client
    pid, eid = _project(c)
    sids = _shots(c, eid)
    body = {"action": "produce", "steps": ["keyframes", "videos", "extend", "export"], "draft": True}
    est = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json=body))
    labels = [i["label"] for i in est["items"]]
    drafts = next(x for x in labels if x.startswith("Draft videos 480p on "))  # it names the engine it picked
    assert drafts.endswith(" · 2") and "Draft render · 1" in labels
    assert not [x for x in labels if x.startswith(("Extensions", "Videos", "QC checks", "Automatic retakes"))]
    full = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={**body, "draft": False}))
    assert "Videos · 2" in [i["label"] for i in full["items"]]

    out = ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json=body))
    assert out["jobs"][0]["payload"]["draft"] is True and out["jobs"][0]["label"].startswith("Quick draft")
    jobs_ = wait_jobs(c, pid, timeout=300)
    prod = next(j for j in jobs_ if j["type"] == "produce")
    assert prod["status"] == "succeeded", prod["error"]
    assert prod["result"]["draft"] is True and prod["result"]["problems"] == [] and "extend" not in prod["result"]["steps"]
    videos = [j for j in jobs_ if j["type"] == "video"]
    assert len(videos) == 2 and all(j["payload"]["draft"] and j["payload"]["engine"] for j in videos)
    assert not [j for j in jobs_ if j["type"] == "qc"]  # a draft gets no quality check
    with SessionLocal() as db:
        shots = db.query(Shot).filter(Shot.id.in_(sids)).all()
        for s in shots:
            v = db.query(Take).filter(Take.shot_id == s.id, Take.kind == "video").one()
            assert v.params["draft"] is True and v.params["resolution"] == "480p"
        # a draft is no final clip: the final film's export counts it as a gap; the draft render doesn't
        assert len(problems.missing_videos(db, shots)) == 2 and problems.missing_videos(db, shots, drafts_ok=True) == []
        ex = db.query(Export).filter(Export.episode_id == eid).one()
        assert ex.kind == "draft" and ex.status == "ready" and ex.preset == "draft" and ex.options.get("draft") is True
        ev = db.query(Event).filter(Event.project_id == pid, Event.type == "run.finished").order_by(Event.id.desc()).first()
        assert ev.payload["draft"] is True
    # nothing left to draft; the final film makes both clips (the drafts are kept in the takes)
    again = c.post(f"/api/episodes/{eid}/estimate", headers=H, json={**body, "steps": ["videos"]})
    assert again.status_code == 200 and again.json()["count"] == 0
    final = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "produce", "steps": ["videos"]}))
    assert [i["label"] for i in final["items"]][0] == "Videos · 2"


def test_quick_draft_needs_an_engine_that_makes_480p(client: TestClient, monkeypatch):
    c = client
    pid, eid = _project(c)
    _shots(c, eid, 1)
    monkeypatch.setattr(generation, "draft_engine", lambda db, project, shot: None)
    r = c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "produce", "steps": ["videos"], "draft": True})
    assert r.status_code == 400 and "480p drafts" in r.json()["detail"]


# ── recipes ──────────────────────────────────────────────────────────────────

def test_recipes_built_in_and_saved_per_team(client: TestClient):
    c = client
    listed = ok(c.get("/api/recipes"))["recipes"]
    built = [r for r in listed if r["builtin"]]
    assert [r["name"] for r in built] == ["Reels draft", "Full film, Hero quality", "Storyboard first"]
    assert built[0]["draft"] is True and built[1]["quality"] == "hero" and built[2]["steps"] == ["cast", "keyframes"]
    mine = ok(c.post("/api/recipes", headers=H, json={"name": "  Ad cut  ", "steps": ["export", "videos", "bogus"],
                                                      "quality": "balanced", "draft": True, "link_scenes": "never",
                                                      "music_per_scene": False}))
    assert mine["name"] == "Ad cut" and mine["steps"] == ["videos", "export"] and mine["id"].startswith("r_")
    same = ok(c.post("/api/recipes", headers=H, json={"name": "ad CUT", "steps": ["videos"], "quality": None}))
    assert same["id"] == mine["id"] and same["steps"] == ["videos"]  # the same name is replaced, not doubled
    assert c.post("/api/recipes", headers=H, json={"name": "Reels draft", "steps": ["videos"]}).status_code == 400
    assert c.post("/api/recipes", headers=H, json={"name": "Empty", "steps": []}).status_code == 400
    assert c.post("/api/recipes", headers=H, json={"name": "Odd", "steps": ["videos"], "quality": "ultra"}).status_code == 400
    team = [r for r in ok(c.get("/api/recipes"))["recipes"] if not r["builtin"]]
    assert [r["name"] for r in team] == ["ad CUT"]
    with SessionLocal() as db:
        assert [r["id"] for r in recipes.team(db)] == [mine["id"]]  # kept in the team setting, no table of its own
    ok(c.delete(f"/api/recipes/{mine['id']}", headers=H))
    assert c.delete("/api/recipes/builtin:reels-draft", headers=H).status_code == 404
    assert not [r for r in ok(c.get("/api/recipes"))["recipes"] if not r["builtin"]]


# ── the desktop render plan's sound matches the server mix ───────────────────

def _tone(out: Path, seconds: float, volume: float) -> Path:
    ff.run(["-f", "lavfi", "-i", f"sine=frequency=330:duration={seconds}", "-af", f"volume={volume}", out])
    return out


def test_desktop_plan_levels_the_sound_and_ducks_under_the_voices(client: TestClient):
    c = client
    pid, eid = _project(c)
    a, b = _shots(c, eid)
    st = get_storage()
    tmp = st.tmp_dir()
    with SessionLocal() as db:
        for sid, color in ((a, "red"), (b, "blue")):
            rel = st.save_file(st.new_path(f"projects/{pid}/shots/{sid}/video", "mp4"), _clip(f"fw_{color}", color))
            db.add(Take(shot_id=sid, kind="video", provider="upload", path=rel, duration_s=2.0, status="ready", selected=True))
        shot = db.get(Shot, a)
        shot.dialogue = {"en": [{"character_id": None, "line": "Who is there?"}]}
        shot.voice_mode = "audio_first"  # the studio voice over the clip (a one-language short would let Veo speak it)
        voice = st.save_file(st.new_path(f"projects/{pid}/shots/{a}/voice", "wav"), _tone(tmp / "voice.wav", 1.5, 0.05))
        db.add(Take(shot_id=a, kind="voice", language="en", provider="gemini", path=voice, duration_s=1.5, status="ready",
                    selected=True))
        music = st.save_file(st.new_path(f"projects/{pid}/music", "wav"), _tone(tmp / "music.wav", 6, 0.3))
        db.add(AudioAsset(project_id=pid, episode_id=eid, kind="music", path=music, duration_s=6, selected=True))
        db.commit()
        ep = db.get(Episode, eid)
        plan = desktop.render_plan(db, ep, "en", 320, 180)
        # the same levels the server render mixes at (assembler.segment_levels on the same cut)
        segs, _ = assembler.plan(db, ep, "en", "final", tmp, assembler.render_options(db, ep, {}))
        timed, _, _ = assembler.timeline(segs, True, True)
        for seg, tm in zip(plan["segments"], timed):
            src, over, extra = assembler.segment_levels(tm.sg)
            assert seg["src_gain_db"] == src and seg["override_gain_db"] == (over if tm.sg.audio_key else 0.0)
            assert [e["gain_db"] for e in seg["extra_audio"]] == [float(e[2]) if len(e) > 2 else 0.0 for e in extra]
        spoken = next(s for s in plan["segments"] if s["shot_id"] == a)
        voiced = spoken["override_gain_db"] or next((e["gain_db"] for e in spoken["extra_audio"] if e["key"] == voice), 0)
        assert voiced > 3  # a quiet voice is brought up to the speech level
        assert plan["audio_levels"] == {"levelled": True, "clip_lufs": ff.CLIP_LUFS, "voice_lufs": ff.VOICE_LUFS}
        side = plan["music"]["sidechain"]
        assert plan["music"]["duck"] is True and side in plan["keys"] and st.exists(side)
        assert abs(ff.duration(st.abs(side)) - plan["duration_s"]) < 0.2
        assert desktop.render_plan(db, ep, "en", 320, 180)["music"]["sidechain"] == side  # made once, kept in storage
        # no voices on the cut: nothing to duck under (the server mixes the music in level too)
        shot = db.get(Shot, a)
        shot.dialogue = {}
        db.commit()
        quiet = desktop.render_plan(db, ep, "en", 320, 180)["music"]
        assert quiet["sidechain"] is None and quiet["duck"] is False


# ── a square film's clip edits are wide, like its clips ──────────────────────

def test_square_film_edits_its_clips_wide(client: TestClient, monkeypatch):
    c = client
    pid, eid = _project(c, aspect="1:1")
    sid, = _shots(c, eid, 1)
    st = get_storage()
    with SessionLocal() as db:
        assert handlers.clip_aspect(db.get(Project, pid)) == "16:9"
        rel = st.save_file(st.new_path(f"projects/{pid}/shots/{sid}/video", "mp4"), _clip("fw_sq", "green"))
        t = Take(shot_id=sid, kind="video", provider="upload", path=rel, duration_s=2.0, status="ready", selected=True)
        db.add(t)
        db.commit()
        tid = t.id
    seen: list[str] = []

    def chain(ctx, name, modes, build, explicit=None, **kw):
        seen.append(build(None, "edit").aspect)
        raise ProviderError("stopped by the test")

    monkeypatch.setattr(handlers, "run_chain", chain)
    ok(c.post(f"/api/takes/{tid}/edit", headers=H, json={"instruction": "make it night"}))
    wait_jobs(c, pid, timeout=60)
    assert seen and seen[0] == "16:9"
