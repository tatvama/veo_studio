"""Transitions and effects: one registry for the browser preview, the exact preview and the final export.

A shot's `fx` (JSON) describes how it looks in the cut:
    transition  {type, duration, params?, easing?}   how it comes in from the previous shot (FFmpeg xfade id, or
                "gl:<name>" for a gl-transition the GPU engine draws; none = cut)
    look        preset id, or "lut:<id>" for a .cube LUT the team uploaded; lut_strength 0..1 (default 1)
    adjust      {exposure, contrast, saturation, temperature, tint, vibrance, gamma, hue, sharpen, blur, vignette, grain}
                each -1..1 (sharpen/blur/vignette/grain 0..1)
    speed       0.25..4, reverse, flip_h, flip_v
    move        {kind: zoom_in|zoom_out|pan_left|pan_right|pan_up|pan_down|none, amount 0..0.5}
    fade_in / fade_out   seconds from / to black
    stabilize   smooth shaky footage (two passes, slower export)
    wheels, curves, chroma, mask, glow   GPU only (docs/ENGINE.md §2): the FFmpeg render skips them with a warning

`video_filters()` turns it into an FFmpeg filter chain; the frontend mirrors the same values with CSS for live preview,
and the exact preview renders a few seconds with this very code, so what you see is what you export. The GPU engine
(frontend/src/engine) draws everything, gl-transitions included; on the server a gl-transition renders as a fade.
"""
from __future__ import annotations

import json
import math
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

# ── transitions (FFmpeg 7.1 xfade) ───────────────────────────────────────────
TRANSITION_GROUPS: list[tuple[str, list[tuple[str, str]]]] = [
    ("Dissolves", [("fade", "Crossfade"), ("dissolve", "Dissolve"), ("fadeblack", "Dip to black"), ("fadewhite", "Dip to white"),
                   ("fadegrays", "Fade through grey"), ("fadefast", "Fast fade"), ("fadeslow", "Slow fade"), ("hblur", "Blur fade"),
                   ("distance", "Distance"), ("pixelize", "Pixelize")]),
    ("Wipes", [("wipeleft", "Wipe left"), ("wiperight", "Wipe right"), ("wipeup", "Wipe up"), ("wipedown", "Wipe down"),
               ("wipetl", "Wipe ↖"), ("wipetr", "Wipe ↗"), ("wipebl", "Wipe ↙"), ("wipebr", "Wipe ↘"),
               ("smoothleft", "Soft wipe left"), ("smoothright", "Soft wipe right"), ("smoothup", "Soft wipe up"),
               ("smoothdown", "Soft wipe down")]),
    ("Slides & pushes", [("slideleft", "Slide left"), ("slideright", "Slide right"), ("slideup", "Slide up"), ("slidedown", "Slide down"),
                         ("coverleft", "Cover left"), ("coverright", "Cover right"), ("coverup", "Cover up"), ("coverdown", "Cover down"),
                         ("revealleft", "Reveal left"), ("revealright", "Reveal right"), ("revealup", "Reveal up"),
                         ("revealdown", "Reveal down")]),
    ("Shapes", [("circleopen", "Iris open"), ("circleclose", "Iris close"), ("circlecrop", "Circle crop"), ("rectcrop", "Box crop"),
                ("radial", "Clock wipe"), ("vertopen", "Barn doors open (vertical)"), ("vertclose", "Barn doors close (vertical)"),
                ("horzopen", "Barn doors open"), ("horzclose", "Barn doors close"), ("diagtl", "Diagonal ↖"), ("diagtr", "Diagonal ↗"),
                ("diagbl", "Diagonal ↙"), ("diagbr", "Diagonal ↘")]),
    ("Slices & wind", [("hlslice", "Slices left"), ("hrslice", "Slices right"), ("vuslice", "Slices up"), ("vdslice", "Slices down"),
                       ("hlwind", "Wind left"), ("hrwind", "Wind right"), ("vuwind", "Wind up"), ("vdwind", "Wind down")]),
    ("Zoom & squeeze", [("zoomin", "Zoom in"), ("squeezeh", "Squeeze horizontal"), ("squeezev", "Squeeze vertical")]),
]
TRANSITIONS = {k: label for _, items in TRANSITION_GROUPS for k, label in items}

