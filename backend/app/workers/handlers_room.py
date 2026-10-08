"""Writers' room jobs: critic loop, table read, and the Autopilot (Showrunner) orchestrator."""
from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Any

from .. import settings_store
from ..core import autopilot as autopilot_def
from ..core import budget, generation, studio
from ..db import SessionLocal, utcnow
from ..events import emit
from ..models import AudioAsset, CharacterAsset, Episode, Job, LocationAsset, Project, VoiceProfile
from ..pipeline import ffmpeg as ff
from ..pipeline.voice import voice_for
from ..providers.base import ProviderError, RetryableProviderError
from ..storage import get_storage
from .handlers import _user
from .worker import Cancelled, JobContext, handler


@handler("critic_loop")
def critic_loop(ctx: JobContext) -> dict:
    """Critic scores the draft; if below the bar, the writer rewrites with the notes. Repeats up to N rounds."""
    with SessionLocal() as db:
        rounds = int(ctx.payload.get("rounds") or settings_store.get_setting(db, "critic_rounds") or 1)
        bar = float(settings_store.get_setting(db, "critic_min_score") or 7.5)
    history: list[dict] = []
    for r in range(rounds + 1):
        ctx.check_cancel()
        ctx.progress(r / (rounds + 1), f"Critic round {r + 1}")
        with SessionLocal() as db:
            ep = db.get(Episode, ctx.episode_id)
            user = _user(db, ctx)
            report = studio.critique(db, user, ep, r)
            history.append({"round": r, "overall": report["overall"]})
            if report["overall"] >= bar or r == rounds:
                studio.save_script_version(db, ep, "critic", user, note=f"Critic score {report['overall']}", critic=report)
                db.commit()
                break
            ctx.progress((r + 0.5) / (rounds + 1), f"Writer revising (score {report['overall']})")
            notes = (f"Script editor notes — fix ALL of these:\n{report['rewrite_instructions']}\n"
                     f"Problems: {'; '.join(report['problems'])}\nKeep what works: {'; '.join(report['strengths'])}")
            studio.generate_script(db, user, ep, instructions=notes)
    with SessionLocal() as db:
        ep = db.get(Episode, ctx.episode_id)
        ep.critic = {**(ep.critic or {}), "history": history}
        db.commit()
        emit(db, ctx.project_id, "episode.updated", {"episode_id": ctx.episode_id, "what": "critic"})
    return {"history": history}


