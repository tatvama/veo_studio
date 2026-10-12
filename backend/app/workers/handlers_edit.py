"""Tatvam Editor AI jobs (docs/EDITOR.md §8). Plans, prices and schemas live in core/edit_ai.py.

Every job writes its files under projects/{pid}/edit_ai/ and its result as
{tool, outputs: [{key, url, kind, duration, name, …}], segments?, commands?, reply?, …}. Times in a result count from
the start of the range the tool was given (`offset` repeats that start, in the media's seconds)."""
from __future__ import annotations

import array
import shutil
import wave
from pathlib import Path
from typing import Any, Callable

from .. import catalog, settings_store
from ..core import edit_ai
from ..core.edit_ai import ToolError
from ..db import SessionLocal
from ..models import AIModel, Character, Project, User, VoiceProfile
from ..pipeline import ffmpeg as ff
from ..pipeline.voice import say
from ..providers.base import MediaResult, ProviderError
from ..providers.schema_map import GenRequest
from ..storage import get_storage
from .handlers import gen_image, run_chain
from .worker import GROUP_OF, JobContext, handler

# concurrency groups (worker.GROUP_LIMITS): picture jobs share the video limit, sound the audio one, writing the LLM one
GROUP_OF.update({"edit_video": "video", "edit_extend": "video", "edit_words": "video", "edit_upscale": "video",
                 "edit_tts": "audio", "edit_dub": "audio", "edit_clean_voice": "audio", "edit_sfx": "audio",
                 "edit_music": "audio", "edit_transcribe": "llm", "edit_translate": "llm", "edit_sfx_suggest": "llm",
                 "edit_assistant": "llm", "edit_broll_suggest": "llm", "edit_highlights": "llm",
                 "edit_mood_suggest": "llm", "edit_thumbnail": "image", "edit_voice_clone": "audio"})


def edit_handler(job_type: str):
    """A job of one editor tool: its parameters parsed again, a scratch folder, ToolError → a failed job."""
    def deco(fn: Callable[[JobContext, Any, Path], dict]):
        @handler(job_type)
        def run(ctx: JobContext) -> dict:
            tmp = get_storage().tmp_dir()
            try:
                _, p = edit_ai.parse(str(ctx.payload.get("tool") or ""), ctx.payload.get("params"))
                return fn(ctx, p, tmp)
            except ToolError as e:
                raise ProviderError(str(e)) from e
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
        return run
    return deco


def _src(ctx: JobContext, key: str) -> Path:
    return edit_ai.asset_path(ctx.project_id, key)


def _save(ctx: JobContext, src: Path, kind: str, name: str, **extra: Any) -> dict:
    """Keep a result file in the edit's folder on the studio → one `outputs` entry."""
    st = get_storage()
    ext = src.suffix.lstrip(".").lower() or ("mp4" if kind == "video" else "wav")
    key = st.save_file(st.new_path(f"projects/{ctx.project_id}/edit_ai", ext), src)
    dur = ff.duration(st.abs(key)) if kind != "image" else 0.0
    return {"key": key, "url": st.url(key), "kind": kind, "duration": round(dur, 3), "name": name[:120], **extra}


def _write(res: MediaResult, path_no_ext: Path) -> Path:
    out = path_no_ext.with_suffix(f".{res.ext or 'bin'}")
    out.write_bytes(res.data)
    return out


def _aspect(video: Path) -> str:
    w, h = ff.video_size(video)
    return "9:16" if h > w else "16:9"


def _speak(ctx: JobContext, voice: dict, text: str, language: str, style: str, tmp: Path, stem: str) -> Path:
    """Text → one audio file (long text in pieces, joined)."""
    parts = []
    for i, chunk in enumerate(edit_ai.tts_chunks(text)):
        ctx.check_cancel()
        res = ctx.services.tts(voice["provider"], chunk, voice["voice_id"], language, style)
        ctx.cost(res.usage)
        parts.append(_write(res, tmp / f"{stem}_{i}"))
    if not parts:
        raise ProviderError("There is nothing to say")
    if len(parts) == 1:
        return parts[0]
    out = tmp / f"{stem}.wav"
    ff.concat_audio_with_gaps(parts, out, gap=0.2, lead_in=0.0)
    return out


