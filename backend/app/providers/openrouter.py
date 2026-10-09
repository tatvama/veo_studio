"""OpenRouter: one key, pay per use, for many video models (Seedance, Kling, Wan, Veo, Hailuo, Grok …) and text models.

Video is an asynchronous job: POST /videos, poll GET /videos/{id}, then download GET /videos/{id}/content.
Input images go in as links (a temporary link into our bucket; a data URI without one).
The video catalog (GET /videos/models, public) lists each model's durations, resolutions, aspect ratios, which
frames it takes, and its prices, so new models show up in the Model Hub without a code change.
"""
from __future__ import annotations

import base64
import json
import re
import time
from datetime import datetime, timezone
from typing import Any, Callable

import httpx

from .base import (ProviderBlocked, ProviderError, ProviderNotConfigured, ProviderOutOfCredit, RetryableProviderError,
                   raise_for_status)
from .links import looks_blocked

BASE = "https://openrouter.ai/api/v1"
P = "openrouter"

# ── catalog and prices ───────────────────────────────────────────────────────

# output pixels per resolution; token-priced models (Seedance) bill about width × height × 24 fps / 1024 per second
PIXELS = {"480p": 864 * 480, "720p": 1280 * 720, "768p": 1366 * 768, "1080p": 1920 * 1080, "2k": 2560 * 1440,
          "4k": 3840 * 2160}
RESOLUTIONS = ("480p", "720p", "1080p", "4k")
_RES = re.compile(r"_(480p|720p|768p|1080p|2k|4k)(?=_|$)")
# prices for inputs or options the studio doesn't send
_SKIP = ("without_audio", "with_video_input", "continuation", "reference", "image_input", "minimum", "megapixel",
         "text_to_video")
# models known to take reference images (the catalog has no field for it yet)
_REFS = re.compile(r"seedance-2|veo-3\.1(-fast)?$|kling-video-o|hailuo-3")
_SOUND = re.compile(r"veo|seedance-2|grok-imagine|wan-(2\.[6-9]|3)|kling-v3|happyhorse|hailuo-3|heygen")


def tokens_per_second(res: str) -> float:
    return PIXELS.get(res, PIXELS["720p"]) * 24 / 1024


def price_table(skus: dict[str, Any] | None, resolutions: list[str] | None = None) -> dict[str, float]:
    """USD per second of video by resolution (plus "default"), read from a model's pricing SKUs.
    Prices with sound are preferred (the studio asks for sound); otherwise a resolution's own price beats the default."""
    per_s: dict[str, tuple[int, float]] = {}
    per_tok: dict[str, tuple[int, float]] = {}
    for k, v in (skus or {}).items():
        key = str(k).lower()
        try:
            val = float(v)
        except (TypeError, ValueError):
            continue
        if any(w in key for w in _SKIP):
            continue
        m = _RES.search(key)
        res = {"768p": "720p", "2k": "1080p"}.get(m.group(1), m.group(1)) if m else "default"
        rank = 2 if "with_audio" in key else 1
        if key.startswith("cents_"):
            target, usd = per_s, val / 100
        elif key.startswith("video_tokens"):
            target, usd = per_tok, val
        elif "duration_seconds" in key:
            target, usd = per_s, val
        else:
            continue
        if res not in target or rank > target[res][0]:
            target[res] = (rank, usd)
    def pick(table: dict[str, tuple[int, float]], res: str) -> tuple[int, float] | None:
        own, default = table.get(res), table.get("default")
        if own and default and default[0] > own[0]:
            return default  # e.g. Kling: per-resolution prices are without sound, the default is with sound
        return own or default

    low = [str(r).lower() for r in resolutions or []]  # the catalog writes "4K"
    wanted = [r for r in RESOLUTIONS if not low or r in low]
    out: dict[str, float] = {}
    for res in (*wanted, "default"):
        s = pick(per_s, res)
        t = pick(per_tok, res)
        if s:
            out[res] = round(s[1], 5)
        elif t:
            out[res] = round(t[1] * tokens_per_second(res if res != "default" else "720p"), 5)
    return out


