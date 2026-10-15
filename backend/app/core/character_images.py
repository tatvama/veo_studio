"""Images the user brings for a character (uploads, kind "source"), and whether they are AI-generated.

An upload is a photo of a real person unless the user attests it is AI-generated. Only attested uploads may go to the
BytePlus asset library (workers/handlers_hub.py): real people verify themselves in the BytePlus console. Every place
that saves a character image the user brings goes through save_character_image(), so the rule holds everywhere.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request
from sqlalchemy.orm import Session

from ..db import utcnow
from ..events import emit
from ..models import Character, CharacterAsset, User
from ..storage import get_storage
from .audit import audit

IMG_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
MAX_BYTES = 15 * 1024 * 1024
PHOTO_LABEL, AI_LABEL = "your photo", "AI-made"


def _attest(db: Session, user: User | None, a: CharacterAsset, ch: Character, ai_made: bool, how: str,
            request: Request | None) -> None:
    a.ai_made = ai_made
    a.ai_attested_by, a.ai_attested_at = (user.id if user else None), utcnow()
    audit(db, user, "character.asset.ai_attested" if ai_made else "character.asset.ai_unattested", ch.name,
          {"character_id": ch.id, "asset_id": a.id, "via": how}, request=request, commit=False)


def attest_upload(db: Session, user: User | None, a: CharacterAsset, ch: Character, *, via: str,
                  request: Request | None = None) -> None:
    """Record at upload time that an image the user brings (e.g. a character board) is AI-made."""
    _attest(db, user, a, ch, True, via, request)
    db.commit()


def save_character_image(db: Session, ch: Character, data: bytes, ext: str, *, user: User | None = None, label: str = "",
                         ai_made: bool = False, request: Request | None = None, via: str = "upload") -> CharacterAsset:
    """Save an image the user brings as the character's own look reference (approved: used first everywhere).

    `ai_made` is the user's attestation that it is AI-generated, not a photo of a real person (recorded with who and
    when, and audit-logged). Without it the image counts as a real person's photo: it is never sent to the BytePlus
    asset library and the character is "made from a photo". When the team turned automatic registration on, an
    attested image registers the character by itself."""
    ext = ext.lower().lstrip(".")
    if ext not in IMG_TYPES.values():
        raise HTTPException(400, "Upload a PNG, JPG or WEBP image")
    if len(data) > MAX_BYTES:
        raise HTTPException(400, "Image too large (max 15 MB)")
    st = get_storage()
    rel = st.save_bytes(st.new_path(f"characters/{ch.id}", ext), data)
    a = CharacterAsset(character_id=ch.id, kind="source", label=(label.strip() or (AI_LABEL if ai_made else PHOTO_LABEL))[:80],
                       path=rel, approved=True)
    db.add(a)
    db.flush()
    if ai_made:
        _attest(db, user, a, ch, True, via, request)
    db.commit()
    if ai_made and user is not None:
        from ..workers.handlers_hub import maybe_auto_register
        maybe_auto_register(db, user, ch)
    emit(db, None, "bible.updated", {"character_id": ch.id})
    return a


def set_ai_made(db: Session, user: User, a: CharacterAsset, ai_made: bool, request: Request | None = None) -> dict[str, Any]:
    """Change an upload's attestation later. Marking it a real person's photo while the character is registered with
    BytePlus takes the registration back at once (withdraw_byteplus): the face may already be in the library, and
    so may sheet views made from it. Returns {"asset", "byteplus"} ("byteplus": {"removed", "error"} or None)."""
    from ..workers.handlers_hub import maybe_auto_register, withdraw_byteplus
    if a.kind != "source":
        raise HTTPException(400, "Only uploaded images carry an AI-made attestation")
    ch = db.get(Character, a.character_id)
    removal = None
    if bool(a.ai_made) != ai_made:
        _attest(db, user, a, ch, ai_made, "toggle", request)
        if a.label in (PHOTO_LABEL, AI_LABEL, ""):
            a.label = AI_LABEL if ai_made else PHOTO_LABEL
        db.commit()
        if not ai_made:  # also stops a registration that is queued or running and might send it
            removal = withdraw_byteplus(db, user, ch, "real_person", request=request)
        elif a.approved and not a.archived:
            maybe_auto_register(db, user, ch)
    emit(db, None, "bible.updated", {"character_id": ch.id})
    return {"asset": a.to_dict(), "byteplus": removal}
