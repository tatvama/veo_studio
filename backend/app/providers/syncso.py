"""sync.so lip-sync REST. Uses the multipart form of POST /v2/generate so no public URLs are needed."""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Callable

import httpx

from .base import ProviderBlocked, ProviderError, RetryableProviderError, raise_for_status

BASE = "https://api.sync.so"


def speaker_option(active_speaker: dict | bool | None) -> dict | None:
    """sync.so's active speaker detection (https://sync.so/docs/developer-guides/speaker-selection, checked 18 Oct
    2026): options.active_speaker_detection = {"auto_detect": false, "frame_number": n, "coordinates": [x, y]} with a
    point on the speaker's face in that frame, in the video's pixels, or {"auto_detect": true} to let sync.so find whoever
    is speaking (it then lip-syncs only the active speaker in a multi-person clip)."""
    if not active_speaker:
        return None
    sp = active_speaker if isinstance(active_speaker, dict) else {}
    if sp.get("x") is not None and sp.get("y") is not None:
        return {"auto_detect": False, "frame_number": int(sp.get("frame") or 0),
                "coordinates": [int(sp["x"]), int(sp["y"])]}
    return {"auto_detect": True}


class SyncClient:
    def __init__(self, api_key: str):
        if not api_key:
            raise ProviderError("SYNC_API_KEY is not set", provider="sync")
        self.http = httpx.Client(base_url=BASE, timeout=httpx.Timeout(600.0, connect=30.0),
                                 headers={"x-api-key": api_key}, follow_redirects=True)

    def create(self, video: Path, audio: Path, model: str, sync_mode: str = "cut_off",
               temperature: float = 0.5, active_speaker: dict | bool | None = None, occlusion: bool = False) -> str:
        options: dict = {"sync_mode": sync_mode, "temperature": temperature}
        if occlusion and model != "sync-3":
            options["occlusion_detection_enabled"] = True
        asd = speaker_option(active_speaker)
        if asd:
            options["active_speaker_detection"] = asd
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
