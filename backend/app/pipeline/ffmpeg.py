"""Thin FFmpeg helpers. Uses FFMPEG_PATH, then system ffmpeg, then the imageio-ffmpeg bundled binary."""
from __future__ import annotations

import math
import re
import shutil
import struct
import subprocess
import wave
from functools import lru_cache
from pathlib import Path

from ..config import get_settings


class FFmpegError(RuntimeError):
    pass


@lru_cache
def ffmpeg_exe() -> str:
    s = get_settings()
    if s.ffmpeg_path and Path(s.ffmpeg_path).exists():
        return s.ffmpeg_path
    sys_ff = shutil.which("ffmpeg")
    if sys_ff:
        return sys_ff
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def run(args: list[str], timeout: int = 900) -> str:
    cmd = [ffmpeg_exe(), "-hide_banner", "-y", *[str(a) for a in args]]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if p.returncode != 0:
        tail = "\n".join(p.stderr.strip().splitlines()[-15:])
        raise FFmpegError(f"ffmpeg failed ({p.returncode}): {tail}")
    return p.stderr


def info(path: Path | str) -> str:
    p = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", str(path)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=60)
    return p.stderr


def duration(path: Path | str) -> float:
    path = Path(path)
    if path.suffix.lower() == ".wav":
        try:
            with wave.open(str(path), "rb") as w:
                return w.getnframes() / float(w.getframerate())
        except Exception:
            pass
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", info(path))
    if not m:
        return 0.0
    h, mi, se = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(se)


def has_audio(path: Path | str) -> bool:
    return bool(re.search(r"Stream #.*Audio:", info(path)))


def video_size(path: Path | str) -> tuple[int, int]:
    m = re.search(r"Stream #.*Video:.*?(\d{2,5})x(\d{2,5})", info(path))
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def dims_for(aspect: str, height: int = 1080) -> tuple[int, int]:
    """Even pixel dims for an aspect at a given short side."""
    if aspect == "9:16":
        return height, int(height * 16 / 9) // 2 * 2
    if aspect == "1:1":
        return height, height
    return int(height * 16 / 9) // 2 * 2, height


# ── frames ───────────────────────────────────────────────────────────────────

def extract_frame(video: Path, out_png: Path, at: float | str = "last") -> Path:
    out_png.parent.mkdir(parents=True, exist_ok=True)
    if at == "last":
        run(["-sseof", "-0.15", "-i", video, "-frames:v", "1", "-update", "1", out_png])
    else:
        run(["-ss", f"{float(at):.3f}", "-i", video, "-frames:v", "1", "-update", "1", out_png])
    return out_png


def extract_frames(video: Path, out_dir: Path, n: int = 4) -> list[Path]:
    d = max(duration(video), 0.5)
    out_dir.mkdir(parents=True, exist_ok=True)
    frames = []
    for i in range(n):
        t = d * (i + 0.5) / n
        f = out_dir / f"qc_{i}.jpg"
        run(["-ss", f"{t:.3f}", "-i", video, "-frames:v", "1", "-q:v", "3", "-update", "1", f])
        frames.append(f)
    return frames


