"""Start and end frames (core/frames.py): a shot's end frame, synced shots that start exactly on the end frame before,
first + last frame clips, the storyboard run that makes a scene's frames in order, and the project's frames engine."""
from __future__ import annotations

import io
from datetime import timedelta
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from app.core import frames, scene_chain
from app.core.scene_order import held_back
from app.db import SessionLocal, utcnow
from app.models import CharacterAsset, Job, Project, Shot, Take
from app.pipeline.prompting import START_LABEL, compile_endframe_prompt, compile_video_prompt, endframe_refs
from app.storage import get_storage
from conftest import H, ok, wait_jobs


def _png(color=(30, 140, 90), size=(96, 160)) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", size, color).save(b, "PNG")
    return b.getvalue()


def _setup(c: TestClient) -> dict:
    """One scene of three shots (Ravi at the temple) and a second scene of one shot."""
    p = ok(c.post("/api/projects", headers=H, json={"concept": "Lamp in the wind", "type": "short", "auto_brief": False}))
    pid, eid = p["id"], p["episodes"][0]["id"]
    cid = ok(c.post("/api/characters", headers=H, json={"name": "Ravi", "project_id": pid}))["id"]
    st = get_storage()
    with SessionLocal() as db:
        rel = st.save_bytes(st.new_path(f"characters/{cid}", "png"), _png((90, 60, 160)))
        db.add(CharacterAsset(character_id=cid, kind="front", label="front", path=rel))
        db.commit()
    b = ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [
        {"title": "Lamp lit", "location": "Temple courtyard", "time_of_day": "dusk", "shots": [
            {"prompt": "Ravi walks to the lamp.", "framing": "wide", "characters": [cid], "duration_s": 6},
            {"prompt": "Ravi kneels and strikes a match.", "framing": "wide", "characters": [cid], "duration_s": 6},
            {"prompt": "The flame catches.", "framing": "wide", "characters": [cid], "duration_s": 4}]},
        {"title": "At the river", "location": "River ghat", "time_of_day": "night", "shots": [
            {"prompt": "Ravi sets the lamp on the water.", "framing": "medium", "characters": [cid], "duration_s": 6}]},
    ]}))
    return {"pid": pid, "eid": eid, "cid": cid, "scenes": [sc["id"] for sc in b["scenes"]],
            "shots": [s["id"] for sc in b["scenes"] for s in sc["shots"]]}


def _failed(jobs: list[dict]) -> list:
    return [(j["type"], j["error"]) for j in jobs if j["status"] == "failed"]


def test_plan_orders_frames_and_prices_only_real_images(client: TestClient):
    s = _setup(client)
    a, b, c3, d = s["shots"]
    with SessionLocal() as db:
        project = db.get(Project, s["pid"])
        shots = [db.get(Shot, i) for i in (a, b, c3, d)]
        synced = frames.plan(db, project, shots, sync=True)
        assert [(st["code"], st["kind"], st["copy"]) for st in synced["steps"]] == [
            (shots[0].code, "keyframe", False), (shots[0].code, "endframe", False),
            (shots[1].code, "keyframe", True), (shots[1].code, "endframe", False),
            (shots[2].code, "keyframe", True), (shots[2].code, "endframe", False),
            (shots[3].code, "keyframe", False), (shots[3].code, "endframe", False)]  # a new scene: never synced across
        assert (synced["images"], synced["copies"]) == (6, 2)
        starts_only = frames.plan(db, project, shots, end_frames=False)
        assert [st["kind"] for st in starts_only["steps"]] == ["keyframe"] * 4
        db.rollback()  # plan changes nothing
        assert not frames.synced(db.get(Shot, b))


