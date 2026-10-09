"""Hand local media to outside services that fetch inputs by link (OpenRouter, BytePlus)."""
from __future__ import annotations

import base64
from pathlib import Path

from ..storage import get_storage
from .base import ProviderError
from .gemini import guess_mime


def media_link(path: Path, *, data_uri_ok: bool = True, provider: str = "") -> str:
    """A temporary HTTPS link to the file (bucket storage), else a base64 data URI when the service accepts one."""
    url = get_storage().public_url(Path(path))
    if url:
        return url
    if not data_uri_ok:
        raise ProviderError(f"{provider or 'This service'} downloads its inputs by link, which needs bucket storage "
                            "(set STORAGE_BACKEND=s3 with the R2 settings)", provider=provider)
    data = Path(path).read_bytes()
    return f"data:{guess_mime(data, 'image/png')};base64,{base64.b64encode(data).decode()}"


BLOCK_WORDS = ("moderation", "safety", "content policy", "flagged", "sensitive", "privacy", "prohibited", "violat",
               "celebrity", "real person", "likeness", "not allowed", "nsfw", "copyright")


def looks_blocked(text: str) -> bool:
    low = (text or "").lower()
    return any(w in low for w in BLOCK_WORDS)
