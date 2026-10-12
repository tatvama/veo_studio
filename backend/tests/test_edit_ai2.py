"""Tatvam Editor wave 3 on the studio (docs/EDITOR.md §10): edit backups (dedupe, retention, restore), timeline review
comments pinned to frames, and the new AI tools end to end with mock providers: B-roll ideas, highlights, thumbnails,
music with a mood, voice cloning (only with a consent record) and a mood per scene."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from app.core import edit_ai, edit_backups
from app.db import SessionLocal, utcnow
from app.models import Character, Consent, EditBackup, Episode, Event, Project, Scene, Shot, VoiceProfile
from app.pipeline import ffmpeg as ff
from app.storage import get_storage
from conftest import H, TMP, ok
from test_edit_ai import _creator, _edit, _output, _run, _upload, _wait
from test_fx import _clip


def _doc(name: str = "Wedding film", clips: int = 3, fps: float = 25, tag: str = "") -> dict:
    seq = {"id": "s1", "name": "Sequence 01", "width": 1920, "height": 1080, "fps": fps, "sampleRate": 48000, "tracks": [],
           "clips": [{"id": f"c{i}", "trackId": "v1", "start": i * 100, "duration": 100} for i in range(clips)],
           "transitions": [], "markers": [], "playhead": 0}
    return {"format": "tatvam-edit", "version": 1, "id": "p_wedding", "name": name, "created": "2026-10-12T08:00:00Z",
            "modified": f"2026-10-12T09:00:00Z{tag}", "bins": [], "media": [], "sequences": [seq], "activeSequenceId": "s1",
            "settings": {"copyMedia": False, "proxy": "off", "autosaveSeconds": 10}}


def _backup(c: TestClient, pid: int, doc: dict | bytes, device: str = "EDIT-PC", status: int = 200) -> dict:
    data = doc if isinstance(doc, bytes) else json.dumps(doc).encode()
    r = c.post(f"/api/edits/{pid}/backups", headers=H, files={"file": ("Wedding film.tatvamedit", data, "application/json")},
               data={"device": device})
    assert r.status_code == status, r.text
    return r.json()


# ── backups ──────────────────────────────────────────────────────────────────

def test_backups_dedupe_list_download_restore(client: TestClient):
    c = client
    pid = _edit(c, "Wedding film")
    a = _backup(c, pid, _doc())
    assert not a["deduped"] and a["clip_count"] == 3 and a["sequence_count"] == 1 and a["duration"] == 12.0
    assert a["device"] == "EDIT-PC" and a["name"] == "Wedding film" and a["edit_id"] == "p_wedding" and a["by"]["name"] == "Admin"
    with SessionLocal() as db:
        key = db.get(EditBackup, a["id"]).key
        assert key.startswith(f"projects/{pid}/edit_backups/") and key.endswith(f"-{a['sha256'][:12]}.json")
        assert get_storage().exists(key)
        assert db.query(Event).filter(Event.project_id == pid, Event.type == "edit.backup").count() == 1
    again = _backup(c, pid, _doc(), device="LAPTOP")
    assert again["deduped"] and again["id"] == a["id"] and again["device"] == "EDIT-PC"  # the same content is kept once
    b = _backup(c, pid, _doc(clips=5, tag="x"))
    assert not b["deduped"] and b["id"] != a["id"] and b["clip_count"] == 5
    rows = ok(c.get(f"/api/edits/{pid}/backups"))
    assert [x["id"] for x in rows] == [b["id"], a["id"]]  # newest first

    r = c.get(f"/api/edits/{pid}/backups/{a['id']}")
    assert r.status_code == 200 and json.loads(r.content) == _doc() and ".tatvamedit" in r.headers["content-disposition"]
    res = ok(c.post(f"/api/edits/{pid}/backups/{b['id']}/restore", headers=H))
    assert res["project"] == _doc(clips=5, tag="x") and res["backup"]["id"] == b["id"]

    for bad in (b"not json", json.dumps({"format": "premiere"}).encode(), json.dumps({"format": "tatvam-edit"}).encode(), b""):
        _backup(c, pid, bad, status=400)
    _backup(c, pid, b"{" + b" " * (edit_backups.MAX_BYTES + 10) + b"}", status=413)
    other = _edit(c, "Other edit")
    assert c.get(f"/api/edits/{other}/backups/{a['id']}").status_code == 404  # another edit's backup
    assert c.post(f"/api/edits/{other}/backups/{a['id']}/restore", headers=H).status_code == 404
    studio = ok(c.post("/api/projects", headers=H, json={"concept": "A studio short", "auto_brief": False}))
    assert c.get(f"/api/edits/{studio['id']}/backups").status_code == 404  # only edits have backups


def test_backup_retention():
    now = datetime(2026, 10, 12, 12, 0)
    # a backup every 4 hours (the newest first) for the last 40 days
    rows = [(i, now - timedelta(hours=4 * i)) for i in range(240)]
    keep = edit_backups.keep_ids(rows, now)
    newest = {i for i in range(50)}
    assert newest <= keep
    days = {at.date() for i, at in rows if i in keep and i not in newest}
    assert all(d >= (now - timedelta(days=30)).date() for d in days)
    assert len(keep) == 50 + len({at.date() for _, at in rows if at.date() >= (now - timedelta(days=30)).date()}
                                 - {at.date() for i, at in rows if i in newest})
    assert max(at for i, at in rows if i not in keep) < rows[49][1]  # only backups older than the newest 50 go

    # on the studio: older backups are pruned (rows and files) when a new one comes in
    with SessionLocal() as db:
        p = Project(title="Retention", type="edit", brief={"edit_id": f"p_{uuid.uuid4().hex[:8]}"}, status="edit")
        db.add(p)
        db.commit()
        st = get_storage()
        old = []
        for i in range(70):
            key = f"projects/{p.id}/edit_backups/old-{i}.json"
            st.save_bytes(key, b"{}")
            b = EditBackup(project_id=p.id, key=key, sha256=f"{i:064d}", created_at=utcnow() - timedelta(days=40, hours=i))
            db.add(b)
            old.append(key)
        db.commit()
        b, deduped = edit_backups.save(db, p, json.dumps(_doc()).encode(), device="PC")
        db.commit()
        left = db.query(EditBackup).filter(EditBackup.project_id == p.id).all()
        assert not deduped and len(left) == 50 and b.id in {x.id for x in left}
        gone = [k for k in old if not st.exists(k)]
        assert len(gone) == 21 and all(not db.query(EditBackup).filter(EditBackup.key == k).count() for k in gone)


# ── timeline review comments ─────────────────────────────────────────────────

def test_edit_comments_pinned_to_frames(client: TestClient):
    c = client
    pid = _edit(c, "Review me")
    late = ok(c.post("/api/comments", headers=H, json={"target_type": "edit", "target_id": pid, "body": "Cut this pause",
                                                        "sequence_id": "seq_main", "frame": 250, "timecode": 10.0}))
    early = ok(c.post("/api/comments", headers=H, json={"target_type": "edit", "target_id": pid, "project_id": pid,
                                                         "body": "Logo too big @Admin", "sequence_id": "seq_main", "frame": 12}))
    ok(c.post("/api/comments", headers=H, json={"target_type": "edit", "target_id": pid, "body": "Shorts version: tighter",
                                                "sequence_id": "seq_short", "frame": 40}))
    assert late["project_id"] == pid and late["frame"] == 250 and late["sequence_id"] == "seq_main"
    rows = ok(c.get(f"/api/comments?target_type=edit&target_id={pid}&sequence_id=seq_main"))
    assert [x["id"] for x in rows] == [early["id"], late["id"]]  # by frame
    assert rows[0]["user"]["name"] == "Admin" and rows[0]["mentions"]
    assert len(ok(c.get(f"/api/comments?target_type=edit&target_id={pid}"))) == 3
    assert len(ok(c.get(f"/api/comments?project_id={pid}"))) == 3
    r = ok(c.post(f"/api/comments/{late['id']}/resolve", headers=H))
    assert r["resolved"] is True
    with SessionLocal() as db:
        ev = db.query(Event).filter(Event.project_id == pid, Event.type == "comment.created").order_by(Event.id).all()
        assert [e.payload["frame"] for e in ev] == [250, 12, 40] and ev[0].payload["sequence_id"] == "seq_main"
        assert db.query(Event).filter(Event.project_id == pid, Event.type == "comment.updated").count() == 1

    studio = ok(c.post("/api/projects", headers=H, json={"concept": "A studio short", "auto_brief": False}))
    assert c.post("/api/comments", headers=H, json={"target_type": "edit", "target_id": studio["id"], "body": "x"}).status_code == 404
    assert c.post("/api/comments", headers=H, json={"target_type": "edit", "target_id": pid, "project_id": studio["id"],
                                                    "body": "x"}).status_code == 404
    # the studio's own comments are unchanged; frames belong to edits
    sc = ok(c.post("/api/comments", headers=H, json={"project_id": studio["id"], "target_type": "episode", "target_id": 1,
                                                     "body": "Nice", "timecode": 3.5}))
    assert sc["frame"] is None and sc["timecode"] == 3.5
    assert c.post("/api/comments", headers=H, json={"project_id": studio["id"], "target_type": "episode", "target_id": 1,
                                                    "body": "x", "frame": 3}).status_code == 400
    assert c.post("/api/comments", headers=H, json={"target_type": "episode", "target_id": 1, "body": "x"}).status_code == 422
    assert c.get("/api/comments?target_type=episode&target_id=1").status_code == 422
    assert c.post("/api/comments", headers=H, json={"target_type": "edit", "target_id": pid, "body": "x",
                                                    "sequence_id": "bad id!"}).status_code == 422


# ── the new AI tools (mock providers) ────────────────────────────────────────

def _segments(n: int = 40, step: float = 3.0) -> list[dict]:
    words = ["We drove to the old temple at dawn", "My grandmother told the story of the river",
             "The market was loud and full of colour", "Nobody expected the rain that evening",
             "This is the moment everything changed for us"]
    return [{"start": round(i * step, 2), "end": round(i * step + step - 0.4, 2), "text": words[i % len(words)]} for i in range(n)]


def test_broll_ideas_and_highlights(client: TestClient, monkeypatch):
    c = client
    pid = _edit(c, "Talk")
    segs = _segments()
    ideas = _run(c, pid, "broll_suggest", {"segments": segs, "style": "warm film look", "count": 5})["result"]["ideas"]
    assert len(ideas) == 5 and [x["start"] for x in ideas] == sorted(x["start"] for x in ideas)
    assert all(0 <= x["start"] < x["end"] <= x["start"] + 30 and x["prompt"] and "warm film look" in x["prompt"] for x in ideas)

    h = _run(c, pid, "highlights", {"segments": segs, "target_seconds": 30, "count": 3, "platform": "reels"})["result"]
    picks = h["highlights"]
    lo, hi = edit_ai.highlight_bounds(30)
    starts, ends = {s["start"] for s in segs}, {s["end"] for s in segs}
    assert len(picks) == 3 and h["platform"] == "reels"
    assert all(lo - 0.01 <= x["end"] - x["start"] <= hi + 0.01 and x["start"] in starts and x["end"] in ends for x in picks)
    assert all(not (a["start"] < b["end"] and b["start"] < a["end"]) for i, a in enumerate(picks) for b in picks[i + 1:])
    assert all(x["title"] and x["hook"] for x in picks)
    for bad in ({"target_seconds": 5}, {"target_seconds": 120}, {"count": 9}, {"platform": "myspace"}):
        r = c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "highlights", "params": {"segments": segs, **bad}})
        assert r.status_code == 400, bad

    # whatever the model says: ranges on whole lines, inside the transcript, no overlaps, at most `count`
    monkeypatch.setattr(edit_ai, "mock_highlights", lambda p: {"highlights": [
        {"start": 10.1, "end": 41.0, "title": "One", "hook": "h", "why": "w"},
        {"start": 20.0, "end": 50.0, "title": "Overlaps one", "hook": "", "why": ""},
        {"start": 500.0, "end": 530.0, "title": "Past the end", "hook": "", "why": ""},
        {"start": 60.0, "end": 61.0, "title": "Too short: stretched", "hook": "", "why": ""},
    ]})
    monkeypatch.setattr(edit_ai, "mock_broll", lambda p: {"ideas": [
        {"start": -5, "end": 2, "prompt": "a river at dawn", "reason": "r"}, {"start": 0.1, "end": 0.2, "prompt": "too close", "reason": ""},
        {"start": 50, "end": 200, "prompt": "long", "reason": ""}, {"start": 70, "end": 75, "prompt": "", "reason": "no prompt"}]})
    picks = _run(c, pid, "highlights", {"segments": segs, "target_seconds": 30, "count": 5})["result"]["highlights"]
    assert [x["title"] for x in picks] == ["One", "Too short: stretched"]  # the overlap and the range past the end go
    assert picks[0]["start"] == 9.0 and all(x["end"] in ends and lo - 0.01 <= x["end"] - x["start"] <= hi + 0.01 for x in picks)
    ideas = _run(c, pid, "broll_suggest", {"segments": segs, "count": 6})["result"]["ideas"]
    assert [(x["start"], x["end"], x["prompt"]) for x in ideas] == [(0.0, 2.0, "a river at dawn"), (50.0, 80.0, "long")]


def test_thumbnails_from_a_frame(client: TestClient):
    c = client
    pid = _edit(c, "Thumbs")
    clip = _upload(c, pid, _clip("edit_thumb", "red", seconds=3.0))
    est = ok(c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "thumbnail", "params": {
        "key": clip["key"], "at": 1.5, "title": "Our big day", "count": 2, "aspects": ["16:9", "9:16"]}}))
    assert est["engine_id"] == "google:image" and est["images"] == 4  # Google first (Nano Banana)
    j = _run(c, pid, "thumbnail", {"key": clip["key"], "at": 1.5, "title": "Our big day", "count": 2, "aspects": ["16:9", "9:16"]})
    outs = j["result"]["outputs"]
    assert len(outs) == 4 and j["result"]["engine"] == "google:image"
    assert [(o["aspect"], o["variant"]) for o in outs] == [("16:9", 1), ("16:9", 2), ("9:16", 1), ("9:16", 2)]
    assert all(o["kind"] == "image" and "/edit_ai/" in o["key"] and c.get(o["url"]).status_code == 200 for o in outs)
    assert (outs[0]["width"], outs[0]["height"]) == (1280, 720) and (outs[2]["width"], outs[2]["height"]) == (720, 1280)
    still = TMP / "thumb_still.png"
    ff.run(["-f", "lavfi", "-i", "color=c=blue:s=640x360", "-frames:v", "1", still])
    s = _upload(c, pid, still)
    one = _run(c, pid, "thumbnail", {"frame_key": s["key"], "count": 1})["result"]["outputs"]
    assert len(one) == 1 and one[0]["aspect"] == "16:9"
    sound = _upload(c, pid, TMP / "speech_8.wav") if (TMP / "speech_8.wav").exists() else None
    bads = [{"count": 1}, {"key": clip["key"], "frame_key": s["key"]}, {"frame_key": clip["key"]}, {"key": clip["key"], "count": 5},
            {"key": clip["key"], "aspects": ["4:3"]}]
    if sound:
        bads.append({"key": sound["key"]})
    for bad in bads:
        assert c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "thumbnail", "params": bad}).status_code == 400, bad


def test_music_with_mood_and_bpm(client: TestClient):
    c = client
    pid = _edit(c, "Score")
    est = ok(c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "music", "params": {"mood": "Tense", "bpm": 92, "seconds": 10}}))
    assert "tense, pulsing" in est["prompt"] and "92 BPM" in est["prompt"] and "Tense" in est["items"][0]["label"]
    j = _run(c, pid, "music", {"mood": "tense", "bpm": 92, "seconds": 10})
    o = _output(c, j, "audio")
    assert abs(o["duration"] - 10) < 0.3 and o["mood"] == "tense" and j["result"]["bpm"] == 92
    assert "Instrumental" in j["result"]["prompt"]
    r = _run(c, pid, "music", {"prompt": "sitar and tabla", "mood": "sunlit-haze", "seconds": 6})["result"]
    assert r["prompt"].startswith("sitar and tabla. Mood: sunlit-haze mood")  # an unknown mood is used as it is
    assert edit_ai.mood_words("Noir") == edit_ai.MOODS["noir"][0] and edit_ai.mood_words("") == ""
    for bad in ({"seconds": 10}, {"prompt": "x", "seconds": 10}, {"mood": "calm", "bpm": 400}):
        assert c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "music", "params": bad}).status_code == 400, bad


def _consent(c: TestClient, kind: str = "voice_replication", expires: str = "", name: str = "Asha Rao") -> int:
    return ok(c.post("/api/consents", headers=H, data={"kind": kind, "subject_name": name, "scope": "Tatvam edits",
                                                        "expires_on": expires}))["id"]


def test_voice_clone_needs_consent(client: TestClient):
    c = client
    pid = _edit(c, "Narration")
    long_speech = TMP / "speech_clone.wav"
    if not long_speech.exists():
        ff.write_tone_wav(long_speech, 14.0, freq=200)
    sample = _upload(c, pid, long_speech)
    base = {"sample_key": sample["key"], "name": "Asha narrator", "languages": ["en", "hi"]}

    r = c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "voice_clone", "params": {**base, "consent_id": 999999}})
    assert r.status_code == 403 and "consent record" in r.json()["detail"]
    r = c.post(f"/api/edits/{pid}/ai/run", headers=H, json={"tool": "voice_clone", "params": {**base, "consent_id": 999999}})
    assert r.status_code == 403  # nothing starts without it
    face = _consent(c, kind="likeness")
    r = c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "voice_clone", "params": {**base, "consent_id": face}})
    assert r.status_code == 403 and "not for cloning a voice" in r.json()["detail"]
    old = _consent(c, expires="2020-01-01")
    r = c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "voice_clone", "params": {**base, "consent_id": old}})
    assert r.status_code == 403 and "expired" in r.json()["detail"]
    assert c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "voice_clone", "params": base}).status_code == 400

    cid = _consent(c)
    short = _upload(c, pid, _clip("edit_clone_short", "green", seconds=3.0))
    r = c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "voice_clone", "params": {**base, "consent_id": cid, "sample_key": short["key"]}})
    assert r.status_code == 400 and "10 seconds" in r.json()["detail"]
    priya = _creator(c)
    ppid = _edit(priya, "Priya's narration")
    r = priya.post(f"/api/edits/{ppid}/ai/estimate", headers=H, json={"tool": "voice_clone", "params": {**base, "consent_id": cid}})
    assert r.status_code == 403 and "producer" in r.json()["detail"]

    j = _run(c, pid, "voice_clone", {**base, "consent_id": cid})
    v = j["result"]["voice"]
    assert v["provider"] == "elevenlabs" and v["voice_id"].startswith("mock-clone-") and v["languages"] == ["en", "hi"]
    assert len(v["profile_ids"]) == 2 and v["subject"] == "Asha Rao" and v["consent_id"] == cid
    with SessionLocal() as db:
        ch = db.get(Character, v["character_id"])
        assert ch.name == "Asha narrator" and ch.role == "Cloned voice"
        vps = db.query(VoiceProfile).filter(VoiceProfile.character_id == ch.id).all()
        assert {x.language for x in vps} == {"en", "hi"} and all(x.voice_id == v["voice_id"] and x.settings["consent_id"] == cid for x in vps)
        assert db.get(Consent, cid).character_id == ch.id  # the record now covers this voice
    voices = ok(c.get(f"/api/edits/{pid}/ai/voices?language=hi"))
    mine = [x for x in voices["studio"] if x["profile_id"] in v["profile_ids"]]
    assert mine and mine[0]["voice_id"] == v["voice_id"]
    vo = _run(c, pid, "tts", {"text": "Namaste, welcome to the film.", "language": "hi", "voice": {"profile_id": mine[0]["profile_id"]}})
    assert vo["result"]["voice"]["voice_id"] == v["voice_id"] and _output(c, vo, "audio")


def test_mood_per_scene(client: TestClient, monkeypatch):
    c = client
    pid = _edit(c, "Moods")
    scenes = [{"id": "sc1", "title": "The chase", "emotion": "tense, afraid of being caught"},
              {"id": "sc2", "title": "Wedding night", "emotion": "joyful celebration", "summary": "Everyone dances"},
              {"id": "sc3", "title": "Goodbye", "emotion": "grief", "summary": "She leaves the village"},
              {"id": "sc4", "title": "Interlude"}]
    picks = _run(c, pid, "mood_suggest", {"scenes": scenes})["result"]["moods"]
    assert [x["scene_id"] for x in picks] == ["sc1", "sc2", "sc3", "sc4"]
    assert [x["mood"] for x in picks] == ["tense", "joyful", "melancholy", "cinematic"] and all(x["why"] for x in picks)
    # the editor's own mood names: only those come back
    names = ["Teal Orange", "Warm Glow", "Noir Night", "Golden Hour"]
    picks = _run(c, pid, "mood_suggest", {"scenes": scenes[:2] + [{"id": "sc5", "title": "Detective in the rain", "emotion": "noir"}],
                                          "moods": names})["result"]["moods"]
    assert all(x["mood"] in names for x in picks) and picks[2]["mood"] == "Noir Night"
    # the editor's moods with their own emotion words (lib/moods.ts): those words decide
    looks = [{"id": "thriller", "label": "Thriller", "words": ["afraid", "danger"]}, {"id": "festival", "label": "Festival", "words": ["celebration"]}]
    picks = _run(c, pid, "mood_suggest", {"scenes": scenes[:2], "moods": looks})["result"]["moods"]
    assert [x["mood"] for x in picks] == ["thriller", "festival"]
    assert c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "mood_suggest", "params": {
        "scenes": scenes[:1], "moods": [{"id": "", "words": []}]}}).status_code == 400
    # a model that answers with moods it wasn't given (or skips a scene) is corrected from the scene's words
    monkeypatch.setattr(edit_ai, "mock_moods", lambda p, allowed: {"picks": [{"scene_id": "sc1", "mood": "purple", "why": "?"}]})
    picks = _run(c, pid, "mood_suggest", {"scenes": scenes[:2]})["result"]["moods"]
    assert [x["mood"] for x in picks] == ["tense", "joyful"]
    monkeypatch.setattr(edit_ai, "mock_moods", lambda p, allowed: {"picks": [{"scene_id": "sc1", "mood": "Festival", "why": "a label"}]})
    picks = _run(c, pid, "mood_suggest", {"scenes": scenes[:1], "moods": looks})["result"]["moods"]
    assert picks == [{"scene_id": "sc1", "mood": "festival", "why": "a label"}]  # a label comes back as its id
    assert c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "mood_suggest", "params": {"scenes": []}}).status_code == 400


def test_episode_scenes_for_moods(client: TestClient):
    c = client
    pid = _edit(c, "From an episode")
    with SessionLocal() as db:
        sp = Project(title="Series", type="series")
        db.add(sp)
        db.flush()
        ep = Episode(project_id=sp.id, number=1, title="Pilot")
        db.add(ep)
        db.flush()
        a = Scene(episode_id=ep.id, order=1, title="Market", emotion="joyful", summary="Busy market")
        b = Scene(episode_id=ep.id, order=2, title="Night", emotion="tense")
        db.add_all([a, b])
        db.flush()
        db.add_all([Shot(episode_id=ep.id, scene_id=a.id, order=1, code="E01S01"), Shot(episode_id=ep.id, scene_id=a.id, order=2, code="E01S02"),
                    Shot(episode_id=ep.id, scene_id=b.id, order=3, code="E01S03")])
        db.commit()
        eid = ep.id
    r = ok(c.get(f"/api/edits/{pid}/episode-scenes?episode_id={eid}"))
    assert [(s["title"], s["emotion"], s["shot_codes"]) for s in r["scenes"]] == [("Market", "joyful", ["E01S01", "E01S02"]),
                                                                                  ("Night", "tense", ["E01S03"])]
    assert c.get(f"/api/edits/{pid}/episode-scenes?episode_id=999999").status_code == 404


def test_new_tools_in_status(client: TestClient):
    c = client
    pid = _edit(c)
    st = {t["id"]: t for t in ok(c.get(f"/api/edits/{pid}/ai/tools"))["tools"]}
    for tid in ("broll_suggest", "highlights", "thumbnail", "voice_clone", "mood_suggest"):
        assert st[tid]["ready"], tid
    assert st["voice_clone"]["provider"] == "elevenlabs" and st["thumbnail"]["provider"] == "gemini"
    j = _run(c, pid, "broll_suggest", {"segments": _segments(4)})
    assert _wait(c, pid, j["id"])["status"] == "succeeded"
