"""ElevenLabs REST: TTS, voice changer (speech-to-speech), voice design, audio isolation."""
from __future__ import annotations

import base64
from typing import Any

import httpx

from .base import ProviderError, RetryableProviderError, raise_for_status

BASE = "https://api.elevenlabs.io"


class ElevenLabsClient:
    def __init__(self, api_key: str):
        if not api_key:
            raise ProviderError("ELEVENLABS_API_KEY is not set", provider="elevenlabs")
        self.http = httpx.Client(base_url=BASE, timeout=httpx.Timeout(300.0, connect=30.0),
                                 headers={"xi-api-key": api_key}, follow_redirects=True)

    def _post(self, url: str, **kw) -> httpx.Response:
        try:
            r = self.http.post(url, **kw)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise RetryableProviderError(f"elevenlabs network error: {e}", provider="elevenlabs") from e
        raise_for_status(r, "elevenlabs")
        return r

    def tts(self, voice_id: str, text: str, model_id: str, language_code: str | None = None) -> bytes:
        body: dict[str, Any] = {"text": text, "model_id": model_id}
        if language_code:
            body["language_code"] = language_code
        r = self._post(f"/v1/text-to-speech/{voice_id}", params={"output_format": "mp3_44100_128"}, json=body)
        return r.content

    def speech_to_speech(self, voice_id: str, audio: bytes, model_id: str, filename: str = "input.wav") -> bytes:
        r = self._post(
            f"/v1/speech-to-speech/{voice_id}",
            params={"output_format": "mp3_44100_128"},
            files={"audio": (filename, audio, "audio/wav")},
            data={"model_id": model_id, "remove_background_noise": "false"},
        )
        return r.content

    def isolate(self, audio: bytes, filename: str = "input.wav") -> bytes:
        r = self._post("/v1/audio-isolation", files={"audio": (filename, audio, "audio/wav")})
        return r.content

    def design_voice(self, description: str, model_id: str, sample_text: str | None = None) -> list[dict[str, Any]]:
        body: dict[str, Any] = {"voice_description": description, "model_id": model_id}
        if sample_text and 100 <= len(sample_text) <= 1000:
            body["text"] = sample_text
        else:
            body["auto_generate_text"] = True
        r = self._post("/v1/text-to-voice/design", json=body)
        return r.json().get("previews") or []

    def save_designed_voice(self, name: str, description: str, generated_voice_id: str) -> str:
        r = self._post("/v1/text-to-voice", json={
            "voice_name": name[:100], "voice_description": description[:1000], "generated_voice_id": generated_voice_id})
        data = r.json()
        vid = data.get("voice_id")
        if not vid:
            raise ProviderError(f"ElevenLabs did not return a voice_id: {str(data)[:200]}", provider="elevenlabs")
        return vid

    def design_and_save(self, name: str, description: str, model_id: str) -> tuple[str, bytes]:
        previews = self.design_voice(description, model_id)
        if not previews:
            raise ProviderError("ElevenLabs returned no voice previews", provider="elevenlabs")
        p = previews[0]
        vid = self.save_designed_voice(name, description, p["generated_voice_id"])
        return vid, base64.b64decode(p.get("audio_base_64") or b"")

    def clone_voice(self, name: str, samples: list[tuple[str, bytes, str]], description: str = "",
                    remove_background_noise: bool = True) -> str:
        """Instant voice clone from 1–25 clean speech samples (filename, bytes, mime). Returns the new voice_id."""
        r = self._post("/v1/voices/add",
                       data={"name": name[:100], "description": description[:500],
                             "remove_background_noise": "true" if remove_background_noise else "false"},
                       files=[("files", s) for s in samples])
        vid = r.json().get("voice_id")
        if not vid:
            raise ProviderError(f"ElevenLabs did not return a voice_id: {r.text[:200]}", provider="elevenlabs")
        return vid

    def sound_effect(self, text: str, seconds: float | None = None, prompt_influence: float = 0.4) -> bytes:
        body: dict[str, Any] = {"text": text[:450], "prompt_influence": prompt_influence}
        if seconds:
            body["duration_seconds"] = max(0.5, min(float(seconds), 22.0))
        r = self._post("/v1/sound-generation", params={"output_format": "mp3_44100_128"}, json=body)
        return r.content

    def list_voices(self) -> list[dict[str, Any]]:
        r = self.http.get("/v1/voices")
        raise_for_status(r, "elevenlabs")
        return r.json().get("voices") or []
