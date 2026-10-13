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

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, model_validator
from sqlalchemy.orm import Session

from .. import catalog, settings_store
from ..db import utcnow
from ..models import AIModel, Consent, Project, VoiceProfile
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
    """Music to a length. `mood` is any mood name (the editor's moods: known ones become musical words, others are used
    as they are); `bpm` asks for a tempo."""
    prompt: str = Field("", max_length=800)
    seconds: float = Field(30.0, ge=5, le=300)
    mood: str = Field("", max_length=60)
    bpm: int | None = Field(None, ge=40, le=220)

    @model_validator(mode="after")
    def _something(self):
        if len(self.prompt.strip()) < 2 and not self.mood.strip():
            raise ValueError("describe the music or pick a mood")
        return self


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


# wave 3 (docs/EDITOR.md §10): ideas from the transcript, highlights, thumbnails, voice cloning, moods

class BrollSuggestIn(_Params):
    segments: list[Segment] = Field(min_length=1, max_length=3000)  # the transcript (or captions), seconds
    style: str = Field("", max_length=300)
    count: int = Field(6, ge=1, le=12)


Platform = Literal["shorts", "reels", "tiktok", "any"]


class HighlightsIn(_Params):
    segments: list[Segment] = Field(min_length=1, max_length=3000)
    target_seconds: float = Field(30.0, ge=15, le=90)
    count: int = Field(3, ge=1, le=5)
    platform: Platform = "shorts"


class ThumbnailIn(_Params):
    """A frame of a video (`key` + `at`) or a still (`frame_key`, or `key` of an image) → `count` thumbnails in each
    aspect asked for."""
    key: str | None = Field(None, min_length=3, max_length=500)
    at: Seconds | None = None
    frame_key: str | None = Field(None, min_length=3, max_length=500)
    title: str = Field("", max_length=120)
    style: str = Field("", max_length=300)
    count: int = Field(2, ge=1, le=4)
    aspects: list[Literal["16:9", "9:16"]] = Field(default_factory=lambda: ["16:9"], min_length=1, max_length=2)
    route: str | None = Field(None, max_length=200)  # a Model Hub image engine (None = the team's chain, Google first)

    @model_validator(mode="after")
    def _source(self):
        if bool(self.key) == bool(self.frame_key):
            raise ValueError("give the frame: key (+ at) or frame_key")
        self.aspects = list(dict.fromkeys(self.aspects))
        return self


class VoiceCloneIn(_Params):
    sample_key: str = Field(min_length=3, max_length=500)  # speech of the voice (audio, or a video with sound)
    start: Seconds | None = None
    end: Seconds | None = None
    name: str = Field(min_length=1, max_length=80)
    consent_id: int = Field(ge=1)  # the speaker's signed consent record (kind voice_replication)
    languages: list[str] = Field(default_factory=list, max_length=20)  # [] = every studio language
    remove_noise: bool = True


