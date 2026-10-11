"""Desktop finishing room (docs/DESKTOP.md §2): checkout lock, cut versions, manifest, render plan, render upload,
AI upscale and review notes."""
from __future__ import annotations

import io
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import settings_store
from app.core import collab, desktop
from app.db import SessionLocal
from app.main import app
from app.models import AudioAsset, AuditEntry, CharacterAsset, CutLock, Episode, Export, Shot, Take, User
from app.pipeline import ffmpeg as ff
from app.pipeline import fx as fxlib
from app.storage import get_storage
from conftest import H, ok, wait_jobs
from test_board import _project
from test_fx import IDENTITY_CUBE, _clip


def _video(pid: int, sid: int, color: str, selected: bool = False) -> int:
    """A real 2 s 320×240 clip with sound as the shot's newest video take."""
    st = get_storage()
    with SessionLocal() as db:
        rel = st.save_file(st.new_path(f"projects/{pid}/shots/{sid}/video", "mp4"), _clip(f"dk_{color}", color))
        t = Take(shot_id=sid, kind="video", provider="upload", path=rel, duration_s=2.0, status="ready", selected=selected)
        db.add(t)
        db.commit()
        return t.id


def _cut(c: TestClient) -> tuple[int, int, list[int], list[int]]:
    """A project with one episode of three shots in two scenes, each with a real video take."""
    pid, eid = _project(c)
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [
        {"title": "One", "shots": [{"prompt": "A quiet street.", "duration_s": 4}, {"prompt": "A door opens.", "duration_s": 4}]},
        {"title": "Two", "shots": [{"prompt": "A cat looks up.", "duration_s": 4}]}]}))
    with SessionLocal() as db:
        sids = [s.id for s in db.query(Shot).filter(Shot.episode_id == eid).order_by(Shot.order).all()]
    tids = [_video(pid, sid, color) for sid, color in zip(sids, ("red", "blue", "green"))]
    return pid, eid, sids, tids


_OTHER: dict[str, TestClient] = {}


def _other(c: TestClient, email: str = "ravi.editor@test.local", role: str = "creator") -> TestClient:
    """A second signed-in person (their own client, so the admin session stays as it is)."""
    if email not in _OTHER:
        ok(c.post("/api/users", headers=H, json={"email": email, "name": "Ravi", "role": role, "password": "ravi-pass-123"}))
        o = TestClient(app)  # no lifespan: must not stop the shared worker
        ok(o.post("/api/auth/login", headers=H, json={"email": email, "password": "ravi-pass-123"}))
        _OTHER[email] = o
    return _OTHER[email]


# ── checkout lock ────────────────────────────────────────────────────────────

def test_check_cut_unit(client: TestClient):
    pid, eid = _project(client)
    ravi, meera = SimpleNamespace(id=9001), SimpleNamespace(id=9002)
    with SessionLocal() as db:
        db.add(CutLock(episode_id=eid, user_id=9001, client="desktop"))
        db.commit()
        desktop.check_cut(db, eid, ravi)  # the holder passes
        with pytest.raises(HTTPException) as e:
            desktop.check_cut(db, eid, meera)
        assert e.value.status_code == 423 and "on desktop" in e.value.detail and "read-only" in e.value.detail
        shot = SimpleNamespace(episode_id=eid, order=1, include=True, trim_in=0.0, trim_out=0.0, fx={}, overlays=[])
        desktop.check_cut_fields(db, shot, meera, {"include": True, "trim_in": 0.0, "action": "x"})  # nothing in the cut changes
        with pytest.raises(HTTPException):
            desktop.check_cut_fields(db, shot, meera, {"trim_in": 0.5})
        db.query(CutLock).filter(CutLock.episode_id == eid).delete()
        db.commit()


