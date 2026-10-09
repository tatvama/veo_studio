"""MCP tools, part 2: storyboard and shots, scene-by-scene video with continuity carried forward, voices, music,
export, and the job queue (status, proposals, approving spend)."""
from __future__ import annotations

import time
from typing import Annotated, Any

import anyio
from mcp.server.mcpserver import Context
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import BaseModel, Field

from .. import catalog
from ..core import jobs, scene_chain
from ..models import Job, Shot
from ..pipeline.prompting import compile_video_prompt
from ..pipeline.selection import current, is_real, takes
from . import media
from .common import (EDIT, PAID, READ, REPLACE, Confirm, DialogueLine, EpisodeNo, Lang, ProjectId, Quality, RunNow,
                     ShotCode, ShotCodes, character, director, location, names, scene_number, with_next)
from .context import call

# ── storyboard & shots ───────────────────────────────────────────────────────


def _shot_row(db, s: Shot, lang: str) -> dict[str, Any]:
    kf, vid = current(db, s.id, "keyframe"), current(db, s.id, "video")
    ls = scene_chain.link_status(db, s)
    return {"code": s.code, "scene": scene_number(db, s), "seconds": s.duration_s, "framing": s.framing, "camera": s.camera,
            "action": s.action, "characters": names(db, s.characters),
            "dialogue": [{"character": names(db, [l.get("character_id")])[0] if l.get("character_id") != "NARRATOR" else "NARRATOR",
                          "line": l.get("line", ""), "emotion": l.get("emotion", "")} for l in (s.dialogue or {}).get(lang) or []],
            "narration": (s.narration or {}).get(lang) or "", "outfits": {names(db, [k])[0]: v for k, v in (s.outfits or {}).items()},
            "continues_from": f"{ls['from']} ({ls['mode']}, {ls['status']})" if ls else None,
            "keyframe": bool(is_real(kf)), "video": bool(is_real(vid)),
            "stale": [t for t, x in (("keyframe", kf), ("video", vid)) if x is not None and x.stale],
            "status": s.status, "generating": s.generating}


def get_storyboard(project_id: ProjectId, episode: EpisodeNo = None,
                   scene: Annotated[int | None, Field(description="Only this scene (1-based). Empty = all scenes.")] = None,
                   images: Annotated[bool, Field(description="Include keyframe pictures")] = True,
                   max_images: Annotated[int, Field(description="At most this many pictures (each is ~50 KB)")] = 8,
                   language: Lang = "") -> list:
    """The storyboard: every shot in order with framing, camera, action, cast, dialogue, its link to the shot before,
    and whether it has a keyframe and a video, plus the keyframe pictures themselves."""
    with call("read") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        lang = language or p.primary_language
        q = c.db.query(Shot).filter(Shot.episode_id == ep.id, Shot.include.is_(True))
        if scene:
            q = q.filter(Shot.scene_id == c.scene(ep, scene).id)
        shots = q.order_by(Shot.order, Shot.id).all()
        rows = [_shot_row(c.db, s, lang) for s in shots]
        summary = {"episode": ep.number, "shots": len(rows), "seconds": sum(s.duration_s for s in shots),
                   "with_keyframe": sum(1 for r in rows if r["keyframe"]), "with_video": sum(1 for r in rows if r["video"]),
                   "storyboard": rows}
        out: list[Any] = [summary]
        if images:
            shown = 0
            for s in shots:
                if shown >= max(0, min(int(max_images), 24)):
                    break
                img = media.thumbnail(current(c.db, s.id, "keyframe"))
                if img is not None:
                    out += [f"{s.code} keyframe — {s.framing}: {s.action[:120]}", img]
                    shown += 1
        return out


