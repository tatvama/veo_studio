"""Assembles an episode into one MP4 (final export or cheap animatic), per language (PLAN §4 stages 7, 10, 11)."""
from __future__ import annotations

import math
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from .. import catalog
from ..config import get_settings
from ..models import AudioAsset, Episode, Project, Shot, Take
from ..providers import mock
from ..storage import get_storage
from . import ffmpeg as ff
from .captions import Cue, cues_for, speech_seconds, write_ass, write_srt
from .prompting import effective_voice_mode, offscreen_only, shot_lines
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
    extra_audio: list[tuple] = field(default_factory=list)  # (file, offset s, gain dB, storage key)
    cues: list[Cue] = field(default_factory=list)
    source_key: str = ""  # storage keys of source / audio_override ("" = a placeholder made for this render)
    audio_key: str = ""
    needs_bed: bool = False  # a dialogue clip whose own sound (and the scene's background with it) was swapped for the voice
    # the clip's own sound plays here, with the effects its prompt asked for (so a separate effects track would double them)
    own_sound: bool = False
    # where speech plays in this segment, (file, offset s, in-point in the file s): levelled as voices, and what the
    # music ducks under (voice_track)
    voices: list[tuple] = field(default_factory=list)


@dataclass
class Timed:
    """A segment placed on the finished cut: its effects, speed, length, transition in and start time."""
    sg: Segment
    fx: dict
    speed: float
    seg_len: float
    start: float
    transition: tuple[str, float] | None


END_CARD_FADE = ("fade", 0.4)  # how the brand end card comes in after a cut that has transitions


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


def _spans_cues(spans: list[dict], offset: float = 0.0, scale: float = 1.0) -> list[Cue]:
    """Caption cues from a voice take's spans, `scale` for a voice that was sped up to fit its clip (lip-sync)."""
    out: list[Cue] = []
    for sp in spans or []:
        out += cues_for(offset + float(sp.get("start", 0)) * scale, offset + float(sp.get("end", 0)) * scale, sp.get("text", ""))
    return out


NARRATION_AFTER = 0.1  # the narration starts this long after the dialogue's last word (its file adds 0.2 s of lead-in)