@handler("table_read")
def table_read(ctx: JobContext) -> dict:
    """The whole episode as an audio drama in the character voices — catch pacing/dialogue problems for cents."""
    st = get_storage()
    tmp = st.tmp_dir()
    lang = ctx.payload.get("language")
    with SessionLocal() as db:
        ep = db.get(Episode, ctx.episode_id)
        project = db.get(Project, ep.project_id)
        lang = lang or project.primary_language
        cast = {c.name.lower(): c.id for c in studio.cast(db, project)}
        items: list[dict[str, Any]] = []
        if lang == project.primary_language:
            for si, sc in enumerate((ep.script or {}).get("scenes", [])):
                for l in sc.get("lines", []):
                    items.append({"scene": si, "scene_title": sc.get("title", ""), "character": l.get("character", ""),
                                  "text": l.get("line", ""), "emotion": l.get("emotion", "")})
        else:
            from ..models import Shot
            for s in db.query(Shot).filter(Shot.episode_id == ep.id, Shot.include.is_(True)).order_by(Shot.order):
                for l in (s.dialogue or {}).get(lang) or []:
                    items.append({"scene": s.scene_id or 0, "scene_title": s.code, "character_id": l.get("character_id"),
                                  "text": l.get("line", ""), "emotion": l.get("emotion", "")})
                if (s.narration or {}).get(lang):
                    items.append({"scene": s.scene_id or 0, "scene_title": s.code, "character": "NARRATOR",
                                  "text": s.narration[lang], "emotion": ""})
        voices = []
        for it in items:
            cid = it.get("character_id")
            if cid is None:
                name = (it.get("character") or "").strip().lower()
                cid = "NARRATOR" if name in ("narrator", "") else next((v for k, v in cast.items() if k.split()[0] == name.split()[0]), None)
            voices.append(voice_for(db, cid if cid is not None else "NARRATOR", lang, project))
            it["character_id"] = cid
        db.commit()
    if not items:
        raise ProviderError("Nothing to read — write the script (or dub this language) first")
    parts: list[Path] = []
    for i, (it, v) in enumerate(zip(items, voices)):
        ctx.check_cancel()
        ctx.progress(i / len(items), f"Reading line {i + 1}/{len(items)}")
        res = ctx.services.tts(v["provider"], it["text"], v["voice_id"], lang, style=it.get("emotion") or v["style"])
        ctx.cost(res.usage)
        p = tmp / f"l{i:03}.{res.ext}"
        p.write_bytes(res.data)
        parts.append(p)
    out = tmp / f"table_read_{lang}.wav"
    spans = ff.concat_audio_with_gaps(parts, out, gap=0.35, lead_in=0.4)
    rel = st.save_file(st.new_path(f"projects/{ctx.project_id}/table_reads", "wav"), out)
    lines = [{**{k: it[k] for k in ("scene", "scene_title", "text")}, "character": it.get("character") or "",
              "character_id": it.get("character_id"), "start": s, "end": e} for it, (s, e) in zip(items, spans)]
    with SessionLocal() as db:
        ep = db.get(Episode, ctx.episode_id)
        ep.table_read = {**(ep.table_read or {}), lang: {"path": rel, "duration": ff.duration(st.abs(rel)), "lines": lines,
                                                          "at": utcnow().isoformat() + "Z"}}
        db.commit()
        emit(db, ctx.project_id, "episode.updated", {"episode_id": ctx.episode_id, "what": "table_read"})
    shutil.rmtree(tmp, ignore_errors=True)
    return {"lines": len(lines), "path": rel}


AUTOPILOT_STAGES = autopilot_def.STAGES


def _run_spend(ctx: JobContext) -> tuple[float, float]:
    """(spent so far by this run — itself and every job it started, incl. QC and retakes — , the 1.5× guard)."""
    from sqlalchemy import func
    with SessionLocal() as db:
        j = db.get(Job, ctx.job_id)
        spent = float(db.query(func.coalesce(func.sum(Job.cost_actual), 0.0)).filter(Job.batch_id == j.batch_id).scalar() or 0)
        return spent, max(j.cost_estimate * 1.5, 1.0)


def _wait_batch_idle(ctx: JobContext, guard=None, timeout_s: float = 26 * 3600) -> None:
    """Wait for follow-up work of this run (QC, retakes) before the next step; it may wait on a provider quota."""
    start, last_guard = time.time(), 0.0
    while True:
        with SessionLocal() as db:
            me = db.get(Job, ctx.job_id)
            busy = db.query(Job).filter(Job.batch_id == me.batch_id, Job.id != ctx.job_id,
                                        Job.status.in_(("queued", "running"))).count()
        if not busy:
            return
        try:
            if ctx.cancelled():
                raise Cancelled()
            if guard and time.time() - last_guard > 10:
                last_guard = time.time()
                guard()
            if time.time() - start > timeout_s:
                raise ProviderError("timed out waiting for this run's follow-up jobs")
        except Exception:
            from ..core.jobs import cancel_tree
            with SessionLocal() as db:
                cancel_tree(db, [ctx.job_id])
                db.commit()
            raise
        time.sleep(2)