class MoodScene(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    title: str = Field("", max_length=200)
    emotion: str = Field("", max_length=200)
    summary: str = Field("", max_length=2000)


class MoodOption(BaseModel):
    """One of the editor's moods: its id, its name and the words in a scene's emotion that point to it."""
    id: str = Field(min_length=1, max_length=60)
    label: str = Field("", max_length=80)
    words: list[Annotated[str, Field(max_length=40)]] = Field(default_factory=list, max_length=40)


class MoodSuggestIn(_Params):
    scenes: list[MoodScene] = Field(min_length=1, max_length=200)
    # the moods to pick from: names, or the editor's moods with their emotion words ([] = MOODS)
    moods: list[Union[MoodOption, Annotated[str, Field(min_length=1, max_length=60)]]] = Field(default_factory=list, max_length=100)


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


# ── moods (music words, and a mood for a scene from its emotion) ─────────────

# Known mood names (the editor's Moods share these names; any other name still works): the words a music prompt
# gets, and the words in a scene's emotion, title or summary that point to the mood.
MOODS: dict[str, tuple[str, tuple[str, ...]]] = {
    "warm": ("warm, intimate, gentle acoustic", ("warm", "tender", "family", "home", "love", "gentle", "kind")),
    "romantic": ("romantic, tender strings, soft piano", ("romance", "romantic", "kiss", "longing", "wedding", "couple", "date")),
    "joyful": ("joyful, bright, uplifting, light percussion", ("joy", "happy", "fun", "laugh", "celebrat", "delight", "cheer")),
    "festive": ("festive, celebratory, dhol and brass", ("festival", "festive", "party", "dance", "diwali", "holi", "wedding")),
    "playful": ("playful, quirky, pizzicato", ("playful", "comic", "comedy", "silly", "prank", "mischief", "cute")),
    "hopeful": ("hopeful, rising, warm strings", ("hope", "hopeful", "dream", "begin", "new start", "promise", "inspire")),
    "calm": ("calm, peaceful, ambient pads", ("calm", "peace", "quiet", "serene", "still", "rest", "meditat", "morning")),
    "dreamy": ("dreamy, airy, soft synth pads", ("dream", "dreamy", "memory", "fantasy", "magic", "wonder", "float")),
    "nostalgic": ("nostalgic, vintage, warm tape tone", ("nostalg", "childhood", "remember", "past", "old days", "flashback", "vintage")),
    "melancholy": ("melancholic, slow, solo piano", ("sad", "grief", "loss", "lonely", "melanchol", "regret", "tears", "funeral", "goodbye")),
    "tense": ("tense, pulsing, low strings", ("tense", "tension", "anxious", "nervous", "argument", "conflict", "pressure", "angry", "anger")),
    "suspense": ("suspenseful, sparse, ticking, low drones", ("suspense", "secret", "hidden", "sneak", "investigat", "clue", "waiting")),
    "mysterious": ("mysterious, eerie, sparse", ("mystery", "mysterious", "strange", "unknown", "night", "shadow", "puzzle")),
    "horror": ("dark, unsettling, dissonant", ("horror", "fear", "scared", "terror", "ghost", "haunt", "scream", "blood")),
    "action": ("driving, energetic, big drums", ("action", "fight", "chase", "race", "battle", "escape", "run", "attack")),
    "epic": ("epic, orchestral, heroic brass", ("epic", "hero", "victory", "triumph", "war", "legend", "glory", "climax")),
    "energetic": ("energetic, upbeat, electronic", ("energy", "energetic", "upbeat", "sport", "workout", "hype", "fast")),
    "dramatic": ("dramatic, cinematic, swelling strings", ("drama", "dramatic", "confront", "reveal", "betray", "shock", "decision")),
    "devotional": ("devotional, serene, bansuri and tanpura", ("devotion", "prayer", "temple", "god", "spiritual", "faith", "ritual")),
    "noir": ("noir, smoky, muted jazz trumpet", ("noir", "crime", "detective", "smoke", "rain", "city night")),
    "gritty": ("gritty, raw, distorted bass", ("gritty", "street", "struggle", "poverty", "rough", "violence", "dirt")),
    # the editor's own mood names (frontend/src/lib/moods.ts) where they differ from the ones above
    "thriller": ("tense, pulsing synth bass, ticking percussion", ("thrill", "danger", "chase", "threat", "paranoid", "suspense")),
    "festival": ("festive dhol and shehnai, celebratory", ("festival", "festive", "celebrat", "diwali", "holi", "utsav")),
    "monsoon": ("rain ambience, soft sitar and bansuri", ("rain", "monsoon", "storm", "baarish", "grey")),
    "comedy": ("quirky, playful pizzicato and ukulele", ("funny", "comedy", "comic", "humour", "humor", "silly", "hilarious")),
    "documentary": ("understated piano and strings, thoughtful", ("documentary", "informative", "explain", "interview", "reflective")),
    "summer": ("sunny upbeat indie pop, acoustic guitar", ("summer", "sunny", "beach", "holiday", "carefree")),
    "cyberpunk": ("dark synthwave, pulsing arpeggios", ("futuristic", "neon", "cyber", "dystopia", "hacker", "robot")),
    "mystery": ("mysterious celesta and low pizzicato, hushed", ("mystery", "mysterious", "secret", "riddle", "unknown", "curious")),
    "inspiring": ("uplifting piano build with strings and drums", ("inspire", "inspiring", "hope", "determined", "motivation")),
    "cinematic": ("cinematic, emotive, orchestral", ()),
}
NEUTRAL_MOODS = ("cinematic", "documentary", "calm", "warm")  # for a scene whose words point to no mood


def mood_key(name: str) -> str:
    return re.sub(r"[\s\-]+", "_", (name or "").strip().lower())[:60]


def mood_words(name: str) -> str:
    """The musical words for a mood ("" for none): a known mood's words, else the name as it is."""
    k = mood_key(name)
    if not k:
        return ""
    return MOODS[k][0] if k in MOODS else f"{name.strip()} mood"


def music_prompt(p: MusicIn) -> str:
    """The prompt the music engine gets: the words, the mood's musical words and the tempo."""
    parts = [p.prompt.strip().rstrip(".")] if p.prompt.strip() else []
    if p.mood.strip():
        parts.append(f"Mood: {mood_words(p.mood)}")
    if p.bpm:
        parts.append(f"Tempo about {p.bpm} BPM")
    if not re.search(r"\bvocal|\bsing|\blyric", p.prompt, re.I):
        parts.append("Instrumental, no vocals")
    return ". ".join(parts)[:1000]


def pick_mood(scene: MoodScene, allowed: list[str], words_of: dict[str, list[str]] | None = None) -> tuple[str, str]:
    """A mood for a scene from the words of its emotion (counted 3×), title and summary → (mood, why). A mood's words:
    those the editor sent with it, else this table's, plus its own name."""
    emo, rest = scene.emotion.lower(), f"{scene.title} {scene.summary}".lower()
    best, score, hit = "", 0.0, ""
    for m in allowed:
        k = mood_key(m)
        given = tuple(w.strip().lower() for w in (words_of or {}).get(k, []) if len(w.strip()) > 1)
        words = (given or (MOODS[k][1] if k in MOODS else ())) + tuple(w for w in k.split("_") if len(w) > 2)
        s, first = 0.0, ""
        for w in words:
            n = 3 * emo.count(w) + rest.count(w)
            if n and not first:
                first = w
            s += n
        if s > score:
            best, score, hit = m, s, first
    if not best:  # nothing points anywhere: the most neutral mood there is
        fallback = next((m for k in NEUTRAL_MOODS for m in allowed if mood_key(m) == k), allowed[0])
        return fallback, f"No strong emotion in the scene: {fallback} as a neutral look"
    src = f"its emotion “{scene.emotion.strip()}”" if hit and hit in emo else f"“{hit}” in the scene"
    return best, f"Matches {src}"[:300]


def allowed_moods(p: MoodSuggestIn) -> list[str]:
    """The mood ids to pick from (each once)."""
    seen: dict[str, str] = {}
    for m in p.moods or list(MOODS):
        name = (m.id if isinstance(m, MoodOption) else m).strip()
        if mood_key(name) and mood_key(name) not in seen:
            seen[mood_key(name)] = name
    return list(seen.values()) or list(MOODS)


def mood_words_of(p: MoodSuggestIn) -> dict[str, list[str]]:
    """The emotion words the editor sent per mood (by mood_key)."""
    return {mood_key(m.id): list(m.words) for m in p.moods if isinstance(m, MoodOption) and m.words}


def mood_labels(p: MoodSuggestIn) -> dict[str, str]:
    return {mood_key(m.id): m.label for m in p.moods if isinstance(m, MoodOption) and m.label}


class _MoodPick(BaseModel):
    scene_id: str = ""
    mood: str = Field("", description="one of the mood names given")
    why: str = Field("", description="one short sentence")


class MoodOut(BaseModel):
    picks: list[_MoodPick] = Field(default_factory=list)


MOOD_SYSTEM = ("You are a film colourist and music supervisor. For each scene you pick the one mood (a colour look and "
               "a music feel) that serves its emotion best, from the list you are given.")


def mood_prompt(p: MoodSuggestIn, allowed: list[str]) -> str:
    labels, words = mood_labels(p), mood_words_of(p)
    opts = "\n".join(f"- {m}" + (f" ({labels[mood_key(m)]})" if mood_key(m) in labels else "")
                     + (f": {', '.join(words[mood_key(m)][:12])}" if mood_key(m) in words else "") for m in allowed)
    rows = "\n".join(f"- id {s.id}: {s.title or 'untitled'}" + (f" · emotion: {s.emotion}" if s.emotion else "")
                     + (f" · {s.summary[:400]}" if s.summary else "") for s in p.scenes)
    return f"Moods to pick from (answer with the id):\n{opts}\n\nScenes:\n{rows}\n\nGive every scene id its mood and why."


def mock_moods(p: MoodSuggestIn, allowed: list[str]) -> dict:
    """The deterministic mapping (used when the text route is mock): each scene's words → a mood."""
    picks, words = [], mood_words_of(p)
    for s in p.scenes:
        m, why = pick_mood(s, allowed, words)
        picks.append({"scene_id": s.id, "mood": m, "why": why})
    return {"picks": picks}


def finish_moods(picks: list[dict], p: MoodSuggestIn, allowed: list[str]) -> list[dict]:
    """One pick per scene, in scene order, each a mood from `allowed` (a missing or unknown pick is made from the
    scene's words)."""
    by_key = {mood_key(m): m for m in allowed}
    labels = mood_labels(p)
    by_key.update({mood_key(labels[mood_key(m)]): m for m in allowed if mood_key(m) in labels})  # a label for its id
    got = {str(x.get("scene_id")): x for x in picks}
    words = mood_words_of(p)
    out = []
    for s in p.scenes:
        x = got.get(s.id) or {}
        mood = by_key.get(mood_key(str(x.get("mood") or "")))
        if mood:
            out.append({"scene_id": s.id, "mood": mood, "why": str(x.get("why") or "").strip()[:300]})
        else:
            m, why = pick_mood(s, allowed, words)
            out.append({"scene_id": s.id, "mood": m, "why": why})
    return out


# ── the transcript: B-roll ideas and highlights ──────────────────────────────

def transcript_text(segments: list[Segment], limit: int = 60000) -> str:
    out, n = [], 0
    for s in segments:
        line = f"[{s.start:.1f}–{s.end:.1f}] " + re.sub(r"\s+", " ", s.text).strip()
        n += len(line) + 1
        if n > limit:
            break
        out.append(line)
    return "\n".join(out)


def transcript_span(segments: list[Segment]) -> tuple[float, float]:
    return min(s.start for s in segments), max(s.end for s in segments)


class _BrollIdea(BaseModel):
    start: float = Field(0.0, description="seconds, where the B-roll starts (inside the transcript)")
    end: float = Field(0.0, description="seconds, where it ends (2 to 10 seconds later)")
    prompt: str = Field("", description="a concrete shot for a video generator: subject, place, light, camera")
    reason: str = Field("", description="which words it illustrates and why, one sentence")


class BrollOut(BaseModel):
    ideas: list[_BrollIdea] = Field(default_factory=list)


BROLL_SYSTEM = ("You are a documentary and YouTube editor. You read a transcript with timings and suggest B-roll: "
                "cutaway shots that illustrate what is being said at that moment. Each idea is one concrete, filmable shot "
                "a video generator can make (no text on screen, no real brands or real people's faces).")


def broll_prompt(p: BrollSuggestIn) -> str:
    return (f"Suggest {p.count} B-roll shots for this transcript (times in seconds)."
            + (f" Visual style: {p.style}." if p.style.strip() else "")
            + " Spread them over the moments where a picture helps most.\n\n" + transcript_text(p.segments))


def _words(text: str, n: int) -> str:
    w = re.sub(r"\s+", " ", text).strip().split(" ")
    return " ".join(w[:n]) + ("…" if len(w) > n else "")


def mock_broll(p: BrollSuggestIn) -> dict:
    """Deterministic ideas (MOCK mode): lines spread over the transcript, each illustrated as it is."""
    segs = sorted(p.segments, key=lambda s: s.start)
    step = max(len(segs) / p.count, 1.0)
    picks = list(dict.fromkeys(min(int(i * step), len(segs) - 1) for i in range(min(p.count, len(segs)))))
    style = f", {p.style.strip()}" if p.style.strip() else ""
    ideas = []
    for i in picks:
        s = segs[i]
        ideas.append({"start": s.start, "end": max(min(s.end, s.start + 6), s.start + 2),
                      "prompt": f"Cinematic cutaway illustrating “{_words(s.text, 12)}”, natural light, slow push in{style}",
                      "reason": f"MOCK: illustrates the line at {s.start:.1f} s"})
    return {"ideas": ideas}


def finish_broll(ideas: list[dict], p: BrollSuggestIn) -> list[dict]:
    """Ideas inside the transcript, 1–30 s long, in time order, at most `count`, no two starting together."""
    a, b = transcript_span(p.segments)
    out: list[dict] = []
    for x in sorted(ideas, key=lambda i: float(i.get("start") or 0)):
        prompt = re.sub(r"\s+", " ", str(x.get("prompt") or "")).strip()[:1000]
        if len(prompt) < 3:
            continue
        s = min(max(float(x.get("start") or 0), a), b)
        e = min(max(float(x.get("end") or 0), s + 1.0), s + 30.0)
        if out and s - out[-1]["start"] < 0.5:
            continue
        out.append({"start": round(s, 3), "end": round(e, 3), "prompt": prompt,
                    "reason": re.sub(r"\s+", " ", str(x.get("reason") or "")).strip()[:300]})
    return out[:p.count]


class _Highlight(BaseModel):
    start: float = Field(0.0, description="seconds: where the clip starts (the start of a line)")
    end: float = Field(0.0, description="seconds: where it ends (the end of a line)")
    title: str = Field("", description="a short catchy title for the clip")
    hook: str = Field("", description="the opening line or idea that grabs attention in the first 2 seconds")
    why: str = Field("", description="why this part works on its own, one sentence")


class HighlightsOut(BaseModel):
    highlights: list[_Highlight] = Field(default_factory=list)


PLATFORM_NAMES = {"shorts": "YouTube Shorts", "reels": "Instagram Reels", "tiktok": "TikTok", "any": "short vertical video"}
HIGHLIGHTS_SYSTEM = ("You are a social video editor who cuts long videos into Shorts and Reels. You pick self-contained "
                     "moments with a strong hook in the first seconds, a clear point and a satisfying end, using only "
                     "whole lines of the transcript.")


def highlights_prompt(p: HighlightsIn) -> str:
    return (f"Pick the {p.count} best clips of about {p.target_seconds:.0f} seconds each for {PLATFORM_NAMES[p.platform]} "
            "from this transcript (times in seconds). The clips must not overlap. Best first.\n\n" + transcript_text(p.segments))


def highlight_bounds(target: float) -> tuple[float, float]:
    """The shortest and longest a highlight may be for a target length."""
    return max(8.0, target * 0.5), min(target * 1.34, 180.0)


def mock_highlights(p: HighlightsIn) -> dict:
    """Deterministic picks (MOCK mode): windows of whole lines up to the target length with the most speech."""
    segs = sorted(p.segments, key=lambda s: s.start)
    lo, _ = highlight_bounds(p.target_seconds)
    lo = min(lo, segs[-1].end - segs[0].start)
    windows = []
    for i, s in enumerate(segs):
        chars, j = 0, i
        while j < len(segs) and segs[j].end - s.start <= p.target_seconds + 0.01:
            chars += len(segs[j].text)
            j += 1
        if j > i and segs[j - 1].end - s.start >= lo - 0.01:
            windows.append((chars / max(segs[j - 1].end - s.start, 1.0), s.start, segs[j - 1].end, s.text))
    picks: list[dict] = []
    for _, a, b, text in sorted(windows, key=lambda w: (-w[0], w[1])):
        if any(a < x["end"] and x["start"] < b for x in picks):
            continue
        picks.append({"start": a, "end": b, "title": _words(text, 6), "hook": _words(text, 14),
                      "why": "MOCK: the densest stretch of speech"})
        if len(picks) >= p.count:
            break
    return {"highlights": picks}


def finish_highlights(raw: list[dict], p: HighlightsIn) -> list[dict]:
    """Highlights on whole lines (from a line's start to a line's end) close to the asked length, inside the
    transcript, not overlapping, best first, at most `count`."""
    segs = sorted(p.segments, key=lambda s: s.start)
    a0, b0 = transcript_span(segs)
    lo, hi = highlight_bounds(p.target_seconds)
    lo = min(lo, b0 - a0)
    out: list[dict] = []
    for x in raw:
        s = min(max(float(x.get("start") or 0), a0), b0)
        want = float(x.get("end") or 0)
        first = next((g for g in segs if g.end > s + 0.05), None)  # the line the clip starts in
        if first is None:
            continue
        s = min(s, first.start) if s - first.start < 2.0 else s
        ends = [g.end for g in segs if s + lo - 0.01 <= g.end <= s + hi + 0.01]
        if not ends:
            continue
        aim = want if s + lo <= want <= s + hi else s + p.target_seconds
        e = min(ends, key=lambda t: abs(t - aim))
        if any(s < y["end"] - 0.05 and y["start"] < e - 0.05 for y in out):
            continue
        out.append({"start": round(s, 3), "end": round(e, 3), "title": str(x.get("title") or "").strip()[:100] or "Highlight",
                    "hook": str(x.get("hook") or "").strip()[:200], "why": str(x.get("why") or "").strip()[:400]})
        if len(out) >= p.count:
            break
    return out


# ── thumbnails ───────────────────────────────────────────────────────────────

THUMB_VARIANTS = ("a tight crop on the main subject's face or the key object, expressive",
                  "a wider frame with clear empty space for the title",
                  "bold colour pop and dramatic contrast lighting",
                  "a clean, minimal background with the subject standing out")


def thumbnail_prompt(p: ThumbnailIn, aspect: str, i: int) -> str:
    where = "YouTube video thumbnail" if aspect == "16:9" else "vertical Shorts/Reels cover"
    text = (f"Put the title “{p.title.strip()}” on it in large, bold, clean lettering that reads at a small size, "
            "never covering the subject's face." if p.title.strip() else "Put no text on it.")
    return (f"Design an eye-catching {where} ({aspect}) from this frame of the video. Keep the people, place and look of "
            f"the frame recognisable; make it sharp, bright and high contrast. {text}"
            + (f" Style: {p.style.strip()}." if p.style.strip() else "")
            + f" Variation: {THUMB_VARIANTS[i % len(THUMB_VARIANTS)]}.")


# ── voice cloning (only with the speaker's consent) ──────────────────────────

CLONE_MIN_S, CLONE_MAX_S = 10.0, 180.0


def check_consent(db: Session, consent_id: int) -> Consent:
    """The speaker's consent record for a cloned voice, or ToolError: it must exist, be for voice replication and not
    have expired."""
    c = db.get(Consent, consent_id)
    how = ("Record the speaker's signed consent first (Team → Consent records, kind “Voice replication”), then pick it "
           "here.")
    if c is None:
        raise ToolError(f"Voice cloning needs the speaker's consent record, and there is none with id {consent_id}. {how}", 403)
    if c.kind != "voice_replication":
        raise ToolError(f"Consent record {consent_id} ({c.subject_name}) is for {c.kind.replace('_', ' ')}, not for "
                        f"cloning a voice. {how}", 403)
    if c.expires_on and c.expires_on < utcnow().date().isoformat():
        raise ToolError(f"The consent of {c.subject_name} expired on {c.expires_on}. Record a new one to clone the voice.", 403)
    return c


def clone_languages(langs: list[str]) -> list[str]:
    for code in langs:
        _check_lang(code)
    return list(dict.fromkeys(langs)) or list(LANGS)


# ── the tools: label, job type, price ────────────────────────────────────────

@dataclass
class Tool:
    id: str
    label: str
    job: str  # job type (workers/handlers_edit.py)
    params: type[BaseModel]
    group: str  # captions | voice | sound | picture | assistant | looks


def _ln(label: str, usd: float) -> dict:
    return {"label": label, "usd": round(usd, 4)}


def engine_choice(db: Session, chain: str, modes: list[str], route: str | None) -> tuple[AIModel, str]:
    """The engine a video tool runs on: the team's chain (Google first), or a route picked from the Model Hub's enabled
    engines that can do this."""
    task = {"edit": "edit", "image": "image"}.get(chain, "video")
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
        extra.update(engine="Lyria", prompt=music_prompt(p))
        mood = f" · {p.mood.strip()}" if p.mood.strip() else ""
        return [_ln(f"Music · {p.seconds:.0f} s{mood} (Lyria)", est.music(p.seconds))], extra
    if tool == "broll_suggest":
        extra["engine"] = text_engine(svc)
        chars = len(broll_prompt(p)) + len(BROLL_SYSTEM)
        return [_ln(f"B-roll ideas · {len(p.segments)} lines ({extra['engine']})", est.text(chars, 260 * p.count))], extra
    if tool == "highlights":
        extra["engine"] = text_engine(svc)
        chars = len(highlights_prompt(p)) + len(HIGHLIGHTS_SYSTEM)
        return [_ln(f"Highlights · {p.count} × ~{p.target_seconds:.0f} s ({extra['engine']})", est.text(chars, 350 * p.count))], extra
    if tool == "thumbnail":
        src = asset_path(pid, p.frame_key or p.key or "")
        k = kind_of_ext(src.suffix)
        if k != "image" and (p.frame_key or k != "video"):
            raise ToolError("A thumbnail starts from a frame of a video or from an image")
        m, _ = engine_choice(db, "image", ["i2i"], p.route)
        n = p.count * len(p.aspects)
        extra.update(engine=m.display_name, engine_id=m.id, images=n)
        return [_ln(f"Thumbnails · {n} image{'s' if n != 1 else ''} ({m.display_name})", est.image_engine(m, n))], extra
    if tool == "voice_clone":
        check_consent(db, p.consent_id)
        clone_languages(p.languages)
        if provider_mode("elevenlabs") == "missing":
            raise ToolError("Voice cloning needs the ElevenLabs key on the studio (Admin → Settings)")
        src = asset_path(pid, p.sample_key)
        if kind_of_ext(src.suffix) == "image" or not ff.has_audio(src):
            raise ToolError("The voice sample has no sound")
        _, secs = span(src, p.start, p.end)
        if secs < CLONE_MIN_S:
            raise ToolError(f"Use at least {CLONE_MIN_S:.0f} seconds of clean speech for a cloned voice")
        secs = min(secs, CLONE_MAX_S)
        extra.update(engine="ElevenLabs", seconds=round(secs, 3))
        return [_ln(f"Instant voice clone · {secs:.0f} s of speech (ElevenLabs)", est.voice_clone("elevenlabs"))], extra
    if tool == "mood_suggest":
        allowed = allowed_moods(p)
        extra["engine"] = text_engine(svc)
        chars = len(mood_prompt(p, allowed)) + len(MOOD_SYSTEM)
        return [_ln(f"Mood per scene · {len(p.scenes)} scene{'s' if len(p.scenes) != 1 else ''} ({extra['engine']})",
                    est.text(chars, 120 * len(p.scenes)))], extra
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
    Tool("broll_suggest", "B-roll ideas", "edit_broll_suggest", BrollSuggestIn, "picture"),
    Tool("highlights", "Highlights for Shorts", "edit_highlights", HighlightsIn, "assistant"),
    Tool("thumbnail", "Thumbnail", "edit_thumbnail", ThumbnailIn, "picture"),
    Tool("voice_clone", "Clone a voice", "edit_voice_clone", VoiceCloneIn, "voice"),
    Tool("mood_suggest", "Mood per scene", "edit_mood_suggest", MoodSuggestIn, "looks"),
)}
PRODUCER_TOOLS = {"voice_clone"}  # like the studio's voice cloning: a producer's step (it needs a consent record)


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
        elif t.id in ("translate", "assistant", "sfx_suggest", "broll_suggest", "highlights", "mood_suggest"):
            prov = route
        elif t.id in ("clean_voice", "sfx", "voice_clone"):
            prov = "elevenlabs"
        elif t.id == "music":
            prov = "gemini"
        elif t.id == "upscale":
            prov = "fal"
        elif t.id in ("tts", "dub"):
            prov = (settings_store.get_setting(db, "tts_provider_by_language") or {}).get("en", "gemini")
        else:
            chain, modes = {"edit_words": ("edit", ["edit"]), "thumbnail": ("image", ["i2i"])}.get(t.id, ("video.saver", ["t2v", "i2v"]))
            c = model_hub.first_choice(db, chain, modes)
            prov = c[0].provider if c else ""
        mode = provider_mode(prov) if prov else "missing"
        rows.append({"id": t.id, "label": t.label, "group": t.group, "provider": {"google": "gemini"}.get(prov, prov),
                     "mode": mode, "ready": mode != "missing"})
    return rows
