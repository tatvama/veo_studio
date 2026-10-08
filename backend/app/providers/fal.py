"""fal.ai — one key, hundreds of models (Kling, Seedance, Wan, MiniMax, LTX, Flux, Luma, Grok, sync, HeyGen, VEED …).

Catalog + schemas + pricing come from the public Platform API (https://api.fal.ai/v1/models);
inference goes through the official `fal-client` SDK (queue + CDN uploads).
"""
from __future__ import annotations

import hashlib
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Iterable

import httpx

from .base import ProviderBlocked, ProviderError, RetryableProviderError

PLATFORM = "https://api.fal.ai/v1"
OPENAPI_DOC = "https://fal.ai/api/openapi/queue/openapi.json"
HUB_CATEGORIES = ["text-to-video", "image-to-video", "video-to-video", "audio-to-video", "text-to-image",
                  "image-to-image", "text-to-speech", "training", "text-to-audio"]


# ── catalog (no key required; key gives higher rate limits + pricing) ────────

def list_models(categories: Iterable[str] = HUB_CATEGORIES, key: str = "", max_pages: int = 60) -> list[dict]:
    headers = {"Authorization": f"Key {key}"} if key else {}
    out: list[dict] = []
    with httpx.Client(timeout=60, headers=headers) as http:
        for cat in categories:
            cursor = None
            for _ in range(max_pages):
                params: dict[str, Any] = {"category": cat, "limit": 100, "status": "active"}
                if cursor:
                    params["cursor"] = cursor
                r = http.get(f"{PLATFORM}/models", params=params)
                if r.status_code == 429:
                    time.sleep(3)
                    continue
                r.raise_for_status()
                d = r.json()
                out.extend(d.get("models", []))
                cursor = d.get("next_cursor")
                if not d.get("has_more"):
                    break
    seen, uniq = set(), []
    for m in out:
        if m["endpoint_id"] not in seen:
            seen.add(m["endpoint_id"])
            uniq.append(m)
    return uniq


def _get_with_retry(http: httpx.Client, url: str, params: list[tuple[str, str]], tries: int = 6) -> httpx.Response:
    r = http.get(url, params=params)
    for attempt in range(tries - 1):
        if r.status_code != 429 and r.status_code < 500:
            break
        try:
            wait = float(r.headers.get("retry-after") or 0)
        except ValueError:
            wait = 0
        time.sleep(min(wait or 3 * (attempt + 1), 30))
        r = http.get(url, params=params)
    return r


def _batched(http: httpx.Client, url: str, ids: list[str], extra: list[tuple[str, str]], items_key: str) -> list[dict]:
    """GET `url` for a batch of endpoint ids, following pages. The API answers 404 for the whole batch when any
    one id is gone, so a 404 is split in halves until the missing ids are isolated and skipped."""
    if not ids:
        return []
    out: list[dict] = []
    cursor = None
    while True:
        params = [("endpoint_id", e) for e in ids] + extra + ([("cursor", cursor)] if cursor else [])
        r = _get_with_retry(http, url, params)
        if r.status_code == 404 and not cursor:
            if len(ids) == 1:
                return []
            mid = len(ids) // 2
            return _batched(http, url, ids[:mid], extra, items_key) + _batched(http, url, ids[mid:], extra, items_key)
        r.raise_for_status()
        d = r.json()
        out.extend(d.get(items_key, []))
        cursor = d.get("next_cursor")
        if not d.get("has_more") or not cursor:
            return out


def get_openapi(endpoint_ids: list[str], key: str = "") -> dict[str, dict]:
    # Schemas are public. The Platform API's `expand=openapi-3.0` answers {"error": {"code": "expansion_failed"}} for
    # every model when called with a key, and allows anonymous callers about one batch per 20 s, so read each
    # endpoint's own OpenAPI document instead, a few at a time.
    def one(http: httpx.Client, eid: str) -> tuple[str, dict | None]:
        r = _get_with_retry(http, OPENAPI_DOC, [("endpoint_id", eid)])
        if r.status_code == 200 and isinstance(spec := r.json(), dict) and spec.get("paths"):
            return eid, spec
        return eid, None  # gone from fal, or no schema published

    out: dict[str, dict] = {}
    with httpx.Client(timeout=60, follow_redirects=True) as http, ThreadPoolExecutor(max_workers=4) as pool:
        for eid, spec in pool.map(lambda e: one(http, e), endpoint_ids):
            if spec:
                out[eid] = spec
    return out


