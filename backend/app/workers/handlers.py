"""Core media job handlers. Every generation goes through the Model Hub router (engine chains with fallback)."""
from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import httpx

from .. import catalog, settings_store
from ..agents import prompts
from ..agents import schemas as S
from ..core import budget, dependencies, frames, generation, lock as lock_core, model_hub, ratelimit, recovery, studio
from ..db import SessionLocal, utcnow
from ..events import emit
from ..models import (AIModel, AudioAsset, Character, CharacterAsset, Episode, Export, Location, LocationAsset, Project, Shot,
                      Style, Take, User, VoiceProfile)
from ..pipeline import assembler, faces, ffmpeg as ff, scene_look
from ..pipeline.prompting import (character_refs, compile_enhance_prompt, compile_keyframe_prompt, compile_video_prompt,
                                  effective_quality, effective_voice_mode, enhance_refs, keyframe_refs, look_of,
                                  MAX_WORDS_PER_CLIP, native_languages, negative_prompt, outfit_for, shot_lines,
                                  video_refs)
from ..pipeline.selection import current, select
from ..pipeline.voice import build_dialogue, build_narration, choose_duration
from ..providers.base import (NeedsApproval, ProviderBlocked, ProviderError, ProviderNotConfigured, ProviderOutOfCredit,
                              RetryableProviderError)
from ..providers.schema_map import GenRequest
from ..storage import get_storage
from .worker import JobContext, handler

AI_PROVIDERS = {"google", "gemini", "fal", "sync", "elevenlabs", "sarvam"}
LEGACY_LIPSYNC = {"lipsync-2": "sync:lipsync", "lipsync-2-pro": "sync:lipsync_pro", "sync-3": "sync:lipsync_angles"}


# ── helpers ──────────────────────────────────────────────────────────────────

def _ext_of_audio(data: bytes) -> str:
    return "wav" if data[:4] == b"RIFF" else "mp3"


def save_take(db, ctx: JobContext, shot: Shot, kind: str, data: bytes | None, ext: str, *, src_file: Path | None = None,
              language: str | None = None, provider: str = "", model: str = "", params: dict | None = None,
              prompt: str = "", duration: float = 0.0, cost: float = 0.0, remote_ref: str = "", interaction_id: str = "",
              parent: int | None = None, auto_select: bool = True) -> Take:
    st = get_storage()
    project_id = ctx.project_id or db.get(Episode, shot.episode_id).project_id
    folder = f"projects/{project_id}/shots/{shot.id}/{kind}"
    rel = st.new_path(folder, ext)
    if src_file:
        st.save_file(rel, src_file)
    else:
        st.save_bytes(rel, data or b"")
    abs_p = st.abs(rel)
    thumb = ""
    if kind in ("keyframe", "endframe", "video", "lipsync", "voicelock", "upscale"):
        try:
            thumb = st.save_file(st.new_path(folder, "jpg"), ff.thumbnail(abs_p, abs_p.with_suffix(".thumb.jpg")))
        except Exception:
            thumb = ""
    if not duration and kind not in ("keyframe", "endframe"):
        try:
            duration = ff.duration(abs_p)
        except Exception:
            duration = 0.0
    params = dict(params or {})
    if provider in AI_PROVIDERS and model_hub.provider_mode(provider) == "mock":
        params["mock"] = True  # a placeholder made without an API key: never counts as finished work
    t = Take(shot_id=shot.id, kind=kind, language=language, provider=provider, model=model, params=params,
             prompt=prompt, path=rel, thumb_path=thumb, duration_s=duration, cost_usd=round(cost, 5), job_id=ctx.job_id,
             remote_ref=remote_ref, interaction_id=interaction_id, parent_take_id=parent, created_by=ctx.user_id)
    db.add(t)
    db.flush()
    dependencies.clear(db, shot.id, kind, language)
    others = [x for x in db.query(Take).filter(Take.shot_id == shot.id, Take.kind == kind, Take.archived.is_(False),
                                               Take.language == language if language else Take.language.is_(None)).all()
              if x.id != t.id]
    # you asked for this take (not a follow-up of a bigger run or an automatic retake): it becomes current even on an
    # approved shot, which goes back to review; follow-up takes never replace what you approved
    asked = ctx.parent_job_id is None and not (ctx.payload or {}).get("retake_count")
    if auto_select and (shot.status != "approved" or asked or not any(o.selected for o in others)):
        select(db, t)
        if asked and shot.status == "approved" and kind in ("video", "lipsync", "voicelock"):
            shot.status = "video_ready"
    return t


def _project_of(db, shot: Shot) -> Project:
    return db.get(Project, db.get(Episode, shot.episode_id).project_id)


def _user(db, ctx: JobContext) -> User | None:
    return db.get(User, ctx.user_id) if ctx.user_id else None


def _style_of(db, project_id: int | None) -> Style | None:
    if not project_id:
        return None
    p = db.get(Project, project_id)
    return db.get(Style, p.style_id) if p and p.style_id else None


def _prev_shot(db, shot: Shot) -> Shot | None:
    return (db.query(Shot).filter(Shot.episode_id == shot.episode_id, Shot.include.is_(True), Shot.order < shot.order)
            .order_by(Shot.order.desc()).first())


def _run_price(m: AIModel, req: GenRequest) -> float:
    """Estimated USD for running `req` on engine `m` (0 in mock mode)."""
    if m.task in ("video", "avatar", "lipsync", "edit"):
        secs = model_hub.clamp_duration(m, float(req.duration or 8))
        return model_hub.price_for(m, seconds=secs, resolution=(req.resolution or "720p").lower())
    return model_hub.price_for(m)


class _Run:
    """What one run_chain call has seen so far: attempts, the last error, rate-limit waits, engines that blocked
    the content, and fallbacks skipped for costing more than the job may spend without approval."""

    def __init__(self, ctx: JobContext, first: AIModel):
        self.ctx, self.first = ctx, first
        self.attempts: list[dict] = []
        self.last: Exception | None = None
        self.held = 0.0  # shortest wait among engines held back by a rate limit
        self.held_google: list[AIModel] = []
        self.blocked: list[str] = []
        self.too_dear: list[tuple[float, AIModel]] = []  # (extra USD over what is allowed, engine)
        with SessionLocal() as db:
            from ..models import Job
            job = db.get(Job, ctx.job_id)
            self.estimate = float(job.cost_estimate or 0) if job else 0.0
            self.limit = float(settings_store.get_setting(db, "fallback_extra_limit_usd") or 0)
        self.extra_ok = float(ctx.result.get("extra_ok_usd") or 0)

    def tried(self) -> set[str]:
        return {a["engine"] for a in self.attempts}


def _try_engines(run: _Run, cands: list[tuple[AIModel, str]], build: Callable[[AIModel, str], GenRequest],
                 expected_s: float):
    """Try engines in order; returns (model, mode, result) from the first that works, else None (see `run`)."""
    from ..core import credit
    ctx = run.ctx
    for m, mode in cands:
        ctx.check_cancel()
        hold = ratelimit.cooling(m.provider)
        per_call = 0.0
        if not hold and m.provider == "google":
            per_call = model_hub.price_for(m, seconds=8) if m.task in ("video", "avatar", "lipsync", "edit") else model_hub.price_for(m)
            hold = ratelimit.google_spend_wait(per_call)
        if hold:
            run.held = min(run.held or hold, hold)
            if m.provider == "google":
                run.held_google.append(m)
            run.attempts.append({"engine": m.id, "mode": mode, "error": f"rate limited, held back {int(hold)}s"})
            continue
        ops = dict(ctx.result.get("ops") or {})
        token = ratelimit.reserve(per_call) if per_call > 0 else None  # count it against the 10-min window now
        try:
            req = build(m, mode)
            if m.id not in ops:  # (a resumed operation is paid for already)
                price = _run_price(m, req)
                if m.id != run.first.id and price > 0:
                    # a fallback route may cost more than the job was approved for, up to the team's limit
                    base = max(run.estimate, _run_price(run.first, req))
                    if price > base + run.limit + run.extra_ok + 1e-6:
                        run.too_dear.append((round(price - base, 4), m))
                        run.attempts.append({"engine": m.id, "mode": mode, "price_usd": round(price, 4),
                                             "error": f"costs ${price:.2f}, over the approved ${base:.2f} + limit"})
                        continue
                short = credit.short_of(m.provider, price) if model_hub.provider_mode(m.provider) == "live" else ""
                if short:
                    run.attempts.append({"engine": m.id, "mode": mode, "error": short})
                    continue
            ctx.progress(0.1, f"{m.display_name} · {mode}")
            res = ctx.services.run_model(
                m, req, on_tick=ctx.tick(m.display_name, expected_s),
                on_request=lambda rid, mid=m.id: ctx.save_result(ops={**(ctx.result.get("ops") or {}), mid: rid}),
                resume=ops.get(m.id))
            model_hub.record_outcome(m.id, True)
            ratelimit.ok(m.provider)
            return m, mode, res
        except RetryableProviderError as e:
            if not e.rate_limited or getattr(e, "cooled", False):
                raise  # cooled: a step inside build() (e.g. the keyframe) was held back, and has recorded it already
            wait = ratelimit.cool(e.provider or m.provider, e.retry_after)
            run.held = min(run.held or wait, wait)
            if m.provider == "google":
                run.held_google.append(m)
            run.attempts.append({"engine": m.id, "mode": mode, "error": str(e)[:300]})
            run.last = e
        except (ProviderBlocked, ProviderError) as e:
            if str(e) == "cancelled" or isinstance(e, NeedsApproval):
                raise
            if m.id in ops:  # the saved operation is dead: a retry must start a new one, not poll this one forever
                ctx.save_result(ops={k: v for k, v in (ctx.result.get("ops") or {}).items() if k != m.id})
            if isinstance(e, ProviderOutOfCredit):
                credit.hold(e.provider or m.provider, str(e))  # skip this provider for every job for a while
            else:
                model_hub.record_outcome(m.id, False)
            if isinstance(e, ProviderBlocked):
                run.blocked.append(m.id)
            run.attempts.append({"engine": m.id, "mode": mode, "error": str(e)[:300]})
            run.last = e  # an explicit pick only has routes of the same model to fall back on
        finally:
            ratelimit.release(token)
    return None