def test_storyboard_run_syncs_a_scene_frame_by_frame(client: TestClient):
    c = client
    s = _setup(c)
    a, b, c3, d = s["shots"]
    pl = ok(c.post(f"/api/episodes/{s['eid']}/storyboard-frames/plan", headers=H,
                   json={"scene_ids": [s["scenes"][0]], "sync": True}))
    assert pl["images"] == 4 and pl["copies"] == 2  # start 1, end 1-3; starts 2-3 are copies
    res = ok(c.post(f"/api/episodes/{s['eid']}/storyboard-frames", headers=H, json={"scene_ids": [s["scenes"][0]], "sync": True}))
    assert res["status"] == "queued" and res["jobs"][0]["type"] == "storyboard_frames"
    jobs = wait_jobs(c, s["pid"], timeout=600)
    assert not _failed(jobs), _failed(jobs)
    st = get_storage()
    with SessionLocal() as db:
        shots = {i: db.get(Shot, i) for i in (a, b, c3)}
        assert frames.synced(shots[b]) and shots[b].continuity_from_shot_id == a
        assert frames.synced(shots[c3]) and shots[c3].continuity_from_shot_id == b
        assert not frames.synced(db.get(Shot, d))  # the other scene was not touched
        for follower, src in ((b, a), (c3, b)):
            end = frames.end_take(db, shots[src])
            kf = db.query(Take).filter(Take.shot_id == follower, Take.kind == "keyframe", Take.selected.is_(True)).one()
            assert kf.params["end_take_id"] == end.id and kf.params["copied"] and kf.cost_usd == 0
            assert st.abs(kf.path).read_bytes() == st.abs(end.path).read_bytes()  # the very same picture
            assert frames.link_out(db, shots[follower])["status"] == "ok"
            assert scene_chain.link_status(db, shots[follower])["mode"] == "end_frame"
        for sid in (a, b, c3):
            end = frames.end_take(db, shots[sid])
            kf = db.query(Take).filter(Take.shot_id == sid, Take.kind == "keyframe", Take.selected.is_(True)).one()
            assert end.params["start_take_id"] == kf.id  # each end frame follows its own start frame
            assert START_LABEL in end.params["refs"]
        made = db.query(Job).filter(Job.project_id == s["pid"], Job.type.in_(("keyframe", "endframe")),
                                    Job.status == "succeeded").order_by(Job.id).all()
        assert [(j.shot_id, j.type) for j in made] == [(a, "keyframe"), (a, "endframe"), (b, "keyframe"), (b, "endframe"),
                                                        (c3, "keyframe"), (c3, "endframe")]  # in order, one at a time
        for prev, nxt in zip(made, made[1:]):
            assert nxt.started_at >= prev.finished_at
        qc = db.query(Job).filter(Job.project_id == s["pid"], Job.type == "keyframe_qc").all()
        assert {(j.shot_id) for j in qc} == {a, b, c3}  # end frames checked too; copies are not
    # nothing left to do: a second run makes nothing
    again = ok(c.post(f"/api/episodes/{s['eid']}/storyboard-frames/plan", headers=H, json={"scene_ids": [s["scenes"][0]]}))
    assert again["steps"] == []


