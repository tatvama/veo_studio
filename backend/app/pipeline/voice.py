"""Voice selection and dialogue-track assembly (audio-first workflow, PLAN §6)."""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from .. import catalog, settings_store
from ..models import Character, Project, Shot, VoiceProfile
from . import ffmpeg as ff
from .prompting import shot_lines

MALE_DEFAULTS = ["Charon", "Orus", "Puck", "Fenrir", "Iapetus", "Algenib", "Alnilam", "Sadaltager"]
FEMALE_DEFAULTS = ["Kore", "Aoede", "Leda", "Despina", "Sulafat", "Achernar", "Vindemiatrix", "Autonoe"]


def _pick(pool: list[str], key: str) -> str:
    return pool[int(hashlib.sha1(key.encode()).hexdigest(), 16) % len(pool)]


def default_provider(db: Session, lang: str) -> str:
    return (settings_store.get_setting(db, "tts_provider_by_language") or {}).get(lang, "gemini")


def voice_for(db: Session, character_id: Any, lang: str, project: Project) -> dict[str, str]:
    """→ {provider, voice_id, style, source}"""
    if character_id in (None, "", "NARRATOR"):
        nar = (project.brief or {}).get("narrator") or {}
        return {"provider": nar.get("provider", "gemini"), "voice_id": nar.get("voice_id", "Charon"),
                "style": nar.get("style", "warm, clear storyteller"), "source": "narrator"}
    cid = int(character_id)
    vp = db.query(VoiceProfile).filter(VoiceProfile.character_id == cid, VoiceProfile.language == lang).first()
    if vp and vp.voice_id:
        return {"provider": vp.provider, "voice_id": vp.voice_id, "style": vp.style_prompt, "source": "profile"}
    # Same character in another language: Gemini/ElevenLabs custom voices are multilingual, so reuse them.
    other = (db.query(VoiceProfile).filter(VoiceProfile.character_id == cid, VoiceProfile.provider.in_(("gemini", "elevenlabs")))
             .order_by(VoiceProfile.id).first())
    if other and other.voice_id:
        return {"provider": other.provider, "voice_id": other.voice_id, "style": other.style_prompt, "source": "profile-other-lang"}
    ch = db.get(Character, cid)
    gender = (ch.gender if ch else "") or "male"
    provider = default_provider(db, lang)
    if provider == "sarvam":
        pool = catalog.SARVAM_SPEAKERS["female" if gender == "female" else "male"]
        return {"provider": "sarvam", "voice_id": _pick(pool, str(cid)), "style": "", "source": "default"}
    pool = FEMALE_DEFAULTS if gender == "female" else MALE_DEFAULTS
    return {"provider": "gemini", "voice_id": _pick(pool, str(cid)), "style": "", "source": "default"}


def choose_duration(dialogue_seconds: float) -> int:
    for d in (4, 6, 8):
        if dialogue_seconds + 0.6 <= d:
            return d
    return 8


def build_dialogue(ctx, db: Session, shot: Shot, project: Project, lang: str, out_dir: Path) -> dict[str, Any] | None:
    """TTS every on-screen line for this shot/language into one WAV. Returns {path, spans, duration, provider}."""
    lines = shot_lines(shot, lang)
    if not lines:
        return None
    parts: list[Path] = []
    meta: list[dict[str, Any]] = []
    providers = set()
    for i, l in enumerate(lines):
        v = voice_for(db, l.get("character_id"), lang, project)
        style = l.get("emotion") or v["style"]
        res = ctx.services.tts(v["provider"], l["line"], v["voice_id"], lang, style=style)
        ctx.cost(res.usage)
        p = out_dir / f"line_{i}.{res.ext}"
        p.write_bytes(res.data)
        parts.append(p)
        providers.add(v["provider"])
        meta.append({"text": l["line"], "character_id": l.get("character_id"), "voice": v})
    out = out_dir / f"dialogue_{lang}.wav"
    spans = ff.concat_audio_with_gaps(parts, out, gap=0.25, lead_in=0.3)
    for m, (s, e) in zip(meta, spans):
        m["start"], m["end"] = s, e
    return {"path": out, "spans": meta, "duration": ff.duration(out), "provider": ",".join(sorted(providers))}


def build_narration(ctx, db: Session, shot: Shot, project: Project, lang: str, out_dir: Path) -> dict[str, Any] | None:
    text = (shot.narration or {}).get(lang, "").strip()
    if not text:
        return None
    v = voice_for(db, "NARRATOR", lang, project)
    res = ctx.services.tts(v["provider"], text, v["voice_id"], lang, style=v["style"])
    ctx.cost(res.usage)
    raw = out_dir / f"narr_raw.{res.ext}"
    raw.write_bytes(res.data)
    out = out_dir / f"narration_{lang}.wav"
    spans = ff.concat_audio_with_gaps([raw], out, gap=0, lead_in=0.2)
    return {"path": out, "spans": [{"text": text, "character_id": "NARRATOR", "start": spans[0][0], "end": spans[0][1],
                                     "voice": v}], "duration": ff.duration(out), "provider": v["provider"]}