# ── gl-transitions (GPU engine only; gl_transitions.json is made by scripts/dev/gen_gl_transitions.py) ──────────
GL = "gl:"
EASINGS = ("linear", "ease_in", "ease_out", "ease_in_out")
VEC_LEN = {"vec2": 2, "vec3": 3, "vec4": 4, "ivec2": 2}
PARAM_LIMIT = 1e4  # a uniform without an @range is clamped to ±this
GPU_EFFECTS = ("wheels", "curves", "chroma", "mask", "glow")
GPU_EFFECT_NAMES = {"wheels": "colour wheels", "curves": "curves", "chroma": "chroma key", "mask": "mask", "glow": "glow"}
MASK_SHAPES = ("rect", "ellipse")
CURVE_KEYS = ("master", "r", "g", "b")
HEX = re.compile(r"#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})")


@lru_cache
def gl_transitions() -> dict[str, dict[str, Any]]:
    """The gl-transitions (1.74.0, MIT) by name: label, tags, author, license, params, needs_texture."""
    items = json.loads(Path(__file__).with_name("gl_transitions.json").read_text(encoding="utf-8"))
    return {t["name"]: t for t in items}


def gl_spec(kind: Any) -> dict[str, Any] | None:
    """The gl-transition behind "gl:<name>", else None."""
    return gl_transitions().get(kind[len(GL):]) if isinstance(kind, str) and kind.startswith(GL) else None


def is_transition(kind: Any) -> bool:
    return isinstance(kind, str) and (kind in TRANSITIONS or gl_spec(kind) is not None)


# ── looks: FFmpeg filters (exported) ─────────────────────────────────────────
LOOKS: dict[str, dict[str, str]] = {
    "none": {"label": "Natural", "vf": ""},
    "cinematic": {"label": "Cinematic", "vf": "eq=contrast=1.12:saturation=0.92,colorbalance=rs=-0.04:bs=0.06:rh=0.06:bh=-0.05"},
    "teal_orange": {"label": "Teal & orange", "vf": "colorbalance=rs=-0.12:gs=-0.02:bs=0.14:rh=0.12:gh=0.02:bh=-0.12,eq=contrast=1.1:saturation=1.08"},
    "warm": {"label": "Warm", "vf": "colorbalance=rs=0.06:bs=-0.06:rm=0.08:gm=0.02:bm=-0.08,eq=saturation=1.05"},
    "golden_hour": {"label": "Golden hour", "vf": "colorbalance=rm=0.14:gm=0.06:bm=-0.12:rh=0.1:bh=-0.08,eq=contrast=1.05:saturation=1.12:gamma=1.04"},
    "cool": {"label": "Cool", "vf": "colorbalance=rs=-0.04:bs=0.08:rm=-0.06:bm=0.08,eq=saturation=0.95"},
    "moonlight": {"label": "Moonlight", "vf": "colorbalance=rs=-0.1:bs=0.15:rm=-0.08:bm=0.12,eq=brightness=-0.05:saturation=0.7:contrast=1.08"},
    "vivid": {"label": "Vivid", "vf": "vibrance=intensity=0.35,eq=saturation=1.2:contrast=1.06"},
    "pastel": {"label": "Pastel", "vf": "eq=saturation=0.75:brightness=0.04:contrast=0.92,curves=preset=lighter"},
    "vintage": {"label": "Vintage", "vf": "curves=preset=vintage,eq=saturation=0.85"},
    "faded_film": {"label": "Faded film", "vf": "curves=all='0/0.08 0.5/0.52 1/0.94',eq=saturation=0.85"},
    "cross_process": {"label": "Cross process", "vf": "curves=preset=cross_process"},
    "bleach_bypass": {"label": "Bleach bypass", "vf": "eq=saturation=0.55:contrast=1.28"},
    "high_contrast": {"label": "Punchy", "vf": "curves=preset=strong_contrast"},
    "matte": {"label": "Matte", "vf": "curves=all='0/0.1 1/0.92',eq=contrast=0.95"},
    "noir": {"label": "Noir", "vf": "hue=s=0,eq=contrast=1.35:brightness=-0.03"},
    "black_white": {"label": "Black & white", "vf": "hue=s=0"},
    "sepia": {"label": "Sepia", "vf": "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131"},
    "negative": {"label": "Negative", "vf": "negate"},
}

