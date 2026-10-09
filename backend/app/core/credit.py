"""Spend safety across providers: account balances and "no credit" holds.

* A provider that answered "no credit" (OpenRouter 402, BytePlus overdue) is held for a while: the router skips its
  engines, so jobs go to another route of the same model instead of failing one by one.
* Balances are read where the provider allows it (OpenRouter: the key's limit, and the account credit with a
  management key; BytePlus: the billing API with the access key + secret). A known balance below a clip's price
  skips that route too. An unknown balance never blocks anything.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from .. import settings_store
from ..db import SessionLocal, utcnow
from ..events import emit

HOLD_MINUTES = 30
BALANCE_TTL = timedelta(minutes=10)
METERED = ("openrouter", "byteplus")  # providers whose balance the studio can read


def _parse(ts: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(str(ts).rstrip("Z")) if ts else None
    except ValueError:
        return None


def holds(db: Session) -> dict[str, dict[str, Any]]:
    """Providers held for lack of credit right now: {provider: {until, reason, at}}."""
    now = utcnow()
    return {p: h for p, h in (settings_store.get_setting(db, "credit_holds") or {}).items()
            if (_parse(h.get("until")) or now) > now}


def held(db: Session, provider: str) -> str:
    """Why this provider is skipped ("" when it isn't)."""
    h = holds(db).get(provider)
    return h.get("reason", "no credit") if h else ""


def hold(provider: str, reason: str, minutes: int = HOLD_MINUTES) -> None:
    with SessionLocal() as db:
        all_ = dict(settings_store.get_setting(db, "credit_holds") or {})
        all_[provider] = {"until": (utcnow() + timedelta(minutes=minutes)).isoformat() + "Z", "reason": reason[:300],
                          "at": utcnow().isoformat() + "Z"}
        settings_store.set_setting(db, "credit_holds", all_)
        db.commit()
        emit(db, None, "providers.credit", {"provider": provider, "held": True, "reason": reason[:300]})


def release(db: Session, provider: str | None = None) -> None:
    """Lift the hold (after a top-up, or when a fresh balance shows credit). No commit."""
    all_ = dict(settings_store.get_setting(db, "credit_holds") or {})
    for p in ([provider] if provider else list(all_)):
        all_.pop(p, None)
    settings_store.set_setting(db, "credit_holds", all_)


def _read_balance(provider: str) -> dict[str, Any]:
    from ..config import get_settings
    if provider == "openrouter":
        from ..providers.openrouter import OpenRouterClient
        b = OpenRouterClient(settings_store.api_key("openrouter")).balance()
        return {"usd": b["usd"], "detail": b}
    if provider == "byteplus":
        if not settings_store.api_key("byteplus_iam"):
            return {"usd": None, "error": "Add the BytePlus access key + secret to read the balance"}
        from ..providers.byteplus import AssetLibrary
        s = get_settings()
        lib = AssetLibrary(settings_store.api_key("byteplus_iam"), s.byteplus_region, s.byteplus_project)
        return {"usd": lib.balance()}
    return {"usd": None}


def balance(provider: str, refresh: bool = False) -> dict[str, Any]:
    """The provider's balance as last read: {provider, usd (None = unknown), checked_at, error}. Read again when
    asked or older than ten minutes. Only live providers are asked (mock mode never calls out)."""
    from ..providers.services import provider_mode
    with SessionLocal() as db:
        cache = dict(settings_store.get_setting(db, "credit_balances") or {})
    row = cache.get(provider) or {}
    fresh = (_parse(row.get("checked_at")) or datetime.min) > utcnow() - BALANCE_TTL
    if provider not in METERED or provider_mode(provider) != "live" or (fresh and not refresh):
        return {"provider": provider, "usd": row.get("usd"), "checked_at": row.get("checked_at"),
                "error": row.get("error", ""), "detail": row.get("detail") or {}}
    try:
        got = _read_balance(provider)
        row = {"usd": got.get("usd"), "error": got.get("error", ""), "detail": got.get("detail") or {}}
    except Exception as e:  # an unreadable balance is "unknown", never a reason to stop work
        row = {"usd": None, "error": str(e)[:300], "detail": {}}
    row["checked_at"] = utcnow().isoformat() + "Z"
    with SessionLocal() as db:
        cache = dict(settings_store.get_setting(db, "credit_balances") or {})
        cache[provider] = row
        settings_store.set_setting(db, "credit_balances", cache)
        if row["usd"] is not None and row["usd"] > 0 and held(db, provider):
            release(db, provider)  # topped up
        db.commit()
    if row["usd"] is not None and row["usd"] <= 0:
        hold(provider, f"{provider} balance is ${row['usd']:.2f}")
    return {"provider": provider, **row}


def short_of(provider: str, usd: float) -> str:
    """Why this provider can't pay for a run of `usd` ("" when it can, or when its balance is unknown)."""
    if provider not in METERED or usd <= 0:
        return ""
    b = balance(provider)
    if b["usd"] is not None and b["usd"] < usd:
        return f"{provider} balance ${b['usd']:.2f} is below this run's ${usd:.2f}"
    return ""


def status() -> list[dict[str, Any]]:
    """Balances and holds for the Settings page."""
    with SessionLocal() as db:
        h = holds(db)
    return [{**balance(p), "held": bool(h.get(p)), "hold_reason": (h.get(p) or {}).get("reason", ""),
             "hold_until": (h.get(p) or {}).get("until")} for p in METERED]
