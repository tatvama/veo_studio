"""Long runs that say what went wrong, voices before videos, safer QC retakes and budget, redo after a character change
(mock providers, local FFmpeg).

Produce all / Autopilot / Scenes in order counted a failed child as done and finished "succeeded" with still pictures in
the export; shots were cut to their clip while their voice ran on; QC retook the video under a lip-sync and remade an
extension's base clip; the spend guard killed paid jobs mid-flight; a character's new look left their shots "fresh".
"""
from __future__ import annotations

import time
import types
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.agents import tools as T
from app.api.board import _match
from app.core import generation, jobs as jobs_core, problems, recovery
from app.core import scene_chain
from app.core.budget import Estimator
from app.db import SessionLocal, utcnow
from app.models import (Character, CharacterAsset, Costume, Episode, Event, Job, Location, LocationAsset, Project,
                        ProjectCast, Shot, Take, User)
from app.pipeline import ffmpeg as ff
from app.pipeline import selection
from app.pipeline.prompting import keyframe_refs, video_refs
from app.pipeline.voice import choose_duration
from app.providers import mock
from app.providers.base import ProviderBlocked, ProviderError, RetryableProviderError, Usage
from app.providers.services import Services
from app.providers.syncso import speaker_option
from app.storage import get_storage
from app.workers import handlers, handlers_room, runlog
from app.workers import worker as W
from conftest import H, ok, wait_jobs


def _project(c: TestClient, **kw) -> tuple[int, int]:
    p = ok(c.post("/api/projects", headers=H, json={"concept": "Run fixes", "type": "short", "auto_brief": False,
                                                    "languages": ["en"], **kw}))
    return p["id"], p["episodes"][0]["id"]


def _board(c: TestClient, eid: int, shots: list[dict], title: str = "One") -> list[int]:
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [{"title": title, "shots": shots}]}))
    return [s["id"] for s in ok(c.get(f"/api/episodes/{eid}/board"))["scenes"][0]["shots"]]


def _clip(out: Path, seconds: float) -> Path:
    ff.run(["-f", "lavfi", "-i", f"testsrc=size=320x180:rate=24:d={seconds}", "-f", "lavfi", "-i",
            f"sine=frequency=220:duration={seconds}", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out])
    return out


def _take(db, shot: Shot, kind: str, src: Path, lang: str | None = None, provider: str = "google", **params) -> Take:
    st = get_storage()
    rel = st.save_file(st.new_path(f"projects/test/{shot.id}/{kind}", src.suffix.lstrip(".")), src)
    t = Take(shot_id=shot.id, kind=kind, language=lang, provider=provider, path=rel, duration_s=ff.duration(src)
             if src.suffix in (".mp4", ".wav") else 0.0, selected=True, params=params)
    db.add(t)
    db.flush()
    return t


def _image(name: str) -> Path:
    out = get_storage().tmp_dir() / f"{name}.png"
    out.write_bytes(mock.image(name, "9:16", name))
    return out


def _user(db) -> User:
    return db.query(User).filter(User.role == "admin").first()


def _job(db, type_: str, project_id: int, shot_id: int | None = None, payload: dict | None = None, **kw) -> Job:
    j = Job(type=type_, status=kw.pop("status", "running"), project_id=project_id, shot_id=shot_id, payload=payload or {},
            requested_by=_user(db).id, label=kw.pop("label", type_), **kw)
    db.add(j)
    db.commit()
    return j


# ── plain words ──────────────────────────────────────────────────────────────

def test_errors_in_plain_words():
    r, n = problems.explain("Blocked by safety filter: Veo blocked the video: weapons. Next: soften it.")
    assert r.startswith("A safety filter blocked it") and "another engine" in n
    assert problems.explain("Rate limited on every engine that can do this; retrying in 60s.")[0] == \
        "The provider's quota ran out"
    assert problems.explain("No enabled engine for 'Lip-sync' that can do lipsync.")[0] == "No engine is connected for this"
    assert problems.explain("cancelled")[0] == "It was stopped before it finished"
    assert problems.explain("ffmpeg failed (1): boom")[0] == "ffmpeg failed (1): boom"


# ── 1. runs list their problems; no export with still pictures ───────────────