def run_chain(ctx: JobContext, chain: str, modes_ok: list[str], build: Callable[[AIModel, str], GenRequest],
              explicit: str | None = None, skip: list[str] | None = None, expected_s: float = 90, only: bool = False):
    """Try each engine of a chain until one succeeds. Non-retryable failures (safety block, bad input, unsupported,
    no credit) fall through to the next engine, and so does a rate limit (that provider is then paused for every job,
    see core/ratelimit.py); other transient errors bubble up so the worker retries the job.

    Two opt-in fallbacks look past "Google first": the same model through another provider when Google's quota is
    used up ("quota_fallback_routes"), and other models when every engine tried blocked the content
    ("safety_fallback"). A fallback that costs more than the job was approved for (plus "fallback_extra_limit_usd")
    is skipped; when nothing else works the job waits for approval instead of failing.

    `only` (with `explicit`): that engine through its own provider and nothing else, not even the same model through
    another provider (a character's sheet engine picked by hand, e.g. Seedream on BytePlus only). The opt-in safety
    fallback still applies when the team turned it on."""
    from ..core import credit, recovery
    with SessionLocal() as db:
        cands = model_hub.candidates(db, chain, modes_ok, explicit)
        no_credit = credit.holds(db)
        quota_fallback = bool(settings_store.get_setting(db, "quota_fallback_routes"))
        safety_fallback = bool(settings_store.get_setting(db, "safety_fallback"))
    if only and explicit:
        cands = [c for c in cands if c[0].id == explicit]
        if not cands:
            with SessionLocal() as db:
                m = db.get(AIModel, explicit)
                name = m.display_name if m else explicit
                mode = model_hub.provider_mode(m.provider) if m else "missing"
                why = ("is no longer in the Model Hub" if m is None or m.status == "retired"
                       else f"has no {m.provider} credit left" if m.provider in no_credit
                       else f"has no {m.provider} API key" if mode == "missing"
                       else f"can't do {'/'.join(modes_ok)}" if not set(modes_ok) & set((m.capabilities or {}).get("modes") or [])
                       else f"has no {m.provider} API key, so it would only make placeholders" if mode == "mock"
                       else "can't run now")
            raise ProviderNotConfigured(f"{name} was picked for this, and it {why}. Pick another engine (or Auto).")
    if skip and len(cands) > 1:
        rest = [c for c in cands if c[0].id not in skip]
        cands = rest or cands
    if not cands:
        if no_credit:
            raise ProviderOutOfCredit(f"No engine for '{model_hub.CHAIN_LABELS.get(chain, chain)}' can run: "
                                      f"{', '.join(sorted(no_credit))} has no credit left. Top up, then re-check the "
                                      "balance in Settings → AI services.")
        raise ProviderNotConfigured(f"No enabled engine for '{model_hub.CHAIN_LABELS.get(chain, chain)}' that can do "
                                    f"{'/'.join(modes_ok)}. Enable one in Model Hub → Engines.")
    run = _Run(ctx, cands[0][0])
    got = _try_engines(run, cands, build, expected_s)
    if got is None and run.held_google and quota_fallback and not explicit:
        # Google is out of quota or rate limited: the same model through another provider (Nano Banana on OpenRouter …)
        keys = {model_hub.route_key(m) for m in run.held_google} - {""}
        with SessionLocal() as db:
            alt = [c for c in model_hub.candidates(db, chain, modes_ok, None, google_first=False)
                   if c[0].provider != "google" and c[0].id not in run.tried() and model_hub.route_key(c[0]) in keys]
        if alt:
            ctx.progress(0.1, "Google is out of quota: the same model through another provider")
            got = _try_engines(run, alt, build, expected_s)
    if got is None and run.blocked and safety_fallback and isinstance(run.last, ProviderBlocked):
        # every engine tried blocked the content: other models, those that take registered characters first
        with SessionLocal() as db:
            alt = [c for c in model_hub.candidates(db, chain, modes_ok, None, google_first=False)
                   if c[0].id not in run.tried() and c[0].id not in (skip or [])]
            alt = recovery.prefer_registered(db, ctx.shot_id, alt)
        if alt:
            ctx.progress(0.1, f"Blocked by a safety filter: trying {alt[0][0].display_name}")
            got = _try_engines(run, alt, build, expected_s)
    if got is not None:
        m, mode, res = got
        return m, mode, res, run.attempts
    ctx.save_result(attempts=run.attempts[-12:], blocked_engines=run.blocked)
    if run.held:
        # every engine that could do this is rate limited: the worker re-queues the job without using up a retry
        err = RetryableProviderError(f"Rate limited on every engine that can do this; retrying in {int(run.held)}s. "
                                     f"{run.last or ''}".strip(), status=429, provider=getattr(run.last, "provider", ""),
                                     retry_after=run.held)
        err.cooled = True  # back-off already recorded per provider
        raise err
    if run.too_dear:
        extra, m = min(run.too_dear, key=lambda t: t[0])
        raise NeedsApproval(f"{m.display_name} can make this, but costs ${extra:.2f} more than approved. "
                            f"Earlier engines: {run.last or 'skipped'}"[:500], extra_usd=extra, engine=m.id,
                            provider=m.provider)
    raise run.last or ProviderError("all engines failed")


def gen_image(ctx: JobContext, prompt: str, refs: list[Path], aspect: str, title: str = "", explicit: str | None = None,
              seed: int | None = None, only: bool = False):
    """Image through the 'image' chain. Returns (MediaResult, engine_id). `seed` reaches engines that take one; `only`
    keeps an `explicit` engine to its own route (see run_chain)."""
    refs = [r for r in refs if r and r.exists()]
    # with references only engines that can see them qualify: a text-only engine would ignore the character's look
    # (if none is free, e.g. Google's quota is used up, the job waits for it instead of making an unrelated image)
    modes = ["i2i"] if refs else ["t2i", "i2i"]
    m, mode, res, attempts = run_chain(ctx, "image", modes, lambda m, mode: GenRequest(
        mode=mode, prompt=prompt, refs=refs if mode == "i2i" else [], aspect=aspect, seed=seed), explicit=explicit,
        expected_s=30, only=only)
    return res, m.id


def _identity(ch: Character, db=None, episode_no: int | None = None) -> dict | None:
    ident = look_of(db, ch, episode_no)["identity"] if db is not None else (ch.identity or {})
    return ident if ident.get("status") == "ready" and ident.get("lora_url") else None


def _continuity_source(db, shot: Shot) -> Shot | None:
    """The shot this one continues from: an explicit Film Map link first, else the previous shot when asked, else (by
    default, setting auto_scene_continuity) the previous shot when it is in the same scene and location."""
    return scene_look.continuity_source(db, shot)


def _loras_for(db, shot: Shot, episode_no: int | None) -> list[dict]:
    """A single trained character rides along to engines that accept LoRA weights (fal models with a loras input)."""
    chars = [db.get(Character, int(c)) for c in (shot.characters or [])]
    if len(chars) != 1 or not chars[0]:
        return []
    ident = _identity(chars[0], db, episode_no)
    return [{"path": ident["lora_url"], "scale": float(ident.get("scale", 1.0))}] if ident else []


MAX_ENGINE_REFS = 9  # the most reference images a video engine takes (Seedance); Veo's reference-to-video takes 3


def _refs_for(m: AIModel, shot_id: int) -> list[tuple[str, Path]]:
    """The labelled references a reference-to-video request sends: as many as this engine takes (its max_refs), a face
    for every on-screen person first (pipeline/prompting.video_refs)."""
    with SessionLocal() as db:
        return video_refs(db, db.get(Shot, shot_id), int((m.capabilities or {}).get("max_refs") or 3))


# What Veo can extend (Gemini API docs, https://ai.google.dev/gemini-api/docs/veo, checked 18 Oct 2026): "Video
# extension is also limited to 720p videos" (7 s added per extension, up to 20 times, inputs up to 141 s); "Gemini API
# only supports video extensions for Veo-generated videos", referenced from a previous generation; and "Generated videos
# are stored on the server for 2 days, after which they are removed" (using a video for an extension starts its 2 days
# again). Our own copy uploaded again is not a Veo-generated video, so an expired clip can't be extended on Veo: the job
# says so in plain words instead.
VEO_KEEPS_S = 2 * 24 * 3600


def _veo_source(t: Take) -> dict[str, Any]:
    p = t.params or {}
    return {"provider": t.provider, "mock": bool(p.get("mock")), "resolution": str(p.get("resolution") or "").lower(),
            "uri": t.remote_ref or "", "made": t.created_at, "touched": p.get("remote_touched_at")}


def veo_cant_extend(src: dict[str, Any], now: datetime | None = None) -> str:
    """Why Veo can't extend this clip ("" = it can)."""
    if src.get("mock"):
        return ""  # a placeholder made without a key: the mock extends anything
    if src.get("provider") not in ("google", "gemini") or not str(src.get("uri") or "").startswith("http"):
        return ("Veo extends only clips it made itself, and this one wasn't made by Veo. Extend it with the engine that "
                "made it (pick it on the shot), or remake the shot's video on Veo first.")
    if src.get("resolution") not in ("", "720p"):
        return (f"Veo extends only 720p clips and this one is {src['resolution']}. Remake the shot's video (a shot with an "
                "extend-to length is made at 720p), then extend it.")
    last = src.get("made")
    try:
        touched = datetime.fromisoformat(str(src.get("touched")).rstrip("Z")) if src.get("touched") else None
    except ValueError:
        touched = None
    last = max(x for x in (last, touched) if x is not None) if (last or touched) else None
    if last is not None and ((now or utcnow()) - last).total_seconds() > VEO_KEEPS_S - 3600:
        return ("Veo keeps the clips it makes for 2 days and this one is older, so Veo can't extend it any more. Remake "
                "the shot's video and extend that, or extend it with another engine (pick one on the shot).")
    return ""


def _touch_remote(take_id: int) -> None:
    with SessionLocal() as db:
        t = db.get(Take, take_id)
        if t is not None:
            t.params = {**(t.params or {}), "remote_touched_at": utcnow().isoformat() + "Z"}
            db.commit()


# ── keyframe ─────────────────────────────────────────────────────────────────

@handler("keyframe")
def keyframe(ctx: JobContext) -> dict:
    # (called inside a video or end-frame job, the payload is that job's: none of it is for the keyframe)
    return make_keyframe(ctx, ctx.shot_id, ctx.payload if ctx.type == "keyframe" else {})


