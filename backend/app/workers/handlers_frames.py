"""Start and end frames (core/frames.py): the end frame of a shot, the start frame of a synced shot (a copy of the end
frame it starts on), and a scene's whole storyboard made frame by frame, in order."""
from __future__ import annotations

from pathlib import Path

from ..core import frames, model_hub
from ..db import SessionLocal, utcnow
from ..events import emit
from ..models import Episode, Project, Shot
from ..pipeline import scene_look
from ..pipeline.prompting import compile_endframe_prompt, endframe_refs
from ..pipeline.selection import current, is_real
from ..providers.base import ProviderError
from ..storage import get_storage
from .handlers import _project_of, gen_image, make_keyframe, save_take
from .handlers_room import _run_spend, _wait_batch_idle
from .worker import JobContext, handler


def synced_start(ctx: JobContext, shot_id: int, own: dict, seen: set[int]) -> dict | None:
    """A synced shot's start frame: a copy of the end frame it starts on (that end frame is made first when missing).
    None when the shot is not synced (or the link loops back on itself): its keyframe is made the usual way."""
    st = get_storage()
    with SessionLocal() as db:
        shot = db.get(Shot, shot_id)
        src = frames.sync_source(db, shot)
        if src is None or src.id in seen:
            return None
        src_id, src_code, code = src.id, src.code, shot.code
        end = frames.end_take(db, src)
        end_id = end.id if end else None
    if end_id is None:
        ctx.progress(0.05, f"{code} starts on {src_code}'s end frame: making that first")
        make_endframe(ctx, src_id, {k: own[k] for k in ("engine", "hero") if own.get(k)}, seen | {shot_id})
    with SessionLocal() as db:
        shot = db.get(Shot, shot_id)
        end = frames.end_take(db, db.get(Shot, src_id))
        if end is None:
            raise ProviderError(f"{code} starts on {src_code}'s end frame, and {src_code} has none")
        ep = (end.params or {})
        params = {"synced_from": src_id, "end_take_id": end.id, "engine": ep.get("engine") or "",
                  "engine_label": f"{src_code}'s end frame", "copied": True, "continuity": True}
        if ep.get("mock"):
            params["mock"] = True
        t = save_take(db, ctx, shot, "keyframe", None, Path(end.path).suffix.lstrip(".") or "png",
                      src_file=st.abs(end.path), provider=end.provider, model=end.model, params=params,
                      prompt=end.prompt, cost=0.0)
        if shot.status in ("draft", "keyframe_ready"):
            shot.status = "keyframe_ready"
        db.commit()
        emit(db, ctx.project_id, "take.created", {"shot_id": shot.id, "take_id": t.id, "kind": "keyframe"})
        return {"take_id": t.id, "engine": "synced", "from_take_id": end.id}


def make_endframe(ctx: JobContext, shot_id: int, own: dict | None = None, seen: set[int] | None = None) -> dict:
    """Make and save the end frame of `shot_id`, its start frame first when it has none: the same shot seconds later,
    where the action has got to (Shot.end_note). Used by the end-frame job, by a video job whose clip runs to an end
    frame, and by a synced shot whose start frame is this end frame."""
    own = dict(own or {})
    seen = set(seen or ()) | {shot_id}
    st = get_storage()
    retake = int(own.get("retake_count") or 0)
    with SessionLocal() as db:
        shot = db.get(Shot, shot_id)
        code = shot.code
        kf = current(db, shot_id, "keyframe")
        ready = kf is not None and is_real(kf) and st.exists(kf.path) and frames.start_ok(db, shot)
    if not ready:
        ctx.progress(0.05, f"{code}: making the start frame first")
        make_keyframe(ctx, shot_id, {k: own[k] for k in ("engine", "hero") if own.get(k)}, seen)
    with SessionLocal() as db:
        shot = db.get(Shot, shot_id)
        project = _project_of(db, shot)
        kf = current(db, shot_id, "keyframe")
        if kf is None or not st.exists(kf.path):
            raise ProviderError(f"{code}: no start frame to make the end frame from")
        start_id = kf.id
        refs = endframe_refs(db, shot, st.abs(kf.path))
        prompt = compile_endframe_prompt(db, shot, project, [l for l, _ in refs], fix=own.get("fix"))
        explicit = own.get("engine") or frames.engine_id(db, project) or ("google:image_hero" if own.get("hero") else None)
        seed = scene_look.scene_seed(shot, project.id, retake)  # the scene's seed: the end frame keeps the start's look
        aspect = project.aspect
        db.commit()
    ctx.progress(0.3, f"End frame {code}")
    res, engine = gen_image(ctx, prompt, [p for _, p in refs], aspect, title=f"{code} end frame", explicit=explicit,
                            seed=seed)
    with SessionLocal() as db:
        shot = db.get(Shot, shot_id)
        params = {"refs": [l for l, _ in refs], "start_take_id": start_id, "engine": engine,
                  "engine_label": model_hub.label(db, engine), "seed": seed, "retake_count": retake}
        if own.get("fix"):
            params["fix"] = list(own["fix"])
        t = save_take(db, ctx, shot, frames.END, res.data, res.ext, provider=res.usage.provider, model=res.usage.model,
                      params=params, prompt=prompt, cost=res.usage.usd)
        ctx.cost(res.usage, db)
        db.commit()
        emit(db, ctx.project_id, "take.created", {"shot_id": shot.id, "take_id": t.id, "kind": frames.END})
    if ctx.type == "endframe" and shot_id == ctx.shot_id:
        from .handlers_keyframe import queue_qc
        queue_qc(ctx, t.id, shot_id, code)  # the same vision check as a keyframe, against the shot's start frame
    return {"take_id": t.id, "engine": engine}


