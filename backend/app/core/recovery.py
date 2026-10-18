"""Blocked-shot recovery and cheap drafts: which other engines can make a shot, at what price, and whether they keep
the shot's characters (registered in the BytePlus asset library, Seedance takes them as trusted references)."""
from __future__ import annotations

import re
from typing import Any

from sqlalchemy.orm import Session

from .. import catalog
from ..models import AIModel, Character, Job, Project, Shot
from ..pipeline.prompting import effective_quality
from ..providers.base import ProviderBlocked
from ..providers.services import provider_mode
from . import credit, model_hub

BLOCK_PREFIX = "Blocked by safety filter"
VIDEO_MODES = {"t2v", "i2v", "ref2v", "flf"}
DRAFT_RES = "480p"

# A blocked video is tried once more with these words toned down (weapons, blood, violence), the action kept: a filter
# that tripped on "the knife" often lets "the kitchen tool" through. Whole words only, any case.
SOFTER = {
    "gun": "prop", "guns": "props", "pistol": "prop", "pistols": "props", "revolver": "prop", "rifle": "long prop",
    "rifles": "long props", "shotgun": "long prop", "firearm": "prop", "firearms": "props", "weapon": "object",
    "weapons": "objects", "knife": "kitchen tool", "knives": "kitchen tools", "dagger": "tool", "sword": "staff",
    "swords": "staffs", "machete": "tool", "blood": "dust", "bloody": "dusty", "bloodied": "dusty", "bleeding": "hurt",
    "gore": "mess", "gory": "messy", "kill": "defeat", "kills": "defeats", "killed": "defeated", "killing": "defeating",
    "murder": "crime", "murders": "crimes", "murdered": "harmed", "murderer": "culprit", "stab": "strike",
    "stabs": "strikes", "stabbed": "struck", "stabbing": "striking", "shoot": "aim at", "shoots": "aims at",
    "corpse": "still figure", "corpses": "still figures", "violence": "conflict", "violent": "intense",
    "violently": "intensely", "bomb": "device", "bombs": "devices", "explosion": "burst of light", "wounded": "hurt",
    "wounds": "bruises", "strangle": "grab", "strangles": "grabs", "strangled": "grabbed", "torture": "pressure",
    "tortured": "pressured", "suicide": "despair",
}
_SOFTER_RX = re.compile(r"\b(?:" + "|".join(sorted(SOFTER, key=len, reverse=True)) + r")\b", re.IGNORECASE)


def soften(prompt: str) -> tuple[str, list[str]]:
    """The prompt with weapons, blood and violence words toned down, and the words it changed (none: nothing to tone)."""
    found: list[str] = []

    def swap(m: re.Match) -> str:
        word = m.group(0)
        found.append(word.lower())
        new = SOFTER[word.lower()]
        return new.capitalize() if word[:1].isupper() else new

    out = _SOFTER_RX.sub(swap, prompt or "")
    return out, list(dict.fromkeys(found))


def blocked(e: Exception, toned: list[str] | None = None) -> ProviderBlocked:
    """A safety block in plain words with the next step (the worker writes "Blocked by safety filter: …" before it)."""
    said = " ".join(str(e).split())[:240].rstrip(".")
    again = f" It was tried again without {', '.join(toned[:5])}, and blocked again." if toned else ""
    return ProviderBlocked(f"{said}.{again} Next: soften the action or the words, or try another engine (the shot's "
                           "Recover options)", provider=getattr(e, "provider", ""))


def seedance_ready(ch: Character | None) -> bool:
    """Registered with BytePlus and at least one image accepted: Seedance can use the character."""
    reg = ((ch.provider_assets or {}).get("byteplus") or {}) if ch else {}
    if reg.get("withdrawn"):  # taken back (archived, or a real person's photo) while BytePlus still holds it: never used
        return False
    return any(a.get("status") == "Active" and a.get("asset_id") for a in reg.get("assets") or [])


def cast_status(db: Session, shot: Shot) -> dict[str, list[str]]:
    """The shot's characters, split by whether Seedance can take them as registered references."""
    out: dict[str, list[str]] = {"ready": [], "missing": []}
    for cid in shot.characters or []:
        ch = db.get(Character, int(cid))
        if ch:
            out["ready" if seedance_ready(ch) else "missing"].append(ch.name)
    return out


def blocked_info(db: Session, shot: Shot) -> dict[str, Any] | None:
    """The shot's latest video attempt, when a safety filter blocked it and nothing newer replaced it."""
    j = (db.query(Job).filter(Job.shot_id == shot.id, Job.type == "video").order_by(Job.id.desc()).limit(8).all())
    j = next((x for x in j if not (x.payload or {}).get("shootout")), None)
    if not j or j.status != "failed" or not (j.error or "").startswith(BLOCK_PREFIX):
        return None
    res = j.result or {}
    engines = list(res.get("blocked_engines") or [])
    if not engines:  # older jobs: read the engine names out of the attempts
        engines = [a["engine"] for a in res.get("attempts") or [] if "block" in str(a.get("error", "")).lower()]
    rows = {m.id: m for m in db.query(AIModel).filter(AIModel.id.in_(engines)).all()} if engines else {}
    return {"job_id": j.id, "error": (j.error or "")[len(BLOCK_PREFIX) + 2:][:400], "engines": engines,
            "engine_labels": [rows[e].display_name if e in rows else e.split(":", 1)[-1] for e in engines],
            "at": j.finished_at.isoformat() + "Z" if j.finished_at else None}


