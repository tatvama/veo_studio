"""Team settings stored in the DB (editable from the Admin page) + encrypted API keys."""
from __future__ import annotations

import base64
import hashlib
import time
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.orm import Session

from . import catalog
from .config import get_settings
from .db import SessionLocal, utcnow
from .models import ApiKey, AppSetting

DEFAULTS: dict[str, Any] = {
    "team_monthly_cap_usd": 100.0,
    "alert_thresholds": [50, 80, 100],
    "default_quality_mode": "saver",
    "tts_provider_by_language": {"en": "gemini", "hi": "gemini", "kn": "gemini", "te": "gemini", "ta": "gemini"},
    "auto_retake": True,
    "max_auto_retakes": 2,
    # Google (Gemini key) is the primary engine: when one of its engines can do a job, only Google is used, and a
    # Google rate limit makes the job wait rather than move to fal. fal runs only for jobs Google can't do (e.g.
    # lip-sync) or when a shot has a fal engine picked by hand. Off = fall back through the whole chain.
    "google_first": True,
    # Same model, several routes (e.g. Seedance on BytePlus, OpenRouter and fal): try the cheapest live route first and
    # fail over to the others. Off = the engine named in the chain first, its other routes only as a fallback.
    "cheapest_route": True,
    # Writing (scripts, prompts, QC notes): "gemini" (Gemini key) or "openrouter". OpenRouter is also used on its own
    # when there is no Gemini key. Empty model = the same Gemini model through OpenRouter.
    "text_provider": "gemini",
    "openrouter_text_model": "",
    "openrouter_text_model_pro": "",
    # BytePlus asset library: CreateAsset calls per minute (3 on the free Entry tier, 120 Advanced, 300 Premium)
    "byteplus_asset_qpm": 3,
    # Register AI characters with BytePlus by themselves when their sheet is approved or the character is locked
    # (never characters made from someone's photo: real people verify themselves in the BytePlus console)
    "byteplus_auto_register": False,
    # On a safety block, try another model (registered-character engines first), even with Google first on
    "safety_fallback": False,
    # When Google's quota is used up or rate limited, run the same model through another provider (e.g. Nano Banana
    # on OpenRouter) instead of waiting. Off keeps Google first strict: the job waits for Google.
    "quota_fallback_routes": False,
    # A fallback route may cost this much (USD) more than the job was approved for; above it the job asks for approval
    "fallback_extra_limit_usd": 0.5,
    "qc_threshold": 0.7,
    "lipsync_model": "lipsync-2",
    "make_webhook_url": "",
    "models": {},
    "prices": {},
    "creator_default_monthly_limit_usd": 25.0,
    # Model Hub
    "engine_policy": {},
    "hub_auto_sync": True,
    "hub_sync_hours": 24,
    "hub_auto_enable": False,
    # Dialogue & dubbing
    "dialogue_method": "audio_first",  # audio_first | audio_driven | voice_lock | native_when_possible
    "dub_method": "redub",  # redub (lip-sync existing video) | regenerate (audio-driven per language)
    # Languages Veo may speak itself (speech + lips in one pass). Others use TTS + lip-sync. Phase 0 decides the list.
    "native_dialogue_languages": ["en"],
    "dialogue_words_qc": True,  # after a spoken clip: did it say the scripted words, in the right language?
    "dialogue_words_threshold": 0.75,
    "outfit_qc": True,  # fail a take whose outfit does not match the scene wardrobe (when the character lock asks for it)
    # {engine id: {language code: 0..1}} from the team's own listening tests; shown in the Model Hub and used to warn
    # when a shot speaks a language an engine scored badly on
    "engine_language_scores": {},
    # Accuracy
    "identity_trainer": {"trainer": "fal-ai/qwen-image-2512-trainer", "inference": "fal-ai/qwen-image-2512/lora",
                         "steps": 1000, "scale": 1.0, "min_images": 12},
    "face_match_threshold": 0.36,  # SFace cosine similarity; ≥ 0.363 = same person (OpenCV guidance)
    "lipsync_qc": True,
    "lipsync_qc_threshold": 0.6,
    # Writers' room
    "critic_rounds": 1,
    "critic_min_score": 7.5,
    # Captions & delivery
    "caption_style": "karaoke",  # karaoke | clean | boxed | none
    "auto_reframe": True,
    "sfx_auto": False,
    "ui_default_language": "en",
}

