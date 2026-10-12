"""Tatvam Editor AI tools (docs/EDITOR.md §8): the parameters and price of every paid tool, the plan a run is submitted
with (jobs.submit, so budgets and approvals apply), speech to text (Gemini listens: Google first), the mock outputs, and
the edit assistant's commands with their strict schemas.

The jobs that run the tools live in workers/handlers_edit.py, the endpoints in api/edits.py. Free tools (silences,
scenes, beats, loudness, local upscale) run on the PC and never reach the server.

Times: every `start` / `end` / `at` a tool takes or returns is in seconds. A tool given a source range (`start`, `end`
in the media's own seconds) works on that part only, and the times it returns count from the range's start.
"""
from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Callable, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError
from sqlalchemy.orm import Session

from .. import catalog, settings_store
from ..models import AIModel, Project, VoiceProfile
from ..pipeline import ffmpeg as ff
from ..providers import mock
from ..providers.base import ProviderNotConfigured, RetryableProviderError, Usage
from ..providers.services import Services, provider_mode
from ..storage import get_storage
from . import model_hub
from .budget import Estimator

EDIT_TYPE = "edit"  # Project.type of an edit's studio project (hidden from the studio's project lists)
LANGS = tuple(catalog.LANGUAGES)
TTS_PROVIDERS = ("gemini", "elevenlabs", "sarvam")
LISTEN_CHUNK_S = 600.0  # Gemini hears up to this much audio per request; longer media is transcribed in pieces
VIDEO_EXT = {"mp4", "mov", "mkv", "webm", "m4v", "avi"}
AUDIO_EXT = {"wav", "mp3", "aac", "m4a", "flac", "ogg"}
IMAGE_EXT = {"png", "jpg", "jpeg", "webp", "gif", "tif", "tiff"}


class ToolError(Exception):
    """A tool can't run with these parameters (the API answers `status`; a job fails with the message)."""

    def __init__(self, msg: str, status: int = 400):
        super().__init__(msg)
        self.status = status


def kind_of_ext(ext: str) -> str | None:
    ext = ext.lower().lstrip(".")
    return "video" if ext in VIDEO_EXT else "audio" if ext in AUDIO_EXT else "image" if ext in IMAGE_EXT else None


def lang_name(code: str) -> str:
    return catalog.LANGUAGES.get(code, {}).get("name", code)


# ── media of the edit ────────────────────────────────────────────────────────

def asset_path(project_id: int, key: str) -> Path:
    """The local file of a studio media key: the edit's own uploads and tool outputs (projects/{pid}/…), or studio
    media an edit imported from an episode ("studio:<key>", another project's folder; the team sees every project).
    Nothing outside the projects' folders."""
    key = (key or "").replace("\\", "/").lstrip("/")
    if not re.match(r"^projects/\d+/", key) or ".." in key.split("/"):
        raise ToolError("That media isn't studio media of this edit")
    st = get_storage()
    if not st.exists(key):
        raise ToolError("That media is no longer on the studio server: upload it again", 404)
    return st.abs(key)


def span(path: Path, start: float | None, end: float | None) -> tuple[float, float]:
    """(start, length) in seconds of the part of `path` a tool works on."""
    d = ff.duration(path)
    s = max(float(start or 0.0), 0.0)
    e = min(float(end), d) if end else d
    if d and s >= d:
        raise ToolError("The range starts after the end of the media")
    if d and e - s < 0.05:
        raise ToolError("The range is empty")
    return s, max(e - s, 0.0)


def _range_args(start: float, length: float, total: float) -> list[str]:
    out: list[str] = []
    if start > 0.001:
        out += ["-ss", f"{start:.3f}"]
    if length and start + length < total - 0.01:
        out += ["-t", f"{length:.3f}"]
    return out


def cut_audio(src: Path, out: Path, start: float | None = None, end: float | None = None, rate: int = 48000) -> Path:
    """The sound of `src` (the range only) as mono WAV."""
    if kind_of_ext(src.suffix) == "image" or not ff.has_audio(src):
        raise ToolError("This media has no sound")
    s, n = span(src, start, end)
    ff.run([*_range_args(s, n, ff.duration(src)), "-i", src, "-vn", "-ac", "1", "-ar", str(rate), out])
    return out


def cut_video(src: Path, out: Path, start: float | None = None, end: float | None = None) -> Path:
    """The range of a video as its own H.264 clip (the whole file, untouched, when there is no range)."""
    if kind_of_ext(src.suffix) != "video":
        raise ToolError("This tool needs a video")
    s, n = span(src, start, end)
    total = ff.duration(src)
    args = _range_args(s, n, total)
    if not args:
        return src
    audio = ["-c:a", "aac", "-b:a", "192k"] if ff.has_audio(src) else ["-an"]
    ff.run([*args, "-i", src, "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", *audio, out])
    return out


def frame_of(src: Path, out: Path, at: float | Literal["last"] | None) -> Path:
    """A still of `src` at `at` seconds ("last" = its last frame). An image is its own frame."""
    k = kind_of_ext(src.suffix)
    if k == "image":
        return src
    if k != "video":
        raise ToolError("A frame needs a video or an image")
    if at == "last" or at is None:
        return ff.extract_frame(src, out, "last")
    return ff.extract_frame(src, out, min(max(float(at), 0.0), max(ff.duration(src) - 0.05, 0.0)))


# ── parameters ───────────────────────────────────────────────────────────────

Seconds = Annotated[float, Field(ge=0, le=36000)]