def _place(parts: list[tuple[Path, float]], total: float, out: Path, rate: int = 48000) -> Path:
    """One mono track with each piece starting at its time (a later piece overwrites an earlier one's tail)."""
    pcm: list[tuple[int, array.array]] = []
    n = int(max(total, 0.1) * rate)
    for i, (p, at) in enumerate(parts):
        q = out.parent / f"_place_{i}.wav"
        ff.run(["-i", p, "-ac", "1", "-ar", str(rate), "-sample_fmt", "s16", q])
        with wave.open(str(q), "rb") as w:
            data = array.array("h", w.readframes(w.getnframes()))
        o = int(max(at, 0.0) * rate)
        pcm.append((o, data))
        n = max(n, o + len(data))
    buf = array.array("h", bytes(2 * n))
    for o, data in pcm:
        buf[o:o + len(data)] = data
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(buf.tobytes())
    return out


def _video(ctx: JobContext, prompt: str, seconds: float, aspect: str, quality: str, route: str | None,
           first: Path | None) -> tuple[AIModel, str, MediaResult]:
    """A clip through the team's video chain (Google first, fallbacks as the studio's shots use them), or the picked
    Model Hub route."""
    resolution = catalog.QUALITY_MODES[quality]["resolution"]

    def build(m: AIModel, mode: str) -> GenRequest:
        return GenRequest(mode=mode, prompt=prompt, first_frame=first if mode == "i2v" else None, duration=seconds,
                          aspect=aspect, resolution=resolution)

    m, used, res, _ = run_chain(ctx, f"video.{quality}", ["i2v"] if first else ["t2v"], build, explicit=route or None)
    ctx.cost(res.usage)
    ctx.save_result(ops={})
    return m, used, res


# ── captions & translation ───────────────────────────────────────────────────

@edit_handler("edit_transcribe")
def transcribe(ctx: JobContext, p: edit_ai.TranscribeIn, tmp: Path) -> dict:
    audio = edit_ai.cut_audio(_src(ctx, p.key), tmp / "sound.wav", p.start, p.end, rate=16000)
    ctx.progress(0.1, "Listening")
    out, usages = edit_ai.transcribe_audio(ctx.services, audio, p.language, p.words,
                                           on_progress=lambda f, m: ctx.progress(0.1 + 0.85 * f, m))
    for u in usages:
        ctx.cost(u)
    return {"tool": "transcribe", "language": out["language"], "segments": out["segments"], "outputs": [],
            "offset": p.start or 0.0, "mock": bool(out.get("mock"))}


@edit_handler("edit_translate")
def translate(ctx: JobContext, p: edit_ai.TranslateIn, tmp: Path) -> dict:
    segs, usages = edit_ai.translate_lines(ctx.services, [s.model_dump() for s in p.segments], p.target, p.source,
                                           on_progress=lambda f, m: ctx.progress(0.05 + 0.9 * f, m))
    for u in usages:
        ctx.cost(u)
    return {"tool": "translate", "language": p.target, "segments": segs, "outputs": []}


# ── voice ────────────────────────────────────────────────────────────────────

@edit_handler("edit_tts")
def tts(ctx: JobContext, p: edit_ai.TtsIn, tmp: Path) -> dict:
    with SessionLocal() as db:
        v = edit_ai.resolve_voice(db, p.voice, p.language)
        project = db.get(Project, ctx.project_id)
        text = say(db, project, p.text) if project else p.text  # the pronunciation dictionary
    ctx.progress(0.1, "Speaking")
    path = _speak(ctx, v, text, p.language, p.style or v["style"], tmp, "voice")
    return {"tool": "tts", "voice": v, "outputs": [_save(ctx, path, "audio", f"Voice-over ({v['voice_id']})")]}