def make_keyframe(ctx: JobContext, shot_id: int, own: dict, seen: set[int] | None = None) -> dict:
    """Make and save the start frame (keyframe) of `shot_id`. A shot synced to the one before starts on that shot's
    end frame: its keyframe is a copy of it (core/frames.py), made first when missing. `seen`: shots already being
    made up the chain (a cycle of synced links is made normally)."""
    if not own.get("enhance_take_id"):
        from .handlers_frames import synced_start
        done = synced_start(ctx, shot_id, own, seen or set())
        if done is not None:
            return done
    st = get_storage()
    tmp = st.tmp_dir()
    retake = int(own.get("retake_count") or 0)
    with SessionLocal() as db:
        shot = db.get(Shot, shot_id)
        project = _project_of(db, shot)
        enhance_id = own.get("enhance_take_id")
        fr = scene_look.Frames()
        if enhance_id:  # Enhance: re-render this keyframe with the Pro model, same picture
            src_take = db.get(Take, int(enhance_id))
            if not src_take or src_take.shot_id != shot.id or src_take.kind != "keyframe" or not st.exists(src_take.path):
                raise ProviderError("The keyframe to enhance is gone")
            refs = enhance_refs(db, shot, st.abs(src_take.path))
            prompt = compile_enhance_prompt(db, shot, project, [l for l, _ in refs])
        else:
            # the scene's anchor keyframe (set, light, palette, wardrobe) and the shot before (positions, props);
            # fr.prev_take_id is the clip whose last frame this keyframe starts from, fr.prev_end_take_id the end frame
            # (core/scene_chain.follows)
            fr = scene_look.continuity_frames(db, shot, _continuity_source(db, shot), tmp)
            refs = keyframe_refs(db, shot, fr.prev, fr.anchor, fr.prev_from)
            prompt = compile_keyframe_prompt(db, shot, project, [l for l, _ in refs], fix=own.get("fix"))
        aspect, code = project.aspect, shot.code
        ep_row = db.get(Episode, shot.episode_id)
        ep_no = ep_row.number if ep_row else None
        chars = [db.get(Character, int(c)) for c in (shot.characters or [])]
        trained = [c for c in chars if c and _identity(c, db, ep_no)]
        # "hero" keyframes (and Enhance) use the Pro image model they were priced at, unless the project's frames
        # have an engine of their own (core/frames.py: Seedream for a Seedance film …). A video job that makes its
        # missing keyframe first names a video engine in its payload: that one is not for the image.
        own_engine = own.get("engine") or frames.engine_id(db, project)
        explicit = own_engine or ("google:image_hero" if (own.get("hero") or enhance_id) else None)
        ident = _identity(trained[0], db, ep_no) if (len(chars) == 1 and trained and not own_engine
                                                     and not enhance_id) else None
        # the trained model sees no images: its prompt must not talk about any
        lora_prompt = compile_keyframe_prompt(db, shot, project, [], fix=own.get("fix")) if ident else ""
        trainer_cfg = settings_store.get_setting(db, "identity_trainer") or {}
        seed = scene_look.scene_seed(shot, project.id, retake) if not enhance_id else None
        db.commit()
    ctx.progress(0.2, "Enhancing keyframe" if enhance_id else "Generating keyframe")
    if ident:  # locked face: the character's own trained model
        lp = f"{ident['trigger']}, {lora_prompt}"
        res = ctx.services.lora_image(ident.get("inference") or trainer_cfg.get("inference", "fal-ai/qwen-image-2512/lora"), lp,
                                      [{"path": ident["lora_url"], "scale": float(ident.get("scale", 1.0))}], aspect,
                                      title=f"{code} keyframe")
        engine = f"lora:{ident.get('trigger')}"
    else:
        res, engine = gen_image(ctx, prompt, [p for _, p in refs], aspect, title=f"{code} keyframe", explicit=explicit,
                                seed=seed)
    with SessionLocal() as db:
        shot = db.get(Shot, shot_id)
        params = {"refs": [l for l, _ in refs] if not ident else [], "continuity": bool(fr.prev),
                  "continuity_take_id": fr.prev_take_id, "continuity_end_take_id": fr.prev_end_take_id,
                  "anchor": bool(fr.anchor), "anchor_shot_id": fr.anchor_shot_id, "engine": engine,
                  "engine_label": model_hub.label(db, engine) if not engine.startswith("lora:") else "Trained identity (LoRA)",
                  "seed": seed, "retake_count": retake}
        if enhance_id:
            params["enhanced_from"] = int(enhance_id)
        if own.get("fix"):
            params["fix"] = list(own["fix"])
        t = save_take(db, ctx, shot, "keyframe", res.data, res.ext, provider=res.usage.provider, model=res.usage.model,
                      params=params, prompt=lp if ident else prompt, cost=res.usage.usd,
                      parent=int(enhance_id) if enhance_id else None)
        if shot.status in ("draft", "keyframe_ready"):
            shot.status = "keyframe_ready"
        ctx.cost(res.usage, db)
        db.commit()
        emit(db, ctx.project_id, "take.created", {"shot_id": shot.id, "take_id": t.id, "kind": "keyframe"})
    shutil.rmtree(tmp, ignore_errors=True)
    if shot_id == ctx.shot_id:  # (a frame made for another shot up a synced chain is not this job's to retake)
        from .handlers_keyframe import queue_qc
        queue_qc(ctx, t.id, shot_id, code)  # vision check, one automatic retake if it fails
    return {"take_id": t.id, "engine": engine}


# ── video (any engine) ───────────────────────────────────────────────────────

@handler("video")
def video(ctx: JobContext) -> dict:
    st = get_storage()
    p = ctx.payload
    with SessionLocal() as db:
        shot = db.get(Shot, ctx.shot_id)
        project = _project_of(db, shot)
        q = p.get("quality") or effective_quality(shot, project)
        qm = catalog.QUALITY_MODES.get(q, catalog.QUALITY_MODES["saver"])
        lang = p.get("language") or project.primary_language
        native = bool(p.get("native"))  # dubbing route: Veo speaks this language itself
        vm = "native" if native else effective_voice_mode(shot, project, lang)
        extend = bool(p.get("extend"))
        ep_row = db.get(Episode, shot.episode_id)
        ep_no = ep_row.number if ep_row else None
        loras = _loras_for(db, shot, ep_no)
        audio_driven = vm == "audio_driven" and bool(shot_lines(shot, lang)) and not extend and not p.get("no_audio_driven")
        explicit = p.get("engine") or (shot.engine if shot.engine and shot.engine != "auto" else None)
        draft = bool(p.get("draft"))  # a cheap 480p preview before the final render
        if extend and not explicit:
            # a clip is extended by the engine that made it when that engine extends (a Seedance clip by Seedance);
            # Google's clips keep the extend chain (Veo extends only its own clips, and Fast is the one priced for it)
            made = current(db, shot.id, "video")
            maker = db.get(AIModel, (made.params or {}).get("engine") or "") if made else None
            if maker and maker.provider != "google" and "extend" in ((maker.capabilities or {}).get("modes") or []):
                explicit = maker.id
        if explicit:
            em = db.get(AIModel, explicit)
            if em and audio_driven and "a2v" not in ((em.capabilities or {}).get("modes") or []):
                audio_driven = False
        chain = "extend" if extend else ("dialogue" if audio_driven else f"video.{q}")
        mode = p.get("mode") or shot.mode or "auto"
        prompt = p.get("prompt_override") or compile_video_prompt(db, shot, project, lang, voice_mode="native" if native else None)
        negative = negative_prompt(project, db)
        kf = current(db, shot.id, "keyframe")
        # a stale keyframe (the shot changed since) counts as missing: the video job remakes it first; so does a synced
        # shot's keyframe that is not the current end frame of the shot it starts on (core/frames.py)
        kf_path = st.abs(kf.path) if kf and st.exists(kf.path) and not kf.stale and frames.start_ok(db, shot) else None
        # the end frame the clip runs to: the shot's own (an out-of-date one, or a missing one a synced shot starts on,
        # is made first)
        end = frames.end_take(db, shot)
        end_path = st.abs(end.path) if end else None
        want_end = end_path is not None or frames.wants_end(db, shot)
        # every on-screen person, as many as any engine takes (Seedance 9); a reference-to-video request gets as many
        # as its own engine takes (Veo 3), see build()
        vr = video_refs(db, shot, MAX_ENGINE_REFS)
        refs = [x for _, x in vr]
        last_frame = extend_from = None
        extend_uri = ""
        extend_src: Take | None = None
        # Veo extends only 720p clips: a shot that will be extended gets its first clip at 720p on Veo
        base_720 = bool(shot.extend_to) and not p.get("draft")
        if mode == "interpolate" and not want_end:
            nxt = (db.query(Shot).filter(Shot.episode_id == shot.episode_id, Shot.include.is_(True), Shot.order > shot.order)
                   .order_by(Shot.order).first())
            nk = current(db, nxt.id, "keyframe") if nxt else None
            last_frame = st.abs(nk.path) if nk else None
        link_parent = None
        if extend:
            vt = current(db, shot.id, "video")
            if p.get("extend_from_take"):  # a retake of an extension: the clip it was made from is extended again
                base = db.get(Take, int(p["extend_from_take"]))
                if base is not None and base.shot_id == shot.id and base.kind == "video" and not base.archived \
                        and st.exists(base.path):
                    vt = base
            if not vt:
                raise ProviderError("Nothing to extend yet — generate a video for this shot first")
            extend_from = st.abs(vt.path)
            extend_uri = vt.remote_ref or ""
            extend_src = vt
            prompt = (p.get("prompt") or shot.action) + "\n" + prompt
        elif shot.continuity_from_shot_id and shot.continuity_mode == "extend" and mode in ("auto", "extend") and not native:
            # Film Map link: this shot IS the continuation of the linked shot's clip
            src = db.get(Shot, shot.continuity_from_shot_id)
            lv = current(db, src.id, "video") if src else None
            if lv and st.exists(lv.path):
                extend, extend_from, extend_uri, link_parent = True, st.abs(lv.path), lv.remote_ref or "", lv.id
                audio_driven, chain = False, "extend"
                prompt = (shot.action or "the action continues") + "\n" + prompt
        # What the video must follow: the shot's keyframe (yours or generated) and its characters. Text-only video is
        # used only when there is nothing to follow, so a clip never quietly ignores the keyframe or the cast.
        guided = bool(kf_path or shot.characters or refs)
        # start + end frame: the clip runs from the keyframe to the end frame (an engine without first + last frame
        # starts from the keyframe only)
        ends = want_end and mode in ("auto", "keyframe_to_video", "interpolate")
        if extend:
            modes_ok = ["extend"]
        elif audio_driven:
            modes_ok = ["a2v"]
        elif mode == "text_to_video" and not guided:
            modes_ok = ["t2v"]
        elif ends:
            modes_ok = ["flf", "i2v", "ref2v"] if refs else ["flf", "i2v"]
        elif mode == "interpolate" and last_frame:
            modes_ok = ["flf", "i2v"]
        elif mode == "reference_to_video" and refs and not kf_path:
            modes_ok = ["ref2v", "i2v"]
        elif guided:
            modes_ok = ["i2v", "ref2v"] if refs else ["i2v"]  # keyframe first: the frame you approved is the first frame
        else:
            modes_ok = ["i2v", "t2v"]
        aspect = project.aspect if project.aspect in ("16:9", "9:16") else "9:16"
        duration = shot.duration_s
        src_info = _veo_source(extend_src) if extend_src is not None else None
        db.commit()

    state: dict[str, Any] = {"kf": kf_path, "audio": None, "end": end_path, "end_take": end.id if end else None,
                             "ref_labels": [], "resolution": qm["resolution"]}

    def ensure_kf() -> Path | None:
        if state["kf"] is None:
            ctx.progress(0.05, "No keyframe yet — generating one first")
            keyframe(ctx)
            with SessionLocal() as db2:
                k = current(db2, ctx.shot_id, "keyframe")
                state["kf"] = st.abs(k.path) if k else None
        return state["kf"]

    def ensure_end() -> Path | None:
        if state["end"] is None and ends:
            ctx.progress(0.06, "Making the end frame first")
            from .handlers_frames import make_endframe
            make_endframe(ctx, ctx.shot_id)
            with SessionLocal() as db2:
                e = frames.end_take(db2, db2.get(Shot, ctx.shot_id))
                state["end"], state["end_take"] = (st.abs(e.path), e.id) if e else (None, None)
        return state["end"]

    def ensure_voice() -> Path | None:
        if state["audio"] is None:
            with SessionLocal() as db2:
                vt2 = current(db2, ctx.shot_id, "voice", lang)
            if not vt2:
                _make_voice(ctx, lang)
                with SessionLocal() as db2:
                    vt2 = current(db2, ctx.shot_id, "voice", lang)
            state["audio"] = st.abs(vt2.path) if vt2 else None
        return state["audio"]

    def build(m: AIModel, mode_: str) -> GenRequest:
        veo = m.provider == "google"
        if mode_ == "extend" and veo and src_info is not None:
            why = veo_cant_extend(src_info)
            if why:  # (another engine of the extend chain may still take it; else the job fails with these words)
                raise ProviderError(why, provider="gemini")
        first = ensure_kf() if mode_ in ("i2v", "flf", "a2v") else None
        if ends and mode_ in ("flf", "i2v"):
            ensure_end()  # (also before a start-frame-only clip: the shot after it starts on this end frame)
        last = (state["end"] or last_frame) if mode_ == "flf" else None
        audio = ensure_voice() if mode_ == "a2v" else None
        own_refs = _refs_for(m, ctx.shot_id) if mode_ == "ref2v" else []
        state["ref_labels"] = [l for l, _ in own_refs]
        res_ = "480p" if draft else "720p" if extend or (veo and base_720) else qm["resolution"]
        state["resolution"] = res_
        return GenRequest(mode=mode_, prompt=prompt, negative=negative, first_frame=first,
                          last_frame=last, refs=[x for _, x in own_refs],
                          audio=audio, video=extend_from, video_uri=extend_uri, duration=duration, aspect=aspect,
                          resolution=res_, generate_audio=not audio_driven,
                          loras=loras if mode_ in ("i2v", "t2v", "ref2v", "flf") else [], cast_refs=vr)

    def make() -> tuple:
        nonlocal audio_driven
        try:
            return run_chain(ctx, chain, modes_ok, build, explicit=explicit, skip=p.get("skip_engines"))
        except ProviderNotConfigured:
            if not audio_driven:
                raise
            audio_driven = False  # no audio-driven engine available → regular video, voice + lip-sync later
            return run_chain(ctx, f"video.{q}", ["i2v", "t2v"], build, skip=p.get("skip_engines"))

    toned: list[str] = []
    try:
        m, used, res, attempts = make()
    except ProviderBlocked as e:
        # once more with the weapons, blood and violence words toned down (the meaning kept), before giving up
        softer, toned = recovery.soften(prompt)
        if not toned or p.get("toned_down"):
            raise recovery.blocked(e) from e
        ctx.progress(0.1, f"Blocked by a safety filter: once more without {', '.join(toned[:4])}")
        prompt = softer
        try:
            m, used, res, attempts = make()
        except ProviderBlocked as e2:
            raise recovery.blocked(e2, toned) from e2
    if extend and m.provider == "google" and extend_src is not None:
        _touch_remote(extend_src.id)  # Veo keeps a clip 2 days from its last use: extending it starts that again
    with SessionLocal() as db:
        shot = db.get(Shot, ctx.shot_id)
        prev = current(db, shot.id, "video")
        params = {"quality": q, "resolution": state["resolution"], "mode": used,
                  "refs": state["ref_labels"] if used == "ref2v" else [], "toned_down": toned or None,
                  "engine": m.id, "engine_label": m.display_name, "attempts": attempts,
                  "retake_count": p.get("retake_count", 0), "audio_driven": used == "a2v",
                  "language": lang if (used == "a2v" or vm == "native") else None,
                  "native_language": lang if vm == "native" and bool(shot_lines(shot, lang)) else None,
                  "loras": bool(loras), "shootout": bool(p.get("shootout")), "draft": draft,
                  "recovered_from": p.get("skip_engines") if p.get("recovery") else None,
                  # the end frame the clip ran to (core/scene_chain.follows: a keyframe made from it follows this clip)
                  "end_take_id": state["end_take"] if used == "flf" and state["end"] else None}
        # a dubbing clip (another language spoken by Veo) is a lip-synced take of that language, not the main video
        as_kind = "lipsync" if (native and lang != project.primary_language) else "video"
        # a draft never pushes aside a finished (non-draft) clip: it stays one click away in the takes
        keep_final = draft and prev is not None and not (prev.params or {}).get("draft")
        t = save_take(db, ctx, shot, as_kind, res.data, "mp4", language=lang if as_kind == "lipsync" else None,
                      provider=m.provider, model=m.endpoint, params={**params, "method": "native"} if as_kind == "lipsync" else params,
                      prompt=prompt, duration=res.duration_s if not extend else 0.0, cost=res.usage.usd,
                      remote_ref=res.remote_ref,
                      parent=extend_src.id if extend_src is not None else (link_parent or (prev.id if extend and prev else None)),
                      auto_select=not p.get("shootout") and not keep_final)
        lip_t = None
        if used == "a2v" and as_kind == "video":  # the clip already speaks the line: it is also this language's lip-synced take
            lip_t = save_take(db, ctx, shot, "lipsync", None, "mp4", src_file=st.abs(t.path), language=lang,
                              provider=m.provider, model=m.endpoint,
                              params={**params, "video_take_id": t.id, "method": "audio_driven"}, cost=0.0, parent=t.id,
                              auto_select=not p.get("shootout"))
        if as_kind == "lipsync":
            lip_t = t
        if shot.status != "approved":
            shot.status = "video_ready"
        ctx.cost(res.usage, db)
        db.commit()
        emit(db, ctx.project_id, "take.created", {"shot_id": shot.id, "take_id": t.id, "kind": "video", "engine": m.display_name})
        has_chars = bool(shot.characters)
        code = shot.code
    ctx.save_result(ops={})
    if (has_chars or lip_t or vm == "native") and not draft:  # a draft is a preview: no QC, no automatic retakes
        # an extension's retake is an extension of the same clip again (with its prompt), never a new base clip
        again = ({"extend": True, "prompt": p.get("prompt") or "", "extend_from_take": extend_src.id}
                 if p.get("extend") and extend_src is not None else {})
        ctx.enqueue_child("qc", {"take_id": (lip_t or t).id, "retake_count": p.get("retake_count", 0), "quality": q,
                                 "language": lang, "native": native,
                                 "engine": m.id, "tried": [*(p.get("skip_engines") or []), m.id],
                                 "shootout": bool(p.get("shootout")), **again},
                          label=f"QC {code}")
    return {"take_id": t.id, "engine": m.id, "mode": used}


