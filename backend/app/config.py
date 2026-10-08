"""App settings. Everything can be set in VEO_STUDIO/.env (see .env.example)."""
from __future__ import annotations

import os
import sys
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]  # VEO_STUDIO/


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(ROOT / ".env"), env_file_encoding="utf-8", extra="ignore")

    app_name: str = "VEO STUDIO"
    # Signs login cookies and encrypts API keys saved from the Admin page. Set a long random value in production.
    app_secret: str = "dev-only-secret-change-me"
    database_url: str = ""
    media_root: Path = ROOT / "media"
    data_root: Path = ROOT / "data"

    # Storage: "local" keeps files on disk; "s3" also mirrors them to an S3-compatible bucket (Cloudflare R2).
    storage_backend: str = "local"
    s3_endpoint_url: str = ""
    s3_bucket: str = ""
    s3_access_key_id: str = ""
    s3_secret_access_key: str = ""

    public_base_url: str = "http://localhost:8100"
    frontend_origin: str = "http://localhost:5173"
    cookie_secure: bool = False

    # Background worker
    run_worker_in_process: bool = True
    worker_concurrency: int = 4

    # "auto" = use a mock provider when its API key is missing; "true" = always mock; "false" = never mock.
    mock_providers: str = "auto"
    # Google caps paid spend per rolling 10 minutes by usage tier (Tier 1: $10, Tier 2: $50, Tier 3: $200).
    # Veo calls wait in the queue instead of crossing it. 0 turns the check off.
    gemini_spend_per_10min: float = 10.0

    gemini_api_key: str = ""
    elevenlabs_api_key: str = ""
    sync_api_key: str = ""
    sarvam_api_key: str = ""
    fal_key: str = ""

    google_client_id: str = ""
    google_client_secret: str = ""
    allowed_google_domains: str = ""  # comma separated; empty = only pre-registered emails

    make_webhook_url: str = ""
    ffmpeg_path: str = ""
    caption_font: str = "Nirmala UI" if sys.platform == "win32" else "Noto Sans"

    spike_budget_usd: float = 30.0

    @property
    def db_url(self) -> str:
        if self.database_url:
            return self.database_url
        self.data_root.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{(self.data_root / 'studio.db').as_posix()}"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.media_root.mkdir(parents=True, exist_ok=True)
    s.data_root.mkdir(parents=True, exist_ok=True)
    return s


def env_flag(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}