MOVES = ("none", "zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down")
ADJUST_KEYS = ("exposure", "contrast", "saturation", "temperature", "tint", "vibrance", "gamma", "hue",
               "sharpen", "blur", "vignette", "grain")
ZERO_TO_ONE = {"sharpen", "blur", "vignette", "grain"}


def _num(v: Any, lo: float, hi: float, default: float = 0.0) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return default if math.isnan(x) else max(lo, min(hi, x))


def _fin(v: Any) -> float | None:
    """A finite number, else None (a bool isn't a number here)."""
    if isinstance(v, bool):
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _param(spec: dict[str, Any], v: Any) -> Any:
    """One gl-transition uniform with the right type and length, clamped to its @range (a colour to 0..1, anything else
    to ±PARAM_LIMIT); None when the value doesn't fit."""
    t = spec["type"]
    if t == "bool":
        return bool(v) if isinstance(v, bool) or (isinstance(v, (int, float)) and math.isfinite(v)) else None
    lo, hi = (0.0, 1.0) if spec.get("color") else (-PARAM_LIMIT, PARAM_LIMIT)
    lo, hi = float(spec.get("min", lo)), float(spec.get("max", hi))

    def one(x: Any) -> float | int | None:
        f = _fin(x)
        if f is None:
            return None
        f = max(lo, min(hi, f))
        return int(round(f)) if t in ("int", "ivec2") else round(f, 6)

    if t in ("float", "int"):
        return one(v)
    if not isinstance(v, (list, tuple)) or len(v) != VEC_LEN.get(t, -1):
        return None
    vals = [one(x) for x in v]
    return None if any(x is None for x in vals) else vals


def _transition(tr: Any) -> dict[str, Any] | None:
    if not isinstance(tr, dict) or not is_transition(tr.get("type")):
        return None
    out: dict[str, Any] = {"type": tr["type"], "duration": round(_num(tr.get("duration"), 0.1, 2.5, 0.5), 2)}
    spec, raw = gl_spec(tr["type"]), tr.get("params")
    if spec and isinstance(raw, dict):
        params = {p["name"]: _param(p, raw[p["name"]]) for p in spec["params"] if p["name"] in raw}
        params = {k: v for k, v in params.items() if v is not None}
        if params:
            out["params"] = params
    if tr.get("easing") in EASINGS[1:]:
        out["easing"] = tr["easing"]
    return out


def _rgb(v: Any) -> list[float]:
    vals = list(v)[:3] if isinstance(v, (list, tuple)) else []
    return [round(_num(x, -1.0, 1.0), 4) for x in vals] + [0.0] * (3 - len(vals))


def _curve(pts: Any) -> list[list[float]] | None:
    """2..16 points [x, y] in 0..1, ascending x (a later point at the same x wins); None for an identity line."""
    if not isinstance(pts, list):
        return None
    by_x: dict[float, float] = {}
    for p in pts[:64]:
        if isinstance(p, dict):
            p = (p.get("x"), p.get("y"))
        if isinstance(p, (list, tuple)) and len(p) == 2 and _fin(p[0]) is not None and _fin(p[1]) is not None:
            by_x[round(min(max(_fin(p[0]), 0.0), 1.0), 4)] = round(min(max(_fin(p[1]), 0.0), 1.0), 4)
    xs = sorted(by_x)
    if len(xs) > 16:  # keep both ends and an even spread between them
        xs = [xs[round(i * (len(xs) - 1) / 15)] for i in range(16)]
    if len(xs) < 2:
        return None
    c = [[x, by_x[x]] for x in xs]
    if xs[0] <= 1e-3 and xs[-1] >= 1 - 1e-3 and all(abs(x - y) <= 1e-3 for x, y in c):
        return None
    return c