# ── QC: face match + vision check + lip-sync check, with automatic retakes ────

def _char_embedding(db, ch: Character) -> list[float] | None:
    if ch.face_embedding:
        return ch.face_embedding
    if not faces.identity_available():
        return None
    st = get_storage()
    for a in character_refs(db, ch, None, 3):
        if a.kind in ("front", "source", "three_quarter") and st.exists(a.path):
            emb = faces.embedding(st.abs(a.path))
            if emb:
                ch.face_embedding = emb
                db.commit()
                return emb
    return None


@handler("qc")
def qc(ctx: JobContext) -> dict:
    st = get_storage()
    tmp = st.tmp_dir()
    take_id = ctx.payload["take_id"]
    with SessionLocal() as db:
        take = db.get(Take, take_id)
        shot = db.get(Shot, take.shot_id)
        project = _project_of(db, shot)
        ref_imgs: list[bytes] = []
        dna: list[str] = []
        embs: list[list[float]] = []
        ep_row = db.get(Episode, shot.episode_id)
        ep_no = ep_row.number if ep_row else None
        locks: list[dict] = []
        outfit_expected = False
        for cid in (shot.characters or [])[:3]:
            ch = db.get(Character, int(cid))
            if not ch:
                continue
            look = look_of(db, ch, ep_no)
            locks.append(look["lock"])
            outfit_expected = outfit_expected or bool(outfit_for(db, shot, ch))
            dna.append(look["dna"] + lock_core.prompt_text(ch, look["lock"]))
            e = _char_embedding(db, ch)
            if e:
                embs.append(e)
            for a in character_refs(db, ch, (shot.outfits or {}).get(str(ch.id)), 1):
                if st.exists(a.path):
                    ref_imgs.append(st.abs(a.path).read_bytes())
        settings = settings_store.all_settings(db)
        video_path = st.abs(take.path)
        action, code, has_chars = shot.action, shot.code, bool(shot.characters)
        tp = take.params or {}
        is_lip = take.kind == "lipsync" or bool(tp.get("audio_driven"))
        native_take = bool(tp.get("native_language")) or tp.get("method") == "native"
        # a lip-sync pass (or voice lock) over a finished clip: only the lips can be retaken, never the clip under them
        lip_only = bool(ctx.payload.get("lip_only")) or take.kind == "voicelock" or tp.get("method") == "redub"
        # the words come from a studio voice (TTS), exactly as written: no transcription check (it misreads Indian
        # languages); the spoken-words check is for clips where Veo speaks the line itself
        tts_voice = lip_only or bool(tp.get("audio_driven")) or tp.get("method") == "audio_driven"
        language = take.language or tp.get("language") or project.primary_language
        lines = " / ".join(l.get("line", "") for l in shot_lines(shot, language))
        lang_name = catalog.LANGUAGES.get(language, {}).get("name", language)
        n_words = sum(len((l.get("line") or "").split()) for l in shot_lines(shot, language))
        clip_s = int(round(take.duration_s or shot.duration_s or 8))
        fits = MAX_WORDS_PER_CLIP.get(clip_s, MAX_WORDS_PER_CLIP[8])
        too_long = native_take and n_words > fits
        strict = max((float(L.get("strictness", 0.5)) for L in locks), default=0.5)
        outfit_required = outfit_expected and any(lock_core.requires_outfit(L) for L in locks) and bool(settings.get("outfit_qc", True))
        db.commit()
    frames = ff.extract_frames(video_path, tmp, 4)
    report: dict[str, Any] = {"checked_at": utcnow().isoformat() + "Z"}
    usages = []
    # 1) objective face match (OpenCV SFace) when the models are installed
    face = faces.best_match_in_frames(frames, embs) if has_chars and embs else {"available": False}
    report["face"] = face
    # 2) vision QC (identity, extra people, text artifacts, hands, action)
    prompt = (f"The first {len(ref_imgs)} image(s) are the character reference sheet(s); the next {len(frames)} are frames "
              f"from the generated clip.\nCharacters: {' | '.join(dna) or 'none'}\nIntended action: {action}")
    obj, usage = ctx.services.llm_json("qc", prompts.QC, prompt, S.QCOut, images=ref_imgs + [f.read_bytes() for f in frames],
                                       mock_ctx={"take_id": take_id})
    usages.append(usage)
    report.update(obj.model_dump())
    # 3) lip-sync check (Gemini watches the clip with its audio). Claude can't hear: with Claude reviewing clips (listening
    # checks on Gemini turned off), this check and the spoken-words check are skipped and the report says so
    listen = ctx.services.can_listen()
    if not listen and (is_lip or (native_take and lines)):
        report["not_heard"] = True
        report["notes"] = (f"{report.get('notes') or ''} Lip-sync and spoken words not checked: Claude reviews clips and "
                           "can't hear audio.").strip()
    lip = None
    if listen and is_lip and settings.get("lipsync_qc", True) and video_path.stat().st_size < 18_000_000:
        lp = (f"Language: {catalog.LANGUAGES.get(language, {}).get('name', language)}. Spoken line(s): {lines}\n"
              "Watch the mouth and listen. Score how well lip shapes and timing match the speech.")
        lip, u2 = ctx.services.llm_json("lipsync_qc", "You are a strict lip-sync reviewer for dubbed video.", lp,
                                        S.LipsyncQCOut, videos=[video_path.read_bytes()], mock_ctx={"take_id": take_id})
        usages.append(u2)
        report["lipsync"] = lip.model_dump()
    # 4) spoken words: did the clip say the scripted line, in the right language? (native Veo speech or a dub)
    words = None
    words_on = settings.get("dialogue_words_qc", True) and video_path.stat().st_size < 18_000_000
    if listen and native_take and not tts_voice and lines and words_on:
        wp = (f"Expected language: {lang_name}. Expected line(s): {lines}\nListen to the clip. Transcribe exactly what is "
              "spoken, name the language actually spoken, score word accuracy, pronunciation and lip-sync, and say whether "
              "any text is burned into the picture.")
        words, u3 = ctx.services.llm_json("dialogue_check", "You are a strict native-speaker reviewer of AI-generated dialogue.",
                                          wp, S.DialogueCheckOut, videos=[video_path.read_bytes()],
                                          mock_ctx={"line": lines, "language_name": lang_name})
        usages.append(u3)
        report["words"] = words.model_dump()
    thr = lock_core.qc_threshold({"strictness": strict}, float(settings.get("qc_threshold") or 0.7))
    fthr = lock_core.face_threshold({"strictness": strict}, float(settings.get("face_match_threshold") or 0.36))
    lthr = float(settings.get("lipsync_qc_threshold") or 0.6)
    wthr = float(settings.get("dialogue_words_threshold") or 0.75)
    if face.get("available") and face.get("similarity") is not None:
        identity_ok = face["similarity"] >= fthr
    else:
        identity_ok = obj.identity_match >= thr or not has_chars
    lip_ok = lip is None or (lip.sync_score >= lthr and not lip.artifacts)
    words_ok = words is None or (words.word_match >= wthr and not words.subtitles_burned)
    outfit_ok = (not outfit_required) or bool(obj.outfit_match)
    passed = identity_ok and lip_ok and words_ok and outfit_ok and not obj.extra_people and not obj.text_artifacts
    report.update({"passed": passed, "identity_ok": identity_ok, "lipsync_ok": lip_ok, "words_ok": words_ok,
                   "outfit_ok": outfit_ok, "threshold": thr, "face_threshold": fthr, "lipsync_threshold": lthr,
                   "words_threshold": wthr, "strictness": strict})
    if too_long and not words_ok:  # making the clip again won't fit the line in it: the run lists it instead
        report["problem"] = {"step": "QC", "reason": f"The line has {n_words} words; about {fits} fit a {clip_s} s clip, "
                                                     "so Veo rushes or drops some of it",
                             "next": "Split the shot or shorten the line, then remake the video"}
    with SessionLocal() as db:
        take = db.get(Take, take_id)
        take.qc = report
        for u in usages:
            ctx.cost(u, db)
        db.commit()
        emit(db, ctx.project_id, "take.updated", {"take_id": take_id, "shot_id": take.shot_id, "qc": {"passed": passed}})
    shutil.rmtree(tmp, ignore_errors=True)
    retakes = int(ctx.payload.get("retake_count", 0))
    if (passed or ctx.payload.get("shootout") or not settings.get("auto_retake")
            or retakes >= int(settings.get("max_auto_retakes") or 2)):
        return {"passed": passed}
    look_bad = not identity_ok or bool(obj.extra_people) or bool(obj.text_artifacts) or not outfit_ok
    if lip_only:  # a lip-sync take is only ever re-lip-synced (one retake count for the whole lip-sync)
        redo = "lipsync" if not lip_ok else None
        why = "" if redo else "the clip under the lip-sync doesn't pass: remake the video"
    else:  # (a line too long for its clip is no reason to make the clip again: it is listed as a problem)
        redo_video = look_bad or tp.get("audio_driven") or (native_take and not words_ok and not too_long)
        redo = "video" if redo_video else "lipsync" if not lip_ok else None
        why = "" if redo else (report.get("problem") or {}).get("reason", "")
    if redo is None:
        return {"passed": False, "retake": None, "reason": why}
    tried = list(ctx.payload.get("tried") or [])
    again = bool(ctx.payload.get("extend")) and redo == "video"
    with SessionLocal() as db:
        shot = db.get(Shot, take.shot_id)
        project = _project_of(db, shot)
        user = _user(db, ctx)
        est = budget.Estimator(db)
        if again:  # an extension is retaken as an extension of the clip it was made from, with its own prompt
            cost = generation.extend_spec(db, project, shot, ctx.payload.get("prompt") or "")["estimate"]
            kind, payload = "video", {"quality": ctx.payload.get("quality"), "extend": True,
                                      "prompt": ctx.payload.get("prompt") or "",
                                      "extend_from_take": ctx.payload.get("extend_from_take"), "retake_count": retakes + 1,
                                      "skip_engines": tried if retakes >= 1 else []}
        elif redo == "video":
            cost = est.video(shot, project, ctx.payload.get("quality"))
            kind, payload = "video", {"quality": ctx.payload.get("quality"), "retake_count": retakes + 1,
                                      "skip_engines": tried if retakes >= 1 else [],
                                      "language": ctx.payload.get("language"), "native": bool(ctx.payload.get("native"))}
        else:  # only the lips are off → re-dub with the next lip-sync engine
            cost = est.lipsync(shot)
            kind, payload = "lipsync", {"language": language, "retake_count": retakes + 1, "skip_engines": tried}
        chk = budget.check(db, user, project, cost) if user else {"ok": False, "reason": "no requester"}
    if chk.get("ok"):
        what = "lips" if kind == "lipsync" else "extension" if again else "look"
        ctx.enqueue_child(kind, payload, shot_id=take.shot_id, estimate=cost, label=f"Auto-retake {code} ({what})")
        return {"passed": False, "retake": kind}
    return {"passed": False, "retake": None, "reason": chk.get("reason", "")}


