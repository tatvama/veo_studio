"""Timeline layers (video & audio over the shots) and clip trims."""
from __future__ import annotations

import io

from fastapi.testclient import TestClient

from app.pipeline import ffmpeg as ff
from app.pipeline import layers as layerlib
from conftest import H, ok
from test_audit_fixes import _shot
from test_fx import TMP, _clip


def _png() -> bytes:
    p = TMP / "logo.png"
    if not p.exists():
        ff.run(["-f", "lavfi", "-i", "color=c=orange:s=64x64", "-frames:v", "1", p])
    return p.read_bytes()


def _wav() -> bytes:
    p = TMP / "vo.wav"
    if not p.exists():
        ff.run(["-f", "lavfi", "-i", "sine=frequency=330:duration=1.5", p])
    return p.read_bytes()


def test_layers_api_and_conflicts(client: TestClient):
    pid, eid, sid = _shot(client)
    vid = ok(client.post(f"/api/episodes/{eid}/media", headers=H, files={"file": ("broll.mp4", io.BytesIO(_clip("a", "red").read_bytes()), "video/mp4")}))
    img = ok(client.post(f"/api/episodes/{eid}/media", headers=H, files={"file": ("logo.png", io.BytesIO(_png()), "image/png")}))
    snd = ok(client.post(f"/api/episodes/{eid}/media", headers=H, files={"file": ("vo.wav", io.BytesIO(_wav()), "audio/wav")}))
    assert vid["kind"] == "video" and 1.9 < vid["duration"] < 2.1 and img["kind"] == "image" and snd["kind"] == "audio"
    assert client.post(f"/api/episodes/{eid}/media", headers=H, files={"file": ("x.exe", io.BytesIO(b"MZ"), "application/octet-stream")}).status_code == 400
    L = ok(client.get(f"/api/episodes/{eid}/layers"))
    assert L["rev"] == 0 and len(L["media"]) == 3
    body = {"rev": 0, "video": [{"name": "PiP", "clips": [
        {"src": vid["src"], "start": 1, "in": 0.5, "dur": 99, "x": 0.8, "y": 0.2, "scale": 0.3},
        {"src": img["src"], "start": 0, "dur": 2, "opacity": 0.8},
        {"src": "projects/999/secret.mp4", "start": 0, "dur": 1}]}],  # not this project's: dropped
        "audio": [{"name": "VO", "gain_db": -3, "clips": [{"src": snd["src"], "start": 0.5, "dur": 1.2, "fade_in": 0.2}]}]}
    saved = ok(client.put(f"/api/episodes/{eid}/layers", headers=H, json=body))
    clips = saved["video"][0]["clips"]
    assert saved["rev"] == 1 and len(clips) == 2 and clips[1]["dur"] == 1.5  # clamped to what's left after "in"
    assert saved["audio"][0]["clips"][0]["url"].startswith("/media/")
    r = client.put(f"/api/episodes/{eid}/layers", headers=H, json=body)  # the other editor, still on rev 0
    assert r.status_code == 409
    r = client.post(f"/api/episodes/{eid}/media/remove", headers=H, json={"src": snd["src"]})
    assert r.status_code == 400  # in use
    # trims keep at least half a second
    assert client.patch(f"/api/shots/{sid}", headers=H, json={"trim_in": 5, "trim_out": 5}).status_code == 400
    ok(client.patch(f"/api/shots/{sid}", headers=H, json={"trim_in": 0.5}))


def test_layers_render(tmp_path):
    body = ff.normalize_clip(_clip("a", "red"), tmp_path / "body.mp4", 320, 240, seconds=2)
    still = tmp_path / "logo.png"
    still.write_bytes(_png())
    vo = tmp_path / "vo.wav"
    vo.write_bytes(_wav())
    L = {"video": [{"clips": [{"src": "v", "kind": "video", "start": 0.5, "in": 0.2, "dur": 1.0, "x": 0.75, "y": 0.25, "scale": 0.3,
                               "opacity": 0.9, "fade_in": 0.2, "fade_out": 0.2, "gain_db": -6}]},
               {"clips": [{"src": "i", "kind": "image", "start": 0, "in": 0, "dur": 2, "x": 0.1, "y": 0.9, "scale": 0.15, "opacity": 1,
                           "muted": True}]}],
         "audio": [{"gain_db": -2, "clips": [{"src": "s", "kind": "audio", "start": 0.3, "in": 0, "dur": 1.2, "fade_in": 0.1, "fade_out": 0.3}]}]}
    paths = {"v": _clip("b", "blue"), "i": still, "s": vo}
    pics, sounds = layerlib.resolve(L, lambda rel: paths.get(rel))
    assert len(pics) == 2 and len(sounds) == 2  # the video layer's own sound + the voice-over
    out = layerlib.overlay(body, pics, 320, 240, tmp_path / "layered.mp4")
    assert 1.9 < ff.duration(out) < 2.2 and not ff.has_audio(out)
    mixed = layerlib.mix(ff.extract_audio(body, tmp_path / "base.wav"), sounds, 2.0, tmp_path / "mix.wav")
    assert 1.9 < ff.duration(mixed) < 2.1