@handler("endframe")
def endframe(ctx: JobContext) -> dict:
    """payload: engine (an image engine; default the project's frames engine), hero, fix, retake_count."""
    return make_endframe(ctx, ctx.shot_id, ctx.payload)


@handler("storyboard_frames")
def storyboard_frames(ctx: JobContext) -> dict:
    """A scene's storyboard, frame by frame and in order, each frame following the one before (start 1 → end 1 →
    start 2 …). payload: shot_ids (in order), engine, end_frames, sync, redo, hero.

    With `sync` each shot of a scene after its first starts exactly on the end frame of the shot before (a synced link;
    the links are set here). Every frame waits for the one before it and for its QC (and automatic retake), so the next
    frame always follows the final picture. Already-good frames are kept unless `redo`."""
    p = ctx.payload
    ids = [int(i) for i in p.get("shot_ids") or []]
    engine = p.get("engine") or None
    hero = bool(p.get("hero"))
    done: list[dict] = list(ctx.result.get("made") or [])

    def guard() -> None:
        ctx.check_cancel()
        spent, cap = _run_spend(ctx)
        if spent > cap and spent > 0:
            raise ProviderError(f"Storyboard stopped: spent ${spent:.2f}, above the approved ${cap:.2f} guard")

    with SessionLocal() as db:
        project = db.get(Project, ctx.project_id)
        shots = [s for s in (db.get(Shot, i) for i in ids) if s is not None and s.include]
        linked = frames.sync_scenes(db, shots) if p.get("sync") else []
        steps = frames.plan(db, project, shots, end_frames=bool(p.get("end_frames", True)), redo=bool(p.get("redo")),
                            engine=engine)["steps"]
        db.commit()
    if linked:
        ctx.save_result(linked=linked)
        emit(None, ctx.project_id, "episode.updated", {"episode_id": ctx.episode_id, "what": "links"})
    for n, step in enumerate(steps):
        guard()
        sid, kind = step["shot_id"], step["kind"]
        if any(d["shot_id"] == sid and d["kind"] == kind and d["status"] == "succeeded" for d in done):
            continue  # this run was resumed (after a restart): that frame is made already
        label = f"{'Start' if kind == 'keyframe' else 'End'} frame {step['code']}"
        ctx.progress(n / max(len(steps), 1), f"{label} ({n + 1}/{len(steps)})")
        with SessionLocal() as db:
            shot = db.get(Shot, sid)
            if shot is None:
                continue
            if not step.get("forced") and frames.step_done(db, shot, kind):
                continue  # made meanwhile (a retake, another run): keep it
            project = db.get(Project, ctx.project_id)
            usd = 0.0 if step.get("copy") else frames.image_price(db, project, 1, engine, hero)
        payload = {k: v for k, v in (("engine", engine), ("hero", hero)) if v}
        cid = ctx.enqueue_child(kind, payload, shot_id=sid, estimate=usd, label=label)
        st = ctx.wait_children([cid], label, guard=guard)
        _wait_batch_idle(ctx, guard)  # its QC and automatic retake: the next frame follows the final picture
        done = [d for d in done if not (d["shot_id"] == sid and d["kind"] == kind)]
        done.append({"shot_id": sid, "code": step["code"], "kind": kind, "status": st.get(cid, "?")})
        ctx.save_result(made=done, updated_at=utcnow().isoformat() + "Z")
    with SessionLocal() as db:
        ep = db.get(Episode, ctx.episode_id) if ctx.episode_id else None
        if ep is not None:
            emit(db, ctx.project_id, "episode.updated", {"episode_id": ep.id, "what": "storyboard_frames"})
    failed = [d["code"] for d in done if d["status"] != "succeeded"]
    return {"made": done, "failed": failed, "linked": linked or ctx.result.get("linked") or []}
