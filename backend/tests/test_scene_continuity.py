"""Scene continuity: anchor + location refs, the previous shot's frame by default, anchor-first batches, keyframe QC with
one automatic retake, Enhance, and approved stills that feed the character references."""
from __future__ import annotations

import io
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import settings_store
from app.core import generation
from app.core.scene_order import held_back
from app.db import SessionLocal, utcnow
from app.models import Character, CharacterAsset, Episode, Job, LocationAsset, Project, Shot, Take
from app.pipeline import approved_stills, scene_look
from app.pipeline.prompting import (ANCHOR_LABEL, LOCATION_LABEL, STILL_KIND, character_refs, compile_keyframe_prompt,
                                    compile_video_prompt, keyframe_refs)
from app.storage import get_storage
from conftest import H, ok, wait_jobs


def _png(color=(30, 140, 90), size=(96, 160)) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", size, color).save(b, "PNG")
    return b.getvalue()


def _char(c: TestClient, pid: int, name: str, kinds=("front", "three_quarter")) -> int:
    cid = ok(c.post("/api/characters", headers=H, json={"name": name, "project_id": pid}))["id"]
    st = get_storage()
    with SessionLocal() as db:
        for i, k in enumerate(kinds):
            rel = st.save_bytes(st.new_path(f"characters/{cid}", "png"), _png((40 * i, 90, 160)))
            db.add(CharacterAsset(character_id=cid, kind=k, label=k, path=rel))
        db.commit()
    return cid


def _setup(c: TestClient, chars: list[int] | None = None) -> dict:
    """Two scenes in two places: scene 1 (3 shots, dusk) and scene 2 (2 shots), with a location image for each."""
    p = ok(c.post("/api/projects", headers=H, json={"concept": "Temple lamp", "type": "short", "auto_brief": False}))
    pid, eid = p["id"], p["episodes"][0]["id"]
    cid = _char(c, pid, "Ravi")
    cast = [cid, *(chars or [])]
    b = ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [
        {"title": "Lamp lit", "location": "Temple courtyard", "time_of_day": "dusk", "shots": [
            {"prompt": "Ravi lights the lamp.", "framing": "wide", "characters": cast, "duration_s": 6},
            {"prompt": "Ravi looks up.", "framing": "medium", "characters": [cid], "duration_s": 6},
            {"prompt": "Ravi's eyes widen.", "framing": "close-up", "characters": [cid], "duration_s": 4}]},
        {"title": "At the river", "location": "River ghat", "time_of_day": "night", "shots": [
            {"prompt": "Ravi walks to the water.", "framing": "wide", "characters": [cid], "duration_s": 6},
            {"prompt": "The lamp floats away.", "framing": "insert", "duration_s": 4}]},
    ]}))
    scenes = b["scenes"]
    shots = [s["id"] for sc in scenes for s in sc["shots"]]
    st = get_storage()
    with SessionLocal() as db:
        for sid in shots[::3]:  # one shot per location is enough to reach both
            loc_id = db.get(Shot, sid).location_id
            rel = st.save_bytes(st.new_path(f"locations/{loc_id}", "png"), _png((120, 100, 40)))
            db.add(LocationAsset(location_id=loc_id, kind="wide", label="wide", path=rel))
        db.commit()
    return {"pid": pid, "eid": eid, "cid": cid, "scenes": [sc["id"] for sc in scenes], "shots": shots}


def _upload_kf(c: TestClient, sid: int, color=(200, 60, 20)) -> dict:
    return ok(c.post(f"/api/shots/{sid}/keyframe/upload", headers=H, files={"file": ("kf.png", _png(color), "image/png")}))["keyframe"]


def _refs(db, sid: int) -> list[str]:
    shot = db.get(Shot, sid)
    fr = scene_look.continuity_frames(db, shot, scene_look.continuity_source(db, shot), None)
    return [l for l, _ in keyframe_refs(db, shot, fr.prev, fr.anchor, fr.prev_from)]


