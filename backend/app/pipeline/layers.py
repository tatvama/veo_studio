"""Extra timeline layers above the main shot track: video layers (picture-in-picture, B-roll, logos, images) and audio
layers (voice-overs, extra music, sound effects).

Stored per episode in `Episode.layers`:
    rev     version, so two editors can't overwrite each other (a save names the rev it started from)
    video   [{id, name, hidden, muted, clips: [{id, src, kind: video|image, name, start, in, dur,
                                               x, y, scale, opacity, rotation, fade_in, fade_out, gain_db, muted,
                                               keyframes: [{t, x?, y?, scale?, opacity?, rotation?}]}]}]
    audio   [{id, name, muted, gain_db, clips: [{id, src, name, start, in, dur, gain_db, fade_in, fade_out}]}]
    media   uploaded files the layers can use [{src, kind, name, duration, thumb}]
    holds   {shot_id: seconds} — a freeze the timeline shows after a shot ("hold" trim mode). Preview only for now:
            the export closes the gap (see assembler.render), so the timeline marks it as such.
Times are on the finished cut's timeline (seconds, after transitions overlap shots). Video layers stack in order:
the first sits just above the main track, the last on top.

Keyframes animate a picture clip (`t` = seconds from the clip's start, linear between keyframes, held before the
first and after the last). The renderer animates:
    x, y        the overlay filter's x/y expressions (per frame, `t` is the cut's time)
    scale       `scale=…:eval=frame` with a `t` expression (per frame; the clip is first scaled once to its largest
                keyframe size, then only shrunk, so it never upsamples)
    opacity     a `geq` alpha expression (per frame; used only when the opacity actually changes between keyframes —
                a constant opacity keeps the cheaper colorchannelmixer)
    rotation    `rotate=a=…` with a `t` expression (per frame, transparent corners), square canvas of the diagonal
fade_in / fade_out multiply on top of all that, as before.
"""
from __future__ import annotations

import math
import uuid
from pathlib import Path
from typing import Any

from . import ffmpeg as ff

MAX_TRACKS = 8
MAX_CLIPS = 200
MAX_KEYFRAMES = 20
MAX_HOLDS = 500
MAX_HOLD_S = 10.0
# animatable properties and their range
KF_RANGE: dict[str, tuple[float, float]] = {"x": (-0.5, 1.5), "y": (-0.5, 1.5), "scale": (0.05, 2.0), "opacity": (0.0, 1.0),
                                            "rotation": (-360.0, 360.0)}
KF_DEFAULT = {"x": 0.5, "y": 0.5, "scale": 0.35, "opacity": 1.0, "rotation": 0.0}


def _num(v: Any, lo: float, hi: float, default: float) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    if math.isnan(x) or math.isinf(x):
        return default
    return max(lo, min(hi, x))


def _id(v: Any) -> str:
    s = str(v or "")
    return s[:24] if s and all(c.isalnum() or c in "-_" for c in s) else uuid.uuid4().hex[:10]


def clean_keyframes(raw: Any, dur: float) -> list[dict[str, float]]:
    """Sorted by t, clamped to the clip (0..dur) and the property ranges, one per instant, at most MAX_KEYFRAMES.
    A keyframe that animates nothing is dropped."""
    if not isinstance(raw, list):
        return []
    out: dict[float, dict[str, float]] = {}
    for k in raw[: MAX_KEYFRAMES * 4]:
        if not isinstance(k, dict):
            continue
        t = _num(k.get("t"), 0.0, max(dur, 0.0), float("nan"))
        if math.isnan(t):
            continue
        kf: dict[str, float] = {"t": round(t, 3)}
        for key, (lo, hi) in KF_RANGE.items():
            if k.get(key) is None:
                continue
            v = _num(k.get(key), lo, hi, float("nan"))
            if not math.isnan(v):
                kf[key] = round(v, 4)
        if len(kf) > 1:
            out[kf["t"]] = kf  # a later keyframe at the same instant replaces the earlier one
    return [out[t] for t in sorted(out)][:MAX_KEYFRAMES]