def model_row(m: dict[str, Any]) -> dict[str, Any]:
    """AIModel fields for one entry of GET /videos/models."""
    mid = str(m["id"])
    frames = set(m.get("supported_frame_images") or [])
    durations = sorted(int(d) for d in (m.get("supported_durations") or []))
    skus = m.get("pricing_skus") or {}
    modes: list[str] = []
    if durations:
        modes.append("t2v")
        if "first_frame" in frames:
            modes.append("i2v")
        if {"first_frame", "last_frame"} <= frames:
            modes.append("flf")
        if _REFS.search(mid) or any("reference" in str(k) for k in skus):
            modes.append("ref2v")
    sound = bool(_SOUND.search(mid)) or any("audio" in str(k) for k in skus)
    table = price_table(skus, m.get("supported_resolutions"))
    caps: dict[str, Any] = {
        "modes": sorted(modes), "durations": durations, "aspects": m.get("supported_aspect_ratios") or [],
        "resolutions": [r for r in (m.get("supported_resolutions") or [])], "native_audio": sound,
        "speech_in_video": sound and bool(durations), "max_refs": 3 if "ref2v" in modes else 0, "audio_driven": False,
        "lora_input": False, "lipsync_to_audio": False, "usable": bool(durations), "price_by_resolution": table,
    }
    if not durations:  # editing, upscaling and avatar models take inputs the studio doesn't send them yet
        caps["why_not"] = "Takes a video or avatar input the studio doesn't send yet"
    name = str(m.get("name") or mid)
    short = name.split(": ", 1)[-1]
    created = m.get("created")
    return {
        "id": f"openrouter:{mid}", "provider": P, "endpoint": mid, "display_name": f"{short} (OpenRouter)",
        "family": short, "maker": mid.split("/")[0], "description": str(m.get("description") or ""),
        "category": "text-to-video" if durations else "video-to-video", "task": "video" if durations else "other",
        "capabilities": caps, "thumbnail_url": "",
        "released_at": datetime.fromtimestamp(created, timezone.utc).strftime("%Y-%m-%d") if created else "",
        "price_usd": table.get("720p") or table.get("default") or (next(iter(table.values())) if table else None),
        "price_unit": "second",
    }


def list_video_models(http: httpx.Client | None = None) -> list[dict[str, Any]]:
    """The video catalog (no key needed)."""
    own = http is None
    http = http or httpx.Client(timeout=60)
    try:
        r = http.get(f"{BASE}/videos/models")
        _check(r)
        d = r.json()
        return list(d.get("data") if isinstance(d, dict) else d or [])
    except httpx.HTTPError as e:
        raise RetryableProviderError(f"OpenRouter catalog: {e}", provider=P) from e
    finally:
        if own:
            http.close()


# image models (Nano Banana, Seedream …): extra routes for the keyframe and character-image chain
_NUM = re.compile(r"^\d+(\.\d+)?$")


def _image_price(pricing: Any) -> float | None:
    """USD per image from an image model's pricing, when it states one ("image", "per_image", "image_output" …)."""
    if not isinstance(pricing, dict):
        return None
    for k, v in pricing.items():
        key = str(k).lower()
        if "image" in key and "input" not in key and "token" not in key and _NUM.match(str(v).strip() or "x"):
            val = float(v)
            if val > 0:
                return round(val / 100 if key.startswith("cents") else val, 5)
    return None


IMAGE_TOKENS = 1290  # output tokens of one 1K image on token-priced image models (Nano Banana)


