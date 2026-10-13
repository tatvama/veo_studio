"""Tatvam Editor AI tools (docs/EDITOR.md §8): the edit's hidden studio project, media uploads, every tool's estimate and
run end to end with mock providers, the budget/approval path, and the edit assistant's command validation."""
from __future__ import annotations

import time
import uuid

import pytest
from fastapi.testclient import TestClient

from app import settings_store
from app.core import budget as budget_mod
from app.core import edit_ai
from app.db import SessionLocal
from app.main import app
from app.models import Project
from app.pipeline import ffmpeg as ff
from conftest import H, TMP, ok
from test_fx import _clip

DONE = ("succeeded", "failed", "cancelled")


def _edit(c: TestClient, name: str = "My edit") -> int:
    return ok(c.post("/api/edits", headers=H, json={"name": name, "edit_id": f"p_{uuid.uuid4().hex[:10]}"}))["id"]


def _upload(c: TestClient, pid: int, path, name: str | None = None) -> dict:
    return ok(c.post(f"/api/edits/{pid}/assets", headers=H, files={"file": (name or path.name, path.read_bytes(), "application/octet-stream")}))


def _speech(seconds: float = 8.0):
    out = TMP / f"speech_{seconds:g}.wav"
    if not out.exists():
        ff.write_tone_wav(out, seconds, freq=180)
    return out


def _wait(c: TestClient, pid: int, jid: int, timeout: float = 240, until=DONE) -> dict:
    start = time.time()
    while time.time() - start < timeout:
        j = ok(c.get(f"/api/edits/{pid}/ai/jobs/{jid}"))
        if j["status"] in until:
            return j
        time.sleep(0.5)
    raise AssertionError(f"job {jid} still {j['status']}")