@edit_handler("edit_dub")
def dub(ctx: JobContext, p: edit_ai.DubIn, tmp: Path) -> dict:
    """Listen → translate → voice each line, fitted into its slot (sped up at most 1.25×) and placed at its time."""
    audio = edit_ai.cut_audio(_src(ctx, p.key), tmp / "sound.wav", p.start, p.end, rate=16000)
    total = ff.duration(audio)
    ctx.progress(0.05, "Listening")
    heard, usages = edit_ai.transcribe_audio(ctx.services, audio, p.source_lang, False,
                                             on_progress=lambda f, m: ctx.progress(0.05 + 0.2 * f, m))
    for u in usages:
        ctx.cost(u)
    if not heard["segments"]:
        raise ProviderError("No speech found to dub")
    ctx.progress(0.3, "Translating")
    said, usages = edit_ai.translate_lines(ctx.services, heard["segments"], p.target, heard["language"] or p.source_lang)
    for u in usages:
        ctx.cost(u)
    with SessionLocal() as db:
        v = edit_ai.resolve_voice(db, p.voice, p.target)
    placed: list[tuple[Path, float]] = []
    lines: list[dict] = []
    for i, s in enumerate(said):
        ctx.check_cancel()
        ctx.progress(0.4 + 0.5 * i / len(said), f"Voicing line {i + 1} of {len(said)}")
        res = ctx.services.tts(v["provider"], s["text"], v["voice_id"], p.target, p.style or v["style"])
        ctx.cost(res.usage)
        raw = _write(res, tmp / f"line_{i}")
        nxt = said[i + 1]["start"] if i + 1 < len(said) else total
        slot = max(nxt - s["start"], s["end"] - s["start"], 0.3)
        fitted, factor = ff.fit_audio_length(raw, tmp / f"fit_{i}{raw.suffix}", slot)
        lines.append(_save(ctx, fitted, "audio", f"Dub line {i + 1}", start=s["start"], end=s["end"], text=s["text"],
                           speed=round(factor, 3)))
        placed.append((fitted, s["start"]))
    track = _place(placed, total, tmp / "dub.wav")
    out = _save(ctx, track, "audio", f"Dub ({edit_ai.lang_name(p.target)})", role="track")
    return {"tool": "dub", "language": p.target, "source_language": heard["language"], "segments": said, "outputs": [out],
            "lines": lines, "voice": v, "offset": p.start or 0.0}


@edit_handler("edit_clean_voice")
def clean_voice(ctx: JobContext, p: edit_ai.CleanVoiceIn, tmp: Path) -> dict:
    wav = edit_ai.cut_audio(_src(ctx, p.key), tmp / "voice.wav", p.start, p.end, rate=44100)
    ctx.progress(0.2, "Isolating the voice")
    res = ctx.services.isolate_voice(wav)
    ctx.cost(res.usage)
    return {"tool": "clean_voice", "outputs": [_save(ctx, _write(res, tmp / "clean"), "audio", "Clean voice")],
            "offset": p.start or 0.0}


# ── sound ────────────────────────────────────────────────────────────────────

@edit_handler("edit_sfx")
def sfx(ctx: JobContext, p: edit_ai.SfxIn, tmp: Path) -> dict:
    ctx.progress(0.2, "Making the sound")
    res = ctx.services.sound_effect(p.prompt, p.seconds)
    ctx.cost(res.usage)
    return {"tool": "sfx", "outputs": [_save(ctx, _write(res, tmp / "sfx"), "audio", f"SFX · {p.prompt[:60]}")]}


@edit_handler("edit_sfx_suggest")
def sfx_suggest(ctx: JobContext, p: edit_ai.SfxSuggestIn, tmp: Path) -> dict:
    frame = edit_ai.frame_of(_src(ctx, p.key), tmp / "frame.png", p.at if p.at is not None else 0.0)
    obj, u = edit_ai.llm(ctx.services, "edit_sfx_ideas", edit_ai.SFX_SYSTEM,
                         "Suggest 3 to 5 sound effects for this shot.", edit_ai.SfxIdeasOut,
                         lambda: {"suggestions": list(edit_ai.MOCK_SFX)}, images=[frame.read_bytes()])
    ctx.cost(u)
    ideas = [s.strip() for s in obj.suggestions if s.strip()][:6]
    return {"tool": "sfx_suggest", "suggestions": ideas, "outputs": []}


@edit_handler("edit_music")
def music(ctx: JobContext, p: edit_ai.MusicIn, tmp: Path) -> dict:
    """Music to the asked length; a mood adds its musical words and a BPM the tempo (edit_ai.music_prompt)."""
    ctx.progress(0.2, "Composing")
    prompt = edit_ai.music_prompt(p)
    res = ctx.services.music(prompt, p.seconds)
    ctx.cost(res.usage)
    # exactly the asked length: looped or trimmed, with a 2 s fade at the end
    fitted = ff.music_bed(_write(res, tmp / "music"), None, tmp / "music_fit.wav", p.seconds, volume_db=0.0, duck=False)
    name = f"Music · {(p.prompt.strip() or p.mood.strip())[:60]}" + (f" ({p.mood.strip()})" if p.mood.strip() and p.prompt.strip() else "")
    return {"tool": "music", "prompt": prompt, "mood": p.mood.strip(), "bpm": p.bpm,
            "outputs": [_save(ctx, fitted, "audio", name, mood=p.mood.strip(), bpm=p.bpm)]}


