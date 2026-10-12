"""GPU render engine, server side (docs/ENGINE.md §2, §5): gl-transitions and the GPU effects in fx.clean, the
catalogue, the FFmpeg fallbacks and their warnings, lut_strength, preset looks as .cube LUTs, and the render plan's
GPU fields."""
from __future__ import annotations

import io
import subprocess

import numpy as np
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import Episode, Shot
from app.pipeline import assembler, look_lut
from app.pipeline import ffmpeg as ff
from app.pipeline import fx as fxlib
from app.storage import get_storage
from conftest import H, ok
from test_desktop import _cut, _lut
from test_fx import IDENTITY_CUBE, TMP, _clip
from test_layers import _png

GRID = np.linspace(0.0, 1.0, 33)
_B, _G, _R = np.meshgrid(GRID, GRID, GRID, indexing="ij")
IDENTITY = np.stack([_R, _G, _B], -1)  # [b][g][r] → (r, g, b), the .cube order (red fastest)


def _cube(text: str) -> np.ndarray:
    rows = [ln.split() for ln in text.splitlines() if ln and (ln[0].isdigit() or ln[0] == "-")]
    assert "LUT_3D_SIZE 33" in text and len(rows) == 33 ** 3
    return np.array(rows, dtype=float).reshape(33, 33, 33, 3)


