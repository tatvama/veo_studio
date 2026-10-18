"""Writers' room jobs: critic loop, table read, and the Autopilot (Showrunner) orchestrator."""
from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Any

from .. import settings_store
from ..core import autopilot as autopilot_def
from ..core import budget, generation, links, problems, scene_chain, studio
from ..db import SessionLocal, utcnow
from ..events import emit
from ..models import AudioAsset, CharacterAsset, Episode, Job, LocationAsset, Project, VoiceProfile
from ..pipeline import ffmpeg as ff
from ..pipeline.voice import voice_for
from ..providers.base import ProviderError, RetryableProviderError
from ..storage import get_storage
from .handlers import _user
from .runlog import BudgetStop, RunLog
from .worker import Cancelled, JobContext, handler


@handler("critic_loop")
def critic_loop(ctx: JobContext) -> dict:
    """Critic scores the draft; if below the bar, the writer rewrites with the notes. Repeats up to N rounds.
    keep_script: score only (one round, no rewrite), for a script that is the user's own words."""
    with SessionLocal() as db:
        rounds = int(ctx.payload.get("rounds") or settings_store.get_setting(db, "critic_rounds") or 1)
        bar = float(settings_store.get_setting(db, "critic_min_score") or 7.5)
    if ctx.payload.get("keep_script"):
        rounds = 0
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


@handler("autopilot")
def autopilot(ctx: JobContext) -> dict:
    """Run the pipeline up to a milestone. Optional approval stops: after each milestone listed in pause_after the run
    ends as "paused"; running it again continues (every stage skips work that is already done). What fails on the
    way is listed as the run's problems; spending past the guard stops it ("stopped") with work in flight finished."""
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

    r = RunLog(ctx, "Autopilot")
    problems.start(ctx.episode_id)
    try:
        try:
            out = _autopilot_run(ctx, stop_at, pause_after, mark, r)
        except BudgetStop:
            r.stopped_at_budget("Autopilot")
            mark(_last_stage(ctx), "stopped", "stopped at your budget", error="Stopped at your budget: press Autopilot "
                 "to continue (what is made is kept)", problems=len(r.problems.items))
            out = {"stopped": "budget", "stages": AUTOPILOT_STAGES[: stop_at + 1]}
    except Cancelled:
        mark(_last_stage(ctx), "cancelled", "Stopped by you")
        r.save(announce=False)
        raise
    except RetryableProviderError as e:  # the worker puts the run back in the queue: it is waiting, not failed
        mark(_last_stage(ctx), "running", f"waiting to retry: {str(e)[:200]}")
        r.save(announce=False)
        raise
    except Exception as e:
        mark(_last_stage(ctx), "failed", str(e)[:300], error=str(e)[:500])
        r.save(announce=False)
        raise
    out["problems"] = r.save(announce=True)
    return out


def _last_stage(ctx: JobContext) -> str:
    with SessionLocal() as db:
        return (db.get(Project, ctx.project_id).autopilot or {}).get("stage") or "brief"