# ── picture ──────────────────────────────────────────────────────────────────

@edit_handler("edit_video")
def video(ctx: JobContext, p: edit_ai.VideoIn, tmp: Path) -> dict:
    first = None
    if p.first_frame_key:
        first = edit_ai.frame_of(_src(ctx, p.first_frame_key), tmp / "first.png",
                                 p.first_frame_at if p.first_frame_at is not None else 0.0)
    m, used, res = _video(ctx, p.prompt, p.seconds, p.aspect, p.quality, p.route, first)
    out = _save(ctx, _write(res, tmp / "broll"), "video", f"B-roll · {p.prompt[:60]}")
    return {"tool": "video", "engine": m.id, "engine_label": m.display_name, "mode": used, "outputs": [out]}


@edit_handler("edit_extend")
def extend(ctx: JobContext, p: edit_ai.ExtendIn, tmp: Path) -> dict:
    """A new clip that starts on the video's last frame (or the frame at `at`): it goes right after the clip."""
    src = _src(ctx, p.key)
    frame = edit_ai.frame_of(src, tmp / "last.png", p.at if p.at is not None else "last")
    prompt = ("Continue this shot seamlessly from this exact frame: the same people, place, light and camera movement."
              + (f" {p.prompt}" if p.prompt else ""))
    m, used, res = _video(ctx, prompt, p.seconds, _aspect(src), p.quality, p.route, frame)
    out = _save(ctx, _write(res, tmp / "extension"), "video", "Extension")
    return {"tool": "extend", "engine": m.id, "engine_label": m.display_name, "mode": used, "outputs": [out]}


@edit_handler("edit_words")
def edit_words(ctx: JobContext, p: edit_ai.EditWordsIn, tmp: Path) -> dict:
    clip = edit_ai.cut_video(_src(ctx, p.key), tmp / "part.mp4", p.start, p.end)
    aspect = _aspect(clip)
    m, used, res, _ = run_chain(ctx, "edit", ["edit"], lambda m, mode: GenRequest(
        mode="edit", prompt=p.instruction, video=clip, aspect=aspect), explicit=p.route or None, expected_s=120)
    ctx.cost(res.usage)
    ctx.save_result(ops={})
    out = _save(ctx, _write(res, tmp / "edited"), "video", f"Edited · {p.instruction[:60]}")
    return {"tool": "edit_words", "engine": m.id, "engine_label": m.display_name, "outputs": [out], "offset": p.start or 0.0}


@edit_handler("edit_upscale")
def upscale(ctx: JobContext, p: edit_ai.UpscaleIn, tmp: Path) -> dict:
    """The cloud upscale of the finishing room (fal, Topaz by default) on any clip of the edit."""
    clip = edit_ai.cut_video(_src(ctx, p.key), tmp / "part.mp4", p.start, p.end)
    w, h, factor = edit_ai.upscale_size(clip, p.target_h)
    with SessionLocal() as db:
        team = settings_store.all_settings(db)
    endpoint = str(team.get("upscale_fal_endpoint") or "fal-ai/topaz/upscale/video")
    model = str(team.get("upscale_model") or "Proteus")
    price = float(team.get("upscale_price_per_s") or 0.08)
    ctx.progress(0.05, "Upscaling")
    res = ctx.services.upscale_video(clip, w, h, factor, endpoint, model, price, on_tick=ctx.tick("Upscaling", 300),
                                     on_request=lambda rid: ctx.save_result(request_id=rid),
                                     resume=ctx.result.get("request_id"))
    ctx.cost(res.usage)
    out = _save(ctx, _write(res, tmp / "upscaled"), "video", f"Upscaled {w}×{h}", width=w, height=h)
    return {"tool": "upscale", "outputs": [out], "offset": p.start or 0.0}


# ── the edit assistant ───────────────────────────────────────────────────────

