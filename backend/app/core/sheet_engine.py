"""Which image engine makes a character's reference pack (sheet, expressions, lighting, outfits).

By default the team's "image" chain decides (Google first, with its fallbacks). A character can instead have its own
engine picked by hand, e.g. Seedream 5.0 Pro on BytePlus: it is remembered on the character (Character.sheet_engine)
so regenerations use it, and the jobs run on that engine's own route only (handlers.run_chain `only`).
"""
from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import AIModel, Character
from . import model_hub

AUTO = ("", "auto")


def usable(m: AIModel | None) -> str:
    """Why this engine can't make character images ("" = it can)."""
    if m is None:
        return "isn't in the Model Hub"
    if m.task != "image" or not set((m.capabilities or {}).get("modes") or []) & {"t2i", "i2i"}:
        return "doesn't make images"
    if m.status != "enabled":
        return "is switched off in the Model Hub"
    if (m.capabilities or {}).get("usable") is False:
        return "can't be used yet"
    if model_hub.provider_mode(m.provider) == "missing":
        return f"has no {m.provider} API key"
    return ""


def image_engines(db: Session) -> list[AIModel]:
    """The engines a character's images can be made with (enabled image engines whose provider has a key)."""
    rows = db.query(AIModel).filter(AIModel.status == "enabled", AIModel.task == "image").all()
    return [m for m in rows if not usable(m)]


def check(db: Session, engine_id: str) -> AIModel:
    m = db.get(AIModel, engine_id)
    why = usable(m)
    if why:
        raise HTTPException(400, f"{m.display_name if m else engine_id} {why}. Pick another engine, or Auto (the team's "
                                 "image chain).")
    return m


def resolve(db: Session, ch: Character, override: str | None = None) -> str | None:
    """The engine id a character's images are made with now, or None for the team's image chain. `override` is a pick
    made with this request: it is checked and remembered on the character ("auto" goes back to the team chain)."""
    if override is not None:
        pick = override.strip()
        if pick in AUTO:
            ch.sheet_engine = ""
            db.commit()
            return None
        check(db, pick)
        if ch.sheet_engine != pick:
            ch.sheet_engine = pick
            db.commit()
        return pick
    if ch.sheet_engine:
        m = db.get(AIModel, ch.sheet_engine)
        why = usable(m)
        if why:  # never fall back to another engine behind the user's back
            raise HTTPException(400, f"The engine picked for {ch.name} ({m.display_name if m else ch.sheet_engine}) {why}. "
                                     "Pick another engine for this character, or Auto.")
        return ch.sheet_engine
    return None