def get_shot(project_id: ProjectId, shot_code: ShotCode, episode: EpisodeNo = None, language: Lang = "",
             image: bool = True) -> list:
    """One shot in full: details, the exact video prompt Tatvam will send, takes with QC results, its link to the
    shot before, a signed link to watch the current video (valid 6 hours) and the keyframe picture."""
    with call("read") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        s = c.shot(ep, shot_code)
        lang = language or p.primary_language
        row = _shot_row(c.db, s, lang)
        vid = current(c.db, s.id, "video")
        row.update(prompt=compile_video_prompt(c.db, s, p, lang), link=scene_chain.link_status(c.db, s),
                   video_link=media.signed_link(vid.path) if vid else None,
                   takes=[{"id": t.id, "kind": t.kind, "engine": (t.params or {}).get("engine_label") or t.model,
                           "selected": t.selected, "stale": t.stale, "qc": t.qc or None, "usd": t.cost_usd,
                           "at": t.created_at.isoformat() + "Z" if t.created_at else None}
                          for kind in ("keyframe", "video") for t in takes(c.db, s.id, kind)[:4]])
        out: list[Any] = [row]
        if image:
            img = media.thumbnail(current(c.db, s.id, "keyframe"))
            if img is not None:
                out.append(img)
        return out


def breakdown_shots(project_id: ProjectId, episode: EpisodeNo = None, confirm: Confirm = False) -> dict:
    """Turn the script into a shot list (following the scene cards' coverage plans). Shots inside a scene are linked
    so each starts where the one before ends. Replaces the current shot list."""
    with call("write") as c:
        p = c.project(project_id)
        out = director(c, p, c.episode(p, episode), "breakdown_shots", {}, confirm=confirm)
        if out.get("status") != "needs_confirmation":
            out["next"] = "get_storyboard to review; generate_keyframes for the pictures; generate_scenes for the videos."
        return out


class ShotChanges(BaseModel):
    framing: str | None = None
    camera: str | None = None
    action: str | None = None
    duration_s: int | None = Field(default=None, description="4, 6 or 8")
    characters: list[str] | None = Field(default=None, description="Cast names in the shot")
    outfits: dict[str, str] | None = Field(default=None, description="{character name: outfit} for this shot only")
    location: str | None = None
    dialogue: list[DialogueLine] | None = Field(default=None, description="All the lines of this shot, in `language`")
    narration: str | None = None
    language: str = Field(default="", description="Language of dialogue / narration; empty = main language")
    sfx: str | None = None
    music_cue: str | None = None
    quality_mode: str | None = Field(default=None, description="saver, balanced, hero, or empty for the project's")
    voice_mode: str | None = Field(default=None, description="auto, native, audio_first, audio_driven, voice_lock, narration, none")
    mode: str | None = Field(default=None, description="auto, keyframe_to_video, reference_to_video, text_to_video, interpolate")
    continues_from: str | None = Field(default=None, description="A shot code to continue from, 'previous' for the shot "
                                                                  "before, or '' to cut (no link)")
    continuity_mode: str | None = Field(default=None, description="last_frame (start from its last frame) or extend "
                                                                  "(this clip extends that one)")
    include: bool | None = Field(default=None, description="false drops the shot from the cut")
    notes: str | None = None