def _gpu_effects(fx: dict[str, Any]) -> dict[str, Any]:
    """wheels, curves, chroma, mask and glow, validated (docs/ENGINE.md §2); a no-op setting is left out."""
    out: dict[str, Any] = {}
    wh = fx.get("wheels")
    if isinstance(wh, dict):
        w = {k: _rgb(wh.get(k)) for k in ("lift", "gamma", "gain")}
        if any(abs(x) > 1e-3 for v in w.values() for x in v):
            out["wheels"] = w
    cv = fx.get("curves")
    if isinstance(cv, dict):
        curves = {k: c for k, c in ((k, _curve(cv.get(k))) for k in CURVE_KEYS) if c}
        if curves:
            out["curves"] = curves
    ch = fx.get("chroma")
    if isinstance(ch, dict):
        m = HEX.fullmatch(str(ch.get("color") or "#00FF00").strip())
        if m:
            hx = m.group(1) if len(m.group(1)) == 6 else "".join(c * 2 for c in m.group(1))
            out["chroma"] = {"color": f"#{hx.upper()}", "similarity": round(_num(ch.get("similarity"), 0.0, 1.0, 0.4), 3),
                             "smoothness": round(_num(ch.get("smoothness"), 0.0, 1.0, 0.08), 3),
                             "spill": round(_num(ch.get("spill"), 0.0, 1.0, 0.1), 3)}
    mk = fx.get("mask")
    if isinstance(mk, dict) and (mk.get("shape") or "rect") in MASK_SHAPES:
        out["mask"] = {"shape": mk.get("shape") or "rect", **{k: round(_num(mk.get(k), 0.0, 1.0, 0.5), 4) for k in ("x", "y", "w", "h")},
                       "rotation": round(_num(mk.get("rotation"), -180.0, 180.0), 2), "feather": round(_num(mk.get("feather"), 0.0, 1.0), 3),
                       "invert": bool(mk.get("invert"))}
    gw = fx.get("glow")
    if isinstance(gw, dict) and _num(gw.get("amount"), 0.0, 1.0) > 1e-3:
        out["glow"] = {"amount": round(_num(gw.get("amount"), 0.0, 1.0), 3), "threshold": round(_num(gw.get("threshold"), 0.0, 1.0, 0.7), 3),
                       "radius": round(_num(gw.get("radius"), 0.0, 1.0, 0.3), 3)}
    return out


def clean(fx: dict | None, lut_ids: set[str] | None = None) -> dict[str, Any]:
    """Validate a shot's fx: unknown keys dropped, numbers clamped, names checked."""
    fx = dict(fx or {})
    out: dict[str, Any] = {}
    tr = _transition(fx.get("transition"))
    if tr:
        out["transition"] = tr
    look = str(fx.get("look") or "none")
    if look in LOOKS or (look.startswith("lut:") and (lut_ids is None or look[4:] in lut_ids)):
        if look != "none":
            out["look"] = look
    adj = {}
    for k in ADJUST_KEYS:
        v = _num((fx.get("adjust") or {}).get(k), 0.0 if k in ZERO_TO_ONE else -1.0, 1.0)
        if abs(v) > 1e-3:
            adj[k] = round(v, 3)
    if adj:
        out["adjust"] = adj
    speed = _num(fx.get("speed"), 0.25, 4.0, 1.0)
    if abs(speed - 1) > 1e-3:
        out["speed"] = round(speed, 3)
    for k in ("reverse", "flip_h", "flip_v", "stabilize"):
        if fx.get(k):
            out[k] = True
    mv = fx.get("move") or {}
    if isinstance(mv, dict) and mv.get("kind") in MOVES and mv.get("kind") != "none":
        out["move"] = {"kind": mv["kind"], "amount": round(_num(mv.get("amount"), 0.02, 0.5, 0.15), 3)}
    for k in ("fade_in", "fade_out"):
        v = _num(fx.get(k), 0.0, 3.0)
        if v > 0.01:
            out[k] = round(v, 2)
    strength = _num(fx.get("lut_strength"), 0.0, 1.0, 1.0)
    if strength < 0.999:
        out["lut_strength"] = round(strength, 3)
    out.update(_gpu_effects(fx))
    return out


def gpu_only(fx: dict | None, transition: bool = True) -> list[str]:
    """What only the GPU engine draws in this (cleaned) fx: "gl:<name>" for a gl-transition (when `transition`, i.e. a
    shot comes before), then the GPU effects."""
    fx = fx or {}
    tr = fx.get("transition") or {}
    out = [tr["type"]] if transition and isinstance(tr, dict) and gl_spec(tr.get("type")) else []
    return out + [k for k in GPU_EFFECTS if fx.get(k)]