# ── voice / lip-sync / voice lock ─────────────────────────────────────────────

def _make_voice(ctx: JobContext, lang: str) -> dict:
    st = get_storage()
    tmp = st.tmp_dir()
    out: dict[str, Any] = {}
    with SessionLocal() as db:
        shot = db.get(Shot, ctx.shot_id)
        project = _project_of(db, shot)
        d = build_dialogue(ctx, db, shot, project, lang, tmp)
        n = build_narration(ctx, db, shot, project, lang, tmp)
        if d:
            t = save_take(db, ctx, shot, "voice", None, "wav", src_file=d["path"], language=lang, provider=d["provider"],
                          params={"spans": d["spans"]}, duration=d["duration"])
            out["voice_take_id"] = t.id
            if (lang == project.primary_language and effective_voice_mode(shot, project, lang) in ("audio_first", "audio_driven")
                    and not current(db, shot.id, "video")):
                shot.duration_s = choose_duration(d["duration"])
        if n:
            t2 = save_take(db, ctx, shot, "narration", None, "wav", src_file=n["path"], language=lang, provider=n["provider"],
                           params={"spans": n["spans"]}, duration=n["duration"])
            out["narration_take_id"] = t2.id
        db.commit()
        emit(db, ctx.project_id, "take.created", {"shot_id": shot.id, "kind": "voice", "language": lang})
    shutil.rmtree(tmp, ignore_errors=True)
    return out


@handler("voice")
def voice(ctx: JobContext) -> dict:
    ctx.progress(0.1, "Speaking lines")
    return _make_voice(ctx, ctx.payload.get("language", "en")) or {"skipped": "no lines or narration"}


@handler("lipsync")
def lipsync(ctx: JobContext) -> dict:
    st = get_storage()
    p = ctx.payload
    lang = p.get("language", "en")
    model = p.get("model") or ""
    explicit = p.get("engine") or (model if ":" in model else LEGACY_LIPSYNC.get(model))
    with SessionLocal() as db:
        shot = db.get(Shot, ctx.shot_id)
        vt = current(db, shot.id, "video")
        if not vt:
            raise ProviderError(f"{shot.code} has no video yet")
        has_voice = current(db, shot.id, "voice", lang) is not None
        regenerate = bool((vt.params or {}).get("audio_driven")) and settings_store.get_setting(db, "dub_method") == "regenerate"
        kf = current(db, shot.id, "keyframe")
        kf_path = st.abs(kf.path) if kf else None
        aspect = _project_of(db, shot).aspect
        prompt = shot.action
        db.commit()
    if not has_voice:
        _make_voice(ctx, lang)
    tmp = st.tmp_dir()
    with SessionLocal() as db:
        shot = db.get(Shot, ctx.shot_id)
        vt = current(db, shot.id, "video")
        voice_t = current(db, shot.id, "voice", lang)
        if not voice_t:
            raise ProviderError(f"{shot.code} has no {lang} dialogue to lip-sync")
        video_path = st.abs(vt.path)
        vdur, adur = ff.duration(video_path), ff.duration(st.abs(voice_t.path))
        held = 0.0
        if adur > vdur - 0.1:  # never cut the speech: the clip holds its last frame until the voice ends
            held = adur + 0.25 - vdur
            longer = tmp / "held.mp4"
            ff.run(["-i", video_path, "-vf", f"tpad=stop_mode=clone:stop_duration={held:.3f}", "-an",
                    *ff.h264_args(18), longer])
            video_path, vdur = longer, ff.duration(longer)
        audio = tmp / "voice_padded.wav"
        ff.run(["-i", st.abs(voice_t.path), "-af", f"apad,atrim=0:{vdur:.3f}", "-ar", "48000", "-ac", "1", audio])
        speaker = _speaker(db, shot, lang, video_path, tmp)
        ids = (vt.id, voice_t.id)
        code = shot.code
        db.commit()
    if regenerate and kf_path:  # audio-driven shot: generate a fresh talking clip from this language's audio
        m, used, res, attempts = run_chain(ctx, "dialogue", ["a2v"], lambda m, mode: GenRequest(
            mode="a2v", prompt=prompt, first_frame=kf_path, audio=st.abs(voice_t.path), aspect=aspect), explicit=explicit,
            skip=p.get("skip_engines"))
        method = "audio_driven"
    else:
        m, used, res, attempts = run_chain(ctx, "lipsync", ["lipsync"], lambda m, mode: GenRequest(
            mode="lipsync", video=video_path, audio=audio, aspect=aspect, speaker=speaker), explicit=explicit,
            skip=p.get("skip_engines"), expected_s=60)
        method = "redub"
    with SessionLocal() as db:
        shot = db.get(Shot, ctx.shot_id)
        t = save_take(db, ctx, shot, "lipsync", res.data, "mp4", language=lang, provider=m.provider, model=m.endpoint,
                      params={"video_take_id": ids[0], "voice_take_id": ids[1], "held_s": round(held, 2),
                              "warning": f"the clip holds its last frame {held:.1f}s so the line can finish" if held > 0.3
                              else "", "speaker": speaker, "engine": m.id,
                              "engine_label": m.display_name, "method": method, "attempts": attempts},
                      cost=res.usage.usd, parent=ids[0])
        ctx.cost(res.usage, db)
        db.commit()
        emit(db, ctx.project_id, "take.created", {"shot_id": shot.id, "take_id": t.id, "kind": "lipsync", "language": lang})
        lip_qc = settings_store.get_setting(db, "lipsync_qc")
    shutil.rmtree(tmp, ignore_errors=True)
    if lip_qc:  # (lip_only: its retakes are lip-syncs, on the same retake count; the clip under it is left alone)
        ctx.enqueue_child("qc", {"take_id": t.id, "retake_count": p.get("retake_count", 0), "lip_only": True,
                                 "tried": [*(p.get("skip_engines") or []), m.id]}, label=f"Lip-sync QC {code}")
    return {"take_id": t.id, "engine": m.id, "held_s": round(held, 2)}


def _speaker(db, shot: Shot, lang: str, video: Path, tmp: Path) -> dict | None:
    """Who the lip-sync should move when more than one person is on screen: a point on the speaker's face in the clip's
    first frame ({frame, x, y}, found with their face reference), else {"auto": True} (sync.so's own active speaker
    detection). None with one person on screen. Engines with no such option ignore it (generation.speaker_warnings)."""
    if len(shot.characters or []) < 2:
        return None
    speakers = list(dict.fromkeys(str(l.get("character_id")) for l in shot_lines(shot, lang)))
    ch = db.get(Character, int(speakers[0])) if len(speakers) == 1 and speakers[0].isdigit() else None
    emb = _char_embedding(db, ch) if ch is not None else None
    if not emb or not faces.identity_available():
        return {"auto": True}
    try:
        first = tmp / "first.png"
        ff.run(["-i", video, "-frames:v", "1", first])
        img = faces._read(first)
        rec = faces._recognizer()
        best, point = -1.0, None
        for f in faces.detect(img)[:6]:
            if f["raw"] is None:
                continue
            sim = faces.similarity([float(v) for v in rec.feature(rec.alignCrop(img, f["raw"])).flatten()], emb)
            if sim > best:
                x, y, w, h = f["box"]
                best, point = sim, {"frame": 0, "x": int(x + w / 2), "y": int(y + h / 2), "who": ch.name}
        return point if point is not None and best >= 0.3 else {"auto": True}
    except Exception as e:  # finding the face is a nicety: the engine's own detection still runs
        print(f"[lipsync] speaker not found: {e}")
        return {"auto": True}