def test_checkout_lock_and_enforcement(client: TestClient):
    c = client
    collab.reset()
    pid, eid, sids, tids = _cut(c)
    other = _other(c)
    assert ok(c.get(f"/api/episodes/{eid}/checkout"))["lock"] is None
    lock = ok(c.post(f"/api/episodes/{eid}/checkout", headers=H, json={"machine": "EDIT-PC"}))["lock"]
    assert lock["mine"] and lock["client"] == "desktop" and lock["machine"] == "EDIT-PC" and lock["user"]["name"] == "Admin"
    assert ok(c.post(f"/api/episodes/{eid}/checkout/heartbeat", headers=H))["lock"]["mine"]
    seen = ok(other.get(f"/api/episodes/{eid}/checkout"))["lock"]
    assert seen["mine"] is False and seen["user"]["name"] == "Admin"

    # someone else: every cut edit is refused …
    r = other.post(f"/api/episodes/{eid}/checkout", headers=H, json={})
    assert r.status_code == 423 and r.json()["detail"].startswith("Checked out by Admin on desktop")
    with SessionLocal() as db:
        aid = AudioAsset(project_id=pid, episode_id=eid, kind="music", path="x/music.wav")
        db.add(aid)
        db.commit()
        aid = aid.id
    refused = [
        other.post(f"/api/episodes/{eid}/shots/reorder", headers=H, json={"shot_ids": list(reversed(sids))}),
        other.patch(f"/api/shots/{sids[0]}", headers=H, json={"trim_in": 0.3}),
        other.patch(f"/api/shots/{sids[0]}", headers=H, json={"include": False}),
        other.put(f"/api/shots/{sids[0]}/fx", headers=H, json={"fx": {"look": "noir"}}),
        other.post(f"/api/episodes/{eid}/fx/apply", headers=H, json={"fx": {"look": "noir"}, "keys": ["look"]}),
        other.put(f"/api/shots/{sids[0]}/overlays", headers=H, json={"overlays": [{"text": "Hi", "start": 0, "end": 1}]}),
        other.put(f"/api/episodes/{eid}/layers", headers=H, json={"rev": 0, "video": [], "audio": []}),
        other.patch(f"/api/episodes/{eid}", headers=H, json={"settings": {"music_volume_db": -10}}),
        other.post(f"/api/audio/{aid}/select", headers=H),
        other.delete(f"/api/shots/{sids[2]}", headers=H),
    ]
    assert [r.status_code for r in refused] == [423] * len(refused), [r.text for r in refused if r.status_code != 423]
    # … while generation-side work, take picks, approvals and story edits stay open
    assert ok(other.patch(f"/api/shots/{sids[0]}", headers=H, json={"action": "A quiet street at dusk.", "include": True}))
    assert ok(other.patch(f"/api/episodes/{eid}", headers=H, json={"title": "Night shift"}))
    ok(other.post(f"/api/takes/{tids[1]}/select", headers=H))
    ok(other.post(f"/api/shots/{sids[1]}/approve", headers=H, json={"approved": True}))
    assert other.post(f"/api/episodes/{eid}/checkout/heartbeat", headers=H).status_code == 409
    assert other.post(f"/api/episodes/{eid}/checkout", headers=H, json={"force": True}).status_code == 403  # creators can't force
    assert other.delete(f"/api/episodes/{eid}/checkout", headers=H).status_code == 403
    assert other.post(f"/api/episodes/{eid}/checkin", headers=H, json={}).status_code == 409
    # the holder edits freely
    assert ok(c.patch(f"/api/shots/{sids[0]}", headers=H, json={"trim_in": 0.3}))["trim_in"] == 0.3

    # presence shows the holder editing the cut
    with SessionLocal() as db:
        admin = db.query(User).filter(User.email == "admin@test.local").first()
    collab.report("desk-tab", admin, pid, "finishing", "")
    me = next(p for p in collab.snapshot(pid)["people"] if p["user_id"] == admin.id)
    assert f"cut:{eid}" in me["editing"]

    # check in: a version, and the cut opens up again
    v = ok(c.post(f"/api/episodes/{eid}/checkin", headers=H, json={"note": "First pass"}))["version"]
    assert v["number"] == 1 and v["note"] == "First pass" and v["client"] == "desktop" and v["stats"]["shots"] == 3
    assert ok(c.get(f"/api/episodes/{eid}/checkout"))["lock"] is None
    assert f"cut:{eid}" not in next(p for p in collab.snapshot(pid)["people"] if p["user_id"] == admin.id)["editing"]
    assert ok(other.patch(f"/api/shots/{sids[0]}", headers=H, json={"trim_in": 0.1}))["trim_in"] == 0.1

    # a producer can take it over (audited), then release it
    ok(other.post(f"/api/episodes/{eid}/checkout", headers=H, json={"machine": "LAPTOP"}))
    assert c.post(f"/api/episodes/{eid}/checkout", headers=H, json={}).status_code == 423
    lock = ok(c.post(f"/api/episodes/{eid}/checkout", headers=H, json={"force": True, "client": "web"}))["lock"]
    assert lock["mine"] and lock["client"] == "web"
    with SessionLocal() as db:
        a = db.query(AuditEntry).filter(AuditEntry.action == "cut.checkout.force").order_by(AuditEntry.id.desc()).first()
        assert a and a.target == f"episode {eid}" and a.detail["from"] == "Ravi"
    assert ok(c.delete(f"/api/episodes/{eid}/checkout", headers=H))["lock"] is None
    assert ok(c.get(f"/api/episodes/{eid}/checkout"))["lock"] is None
    collab.reset()