@handler("autopilot")
def autopilot(ctx: JobContext) -> dict:
    """Run the pipeline up to a milestone. Optional approval stops: after each milestone listed in pause_after the run
    ends as "paused"; running it again continues (every stage skips work that is already done)."""
    p = ctx.payload
    through = autopilot_def.resolve_through(p.get("through"))
    stop_at = AUTOPILOT_STAGES.index(through)
    pause_after = [m for m in (p.get("pause_after") or []) if m in autopilot_def.MILESTONE_BY_ID]
    target = autopilot_def.milestone_containing(through)
    log: list[str] = list(p.get("log") or [])

    def mark(stage: str, status: str, note: str = "", **extra) -> None:
        if note:
            log.append(f"{autopilot_def.STAGE_LABELS.get(stage, stage)}: {note}")
        with SessionLocal() as db:
            pr = db.get(Project, ctx.project_id)
            pr.autopilot = {"job_id": ctx.job_id, "episode_id": ctx.episode_id, "stage": stage, "status": status,
                            "milestone": autopilot_def.milestone_containing(stage)["id"], "through": target["id"],
                            "pause_after": pause_after, "log": log[-40:], "stages": AUTOPILOT_STAGES[: stop_at + 1],
                            "updated_at": utcnow().isoformat() + "Z", **extra}
            db.commit()
            emit(db, ctx.project_id, "autopilot.updated", pr.autopilot)

    try:
        return _autopilot_run(ctx, stop_at, pause_after, mark)
    except Cancelled:
        mark(_last_stage(ctx), "cancelled", "Stopped by you")
        raise
    except RetryableProviderError as e:  # the worker puts the run back in the queue: it is waiting, not failed
        mark(_last_stage(ctx), "running", f"waiting to retry: {str(e)[:200]}")
        raise
    except Exception as e:
        mark(_last_stage(ctx), "failed", str(e)[:300], error=str(e)[:500])
        raise


def _last_stage(ctx: JobContext) -> str:
    with SessionLocal() as db:
        return (db.get(Project, ctx.project_id).autopilot or {}).get("stage") or "brief"