def test_clips_run_from_start_to_end_frame_and_synced_videos_share_one_end_frame(client: TestClient):
    c = client
    s = _setup(c)
    a, b, c3, _ = s["shots"]
    ok(c.patch(f"/api/shots/{b}", headers=H, json={"continuity_from_shot_id": a, "continuity_mode": "end_frame"}))
    ok(c.patch(f"/api/shots/{c3}", headers=H, json={"continuity_from_shot_id": b, "continuity_mode": "end_frame"}))
    ok(c.patch(f"/api/shots/{c3}", headers=H, json={"end_note": "The flame burns steady; Ravi smiles."}))
    # every video at once, nothing made yet: synced shots wait for the end frame they start on
    res = ok(c.post(f"/api/episodes/{s['eid']}/generate", headers=H, json={"action": "videos", "shot_ids": [a, b, c3]}))
    after = {j["shot_id"]: j["payload"].get("after_end") for j in res["jobs"]}
    assert after == {a: None, b: a, c3: b}
    jobs = wait_jobs(c, s["pid"], timeout=900)
    assert not _failed(jobs), _failed(jobs)
    st = get_storage()
    with SessionLocal() as db:
        for sid in (a, b):  # a shot starts on each of these: their clips run to an end frame
            ends = db.query(Take).filter(Take.shot_id == sid, Take.kind == "endframe").all()
            assert len(ends) == 1  # made once, by one job, not again by the shot after it
            vid = db.query(Take).filter(Take.shot_id == sid, Take.kind == "video", Take.selected.is_(True)).one()
            assert vid.params["mode"] == "flf" and vid.params["end_take_id"] == ends[0].id
        for follower, src in ((b, a), (c3, b)):
            kf = db.query(Take).filter(Take.shot_id == follower, Take.kind == "keyframe", Take.selected.is_(True)).one()
            end = frames.end_take(db, db.get(Shot, src))
            assert st.abs(kf.path).read_bytes() == st.abs(end.path).read_bytes()
            assert scene_chain.link_status(db, db.get(Shot, follower))["status"] == "ok"
        # the last shot has no end frame and nobody starts on it: a start-frame clip
        assert db.query(Take).filter(Take.shot_id == c3, Take.kind == "endframe").count() == 0
        assert db.query(Take).filter(Take.shot_id == c3, Take.kind == "video").one().params["mode"] != "flf"
        assert "[END] The shot ends on: The flame burns steady; Ravi smiles." in compile_video_prompt(
            db, db.get(Shot, c3), db.get(Project, s["pid"]))


def test_end_frame_upload_note_and_removal(client: TestClient):
    c = client
    s = _setup(c)
    a = s["shots"][0]
    shot = ok(c.post(f"/api/shots/{a}/endframe/upload", headers=H, files={"file": ("end.png", _png((10, 10, 200)), "image/png")}))
    assert shot["endframe"]["provider"] == "upload" and shot["endframe"]["url"]
    with SessionLocal() as db:
        assert frames.end_take(db, db.get(Shot, a)) is not None and frames.wants_end(db, db.get(Shot, a))
    ok(c.post(f"/api/shots/{a}/endframe", headers=H, json={}))  # a generated one replaces it
    wait_jobs(c, s["pid"])
    shot = ok(c.get(f"/api/shots/{a}"))
    assert shot["endframe"]["provider"] != "upload" and shot["keyframe"] is not None  # its start frame was made first
    assert shot["endframe"]["qc"]["kind"] == "endframe" and shot["endframe"]["qc"]["compared_with_anchor"] is True
    r = ok(c.patch(f"/api/shots/{a}", headers=H, json={"end_note": "Ravi stands, the lamp lit behind him."}))
    assert shot["endframe"]["id"] in r["stale_takes"]  # how it ends changed: the end frame (and the clip) are out of date
    with SessionLocal() as db:
        sh = db.get(Shot, a)
        assert frames.end_take(db, sh) is None and frames.wants_end(db, sh)  # out of date, but still wanted
        prompt = compile_endframe_prompt(db, sh, db.get(Project, s["pid"]),
                                         [l for l, _ in endframe_refs(db, sh, Path("start.png"))])
        assert "Ravi stands, the lamp lit behind him" in prompt and "LAST frame" in prompt
    cleared = ok(c.delete(f"/api/shots/{a}/endframe", headers=H))
    assert cleared["endframe"] is None and cleared["archived"] >= 2
    with SessionLocal() as db:
        assert not frames.wants_end(db, db.get(Shot, a))