def _run(c: TestClient, pid: int, tool: str, params: dict, what: str = "") -> dict:
    """Estimate (free in mock mode, budget ok), run, wait: the finished job."""
    est = ok(c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": tool, "params": params, "what": what}))
    assert est["tool"] == tool and est["total_usd"] == 0 and est["budget"]["ok"] and est["items"], est
    res = ok(c.post(f"/api/edits/{pid}/ai/run", headers=H, json={"tool": tool, "params": params, "what": what}))
    assert res["status"] == "queued" and res["job_id"] and res["jobs"][0]["type"] == edit_ai.TOOLS[tool].job
    j = _wait(c, pid, res["job_id"])
    assert j["status"] == "succeeded", j["error"]
    assert j["result"]["tool"] == tool and isinstance(j["result"]["outputs"], list)
    return j


def _output(c: TestClient, j: dict, kind: str) -> dict:
    o = j["result"]["outputs"][0]
    assert o["kind"] == kind and o["key"].startswith("projects/") and "/edit_ai/" in o["key"] and o["url"] == f"/media/{o['key']}"
    assert c.get(o["url"]).status_code == 200
    return o


# ── the edit's studio project ────────────────────────────────────────────────

def test_edit_project_is_made_once_and_hidden(client: TestClient):
    c = client
    eid = f"p_{uuid.uuid4().hex[:10]}"
    a = ok(c.post("/api/edits", headers=H, json={"name": "Wedding film", "edit_id": eid}))
    assert a["type"] == "edit" and a["name"] == "Wedding film" and a["edit_id"] == eid and a["owner"]["name"] == "Admin"
    b = ok(c.post("/api/edits", headers=H, json={"name": "Wedding film v2", "edit_id": eid}))
    assert b["id"] == a["id"] and b["name"] == "Wedding film v2"  # the same edit, renamed on the PC
    assert ok(c.get(f"/api/edits/{a['id']}"))["edit_id"] == eid
    assert a["id"] not in [p["id"] for p in ok(c.get("/api/projects"))]  # not in the studio's lists
    with SessionLocal() as db:
        assert db.get(Project, a["id"]).type == "edit"
    studio = ok(c.post("/api/projects", headers=H, json={"concept": "A studio short", "auto_brief": False}))
    assert c.get(f"/api/edits/{studio['id']}").status_code == 404
    assert c.post("/api/edits", headers=H, json={"name": "x", "edit_id": "bad id!"}).status_code == 422


def test_upload_assets(client: TestClient):
    c = client
    pid = _edit(c)
    clip = _clip("edit_up", "red")
    up = _upload(c, pid, clip)
    assert up["key"].startswith(f"projects/{pid}/edit_assets/") and up["key"].endswith(".mp4")
    assert up["kind"] == "video" and up["has_audio"] and abs(up["duration"] - 2.0) < 0.2 and (up["width"], up["height"]) == (320, 240)
    assert _upload(c, pid, clip)["key"] == up["key"]  # the same file is kept once
    wav = _upload(c, pid, _speech())
    assert wav["kind"] == "audio" and wav["has_audio"] and wav["duration"] > 7
    r = c.post(f"/api/edits/{pid}/assets", headers=H, files={"file": ("notes.txt", b"hello", "text/plain")})
    assert r.status_code == 400
    r = c.post(f"/api/edits/{pid}/assets", headers=H, files={"file": ("broken.mp4", b"not a video", "video/mp4")})
    assert r.status_code == 400
    with SessionLocal() as db:
        settings_store.set_setting(db, "desktop_upload_max_mb", 0.0001)
        db.commit()
    try:
        assert c.post(f"/api/edits/{pid}/assets", headers=H, files={"file": ("a.mp4", clip.read_bytes(), "video/mp4")}).status_code == 413
    finally:
        with SessionLocal() as db:
            settings_store.set_setting(db, "desktop_upload_max_mb", 8000)
            db.commit()
    # studio media of other projects works (an episode imported into the edit); nothing outside the projects' folders
    other = _edit(c, "Other")
    assert ok(c.post(f"/api/edits/{other}/ai/estimate", headers=H, json={"tool": "transcribe", "params": {"key": up["key"]}}))
    for bad in ("_tmp/x.mp4", f"projects/{pid}/../../app.db", "C:/Windows/win.ini"):
        r = c.post(f"/api/edits/{other}/ai/estimate", headers=H, json={"tool": "transcribe", "params": {"key": bad}})
        assert r.status_code == 400 and "isn't studio media" in r.json()["detail"], bad
    r = c.post(f"/api/edits/{other}/ai/estimate", headers=H, json={"tool": "transcribe", "params": {"key": f"projects/{pid}/edit_assets/gone.mp4"}})
    assert r.status_code == 404


# ── every tool, end to end (mock providers) ──────────────────────────────────

def test_tools_status_and_voices(client: TestClient):
    c = client
    pid = _edit(c)
    st = ok(c.get(f"/api/edits/{pid}/ai/tools"))
    assert {t["id"] for t in st["tools"]} == set(edit_ai.TOOLS) and all(t["ready"] for t in st["tools"])
    assert {lang["code"] for lang in st["languages"]} == set(edit_ai.LANGS)
    v = ok(c.get(f"/api/edits/{pid}/ai/voices?language=hi"))
    assert v["default"] == {"provider": "gemini", "voice_id": "Kore"}
    gem = next(p for p in v["providers"] if p["provider"] == "gemini")
    assert any(x["voice_id"] == "Kore" for x in gem["voices"])


def test_captions_translate_and_voice(client: TestClient):
    c = client
    pid = _edit(c)
    sound = _upload(c, pid, _speech())
    j = _run(c, pid, "transcribe", {"key": sound["key"], "language": "auto", "words": True}, what="speech.wav")
    r = j["result"]
    assert j["label"].startswith("Captions: speech.wav") and r["language"] == "en" and r["offset"] == 0
    segs = r["segments"]
    assert len(segs) >= 2 and all(0 <= s["start"] < s["end"] <= 8.0 for s in segs) and segs[0]["text"]
    assert all(segs[i]["end"] <= segs[i + 1]["start"] for i in range(len(segs) - 1))  # captions never overlap
    w = segs[0]["words"]
    assert len(w) == len(segs[0]["text"].split()) and w[0]["start"] == segs[0]["start"] and w[-1]["end"] <= segs[0]["end"] + 1e-6
    # a range of the media: times count from its start
    part = _run(c, pid, "transcribe", {"key": sound["key"], "language": "hi", "words": False, "start": 2, "end": 6})["result"]
    assert part["language"] == "hi" and part["offset"] == 2 and all(s["end"] <= 4.0 + 1e-6 for s in part["segments"])
    assert "words" not in part["segments"][0]
    assert c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "transcribe", "params": {"key": sound["key"], "language": "xx"}}).status_code == 400
    for bad in ({"start": 5, "end": 3}, {"start": 30}):  # an empty range, a range past the end
        assert c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "transcribe", "params": {"key": sound["key"], **bad}}).status_code == 400

    tr = _run(c, pid, "translate", {"segments": [{k: s[k] for k in ("start", "end", "text")} for s in segs], "target": "kn"})["result"]
    assert tr["language"] == "kn" and [(s["start"], s["end"]) for s in tr["segments"]] == [(s["start"], s["end"]) for s in segs]
    assert tr["segments"][0]["text"] != segs[0]["text"] and "words" not in tr["segments"][0]

    vo = _run(c, pid, "tts", {"text": "Welcome to the wedding of Asha and Ravi. " * 3, "language": "en"})
    o = _output(c, vo, "audio")
    assert o["duration"] > 1 and vo["result"]["voice"]["provider"] == "gemini"
    sarvam = _run(c, pid, "tts", {"text": "नमस्ते", "language": "hi", "voice": {"provider": "sarvam", "voice_id": "anand"}})
    assert sarvam["result"]["voice"] == {"provider": "sarvam", "voice_id": "anand", "style": ""}
    r = c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "tts", "params": {"text": "x", "voice": {"provider": "elevenlabs"}}})
    assert r.status_code == 400 and "ElevenLabs voice" in r.json()["detail"]
    assert len(edit_ai.tts_chunks("Hello there. " * 400)) > 3 and all(len(x) <= 1200 for x in edit_ai.tts_chunks("word " * 2000))