def clean_holds(raw: Any) -> dict[str, float]:
    """{shot_id: seconds} with only positive, sane values."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, float] = {}
    for k, v in list(raw.items())[: MAX_HOLDS * 2]:
        try:
            sid = int(k)
        except (TypeError, ValueError):
            continue
        h = round(_num(v, 0.0, MAX_HOLD_S, 0.0), 2)
        if sid > 0 and h > 0:
            out[str(sid)] = h
        if len(out) >= MAX_HOLDS:
            break
    return out


def clean(layers: dict | None, project_id: int, media: list[dict] | None = None) -> dict[str, Any]:
    """Validate an edit: only this project's uploaded files, numbers in range, sane sizes."""
    layers = layers or {}
    allowed = {m["src"]: m for m in (media or [])}
    prefix = f"projects/{project_id}/"

    def clip_ok(c: dict) -> dict | None:
        src = str(c.get("src") or "")
        if not src.startswith(prefix) or ".." in src or src not in allowed:
            return None
        m = allowed[src]
        length = float(m.get("duration") or 0) or 3600.0
        inn = _num(c.get("in"), 0, max(length - 0.1, 0), 0)
        out = {"id": _id(c.get("id")), "src": src, "name": str(c.get("name") or m.get("name") or "")[:80], "kind": m["kind"],
               "start": round(_num(c.get("start"), 0, 36000, 0), 3), "in": round(inn, 3),
               "dur": round(_num(c.get("dur"), 0.1, max(length - inn, 0.1) if m["kind"] != "image" else 3600, 3), 3),
               "fade_in": round(_num(c.get("fade_in"), 0, 10, 0), 2), "fade_out": round(_num(c.get("fade_out"), 0, 10, 0), 2),
               "gain_db": round(_num(c.get("gain_db"), -60, 12, 0), 1)}
        if m["kind"] in ("video", "image"):
            out.update({"x": round(_num(c.get("x"), -0.5, 1.5, 0.5), 4), "y": round(_num(c.get("y"), -0.5, 1.5, 0.5), 4),
                        "scale": round(_num(c.get("scale"), 0.05, 2.0, 0.35), 4), "opacity": round(_num(c.get("opacity"), 0, 1, 1), 3),
                        "muted": bool(c.get("muted", m["kind"] == "image"))})
            rot = round(_num(c.get("rotation"), -360, 360, 0), 2)
            if abs(rot) > 1e-3:
                out["rotation"] = rot
            kfs = clean_keyframes(c.get("keyframes"), out["dur"])
            if kfs:
                out["keyframes"] = kfs
        return out

    def tracks(kind: str) -> list[dict]:
        res = []
        for t in (layers.get(kind) or [])[:MAX_TRACKS]:
            clips = [c for c in (clip_ok(c) for c in (t.get("clips") or [])[:MAX_CLIPS] if isinstance(c, dict)) if c]
            if kind == "video":
                clips = [c for c in clips if c["kind"] in ("video", "image")]
            else:  # a video's sound can sit on an audio layer: it keeps no picture animation there
                clips = [{k: v for k, v in c.items() if k not in ("keyframes", "rotation")} for c in clips if c["kind"] in ("audio", "video")]
            res.append({"id": _id(t.get("id")), "name": str(t.get("name") or "")[:40] or f"{kind.title()} {len(res) + 1}",
                        "muted": bool(t.get("muted")), "hidden": bool(t.get("hidden")),
                        "gain_db": round(_num(t.get("gain_db"), -60, 12, 0), 1), "clips": sorted(clips, key=lambda c: c["start"])})
        return res

    return {"video": tracks("video"), "audio": tracks("audio"), "holds": clean_holds(layers.get("holds"))}


# ── keyframes: sampling (what the preview shows) and FFmpeg expressions (what the export renders) ─────────────────

def _points(kfs: list[dict], key: str) -> list[tuple[float, float]]:
    return [(float(k["t"]), float(k[key])) for k in kfs if key in k]


def sample(kfs: list[dict] | None, key: str, base: float, t: float) -> float:
    """The value of `key` at `t` seconds into the clip: linear between keyframes, held outside them, `base` when the
    property has no keyframe. Mirrors the browser preview exactly."""
    pts = _points(kfs or [], key)
    if not pts:
        return base
    if t <= pts[0][0]:
        return pts[0][1]
    for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
        if t <= t1:
            return v1 if t1 - t0 < 1e-9 else v0 + (v1 - v0) * (t - t0) / (t1 - t0)
    return pts[-1][1]