def plan(db: Session, episode: Episode, lang: str, kind: str, tmp: Path,
         ro: dict[str, Any] | None = None) -> tuple[list[Segment], list[str]]:
    """The cut as segments (one per included shot) and what to warn about. `ro`: the render options (render_options);
    with `ambience` on (default) a dialogue clip whose own sound was replaced gets its scene's background back.

    No speech is ever cut: a voice or the narration that runs past its clip holds the clip's last frame until the words
    end. A clip longer than its shot was planned (Veo makes 8 s in some modes) is trimmed to the plan, unless words
    need more. The narrator never talks over a character: in a shot that has both, the narration starts after the
    dialogue's last word. A dialogue clip with no voice yet never plays its own sound (made-up speech, the clip was
    asked for mouths moving, not words): the scene's background, else silence, until the voice is made."""
    st = get_storage()
    project = db.get(Project, episode.project_id)
    shots = (db.query(Shot).filter(Shot.episode_id == episode.id, Shot.include.is_(True))
             .order_by(Shot.order, Shot.id).all())
    segs: list[Segment] = []
    warnings: list[str] = []
    for shot in shots:
        lines = shot_lines(shot, lang)
        off = bool(lines) and offscreen_only(shot, project)  # heard from off-screen: voiced over the clip, no lips
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
        still = kind == "animatic" or not video
        if off or still:  # (nobody's lips to sync; a still plays the voice itself)
            lips = vlock = None
        lips = lips if lips and lips.path and lines else None
        vlock = vlock if vlock and vlock.path and lines else None
        voice = current(db, shot.id, "voice", lang)
        narr = current(db, shot.id, "narration", lang)
        voice_path = st.abs(voice.path) if voice and voice.path else None
        voice_key = voice.path if voice_path else ""
        # the words as the clip has them: a lip-synced voice was sped up to fit (its speed factor), and its take says
        # which voice it was made from
        factor = max(float((lips.params or {}).get("speed_factor") or 1.0), 0.5) if lips else 1.0
        said_take = (db.get(Take, (lips.params or {}).get("voice_take_id")) if lips and (lips.params or {}).get("voice_take_id")
                     else None) or voice
        spans = list((said_take.params or {}).get("spans") or []) if said_take else []
        said_cues = _spans_cues(spans, scale=1 / factor)
        said_end = 0.0
        if lines:  # where the dialogue's last word ends (estimated from the words while no voice says it)
            said_end = (max(float(sp.get("end", 0)) for sp in spans) / factor if spans
                        else 0.3 + speech_seconds(" ".join(l.get("line", "") for l in lines), lang))
        extra: list[tuple] = []
        voices: list[tuple] = []
        narr_cues: list[Cue] = []
        narr_s = 0.0  # where the voice-over ends (with a short tail), so it is never cut off mid-sentence
        if narr and narr.path:
            at = round(said_end + NARRATION_AFTER, 3) if lines else 0.0  # never over a character's line
            extra.append((st.abs(narr.path), at, 0.0, narr.path))
            voices.append((st.abs(narr.path), at, 0.0))
            narr_cues = _spans_cues((narr.params or {}).get("spans", []), offset=at)
            narr_s = at + float(narr.duration_s) + 0.3 if narr.duration_s else 0.0
        elif (shot.narration or {}).get(lang):
            warnings.append(f"{shot.code}: narration in {lang} not voiced yet")

        if still:
            kf = current(db, shot.id, "keyframe")
            img_key = ""
            if kf and kf.path and st.exists(kf.path):
                img, img_key = st.abs(kf.path), kf.path
            else:
                img = tmp / f"ph_{shot.id}.png"
                img.write_bytes(mock.image(f"{shot.code}: {shot.action}", project.aspect, f"{shot.code} — no keyframe yet"))
                warnings.append(f"{shot.code}: no keyframe yet (placeholder used)")
            dur = max(float(shot.duration_s), narr_s)
            if voice:
                dur = max(dur, voice.duration_s + 0.2)
            if kind != "animatic" and not video:
                warnings.append(f"{shot.code}: no video yet — still image used")
            cues = said_cues if voice else (_even_cues(lines, min(dur, said_end + 0.3) if narr_cues else dur) if lines else [])
            segs.append(Segment(shot, img, "still", dur, audio_override=voice_path, extra_audio=extra, cues=cues + narr_cues,
                                source_key=img_key, audio_key=voice_key,
                                voices=([(voice_path, 0.0, 0.0)] if voice_path else []) + voices))
            continue

        if (video.params or {}).get("mock"):
            warnings.append(f"{shot.code}: placeholder clip (made without an API key) — generate it for real")
        vdur = max(video.duration_s or ff.duration(st.abs(video.path)), 0.5)
        trim_in = max(shot.trim_in or 0.0, 0.0)
        avail = max(vdur - trim_in - max(shot.trim_out or 0.0, 0.0), 0.5)  # the clip as trimmed
        if lines and lips and lips.path and float(lips.duration_s or 0) - trim_in > avail + 0.05:
            avail = float(lips.duration_s) - trim_in  # the lip-sync held the clip's last frame until the line ended
        # the shot's planned length (the extension's, when the clip was extended): a longer clip is trimmed to it
        planned = float(shot.extend_to) if shot.extend_to and vdur > shot.duration_s + 1 else float(shot.duration_s or 0)
        dur = min(avail, planned) if planned > 0 else avail
        native = bool(lines) and vm == "native" and lang == project.primary_language
        vid = {"source": st.abs(video.path), "source_key": video.path}
        even = _even_cues(lines, min(avail, said_end + 0.3) if narr_cues else dur) if lines else []
        words = 0.0  # where the words in the clip end: it never stops before them
        if lips:
            words = min(said_end + 0.2, avail)  # the voice is in the clip: it can't run past it
            sg = Segment(shot, st.abs(lips.path), "lipsync", dur, trim_in, extra_audio=extra, cues=said_cues or even,
                         source_key=lips.path, needs_bed=True, voices=[(st.abs(lips.path), 0.0, trim_in)])
        elif vlock:  # Demucs keeps the background under the new voice; voice isolation drops it
            demucs = (vlock.params or {}).get("separation") == "demucs"
            words = min(said_end + 0.2, avail)
            sg = Segment(shot, st.abs(vlock.path), "voicelock", dur, trim_in, extra_audio=extra, cues=said_cues or even,
                         source_key=vlock.path, needs_bed=not demucs, own_sound=demucs,
                         voices=[(st.abs(vlock.path), 0.0, trim_in)])
        elif native:  # Veo speaks the line somewhere in its clip: all of it plays, so no word is cut
            words = avail
            sg = Segment(shot, source_kind="video", duration=dur, trim_in=trim_in, extra_audio=extra, cues=said_cues or even,
                         own_sound=True, voices=[(vid["source"], 0.0, trim_in)], **vid)
        elif lines and voice_path:
            words = float(voice.duration_s or 0) + 0.2 if voice.duration_s else 0.0
            if off and vm != "native":  # nobody on screen says it: the voice over the clip's own sound, no lips to match
                sg = Segment(shot, source_kind="video", duration=dur, trim_in=trim_in, cues=said_cues,
                             extra_audio=[(voice_path, 0.0, 0.0, voice_key), *extra], own_sound=True, **vid)
            else:  # (a dub of a clip where Veo speaks: its own words go, the background comes back)
                if not off:
                    warnings.append(f"{shot.code}: lip-sync for {lang} not done yet — voice laid over video (lips won't match)")
                sg = Segment(shot, source_kind="video", duration=dur, trim_in=trim_in, audio_override=voice_path,
                             extra_audio=extra, cues=said_cues, audio_key=voice_key, needs_bed=True, **vid)
            sg.voices = [(voice_path, 0.0, 0.0)]
        elif lines and (off or vm in ("audio_first", "audio_driven")):
            warnings.append(f"{shot.code}: no {lang} voice yet: the clip's own sound is left out (it could speak made-up "
                            "words) and the scene's background plays under the captions; make the voice to hear the line")
            sg = Segment(shot, source_kind="video", duration=dur, trim_in=trim_in, extra_audio=extra, cues=even,
                         keep_src_audio=False, needs_bed=True, **vid)
        elif lines:  # voice lock not done yet: the clip speaks the scripted line itself
            warnings.append(f"{shot.code}: no {lang} voice yet — original audio used")
            sg = Segment(shot, source_kind="video", duration=dur, trim_in=trim_in, extra_audio=extra, cues=even,
                         own_sound=True, voices=[(vid["source"], 0.0, trim_in)], **vid)
        else:
            sg = Segment(shot, source_kind="video", duration=dur, trim_in=trim_in, src_gain_db=-6.0 if vm == "narration" else 0.0,
                         extra_audio=extra, own_sound=True, **vid)
        sg.cues = sg.cues + narr_cues
        sg.voices = sg.voices + voices
        need = max(narr_s, words)
        if need > sg.duration + 0.05:
            if need > avail + 0.05:  # past the clip: it holds its last frame (normalize_clip pads with it)
                warnings.append(f"{shot.code}: the {'voice-over' if narr_s >= words else 'voice'} runs {need:.1f}s and "
                                f"the clip {avail:.1f}s; its last frame is held until the words end (a longer shot or an "
                                "extension fixes it)")
            sg.duration = need
        segs.append(sg)
    if (ro or {}).get("ambience", True):
        warnings += ambience_beds(db, project, segs, lang, bool((ro or {}).get("sfx", True)), tmp)
    if (ro or {}).get("sfx", True):
        doubled = [sg.shot.code for sg in segs if (sg.shot.sfx_track or {}).get("path")
                   and st.exists(sg.shot.sfx_track["path"]) and not _sfx_fits(sg)]
        if doubled:
            warnings.append(f"{', '.join(doubled[:8])}{' …' if len(doubled) > 8 else ''}: their sound effects stay out of the "
                            "mix: the clip's own sound already has them (they would play twice). Make the shot's sound "
                            "effects again to lay them over it anyway.")
    return segs, warnings


