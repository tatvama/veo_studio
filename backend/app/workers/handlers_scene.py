"""The scene chain: make an episode's videos scene by scene, carrying continuity forward (core/scene_chain.py)."""
from __future__ import annotations

from ..core import problems, scene_chain
from ..db import SessionLocal, utcnow
from ..events import emit
from ..models import Episode, Project, Scene
from .handlers import _user
from .handlers_room import RunLog
from .worker import BudgetStop, JobContext, handler


@handler("scene_chain")
def scene_chain_run(ctx: JobContext) -> dict:
    """payload: scene_ids (in order), quality, fix_links, link_scenes (auto|always|never), pause_after_each.
    For each scene: write the end states of the scenes before it, link its first shot to the previous scene when it
    picks up straight from it, make its videos in link order (waiting for QC and retakes), write its own end state.
    With pause_after_each the run stops after a scene that made something; running it again carries on. What fails is
    listed as the run's problems; spending past the guard stops it with the work in flight finished."""
    r = RunLog(ctx, "Scenes in order")
    if not ctx.result.get("scenes"):  # (a run resumed after a restart keeps the problems it found so far)
        problems.start(ctx.episode_id)
    try:
        try:
            out = _scenes(ctx, r)
        except BudgetStop:
            r.stopped_at_budget("Scenes in order")
            out = {"scenes": list(ctx.result.get("scenes") or []), "stopped": "budget"}
    except BaseException:
        r.save(announce=False)
        raise
    out["problems"] = r.save(announce=True)
    return out


def _scenes(ctx: JobContext, r: RunLog) -> dict:
    p = ctx.payload
    scene_ids = [int(i) for i in p.get("scene_ids") or []]
    quality = p.get("quality") or None
    fix_links = bool(p.get("fix_links"))
    rule = p.get("link_scenes") if p.get("link_scenes") in scene_chain.LINK_SCENES else "auto"
    report: list[dict] = list(ctx.result.get("scenes") or [])
    done_ids = {e["scene_id"] for e in report if e.get("status") == "done"}

    def save(entry: dict) -> None:
        nonlocal report
        report = [e for e in report if e["scene_id"] != entry["scene_id"]] + [entry]
        ctx.save_result(scenes=report, updated_at=utcnow().isoformat() + "Z")
        emit(None, ctx.project_id, "episode.updated", {"episode_id": ctx.episode_id, "what": "scene_chain"})

    todo = [sid for sid in scene_ids if sid not in done_ids]
    for n, sid in enumerate(todo):
        r.guard()
        with SessionLocal() as db:
            project, episode, scene = db.get(Project, ctx.project_id), db.get(Episode, ctx.episode_id), db.get(Scene, sid)
            if scene is None:
                continue
            label = f"Scene {scene.order + 1}"
            r.step = label
            ctx.progress(n / max(len(todo), 1), f"{label}: continuity from the scenes before")
            user = _user(db, ctx)
            written = scene_chain.ensure_end_states(db, user, project, episode, scene.order)
            linked = scene_chain.link_to_previous_scene(db, scene, rule)
            shots = scene_chain.scene_shots(db, scene)
            make = [s.id for s in scene_chain.shots_to_make(db, shots, fix_links)]
            entry = {"scene_id": scene.id, "scene": scene.order + 1, "title": scene.title, "status": "running",
                     "end_states_written": written, "linked": linked, "shots": [s.code for s in shots]}
        save(entry)
        res = scene_chain.make_videos_in_order(SessionLocal, r.run, ctx.project_id, make, quality, label, fix_links)
        for w in res["warnings"]:
            r.problems.add(None, label, w, "Make the video it continues from, then remake this one")
        with SessionLocal() as db:
            project, episode, scene = db.get(Project, ctx.project_id), db.get(Episode, ctx.episode_id), db.get(Scene, sid)
            if not scene.end_state:  # the next scene starts from this one's end state
                from ..core import continuity
                continuity.end_state(db, _user(db, ctx), project, episode, scene)
            links = {s.code: scene_chain.link_status(db, s) for s in scene_chain.scene_shots(db, scene)}
            r.problems.extend(problems.qc_problems(db, scene_chain.scene_shots(db, scene)))
        entry.update(status="done", **res, links={k: v["status"] for k, v in links.items() if v})
        save(entry)
        if p.get("pause_after_each") and res["videos"] and n < len(todo) - 1:
            ctx.save_result(paused_after=entry["scene"])
            return {"scenes": report, "paused_after": entry["scene"]}
    ctx.save_result(paused_after=None)
    return {"scenes": report}
