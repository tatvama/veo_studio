"""Continuity Bible: the state of the world at the end of every scene, and the wardrobe timeline of an episode.

The end state (who wears what, what they carry, injuries, weather, time of day) is written by the AI from the
script and the previous scene's end state, then kept on the Scene row where a person can correct it. The next
scene's prompts and the Director read it, so a lamp picked up in scene 3 is still in hand in scene 4.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..agents import schemas as S
from ..models import Character, Episode, Project, Prop, Scene, Shot, User
from . import mentions

END_STATE_SYSTEM = (
    "You are the continuity supervisor of a film. From the scene text and the state at the end of the previous "
    "scene, write the state of the world at the END of this scene: for every character present, the outfit they "
    "wear (keep the previous outfit unless the script changes it) and their physical state (wet, wounded, carrying "
    "something, hair down, etc.); the props that are now with them or placed in the location; time of day; weather; "
    "and short notes on anything the next scene must respect. Be concrete and brief. Never invent costume changes.")


def _scene_text(episode: Episode, scene: Scene) -> dict:
    script = mentions.plain_script(episode.script or {})
    scenes = script.get("scenes") or []
    if 0 <= scene.order < len(scenes):
        return scenes[scene.order]
    return {"title": scene.title, "summary": scene.summary, "action": "", "lines": []}


def previous_state(db: Session, scene: Scene) -> dict:
    prev = (db.query(Scene).filter(Scene.episode_id == scene.episode_id, Scene.order < scene.order)
            .order_by(Scene.order.desc()).first())
    while prev is not None and not prev.end_state:
        prev = (db.query(Scene).filter(Scene.episode_id == scene.episode_id, Scene.order < prev.order)
                .order_by(Scene.order.desc()).first())
    return dict(prev.end_state or {}) if prev else {}


def end_state(db: Session, user: User | None, project: Project, episode: Episode, scene: Scene) -> dict:
    from .studio import _llm
    text = _scene_text(episode, scene)
    prev = previous_state(db, scene)
    names = {str(c.id): c.name for c in db.query(Character).all()}
    wardrobe = {names.get(str(k), str(k)): v for k, v in (scene.wardrobe or {}).items()}
    props = [p.name for p in db.query(Prop).filter(Prop.id.in_([int(x) for x in (scene.prop_ids or [])])).all()] if scene.prop_ids else []
    prompt = (f"SCENE {scene.order + 1}: {text.get('title', scene.title)} at {text.get('location', '')} {text.get('time_of_day', '')}\n"
              f"Summary: {text.get('summary', '')}\nAction: {text.get('action', '')}\n"
              f"Lines: " + " / ".join(f"{l.get('character', '')}: {l.get('line', '')}" for l in text.get("lines") or []) + "\n"
              f"Scene card wardrobe: {wardrobe}\nScene props: {', '.join((scene.props or []) + props)}\n"
              f"Continuity notes: {scene.continuity_notes}\n"
              f"STATE AT THE END OF THE PREVIOUS SCENE: {prev or 'this is the first scene'}")
    out = _llm(db, user, project, "end_state", END_STATE_SYSTEM, prompt, S.EndStateOut,
               {"characters": list(wardrobe) or [l.get("character", "") for l in text.get("lines") or []],
                "wardrobe": wardrobe, "props": (scene.props or []) + props})
    by_name = {c.name.strip().lower(): c for c in db.query(Character).filter(Character.archived.is_(False)).all()}
    chars: dict[str, Any] = {}
    for c in out.characters:
        row = by_name.get(c.name.strip().lower())
        key = str(row.id) if row else c.name
        chars[key] = {"name": row.name if row else c.name, "outfit": c.outfit, "state": c.state}
    state = {"characters": chars, "props": out.props, "time_of_day": out.time_of_day, "weather": out.weather,
             "notes": out.notes, "source": "ai"}
    scene.end_state = state
    db.commit()
    return state


def state_text(db: Session, scene: Scene | None) -> str:
    """The previous scene's end state as prompt text for the shots of `scene`."""
    if scene is None:
        return ""
    prev = previous_state(db, scene)
    if not prev:
        return ""
    bits = []
    for c in (prev.get("characters") or {}).values():
        parts = [x for x in (c.get("outfit"), c.get("state")) if x]
        if parts:
            bits.append(f"{c.get('name', '')}: {', '.join(parts)}")
    if prev.get("props"):
        bits.append("props: " + ", ".join(prev["props"]))
    for k in ("time_of_day", "weather", "notes"):
        if prev.get(k):
            bits.append(f"{k.replace('_', ' ')}: {prev[k]}")
    return "; ".join(bits)


def wardrobe_timeline(db: Session, project: Project, episode: Episode) -> dict[str, Any]:
    """Who wears what in every scene, and where an outfit changes without the script saying so."""
    scenes = db.query(Scene).filter(Scene.episode_id == episode.id).order_by(Scene.order, Scene.id).all()
    shots = db.query(Shot).filter(Shot.episode_id == episode.id, Shot.include.is_(True)).order_by(Shot.order, Shot.id).all()
    cast_ids: list[int] = []
    for s in shots:
        for cid in s.characters or []:
            if int(cid) not in cast_ids:
                cast_ids.append(int(cid))
    for sc in scenes:
        for cid in (sc.wardrobe or {}):
            if str(cid).isdigit() and int(cid) not in cast_ids:
                cast_ids.append(int(cid))
    chars = {c.id: c for c in db.query(Character).filter(Character.id.in_(cast_ids)).all()} if cast_ids else {}
    out = []
    for cid in cast_ids:
        ch = chars.get(cid)
        if not ch:
            continue
        rows = []
        last = None
        for sc in scenes:
            sc_shots = [s for s in shots if s.scene_id == sc.id and cid in [int(x) for x in (s.characters or [])]]
            if not sc_shots and str(cid) not in (sc.wardrobe or {}):
                continue
            per_shot = {(s.outfits or {}).get(str(cid)) for s in sc_shots if (s.outfits or {}).get(str(cid))}
            scene_outfit = (sc.wardrobe or {}).get(str(cid)) or ""
            end = ((sc.end_state or {}).get("characters") or {}).get(str(cid), {}).get("outfit") or ""
            outfit = scene_outfit or (next(iter(per_shot)) if len(per_shot) == 1 else "") or end
            source = "scene" if scene_outfit else ("shot" if per_shot else ("bible" if end else "default"))
            scripted = bool(sc.continuity_notes and "outfit" in sc.continuity_notes.lower()) or sc.order == 0
            change = bool(last) and bool(outfit) and outfit != last
            rows.append({"scene_id": sc.id, "order": sc.order, "title": sc.title, "outfit": outfit, "source": source,
                         "mixed": len(per_shot) > 1, "change": change, "break": change and not scripted and not scene_outfit})
            if outfit:
                last = outfit
        out.append({"character_id": cid, "name": ch.name, "scenes": rows})
    return {"episode_id": episode.id, "characters": out,
            "breaks": sum(1 for c in out for r in c["scenes"] if r["break"])}


def get_scene(db: Session, scene_id: int) -> Scene:
    sc = db.get(Scene, scene_id)
    if not sc:
        raise HTTPException(404, "Scene not found")
    return sc