def test_frames_engine_is_used_for_start_and_end_frames(client: TestClient):
    c = client
    s = _setup(c)
    d = s["shots"][3]
    engines = ok(c.get(f"/api/projects/{s['pid']}/frames-engines"))
    ids = {e["id"] for e in engines["engines"]}
    assert "byteplus:seedream-5.0-pro" in ids and engines["current"] == ""
    assert c.put(f"/api/projects/{s['pid']}/frames-engine", headers=H, json={"engine": "google:video_saver"}).status_code == 400
    ok(c.put(f"/api/projects/{s['pid']}/frames-engine", headers=H, json={"engine": "byteplus:seedream-5.0-pro"}))
    assert ok(c.get(f"/api/projects/{s['pid']}"))["frames_engine"] == "byteplus:seedream-5.0-pro"
    ok(c.post(f"/api/shots/{d}/endframe", headers=H, json={}))
    jobs = wait_jobs(c, s["pid"])
    assert not _failed(jobs), _failed(jobs)
    shot = ok(c.get(f"/api/shots/{d}"))
    assert shot["keyframe"]["params"]["engine"] == "byteplus:seedream-5.0-pro"
    assert shot["endframe"]["params"]["engine"] == "byteplus:seedream-5.0-pro"
    ok(c.put(f"/api/projects/{s['pid']}/frames-engine", headers=H, json={"engine": ""}))  # back to the team's chain


def test_synced_holds_wait_for_the_chain_above(client: TestClient):
    s = _setup(client)
    a, b, c3, _ = s["shots"]
    with SessionLocal() as db:
        for f, src in ((b, a), (c3, b)):
            sh = db.get(Shot, f)
            sh.continuity_from_shot_id, sh.continuity_mode = src, "end_frame"
        db.commit()
    now = utcnow()
    jb = Job(id=10_000_101, type="video", payload={"after_end": a}, shot_id=b)  # claim candidates, not saved
    jc = Job(id=10_000_102, type="video", payload={"after_end": b}, shot_id=c3)
    with SessionLocal() as db:
        head = Job(type="video", status="queued", shot_id=a, payload={}, label="head (test)")
        db.add(head)
        db.commit()
        try:
            assert held_back(db, [jb, jc], now) == {jb.id, jc.id}  # the head of the chain will make the first end frame
            head.status, head.started_at = "running", now
            db.commit()
            assert held_back(db, [jb, jc], now) == {jb.id, jc.id}
            head.started_at = now - timedelta(hours=1)
            db.commit()
            assert held_back(db, [jb, jc], now) == set()  # running far too long: go ahead without it
            head.started_at = now
            db.add(Take(shot_id=a, kind="endframe", path="end_a.png", provider="upload", params={"uploaded": True}))
            db.commit()
            get_storage().save_bytes("end_a.png", _png())
            assert held_back(db, [jb, jc], now) == set()  # the end frame is there: both go (c3's own source has no job)
        finally:
            head.status = "cancelled"
            db.commit()


def test_synced_links_never_wait_on_clips_or_loop(client: TestClient):
    s = _setup(client)
    a, b, c3, _ = s["shots"]
    with SessionLocal() as db:
        for f, src in ((b, a), (c3, b)):
            sh = db.get(Shot, f)
            sh.continuity_from_shot_id, sh.continuity_mode = src, "end_frame"
        db.commit()
        shots = [db.get(Shot, i) for i in (a, b, c3)]
        assert [[x.id for x in w] for w in scene_chain.waves(db, shots)] == [[a, b, c3]]  # clips side by side
        assert frames.after_end(db, db.get(Shot, c3)) == b
        sa = db.get(Shot, a)  # a loop: a starts on c3's end frame, which comes (through b) from a's own
        sa.continuity_from_shot_id, sa.continuity_mode = c3, "end_frame"
        db.commit()
        assert frames.after_end(db, db.get(Shot, b)) is None and frames.after_end(db, sa) is None
        now = utcnow()
        loop = Job(id=10_000_201, type="video", payload={"after_end": a}, shot_id=b)
        other = Job(type="video", status="queued", shot_id=a, payload={"after_end": c3}, label="loop (test)")
        db.add(other)
        db.commit()
        try:
            assert held_back(db, [loop], now) == set()  # inside a loop nobody waits
        finally:
            other.status = "cancelled"
            sa.continuity_from_shot_id, sa.continuity_mode = None, "last_frame"
            db.commit()