def image_model_row(m: dict[str, Any]) -> dict[str, Any]:
    """AIModel fields for one image model (GET /images/models, or /models filtered to image output)."""
    mid = str(m["id"])
    arch = m.get("architecture") or {}
    inputs = {str(x).lower() for x in (arch.get("input_modalities") or m.get("input_modalities") or ["text"])}
    params = m.get("supported_parameters") or {}
    if isinstance(params, list):  # the general model list writes them as names
        params = {str(x): {} for x in params}
    refs = params.get("input_references") or {}
    max_refs = int(refs.get("max") or 0) if isinstance(refs, dict) and refs.get("max") is not None else (
        8 if "image" in inputs or "input_references" in params else 0)
    aspects = (params.get("aspect_ratio") or {}).get("values") if isinstance(params.get("aspect_ratio"), dict) else None
    name = str(m.get("name") or mid)
    short = name.split(": ", 1)[-1]
    created = m.get("created")
    price = _image_price(m.get("pricing")) or _image_price(m.get("pricing_skus"))
    return {
        "id": f"openrouter:{mid}", "provider": P, "endpoint": mid, "display_name": f"{short} (OpenRouter)",
        "family": short, "maker": mid.split("/")[0], "description": str(m.get("description") or ""),
        "category": "text-to-image", "task": "image",
        "capabilities": {"modes": ["t2i", "i2i"] if max_refs else ["t2i"], "max_refs": max_refs,
                         "aspects": list(aspects or m.get("supported_aspect_ratios") or []), "usable": True},
        "thumbnail_url": "",
        "released_at": datetime.fromtimestamp(created, timezone.utc).strftime("%Y-%m-%d") if isinstance(created, (int, float)) else "",
        "price_usd": price, "price_unit": "image",
    }


def image_price(mid: str, http: httpx.Client | None = None) -> float | None:
    """USD per output image from the model's endpoints (the cheapest provider's base price; a token price counts a
    1K image). None when it can't be read."""
    own = http is None
    http = http or httpx.Client(timeout=20)
    try:
        r = http.get(f"{BASE}/images/models/{mid}/endpoints")
        if r.status_code >= 400:
            return None
        best: float | None = None
        for ep in (r.json() or {}).get("endpoints") or []:
            for p in ep.get("pricing") or []:
                if p.get("billable") != "output_image" or p.get("variant") or p.get("cost_usd") is None:
                    continue
                usd = float(p["cost_usd"]) * (IMAGE_TOKENS if p.get("unit") == "token" else 1)
                best = usd if best is None else min(best, usd)
        return round(best, 5) if best is not None else None
    except (httpx.HTTPError, ValueError, TypeError):
        return None
    finally:
        if own:
            http.close()


def list_image_models(http: httpx.Client | None = None) -> list[dict[str, Any]]:
    """Image models: the image catalog, else the model list filtered to image output (no key needed)."""
    own = http is None
    http = http or httpx.Client(timeout=60)
    try:
        for path, params in (("/images/models", None), ("/models", {"output_modalities": "image"})):
            try:
                r = http.get(f"{BASE}{path}", params=params)
            except httpx.HTTPError as e:
                raise RetryableProviderError(f"OpenRouter image catalog: {e}", provider=P) from e
            if r.status_code == 404:
                continue
            _check(r)
            d = r.json()
            items = list(d.get("data") if isinstance(d, dict) else d or [])
            out = [x for x in items if isinstance(x, dict) and x.get("id")]
            if path == "/models":  # keep models that really make images
                out = [x for x in out if "image" in [str(v).lower() for v in
                                                     ((x.get("architecture") or {}).get("output_modalities") or [])]]
            return out
        return []
    finally:
        if own:
            http.close()


# ── errors ───────────────────────────────────────────────────────────────────

def _message(r: httpx.Response) -> str:
    try:
        body = r.json()
    except ValueError:
        return r.text[:400]
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        meta = err.get("metadata") or {}
        extra = meta.get("reasons") or meta.get("raw") or ""
        return f"{err.get('message') or ''} {extra if isinstance(extra, str) else json.dumps(extra)[:300]}".strip()
    return str(err or body)[:400]


def _check(r: httpx.Response) -> None:
    if r.status_code < 400:
        return
    msg = _message(r)
    if r.status_code == 402:
        raise ProviderOutOfCredit("OpenRouter credit is used up: add credit at openrouter.ai/settings/credits "
                                  f"(OpenRouter engines are skipped until then). {msg}"[:400], status=402, provider=P)
    if r.status_code == 401:
        raise ProviderError(f"OpenRouter rejected the API key: check it in Settings → AI services. {msg}"[:400],
                            status=401, provider=P)
    if r.status_code in (400, 403, 422) and looks_blocked(msg):
        raise ProviderBlocked(f"OpenRouter: blocked by the model's safety filter: {msg}"[:400], status=r.status_code,
                              provider=P)
    raise_for_status(r, "OpenRouter")


