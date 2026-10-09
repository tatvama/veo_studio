"""Scene-by-scene generation with continuity carried forward (the `scene_chain` job, also used by Autopilot and
Produce all for their video step).

A shot linked to the one before it (a Film Map link, or "continue from the previous shot", which the breakdown sets
inside a scene) needs that shot's FINISHED clip: its keyframe starts from the clip's last frame, or its video extends
the clip. Queued all at once, a linked shot can start before its source is done; it then falls back to the source's
keyframe and the cut jumps. Here shots run in waves: a shot starts only once the shot it continues from has its video.

Before a scene starts, every earlier scene has its Continuity Bible end state (written by AI from the script when
missing, core/continuity.py), so the prompts carry who wears what, what is in hand, time of day and weather forward.
"""
from __future__ import annotations

from typing import Any, Callable

from sqlalchemy.orm import Session

from ..models import Episode, Project, Scene, Shot, Take, User
from ..pipeline.selection import current, is_real
from . import continuity, generation
from .budget import Estimator

LINK_SCENES = ("auto", "always", "never")


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


def follows(kf: Take, src_video: Take) -> bool:
    """Did this keyframe start from the last frame of `src_video`? Your own uploaded image always counts as right."""
    p = kf.params or {}
    if kf.provider == "upload" or p.get("uploaded"):
        return True
    if p.get("continuity_take_id") is not None:
        return p["continuity_take_id"] == src_video.id
    # keyframes made before the job recorded its source clip: it can only have used a clip that already existed
    return bool(p.get("continuity")) and kf.created_at is not None and src_video.created_at is not None \
        and kf.created_at >= src_video.created_at


def needs_new_keyframe(db: Session, shot: Shot) -> bool:
    """The shot has a keyframe, but it was not made from the current clip of the shot it continues from (it was made
    from that shot's keyframe, or from an older take). A missing or stale keyframe is remade by the video job anyway."""
    src = source(db, shot)
    if src is None or extends(shot):
        return False
    sv = current(db, src.id, "video")
    if not is_real(sv):
        return False  # nothing better to start from yet
    kf = current(db, shot.id, "keyframe")
    if kf is None or kf.stale:
        return False
    return not follows(kf, sv)


def link_status(db: Session, shot: Shot) -> dict[str, Any] | None:
    """How the shot's link to the shot before it stands: ok, waiting (no source clip yet), or broken (made from an
    older picture than the source's current clip)."""
    src = source(db, shot)
    if src is None:
        return None
    mode = "extend" if extends(shot) else "last_frame"
    out: dict[str, Any] = {"from": src.code, "mode": mode, "explicit": bool(shot.continuity_from_shot_id)}
    sv, vid, kf = current(db, src.id, "video"), current(db, shot.id, "video"), current(db, shot.id, "keyframe")
    if not is_real(sv):
        out.update(status="waiting", note=f"{src.code} has no video yet; generate in scene order")
    elif mode == "extend":
        ok = vid is not None and vid.parent_take_id == sv.id
        out.update(status="ok" if ok else ("broken" if vid else "pending"),
                   note="" if ok else (f"made before {src.code}'s current clip" if vid else "not generated yet"))
    elif kf is None or not follows(kf, sv):
        out.update(status="broken" if (vid or kf) else "pending",
                   note=f"its first frame is not {src.code}'s last frame" if (vid or kf) else "not generated yet")
    elif vid is not None and kf.created_at and vid.created_at and vid.created_at < kf.created_at:
        out.update(status="broken", note="the keyframe was redone after the video; the video is older")
    else:
        out.update(status="ok", note="" if vid else "first frame ready; video not generated yet")
    return out


def waves(db: Session, shots: list[Shot]) -> list[list[Shot]]:
    """Order shots so each starts after the shot it continues from (when that one is also being made)."""
    ids = {s.id for s in shots}
    by_id = {s.id: s for s in shots}
    depth: dict[int, int] = {}

    def d(s: Shot, seen: frozenset[int]) -> int:
        if s.id in depth:
            return depth[s.id]
        src = source(db, s)
        if src is None or src.id not in ids or src.id in seen:
            depth[s.id] = 0
        else:
            depth[s.id] = d(by_id[src.id], seen | {s.id}) + 1
        return depth[s.id]

    for s in shots:
        d(s, frozenset())
    out: list[list[Shot]] = [[] for _ in range(max(depth.values(), default=-1) + 1)]
    for s in shots:
        out[depth[s.id]].append(s)
    return [w for w in out if w]


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


