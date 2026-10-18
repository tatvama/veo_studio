"""Start and end frames: a shot's clip runs from its start frame (the keyframe) to an end frame of its own, and the
next shot can start exactly on that end frame, so the clips join without a jump.

- A shot's end frame is a take of kind "endframe": made by the `endframe` job from the shot's start frame (same
  camera, set, light and faces; the moment the shot ends, `Shot.end_note`), or your own image. The video job then asks
  the engine for first + last frame ("flf": Seedance, Veo, Kling …); an engine without it starts from the start frame.
- A shot linked with continuity_mode "end_frame" (a synced link) starts on its source shot's end frame: its keyframe
  is a copy of that image (no image call). Both clips come from frames known in advance, so they are made at the same
  time, without waiting for the clip before.
- A scene's frames (its storyboard) are made in order by the `storyboard_frames` job (workers/handlers_frames.py),
  each frame following the one before: start 1 → end 1 (= start 2 when synced) → end 2 …
- The image engine: the project's `frames_engine` when one is picked (e.g. Seedream 5.0 Pro for a Seedance film), else
  the team's image chain (Google first).
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ..models import AIModel, Job, Project, Shot, Take
from ..pipeline.selection import current, is_real
from ..storage import get_storage
from .links import SYNC, synced  # (the link rules live there: core/links.py imports nothing of core)
from .staleness import mark_stale  # (nor does core/staleness.py)

END = "endframe"  # the take kind
MAX_CHAIN = 50  # synced links followed up a chain at most (a cycle stops earlier)
FRAME_WORK = ("keyframe", "endframe", "video")  # jobs that may make a shot's start or end frame


def sync_source(db: Session, shot: Shot) -> Shot | None:
    """The shot whose end frame this shot starts on (a synced link), else None."""
    if not synced(shot):
        return None
    src = db.get(Shot, shot.continuity_from_shot_id)
    return src if src is not None and src.episode_id == shot.episode_id and src.id != shot.id else None


def followers(db: Session, shot: Shot) -> list[Shot]:
    """Shots that start on this shot's end frame."""
    return (db.query(Shot).filter(Shot.continuity_from_shot_id == shot.id, Shot.continuity_mode == SYNC,
                                  Shot.include.is_(True), Shot.id != shot.id)
            .order_by(Shot.order, Shot.id).all())


def end_take(db: Session, shot: Shot | None) -> Take | None:
    """The shot's current end frame when it can be used: on disk, real work (not a placeholder made without a key)
    and not out of date."""
    if shot is None:
        return None
    t = current(db, shot.id, END)
    return t if t is not None and is_real(t) and not t.stale and get_storage().exists(t.path) else None


def wants_end(db: Session, shot: Shot) -> bool:
    """The clip should end on an end frame: it has one (an out-of-date one is remade first), or a shot starts on it."""
    return current(db, shot.id, END) is not None or bool(followers(db, shot))


def is_copy_of(kf: Take | None, end: Take | None) -> bool:
    """Is this keyframe the end frame it should start on? Your own uploaded image always counts as right."""
    if kf is None or end is None:
        return False
    p = kf.params or {}
    return kf.provider == "upload" or bool(p.get("uploaded")) or p.get("end_take_id") == end.id


def start_ok(db: Session, shot: Shot) -> bool:
    """A synced shot's keyframe is usable: it is the copy of its source's current end frame (and not out of date)."""
    src = sync_source(db, shot)
    kf = current(db, shot.id, "keyframe")
    if kf is None or kf.stale:
        return False
    return src is None or is_copy_of(kf, end_take(db, src))


def chain_up(db: Session, shot: Shot) -> list[Shot]:
    """The shots a synced shot's start frame comes from, nearest first (the source, its source …)."""
    out: list[Shot] = []
    seen = {shot.id}
    src = sync_source(db, shot)
    while src is not None and src.id not in seen and len(out) < MAX_CHAIN:
        out.append(src)
        seen.add(src.id)
        src = sync_source(db, src)
    return out


# ── the image engine ─────────────────────────────────────────────────────────

def engine_id(db: Session, project: Project | None) -> str | None:
    """The image engine picked for this project's frames while it is enabled and makes images; None = the team's
    image chain."""
    eid = ((project.frames_engine if project is not None else "") or "").strip()
    if not eid:
        return None
    m = db.get(AIModel, eid)
    return eid if m is not None and m.status == "enabled" and m.task == "image" else None


