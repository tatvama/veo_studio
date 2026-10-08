"""High-level AI services. Each picks the live provider or the mock automatically.

Every call returns cost information (Usage) so callers can write it to the cost ledger.
"""
from __future__ import annotations

import base64
import hashlib
import json
import tempfile
from pathlib import Path
from typing import Any, Callable, TypeVar

from pydantic import BaseModel, ValidationError

from .. import catalog, settings_store
from ..config import get_settings
from ..pipeline import ffmpeg as ff
from . import mock
from .base import MediaResult, ProviderError, ProviderNotConfigured, RetryableProviderError, Usage
from .elevenlabs import ElevenLabsClient
from .gemini import GeminiClient, guess_mime
from .sarvam import SarvamClient
from .syncso import SyncClient

T = TypeVar("T", bound=BaseModel)

PROVIDER_LABELS = {
    "gemini": "Google Gemini (text, images, Veo, Omni, TTS, Lyria)",
    "elevenlabs": "ElevenLabs (voice changer, premium TTS)",
    "sync": "sync.so (lip-sync)",
    "sarvam": "Sarvam AI (Indian-language TTS)",
    "fal": "fal.ai (Kling, Seedance, Wan, MiniMax, LTX, Flux, Luma, Grok, HeyGen … one key)",
}


def provider_mode(provider: str) -> str:
    """live | mock | missing"""
    s = get_settings()
    key = settings_store.api_key(provider)
    if s.mock_providers == "true":
        return "mock"
    if key:
        return "live"
    return "mock" if s.mock_providers == "auto" else "missing"


def provider_status() -> list[dict[str, Any]]:
    out = []
    for p, label in PROVIDER_LABELS.items():
        out.append({"provider": p, "label": label, "mode": provider_mode(p)})
    return out


def _require(provider: str) -> str:
    mode = provider_mode(provider)
    if mode == "missing":
        raise ProviderNotConfigured(f"No API key for {provider}. Add it in Admin → Settings or .env", provider=provider)
    return mode


def _tmp() -> Path:
    return Path(tempfile.mkdtemp(prefix="veo_"))