def update_shot(project_id: ProjectId, shot_code: ShotCode, changes: ShotChanges, episode: EpisodeNo = None) -> dict:
    """Edit a shot: framing, camera, action, length, cast, outfits, dialogue, link to the shot before, quality…
    Takes the change invalidates (keyframe, video, voice, lip-sync) are flagged stale; see impact_report."""
    from ..api.shots import ShotPatch, patch_shot

    with call("write") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        s = c.shot(ep, shot_code)
        d = changes.model_dump(exclude_unset=True)
        lang = d.pop("language", "") or p.primary_language
        patch: dict[str, Any] = {k: d[k] for k in ("framing", "camera", "action", "duration_s", "sfx", "music_cue",
                                                     "quality_mode", "voice_mode", "mode", "include", "notes", "continuity_mode") if k in d}
        if "characters" in d:
            patch["characters"] = [character(c.db, p, n).id for n in d["characters"] or []]
        if "outfits" in d:
            patch["outfits"] = {str(character(c.db, p, n).id): o for n, o in (d["outfits"] or {}).items()}
        if "location" in d:
            patch["location_id"] = location(c.db, p, d["location"]).id if d["location"] else None
        if "dialogue" in d:
            lines = []
            for l in d["dialogue"] or []:
                who = "NARRATOR" if l["character"].strip().upper() in ("NARRATOR", "VO") else character(c.db, p, l["character"]).id
                lines.append({"character_id": who, "line": l["line"], "emotion": l.get("emotion", "")})
            patch["dialogue"] = {**(s.dialogue or {}), lang: lines}
        if "narration" in d:
            patch["narration"] = {**(s.narration or {}), lang: d["narration"] or ""}
        if "continues_from" in d:
            src = (d["continues_from"] or "").strip()
            if src.lower() == "previous":
                patch.update(continuity_from_prev=True, continuity_from_shot_id=None)
            elif src:
                patch.update(continuity_from_shot_id=c.shot(ep, src).id, continuity_from_prev=False)
            else:
                patch.update(continuity_from_prev=False, continuity_from_shot_id=None)
        out = patch_shot(s.id, ShotPatch(**patch), c.user, c.db)
        c.db.refresh(s)
        return {**_shot_row(c.db, s, lang), "stale_takes": len(out.get("stale_takes") or [])}


def add_shot_after(project_id: ProjectId, shot_code: ShotCode,
                   action: Annotated[str, Field(description="What happens in the new shot")] = "",
                   mode: Annotated[str, Field(description="last_frame (starts from its last frame) or extend (continues the clip)")] = "last_frame",
                   episode: EpisodeNo = None) -> dict:
    """Add the shot right after another one: same cast, wardrobe, location and props, linked so it carries on from it."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "next_shot",
                        {"shot_code": shot_code, "action": action, "mode": mode, "generate": False})


def impact_report(project_id: ProjectId, episode: EpisodeNo = None) -> dict:
    """What is out of date after edits (keyframes, videos, voices, lip-syncs) and what redoing it costs."""
    with call("read") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "impact_report", {})


# ── generation (paid: proposals unless run_now) ──────────────────────────────

def _scene_codes(c, ep, scene: int | None, codes: list[str] | None) -> list[str] | None:
    if scene:
        return [s.code for s in scene_chain.scene_shots(c.db, c.scene(ep, scene))]
    return codes or None


def generate_keyframes(project_id: ProjectId, shot_codes: ShotCodes = None,
                       scene: Annotated[int | None, Field(description="All shots of this scene (1-based)")] = None,
                       episode: EpisodeNo = None, run_now: RunNow = False) -> dict:
    """Make the storyboard pictures (keyframes) for shots: cheap, and every video starts from its keyframe. With no
    shots or scene given, only shots without one."""
    with call("write") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        return director(c, p, ep, "generate_keyframes", {"shot_codes": _scene_codes(c, ep, scene, shot_codes)}, run_now=run_now)


def generate_scenes(project_id: ProjectId,
                    scenes: Annotated[list[int] | None, Field(description="Scene numbers to make, e.g. [1] or [2, 3]. "
                                                                          "Empty = every scene, in order.")] = None,
                    episode: EpisodeNo = None, quality: Quality = "",
                    link_scenes: Annotated[str, Field(description="auto: a scene that picks up straight from the one "
                                                                  "before (same place, same time, same people) starts from "
                                                                  "its last frame; always; never")] = "auto",
                    fix_links: Annotated[bool, Field(description="Also remake clips whose link is already broken "
                                                                 "(made before the clip they continue from)")] = False,
                    pause_after_each_scene: Annotated[bool, Field(description="Stop after each scene so the user can "
                                                                              "review it; run again to continue")] = False,
                    plan_only: Annotated[bool, Field(description="Only show what would be made and the cost")] = False,
                    run_now: RunNow = False) -> dict:
    """Make the videos scene by scene with continuity carried forward. For each scene in order: the end states of
    the scenes before it are written (outfits, props in hand, time of day, weather go into its prompts); its first
    shot is linked to the previous scene when it picks up straight from it; its shots are made in link order, so a
    shot that continues another starts from that clip's real last frame (or extends it); QC and retakes finish before
    the next scene; then its own end state is written for the scene after. Videos that already exist are kept."""
    with call("write") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        rows = c.scenes(ep)
        if not rows:
            raise ToolError("No scenes yet: write or import a script, then breakdown_shots.")
        picked = [c.scene(ep, n) for n in sorted(set(scenes))] if scenes else rows
        if link_scenes not in scene_chain.LINK_SCENES:
            raise ToolError("link_scenes must be auto, always or never")
        q = quality if quality in catalog.QUALITY_MODES else None
        plan = scene_chain.plan(c.db, p, ep, picked, q, fix_links, link_scenes)
        if plan_only or not plan["shots_to_make"]:
            return {**plan, "submitted": False,
                    "next": "Every shot in these scenes already has its video." if not plan["shots_to_make"] else
                            "Show the user this plan; call again without plan_only to propose it."}
        spec = jobs.spec("scene_chain", payload={"scene_ids": [s.id for s in picked], "quality": q, "fix_links": fix_links,
                                                 "link_scenes": link_scenes, "pause_after_each": pause_after_each_scene},
                         project_id=p.id, episode_id=ep.id, estimate=plan["total_usd"],
                         label=f"Scenes {', '.join(str(s.order + 1) for s in picked)} in order")
        if run_now:
            c.need("spend")
        ctx = c.agent(p, ep, run_now=run_now)
        res = ctx.submit([spec], "scenes in order")
        return {**plan, "submitted": True, **with_next(res)}


def generate_videos(project_id: ProjectId, shot_codes: ShotCodes = None, quality: Quality = "", episode: EpisodeNo = None,
                    run_now: RunNow = False) -> dict:
    """Make videos for individual shots, all at once. For whole scenes use generate_scenes instead: it keeps the
    links between shots (a linked shot made here before its source clip exists starts from the source's keyframe)."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "generate_videos", {"shot_codes": shot_codes, "quality": quality},
                        run_now=run_now)