def test_produce_lists_failures_and_skips_the_export(client: TestClient, monkeypatch):
    c = client
    pid, eid = _project(c)
    good, bad = _board(c, eid, [{"prompt": "The lamp glows.", "duration_s": 4},
                                {"prompt": "The lamp flickers.", "duration_s": 4}])
    orig = W.HANDLERS["video"]

    def video(ctx):
        if ctx.shot_id == bad:
            raise ProviderBlocked("Veo blocked the video: weapons", provider="gemini")
        return orig(ctx)

    monkeypatch.setitem(W.HANDLERS, "video", video)
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "produce",
                                                               "steps": ["keyframes", "videos", "export"]}))
    jobs = wait_jobs(c, pid, timeout=600)
    prod = next(j for j in jobs if j["type"] == "produce")
    assert prod["status"] == "succeeded", prod["error"]
    found = prod["result"]["problems"]
    blocked = [p for p in found if p["shot_id"] == bad]
    assert blocked and blocked[0]["step"] == "Videos" and blocked[0]["reason"].startswith("A safety filter blocked it")
    assert "another engine" in blocked[0]["next"]
    assert any(p["step"] == "export" and p["reason"].startswith("Export skipped: 1 shot has no video") for p in found)
    assert not [j for j in jobs if j["type"] == "export"]  # no export with a still picture where a clip should be
    failed = next(j for j in jobs if j["type"] == "video" and j["shot_id"] == bad)
    assert failed["error"].startswith("Blocked by safety filter: Veo blocked the video: weapons.") and "Next:" in failed["error"]
    assert ok(c.get(f"/api/episodes/{eid}/board"))["run_problems"] == found  # the shot list shows them
    with SessionLocal() as db:
        ev = db.query(Event).filter(Event.project_id == pid, Event.type == "run.finished").order_by(Event.id.desc()).first()
        assert ev is not None and len(ev.payload["problems"]) == len(found) and ev.payload["episode_id"] == eid
    # the next run starts with a clean list
    monkeypatch.setitem(W.HANDLERS, "video", orig)
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "produce", "steps": ["videos", "export"]}))
    jobs = wait_jobs(c, pid, timeout=600)
    assert ok(c.get(f"/api/episodes/{eid}/board"))["run_problems"] == []
    assert [j for j in jobs if j["type"] == "export" and j["status"] == "succeeded"]


# ── 2. voices before videos, speech never cut ────────────────────────────────

def test_voices_come_first_and_time_the_shots(client: TestClient):
    c = client
    pid, eid = _project(c, languages=["hi"])  # Hindi: the studio voice first, lip-sync after the clip
    ravi = ok(c.post("/api/characters", headers=H, json={"name": "Ravi", "project_id": pid}))["id"]
    short_line = "Tonight the lamp moves again, and we follow it home."  # ~3.7 s
    vo = "Every evening the old lamp was lit before the first star, and the whole village gathered under it " \
         "to tell the stories their grandparents told them long ago, again and again."  # ~13 s
    long_line = "I have waited all my life for this one night, and I will not let the lamp go out before the " \
                "village hears every word of the story that it keeps."  # ~10 s
    a, b, cc = _board(c, eid, [
        {"prompt": "Ravi lifts the lamp.", "duration_s": 8, "characters": [ravi], "lines": [{"speaker": ravi, "text": short_line}]},
        {"prompt": "The village at dusk.", "duration_s": 4, "lines": [{"speaker": "VO", "text": vo}]},
        {"prompt": "Ravi speaks to the crowd.", "duration_s": 4, "characters": [ravi], "lines": [{"speaker": ravi, "text": long_line}]},
    ])
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "produce",
                                                               "steps": ["keyframes", "videos", "voices"]}))
    jobs = wait_jobs(c, pid, timeout=900)
    prod = next(j for j in jobs if j["type"] == "produce")
    assert prod["status"] == "succeeded", prod["error"]
    voices = [j for j in jobs if j["type"] == "voice" and j["parent_job_id"] == prod["id"]]
    videos = [j for j in jobs if j["type"] == "video" and j["parent_job_id"] == prod["id"]]
    assert {j["shot_id"] for j in voices} == {a, b, cc} and len(videos) == 3
    assert max(j["id"] for j in voices) < min(j["id"] for j in videos)  # every voice before any picture
    assert prod["result"]["jobs"]["voices_first"] == 3
    with SessionLocal() as db:
        sa, sb, sc_ = db.get(Shot, a), db.get(Shot, b), db.get(Shot, cc)
        va = selection.current(db, a, "voice", "hi")
        assert sa.duration_s == choose_duration(va.duration_s) < 8  # the clip is as long as its voice, not 8 s
        nb = selection.current(db, b, "narration", "hi")
        assert nb.duration_s > 8 and sb.duration_s == 8 and sb.extend_to == 15  # narration: 8 s + one extension
        vc = selection.current(db, cc, "voice", "hi")
        assert vc.duration_s > 8 and sc_.duration_s == 8 and not sc_.extend_to  # on screen: one clip at most
        lip = selection.current(db, cc, "lipsync", "hi")
        assert lip is not None and lip.params["held_s"] > 0 and lip.duration_s >= vc.duration_s - 0.1  # never cut
        assert "holds its last frame" in lip.params["warning"]
    assert any(p["shot_id"] == cc and "lines run" in p["reason"] for p in prod["result"]["problems"])