class Services:
    def __init__(self):
        self.models = settings_store.models()
        self.prices = settings_store.prices()

    # ── clients ──────────────────────────────────────────────────────────────
    def gemini(self) -> GeminiClient:
        return GeminiClient(settings_store.api_key("gemini"))

    def eleven(self) -> ElevenLabsClient:
        return ElevenLabsClient(settings_store.api_key("elevenlabs"))

    def sync(self) -> SyncClient:
        return SyncClient(settings_store.api_key("sync"))

    def sarvam(self) -> SarvamClient:
        return SarvamClient(settings_store.api_key("sarvam"))

    # ── prices ───────────────────────────────────────────────────────────────
    def video_price(self, model: str, resolution: str) -> float:
        table = self.prices["video_per_second"].get(model, {})
        return float(table.get(resolution) or table.get("720p") or 0.4)

    def text_cost(self, model: str, tin: int, tout: int) -> float:
        p = self.prices["text_per_million"].get(model, {"in": 0.3, "out": 2.5})
        return tin / 1e6 * p["in"] + tout / 1e6 * p["out"]

    # ── LLM (structured JSON) ────────────────────────────────────────────────
    def llm_json(self, task: str, system: str, prompt: str, schema: type[T], *, pro: bool = False,
                 images: list[bytes] | None = None, videos: list[bytes] | None = None, mock_ctx: dict | None = None,
                 temperature: float | None = None, tools: list[dict] | None = None) -> tuple[T, Usage]:
        model = self.models["text_pro" if pro else "text"]
        if _require("gemini") == "mock":
            data = mock.llm(task, mock_ctx or {})
            return schema.model_validate(data), Usage("gemini", model, f"llm:{task}", 0, "tokens", 0.0, mock=True)
        client = self.gemini()
        if images or videos:
            input_: Any = [{"type": "text", "text": prompt}]
            input_ += [{"type": "image", "data": base64.b64encode(b).decode(), "mime_type": guess_mime(b, "image/jpeg")}
                       for b in (images or [])]
            input_ += [{"type": "video", "data": base64.b64encode(b).decode(), "mime_type": "video/mp4"} for b in (videos or [])]
        else:
            input_ = prompt
        if tools:  # e.g. Google Search grounding for the Trend Scout
            resp = client.interact({"model": model, "input": input_, "system_instruction": system + "\nAnswer as JSON only.",
                                    "tools": tools, "store": False})
            text = client.output_text(resp)
            m = text[text.find("{"): text.rfind("}") + 1] if "{" in text else text
            tin, tout = client.usage(resp)
            try:
                return schema.model_validate_json(m), Usage("gemini", model, f"llm:{task}", tin + tout, "tokens",
                                                            self.text_cost(model, tin, tout))
            except ValidationError:
                pass  # fall through to strict structured output without tools
        last_err: Exception | None = None
        for _ in range(2):
            data, (tin, tout) = client.text_json(model, system, input_, schema.model_json_schema(), temperature)
            try:
                obj = schema.model_validate(data)
                return obj, Usage("gemini", model, f"llm:{task}", tin + tout, "tokens", self.text_cost(model, tin, tout))
            except ValidationError as e:
                last_err = e
        raise RetryableProviderError(f"model output did not match schema: {last_err}", provider="gemini")

    # ── Images ───────────────────────────────────────────────────────────────
    def image(self, prompt: str, refs: list[Path], aspect: str, hero: bool = False, title: str = "") -> MediaResult:
        model = self.models["image_hero" if hero else "image"]
        price = float(self.prices["image_each"].get(model, 0.07))
        if _require("gemini") == "mock":
            data = mock.image(prompt, aspect, title, refs=len(refs))
            return MediaResult(data, "png", Usage("gemini", model, "image", 1, "images", 0.0, mock=True))
        ref_bytes = [p.read_bytes() for p in refs if p and p.exists()][:10]
        data, mime = self.gemini().image(model, prompt, ref_bytes, aspect)
        ext = "jpg" if "jpeg" in mime else "png"
        return MediaResult(data, ext, Usage("gemini", model, "image", 1, "images", price))

    # ── Video (Veo) ──────────────────────────────────────────────────────────
    def video(self, *, model_key: str, prompt: str, aspect: str, duration: int, resolution: str,
              first_frame: Path | None = None, last_frame: Path | None = None, refs: list[Path] | None = None,
              extend_from: Path | None = None, extend_uri: str = "", negative: str = "",
              on_tick: Callable[[float], bool] | None = None,
              on_operation: Callable[[str], None] | None = None, resume_operation: str | None = None) -> MediaResult:
        model = self.models[model_key]
        refs = [r for r in (refs or []) if r and r.exists()][:3]
        if refs or last_frame or resolution in ("1080p", "4k") or extend_from:
            duration = 8
        if extend_from:
            resolution = "720p"
        price = self.video_price(model, resolution)
        if _require("gemini") == "mock":
            out = _tmp() / "mock_video.mp4"
            frame = first_frame.read_bytes() if first_frame and first_frame.exists() else None
            if frame is None and refs:
                frame = mock.image(prompt, aspect, f"video ({len(refs)} refs)", refs=len(refs))
            mock.video_from(frame, prompt, out, duration, aspect)
            return MediaResult(out.read_bytes(), "mp4", Usage("gemini", model, "video", duration, "seconds", 0.0, mock=True),
                               duration_s=duration, remote_ref="mock://video")
        client = self.gemini()
        if resume_operation:
            op = resume_operation
        else:
            # Veo 3.1 rejects the `negativePrompt` parameter ("isn't supported by this model"), so it goes in the prompt
            instance: dict[str, Any] = {"prompt": f"{prompt}\n\nAvoid: {negative}" if negative else prompt}
            if extend_from:
                # Veo only extends its own clips, referenced by the URI it returned ("Video URI not found" otherwise)
                instance["video"] = ({"uri": extend_uri} if extend_uri.startswith("http")
                                     else client.inline(extend_from.read_bytes(), "video/mp4"))
            if first_frame and not extend_from:
                fb = first_frame.read_bytes()
                instance["image"] = client.inline(fb, guess_mime(fb))
            if last_frame and first_frame:
                lb = last_frame.read_bytes()
                instance["lastFrame"] = client.inline(lb, guess_mime(lb))
            if refs and not first_frame and not extend_from:
                instance["referenceImages"] = [
                    {"image": client.inline(r.read_bytes(), guess_mime(r.read_bytes())), "referenceType": "asset"} for r in refs]
            params: dict[str, Any] = {"aspectRatio": aspect if aspect in ("16:9", "9:16") else "9:16",
                                      "resolution": resolution}  # one video per request is the default
            if not extend_from:
                params["durationSeconds"] = int(duration)
            params["personGeneration"] = "allow_adult" if (first_frame or refs) else "allow_all"
            op = client.veo_start(model, instance, params)
            if on_operation:
                on_operation(op)
        response = client.veo_wait(op, on_tick=on_tick)
        uri = client.veo_video_uri(response)
        data = client.download_file(uri)
        seconds = duration if not extend_from else 7
        return MediaResult(data, "mp4", Usage("gemini", model, "video", seconds, "seconds", price * seconds),
                           duration_s=float(duration), remote_ref=uri, meta={"operation": op})

    # ── Omni (conversational edit) ───────────────────────────────────────────
    def omni_edit(self, instruction: str, aspect: str, video: Path | None = None,
                  previous_interaction_id: str | None = None) -> MediaResult:
        model = self.models["omni"]
        price = self.video_price(model, "720p")
        if _require("gemini") == "mock":
            out = _tmp() / "omni.mp4"
            mock.omni_edit(video, out) if video else mock.video_from(None, instruction, out, 8, aspect)
            d = ff.duration(out)
            return MediaResult(out.read_bytes(), "mp4", Usage("gemini", model, "video_edit", d, "seconds", 0.0, mock=True),
                               duration_s=d, interaction_id="mock-interaction")
        client = self.gemini()
        if previous_interaction_id:
            content: Any = instruction
        else:
            content = [{"type": "user_input", "content": [
                {"type": "video", "mime_type": "video/mp4", "data": base64.b64encode(video.read_bytes()).decode()},
                {"type": "text", "text": instruction}]}]
        data, iid = client.omni(model, content, aspect=aspect, previous_interaction_id=previous_interaction_id)
        tmp = _tmp() / "omni.mp4"
        tmp.write_bytes(data)
        d = ff.duration(tmp)
        return MediaResult(data, "mp4", Usage("gemini", model, "video_edit", d, "seconds", price * d), duration_s=d,
                           interaction_id=iid)

    # ── Speech ───────────────────────────────────────────────────────────────
    def tts(self, provider: str, text: str, voice_id: str, language: str, style: str = "") -> MediaResult:
        chars = len(text)
        price = float(self.prices["tts_per_1k_chars"].get(provider, 0.05)) * chars / 1000
        lang = catalog.LANGUAGES.get(language, catalog.LANGUAGES["en"])
        if _require(provider) == "mock":
            out = _tmp() / "tts.wav"
            mock.tts(text, voice_id or provider, out)
            return MediaResult(out.read_bytes(), "wav", Usage(provider, "mock-tts", "tts", chars, "chars", 0.0, mock=True),
                               duration_s=ff.duration(out))
        if provider == "gemini":
            model = self.models["tts_gemini"]
            data = self.gemini().tts(model, text, voice_id or "Kore", style)
            ext = "wav"
        elif provider == "elevenlabs":
            model = self.models["tts_elevenlabs"]
            data = self.eleven().tts(voice_id, text, model, language_code=language)
            ext = "mp3"
        elif provider == "sarvam":
            model = self.models["tts_sarvam"]
            data = self.sarvam().tts(text, lang["sarvam"], voice_id or "anand", model)
            ext = "wav"
        else:
            raise ProviderError(f"unknown TTS provider {provider}")
        tmp = _tmp() / f"tts.{ext}"
        tmp.write_bytes(data)
        return MediaResult(data, ext, Usage(provider, model, "tts", chars, "chars", price), duration_s=ff.duration(tmp))

    def design_voice(self, provider: str, name: str, description: str, language: str, gender: str) -> tuple[str, bytes, Usage]:
        price = float(self.prices["voice_design_each"].get(provider, 0.0))
        lang = catalog.LANGUAGES.get(language, catalog.LANGUAGES["en"])
        if _require(provider) == "mock":
            vid = f"mock_{provider}_{hashlib.sha1((name + description + language).encode()).hexdigest()[:8]}"
            out = _tmp() / "sample.wav"
            mock.tts("This is a sample of my designed voice for the studio.", vid, out)
            return vid, out.read_bytes(), Usage(provider, "mock", "voice_design", 1, "voices", 0.0, mock=True)
        if provider == "gemini":
            vid, sample = self.gemini().create_voice(self.models["tts_gemini"], name, description, gender, lang["bcp47"])
            return vid, sample, Usage(provider, self.models["tts_gemini"], "voice_design", 1, "voices", price)
        if provider == "elevenlabs":
            vid, sample = self.eleven().design_and_save(name, description, self.models["ttv_elevenlabs"])
            return vid, sample, Usage(provider, self.models["ttv_elevenlabs"], "voice_design", 1, "voices", price)
        if provider == "sarvam":
            pool = catalog.SARVAM_SPEAKERS["female" if gender == "female" else "male"]
            speaker = pool[int(hashlib.sha1(name.encode()).hexdigest(), 16) % len(pool)]
            sample = self.sarvam().tts("Namaskara. This is my voice.", lang["sarvam"], speaker, self.models["tts_sarvam"])
            return speaker, sample, Usage(provider, self.models["tts_sarvam"], "voice_design", 1, "voices", 0.0)
        raise ProviderError(f"unknown provider {provider}")

    def voice_change(self, audio_wav: Path, voice_id: str) -> MediaResult:
        model = self.models["sts_elevenlabs"]
        d = ff.duration(audio_wav)
        price = float(self.prices["sts_per_minute"].get("elevenlabs", 0.3)) * d / 60
        if _require("elevenlabs") == "mock":
            out = _tmp() / "sts.wav"
            mock.tts("x" * int(d * 14), voice_id, out)
            return MediaResult(out.read_bytes(), "wav", Usage("elevenlabs", model, "voice_change", d, "seconds", 0.0, mock=True),
                               duration_s=d)
        data = self.eleven().speech_to_speech(voice_id, audio_wav.read_bytes(), model)
        return MediaResult(data, "mp3", Usage("elevenlabs", model, "voice_change", d, "seconds", price), duration_s=d)

    def isolate_voice(self, audio_wav: Path) -> MediaResult:
        d = ff.duration(audio_wav)
        price = float(self.prices["isolation_per_minute"].get("elevenlabs", 0.3)) * d / 60
        if _require("elevenlabs") == "mock":
            return MediaResult(audio_wav.read_bytes(), "wav",
                               Usage("elevenlabs", "audio-isolation", "isolation", d, "seconds", 0.0, mock=True), duration_s=d)
        data = self.eleven().isolate(audio_wav.read_bytes())
        return MediaResult(data, "mp3", Usage("elevenlabs", "audio-isolation", "isolation", d, "seconds", price), duration_s=d)

    # ── Lip-sync ─────────────────────────────────────────────────────────────
    def lipsync(self, video: Path, audio: Path, model: str, on_tick: Callable[[float], bool] | None = None,
                active_speaker: bool = False) -> MediaResult:
        d = ff.duration(video)
        price = float(self.prices["lipsync_per_second"].get(model, 0.05)) * d
        if _require("sync") == "mock":
            out = _tmp() / "lipsync.mp4"
            mock.lipsync(video, audio, out)
            return MediaResult(out.read_bytes(), "mp4", Usage("sync", model, "lipsync", d, "seconds", 0.0, mock=True), duration_s=d)
        client = self.sync()
        gid = client.create(video, audio, model, sync_mode="cut_off", active_speaker=active_speaker)
        res = client.wait(gid, on_tick=on_tick)
        data = client.download(res["outputUrl"])
        return MediaResult(data, "mp4", Usage("sync", model, "lipsync", d, "seconds", price), duration_s=d,
                           remote_ref=res.get("outputUrl", ""), meta={"generation_id": gid})

    # ── Music ────────────────────────────────────────────────────────────────
    def music(self, prompt: str, seconds: float) -> MediaResult:
        model = self.models["music_clip" if seconds <= 30 else "music"]
        price = float(self.prices["music_each"].get(model, 0.1))
        if _require("gemini") == "mock":
            out = _tmp() / "music.wav"
            mock.music(out, min(max(seconds, 10), 60))
            return MediaResult(out.read_bytes(), "wav", Usage("gemini", model, "music", 1, "tracks", 0.0, mock=True),
                               duration_s=ff.duration(out))
        hint = prompt if seconds <= 30 else f"{prompt} Length about {int(seconds)} seconds."
        data, ext = self.gemini().music(model, hint)
        tmp = _tmp() / f"music.{ext}"
        tmp.write_bytes(data)
        return MediaResult(data, ext, Usage("gemini", model, "music", 1, "tracks", price), duration_s=ff.duration(tmp))


    # ── Sound effects ────────────────────────────────────────────────────────
    def sound_effect(self, prompt: str, seconds: float) -> MediaResult:
        price = 0.02 * max(seconds, 1) / 10  # ElevenLabs SFX ≈ credits per second (estimate)
        if _require("elevenlabs") == "mock":
            out = _tmp() / "sfx.wav"
            ff.write_tone_wav(out, max(seconds, 0.5), freq=80, volume=0.05, syllables=False)
            return MediaResult(out.read_bytes(), "wav", Usage("elevenlabs", "sfx", "sfx", seconds, "seconds", 0.0, mock=True),
                               duration_s=seconds)
        data = self.eleven().sound_effect(prompt, seconds)
        return MediaResult(data, "mp3", Usage("elevenlabs", "sound-generation", "sfx", seconds, "seconds", price),
                           duration_s=seconds)

    # ── Character identity (LoRA) ────────────────────────────────────────────
    def train_identity(self, trainer: str, zip_path: Path, trigger: str, steps: int,
                       on_tick: Callable[[float], bool] | None = None, on_request: Callable[[str], None] | None = None,
                       resume: str | None = None) -> tuple[str, Usage]:
        """Train a character LoRA on fal.ai. Returns (lora_url, usage)."""
        if _require("fal") == "mock":
            return f"mock://lora/{trigger}", Usage("fal", trainer, "train", steps, "steps", 0.0, mock=True)
        client = self.fal()
        url = client.upload(zip_path)
        args: dict[str, Any] = {"steps": steps}
        if "krea" in trainer:
            args.update({"images_data_url": url, "trigger_phrase": trigger, "auto_captioning": "Object/Character"})
        else:
            args.update({"image_data_url": url, "default_caption": f"{trigger}, a person"})
        res = client.run(trainer, args, on_tick=on_tick, on_request=on_request, resume_request_id=resume, timeout_s=5400)
        lora = (res.get("diffusers_lora_file") or res.get("lora_file") or {}).get("url")
        if not lora:
            raise ProviderError(f"trainer returned no LoRA file: {str(res)[:200]}", provider="fal")
        from ..core.model_hub import TASK_DEFAULT_PRICE  # noqa: F401
        cost = 0.002 * steps  # ~$2 per 1,000 steps (fal LoRA trainers, estimate)
        return lora, Usage("fal", trainer, "train", steps, "steps", cost)

    def lora_image(self, endpoint: str, prompt: str, loras: list[dict], aspect: str, title: str = "") -> MediaResult:
        if _require("fal") == "mock":
            data = mock.image(prompt, aspect, f"{title} · LoRA")
            return MediaResult(data, "png", Usage("fal", endpoint, "image", 1, "images", 0.0, mock=True))
        from .schema_map import IMAGE_SIZE_FOR
        client = self.fal()
        res = client.run(endpoint, {"prompt": prompt, "loras": loras, "image_size": IMAGE_SIZE_FOR.get(aspect, "portrait_16_9"),
                                    "num_images": 1, "output_format": "png"})
        from .schema_map import extract_url
        url = extract_url(res, "image")
        if not url:
            raise ProviderError("LoRA model returned no image", provider="fal")
        return MediaResult(client.download(url), "png", Usage("fal", endpoint, "image", 1, "images", 0.03))

    # ── Embeddings ───────────────────────────────────────────────────────────
    def embed(self, texts: list[str]) -> tuple[list[list[float]], str]:
        model = self.models.get("embedding", "gemini-embedding-001")
        if _require("gemini") == "mock" or not texts:
            return [hash_embed(t) for t in texts], "hash-256"
        return self.gemini().embed(model, texts), model

    # ── Any engine from the Model Hub ────────────────────────────────────────
    def fal(self):
        from .fal import FalClient
        return FalClient(settings_store.api_key("fal"))

    def run_model(self, m, req, on_tick: Callable[[float], bool] | None = None,
                  on_request: Callable[[str], None] | None = None, resume: str | None = None) -> MediaResult:
        """Run `req` (schema_map.GenRequest) on hub engine `m` (models.AIModel). Returns media + cost."""
        from ..core.model_hub import clamp_duration, price_for
        from . import schema_map

        task = m.task
        if m.provider == "google" and m.builtin:
            if task == "image":
                return self.image(req.prompt, req.refs + ([req.first_frame] if req.first_frame else []), req.aspect,
                                  hero=m.endpoint == "image_hero", title="keyframe")
            if req.mode == "edit":
                return self.omni_edit(req.prompt, req.aspect, video=req.video)
            if m.endpoint == "omni" and req.mode == "extend":
                return self.omni_edit(f"Continue the scene: {req.prompt}", req.aspect, video=req.video)
            return self.video(model_key=m.endpoint, prompt=req.prompt, aspect=req.aspect, duration=int(req.duration or 8),
                              resolution=req.resolution, first_frame=req.first_frame if req.mode in ("i2v", "flf") else None,
                              last_frame=req.last_frame if req.mode == "flf" else None,
                              refs=req.refs if req.mode == "ref2v" else None,
                              extend_from=req.video if req.mode == "extend" else None,
                              extend_uri=req.video_uri if req.mode == "extend" else "", negative=req.negative,
                              on_tick=on_tick, on_operation=on_request, resume_operation=resume)
        if m.provider == "sync" and m.builtin:
            return self.lipsync(req.video, req.audio, self.models.get(m.endpoint, "lipsync-2"), on_tick=on_tick)

        # catalog engine (fal.ai)
        seconds = float(req.duration or 8)
        if req.mode in ("a2v", "lipsync") and req.audio:
            seconds = max(ff.duration(req.audio), 1.0)
        elif task in ("video", "edit"):
            seconds = clamp_duration(m, seconds)
            req.duration = seconds
        units = 1.0
        if _require(m.provider) == "mock":
            return _mock_engine(m, req, seconds)
        client = self.fal()
        pm = dict(m.param_map or {})
        args = schema_map.build_args(pm, m.capabilities or {}, req, client.upload)
        args.update((m.param_overrides or {}).get("fixed_args", {}))
        result = client.run(m.endpoint, args, on_tick=on_tick, on_request=on_request, resume_request_id=resume)
        kind = "image" if task == "image" else "audio" if task in ("tts", "music") else "video"
        url = schema_map.extract_url(result, kind)
        if not url:
            raise ProviderError(f"{m.display_name}: no {kind} in the response ({str(result)[:200]})", provider="fal")
        data = client.download(url)
        ext = url.split("?")[0].rsplit(".", 1)[-1].lower() if "." in url.split("/")[-1] else ("png" if kind == "image" else "mp4")
        dur = 0.0
        if kind == "video":
            tmp = _tmp() / f"out.{ext}"
            tmp.write_bytes(data)
            dur = ff.duration(tmp)
            seconds = dur or seconds
        cost = price_for(m, seconds=seconds, resolution=req.resolution, units=units)
        return MediaResult(data, ext, Usage("fal", m.endpoint, task, seconds if kind == "video" else units,
                                            "seconds" if kind == "video" else "units", cost),
                           duration_s=dur, remote_ref=url, meta={"args": {k: v for k, v in args.items() if "url" not in k}})


