from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Usage:
    provider: str
    model: str
    kind: str
    units: float
    unit_type: str
    usd: float
    mock: bool = False


@dataclass
class MediaResult:
    data: bytes
    ext: str
    usage: Usage
    duration_s: float = 0.0
    remote_ref: str = ""
    interaction_id: str = ""
    meta: dict[str, Any] = field(default_factory=dict)


class ProviderError(Exception):
    retryable = False

    def __init__(self, message: str, *, status: int | None = None, provider: str = "", retry_after: float | None = None):
        super().__init__(message)
        self.status = status
        self.provider = provider
        self.retry_after = retry_after  # seconds, when the provider said how long to wait

    @property
    def rate_limited(self) -> bool:
        return self.status == 429


class RetryableProviderError(ProviderError):
    retryable = True


class ProviderBlocked(ProviderError):
    """Safety filter / policy block. Never retried automatically; not charged by Google."""


class ProviderNotConfigured(ProviderError):
    pass


class ProviderOutOfCredit(ProviderError):
    """The account has no credit or balance left. The router skips that provider for a while (core/credit.py)."""


class NeedsApproval(ProviderError):
    """A fallback engine would cost more than the job was approved for: the job waits for someone to approve it."""

    def __init__(self, message: str, *, extra_usd: float, engine: str = "", provider: str = ""):
        super().__init__(message, provider=provider)
        self.extra_usd = extra_usd
        self.engine = engine


def _seconds(v: Any) -> float | None:
    try:
        return float(str(v).strip().rstrip("s")) if v not in (None, "") else None
    except ValueError:
        return None


def _quota_details(body: dict) -> tuple[str, float | None]:
    """Google puts the exhausted quota and the wait in error.details (QuotaFailure, RetryInfo)."""
    err = body.get("error") if isinstance(body.get("error"), dict) else {}
    notes, retry = [], None
    for d in err.get("details") or []:
        kind = str(d.get("@type", ""))
        if kind.endswith("QuotaFailure"):
            for v in d.get("violations") or []:
                name = v.get("quotaId") or v.get("quotaMetric") or ""
                notes.append(f"{name} (limit {v['quotaValue']})" if v.get("quotaValue") else name)
        elif kind.endswith("RetryInfo"):
            retry = _seconds(d.get("retryDelay"))
    return "; ".join(n for n in notes if n), retry


def raise_for_status(resp, provider: str) -> None:
    if resp.status_code < 400:
        return
    retry_after = _seconds(resp.headers.get("retry-after"))
    quota = ""
    try:
        body = resp.json()
        msg = body.get("error", {}).get("message") if isinstance(body.get("error"), dict) else None
        msg = msg or body.get("message") or body.get("detail") or resp.text[:500]
        if isinstance(msg, (dict, list)):
            msg = str(msg)
        if isinstance(body, dict):
            quota, hint = _quota_details(body)
            retry_after = hint or retry_after
    except Exception:
        msg = resp.text[:500]
    # the exhausted quota and wait go first, so they survive when the message is cut short in the UI
    extra = "".join([f" [quota: {quota}]" if quota else "", f" [retry in {retry_after:g}s]" if retry_after else ""])
    text = f"{provider} HTTP {resp.status_code}{extra}: {msg}"
    if resp.status_code in (408, 409, 425, 429, 500, 502, 503, 504):
        raise RetryableProviderError(text, status=resp.status_code, provider=provider, retry_after=retry_after)
    low = str(msg).lower()
    if any(w in low for w in ("safety", "blocked", "policy", "prohibited", "responsible ai")):
        raise ProviderBlocked(text, status=resp.status_code, provider=provider)
    raise ProviderError(text, status=resp.status_code, provider=provider)