def image_price(db: Session, project: Project | None, n: int = 1, engine: str | None = None, hero: bool = False) -> float:
    """What `n` frames cost on the picked engine (or the project's), else on the team's image chain."""
    from ..providers.services import provider_mode
    from . import model_hub
    from .budget import Estimator
    eid = engine or engine_id(db, project)
    m = db.get(AIModel, eid) if eid else None
    if m is None:
        return Estimator(db).image(n, hero)
    return model_hub.price_for(m, units=max(n, 0)) if provider_mode(m.provider) == "live" else 0.0


def image_engines(db: Session) -> list[AIModel]:
    """Enabled image engines that can take reference images (a frame must follow the cast and the frame before)."""
    from ..providers.services import provider_mode
    rows = db.query(AIModel).filter(AIModel.status == "enabled", AIModel.task == "image").all()
    return [m for m in rows if "i2i" in ((m.capabilities or {}).get("modes") or [])
            and (m.capabilities or {}).get("usable") is not False and provider_mode(m.provider) != "missing"]


# ── holds: a synced shot's job waits while the frames it starts on are being made ─

def _chain_of(db: Session, shot_id: int | None, src_id: int) -> list[int] | None:
    """The shots whose end frames a synced shot waits on: its source and up the chain; None for a loop of synced
    links back to the shot itself (nobody in a loop waits, so a loop never stalls)."""
    src = db.get(Shot, src_id)
    if src is None:
        return None
    chain = [src.id] + [s.id for s in chain_up(db, src)]
    return None if shot_id in chain else chain


def holding_sources(db: Session, cands: list[Job], now: Any, max_run: Any, max_backoff: Any) -> set[int]:
    """Ids of the queued jobs in `cands` that wait for the end frame they start on (payload `after_end`): while a
    shot up their synced chain has no usable end frame yet and frame work of its own running (up to `max_run`) or
    queued to run soon (a back-off up to `max_backoff`). A queued job that waits itself still counts: the shot after
    it waits for it, so the chain is made top-down and every end frame once."""
    chains: dict[int, list[int]] = {}
    for j in cands:
        sid = (j.payload or {}).get("after_end") if j.type in FRAME_WORK else None
        if sid:
            ch = _chain_of(db, j.shot_id, int(sid))
            if ch:
                chains[j.id] = ch
    ids = {i for ch in chains.values() for i in ch}
    if not ids:
        return set()
    rows = db.query(Job).filter(Job.type.in_(FRAME_WORK), Job.shot_id.in_(ids), Job.status.in_(("queued", "running"))).all()
    busy: set[int] = set()
    for r in rows:
        if r.status == "running":
            active = r.started_at is None or now - r.started_at < max_run
        else:
            active = r.run_after is None or r.run_after <= now + max_backoff
        if active:
            busy.add(r.shot_id)
    if busy:
        busy -= {sid for sid in busy if end_take(db, db.get(Shot, sid)) is not None}
    return {jid for jid, ch in chains.items() if busy & set(ch)}


def after_end(db: Session, shot: Shot) -> int | None:
    """The `after_end` a job of this shot carries: its source shot, while that has no usable end frame yet (never
    inside a loop of synced links)."""
    src = sync_source(db, shot)
    if src is None or end_take(db, src) is not None or _chain_of(db, shot.id, src.id) is None:
        return None
    return src.id


# ── a storyboard run: every frame of some shots, in order ────────────────────

def _usable_kf(db: Session, shot: Shot) -> Take | None:
    kf = current(db, shot.id, "keyframe")
    return kf if kf is not None and is_real(kf) and not kf.stale and get_storage().exists(kf.path) else None


def step_done(db: Session, shot: Shot, kind: str) -> bool:
    """Is this frame already good? A start frame: there, real and up to date (a synced shot's: the copy of its source's
    current end frame). An end frame: there, real, up to date and made from the shot's current start frame."""
    kf = _usable_kf(db, shot)
    if kind == "keyframe":
        return kf is not None and start_ok(db, shot)
    end = end_take(db, shot)
    if end is None or kf is None:
        return False
    made_from = (end.params or {}).get("start_take_id")
    return made_from is None or made_from == kf.id or end.provider == "upload" or bool((end.params or {}).get("uploaded"))


def _scene_runs(shots: list[Shot]) -> list[list[Shot]]:
    """Consecutive shots of the same scene (in the given order): a storyboard syncs inside a scene, never across a cut
    between scenes."""
    runs: list[list[Shot]] = []
    for s in shots:
        if runs and s.scene_id is not None and runs[-1][-1].scene_id == s.scene_id:
            runs[-1].append(s)
        else:
            runs.append([s])
    return runs


