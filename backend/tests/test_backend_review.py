"""Fixes from the backend review: media path normalisation, Google sign-in state, the anonymous health body, index
and foreign-key aware migrations, budget reservations of orchestrators, worker recovery, concat escaping, the
hardware encoder choice, pre-aggregated shot views and the shared event poller."""
from __future__ import annotations

import time
from urllib.parse import parse_qs, urlparse

from conftest import H, ok
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.storage import get_storage

_VIEWER: dict[str, TestClient] = {}


def _viewer(c: TestClient) -> TestClient:
    if not _VIEWER:
        ok(c.post("/api/users", headers=H, json={"email": "review.viewer@test.local", "name": "Vik", "role": "viewer",
                                                 "password": "viewer-pass-123"}))
        o = TestClient(app)  # no lifespan: must not stop the shared worker
        ok(o.post("/api/auth/login", headers=H, json={"email": "review.viewer@test.local", "password": "viewer-pass-123"}))
        _VIEWER["c"] = o
    return _VIEWER["c"]


# ── 1. /media: the private check uses the cleaned storage key ────────────────

def test_media_private_check_uses_the_cleaned_key(client: TestClient):
    st = get_storage()
    st.save_bytes("consents/review_release.pdf", b"%PDF-1.4 signed release")
    st.save_bytes("projects/1/review_open.txt", b"public enough")
    viewer = _viewer(client)
    # a producer (the admin) opens the release, however the path is spelled
    for spelled in ("consents/review_release.pdf", "./consents/review_release.pdf", "/consents//review_release.pdf",
                    "Consents/review_release.pdf"):
        assert client.get(f"/media/{spelled}").status_code == 200, spelled
    # a viewer is refused on every spelling: "." and empty parts are dropped before the folder is looked at
    for spelled in ("consents/review_release.pdf", "./consents/review_release.pdf", "/consents//review_release.pdf",
                    ".//consents/review_release.pdf", "Consents/review_release.pdf", "consents\\review_release.pdf"):
        assert viewer.get(f"/media/{spelled}").status_code == 403, spelled
    assert viewer.get("/media/./projects/1/review_open.txt").status_code == 200
    # invalid keys answer 404 whoever asks (nothing about the file system leaks)
    for bad in ("..%2Fsecret", "projects/../../x", "C:/x.txt"):
        assert client.get(f"/media/{bad}").status_code == 404, bad
        assert viewer.get(f"/media/{bad}").status_code == 404, bad
    anon = TestClient(app)
    assert anon.get("/media/./consents/review_release.pdf").status_code == 401


# ── 2. Google sign-in: states expire and are bound to the browser ────────────

def test_google_state_expires_and_is_bound_to_the_browser(client: TestClient, monkeypatch):
    from app.api import auth

    s = get_settings()
    monkeypatch.setattr(s, "google_client_id", "client-id.apps.googleusercontent.com")
    monkeypatch.setattr(s, "google_client_secret", "secret")
    auth._states.clear()

    browser = TestClient(app)
    r = browser.get("/api/auth/google/start", follow_redirects=False)
    assert r.status_code in (302, 307)
    state = parse_qs(urlparse(r.headers["location"]).query)["state"][0]
    assert state in auth._states and browser.cookies.get(auth.STATE_COOKIE)

    class _Resp:
        def __init__(self, data):
            self._d = data

        def json(self):
            return self._d

    monkeypatch.setattr(auth.httpx, "post", lambda *a, **k: _Resp({"access_token": "tok"}))
    monkeypatch.setattr(auth.httpx, "get", lambda *a, **k: _Resp({"email": "admin@test.local", "email_verified": True, "name": "Admin"}))

    # another browser (no state cookie) presenting a valid state: login CSRF, refused; the state stays usable
    other = TestClient(app)
    assert other.get(f"/api/auth/google/callback?code=abc&state={state}", follow_redirects=False).status_code == 400
    # a stale state is refused and purged
    browser2 = TestClient(app)
    r2 = browser2.get("/api/auth/google/start", follow_redirects=False)
    old_state = parse_qs(urlparse(r2.headers["location"]).query)["state"][0]
    auth._states[old_state] = time.time() - auth.STATE_TTL_S - 1
    assert browser2.get(f"/api/auth/google/callback?code=abc&state={old_state}", follow_redirects=False).status_code == 400
    assert old_state not in auth._states
    # the right browser, the right state: signed in, state used up, state cookie gone
    r = browser.get(f"/api/auth/google/callback?code=abc&state={state}", follow_redirects=False)
    assert r.status_code in (302, 307), r.text
    assert browser.cookies.get(auth.COOKIE) and state not in auth._states
    assert not browser.cookies.get(auth.STATE_COOKIE)
    assert browser.get(f"/api/auth/google/callback?code=abc&state={state}", follow_redirects=False).status_code == 400  # one use
    # unknown states never pile up: nothing is stored for a callback that fails
    assert "forged" not in auth._states


# ── 3. /api/health says little to strangers ──────────────────────────────────

def test_health_hides_provider_modes_from_anonymous_callers(client: TestClient):
    anon = TestClient(app)
    body = anon.get("/api/health").json()
    assert body == {"ok": True, "version": app.version}
    mine = client.get("/api/health").json()
    assert mine["ok"] is True and mine["version"] == app.version
    assert isinstance(mine["providers"], list) and mine["providers"] and "mode" in mine["providers"][0]