# ── cut versions ─────────────────────────────────────────────────────────────

def test_versions_restore_round_trip(client: TestClient):
    c = client
    pid, eid, sids, tids = _cut(c)
    ok(c.patch(f"/api/shots/{sids[0]}", headers=H, json={"trim_in": 0.3, "trim_out": 0.2}))
    ok(c.put(f"/api/shots/{sids[1]}/fx", headers=H, json={"fx": {"look": "noir", "transition": {"type": "fade", "duration": 0.5}}}))
    ok(c.post(f"/api/episodes/{eid}/shots/reorder", headers=H, json={"shot_ids": [sids[2], sids[0], sids[1]]}))
    ok(c.patch(f"/api/episodes/{eid}", headers=H, json={"settings": {"music_volume_db": -20}}))
    v1 = ok(c.post(f"/api/episodes/{eid}/versions", headers=H, json={"note": "Locked picture"}))
    assert v1["number"] == 1 and v1["client"] == "web" and v1["stats"]["included"] == 3 and v1["created_by"]["name"] == "Admin"
    full = ok(c.get(f"/api/versions/{v1['id']}"))
    snap = full["snapshot"]
    assert [s["id"] for s in snap["shots"]] == [sids[2], sids[0], sids[1]]
    assert snap["shots"][1]["selected"]["video"] == tids[0] and snap["settings"]["music_volume_db"] == -20
    assert "rev" not in snap["layers"] and snap["music_id"] is None

    # change everything, and make a newer clip the current one
    ok(c.patch(f"/api/shots/{sids[0]}", headers=H, json={"trim_in": 0.6, "trim_out": 0.0}))
    ok(c.put(f"/api/shots/{sids[1]}/fx", headers=H, json={"fx": {}}))
    ok(c.post(f"/api/episodes/{eid}/shots/reorder", headers=H, json={"shot_ids": sids}))
    ok(c.patch(f"/api/shots/{sids[2]}", headers=H, json={"include": False}))
    ok(c.patch(f"/api/episodes/{eid}", headers=H, json={"settings": {"music_volume_db": -10}}))
    newer = _video(pid, sids[0], "yellow")
    with SessionLocal() as db:
        from app.pipeline.selection import current
        assert current(db, sids[0], "video").id == newer
        rev_before = int((db.get(Episode, eid).layers or {}).get("rev") or 0)

    back = ok(c.post(f"/api/versions/{v1['id']}/restore", headers=H))
    assert back["number"] == 3 and back["note"] == "Restored v1" and back["restored_from"] == 1
    assert [v["note"] for v in ok(c.get(f"/api/episodes/{eid}/versions"))] == ["Restored v1", "Before restoring v1", "Locked picture"]
    with SessionLocal() as db:
        from app.pipeline.selection import current
        shots = {s.id: s for s in db.query(Shot).filter(Shot.episode_id == eid).all()}
        assert sorted(shots, key=lambda i: shots[i].order) == [sids[2], sids[0], sids[1]]
        assert (shots[sids[0]].trim_in, shots[sids[0]].trim_out) == (0.3, 0.2)
        assert shots[sids[1]].fx["look"] == "noir" and shots[sids[2]].include is True
        assert current(db, sids[0], "video").id == tids[0]  # the clip that was in the cut back then
        ep = db.get(Episode, eid)
        assert ep.settings["music_volume_db"] == -20 and ep.layers["rev"] == rev_before + 1
        assert shots[sids[2]].code.endswith("SH01")  # codes follow the restored order
    # the "before" version keeps what was replaced, so the restore itself can be undone
    before = ok(c.get(f"/api/versions/{ok(c.get(f'/api/episodes/{eid}/versions'))[1]['id']}"))["snapshot"]
    assert next(s for s in before["shots"] if s["id"] == sids[0])["trim_in"] == 0.6