def test_estimate_warns_about_long_lines(client: TestClient):
    c = client
    pid, eid = _project(c)
    long_line = " ".join(["word"] * 30)
    ravi = ok(c.post("/api/characters", headers=H, json={"name": "Ravi", "project_id": pid}))["id"]
    _board(c, eid, [{"prompt": "Ravi talks.", "duration_s": 6, "characters": [ravi],
                     "lines": [{"speaker": ravi, "text": long_line}]}])
    est = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "produce"}))
    assert any("30 words in a 6s clip" in w for w in est["warnings"])


# ── 3. QC retakes ────────────────────────────────────────────────────────────

def _fake_llm(outs: dict, calls: list):
    from app.agents import schemas as S
    shapes = {"qc": S.QCOut, "lipsync_qc": S.LipsyncQCOut, "dialogue_check": S.DialogueCheckOut}

    def llm_json(task, system, prompt, schema, **kw):
        calls.append(task)
        base = {"qc": {"identity_match": 0.95, "outfit_match": True, "extra_people": False, "text_artifacts": False,
                       "hand_issues": False, "matches_action": True},
                "lipsync_qc": {"sync_score": 0.95, "face_visible": True, "artifacts": False},
                "dialogue_check": {"word_match": 0.95}}[task]
        return shapes[task].model_validate({**base, **outs.get(task, {})}), Usage("gemini", "x", task, 0, "tokens", 0.0)
    return llm_json


def _run_qc(db_take_id: int, payload: dict, outs: dict) -> tuple[dict, list[str], list[Job]]:
    calls: list[str] = []
    with SessionLocal() as db:
        t = db.get(Take, db_take_id)
        shot = db.get(Shot, t.shot_id)
        ep = db.get(Episode, shot.episode_id)
        j = _job(db, "qc", ep.project_id, shot.id, {"take_id": db_take_id, **payload})
        ctx = W.JobContext(j)
    ctx.services.llm_json = _fake_llm(outs, calls)
    try:
        out = handlers.qc(ctx)
    finally:
        with SessionLocal() as db:
            db.get(Job, ctx.job_id).status = "succeeded"
            db.commit()
    with SessionLocal() as db:
        kids = db.query(Job).filter(Job.parent_job_id == ctx.job_id).all()
        db.expunge_all()
    return out, calls, kids


def test_qc_retakes_lips_only_extensions_as_extensions_and_lists_long_lines(client: TestClient):
    c = client
    pid, eid = _project(c, languages=["hi"])
    ravi = ok(c.post("/api/characters", headers=H, json={"name": "Ravi", "project_id": pid}))["id"]
    sid, sid2 = _board(c, eid, [
        {"prompt": "Ravi talks.", "duration_s": 4, "characters": [ravi], "lines": [{"speaker": ravi, "text": "Chalo."}]},
        {"prompt": "Ravi walks.", "duration_s": 4, "characters": [ravi]}])
    tmp = get_storage().tmp_dir()
    with SessionLocal() as db:
        shot, shot2 = db.get(Shot, sid), db.get(Shot, sid2)
        vid = _take(db, shot, "video", _clip(tmp / "v.mp4", 2))
        lip = _take(db, shot, "lipsync", _clip(tmp / "l.mp4", 2), lang="hi", provider="sync", method="redub",
                    video_take_id=vid.id)
        base = _take(db, shot2, "video", _clip(tmp / "b.mp4", 2), engine="google:video_balanced", mock=True)
        ext = _take(db, shot2, "video", _clip(tmp / "e.mp4", 3), engine="google:video_balanced", mock=True)
        ext.parent_take_id = base.id
        db.commit()
        lip_id, base_id, ext_id = lip.id, base.id, ext.id
    # (a) a lip-sync take whose clip fails the face check: no new video under it
    out, calls, kids = _run_qc(lip_id, {"retake_count": 0, "lip_only": True}, {"qc": {"identity_match": 0.1}})
    assert out["retake"] is None and "remake the video" in out["reason"] and not kids
    assert "dialogue_check" not in calls  # (c) a studio voice: no transcription check of its words
    # … whose lips are off: a lip-sync retake, on the same count
    out, _, kids = _run_qc(lip_id, {"retake_count": 1, "lip_only": True}, {"lipsync_qc": {"sync_score": 0.1}})
    assert out["retake"] == "lipsync" and [k.type for k in kids] == ["lipsync"] and kids[0].payload["retake_count"] == 2
    # (b) an extension is retaken as an extension of the clip it was made from, with its prompt
    out, _, kids = _run_qc(ext_id, {"retake_count": 0, "quality": "saver", "extend": True, "prompt": "he walks on",
                                    "extend_from_take": base_id}, {"qc": {"identity_match": 0.1}})
    assert out["retake"] == "video" and len(kids) == 1
    assert kids[0].payload["extend"] is True and kids[0].payload["extend_from_take"] == base_id
    assert kids[0].payload["prompt"] == "he walks on" and kids[0].label.endswith("(extension)")
    wait_jobs(c, pid, timeout=600)