def regenerate_stale(project_id: ProjectId, shot_codes: ShotCodes = None, episode: EpisodeNo = None,
                     run_now: RunNow = False) -> dict:
    """Redo every out-of-date take (see impact_report)."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "regenerate_stale", {"shot_codes": shot_codes}, run_now=run_now)


def edit_clip(project_id: ProjectId, shot_code: ShotCode,
              instruction: Annotated[str, Field(description="e.g. 'make the sky stormy', 'remove the car'")],
              episode: EpisodeNo = None, run_now: RunNow = False) -> dict:
    """Edit a shot's current clip with words (video-to-video)."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "edit_clip", {"shot_code": shot_code, "instruction": instruction},
                        run_now=run_now)


def voice_and_lipsync(project_id: ProjectId, language: Lang = "", shot_codes: ShotCodes = None, episode: EpisodeNo = None,
                      run_now: RunNow = False) -> dict:
    """Voice the dialogue and narration and lip-sync the clips (for shots whose video does not already speak)."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "voice_and_lipsync", {"language": language, "shot_codes": shot_codes},
                        run_now=run_now)


def generate_music(project_id: ProjectId, prompt: str = "", episode: EpisodeNo = None, run_now: RunNow = False) -> dict:
    """Compose background music for the episode."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "generate_music", {"prompt": prompt}, run_now=run_now)