# ── manifest ─────────────────────────────────────────────────────────────────

def test_manifest_scopes_series_and_folders(client: TestClient):
    c = client
    pid, eid, sids, tids = _cut(c)
    st = get_storage()
    ok(c.post(f"/api/shots/{sids[0]}/approve", headers=H, json={"approved": True}))
    second = _video(pid, sids[0], "white")  # shot 1 now has two takes: the newest is current, as take 2
    ok(c.patch(f"/api/shots/{sids[2]}", headers=H, json={"include": False}))
    ch = ok(c.post("/api/characters", headers=H, json={"name": "Meera", "project_id": pid}))
    with SessionLocal() as db:
        music = st.save_bytes(f"projects/{pid}/audio/music_{eid}.wav", b"RIFF0000WAVE")
        db.add(AudioAsset(project_id=pid, episode_id=eid, kind="music", path=music, duration_s=30.0))
        db.add(CharacterAsset(character_id=ch["id"], kind="front", path=f"projects/{pid}/bible/meera_front.png", approved=True))
        db.add(CharacterAsset(character_id=ch["id"], kind="profile", path=f"projects/{pid}/bible/meera_side.png", approved=False))
        db.add(Export(project_id=pid, episode_id=eid, language="en", preset="shorts", status="ready", version=1, approved_by=1,
                      path=f"projects/{pid}/exports/e01_en_v1.mp4", srt_path=f"projects/{pid}/exports/e01_en_v1.srt"))
        db.add(Export(project_id=pid, episode_id=eid, language="en", preset="shorts", status="ready", version=2,
                      path=f"projects/{pid}/exports/e01_en_v2.mp4"))
        ep = db.get(Episode, eid)
        ep.layers = {"media": [{"src": f"projects/{pid}/layers/a.mp4", "kind": "video", "name": "IMP_0001_broll.mp4"},
                               {"src": f"projects/{pid}/layers/logo.png", "kind": "image", "name": "logo.png"}]}
        db.commit()

    cut = ok(c.get(f"/api/projects/{pid}/desktop/manifest?scope=cut"))
    assert cut["project"]["id"] == pid and cut["generated_at"].endswith("Z")
    ep = cut["episodes"][0]
    assert ep["cut_version"] == 0 and [s["order"] for s in ep["scenes"]] == [1, 2]
    assert [(s["cut_index"], s["scene_order"]) for s in ep["shots"]] == [(1, 1), (2, 1), (None, 2)]
    vids = [i for i in cut["items"] if i["kind"] == "video"]
    assert [i["shot_id"] for i in vids] == [sids[0], sids[1]]  # shot 3 is out of the cut
    v1 = vids[0]
    assert v1["take_id"] == second and v1["folder"] == "Takes" and v1["role"] == "take" and v1["ext"] == "mp4"
    assert v1["series"] == {"season": 1, "episode": 1, "scene": 1, "shot": 1, "cut": 1, "take": 2, "version": 2, "code": v1["series"]["code"]}
    assert v1["approved"] and v1["label"] == "Video take 2" and v1["url"] == f"/media/{v1['key']}"
    folders = {i["folder"] for i in cut["items"]}
    assert {"Audio/Music", "Renders", "Captions", "Bible/Characters", "Imports", "Media"} <= folders
    assert len([i for i in cut["items"] if i["role"] == "render"]) == 2
    assert [i["label"] for i in cut["items"] if i["folder"] == "Bible/Characters"] == ["Meera front"]

    appr = ok(c.get(f"/api/projects/{pid}/desktop/manifest?scope=approved&episode_id={eid}"))
    assert [i["shot_id"] for i in appr["items"] if i["kind"] == "video"] == [sids[0]]  # only the approved shot …
    assert [i["series"]["version"] for i in appr["items"] if i["role"] == "render"] == [1]  # … and the approved render
    ok(c.post(f"/api/takes/{tids[1]}/select", headers=H))  # … plus anything picked by hand
    appr = ok(c.get(f"/api/projects/{pid}/desktop/manifest?scope=approved"))
    assert [i["shot_id"] for i in appr["items"] if i["kind"] == "video"] == [sids[0], sids[1]]
    assert c.get(f"/api/projects/{pid}/desktop/manifest?scope=everything").status_code == 400


# ── render plan ──────────────────────────────────────────────────────────────

