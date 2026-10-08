"""Google (the Gemini key) is the primary engine; fal only for what Google can't do, unless the team turns that off."""
from __future__ import annotations

from app import settings_store
from app.core import model_hub
from app.db import SessionLocal


def test_google_engines_find_the_gemini_key(client, monkeypatch):
    s = settings_store.get_settings()
    monkeypatch.setattr(s, "gemini_api_key", "AIza-test-key")
    assert settings_store.api_key("google") == "AIza-test-key"  # Model Hub's "google" engines use the Gemini key


def test_google_first_routing(client):
    from test_v2 import seed_fal_models
    seed_fal_models()
    with SessionLocal() as db:
        saver = model_hub.candidates(db, "video.saver", ["i2v"])
        assert saver and {m.provider for m, _ in saver} == {"google"}  # no fal while Google can do it
        lip = model_hub.candidates(db, "lipsync", ["lipsync"])
        assert lip and any(m.provider == "fal" for m, _ in lip)  # Google can't lip-sync: fal is still used
        settings_store.set_setting(db, "google_first", False)
        db.commit()
        try:
            assert any(m.provider == "fal" for m, _ in model_hub.candidates(db, "video.saver", ["i2v"]))
        finally:
            settings_store.set_setting(db, "google_first", True)
            db.commit()
