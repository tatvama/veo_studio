"""Shared provider back-off, so the queue follows each provider's allocated rate.

One rate-limit answer (HTTP 429) pauses that provider for every job, instead of each queued job hitting the same
limit and burning its retries. Google also caps paid spend per rolling 10-minute window (Tier 1: $10); Veo calls
are held back before they would cross it.
"""
from __future__ import annotations

import threading
import time
from datetime import timedelta

from ..config import get_settings
from ..db import SessionLocal, utcnow

_lock = threading.Lock()
_until: dict[str, float] = {}  # provider -> epoch seconds when calls may resume
_strikes: dict[str, int] = {}  # consecutive rate limits without a success in between
_pending: dict[int, tuple[float, float]] = {}  # Google calls in flight: token -> (usd, epoch started)
_next_token = 0

# AIModel.provider -> provider name used by errors and the cost ledger
LEDGER_NAME = {"google": "gemini"}
SPEND_WINDOW = timedelta(minutes=10)


def _key(provider: str) -> str:
    return LEDGER_NAME.get(provider, provider)


def cool(provider: str, retry_after: float | None = None) -> float:
    """Record a rate limit. Uses the provider's own retry hint, else 60 s doubling per strike (max 15 min).
    Returns the seconds until calls may resume."""
    p = _key(provider)
    with _lock:
        # jobs that were already in flight when the limit hit report it too: that is the same strike, not a new one
        strikes = _strikes.get(p, 0) + (0 if _until.get(p, 0.0) > time.time() else 1)
        strikes = max(strikes, 1)
        _strikes[p] = strikes
        wait = retry_after if retry_after and retry_after > 0 else min(60 * 2 ** (strikes - 1), 900)
        _until[p] = max(_until.get(p, 0.0), time.time() + wait)
        return _until[p] - time.time()


def ok(provider: str) -> None:
    """A call went through: forget earlier strikes."""
    with _lock:
        _strikes.pop(_key(provider), None)


def cooling(provider: str) -> float:
    """Seconds until this provider may be called again (0 = now)."""
    with _lock:
        return max(0.0, _until.get(_key(provider), 0.0) - time.time())


def in_flight() -> float:
    """USD of Google calls started but not yet billed (they count against the window too)."""
    now = time.time()
    with _lock:
        for k in [k for k, (_, t) in _pending.items() if now - t > SPEND_WINDOW.total_seconds()]:
            _pending.pop(k, None)
        return sum(u for u, _ in _pending.values())


def reserve(usd: float) -> int:
    global _next_token
    with _lock:
        _next_token += 1
        _pending[_next_token] = (usd, time.time())
        return _next_token


def release(token: int | None) -> None:
    if token:
        with _lock:
            _pending.pop(token, None)


def google_spend_wait(estimate_usd: float) -> float:
    """Seconds to hold a Google call so spend in the rolling 10-minute window stays under the tier's cap
    (GEMINI_SPEND_PER_10MIN; 0 turns the check off). Returns 0 when the call fits."""
    cap = get_settings().gemini_spend_per_10min
    if cap <= 0 or estimate_usd <= 0:
        return 0.0
    from sqlalchemy import func

    from ..models import CostEntry

    since = utcnow() - SPEND_WINDOW
    with SessionLocal() as db:
        spent = db.query(func.coalesce(func.sum(CostEntry.usd), 0.0)).filter(
            CostEntry.provider == "gemini", CostEntry.mock.is_(False), CostEntry.created_at > since).scalar() or 0.0
        if spent + in_flight() + estimate_usd <= cap * 0.9:  # keep a 10% margin for estimate error
            return 0.0
        oldest = db.query(func.min(CostEntry.created_at)).filter(
            CostEntry.provider == "gemini", CostEntry.mock.is_(False), CostEntry.created_at > since).scalar()
    if not oldest:
        return 60.0 if in_flight() else 0.0  # only calls in flight: wait for them to finish
    return max(15.0, (oldest + SPEND_WINDOW - utcnow()).total_seconds())
