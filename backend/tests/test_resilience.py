"""Surviving a flaky database link: which errors count as network trouble, retrying safe reads, fewer media lookups."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import exc as sa_exc

from app.api import work
from app.db import is_network_error
from app.middleware import RetryReads


class _Pg8000InterfaceError(Exception):
    pass


_Pg8000InterfaceError.__name__ = "InterfaceError"


def test_network_errors_are_recognised_through_wrappers():
    assert is_network_error(TimeoutError("timed out"))
    assert is_network_error(ConnectionResetError(10054, "An existing connection was forcibly closed by the remote host"))
    wrapped = sa_exc.InterfaceError("SELECT 1", {}, _Pg8000InterfaceError("network error"))
    assert is_network_error(wrapped)
    try:
        try:
            raise TimeoutError("timed out")
        except TimeoutError as inner:
            raise RuntimeError("query failed") from inner
    except RuntimeError as outer:
        assert is_network_error(outer)


def test_data_and_file_errors_are_not_network_errors():
    assert not is_network_error(ValueError("bad value"))
    assert not is_network_error(FileNotFoundError("missing.mp4"))
    assert not is_network_error(sa_exc.IntegrityError("INSERT", {}, Exception("duplicate key value violates unique constraint")))
    assert not is_network_error(None)


def _flaky_app(error: Exception):
    calls = {"n": 0}
    app = FastAPI()
    app.add_middleware(RetryReads, delay_s=0)

    def handler():
        calls["n"] += 1
        if calls["n"] == 1:
            raise error
        return {"ok": True, "calls": calls["n"]}

    app.get("/thing")(handler)
    app.post("/thing")(handler)
    return app, calls


def test_get_is_retried_once_after_a_dropped_connection():
    app, calls = _flaky_app(TimeoutError("timed out"))
    r = TestClient(app).get("/thing")
    assert r.status_code == 200 and r.json()["calls"] == 2 and calls["n"] == 2


def test_writes_are_never_retried():
    app, calls = _flaky_app(TimeoutError("timed out"))
    with pytest.raises(TimeoutError):
        TestClient(app).post("/thing")
    assert calls["n"] == 1


def test_other_errors_are_not_retried():
    app, calls = _flaky_app(ValueError("bug"))
    with pytest.raises(ValueError):
        TestClient(app).get("/thing")
    assert calls["n"] == 1


def test_media_remembers_a_checked_session_for_a_minute(monkeypatch):
    work._MEDIA_AUTH.clear()
    looked_up = {"n": 0}

    def fake_user(db, token):
        looked_up["n"] += 1
        return SimpleNamespace(role="creator") if token == "good" else None

    monkeypatch.setattr(work, "user_from_token", fake_user)
    assert work._media_role(None, "good") == "creator"
    assert work._media_role(None, "good") == "creator"
    assert looked_up["n"] == 1
    assert work._media_role(None, "bad") is None and work._media_role(None, None) is None
    work._MEDIA_AUTH["good"] = (0.0, "creator")  # expired: checked again
    assert work._media_role(None, "good") == "creator" and looked_up["n"] == 3
    work._MEDIA_AUTH.clear()