def _autopilot_run(ctx: JobContext, stop_at: int, pause_after: list[str], mark, r: RunLog) -> dict:
    from ..pipeline.selection import current, has_fresh, is_real
    stages = AUTOPILOT_STAGES[: stop_at + 1]
    for stage in stages:
        r.guard()
        r.step = autopilot_def.STAGE_LABELS.get(stage, stage)
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
                keep = studio.users_script_reason(db, project, episode)
                if keep:  # the user's words: the editor scores them, the writer leaves them alone
                    mark(stage, "running", f"kept your script ({keep}); scoring only")
                db.commit()
                r.run([{"type": "critic_loop", "payload": {"keep_script": bool(keep)}, "episode_id": episode.id,
                        "estimate": 0.0, "label": "Critic review" if keep else "Critic loop"}], "Script editor")
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
                r.run(specs, "Character sheets & locations")
            elif stage == "voices":
                specs = []
                for ch in studio.cast(db, project):
                    for lang in (project.languages or [project.primary_language]):
                        if not db.query(VoiceProfile).filter(VoiceProfile.character_id == ch.id, VoiceProfile.language == lang).count():
                            prov = (settings_store.get_setting(db, "tts_provider_by_language") or {}).get(lang, "gemini")
                            specs.append(generation.voice_design_spec(db, project.id, ch, lang, prov))
                db.commit()
                r.run(specs, "Designing voices")
            elif stage == "shots" and not generation.episode_shots(db, episode):
                studio.breakdown(db, user, episode)
            elif stage == "continuity":
                rep = studio.continuity_check(db, user, episode)
                # every scene's end state before any picture is made, so each scene's prompts carry the one before
                written = scene_chain.ensure_end_states(db, user, project, episode, 1_000_000)
                mark(stage, "running", f"{len(rep.get('issues', []))} continuity notes"
                     + (f"; end states written for scenes {written}" if written else ""))
            elif stage == "keyframes":
                specs = generation.keyframe_specs(db, project, generation.episode_shots(db, episode), only_missing=True)
                db.commit()
                r.run(specs, "Keyframes")
            elif stage == "videos":  # in link order: a shot that continues another starts from its finished clip
                db.commit()
                if "dialogue" in stages:  # voices before pictures: each new clip is as long as its real voice
                    _voices_first(ctx, r, None, None)
                    r.step = autopilot_def.STAGE_LABELS["videos"]
                with SessionLocal() as db2:
                    need = [s.id for s in generation.episode_shots(db2, db2.get(Episode, ctx.episode_id))
                            if not is_real(current(db2, s.id, "video"))]
                # each wave is brought up to its extend_to length before the next wave starts from its last frame
                res = scene_chain.make_videos_in_order(SessionLocal, r.run, project.id, need, None, "Videos", extend=True)
                for w in res["warnings"]:
                    r.problems.add(None, r.step, w, "Make the video it continues from, then remake this one")
            elif stage == "dialogue":
                lang = project.primary_language
                shots = generation.episode_shots(db, episode)
                need = [s for s in shots if budget.Estimator.needs_lipsync(s, project, lang) and not has_fresh(db, s.id, "lipsync", lang)]
                narr = [s for s in shots if budget.Estimator.voice_only(s, project, lang) and s not in need
                        and not current(db, s.id, "narration" if (s.narration or {}).get(lang) else "voice", lang)]
                specs = generation.lipsync_specs(db, project, need, lang) + generation.voice_specs(db, project, narr, lang)
                db.commit()
                r.run(specs, "Voices & lip-sync")
            elif stage == "music" and (mus := generation.music_step(db, project, episode)):
                db.commit()  # a piece per scene with two or more scenes (or the one score), only what is missing
                r.run([mus[0]], "Music")
            elif stage == "sfx" and settings_store.get_setting(db, "sfx_auto") \
                    and (snd := generation.sound_step(db, project, episode, generation.episode_shots(db, episode))):
                db.commit()
                r.run([snd[0]], "Sound design")  # ElevenLabs, or the free library without its key
            elif stage == "dubs":
                others = [l for l in (project.languages or []) if l != project.primary_language]
                specs = [generation.dub_spec(db, project, episode, l) for l in others]
                db.commit()
                for j in db.query(Job).filter(Job.id.in_(list(r.run(specs, "Dubbing")) or [0])).all():
                    n = int((j.result or {}).get("failed") or 0)  # a dub finishes even when some of its voices didn't
                    if n:
                        r.problems.add(None, r.step, f"{j.label}: {n} voice or lip-sync job{'s' if n != 1 else ''} "
                                       "didn't finish", "Open the dub's jobs to see why, then run the dub again")
            elif stage == "export":
                # never an export with still pictures where clips should be: the gaps are listed instead
                missing = problems.missing_videos(db, generation.episode_shots(db, episode))
                if missing:
                    r.problems.extend([problems.export_skipped(missing)])
                    mark(stage, "running", r.problems.items[-1]["reason"])
                else:
                    preset = "youtube" if project.aspect == "16:9" else ("square" if project.aspect == "1:1" else "shorts")
                    specs = [generation.render_spec(project, episode, l, "final", preset, {"captions": True})
                             for l in (project.languages or [project.primary_language])]
                    db.commit()
                    r.run(specs, "Exports")
            elif stage == "marketing":
                db.commit()
                r.run([generation.marketing_spec(db, project, episode)], "Marketing pack")
        mark(stage, "done")
        ms = autopilot_def.milestone_of(stage)
        if ms and ms["id"] in pause_after and AUTOPILOT_STAGES.index(stage) < stop_at:
            # an approval stop: hand back to the user; Continue runs again and skips what is done
            mark(stage, "paused", f"{ms['label']} is ready — review it, then Continue", paused_after=ms["id"],
                 problems=len(r.problems.items))
            return {"paused_after": ms["id"], "stages": stages}
    with SessionLocal() as db:
        r.problems.extend(problems.qc_problems(db, generation.episode_shots(db, db.get(Episode, ctx.episode_id))))
    n = len(r.problems.items)
    mark(AUTOPILOT_STAGES[stop_at], "finished",
         f"Autopilot finished with {n} problem{'s' if n != 1 else ''}: see the shot list" if n else "Autopilot finished",
         problems=n)
    return {"stages": stages}