def thumbnail(src: Path, out_jpg: Path, width: int = 360) -> Path:
    """Thumbnail from an image or the middle of a video."""
    out_jpg.parent.mkdir(parents=True, exist_ok=True)
    if src.suffix.lower() in {".mp4", ".mov", ".webm", ".mkv"}:
        t = max(duration(src) / 2, 0)
        run(["-ss", f"{t:.2f}", "-i", src, "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "4", "-update", "1", out_jpg])
    else:
        run(["-i", src, "-vf", f"scale={width}:-2", "-q:v", "4", "-update", "1", out_jpg])
    return out_jpg


# ── video building blocks ────────────────────────────────────────────────────

def fit_filter(w: int, h: int, center: tuple[float, float] | None = None) -> str:
    """Scale to cover then crop to exactly w×h (no letterboxing). `center` (0–1) aims the crop, e.g. at a face."""
    if not center:
        return f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1"
    cx, cy = center
    return (f"scale={w}:{h}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h}:'max(0,min(iw-ow,iw*{cx:.4f}-ow/2))':'max(0,min(ih-oh,ih*{cy:.4f}-oh/2))',setsar=1")


def still_to_video(image: Path, out: Path, seconds: float, w: int, h: int, fps: int = 24,
                   audio: Path | None = None, kenburns: bool = True, fx: dict | None = None,
                   luts: dict[str, str] | None = None) -> Path:
    from . import fx as fxlib
    frames = max(int(round(seconds * fps)), 1)
    if fx and (fx.get("move") or {}).get("kind", "none") != "none":
        kenburns = False  # the shot's own camera move (added below) instead of the default push-in
    if kenburns:
        vf = (f"scale={w * 2}:{h * 2}:force_original_aspect_ratio=increase,crop={w * 2}:{h * 2},"
              f"zoompan=z='min(zoom+0.0009,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={w}x{h}:fps={fps},setsar=1")
    else:
        vf = fit_filter(w, h) + f",fps={fps}"
    extra = fxlib.video_filters(fx, w, h, seconds, fps, luts)
    if extra:
        vf += "," + extra
    af = fxlib.audio_filters(fx, seconds)
    args: list = ["-loop", "1", "-framerate", str(fps), "-i", image]
    if audio:
        args += ["-i", audio]
    else:
        args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
    args += ["-t", f"{seconds:.3f}", "-vf", vf, "-map", "0:v", "-map", "1:a",
             "-af", f"apad,atrim=0:{seconds:.3f}" + (f",{af}" if af else ""), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
             "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", out]
    run(args)
    return out


def normalize_clip(src: Path, out: Path, w: int, h: int, seconds: float | None = None, trim_in: float = 0.0,
                   fps: int = 24, audio_override: Path | None = None, mix_extra: list[tuple] | None = None,
                   keep_src_audio: bool = True, src_audio_gain_db: float = 0.0,
                   center: tuple[float, float] | None = None, fx: dict | None = None,
                   luts: dict[str, str] | None = None) -> Path:
    """Scale/crop/trim a clip to the export format. Optionally replace or add audio tracks.

    mix_extra: list of (audio_path, start_offset_seconds[, gain_db]) laid over the clip audio.
    center: crop aim (0–1, 0–1), used by face-aware auto-reframe.
    """
    from . import fx as fxlib
    fx = fx or {}
    speed = float(fx.get("speed") or 1.0)
    src_dur = duration(src)
    seg = seconds if seconds else max((src_dur - trim_in) / speed, 0.1)
    pre = ""  # before framing: stabilise, reverse, speed (they work on the source frames)
    if fx.get("stabilize"):
        trf = out.with_suffix(".trf")
        try:
            run(["-ss", f"{trim_in:.3f}", "-t", f"{seg * speed + 0.5:.3f}", "-i", src, "-vf",
                 f"vidstabdetect=shakiness=6:accuracy=12:result='{fxlib._esc_path(str(trf))}'", "-f", "null", "-"])
            pre += f"vidstabtransform=input='{fxlib._esc_path(str(trf))}':smoothing=12:zoom=2,unsharp=5:5:0.6,"
        except Exception as e:  # stabilising is a nicety; never fail the export over it
            print(f"[fx] stabilize skipped: {e}")
    if fx.get("reverse"):
        pre += "reverse,"
    if abs(speed - 1) > 1e-3:
        pre += f"setpts=(PTS-STARTPTS)/{speed},"
    args: list = ["-ss", f"{trim_in:.3f}", "-t", f"{seg * speed + 0.5:.3f}", "-i", src]
    inputs_audio: list[str] = []
    idx = 1
    if audio_override:
        args += ["-i", audio_override]
        inputs_audio.append(f"[{idx}:a]aresample=48000,aformat=channel_layouts=stereo,apad[a{idx}]")
        idx += 1
    elif keep_src_audio and has_audio(src):
        gain = f",volume={src_audio_gain_db}dB" if src_audio_gain_db else ""
        inputs_audio.append(f"[0:a]aresample=48000,aformat=channel_layouts=stereo{gain},apad[a0]")
    for item in (mix_extra or []):
        extra, offset = item[0], item[1]
        gain = f",volume={item[2]}dB" if len(item) > 2 and item[2] else ""
        args += ["-i", extra]
        ms = int(max(offset, 0) * 1000)
        inputs_audio.append(f"[{idx}:a]aresample=48000,aformat=channel_layouts=stereo{gain},adelay={ms}|{ms},apad[a{idx}]")
        idx += 1
    if not inputs_audio:
        args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
        inputs_audio.append(f"[{idx}:a]apad[a{idx}]")
        idx += 1
    labels = [s.rsplit("[", 1)[1].rstrip("]") for s in inputs_audio]
    fc = ";".join(inputs_audio)
    if len(labels) > 1:
        fc += ";" + "".join(f"[{l}]" for l in labels) + f"amix=inputs={len(labels)}:normalize=0:duration=longest[am]"
        amap = "[am]"
    else:
        amap = f"[{labels[0]}]"
    a_fx = [fxlib.atempo_chain(speed)] if abs(speed - 1) > 1e-3 else []
    if fxlib.audio_filters(fx, seg):
        a_fx.append(fxlib.audio_filters(fx, seg))
    if a_fx:  # the clip's sound follows its speed and fades
        fc += f";{amap}{','.join(a_fx)},apad[afx]"
        amap = "[afx]"
    post = fxlib.video_filters(fx, w, h, seg, fps, luts)
    fc += (f";[0:v]{pre}{fit_filter(w, h, center)},fps={fps}{',' + post if post else ''},"
           f"tpad=stop_mode=clone:stop_duration=30[vv]")
    args += ["-filter_complex", fc, "-map", "[vv]", "-map", amap, "-t", f"{seg:.3f}",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-ar", "48000", "-ac", "2", out]
    run(args)
    return out


def xfade_concat(clips: list[Path], lengths: list[float], transitions: list[tuple[str, float] | None], out: Path,
                 fps: int = 24) -> Path:
    """Join clips; transitions[i] (for i ≥ 1) blends clip i in from clip i-1 (FFmpeg xfade + acrossfade), None = cut.
    All clips must already share size, fps and audio format (normalize_clip / still_to_video make sure)."""
    if not any(transitions[1:]):
        return concat(clips, out)
    args: list = []
    for c in clips:
        args += ["-i", c]
    f: list[str] = []
    for i in range(len(clips)):
        f.append(f"[{i}:v]setpts=PTS-STARTPTS,settb=AVTB,fps={fps},format=yuv420p[v{i}]")  # fps last: xfade needs CFR
        f.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a{i}]")
    vcur, acur, length = "v0", "a0", lengths[0]
    for i in range(1, len(clips)):
        tr = transitions[i]
        vo, ao = f"vx{i}", f"ax{i}"
        if tr:
            name, d = tr
            d = max(0.1, min(d, lengths[i] / 2, length / 2))  # never longer than half of either clip
            off = max(length - d, 0)
            f.append(f"[{vcur}][v{i}]xfade=transition={name}:duration={d:.3f}:offset={off:.3f}[{vo}]")
            f.append(f"[{acur}][a{i}]acrossfade=d={d:.3f}:c1=tri:c2=tri[{ao}]")
            length = length + lengths[i] - d
        else:
            f.append(f"[{vcur}][{acur}][v{i}][a{i}]concat=n=2:v=1:a=1[{vo}c][{ao}]")
            f.append(f"[{vo}c]fps={fps}[{vo}]")  # keep a constant frame rate for the next transition
            length += lengths[i]
        vcur, acur = vo, ao
    run([*args, "-filter_complex", ";".join(f), "-map", f"[{vcur}]", "-map", f"[{acur}]",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-ar", "48000", "-ac", "2", out], timeout=3600)
    return out


def concat(clips: list[Path], out: Path) -> Path:
    lst = out.parent / f"{out.stem}_list.txt"
    lst.write_text("".join(f"file '{c.resolve().as_posix()}'\n" for c in clips), encoding="utf-8")
    run(["-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out])
    return out


def mux_audio(video: Path, audio: Path, out: Path) -> Path:
    """Replace the video's audio with `audio` (padded/trimmed to the video length)."""
    d = duration(video)
    run(["-i", video, "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "copy",
         "-af", f"apad,atrim=0:{d:.3f}", "-c:a", "aac", "-ar", "48000", "-ac", "2", out])
    return out


def extract_audio(video: Path, out_wav: Path) -> Path:
    run(["-i", video, "-vn", "-ac", "1", "-ar", "44100", out_wav])
    return out_wav


def to_wav(src: Path, out_wav: Path, rate: int = 48000) -> Path:
    run(["-i", src, "-ac", "1", "-ar", str(rate), out_wav])
    return out_wav


def fit_audio_length(src: Path, out: Path, target: float, max_speedup: float = 1.25) -> tuple[Path, float]:
    """Speed audio up (max 1.25×) so it fits target seconds. Returns (path, factor used)."""
    d = duration(src)
    factor = 1.0
    if target > 0 and d > target:
        factor = min(d / target, max_speedup)
    if factor > 1.001:
        run(["-i", src, "-filter:a", f"atempo={factor:.4f}", out])
    else:
        shutil.copyfile(src, out)
    return out, factor


def music_bed(music: Path, voice_mix: Path | None, out: Path, length: float, volume_db: float = -16.0,
              duck: bool = True) -> Path:
    """Loop/trim music to `length`, fade out, and duck it under the voice track."""
    fade_start = max(length - 2.0, 0)
    base = (f"[0:a]aresample=48000,aformat=channel_layouts=stereo,volume={volume_db}dB,"
            f"atrim=0:{length:.3f},afade=t=out:st={fade_start:.3f}:d=2[m]")
    if voice_mix and duck:
        fc = base + (";[1:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[sc][vo];"
                     "[m][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350[md];"
                     "[md][vo]amix=inputs=2:normalize=0:duration=first[out]")
        run(["-stream_loop", "-1", "-i", music, "-i", voice_mix, "-filter_complex", fc, "-map", "[out]",
             "-t", f"{length:.3f}", "-ar", "48000", out])
    else:
        run(["-stream_loop", "-1", "-i", music, "-filter_complex", base, "-map", "[m]", "-t", f"{length:.3f}", out])
    return out


def replace_audio_mix(video: Path, audio: Path, out: Path, loudnorm: bool = True, subtitles_ass: Path | None = None,
                      fontsdir: Path | None = None) -> Path:
    """Final mux: new audio (loudness-normalised to -14 LUFS) + optional burned subtitles."""
    af = "loudnorm=I=-14:TP=-1.5:LRA=11" if loudnorm else "anull"
    args: list = ["-i", video, "-i", audio]
    if subtitles_ass:
        sub = subtitles_ass.resolve().as_posix().replace(":", r"\:")
        # shaping=complex makes libass use HarfBuzz, required for Indic conjuncts (ನ್ನ, త్రి, क्ष …)
        vf = f"ass='{sub}':shaping=complex"
        if fontsdir:
            vf += f":fontsdir='{fontsdir.resolve().as_posix().replace(':', chr(92) + ':')}'"
        args += ["-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p"]
    else:
        args += ["-c:v", "copy"]
    args += ["-map", "0:v", "-map", "1:a", "-af", af, "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
             "-movflags", "+faststart", "-shortest", out]
    run(args)
    return out


def peaks(src: Path, points: int = 800) -> list[float]:
    """Audio waveform peaks (0–1) for the review player."""
    p = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", str(src), "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
                       capture_output=True, timeout=300)
    raw = p.stdout
    if not raw:
        return []
    n = len(raw) // 2
    samples = struct.unpack(f"<{n}h", raw[: n * 2])
    step = max(n // points, 1)
    out = []
    for i in range(0, n, step):
        chunk = samples[i:i + step]
        out.append(round(max(abs(x) for x in chunk) / 32768, 3) if chunk else 0.0)
    return out[:points]


# ── pure-python WAV helpers (used by mocks and dialogue assembly) ────────────

def write_tone_wav(path: Path, seconds: float, freq: float = 220.0, rate: int = 24000, volume: float = 0.25,
                   syllables: bool = True) -> Path:
    """A soft 'speech-like' tone pattern so mock audio is audible and has a real duration."""
    path.parent.mkdir(parents=True, exist_ok=True)
    n = int(seconds * rate)
    frames = bytearray()
    for i in range(n):
        t = i / rate
        env = 1.0
        if syllables:
            env = 0.5 * (1 - math.cos(2 * math.pi * ((t * 4.0) % 1.0)))
        v = volume * env * (math.sin(2 * math.pi * freq * t) + 0.3 * math.sin(2 * math.pi * freq * 2 * t))
        frames += struct.pack("<h", int(max(-1, min(1, v)) * 32767))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    return path


def silence_wav(path: Path, seconds: float, rate: int = 48000) -> Path:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(seconds * rate))
    return path


def concat_audio_with_gaps(parts: list[Path], out_wav: Path, gap: float = 0.25, lead_in: float = 0.3,
                           rate: int = 48000) -> list[tuple[float, float]]:
    """Concatenate audio files (any format) into one mono WAV with gaps. Returns [(start, end)] per part."""
    tmp = out_wav.parent
    norm: list[Path] = []
    for i, p in enumerate(parts):
        q = tmp / f"_part_{out_wav.stem}_{i}.wav"
        run(["-i", p, "-ac", "1", "-ar", str(rate), "-sample_fmt", "s16", q])
        norm.append(q)
    spans: list[tuple[float, float]] = []
    pcm = bytearray()
    cursor = lead_in
    pcm += b"\x00\x00" * int(lead_in * rate)
    for i, q in enumerate(norm):
        with wave.open(str(q), "rb") as w:
            data = w.readframes(w.getnframes())
            d = w.getnframes() / float(w.getframerate())
        spans.append((round(cursor, 3), round(cursor + d, 3)))
        pcm += data
        cursor += d
        if i < len(norm) - 1:
            pcm += b"\x00\x00" * int(gap * rate)
            cursor += gap
    pcm += b"\x00\x00" * int(0.2 * rate)
    with wave.open(str(out_wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(pcm))
    for q in norm:
        q.unlink(missing_ok=True)
    return spans
