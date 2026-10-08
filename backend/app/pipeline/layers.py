"""Extra timeline layers above the main shot track: video layers (picture-in-picture, B-roll, logos, images) and audio
layers (voice-overs, extra music, sound effects).

Stored per episode in `Episode.layers`:
    rev     version, so two editors can't overwrite each other (a save names the rev it started from)
    video   [{id, name, hidden, muted, clips: [{id, src, kind: video|image, name, start, in, dur,
                                               x, y, scale, opacity, fade_in, fade_out, gain_db, muted}]}]
    audio   [{id, name, muted, gain_db, clips: [{id, src, name, start, in, dur, gain_db, fade_in, fade_out}]}]
    media   uploaded files the layers can use [{src, kind, name, duration, thumb}]
Times are on the finished cut's timeline (seconds, after transitions overlap shots). Video layers stack in order:
the first sits just above the main track, the last on top.
"""
from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from . import ffmpeg as ff

MAX_TRACKS = 8
MAX_CLIPS = 200


def _num(v: Any, lo: float, hi: float, default: float) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, x))


def _id(v: Any) -> str:
    s = str(v or "")
    return s[:24] if s and all(c.isalnum() or c in "-_" for c in s) else uuid.uuid4().hex[:10]


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
        return out

    def tracks(kind: str) -> list[dict]:
        res = []
        for t in (layers.get(kind) or [])[:MAX_TRACKS]:
            clips = [c for c in (clip_ok(c) for c in (t.get("clips") or [])[:MAX_CLIPS] if isinstance(c, dict)) if c]
            if kind == "video":
                clips = [c for c in clips if c["kind"] in ("video", "image")]
            else:
                clips = [c for c in clips if c["kind"] in ("audio", "video")]  # a video's sound can sit on an audio layer
            res.append({"id": _id(t.get("id")), "name": str(t.get("name") or "")[:40] or f"{kind.title()} {len(res) + 1}",
                        "muted": bool(t.get("muted")), "hidden": bool(t.get("hidden")),
                        "gain_db": round(_num(t.get("gain_db"), -60, 12, 0), 1), "clips": sorted(clips, key=lambda c: c["start"])})
        return res

    return {"video": tracks("video"), "audio": tracks("audio")}


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


def overlay(body: Path, pics: list[dict], w: int, h: int, out: Path) -> Path:
    """Composite the picture layers over the main track (position = centre as a fraction of the frame, scale = width)."""
    if not pics:
        return body
    args: list = ["-i", body]
    f: list[str] = []
    base = "0:v"
    for k, c in enumerate(pics, 1):
        if c["kind"] == "image":
            args += ["-loop", "1", "-framerate", "24", "-t", f"{c['dur']:.3f}", "-i", c["path"]]
        else:
            args += ["-ss", f"{c['in']:.3f}", "-t", f"{c['dur']:.3f}", "-i", c["path"]]
        sw = max(2, int(round(w * c.get("scale", 0.35) / 2)) * 2)
        st, end = c["start"], c["start"] + c["dur"]
        chain = [f"setpts=PTS-STARTPTS+{st:.3f}/TB", f"scale={sw}:-2", "format=yuva420p"]
        if c.get("opacity", 1) < 0.999:
            chain.append(f"colorchannelmixer=aa={c['opacity']:.3f}")
        if c.get("fade_in"):
            chain.append(f"fade=t=in:st={st:.3f}:d={c['fade_in']}:alpha=1")
        if c.get("fade_out"):
            chain.append(f"fade=t=out:st={max(end - c['fade_out'], st):.3f}:d={c['fade_out']}:alpha=1")
        f.append(f"[{k}:v]{','.join(chain)}[p{k}]")
        f.append(f"[{base}][p{k}]overlay=x='main_w*{c.get('x', 0.5):.4f}-overlay_w/2':y='main_h*{c.get('y', 0.5):.4f}-overlay_h/2'"
                 f":enable='between(t,{st:.3f},{end:.3f})':eof_action=pass[b{k}]")
        base = f"b{k}"
    ff.run([*args, "-filter_complex", ";".join(f), "-map", f"[{base}]", "-an", "-c:v", "libx264", "-preset", "veryfast",
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
