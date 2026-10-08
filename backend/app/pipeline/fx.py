"""Transitions and effects: one registry for the browser preview, the exact preview and the final export.

A shot's `fx` (JSON) describes how it looks in the cut:
    transition  {type, duration}   how it comes in from the previous shot (FFmpeg xfade; none = cut)
    look        preset id, or "lut:<id>" for a .cube LUT the team uploaded
    adjust      {exposure, contrast, saturation, temperature, tint, vibrance, gamma, hue, sharpen, blur, vignette, grain}
                each -1..1 (sharpen/blur/vignette/grain 0..1)
    speed       0.25..4, reverse, flip_h, flip_v
    move        {kind: zoom_in|zoom_out|pan_left|pan_right|pan_up|pan_down|none, amount 0..0.5}
    fade_in / fade_out   seconds from / to black
    stabilize   smooth shaky footage (two passes, slower export)

`video_filters()` turns it into an FFmpeg filter chain; the frontend mirrors the same values with CSS for live preview,
and the exact preview renders a few seconds with this very code, so what you see is what you export.
"""
from __future__ import annotations

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
    return max(lo, min(hi, x))


def clean(fx: dict | None, lut_ids: set[str] | None = None) -> dict[str, Any]:
    """Validate a shot's fx: unknown keys dropped, numbers clamped, names checked."""
    fx = dict(fx or {})
    out: dict[str, Any] = {}
    tr = fx.get("transition") or None
    if isinstance(tr, dict) and tr.get("type") in TRANSITIONS:
        out["transition"] = {"type": tr["type"], "duration": round(_num(tr.get("duration"), 0.1, 2.5, 0.5), 2)}
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
    if lk:
        f.append(lk)
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
    tr = (fx or {}).get("transition")
    return (tr["type"], float(tr["duration"])) if tr and tr.get("type") in TRANSITIONS else None


def catalog() -> dict[str, Any]:
    """For the UI: groups of transitions, the looks, the moves."""
    return {"transitions": [{"group": g, "items": [{"id": k, "label": v} for k, v in items]} for g, items in TRANSITION_GROUPS],
            "looks": [{"id": k, "label": v["label"]} for k, v in LOOKS.items()],
            "moves": list(MOVES), "adjust": list(ADJUST_KEYS)}