@edit_handler("edit_assistant")
def assistant(ctx: JobContext, p: edit_ai.AssistantIn, tmp: Path) -> dict:
    """Claude turns the instruction into editor commands; only commands that pass their strict schema and fit the
    sequence come back (the rest are listed in `rejected`)."""
    ctx.progress(0.1, "Thinking")
    obj, u = edit_ai.llm(ctx.services, "edit_assistant", edit_ai.ASSISTANT_SYSTEM, edit_ai.assistant_prompt(p),
                         edit_ai.AssistantOut, lambda: edit_ai.mock_assistant(p.instruction, p.sequence_digest))
    ctx.cost(u)
    cmds, rejected = edit_ai.validate_commands([edit_ai.from_flat(c.model_dump()) for c in obj.commands], p.sequence_digest)
    reply = obj.reply.strip() or ("Here is what I would change." if cmds else "I couldn't turn that into edits.")
    return {"tool": "assistant", "reply": reply, "commands": cmds, "rejected": rejected, "outputs": []}


# ── wave 3: ideas, highlights, thumbnails, cloned voices, moods ──────────────

@edit_handler("edit_broll_suggest")
def broll_suggest(ctx: JobContext, p: edit_ai.BrollSuggestIn, tmp: Path) -> dict:
    """B-roll ideas tied to the transcript's times (Claude writes them); each becomes a prompt for "Generate B-roll"."""
    ctx.progress(0.1, "Reading the transcript")
    obj, u = edit_ai.llm(ctx.services, "edit_broll_ideas", edit_ai.BROLL_SYSTEM, edit_ai.broll_prompt(p), edit_ai.BrollOut,
                         lambda: edit_ai.mock_broll(p))
    ctx.cost(u)
    return {"tool": "broll_suggest", "ideas": edit_ai.finish_broll([x.model_dump() for x in obj.ideas], p), "outputs": []}


@edit_handler("edit_highlights")
def highlights(ctx: JobContext, p: edit_ai.HighlightsIn, tmp: Path) -> dict:
    """The best self-contained moments for Shorts / Reels, on whole transcript lines, close to the asked length."""
    ctx.progress(0.1, "Finding the best moments")
    obj, u = edit_ai.llm(ctx.services, "edit_highlights", edit_ai.HIGHLIGHTS_SYSTEM, edit_ai.highlights_prompt(p),
                         edit_ai.HighlightsOut, lambda: edit_ai.mock_highlights(p))
    ctx.cost(u)
    picks = edit_ai.finish_highlights([x.model_dump() for x in obj.highlights], p)
    if not picks:  # the model's ranges didn't fit: the deterministic picks
        picks = edit_ai.finish_highlights(edit_ai.mock_highlights(p)["highlights"], p)
    return {"tool": "highlights", "highlights": picks, "platform": p.platform, "target_seconds": p.target_seconds,
            "outputs": []}


@edit_handler("edit_thumbnail")
def thumbnail(ctx: JobContext, p: edit_ai.ThumbnailIn, tmp: Path) -> dict:
    """Thumbnails from a frame through the team's image chain (Google first): `count` in each aspect asked for. A retry
    keeps the images already made."""
    st = get_storage()
    frame = edit_ai.frame_of(_src(ctx, p.frame_key or p.key or ""), tmp / "frame.png", p.at if p.at is not None else 0.0)
    outs: list[dict] = [o for o in ctx.result.get("outputs") or [] if isinstance(o, dict) and o.get("key")]
    todo = [(aspect, i) for aspect in p.aspects for i in range(p.count)]
    engine = str(ctx.result.get("engine") or "")
    for n, (aspect, i) in enumerate(todo):
        if any(o.get("aspect") == aspect and o.get("variant") == i + 1 for o in outs):
            continue
        ctx.check_cancel()
        ctx.progress(0.05 + 0.9 * n / len(todo), f"Thumbnail {n + 1} of {len(todo)}")
        res, engine = gen_image(ctx, edit_ai.thumbnail_prompt(p, aspect, i), [frame], aspect, title=p.title or "thumbnail",
                                explicit=p.route or None)
        ctx.cost(res.usage)
        name = f"Thumbnail {aspect} #{i + 1}" + (f" · {p.title.strip()[:40]}" if p.title.strip() else "")
        o = _save(ctx, _write(res, tmp / f"thumb_{n}"), "image", name, aspect=aspect, variant=i + 1, engine=engine)
        w, h = ff.video_size(st.abs(o["key"]))
        outs.append({**o, "width": w, "height": h})
        ctx.save_result(outputs=outs, engine=engine)
    return {"tool": "thumbnail", "engine": engine, "title": p.title, "outputs": outs}


