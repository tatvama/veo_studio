"""Deterministic prompt compiler + reference picker (PLAN §5.2–5.4).

The LLM only writes the shot-specific parts (framing, camera, action, dialogue, sfx).
Style, location and character DNA come from the Bible word-for-word, so characters don't drift.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from .. import catalog
from ..models import Character, CharacterAsset, Episode, Location, LocationAsset, Project, Shot, Style
from ..storage import get_storage

# "source" = a photo the user uploaded. When approved it is the truth about the character's look, so it comes first.
CHAR_REF_ORDER = ["source", "front", "three_quarter", "full_body", "profile", "outfit", "expression"]
LOC_REF_ORDER = ["wide", "medium", "source", "detail"]


def effective_quality(shot: Shot, project: Project) -> str:
    q = shot.quality_mode or project.quality_mode or "saver"
    return q if q in catalog.QUALITY_MODES else "saver"


def shot_lines(shot: Shot, lang: str) -> list[dict]:
    return list((shot.dialogue or {}).get(lang) or [])


_method_cache: dict[str, Any] = {"at": 0.0, "value": "audio_first", "v": -1}


def team_dialogue_method() -> str:
    """Team default for dialogue shots (Settings → Generation): audio_first | audio_driven | voice_lock."""
    from .. import settings_store
    now = time.time()
    if now - _method_cache["at"] > 30 or _method_cache["v"] != settings_store.VERSION["n"]:
        from ..db import SessionLocal
        with SessionLocal() as db:
            _method_cache["value"] = settings_store.get_setting(db, "dialogue_method") or "audio_first"
        _method_cache["at"], _method_cache["v"] = now, settings_store.VERSION["n"]
    return _method_cache["value"]


def effective_voice_mode(shot: Shot, project: Project, lang: str | None = None) -> str:
    lang = lang or project.primary_language
    if shot.voice_mode and shot.voice_mode != "auto":
        return shot.voice_mode
    has_lines = bool(shot_lines(shot, project.primary_language) or shot_lines(shot, lang))
    has_narr = bool((shot.narration or {}).get(project.primary_language) or (shot.narration or {}).get(lang))
    if not has_lines:
        return "narration" if has_narr else "none"
    method = (project.brief or {}).get("dialogue_method") or team_dialogue_method()
    if method == "auto" or not method:
        method = "audio_first"
    if method == "native_when_possible" or (
            method == "audio_first" and project.type in ("short", "ad") and project.primary_language == "en"
            and len(project.languages or []) <= 1):
        return "native" if project.primary_language == "en" else "audio_first"
    return method if method in ("audio_first", "audio_driven", "voice_lock", "native") else "audio_first"


def _chars(db: Session, shot: Shot) -> list[Character]:
    ids = [int(i) for i in (shot.characters or [])]
    if not ids:
        return []
    rows = {c.id: c for c in db.query(Character).filter(Character.id.in_(ids)).all()}
    return [rows[i] for i in ids if i in rows]


def _style(db: Session, project: Project) -> Style | None:
    return db.get(Style, project.style_id) if project.style_id else None


def _outfit_text(db: Session, ch: Character, outfit: str | None, episode_no: int | None) -> str:
    if not outfit:
        return ""
    a = (db.query(CharacterAsset)
         .filter(CharacterAsset.character_id == ch.id, CharacterAsset.kind == "outfit", CharacterAsset.outfit == outfit,
                 CharacterAsset.archived.is_(False))
         .order_by(CharacterAsset.approved.desc(), CharacterAsset.id.desc()).first())
    desc = (a.prompt.split("OUTFIT:", 1)[-1].strip() if a and "OUTFIT:" in a.prompt else outfit)
    return f" In this scene {ch.name} wears: {desc}."


def _scene(db: Session, shot: Shot):
    from ..models import Scene
    return db.get(Scene, shot.scene_id) if shot.scene_id else None


def character_block(db: Session, shot: Shot, episode: Episode | None) -> str:
    parts = []
    scene = _scene(db, shot)
    wardrobe = (scene.wardrobe or {}) if scene else {}
    for ch in _chars(db, shot):
        dna = (ch.dna_text or ch.name).strip()
        outfit = (shot.outfits or {}).get(str(ch.id))
        extra = _outfit_text(db, ch, outfit, episode.number if episode else None)
        if not outfit and wardrobe.get(str(ch.id)):
            extra = f" In this scene {ch.name} wears: {wardrobe[str(ch.id)]}."
        parts.append(dna + extra)
    return " ".join(parts)


def continuity_block(db: Session, shot: Shot) -> str:
    scene = _scene(db, shot)
    if not scene:
        return ""
    bits = []
    if scene.props:
        bits.append("props present: " + ", ".join(scene.props))
    if scene.continuity_notes:
        bits.append(scene.continuity_notes)
    if scene.blocking:
        bits.append("blocking: " + scene.blocking)
    return "; ".join(bits)


def name_of(db: Session, character_id) -> str:
    if character_id in (None, "", "NARRATOR"):
        return "Narrator"
    ch = db.get(Character, int(character_id)) if str(character_id).isdigit() else None
    return ch.name if ch else str(character_id)


def compile_video_prompt(db: Session, shot: Shot, project: Project, lang: str | None = None) -> str:
    lang = lang or project.primary_language
    episode = db.get(Episode, shot.episode_id)
    style = _style(db, project)
    loc = db.get(Location, shot.location_id) if shot.location_id else None
    vm = effective_voice_mode(shot, project, lang)
    out: list[str] = []
    if style:
        out.append(f"[STYLE] {style.look}. {style.lens}. {style.grade}. {style.grain}.".replace("..", "."))
    if loc:
        out.append(f"[LOCATION] {loc.description_text}")
    cb = character_block(db, shot, episode)
    if cb:
        out.append(f"[CHARACTERS] {cb}")
    shot_txt = ". ".join(x for x in [shot.framing, shot.camera, shot.action] if x)
    out.append(f"[SHOT] {shot_txt}.".replace("..", "."))
    cont = continuity_block(db, shot)
    if cont:
        out.append(f"[CONTINUITY] {cont}.")
    lines = shot_lines(shot, lang) or shot_lines(shot, project.primary_language)
    if lines:
        if vm == "native":
            said = " ".join(f'{name_of(db, l.get("character_id"))} says{(" " + l["emotion"]) if l.get("emotion") else ""}, "{l["line"]}"'
                            for l in lines)
            out.append(f"[DIALOGUE] {said}")
        elif vm in ("audio_first", "voice_lock", "audio_driven"):
            speakers = sorted({name_of(db, l.get("character_id")) for l in lines})
            if vm == "voice_lock" and lang == "en":
                said = " ".join(f'{name_of(db, l.get("character_id"))} says, "{l["line"]}"' for l in lines)
                out.append(f"[DIALOGUE] {said}")
            else:
                out.append(f"[DIALOGUE] {', '.join(speakers)} speaks naturally to camera-side, clear visible lip movement, "
                           f"facing the camera, mouth unobstructed.")
    audio = ", ".join(x for x in [shot.sfx, shot.music_cue] if x)
    if vm in ("audio_first", "narration", "audio_driven"):
        audio = (audio + ", " if audio else "") + "no background music, no narration"
    if audio:
        out.append(f"[AUDIO] {audio}.")
    avoid = (style.avoid_list if style else "subtitles, on-screen text, extra people, warped hands")
    out.append(f"[AVOID] {avoid}.")
    return "\n".join(out)


def negative_prompt(project: Project, db: Session) -> str:
    style = _style(db, project)
    return style.avoid_list if style and style.avoid_list else "subtitles, on-screen text, watermark, extra people, distorted hands"


# ── references ───────────────────────────────────────────────────────────────

def character_refs(db: Session, ch: Character, outfit: str | None = None, max_n: int = 2) -> list[CharacterAsset]:
    q = (db.query(CharacterAsset)
         .filter(CharacterAsset.character_id == ch.id, CharacterAsset.archived.is_(False))
         .order_by(CharacterAsset.approved.desc(), CharacterAsset.id.desc()).all())
    picked: list[CharacterAsset] = []
    if outfit:
        picked += [a for a in q if a.kind == "outfit" and a.outfit == outfit][:1]
    # the user's own approved photos come first, in upload order (the first one is their main photo)
    own = sorted((a for a in q if a.kind == "source" and a.approved), key=lambda a: a.id)
    picked += own[: max(max_n - len(picked), 0)]
    for kind in CHAR_REF_ORDER:
        if kind == "source":
            continue
        for a in q:
            if a.kind == kind and a not in picked and (a.kind != "outfit" or not outfit) and (kind != "source" or a.approved):
                picked.append(a)
                break
        if len(picked) >= max_n:
            break
    return picked[:max_n]


def location_ref(db: Session, location_id: int | None, time_of_day: str = "") -> LocationAsset | None:
    if not location_id:
        return None
    q = (db.query(LocationAsset).filter(LocationAsset.location_id == location_id, LocationAsset.archived.is_(False))
         .order_by(LocationAsset.approved.desc(), LocationAsset.id.desc()).all())
    if time_of_day:
        for a in q:
            if a.time_of_day == time_of_day:
                return a
    for kind in LOC_REF_ORDER:
        for a in q:
            if a.kind == kind:
                return a
    return q[0] if q else None


def shot_refs(shot: Shot) -> list[tuple[str, Path]]:
    """References the user attached to this shot (a product, a prop, a look), in their order."""
    st = get_storage()
    out = []
    for r in shot.ref_images or []:
        p = st.abs(r.get("path", "")) if r.get("path") else None
        if p and p.exists():
            out.append((f"reference: {r.get('label') or 'object in this shot'}", p))
    return out


def video_refs(db: Session, shot: Shot) -> list[tuple[str, Path]]:
    """Up to 3 refs for Veo reference-to-video: per PLAN §5.2, plus the shot's own references."""
    st = get_storage()
    chars = _chars(db, shot)
    refs: list[tuple[str, Path]] = []
    per_char = 2 if len(chars) == 1 else 1
    for ch in chars[:2]:
        for a in character_refs(db, ch, (shot.outfits or {}).get(str(ch.id)), per_char):
            refs.append((f"{ch.name} ({a.kind})", st.abs(a.path)))
    refs = refs[: 3 - min(len(shot_refs(shot)), 1)] + shot_refs(shot)  # keep room for at least one shot reference
    la = location_ref(db, shot.location_id)
    if la and len(refs) < 3:
        refs.append(("location", st.abs(la.path)))
    return [(lbl, p) for lbl, p in refs if p.exists()][:3]