def test_dub_and_clean_voice(client: TestClient):
    c = client
    pid = _edit(c)
    clip = _upload(c, pid, _clip("edit_dub", "blue", seconds=6.0))
    est = ok(c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "dub", "params": {"key": clip["key"], "target": "hi"}}))
    assert len(est["items"]) == 3  # listening, translation, voice
    d = _run(c, pid, "dub", {"key": clip["key"], "target": "hi", "source_lang": "en"})["result"]
    track = d["outputs"][0]
    assert track["kind"] == "audio" and track["role"] == "track" and abs(track["duration"] - 6.0) < 0.6
    assert d["language"] == "hi" and len(d["lines"]) == len(d["segments"]) >= 1
    assert all(line["start"] == s["start"] and line["text"] == s["text"] for line, s in zip(d["lines"], d["segments"]))
    cv = _run(c, pid, "clean_voice", {"key": clip["key"], "start": 1, "end": 4})
    o = _output(c, cv, "audio")
    assert abs(o["duration"] - 3.0) < 0.3 and cv["result"]["offset"] == 1
    image = TMP / "edit_still.png"
    ff.run(["-f", "lavfi", "-i", "color=c=green:s=320x240", "-frames:v", "1", image])
    still = _upload(c, pid, image)
    r = c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "clean_voice", "params": {"key": still["key"]}})
    assert r.status_code == 400 and "no sound" in r.json()["detail"]


def test_sound_tools(client: TestClient):
    c = client
    pid = _edit(c)
    fx = _output(c, _run(c, pid, "sfx", {"prompt": "door slams shut", "seconds": 2.5}), "audio")
    assert abs(fx["duration"] - 2.5) < 0.2 and fx["name"].startswith("SFX")
    m = _output(c, _run(c, pid, "music", {"prompt": "soft sitar, hopeful", "seconds": 12}), "audio")
    assert abs(m["duration"] - 12) < 0.3  # exactly the asked length
    clip = _upload(c, pid, _clip("edit_sfx", "green"))
    ideas = _run(c, pid, "sfx_suggest", {"key": clip["key"], "at": 1.0})["result"]
    assert len(ideas["suggestions"]) >= 3 and all(isinstance(s, str) and s for s in ideas["suggestions"])
    assert c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "sfx", "params": {"prompt": "x", "seconds": 99}}).status_code == 400
    assert c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "nope", "params": {}}).status_code == 400


def test_picture_tools(client: TestClient):
    c = client
    pid = _edit(c)
    clip = _upload(c, pid, _clip("edit_pic", "yellow", seconds=3.0))
    est = ok(c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "video", "params": {"prompt": "a busy market", "seconds": 12}}))
    assert est["engine_id"] == "google:video_saver" and est["seconds"] == 8 and est["mode"] == "t2v"  # Google first, Veo's longest
    b = _run(c, pid, "video", {"prompt": "a busy market at dusk", "seconds": 4, "aspect": "16:9"})
    o = _output(c, b, "video")
    assert b["result"]["engine"] == "google:video_saver" and abs(o["duration"] - 4) < 0.3
    assert ff.video_size(_local(o["key"])) == (1280, 720)
    ff_first = _run(c, pid, "video", {"prompt": "the same street, wider", "seconds": 4, "first_frame_key": clip["key"],
                                      "first_frame_at": 1.0, "route": "google:video_saver"})
    assert ff_first["result"]["mode"] == "i2v"
    r = c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "video", "params": {"prompt": "x y", "route": "fal:nope"}})
    assert r.status_code == 400 and "Model Hub" in r.json()["detail"]

    ext = _run(c, pid, "extend", {"key": clip["key"], "seconds": 4, "prompt": "the camera keeps drifting left"})
    assert ext["result"]["mode"] == "i2v" and _output(c, ext, "video")["duration"] > 3

    ew = _run(c, pid, "edit_words", {"key": clip["key"], "instruction": "make it night", "start": 0.5, "end": 2.5})
    assert ew["result"]["engine"] == "google:omni" and ew["result"]["offset"] == 0.5
    assert abs(_output(c, ew, "video")["duration"] - 2.0) < 0.3

    up = _run(c, pid, "upscale", {"key": clip["key"], "target_h": 480})
    o = _output(c, up, "video")
    assert (o["width"], o["height"]) == (640, 480) and ff.video_size(_local(o["key"])) == (640, 480) and ff.has_audio(_local(o["key"]))
    assert c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "upscale", "params": {"key": o["key"], "target_h": 480}}).status_code == 400
    assert c.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "upscale", "params": {"key": clip["key"], "target_h": 100}}).status_code == 400