# ── the scene's background under dialogue ────────────────────────────────────

AMBIENCE_GAIN_DB = -14.0  # the bed under the voice (the bed itself is levelled to the mix's loudness first)
AMBIENCE_LUFS = -14.0
AMBIENCE_SILENT_LUFS = -55.0  # a clip quieter than this has no background worth carrying


def _sfx_fits(sg: Segment) -> bool:
    """A shot's sound-effects track belongs over this segment: the clip's own sound is replaced (a lip-synced or laid
    voice) or there is none (a still, a clip without sound), or the track was made to go over it (Sound design on the
    shot, sfx_track.over_clip). Over a clip that keeps its own sound, which has the effects its prompt asked for, it
    would play them twice (core/generation.keeps_clip_sound decides the same before they are made)."""
    return not sg.own_sound or bool((sg.shot.sfx_track or {}).get("over_clip")) or not ff.has_audio_kept(sg.source)


def _keeps_sfx(sg: Segment, use_sfx: bool) -> bool:
    """The shot's own sound-effects track goes into this render (timeline() adds it): it carries the scene's sound."""
    sfx = sg.shot.sfx_track or {}
    return bool(use_sfx and sfx.get("path") and get_storage().exists(sfx["path"]) and _sfx_fits(sg))


def ambience_beds(db: Session, project: Project, segs: list[Segment], lang: str, use_sfx: bool, tmp: Path) -> list[str]:
    """A lip-sync take, a voice-lock take without the background, or a voice laid over a clip replaces the clip's own
    sound, and the scene's rain or room sound goes with it: the cut then drops to dead silence behind every line.
    Each such segment with no sound-effects track of its own gets its scene's background back, taken from a clip of
    the same scene where nobody speaks (scene_ambience), at AMBIENCE_GAIN_DB. A clip where Veo speaks the line keeps
    its own sound and needs none. Returns the warnings for dialogue shots left with no background at all."""
    st = get_storage()
    groups: dict[int | None, list[Segment]] = {}
    for sg in segs:
        if sg.needs_bed and not _keeps_sfx(sg, use_sfx):
            groups.setdefault(sg.shot.scene_id, []).append(sg)
    warnings = []
    for scene_id, group in groups.items():
        key = scene_ambience(db, project, scene_id, lang, max(sg.duration for sg in group), tmp) if scene_id else None
        for sg in group:
            if key:
                sg.extra_audio.append((st.abs(key), 0.0, AMBIENCE_GAIN_DB, key))
            else:
                warnings.append(f"{sg.shot.code}: the scene's background sound drops out under the dialogue (no clip in the "
                                "scene without dialogue to take it from): a sound effect for the shot, or a shot without "
                                "dialogue in the scene, brings it back")
    return warnings


