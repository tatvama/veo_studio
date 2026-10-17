"""Which shot a shot continues from, and which scene picks up straight from the one before.

The plain rules, without any generation: core/scene_chain.py (which makes the videos in link order) and
core/generation.py (which prices Produce all) both read them, and neither has to import the other for it.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Scene, Shot
from ..pipeline.selection import current, is_real
from . import frames


def _prev_shot(db: Session, shot: Shot) -> Shot | None:
    return (db.query(Shot).filter(Shot.episode_id == shot.episode_id, Shot.include.is_(True), Shot.order < shot.order)
            .order_by(Shot.order.desc()).first())


def source(db: Session, shot: Shot) -> Shot | None:
    """The shot this one continues from (same rule as the keyframe job: an explicit link first, else the previous
    shot when "continue from previous" is on)."""
    if shot.continuity_from_shot_id:
        src = db.get(Shot, shot.continuity_from_shot_id)
        if src and src.episode_id == shot.episode_id:
            return src
    return _prev_shot(db, shot) if shot.continuity_from_prev else None


def extends(shot: Shot) -> bool:
    return bool(shot.continuity_from_shot_id) and shot.continuity_mode == "extend"


def scene_shots(db: Session, scene: Scene) -> list[Shot]:
    return (db.query(Shot).filter(Shot.scene_id == scene.id, Shot.include.is_(True)).order_by(Shot.order, Shot.id).all())


def previous_scene(db: Session, scene: Scene) -> Scene | None:
    return (db.query(Scene).filter(Scene.episode_id == scene.episode_id, Scene.order < scene.order)
            .order_by(Scene.order.desc()).first())


def scene_link_candidate(db: Session, scene: Scene, rule: str = "auto") -> tuple[Shot, Shot] | None:
    """(first shot of this scene, last shot of the previous scene) when this scene picks up straight from the previous
    one: same place, same time of day and someone in common ("auto"), or always ("always"). None when the first shot
    already has a link of its own or a finished video."""
    if rule not in ("auto", "always"):
        return None
    prev = previous_scene(db, scene)
    mine = scene_shots(db, scene)
    theirs = scene_shots(db, prev) if prev else []
    if not prev or not mine or not theirs:
        return None
    first, last = mine[0], theirs[-1]
    if first.continuity_from_shot_id or first.continuity_from_prev or is_real(current(db, first.id, "video")):
        return None  # it has its own link, or its clip is already made (linking now would only report it as broken)
    if rule == "auto":
        same_place = bool(scene.location_id) and scene.location_id == prev.location_id
        same_time = (scene.time_of_day or "").strip().lower() == (prev.time_of_day or "").strip().lower()
        shared = {str(c) for c in (first.characters or [])} & {str(c) for c in (last.characters or [])}
        if not (same_place and same_time and shared):
            return None
    return first, last


def planned_links(db: Session, shots: list[Shot], rule: str = "auto") -> dict[int, int]:
    """{first shot of a scene: last shot of the scene before} for the scenes of these shots that would be linked by
    `rule` (scene_link_candidate; nothing is changed)."""
    if rule not in ("auto", "always"):
        return {}
    out: dict[int, int] = {}
    for sid in dict.fromkeys(s.scene_id for s in shots if s.scene_id):
        sc = db.get(Scene, sid)
        cand = scene_link_candidate(db, sc, rule) if sc else None
        if cand:
            out[cand[0].id] = cand[1].id
    return out


def waits_for_clip(db: Session, shot: Shot, planned: dict[int, int] | None = None) -> bool:
    """The shot starts from the last frame of a clip that isn't made yet (its own link, or one `planned`): its keyframe
    is made from that clip once it exists (scene_chain.make_videos_in_order), so making one now would be paid twice."""
    src = source(db, shot)
    if src is None and planned and shot.id in planned:
        src = db.get(Shot, planned[shot.id])
    if src is None or extends(shot) or frames.synced(shot):
        return False
    return not is_real(current(db, src.id, "video"))
