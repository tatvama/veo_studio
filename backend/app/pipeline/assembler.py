"""Assembles an episode into one MP4 (final export or cheap animatic), per language (PLAN §4 stages 7, 10, 11)."""
from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from .. import catalog
from ..config import get_settings
from ..models import AudioAsset, Episode, Project, Shot
from ..providers import mock
from ..storage import get_storage
from . import ffmpeg as ff
from .captions import Cue, cues_for, write_ass, write_srt
from .prompting import effective_voice_mode, shot_lines
from . import fx as fxlib
from . import layers as layerlib
from .selection import current, is_stale


@dataclass
class Segment:
    shot: Shot
    source: Path
    source_kind: str  # lipsync | voicelock | video | still
    duration: float
    trim_in: float = 0.0
    audio_override: Path | None = None
    keep_src_audio: bool = True
    src_gain_db: float = 0.0
    extra_audio: list[tuple] = field(default_factory=list)
    cues: list[Cue] = field(default_factory=list)


def project_luts(project: Project) -> dict[str, str]:
    """The team's uploaded .cube LUTs, id → file on disk."""
    st = get_storage()
    out = {}
    for l in project.luts or []:
        if l.get("id") and l.get("path") and st.exists(l["path"]):
            out[str(l["id"])] = str(st.abs(l["path"]))
    return out


def export_dims(project: Project, preset: str) -> tuple[int, int]:
    p = catalog.EXPORT_PRESETS.get(preset, catalog.EXPORT_PRESETS["shorts"])
    if preset == "draft":
        return ff.dims_for(project.aspect, 720)
    if p["aspect"]:
        return p["w"], p["h"]
    return ff.dims_for(project.aspect, 1080)


def _spans_cues(spans: list[dict], offset: float = 0.0) -> list[Cue]:
    out: list[Cue] = []
    for sp in spans or []:
        out += cues_for(offset + float(sp.get("start", 0)), offset + float(sp.get("end", 0)), sp.get("text", ""))
    return out


def plan(db: Session, episode: Episode, lang: str, kind: str, tmp: Path) -> tuple[list[Segment], list[str]]:
    st = get_storage()
    project = db.get(Project, episode.project_id)
    shots = (db.query(Shot).filter(Shot.episode_id == episode.id, Shot.include.is_(True))
             .order_by(Shot.order, Shot.id).all())
    segs: list[Segment] = []
    warnings: list[str] = []
    for shot in shots:
        lines = shot_lines(shot, lang)
        vm = effective_voice_mode(shot, project, lang)
        video = current(db, shot.id, "video")
        lips = current(db, shot.id, "lipsync", lang)
        vlock = current(db, shot.id, "voicelock", lang)
        if video is not None:  # made from an older video: using it would hide the newer clip you picked
            if is_stale(db, lips, video):
                warnings.append(f"{shot.code}: lip-sync for {lang} is from an older video — redo it for the current clip")
                lips = None
            if is_stale(db, vlock, video):
                warnings.append(f"{shot.code}: voice lock for {lang} is from an older video — redo it for the current clip")
                vlock = None
        voice = current(db, shot.id, "voice", lang)
        narr = current(db, shot.id, "narration", lang)
        voice_path = st.abs(voice.path) if voice and voice.path else None
        cues: list[Cue] = _spans_cues((voice.params or {}).get("spans", [])) if voice else []
        extra: list[tuple[Path, float]] = []
        if narr and narr.path:
            extra.append((st.abs(narr.path), 0.0))
            cues += _spans_cues((narr.params or {}).get("spans", []))
        elif (shot.narration or {}).get(lang):
            warnings.append(f"{shot.code}: narration in {lang} not voiced yet")

        if kind == "animatic" or not video:
            kf = current(db, shot.id, "keyframe")
            if kf and kf.path and st.exists(kf.path):
                img = st.abs(kf.path)
            else:
                img = tmp / f"ph_{shot.id}.png"
                img.write_bytes(mock.image(f"{shot.code}: {shot.action}", project.aspect, f"{shot.code} — no keyframe yet"))
                warnings.append(f"{shot.code}: no keyframe yet (placeholder used)")
            dur = float(shot.duration_s)
            if voice:
                dur = max(dur, voice.duration_s + 0.2)
            if kind != "animatic" and not video:
                warnings.append(f"{shot.code}: no video yet — still image used")
            if lines and not voice:
                cues += _even_cues(lines, dur)
            segs.append(Segment(shot, img, "still", dur, audio_override=voice_path, extra_audio=extra, cues=cues))
            continue

        if (video.params or {}).get("mock"):
            warnings.append(f"{shot.code}: placeholder clip (made without an API key) — generate it for real")
        vdur = max(video.duration_s or ff.duration(st.abs(video.path)), 0.5)
        trim_in = max(shot.trim_in or 0.0, 0.0)
        dur = max(vdur - trim_in - max(shot.trim_out or 0.0, 0.0), 0.5)
        if lines and lips and lips.path:
            segs.append(Segment(shot, st.abs(lips.path), "lipsync", dur, trim_in, extra_audio=extra, cues=cues or _even_cues(lines, dur)))
        elif lines and vlock and vlock.path:
            segs.append(Segment(shot, st.abs(vlock.path), "voicelock", dur, trim_in, extra_audio=extra,
                                cues=cues or _even_cues(lines, dur)))
        elif lines and vm == "native" and lang == project.primary_language:
            segs.append(Segment(shot, st.abs(video.path), "video", dur, trim_in, extra_audio=extra, cues=cues or _even_cues(lines, dur)))
        elif lines:
            if voice_path:
                warnings.append(f"{shot.code}: lip-sync for {lang} not done yet — voice laid over video (lips won't match)")
                segs.append(Segment(shot, st.abs(video.path), "video", dur, trim_in, audio_override=voice_path,
                                    extra_audio=extra, cues=cues))
            else:
                warnings.append(f"{shot.code}: no {lang} voice yet — original audio used")
                segs.append(Segment(shot, st.abs(video.path), "video", dur, trim_in, extra_audio=extra, cues=_even_cues(lines, dur)))
        else:
            gain = -6.0 if vm == "narration" else 0.0
            segs.append(Segment(shot, st.abs(video.path), "video", dur, trim_in, src_gain_db=gain, extra_audio=extra, cues=cues))
    return segs, warnings


