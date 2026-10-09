"""BytePlus ModelArk: ByteDance's own models, direct (Seedance video, Seedream images).

Two kinds of access:
* the ModelArk API key (Bearer) runs generations on the data plane:
  POST /contents/generations/tasks, poll GET /contents/generations/tasks/{id}, then download content.video_url;
  POST /images/generations for Seedream.
* the IAM access key + secret (HMAC-SHA256 signed OpenAPI calls) manage the private asset library. The studio
  registers each AI character there once (an "AIGC" group per character, one asset per approved image); Seedance
  then takes the character as `asset://<asset id>` reference images, the sanctioned way to animate consistent
  characters that its real-person filter would otherwise block.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import quote

import httpx

from .base import ProviderBlocked, ProviderError, ProviderNotConfigured, RetryableProviderError
from .links import looks_blocked

P = "byteplus"
ARK_BASE = "https://ark.ap-southeast.bytepluses.com/api/v3"
OPENAPI_HOST = "ark.{region}.byteplusapi.com"
SERVICE = "ark"
VERSION = "2024-01-01"

# Seedance bills tokens ≈ width × height × 24 fps / 1024 per second of output
PIXELS = {"480p": 864 * 480, "720p": 1280 * 720, "1080p": 1920 * 1080}


def tokens_per_second(res: str) -> float:
    return PIXELS.get(res, PIXELS["720p"]) * 24 / 1024


# Seedream sizes around 2K for each aspect ratio
IMAGE_SIZES = {"9:16": "1440x2560", "16:9": "2560x1440", "1:1": "2048x2048", "4:5": "1792x2240", "5:4": "2240x1792",
               "3:4": "1728x2304", "4:3": "2304x1728", "2:3": "1664x2496", "3:2": "2496x1664", "21:9": "3024x1296"}


# ── errors ───────────────────────────────────────────────────────────────────

def _classify(code: str, message: str, status: int | None = None) -> ProviderError:
    text = f"BytePlus{f' HTTP {status}' if status else ''}: {code + ': ' if code else ''}{message}"[:500]
    c = (code or "").lower()
    if "sensitive" in c or "privacy" in c or "risk" in c or looks_blocked(message):
        hint = (" (the image may show a real person: register the character in Characters → BytePlus so Seedance "
                "can use it)") if "privacy" in c or "real" in message.lower() else ""
        return ProviderBlocked(text + hint, status=status, provider=P)
    if status in (408, 425, 429, 500, 502, 503, 504) or any(w in c for w in ("ratelimit", "rate_limit", "throttl",
                                                                               "serveroverloaded", "quotaexceeded")):
        return RetryableProviderError(text, status=429 if status == 429 or "rate" in c else status, provider=P)
    if "overdue" in c or "balance" in message.lower():
        return ProviderError(f"BytePlus account has no balance: top up in the BytePlus console. {message}"[:400],
                             status=status, provider=P)
    if "modelnotopen" in c or "not activated" in message.lower():
        return ProviderError(f"Activate this model in the BytePlus ModelArk console first. {message}"[:400],
                             status=status, provider=P)
    if status in (401, 403) or "authentication" in c or "apikey" in c:
        return ProviderError(f"BytePlus rejected the key: check it in Settings → AI services. {message}"[:400],
                             status=status, provider=P)
    return ProviderError(text, status=status, provider=P)


def _check(r: httpx.Response) -> dict[str, Any]:
    try:
        body = r.json()
    except ValueError:
        body = {}
    if r.status_code < 400 and not (isinstance(body, dict) and body.get("error")):
        return body if isinstance(body, dict) else {"data": body}
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        raise _classify(str(err.get("code") or ""), str(err.get("message") or ""), r.status_code)
    raise _classify("", r.text[:300], r.status_code)


# ── generation (API key) ─────────────────────────────────────────────────────

class ArkClient:
    def __init__(self, key: str, http: httpx.Client | None = None, base: str = ARK_BASE):
        if not key:
            raise ProviderNotConfigured("No BytePlus API key. Add it in Settings → AI services", provider=P)
        self.base = base.rstrip("/")
        self.http = http or httpx.Client(timeout=httpx.Timeout(120.0, connect=20.0), follow_redirects=True)
        self.headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    def _req(self, method: str, path: str, **kw) -> dict[str, Any]:
        try:
            r = self.http.request(method, f"{self.base}{path}", headers=self.headers, **kw)
        except httpx.TimeoutException as e:
            raise RetryableProviderError(f"BytePlus timed out ({path})", provider=P) from e
        except httpx.TransportError as e:
            raise RetryableProviderError(f"BytePlus connection failed: {e}", provider=P) from e
        return _check(r)

    def create_task(self, body: dict[str, Any]) -> str:
        d = self._req("POST", "/contents/generations/tasks", json=body)
        if not d.get("id"):
            raise ProviderError(f"BytePlus returned no task id: {str(d)[:200]}", provider=P)
        return str(d["id"])

    def task(self, tid: str) -> dict[str, Any]:
        return self._req("GET", f"/contents/generations/tasks/{tid}")

    def cancel(self, tid: str) -> None:
        try:
            self._req("DELETE", f"/contents/generations/tasks/{tid}")
        except ProviderError:
            pass  # a running task can't always be cancelled; it then just finishes unused

    def wait_task(self, tid: str, on_tick: Callable[[float], bool] | None = None, poll_s: float = 5.0,
                  timeout_s: float = 1800.0) -> dict[str, Any]:
        start = time.time()
        while True:
            t = self.task(tid)
            status = str(t.get("status") or "")
            if status == "succeeded":
                return t
            if status in ("failed", "cancelled", "expired"):
                err = t.get("error") or {}
                raise _classify(str(err.get("code") or status), str(err.get("message") or f"task {status}"))
            elapsed = time.time() - start
            if elapsed > timeout_s:
                raise RetryableProviderError("BytePlus task timed out", provider=P)
            if on_tick and on_tick(elapsed) is False:
                self.cancel(tid)
                raise ProviderError("cancelled", provider=P)
            time.sleep(poll_s)

    def images(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._req("POST", "/images/generations", json=body, timeout=300)

    def download(self, url: str) -> bytes:
        try:
            r = self.http.get(url, timeout=600)
        except httpx.HTTPError as e:
            raise RetryableProviderError(f"BytePlus download failed: {e}", provider=P) from e
        if r.status_code >= 400 or not r.content:
            raise RetryableProviderError(f"BytePlus download failed HTTP {r.status_code}", provider=P)
        return r.content


# ── asset library (access key + secret) ──────────────────────────────────────

def _q(v: str) -> str:
    return quote(v, safe="-_.~")


def sign(*, access_key: str, secret_key: str, method: str, host: str, query: dict[str, str], payload: bytes,
         region: str, now: datetime, service: str = SERVICE, session_token: str = "") -> dict[str, str]:
    """BytePlus OpenAPI V4 signature (HMAC-SHA256). Returns the headers that authenticate one request."""
    x_date = now.strftime("%Y%m%dT%H%M%SZ")
    short = now.strftime("%Y%m%d")
    body_hash = hashlib.sha256(payload).hexdigest()
    signed = {"host": host, "x-content-sha256": body_hash, "x-date": x_date}
    if method.upper() != "GET":
        signed["content-type"] = "application/json"
    if session_token:
        signed["x-security-token"] = session_token
    names = sorted(signed)
    canonical = "\n".join((
        method.upper(), "/", "&".join(f"{_q(k)}={_q(v)}" for k, v in sorted(query.items())),
        "".join(f"{n}:{signed[n].strip()}\n" for n in names), ";".join(names), body_hash))
    scope = f"{short}/{region}/{service}/request"
    to_sign = "\n".join(("HMAC-SHA256", x_date, scope, hashlib.sha256(canonical.encode()).hexdigest()))
    key = secret_key.encode()
    for part in (short, region, service, "request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    headers = {"Host": host, "X-Date": x_date, "X-Content-Sha256": body_hash,
               "Authorization": f"HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={';'.join(names)}, "
                                f"Signature={signature}"}
    if "content-type" in signed:
        headers["Content-Type"] = "application/json"
    if session_token:
        headers["X-Security-Token"] = session_token
    return headers


class AssetLibrary:
    def __init__(self, iam_key: str, region: str = "ap-southeast-1", project: str = "default",
                 http: httpx.Client | None = None):
        ak, _, sk = (iam_key or "").partition(":")
        if not ak or not sk:
            raise ProviderNotConfigured("No BytePlus access key + secret for the asset library. Add them in Settings → "
                                        "AI services", provider=P)
        self.ak, self.sk, self.region, self.project = ak.strip(), sk.strip(), region, project or "default"
        self.host = OPENAPI_HOST.format(region=region)
        self.http = http or httpx.Client(timeout=httpx.Timeout(60.0, connect=20.0))

    def call(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        query = {"Action": action, "Version": VERSION}
        clean = {k: v for k, v in body.items() if v is not None}
        payload = json.dumps(clean, separators=(",", ":"), ensure_ascii=False).encode()
        headers = sign(access_key=self.ak, secret_key=self.sk, method="POST", host=self.host, query=query,
                       payload=payload, region=self.region, now=datetime.now(timezone.utc))
        headers["Accept"] = "application/json"
        try:
            r = self.http.post(f"https://{self.host}/", params=query, headers=headers, content=payload)
        except httpx.TimeoutException as e:
            raise RetryableProviderError(f"BytePlus asset library timed out ({action})", provider=P) from e
        except httpx.TransportError as e:
            raise RetryableProviderError(f"BytePlus asset library connection failed: {e}", provider=P) from e
        try:
            d = r.json()
        except ValueError:
            d = {}
        err = ((d.get("ResponseMetadata") or {}).get("Error") or {}) if isinstance(d, dict) else {}
        if r.status_code >= 400 or err.get("Code") or err.get("Message"):
            code, msg = str(err.get("Code") or ""), str(err.get("Message") or r.text[:300])
            if r.status_code in (401, 403) or code.startswith(("InvalidAccessKey", "InvalidSecret", "SignatureDoesNotMatch")):
                raise ProviderError(f"BytePlus refused the access key / secret ({code}). Check them, and that the IAM "
                                    f"user has ArkFullAccess on the project. {msg}"[:400], status=r.status_code, provider=P)
            if r.status_code == 429 or code in ("RequestLimitExceeded", "FlowLimitExceeded", "TooManyRequests", "Throttling"):
                raise RetryableProviderError(f"BytePlus asset library is busy ({code}): {msg}"[:300], status=429,
                                             provider=P, retry_after=20)
            raise ProviderError(f"BytePlus {action}: {code} {msg}"[:400], status=r.status_code, provider=P)
        res = d.get("Result") if isinstance(d, dict) else None
        return res if isinstance(res, dict) else {}

    def find_group(self, name: str) -> str | None:
        res = self.call("ListAssetGroups", {"Filter": {"Name": name, "GroupType": "AIGC"}, "MaxResults": 50,
                                            "ProjectName": self.project})
        exact = [g for g in (res.get("Items") or []) if g.get("Name") == name]
        return str(exact[0]["Id"]) if exact else None

    def ensure_group(self, name: str, description: str = "") -> str:
        """The AIGC group for one character (reused when it already exists)."""
        found = self.find_group(name)
        if found:
            return found
        res = self.call("CreateAssetGroup", {"Name": name, "Description": description[:300], "GroupType": "AIGC",
                                             "ProjectName": self.project})
        if not res.get("Id"):
            raise ProviderError("BytePlus created no asset group", provider=P)
        return str(res["Id"])

    def create_asset(self, group_id: str, url: str, name: str) -> str:
        res = self.call("CreateAsset", {"GroupId": group_id, "URL": url, "AssetType": "Image", "Name": name[:100],
                                        "ProjectName": self.project})
        if not res.get("Id"):
            raise ProviderError("BytePlus created no asset", provider=P)
        return str(res["Id"])

    def get_asset(self, asset_id: str) -> dict[str, Any]:
        return self.call("GetAsset", {"Id": asset_id, "ProjectName": self.project})