def _separate(ctx: JobContext, wav: Path, tmp: Path) -> tuple[Path, Path | None, str]:
    """→ (vocals, background or None, method). Demucs (CPU) if installed, else ElevenLabs audio isolation."""
    if importlib.util.find_spec("demucs") is not None:
        try:
            subprocess.run([sys.executable, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "-o", str(tmp), str(wav)],
                           check=True, capture_output=True, timeout=900)
            base = tmp / "htdemucs" / wav.stem
            return base / "vocals.wav", base / "no_vocals.wav", "demucs"
        except Exception as e:
            print(f"[voicelock] demucs failed, falling back: {e}")
    res = ctx.services.isolate_voice(wav)
    ctx.cost(res.usage)
    vocals = tmp / f"vocals.{res.ext}"
    vocals.write_bytes(res.data)
    return vocals, None, "elevenlabs-isolation"


@handler("voicelock")
def voicelock(ctx: JobContext) -> dict:
    st = get_storage()
    tmp = st.tmp_dir()
    with SessionLocal() as db:
        shot = db.get(Shot, ctx.shot_id)
        project = _project_of(db, shot)
        ok, why = generation.voicelock_eligible(db, project, shot)
        if not ok:
            raise ProviderError(f"Voice lock not possible for {shot.code}: {why}")
        lang = project.primary_language
        speaker = int(shot_lines(shot, lang)[0]["character_id"])
        vp = db.query(VoiceProfile).filter(VoiceProfile.character_id == speaker).filter(
            (VoiceProfile.provider == "elevenlabs") | (VoiceProfile.sts_voice_id != "")).first()
        target = (vp.sts_voice_id or vp.voice_id) if vp else ""
        if not target:
            ch = db.get(Character, speaker)
            raise ProviderError(f"Voice lock needs an ElevenLabs voice for {ch.name if ch else 'the speaker'} — "
                                f"design one in Bible → Voices (provider: ElevenLabs)")
        vt = current(db, shot.id, "video")
        video_path = st.abs(vt.path)
        vt_id = vt.id
        db.commit()
    wav = ff.extract_audio(video_path, tmp / "orig.wav")
    ctx.progress(0.2, "Separating voice from background")
    vocals, background, method = _separate(ctx, wav, tmp)
    ctx.progress(0.5, "Converting to the locked voice")
    conv = ctx.services.voice_change(ff.to_wav(vocals, tmp / "vocals_in.wav", 44100), target)
    conv_path = tmp / f"converted.{conv.ext}"
    conv_path.write_bytes(conv.data)
    mixed = tmp / "mixed.wav"
    if background and background.exists():
        ff.run(["-i", conv_path, "-i", background, "-filter_complex",
                "[0:a]aresample=48000[a];[1:a]aresample=48000[b];[a][b]amix=inputs=2:normalize=0:duration=longest[o]",
                "-map", "[o]", mixed])
    else:
        ff.to_wav(conv_path, mixed)
    out = ff.mux_audio(video_path, mixed, tmp / "voicelock.mp4")
    with SessionLocal() as db:
        shot = db.get(Shot, ctx.shot_id)
        t = save_take(db, ctx, shot, "voicelock", None, "mp4", src_file=out, language=lang, provider="elevenlabs",
                      model=conv.usage.model, params={"separation": method, "video_take_id": vt_id, "voice": target},
                      cost=conv.usage.usd, parent=vt_id)
        ctx.cost(conv.usage, db)
        db.commit()
        emit(db, ctx.project_id, "take.created", {"shot_id": shot.id, "take_id": t.id, "kind": "voicelock"})
    shutil.rmtree(tmp, ignore_errors=True)
    return {"take_id": t.id, "separation": method}


# ── music ────────────────────────────────────────────────────────────────────

def score_notes(db, episode: Episode) -> str:
    """The scenes in order as "1) tense · low tabla" for the score: each scene's mood and music notes, and the music
    cues of its shots ("" when the script says nothing about either)."""
    from ..models import Scene
    out = []
    shots = generation.episode_shots(db, episode)
    for i, sc in enumerate(db.query(Scene).filter(Scene.episode_id == episode.id).order_by(Scene.order, Scene.id).all(), 1):
        cues = list(dict.fromkeys(s.music_cue.strip() for s in shots if s.scene_id == sc.id and (s.music_cue or "").strip()))
        bits = [x.strip() for x in (sc.emotion, sc.music, *cues) if x and x.strip()]
        if bits:
            out.append(f"{i}) {sc.title or f'Scene {i}'}: " + " · ".join(bits))
    return "; ".join(out)[:2000]


def _music_mode(db, episode_id: int, mode: str) -> None:
    """What the export lays under the cut: "score" (one track) or "scenes" (each scene's own piece, crossfaded)."""
    ep = db.get(Episode, episode_id)
    ep.settings = {**(ep.settings or {}), "music_mode": mode}


@handler("music")
def music(ctx: JobContext) -> dict:
    if ctx.payload.get("per_scene"):
        return _music_per_scene(ctx)
    with SessionLocal() as db:
        episode = db.get(Episode, ctx.episode_id)
        project = db.get(Project, episode.project_id)
        total = sum(s.duration_s for s in generation.episode_shots(db, episode)) or 30
        prompt = ctx.payload.get("prompt") or ""
        if not prompt:
            style = db.get(Style, project.style_id) if project.style_id else None
            arc = score_notes(db, episode)
            p = (f"Write a music prompt for the background score of this {project.type}. Tone: {(project.brief or {}).get('tone', '')}. "
                 f"Style: {style.look if style else ''}. Concept: {project.concept}. About {total} seconds. "
                 + (f"The score follows the scenes in order (mood · music the script asks for): {arc}. Keep one theme "
                    "and instrumentation throughout so the scenes feel like one film; let it shift with each scene's mood. "
                    "Where the script names music, use it. " if arc else "")
                 + "Instrumental only, no vocals. Mention instruments, tempo and mood. Indian instruments where they fit.")
            out, usage = ctx.services.llm_json("music_prompt", prompts.WRITER, p, S.MusicPromptOut, mock_ctx={})
            ctx.cost(usage, db)
            prompt = out.prompt
        db.commit()
    if "instrumental" not in prompt.lower():
        prompt += " Instrumental only, no vocals."
    ctx.progress(0.2, "Composing music")
    res = ctx.services.music(prompt, total)
    st = get_storage()
    with SessionLocal() as db:
        rel = st.save_bytes(st.new_path(f"projects/{ctx.project_id}/music", res.ext), res.data)
        for a in db.query(AudioAsset).filter(AudioAsset.episode_id == ctx.episode_id, AudioAsset.kind == "music").all():
            a.selected = False
        a = AudioAsset(project_id=ctx.project_id, episode_id=ctx.episode_id, kind="music", provider="gemini",
                       model=res.usage.model, prompt=prompt, path=rel, duration_s=res.duration_s, cost_usd=res.usage.usd,
                       selected=True)
        db.add(a)
        ctx.cost(res.usage, db)
        _music_mode(db, ctx.episode_id, "score")
        db.commit()
        emit(db, ctx.project_id, "audio.created", {"episode_id": ctx.episode_id, "audio_id": a.id})
    return {"audio_id": a.id}


def _music_per_scene(ctx: JobContext) -> dict:
    """One piece per scene that follows its mood, all on one theme (instruments, key, tempo feel) so the film still
    sounds like one score: one writing call for the theme and every scene's prompt, then a track per scene as long as
    its shots. The export lays them on the cut with crossfades (assembler.scene_music). Scenes that already have a
    piece keep their theme for the new ones; only_missing makes only the scenes with none."""
    from ..models import Scene
    p = ctx.payload
    st = get_storage()
    with SessionLocal() as db:
        episode = db.get(Episode, ctx.episode_id)
        project = db.get(Project, episode.project_id)
        scenes = generation.music_scenes(db, episode)
        if p.get("scene_ids") is not None:
            scenes = [(sc, secs) for sc, secs in scenes if sc.id in set(p["scene_ids"])]
        if p.get("only_missing"):
            have = generation.scene_cue_ids(db, episode)
            scenes = [(sc, secs) for sc, secs in scenes if sc.id not in have]
        if not scenes:
            return {"cues": 0}
        prior = (db.query(AudioAsset).filter(AudioAsset.episode_id == episode.id, AudioAsset.kind == "music_scene")
                 .order_by(AudioAsset.selected.desc(), AudioAsset.id.desc()).first())
        theme = str(((prior.params or {}).get("theme") if prior else "") or "")
        shots = generation.episode_shots(db, episode)
        style = db.get(Style, project.style_id) if project.style_id else None

        def row(i: int, sc: Scene, secs: float) -> str:
            cues = list(dict.fromkeys(s.music_cue.strip() for s in shots if s.scene_id == sc.id and (s.music_cue or "").strip()))
            notes = [f"mood: {sc.emotion}" if sc.emotion else "", f"music: {sc.music}" if sc.music else "",
                     f"shot cues: {'; '.join(cues)}" if cues else "", f"what happens: {sc.summary[:200]}" if sc.summary else ""]
            return f"{i}. {sc.title or f'Scene {i}'} ({round(secs)} s)" + "".join(f"; {n}" for n in notes if n)
        listing = "\n".join(row(i, sc, secs) for i, (sc, secs) in enumerate(scenes, 1))
        text = (f"Write the background music of this {project.type}, one piece per scene, all on one shared theme so the "
                f"film sounds like one score that shifts with each scene's mood. Tone: {(project.brief or {}).get('tone', '')}. "
                f"Style: {style.look if style else ''}. Concept: {project.concept}.\n"
                + (f"Keep this theme (the other scenes already use it): {theme}\n" if theme else "")
                + f"SCENES (number. title (length); mood; music the script asks for; shot cues):\n{listing}\n"
                "Return the theme (instruments, key, tempo feel, in one or two sentences) and, for every scene number, a "
                "music prompt that follows its mood and the music the script names, on that theme. Instrumental only, no "
                "vocals. Indian instruments where they fit.")
        out, usage = ctx.services.llm_json("scene_music", prompts.WRITER, text, S.SceneMusicOut,
                                           mock_ctx={"scenes": list(range(1, len(scenes) + 1))})
        ctx.cost(usage, db)
        theme = theme or out.theme.strip()
        prompts_by = {c.scene: c.prompt.strip() for c in out.scenes}
        todo = [(sc.id, sc.title or f"Scene {i}", secs, prompts_by.get(i) or " · ".join(x for x in (sc.emotion, sc.music) if x))
                for i, (sc, secs) in enumerate(scenes, 1)]
        db.commit()
    made: list[int] = []
    for i, (sid, title, secs, prompt) in enumerate(todo):
        ctx.check_cancel()
        ctx.progress(0.1 + 0.9 * i / len(todo), f"Composing music: {title}")
        full = ". ".join(x for x in (theme, prompt) if x)
        if "instrumental" not in full.lower():
            full += " Instrumental only, no vocals."
        res = ctx.services.music(full, secs)
        with SessionLocal() as db:
            rel = st.save_bytes(st.new_path(f"projects/{ctx.project_id}/music", res.ext), res.data)
            for a in db.query(AudioAsset).filter(AudioAsset.episode_id == ctx.episode_id, AudioAsset.kind == "music_scene").all():
                if (a.params or {}).get("scene_id") == sid:
                    a.selected = False
            a = AudioAsset(project_id=ctx.project_id, episode_id=ctx.episode_id, kind="music_scene", provider="gemini",
                           model=res.usage.model, prompt=full, path=rel, duration_s=res.duration_s, cost_usd=res.usage.usd,
                           selected=True, params={"scene_id": sid, "theme": theme, "seconds": round(secs, 2)})
            db.add(a)
            ctx.cost(res.usage, db)
            db.commit()
            made.append(a.id)
    with SessionLocal() as db:  # the export switches to the scenes' pieces once every one asked for is made
        _music_mode(db, ctx.episode_id, "scenes")
        db.commit()
        emit(db, ctx.project_id, "audio.created", {"episode_id": ctx.episode_id, "audio_ids": made})
    return {"cues": len(made), "audio_ids": made, "theme": theme}