def _local(key: str):
    from app.storage import get_storage
    return get_storage().abs(key)


# ── budgets and approvals ────────────────────────────────────────────────────

_PRIYA: dict[str, TestClient] = {}


def _creator(c: TestClient) -> TestClient:
    """A creator with no monthly allowance: anything that costs money needs a producer's approval."""
    if not _PRIYA:
        ok(c.post("/api/users", headers=H, json={"email": "editor.priya@test.local", "name": "Priya", "role": "creator",
                                                 "password": "priya-pass-123", "monthly_limit_usd": 0.0}))
        o = TestClient(app)  # no lifespan: must not stop the shared worker
        ok(o.post("/api/auth/login", headers=H, json={"email": "editor.priya@test.local", "password": "priya-pass-123"}))
        _PRIYA["c"] = o
    return _PRIYA["c"]


def test_paid_tool_over_a_limit_waits_for_approval(client: TestClient, monkeypatch):
    c = client
    priya = _creator(c)
    pid = _edit(priya, "Priya's reel")
    # prices as if Gemini were live (the run itself still uses the mock providers)
    monkeypatch.setattr(budget_mod, "provider_mode", lambda p: "live" if p == "gemini" else "mock")
    est = ok(priya.post(f"/api/edits/{pid}/ai/estimate", headers=H, json={"tool": "music", "params": {"prompt": "calm flute", "seconds": 20}}))
    assert est["total_usd"] > 0 and not est["budget"]["ok"] and est["budget"]["needs_role"] == "producer"
    res = ok(priya.post(f"/api/edits/{pid}/ai/run", headers=H, json={"tool": "music", "params": {"prompt": "calm flute", "seconds": 20}}))
    assert res["status"] == "awaiting_approval" and res["total_usd"] == est["total_usd"] and "monthly limit" in res["reason"]
    assert _wait(priya, pid, res["job_id"], timeout=5, until=("awaiting_approval",))["status"] == "awaiting_approval"
    appr = next(a for a in ok(c.get("/api/approvals")) if a["batch_id"] == res["batch_id"])
    assert appr["project_title"] == "Priya's reel" and appr["needs_role"] == "producer"
    assert priya.post(f"/api/approvals/{appr['id']}/decide", headers=H, json={"approve": True}).status_code == 403
    ok(c.post(f"/api/approvals/{appr['id']}/decide", headers=H, json={"approve": True}))
    j = _wait(priya, pid, res["job_id"])
    assert j["status"] == "succeeded" and j["result"]["outputs"][0]["kind"] == "audio"
    monkeypatch.undo()
    # the edit's spend is its studio project's
    assert ok(c.get(f"/api/edits/{pid}"))["spent_usd"] == 0  # mock providers book nothing


# ── the edit assistant ───────────────────────────────────────────────────────

DIGEST = {
    "name": "Sequence 01", "fps": 25, "duration": 60.0, "playhead": 3.0,
    "tracks": [{"id": "v1", "kind": "video", "name": "V1"}, {"id": "v2", "kind": "video", "name": "V2", "locked": True},
               {"id": "a1", "kind": "audio", "name": "A1"}],
    "clips": [{"id": "c1", "track_id": "v1", "start": 0, "end": 20, "name": "intro.mp4", "media_kind": "video", "has_audio": True},
              {"id": "c2", "track_id": "v1", "start": 20, "end": 60, "name": "talk.mp4", "media_kind": "video", "has_audio": True},
              {"id": "c3", "track_id": "v2", "start": 5, "end": 10, "name": "logo.png", "media_kind": "image"},
              {"id": "c4", "track_id": "a1", "start": 0, "end": 60, "name": "music.wav", "media_kind": "audio", "has_audio": True}],
    "effects": ["blur", "vignette"], "transitions": ["fade", "dissolve", "wipeleft"],
}