def test_anchor_and_location_refs_survive_the_limit(client: TestClient):
    c = client
    pid = ok(c.post("/api/projects", headers=H, json={"concept": "crowd", "type": "short", "auto_brief": False}))["id"]
    extra = [_char(c, pid, n) for n in ("Meera", "Arun", "Devi")]  # 4 characters × 2 views = 8 references alone
    s = _setup(c, extra)
    s1, s2, s3 = s["shots"][:3]
    _upload_kf(c, s1)
    with SessionLocal() as db:
        busy = db.get(Shot, s2)
        busy.characters = [s["cid"], *extra]
        busy.ref_images = [{"path": db.get(Take, db.query(Take.id).filter(Take.shot_id == s1).scalar()).path, "label": f"thing {i}"}
                           for i in range(4)]
        db.commit()
        labels = _refs(db, s2)
        assert len(labels) <= 8
        assert labels.count(ANCHOR_LABEL + "; also continue its positions and props") == 1  # the shot before is the anchor
        assert LOCATION_LABEL in labels
        for name in ("Ravi", "Meera", "Arun", "Devi"):  # every character keeps a face
            assert any(l.startswith(f"{name} (") for l in labels), (name, labels)
        # the anchor shot itself follows nobody
        assert not any(l.startswith("scene anchor") for l in _refs(db, s1))
        # same scene look block, word for word, in every shot of the scene (keyframes and videos)
        p = db.get(Project, s["pid"])
        look = scene_look.scene_look(db, scene_look.scene_of(db, db.get(Shot, s2)))
        assert "dusk" in look and "golden" in look and "Temple courtyard" in look
        for sid in (s1, s2, s3):
            assert f"[SCENE LOOK] {look}" in compile_video_prompt(db, db.get(Shot, sid), p)
            assert look in compile_keyframe_prompt(db, db.get(Shot, sid), p, [])
        # cinematography by framing, and what each image is for
        close = compile_keyframe_prompt(db, db.get(Shot, s3), p, _refs(db, s3))
        assert "85mm" in close and "scene anchor" in close and "Faces come only from the character images" in close
        assert "1-2) Ravi (front, three quarter): copy this exact face" in close  # two views of one face: one entry
        assert "24-35mm" in compile_keyframe_prompt(db, db.get(Shot, s1), p, [])


def test_previous_frame_by_default_within_a_scene_only(client: TestClient):
    c = client
    s = _setup(c)
    s1, s2, s3, s4, s5 = s["shots"]
    for sid in (s1, s2, s3):
        _upload_kf(c, sid, (sid % 255, 80, 80))
    with SessionLocal() as db:
        get = lambda i: db.get(Shot, i)  # noqa: E731
        assert scene_look.continuity_source(db, get(s3)).id == s2  # same scene, same place: by default
        assert scene_look.continuity_source(db, get(s4)) is None  # first shot of the next scene: not across scenes
        assert any(l.startswith("the shot before") for l in _refs(db, s3))
        assert not any(l.startswith("the shot before") or l.startswith("scene anchor") for l in _refs(db, s4))
        assert scene_look.anchor_for(db, get(s5)).id == s4 and scene_look.anchor_for(db, get(s3)).id == s1
        # another place inside the same scene: no previous frame (the anchor still applies)
        loc_other = get(s4).location_id
        get(s3).location_id = loc_other
        db.commit()
        assert scene_look.continuity_source(db, get(s3)) is None
        get(s3).location_id = get(s2).location_id
        db.commit()
        # the team setting switches the automatic part off
        settings_store.set_setting(db, "auto_scene_continuity", False)
        db.commit()
        try:
            assert scene_look.continuity_source(db, get(s3)) is None and scene_look.anchor_for(db, get(s3)) is None
            assert not any(l.startswith("the shot before") or l.startswith("scene anchor") for l in _refs(db, s3))
        finally:
            settings_store.set_setting(db, "auto_scene_continuity", True)
            db.commit()


def test_keyframe_from_the_previous_clip_counts_as_linked(client: TestClient):
    """The previous shot's finished clip gives the keyframe its first frame, and the take records which clip it was,
    so core/scene_chain sees the link as followed."""
    from app.core import scene_chain
    from app.pipeline.selection import current
    c = client
    s = _setup(c)
    s1, s2 = s["shots"][:2]
    ok(c.post(f"/api/shots/{s1}/video", headers=H, json={}))
    wait_jobs(c, s["pid"], timeout=600)
    with SessionLocal() as db:
        db.get(Shot, s2).continuity_from_prev = True  # an explicit link, as the breakdown sets inside a scene
        db.commit()
    ok(c.post(f"/api/shots/{s2}/keyframe", headers=H, json={}))
    wait_jobs(c, s["pid"])
    with SessionLocal() as db:
        sv, kf = current(db, s1, "video"), current(db, s2, "keyframe")
        assert kf.params["continuity_take_id"] == sv.id and kf.params["anchor"]
        assert any(l.startswith("the shot before (last frame)") for l in kf.params["refs"])
        assert scene_chain.follows(kf, sv) and scene_chain.link_status(db, db.get(Shot, s2))["status"] == "ok"


