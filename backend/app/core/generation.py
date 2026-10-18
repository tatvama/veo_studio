"""Builds job specs (with cost estimates) for every paid step. Shared by REST, agent and autopilot."""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from .. import catalog
from ..models import AIModel, Character, Episode, Location, Project, Shot, Take
from ..pipeline.prompting import effective_voice_mode, shot_lines
from ..pipeline.selection import current, has_fresh, is_real
from . import frames
from . import links
from .budget import Estimator
from .jobs import spec


def episode_shots(db: Session, episode: Episode, shot_ids: list[int] | None = None, codes: list[str] | None = None) -> list[Shot]:
    q = db.query(Shot).filter(Shot.episode_id == episode.id, Shot.include.is_(True))
    if shot_ids:
        q = q.filter(Shot.id.in_(shot_ids))
    if codes:
        q = q.filter(Shot.code.in_(codes))
    return q.order_by(Shot.order, Shot.id).all()


def keyframe_specs(db: Session, project: Project, shots: list[Shot], only_missing: bool = False, hero: bool = False) -> list[dict]:
    """Each scene's anchor first; the scene's other keyframes carry `after_shot` and are claimed once the anchor's
    keyframe is done (core/scene_order.py), so they can follow its look. Scenes still run side by side. A synced
    shot's keyframe is a copy of the end frame it starts on (core/frames.py): free once that end frame exists, and
    held back (`after_end`) while the shot before is still making it."""
    from ..pipeline.scene_look import anchor_map
    est = Estimator(db)
    anchors = anchor_map(db, shots)
    first, after = [], []
    for s in shots:
        if only_missing and is_real(current(db, s.id, "keyframe")):
            continue
        payload: dict[str, Any] = {"hero": hero}
        if s.id in anchors:
            payload["after_shot"] = anchors[s.id]
        src = frames.sync_source(db, s)
        usd = frames.image_price(db, project, 1, hero=hero)
        if src is not None:
            payload["after_end"] = frames.after_end(db, s)
            usd = 0.0 if frames.end_take(db, src) is not None else usd  # (else it makes the end frame first)
            payload = {k: v for k, v in payload.items() if v}
        (after if s.id in anchors else first).append(
            spec("keyframe", payload=payload, project_id=project.id, episode_id=s.episode_id, shot_id=s.id,
                 estimate=usd, label=f"Keyframe {s.code}"))
    return first + after


def endframe_spec(db: Session, project: Project, shot: Shot, hero: bool = False, engine: str | None = None) -> dict:
    """The shot's end frame (core/frames.py), its start frame first when it has none."""
    usd = frames.image_price(db, project, 1, engine, hero)
    if current(db, shot.id, "keyframe") is None:
        usd += frames.image_price(db, project, 1, engine, hero) if frames.sync_source(db, shot) is None else 0.0
    payload: dict[str, Any] = {k: v for k, v in (("hero", hero), ("engine", engine), ("after_end", frames.after_end(db, shot))) if v}
    return spec("endframe", payload=payload, project_id=project.id, episode_id=shot.episode_id, shot_id=shot.id,
                estimate=usd, label=f"End frame {shot.code}")


def storyboard_spec(db: Session, project: Project, episode: Episode, shots: list[Shot], *, end_frames: bool = True,
                    sync: bool = False, redo: bool = False, engine: str | None = None, hero: bool = False) -> tuple[dict, dict]:
    """(job spec, plan): every start and end frame of these shots, made in order (workers/handlers_frames.py)."""
    pl = frames.plan(db, project, shots, end_frames=end_frames, redo=redo, engine=engine, sync=sync, hero=hero)
    payload = {"shot_ids": [s.id for s in shots], "end_frames": end_frames, "sync": sync, "redo": redo,
               "engine": engine or "", "hero": hero}
    label = f"Storyboard frames ({len(pl['shots'])} shot{'s' if len(pl['shots']) != 1 else ''})"
    return spec("storyboard_frames", payload=payload, project_id=project.id, episode_id=episode.id,
                estimate=pl["total_usd"], label=label), pl


def enhance_spec(db: Session, project: Project, shot: Shot, take: Take) -> dict:
    """Re-render a keyframe with the Pro image model, keeping its composition and faces (a new take)."""
    return spec("keyframe", payload={"hero": True, "enhance_take_id": take.id}, project_id=project.id,
                episode_id=shot.episode_id, shot_id=shot.id, estimate=Estimator(db).image(1, hero=True),
                label=f"Enhance keyframe {shot.code}")


