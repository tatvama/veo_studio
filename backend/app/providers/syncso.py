"""sync.so lip-sync REST. Uses the multipart form of POST /v2/generate so no public URLs are needed."""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Callable

import httpx

from .base import ProviderBlocked, ProviderError, RetryableProviderError, raise_for_status

BASE = "https://api.sync.so"


class SyncClient:
    def __init__(self, api_key: str):
        if not api_key:
            raise ProviderError("SYNC_API_KEY is not set", provider="sync")
        self.http = httpx.Client(base_url=BASE, timeout=httpx.Timeout(600.0, connect=30.0),
                                 headers={"x-api-key": api_key}, follow_redirects=True)

    def create(self, video: Path, audio: Path, model: str, sync_mode: str = "cut_off",
               temperature: float = 0.5, active_speaker: bool = False, occlusion: bool = False) -> str:
        options: dict = {"sync_mode": sync_mode, "temperature": temperature}
        if occlusion and model != "sync-3":
            options["occlusion_detection_enabled"] = True
        if active_speaker:
            options["active_speaker_detection"] = {"auto_detect": True}
        with open(video, "rb") as fv, open(audio, "rb") as fa:
            try:
                r = self.http.post("/v2/generate", files={
                    "video": (video.name, fv, "video/mp4"),
                    "audio": (audio.name, fa, "audio/wav" if audio.suffix == ".wav" else "audio/mpeg"),
                }, data={"model": model, "options": json.dumps(options)})
            except (httpx.TimeoutException, httpx.TransportError) as e:
                raise RetryableProviderError(f"sync.so network error: {e}", provider="sync") from e
        raise_for_status(r, "sync")
        gid = r.json().get("id")
        if not gid:
            raise ProviderError(f"sync.so returned no id: {r.text[:200]}", provider="sync")
        return gid

    def wait(self, gid: str, on_tick: Callable[[float], bool] | None = None, poll_s: float = 5.0,
             timeout_s: float = 1800.0) -> dict:
        start = time.time()
        while True:
            r = self.http.get(f"/v2/generate/{gid}")
            raise_for_status(r, "sync")
            data = r.json()
            st = data.get("status")
            if st == "COMPLETED":
                return data
            if st in ("FAILED", "REJECTED"):
                msg = f"sync.so {st}: {data.get('error') or data.get('errorCode') or ''}"
                if st == "REJECTED":
                    raise ProviderBlocked(msg, provider="sync")
                raise ProviderError(msg, provider="sync")
            elapsed = time.time() - start
            if elapsed > timeout_s:
                raise RetryableProviderError("sync.so generation timed out", provider="sync")
            if on_tick and on_tick(elapsed) is False:
                raise ProviderError("cancelled", provider="sync")
            time.sleep(poll_s)

    def download(self, url: str) -> bytes:
        r = httpx.get(url, timeout=300.0, follow_redirects=True)
        raise_for_status(r, "sync")
        return r.content
