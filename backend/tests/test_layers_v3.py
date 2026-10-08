"""Timeline v3: keyframe animation on layer clips (validation, sampling, the FFmpeg graph, a real render) and holds."""
from __future__ import annotations

import io
import re
import subprocess
from pathlib import Path

from fastapi.testclient import TestClient

from app.pipeline import ffmpeg as ff
from app.pipeline import layers as layerlib
from conftest import H, ok
from test_audit_fixes import _shot
from test_fx import _clip
from test_layers import _png, _wav

MEDIA = [{"src": "projects/7/layers/a.mp4", "kind": "video", "name": "a.mp4", "duration": 4.0},
         {"src": "projects/7/layers/l.png", "kind": "image", "name": "l.png", "duration": 0.0}]


def test_clean_keyframes_sorted_clamped_capped():
    raw = [{"t": 2, "x": 0.9, "y": 5, "scale": 0.001, "opacity": 2},     # out-of-range values clamp
           {"t": 0.5, "rotation": 720},                                    # rotation clamps to ±360
           {"t": -1, "x": 0.1},                                            # t clamps to 0
           {"t": 99, "x": 0.4},                                            # t clamps to the clip length
           {"t": 1, "name": "nothing animated"},                           # dropped: animates nothing
           {"t": 0.5, "x": 0.2}, "junk", None,                             # the later one at 0.5 wins; junk ignored
           *[{"t": 0.01 * i + 1.1, "x": 0.5} for i in range(40)]]           # capped at MAX_KEYFRAMES
    kfs = layerlib.clean_keyframes(raw, 3.0)
    assert len(kfs) == layerlib.MAX_KEYFRAMES
    assert [k["t"] for k in kfs] == sorted(k["t"] for k in kfs) and kfs[0]["t"] == 0 and kfs[0]["x"] == 0.1
    at_half = next(k for k in kfs if k["t"] == 0.5)
    assert at_half == {"t": 0.5, "x": 0.2}  # same instant → replaced, not merged
    assert layerlib.clean_keyframes("nope", 3.0) == [] and layerlib.clean_keyframes([{"t": "x", "x": 1}], 3.0) == []
    full = layerlib.clean_keyframes([{"t": 2, "x": 0.9, "y": 5, "scale": 0.001, "opacity": 2}, {"t": 99, "x": 0.4}], 3.0)
    assert full[0] == {"t": 2, "x": 0.9, "y": 1.5, "scale": 0.05, "opacity": 1} and full[1]["t"] == 3

    # through clean(): only picture clips carry keyframes / rotation, and the keys stay compact when unused
    L = layerlib.clean({"video": [{"clips": [
        {"src": MEDIA[0]["src"], "start": 0, "dur": 2, "rotation": 400, "keyframes": [{"t": 1.5, "x": 1}, {"t": 0, "x": 0}]},
        {"src": MEDIA[1]["src"], "start": 1, "dur": 1, "rotation": 0, "keyframes": []}]}],
        "audio": [{"clips": [{"src": MEDIA[0]["src"], "start": 0, "dur": 1, "keyframes": [{"t": 0, "x": 1}]}]}],
        "holds": {"12": 1.5, "x": 1, "13": -2, "14": 99, 15: "0.75"}}, 7, MEDIA)
    v0, v1 = L["video"][0]["clips"]
    assert v0["rotation"] == 360 and [k["t"] for k in v0["keyframes"]] == [0, 1.5]
    assert "rotation" not in v1 and "keyframes" not in v1
    assert "keyframes" not in L["audio"][0]["clips"][0]
    assert L["holds"] == {"12": 1.5, "14": layerlib.MAX_HOLD_S, "15": 0.75}