# ── bible media ──────────────────────────────────────────────────────────────

SHEET_VIEWS = {
    "front": ("Front view head-and-shoulders portrait, looking straight into the camera", "3:4"),
    "three_quarter": ("Three-quarter view portrait, head turned about 45 degrees", "3:4"),
    "profile": ("Side profile portrait, facing left", "3:4"),
    "full_body": ("Full-body shot standing, head to toe visible, showing the complete outfit and shoes", "9:16"),
    "back": ("Back view, standing, seen from behind, head to feet visible, showing the hair and the back of the outfit", "9:16"),
}
LIGHTING = {"day": "bright natural daylight outdoors, soft shadows",
            "dusk": "warm golden-hour light at dusk, long soft shadows, dusk-blue sky",
            "night_interior": "night interior lit by warm oil lamps and tungsten, deep shadows"}
EXPRESSIONS = ["neutral", "happy, warm smile", "angry", "sad, teary eyes", "surprised"]


def _sheet_prompt(ch: Character, view: str, style: Style | None, has_ref: bool, extra: str = "") -> str:
    look = style.look if style else "photorealistic cinematic"
    same = "Same person as the reference image — identical face, hair, skin tone, age and outfit. " if has_ref else ""
    return (f"Character reference image for an AI film. {view}. {same}{ch.dna_text} {extra}\n"
            f"Plain neutral light-grey studio background, soft even lighting, face clearly visible and sharp. "
            f"Rendering style: {look}. No text, no watermark, single person only.")


def _char_ref(db, ch: Character) -> Path | None:
    """Base image for sheets, outfits and expressions: the user's own approved photo first, so everything generated
    from it keeps the real face; otherwise the front view (generated, or cut from an uploaded board). A whole uploaded
    board is the last resort."""
    st = get_storage()
    for kind, approved_only in (("source", True), ("front", False), ("source", False)):
        q = db.query(CharacterAsset).filter(CharacterAsset.character_id == ch.id, CharacterAsset.kind == kind,
                                            CharacterAsset.archived.is_(False))
        if approved_only:
            q = q.filter(CharacterAsset.approved.is_(True), CharacterAsset.origin != "board")
        a = q.order_by(CharacterAsset.approved.desc(), CharacterAsset.id.desc()).first()
        if a and st.exists(a.path):
            return st.abs(a.path)
    return None


def _save_char_asset(db, ctx: JobContext, ch: Character, kind: str, res, prompt: str, label: str = "", outfit: str = "",
                     episode_scope: int | None = None, view: str = "", lighting: str = "", engine: str = "",
                     book: bool = True) -> CharacterAsset:
    """Save a generated character image. `book`=False when the request's cost was booked already (a whole board in
    one request is booked once, then shared out over its images)."""
    st = get_storage()
    rel = st.save_bytes(st.new_path(f"characters/{ch.id}", res.ext), res.data)
    a = CharacterAsset(character_id=ch.id, kind=kind, label=label or kind.replace("_", " "), outfit=outfit,
                       episode_scope=episode_scope, view=view, lighting=lighting, path=rel, prompt=prompt,
                       cost_usd=res.usage.usd, version=ch.version, meta={"engine": engine} if engine else {})
    db.add(a)
    if book:
        ctx.cost(res.usage, db)
    db.commit()
    emit(db, ctx.project_id, "bible.updated", {"character_id": ch.id, "asset_id": a.id})
    return a


@handler("character_sheet")
def character_sheet(ctx: JobContext) -> dict:
    cid = ctx.payload["character_id"]
    kinds = ctx.payload.get("kinds") or list(SHEET_VIEWS)
    made = []
    with SessionLocal() as db:
        ch = db.get(Character, cid)
        style = _style_of(db, ctx.payload.get("project_id"))
        ref = _char_ref(db, ch)
        db.commit()
    engine = ctx.payload.get("engine") or None  # the character's own engine (picked by hand), else the team chain
    for i, kind in enumerate(kinds):
        ctx.check_cancel()
        view, aspect = SHEET_VIEWS.get(kind, SHEET_VIEWS["front"])
        prompt = _sheet_prompt(ch, view, style, ref is not None)
        ctx.progress(i / len(kinds), f"{ch.name}: {kind.replace('_', ' ')}")
        res, used = gen_image(ctx, prompt, [ref] if ref else [], aspect, title=f"{ch.name} · {kind}", explicit=engine,
                              only=bool(engine))
        with SessionLocal() as db:
            ch = db.get(Character, cid)
            a = _save_char_asset(db, ctx, ch, kind, res, prompt, engine=used)
            made.append(a.id)
            if ref is None and kind == "front":
                ref = get_storage().abs(a.path)
    return {"assets": made}


@handler("character_outfit")
def character_outfit(ctx: JobContext) -> dict:
    """A mini turnaround per outfit (front, three-quarter, full body by default), so the clothes are known from
    more than one side and the keyframe keeps them from any angle."""
    p = ctx.payload
    views = [v for v in (p.get("views") or ["front", "three_quarter", "full_body"]) if v in SHEET_VIEWS] or ["full_body"]
    with SessionLocal() as db:
        ch = db.get(Character, p["character_id"])
        style = _style_of(db, p.get("project_id"))
        ref = _char_ref(db, ch)
        db.commit()
    made = []
    first: Path | None = None
    for i, view in enumerate(views):
        ctx.check_cancel()
        ctx.progress(i / len(views), f"{ch.name}: {p['outfit']} ({view.replace('_', ' ')})")
        desc, aspect = SHEET_VIEWS[view]
        same_outfit = " Same outfit as in the second reference image." if first else ""
        prompt = _sheet_prompt(ch, desc, style, ref is not None,
                               extra=f"Now wearing a different outfit. OUTFIT: {p['description']}.{same_outfit}")
        refs = [x for x in (ref, first) if x]
        res, used = gen_image(ctx, prompt, refs, aspect, title=f"{ch.name} · outfit {p['outfit']} {view}",
                              explicit=p.get("engine") or None, only=bool(p.get("engine")))
        with SessionLocal() as db:
            a = _save_char_asset(db, ctx, db.get(Character, p["character_id"]), "outfit", res, prompt,
                                 label=f"outfit: {p['outfit']} ({view.replace('_', ' ')})", outfit=p["outfit"],
                                 episode_scope=p.get("episode_scope"), view=view, engine=used)
            made.append(a.id)
            if first is None:
                first = get_storage().abs(a.path)
    return {"asset_id": made[0] if made else None, "assets": made}


@handler("character_lighting")
def character_lighting(ctx: JobContext) -> dict:
    """The same face under day, dusk and night-interior light: references for scenes in those conditions."""
    p = ctx.payload
    variants = [v for v in (p.get("variants") or list(LIGHTING)) if v in LIGHTING] or list(LIGHTING)
    with SessionLocal() as db:
        ch = db.get(Character, p["character_id"])
        style = _style_of(db, p.get("project_id"))
        ref = _char_ref(db, ch)
        db.commit()
    look = style.look if style else "photorealistic cinematic"
    made = []
    for i, v in enumerate(variants):
        ctx.check_cancel()
        ctx.progress(i / len(variants), f"{ch.name}: {v.replace('_', ' ')} light")
        same = "Same person as the reference image: identical face, hair, skin tone, age and outfit. " if ref else ""
        prompt = (f"Character reference image for an AI film. Head-and-shoulders portrait, three-quarter view. {same}{ch.dna_text} "
                  f"Lighting: {LIGHTING[v]}. Background: a simple real setting that matches this light, softly out of focus. "
                  f"Rendering style: {look}. No text, no watermark, single person only.")
        res, used = gen_image(ctx, prompt, [ref] if ref else [], "3:4", title=f"{ch.name} · {v} light",
                              explicit=p.get("engine") or None, only=bool(p.get("engine")))
        with SessionLocal() as db:
            a = _save_char_asset(db, ctx, db.get(Character, p["character_id"]), "lighting", res, prompt,
                                 label=f"{v.replace('_', ' ')} light", lighting=v, engine=used)
            made.append(a.id)
    return {"assets": made}


@handler("character_expressions")
def character_expressions(ctx: JobContext) -> dict:
    cid = ctx.payload["character_id"]
    with SessionLocal() as db:
        ch = db.get(Character, cid)
        style = _style_of(db, ctx.payload.get("project_id"))
        ref = _char_ref(db, ch)
        db.commit()
    made = []
    for i, expr in enumerate(EXPRESSIONS):
        ctx.check_cancel()
        ctx.progress(i / len(EXPRESSIONS), f"{ch.name}: {expr}")
        prompt = _sheet_prompt(ch, f"Head-and-shoulders portrait with a {expr} expression", style, ref is not None)
        engine = ctx.payload.get("engine") or None
        res, used = gen_image(ctx, prompt, [ref] if ref else [], "3:4", title=f"{ch.name} · {expr}", explicit=engine,
                              only=bool(engine))
        with SessionLocal() as db:
            a = _save_char_asset(db, ctx, db.get(Character, cid), "expression", res, prompt, label=expr.split(",")[0],
                                 engine=used)
            made.append(a.id)
    return {"assets": made}


@handler("location_images")
def location_images(ctx: JobContext) -> dict:
    lid = ctx.payload["location_id"]
    kinds = ctx.payload.get("kinds") or ["wide", "medium"]
    tod = ctx.payload.get("time_of_day", "")
    views = {"wide": "Wide establishing shot", "medium": "Medium shot of the main area", "detail": "Close detail shot of a key prop"}
    st = get_storage()
    made = []
    with SessionLocal() as db:
        loc = db.get(Location, lid)
        style = _style_of(db, ctx.payload.get("project_id"))
        project = db.get(Project, ctx.payload.get("project_id")) if ctx.payload.get("project_id") else None
        first = (db.query(LocationAsset).filter(LocationAsset.location_id == lid, LocationAsset.archived.is_(False))
                 .order_by(LocationAsset.approved.desc(), LocationAsset.id).first())
        ref = st.abs(first.path) if first and st.exists(first.path) else None
        aspect = project.aspect if project else "16:9"
        db.commit()
    for i, kind in enumerate(kinds):
        ctx.progress(i / len(kinds), f"{loc.name}: {kind}")
        prompt = (f"Location reference for an AI film, no people. {views.get(kind, kind)}{(' at ' + tod) if tod else ''}. "
                  f"{loc.description_text} Style: {style.look if style else 'cinematic'}; {style.grade if style else ''}. "
                  f"{'Same place as the reference image.' if ref else ''} No text, no watermark.")
        res, _ = gen_image(ctx, prompt, [ref] if ref else [], aspect, title=f"{loc.name} · {kind}")
        with SessionLocal() as db:
            rel = st.save_bytes(st.new_path(f"locations/{lid}", res.ext), res.data)
            a = LocationAsset(location_id=lid, kind=kind, label=kind, time_of_day=tod, path=rel, prompt=prompt,
                              cost_usd=res.usage.usd)
            db.add(a)
            ctx.cost(res.usage, db)
            db.commit()
            emit(db, ctx.project_id, "bible.updated", {"location_id": lid, "asset_id": a.id})
            made.append(a.id)
            if ref is None:
                ref = st.abs(rel)
    return {"assets": made}