def video_specs(db: Session, project: Project, shots: list[Shot], quality: str | None = None, only_missing: bool = False,
                mode: str | None = None) -> list[dict]:
    from ..pipeline.scene_look import anchor_map
    est = Estimator(db)
    anchors = anchor_map(db, shots)
    first, after = [], []
    for s in shots:
        if only_missing and is_real(current(db, s.id, "video")):
            continue
        q = quality or s.quality_mode or project.quality_mode
        cost = est.video(s, project, q)
        kf = current(db, s.id, "keyframe")
        payload: dict[str, Any] = {"quality": q, "mode": mode}
        src = frames.sync_source(db, s)
        if src is not None:  # a synced shot: its start frame is a copy of the end frame before (core/frames.py) ...
            if frames.end_take(db, src) is None:
                cost += frames.image_price(db, project, 1)  # ... which it makes first when the shot before hasn't
                if (wait := frames.after_end(db, s)) is not None:
                    payload["after_end"] = wait  # ... and waits for while the shot before is making it
        elif not kf or kf.stale:  # the video job makes the missing (or stale) keyframe first
            cost += frames.image_price(db, project, 1)
            if s.id in anchors:  # ... after its scene's anchor has one to follow (core/scene_order.py)
                payload["after_shot"] = anchors[s.id]
        if frames.end_take(db, s) is None and frames.wants_end(db, s) and (mode or s.mode or "auto") in (
                "auto", "keyframe_to_video", "interpolate"):
            cost += frames.image_price(db, project, 1)  # its end frame (out of date, or one a shot starts on) first
        (after if "after_shot" in payload else first).append(
            spec("video", payload=payload, project_id=project.id, episode_id=s.episode_id, shot_id=s.id, estimate=cost,
                 label=f"Video {s.code} ({q})"))
    return first + after


def voice_specs(db: Session, project: Project, shots: list[Shot], lang: str) -> list[dict]:
    est = Estimator(db)
    return [spec("voice", payload={"language": lang}, project_id=project.id, episode_id=s.episode_id, shot_id=s.id,
                 estimate=est.voice(s, lang), label=f"Voice {s.code} [{lang}]")
            for s in shots if shot_lines(s, lang) or (s.narration or {}).get(lang)]


def lipsync_specs(db: Session, project: Project, shots: list[Shot], lang: str, model: str | None = None) -> list[dict]:
    est = Estimator(db)
    out = []
    for s in shots:
        if not shot_lines(s, lang) or not current(db, s.id, "video"):
            continue
        cost = est.lipsync(s, model)
        if not current(db, s.id, "voice", lang):
            cost += est.voice(s, lang)
        out.append(spec("lipsync", payload={"language": lang, "model": model}, project_id=project.id,
                        episode_id=s.episode_id, shot_id=s.id, estimate=cost, label=f"Lip-sync {s.code} [{lang}]"))
    return out


def voicelock_eligible(db: Session, project: Project, s: Shot) -> tuple[bool, str]:
    lines = shot_lines(s, project.primary_language)
    if not lines:
        return False, "no dialogue"
    if project.primary_language not in catalog.STS_LANGUAGES:
        return False, f"voice changer doesn't support {project.primary_language}"
    speakers = {str(l.get("character_id")) for l in lines}
    if len(speakers) != 1:
        return False, "more than one speaker in the shot"
    if not current(db, s.id, "video"):
        return False, "no video yet"
    return True, ""


def voicelock_specs(db: Session, project: Project, shots: list[Shot]) -> list[dict]:
    est = Estimator(db)
    return [spec("voicelock", payload={"language": project.primary_language}, project_id=project.id, episode_id=s.episode_id,
                 shot_id=s.id, estimate=est.voicelock(s), label=f"Voice lock {s.code}")
            for s in shots if voicelock_eligible(db, project, s)[0]]