def prefer_registered(db: Session, shot_id: int | None, cands: list[tuple[AIModel, str]]) -> list[tuple[AIModel, str]]:
    """Engines that take registered characters first, when the shot has any (stable otherwise)."""
    shot = db.get(Shot, shot_id) if shot_id else None
    if not shot or not cast_status(db, shot)["ready"]:
        return cands
    return sorted(cands, key=lambda t: not (t[0].capabilities or {}).get("asset_refs"))


def options(db: Session, shot: Shot, project: Project, purpose: str = "recover",
            exclude: list[str] | None = None) -> list[dict[str, Any]]:
    """Engines that can make this shot instead: one per model (its cheapest live route), with the price of this
    shot. purpose "recover": not the engines (nor models) that blocked it, registered-cast engines first;
    purpose "draft": engines that render 480p, cheapest first."""
    draft = purpose == "draft"
    res = DRAFT_RES if draft else catalog.QUALITY_MODES[effective_quality(shot, project)]["resolution"]
    blocked = set(exclude or [])
    blocked_rows = [db.get(AIModel, e) for e in blocked]
    blocked_keys = {model_hub.route_key(m) for m in blocked_rows if m} - {""}
    blocked_providers = {m.provider for m in blocked_rows if m}
    held = set(credit.holds(db))
    cast = cast_status(db, shot)
    rows = []
    for m in db.query(AIModel).filter(AIModel.status == "enabled", AIModel.task == "video").all():
        caps = m.capabilities or {}
        if caps.get("usable") is False or provider_mode(m.provider) == "missing" or m.provider in held:
            continue
        if not set(caps.get("modes") or []) & VIDEO_MODES or m.id in blocked:
            continue
        if model_hub.route_key(m) and model_hub.route_key(m) in blocked_keys:
            continue  # the same model through another provider runs the same filter
        if draft and DRAFT_RES not in [str(r).lower() for r in caps.get("resolutions") or []]:
            continue
        rows.append(m)
    out = []
    for group in model_hub.catalog_groups(rows):
        m = group[0]
        caps = m.capabilities or {}
        secs = model_hub.clamp_duration(m, shot.duration_s)
        uses_cast = bool(caps.get("asset_refs")) and bool(cast["ready"])
        out.append({"id": m.id, "display_name": m.display_name, "provider": m.provider, "routes": len(group),
                    "provider_mode": provider_mode(m.provider), "resolution": res, "seconds": secs,
                    "est_usd": round(model_hub.price_for(m, seconds=secs, resolution=res), 4),
                    "uses_registered": uses_cast, "asset_refs": bool(caps.get("asset_refs"))})
    out.sort(key=lambda d: (not d["uses_registered"], d["provider"] in blocked_providers,
                            d["provider_mode"] != "live", d["est_usd"]))
    return out


def seedance_engine(db: Session, shot: Shot, project: Project, quality: str | None = None) -> AIModel | None:
    """The engine that will make this shot's clip, when it is one that takes registered characters (Seedance on
    BytePlus), else None."""
    q = quality if quality in catalog.QUALITY_MODES else effective_quality(shot, project)
    explicit = shot.engine if shot.engine and shot.engine != "auto" else None
    choice = model_hub.first_choice(db, f"video.{q}", ["i2v", "ref2v", "t2v"], explicit)
    m = choice[0] if choice else None
    return m if m is not None and (m.capabilities or {}).get("asset_refs") else None


def seedance_warnings(db: Session, project: Project, shots: list[Shot], quality: str | None = None) -> list[str]:
    """What the cost dialog says when Seedance will make shots whose people aren't registered with BytePlus: it gets
    only the keyframe, and its real-person filter may block a realistic face (the fallback to registered references
    works only for registered, accepted characters)."""
    names: list[str] = []
    for s in shots:
        if s.characters and seedance_engine(db, s, project, quality) is not None:
            names += [n for n in cast_status(db, s)["missing"] if n not in names]
    if not names:
        return []
    return [f"Seedance makes some of these shots and may block a realistic face it only sees in the keyframe: "
            f"{', '.join(names[:6])}{' …' if len(names) > 6 else ''} {'is' if len(names) == 1 else 'are'}n't registered "
            "with BytePlus. Register them in the Bible (BytePlus), or turn on automatic registration (Settings → "
            "Generation) and Produce all registers AI-made characters in its cast step."]