def get_pricing(endpoint_ids: list[str], key: str) -> dict[str, dict]:
    if not key:
        return {}
    out: dict[str, dict] = {}
    with httpx.Client(timeout=60, headers={"Authorization": f"Key {key}"}) as http:
        for i in range(0, len(endpoint_ids), 50):
            try:
                prices = _batched(http, f"{PLATFORM}/models/pricing", endpoint_ids[i:i + 50], [], "prices")
            except httpx.HTTPError:
                continue  # pricing is best effort; models keep their previous price
            for p in prices:
                if not p.get("unit_price"):
                    continue  # no price listed: keep the previous one rather than treating the model as free
                out[p["endpoint_id"]] = {"unit_price": float(p["unit_price"]), "unit": p.get("unit", ""),
                                         "currency": p.get("currency", "USD")}
    return out


# ── inference ────────────────────────────────────────────────────────────────

class FalClient:
    def __init__(self, key: str):
        if not key:
            raise ProviderError("FAL_KEY is not set", provider="fal")
        import fal_client  # official SDK (queue + CDN uploads)

        self._fc = fal_client
        self.client = fal_client.SyncClient(key=key, default_timeout=180.0)
        self._uploads: dict[str, str] = {}

    def upload(self, path: Path) -> str:
        h = hashlib.sha1(path.read_bytes()).hexdigest()
        if h in self._uploads:
            return self._uploads[h]
        try:
            url = self.client.upload_file(path)
        except Exception as e:  # network / auth
            if account := _account_problem(e):
                raise ProviderError(account, status=403, provider="fal") from e
            raise RetryableProviderError(f"fal upload failed: {e}", provider="fal") from e
        self._uploads[h] = url
        return url

    def run(self, endpoint: str, args: dict[str, Any], on_tick: Callable[[float], bool] | None = None,
            on_request: Callable[[str], None] | None = None, resume_request_id: str | None = None,
            poll_s: float = 3.0, timeout_s: float = 1800.0) -> dict[str, Any]:
        fc = self._fc
        try:
            if resume_request_id:
                rid = resume_request_id
            else:
                rid = self.client.submit(endpoint, arguments=args).request_id
                if on_request:
                    on_request(rid)
            start = time.time()
            while True:
                st = self.client.status(endpoint, rid)
                if isinstance(st, fc.Completed):
                    break
                elapsed = time.time() - start
                if elapsed > timeout_s:
                    raise RetryableProviderError("fal request timed out", provider="fal")
                if on_tick and on_tick(elapsed) is False:
                    try:
                        self.client.cancel(endpoint, rid)
                    finally:
                        raise ProviderError("cancelled", provider="fal")
                time.sleep(poll_s)
            return self.client.result(endpoint, rid)
        except ProviderError:
            raise
        except Exception as e:
            raise _classify(e) from e

    @staticmethod
    def download(url: str) -> bytes:
        r = httpx.get(url, timeout=600, follow_redirects=True)
        if r.status_code >= 400:
            raise RetryableProviderError(f"download failed HTTP {r.status_code}", provider="fal")
        return r.content


def _account_problem(e: Exception) -> str:
    """fal answers 403 'User is locked. Reason: Exhausted balance' when the account is out of credit. Retrying cannot
    help, so this is reported plainly and the chain moves on to the next engine."""
    resp = getattr(e, "response", None)
    body = ""
    try:
        body = resp.text if resp is not None else ""
    except Exception:
        pass
    text = f"{e} {body}".lower()
    if "exhausted balance" in text or "user is locked" in text or ("insufficient" in text and "balance" in text):
        return "fal.ai balance is used up: top up at fal.ai/dashboard/billing (fal engines are unavailable until then)"
    return ""


def _classify(e: Exception) -> ProviderError:
    if account := _account_problem(e):
        return ProviderError(account, status=403, provider="fal")
    msg = str(e)
    status = getattr(getattr(e, "response", None), "status_code", None) or getattr(e, "status_code", None)
    low = msg.lower()
    if any(w in low for w in ("content policy", "nsfw", "safety", "moderation", "not allowed", "blocked")):
        return ProviderBlocked(f"fal: {msg[:400]}", provider="fal")
    if status in (408, 429, 500, 502, 503, 504) or any(w in low for w in ("timeout", "temporarily", "connection")):
        return RetryableProviderError(f"fal: {msg[:400]}", status=status, provider="fal")
    return ProviderError(f"fal: {msg[:400]}", status=status, provider="fal")
