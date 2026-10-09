"""Which images a character's identity (face model) is trained on.

When the user has uploaded photos, the face model learns from those only, plus any AI variations of their photo that
they approved. Nothing is added behind their back: if there aren't enough, they upload more or ask for variations,
review them, then train. Characters without any uploaded photo (AI-designed ones) train on their approved sheet.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Character, CharacterAsset

MIN_IMAGES = 4  # the trainer needs at least this many
GOOD_IMAGES = 10  # recommended for a reliable face


def training_set(db: Session, ch: Character) -> dict:
    assets = (db.query(CharacterAsset).filter(CharacterAsset.character_id == ch.id, CharacterAsset.archived.is_(False))
              .order_by(CharacterAsset.id).all())
    own = [a for a in assets if a.kind == "source" and a.approved]
    # sheet fill-ins made for an AI-designed character are not variations of a real photo: once the user has their
    # own photos, only the variations they asked for and approved count
    variations = [a for a in assets if a.kind == "training" and not (own and a.label.startswith("training "))]
    approved_var = [a for a in variations if a.approved]
    if own:
        chosen = own + approved_var
        basis = "your_photos"
        auto_fill = False  # a real person: only what the user approved
    else:
        # an AI-designed character has no real face to protect: train on its sheet and fill up with variations of it
        sheet_kinds = ("front", "three_quarter", "profile", "full_body", "expression", "outfit")
        sheet = [a for a in assets if a.kind in sheet_kinds]
        chosen = ([a for a in sheet if a.approved] or sheet) + approved_var
        basis = "sheet"
        auto_fill = True
    return {"assets": chosen, "basis": basis, "own": len(own), "variations_approved": len(approved_var),
            "variations_waiting": len([a for a in variations if not a.approved]), "count": len(chosen),
            "min": MIN_IMAGES if not auto_fill else 1, "good": GOOD_IMAGES, "auto_fill": auto_fill}


def summary(db: Session, ch: Character) -> dict:
    from ..pipeline.approved_stills import train_suggested
    s = training_set(db, ch)
    out = {k: v for k, v in s.items() if k != "assets"}
    # in many shots with no face model yet: training one locks the face better than reference images alone
    out["train_suggested"], out["shots"] = train_suggested(db, ch)
    return out