def _even_cues(lines: list[dict], dur: float) -> list[Cue]:
    if not lines:
        return []
    step = dur / len(lines)
    out: list[Cue] = []
    for i, l in enumerate(lines):
        out += cues_for(i * step + 0.2, (i + 1) * step - 0.1, l.get("line", ""))
    return out


def _reframe_center(src: Path, w: int, h: int, tmp: Path, idx: int) -> tuple[float, float] | None:
    """Aim the crop at the main face when the clip's aspect differs from the export (e.g. 16:9 → 9:16)."""
    sw, sh = ff.video_size(src)
    if not sw or not sh or abs(sw / sh - w / h) < 0.05:
        return None
    try:
        from . import faces
        frames = ff.extract_frames(src, tmp / f"rf_{idx}", 3)
        return faces.face_center(frames)
    except Exception as e:  # OpenCV missing or unreadable frames → centre crop
        print(f"[reframe] skipped: {e}")
        return None


def _end_card(project: Project, db: Session, w: int, h: int, tmp: Path) -> tuple[Path, float] | None:
    from ..models import BrandKit
    kit = db.get(BrandKit, project.brand_kit_id) if project.brand_kit_id else None
    if not kit or not (kit.end_card or {}).get("enabled"):
        return None
    from PIL import Image, ImageDraw
    colors = kit.colors or ["#111111", "#F97316"]
    img = Image.new("RGB", (w, h), colors[0])
    d = ImageDraw.Draw(img)
    st = get_storage()
    y = int(h * 0.30)
    if kit.logo_path and st.exists(kit.logo_path):
        logo = Image.open(st.abs(kit.logo_path)).convert("RGBA")
        logo.thumbnail((int(w * 0.5), int(h * 0.22)))
        img.paste(logo, ((w - logo.width) // 2, y - logo.height // 2), logo)
        y += logo.height // 2 + int(h * 0.05)
    big, small = mock._font(max(w // 16, 28)), mock._font(max(w // 26, 20))
    accent = colors[1] if len(colors) > 1 else "#F97316"
    for text, font, color in ((kit.tagline, big, "#FFFFFF"), ((kit.end_card or {}).get("text") or kit.cta, small, accent),
                              (kit.website, small, "#DDDDDD")):
        if not text:
            continue
        tw = d.textlength(text, font=font)
        d.text(((w - tw) / 2, y), text, font=font, fill=color)
        y += int(font.size * 1.8)
    out = tmp / "endcard.png"
    img.save(out)
    return out, float((kit.end_card or {}).get("seconds") or 3)


def render(db: Session, episode: Episode, lang: str, preset: str, kind: str, options: dict[str, Any],
           out_rel_base: str) -> dict[str, Any]:
    """Render to storage. Returns {path, srt_path, thumbnail_path, duration, warnings, peaks}."""
    from .. import settings_store
    st = get_storage()
    project = db.get(Project, episode.project_id)
    w, h = export_dims(project, preset)
    team = settings_store.all_settings(db)
    caption_style = (options.get("caption_style") or (episode.settings or {}).get("caption_style")
                     or team.get("caption_style", "karaoke"))
    ep_settings = episode.settings or {}  # None = "use the team setting"
    ep_reframe, ep_sfx = ep_settings.get("auto_reframe"), ep_settings.get("sfx")
    auto_reframe = options.get("auto_reframe", team.get("auto_reframe", True) if ep_reframe is None else ep_reframe)
    use_sfx = options.get("sfx", True if ep_sfx is None else ep_sfx)
    tmp = st.tmp_dir()
    try:
        segs, warnings = plan(db, episode, lang, kind, tmp)
        if not segs:
            raise ValueError("This episode has no shots to render")
        luts = project_luts(project)
        effects = options.get("effects", True) is not False  # transitions, looks and moves (off = plain cut)
        lengths: list[float] = []
        transitions: list[tuple[str, float] | None] = []
        clips: list[Path] = []
        cues: list[Cue] = []
        overlays: list[dict] = []
        t = 0.0
        for i, sg in enumerate(segs):
            out = tmp / f"seg_{i:03}.mp4"
            sfx = sg.shot.sfx_track or {}
            if sfx.get("path") and st.exists(sfx["path"]) and use_sfx:
                sg.extra_audio.append((st.abs(sfx["path"]), float(sfx.get("start", 0)), float(sfx.get("volume_db", -8))))
            fx = dict(sg.shot.fx or {}) if effects else {}
            speed = float(fx.get("speed") or 1.0) if sg.source_kind != "still" else 1.0
            seg_len = sg.duration / speed
            if sg.source_kind == "still":
                audio = sg.audio_override
                if sg.extra_audio:
                    audio = _mix_audio(tmp / f"segaud_{i}.wav", sg.audio_override, sg.extra_audio, sg.duration)
                ff.still_to_video(sg.source, out, sg.duration, w, h, audio=audio, fx=fx, luts=luts)
            else:
                center = _reframe_center(sg.source, w, h, tmp, i) if auto_reframe else None
                ff.normalize_clip(sg.source, out, w, h, seconds=seg_len, trim_in=sg.trim_in,
                                  audio_override=sg.audio_override, mix_extra=sg.extra_audio,
                                  keep_src_audio=sg.keep_src_audio, src_audio_gain_db=sg.src_gain_db, center=center,
                                  fx=fx, luts=luts)
            # a transition blends this clip over the end of the previous one, so it starts that much earlier
            tr = fxlib.transition_of(fx) if i > 0 else None
            if tr:
                d = max(0.1, min(tr[1], seg_len / 2, lengths[-1] / 2))
                tr = (tr[0], d)
                t -= d
            transitions.append(tr)
            lengths.append(seg_len)
            clips.append(out)
            cues += [(s / speed + t, e / speed + t, txt) for s, e, txt in sg.cues if e > s]
            for ov in sg.shot.overlays or []:
                if ov.get("text"):
                    overlays.append({**ov, "start": t + float(ov.get("start", 0)),
                                     "end": t + float(ov.get("end") or seg_len)})
            t += seg_len
        card = _end_card(project, db, w, h, tmp) if kind == "final" else None
        if card:
            out = tmp / "seg_endcard.mp4"
            ff.still_to_video(card[0], out, card[1], w, h, kenburns=False)
            clips.append(out)
            lengths.append(card[1])
            transitions.append(("fade", 0.4) if any(transitions) else None)
        body = ff.xfade_concat(clips, lengths, transitions, tmp / "body.mp4")
        total = ff.duration(body)

        voice_mix = ff.extract_audio(body, tmp / "voice_mix.wav")
        pics, sounds = layerlib.resolve(episode.layers, lambda rel: st.abs(rel) if rel and st.exists(rel) else None)
        if effects and pics:
            body = layerlib.overlay(body, pics, w, h, tmp / "body_layers.mp4")
        if effects and sounds:
            voice_mix = layerlib.mix(voice_mix, sounds, total, tmp / "voice_layers.wav")
        final_audio = voice_mix
        music = (db.query(AudioAsset).filter(AudioAsset.episode_id == episode.id, AudioAsset.kind == "music")
                 .order_by(AudioAsset.selected.desc(), AudioAsset.id.desc()).first())
        settings = episode.settings or {}
        if music and music.path and st.exists(music.path) and options.get("music", True):
            final_audio = ff.music_bed(st.abs(music.path), voice_mix, tmp / "mixed.wav", total,
                                       volume_db=float(settings.get("music_volume_db", -16)), duck=settings.get("duck", True))
        elif options.get("music", True) and kind == "final":
            warnings.append("No music track yet")

        ass = None
        srt_rel = ""
        if cues:
            srt = write_srt(cues, tmp / "captions.srt")
            srt_rel = st.save_file(f"{out_rel_base}.srt", srt)
        burn = bool(options.get("captions", kind == "final")) and caption_style != "none"
        if (cues and burn) or overlays:
            ass = write_ass(cues if burn else [], tmp / "captions.ass", w, h, get_settings().caption_font,
                            "shorts" if h >= w else "standard", caption_style=caption_style, overlays=overlays)
        final = ff.replace_audio_mix(body, final_audio, tmp / "final.mp4", loudnorm=True, subtitles_ass=ass)
        out_rel = st.save_file(f"{out_rel_base}.mp4", final)
        thumb = ff.thumbnail(final, tmp / "thumb.jpg", width=480)
        thumb_rel = st.save_file(f"{out_rel_base}.jpg", thumb)
        try:
            wave_peaks = ff.peaks(final)
        except Exception:
            wave_peaks = []
        return {"path": out_rel, "srt_path": srt_rel, "thumbnail_path": thumb_rel, "duration": ff.duration(final),
                "warnings": warnings, "peaks": wave_peaks}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _mix_audio(out: Path, base: Path | None, extra: list[tuple], seconds: float) -> Path:
    args: list = []
    filters, labels = [], []
    idx = 0
    if base:
        args += ["-i", base]
        filters.append(f"[{idx}:a]aresample=48000,apad[a{idx}]")
        labels.append(f"[a{idx}]")
        idx += 1
    for item in extra:
        p, off = item[0], item[1]
        gain = f",volume={item[2]}dB" if len(item) > 2 and item[2] else ""
        args += ["-i", p]
        ms = int(off * 1000)
        filters.append(f"[{idx}:a]aresample=48000{gain},adelay={ms}|{ms},apad[a{idx}]")
        labels.append(f"[a{idx}]")
        idx += 1
    fc = ";".join(filters) + ";" + "".join(labels) + f"amix=inputs={len(labels)}:normalize=0:duration=longest[o]"
    ff.run([*args, "-filter_complex", fc, "-map", "[o]", "-t", f"{seconds:.3f}", out])
    return out


def preview_fx(db: Session, shot: Shot, fx_override: dict | None, out: Path, height: int = 480) -> Path:
    """A few seconds of this shot exactly as the export renders it (same filters, same transition from the shot
    before), small and quick, so the team can check an effect before a full render."""
    st = get_storage()
    episode = db.get(Episode, shot.episode_id)
    project = db.get(Project, episode.project_id)
    w, h = ff.dims_for(project.aspect, height)
    tmp = out.parent
    segs, _ = plan(db, episode, project.primary_language, "final", tmp)
    idx = next((i for i, s in enumerate(segs) if s.shot.id == shot.id), None)
    if idx is None:
        raise ValueError("This shot isn't in the cut")
    luts = project_luts(project)

    def make(i: int, fx: dict, part: Path, tail: float | None = None) -> float:
        sg = segs[i]
        speed = float(fx.get("speed") or 1.0) if sg.source_kind != "still" else 1.0
        length = sg.duration / speed
        if sg.source_kind == "still":
            secs = min(length, tail) if tail else min(length, 10)
            ff.still_to_video(sg.source, part, secs, w, h, audio=sg.audio_override, fx=fx, luts=luts)
            return secs
        trim = sg.trim_in
        if tail and length > tail:  # only the end of the previous shot
            trim += (length - tail) * speed
            length = tail
        length = min(length, 10)
        ff.normalize_clip(sg.source, part, w, h, seconds=length, trim_in=trim, audio_override=sg.audio_override,
                          keep_src_audio=sg.keep_src_audio, src_audio_gain_db=sg.src_gain_db, fx=fx, luts=luts)
        return length

    fx = fxlib.clean(fx_override if fx_override is not None else shot.fx)
    tr = fxlib.transition_of(fx)
    this = tmp / "pv_this.mp4"
    n = make(idx, fx, this)
    if tr and idx > 0:
        prev = tmp / "pv_prev.mp4"
        p = make(idx - 1, dict(segs[idx - 1].shot.fx or {}), prev, tail=tr[1] + 1.2)
        return ff.xfade_concat([prev, this], [p, n], [None, (tr[0], min(tr[1], p / 2, n / 2))], out)
    shutil.copyfile(this, out)
    return out