# byteplus_iam is the BytePlus access key and secret, saved together as "ACCESS_KEY:SECRET" (asset library only)
PROVIDERS = ["gemini", "elevenlabs", "sync", "sarvam", "fal", "openrouter", "byteplus", "byteplus_iam"]


def get_setting(db: Session, key: str) -> Any:
    row = db.get(AppSetting, key)
    if row is None:
        return DEFAULTS.get(key)
    return row.value


def all_settings(db: Session) -> dict[str, Any]:
    out = dict(DEFAULTS)
    for row in db.query(AppSetting).all():
        out[row.key] = row.value
    return out


VERSION = {"n": 0}  # bumped on every change so in-process caches refresh immediately


def set_setting(db: Session, key: str, value: Any) -> None:
    VERSION["n"] += 1
    row = db.get(AppSetting, key)
    if row is None:
        db.add(AppSetting(key=key, value=value))
    else:
        row.value = value
    db.flush()


def models(db: Session | None = None) -> dict[str, str]:
    own = db is None
    db = db or SessionLocal()
    try:
        return catalog.merged(catalog.MODELS, get_setting(db, "models") or {})
    finally:
        if own:
            db.close()


def prices(db: Session | None = None) -> dict[str, Any]:
    own = db is None
    db = db or SessionLocal()
    try:
        return catalog.merged(catalog.PRICES, get_setting(db, "prices") or {})
    finally:
        if own:
            db.close()


# ── API keys ─────────────────────────────────────────────────────────────────

def _fernet() -> Fernet:
    digest = hashlib.sha256(("veo-studio-keys:" + get_settings().app_secret).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def save_api_key(db: Session, provider: str, key: str, user_id: int | None) -> None:
    VERSION["n"] += 1
    enc = _fernet().encrypt(key.strip().encode()).decode()
    row = db.get(ApiKey, provider)
    if row is None:
        db.add(ApiKey(provider=provider, encrypted=enc, updated_by=user_id))
    else:
        row.encrypted, row.updated_by, row.updated_at = enc, user_id, utcnow()
    db.flush()


def delete_api_key(db: Session, provider: str) -> None:
    VERSION["n"] += 1
    row = db.get(ApiKey, provider)
    if row:
        db.delete(row)
        db.flush()


_KEY_TTL = 5.0  # seconds; a key saved in another process (the worker container) is seen within this
_key_cache: dict[str, tuple[float, int, str]] = {}


def api_key(provider: str) -> str:
    """DB key (set from Admin page) wins over .env. The database lookup is cached for a few seconds: routing and
    price lists ask for every engine's key."""
    # Model Hub engines name Google "google"; its key is stored as "gemini". Without this, Veo looked keyless (mock)
    # and every chain put fal engines ahead of it.
    provider = {"google": "gemini"}.get(provider, provider)
    saved = _saved_key(provider)
    if saved:
        return saved
    s = get_settings()
    return {
        "gemini": s.gemini_api_key,
        "elevenlabs": s.elevenlabs_api_key,
        "sync": s.sync_api_key,
        "sarvam": s.sarvam_api_key,
        "fal": s.fal_key,
        "openrouter": s.openrouter_api_key,
        "byteplus": s.byteplus_api_key,
        "byteplus_iam": f"{s.byteplus_access_key}:{s.byteplus_secret_key}" if s.byteplus_access_key and s.byteplus_secret_key else "",
    }.get(provider, "") or ""


def _saved_key(provider: str) -> str:
    """The key saved from the Admin page ("" when none)."""
    hit = _key_cache.get(provider)
    now = time.monotonic()
    if hit and hit[1] == VERSION["n"] and now - hit[0] < _KEY_TTL:
        return hit[2]
    value = ""
    db = SessionLocal()
    try:
        row = db.get(ApiKey, provider)
        if row:
            try:
                value = _fernet().decrypt(row.encrypted.encode()).decode()
            except InvalidToken:
                pass
    finally:
        db.close()
    _key_cache[provider] = (now, VERSION["n"], value)
    return value


def key_source(db: Session, provider: str) -> str:
    if db.get(ApiKey, provider):
        return "admin"
    return "env" if api_key(provider) else "missing"


def mask(key: str) -> str:
    if ":" in key:  # "ACCESS_KEY:SECRET": show only the access key's ends, never any of the secret
        key = key.split(":", 1)[0]
    return (key[:4] + "…" + key[-4:]) if len(key) > 10 else ("set" if key else "")