def test_assistant_returns_only_valid_commands(client: TestClient, monkeypatch):
    c = client
    pid = _edit(c)
    j = _run(c, pid, "assistant", {"instruction": "Cut this to 30 seconds, add markers and a fade transition, then captions",
                                   "sequence_digest": DIGEST})
    r = j["result"]
    ops = [x["op"] for x in r["commands"]]
    assert r["reply"].startswith("MOCK") and ops == ["trim_to_duration", "add_markers", "add_transition", "add_captions"]
    assert r["commands"][0] == {"op": "trim_to_duration", "seconds": 30.0, "id": "cmd_1", "summary": "Trim the sequence to 0:30.0",
                                "paid": False}
    assert r["commands"][2]["clip_id"] == "c2" and r["commands"][3]["paid"] is True

    # whatever the model says, only well-formed commands that fit this sequence come back
    def model_says(instruction, digest):
        return {"reply": "Done.", "commands": [
            {"op": "trim_to_duration", "seconds": 45},
            {"op": "explode_everything"},
            {"op": "trim_to_duration"},                                     # missing seconds
            {"op": "move_clip", "clip_id": "nope", "to": 3},                # unknown clip
            {"op": "move_clip", "clip_id": "c1", "to": 3, "track_id": "a1"},  # video onto an audio track
            {"op": "delete_clip", "clip_id": "c3"},                         # on a locked track
            {"op": "set_speed", "clip_id": "c2", "speed": 50},              # out of range
            {"op": "add_transition", "clip_id": "c2", "type": "glitchy-zoom"},  # the editor has no such transition
            {"op": "set_effect", "clip_id": "c1", "effect": "vignette", "params": [{"name": "amount", "number": 0.4}]},
            {"op": "set_volume", "clip_id": "c4", "gain_db": -6},
            {"op": "add_title", "text": "Chapter one", "at": 2, "duration": 3, "position": "top"},
            {"op": "remove_range", "start": 10, "end": 5},                  # end before start
        ]}
    monkeypatch.setattr(edit_ai, "mock_assistant", model_says)
    r = _run(c, pid, "assistant", {"instruction": "tidy it up", "sequence_digest": DIGEST})["result"]
    assert r["reply"] == "Done."
    assert [x["op"] for x in r["commands"]] == ["trim_to_duration", "set_effect", "set_volume", "add_title"]
    assert r["commands"][1]["params"] == {"amount": 0.4} and r["commands"][3]["position"] == "top"
    assert len(r["rejected"]) == 8 and {x["op"] for x in r["rejected"]} >= {"explode_everything", "move_clip", "delete_clip"}
    assert any("locked" in x["reason"] for x in r["rejected"]) and any("audio track" in x["reason"] for x in r["rejected"])


def test_validate_commands_unit():
    d = edit_ai.Digest.model_validate(DIGEST)
    keep, rej = edit_ai.validate_commands([
        {"op": "trim_to_duration", "seconds": 90},                          # already shorter
        {"op": "split_at", "at": 30, "track_ids": ["v1"]},
        {"op": "add_markers", "markers": [{"at": 1, "name": "Hook", "color": "#22d3ee"}]},
        {"op": "add_markers", "markers": [{"at": 1, "name": "x", "color": "red"}]},  # not #rrggbb
        {"op": "add_music", "prompt": "lofi beat", "start": 0, "end": 30},
        {"op": "add_captions", "clip_ids": ["c2"], "language": "kn"},
        {"op": "trim_to_duration", "seconds": 30, "extra": 1},              # unknown field
        "not a command",
    ], d)
    assert [k["op"] for k in keep] == ["split_at", "add_markers", "add_music", "add_captions"]
    assert keep[2]["volume_db"] == -18 and keep[2]["paid"] and keep[3]["summary"] == "Captions for 1 clip (paid)"
    assert len(rej) == 4
    flat = edit_ai.from_flat(edit_ai.AssistantOut.model_validate(
        {"commands": [{"op": "add_markers", "markers": [{"at": 2, "name": "A"}]}]}).commands[0].model_dump())
    assert flat == {"op": "add_markers", "markers": [{"at": 2.0, "name": "A"}]}


@pytest.mark.parametrize("text,n", [("", 0), ("Short line.", 1)])
def test_tts_chunks_small(text, n):
    assert len(edit_ai.tts_chunks(text)) == n
