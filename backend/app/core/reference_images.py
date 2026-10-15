"""Reference pictures of the cast, places and props: one place that saves them, used by the upload endpoints
(api/bible.py, api/production.py) and by the Director's add_cast_from_image tool, so a picture added either way is
stored and approved the same way.

Keyword arguments only after the picture itself, so a caller can pass more about it later (e.g. where it came from)
without touching the others."""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..events import emit
from ..models import Character, CharacterAsset, Location, LocationAsset, Prop
from ..storage import get_storage

IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
MAX_BYTES = 15 * 1024 * 1024


def sniff(data: bytes) -> str:
    """The image type from the file's first bytes ("png", "jpg", "webp"), or "" when it isn't one of those."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return ""


def save_character_image(db: Session, ch: Character, data: bytes, ext: str, *, label: str = "",
                         project_id: int | None = None) -> CharacterAsset:
    """The user's own picture of a character: an approved "source" asset, the first look reference everywhere."""
    st = get_storage()
    rel = st.save_bytes(st.new_path(f"characters/{ch.id}", ext), data)
    a = CharacterAsset(character_id=ch.id, kind="source", label=(label.strip() or "your photo")[:80], path=rel, approved=True)
    db.add(a)
    db.commit()
    emit(db, project_id, "bible.updated", {"character_id": ch.id})
    return a


def save_location_image(db: Session, loc: Location, data: bytes, ext: str, *, label: str = "",
                        project_id: int | None = None) -> LocationAsset:
    st = get_storage()
    rel = st.save_bytes(st.new_path(f"locations/{loc.id}", ext), data)
    a = LocationAsset(location_id=loc.id, kind="source", label=(label.strip() or "uploaded photo")[:120], path=rel,
                      approved=True)
    db.add(a)
    db.commit()
    emit(db, project_id, "bible.updated", {"location_id": loc.id})
    return a


def save_prop_image(db: Session, prop: Prop, data: bytes, ext: str, *, project_id: int | None = None) -> Prop:
    """A prop has one reference picture: this one replaces it."""
    st = get_storage()
    prop.path = st.save_bytes(st.new_path(f"props/{prop.id}", ext), data)
    db.commit()
    emit(db, project_id, "bible.updated", {"prop_id": prop.id})
    return prop