def test_qc_never_retakes_a_clip_for_a_line_too_long(client: TestClient):
    c = client
    pid, eid = _project(c)
    ravi = ok(c.post("/api/characters", headers=H, json={"name": "Ravi", "project_id": pid}))["id"]
    (sid,) = _board(c, eid, [{"prompt": "Ravi talks.", "duration_s": 8, "characters": [ravi],
                              "lines": [{"speaker": ravi, "text": " ".join(["word"] * 30)}]}])
    with SessionLocal() as db:
        t = _take(db, db.get(Shot, sid), "video", _clip(get_storage().tmp_dir() / "n.mp4", 2), native_language="en")
        db.commit()
        tid = t.id
    out, calls, kids = _run_qc(tid, {"retake_count": 0, "quality": "saver", "language": "en"},
                               {"dialogue_check": {"word_match": 0.2}})
    assert "dialogue_check" in calls and out["retake"] is None and not kids
    with SessionLocal() as db:
        p = db.get(Take, tid).qc["problem"]
        assert "30 words" in p["reason"] and "Split the shot" in p["next"]
        assert problems.qc_problems(db, [db.get(Shot, sid)])[0]["reason"] == p["reason"]


# ── 4 + 5. extensions in waves, Veo's limits ─────────────────────────────────

def test_a_linked_shot_starts_after_the_clip_before_is_extended(client: TestClient):
    c = client
    pid, eid = _project(c)
    a, b = _board(c, eid, [{"prompt": "The lamp is lit.", "duration_s": 8, "extend_to": 15},
                           {"prompt": "The flame grows.", "duration_s": 4}])
    with SessionLocal() as db:
        shot_b = db.get(Shot, b)
        shot_b.continuity_from_shot_id, shot_b.continuity_mode = a, "last_frame"
        db.commit()
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "produce", "quality": "hero",
                                                               "steps": ["keyframes", "videos", "extend"]}))
    jobs = wait_jobs(c, pid, timeout=900)
    prod = next(j for j in jobs if j["type"] == "produce")
    assert prod["status"] == "succeeded", prod["error"]
    ext = [j for j in jobs if j["type"] == "video" and j["shot_id"] == a and j["payload"].get("extend")]
    vid_b = [j for j in jobs if j["type"] == "video" and j["shot_id"] == b]
    assert ext and vid_b and min(j["id"] for j in ext) < min(j["id"] for j in vid_b)
    assert prod["result"]["jobs"]["extend"] >= 1
    with SessionLocal() as db:
        first = db.query(Take).filter(Take.shot_id == a, Take.kind == "video").order_by(Take.id).first()
        assert first.params["resolution"] == "720p"  # Veo extends only 720p clips: the base clip is made at 720p
        assert selection.current(db, b, "video").params["resolution"] == "1080p"
        kf_b = selection.current(db, b, "keyframe")
        src = db.get(Take, kf_b.params["continuity_take_id"])
        assert src.shot_id == a and src.parent_take_id is not None  # it starts from the extended clip


def test_veo_extension_limits():
    now = utcnow()
    fresh = {"provider": "google", "uri": "https://x/files/a", "resolution": "720p", "made": now - timedelta(hours=3)}
    assert handlers.veo_cant_extend(fresh) == ""
    assert "720p" in handlers.veo_cant_extend({**fresh, "resolution": "1080p"})
    old = {**fresh, "made": now - timedelta(days=3)}
    assert "2 days" in handlers.veo_cant_extend(old)
    assert handlers.veo_cant_extend({**old, "touched": (now - timedelta(hours=5)).isoformat() + "Z"}) == ""  # used again
    assert "made by Veo" in handlers.veo_cant_extend({**fresh, "provider": "byteplus", "uri": "byteplus:t1"})
    assert handlers.veo_cant_extend({**old, "mock": True}) == ""


# ── 6. a character's new look makes their shots out of date ───────────────────