def _lut(c: TestClient, pid: int) -> str:
    return ok(c.post(f"/api/projects/{pid}/luts", headers=H, data={"name": "Identity"},
                     files={"file": ("id.cube", io.BytesIO(IDENTITY_CUBE.encode()), "text/plain")}))["id"]


def test_render_plan_matches_the_server_timing(client: TestClient):
    c = client
    pid, eid, sids, tids = _cut(c)
    lid = _lut(c, pid)
    ok(c.patch(f"/api/shots/{sids[0]}", headers=H, json={"trim_in": 0.2, "dialogue": {"en": [{"character_id": None, "line": "Who is there?"}]}}))
    ok(c.put(f"/api/shots/{sids[1]}/fx", headers=H, json={"fx": {"transition": {"type": "fade", "duration": 0.5}, "look": f"lut:{lid}",
                                                                 "speed": 2, "fade_in": 0.3}}))
    ok(c.put(f"/api/shots/{sids[2]}/overlays", headers=H, json={"overlays": [{"text": "The end", "start": 0, "end": 1}]}))
    plan = ok(c.get(f"/api/episodes/{eid}/render-plan?lang=en&w=640&h=360&fps=24"))
    assert (plan["w"], plan["h"], plan["fps"], plan["lang"], plan["cut_version"]) == (640, 360, 24, "en", 0)
    assert len(plan["fingerprint"]) == 40 and plan["loudnorm"] == ff.LOUDNORM
    a, b, z = plan["segments"]
    assert [s["shot_id"] for s in plan["segments"]] == sids and a["source_kind"] == "video" and a["has_audio"]
    assert a["trim_in"] == 0.2 and a["duration"] == 1.8 and a["transition"] is None and a["start"] == 0
    assert b["speed"] == 2 and b["seg_len"] == 1.0 and b["transition"] == ["fade", 0.5] and b["start"] == round(a["seg_len"] - 0.5, 3)
    assert z["start"] == round(b["start"] + b["seg_len"], 3)
    mark = f"@@LUT_{lid}@@"
    assert mark in b["vf_post"] and mark in b["vf"] and fxlib._esc_path(mark) == mark
    assert b["pre"] == "setpts=(PTS-STARTPTS)/2.0," and b["af_fx"].startswith("atempo=2.0") and "afade=t=in" in b["af_fx"]
    assert plan["luts"] == {lid: f"projects/{pid}/luts/{lid}.cube"}
    assert {a["source"], b["source"], z["source"], plan["luts"][lid]} <= set(plan["keys"]) and len(plan["keys"]) == len(set(plan["keys"]))
    caps = plan["captions"]
    assert "Who is there?" in caps["srt"] and caps["burn"] and "[Script Info]" in caps["ass"] and "The end" in caps["ass"]
    assert plan["music"] is None and "No music track yet" in plan["warnings"]
    assert plan["stabilize_filters"]["transform"].startswith("vidstabtransform=input='@@TRF@@'")
    # the filter strings run as they are once the LUT mark becomes a local path
    st = get_storage()
    out = st.tmp_dir() / "seg.mp4"
    vf = b["vf"].replace(mark, fxlib._esc_path(str(st.abs(plan["luts"][lid]))))
    ff.run(["-ss", f"{b['trim_in']:.3f}", "-i", st.abs(b["source"]), "-vf", vf, "-t", f"{b['seg_len']:.3f}", "-an", out])
    assert ff.video_size(out) == (640, 360)
    # same cut, same fingerprint; a trim changes it
    assert ok(c.get(f"/api/episodes/{eid}/render-plan?w=640&h=360"))["fingerprint"] == plan["fingerprint"]
    ok(c.patch(f"/api/shots/{sids[2]}", headers=H, json={"trim_out": 0.5}))
    assert ok(c.get(f"/api/episodes/{eid}/render-plan?w=640&h=360"))["fingerprint"] != plan["fingerprint"]


# ── render upload, server render versions, review notes ──────────────────────

def _upload(c: TestClient, eid: int, data: bytes, **kw) -> dict:
    up = ok(c.post(f"/api/episodes/{eid}/renders/uploads", headers=H, json={
        "filename": "master.mp4", "size": len(data), "language": "en", "preset": "yt4k", "w": 320, "h": 240, "fps": 24,
        "codec": "hevc", "encoder": "hevc_nvenc", "cut_version": 0, "duration_s": 2.0, "machine": "EDIT-PC", **kw}))
    assert up["chunk_size"] == 8 * 1024 * 1024 and len(up["upload_id"]) == 32
    return up