def scene_ambience(db: Session, project: Project, scene_id: int, lang: str, seconds: float, tmp: Path) -> str | None:
    """Storage key of the scene's background bed, at least `seconds` long: the sound of the longest real clip of the
    scene where nobody speaks in `lang` (silent or voice-over only: its own sound is the scene's ambience alone; not
    a mock placeholder, a draft or a stale take), levelled and looped. Kept in storage per clip and length, so later
    renders and the desktop's render plan (which needs a storage key for every file) reuse it."""
    st = get_storage()
    length = 10.0 * math.ceil(max(seconds + 0.5, 20.0) / 10.0)  # a few lengths only: most scenes share one file
    found = []
    for s in db.query(Shot).filter(Shot.scene_id == scene_id).all():
        v = None if shot_lines(s, lang) else current(db, s.id, "video")
        if v is not None and v.path and not v.stale and not (v.params or {}).get("mock") \
                and not (v.params or {}).get("draft") and st.exists(v.path):
            found.append(v)
    for v in sorted(found, key=lambda t: (-(t.duration_s or 0), t.id)):
        key = f"projects/{project.id}/ambience/take_{v.id}_{int(length)}s.m4a"
        if st.exists(key):
            return key
        try:
            made = _ambience_file(st.abs(v.path), length, tmp / f"amb_{v.id}.m4a")
        except ff.FFmpegError as e:  # an unreadable clip: try the next one
            print(f"[ambience] take {v.id} skipped: {e}")
            continue
        if made:
            return st.save_file(key, made)
    return None


def _ambience_file(video: Path, length: float, out: Path) -> Path | None:
    """The clip's sound, levelled to AMBIENCE_LUFS and `length` long: played forward then backward when the clip is
    shorter (a loop with no seam to click), with a short fade in. None when the clip has no sound worth carrying."""
    if not ff.has_audio(video):
        return None
    wav = out.with_suffix(".src.wav")
    try:
        ff.run(["-i", video, "-vn", "-ac", "2", "-ar", "48000", wav])
        level, d = ff.loudness(wav), ff.duration(wav)
        if level is None or level < AMBIENCE_SILENT_LUFS or d < 0.5:
            return None
        loops = math.ceil(length / (2 * d)) - 1  # finite (cut by -t): an endless source before a trim can stall FFmpeg 7
        head = (f"[0:a]asplit[f][r];[r]areverse[b];[f][b]concat=n=2:v=0:a=1,aloop=loop={loops}:size={int(2 * d * 48000) + 48000},"
                if d < length else "[0:a]")
        fc = head + f"volume={min(AMBIENCE_LUFS - level, 12.0):.2f}dB,afade=t=in:d=0.05[out]"
        ff.run(["-i", wav, "-filter_complex", fc, "-map", "[out]", "-t", f"{length:.3f}", "-c:a", "aac", "-b:a", "160k", out])
        return out
    finally:
        wav.unlink(missing_ok=True)