def voice_brief(ch: Character) -> str:
    """The voice to design for a character with no voice description: who they are (age, gender, look), so a farmer
    of 35 and a grandmother of 70 don't get the same stock voice."""
    age = (f"{ch.age}-year-old" if ch.age.isdigit() else ch.age) if ch.age else ""
    who = " ".join(x for x in (age, ch.gender) if x) or "natural"
    look = (ch.dna_text or "").split(":", 1)[-1].strip()[:240]
    return f"A {who} voice for {ch.name}" + (f", who is {look}" if look else "") + ". Clear, natural and believable."


@handler("voice_design")
def voice_design(ctx: JobContext) -> dict:
    p = ctx.payload
    lang, provider = p["language"], p["provider"]
    with SessionLocal() as db:
        ch = db.get(Character, p["character_id"])
        lname = catalog.LANGUAGES.get(lang, {}).get("name", lang)
        desc = (p.get("description") or ch.voice_description or voice_brief(ch)).strip()
        if lname.lower() not in desc.lower():
            desc += f" Speaks {lname} naturally with a native {lname} accent."
        name, gender = ch.name, ch.gender
        db.commit()
    ctx.progress(0.2, f"Designing {name}'s {lname} voice ({provider})")
    vid, sample, usage = ctx.services.design_voice(provider, f"{name} {lang}", desc, lang, gender)
    st = get_storage()
    with SessionLocal() as db:
        rel = st.save_bytes(st.new_path(f"characters/{p['character_id']}/voices", _ext_of_audio(sample)), sample) if sample else ""
        vp = db.query(VoiceProfile).filter(VoiceProfile.character_id == p["character_id"], VoiceProfile.language == lang).first()
        if not vp:
            vp = VoiceProfile(character_id=p["character_id"], language=lang)
            db.add(vp)
        vp.provider, vp.voice_id, vp.voice_name, vp.description, vp.sample_path = provider, vid, f"{name} ({lang})", desc, rel
        if provider == "elevenlabs":
            vp.sts_voice_id = vid
        ctx.cost(usage, db)
        db.commit()
        emit(db, ctx.project_id, "bible.updated", {"character_id": p["character_id"], "voice_profile_id": vp.id})
    return {"voice_profile_id": vp.id, "voice_id": vid}


@handler("voice_preview")
def voice_preview(ctx: JobContext) -> dict:
    st = get_storage()
    with SessionLocal() as db:
        vp = db.get(VoiceProfile, ctx.payload["voice_profile_id"])
        provider, vid, lang, style = vp.provider, vp.voice_id, vp.language, vp.style_prompt
        db.commit()
    text = ctx.payload.get("text") or mock_sample(lang)
    res = ctx.services.tts(provider, text, vid, lang, style=style)
    with SessionLocal() as db:
        vp = db.get(VoiceProfile, ctx.payload["voice_profile_id"])
        vp.sample_path = st.save_bytes(st.new_path(f"characters/{vp.character_id}/voices", res.ext), res.data)
        ctx.cost(res.usage, db)
        db.commit()
        emit(db, ctx.project_id, "bible.updated", {"voice_profile_id": vp.id})
    return {"sample_path": vp.sample_path}


def mock_sample(lang: str) -> str:
    from ..providers.mock import SAMPLE_LINES
    return " ".join(SAMPLE_LINES.get(lang, SAMPLE_LINES["en"])[:2])


# ── edit a clip with words (Omni / any edit engine) ─────────────────────────

@handler("omni_edit")
def omni_edit(ctx: JobContext) -> dict:
    st = get_storage()
    with SessionLocal() as db:
        take = db.get(Take, ctx.payload["take_id"])
        shot = db.get(Shot, take.shot_id)
        project = _project_of(db, shot)
        path = st.abs(take.path)
        aspect = project.aspect if project.aspect in ("16:9", "9:16") else "9:16"
        # an edited lip-synced (or voice-locked) clip stays that kind and language, so it replaces the one it came from
        out_kind = take.kind if take.kind in ("lipsync", "voicelock") else "video"
        out_lang = take.language if out_kind != "video" else None
        db.commit()
    instr = ctx.payload["instruction"]
    m, used, res, attempts = run_chain(ctx, "edit", ["edit"], lambda m, mode: GenRequest(
        mode="edit", prompt=instr, video=path, aspect=aspect), explicit=ctx.payload.get("engine"))
    with SessionLocal() as db:
        shot = db.get(Shot, ctx.shot_id or take.shot_id)
        t = save_take(db, ctx, shot, out_kind, res.data, "mp4", language=out_lang, provider=m.provider, model=m.endpoint,
                      params={"edit_instruction": instr, "mode": "edit", "engine": m.id, "engine_label": m.display_name,
                              "attempts": attempts},
                      prompt=instr, cost=res.usage.usd, interaction_id=res.interaction_id, parent=ctx.payload["take_id"])
        ctx.cost(res.usage, db)
        db.commit()
        emit(db, ctx.project_id, "take.created", {"shot_id": shot.id, "take_id": t.id, "kind": out_kind})
    return {"take_id": t.id}


# ── render (animatic / export) ───────────────────────────────────────────────

def _render(ctx: JobContext, kind: str) -> dict:
    p = ctx.payload
    lang, preset, options = p.get("language", "en"), p.get("preset", "shorts" if kind == "final" else "draft"), p.get("options") or {}
    with SessionLocal() as db:
        ex = db.get(Export, p["export_id"]) if p.get("export_id") else None
        if not ex:
            from ..core import desktop
            episode = db.get(Episode, ctx.episode_id)
            # which cut this render shows, so review notes know whether their timecodes still land on the timeline
            cut = {"cut_version": desktop.latest_number(db, episode.id), "fingerprint": desktop.fingerprint(desktop.snapshot(db, episode))}
            ex = Export(project_id=ctx.project_id, episode_id=ctx.episode_id, language=lang, preset=preset, kind=kind,
                        options={**options, **cut}, status="running", job_id=ctx.job_id, created_by=ctx.user_id,
                        version=desktop.next_export_version(db, ctx.episode_id))
            db.add(ex)
            db.commit()
            ctx.save_result(export_id=ex.id)
        elif ex.version is None:
            from ..core.desktop import next_export_version
            ex.version = next_export_version(db, ex.episode_id)
            db.commit()
        ex_id = ex.id
        emit(db, ctx.project_id, "export.updated", {"export_id": ex_id, "status": "running"})
    ctx.progress(0.1, f"Rendering {kind} [{lang}]")
    with SessionLocal() as db:
        episode = db.get(Episode, ctx.episode_id)
        try:
            out = assembler.render(db, episode, lang, preset, kind, options,
                                   out_rel_base=f"projects/{ctx.project_id}/exports/e{episode.number:02}_{lang}_{preset}_{kind}_{ex_id}")
        except Exception as e:
            ex = db.get(Export, ex_id)
            ex.status = "failed"
            ex.warnings = [str(e)[:500]]
            db.commit()
            emit(db, ctx.project_id, "export.updated", {"export_id": ex_id, "status": "failed"})
            raise
        ex = db.get(Export, ex_id)
        ex.path, ex.srt_path, ex.thumbnail_path = out["path"], out["srt_path"], out["thumbnail_path"]
        ex.duration_s, ex.warnings, ex.status = out["duration"], out["warnings"], "ready"
        ex.peaks = out.get("peaks", [])
        db.commit()
        emit(db, ctx.project_id, "export.updated", {"export_id": ex_id, "status": "ready"})
        webhook = settings_store.get_setting(db, "make_webhook_url") or ""
        project = db.get(Project, ctx.project_id)
        info = {"project": project.title, "episode": episode.number, "language": lang, "preset": preset,
                "duration_s": ex.duration_s, "video_path": ex.path}
    # never publish a cut with placeholders in it (missing shots or clips made without an API key)
    unfinished = [w for w in out["warnings"] if "placeholder" in w or "no video yet" in w]
    if kind == "final" and options.get("publish") and webhook and unfinished:
        print(f"[export] not published: {len(unfinished)} unfinished shot(s)")
        out["warnings"] = [*out["warnings"], "Not published: some shots are placeholders or still images — finish them first"]
        with SessionLocal() as db:
            ex = db.get(Export, ex_id)
            ex.warnings = out["warnings"]
            db.commit()
    elif kind == "final" and options.get("publish") and webhook:
        from ..config import get_settings
        base = get_settings().public_base_url.rstrip("/")
        try:
            httpx.post(webhook, json={**info, "video_url": f"{base}/media/{info['video_path']}"}, timeout=15)
        except Exception as e:
            print(f"[export] Make.com webhook failed: {e}")
    return {"export_id": ex_id, "warnings": out["warnings"]}


@handler("export")
def export(ctx: JobContext) -> dict:
    return _render(ctx, "final")


@handler("animatic")
def animatic(ctx: JobContext) -> dict:
    return _render(ctx, "animatic")


# ── dub (orchestrator) ───────────────────────────────────────────────────────

@handler("dub")
def dub(ctx: JobContext) -> dict:
    lang = ctx.payload["language"]
    with SessionLocal() as db:
        episode = db.get(Episode, ctx.episode_id)
        project = db.get(Project, episode.project_id)
        user = _user(db, ctx)
        ctx.progress(0.05, "Adapting the script")
        studio.localize(db, user, episode, lang)
        if ctx.payload.get("native_polish", True):
            studio.native_polish(db, user, episode, lang)
        shots = generation.episode_shots(db, episode)
        dub_method = settings_store.get_setting(db, "dub_method") or "redub"
        # Google route: Veo speaks the translated line itself (voice + lips in one pass) when this language is allowed
        native = ctx.payload.get("native")
        if native is None:
            native = lang in native_languages(project) and dub_method in ("regenerate", "regenerate_native", "native")
        spoken = [s for s in shots if shot_lines(s, lang)]
        voice_ids = [s.id for s in shots if (s.narration or {}).get(lang) or (shot_lines(s, lang) and not native)]
        native_specs = [(s.id, est_v) for s, est_v in ((s, budget.Estimator(db).video(s, project)) for s in spoken)] if native else []
        if lang not in (project.languages or []):
            project.languages = [*(project.languages or []), lang]
        est = budget.Estimator(db)
        db.commit()
    children = [ctx.enqueue_child("voice", {"language": lang}, shot_id=sid, label=f"Voice [{lang}]") for sid in voice_ids]
    children += [ctx.enqueue_child("video", {"language": lang, "native": True}, shot_id=sid, estimate=est_v,
                                   label=f"Speak [{lang}]") for sid, est_v in native_specs]
    st = ctx.wait_children(children, "Voices" if not native else "Spoken clips")
    lip_jobs: list[int] = []
    if not native:
        with SessionLocal() as db:
            episode = db.get(Episode, ctx.episode_id)
            lips = [s for s in generation.episode_shots(db, episode) if shot_lines(s, lang) and current(db, s.id, "video")]
            lip_jobs = [ctx.enqueue_child("lipsync", {"language": lang}, shot_id=s.id, estimate=est.lipsync(s),
                                          label=f"Lip-sync {s.code} [{lang}]") for s in lips]
    st2 = ctx.wait_children(lip_jobs, "Lip-sync") if lip_jobs else {}
    failed = sum(1 for v in [*st.values(), *st2.values()] if v != "succeeded")
    if ctx.payload.get("then_export"):
        ex = ctx.enqueue_child("export", {"language": lang, "preset": ctx.payload["then_export"], "options": {"captions": True}})
        ctx.wait_children([ex], "Export")
    return {"voices": len(children), "lipsyncs": len(lip_jobs), "failed": failed}


from . import handlers_keyframe  # noqa: E402,F401  (registers keyframe QC; imported here so the worker always has it)