def music_spec(db: Session, project: Project, episode: Episode, prompt: str = "", per_scene: bool = False,
               only_missing: bool = False) -> dict:
    """The episode's music: one score, or (per_scene) one piece per scene that follows its mood, all on one theme,
    priced a track each (only_missing: the scenes with no piece yet)."""
    if per_scene:
        todo = music_scenes(db, episode)
        if only_missing:
            have = scene_cue_ids(db, episode)
            todo = [(sc, secs) for sc, secs in todo if sc.id not in have]
        est = Estimator(db)
        return spec("music", payload={"prompt": prompt, "per_scene": True, "only_missing": only_missing,
                                      "scene_ids": [sc.id for sc, _ in todo]},
                    project_id=project.id, episode_id=episode.id, estimate=sum(est.music(secs) for _, secs in todo),
                    label=f"Music per scene E{episode.number:02} ({len(todo)} scene{'s' if len(todo) != 1 else ''})")
    total = sum(s.duration_s for s in episode_shots(db, episode))
    return spec("music", payload={"prompt": prompt}, project_id=project.id, episode_id=episode.id,
                estimate=Estimator(db).music(total), label=f"Music E{episode.number:02}")


def music_scenes(db: Session, episode: Episode) -> list[tuple[Any, float]]:
    """The scenes with shots in the cut, in order, each with its length (its shots' extend_to or duration)."""
    from ..models import Scene
    secs: dict[int, float] = {}
    for s in episode_shots(db, episode):
        if s.scene_id:
            secs[s.scene_id] = secs.get(s.scene_id, 0.0) + max(float(s.extend_to or 0), float(s.duration_s))
    rows = db.query(Scene).filter(Scene.id.in_(list(secs))).order_by(Scene.order, Scene.id).all() if secs else []
    return [(sc, secs[sc.id]) for sc in rows]


def scene_cue_ids(db: Session, episode: Episode) -> set[int]:
    """The scenes that already have a piece of music of their own (AudioAsset kind "music_scene")."""
    from ..models import AudioAsset
    rows = db.query(AudioAsset.params).filter(AudioAsset.episode_id == episode.id, AudioAsset.kind == "music_scene").all()
    return {int(p["scene_id"]) for (p,) in rows if isinstance(p, dict) and p.get("scene_id") is not None}


def music_per_scene_default(db: Session, episode: Episode) -> bool:
    """One piece per scene once the episode has two or more scenes with shots, unless it is already scored with one
    piece (Produce all then keeps that score instead of buying new music; ask for per-scene music to switch)."""
    from ..models import AudioAsset
    if len(music_scenes(db, episode)) < 2:
        return False
    scored = db.query(AudioAsset.id).filter(AudioAsset.episode_id == episode.id, AudioAsset.kind == "music").first()
    return (episode.settings or {}).get("music_mode") == "scenes" or scored is None


def music_step(db: Session, project: Project, episode: Episode, per_scene: bool | None = None) -> tuple[dict, int] | None:
    """Produce all's music step, only what is missing: a piece for each scene with none yet (per_scene), or the one
    score when there is none. (job spec, tracks) or None. One scene is one score: per_scene needs two or more."""
    from ..models import AudioAsset
    if per_scene is None or (per_scene and len(music_scenes(db, episode)) < 2):
        per_scene = music_per_scene_default(db, episode)
    if per_scene:
        sp = music_spec(db, project, episode, per_scene=True, only_missing=True)
        n = len(sp["payload"]["scene_ids"])
        return (sp, n) if n else None
    if db.query(AudioAsset.id).filter(AudioAsset.episode_id == episode.id, AudioAsset.kind == "music").first():
        return None
    return music_spec(db, project, episode), 1


def render_spec(project: Project, episode: Episode, lang: str, kind: str = "final", preset: str = "shorts",
                options: dict | None = None) -> dict:
    return spec("export" if kind == "final" else "animatic", payload={"language": lang, "preset": preset, "options": options or {}},
                project_id=project.id, episode_id=episode.id, estimate=0.0,
                label=f"{'Export' if kind == 'final' else 'Animatic'} E{episode.number:02} [{lang}] {preset}")


def dub_spec(db: Session, project: Project, episode: Episode, lang: str, then_export: str | None = None) -> dict:
    est = Estimator(db)
    total = 0.0
    for s in episode_shots(db, episode):
        lines = shot_lines(s, project.primary_language)
        if lines or (s.narration or {}).get(project.primary_language):
            total += est.voice(s, project.primary_language)  # similar length in target language
        if lines and current(db, s.id, "video"):
            total += est.lipsync(s)
    return spec("dub", payload={"language": lang, "then_export": then_export}, project_id=project.id, episode_id=episode.id,
                estimate=total, label=f"Dub E{episode.number:02} → {catalog.LANGUAGES.get(lang, {}).get('name', lang)}")


