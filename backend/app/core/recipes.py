"""Recipes: saved "Make it for me" choices, one click each (the simple "app mode").

A recipe is what the Make it for me dialog asks when there are shots: which produce steps run, the video quality,
"Quick draft first", "stop to check new cast", "a scene that picks up starts on the last frame" and "one piece of music
per scene". Three ship built in; a team saves its own (kept in the team setting "make_recipes", no table of its own).
Applying one only fills the dialog: the price is still shown before anything starts.
"""
from __future__ import annotations

import re
import uuid
from typing import Any

from sqlalchemy.orm import Session

from .. import catalog, settings_store
from ..db import utcnow
from .generation import PRODUCE_STEPS

KEY = "make_recipes"
MAX_TEAM = 30
LINKS = ("auto", "never")

BUILTIN: list[dict[str, Any]] = [
    {"id": "builtin:reels-draft", "name": "Reels draft", "steps": ["cast", "keyframes", "videos", "voices", "sound", "music", "export"],
     "quality": "saver", "draft": True, "review_looks": False, "link_scenes": "auto", "music_per_scene": False,
     "about": "A quick 480p cut to check the story and timing, one music track, cheapest engines"},
    {"id": "builtin:hero-film", "name": "Full film, Hero quality", "steps": list(PRODUCE_STEPS), "quality": "hero",
     "draft": False, "review_looks": True, "link_scenes": "auto", "music_per_scene": True,
     "about": "Everything at the best quality: stops after new cast pictures and voices so you can check them first"},
    {"id": "builtin:storyboard", "name": "Storyboard first", "steps": ["cast", "keyframes"], "quality": None,
     "draft": False, "review_looks": True, "link_scenes": "auto", "music_per_scene": True,
     "about": "The cast and a picture per shot, so you can check the look before paying for video"},
]


def clean(raw: dict[str, Any]) -> dict[str, Any]:
    """A recipe from a request, checked: ValueError in plain words when it can't be saved."""
    name = re.sub(r"\s+", " ", str(raw.get("name") or "")).strip()[:60]
    if not name:
        raise ValueError("Give the recipe a name")
    steps = [s for s in PRODUCE_STEPS if s in (raw.get("steps") or [])]
    if not steps:
        raise ValueError(f"A recipe needs at least one step: some of {', '.join(PRODUCE_STEPS)}")
    quality = raw.get("quality") or None
    if quality is not None and quality not in catalog.QUALITY_MODES:
        raise ValueError(f"Quality must be one of {', '.join(catalog.QUALITY_MODES)} (or empty for the project's own)")
    link = raw.get("link_scenes") if raw.get("link_scenes") in LINKS else "never"
    return {"name": name, "steps": steps, "quality": quality, "draft": bool(raw.get("draft")),
            "review_looks": bool(raw.get("review_looks")), "link_scenes": link,
            "music_per_scene": bool(raw.get("music_per_scene", True)), "about": str(raw.get("about") or "")[:200]}


def team(db: Session) -> list[dict[str, Any]]:
    return [r for r in settings_store.get_setting(db, KEY) or [] if isinstance(r, dict) and r.get("id")]


def all_recipes(db: Session) -> list[dict[str, Any]]:
    """The built-in recipes, then the team's (newest last)."""
    return [{**r, "builtin": True} for r in BUILTIN] + [{**r, "builtin": False} for r in team(db)]


def save(db: Session, raw: dict[str, Any], by: str = "") -> dict[str, Any]:
    """Save a team recipe; one with the same name (any case) is replaced. Returns it. No commit."""
    r = clean(raw)
    rows = team(db)
    old = next((x for x in rows if x.get("name", "").lower() == r["name"].lower()), None)
    if any(b["name"].lower() == r["name"].lower() for b in BUILTIN):
        raise ValueError(f"“{r['name']}” is a built-in recipe: pick another name")
    if old is None and len(rows) >= MAX_TEAM:
        raise ValueError(f"A team keeps at most {MAX_TEAM} recipes: delete one first")
    out = {**r, "id": old["id"] if old else f"r_{uuid.uuid4().hex[:10]}", "by": by[:80],
           "at": utcnow().isoformat() + "Z"}
    settings_store.set_setting(db, KEY, [out if x is old else x for x in rows] if old else [*rows, out])
    return out


def delete(db: Session, rid: str) -> bool:
    """Delete a team recipe (built-ins stay). False when there was none with that id. No commit."""
    rows = team(db)
    keep = [x for x in rows if x.get("id") != rid]
    if len(keep) == len(rows):
        return False
    settings_store.set_setting(db, KEY, keep)
    return True