def render_options(db: Session, episode: Episode, options: dict[str, Any]) -> dict[str, Any]:
    """Caption style, auto-reframe, sound effects and the background under dialogue (ambience) for a render: the
    render's options, then the episode, then the team setting."""
    from .. import settings_store
    team = settings_store.all_settings(db)
    ep = episode.settings or {}  # None = "use the team setting"
    return {"caption_style": options.get("caption_style") or ep.get("caption_style") or team.get("caption_style", "karaoke"),
            "auto_reframe": options.get("auto_reframe", team.get("auto_reframe", True) if ep.get("auto_reframe") is None
                                        else ep.get("auto_reframe")),
            "sfx": options.get("sfx", True if ep.get("sfx") is None else ep.get("sfx")),
            "ambience": options.get("ambience", True if ep.get("ambience") is None else ep.get("ambience"))}


def timeline(segs: list[Segment], effects: bool, use_sfx: bool) -> tuple[list[Timed], list[Cue], list[dict]]:
    """The cut's timing, shared by the server render and the desktop render plan: each segment's speed and length,
    its transition (never longer than half of either clip, so it starts that much earlier) and its start on the
    finished cut; the caption cues and titles moved onto that timeline. Adds each shot's sound effect to its audio
    where it belongs (_sfx_fits)."""
    out: list[Timed] = []
    cues: list[Cue] = []
    overlays: list[dict] = []
    t = 0.0
    for i, sg in enumerate(segs):
        sfx = sg.shot.sfx_track or {}
        if _keeps_sfx(sg, use_sfx) and not any(e[3:4] == (sfx["path"],) for e in sg.extra_audio):
            sg.extra_audio.append((get_storage().abs(sfx["path"]), float(sfx.get("start", 0)), float(sfx.get("volume_db", -8)),
                                   sfx["path"]))
        fx = dict(sg.shot.fx or {}) if effects else {}
        speed = float(fx.get("speed") or 1.0) if sg.source_kind != "still" else 1.0
        seg_len = sg.duration / speed
        # a transition blends this clip over the end of the previous one, so it starts that much earlier
        tr = fxlib.transition_of(fx) if i > 0 else None
        if tr:
            d = max(0.1, min(tr[1], seg_len / 2, out[-1].seg_len / 2))
            tr = (tr[0], d)
            t -= d
        out.append(Timed(sg, fx, speed, seg_len, t, tr))
        cues += [(s / speed + t, e / speed + t, txt) for s, e, txt in sg.cues if e > s]
        for ov in sg.shot.overlays or []:
            if ov.get("text"):
                overlays.append({**ov, "start": t + float(ov.get("start", 0)), "end": t + float(ov.get("end") or seg_len)})
        t += seg_len
    return out, cues, overlays


def music_track(db: Session, episode: Episode) -> AudioAsset | None:
    """The episode's music bed: the picked track, else the newest."""
    return (db.query(AudioAsset).filter(AudioAsset.episode_id == episode.id, AudioAsset.kind == "music")
            .order_by(AudioAsset.selected.desc(), AudioAsset.id.desc()).first())


# ── music per scene ──────────────────────────────────────────────────────────

MUSIC_OVERLAP = 1.5  # a scene's piece runs on this long into the next one, fading out while the next fades in
MUSIC_FADE_IN, MUSIC_FADE_OUT = 1.0, 1.5
MUSIC_LUFS = -14.0  # every piece levelled the same before the bed's own level: a scene change never jumps in loudness


@dataclass
class MusicPiece:
    """One stretch of the music bed: a storage key (a scene's cue, or the score where a scene has none), where it
    starts on the cut, how long it plays, where in its file it starts, and its fades."""
    key: str
    start: float
    length: float
    offset: float = 0.0
    fade_in: float = 0.0
    fade_out: float = 0.0