def _images_cost(db: Session, n: int, engine: str | None) -> float:
    """`n` character images: on the engine picked for the character, else the team's image chain (Google first)."""
    m = db.get(AIModel, engine) if engine else None
    return Estimator(db).image_engine(m, n) if m else Estimator(db).image(n)


def _on(engine: str | None) -> str:
    return f" on {engine.split(':', 1)[-1]}" if engine else ""


def _engine_for(ch: Character, engine: str | None) -> str | None:
    """The engine given, else the one remembered on the character (so the Director, the MCP tools and "build from
    script" make its images like the reference pack does); None = the team's image chain. A remembered engine that can
    no longer run fails the job with that reason: it is never swapped for another one."""
    return engine or (ch.sheet_engine or None)


def character_sheet_spec(db: Session, project_id: int | None, ch: Character, kinds: list[str] | None = None,
                         engine: str | None = None) -> dict:
    """`engine`: the character's own image engine (core/sheet_engine.resolve; default: the one remembered on it), used
    on its own route only."""
    kinds = kinds or ["front", "three_quarter", "profile", "back", "full_body"]
    engine = _engine_for(ch, engine)
    return spec("character_sheet", payload={"character_id": ch.id, "kinds": kinds, "project_id": project_id, "engine": engine},
                project_id=project_id, estimate=_images_cost(db, len(kinds), engine), label=f"Sheet: {ch.name}{_on(engine)}")


OUTFIT_VIEWS = ["front", "three_quarter", "full_body"]
LIGHTING_VARIANTS = ["day", "dusk", "night_interior"]


def outfit_spec(db: Session, project_id: int | None, ch: Character, name: str, description: str, episode_scope: int | None,
                views: list[str] | None = None, engine: str | None = None) -> dict:
    views = [v for v in (views or OUTFIT_VIEWS) if v in ("front", "three_quarter", "profile", "back", "full_body")] or OUTFIT_VIEWS
    engine = _engine_for(ch, engine)
    return spec("character_outfit", payload={"character_id": ch.id, "outfit": name, "description": description,
                                             "episode_scope": episode_scope, "project_id": project_id, "views": views,
                                             "engine": engine},
                project_id=project_id, estimate=_images_cost(db, len(views), engine),
                label=f"Outfit: {ch.name} – {name} ({len(views)} views){_on(engine)}")


def lighting_spec(db: Session, project_id: int | None, ch: Character, variants: list[str] | None = None,
                  engine: str | None = None) -> dict:
    variants = [v for v in (variants or LIGHTING_VARIANTS) if v in LIGHTING_VARIANTS] or LIGHTING_VARIANTS
    engine = _engine_for(ch, engine)
    return spec("character_lighting", payload={"character_id": ch.id, "project_id": project_id, "variants": variants,
                                               "engine": engine},
                project_id=project_id, estimate=_images_cost(db, len(variants), engine), label=f"Lighting: {ch.name}{_on(engine)}")


def native_video_specs(db: Session, project: Project, shots: list[Shot], lang: str) -> list[dict]:
    """Regenerate spoken shots with the line in `lang`: Veo speaks it, lips included (Google dubbing route)."""
    est = Estimator(db)
    return [spec("video", payload={"language": lang, "native": True}, project_id=project.id, episode_id=s.episode_id,
                 shot_id=s.id, estimate=est.video(s, project), label=f"Speak {s.code} [{lang}]") for s in shots if shot_lines(s, lang)]


def expressions_spec(db: Session, project_id: int | None, ch: Character, engine: str | None = None) -> dict:
    engine = _engine_for(ch, engine)
    return spec("character_expressions", payload={"character_id": ch.id, "project_id": project_id, "engine": engine},
                project_id=project_id, estimate=_images_cost(db, 5, engine), label=f"Expressions: {ch.name}{_on(engine)}")


def board_split_spec(db: Session, project_id: int | None, ch: Character, asset_id: int, panels: int, find_boxes: bool) -> dict:
    """Label the panels of an uploaded character board with a vision model (and find them first when the layout isn't
    clean): one small call per step, the crops sent at most 640 px."""
    images = panels + (1 if find_boxes else 0) or 2
    return spec("board_split", payload={"character_id": ch.id, "asset_id": asset_id, "project_id": project_id,
                                        "find_boxes": find_boxes},
                project_id=project_id, estimate=Estimator(db).vision(images, calls=2 if find_boxes else 1),
                label=f"Split board: {ch.name}")