def test_explicit_links_and_pinned_anchor_win(client: TestClient):
    c = client
    s = _setup(c)
    s1, s2, s3, s4, s5 = s["shots"]
    sc1, sc2 = s["scenes"]
    with SessionLocal() as db:
        db.get(Shot, s4).continuity_from_shot_id = s2  # Film Map link across scenes
        db.commit()
        assert scene_look.continuity_source(db, db.get(Shot, s4)).id == s2
        db.get(Shot, s4).continuity_from_shot_id = None
        db.get(Shot, s4).continuity_from_prev = True  # "continue from previous shot", even into a new scene
        db.commit()
        assert scene_look.continuity_source(db, db.get(Shot, s4)).id == s3
    # pin another shot as the scene's look anchor
    assert c.patch(f"/api/scenes/{sc1}", headers=H, json={"anchor_shot_id": s4}).status_code == 400
    ok(c.patch(f"/api/scenes/{sc1}", headers=H, json={"anchor_shot_id": s2}))
    assert ok(c.get(f"/api/shots/{s2}"))["scene_anchor"] == {"scene_id": sc1, "shot_id": s2, "code": ok(c.get(f"/api/shots/{s2}"))["code"],
                                                             "is_anchor": True, "pinned": True, "auto": True}
    with SessionLocal() as db:
        assert scene_look.anchor_for(db, db.get(Shot, s1)).id == s2 and scene_look.anchor_for(db, db.get(Shot, s2)) is None
        p = db.get(Project, s["pid"])
        specs = generation.keyframe_specs(db, p, [db.get(Shot, i) for i in s["shots"]])
        assert [x["shot_id"] for x in specs[:2]] == [s2, s4]  # the anchors first
        assert {x["shot_id"]: x["payload"].get("after_shot") for x in specs} == {s1: s2, s2: None, s3: s2, s4: None, s5: s4}
    ok(c.patch(f"/api/scenes/{sc1}", headers=H, json={"anchor_shot_id": None}))
    assert ok(c.get(f"/api/shots/{s2}"))["scene_anchor"]["shot_id"] == s1


def test_batch_makes_each_anchor_first(client: TestClient):
    c = client
    s = _setup(c)
    s1, s2, s3, s4, s5 = s["shots"]
    res = ok(c.post(f"/api/episodes/{s['eid']}/generate", headers=H, json={"action": "keyframes"}))
    assert [j["shot_id"] for j in res["jobs"]][:2] == [s1, s4]
    jobs = wait_jobs(c, s["pid"])
    assert not [j for j in jobs if j["status"] == "failed"], [j["error"] for j in jobs if j["status"] == "failed"]
    with SessionLocal() as db:
        kf = {j.shot_id: j for j in db.query(Job).filter(Job.project_id == s["pid"], Job.type == "keyframe").all()}
        qc = {j.shot_id: j for j in db.query(Job).filter(Job.project_id == s["pid"], Job.type == "keyframe_qc").all()}
        assert set(qc) == set(s["shots"])  # every keyframe was checked
        for follower, anchor in ((s2, s1), (s3, s1), (s5, s4)):
            assert kf[follower].started_at >= qc[anchor].finished_at  # waited for the anchor (and its QC)
            t = db.query(Take).filter(Take.shot_id == follower, Take.kind == "keyframe").one()
            assert t.params["anchor"] and t.params["anchor_shot_id"] == anchor
            assert any(l.startswith("scene anchor") for l in t.params["refs"])
        assert not db.query(Take).filter(Take.shot_id == s1, Take.kind == "keyframe").one().params["anchor"]


def test_videos_that_make_their_keyframes_follow_the_anchor(client: TestClient):
    c = client
    s = _setup(c)
    s1, s2, s3, s4, s5 = s["shots"]
    res = ok(c.post(f"/api/episodes/{s['eid']}/generate", headers=H, json={"action": "videos"}))
    assert [j["shot_id"] for j in res["jobs"]][:2] == [s1, s4]
    assert {j["shot_id"]: j["payload"].get("after_shot") for j in res["jobs"]} == {s1: None, s2: s1, s3: s1, s4: None, s5: s4}
    jobs = wait_jobs(c, s["pid"], timeout=600)
    assert not [j for j in jobs if j["status"] == "failed"], [j["error"] for j in jobs if j["status"] == "failed"]
    with SessionLocal() as db:
        for follower, anchor in ((s2, s1), (s3, s1), (s5, s4)):
            t = db.query(Take).filter(Take.shot_id == follower, Take.kind == "keyframe").one()
            assert t.params["anchor"] and t.params["anchor_shot_id"] == anchor