@edit_handler("edit_voice_clone")
def voice_clone(ctx: JobContext, p: edit_ai.VoiceCloneIn, tmp: Path) -> dict:
    """An instant voice clone (ElevenLabs) of a sample, only with the speaker's consent record. The voice becomes a
    studio voice (a cast entry with a voice profile per language), so voice-over and dubbing can use it."""
    with SessionLocal() as db:
        consent = edit_ai.check_consent(db, p.consent_id)
        subject, consent_char = consent.subject_name, consent.character_id
    langs = edit_ai.clone_languages(p.languages)
    src = _src(ctx, p.sample_key)
    s, n = edit_ai.span(src, p.start, p.end)
    if n < edit_ai.CLONE_MIN_S:
        raise ToolError(f"Use at least {edit_ai.CLONE_MIN_S:.0f} seconds of clean speech for a cloned voice")
    wav = edit_ai.cut_audio(src, tmp / "sample.wav", s, s + min(n, edit_ai.CLONE_MAX_S), rate=44100)
    voice_id = str(ctx.result.get("voice_id") or "")
    if not voice_id:  # a retry keeps the voice made before
        ctx.progress(0.3, "Cloning the voice")
        voice_id, usage = ctx.services.clone_voice(f"{p.name} (Tatvam clone)", [("sample.wav", wav.read_bytes(), "audio/wav")],
                                                   description=f"Cloned voice of {subject}, with consent record {p.consent_id}",
                                                   remove_noise=p.remove_noise)
        ctx.cost(usage)
        ctx.save_result(voice_id=voice_id)
    st = get_storage()
    sample = st.save_file(st.new_path(f"projects/{ctx.project_id}/edit_ai", "wav"), wav)
    from ..core.audit import audit
    with SessionLocal() as db:
        ch = db.get(Character, int(ctx.result["character_id"])) if ctx.result.get("character_id") else None
        if ch is None:
            ch = Character(name=p.name.strip()[:120], role="Cloned voice", voice_description=f"Cloned voice of {subject}",
                           created_by=ctx.user_id)
            db.add(ch)
            db.flush()
        ids = []
        for lang in langs:
            vp = db.query(VoiceProfile).filter(VoiceProfile.character_id == ch.id, VoiceProfile.language == lang).first()
            if vp is None:
                vp = VoiceProfile(character_id=ch.id, language=lang)
                db.add(vp)
            vp.provider, vp.voice_id, vp.voice_name = "elevenlabs", voice_id, f"{p.name.strip()[:80]} · cloned voice"
            vp.description = f"Cloned in Tatvam Editor from a sample of {subject} (consent record {p.consent_id})"
            vp.sts_voice_id, vp.sample_path, vp.style_prompt = voice_id, sample, ""
            vp.settings = {**(vp.settings or {}), "consent_id": p.consent_id, "source": "editor", "edit_project_id": ctx.project_id}
            db.flush()
            ids.append(vp.id)
        if consent_char is None:  # the record now covers this voice (the cast shows "consent on file")
            c = edit_ai.check_consent(db, p.consent_id)
            c.character_id = ch.id
        audit(db, db.get(User, ctx.user_id) if ctx.user_id else None, "voice.clone", ch.name,
              {"character_id": ch.id, "subject": subject, "consent_id": p.consent_id, "languages": langs, "voice_id": voice_id,
               "source": "editor", "edit_project_id": ctx.project_id}, commit=False)
        db.commit()
        cid = ch.id
    ctx.save_result(character_id=cid)
    from ..events import emit
    emit(None, None, "bible.updated", {"character_id": cid})
    return {"tool": "voice_clone", "voice": {"provider": "elevenlabs", "voice_id": voice_id, "name": p.name.strip(),
                                             "character_id": cid, "profile_ids": ids, "languages": langs,
                                             "consent_id": p.consent_id, "subject": subject},
            "outputs": [], "offset": s}


@edit_handler("edit_mood_suggest")
def mood_suggest(ctx: JobContext, p: edit_ai.MoodSuggestIn, tmp: Path) -> dict:
    """A mood per scene from its emotion (Claude; the deterministic mapping when the text route is mock)."""
    allowed = edit_ai.allowed_moods(p)
    obj, u = edit_ai.llm(ctx.services, "edit_moods", edit_ai.MOOD_SYSTEM, edit_ai.mood_prompt(p, allowed), edit_ai.MoodOut,
                         lambda: edit_ai.mock_moods(p, allowed))
    ctx.cost(u)
    return {"tool": "mood_suggest", "moods": edit_ai.finish_moods([x.model_dump() for x in obj.picks], p, allowed),
            "outputs": []}