def _autopilot_run(ctx: JobContext, stop_at: int, pause_after: list[str], mark) -> dict:
    def guard() -> None:
        ctx.check_cancel()
        spent, cap = _run_spend(ctx)
        if spent > cap and spent > 0:
            raise ProviderError(f"Autopilot stopped: spent ${spent:.2f}, above the approved ${cap:.2f} guard")

    def run_children(specs: list[dict], label: str) -> dict[int, str]:
        ids = [ctx.enqueue_child(s["type"], s["payload"], shot_id=s.get("shot_id"), episode_id=s.get("episode_id"),
                                 estimate=s["estimate"], label=s["label"]) for s in specs]
        res = ctx.wait_children(ids, label, guard=guard) if ids else {}
        _wait_batch_idle(ctx, guard)
        return res

    for stage in AUTOPILOT_STAGES[: stop_at + 1]:
        guard()
        mark(stage, "running")
        with SessionLocal() as db:
            project = db.get(Project, ctx.project_id)
            episode = db.get(Episode, ctx.episode_id)
            user = _user(db, ctx)
            if stage == "brief" and not (project.brief or {}).get("key_message"):
                studio.generate_brief(db, user, project)
            elif stage == "hooks" and episode.selected_hook is None:
                if not episode.hooks:
                    studio.generate_hooks(db, user, episode, 6)
                hooks = episode.hooks or []
                best = max(range(len(hooks)), key=lambda i: float(hooks[i].get("total") or 0)) if hooks else 0
                studio.select_hook(db, episode, best)
                if hooks:
                    mark(stage, "running", f"picked the highest-scoring hook ({hooks[best].get('total', '?')}/10)")
            elif stage == "script" and not (episode.script or {}).get("scenes"):
                studio.generate_script(db, user, episode)
            elif stage == "critic" and not (episode.critic or {}).get("overall"):
                db.commit()
                run_children([{"type": "critic_loop", "payload": {}, "episode_id": episode.id, "estimate": 0.0,
                               "label": "Critic loop"}], "Script editor")
            elif stage == "scenes":
                from ..models import Scene
                if not db.query(Scene).filter(Scene.episode_id == episode.id, Scene.goal != "").count():
                    studio.plan_scene_cards(db, user, episode)
            elif stage == "bible":
                # continuing after an approval stop keeps the cast the user just reviewed (no re-adding removed characters)
                if not (ctx.payload.get("resume") and studio.cast(db, project)):
                    studio.propose_bible(db, user, project, episode)
            elif stage == "sheets":
                specs = []
                for ch in studio.cast(db, project):
                    if not db.query(CharacterAsset).filter(CharacterAsset.character_id == ch.id, CharacterAsset.archived.is_(False)).count():
                        specs.append(generation.character_sheet_spec(db, project.id, ch, ["front", "three_quarter"]))
                for loc in studio.locations(db, project):
                    if not db.query(LocationAsset).filter(LocationAsset.location_id == loc.id).count():
                        specs.append(generation.location_images_spec(db, project.id, loc, ["wide"]))
                db.commit()
                run_children(specs, "Character sheets & locations")
            elif stage == "voices":
                specs = []
                for ch in studio.cast(db, project):
                    for lang in (project.languages or [project.primary_language]):
                        if not db.query(VoiceProfile).filter(VoiceProfile.character_id == ch.id, VoiceProfile.language == lang).count():
                            prov = (settings_store.get_setting(db, "tts_provider_by_language") or {}).get(lang, "gemini")
                            specs.append(generation.voice_design_spec(db, project.id, ch, lang, prov))
                db.commit()
                run_children(specs, "Designing voices")
            elif stage == "shots" and not generation.episode_shots(db, episode):
                studio.breakdown(db, user, episode)
            elif stage == "continuity":
                rep = studio.continuity_check(db, user, episode)
                mark(stage, "running", f"{len(rep.get('issues', []))} continuity notes")
            elif stage == "keyframes":
                specs = generation.keyframe_specs(db, project, generation.episode_shots(db, episode), only_missing=True)
                db.commit()
                run_children(specs, "Keyframes")
            elif stage == "videos":
                specs = generation.video_specs(db, project, generation.episode_shots(db, episode), only_missing=True)
                db.commit()
                run_children(specs, "Videos")
            elif stage == "dialogue":
                lang = project.primary_language
                shots = generation.episode_shots(db, episode)
                from ..pipeline.selection import current, has_fresh
                need = [s for s in shots if budget.Estimator.needs_lipsync(s, project, lang) and not has_fresh(db, s.id, "lipsync", lang)]
                narr = [s for s in shots if (s.narration or {}).get(lang) and s not in need]
                specs = generation.lipsync_specs(db, project, need, lang) + generation.voice_specs(db, project, narr, lang)
                db.commit()
                run_children(specs, "Voices & lip-sync")
            elif stage == "music" and not db.query(AudioAsset).filter(AudioAsset.episode_id == episode.id,
                                                                      AudioAsset.kind == "music").count():
                spec = generation.music_spec(db, project, episode)
                db.commit()
                run_children([spec], "Music")
            elif stage == "sfx" and settings_store.get_setting(db, "sfx_auto"):
                db.commit()
                run_children([generation.sfx_spec(db, project, episode)], "Sound design")
            elif stage == "dubs":
                others = [l for l in (project.languages or []) if l != project.primary_language]
                specs = [generation.dub_spec(db, project, episode, l) for l in others]
                db.commit()
                run_children(specs, "Dubbing")
            elif stage == "export":
                preset = "youtube" if project.aspect == "16:9" else ("square" if project.aspect == "1:1" else "shorts")
                specs = [generation.render_spec(project, episode, l, "final", preset, {"captions": True})
                         for l in (project.languages or [project.primary_language])]
                db.commit()
                run_children(specs, "Exports")
            elif stage == "marketing":
                db.commit()
                run_children([generation.marketing_spec(db, project, episode)], "Marketing pack")
        mark(stage, "done")
        ms = autopilot_def.milestone_of(stage)
        if ms and ms["id"] in pause_after and AUTOPILOT_STAGES.index(stage) < stop_at:
            # an approval stop: hand back to the user; Continue runs again and skips what is done
            mark(stage, "paused", f"{ms['label']} is ready — review it, then Continue", paused_after=ms["id"])
            return {"paused_after": ms["id"], "stages": AUTOPILOT_STAGES[: stop_at + 1]}
    mark(AUTOPILOT_STAGES[stop_at], "finished", "Autopilot finished")
    return {"stages": AUTOPILOT_STAGES[: stop_at + 1]}