def test_hold_rules_never_deadlock(client: TestClient):
    s = _setup(client)
    s1, s2 = s["shots"][:2]
    now = utcnow()
    follower = Job(id=10_000_001, type="keyframe", payload={"after_shot": s1}, shot_id=s2)  # not saved: a claim candidate
    with SessionLocal() as db:
        a = Job(type="keyframe", status="running", shot_id=s1, payload={}, started_at=now, label="anchor (test)")
        db.add(a)
        db.commit()
        try:
            assert held_back(db, [follower], now) == {follower.id}  # anchor running: wait
            a.started_at = now - timedelta(hours=1)
            db.commit()
            assert held_back(db, [follower], now) == set()  # running far too long: go ahead without it
            a.status, a.started_at, a.run_after = "queued", None, now + timedelta(hours=3)
            db.commit()
            assert held_back(db, [follower], now) == set()  # backing off for hours (rate limit): don't wait
            a.run_after = now + timedelta(seconds=60)
            db.commit()
            assert held_back(db, [follower], now) == {follower.id}  # a short back-off: wait
            a.payload = {"after_shot": s2}  # it waits itself: never chain waits (no cycles)
            db.commit()
            assert held_back(db, [follower], now) == set()
            # the anchor's video job is making the anchor's keyframe first: video jobs that make keyframes wait too
            vid = Job(id=10_000_002, type="video", payload={"after_shot": s1}, shot_id=s2)
            a.type, a.status, a.payload, a.started_at, a.run_after = "video", "running", {}, now, None
            db.commit()
            assert held_back(db, [follower, vid], now) == {follower.id, vid.id}
            db.add(Take(shot_id=s1, kind="keyframe", path="anchor.png"))  # ... until it has one
            db.commit()
            assert held_back(db, [follower, vid], now) == set()
            a.type, a.payload, a.status = "keyframe", {}, "failed"
            db.commit()
            assert held_back(db, [follower], now) == set()  # a failed anchor releases its scene
        finally:
            a.status = "cancelled"
            db.commit()


