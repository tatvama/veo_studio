"""USD→INR display rate for the cost figures.

Spend is tracked in USD (that is what Google and fal.ai bill in); the UI can show rupees next to it. The rate comes from
keyless public sources, is cached in memory for a short while and kept on disk, so a restart or an outage still has
the last good number. It is for display only: it never changes what is charged or what a budget cap means.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from ..config import get_settings

log = logging.getLogger("rates")

REFRESH_S = 15 * 60  # how long a fetched rate is reused before asking again
RETRY_S = 60  # after a failed refresh, wait this long before trying again
SANE = (20.0, 400.0)  # reject nonsense (a bad payload must not turn $1 into ₹0.01)
_lock = threading.Lock()
_state: dict[str, Any] = {"rate": None, "as_of": None, "fetched": 0.0, "source": None, "next_try": 0.0}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _er_api(c: httpx.Client) -> tuple[float, str]:
    d = c.get("https://open.er-api.com/v6/latest/USD").json()
    ts = d.get("time_last_update_unix")
    return float(d["rates"]["INR"]), datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else _now()


def _frankfurter(c: httpx.Client) -> tuple[float, str]:
    d = c.get("https://api.frankfurter.dev/v1/latest", params={"base": "USD", "symbols": "INR"}).json()
    return float(d["rates"]["INR"]), f"{d['date']}T00:00:00+00:00"


SOURCES = (("open.er-api.com", _er_api), ("frankfurter.dev", _frankfurter))


def _file():
    return get_settings().data_root / "usd_inr.json"


def _load_disk() -> None:
    try:
        d = json.loads(_file().read_text(encoding="utf-8"))
        if SANE[0] < float(d["rate"]) < SANE[1]:
            _state.update(rate=float(d["rate"]), as_of=d["as_of"], source=d["source"], fetched=0.0)
    except (OSError, ValueError, KeyError):
        pass


def _fetch() -> None:
    """Try each source in turn; keep the first sane answer."""
    with httpx.Client(timeout=6, headers={"User-Agent": "tatvam-studio/1.0"}, follow_redirects=True) as c:
        for name, fn in SOURCES:
            try:
                rate, as_of = fn(c)
            except Exception as e:  # network, bad JSON, missing key: try the next source
                log.warning("USD→INR from %s failed: %s", name, e)
                continue
            if SANE[0] < rate < SANE[1]:
                _state.update(rate=rate, as_of=as_of, source=name, fetched=time.time(), next_try=time.time() + REFRESH_S)
                try:
                    _file().write_text(json.dumps({"rate": rate, "as_of": as_of, "source": name}), encoding="utf-8")
                except OSError:
                    pass
                return
    _state["next_try"] = time.time() + RETRY_S


def usd_inr() -> dict[str, Any]:
    """The current rate: pinned by USD_INR_RATE, else live (cached), else the last good one marked stale, else none."""
    pinned = get_settings().usd_inr_rate
    if pinned and SANE[0] < pinned < SANE[1]:
        return {"base": "USD", "rates": {"INR": pinned}, "as_of": _now(), "source": "pinned", "stale": False}
    with _lock:
        if _state["rate"] is None and not _state["fetched"]:
            _load_disk()
        if time.time() >= _state["next_try"]:
            _fetch()
        rate = _state["rate"]
        fresh = bool(_state["fetched"]) and time.time() - _state["fetched"] < REFRESH_S * 2
        return {"base": "USD", "rates": {"INR": rate} if rate else {}, "as_of": _state["as_of"], "source": _state["source"],
                "stale": bool(rate) and not fresh}


def reset_for_tests() -> None:
    _state.update(rate=None, as_of=None, fetched=0.0, source=None, next_try=0.0)