def sheet_board_spec(db: Session, project_id: int | None, ch: Character, engine: AIModel, panels: list[str],
                     outfit: dict | None = None, fill_missing: bool = True) -> dict:
    """A whole character board in one request (BytePlus Seedream group generation): priced per image asked for (BytePlus
    bills each image made; missing ones are made one by one on the same engine within the same estimate)."""
    return spec("sheet_board", payload={"character_id": ch.id, "project_id": project_id, "engine": engine.id,
                                        "panels": panels, "outfit": outfit or None, "fill_missing": fill_missing},
                project_id=project_id, estimate=Estimator(db).image_engine(engine, len(panels)),
                label=f"Full board in one go: {ch.name} ({len(panels)} images)")


def location_images_spec(db: Session, project_id: int | None, loc: Location, kinds: list[str] | None = None,
                         time_of_day: str = "") -> dict:
    kinds = kinds or ["wide", "medium"]
    return spec("location_images", payload={"location_id": loc.id, "kinds": kinds, "time_of_day": time_of_day,
                                            "project_id": project_id},
                project_id=project_id, estimate=Estimator(db).image(len(kinds)), label=f"Location: {loc.name}")


def voice_design_spec(db: Session, project_id: int | None, ch: Character, lang: str, provider: str, description: str = "") -> dict:
    return spec("voice_design", payload={"character_id": ch.id, "language": lang, "provider": provider,
                                         "description": description, "project_id": project_id},
                project_id=project_id, estimate=Estimator(db).voice_design(provider),
                label=f"Voice: {ch.name} [{lang}] via {provider}")


def voice_preview_spec(db: Session, vp: Any, text: str = "") -> dict:
    """A short sample of a voice profile (at least 80 characters are billed)."""
    est = Estimator(db)
    cost = float(est.prices["tts_per_1k_chars"].get(vp.provider, 0.05)) * max(len(text), 80) / 1000 if est._live(vp.provider) else 0
    return spec("voice_preview", payload={"voice_profile_id": vp.id, "text": text}, estimate=cost, label="Voice preview")


def omni_edit_spec(db: Session, project: Project, take: Take, instruction: str) -> dict:
    return spec("omni_edit", payload={"take_id": take.id, "instruction": instruction}, project_id=project.id,
                shot_id=take.shot_id, estimate=Estimator(db).omni(take.duration_s or 8), label=f"Edit take #{take.id}")


def extend_spec(db: Session, project: Project, shot: Shot, prompt: str) -> dict:
    est = Estimator(db)
    from . import model_hub
    q = "balanced" if (shot.quality_mode or project.quality_mode) == "saver" else (shot.quality_mode or project.quality_mode)
    first = model_hub.first_choice(db, "extend", ["extend"])  # extending always runs the "extend" engine chain
    cost = model_hub.price_for(first[0], seconds=7, resolution="720p") if first else 0.0
    return spec("video", payload={"quality": q, "extend": True, "prompt": prompt}, project_id=project.id,
                episode_id=shot.episode_id, shot_id=shot.id, estimate=cost, label=f"Extend {shot.code} +7s")


PRODUCE_STEPS = ["cast", "keyframes", "videos", "extend", "voices", "sound", "music", "export"]
PRODUCE_LABELS = {"cast": "Cast looks & voices", "keyframes": "Keyframes", "videos": "Videos", "extend": "Extensions",
                  "voices": "Voices & lip-sync", "sound": "Sound effects", "music": "Music", "export": "Final export"}