def test_a_new_look_marks_the_shots_and_can_be_redone(client: TestClient):
    c = client
    pid, eid = _project(c)
    ravi = ok(c.post("/api/characters", headers=H, json={"name": "Ravi", "project_id": pid}))["id"]
    with open(_image("ravi"), "rb") as f:
        ok(c.post(f"/api/characters/{ravi}/upload", headers=H, files={"file": ("r.png", f, "image/png")}))
    sid, other = _board(c, eid, [{"prompt": "Ravi waits.", "duration_s": 4, "characters": [ravi]},
                                 {"prompt": "The empty road.", "duration_s": 4}])
    tmp = get_storage().tmp_dir()
    with SessionLocal() as db:
        aid = db.query(CharacterAsset).filter(CharacterAsset.character_id == ravi).first().id
        for s in (db.get(Shot, sid), db.get(Shot, other)):
            _take(db, s, "keyframe", _image(f"k{s.id}"))
            _take(db, s, "video", _clip(tmp / f"v{s.id}.mp4", 1))
        db.commit()

    def stale(shot_id: int) -> dict[str, str]:
        with SessionLocal() as db:
            return {t.kind: t.stale_reason for t in db.query(Take).filter(Take.shot_id == shot_id, Take.stale.is_(True))}

    ok(c.patch(f"/api/character-assets/{aid}", headers=H, json={"approved": False}))
    assert stale(sid) == {"keyframe": "Ravi's look changed", "video": "Ravi's look changed"} and stale(other) == {}
    imp = ok(c.get(f"/api/characters/{ravi}/impact?project_id={pid}"))
    assert imp["shot_ids"] == [sid] and imp["episodes"][0]["episode_id"] == eid and "estimate" in imp
    with SessionLocal() as db:
        assert imp["shots"] == [db.get(Shot, sid).code]
    out = ok(c.post(f"/api/episodes/{eid}/impact/regenerate", headers=H, json={"shot_ids": imp["shot_ids"]}))
    assert [j["shot_id"] for j in out["jobs"]] == [sid]
    wait_jobs(c, pid, timeout=600)
    assert stale(sid) == {}  # redone
    ok(c.put(f"/api/characters/{ravi}/lock", headers=H, json={"lock": {"strictness": 0.9}}))
    assert set(stale(sid).values()) == {"Ravi's lock changed"}
    # an outfit edit marks only the shots where it is worn
    with SessionLocal() as db:
        for t in db.query(Take).filter(Take.shot_id == sid):
            t.stale, t.stale_reason = False, ""
        db.add(Costume(character_id=ravi, name="Wedding", description="red silk"))
        s2 = Shot(episode_id=eid, order=9, code="W1", characters=[ravi], outfits={str(ravi): "Wedding"})
        db.add(s2)
        db.flush()
        _take(db, s2, "video", _clip(tmp / "w.mp4", 1))
        db.commit()
        coid, wid = db.query(Costume).filter(Costume.character_id == ravi).first().id, s2.id
    ok(c.patch(f"/api/costumes/{coid}", headers=H, json={"description": "gold silk"}))
    assert stale(wid) == {"video": "Ravi's outfit 'Wedding' changed"} and stale(sid) == {}


# ── 7. budget: an allowance for checks and retakes, a stop that lets paid work finish ──

def test_budget_allowance_and_forced_eight_seconds(client: TestClient, monkeypatch):
    from app.core import model_hub
    pid, eid = _project(client)
    with SessionLocal() as db:
        ep = db.get(Episode, eid)
        s = Shot(episode_id=eid, order=1, code="B1", duration_s=4, characters=[], dialogue={"en": [{"character_id": 1, "line": "hi"}]})
        db.add(s)
        db.commit()
        est = Estimator(db)
        monkeypatch.setattr(est, "vision", lambda *a, **k: 0.01)
        items = generation.checks_allowance(db, est, {s.id: s}, [{"shot_id": s.id, "estimate": 0.1}],
                                            [{"shot_id": s.id, "estimate": 1.0}], [])
        assert items == [{"label": "QC checks · 2", "usd": 0.02},
                         {"label": "Automatic retakes (allowance)", "usd": round(0.3 * 1.1, 4)}]
        seen: list = []

        def price(m, seconds=8.0, resolution="720p", units=1.0):
            seen.append((seconds, resolution))
            return 1.0
        monkeypatch.setattr(model_hub, "price_for", price)
        project = db.get(Project, ep.project_id)
        seen.clear()
        Estimator(db).video(s, project, "saver")
        assert seen[-1] == (4.0, "720p")
        Estimator(db).video(s, project, "saver", ends=True)  # Veo makes 8 s whenever there is an end frame
        assert seen[-1] == (8, "720p")
        s.extend_to = 15
        Estimator(db).video(s, project, "hero")  # extended later: the base clip at 720p
        assert seen[-1] == (4.0, "720p")
        s.extend_to = 0
        Estimator(db).video(s, project, "hero")
        assert seen[-1] == (8, "1080p")


def test_budget_stop_lets_running_work_finish(client: TestClient, monkeypatch):
    c = client
    pid, eid = _project(c)
    _board(c, eid, [{"prompt": "The lamp glows.", "duration_s": 4}])
    monkeypatch.setattr(runlog, "_run_spend", lambda ctx: (5.0, 1.0))
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "produce", "steps": ["keyframes", "videos"]}))
    jobs = wait_jobs(c, pid, timeout=600)
    prod = next(j for j in jobs if j["type"] == "produce")
    assert prod["status"] == "succeeded" and prod["result"]["stopped"] == "budget"
    assert prod["result"]["problems"][0]["reason"] == "Stopped at your budget: press Produce all to continue"
    assert not [j for j in jobs if j["type"] in ("keyframe", "video")]
    with SessionLocal() as db:  # only what hasn't started is cancelled; work already running (and paid) goes on
        root = _job(db, "produce", pid, batch_id="bx-run")
        waiting = _job(db, "music", pid, status="awaiting_approval", parent_job_id=root.id, batch_id="bx-run")
        running = _job(db, "music", pid, parent_job_id=root.id, batch_id="bx-run")
        assert jobs_core.cancel_queued_tree(db, [root.id]) == 1 and jobs_core.running_in_tree(db, [root.id]) == 1
        db.commit()
        assert db.get(Job, waiting.id).status == "cancelled" and db.get(Job, running.id).status == "running"
        root.result = {"budget_stopped": True}
        db.commit()
        ctx = W.JobContext(db.get(Job, running.id))
        assert ctx.enqueue_child("qc", {"take_id": 1}) == 0  # no follow-up work after the stop
        for j in (root, running):
            db.get(Job, j.id).status = "succeeded"
        db.commit()