def kf_expr(kfs: list[dict] | None, key: str, var: str = "t", offset: float = 0.0) -> str | None:
    """A piecewise-linear FFmpeg expression in `var` (the cut's time; the clip starts at `offset`), or None when the
    property has no keyframe. v0 + Σ (v_i+1 − v_i)·clip((t − t_i)/(t_i+1 − t_i), 0, 1): each segment adds its change
    once the time has passed through it, which is exactly linear interpolation held at both ends."""
    pts = _points(kfs or [], key)
    if not pts:
        return None
    parts = [f"{pts[0][1]:.4f}"]
    for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
        dt = t1 - t0
        if dt < 1e-6 or abs(v1 - v0) < 1e-9:
            continue
        parts.append(f"({v1 - v0:.4f})*clip(({var}-{offset + t0:.3f})/{dt:.3f},0,1)")
    return parts[0] if len(parts) == 1 else "(" + "+".join(parts) + ")"


def animated(kfs: list[dict] | None, key: str) -> bool:
    """True when the property really changes over the keyframes (a single value is treated as static)."""
    vals = {round(v, 4) for _, v in _points(kfs or [], key)}
    return len(vals) > 1


def resolve(layers: dict | None, abspath) -> tuple[list[dict], list[dict]]:
    """(picture items bottom→top, sound items) with absolute file paths, skipping hidden / muted tracks and missing files."""
    pics, sounds = [], []
    for t in (layers or {}).get("video") or []:
        if t.get("hidden"):
            continue
        for c in t.get("clips") or []:
            p = abspath(c["src"])
            if not p:
                continue
            pics.append({**c, "path": p})
            if c["kind"] == "video" and not c.get("muted") and not t.get("muted"):
                sounds.append({**c, "path": p, "gain_db": c.get("gain_db", 0) + t.get("gain_db", 0)})
    for t in (layers or {}).get("audio") or []:
        if t.get("muted"):
            continue
        for c in t.get("clips") or []:
            p = abspath(c["src"])
            if p:
                sounds.append({**c, "path": p, "gain_db": c.get("gain_db", 0) + t.get("gain_db", 0)})
    return pics, sounds


def _aspect(path: Path | str) -> float:
    """height / width of a media file (16:9 when it can't be read)."""
    try:
        sw, sh = ff.video_size(path)
    except Exception:
        sw, sh = 0, 0
    return sh / sw if sw and sh else 9 / 16


def pic_chain(c: dict, w: int, h: int, aspect: float | None = None) -> tuple[list[str], str, str]:
    """The filter chain for one picture layer clip and the overlay's x / y expressions.
    Static clips keep the simple graph the export always used; keyframes add per-frame expressions (see module doc)."""
    kfs = c.get("keyframes") or []
    st, end = float(c["start"]), float(c["start"]) + float(c["dur"])
    base = {k: float(c.get(k, d)) for k, d in KF_DEFAULT.items()}
    anim = {k: animated(kfs, k) for k in KF_DEFAULT}
    # a keyframed property starts from its first keyframe, a static one from the clip's value
    first = {k: (sample(kfs, k, base[k], 0.0) if _points(kfs, k) else base[k]) for k in KF_DEFAULT}
    s_max = max([first["scale"]] + [v for _, v in _points(kfs, "scale")]) if anim["scale"] else first["scale"]
    sw = max(2, int(round(w * s_max / 2)) * 2)
    ratio = aspect if aspect is not None else _aspect(c["path"])
    sh = max(2.0, sw * ratio)
    chain = [f"setpts=PTS-STARTPTS+{st:.3f}/TB", f"scale={sw}:-2", "format=yuva420p"]
    if anim["opacity"]:  # geq uses T for the time
        chain.append(f"geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='alpha(X,Y)*clip({kf_expr(kfs, 'opacity', 'T', st)},0,1)'")
    elif first["opacity"] < 0.999:
        chain.append(f"colorchannelmixer=aa={first['opacity']:.3f}")
    ow: str = str(sw)
    oh: str = f"{sh:.2f}"
    if anim["rotation"] or abs(first["rotation"]) > 1e-3:
        deg = kf_expr(kfs, "rotation", "t", st) if anim["rotation"] else f"{first['rotation']:.3f}"
        side = int(math.ceil(math.hypot(sw, sh) / 2) * 2)  # even; the whole picture stays inside at any angle
        chain.append(f"rotate=a='({deg})*PI/180':ow={side}:oh={side}:c=black@0")
        ow = oh = str(side)
    if anim["scale"]:  # shrink from the largest size per frame; the overlay centring follows the same expression
        factor = f"({kf_expr(kfs, 'scale', 't', st)}/{s_max:.4f})"
        chain.append(f"scale=w='if(isnan(t),{ow},2*trunc({ow}*{factor}/2))':h=-2:eval=frame")
        ow, oh = f"({ow}*{factor})", f"({oh}*{factor})"
        half_w, half_h = f"{ow}/2", f"{oh}/2"
    else:
        half_w, half_h = "overlay_w/2", "overlay_h/2"
    if c.get("fade_in"):
        chain.append(f"fade=t=in:st={st:.3f}:d={c['fade_in']}:alpha=1")
    if c.get("fade_out"):
        chain.append(f"fade=t=out:st={max(end - float(c['fade_out']), st):.3f}:d={c['fade_out']}:alpha=1")
    xe = kf_expr(kfs, "x", "t", st) if anim["x"] else f"{first['x']:.4f}"
    ye = kf_expr(kfs, "y", "t", st) if anim["y"] else f"{first['y']:.4f}"
    return chain, f"main_w*{xe}-{half_w}", f"main_h*{ye}-{half_h}"