def fallback_warnings(code: str, fx: dict | None, transition: bool = True) -> list[str]:
    """What the FFmpeg render draws differently from the GPU engine, in plain words."""
    used = gpu_only(clean(fx), transition)
    out: list[str] = []
    if used and used[0].startswith(GL):
        out.append(f"{code}: the {gl_spec(used[0])['label']} transition renders as a fade here — render on the GPU in "
                   "Tatvam Desktop for the real one")
    names = [GPU_EFFECT_NAMES[k] for k in used if k in GPU_EFFECT_NAMES]
    if names:
        out.append(f"{code}: {', '.join(names)} need{'s' if len(names) == 1 else ''} the GPU render in Tatvam Desktop")
    return out


def _esc_path(p: str) -> str:
    """A file path inside an FFmpeg filter argument (Windows drive colons and quotes escaped)."""
    return p.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def look_filter(look: str | None, luts: dict[str, str] | None = None) -> str:
    if not look or look == "none":
        return ""
    if look.startswith("lut:"):
        path = (luts or {}).get(look[4:])
        return f"lut3d=file='{_esc_path(path)}':interp=tetrahedral" if path else ""
    return LOOKS.get(look, {}).get("vf", "")


def strength_filter(look: str, strength: float) -> str:
    """A look (or LUT) at part strength: grade a copy of the picture and lay it over the original at that opacity.
    Still one input and one output, so it sits inside a -vf chain or a [0:v]…[vv] filter_complex chain."""
    return f"split[lkorig][lkin];[lkin]{look}[lkout];[lkout][lkorig]blend=all_mode=normal:all_opacity={strength:.3f}"


def adjust_filters(a: dict[str, float]) -> list[str]:
    if not a:
        return []
    f: list[str] = []
    eq = {}
    if a.get("exposure"):
        eq["brightness"] = round(a["exposure"] * 0.25, 4)
    if a.get("contrast"):
        eq["contrast"] = round(1 + a["contrast"] * 0.6, 4)
    if a.get("saturation"):
        eq["saturation"] = round(1 + a["saturation"], 4)
    if a.get("gamma"):
        eq["gamma"] = round(1 + a["gamma"] * 0.5, 4)
    if eq:
        f.append("eq=" + ":".join(f"{k}={v}" for k, v in eq.items()))
    if a.get("temperature") or a.get("tint"):
        t, n = a.get("temperature", 0.0), a.get("tint", 0.0)
        f.append(f"colorbalance=rm={round(0.15 * t, 4)}:gm={round(-0.15 * n, 4)}:bm={round(-0.15 * t, 4)}")
    if a.get("vibrance"):
        f.append(f"vibrance=intensity={round(a['vibrance'] * 0.6, 4)}")
    if a.get("hue"):
        f.append(f"hue=h={round(a['hue'] * 180, 2)}")
    if a.get("sharpen"):
        f.append(f"unsharp=5:5:{round(a['sharpen'] * 1.5, 3)}")
    if a.get("blur"):
        f.append(f"gblur=sigma={round(a['blur'] * 8, 3)}")
    if a.get("vignette"):
        f.append(f"vignette=angle={round(0.25 + a['vignette'] * 0.9, 4)}")
    if a.get("grain"):
        f.append(f"noise=alls={int(a['grain'] * 40)}:allf=t+u")
    return f


def move_filter(mv: dict | None, w: int, h: int, seconds: float, fps: int) -> str:
    """Ken Burns camera move on the already-framed picture (scaled up first so the motion stays smooth)."""
    if not mv or mv.get("kind", "none") == "none":
        return ""
    a = float(mv.get("amount", 0.15))
    n = max(int(seconds * fps), 1)
    p = f"min(on/{n},1)"
    k = mv["kind"]
    if k == "zoom_in":
        z, x, y = f"1+{a}*{p}", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
    elif k == "zoom_out":
        z, x, y = f"1+{a}-{a}*{p}", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
    else:
        z = f"{1 + a}"
        x = {"pan_left": f"(iw-iw/zoom)*(1-{p})", "pan_right": f"(iw-iw/zoom)*{p}"}.get(k, "iw/2-(iw/zoom/2)")
        y = {"pan_up": f"(ih-ih/zoom)*(1-{p})", "pan_down": f"(ih-ih/zoom)*{p}"}.get(k, "ih/2-(ih/zoom/2)")
    return f"scale={w * 2}:{h * 2},zoompan=z='{z}':x='{x}':y='{y}':d=1:s={w}x{h}:fps={fps}"