# ── 8. review stop only when there is something new to check ──────────────────

def test_no_review_stop_when_every_look_failed(client: TestClient, monkeypatch):
    c = client
    pid, eid = _project(c)
    zoya = ok(c.post("/api/characters", headers=H, json={"name": "Zoya Quint", "project_id": pid}))["id"]
    _board(c, eid, [{"prompt": "Zoya waits.", "duration_s": 4, "characters": [zoya]}])

    def sheet(ctx):
        raise ProviderError("No enabled engine for 'Keyframes & character images' that can do i2i.")
    monkeypatch.setitem(W.HANDLERS, "character_sheet", sheet)
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "produce", "steps": ["cast", "keyframes"],
                                                               "review_looks": True}))
    jobs = wait_jobs(c, pid, timeout=600)
    prod = next(j for j in jobs if j["type"] == "produce")
    assert prod["status"] == "succeeded" and "paused_after" not in prod["result"]
    assert [j for j in jobs if j["type"] == "keyframe"]  # it carried on
    assert any("Sheet: Zoya Quint" in p["reason"] and p["next"].startswith("Connect one") for p in prod["result"]["problems"])
    assert ok(c.get(f"/api/episodes/{eid}/board"))["produce_paused"] is None


# ── 9 + 10. waiting runs say what they wait for, and give up only when stuck ──

def test_waiting_notes_and_the_stuck_timeout(client: TestClient):
    later = utcnow() + timedelta(hours=3)
    quota = types.SimpleNamespace(status="queued", run_after=later, label="Video S1", type="video",
                                  error="Waiting for the gemini rate limit, retrying at 03:00:00 UTC. quota")
    assert W._wait_note([quota]) == f"waiting for gemini quota until {later:%H:%M} UTC"
    asked = types.SimpleNamespace(status="awaiting_approval", run_after=None, label="Video S2 (Kling)", type="video", error="")
    assert W._wait_note([quota, asked]) == "waiting for your approval of Video S2 (Kling)"
    pid, _ = _project(client)
    with SessionLocal() as db:
        parent = _job(db, "produce", pid)
        kid = _job(db, "music", pid, status="queued", parent_job_id=parent.id, run_after=utcnow() + timedelta(hours=5))
        ctx = W.JobContext(parent)
    t0 = time.time()
    with pytest.raises(ProviderError, match="nothing moved"):
        ctx.wait_children([kid.id], "Music", timeout_s=3)
    assert time.time() - t0 < 30
    with SessionLocal() as db:
        assert db.get(Job, kid.id).status == "cancelled"
        db.get(Job, parent.id).status = "failed"
        db.commit()


# ── 11. a continuity hiccup never fails the run ───────────────────────────────

def test_a_continuity_hiccup_is_a_problem_not_a_failure(client: TestClient, monkeypatch):
    c = client
    pid, eid = _project(c)
    _board(c, eid, [{"prompt": "The lamp glows.", "duration_s": 4}])

    def boom(*a, **k):
        raise RetryableProviderError("the writer is overloaded", provider="anthropic")
    monkeypatch.setattr(scene_chain, "ensure_end_states", boom)
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "produce", "steps": ["keyframes"]}))
    jobs = wait_jobs(c, pid, timeout=600)
    prod = next(j for j in jobs if j["type"] == "produce")
    assert prod["status"] == "succeeded" and [j for j in jobs if j["type"] == "keyframe"]
    assert any(p["step"] == "Continuity" and "overloaded" in p["reason"] for p in prod["result"]["problems"])


# ── 12. a placeholder lip-sync isn't finished work once an engine is connected ─

def test_placeholder_lipsync_counts_as_missing(client: TestClient, monkeypatch):
    pid, eid = _project(client)
    with SessionLocal() as db:
        s = Shot(episode_id=eid, order=1, code="P1")
        db.add(s)
        db.flush()
        v = Take(shot_id=s.id, kind="video", provider="google", path="x/v.mp4", selected=True, params={})
        db.add(v)
        db.flush()
        db.add(Take(shot_id=s.id, kind="lipsync", language="en", provider="sync", path="x/l.mp4", selected=True,
                    parent_take_id=v.id, params={"mock": True, "video_take_id": v.id}))
        db.commit()
        monkeypatch.setattr(selection, "_lipsync_live", lambda db: False)
        assert selection.has_fresh(db, s.id, "lipsync", "en")
        monkeypatch.setattr(selection, "_lipsync_live", lambda db: True)
        assert not selection.has_fresh(db, s.id, "lipsync", "en")