def keyframe_refs(db: Session, shot: Shot, continuity_frame: Path | None) -> list[tuple[str, Path]]:
    """Characters first (their look is what must match), then the shot's own references, the location, and last the
    previous shot's frame, which is only for lighting and positions."""
    st = get_storage()
    limit = 8
    own = shot_refs(shot)  # always kept: the user attached them so the keyframe follows them
    la = location_ref(db, shot.location_id)
    loc = [("location reference", st.abs(la.path))] if la and st.abs(la.path).exists() else []
    chars = _chars(db, shot)[:4]
    room = max(limit - len(own) - len(loc), len(chars))  # every character keeps at least one reference
    per_char = 2 if chars and room >= 2 * len(chars) else 1
    refs: list[tuple[str, Path]] = []
    for ch in chars:
        for a in character_refs(db, ch, (shot.outfits or {}).get(str(ch.id)), per_char):
            kind = "your photo" if a.kind == "source" else a.kind.replace("_", " ")
            p = st.abs(a.path)
            if p.exists():
                refs.append((f"{ch.name} — reference ({kind}): keep this exact face and look", p))
    refs += own
    if len(refs) < limit:
        refs += loc
    if continuity_frame and continuity_frame.exists() and len(refs) < limit:
        refs.append(("previous shot's last frame: match lighting, positions and props only — faces come from the character references",
                     continuity_frame))
    return refs[:limit]