def cast_specs(db: Session, project: Project, shots: list[Shot]) -> list[dict]:
    """Reference pictures for whoever is in these shots and has none yet (a front and a three-quarter view), a wide
    view of every place they're set in that has none, and a designed voice for everyone who speaks and has none.
    Without them each clip invents its own face and set, and every unknown speaker gets the same stock voice."""
    from ..models import CharacterAsset, LocationAsset
    ids = list(dict.fromkeys(int(c) for s in shots for c in (s.characters or [])))
    rows = {c.id: c for c in db.query(Character).filter(Character.id.in_(ids), Character.archived.is_(False)).all()} if ids else {}
    out = []
    for cid in ids:
        ch = rows.get(cid)
        if ch and not db.query(CharacterAsset.id).filter(CharacterAsset.character_id == ch.id,
                                                         CharacterAsset.archived.is_(False)).first():
            out.append(character_sheet_spec(db, project.id, ch, ["front", "three_quarter"]))
    loc_ids = list(dict.fromkeys(s.location_id for s in shots if s.location_id))
    locs = {l.id: l for l in db.query(Location).filter(Location.id.in_(loc_ids)).all()} if loc_ids else {}
    for lid in loc_ids:
        loc = locs.get(lid)
        if loc and not db.query(LocationAsset.id).filter(LocationAsset.location_id == loc.id,
                                                         LocationAsset.archived.is_(False)).first():
            out.append(location_images_spec(db, project.id, loc, ["wide"]))
    return out + cast_voice_specs(db, project, shots)


def cast_voice_specs(db: Session, project: Project, shots: list[Shot]) -> list[dict]:
    """A designed voice (from the character's age, gender and look) for each on-screen speaker in the film's language
    who has none: a Gemini or ElevenLabs voice made for another language is reused (pipeline/voice.voice_for)."""
    from .. import settings_store
    from ..models import VoiceProfile
    lang = project.primary_language
    provider = (settings_store.get_setting(db, "tts_provider_by_language") or {}).get(lang, "gemini")
    out = []
    for cid in dict.fromkeys(int(l["character_id"]) for s in shots for l in shot_lines(s, lang)
                             if str(l.get("character_id")).isdigit()):
        ch = db.get(Character, cid)
        if ch is None or ch.archived:
            continue
        has = db.query(VoiceProfile.id).filter(VoiceProfile.character_id == cid, VoiceProfile.voice_id != "",
                                               (VoiceProfile.language == lang)
                                               | VoiceProfile.provider.in_(("gemini", "elevenlabs"))).first()
        if not has:
            out.append(voice_design_spec(db, project.id, ch, lang, provider))
    return out


def sound_effects_ready() -> bool:
    """Sound effects can be made for real: an ElevenLabs key, or the whole studio on mock providers (tests, demos).
    With real providers and no ElevenLabs key the mock would save a placeholder tone as each shot's sound."""
    from ..config import get_settings
    from ..providers.services import provider_mode
    mode = provider_mode("elevenlabs")
    return mode == "live" or (mode == "mock" and get_settings().mock_providers == "true")


def needs_sfx(shots: list[Shot]) -> list[Shot]:
    return [s for s in shots if not (s.sfx_track or {}).get("path")]


def with_sound_notes(db: Session, shots: list[Shot]) -> list[Shot]:
    """The shots whose script names a sound: written effects of their own, or a sound note on their scene (what the
    free sound library, pipeline/sfx_library.py, makes its effects from)."""
    from ..models import Scene
    ids = {s.scene_id for s in shots if s.scene_id}
    sound = {sc.id: sc.sound for sc in db.query(Scene).filter(Scene.id.in_(ids)).all()} if ids else {}
    return [s for s in shots if (s.sfx or "").strip() or (sound.get(s.scene_id) or "").strip()]


def sound_step(db: Session, project: Project, episode: Episode, shots: list[Shot]) -> tuple[dict, int] | None:
    """Produce all's (and Autopilot's) sound step, only the shots with no effects yet: made with ElevenLabs when it is
    connected, else free from the bundled library for the shots whose script names a sound. (job spec, shots) or None."""
    quiet = needs_sfx(shots)
    if not sound_effects_ready():
        quiet = with_sound_notes(db, quiet)
    if not quiet:
        return None
    return sfx_spec(db, project, episode, [s.id for s in quiet], only_missing=True), len(quiet)


LIPSYNC_MISSING = ("No lip-sync engine is connected: the voices will be laid over the clips and the lips won't match. "
                   "Connect one in Model Hub, or let Veo speak the lines (Settings → dialogue route).")


def lipsync_ready(db: Session) -> bool:
    """A live lip-sync engine is connected (or the whole studio runs on mock providers: tests, demos). Without one the
    lip-sync jobs make placeholders and the export lays the voices over the clips."""
    from ..config import get_settings
    from ..providers.services import provider_mode
    from . import model_hub
    if get_settings().mock_providers == "true":
        return True
    return any(provider_mode(m.provider) == "live" for m, _ in model_hub.candidates(db, "lipsync", ["lipsync"]))