# ── 13. every on-screen person gets a reference where the engine allows ───────

def test_each_engine_gets_its_own_number_of_references(client: TestClient):
    pid, eid = _project(client)
    st = get_storage()
    with SessionLocal() as db:
        loc = Location(name="Market")
        db.add(loc)
        db.flush()
        db.add(LocationAsset(location_id=loc.id, kind="wide", path=st.save_file(st.new_path("t/loc", "png"), _image("loc"))))
        people = []
        for n in ("Asha", "Bala", "Chitra", "Dev", "Esha"):
            ch = Character(name=n)
            db.add(ch)
            db.flush()
            for kind in ("front", "three_quarter"):
                db.add(CharacterAsset(character_id=ch.id, kind=kind, approved=True,
                                      path=st.save_file(st.new_path(f"t/{n}", "png"), _image(f"{n}{kind}"))))
            people.append(ch.id)
        s = Shot(episode_id=eid, order=1, code="M1", characters=people[:3], location_id=loc.id)
        s5 = Shot(episode_id=eid, order=2, code="M2", characters=people, location_id=loc.id)
        db.add_all([s, s5])
        db.commit()
        veo = video_refs(db, s, 3)
        assert [l.split(" (")[0] for l, _ in veo] == ["Asha", "Bala", "Chitra"]  # the third person isn't dropped
        seed = [l for l, _ in video_refs(db, s, 9)]
        assert {x.split(" (")[0] for x in seed} >= {"Asha", "Bala", "Chitra"} and "location" in seed and len(seed) > 4
        kf = [l for l, _ in keyframe_refs(db, s5, None, None)]
        assert all(any(l.startswith(n) for l in kf) for n in ("Asha", "Bala", "Chitra", "Dev", "Esha"))


# ── 14. Seedance and realistic faces ─────────────────────────────────────────

def test_seedance_warning_and_registration_in_the_cast_step(client: TestClient, monkeypatch):
    from app import settings_store
    from app.workers import handlers_hub
    pid, eid = _project(client)
    with SessionLocal() as db:
        ch = Character(name="Kiran Seed")
        db.add(ch)
        db.flush()
        s = Shot(episode_id=eid, order=1, code="K1", characters=[ch.id])
        db.add(s)
        db.commit()
        project = db.get(Project, pid)
        assert recovery.seedance_warnings(db, project, [s]) == []  # Google first: Veo makes it
        fake = types.SimpleNamespace(id="byteplus:seedance-2.0", capabilities={"asset_refs": True})
        monkeypatch.setattr(recovery, "seedance_engine", lambda db, shot, project, quality=None: fake)
        w = recovery.seedance_warnings(db, project, [s])
        assert len(w) == 1 and "Kiran Seed isn't registered with BytePlus" in w[0]
        assert handlers_room._registrations(db, project, [s], None) == []  # automatic registration is off
        monkeypatch.setattr(settings_store, "get_setting", lambda db, k: True if k == "byteplus_auto_register" else None)
        monkeypatch.setattr(handlers_hub, "auto_register_reason", lambda db, c: "")
        specs = handlers_room._registrations(db, project, [s], None)
        assert [x["type"] for x in specs] == ["byteplus_register"] and specs[0]["payload"]["character_id"] == ch.id
        monkeypatch.setattr(handlers_hub, "auto_register_reason", lambda db, c: "Made from a photo of a real person")
        assert handlers_room._registrations(db, project, [s], None) == []  # never a real person's photo


# ── 15. safety blocks: once more toned down, then plain words ─────────────────

def test_a_blocked_clip_is_tried_once_more_toned_down(client: TestClient, monkeypatch):
    assert recovery.soften("He raises the Knife; blood on the floor.") == \
        ("He raises the Kitchen tool; dust on the floor.", ["knife", "blood"])
    assert recovery.soften("A quiet morning.") == ("A quiet morning.", [])
    c = client
    pid, eid = _project(c)
    knife, star = _board(c, eid, [{"prompt": "Ravi picks up the knife.", "duration_s": 4},
                                  {"prompt": "A celebrity waves at the crowd.", "duration_s": 4}])
    orig = Services.run_model

    def run_model(self, m, req, **kw):
        if m.task == "video" and ("knife" in req.prompt.lower() or "celebrity" in req.prompt.lower()):
            raise ProviderBlocked("Veo blocked the video: unsafe", provider="gemini")
        return orig(self, m, req, **kw)
    monkeypatch.setattr(Services, "run_model", run_model)
    ok(c.post(f"/api/shots/{knife}/video", headers=H, json={}))
    ok(c.post(f"/api/shots/{star}/video", headers=H, json={}))
    jobs = wait_jobs(c, pid, timeout=600)
    good = next(j for j in jobs if j["type"] == "video" and j["shot_id"] == knife)
    bad = next(j for j in jobs if j["type"] == "video" and j["shot_id"] == star)
    assert good["status"] == "succeeded", good["error"]
    with SessionLocal() as db:
        t = selection.current(db, knife, "video")
        assert t.params["toned_down"] == ["knife"] and "kitchen tool" in t.prompt
        info = recovery.blocked_info(db, db.get(Shot, star))
        assert info is not None and info["error"].startswith("Veo blocked the video: unsafe")
    assert bad["status"] == "failed" and bad["error"].startswith("Blocked by safety filter:")
    assert "Next: soften the action or the words, or try another engine" in bad["error"]