def test_sampling_and_expressions():
    kfs = [{"t": 0, "x": 0.2, "opacity": 1}, {"t": 1, "x": 0.8}, {"t": 2, "x": 0.5, "opacity": 0.5}]
    s = layerlib.sample
    near = lambda a, b: abs(a - b) < 1e-9  # noqa: E731
    assert s(kfs, "x", 0.5, -1) == 0.2 and near(s(kfs, "x", 0.5, 0.5), 0.5) and near(s(kfs, "x", 0.5, 1), 0.8)
    assert near(s(kfs, "x", 0.5, 1.5), 0.65) and s(kfs, "x", 0.5, 9) == 0.5
    assert s(kfs, "opacity", 1, 1) == 0.75  # interpolates between the keyframes that define it (0 and 2 s)
    assert s(kfs, "scale", 0.35, 1) == 0.35 and s(None, "x", 0.5, 1) == 0.5  # no keyframe → the clip's own value
    assert layerlib.animated(kfs, "x") and layerlib.animated(kfs, "opacity") and not layerlib.animated(kfs, "scale")
    assert not layerlib.animated([{"t": 0, "y": 0.3}, {"t": 1, "y": 0.3}], "y")  # same value twice = static

    e = layerlib.kf_expr(kfs, "x", "t", 10.0)
    assert e == "(0.2000+(0.6000)*clip((t-10.000)/1.000,0,1)+(-0.3000)*clip((t-11.000)/1.000,0,1))"
    assert layerlib.kf_expr(kfs, "opacity", "T", 0) == "(1.0000+(-0.5000)*clip((T-0.000)/2.000,0,1))"
    assert layerlib.kf_expr(kfs, "scale") is None and layerlib.kf_expr([{"t": 0, "x": 0.3}], "x") == "0.3000"

    # static clip: the graph the export always used
    chain, x, y = layerlib.pic_chain({"path": "x", "kind": "video", "start": 1, "dur": 2, "x": 0.75, "y": 0.25, "scale": 0.3,
                                      "opacity": 0.9, "fade_in": 0.2}, 320, 240, aspect=0.75)
    assert chain == ["setpts=PTS-STARTPTS+1.000/TB", "scale=96:-2", "format=yuva420p", "colorchannelmixer=aa=0.900",
                     "fade=t=in:st=1.000:d=0.2:alpha=1"]
    assert x == "main_w*0.7500-overlay_w/2" and y == "main_h*0.2500-overlay_h/2"

    # keyframed clip: per-frame expressions for every animated property
    c = {"path": "x", "kind": "video", "start": 1, "in": 0, "dur": 2, "x": 0.5, "y": 0.5, "scale": 0.5, "opacity": 1, "rotation": 15,
         "keyframes": [{"t": 0, "x": 0.2, "scale": 0.4, "opacity": 1, "rotation": 0}, {"t": 2, "x": 0.8, "scale": 0.2, "opacity": 0.3, "rotation": 90}]}
    chain, x, y = layerlib.pic_chain(c, 320, 240, aspect=0.75)
    assert chain[1] == "scale=128:-2"  # scaled once to the largest keyframe (0.4 × 320), then only shrunk
    assert chain[3].startswith("geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='alpha(X,Y)*clip((1.0000+(-0.7000)*clip((T-1.000)/2.000,0,1)),0,1)'")
    assert chain[4].startswith("rotate=a='((0.0000+(90.0000)*clip((t-1.000)/2.000,0,1)))*PI/180':ow=160:oh=160:c=black@0")
    assert chain[5].startswith("scale=w='if(isnan(t),160,2*trunc(160*((0.4000+(-0.2000)*clip((t-1.000)/2.000,0,1))/0.4000)/2))':h=-2:eval=frame")
    assert x.startswith("main_w*(0.2000+(0.6000)*clip((t-1.000)/2.000,0,1))-(160*(") and "overlay_w" not in x
    assert y == "main_h*0.5000-(160*((0.4000+(-0.2000)*clip((t-1.000)/2.000,0,1))/0.4000))/2"
    args, graph, label = layerlib.overlay_graph([c, {"path": "l.png", "kind": "image", "start": 0, "dur": 1}], 320, 240)
    assert args[:3] == ["-ss", "0.000", "-t"] and "-loop" in args and label == "b2" and graph.count("overlay=") == 2


