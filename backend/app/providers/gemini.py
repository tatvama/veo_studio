"""Google Gemini API over REST (Interactions API + Veo predictLongRunning + Voices).

REST is used directly (not the SDK) so request shapes match the docs exactly and
SDK version churn in the beta Interactions API can't break us.
Docs: ai.google.dev/gemini-api/docs/{interactions,veo,omni,speech-generation,voice-design,music-generation,image-generation}
"""
from __future__ import annotations

import base64
import json
import time
from typing import Any, Callable

import httpx

from .base import ProviderBlocked, ProviderError, RetryableProviderError, raise_for_status

BASE = "https://generativelanguage.googleapis.com/v1beta"


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def guess_mime(data: bytes, default: str = "image/png") -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return default


class GeminiClient:
    def __init__(self, api_key: str, timeout: float = 600.0):
        if not api_key:
            raise ProviderError("GEMINI_API_KEY is not set", provider="gemini")
        self.http = httpx.Client(
            base_url=BASE,
            timeout=httpx.Timeout(timeout, connect=30.0),
            headers={"x-goog-api-key": api_key, "Content-Type": "application/json", "Api-Revision": "2026-05-20"},
            follow_redirects=True,
        )

    # ── Interactions ─────────────────────────────────────────────────────────
    def interact(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            r = self.http.post("/interactions", json=body)
        except httpx.TimeoutException as e:
            raise RetryableProviderError(f"gemini timeout: {e}", provider="gemini") from e
        except httpx.TransportError as e:
            raise RetryableProviderError(f"gemini network error: {e}", provider="gemini") from e
        raise_for_status(r, "gemini")
        data = r.json()
        if data.get("status") in ("failed", "cancelled"):
            err = data.get("error") or {}
            msg = err.get("message") if isinstance(err, dict) else str(err)
            raise _classify(msg or "interaction failed")
        return data

    @staticmethod
    def outputs(resp: dict[str, Any]) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for step in resp.get("steps") or []:
            if step.get("type") == "model_output":
                items.extend(step.get("content") or [])
        # older "outputs" schema fallback
        for item in resp.get("outputs") or []:
            items.append(item)
        return items

    @staticmethod
    def function_calls(resp: dict[str, Any]) -> list[dict[str, Any]]:
        return [s for s in (resp.get("steps") or []) if s.get("type") == "function_call"]

    @classmethod
    def output_text(cls, resp: dict[str, Any]) -> str:
        texts = [c.get("text", "") for c in cls.outputs(resp) if c.get("type") == "text"]
        return "".join(texts).strip()

    @classmethod
    def last_output(cls, resp: dict[str, Any], kind: str) -> dict[str, Any] | None:
        found = [c for c in cls.outputs(resp) if c.get("type") == kind]
        return found[-1] if found else None

    @staticmethod
    def usage(resp: dict[str, Any]) -> tuple[int, int]:
        u = resp.get("usage") or resp.get("usage_metadata") or resp.get("usageMetadata") or {}
        tin = (u.get("total_input_tokens") or u.get("input_tokens") or u.get("prompt_token_count")
               or u.get("promptTokenCount") or 0)
        tout = (u.get("total_output_tokens") or u.get("output_tokens") or u.get("candidates_token_count")
                or u.get("candidatesTokenCount") or 0)
        return int(tin or 0), int(tout or 0)

    def media_bytes(self, item: dict[str, Any]) -> bytes:
        if item.get("data"):
            return base64.b64decode(item["data"])
        if item.get("uri"):
            return self.download_file(item["uri"])
        raise ProviderError("model returned no media data", provider="gemini")

    # ── Text / JSON ──────────────────────────────────────────────────────────
    def text_json(self, model: str, system: str, input_: Any, schema: dict[str, Any],
                  temperature: float | None = None) -> tuple[dict[str, Any], tuple[int, int]]:
        body: dict[str, Any] = {
            "model": model,
            "input": input_,
            "store": False,
            "response_format": {"type": "text", "mime_type": "application/json", "schema": schema},
        }
        if system:
            body["system_instruction"] = system
        if temperature is not None:
            body["generation_config"] = {"temperature": temperature}
        resp = self.interact(body)
        text = self.output_text(resp)
        try:
            return json.loads(text), self.usage(resp)
        except json.JSONDecodeError as e:
            raise RetryableProviderError(f"model returned invalid JSON: {text[:200]}", provider="gemini") from e

    def agent_step(self, model: str, system: str, input_: Any, tools: list[dict[str, Any]],
                   previous_interaction_id: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"model": model, "input": input_, "tools": tools, "system_instruction": system}
        if previous_interaction_id:
            body["previous_interaction_id"] = previous_interaction_id
        return self.interact(body)

    # ── Embeddings (semantic search) ─────────────────────────────────────────
    def embed(self, model: str, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(texts), 90):
            chunk = texts[i:i + 90]
            r = self.http.post(f"/models/{model}:batchEmbedContents", json={"requests": [
                {"model": f"models/{model}", "content": {"parts": [{"text": t[:8000]}]}} for t in chunk]})
            raise_for_status(r, "gemini")
            out += [e.get("values", []) for e in r.json().get("embeddings", [])]
        return out

    # ── Images (Nano Banana) ─────────────────────────────────────────────────
    def image(self, model: str, prompt: str, refs: list[bytes], aspect: str, size: str = "2K") -> tuple[bytes, str]:
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        for data in refs:
            content.append({"type": "image", "data": b64(data), "mime_type": guess_mime(data)})
        body = {
            "model": model,
            "input": content if refs else prompt,
            "store": False,
            "response_format": {"type": "image", "aspect_ratio": aspect, "image_size": size},
        }
        resp = self.interact(body)
        item = self.last_output(resp, "image")
        if not item:
            raise _classify(self.output_text(resp) or "no image returned (possibly blocked by safety filters)")
        return self.media_bytes(item), item.get("mime_type", "image/png")

    # ── Speech (Gemini TTS) ──────────────────────────────────────────────────
    def tts(self, model: str, text: str, voice: str, style: str = "") -> bytes:
        item: dict[str, Any] = {"type": "text", "text": text}
        if style:
            item["annotations"] = [{"type": "speech_metadata", "style": style}]
        body = {
            "model": model,
            "input": [{"type": "user_input", "content": [item]}],
            "store": False,
            "response_format": {"type": "audio"},
            "generation_config": {"speech_config": [{"voice": voice}]},
        }
        resp = self.interact(body)
        audio = self.last_output(resp, "audio")
        if not audio:
            raise ProviderError("TTS returned no audio", provider="gemini")
        return self.media_bytes(audio)

    def create_voice(self, model: str, display_name: str, description: str, gender: str = "",
                     language_code: str = "en-IN") -> tuple[str, bytes]:
        voice: dict[str, Any] = {
            "model": model,
            "type": "prompted",
            "display_name": display_name[:60],
            "language_code": language_code,
            "prompted": {"input": description},
        }
        if gender in ("male", "female", "neutral"):
            voice["gender"] = gender
        r = self.http.post("/voices", json={"store": True, "voice": voice})
        raise_for_status(r, "gemini")
        data = r.json()
        vid = data.get("id") or data.get("name", "").split("/")[-1]
        sample = base64.b64decode((data.get("sample_audio") or {}).get("data") or b"")
        return vid, sample

    def list_voices(self, language_code: str | None = None, page_size: int = 100) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"page_size": page_size}
        if language_code:
            params["language_code"] = language_code
        r = self.http.get("/voices", params=params)
        raise_for_status(r, "gemini")
        return r.json().get("voices") or []

    # ── Music (Lyria) ────────────────────────────────────────────────────────
    def music(self, model: str, prompt: str) -> tuple[bytes, str]:
        resp = self.interact({"model": model, "input": prompt, "store": False})
        audio = self.last_output(resp, "audio")
        if not audio:
            raise ProviderError("Lyria returned no audio", provider="gemini")
        mime = audio.get("mime_type", "audio/mpeg")
        return self.media_bytes(audio), ("wav" if "wav" in mime else "mp3")

    # ── Omni Flash (video generate / edit) ───────────────────────────────────
    def omni(self, model: str, content: list[dict[str, Any]] | str, aspect: str | None = None,
             resolution: str | None = None, previous_interaction_id: str | None = None) -> tuple[bytes, str]:
        fmt: dict[str, Any] = {"type": "video", "delivery": "uri"}
        if aspect:
            fmt["aspect_ratio"] = aspect
        if resolution:
            fmt["resolution"] = resolution
        body: dict[str, Any] = {"model": model, "input": content, "response_format": fmt}
        if previous_interaction_id:
            body["previous_interaction_id"] = previous_interaction_id
        resp = self.interact(body)
        item = self.last_output(resp, "video")
        if not item:
            raise _classify(self.output_text(resp) or "Omni returned no video (possibly blocked)")
        return self.media_bytes(item), resp.get("id", "")

    # ── Files ────────────────────────────────────────────────────────────────
    def download_file(self, uri: str, wait_s: int = 300) -> bytes:
        if "/files/" in uri and not uri.endswith(":download"):
            name = "files/" + uri.split("/files/")[1].split("?")[0].split(":")[0]
            deadline = time.time() + wait_s
            while time.time() < deadline:
                r = self.http.get(f"/{name}")
                if r.status_code == 200 and r.json().get("state", "ACTIVE") in ("ACTIVE", "STATE_UNSPECIFIED"):
                    break
                if r.status_code == 200 and r.json().get("state") == "FAILED":
                    raise ProviderError("file processing failed", provider="gemini")
                time.sleep(3)
            r = self.http.get(f"/{name}:download", params={"alt": "media"})
            if r.status_code < 400 and r.content:
                return r.content
        r = self.http.get(uri)
        raise_for_status(r, "gemini")
        return r.content

    # ── Veo (long-running) ───────────────────────────────────────────────────
    def veo_start(self, model: str, instance: dict[str, Any], parameters: dict[str, Any]) -> str:
        r = self.http.post(f"/models/{model}:predictLongRunning", json={"instances": [instance], "parameters": parameters})
        raise_for_status(r, "gemini")
        name = r.json().get("name")
        if not name:
            raise ProviderError(f"Veo did not return an operation: {r.text[:300]}", provider="gemini")
        return name

    def veo_wait(self, operation: str, on_tick: Callable[[float], bool] | None = None,
                 poll_s: float = 10.0, timeout_s: float = 1200.0) -> dict[str, Any]:
        """Poll until done. on_tick(elapsed) returning False cancels."""
        start = time.time()
        while True:
            r = self.http.get(f"/{operation}")
            raise_for_status(r, "gemini")
            data = r.json()
            if data.get("done"):
                if data.get("error"):
                    raise _classify(data["error"].get("message", str(data["error"])))
                return data.get("response") or {}
            elapsed = time.time() - start
            if elapsed > timeout_s:
                raise RetryableProviderError("Veo operation timed out", provider="gemini")
            if on_tick and on_tick(elapsed) is False:
                raise ProviderError("cancelled", provider="gemini")
            time.sleep(poll_s)

    def veo_video_uri(self, response: dict[str, Any]) -> str:
        gvr = response.get("generateVideoResponse") or response
        samples = gvr.get("generatedSamples") or gvr.get("generatedVideos") or []
        if not samples:
            reasons = gvr.get("raiMediaFilteredReasons") or []
            raise ProviderBlocked("Veo blocked the video: " + ("; ".join(reasons) or "safety filter"), provider="gemini")
        video = samples[0].get("video") or {}
        uri = video.get("uri")
        if not uri:
            raise ProviderError("Veo returned no video URI", provider="gemini")
        return uri

    @staticmethod
    def inline(data: bytes, mime: str) -> dict[str, Any]:
        # Veo predictLongRunning rejects `inlineData` ("isn't supported by this model"); it takes raw base64 + mimeType.
        return {"bytesBase64Encoded": b64(data), "mimeType": mime}


def _classify(msg: str) -> ProviderError:
    low = (msg or "").lower()
    if any(w in low for w in ("safety", "blocked", "policy", "prohibited", "responsible")):
        return ProviderBlocked(msg, provider="gemini")
    if any(w in low for w in ("resource exhausted", "resource_exhausted", "quota", "rate limit")):
        return RetryableProviderError(msg, provider="gemini", status=429)  # waits in the queue, see core/ratelimit.py
    if any(w in low for w in ("overloaded", "unavailable", "try again", "deadline", "high demand")):
        return RetryableProviderError(msg, provider="gemini")
    return ProviderError(msg, provider="gemini")