def scene_cues(db: Session, episode: Episode) -> dict[int, AudioAsset]:
    """Each scene's own piece of music (AudioAsset kind "music_scene"): the picked one, else the newest."""
    st = get_storage()
    out: dict[int, AudioAsset] = {}
    for a in (db.query(AudioAsset).filter(AudioAsset.episode_id == episode.id, AudioAsset.kind == "music_scene")
              .order_by(AudioAsset.selected.desc(), AudioAsset.id.desc()).all()):
        sid = (a.params or {}).get("scene_id")
        if sid is not None and int(sid) not in out and a.path and st.exists(a.path):
            out[int(sid)] = a
    return out


def scene_music_plan(db: Session, episode: Episode, timed: list[Timed], total: float) -> list[MusicPiece]:
    """Music per scene on the cut (episode.settings.music_mode "scenes"): each run of a scene's segments gets its
    scene's piece from where the scene starts, looped or trimmed to the scene plus MUSIC_OVERLAP, faded in and out so
    scenes crossfade; the last one plays on under the end card. A scene with no piece gets the score there (as far in
    as the score would have played), else silence. [] = no scene pieces: the export uses the one score as before."""
    if (episode.settings or {}).get("music_mode") != "scenes":
        return []
    cues = scene_cues(db, episode)
    spans: list[list] = []  # [scene id, start, end] per run of segments of one scene
    for tm in timed:
        sid, end = tm.sg.shot.scene_id, tm.start + tm.seg_len
        if spans and spans[-1][0] == sid:
            spans[-1][2] = end
        else:
            spans.append([sid, tm.start, end])
    if not cues or not any(s[0] in cues for s in spans):
        return []
    spans[-1][2] = max(spans[-1][2], total)
    st = get_storage()
    score = music_track(db, episode)
    score_key = score.path if score and score.path and st.exists(score.path) else ""
    out: list[MusicPiece] = []
    for i, (sid, start, end) in enumerate(spans):
        cue = cues.get(sid)
        key = cue.path if cue else score_key
        if not key:
            continue
        last = i == len(spans) - 1
        length = end - start + (0.0 if last else MUSIC_OVERLAP)
        out.append(MusicPiece(key, round(start, 3), round(length, 3), 0.0 if cue else round(start, 3),
                              round(min(MUSIC_FADE_IN, length / 3), 3), 0.0 if last else round(min(MUSIC_FADE_OUT, length / 3), 3)))
    return out


def scene_music(pieces: list[MusicPiece], total: float, out: Path) -> Path:
    """The pieces mixed into one music track of the cut's length (WAV, or AAC for an .m4a `out`); ff.music_bed then
    sets its level and ducks it under the voices like the one score."""
    st = get_storage()
    gains: dict[str, float] = {}
    args: list = []
    parts: list[str] = []
    for i, pc in enumerate(pieces):
        path = st.abs(pc.key)
        if pc.key not in gains:
            level = ff.loudness(path)
            gains[pc.key] = max(min(MUSIC_LUFS - level, 12.0), -24.0) if level is not None else 0.0
        args += ["-stream_loop", "-1", "-i", path]
        ms = int(pc.start * 1000)
        chain = (f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim={pc.offset:.3f}:{pc.offset + pc.length:.3f},"
                 f"asetpts=PTS-STARTPTS,volume={gains[pc.key]:.2f}dB")
        if pc.fade_in:
            chain += f",afade=t=in:d={pc.fade_in:.3f}"
        if pc.fade_out:
            chain += f",afade=t=out:st={max(pc.length - pc.fade_out, 0):.3f}:d={pc.fade_out:.3f}"
        parts.append(f"{chain},adelay={ms}|{ms}[p{i}]")
    parts.append("".join(f"[p{i}]" for i in range(len(pieces))) + f"amix=inputs={len(pieces)}:normalize=0:duration=longest,"
                 f"apad=whole_dur={total:.3f}[out]")  # padded by whole_dur, cut by -t (an endless apad can stall FFmpeg 7)
    ff.run([*args, "-filter_complex", ";".join(parts), "-map", "[out]", "-t", f"{total:.3f}", "-ar", "48000", "-ac", "2", out])
    return out