def _carry_continuity(ctx: JobContext, shot_ids: list[int] | None, r: RunLog | None = None) -> list[int]:
    """Before the first picture: the Continuity Bible end state of every scene before the last one being made (written
    by AI from the script when missing, core/continuity.py), so each scene's prompts carry who wears what, what is in
    hand, time of day and weather from the scene before. Never stops the run, not even for an error worth retrying:
    without it the shots are still made, and the hiccup is listed as a problem."""
    from ..models import Scene
    try:
        with SessionLocal() as db:
            project, episode = db.get(Project, ctx.project_id), db.get(Episode, ctx.episode_id)
            scene_ids = {s.scene_id for s in generation.episode_shots(db, episode, shot_ids) if s.scene_id}
            orders = [sc.order for sc in db.query(Scene).filter(Scene.id.in_(scene_ids)).all()] if scene_ids else []
            if not orders:
                return []
            return scene_chain.ensure_end_states(db, _user(db, ctx), project, episode, max(orders))
    except Cancelled:
        raise
    except Exception as e:  # a writing hiccup must not cost the user their videos
        print(f"[produce] continuity end states skipped: {e}")
        if r is not None:
            r.problems.add(None, "Continuity", f"The scenes' end states couldn't be written ({str(e)[:160]})",
                           "The shots are made anyway; write the end states in the Continuity Bible and remake a shot "
                           "if something doesn't carry over")
        return []


def _link_scenes(ctx: JobContext, shot_ids: list[int] | None, rule: str) -> list[str]:
    """Before the first picture: a scene that picks up straight from the one before (same place and time, someone in
    common: core/links.scene_link_candidate) starts from its last frame, so the cut doesn't jump between them."""
    from ..models import Scene
    with SessionLocal() as db:
        episode = db.get(Episode, ctx.episode_id)
        ids = {s.scene_id for s in generation.episode_shots(db, episode, shot_ids) if s.scene_id}
        scenes = db.query(Scene).filter(Scene.id.in_(ids)).order_by(Scene.order, Scene.id).all() if ids else []
        return [x for x in (scene_chain.link_to_previous_scene(db, sc, rule) for sc in scenes) if x]


def _voices_first(ctx: JobContext, r: RunLog, shot_ids: list[int] | None, lang: str | None) -> int:
    """Before the pictures: the studio voices (TTS dialogue and narration) of the shots whose clip isn't made yet, then
    each of those shots is timed to its real voice (generation.fit_to_voices: 4/6/8 s, extended when narration runs
    longer). The lip-sync comes after the videos. Returns the voice jobs queued."""
    r.step = "Voices first"
    with SessionLocal() as db:
        project, episode = db.get(Project, ctx.project_id), db.get(Episode, ctx.episode_id)
        lang = lang or project.primary_language
        specs = generation.voice_first_specs(db, project, generation.episode_shots(db, episode, shot_ids), lang)
        db.commit()
    r.run(specs, "Voices first, to time the shots")
    with SessionLocal() as db:
        project, episode = db.get(Project, ctx.project_id), db.get(Episode, ctx.episode_id)
        notes, changed = generation.fit_to_voices(db, project, generation.episode_shots(db, episode, shot_ids), lang)
        db.commit()
    r.problems.extend(notes)
    if changed:
        emit(None, ctx.project_id, "episode.updated", {"episode_id": ctx.episode_id, "what": "shots"})
    return len(specs)


def _registrations(db, project: Project, shots: list, quality: str | None) -> list[dict]:
    """Seedance can refuse a realistic face it gets from a keyframe alone; a character registered in the BytePlus asset
    library goes in as a trusted reference instead (providers/services._seedance). When a Seedance engine will make some
    of these shots and the team turned on automatic registration, the cast step registers their on-screen characters
    that may be registered: AI-made images only, a real person's photo never (handlers_hub.auto_register_reason)."""
    from ..core import recovery
    from ..models import Character
    from .handlers_hub import auto_register_reason
    if not settings_store.get_setting(db, "byteplus_auto_register"):
        return []
    out, seen = [], set()
    for s in shots:
        if recovery.seedance_engine(db, s, project, quality) is None:
            continue
        for cid in s.characters or []:
            ch = db.get(Character, int(cid))
            if ch is None or ch.id in seen or recovery.seedance_ready(ch):
                continue
            seen.add(ch.id)
            if not auto_register_reason(db, ch):
                out.append(generation.byteplus_register_spec(project.id, ch))
    return out


