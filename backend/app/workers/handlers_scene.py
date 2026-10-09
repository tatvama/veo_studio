"""The scene chain: make an episode's videos scene by scene, carrying continuity forward (core/scene_chain.py)."""
from __future__ import annotations

from ..core import scene_chain
from ..db import SessionLocal, utcnow
from ..events import emit
from ..models import Episode, Project, Scene
from ..providers.base import ProviderError
from .handlers import _user
from .handlers_room import _run_spend, _wait_batch_idle
from .worker import JobContext, handler


@handler("scene_chain")
def scene_chain_run(ctx: JobContext) -> dict:
    """payload: scene_ids (in order), quality, fix_links, link_scenes (auto|always|never), pause_after_each.
    For each scene: write the end states of the scenes before it, link its first shot to the previous scene when it
    picks up straight from it, make its videos in link order (waiting for QC and retakes), write its own end state.
    With pause_after_each the run stops after a scene that made something; running it again carries on."""
    p = ctx.payload
    scene_ids = [int(i) for i in p.get("scene_ids") or []]
    quality = p.get("quality") or None
    fix_links = bool(p.get("fix_links"))
    rule = p.get("link_scenes") if p.get("link_scenes") in scene_chain.LINK_SCENES else "auto"
    report: list[dict] = list(ctx.result.get("scenes") or [])
    done_ids = {r["scene_id"] for r in report if r.get("status") == "done"}

    def guard() -> None:
        ctx.check_cancel()
        spent, cap = _run_spend(ctx)
        if spent > cap and spent > 0:
            raise ProviderError(f"Scene run stopped: spent ${spent:.2f}, above the approved ${cap:.2f} guard")

    def run(specs: list[dict], label: str) -> None:
        ids = [ctx.enqueue_child(s["type"], s["payload"], shot_id=s.get("shot_id"), episode_id=s.get("episode_id"),
                                 estimate=s["estimate"], label=s["label"]) for s in specs]
        if ids:
            ctx.wait_children(ids, label, guard=guard)
            _wait_batch_idle(ctx, guard)

    def save(entry: dict) -> None:
        nonlocal report
        report = [r for r in report if r["scene_id"] != entry["scene_id"]] + [entry]
        ctx.save_result(scenes=report, updated_at=utcnow().isoformat() + "Z")
        emit(None, ctx.project_id, "episode.updated", {"episode_id": ctx.episode_id, "what": "scene_chain"})

    todo = [sid for sid in scene_ids if sid not in done_ids]
    for n, sid in enumerate(todo):
        guard()
        with SessionLocal() as db:
            project, episode, scene = db.get(Project, ctx.project_id), db.get(Episode, ctx.episode_id), db.get(Scene, sid)
            if scene is None:
                continue
            label = f"Scene {scene.order + 1}"
            ctx.progress(n / max(len(todo), 1), f"{label}: continuity from the scenes before")
            user = _user(db, ctx)
            written = scene_chain.ensure_end_states(db, user, project, episode, scene.order)
            linked = scene_chain.link_to_previous_scene(db, scene, rule)
            shots = scene_chain.scene_shots(db, scene)
            make = [s.id for s in scene_chain.shots_to_make(db, shots, fix_links)]
            entry = {"scene_id": scene.id, "scene": scene.order + 1, "title": scene.title, "status": "running",
                     "end_states_written": written, "linked": linked, "shots": [s.code for s in shots]}
        save(entry)
        res = scene_chain.make_videos_in_order(SessionLocal, run, ctx.project_id, make, quality, label, fix_links)
        with SessionLocal() as db:
            project, episode, scene = db.get(Project, ctx.project_id), db.get(Episode, ctx.episode_id), db.get(Scene, sid)
            if not scene.end_state:  # the next scene starts from this one's end state
                from ..core import continuity
                continuity.end_state(db, _user(db, ctx), project, episode, scene)
            links = {s.code: scene_chain.link_status(db, s) for s in scene_chain.scene_shots(db, scene)}
        entry.update(status="done", **res, links={k: v["status"] for k, v in links.items() if v})
        save(entry)
        if p.get("pause_after_each") and res["videos"] and n < len(todo) - 1:
            ctx.save_result(paused_after=entry["scene"])
            return {"scenes": report, "paused_after": entry["scene"]}
    ctx.save_result(paused_after=None)
    return {"scenes": report}
