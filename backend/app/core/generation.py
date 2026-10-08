"""Builds job specs (with cost estimates) for every paid step. Shared by REST, agent and autopilot."""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from .. import catalog
from ..models import Character, Episode, Location, Project, Shot, Take
from ..pipeline.prompting import effective_voice_mode, shot_lines
from ..pipeline.selection import current, has_fresh, is_real
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
    est = Estimator(db)
    out = []
    for s in shots:
        if only_missing and is_real(current(db, s.id, "keyframe")):
            continue
        out.append(spec("keyframe", payload={"hero": hero}, project_id=project.id, episode_id=s.episode_id, shot_id=s.id,
                        estimate=est.image(1, hero), label=f"Keyframe {s.code}"))
    return out


def video_specs(db: Session, project: Project, shots: list[Shot], quality: str | None = None, only_missing: bool = False,
                mode: str | None = None) -> list[dict]:
    est = Estimator(db)
    out = []
    for s in shots:
        if only_missing and is_real(current(db, s.id, "video")):
            continue
        q = quality or s.quality_mode or project.quality_mode
        cost = est.video(s, project, q)
        if not current(db, s.id, "keyframe"):  # the video job makes the missing keyframe first
            cost += est.image(1)
        out.append(spec("video", payload={"quality": q, "mode": mode}, project_id=project.id, episode_id=s.episode_id,
                        shot_id=s.id, estimate=cost, label=f"Video {s.code} ({q})"))
    return out


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


def music_spec(db: Session, project: Project, episode: Episode, prompt: str = "") -> dict:
    total = sum(s.duration_s for s in episode_shots(db, episode))
    return spec("music", payload={"prompt": prompt}, project_id=project.id, episode_id=episode.id,
                estimate=Estimator(db).music(total), label=f"Music E{episode.number:02}")


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


def character_sheet_spec(db: Session, project_id: int | None, ch: Character, kinds: list[str] | None = None) -> dict:
    kinds = kinds or ["front", "three_quarter", "profile", "full_body"]
    return spec("character_sheet", payload={"character_id": ch.id, "kinds": kinds, "project_id": project_id},
                project_id=project_id, estimate=Estimator(db).image(len(kinds)), label=f"Sheet: {ch.name}")


def outfit_spec(db: Session, project_id: int | None, ch: Character, name: str, description: str, episode_scope: int | None) -> dict:
    return spec("character_outfit", payload={"character_id": ch.id, "outfit": name, "description": description,
                                             "episode_scope": episode_scope, "project_id": project_id},
                project_id=project_id, estimate=Estimator(db).image(1), label=f"Outfit: {ch.name} – {name}")


def expressions_spec(db: Session, project_id: int | None, ch: Character) -> dict:
    return spec("character_expressions", payload={"character_id": ch.id, "project_id": project_id}, project_id=project_id,
                estimate=Estimator(db).image(5), label=f"Expressions: {ch.name}")


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


PRODUCE_STEPS = ["keyframes", "videos", "extend", "voices", "music", "export"]
PRODUCE_LABELS = {"keyframes": "Keyframes", "videos": "Videos", "extend": "Extensions", "voices": "Voices & lip-sync",
                  "music": "Music", "export": "Final export"}


def extensions_needed(db: Session, shot: Shot) -> int:
    """How many ~7 s extensions it takes to bring this shot up to its extend_to length."""
    if not shot.extend_to:
        return 0
    vid = current(db, shot.id, "video")
    have = (vid.duration_s if vid and vid.duration_s else shot.duration_s) or shot.duration_s
    gap = shot.extend_to - have
    return max(0, -(-int(gap) // 7)) if gap > 1 else 0


def produce_plan(db: Session, project: Project, episode: Episode, shots: list[Shot], steps: list[str],
                 quality: str | None = None, lang: str | None = None) -> tuple[float, list[dict]]:
    """Cost of Produce all, step by step (only what is still missing). Returns (total, items for the cost dialog)."""
    lang = lang or project.primary_language
    est = Estimator(db)
    items: list[dict] = []

    def add(step: str, n: int, usd: float) -> None:
        if n:
            items.append({"label": f"{PRODUCE_LABELS[step]} · {n}", "usd": round(usd, 4)})

    if "keyframes" in steps:
        ks = keyframe_specs(db, project, shots, only_missing=True)
        add("keyframes", len(ks), sum(s["estimate"] for s in ks))
    if "videos" in steps:
        vs = video_specs(db, project, shots, quality, only_missing=True)
        if "keyframes" in steps:  # the missing keyframe is already counted above
            no_kf = {s.id for s in shots if not current(db, s.id, "keyframe")}
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
    if "music" in steps:
        from ..models import AudioAsset
        if not db.query(AudioAsset).filter(AudioAsset.episode_id == episode.id, AudioAsset.kind == "music").count():
            add("music", 1, est.music(sum(max(s.extend_to or 0, s.duration_s) for s in shots)))
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


def sfx_spec(db: Session, project: Project, episode: Episode, shot_ids: list[int] | None = None) -> dict:
    n = len(episode_shots(db, episode, shot_ids))
    est = 0.002 * 6 * n if Estimator(db)._live("elevenlabs") else 0.0
    return spec("sfx", payload={"shot_ids": shot_ids}, project_id=project.id, episode_id=episode.id, estimate=est,
                label=f"Sound design E{episode.number:02}")


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


def identity_variations_spec(db: Session, project_id: int | None, ch: Character, count: int) -> dict:
    return spec("identity_variations", payload={"character_id": ch.id, "count": count, "project_id": project_id},
                project_id=project_id, estimate=Estimator(db).image(count), label=f"Variations of {ch.name}'s photo ×{count}")


def search_index_spec(project: Project) -> dict:
    return spec("search_index", payload={}, project_id=project.id, estimate=0.0, label="Search index")