def caption_files(cues: list[Cue], overlays: list[dict], burn: bool, caption_style: str, w: int, h: int,
                  tmp: Path) -> tuple[Path | None, Path | None]:
    """(captions.srt when there are cues, captions.ass to burn in when captions are burned or there are titles)."""
    srt = write_srt(cues, tmp / "captions.srt") if cues else None
    ass = None
    if (cues and burn) or overlays:
        ass = write_ass(cues if burn else [], tmp / "captions.ass", w, h, get_settings().caption_font,
                        "shorts" if h >= w else "standard", caption_style=caption_style, overlays=overlays)
    return srt, ass


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


def segment_workers() -> int:
    """How many segment clips are built at once: half the cores (each is an FFmpeg process of its own)."""
    return max(1, (os.cpu_count() or 2) // 2)


def render_segments(items: list, make) -> list[Path]:
    """`make(i, item)` for every item, side by side, results in order. The first failure (in order) raises as it
    would have one at a time, and the clips not started yet are dropped."""
    out: list[Path] = []
    with ThreadPoolExecutor(max_workers=segment_workers(), thread_name_prefix="seg") as ex:
        futures = [ex.submit(make, i, item) for i, item in enumerate(items)]
        try:
            for f in futures:
                out.append(f.result())
        except BaseException:
            ex.shutdown(wait=False, cancel_futures=True)
            raise
    return out


def segment_levels(sg: Segment) -> tuple[float, float, list[tuple]]:
    """(the clip's own sound gain, the replacing audio's gain, the extra audio with its voices levelled): every clip's
    sound brought to ff.CLIP_LUFS and every voice to ff.VOICE_LUFS before they are mixed, so a loud engine never buries
    a quiet voice (the finished mix is then brought to -14 LUFS as a whole). The scene's bed and the sound effects keep
    the levels they were made at."""
    speech = {str(v[0]) for v in sg.voices}
    src = 0.0
    if sg.source_kind != "still" and sg.keep_src_audio and not sg.audio_override:
        src = ff.level_db(sg.source, ff.VOICE_LUFS if str(sg.source) in speech else ff.CLIP_LUFS)
    over = ff.level_db(sg.audio_override, ff.VOICE_LUFS) if sg.audio_override else 0.0
    extra = [(e[0], e[1], round((e[2] if len(e) > 2 else 0.0) + ff.level_db(e[0], ff.VOICE_LUFS), 2), *e[3:])
             if str(e[0]) in speech else e for e in sg.extra_audio]
    return round(sg.src_gain_db + src, 2), over, extra


def voice_track(timed: list[Timed], total: float, out: Path) -> Path | None:
    """The voices alone (dialogue and narration) where they play on the cut: what the music ducks under. Keyed on the
    whole mix it also dipped under every rain bed and sound effect, pumping in and out. None: no voices."""
    parts = []
    for tm in timed:
        for path, offset, at in tm.sg.voices:
            start = offset / tm.speed
            if start < tm.seg_len - 0.05:
                parts.append((path, tm.start + start, at, tm.seg_len - start))
    try:
        return ff.place_audio(parts, total, out) if parts else None
    except (ff.FFmpegError, OSError) as e:  # ducking is a nicety: the mix goes on without it (OSError: a huge command)
        print(f"[music] voice track skipped: {e}")
        return None


def render(db: Session, episode: Episode, lang: str, preset: str, kind: str, options: dict[str, Any],
           out_rel_base: str) -> dict[str, Any]:
    """Render to storage. Returns {path, srt_path, thumbnail_path, duration, warnings, peaks}."""
    st = get_storage()
    project = db.get(Project, episode.project_id)
    w, h = export_dims(project, preset)
    ro = render_options(db, episode, options)
    caption_style, auto_reframe = ro["caption_style"], ro["auto_reframe"]
    tmp = st.tmp_dir()
    try:
        segs, warnings = plan(db, episode, lang, kind, tmp, ro)
        if not segs:
            raise ValueError("This episode has no shots to render")
        luts = project_luts(project)
        effects = options.get("effects", True) is not False  # transitions, looks and moves (off = plain cut)
        timed, cues, overlays = timeline(segs, effects, ro["sfx"])
        for tm in timed:  # FFmpeg draws a gl-transition as a fade and leaves the GPU-only effects out
            warnings += fxlib.fallback_warnings(tm.sg.shot.code, tm.fx, tm.transition is not None)
        lengths = [tm.seg_len for tm in timed]
        transitions: list[tuple[str, float] | None] = [tm.transition for tm in timed]

        def make_segment(i: int, tm) -> Path:  # one clip per segment; every file name carries i, so they run side by side
            out = tmp / f"seg_{i:03}.mp4"
            sg, fx, seg_len = tm.sg, tm.fx, tm.seg_len
            src_gain, over_gain, extra = segment_levels(sg)
            if sg.source_kind == "still":
                audio = sg.audio_override
                if extra or over_gain:
                    audio = _mix_audio(tmp / f"segaud_{i}.wav", sg.audio_override, extra, sg.duration, over_gain)
                ff.still_to_video(sg.source, out, sg.duration, w, h, audio=audio, fx=fx, luts=luts)
            else:
                center = _reframe_center(sg.source, w, h, tmp, i) if auto_reframe else None
                ff.normalize_clip(sg.source, out, w, h, seconds=seg_len, trim_in=sg.trim_in,
                                  audio_override=sg.audio_override, mix_extra=extra,
                                  keep_src_audio=sg.keep_src_audio, src_audio_gain_db=src_gain, center=center,
                                  fx=fx, luts=luts, override_gain_db=over_gain)
            return out

        clips: list[Path] = render_segments(timed, make_segment)
        card = _end_card(project, db, w, h, tmp) if kind == "final" else None
        if card:
            out = tmp / "seg_endcard.mp4"
            ff.still_to_video(card[0], out, card[1], w, h, kenburns=False)
            clips.append(out)
            lengths.append(card[1])
            transitions.append(END_CARD_FADE if any(transitions) else None)
        body = ff.xfade_concat(clips, lengths, transitions, tmp / "body.mp4")
        total = ff.duration(body)

        voice_mix = ff.extract_audio(body, tmp / "voice_mix.wav")
        pics, sounds = layerlib.resolve(episode.layers, lambda rel: st.abs(rel) if rel and st.exists(rel) else None)
        if effects and pics:
            body = layerlib.overlay(body, pics, w, h, tmp / "body_layers.mp4")
        if effects and sounds:
            voice_mix = layerlib.mix(voice_mix, sounds, total, tmp / "voice_layers.wav")
        final_audio = voice_mix
        settings = episode.settings or {}
        bed: Path | None = None
        if options.get("music", True):  # each scene's own piece (music per scene), else the one score
            pieces = scene_music_plan(db, episode, timed, total)
            music = music_track(db, episode)
            if pieces:
                bed = scene_music(pieces, total, tmp / "scene_music.wav")
            elif music and music.path and st.exists(music.path):
                bed = st.abs(music.path)
        if bed:
            duck = bool(settings.get("duck", True))
            final_audio = ff.music_bed(bed, voice_mix, tmp / "mixed.wav", total, volume_db=float(settings.get("music_volume_db", -16)),
                                       duck=duck, sidechain=voice_track(timed, total, tmp / "voices.wav") if duck else None)
        elif options.get("music", True) and kind == "final":
            warnings.append("No music track yet")

        burn = bool(options.get("captions", kind == "final")) and caption_style != "none"
        srt, ass = caption_files(cues, overlays, burn, caption_style, w, h, tmp)
        srt_rel = st.save_file(f"{out_rel_base}.srt", srt) if srt else ""
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


def _mix_audio(out: Path, base: Path | None, extra: list[tuple], seconds: float, base_gain_db: float = 0.0) -> Path:
    args: list = []
    filters, labels = [], []
    idx = 0
    if base:
        args += ["-i", base]
        filters.append(f"[{idx}:a]aresample=48000{f',volume={base_gain_db}dB' if base_gain_db else ''},apad[a{idx}]")
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
    before), small and quick, so the team can check an effect before a full render. Like the export, a gl-transition
    shows as a fade and the GPU-only effects are left out (fx.fallback_warnings says which)."""
    st = get_storage()
    episode = db.get(Episode, shot.episode_id)
    project = db.get(Project, episode.project_id)
    w, h = ff.dims_for(project.aspect, height)
    tmp = out.parent
    segs, _ = plan(db, episode, project.primary_language, "final", tmp, {"ambience": False})  # a preview mixes no extras
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
