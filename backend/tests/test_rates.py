"""The USD→INR display rate: source fallback, sanity limits, stale marking, disk memory, pinning."""
from __future__ import annotations

import pytest

from app.config import get_settings
from app.core import rates

from conftest import H


def _boom(c):
    raise RuntimeError("down")


@pytest.fixture(autouse=True)
def _clean(monkeypatch, tmp_path):
    rates.reset_for_tests()
    monkeypatch.setattr(rates, "_file", lambda: tmp_path / "usd_inr.json")
    yield
    rates.reset_for_tests()


def test_first_source_wins(monkeypatch):
    monkeypatch.setattr(rates, "SOURCES", (("a", lambda c: (96.5, "2026-10-09T00:00:00+00:00")), ("b", lambda c: (1.0, "x"))))
    out = rates.usd_inr()
    assert out["rates"] == {"INR": 96.5} and out["source"] == "a" and out["stale"] is False


def test_falls_through_failing_and_insane_sources(monkeypatch):
    monkeypatch.setattr(rates, "SOURCES", (("a", _boom), ("b", lambda c: (0.01, "x")), ("c", lambda c: (97.2, "2026-10-09T00:00:00+00:00"))))
    out = rates.usd_inr()
    assert out["rates"]["INR"] == 97.2 and out["source"] == "c"


def test_outage_keeps_last_good_rate_and_marks_it_stale(monkeypatch):
    monkeypatch.setattr(rates, "SOURCES", (("a", lambda c: (96.0, "2026-10-09T00:00:00+00:00")),))
    assert rates.usd_inr()["rates"]["INR"] == 96.0
    monkeypatch.setattr(rates, "SOURCES", (("a", _boom),))
    rates._state["next_try"] = 0.0
    rates._state["fetched"] -= rates.REFRESH_S * 3
    out = rates.usd_inr()
    assert out["rates"]["INR"] == 96.0 and out["stale"] is True


def test_nothing_ever_answered_gives_empty_rates(monkeypatch):
    monkeypatch.setattr(rates, "SOURCES", (("a", _boom),))
    out = rates.usd_inr()
    assert out["rates"] == {} and out["stale"] is False


def test_rate_survives_a_restart_via_disk(monkeypatch):
    monkeypatch.setattr(rates, "SOURCES", (("a", lambda c: (95.5, "2026-10-09T00:00:00+00:00")),))
    rates.usd_inr()
    rates.reset_for_tests()
    monkeypatch.setattr(rates, "SOURCES", (("a", _boom),))
    out = rates.usd_inr()
    assert out["rates"]["INR"] == 95.5 and out["stale"] is True


def test_pinned_rate_overrides(monkeypatch):
    monkeypatch.setattr(get_settings(), "usd_inr_rate", 90.0)
    out = rates.usd_inr()
    assert out["rates"]["INR"] == 90.0 and out["source"] == "pinned"


def test_endpoint(client, monkeypatch):
    monkeypatch.setattr(rates, "SOURCES", (("a", lambda c: (96.1, "2026-10-09T00:00:00+00:00")),))
    r = client.get("/api/rates", headers=H)
    assert r.status_code == 200 and r.json()["rates"]["INR"] == 96.1


def test_currency_preference_is_saved_and_validated(client):
    r = client.patch("/api/me/prefs", json={"currency": "inr"}, headers=H)
    assert r.status_code == 200 and r.json()["currency"] == "inr"
    assert client.get("/api/me/prefs", headers=H).json()["currency"] == "inr"
    assert client.patch("/api/me/prefs", json={"currency": "euro"}, headers=H).status_code == 422
    client.patch("/api/me/prefs", json={"currency": "both"}, headers=H)