@handler("produce")
def produce(ctx: JobContext) -> dict:
    """Produce all: the shot list as written, step by step (keyframes → videos → extensions → voices & lip-sync →
    music → export). No writing or re-planning: only what is missing is made. One budget approval covers the run."""
    from ..pipeline.selection import current, has_fresh

    p = ctx.payload
    steps = [s for s in generation.PRODUCE_STEPS if s in (p.get("steps") or generation.PRODUCE_STEPS)]
    shot_ids = p.get("shot_ids") or None
    quality = p.get("quality")
    done: dict[str, int] = {}

    def guard() -> None:
        ctx.check_cancel()
        spent, cap = _run_spend(ctx)
        if spent > cap and spent > 0:
            raise ProviderError(f"Produce stopped: spent ${spent:.2f}, above the approved ${cap:.2f} guard")

    def run_children(specs: list[dict], label: str) -> int:
        ids = [ctx.enqueue_child(s["type"], s["payload"], shot_id=s.get("shot_id"), episode_id=s.get("episode_id"),
                                 estimate=s["estimate"], label=s["label"]) for s in specs]
        if ids:
            ctx.wait_children(ids, label, guard=guard)
            _wait_batch_idle(ctx, guard)
        return len(ids)

    for i, step in enumerate(steps):
        guard()
        label = generation.PRODUCE_LABELS[step]
        ctx.progress(i / len(steps), label)
        if step == "extend":  # rounds: each extension adds ~7 s; stop a shot if its clip didn't grow
            last_len: dict[int, float] = {}
            for rnd in range(4):
                guard()
                with SessionLocal() as db:
                    project = db.get(Project, ctx.project_id)
                    episode = db.get(Episode, ctx.episode_id)
                    specs = []
                    for s in generation.episode_shots(db, episode, shot_ids):
                        if not generation.extensions_needed(db, s):
                            continue
                        vid = current(db, s.id, "video")
                        if not vid or last_len.get(s.id) == vid.duration_s:
                            continue
                        last_len[s.id] = vid.duration_s
                        specs.append(generation.extend_spec(db, project, s, s.extend_prompt or f"The action continues naturally. {s.action}"))
                    db.commit()
                if not specs:
                    break
                done[step] = done.get(step, 0) + run_children(specs, f"{label} (round {rnd + 1})")
            continue
        with SessionLocal() as db:
            project = db.get(Project, ctx.project_id)
            episode = db.get(Episode, ctx.episode_id)
            shots = generation.episode_shots(db, episode, shot_ids)
            lang = p.get("language") or project.primary_language
            specs: list[dict] = []
            if step == "keyframes":
                specs = generation.keyframe_specs(db, project, shots, only_missing=True)
            elif step == "videos":
                specs = generation.video_specs(db, project, shots, quality, only_missing=True)
            elif step == "voices":
                need = [s for s in shots if budget.Estimator.needs_lipsync(s, project, lang) and not has_fresh(db, s.id, "lipsync", lang)]
                narr = [s for s in shots if (s.narration or {}).get(lang) and s not in need and not current(db, s.id, "narration", lang)]
                specs = generation.lipsync_specs(db, project, need, lang) + generation.voice_specs(db, project, narr, lang)
            elif step == "music" and not db.query(AudioAsset).filter(AudioAsset.episode_id == episode.id, AudioAsset.kind == "music").count():
                specs = [generation.music_spec(db, project, episode)]
            elif step == "export":
                preset = "youtube" if project.aspect == "16:9" else ("square" if project.aspect == "1:1" else "shorts")
                specs = [generation.render_spec(project, episode, lang, "final", preset, {"captions": True})]
            db.commit()
        done[step] = run_children(specs, label)
    return {"steps": steps, "jobs": done}