def _mean_rgb(video, at: float = 0.5) -> np.ndarray:
    w, h = ff.video_size(video)
    out = subprocess.run([ff.ffmpeg_exe(), "-v", "error", "-ss", f"{at}", "-i", str(video), "-frames:v", "1", "-f", "rawvideo",
                          "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(out, np.uint8).reshape(h * w, 3).mean(0)


# ── fx.clean ─────────────────────────────────────────────────────────────────

def test_clean_gl_transitions():
    # the 58 xfade ids as before (no params; linear easing left out), gl:<name> for the gl-transitions, nothing else
    assert fxlib.clean({"transition": {"type": "wipeleft", "duration": 1, "easing": "linear", "params": {"x": 1}}}) == \
        {"transition": {"type": "wipeleft", "duration": 1.0}}
    assert fxlib.clean({"transition": {"type": "gl:cube"}}) == {"transition": {"type": "gl:cube", "duration": 0.5}}
    for bad in ("gl:nope", "gl:", "cube", "GL:cube", ["gl:cube"], None, 3):
        assert fxlib.clean({"transition": {"type": bad}}) == {}, bad
    tr = fxlib.clean({"transition": {"type": "gl:cube", "duration": 9, "easing": "ease_in_out",
                                     "params": {"persp": 5, "unzoom": "0.25", "reflection": True, "floating": float("inf"), "bogus": 1}}})
    assert tr["transition"] == {"type": "gl:cube", "duration": 2.5, "params": {"persp": 1.0, "unzoom": 0.25}, "easing": "ease_in_out"}
    assert "easing" not in fxlib.clean({"transition": {"type": "gl:cube", "easing": "bounce"}})["transition"]

    def params(name: str, raw: dict) -> dict:
        return fxlib.clean({"transition": {"type": f"gl:{name}", "params": raw}})["transition"].get("params", {})

    # ints round and keep to their @range; bools are bools (a bool isn't a number); vectors keep their length;
    # colours stay 0..1; a uniform without a range is clamped to ±1e4
    assert params("Box", {"location": 7.6, "rectIn": "2"}) == {"rectIn": 2, "location": 4}
    assert params("BowTieWithParameter", {"reverse": 1, "adjust": True}) == {"reverse": True}
    assert params("Bounce", {"shadow_colour": [0, 0.5, 2, -1], "shadow_height": 0, "bounces": 50}) == \
        {"shadow_colour": [0.0, 0.5, 1.0, 0.0], "shadow_height": 0.01, "bounces": 10.0}
    assert params("GridFlip", {"size": [3.6, 4], "bgcolor": [1, 1, 1], "pause": 1e9}) == {"size": [4, 4], "pause": 1e4}
    assert params("Directional", {"direction": [1, "x"]}) == {}
    # a gl-transition is a fade for FFmpeg
    assert fxlib.transition_of({"transition": {"type": "gl:cube", "duration": 0.8}}) == ("fade", 0.8)
    assert fxlib.transition_of({"transition": {"type": "radial", "duration": 0.8}}) == ("radial", 0.8)
    assert fxlib.transition_of({"transition": {"type": "gl:nope", "duration": 0.8}}) is None


def test_clean_gpu_effects():
    fx = fxlib.clean({
        "look": "warm", "lut_strength": 0.4567,
        "wheels": {"lift": [0.1, 2, -5], "gain": [0.2], "bogus": [1, 1, 1]},
        "curves": {"master": [[0, 0], [1, 1]], "r": [[1, 0.9], [0, 0.1], [0.5, 0.4], [0.5, 0.6], ["a", 1]], "g": [[0.5, 0.5]],
                   "x": [[0, 1], [1, 0]]},
        "chroma": {"color": "#0f0", "similarity": 3, "spill": -1, "x": 1},
        "mask": {"shape": "ellipse", "x": 2, "w": 0.3, "rotation": 400, "feather": 0.25, "invert": 1},
        "glow": {"amount": 0.5, "radius": 9}, "bloom": {"amount": 1}})
    assert fx == {
        "look": "warm", "lut_strength": 0.457,
        "wheels": {"lift": [0.1, 1.0, -1.0], "gamma": [0.0, 0.0, 0.0], "gain": [0.2, 0.0, 0.0]},
        "curves": {"r": [[0.0, 0.1], [0.5, 0.6], [1.0, 0.9]]},  # the later point at x = 0.5 wins; identity / 1-point left out
        "chroma": {"color": "#00FF00", "similarity": 1.0, "smoothness": 0.08, "spill": 0.0},
        "mask": {"shape": "ellipse", "x": 1.0, "y": 0.5, "w": 0.3, "h": 0.5, "rotation": 180.0, "feather": 0.25, "invert": True},
        "glow": {"amount": 0.5, "threshold": 0.7, "radius": 1.0}}
    assert fxlib.clean(fx) == fx  # cleaning is stable
    # settings that do nothing are left out
    assert fxlib.clean({"lut_strength": 1, "wheels": {"lift": [0, 0, 0.0001]}, "curves": {"master": [[0, 0], [0.5, 0.5], [1, 1]], "b": "x"},
                        "glow": {"amount": 0, "threshold": 1}, "mask": {"shape": "star"}, "chroma": {"color": "green"}}) == {}
    assert fxlib.clean({"lut_strength": 0})["lut_strength"] == 0.0
    long = fxlib.clean({"curves": {"g": [[i / 39, (i / 39) ** 2] for i in range(40)]}})["curves"]["g"]
    assert len(long) == 16 and long[0] == [0.0, 0.0] and long[-1] == [1.0, 1.0]
    assert fxlib.clean({"chroma": {}})["chroma"]["color"] == "#00FF00" and fxlib.clean({"mask": {}})["mask"]["shape"] == "rect"
    # what only the GPU draws, and how the FFmpeg render says so
    assert fxlib.gpu_only(fx) == ["wheels", "curves", "chroma", "mask", "glow"]
    assert fxlib.gpu_only({"transition": {"type": "gl:cube"}}, transition=False) == []
    assert fxlib.fallback_warnings("E01-SH03", {"transition": {"type": "gl:GlitchMemories"}, "glow": {"amount": 1}}) == [
        "E01-SH03: the Glitch memories transition renders as a fade here — render on the GPU in Tatvam Desktop for the real one",
        "E01-SH03: glow needs the GPU render in Tatvam Desktop"]
    assert fxlib.fallback_warnings("E01-SH03", {"wheels": {"gain": [0.1, 0, 0]}, "curves": {"r": [[0, 0.1], [1, 1]]}}) == [
        "E01-SH03: colour wheels, curves need the GPU render in Tatvam Desktop"]
    assert fxlib.fallback_warnings("E01-SH01", {"transition": {"type": "gl:cube"}}, transition=False) == []
    assert fxlib.fallback_warnings("E01-SH02", {"look": "warm", "lut_strength": 0.5, "transition": {"type": "fade"}}) == []


def test_catalog_lists_gpu_transitions_and_effects(client: TestClient):
    cat = ok(client.get("/api/fx/catalog"))
    assert cat["transitions"] and cat["looks"] and cat["moves"] and cat["adjust"]  # unchanged
    assert cat["gpu_effects"] == ["wheels", "curves", "chroma", "mask", "glow"]
    gpu = cat["gpu_transitions"]
    assert len(gpu) == 125 and len({t["id"] for t in gpu}) == 125 and all(t["id"].startswith("gl:") for t in gpu)
    labels = [t["label"] for t in gpu]
    assert labels == sorted(labels, key=str.lower)
    cube = next(t for t in gpu if t["id"] == "gl:cube")
    assert (cube["label"], cube["license"], cube["needs_texture"]) == ("Cube", "MIT", False) and cube["author"] and cube["tags"] is not None
    assert {k: v for k, v in cube["params"][0].items() if k != "description"} == {"name": "persp", "type": "float", "default": 0.7,
                                                                                    "min": 0.0, "max": 1.0}
    assert next(t for t in gpu if t["id"] == "gl:GlitchMemories")["label"] == "Glitch memories"
    assert next(t for t in gpu if t["id"] == "gl:luma")["needs_texture"]
    assert {p["type"] for t in gpu for p in t["params"]} == {"float", "int", "bool", "vec2", "vec3", "vec4", "ivec2"}
    assert sum(1 for t in gpu for p in t["params"] if "min" in p) >= 14  # the @range comments
    assert all(fxlib.clean({"transition": {"type": t["id"]}}) for t in gpu)  # every one of them is a valid fx


# ── FFmpeg fallbacks ─────────────────────────────────────────────────────────

def test_lut_strength_renders():
    red = TMP / "solid_red.mp4"
    if not red.exists():
        ff.run(["-f", "lavfi", "-i", "color=c=red:size=160x120:rate=24:duration=1", "-f", "lavfi", "-i", "sine=duration=1", "-shortest",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", red])
    got = {}
    for s in (1, 0.25, 0):
        fx = fxlib.clean({"look": "negative", "lut_strength": s, "move": {"kind": "zoom_in"}})
        got[s] = _mean_rgb(ff.normalize_clip(red, TMP / f"neg_{s}.mp4", 160, 120, fx=fx))
    assert got[1][0] < 20 and got[1][1] > 235  # red → cyan
    assert abs(got[0.25][0] - 191) < 12 and abs(got[0.25][1] - 64) < 12  # a quarter of the way there
    assert got[0][0] > 235 and got[0][1] < 20  # strength 0: the look is off
    # the same on a still (a -vf chain), and an uploaded LUT at half strength
    still = TMP / "solid_red.png"
    ff.extract_frame(red, still, 0.2)
    half = _mean_rgb(ff.still_to_video(still, TMP / "neg_still.mp4", 1.0, 160, 120, fx={"look": "negative", "lut_strength": 0.5}))
    assert abs(half[0] - 128) < 14 and abs(half[1] - 128) < 14
    lut = TMP / "id_strength.cube"
    lut.write_text(IDENTITY_CUBE)
    fx = fxlib.clean({"look": "lut:x", "lut_strength": 0.5}, lut_ids={"x"})
    assert "blend=all_mode=normal:all_opacity=0.500" in fxlib.video_filters(fx, 160, 120, 1.0, 24, {"x": str(lut)})
    out = ff.normalize_clip(_clip("a", "red"), TMP / "lut_half.mp4", 160, 120, seconds=1, fx=fx, luts={"x": str(lut)})
    assert ff.duration(out) > 0.9


def test_server_render_falls_back_and_warns(client: TestClient):
    c = client
    pid, eid, sids, tids = _cut(c)
    fxs = [{"transition": {"type": "gl:cube"}},  # the first shot: nothing comes before it, so no warning
           {"transition": {"type": "gl:cube", "duration": 0.5, "params": {"persp": 0.2}}, "chroma": {"color": "#00ff00"}},
           {"look": "negative", "lut_strength": 0.5, "wheels": {"lift": [0.1, 0, 0]}, "curves": {"master": [[0, 0.1], [1, 0.9]]}}]
    for sid, fx in zip(sids, fxs):
        ok(c.put(f"/api/shots/{sid}/fx", headers=H, json={"fx": fx}))
    with SessionLocal() as db:
        codes = [db.get(Shot, sid).code for sid in sids]
        out = assembler.render(db, db.get(Episode, eid), "en", "draft", "final", {"music": False}, f"projects/{pid}/exports/gpu_fallback")
    assert 5.2 < out["duration"] < 5.8  # 3 × 2 s, the cube drawn as a 0.5 s fade
    w = out["warnings"]
    assert f"{codes[1]}: the Cube transition renders as a fade here — render on the GPU in Tatvam Desktop for the real one" in w
    assert f"{codes[1]}: chroma key needs the GPU render in Tatvam Desktop" in w
    assert f"{codes[2]}: colour wheels, curves need the GPU render in Tatvam Desktop" in w
    assert not any(x.startswith(f"{codes[0]}:") and "GPU" in x for x in w)
    assert get_storage().exists(out["path"])
    # the exact preview falls back the same way and says so
    pv = ok(c.post(f"/api/shots/{sids[1]}/fx/preview", headers=H, json={}))
    assert pv["url"].endswith(".mp4") and pv["warnings"][0].startswith(f"{codes[1]}: the Cube transition renders as a fade")
    assert ok(c.post(f"/api/shots/{sids[0]}/fx/preview", headers=H, json={}))["warnings"] == []


# ── preset looks as .cube LUTs ───────────────────────────────────────────────

def test_look_cube_endpoint(client: TestClient, monkeypatch):
    c = client
    r = c.get("/api/fx/looks/none.cube")
    assert r.status_code == 200 and r.headers["cache-control"] == "public, max-age=86400" and r.headers["etag"]
    assert r.text.startswith("# tatvam-look none ") and 'TITLE "Natural"' in r.text
    assert np.abs(_cube(r.text) - IDENTITY).max() <= 2 / 255
    bw = _cube(c.get("/api/fx/looks/black_white.cube").text)
    assert np.abs(bw[..., 0] - bw[..., 1]).max() < 1e-4 and np.abs(bw[..., 1] - bw[..., 2]).max() < 1e-4
    assert bw[-1, -1, -1, 0] > 0.97 and bw[0, 0, 0, 0] < 0.02 and bw[0, 0, -1, 0] > bw[-1, 0, 0, 0]  # red is lighter than blue
    text = c.get("/api/fx/looks/negative.cube").text
    neg = _cube(text)
    assert np.abs(neg - (1 - IDENTITY)).mean() < 4 / 255 and neg[0, 0, 0].min() > 0.95 and neg[-1, -1, -1].max() < 0.05
    assert c.get("/api/fx/looks/bogus.cube").status_code == 404 and c.get("/api/fx/looks/lut:abc.cube").status_code == 404
    assert TestClient(app).get("/api/fx/looks/none.cube").status_code == 401  # signed-in people only
    assert get_storage().exists("fx/looks/negative.cube")

    def boom(look: str) -> str:
        raise AssertionError("baked again")

    monkeypatch.setattr(look_lut, "cube_text", boom)  # the second call comes from storage
    assert c.get("/api/fx/looks/negative.cube").text == text
    monkeypatch.undo()
    monkeypatch.setitem(fxlib.LOOKS["black_white"], "vf", "negate")  # a changed preset bakes again
    changed = _cube(c.get("/api/fx/looks/black_white.cube").text)
    assert np.abs(changed - (1 - IDENTITY)).mean() < 4 / 255
    monkeypatch.undo()
    assert np.abs(_cube(c.get("/api/fx/looks/black_white.cube").text) - bw).max() < 1e-6


# ── the desktop render plan ──────────────────────────────────────────────────

def test_render_plan_gpu_fields(client: TestClient):
    c = client
    pid, eid, sids, tids = _cut(c)
    lid = _lut(c, pid)
    ok(c.put(f"/api/shots/{sids[0]}/fx", headers=H, json={"fx": {"transition": {"type": "gl:cube"}, "look": f"lut:{lid}", "lut_strength": 0.5}}))
    ok(c.put(f"/api/shots/{sids[1]}/fx", headers=H, json={"fx": {
        "transition": {"type": "gl:cube", "duration": 2, "params": {"persp": 0.5}, "easing": "ease_out"}, "chroma": {"color": "#00ff00"}}}))
    ok(c.put(f"/api/shots/{sids[2]}/fx", headers=H, json={"fx": {"transition": {"type": "wipeleft", "duration": 0.4}}}))
    vid = ok(c.post(f"/api/episodes/{eid}/media", headers=H, files={"file": ("broll.mp4", io.BytesIO(_clip("a", "red").read_bytes()), "video/mp4")}))
    img = ok(c.post(f"/api/episodes/{eid}/media", headers=H, files={"file": ("logo.png", io.BytesIO(_png()), "image/png")}))
    ok(c.put(f"/api/episodes/{eid}/layers", headers=H, json={"rev": 0, "video": [{"id": "pip", "name": "PiP", "clips": [
        {"id": "b1", "src": vid["src"], "start": 1, "dur": 1.5, "x": 0.8, "y": 0.2, "scale": 0.3, "rotation": -30, "opacity": 0.8,
         "fade_in": 0.2, "gain_db": -6, "keyframes": [{"t": 0, "x": 0.8}, {"t": 1.5, "x": 0.2}]},
        {"id": "l1", "src": img["src"], "start": 0, "dur": 2}]}], "audio": []}))

    plan = ok(c.get(f"/api/episodes/{eid}/render-plan?w=320&h=240"))
    a, b, z = plan["segments"]
    assert plan["gpu_only"] == ["chroma", "gl:cube"]  # the first shot's cube never plays
    assert a["transition"] is None and a["gpu_transition"] is None and a["fx"]["lut_strength"] == 0.5
    assert b["transition"] == ["fade", 1.0]  # the FFmpeg path keeps working; clamped to half a 2 s clip
    assert b["gpu_transition"] == {"type": "gl:cube", "duration": 1.0, "params": {"persp": 0.5}, "easing": "ease_out"}
    assert b["fx"]["chroma"] == {"color": "#00FF00", "similarity": 0.4, "smoothness": 0.08, "spill": 0.1}
    assert z["transition"] == ["wipeleft", 0.4] and z["gpu_transition"] == {"type": "wipeleft", "duration": 0.4, "params": {}, "easing": "linear"}
    # the LUT at half strength still runs as the desktop runs it ([0:v]…[vv]) once the mark is a local path
    st = get_storage()
    mark = f"@@LUT_{lid}@@"
    assert mark in a["vf"] and "split[lkorig]" in a["vf"]
    vf = a["vf"].replace(mark, fxlib._esc_path(str(st.abs(plan["luts"][lid]))))
    out = st.tmp_dir() / "seg.mp4"
    ff.run(["-i", st.abs(a["source"]), "-filter_complex", f"[0:v]{vf}[vv]", "-map", "[vv]", "-t", "0.5", out])
    assert ff.video_size(out) == (320, 240)
    # picture layers carry the raw clip values next to the FFmpeg strings
    logo, pip = plan["layers"]["pics"]
    assert isinstance(pip["x"], str) and pip["chain"] and pip["raw"] == {
        "id": "b1", "track": "pip", "x": 0.8, "y": 0.2, "scale": 0.3, "opacity": 0.8, "rotation": -30, "fade_in": 0.2, "fade_out": 0,
        "gain_db": -6, "keyframes": [{"t": 0, "x": 0.8}, {"t": 1.5, "x": 0.2}]}
    assert logo["raw"]["rotation"] == 0 and logo["raw"]["keyframes"] == [] and logo["raw"]["scale"] == 0.35
    # effects off: a plain cut
    plain = ok(c.get(f"/api/episodes/{eid}/render-plan?w=320&h=240&effects=0"))
    assert plain["gpu_only"] == [] and all(s["fx"] == {} and s["gpu_transition"] is None for s in plain["segments"])