def test_upload_render_versions_and_review_notes(client: TestClient):
    c = client
    pid, eid, sids, tids = _cut(c)
    data = _clip("dk_red", "red").read_bytes()
    up = _upload(c, eid, data)
    uid, half = up["upload_id"], len(data) // 2
    assert ok(c.put(f"/api/renders/uploads/{uid}?offset=0", headers=H, content=data[:half]))["received"] == half
    r = c.put(f"/api/renders/uploads/{uid}?offset=0", headers=H, content=data[:half])  # a resend from the wrong place
    assert r.status_code == 409 and r.json()["received"] == half
    assert ok(c.get(f"/api/renders/uploads/{uid}")) == {"upload_id": uid, "received": half, "size": len(data)}
    r = c.post(f"/api/renders/uploads/{uid}/complete", headers=H, json={})
    assert r.status_code == 409 and r.json()["received"] == half
    assert c.put(f"/api/renders/uploads/{uid}?offset={half}", headers=H, content=data[half:] + b"extra").status_code == 400
    assert ok(c.put(f"/api/renders/uploads/{uid}?offset={half}", headers=H, content=data[half:]))["received"] == len(data)
    x1 = ok(c.post(f"/api/renders/uploads/{uid}/complete", headers=H, json={"srt": "1\n00:00:00,000 --> 00:00:01,000\nHello\n"}))
    assert (x1["status"], x1["version"], x1["kind"], x1["preset"]) == ("ready", 1, "final", "desktop:yt4k")
    assert x1["options"]["source"] == "desktop" and x1["options"]["encoder"] == "hevc_nvenc" and x1["options"]["cut_version"] == 0
    assert f"_en_yt4k_v1_{x1['id']}.mp4" in x1["path"] and x1["thumb_url"] and x1["srt_url"] and x1["peaks"]
    assert c.get(x1["url"]).content == data
    assert c.get(f"/api/renders/uploads/{uid}").status_code == 404  # finished uploads are gone
    assert c.post(f"/api/episodes/{eid}/renders/uploads", headers=H, json={"filename": "x.mp4", "size": 0}).status_code == 400
    with SessionLocal() as db:
        settings_store.set_setting(db, "desktop_upload_max_mb", 1)
        db.commit()
    assert c.post(f"/api/episodes/{eid}/renders/uploads", headers=H, json={"filename": "x.mp4", "size": 2 * 1024 * 1024}).status_code == 413
    with SessionLocal() as db:
        settings_store.set_setting(db, "desktop_upload_max_mb", 8000)
        db.commit()

    up2 = _upload(c, eid, data, preset="master_prores", filename="master.mov")
    ok(c.put(f"/api/renders/uploads/{up2['upload_id']}?offset=0", headers=H, content=data))
    x2 = ok(c.post(f"/api/renders/uploads/{up2['upload_id']}/complete", headers=H, json={}))
    assert x2["version"] == 2 and x2["preset"] == "desktop:master_prores" and x2["path"].endswith(".mov") and not x2["srt_url"]

    # a server render takes the next number from the same counter, and records which cut it shows
    ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "export", "preset": "draft", "music": False}))
    wait_jobs(c, pid)
    with SessionLocal() as db:
        x3 = db.query(Export).filter(Export.episode_id == eid).order_by(Export.id.desc()).first()
        assert x3.status == "ready" and x3.version == 3 and x3.options["cut_version"] == 0 and len(x3.options["fingerprint"]) == 40
        x3_id = x3.id

    # review notes: newest render first, and whether their timecodes still land on the cut
    for xid, tc in ((x1["id"], 1.5), (x1["id"], 0.5), (x3_id, 2.0)):
        ok(c.post("/api/comments", headers=H, json={"project_id": pid, "target_type": "export", "target_id": xid,
                                                    "body": f"Note at {tc}", "timecode": tc}))
    notes = ok(c.get(f"/api/episodes/{eid}/review-notes"))
    assert [(n["export_id"], n["timecode"]) for n in notes] == [(x3_id, 2.0), (x1["id"], 0.5), (x1["id"], 1.5)]
    assert notes[0]["export_version"] == 3 and notes[0]["author"]["name"] == "Admin" and all(n["maps_to_cut"] for n in notes)
    ok(c.post(f"/api/episodes/{eid}/versions", headers=H, json={"note": "v1"}))  # a new cut version, same cut
    notes = ok(c.get(f"/api/episodes/{eid}/review-notes"))
    assert notes[0]["maps_to_cut"] and not notes[1]["maps_to_cut"]  # the server render knows its cut; the upload said v0
    ok(c.patch(f"/api/shots/{sids[0]}", headers=H, json={"trim_in": 0.4}))
    assert not ok(c.get(f"/api/episodes/{eid}/review-notes"))[0]["maps_to_cut"]


