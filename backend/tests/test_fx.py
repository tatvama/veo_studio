"""Transitions & effects: validation, the FFmpeg chains really render, the API (apply-to-all, LUTs, exact preview)."""
from __future__ import annotations

import io
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.pipeline import ffmpeg as ff
from app.pipeline import fx as fxlib
from app.pipeline.captions import write_ass
from conftest import H, ok
from test_audit_fixes import _shot

TMP = Path(tempfile.mkdtemp(prefix="veo_fx_"))
IDENTITY_CUBE = "TITLE \"identity\"\nLUT_3D_SIZE 2\n" + "".join(
    f"{r} {g} {b}\n" for b in (0.0, 1.0) for g in (0.0, 1.0) for r in (0.0, 1.0))


def _clip(name: str, color: str, seconds: float = 2.0) -> Path:
    out = TMP / f"{name}.mp4"
    if not out.exists():
        ff.run(["-f", "lavfi", "-i", f"testsrc2=size=320x240:rate=24:duration={seconds}", "-f", "lavfi", "-i",
                f"sine=frequency=440:duration={seconds}", "-vf", f"drawbox=c={color}@0.4:t=fill", "-shortest",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out])
    return out


def test_clean_validates_and_clamps():
    fx = fxlib.clean({"transition": {"type": "slideleft", "duration": 9}, "look": "noir", "speed": 10,
                      "adjust": {"contrast": 5, "grain": -1, "bogus": 1}, "move": {"kind": "zoom_in", "amount": 2},
                      "flip_h": 1, "fade_in": 0.5, "evil": "rm -rf"})
    assert fx == {"transition": {"type": "slideleft", "duration": 2.5}, "look": "noir", "speed": 4.0,
                  "adjust": {"contrast": 1.0}, "move": {"kind": "zoom_in", "amount": 0.5}, "flip_h": True, "fade_in": 0.5}
    assert fxlib.clean({"transition": {"type": "explode"}, "look": "lut:nope"}, lut_ids=set()) == {}
    assert len(fxlib.TRANSITIONS) >= 55


def test_every_transition_renders():
    a, b = _clip("a", "red"), _clip("b", "blue")
    na, nb = TMP / "na.mp4", TMP / "nb.mp4"
    ff.normalize_clip(a, na, 160, 120, seconds=2)
    ff.normalize_clip(b, nb, 160, 120, seconds=2)
    for name in fxlib.TRANSITIONS:  # all of them, so a name FFmpeg doesn't know can't reach an export
        out = TMP / f"x_{name}.mp4"
        ff.xfade_concat([na, nb], [2, 2], [None, (name, 0.5)], out)
        assert 3.3 < ff.duration(out) < 3.7, name


def test_full_effect_chain_renders():
    a = _clip("a", "red")
    lut = TMP / "id.cube"
    lut.write_text(IDENTITY_CUBE)
    fx = fxlib.clean({"look": "lut:x", "adjust": {k: 0.5 for k in fxlib.ADJUST_KEYS}, "speed": 2, "reverse": True,
                      "flip_h": True, "flip_v": True, "move": {"kind": "pan_left", "amount": 0.2}, "fade_in": 0.3,
                      "fade_out": 0.3, "stabilize": True}, lut_ids={"x"})
    out = TMP / "chain.mp4"
    ff.normalize_clip(a, out, 160, 120, fx=fx, luts={"x": str(lut)})
    assert 0.9 < ff.duration(out) < 1.2  # 2 s at 2× speed
    for look in fxlib.LOOKS:
        o = TMP / f"look_{look}.mp4"
        ff.normalize_clip(a, o, 160, 120, seconds=0.5, fx={"look": look})
        assert ff.duration(o) > 0.4, look
    still = TMP / "still.png"
    ff.extract_frame(a, still, 0.5)
    o = TMP / "still_fx.mp4"
    ff.still_to_video(still, o, 1.0, 160, 120, fx={"move": {"kind": "zoom_out", "amount": 0.2}, "look": "warm", "fade_out": 0.3})
    assert 0.9 < ff.duration(o) < 1.1


def test_title_animations(tmp_path):
    ovs = [{"text": "Hello", "start": 0, "end": 1, "kind": "title", "anim": a} for a in
           ("fade", "pop", "slide_up", "slide_in", "zoom", "blur_in", "typewriter", "none")]
    ass = write_ass([], tmp_path / "t.ass", 160, 120, "Arial", overlays=ovs).read_text()
    # 6 animated + "none" + the typewriter's last step show the whole word; earlier steps show "H", "He", …
    assert "\\move(" in ass and "\\blur14" in ass and ass.count("Hello") == 8 and "}Hel\n" in ass
    out = tmp_path / "titled.mp4"
    ff.replace_audio_mix(ff.normalize_clip(_clip("a", "red"), tmp_path / "n.mp4", 160, 120, seconds=1),
                         ff.extract_audio(_clip("a", "red"), tmp_path / "a.wav"), out, subtitles_ass=tmp_path / "t.ass")
    assert ff.duration(out) > 0.9


def test_fx_api(client: TestClient):
    pid, eid, sid = _shot(client)
    cat = ok(client.get("/api/fx/catalog"))
    assert cat["transitions"] and cat["looks"]
    s = ok(client.put(f"/api/shots/{sid}/fx", headers=H, json={"fx": {"look": "cinematic", "speed": 1.5, "x": 1}}))
    assert s["fx"] == {"look": "cinematic", "speed": 1.5}
    ok(client.post(f"/api/shots/{sid}/undo", headers=H))
    assert ok(client.get(f"/api/shots/{sid}"))["fx"] in ({}, None)
    # a LUT: only real .cube files
    r = client.post(f"/api/projects/{pid}/luts", headers=H, files={"file": ("bad.cube", io.BytesIO(b"<html>"), "text/plain")})
    assert r.status_code == 400
    lut = ok(client.post(f"/api/projects/{pid}/luts", headers=H, data={"name": "Identity"},
                         files={"file": ("id.cube", io.BytesIO(IDENTITY_CUBE.encode()), "text/plain")}))
    assert ok(client.get(f"/api/projects/{pid}/luts"))[0]["name"] == "Identity"
    ok(client.put(f"/api/shots/{sid}/fx", headers=H, json={"fx": {"look": f"lut:{lut['id']}"}}))
    # copy the look to every shot; the exact preview renders with the export's filters
    res = ok(client.post(f"/api/episodes/{eid}/fx/apply", headers=H,
                         json={"fx": {"look": "noir", "transition": {"type": "fade", "duration": 0.5}}, "keys": ["look", "transition"]}))
    assert res["updated"] >= 1
    pv = ok(client.post(f"/api/shots/{sid}/fx/preview", headers=H, json={"fx": {"look": "warm", "move": {"kind": "zoom_in"}}}))
    assert pv["url"].endswith(".mp4") and client.get(pv["url"]).status_code == 200
    ok(client.delete(f"/api/projects/{pid}/luts/{lut['id']}", headers=H))