def overlay_graph(pics: list[dict], w: int, h: int) -> tuple[list, str, str]:
    """(extra ffmpeg inputs, filter_complex, output label) for compositing the picture layers over input 0."""
    args: list = []
    f: list[str] = []
    base = "0:v"
    for k, c in enumerate(pics, 1):
        if c["kind"] == "image":
            args += ["-loop", "1", "-framerate", "24", "-t", f"{c['dur']:.3f}", "-i", c["path"]]
        else:
            args += ["-ss", f"{c['in']:.3f}", "-t", f"{c['dur']:.3f}", "-i", c["path"]]
        st, end = c["start"], c["start"] + c["dur"]
        chain, x, y = pic_chain(c, w, h)
        f.append(f"[{k}:v]{','.join(chain)}[p{k}]")
        f.append(f"[{base}][p{k}]overlay=x='{x}':y='{y}':enable='between(t,{st:.3f},{end:.3f})':eof_action=pass[b{k}]")
        base = f"b{k}"
    return args, ";".join(f), base


def overlay(body: Path, pics: list[dict], w: int, h: int, out: Path) -> Path:
    """Composite the picture layers over the main track (position = centre as a fraction of the frame, scale = width)."""
    if not pics:
        return body
    args, graph, label = overlay_graph(pics, w, h)
    ff.run(["-i", body, *args, "-filter_complex", graph, "-map", f"[{label}]", "-an", "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "20", "-pix_fmt", "yuv420p", out], timeout=3600)
    return out  # picture only: the final mix supplies the sound


def mix(base_audio: Path, sounds: list[dict], total: float, out: Path) -> Path:
    """Lay the sound layers over a mix (each at its own time, volume and fades)."""
    if not sounds:
        return base_audio
    args: list = ["-i", base_audio]
    f = ["[0:a]aresample=48000,aformat=channel_layouts=stereo[a0]"]
    labels = ["[a0]"]
    for k, c in enumerate(sounds, 1):
        if not ff.has_audio(c["path"]):
            continue
        args += ["-ss", f"{c['in']:.3f}", "-t", f"{c['dur']:.3f}", "-i", c["path"]]
        idx = len(labels)
        ms = int(c["start"] * 1000)
        chain = ["aresample=48000", "aformat=channel_layouts=stereo", f"volume={c.get('gain_db', 0)}dB"]
        if c.get("fade_in"):
            chain.append(f"afade=t=in:st=0:d={c['fade_in']}")
        if c.get("fade_out"):
            chain.append(f"afade=t=out:st={max(c['dur'] - c['fade_out'], 0):.3f}:d={c['fade_out']}")
        chain.append(f"adelay={ms}|{ms}")
        f.append(f"[{idx}:a]{','.join(chain)}[a{idx}]")
        labels.append(f"[a{idx}]")
    if len(labels) == 1:
        return base_audio
    f.append("".join(labels) + f"amix=inputs={len(labels)}:normalize=0:duration=first[m]")
    ff.run([*args, "-filter_complex", ";".join(f), "-map", "[m]", "-t", f"{total:.3f}", "-ar", "48000", "-ac", "2", out])
    return out