# ── 16. lip-sync with two people: who speaks ──────────────────────────────────

def test_who_speaks_goes_to_the_lipsync_engine(client: TestClient):
    assert speaker_option(None) is None
    assert speaker_option({"auto": True}) == {"auto_detect": True}
    assert speaker_option({"frame": 0, "x": 640.4, "y": 360}) == {"auto_detect": False, "frame_number": 0,
                                                                  "coordinates": [640, 360]}
    pid, eid = _project(client)
    with SessionLocal() as db:
        a, b = Character(name="Uma"), Character(name="Vik")
        db.add_all([a, b])
        db.flush()
        one = Shot(episode_id=eid, order=1, code="T1", characters=[a.id], dialogue={"en": [{"character_id": a.id, "line": "Hi"}]})
        two = Shot(episode_id=eid, order=2, code="T2", characters=[a.id, b.id],
                   dialogue={"en": [{"character_id": a.id, "line": "Hi"}]})
        db.add_all([one, two])
        db.commit()
        tmp = get_storage().tmp_dir()
        assert handlers._speaker(db, one, "en", tmp / "none.mp4", tmp) is None
        assert handlers._speaker(db, two, "en", tmp / "none.mp4", tmp) == {"auto": True}  # no face models: sync.so finds them


# ── 17. the Director's import matches whole names only ────────────────────────

TEJAS_SCRIPT = """CHARACTERS:
TEJAS - 30, a farmer
TEJAS RAO - 60, his uncle

SCENE 1: INT. HOUSE - DAY
SHOT 1
VISUAL: Tejas looks around.
TEJAS: Where is the lamp?
SHOT 2
VISUAL: The uncle points.
TEJAS RAO: Here.
"""


def test_director_import_never_merges_by_first_name(client: TestClient):
    c = client
    pid, eid = _project(c)
    ok(c.post("/api/characters", headers=H, json={"name": "Tejas Rao", "project_id": pid}))
    with SessionLocal() as db:
        p = db.get(Project, pid)
        assert _match(db, p, "Tejas", exact_only=True) is None
        assert _match(db, p, "Tejas")["name"] == "Tejas Rao"  # (the wizard still suggests it for a person to check)
        assert _match(db, p, "  tejas   RAO ", exact_only=True)["name"] == "Tejas Rao"
        ctx = T.AgentCtx(db=db, user=_user(db), project=p, episode=db.get(Episode, eid))
        out = T.import_script(ctx, text=TEJAS_SCRIPT, method="markers")
        assert "error" not in out, out
        names = {ch.name.lower() for ch in db.query(Character).join(ProjectCast, ProjectCast.character_id == Character.id)
                 .filter(ProjectCast.project_id == pid).all()}
        assert {"tejas", "tejas rao"} <= names and [n.lower() for n in out["created_characters"]] == ["tejas"]


# ── 18. the Director sees what failed ─────────────────────────────────────────

def test_the_director_sees_real_takes_and_failures(client: TestClient):
    pid, eid = _project(client)
    with SessionLocal() as db:
        s = Shot(episode_id=eid, order=1, code="D1")
        db.add(s)
        db.flush()
        db.add(Take(shot_id=s.id, kind="video", provider="google", path="x/d.mp4", selected=True, params={"draft": True}))
        ep = db.get(Episode, eid)
        ep.settings = {**(ep.settings or {}), "run_problems": [problems.problem(s, "Videos", "A safety filter blocked it",
                                                                                 problems.TRY_ANOTHER)]}
        _job(db, "video", pid, s.id, status="failed", error="Blocked by safety filter: Veo blocked the video: x.")
        db.commit()
        state = T.get_project_state(T.AgentCtx(db=db, user=_user(db), project=db.get(Project, pid), episode=ep))
        brief = next(x for x in state["shots"] if x["code"] == "D1")
        assert brief["video"] is False and brief["video_note"] == "draft only"
        assert state["run_problems"][0]["reason"] == "A safety filter blocked it"
        assert state["failed_jobs"][0]["reason"].startswith("A safety filter blocked it") and state["failed_jobs"][0]["shot"] == "D1"