def _set_paused(episode_id: int, after: str | None) -> None:
    """Episode.settings["produce_paused"]: the shot list shows a "check them, then continue" note while it is set."""
    with SessionLocal() as db:
        ep = db.get(Episode, episode_id)
        settings = dict(ep.settings or {})
        if after:
            settings["produce_paused"] = {"after": after, "at": utcnow().isoformat() + "Z"}
        elif "produce_paused" not in settings:
            return
        else:
            settings.pop("produce_paused")
        ep.settings = settings
        db.commit()


@handler("produce")
def produce(ctx: JobContext) -> dict:
    """Produce all: the shot list as written, step by step (cast looks & voices → the studio voices, so each new clip
    is as long as its voice → keyframes → videos, each wave of linked shots extended before the next starts → the
    remaining extensions → lip-sync → sound effects → music → export). No writing or re-planning: only what is missing
    is made. One budget approval covers the run. Before the first picture every scene gets the end state of the one
    before it, and (link_scenes) a scene that picks up straight from the one before starts from its last frame.
    review_looks: when the run made new looks or voices, it stops after them so they can be checked before every shot
    uses them; running it again carries on (nothing is made twice). What fails is listed as the run's problems (the
    result's "problems", the episode's run_problems); the export is skipped while shots have no video.
    draft ("Quick draft first"): every shot without a clip gets a cheap 480p preview on the cheapest engine that makes
    one (no QC, never replacing a finished clip), no extensions and no mouth sync yet (the voices are made and kept),
    and the export is a draft render of that cut. The final film is the same run without `draft`: the drafts are
    remade as finished clips (a draft never counts as one)."""
    p = ctx.payload
    draft = bool(p.get("draft"))
    steps = [s for s in generation.PRODUCE_STEPS if s in (p.get("steps") or generation.PRODUCE_STEPS)
             and not (draft and s == "extend")]
    r = RunLog(ctx, "Make it for me (draft)" if draft else "Produce all")
    problems.start(ctx.episode_id)
    _set_paused(ctx.episode_id, None)
    try:
        try:
            out = _produce(ctx, r, steps)
        except BudgetStop:
            r.stopped_at_budget("Make it for me" if draft else "Produce all")
            out = {"steps": steps, "jobs": r.done, "stopped": "budget"}
    except BaseException:
        r.save(announce=False, draft=draft)
        raise
    out["problems"] = r.save(announce=True, draft=draft)
    out["draft"] = draft
    return out