def video_filters(fx: dict | None, w: int, h: int, seconds: float, fps: int = 24, luts: dict[str, str] | None = None) -> str:
    """Everything after the clip is framed to w×h: move, flip, look, adjustments, fades. ("" = nothing to do)"""
    fx = fx or {}
    f: list[str] = []
    m = move_filter(fx.get("move"), w, h, seconds, fps)
    if m:
        f.append(m)
    if fx.get("flip_h"):
        f.append("hflip")
    if fx.get("flip_v"):
        f.append("vflip")
    lk = look_filter(fx.get("look"), luts)
    strength = _num(fx.get("lut_strength"), 0.0, 1.0, 1.0)
    if lk and strength > 1e-3:
        f.append(lk if strength >= 0.999 else strength_filter(lk, strength))
    f += adjust_filters(fx.get("adjust") or {})
    if fx.get("fade_in"):
        f.append(f"fade=t=in:st=0:d={fx['fade_in']}")
    if fx.get("fade_out"):
        f.append(f"fade=t=out:st={max(seconds - fx['fade_out'], 0):.3f}:d={fx['fade_out']}")
    if f:
        f.append("format=yuv420p")
    return ",".join(f)


def audio_filters(fx: dict | None, seconds: float) -> str:
    fx = fx or {}
    f: list[str] = []
    if fx.get("fade_in"):
        f.append(f"afade=t=in:st=0:d={fx['fade_in']}")
    if fx.get("fade_out"):
        f.append(f"afade=t=out:st={max(seconds - fx['fade_out'], 0):.3f}:d={fx['fade_out']}")
    return ",".join(f)


def atempo_chain(speed: float) -> str:
    """atempo takes 0.5–2 per stage: chain stages for 0.25–4×."""
    parts, s = [], speed
    while s > 2.0:
        parts.append("atempo=2.0")
        s /= 2.0
    while s < 0.5:
        parts.append("atempo=0.5")
        s /= 0.5
    parts.append(f"atempo={s:.4f}")
    return ",".join(parts)


def transition_of(fx: dict | None) -> tuple[str, float] | None:
    """The transition as FFmpeg xfade draws it: (xfade id, seconds). A gl-transition is a fade there."""
    tr = (fx or {}).get("transition")
    if not isinstance(tr, dict) or not is_transition(tr.get("type")):
        return None
    return ("fade" if tr["type"].startswith(GL) else tr["type"]), _num(tr.get("duration"), 0.1, 2.5, 0.5)


def gpu_transition(fx: dict | None, duration: float) -> dict[str, Any] | None:
    """The transition as the GPU engine draws it (xfade ids too): {type, duration, params, easing}."""
    tr = (fx or {}).get("transition")
    if not isinstance(tr, dict) or not is_transition(tr.get("type")):
        return None
    return {"type": tr["type"], "duration": round(duration, 3), "params": dict(tr.get("params") or {}),
            "easing": tr.get("easing") if tr.get("easing") in EASINGS else "linear"}


def catalog() -> dict[str, Any]:
    """For the UI: groups of transitions, the looks, the moves; the gl-transitions and effects only the GPU draws."""
    gpu = [{"id": f"{GL}{t['name']}", **{k: t[k] for k in ("label", "tags", "author", "license", "params", "needs_texture")},
            **({"description": t["description"]} if t.get("description") else {})} for t in gl_transitions().values()]
    return {"transitions": [{"group": g, "items": [{"id": k, "label": v} for k, v in items]} for g, items in TRANSITION_GROUPS],
            "looks": [{"id": k, "label": v["label"]} for k, v in LOOKS.items()],
            "moves": list(MOVES), "adjust": list(ADJUST_KEYS), "gpu_transitions": gpu, "gpu_effects": list(GPU_EFFECTS)}