def _yavg(path: Path, at: float, crop: str) -> float:
    """Mean luma of a region of the frame at `at` seconds (0..255)."""
    p = subprocess.run([ff.ffmpeg_exe(), "-hide_banner", "-ss", f"{at:.3f}", "-i", str(path), "-frames:v", "1",
                        "-vf", f"crop={crop},signalstats,metadata=print:file=-", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    m = re.search(r"lavfi\.signalstats\.YAVG=([\d.]+)", p.stdout)
    assert m, p.stderr[-800:]
    return float(m.group(1))


def test_render_keyframes_moves_scales_fades(tmp_path):
    w, h = 320, 240
    body = tmp_path / "body.mp4"
    ff.run(["-f", "lavfi", "-i", f"color=c=black:s={w}x{h}:r=24:d=2", "-pix_fmt", "yuv420p", body])
    box = tmp_path / "box.mp4"  # a bright square
    ff.run(["-f", "lavfi", "-i", "color=c=white:s=120x120:r=24:d=2", "-pix_fmt", "yuv420p", box])
    logo = tmp_path / "logo.png"
    logo.write_bytes(_png())
    L = {"video": [{"clips": [
        {"src": "v", "kind": "video", "start": 0.0, "in": 0, "dur": 2.0, "x": 0.5, "y": 0.5, "scale": 0.3, "opacity": 1, "muted": True,
         "fade_in": 0.1, "gain_db": 0, "rotation": 0,
         "keyframes": [{"t": 0.0, "x": 0.2, "y": 0.5, "scale": 0.3, "opacity": 1, "rotation": 0},
                       {"t": 2.0, "x": 0.8, "y": 0.5, "scale": 0.3, "opacity": 1, "rotation": 45}]},
        {"src": "i", "kind": "image", "start": 0.0, "in": 0, "dur": 2.0, "x": 0.5, "y": 0.12, "scale": 0.2, "opacity": 1, "muted": True,
         "keyframes": [{"t": 0.0, "scale": 0.3, "opacity": 1}, {"t": 2.0, "scale": 0.1, "opacity": 0.0}]}]}], "audio": []}
    pics, sounds = layerlib.resolve(L, lambda rel: {"v": box, "i": logo}.get(rel))
    assert len(pics) == 2 and not sounds
    out = layerlib.overlay(body, pics, w, h, tmp_path / "layered.mp4")
    assert 1.9 < ff.duration(out) < 2.2 and not ff.has_audio(out)
    # the square travels left → right: the left region is bright early and dark late, the right the other way round
    left, right = "50:50:47:95", "50:50:221:95"
    assert _yavg(out, 0.08, left) > 120 and _yavg(out, 1.9, left) < 40
    assert _yavg(out, 0.08, right) < 40 and _yavg(out, 1.9, right) > 120
    # the logo at the top shrinks and fades out: visible early, nearly gone late
    top = "40:20:140:26"
    assert _yavg(out, 0.08, top) > 60 and _yavg(out, 1.9, top) < 32


def test_keyframes_and_holds_api(client: TestClient):
    pid, eid, sid = _shot(client)
    vid = ok(client.post(f"/api/episodes/{eid}/media", headers=H, files={"file": ("broll.mp4", io.BytesIO(_clip("a", "red").read_bytes()), "video/mp4")}))
    img = ok(client.post(f"/api/episodes/{eid}/media", headers=H, files={"file": ("logo.png", io.BytesIO(_png()), "image/png")}))
    snd = ok(client.post(f"/api/episodes/{eid}/media", headers=H, files={"file": ("vo.wav", io.BytesIO(_wav()), "audio/wav")}))
    L = ok(client.get(f"/api/episodes/{eid}/layers"))
    assert L["holds"] == {} and L["rev"] == 0
    body = {"rev": 0, "video": [{"name": "PiP", "clips": [
        {"src": vid["src"], "start": 1, "in": 0.5, "dur": 1.5, "x": 0.8, "y": 0.2, "scale": 0.3, "rotation": -30,
         "keyframes": [{"t": 1.5, "x": 0.2, "opacity": 0.5}, {"t": 0, "x": 0.8}, {"t": 9, "scale": 0.5}]},
        {"src": img["src"], "start": 0, "dur": 2, "keyframes": [{"t": 0, "scale": 0.1}, {"t": 2, "scale": 0.3}]}]}],
        "audio": [{"name": "VO", "clips": [{"src": snd["src"], "start": 0.5, "dur": 1.2, "keyframes": [{"t": 0, "x": 1}]}]}],
        "holds": {str(sid): 1.25, "999999": 0, "bad": 3}}
    saved = ok(client.put(f"/api/episodes/{eid}/layers", headers=H, json=body))
    logo, pip = saved["video"][0]["clips"]  # sorted by start
    assert pip["rotation"] == -30 and pip["dur"] == 1.5
    # sorted by t; 9 s clamps to the clip length (1.5 s) and replaces the keyframe already at that instant
    assert pip["keyframes"] == [{"t": 0, "x": 0.8}, {"t": 1.5, "scale": 0.5}]
    assert logo["keyframes"] == [{"t": 0, "scale": 0.1}, {"t": 2, "scale": 0.3}]
    assert "keyframes" not in saved["audio"][0]["clips"][0]
    assert saved["holds"] == {str(sid): 1.25} and saved["rev"] == 1
    # a save without `holds` keeps them; an explicit {} clears them
    again = ok(client.put(f"/api/episodes/{eid}/layers", headers=H, json={"rev": 1, "video": saved["video"], "audio": saved["audio"]}))
    assert again["holds"] == {str(sid): 1.25} and again["video"][0]["clips"][1]["keyframes"] == pip["keyframes"]
    cleared = ok(client.put(f"/api/episodes/{eid}/layers", headers=H, json={"rev": 2, "video": [], "audio": [], "holds": {}}))
    assert cleared["holds"] == {} and ok(client.get(f"/api/episodes/{eid}/layers"))["holds"] == {}
