"""Sarvam AI Bulbul TTS (Indian languages)."""
from __future__ import annotations

import base64

import httpx

from .base import ProviderError, RetryableProviderError, raise_for_status

BASE = "https://api.sarvam.ai"


class SarvamClient:
    def __init__(self, api_key: str):
        if not api_key:
            raise ProviderError("SARVAM_API_KEY is not set", provider="sarvam")
        self.http = httpx.Client(base_url=BASE, timeout=httpx.Timeout(120.0, connect=30.0),
                                 headers={"api-subscription-key": api_key, "Content-Type": "application/json"})

    def tts(self, text: str, language_code: str, speaker: str, model: str = "bulbul:v3", pace: float = 1.0) -> bytes:
        body = {"text": text[:2500], "language_code": language_code, "speaker": speaker, "model": model,
                "pace": pace, "speech_sample_rate": 24000}
        try:
            r = self.http.post("/text-to-speech", json=body)
            if r.status_code in (400, 422) and "target_language_code" in r.text:
                # Older API revision used target_language_code
                body["target_language_code"] = body.pop("language_code")
                r = self.http.post("/text-to-speech", json=body)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise RetryableProviderError(f"sarvam network error: {e}", provider="sarvam") from e
        raise_for_status(r, "sarvam")
        audios = r.json().get("audios") or []
        if not audios:
            raise ProviderError("Sarvam returned no audio", provider="sarvam")
        return base64.b64decode(audios[0])