def hash_embed(text: str, dims: int = 256) -> list[float]:
    """Offline fallback embedding (bag of words, hashed). Good enough for keyword-ish search in mock mode."""
    import math
    import re as _re
    v = [0.0] * dims
    for w in _re.findall(r"\w+", (text or "").lower()):
        h = int(hashlib.md5(w.encode()).hexdigest(), 16)
        v[h % dims] += 1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def _mock_engine(m, req, seconds: float) -> MediaResult:
    """Placeholder output for any catalog engine (MOCK mode), so routing and pipelines can be tested free."""
    out = _tmp() / "engine.mp4"
    label = f"{m.display_name} · {req.mode}"
    if m.task == "image":
        data = mock.image(req.prompt, req.aspect, label, refs=len(req.refs))
        return MediaResult(data, "png", Usage("fal", m.endpoint, "image", 1, "units", 0.0, mock=True))
    if req.mode == "lipsync" and req.video and req.audio:
        mock.lipsync(req.video, req.audio, out)
    elif req.mode in ("edit", "extend") and req.video:
        mock.omni_edit(req.video, out)
    else:
        frame = req.first_frame.read_bytes() if req.first_frame and req.first_frame.exists() else (
            req.refs[0].read_bytes() if req.refs else None)
        mock.video_from(frame or mock.image(req.prompt, req.aspect, label), req.prompt, out, max(seconds, 2), req.aspect,
                        with_tone=req.mode != "a2v")
        if req.mode == "a2v" and req.audio:
            muxed = out.with_name("engine_a2v.mp4")
            mock.lipsync(out, req.audio, muxed)
            out = muxed
    d = ff.duration(out)
    return MediaResult(out.read_bytes(), "mp4", Usage("fal", m.endpoint, m.task, d, "seconds", 0.0, mock=True), duration_s=d,
                       remote_ref="mock://engine")


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)