def plan(db: Session, project: Project, episode: Episode, scenes: list[Scene], quality: str | None = None,
         fix_links: bool = False, link_scenes: str = "auto") -> dict[str, Any]:
    """What a scene chain run would make, scene by scene, and what it costs (nothing is changed)."""
    est = Estimator(db)
    out_scenes, total = [], 0.0
    for sc in scenes:
        shots = scene_shots(db, sc)
        items, notes = [], []
        cand = scene_link_candidate(db, sc, link_scenes)
        if cand:
            notes.append(f"{cand[0].code} will start from the last frame of {cand[1].code} (the previous scene's last shot)")
        for s in shots:
            vid = current(db, s.id, "video")
            link = link_status(db, s)
            redo = fix_links and link is not None and link["status"] == "broken"
            if is_real(vid) and not vid.stale and not redo:
                continue
            v = generation.video_specs(db, project, [s], quality)[0]
            usd = v["estimate"]
            kf_remake = link is not None and not extends(s) and (redo or link["status"] in ("broken", "waiting"))
            kf = current(db, s.id, "keyframe")
            if kf_remake and kf is not None and not kf.stale and not (kf.provider == "upload" or (kf.params or {}).get("uploaded")):
                usd += est.image(1)
            items.append({"shot": s.code, "video": True, "new_keyframe": bool(kf_remake), "usd": round(usd, 4),
                          "continues_from": link["from"] if link else None,
                          "why": "fix the link" if redo else ("out of date" if vid is not None and vid.stale else "missing")})
            total += usd
        broken = [s.code for s in shots if (ls := link_status(db, s)) and ls["status"] == "broken"]
        if broken and not fix_links:
            notes.append(f"links already broken in {', '.join(broken)} (their clips were made before the clip they "
                         "continue from); run with fix_links=true to remake them")
        out_scenes.append({"scene": sc.order + 1, "scene_id": sc.id, "title": sc.title, "shots": [s.code for s in shots],
                           "to_make": items, "has_end_state": bool(sc.end_state), "notes": notes,
                           "usd": round(sum(i["usd"] for i in items), 4)})
    return {"scenes": out_scenes, "total_usd": round(total, 2),
            "shots_to_make": sum(len(s["to_make"]) for s in out_scenes)}


def ensure_end_states(db: Session, user: User | None, project: Project, episode: Episode, upto_order: int) -> list[int]:
    """Write the Continuity Bible end state of every scene before `upto_order` that has none (in order, so each one
    builds on the one before). Hand-written states are kept. Returns the scene numbers written."""
    done = []
    for sc in (db.query(Scene).filter(Scene.episode_id == episode.id, Scene.order < upto_order)
               .order_by(Scene.order, Scene.id).all()):
        if not sc.end_state:
            continuity.end_state(db, user, project, episode, sc)
            done.append(sc.order + 1)
    return done


def link_to_previous_scene(db: Session, scene: Scene, rule: str) -> str | None:
    cand = scene_link_candidate(db, scene, rule)
    if not cand:
        return None
    first, last = cand
    first.continuity_from_shot_id, first.continuity_mode = last.id, "last_frame"
    db.commit()
    return f"{first.code} ← {last.code}"


Run = Callable[[list[dict], str], Any]


def make_videos_in_order(open_db: Callable[[], Session], run: Run, project_id: int, shot_ids: list[int],
                         quality: str | None = None, label: str = "Videos", fix_links: bool = False) -> dict[str, Any]:
    """Make the videos of these shots in link order (`run(specs, label)` queues child jobs and waits for them, and
    for their QC and retakes). A linked shot whose keyframe was not made from the source's finished clip gets a new
    keyframe first. Returns {"waves": n, "videos": n, "keyframes": n, "warnings": [...]}."""
    with open_db() as db:
        shots = [s for s in (db.get(Shot, i) for i in shot_ids) if s is not None]
        order = [[s.id for s in w] for w in waves(db, shots)]
    made_v = made_k = 0
    warnings: list[str] = []
    for i, wave in enumerate(order, 1):
        step = f"{label} {i}/{len(order)}" if len(order) > 1 else label
        with open_db() as db:
            project = db.get(Project, project_id)
            shots = [db.get(Shot, sid) for sid in wave]
            for s in shots:
                src = source(db, s)
                if src is not None and src.id not in shot_ids and not is_real(current(db, src.id, "video")):
                    warnings.append(f"{s.code} continues from {src.code}, which has no video: it starts from {src.code}'s keyframe")
            redo = [s for s in shots if needs_new_keyframe(db, s)]
            kf_specs = generation.keyframe_specs(db, project, redo)
            db.commit()
        if kf_specs:
            run(kf_specs, f"{step}: first frames from the clips before")
            made_k += len(kf_specs)
        with open_db() as db:
            project = db.get(Project, project_id)
            shots = [db.get(Shot, sid) for sid in wave]
            v_specs = generation.video_specs(db, project, shots, quality)
            db.commit()
        if v_specs:
            run(v_specs, step)
            made_v += len(v_specs)
    return {"waves": len(order), "videos": made_v, "keyframes": made_k, "warnings": warnings}


def shots_to_make(db: Session, shots: list[Shot], fix_links: bool = False) -> list[Shot]:
    out = []
    for s in shots:
        vid = current(db, s.id, "video")
        if not is_real(vid) or vid.stale:
            out.append(s)
        elif fix_links and (ls := link_status(db, s)) and ls["status"] == "broken":
            out.append(s)
    return out