# ── AI upscale ───────────────────────────────────────────────────────────────

def test_upscale_estimate_submit_and_plan(client: TestClient):
    c = client
    pid, eid, sids, tids = _cut(c)
    est = ok(c.post(f"/api/episodes/{eid}/upscale/estimate", headers=H, json={"target_h": 480}))
    assert [i["shot_id"] for i in est["items"]] == sids and est["total_usd"] == 0 and est["skipped"] == []
    assert est["items"][0]["from"] == [320, 240] and est["items"][0]["to"] == [640, 480] and est["items"][0]["factor"] == 2.0
    big = ok(c.post(f"/api/episodes/{eid}/upscale/estimate", headers=H, json={"target_h": 360, "shot_ids": [sids[0]]}))
    assert len(big["items"]) == 1
    assert c.post(f"/api/episodes/{eid}/upscale/estimate", headers=H, json={"target_h": 100}).status_code == 400

    res = ok(c.post(f"/api/episodes/{eid}/upscale", headers=H, json={"target_h": 480, "shot_ids": [sids[0]]}))
    assert res["status"] == "queued" and len(res["jobs"]) == 1 and res["jobs"][0]["type"] == "upscale" and res["total_usd"] == 0
    jobs = wait_jobs(c, pid)
    assert next(j for j in jobs if j["type"] == "upscale")["status"] == "succeeded"
    st = get_storage()
    with SessionLocal() as db:
        up = db.query(Take).filter(Take.shot_id == sids[0], Take.kind == "upscale").one()
        assert up.parent_take_id == tids[0] and up.params["w"] == 640 and up.params["factor"] == 2.0 and up.status == "ready"
        assert ff.video_size(st.abs(up.path)) == (640, 480) and ff.has_audio(st.abs(up.path))
        up_path, up_id = up.path, up.id
    skipped = ok(c.post(f"/api/episodes/{eid}/upscale/estimate", headers=H, json={"target_h": 480}))["skipped"]
    assert skipped == [{"shot_id": sids[0], "code": skipped[0]["code"], "reason": "Already upscaled"}]

    plan = ok(c.get(f"/api/episodes/{eid}/render-plan?w=640&h=480&upscaled=1"))
    assert [s["upscaled"] for s in plan["segments"]] == [True, False, False] and plan["segments"][0]["source"] == up_path
    assert not ok(c.get(f"/api/episodes/{eid}/render-plan?w=640&h=480"))["segments"][0]["upscaled"]
    cut = ok(c.get(f"/api/projects/{pid}/desktop/manifest?scope=cut"))
    assert any(i["take_id"] == up_id and i["kind"] == "upscale" and i["folder"] == "Takes" for i in cut["items"])

    # a newer video makes the upscale stale: the plan goes back to the clip, the estimate offers it again
    _video(pid, sids[0], "pink")
    plan = ok(c.get(f"/api/episodes/{eid}/render-plan?w=640&h=480&upscaled=1"))
    assert not plan["segments"][0]["upscaled"]
    assert sids[0] in [i["shot_id"] for i in ok(c.post(f"/api/episodes/{eid}/upscale/estimate", headers=H, json={"target_h": 480}))["items"]]
    assert not any(i.get("take_id") == up_id for i in ok(c.get(f"/api/projects/{pid}/desktop/manifest?scope=cut"))["items"])


def test_migration_adds_desktop_tables_and_columns(client: TestClient):
    from sqlalchemy import inspect, text

    from app.db import engine, is_sqlite
    from app.db_migrate import migrate
    if not is_sqlite():
        return
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE cut_locks"))
    dropped = True
    try:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE exports DROP COLUMN version"))
    except Exception:  # an old SQLite without DROP COLUMN: the table part is still checked
        dropped = False
    changed = migrate()
    assert "cut_locks" in inspect(engine).get_table_names()
    assert "version" in {col["name"] for col in inspect(engine).get_columns("exports")}
    assert ("exports.version" in changed) is dropped and migrate() == []