def _produce(ctx: JobContext, r: RunLog, steps: list[str]) -> dict:
    from ..pipeline.selection import current, has_fresh, is_real

    p = ctx.payload
    shot_ids = p.get("shot_ids") or None
    quality = p.get("quality")
    draft = bool(p.get("draft"))
    link_rule = p.get("link_scenes") if p.get("link_scenes") in ("auto", "always") else "never"
    done = r.done
    carried = False
    in_waves = "extend" in steps and "videos" in steps  # each wave is extended before the next starts from it

    for i, step in enumerate(steps):
        r.guard()
        label = generation.PRODUCE_LABELS[step]
        ctx.progress(i / len(steps), label)
        if step in ("keyframes", "videos") and not carried:
            carried = True
            ctx.progress(i / len(steps), "Continuity: what carries from scene to scene")
            done["continuity"] = len(_carry_continuity(ctx, shot_ids, r))
            if link_rule != "never":
                done["scene_links"] = len(_link_scenes(ctx, shot_ids, link_rule))
            if "voices" in steps:  # voices before pictures: each new clip is as long as its real voice
                ctx.progress(i / len(steps), "Voices first, to time the shots")
                done["voices_first"] = _voices_first(ctx, r, shot_ids, p.get("language"))
        r.step = label
        if step == "extend":  # what the video step's waves didn't extend (clips made before this run)
            with SessionLocal() as db:
                ids = [s.id for s in generation.episode_shots(db, db.get(Episode, ctx.episode_id), shot_ids)]
            done[step] = done.get(step, 0) + scene_chain.extend_shots(SessionLocal, r.run, ctx.project_id, ids, label)
            continue
        with SessionLocal() as db:
            project = db.get(Project, ctx.project_id)
            episode = db.get(Episode, ctx.episode_id)
            shots = generation.episode_shots(db, episode, shot_ids)
            lang = p.get("language") or project.primary_language
            specs: list[dict] = []
            if step == "cast":
                specs = generation.cast_specs(db, project, shots) + _registrations(db, project, shots, quality)
            elif step == "keyframes":  # a shot that starts from a clip not made yet gets its keyframe with its video
                specs = generation.keyframe_specs(db, project, [s for s in shots if "videos" not in steps
                                                                or not links.waits_for_clip(db, s)], only_missing=True)
            elif step == "videos":  # in link order: a shot that continues another starts from its finished clip
                # remake: the Director was asked for these shots by name, so they are made again even with a video;
                # a draft run drafts only the shots with no clip at all (a draft or a finished clip is kept)
                need = [s.id for s in shots if (generation.needs_draft(db, s) if draft
                                                else p.get("remake") or not is_real(current(db, s.id, "video")))]
                db.commit()
                res = scene_chain.make_videos_in_order(SessionLocal, r.run, project.id, need, quality, label,
                                                       extend=in_waves, draft=draft)
                done[step] = res["videos"]
                if res["extensions"]:
                    done["extend"] = done.get("extend", 0) + res["extensions"]
                for w in res["warnings"]:
                    r.problems.add(None, label, w, "Make the video it continues from, then remake this one")
                continue
            elif step == "voices":  # the lip-syncs (their voices were made first) and any narration still missing
                need = [s for s in shots if budget.Estimator.needs_lipsync(s, project, lang) and not has_fresh(db, s.id, "lipsync", lang)]
                narr = [s for s in shots if budget.Estimator.voice_only(s, project, lang) and s not in need
                        and not current(db, s.id, "narration" if (s.narration or {}).get(lang) else "voice", lang)]
                if draft:  # a draft clip is remade for the final film: its voice is kept, its mouth sync waits for that
                    need = [s for s in need if not current(db, s.id, "voice", lang)]
                    specs = generation.voice_specs(db, project, need + narr, lang)
                else:
                    specs = generation.lipsync_specs(db, project, need, lang) + generation.voice_specs(db, project, narr, lang)
            elif step == "sound" and (snd := generation.sound_step(db, project, episode, shots)):
                specs = [snd[0]]  # ElevenLabs, or the free library without its key
            elif step == "music" and (mus := generation.music_step(db, project, episode, p.get("music_per_scene"))):
                specs = [mus[0]]  # the scenes' missing pieces, or the one score
            elif step == "export":
                # never an export with still pictures where clips should be: the gaps are listed instead (a draft
                # run renders its drafts as a draft cut; the final film counts a draft as a gap still to make)
                missing = problems.missing_videos(db, shots, drafts_ok=draft)
                if missing:
                    r.problems.extend([problems.export_skipped(missing, draft)])
                elif draft:
                    specs = [generation.render_spec(project, episode, lang, "final", "draft", {"captions": True, "draft": True})]
                else:
                    preset = "youtube" if project.aspect == "16:9" else ("square" if project.aspect == "1:1" else "shorts")
                    specs = [generation.render_spec(project, episode, lang, "final", preset, {"captions": True})]
            db.commit()
        st = r.run(specs, label)
        done[step] = len(st)
        if step == "cast" and p.get("review_looks") and step != steps[-1]:
            made = sum(1 for s in st.values() if s == "succeeded")
            if made:  # something new to check (failures are listed as problems; nothing new: no stop)
                failed = len(st) - made
                _set_paused(ctx.episode_id, "cast")
                msg = ("New looks and voices are ready: check them in Cast, then press Produce all to carry on."
                       + (f" {failed} didn't finish: see the shot list." if failed else ""))
                emit(None, ctx.project_id, "produce.paused", {"episode_id": ctx.episode_id, "after": "cast", "message": msg})
                emit(None, ctx.project_id, "episode.updated", {"episode_id": ctx.episode_id, "what": "shots"})
                return {"steps": steps, "jobs": done, "paused_after": "cast"}
    with SessionLocal() as db:
        r.problems.extend(problems.qc_problems(db, generation.episode_shots(db, db.get(Episode, ctx.episode_id), shot_ids)))
    return {"steps": steps, "jobs": done}