def lipsync_warnings(db: Session, syncing: list) -> list[str]:
    """What the cost dialog says before shots are paid for and lip-synced with no engine to do it."""
    return [LIPSYNC_MISSING] if syncing and not lipsync_ready(db) else []


def extensions_needed(db: Session, shot: Shot) -> int:
    """How many ~7 s extensions it takes to bring this shot up to its extend_to length."""
    if not shot.extend_to:
        return 0
    vid = current(db, shot.id, "video")
    have = (vid.duration_s if vid and vid.duration_s else shot.duration_s) or shot.duration_s
    gap = shot.extend_to - have
    return max(0, -(-int(gap) // 7)) if gap > 1 else 0


def produce_plan(db: Session, project: Project, episode: Episode, shots: list[Shot], steps: list[str],
                 quality: str | None = None, lang: str | None = None, link_scenes: str = "never",
                 music_per_scene: bool | None = None) -> tuple[float, list[dict]]:
    """Cost of Produce all, step by step (only what is still missing). Returns (total, items for the cost dialog).
    link_scenes "auto": a scene that picks up straight from the one before will start from its last frame (made in the
    run, see workers/handlers_room.produce), so that first shot's keyframe is counted with its video, not twice.
    music_per_scene: one piece of music per scene (None: music_per_scene_default)."""
    lang = lang or project.primary_language
    est = Estimator(db)
    items: list[dict] = []
    planned = links.planned_links(db, shots, link_scenes)
    # (only when this run also makes the videos: keyframes alone, for a storyboard, are all made)
    waiting = {s.id for s in shots if "videos" in steps and links.waits_for_clip(db, s, planned)}

    def add(step: str, n: int, usd: float) -> None:
        if n:
            items.append({"label": f"{PRODUCE_LABELS[step]} · {n}", "usd": round(usd, 4)})

    if "cast" in steps:
        cs = cast_specs(db, project, shots)
        add("cast", len(cs), sum(s["estimate"] for s in cs))
    if "keyframes" in steps:  # (a shot that starts from a clip not made yet gets its keyframe with its video)
        ks = keyframe_specs(db, project, [s for s in shots if s.id not in waiting], only_missing=True)
        add("keyframes", len(ks), sum(s["estimate"] for s in ks))
    if "videos" in steps:
        vs = video_specs(db, project, shots, quality, only_missing=True)
        if "keyframes" in steps:  # the missing keyframe is already counted above
            no_kf = {s.id for s in shots if not current(db, s.id, "keyframe") and s.id not in waiting}
            vs = [{**s, "estimate": max(0.0, s["estimate"] - (est.image(1) if s["shot_id"] in no_kf else 0))} for s in vs]
        add("videos", len(vs), sum(s["estimate"] for s in vs))
    if "extend" in steps:
        n, usd = 0, 0.0
        for s in shots:
            k = extensions_needed(db, s)
            if k:
                n += k
                usd += k * extend_spec(db, project, s, "")["estimate"]
        add("extend", n, usd)
    if "voices" in steps:
        need = [s for s in shots if Estimator.needs_lipsync(s, project, lang) and not has_fresh(db, s.id, "lipsync", lang)]
        narr = [s for s in shots if (s.narration or {}).get(lang) and s not in need and not current(db, s.id, "narration", lang)]
        cost = sum(est.lipsync(s) + est.voice(s, lang) for s in need) + sum(est.voice(s, lang) for s in narr)
        add("voices", len(need) + len(narr), cost)
    if "sound" in steps and (snd := sound_step(db, project, episode, shots)):
        add("sound", snd[1], snd[0]["estimate"])
    if "music" in steps and (mus := music_step(db, project, episode, music_per_scene)):
        add("music", mus[1], mus[0]["estimate"])
    if "export" in steps:
        add("export", 1, 0.0)
    return round(sum(i["usd"] for i in items), 2), items


def autopilot_estimate(db: Session, project: Project, episode: Episode) -> float:
    """Rough upper estimate used for the single Autopilot budget gate."""
    est = Estimator(db)
    shots = episode_shots(db, episode)
    n_shots = max(len(shots), int(max((project.brief or {}).get("duration_s") or 45, 8) / 7))
    per_shot_video = est.prices["video_per_second"].get(est.models[catalog.QUALITY_MODES[project.quality_mode]["model_key"]], {})
    v = float(per_shot_video.get(catalog.QUALITY_MODES[project.quality_mode]["resolution"], 0.1)) if est._live("gemini") else 0.0
    total = n_shots * (est.image(1) + v * 7 * 1.3)
    total += est.image(4) * 3 + est.music(n_shots * 7)
    if est._live("sync"):
        total += n_shots * 0.5 * 7 * float(est.prices["lipsync_per_second"].get("lipsync-2", 0.05))
    return round(total, 2)


def summary_for(specs: list[dict]) -> dict[str, Any]:
    return {"count": len(specs), "total_usd": round(sum(s["estimate"] for s in specs), 4),
            "items": [{"label": s["label"], "usd": s["estimate"]} for s in specs]}


# ── v2: hub, writers' room, growth ───────────────────────────────────────────

def shootout_specs(db: Session, project: Project, shot: Shot, engine_ids: list[str]) -> list[dict]:
    est = Estimator(db)
    out = []
    for eid in engine_ids[:4]:
        out.append(spec("video", payload={"engine": eid, "shootout": True}, project_id=project.id, episode_id=shot.episode_id,
                        shot_id=shot.id, estimate=est.engine_video(shot, project, eid), label=f"Shootout {shot.code}: {eid.split(':', 1)[-1]}"))
    return out


def sfx_spec(db: Session, project: Project, episode: Episode, shot_ids: list[int] | None = None,
             only_missing: bool = False, free: bool | None = None) -> dict:
    """free: the bundled library instead of ElevenLabs (no cost); by default when ElevenLabs isn't connected."""
    free = not sound_effects_ready() if free is None else free
    shots = episode_shots(db, episode, shot_ids)
    n = len(needs_sfx(shots) if only_missing else shots)
    est = 0.002 * 6 * n if Estimator(db)._live("elevenlabs") and not free else 0.0
    return spec("sfx", payload={"shot_ids": shot_ids, "only_missing": only_missing, "free": free}, project_id=project.id,
                episode_id=episode.id, estimate=est,
                label=f"Sound design E{episode.number:02}" + (" (free library)" if free else ""))


def marketing_spec(db: Session, project: Project, episode: Episode, platforms: list[str] | None = None,
                   languages: list[str] | None = None) -> dict:
    return spec("marketing", payload={"platforms": platforms, "languages": languages}, project_id=project.id,
                episode_id=episode.id, estimate=Estimator(db).image(3), label=f"Marketing pack E{episode.number:02}")


def critic_spec(project: Project, episode: Episode, rounds: int | None = None) -> dict:
    return spec("critic_loop", payload={"rounds": rounds}, project_id=project.id, episode_id=episode.id, estimate=0.0,
                label=f"Critic loop E{episode.number:02}")


def table_read_spec(db: Session, project: Project, episode: Episode, lang: str) -> dict:
    chars = sum(len(l.get("line", "")) for sc in (episode.script or {}).get("scenes", []) for l in sc.get("lines", []))
    est = Estimator(db)
    prov = est.tts_provider(lang)
    cost = float(est.prices["tts_per_1k_chars"].get(prov, 0.05)) * chars / 1000 if est._live(prov) else 0.0
    return spec("table_read", payload={"language": lang}, project_id=project.id, episode_id=episode.id, estimate=cost,
                label=f"Table read E{episode.number:02} [{lang}]")


def train_identity_spec(db: Session, project_id: int | None, ch: Character) -> dict:
    live = Estimator(db)._live("fal")
    return spec("train_identity", payload={"character_id": ch.id, "project_id": project_id}, project_id=project_id,
                estimate=(3.0 + Estimator(db).image(8)) if live else 0.0, label=f"Train identity: {ch.name}")


def byteplus_register_spec(project_id: int | None, ch: Character) -> dict:
    return spec("byteplus_register", payload={"character_id": ch.id, "project_id": project_id}, project_id=project_id,
                estimate=0.0, label=f"Register {ch.name} with BytePlus")


def identity_variations_spec(db: Session, project_id: int | None, ch: Character, count: int) -> dict:
    return spec("identity_variations", payload={"character_id": ch.id, "count": count, "project_id": project_id},
                project_id=project_id, estimate=Estimator(db).image(count), label=f"Variations of {ch.name}'s photo ×{count}")


def search_index_spec(project: Project) -> dict:
    return spec("search_index", payload={}, project_id=project.id, estimate=0.0, label="Search index")