def _failed(job: dict[str, Any]) -> ProviderError:
    err = job.get("error")
    msg = err.get("message") if isinstance(err, dict) else str(err or job.get("status") or "failed")
    text = f"OpenRouter video {job.get('status', 'failed')}: {msg}"[:400]
    if looks_blocked(msg):
        return ProviderBlocked(text, provider=P)
    return ProviderError(text, provider=P)


# ── client ───────────────────────────────────────────────────────────────────

class OpenRouterClient:
    def __init__(self, key: str, http: httpx.Client | None = None, referer: str = ""):
        if not key:
            raise ProviderNotConfigured("No OpenRouter API key. Add it in Settings → AI services", provider=P)
        self.http = http or httpx.Client(timeout=httpx.Timeout(120.0, connect=20.0), follow_redirects=True)
        self.headers = {"Authorization": f"Bearer {key}", "X-Title": "Tatvam AI Studio"}
        if referer:
            self.headers["HTTP-Referer"] = referer

    def _req(self, method: str, path: str, **kw) -> httpx.Response:
        try:
            r = self.http.request(method, f"{BASE}{path}", headers=self.headers, **kw)
        except httpx.TimeoutException as e:
            raise RetryableProviderError(f"OpenRouter timed out ({path})", provider=P) from e
        except httpx.TransportError as e:
            raise RetryableProviderError(f"OpenRouter connection failed: {e}", provider=P) from e
        _check(r)
        return r

    # video
    def start_video(self, body: dict[str, Any]) -> str:
        d = self._req("POST", "/videos", json=body).json()
        if not d.get("id"):
            raise ProviderError(f"OpenRouter returned no job id: {str(d)[:200]}", provider=P)
        return str(d["id"])

    def video(self, vid: str) -> dict[str, Any]:
        return self._req("GET", f"/videos/{vid}").json()

    def wait_video(self, vid: str, on_tick: Callable[[float], bool] | None = None, poll_s: float = 5.0,
                   timeout_s: float = 1800.0) -> dict[str, Any]:
        start = time.time()
        while True:
            job = self.video(vid)
            status = str(job.get("status") or "")
            if status == "completed":
                return job
            if status in ("failed", "cancelled", "expired"):
                raise _failed(job)
            elapsed = time.time() - start
            if elapsed > timeout_s:
                raise RetryableProviderError("OpenRouter video timed out", provider=P)
            if on_tick and on_tick(elapsed) is False:
                raise ProviderError("cancelled", provider=P)
            time.sleep(poll_s)

    def download_video(self, vid: str, index: int = 0) -> bytes:
        r = self._req("GET", f"/videos/{vid}/content", params={"index": index}, timeout=600)
        if not r.content:
            raise RetryableProviderError("OpenRouter returned an empty video", provider=P)
        return r.content

    # images
    def image(self, model: str, prompt: str, refs: list[str], aspect: str = "", seed: int | None = None
              ) -> tuple[bytes, str, float | None]:
        """One image: (bytes, mime type, billed USD or None). The image API first; a model it doesn't serve is asked
        through chat completions with image output instead."""
        body: dict[str, Any] = {"model": model, "prompt": prompt, "n": 1}
        if aspect:
            body["aspect_ratio"] = aspect
        if refs:
            body["input_references"] = [{"type": "image_url", "image_url": {"url": u}} for u in refs]
        if seed is not None:
            body["seed"] = seed
        try:
            r = self.http.request("POST", f"{BASE}/images", headers=self.headers, json=body, timeout=300)
        except httpx.TimeoutException as e:
            raise RetryableProviderError("OpenRouter timed out (images)", provider=P) from e
        except httpx.TransportError as e:
            raise RetryableProviderError(f"OpenRouter connection failed: {e}", provider=P) from e
        if r.status_code not in (404, 405):
            _check(r)
            d = r.json()
            item = (d.get("data") or [{}])[0]
            cost = (d.get("usage") or {}).get("cost")
            billed = float(cost) if cost is not None else None
            if item.get("b64_json"):
                return base64.b64decode(item["b64_json"]), str(item.get("media_type") or "image/png"), billed
            if item.get("url"):
                return (*self._fetch_image(item["url"]), billed)
            raise ProviderError(f"OpenRouter returned no image: {str(d)[:200]}", provider=P)
        return self._chat_image(model, prompt, refs, aspect)

    def _chat_image(self, model: str, prompt: str, refs: list[str], aspect: str) -> tuple[bytes, str, float | None]:
        content: Any = prompt
        if refs:
            content = [{"type": "text", "text": prompt}] + [{"type": "image_url", "image_url": {"url": u}} for u in refs]
        body: dict[str, Any] = {"model": model, "messages": [{"role": "user", "content": content}],
                                "modalities": ["image", "text"]}
        if aspect:
            body["image_config"] = {"aspect_ratio": aspect}
        d = self._req("POST", "/chat/completions", json=body, timeout=300).json()
        msg = ((d.get("choices") or [{}])[0].get("message") or {})
        images = msg.get("images") or []
        url = ""
        if images and isinstance(images[0], dict):
            iu = images[0].get("image_url") or images[0].get("imageUrl") or {}
            url = iu.get("url", "") if isinstance(iu, dict) else str(iu)
        if not url:
            raise ProviderError(f"OpenRouter returned no image ({str(msg.get('content') or d)[:200]})", provider=P)
        cost = (d.get("usage") or {}).get("cost")
        data, mime = self._fetch_image(url)
        return data, mime, float(cost) if cost is not None else None

    def _fetch_image(self, url: str) -> tuple[bytes, str]:
        if url.startswith("data:"):
            head, _, b64 = url.partition(",")
            return base64.b64decode(b64), head[5:].split(";")[0] or "image/png"
        try:
            r = self.http.get(url, timeout=120)
        except httpx.HTTPError as e:
            raise RetryableProviderError(f"OpenRouter image download failed: {e}", provider=P) from e
        if r.status_code >= 400 or not r.content:
            raise RetryableProviderError(f"OpenRouter image download failed HTTP {r.status_code}", provider=P)
        return r.content, r.headers.get("content-type", "image/png").split(";")[0]

    # account
    def balance(self) -> dict[str, Any]:
        """What this key may still spend: {"usd": float | None, "limit_usd", "credits_usd", "usage_usd"}.
        The key's own spending limit always; the account's credit too when the key may read it (a management key)."""
        out: dict[str, Any] = {"usd": None, "limit_usd": None, "credits_usd": None, "usage_usd": None}
        info = (self._req("GET", "/key").json() or {}).get("data") or {}
        if info.get("limit_remaining") is not None:
            out["limit_usd"] = float(info["limit_remaining"])
        if info.get("usage") is not None:
            out["usage_usd"] = float(info["usage"])
        try:
            r = self.http.get(f"{BASE}/credits", headers=self.headers, timeout=30)
            if r.status_code < 400:
                c = (r.json() or {}).get("data") or {}
                if c.get("total_credits") is not None:
                    out["credits_usd"] = round(float(c["total_credits"]) - float(c.get("total_usage") or 0), 4)
        except (httpx.HTTPError, ValueError):
            pass  # a normal key can't read the account's credit; the key limit (if any) still counts
        known = [v for v in (out["limit_usd"], out["credits_usd"]) if v is not None]
        out["usd"] = min(known) if known else None
        return out

    # text
    def chat_json(self, model: str, system: str, content: Any, schema: dict[str, Any],
                  temperature: float | None = None) -> tuple[Any, tuple[int, int, float | None]]:
        body: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "result", "strict": False, "schema": schema}},
        }
        if temperature is not None:
            body["temperature"] = temperature
        d = self._req("POST", "/chat/completions", json=body, timeout=300).json()
        if d.get("error"):
            raise ProviderError(f"OpenRouter: {d['error']}"[:400], provider=P)
        msg = ((d.get("choices") or [{}])[0].get("message") or {})
        text = msg.get("content") or ""
        if isinstance(text, list):
            text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
        u = d.get("usage") or {}
        usage = (int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0),
                 float(u["cost"]) if u.get("cost") is not None else None)
        try:
            return json.loads(text[text.find("{"): text.rfind("}") + 1] if "{" in text else text), usage
        except ValueError as e:
            raise RetryableProviderError(f"OpenRouter answer was not JSON: {text[:200]}", provider=P) from e