class _Params(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _Ranged(_Params):
    key: str = Field(min_length=3, max_length=500)
    start: Seconds | None = None
    end: Seconds | None = None


class VoiceRef(_Params):
    """Which voice speaks: a studio voice profile, or a provider's voice id ("" = the team's voice for the language)."""
    provider: str = Field("", max_length=20)
    voice_id: str = Field("", max_length=200)
    profile_id: int | None = None


class TranscribeIn(_Ranged):
    language: str = "auto"
    words: bool = True


class Segment(BaseModel):
    start: Seconds
    end: Seconds
    text: str = Field(max_length=2000)


class TranslateIn(_Params):
    segments: list[Segment] = Field(min_length=1, max_length=3000)
    target: str
    source: str = "auto"


class TtsIn(_Params):
    text: str = Field(min_length=1, max_length=10000)
    language: str = "en"
    voice: VoiceRef = Field(default_factory=VoiceRef)
    style: str = Field("", max_length=300)


class DubIn(_Ranged):
    target: str
    source_lang: str = "auto"
    voice: VoiceRef = Field(default_factory=VoiceRef)
    style: str = Field("", max_length=300)


class CleanVoiceIn(_Ranged):
    pass


class SfxIn(_Params):
    prompt: str = Field(min_length=2, max_length=500)
    seconds: float = Field(4.0, ge=0.5, le=30)


class SfxSuggestIn(_Params):
    key: str = Field(min_length=3, max_length=500)
    at: Seconds | None = None


class MusicIn(_Params):
    prompt: str = Field(min_length=2, max_length=800)
    seconds: float = Field(30.0, ge=5, le=300)


Quality = Literal["saver", "balanced", "hero"]


class VideoIn(_Params):
    prompt: str = Field(min_length=2, max_length=2000)
    seconds: float = Field(6.0, ge=1, le=30)
    aspect: Literal["16:9", "9:16"] = "16:9"
    first_frame_key: str | None = Field(None, max_length=500)
    first_frame_at: Seconds | None = None  # when the first frame comes from a video: which moment
    quality: Quality = "saver"
    route: str | None = Field(None, max_length=200)  # a Model Hub engine id (None = the team's chain, Google first)


class ExtendIn(_Params):
    key: str = Field(min_length=3, max_length=500)
    seconds: float = Field(6.0, ge=1, le=30)
    prompt: str = Field("", max_length=2000)
    at: Seconds | None = None  # the frame it continues from (default: the video's last frame)
    quality: Quality = "saver"
    route: str | None = Field(None, max_length=200)


class EditWordsIn(_Ranged):
    instruction: str = Field(min_length=2, max_length=1000)
    route: str | None = Field(None, max_length=200)


class UpscaleIn(_Ranged):
    target_h: int = Field(2160, ge=360, le=4320)


class DTrack(BaseModel):
    id: str = Field(max_length=80)
    kind: Literal["video", "audio"]
    name: str = Field("", max_length=80)
    locked: bool = False


class DClip(BaseModel):
    id: str = Field(max_length=80)
    track_id: str = Field(max_length=80)
    start: Seconds
    end: Seconds
    name: str = Field("", max_length=200)
    kind: str = Field("media", max_length=20)  # media | title | color | adjustment | nested
    media_kind: str = Field("", max_length=10)  # video | audio | image
    has_audio: bool = False
    text: str = Field("", max_length=500)  # a title's words


class DMarker(BaseModel):
    at: Seconds
    name: str = Field("", max_length=120)


class Digest(BaseModel):
    """What the assistant knows about the sequence (the editor sends it; times in seconds)."""
    name: str = Field("", max_length=200)
    fps: float = Field(25.0, gt=0, le=240)
    width: int = 1920
    height: int = 1080
    duration: Seconds = 0.0
    playhead: Seconds = 0.0
    in_point: Seconds | None = None
    out_point: Seconds | None = None
    tracks: list[DTrack] = Field(default_factory=list, max_length=99)
    clips: list[DClip] = Field(default_factory=list, max_length=3000)
    markers: list[DMarker] = Field(default_factory=list, max_length=1000)
    selection: list[str] = Field(default_factory=list, max_length=3000)
    effects: list[str] = Field(default_factory=list, max_length=500)  # effect ids the editor knows ([] = any)
    transitions: list[str] = Field(default_factory=list, max_length=500)  # transition ids the editor knows ([] = any)


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(max_length=4000)


class AssistantIn(_Params):
    instruction: str = Field(min_length=1, max_length=4000)
    sequence_digest: Digest
    history: list[Turn] = Field(default_factory=list, max_length=20)


def _check_lang(code: str, auto: bool = False) -> None:
    if not (code in LANGS or (auto and code == "auto")):
        raise ToolError(f"Unknown language '{code}' (one of {', '.join(LANGS)}{', auto' if auto else ''})")


# ── voices ───────────────────────────────────────────────────────────────────

def resolve_voice(db: Session, ref: VoiceRef, language: str) -> dict[str, str]:
    """→ {provider, voice_id, style}. Without a pick, the team's voice provider for the language (Google first)."""
    if ref.profile_id:
        vp = db.get(VoiceProfile, ref.profile_id)
        if vp is None or not vp.voice_id:
            raise ToolError("That studio voice is gone")
        return {"provider": vp.provider, "voice_id": vp.voice_id, "style": vp.style_prompt or ""}
    provider = ref.provider or (settings_store.get_setting(db, "tts_provider_by_language") or {}).get(language, "gemini")
    if provider not in TTS_PROVIDERS:
        raise ToolError(f"Unknown voice provider '{provider}'")
    voice = ref.voice_id or {"gemini": "Kore", "sarvam": "anand"}.get(provider, "")
    if not voice:
        raise ToolError("Pick an ElevenLabs voice")
    return {"provider": provider, "voice_id": voice, "style": ""}


def tts_chunks(text: str, limit: int = 1200) -> list[str]:
    """Text in pieces a TTS call takes (Sarvam stops at 2,500 characters), split at sentence ends."""
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= limit:
        return [text] if text else []
    parts, cur = [], ""
    for s in re.split(r"(?<=[.!?।॥])\s+", text):
        while len(s) > limit:
            cut = s.rfind(" ", 0, limit)
            cut = cut if cut > limit // 2 else limit
            if cur:
                parts.append(cur)
                cur = ""
            parts.append(s[:cut].strip())
            s = s[cut:].strip()
        if len(cur) + len(s) + 1 > limit and cur:
            parts.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        parts.append(cur)
    return [p for p in parts if p]


# ── LLM calls (writing on Claude by default; mock when no text provider is live) ─

def _text_is_mock(svc: Services) -> bool:
    return svc.text_route() == "gemini" and provider_mode("gemini") == "mock"


def llm(svc: Services, task: str, system: str, prompt: str, schema: type[BaseModel], mock_data: Callable[[], dict],
        images: list[bytes] | None = None) -> tuple[Any, Usage]:
    if _text_is_mock(svc):
        return schema.model_validate(mock_data()), Usage("gemini", svc.models["text"], f"llm:{task}", 0, "tokens", 0.0,
                                                         mock=True)
    return svc.llm_json(task, system, prompt, schema, images=images)


def text_engine(svc: Services) -> str:
    return {"anthropic": "Claude", "openrouter": "OpenRouter"}.get(svc.text_route(), "Gemini")


# ── speech to text (Gemini listens) ──────────────────────────────────────────

class _TWord(BaseModel):
    start: float = Field(0.0, description="seconds from the start of this audio")
    end: float = Field(0.0, description="seconds from the start of this audio")
    text: str = ""


class _TSeg(BaseModel):
    start: float = Field(0.0, description="seconds from the start of this audio, 2 decimals")
    end: float = Field(0.0, description="seconds from the start of this audio, 2 decimals")
    text: str = Field("", description="the words spoken, in the script of the language spoken")
    words: list[_TWord] = Field(default_factory=list, description="every word with its own start and end")


class TranscriptOut(BaseModel):
    language: str = Field("", description="ISO 639-1 code of the main language spoken: en, hi, kn, te, ta …")
    segments: list[_TSeg] = Field(default_factory=list)


LISTEN_SYSTEM = ("You are a meticulous subtitle transcriber for Indian film and video. You write exactly what is spoken, "
                 "with accurate timings, and nothing that isn't spoken.")


def spread_words(text: str, start: float, end: float) -> list[dict]:
    """Word timings spread over a line by word length (when the listener gave none)."""
    words = text.split()
    if not words:
        return []
    total = sum(len(w) for w in words) or 1
    out, t, length = [], start, max(end - start, 0.05)
    for w in words:
        d = length * len(w) / total
        out.append({"start": round(t, 3), "end": round(t + d, 3), "text": w})
        t += d
    return out


def clean_segments(raw: list[dict], length: float, words: bool, offset: float = 0.0) -> list[dict]:
    """Sorted, inside the audio, non-overlapping caption lines (each at least 0.2 s), words inside their line."""
    segs = []
    for s in raw:
        text = re.sub(r"\s+", " ", str(s.get("text") or "")).strip()
        if not text:
            continue
        a = min(max(float(s.get("start") or 0.0), 0.0), length)
        b = min(max(float(s.get("end") or 0.0), a + 0.2), length if length > a + 0.2 else a + 0.2)
        segs.append({"start": a, "end": b, "text": text, "words": s.get("words") or []})
    segs.sort(key=lambda s: s["start"])
    for i, s in enumerate(segs[:-1]):
        s["end"] = max(min(s["end"], segs[i + 1]["start"]), s["start"] + 0.05)
    out = []
    for s in segs:
        seg: dict[str, Any] = {"start": round(s["start"] + offset, 3), "end": round(s["end"] + offset, 3), "text": s["text"]}
        if words:
            ws = [w for w in s["words"] if str(w.get("text") or "").strip()]
            if ws:
                seg["words"] = [{"start": round(min(max(float(w.get("start") or 0), s["start"]), s["end"]) + offset, 3),
                                 "end": round(min(max(float(w.get("end") or 0), s["start"]), s["end"]) + offset, 3),
                                 "text": str(w["text"]).strip()} for w in ws]
            else:
                seg["words"] = spread_words(s["text"], s["start"] + offset, s["end"] + offset)
        out.append(seg)
    return out


def mock_transcript(seconds: float, language: str, words: bool) -> dict:
    """Deterministic fake captions: the mock sample lines, one every few seconds."""
    lang = language if language in mock.SAMPLE_LINES else "en"
    lines = mock.SAMPLE_LINES[lang]
    raw, t, i = [], 0.3, 0
    while t + 0.8 < seconds and len(raw) < 500:
        text = lines[i % len(lines)]
        d = min(max(1.2, len(text) / 14), 4.0, seconds - t)
        raw.append({"start": t, "end": t + d, "text": text})
        t += d + 0.4
        i += 1
    return {"language": lang, "segments": clean_segments(raw, seconds, words), "mock": True}


def transcribe_audio(svc: Services, audio: Path, language: str, words: bool,
                     on_progress: Callable[[float, str], None] | None = None) -> tuple[dict, list[Usage]]:
    """Speech to text with Gemini audio understanding (the way the studio's listening checks hear clips). Google
    first and strict: no other provider is tried. → ({language, segments}, usages)."""
    seconds = ff.duration(audio)
    model = svc.models["text"]
    mode = provider_mode("gemini")
    if mode == "missing":
        raise ProviderNotConfigured("Captions listen to the sound with Gemini: add the Gemini key in Admin → Settings",
                                    provider="gemini")
    if mode == "mock":
        return mock_transcript(seconds, language, words), [Usage("gemini", model, "llm:transcribe", 0, "tokens", 0.0, mock=True)]
    client = svc.gemini()
    hint = (f" The language spoken is {lang_name(language)}." if language in LANGS else
            " Detect the language spoken (often English, Hindi, Kannada, Telugu or Tamil, or a mix).")
    usages: list[Usage] = []
    segs: list[dict] = []
    langs: list[str] = []
    n = max(int(-(-seconds // LISTEN_CHUNK_S)), 1)
    tmp = get_storage().tmp_dir()
    for k in range(n):
        a = k * LISTEN_CHUNK_S
        length = min(LISTEN_CHUNK_S, seconds - a)
        if length <= 0.2:
            break
        piece = tmp / f"listen_{k}.mp3"
        ff.run(["-ss", f"{a:.3f}", "-t", f"{length:.3f}", "-i", audio, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", piece])
        prompt = (f"Transcribe every word spoken in this {length:.0f}-second audio.{hint} Split it into caption lines of one "
                  "sentence or phrase each (at most about 42 characters and 6 seconds). Give each line its start and end "
                  "in seconds from the start of this audio"
                  + (", and every word its own start and end" if words else "") +
                  ". Write the words in the script of the language spoken (Devanagari for Hindi, Kannada script for "
                  "Kannada …); keep English words in English. Leave out music, noises and silences.")
        input_ = [{"type": "text", "text": prompt},
                  {"type": "audio", "data": base64.b64encode(piece.read_bytes()).decode(), "mime_type": "audio/mpeg"}]
        last: Exception | None = None
        for _ in range(2):
            data, (tin, tout) = client.text_json(model, LISTEN_SYSTEM, input_, TranscriptOut.model_json_schema(), 0.0)
            usages.append(Usage("gemini", model, "llm:transcribe", tin + tout, "tokens", svc.text_cost(model, tin, tout)))
            try:
                obj = TranscriptOut.model_validate(data)
                break
            except ValidationError as e:
                last = e
        else:
            raise RetryableProviderError(f"the transcript did not match its schema: {last}", provider="gemini")
        langs.append(obj.language)
        segs += clean_segments([s.model_dump() for s in obj.segments], length, words, offset=a)
        if on_progress:
            on_progress((k + 1) / n, f"Listening ({k + 1}/{n})")
    detected = next((code for code in langs if code), "") if language == "auto" else language
    return {"language": detected or language, "segments": segs}, usages


# ── translation (writing: Claude by default) ─────────────────────────────────

class _TItem(BaseModel):
    i: int = Field(0, description="the line's number")
    text: str = Field("", description="the translated line")


class TranslateOut(BaseModel):
    items: list[_TItem] = Field(default_factory=list)


TRANSLATE_SYSTEM = ("You translate subtitles and dubbing scripts for Indian film and video. Natural spoken language in the "
                    "target language's own script, the same meaning and tone, close to the original length so each line fits "
                    "the same time on screen. Names stay as they are.")


def mock_translate(texts: list[str], target: str) -> list[str]:
    pool = mock.SAMPLE_LINES.get(target)
    return [pool[i % len(pool)] if pool else f"[{target}] {t}" for i, t in enumerate(texts)]


def translate_lines(svc: Services, segments: list[dict], target: str, source: str = "auto",
                    on_progress: Callable[[float, str], None] | None = None) -> tuple[list[dict], list[Usage]]:
    """Each caption line in the target language, timings kept. A line the writer skipped keeps its original words."""
    usages: list[Usage] = []
    out = [dict(s) for s in segments]
    for s in out:
        s.pop("words", None)  # word timings belong to the original words
    step = 80
    for b in range(0, len(out), step):
        part = out[b:b + step]
        texts = [s["text"] for s in part]
        src = f" from {lang_name(source)}" if source in LANGS else ""
        prompt = (f"Translate these {len(part)} caption lines{src} into {lang_name(target)}. Each line shows how long it "
                  "is on screen. Return every line with its number i.\n\n"
                  + "\n".join(f"{i}: [{max(s['end'] - s['start'], 0):.1f}s] {s['text']}" for i, s in enumerate(part)))
        obj, u = llm(svc, "edit_translate", TRANSLATE_SYSTEM, prompt, TranslateOut,
                     lambda texts=texts: {"items": [{"i": i, "text": t} for i, t in enumerate(mock_translate(texts, target))]})
        usages.append(u)
        got = {it.i: it.text.strip() for it in obj.items if it.text.strip()}
        for i, s in enumerate(part):
            s["text"] = got.get(i, s["text"])
        if on_progress:
            on_progress(min((b + step) / len(out), 1.0), "Translating")
    return out, usages


# ── sound effect ideas from the picture ──────────────────────────────────────

class SfxIdeasOut(BaseModel):
    suggestions: list[str] = Field(default_factory=list, description="3 to 5 short sound effect prompts")


SFX_SYSTEM = ("You are a film sound designer. From a still of a shot, suggest sound effects that would sell it: each a "
              "short, concrete prompt for a sound effect generator (what makes the sound, where, how it sounds).")
MOCK_SFX = ["soft wind through trees, distant birds", "footsteps on a stone floor, close", "a door creaks open slowly",
            "low city traffic hum, far away"]


# ── the edit assistant's commands (times in seconds on the sequence) ─────────

class _Cmd(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CTrimToDuration(_Cmd):
    op: Literal["trim_to_duration"]
    seconds: float = Field(gt=0, le=36000)


class CMarker(_Cmd):
    at: Seconds
    name: str = Field("", max_length=120)
    color: str = Field("#fbbf24", pattern=r"^#[0-9a-fA-F]{6}$")
    comment: str = Field("", max_length=500)


class CAddMarkers(_Cmd):
    op: Literal["add_markers"]
    markers: list[CMarker] = Field(min_length=1, max_length=200)


class CRemoveRange(_Cmd):
    op: Literal["remove_range"]
    start: Seconds
    end: float = Field(gt=0, le=36000)
    ripple: bool = True
    track_ids: list[str] = Field(default_factory=list, max_length=99)  # [] = every unlocked track


class CSplitAt(_Cmd):
    op: Literal["split_at"]
    at: float = Field(gt=0, le=36000)
    track_ids: list[str] = Field(default_factory=list, max_length=99)


class CMoveClip(_Cmd):
    op: Literal["move_clip"]
    clip_id: str = Field(max_length=80)
    to: Seconds
    track_id: str = Field("", max_length=80)  # "" = the same track


class CDeleteClip(_Cmd):
    op: Literal["delete_clip"]
    clip_id: str = Field(max_length=80)
    ripple: bool = False


class CSetSpeed(_Cmd):
    op: Literal["set_speed"]
    clip_id: str = Field(max_length=80)
    speed: float = Field(ge=0.1, le=16)


class CSetVolume(_Cmd):
    op: Literal["set_volume"]
    clip_id: str = Field(max_length=80)
    gain_db: float = Field(ge=-60, le=12)


class CAddTitle(_Cmd):
    op: Literal["add_title"]
    text: str = Field(min_length=1, max_length=300)
    at: Seconds
    duration: float = Field(gt=0, le=600)
    position: Literal["top", "center", "lower_third", "bottom"] = "lower_third"
    size: int = Field(0, ge=0, le=400)  # px at the sequence's size; 0 = the default title size


class CAddTransition(_Cmd):
    op: Literal["add_transition"]
    clip_id: str = Field(max_length=80)
    edge: Literal["in", "out"] = "in"
    type: str = Field("fade", pattern=r"^[a-z0-9_.:\-]{1,60}$")
    duration: float = Field(0.5, gt=0, le=10)


class CSetEffect(_Cmd):
    op: Literal["set_effect"]
    clip_id: str = Field(max_length=80)
    effect: str = Field(pattern=r"^[a-z0-9_.:\-]{1,60}$")
    params: dict[Annotated[str, Field(pattern=r"^[A-Za-z0-9_]{1,40}$")], Union[bool, float, str]] = Field(default_factory=dict)


class CAddMusic(_Cmd):
    op: Literal["add_music"]
    prompt: str = Field(min_length=2, max_length=800)
    start: Seconds
    end: float = Field(gt=0, le=36000)
    volume_db: float = Field(-18.0, ge=-40, le=0)


class CAddCaptions(_Cmd):
    op: Literal["add_captions"]
    clip_ids: list[str] = Field(default_factory=list, max_length=500)  # [] = every clip with sound
    language: str = "auto"
    words: bool = True


Command = Annotated[Union[CTrimToDuration, CAddMarkers, CRemoveRange, CSplitAt, CMoveClip, CDeleteClip, CSetSpeed, CSetVolume,
                          CAddTitle, CAddTransition, CSetEffect, CAddMusic, CAddCaptions], Field(discriminator="op")]
COMMAND = TypeAdapter(Command)
OPS = ("trim_to_duration", "add_markers", "remove_range", "split_at", "move_clip", "delete_clip", "set_speed", "set_volume",
       "add_title", "add_transition", "set_effect", "add_music", "add_captions")
PAID_OPS = {"add_music", "add_captions"}  # these start a paid tool: the editor shows its price before running it
MAX_COMMANDS = 60


def _fmt(s: float) -> str:
    m, r = divmod(max(s, 0.0), 60)
    return f"{int(m)}:{r:04.1f}"


def describe(c: dict, clips: dict[str, DClip]) -> str:
    name = (lambda cid: f"“{(clips[cid].name or cid)[:40]}”" if cid in clips else cid)
    op = c["op"]
    if op == "trim_to_duration":
        return f"Trim the sequence to {_fmt(c['seconds'])}"
    if op == "add_markers":
        n = len(c["markers"])
        return f"Add {n} marker{'s' if n != 1 else ''}"
    if op == "remove_range":
        return f"Remove {_fmt(c['start'])}–{_fmt(c['end'])}{' and close the gap' if c['ripple'] else ''}"
    if op == "split_at":
        return f"Split at {_fmt(c['at'])}"
    if op == "move_clip":
        return f"Move {name(c['clip_id'])} to {_fmt(c['to'])}"
    if op == "delete_clip":
        return f"Delete {name(c['clip_id'])}{' and close the gap' if c['ripple'] else ''}"
    if op == "set_speed":
        return f"Play {name(c['clip_id'])} at {c['speed'] * 100:.0f}%"
    if op == "set_volume":
        return f"Set {name(c['clip_id'])} to {c['gain_db']:+.1f} dB"
    if op == "add_title":
        return f"Title “{c['text'][:40]}” at {_fmt(c['at'])} for {c['duration']:.1f} s"
    if op == "add_transition":
        return f"{c['type']} ({c['duration']:.1f} s) at the {'start' if c['edge'] == 'in' else 'end'} of {name(c['clip_id'])}"
    if op == "set_effect":
        return f"Apply {c['effect']} to {name(c['clip_id'])}"
    if op == "add_music":
        return f"Generate music for {_fmt(c['start'])}–{_fmt(c['end'])}: “{c['prompt'][:40]}” (paid)"
    if op == "add_captions":
        n = len(c["clip_ids"])
        return f"Captions for {f'{n} clip' + ('s' if n != 1 else '') if n else 'every clip with sound'} (paid)"
    return op


def _problem(c: dict, d: Digest) -> str:
    """Why a well-formed command still can't apply to this sequence ("" = it can)."""
    clips = {x.id: x for x in d.clips}
    tracks = {t.id: t for t in d.tracks}
    end = max(d.duration, max((x.end for x in d.clips), default=0.0))
    limit = end + 600
    cid = c.get("clip_id")
    if cid is not None:
        if cid not in clips:
            return f"there is no clip '{cid}'"
        tr = tracks.get(clips[cid].track_id)
        if tr and tr.locked:
            return f"track {tr.name or tr.id} is locked"
    for tid in [*c.get("track_ids", []), *([c["track_id"]] if c.get("track_id") else [])]:
        if tid not in tracks:
            return f"there is no track '{tid}'"
    op = c["op"]
    if op == "trim_to_duration" and c["seconds"] >= end - 1e-3:
        return f"the sequence is already {_fmt(end)} long"
    if op in ("remove_range", "add_music") and c["end"] <= c["start"]:
        return "the end is before the start"
    if op == "remove_range" and c["start"] >= end:
        return "the range starts after the end of the sequence"
    if op == "split_at" and not 0 < c["at"] < end:
        return "that time is outside the sequence"
    if op == "add_markers" and any(m["at"] > limit for m in c["markers"]):
        return "a marker is far past the end of the sequence"
    if op == "move_clip":
        if c["to"] > limit:
            return "that time is far past the end of the sequence"
        if c.get("track_id"):
            src, dst = tracks.get(clips[cid].track_id), tracks[c["track_id"]]
            if src and dst.kind != src.kind:
                return f"a {src.kind} clip can't go on a {dst.kind} track"
            if dst.locked:
                return f"track {dst.name or dst.id} is locked"
    if op == "add_title" and c["at"] > limit:
        return "that time is far past the end of the sequence"
    if op == "add_transition":
        tr = tracks.get(clips[cid].track_id)
        if d.transitions and c["type"] not in d.transitions and not (tr and tr.kind == "audio"):
            return f"the editor has no transition '{c['type']}'"
    if op == "set_effect" and d.effects and c["effect"] not in d.effects:
        return f"the editor has no effect '{c['effect']}'"
    if op == "set_volume":
        x = clips[cid]
        tr = tracks.get(x.track_id)
        if not (x.has_audio or (tr and tr.kind == "audio")):
            return "that clip has no sound"
    if op == "add_music" and c["end"] - c["start"] > 300:
        return "music is at most 5 minutes"
    if op == "add_captions":
        if c["language"] != "auto" and c["language"] not in LANGS:
            return f"unknown language '{c['language']}'"
        for x in c["clip_ids"]:
            if x not in clips:
                return f"there is no clip '{x}'"
    return ""


def validate_commands(raw: list[Any], digest: Digest) -> tuple[list[dict], list[dict]]:
    """Only commands that match their schema exactly and fit this sequence (its clips, tracks and length) come back;
    the rest are listed with the reason. Each kept one gets an id, a summary line and `paid`."""
    clips = {x.id: x for x in digest.clips}
    keep, rejected = [], []
    for item in list(raw or [])[:MAX_COMMANDS * 2]:
        op = item.get("op") if isinstance(item, dict) else None
        if op not in OPS:
            rejected.append({"op": str(op or "?")[:40], "reason": "not an editor command"})
            continue
        try:
            c = COMMAND.validate_python(item).model_dump()
        except ValidationError as e:
            first = e.errors()[0] if e.errors() else {}
            where = ".".join(str(p) for p in first.get("loc", ()) if p != op)
            rejected.append({"op": op, "reason": f"{where}: {first.get('msg', 'invalid')}" if where else "invalid"})
            continue
        why = _problem(c, digest)
        if why:
            rejected.append({"op": op, "reason": why})
            continue
        if len(keep) >= MAX_COMMANDS:
            rejected.append({"op": op, "reason": f"more than {MAX_COMMANDS} commands"})
            continue
        keep.append({**c, "id": f"cmd_{len(keep) + 1}", "summary": describe(c, clips), "paid": op in PAID_OPS})
    return keep, rejected


# What the model fills in (strict-schema friendly: no free-form objects, no nulls). Unused fields keep their defaults
# and are dropped per op by from_flat, so validate_commands sees exactly each command's own fields.
class _MarkerOut(BaseModel):
    at: float = 0.0
    name: str = ""
    color: str = ""
    comment: str = ""


class _ParamOut(BaseModel):
    name: str = ""
    number: float = 0.0
    text: str = Field("", description="set for a text value instead of `number`")


class _CmdOut(BaseModel):
    op: str = Field(description=" | ".join(OPS))
    seconds: float = -1.0
    start: float = -1.0
    end: float = -1.0
    at: float = -1.0
    to: float = -1.0
    duration: float = -1.0
    speed: float = -1.0
    gain_db: float = 0.0
    volume_db: float = -18.0
    clip_id: str = ""
    track_id: str = ""
    track_ids: list[str] = Field(default_factory=list)
    clip_ids: list[str] = Field(default_factory=list)
    text: str = ""
    position: str = "lower_third"
    size: int = 0
    edge: str = "in"
    type: str = ""
    effect: str = ""
    params: list[_ParamOut] = Field(default_factory=list)
    prompt: str = ""
    language: str = "auto"
    words: bool = True
    ripple: bool = True
    markers: list[_MarkerOut] = Field(default_factory=list)


class AssistantOut(BaseModel):
    reply: str = Field("", description="a short answer to the editor, in English")
    commands: list[_CmdOut] = Field(default_factory=list)


OP_FIELDS: dict[str, tuple[str, ...]] = {
    "trim_to_duration": ("seconds",), "add_markers": ("markers",), "remove_range": ("start", "end", "ripple", "track_ids"),
    "split_at": ("at", "track_ids"), "move_clip": ("clip_id", "to", "track_id"), "delete_clip": ("clip_id", "ripple"),
    "set_speed": ("clip_id", "speed"), "set_volume": ("clip_id", "gain_db"),
    "add_title": ("text", "at", "duration", "position", "size"), "add_transition": ("clip_id", "edge", "type", "duration"),
    "set_effect": ("clip_id", "effect", "params"), "add_music": ("prompt", "start", "end", "volume_db"),
    "add_captions": ("clip_ids", "language", "words"),
}


def from_flat(c: dict) -> dict:
    """One command the model filled in (the flat _CmdOut) as that op's own fields."""
    op = c.get("op")
    out: dict[str, Any] = {"op": op}
    for f in OP_FIELDS.get(op, ()):
        v = c.get(f)
        if f == "markers":
            v = [{k: x for k, x in m.items() if not (k in ("color", "comment") and not x)} for m in v or []]
        elif f == "params":
            v = {p["name"]: (p["text"] if p.get("text") else p["number"]) for p in v or [] if p.get("name")}
        elif f in ("type",) and not v:
            continue  # the command's own default (fade)
        out[f] = v
    return out


ASSISTANT_SYSTEM = f"""You are the edit assistant inside Tatvam Editor, a Premiere-style video editor. The editor sends
what is on the timeline (times in seconds) and an instruction. Answer with a short reply and the edit commands that do it.

Commands (op and its fields; times are seconds on the sequence timeline; ids only from the sequence):
- trim_to_duration: seconds — shorten the whole sequence to this length (it cuts the end).
- add_markers: markers [{{at, name, color "#rrggbb", comment}}]
- remove_range: start, end, ripple (close the gap), track_ids ([] = all tracks)
- split_at: at, track_ids ([] = all tracks)
- move_clip: clip_id, to, track_id ("" = same track; video clips only on video tracks, audio on audio)
- delete_clip: clip_id, ripple
- set_speed: clip_id, speed (1 = normal, 0.5 = half speed)
- set_volume: clip_id, gain_db (-60 to +12)
- add_title: text, at, duration, position (top | center | lower_third | bottom), size (0 = default)
- add_transition: clip_id, edge (in = at its start, out = at its end), type (a transition id), duration
- set_effect: clip_id, effect (an effect id), params [{{name, number}} or {{name, text}}]
- add_music: prompt (style, mood, instruments; never a real song), start, end, volume_db (-40 to 0, default -18)
- add_captions: clip_ids ([] = every clip with sound), language (auto or a code), words (word timings)

Rules: use only clip and track ids that are in the sequence. Prefer a few clear commands. add_music and add_captions
start paid AI tools: the editor shows their price before they run, so propose them only when asked for. If the
instruction can't be done with these commands, say so in the reply and return no commands. Never invent footage."""


def assistant_prompt(body: AssistantIn) -> str:
    d = body.sequence_digest.model_dump()
    d["clips"] = d["clips"][:600]
    hist = "\n".join(f"{t.role}: {t.text}" for t in body.history[-10:])
    return ((f"Conversation so far:\n{hist}\n\n" if hist else "")
            + "Sequence:\n" + json.dumps(d, ensure_ascii=False, separators=(",", ":"))
            + f"\n\nInstruction: {body.instruction}")


def mock_assistant(instruction: str, d: Digest) -> dict:
    """A deterministic stand-in for the model (MOCK mode): a few commands picked from words in the instruction."""
    low = instruction.lower()
    end = max(d.duration, max((x.end for x in d.clips), default=0.0))
    cmds: list[dict] = []
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:s\b|sec|second)", low)
    if m and any(w in low for w in ("cut", "trim", "shorten", "make it")):
        cmds.append({"op": "trim_to_duration", "seconds": float(m.group(1))})
    if "marker" in low:
        cmds.append({"op": "add_markers", "markers": [{"at": x.start, "name": x.name or f"Clip {i + 1}"}
                                                      for i, x in enumerate(d.clips[:10])] or [{"at": d.playhead, "name": "Note"}]})
    if "title" in low:
        q = re.search(r"[\"“']([^\"”']{1,80})[\"”']", instruction)
        cmds.append({"op": "add_title", "text": q.group(1) if q else "Title", "at": 0.0, "duration": min(4.0, max(end, 1.0)),
                     "position": "center"})
    if any(w in low for w in ("transition", "fade", "dissolve")):
        vids = [x for x in d.clips if any(t.id == x.track_id and t.kind == "video" for t in d.tracks)]
        if len(vids) > 1:
            cmds.append({"op": "add_transition", "clip_id": vids[1].id, "edge": "in", "type": "fade", "duration": 0.5})
    if "music" in low:
        cmds.append({"op": "add_music", "prompt": "Warm cinematic background score, soft strings and tabla", "start": 0.0,
                     "end": max(end, 5.0), "volume_db": -18.0})
    if "caption" in low or "subtitle" in low:
        cmds.append({"op": "add_captions", "clip_ids": [], "language": "auto", "words": True})
    reply = ("MOCK assistant: " + (f"{len(cmds)} change{'s' if len(cmds) != 1 else ''} to review." if cmds else
                                   "I couldn't map that onto editor commands."))
    return {"reply": reply, "commands": cmds}


# ── the tools: label, job type, price ────────────────────────────────────────

@dataclass
class Tool:
    id: str
    label: str
    job: str  # job type (workers/handlers_edit.py)
    params: type[BaseModel]
    group: str  # captions | voice | sound | picture | assistant


def _ln(label: str, usd: float) -> dict:
    return {"label": label, "usd": round(usd, 4)}


def engine_choice(db: Session, chain: str, modes: list[str], route: str | None) -> tuple[AIModel, str]:
    """The engine a video tool runs on: the team's chain (Google first), or a route picked from the Model Hub's enabled
    engines that can do this."""
    task = "edit" if chain == "edit" else "video"
    if route:
        m = db.get(AIModel, route)
        caps = (m.capabilities or {}) if m else {}
        if (m is None or m.status != "enabled" or m.task != task or caps.get("usable") is False
                or provider_mode(m.provider) == "missing" or not set(modes) & set(caps.get("modes") or [])):
            raise ToolError(f"'{route}' isn't an engine the Model Hub allows for this")
    choice = model_hub.first_choice(db, chain, modes, route or None)
    if choice is None:
        raise ToolError(f"No enabled engine can do '{model_hub.CHAIN_LABELS.get(chain, chain)}'. Enable one in Model Hub → "
                        "Engines.")
    return choice


def video_seconds(m: AIModel, seconds: float, resolution: str) -> float:
    secs = model_hub.clamp_duration(m, seconds)
    if m.builtin and m.provider == "google" and resolution != "720p":
        secs = 8.0  # Veo makes 1080p and 4K clips 8 s long
    return secs


def price(db: Session, project: Project, tool: str, p: Any) -> tuple[list[dict], dict]:
    """→ (cost lines, extras for the panel: engine, seconds made …)."""
    est = Estimator(db)
    svc = Services()
    pid = project.id
    extra: dict[str, Any] = {}
    if tool == "transcribe":
        _check_lang(p.language, auto=True)
        _, secs = span(asset_path(pid, p.key), p.start, p.end)
        extra["engine"] = "Gemini"
        return [_ln(f"Listening · {secs:.0f} s of sound (Gemini)", est.listen(secs, p.words))], extra
    if tool == "translate":
        _check_lang(p.target)
        chars = sum(len(s.text) for s in p.segments)
        extra["engine"] = text_engine(svc)
        return [_ln(f"Translation into {lang_name(p.target)} · {len(p.segments)} lines ({extra['engine']})",
                    est.text(chars + 400, int(chars * 1.4), calls=-(-len(p.segments) // 80)))], extra
    if tool == "tts":
        _check_lang(p.language)
        v = resolve_voice(db, p.voice, p.language)
        extra.update(engine=v["provider"], voice=v["voice_id"])
        return [_ln(f"Voice · {len(p.text)} characters ({v['provider']})", est.tts_chars(v["provider"], len(p.text)))], extra
    if tool == "dub":
        _check_lang(p.target)
        _check_lang(p.source_lang, auto=True)
        _, secs = span(asset_path(pid, p.key), p.start, p.end)
        v = resolve_voice(db, p.voice, p.target)
        chars = int(secs * 14)  # about 14 characters of speech a second
        extra.update(engine=f"Gemini → {text_engine(svc)} → {v['provider']}", voice=v["voice_id"])
        return [_ln(f"Listening · {secs:.0f} s (Gemini)", est.listen(secs, False)),
                _ln(f"Translation into {lang_name(p.target)} ({text_engine(svc)})", est.text(chars + 400, int(chars * 1.4))),
                _ln(f"Voice · ~{chars} characters ({v['provider']})", est.tts_chars(v["provider"], chars))], extra
    if tool == "clean_voice":
        src = asset_path(pid, p.key)
        if not ff.has_audio(src):
            raise ToolError("This media has no sound")
        _, secs = span(src, p.start, p.end)
        extra["engine"] = "ElevenLabs"
        return [_ln(f"Voice isolation · {secs:.0f} s (ElevenLabs)", est.isolation(secs))], extra
    if tool == "sfx":
        extra["engine"] = "ElevenLabs"
        return [_ln(f"Sound effect · {p.seconds:.1f} s (ElevenLabs)", est.sfx(p.seconds))], extra
    if tool == "sfx_suggest":
        asset_path(pid, p.key)
        extra["engine"] = text_engine(svc)
        return [_ln(f"Ideas from the picture ({extra['engine']})", est.text(1500, 600))], extra
    if tool == "music":
        extra["engine"] = "Lyria"
        return [_ln(f"Music · {p.seconds:.0f} s (Lyria)", est.music(p.seconds))], extra
    if tool in ("video", "extend"):
        if tool == "video" and p.first_frame_key:
            if kind_of_ext(asset_path(pid, p.first_frame_key).suffix) not in ("video", "image"):
                raise ToolError("The first frame comes from a video or an image")
        if tool == "extend":
            src = asset_path(pid, p.key)
            if kind_of_ext(src.suffix) != "video":
                raise ToolError("Only a video can be extended")
        first = tool == "extend" or bool(p.first_frame_key)
        m, mode = engine_choice(db, f"video.{p.quality}", ["i2v"] if first else ["t2v"], p.route)
        res = catalog.QUALITY_MODES[p.quality]["resolution"]
        secs = video_seconds(m, p.seconds, res)
        extra.update(engine=m.display_name, engine_id=m.id, mode=mode, seconds=secs, resolution=res)
        what = "Extension" if tool == "extend" else "B-roll"
        return [_ln(f"{what} · {secs:.0f} s at {res} ({m.display_name})", model_hub.price_for(m, seconds=secs, resolution=res))], extra
    if tool == "edit_words":
        src = asset_path(pid, p.key)
        if kind_of_ext(src.suffix) != "video":
            raise ToolError("Edit with words needs a video")
        _, secs = span(src, p.start, p.end)
        m, _ = engine_choice(db, "edit", ["edit"], p.route)
        secs = model_hub.clamp_duration(m, secs)
        extra.update(engine=m.display_name, engine_id=m.id, seconds=secs)
        return [_ln(f"Edit with words · {secs:.0f} s ({m.display_name})", model_hub.price_for(m, seconds=secs))], extra
    if tool == "upscale":
        src = asset_path(pid, p.key)
        if kind_of_ext(src.suffix) != "video":
            raise ToolError("AI upscale needs a video")
        _, secs = span(src, p.start, p.end)
        w, h, factor = upscale_size(src, p.target_h)
        extra.update(engine="Topaz (fal)", to=[w, h], factor=factor, seconds=secs)
        return [_ln(f"AI upscale · {secs:.0f} s → {w}×{h} (Topaz)", est.upscale(secs))], extra
    if tool == "assistant":
        chars = len(assistant_prompt(p)) + len(ASSISTANT_SYSTEM)
        extra["engine"] = text_engine(svc)
        return [_ln(f"Edit assistant ({extra['engine']})", est.text(chars, 3000))], extra
    raise ToolError(f"Unknown tool '{tool}'")


def _even(x: float) -> int:
    return max(int(round(x / 2)) * 2, 2)


MAX_UPSCALE = 4.0


def upscale_size(src: Path, target_h: int) -> tuple[int, int, float]:
    """The size an upscale makes: the short side reaches target_h (at most 4×)."""
    sw, sh = ff.video_size(src)
    if not sw or not sh:
        raise ToolError("Couldn't read the video's size")
    factor = min(target_h / min(sw, sh), MAX_UPSCALE)
    if factor <= 1.05:
        raise ToolError(f"The video is already {sw}×{sh}")
    return _even(sw * factor), _even(sh * factor), round(factor, 3)


TOOLS: dict[str, Tool] = {t.id: t for t in (
    Tool("transcribe", "Captions", "edit_transcribe", TranscribeIn, "captions"),
    Tool("translate", "Translate captions", "edit_translate", TranslateIn, "captions"),
    Tool("tts", "AI voice-over", "edit_tts", TtsIn, "voice"),
    Tool("dub", "Dub", "edit_dub", DubIn, "voice"),
    Tool("clean_voice", "Clean up voice", "edit_clean_voice", CleanVoiceIn, "voice"),
    Tool("sfx", "Sound effect", "edit_sfx", SfxIn, "sound"),
    Tool("sfx_suggest", "Sound ideas from the picture", "edit_sfx_suggest", SfxSuggestIn, "sound"),
    Tool("music", "Music", "edit_music", MusicIn, "sound"),
    Tool("video", "Generate B-roll", "edit_video", VideoIn, "picture"),
    Tool("extend", "Extend clip", "edit_extend", ExtendIn, "picture"),
    Tool("edit_words", "Edit with words", "edit_words", EditWordsIn, "picture"),
    Tool("upscale", "AI upscale", "edit_upscale", UpscaleIn, "picture"),
    Tool("assistant", "Edit assistant", "edit_assistant", AssistantIn, "assistant"),
)}


def parse(tool: str, params: dict | None) -> tuple[Tool, BaseModel]:
    t = TOOLS.get(tool)
    if t is None:
        raise ToolError(f"Unknown tool '{tool}' (one of {', '.join(TOOLS)})")
    try:
        return t, t.params.model_validate(params or {})
    except ValidationError as e:
        first = e.errors()[0] if e.errors() else {}
        where = ".".join(str(x) for x in first.get("loc", ()))
        raise ToolError(f"{t.label}: {where + ': ' if where else ''}{first.get('msg', 'invalid parameters')}") from e


def plan(db: Session, project: Project, tool: str, params: dict | None, what: str = "") -> dict[str, Any]:
    """What a run costs and the job it is submitted as (`what` names the clip in the job's label). Raises ToolError
    when it can't run."""
    t, p = parse(tool, params)
    items, extra = price(db, project, t.id, p)
    total = round(sum(i["usd"] for i in items), 4)
    label = t.label + (f": {what.strip()[:80]}" if what.strip() else "") + (f" · {extra['engine']}" if extra.get("engine") else "")
    return {"tool": t.id, "label": label[:200], "job": t.job, "params": p.model_dump(mode="json"), "items": items,
            "total_usd": total, **extra}


def tools_status(db: Session) -> list[dict[str, Any]]:
    """Each tool and whether its provider is ready (live, mock or missing a key), for the AI panel."""
    svc = Services()
    route = svc.text_route()
    rows = []
    for t in TOOLS.values():
        if t.id == "transcribe":
            prov = "gemini"
        elif t.id in ("translate", "assistant", "sfx_suggest"):
            prov = route
        elif t.id in ("clean_voice", "sfx"):
            prov = "elevenlabs"
        elif t.id == "music":
            prov = "gemini"
        elif t.id == "upscale":
            prov = "fal"
        elif t.id in ("tts", "dub"):
            prov = (settings_store.get_setting(db, "tts_provider_by_language") or {}).get("en", "gemini")
        else:
            chain, modes = ("edit", ["edit"]) if t.id == "edit_words" else ("video.saver", ["t2v", "i2v"])
            c = model_hub.first_choice(db, chain, modes)
            prov = c[0].provider if c else ""
        mode = provider_mode(prov) if prov else "missing"
        rows.append({"id": t.id, "label": t.label, "group": t.group, "provider": {"google": "gemini"}.get(prov, prov),
                     "mode": mode, "ready": mode != "missing"})
    return rows