def compile_keyframe_prompt(db: Session, shot: Shot, project: Project, ref_labels: list[str]) -> str:
    episode = db.get(Episode, shot.episode_id)
    style = _style(db, project)
    loc = db.get(Location, shot.location_id) if shot.location_id else None
    parts = [f"Create a single cinematic film still (keyframe) in {project.aspect} aspect ratio for an AI video."]
    if ref_labels:
        parts.append("Reference images, in order: " + "; ".join(f"Image {i + 1}: {l}" for i, l in enumerate(ref_labels)) + ".")
        parts.append("Keep every character's face, hair, skin tone and outfit EXACTLY as in their reference images.")
    if style:
        parts.append(f"Style: {style.look}; {style.lens}; {style.grade}; {style.grain}.")
    if loc:
        parts.append(f"Location: {loc.description_text}")
    cb = character_block(db, shot, episode)
    if cb:
        parts.append(f"Characters: {cb}")
    parts.append(f"Shot: {shot.framing}. {shot.action}".strip())
    cont = continuity_block(db, shot)
    if cont:
        parts.append(f"Continuity: {cont}.")
    lines = shot_lines(shot, project.primary_language)
    if lines:
        parts.append("The speaking character is mid-sentence with lips slightly parted, facing camera-side.")
    parts.append(f"No text, no subtitles, no watermark. Avoid: {style.avoid_list if style else 'extra people, warped hands'}.")
    return "\n".join(parts)
