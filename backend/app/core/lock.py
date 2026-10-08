"""Character Lock: structured constraints per character that steer three things at once: the prompt compiler,
how many references a character gets, and how strict QC is for that character.

It steers and checks; it cannot guarantee identity (no model can). The UI says so.
"""
from __future__ import annotations

from typing import Any

from ..models import Character

DEFAULT: dict[str, Any] = {
    "face": True,  # identical face and facial hair
    "body": True,  # same build and proportions
    "skin_hair": True,  # skin tone and hairstyle
    "voice": True,  # the voice description goes into every dialogue prompt
    "costume_continuity": True,  # the outfit of the scene wardrobe must be worn, and QC fails a wrong outfit
    "gestures": "",  # free text: signature gestures / posture
    "age": "",  # free text: apparent age to keep
    "lighting": "",  # free text: a cinematic lighting style for this character
    "strictness": 0.5,  # 0 = lenient QC, 1 = strict QC
}


def effective(ch: Character | None, override: dict | None = None) -> dict[str, Any]:
    out = dict(DEFAULT)
    out.update({k: v for k, v in ((ch.lock if ch and ch.lock else {}) or {}).items() if k in DEFAULT})
    if override:
        out.update({k: v for k, v in override.items() if k in DEFAULT})
    try:
        out["strictness"] = min(1.0, max(0.0, float(out.get("strictness", 0.5))))
    except (TypeError, ValueError):
        out["strictness"] = 0.5
    return out


def prompt_text(ch: Character, lock: dict | None = None) -> str:
    """One sentence per locked trait, appended to the character block of every prompt."""
    L = effective(ch, lock)
    bits: list[str] = []
    if L["face"]:
        bits.append("identical face and facial hair")
    if L["body"]:
        bits.append("same build and body proportions")
    if L["skin_hair"]:
        bits.append("same skin tone and hairstyle")
    if L["costume_continuity"]:
        bits.append("wearing exactly the outfit described, nothing added or removed")
    if L.get("age"):
        bits.append(f"apparent age {L['age']}")
    if L.get("gestures"):
        bits.append(f"mannerisms: {L['gestures']}")
    if L.get("lighting"):
        bits.append(f"lit in {L['lighting']}")
    if (ch.performance_notes or "").strip():
        bits.append(f"performance: {ch.performance_notes.strip()}")
    return f" Keep {ch.name}: " + "; ".join(bits) + "." if bits else ""


def face_threshold(lock: dict | None, base: float) -> float:
    """Face-match threshold shifted by strictness: 0.5 keeps the team default, 1.0 is +0.1, 0.0 is -0.1."""
    s = float((lock or {}).get("strictness", 0.5))
    return round(min(0.7, max(0.2, base + (s - 0.5) * 0.2)), 3)


def qc_threshold(lock: dict | None, base: float) -> float:
    s = float((lock or {}).get("strictness", 0.5))
    return round(min(0.95, max(0.4, base + (s - 0.5) * 0.3)), 3)


def refs_per_char(lock: dict | None) -> int:
    return 2 if float((lock or {}).get("strictness", 0.5)) >= 0.5 else 1


def requires_outfit(lock: dict | None) -> bool:
    return bool((lock or {}).get("costume_continuity", True))