def sync_scenes(db: Session, shots: list[Shot]) -> list[str]:
    """Link each shot of a scene after its first to the shot before it as synced (it starts on that shot's end frame).
    Returns the links set ("B ← A"). Takes made under the old link are flagged out of date."""
    out = []
    for run in _scene_runs(shots):
        for prev, s in zip(run, run[1:]):
            if s.continuity_from_shot_id == prev.id and s.continuity_mode == SYNC:
                continue
            s.continuity_from_shot_id, s.continuity_mode, s.continuity_from_prev = prev.id, SYNC, False
            mark_stale(db, s, {"continuity_from_shot_id", "continuity_mode"}, note="synced to the shot before")
            out.append(f"{s.code} ← {prev.code}")
    db.flush()
    return out


def plan(db: Session, project: Project, shots: list[Shot], *, end_frames: bool = True, redo: bool = False,
         engine: str | None = None, sync: bool = False, hero: bool = False) -> dict[str, Any]:
    """The frames a storyboard run makes for these shots (in order), and what they cost. Nothing is changed:
    with `sync` the links sync_scenes would set are assumed.

    Per shot: its start frame (a synced shot's is a free copy of the end frame before), then its end frame when
    `end_frames` or a shot starts on it. A frame is made when it is missing or out of date, when what it follows is
    remade in this run (a new start frame → a new end frame → a new copy after it), or always with `redo`. A synced
    shot whose source is not in the run gets that source's end frame made first when it has none."""
    order = [s for s in shots if s.include]
    in_run = {s.id for s in order}
    src_of: dict[int, Shot | None] = {}
    for run in _scene_runs(order):
        for i, s in enumerate(run):
            src_of[s.id] = run[i - 1] if (sync and i > 0) else sync_source(db, s)
    starts_on: dict[int, list[int]] = {}
    for sid, src in src_of.items():
        if src is not None:
            starts_on.setdefault(src.id, []).append(sid)
    for s in order:  # synced shots outside the run that start on a shot in it
        for f in followers(db, s):
            if f.id not in in_run and not (sync and src_of.get(f.id) is not None):
                starts_on.setdefault(s.id, []).append(f.id)
    steps: list[dict[str, Any]] = []
    remade: set[tuple[int, str]] = set()

    def add(shot: Shot, kind: str, copy: bool, forced: bool) -> None:
        steps.append({"shot_id": shot.id, "code": shot.code, "kind": kind, "copy": copy, "forced": forced})
        remade.add((shot.id, kind))

    for s in order:
        src = src_of.get(s.id)
        if src is not None and src.id not in in_run and end_take(db, src) is None and (src.id, END) not in remade:
            add(src, END, False, False)  # the source is outside the run and has no end frame yet
        kf_done = step_done(db, s, "keyframe")
        if src is not None:
            src_new = (src.id, END) in remade
            if sync and not (s.continuity_from_shot_id == src.id and s.continuity_mode == SYNC):
                kf_done = False  # the link is new: its start frame becomes the copy
            if redo or src_new or not kf_done:
                add(s, "keyframe", True, redo or src_new or kf_done)
        elif redo or not kf_done:
            add(s, "keyframe", False, redo or kf_done)
        needs_end = end_frames or bool(starts_on.get(s.id)) or current(db, s.id, END) is not None
        if needs_end:
            start_new = (s.id, "keyframe") in remade
            e_done = step_done(db, s, END)
            if redo or start_new or not e_done:
                add(s, END, False, redo or (start_new and e_done))
    paid = sum(1 for st in steps if not st["copy"])
    usd = image_price(db, project, paid, engine, hero) if paid else 0.0
    eid = engine or engine_id(db, project)
    m = db.get(AIModel, eid) if eid else None
    return {"steps": steps, "images": paid, "copies": sum(1 for st in steps if st["copy"]), "total_usd": round(usd, 4),
            "engine": eid or "", "engine_label": m.display_name if m else "Team image chain (Google first)",
            "shots": [s.code for s in order]}


def link_out(db: Session, shot: Shot) -> dict[str, Any] | None:
    """For the shot card: which shot this one starts on and whether its start frame is that end frame (ok / waiting
    for the source's end frame / broken: made from another picture)."""
    src = sync_source(db, shot)
    if src is None:
        return None
    end = end_take(db, src)
    kf = current(db, shot.id, "keyframe")
    if end is None:
        status = "waiting"
    elif kf is None or kf.stale:
        status = "pending"
    else:
        status = "ok" if is_copy_of(kf, end) else "broken"
    return {"from_shot_id": src.id, "from": src.code, "status": status, "end_take_id": end.id if end else None}