def make_animatic(project_id: ProjectId, language: Lang = "", episode: EpisodeNo = None) -> dict:
    """Render a free preview cut from the keyframes, voices and music."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "make_animatic", {"language": language})


def export_video(project_id: ProjectId, language: Lang = "",
                 preset: Annotated[str, Field(description=f"One of {', '.join(catalog.EXPORT_PRESETS)}; empty = by aspect")] = "",
                 episode: EpisodeNo = None) -> dict:
    """Render the final video with captions. The finished file appears in Tatvam (Export)."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "export_video", {"language": language, "preset": preset})


def dub_episode(project_id: ProjectId, language: Annotated[str, Field(description="en, hi, kn, te or ta")],
                episode: EpisodeNo = None, run_now: RunNow = False) -> dict:
    """Dub the episode into another language (adapted script, voices, lip-sync or native speech)."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "dub_episode", {"language": language}, run_now=run_now)


def make_cutdowns(project_id: ProjectId, count: int = 3, seconds: int = 30, episode: EpisodeNo = None,
                  confirm: Confirm = False) -> dict:
    """Cut the episode into N standalone shorts (new cut-down episodes)."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "make_cutdowns", {"count": count, "seconds": seconds}, confirm=confirm)


def start_autopilot(project_id: ProjectId,
                    through: Annotated[str, Field(description="script, cast, storyboard or final")] = "storyboard",
                    episode: EpisodeNo = None, run_now: RunNow = False) -> dict:
    """Run the whole pipeline on its own up to a milestone (it skips what is already done)."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "start_autopilot", {"through": through}, run_now=run_now)


# ── jobs & money ─────────────────────────────────────────────────────────────

def _job(j: Job) -> dict[str, Any]:
    d = {"id": j.id, "type": j.type, "label": j.label, "status": j.status, "progress": round(j.progress or 0, 2),
         "message": j.message, "usd_estimate": round(j.cost_estimate or 0, 4), "usd_spent": round(j.cost_actual or 0, 4)}
    if j.error:
        d["error"] = j.error[:400]
    if j.type == "scene_chain" and j.result:
        d["scenes"] = (j.result or {}).get("scenes")
        d["paused_after_scene"] = (j.result or {}).get("paused_after")
    return d


def _status(project_id: int, batch_id: str | None) -> dict[str, Any]:
    with call("read") as c:
        p = c.project(project_id)
        q = c.db.query(Job).filter(Job.project_id == p.id)
        if batch_id:
            rows = q.filter(Job.batch_id == batch_id).order_by(Job.id).all()
            if not rows:
                raise ToolError(f"No jobs in batch {batch_id} for this project.")
        else:
            rows = q.filter(Job.status.in_(jobs.ACTIVE)).order_by(Job.id).limit(200).all()
        by: dict[str, int] = {}
        for j in rows:
            by[j.status] = by.get(j.status, 0) + 1
        active = sum(by.get(s, 0) for s in ("queued", "running"))
        top = [j for j in rows if not j.parent_job_id] or rows
        return {"batch_id": batch_id, "counts": by, "done": active == 0, "jobs": [_job(j) for j in top[:60]],
                "children": len(rows) - len(top), "usd_spent": round(sum(j.cost_actual or 0 for j in rows), 4)}


async def job_status(project_id: ProjectId,
                     batch_id: Annotated[str | None, Field(description="From a proposal or a started job. "
                                                                         "Empty = everything active in the project.")] = None,
                     wait_seconds: Annotated[int, Field(description="Wait up to this long (max 50) for the jobs to finish, "
                                                                    "reporting progress meanwhile")] = 0,
                     ctx: Context | None = None) -> dict:
    """Progress of generation jobs: status, progress, messages, money spent, errors; for a scene run, how far each
    scene got. Videos take minutes: call again with wait_seconds to follow along."""
    deadline = time.monotonic() + max(0, min(int(wait_seconds or 0), 50))
    while True:
        st = await anyio.to_thread.run_sync(_status, project_id, batch_id)
        if st["done"] or time.monotonic() >= deadline:
            if not st["done"]:
                st["next"] = "Still working. Call job_status again (wait_seconds=50) to keep following."
            return st
        if ctx is not None:
            n = sum(st["counts"].values()) or 1
            finished = sum(st["counts"].get(s, 0) for s in ("succeeded", "failed", "cancelled"))
            try:
                await ctx.report_progress(finished, n, f"{finished}/{n} jobs done")
            except Exception:
                pass
        await anyio.sleep(3)


def list_pending(project_id: ProjectId) -> dict:
    """Paid work waiting for a decision: proposals (waiting for approve_spend or approval in Tatvam) and batches over a
    budget limit (waiting for a producer)."""
    from ..models import Approval

    with call("read") as c:
        p = c.project(project_id)
        rows = c.db.query(Job).filter(Job.project_id == p.id, Job.status == "proposed").order_by(Job.id).all()
        batches: dict[str, dict] = {}
        for j in rows:
            b = batches.setdefault(j.batch_id, {"batch_id": j.batch_id, "jobs": 0, "usd": 0.0, "what": []})
            b["jobs"] += 1
            b["usd"] = round(b["usd"] + (j.cost_estimate or 0), 4)
            if len(b["what"]) < 6:
                b["what"].append(j.label)
        appr = c.db.query(Approval).filter(Approval.project_id == p.id, Approval.status == "pending").all()
        return {"proposals": list(batches.values()),
                "over_budget": [{"batch_id": a.batch_id, "usd": a.amount_usd, "reason": a.reason, "needs": a.needs_role,
                                 "what": a.summary} for a in appr]}


def approve_spend(project_id: ProjectId, batch_id: Annotated[str, Field(description="The proposal's batch_id")]) -> dict:
    """Start a proposed batch of paid work (needs the 'spend' scope). Only do this after the user has seen the estimate
    and agreed. Budget limits still apply: over a limit it waits for a producer instead."""
    with call("spend") as c:
        p = c.project(project_id)
        first = c.db.query(Job).filter(Job.batch_id == batch_id).first()
        if first is None or first.project_id != p.id:
            raise ToolError(f"No batch {batch_id} in this project.")
        return with_next(jobs.confirm_batch(c.db, c.user, batch_id))


def cancel_jobs(project_id: ProjectId, batch_id: Annotated[str, Field(description="Batch to stop (proposed or running)")]) -> dict:
    """Stop a batch: waiting jobs are cancelled, running ones are asked to stop (with everything they started)."""
    with call("write") as c:
        p = c.project(project_id)
        first = c.db.query(Job).filter(Job.batch_id == batch_id).first()
        if first is None or first.project_id != p.id:
            raise ToolError(f"No batch {batch_id} in this project.")
        return {"batch_id": batch_id, "stopped": jobs.cancel_batch(c.db, batch_id)}


TOOLS = [
    (get_storyboard, "Storyboard", READ), (get_shot, "Shot details", READ),
    (breakdown_shots, "Plan the shot list", REPLACE), (update_shot, "Edit a shot", EDIT),
    (add_shot_after, "Add a linked shot", EDIT), (impact_report, "What is out of date", READ),
    (generate_keyframes, "Make keyframes", PAID), (generate_scenes, "Make scenes in order", PAID),
    (generate_videos, "Make shot videos", PAID), (regenerate_stale, "Redo stale takes", PAID),
    (edit_clip, "Edit a clip", PAID), (voice_and_lipsync, "Voices & lip-sync", PAID),
    (generate_music, "Make music", PAID), (make_animatic, "Render a preview", EDIT), (export_video, "Render the final video", EDIT),
    (dub_episode, "Dub the episode", PAID), (make_cutdowns, "Cut into shorts", EDIT), (start_autopilot, "Start Autopilot", PAID),
    (job_status, "Job progress", READ), (list_pending, "Waiting for approval", READ),
    (approve_spend, "Approve spending", PAID), (cancel_jobs, "Stop jobs", EDIT),
]