def test_keyframe_qc_retakes_once_on_failure(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    c = client
    s = _setup(c)
    s4 = s["shots"][3]
    ok(c.post(f"/api/shots/{s4}/keyframe", headers=H, json={}))
    wait_jobs(c, s["pid"])
    shot = ok(c.get(f"/api/shots/{s4}"))
    assert shot["keyframe"]["qc"]["kind"] == "keyframe" and shot["keyframe"]["qc"]["passed"] is True
    assert len([t for t in shot["takes"] if t["kind"] == "keyframe"]) == 1  # passed: no retake

    from app.providers import mock
    real = mock.llm

    def failing(task, ctx):
        if task == "keyframe_qc":
            return {**real(task, ctx), "identity_match": 0.2, "hand_issues": True}
        return real(task, ctx)

    monkeypatch.setattr(mock, "llm", failing)
    s3 = s["shots"][2]  # a scene-1 shot with Ravi
    ok(c.post(f"/api/shots/{s3}/keyframe", headers=H, json={}))
    wait_jobs(c, s["pid"])
    takes = [t for t in ok(c.get(f"/api/shots/{s3}"))["takes"] if t["kind"] == "keyframe"]
    assert len(takes) == 2  # the first one and exactly one automatic retake
    first, retake = sorted(takes, key=lambda t: t["id"])
    assert first["qc"]["passed"] is False and retake["qc"]["passed"] is False
    assert first["qc"]["identity_ok"] is False and first["qc"]["hand_issues"] is True
    assert retake["params"]["retake_count"] == 1 and any("hands" in f for f in retake["params"]["fix"])
    assert "Fix what was wrong last time" in retake["prompt"]
    with SessionLocal() as db:
        assert db.query(Job).filter(Job.shot_id == s3, Job.type == "keyframe_qc").count() == 2
        assert db.query(Job).filter(Job.shot_id == s3, Job.type == "keyframe").count() == 2


def test_enhance_makes_a_new_take(client: TestClient):
    c = client
    s = _setup(c)
    sid = s["shots"][1]
    ok(c.post(f"/api/shots/{sid}/keyframe", headers=H, json={}))
    wait_jobs(c, s["pid"])
    kf = ok(c.get(f"/api/shots/{sid}"))["keyframe"]
    res = ok(c.post(f"/api/takes/{kf['id']}/enhance", headers=H))
    assert res["jobs"][0]["payload"]["enhance_take_id"] == kf["id"] and res["jobs"][0]["label"].startswith("Enhance")
    wait_jobs(c, s["pid"])
    shot = ok(c.get(f"/api/shots/{sid}"))
    new = shot["keyframe"]
    assert new["id"] != kf["id"] and new["parent_take_id"] == kf["id"] and new["params"]["enhanced_from"] == kf["id"]
    assert new["params"]["engine"] == "google:image_hero" and new["params"]["refs"][0].startswith("the keyframe to enhance")
    assert "Enhance this film still" in new["prompt"]
    assert len([t for t in shot["takes"] if t["kind"] == "keyframe"]) == 2  # the original is kept
    with SessionLocal() as db:
        vid = Take(shot_id=sid, kind="video", path=db.get(Take, kf["id"]).path)
        db.add(vid)
        db.commit()
        vid_id = vid.id
    assert c.post(f"/api/takes/{vid_id}/enhance", headers=H).status_code == 400


def test_approved_keyframes_become_character_references(client: TestClient):
    c = client
    s = _setup(c)
    cid, sid = s["cid"], s["shots"][1]
    ok(c.post(f"/api/shots/{sid}/keyframe", headers=H, json={}))
    wait_jobs(c, s["pid"])
    kf = ok(c.get(f"/api/shots/{sid}"))["keyframe"]
    ok(c.post(f"/api/takes/{kf['id']}/select", headers=H))
    ok(c.post(f"/api/takes/{kf['id']}/select", headers=H))  # picking it again adds nothing
    ok(c.post(f"/api/shots/{sid}/approve", headers=H, json={"approved": True}))  # nor does approving the shot
    with SessionLocal() as db:
        stills = db.query(CharacterAsset).filter(CharacterAsset.character_id == cid, CharacterAsset.kind == STILL_KIND).all()
        assert len(stills) == 1 and stills[0].approved and f"take #{kf['id']}" in stills[0].label
        refs = character_refs(db, db.get(Character, cid), None, 2)
        assert [a.kind for a in refs] == [STILL_KIND, "front"]  # right after approved views (none here), before the rest
        # an approved sheet view still comes first
        front = next(a for a in db.query(CharacterAsset).filter(CharacterAsset.character_id == cid, CharacterAsset.kind == "front"))
        front.approved = True
        db.commit()
        assert [a.kind for a in character_refs(db, db.get(Character, cid), None, 2)] == ["front", STILL_KIND]
        assert any("a still you approved" in l for l in _refs(db, s["shots"][2]))  # and keyframes now use it
        # only the newest 6 stay in use
        src = db.get(Take, kf["id"])
        for _ in range(7):
            t = Take(shot_id=sid, kind="keyframe", provider="upload", path=src.path, params={})
            db.add(t)
            db.flush()
            approved_stills.learn_from_keyframe(db, t)
        db.commit()
        live = db.query(CharacterAsset).filter(CharacterAsset.character_id == cid, CharacterAsset.kind == STILL_KIND,
                                               CharacterAsset.archived.is_(False)).count()
        assert live == approved_stills.MAX_STILLS
        # several characters in one shot: faces are only cropped with the face models installed (not in tests)
        other = Character(name="Extra")
        db.add(other)
        db.flush()
        db.get(Shot, sid).characters = [cid, other.id]
        db.commit()
        assert approved_stills.learn_from_keyframe(db, db.get(Take, kf["id"])) == []
        db.get(Shot, sid).characters = [cid]
        db.commit()
    # a character in many shots without a trained face model: suggest training one
    ch = ok(c.get(f"/api/characters/{cid}"))
    assert ch["training"]["shots"] == 4 and ch["training"]["train_suggested"] is False
    with SessionLocal() as db:
        ep = db.get(Episode, s["eid"])
        for i in range(2):
            db.add(Shot(episode_id=ep.id, order=50 + i, characters=[cid], action="more"))
        db.commit()
    assert ok(c.get(f"/api/characters/{cid}"))["training"]["train_suggested"] is True
