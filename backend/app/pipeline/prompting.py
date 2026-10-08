"""Deterministic prompt compiler + reference picker (TATVAM_PLAN sections 3, 6 and 7).

The LLM only writes the shot-specific parts (framing, camera, action, dialogue, sfx). Style, location and character
DNA come from the Bible word-for-word, so characters do not drift. The Character Lock adds its constraints, the
character version for this episode replaces the DNA when one applies, and the Continuity Bible carries the state of
the previous scene into every prompt.

Dialogue follows the shape that Veo keeps best: the line sits right after the shot, attribution first, in the
language's own script, with the character's voice description, one speaker per clip.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from .. import catalog
from ..core import lock as lock_core
from ..models import Character, CharacterAsset, CharacterVersion, Episode, Location, LocationAsset, Project, Prop, Shot, Style
from ..storage import get_storage

# "source" = a photo the user uploaded. When approved it is the truth about the character's look, so it comes first.
CHAR_REF_ORDER = ["source", "front", "three_quarter", "full_body", "profile", "back", "outfit", "expression"]
LOC_REF_ORDER = ["wide", "medium", "source", "detail"]
MAX_WORDS_PER_CLIP = {4: 10, 6: 16, 8: 22}  # a line longer than this is rushed or cut off by the engine


def effective_quality(shot: Shot, project: Project) -> str:
    q = shot.quality_mode or project.quality_mode or "saver"
    return q if q in catalog.QUALITY_MODES else "saver"


def shot_lines(shot: Shot, lang: str) -> list[dict]:
    return list((shot.dialogue or {}).get(lang) or [])


_settings_cache: dict[str, Any] = {"at": 0.0, "v": -1, "values": {}}
_TEAM_KEYS = ("dialogue_method", "native_dialogue_languages")


def team_setting(key: str) -> Any:
    """A team setting read at most every 30 s (and immediately after a change) from inside the pipeline."""
    from .. import settings_store
    now = time.time()
    if now - _settings_cache["at"] > 30 or _settings_cache["v"] != settings_store.VERSION["n"]:
        from ..db import SessionLocal
        with SessionLocal() as db:
            _settings_cache["values"] = {k: settings_store.get_setting(db, k) for k in _TEAM_KEYS}
        _settings_cache["at"], _settings_cache["v"] = now, settings_store.VERSION["n"]
    return _settings_cache["values"].get(key)


def team_dialogue_method() -> str:
    """Team default for dialogue shots (Settings): audio_first | audio_driven | voice_lock | native | native_when_possible."""
    return team_setting("dialogue_method") or "audio_first"


def native_languages(project: Project | None = None) -> set[str]:
    """Languages Veo may speak itself. The project brief can narrow or widen the team list."""
    langs = (project.brief or {}).get("native_languages") if project else None
    if langs is None:
        langs = team_setting("native_dialogue_languages") or ["en"]
    return {str(x) for x in langs}


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
    native_ok = lang in native_languages(project)
    if method in ("native", "native_when_possible"):
        return "native" if native_ok else "audio_first"
    if method == "audio_first" and project.type in ("short", "ad") and len(project.languages or []) <= 1 and native_ok:
        return "native"  # a one-language short or ad: the cheapest route, speech and lips in one pass
    return method if method in ("audio_first", "audio_driven", "voice_lock") else "audio_first"


# ── characters, versions and locks ───────────────────────────────────────────

def version_for(db: Session, ch: Character, episode_no: int | None) -> CharacterVersion | None:
    """The frozen look that applies to this episode number, if the character has one for it."""
    if episode_no is None:
        return None
    rows = db.query(CharacterVersion).filter(CharacterVersion.character_id == ch.id).order_by(CharacterVersion.version.desc()).all()
    for v in rows:
        lo, hi = v.episode_from, v.episode_to
        if (lo is None or episode_no >= lo) and (hi is None or episode_no <= hi):
            return v
    return None


def look_of(db: Session, ch: Character, episode_no: int | None) -> dict[str, Any]:
    """DNA, voice description, lock and identity for a character in an episode (version-aware)."""
    v = version_for(db, ch, episode_no)
    return {"dna": (v.dna_text if v and v.dna_text else ch.dna_text) or ch.name,
            "voice": (v.voice_description if v and v.voice_description else ch.voice_description) or "",
            "lock": lock_core.effective(ch, v.lock if v else None),
            "identity": (v.identity if v and v.identity else ch.identity) or {},
            "asset_ids": list(v.asset_ids or []) if v else [], "version": v}


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
    from ..models import Costume
    c = (db.query(Costume).filter(Costume.character_id == ch.id, Costume.name == outfit, Costume.archived.is_(False)).first())
    if c and c.description:
        return f" In this scene {ch.name} wears: {c.description}."
    a = (db.query(CharacterAsset)
         .filter(CharacterAsset.character_id == ch.id, CharacterAsset.kind == "outfit", CharacterAsset.outfit == outfit,
                 CharacterAsset.archived.is_(False))
         .order_by(CharacterAsset.approved.desc(), CharacterAsset.id.desc()).first())
    desc = (a.prompt.split("OUTFIT:", 1)[-1].strip() if a and "OUTFIT:" in a.prompt else outfit)
    return f" In this scene {ch.name} wears: {desc}."


def _scene(db: Session, shot: Shot):
    from ..models import Scene
    return db.get(Scene, shot.scene_id) if shot.scene_id else None


def outfit_for(db: Session, shot: Shot, ch: Character) -> str:
    """The outfit a character wears in this shot: the shot's own pick, else the scene wardrobe, else the default costume."""
    o = (shot.outfits or {}).get(str(ch.id))
    if o:
        return o
    scene = _scene(db, shot)
    if scene and (scene.wardrobe or {}).get(str(ch.id)):
        return scene.wardrobe[str(ch.id)]
    from ..models import Costume
    c = db.query(Costume).filter(Costume.character_id == ch.id, Costume.is_default.is_(True), Costume.archived.is_(False)).first()
    return c.name if c else ""


def character_block(db: Session, shot: Shot, episode: Episode | None) -> str:
    parts = []
    episode_no = episode.number if episode else None
    for ch in _chars(db, shot):
        look = look_of(db, ch, episode_no)
        dna = look["dna"].strip()
        outfit = outfit_for(db, shot, ch)
        extra = _outfit_text(db, ch, outfit, episode_no)
        parts.append(dna + extra + lock_core.prompt_text(ch, look["lock"]))
    return " ".join(parts)


def props_text(db: Session, shot: Shot) -> str:
    scene = _scene(db, shot)
    ids = [int(x) for x in (shot.prop_ids or [])] or [int(x) for x in ((scene.prop_ids if scene else None) or [])]
    if not ids:
        return ""
    rows = db.query(Prop).filter(Prop.id.in_(ids), Prop.archived.is_(False)).all()
    return "; ".join(f"{p.name}" + (f" ({p.description})" if p.description else "") for p in rows)


def continuity_block(db: Session, shot: Shot) -> str:
    scene = _scene(db, shot)
    bits = []
    if scene:
        if scene.props:
            bits.append("props present: " + ", ".join(scene.props))
        pt = props_text(db, shot)
        if pt:
            bits.append("props: " + pt)
        if scene.continuity_notes:
            bits.append(scene.continuity_notes)
        if scene.blocking:
            bits.append("blocking: " + scene.blocking)
        from ..core import continuity
        st = continuity.state_text(db, scene)
        if st:
            bits.append("carried over from the previous scene: " + st)
    else:
        pt = props_text(db, shot)
        if pt:
            bits.append("props: " + pt)
    return "; ".join(bits)


def name_of(db: Session, character_id) -> str:
    if character_id in (None, "", "NARRATOR"):
        return "Narrator"
    ch = db.get(Character, int(character_id)) if str(character_id).isdigit() else None
    return ch.name if ch else str(character_id)


def speaker_label(db: Session, character_id, episode_no: int | None, with_voice: bool) -> str:
    """`Ravi (pronounced RAH-vee; voice: warm, low, calm)`: what Veo needs to pick a consistent voice."""
    if character_id in (None, "", "NARRATOR"):
        return "The narrator"
    ch = db.get(Character, int(character_id)) if str(character_id).isdigit() else None
    if not ch:
        return str(character_id)
    extras = []
    if ch.name_pronunciation:
        extras.append(f"pronounced {ch.name_pronunciation}")
    look = look_of(db, ch, episode_no)
    if with_voice and look["lock"].get("voice", True) and look["voice"]:
        extras.append(f"voice: {look['voice'].strip().rstrip('.')}")
    return ch.name + (f" ({'; '.join(extras)})" if extras else "")


def native_dialogue(db: Session, shot: Shot, lang: str, episode_no: int | None) -> str:
    """The [DIALOGUE] block for a clip that speaks for itself (Veo native speech)."""
    lines = shot_lines(shot, lang)
    lname = catalog.LANGUAGES.get(lang, {}).get("name", lang)
    said = []
    for l in lines:
        emo = f", {l['emotion']}" if l.get("emotion") else ""
        said.append(f'{speaker_label(db, l.get("character_id"), episode_no, True)} says in {lname}{emo}: "{l["line"]}"')
    return " ".join(said) + " Clear, natural speech; the words exactly as written; lips match the words."


def dialogue_warnings(shot: Shot, lang: str) -> list[str]:
    """Things that make Veo drop or rush a line: too many words for the clip, more than one speaker."""
    lines = shot_lines(shot, lang)
    out = []
    words = sum(len((l.get("line") or "").split()) for l in lines)
    cap = MAX_WORDS_PER_CLIP.get(int(shot.duration_s or 8), 22)
    if words > cap:
        out.append(f"{words} words in a {shot.duration_s}s clip; about {cap} fit. Split the shot or shorten the line.")
    speakers = {str(l.get("character_id")) for l in lines}
    if len(speakers) > 1:
        out.append("Two speakers in one clip: one speaker per shot keeps voices and lips reliable.")
    return out


def compile_video_prompt(db: Session, shot: Shot, project: Project, lang: str | None = None, voice_mode: str | None = None) -> str:
    lang = lang or project.primary_language
    episode = db.get(Episode, shot.episode_id)
    episode_no = episode.number if episode else None
    style = _style(db, project)
    loc = db.get(Location, shot.location_id) if shot.location_id else None
    vm = voice_mode or effective_voice_mode(shot, project, lang)
    out: list[str] = []
    shot_txt = ". ".join(x for x in [shot.framing, shot.camera, shot.action] if x)
    out.append(f"[SHOT] {shot_txt}.".replace("..", "."))
    lines = shot_lines(shot, lang) or shot_lines(shot, project.primary_language)
    use_lang = lang if shot_lines(shot, lang) else project.primary_language
    if lines:
        if vm == "native":
            out.append(f"[DIALOGUE] {native_dialogue(db, shot, use_lang, episode_no)}")
        elif vm in ("audio_first", "voice_lock", "audio_driven"):
            speakers = sorted({name_of(db, l.get("character_id")) for l in lines})
            if vm == "voice_lock" and use_lang == "en":
                said = " ".join(f'{name_of(db, l.get("character_id"))} says, "{l["line"]}"' for l in lines)
                out.append(f"[DIALOGUE] {said}")
            else:
                out.append(f"[DIALOGUE] {', '.join(speakers)} speaks naturally to camera-side, clear visible lip movement, "
                           f"facing the camera, mouth unobstructed.")
    cb = character_block(db, shot, episode)
    if cb:
        out.append(f"[CHARACTERS] {cb}")
    if loc:
        out.append(f"[LOCATION] {loc.description_text}")
    cont = continuity_block(db, shot)
    if cont:
        out.append(f"[CONTINUITY] {cont}.")
    if style:
        out.append(f"[STYLE] {style.look}. {style.lens}. {style.grade}. {style.grain}.".replace("..", "."))
    audio = ", ".join(x for x in [shot.sfx, shot.music_cue] if x)
    if vm in ("audio_first", "narration", "audio_driven"):
        audio = (audio + ", " if audio else "") + "no background music, no narration"
    if audio:
        out.append(f"[AUDIO] {audio}.")
    avoid = (style.avoid_list if style else "subtitles, on-screen text, extra people, warped hands")
    if "subtitles" not in avoid.lower():
        avoid = "subtitles, on-screen text, " + avoid
    out.append(f"[AVOID] {avoid}.")
    return "\n".join(out)


def negative_prompt(project: Project, db: Session) -> str:
    style = _style(db, project)
    return style.avoid_list if style and style.avoid_list else "subtitles, on-screen text, watermark, extra people, distorted hands"


# ── references ───────────────────────────────────────────────────────────────

def character_refs(db: Session, ch: Character, outfit: str | None = None, max_n: int = 2,
                   episode_no: int | None = None) -> list[CharacterAsset]:
    q = (db.query(CharacterAsset)
         .filter(CharacterAsset.character_id == ch.id, CharacterAsset.archived.is_(False))
         .order_by(CharacterAsset.approved.desc(), CharacterAsset.id.desc()).all())
    look = look_of(db, ch, episode_no) if episode_no is not None else None
    if look and look["asset_ids"]:  # a frozen version: only its own pack counts
        keep = set(int(x) for x in look["asset_ids"])
        q = [a for a in q if a.id in keep] or q
    picked: list[CharacterAsset] = []
    if outfit:
        # the outfit turnaround: front first, then another angle, so the clothes are seen from two sides
        outfit_assets = [a for a in q if a.kind == "outfit" and a.outfit == outfit]
        outfit_assets.sort(key=lambda a: (a.view != "front", a.view != "three_quarter", not a.approved, -a.id))
        picked += outfit_assets[: min(2, max_n)]
    # the user's own approved photos come first, in upload order (the first one is their main photo)
    own = sorted((a for a in q if a.kind == "source" and a.approved), key=lambda a: a.id)
    picked += [a for a in own if a not in picked][: max(max_n - len(picked), 0)]
    for kind in CHAR_REF_ORDER:
        if kind == "source":
            continue
        for a in q:
            if a.kind == kind and a not in picked and (a.kind != "outfit" or not outfit) and (kind != "source" or a.approved) \
                    and not a.lighting:  # lighting variants are picked by lighting, not as identity references
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


def prop_refs(db: Session, shot: Shot, limit: int = 2) -> list[tuple[str, Path]]:
    st = get_storage()
    scene = _scene(db, shot)
    ids = [int(x) for x in (shot.prop_ids or [])] or [int(x) for x in ((scene.prop_ids if scene else None) or [])]
    out: list[tuple[str, Path]] = []
    for p in (db.query(Prop).filter(Prop.id.in_(ids), Prop.archived.is_(False)).all() if ids else []):
        if p.path and st.exists(p.path):
            out.append((f"prop: {p.name}", st.abs(p.path)))
    return out[:limit]


def _episode_no(db: Session, shot: Shot) -> int | None:
    e = db.get(Episode, shot.episode_id)
    return e.number if e else None


def video_refs(db: Session, shot: Shot) -> list[tuple[str, Path]]:
    """Up to 3 refs for Veo reference-to-video, plus the shot's own references."""
    st = get_storage()
    chars = _chars(db, shot)
    ep_no = _episode_no(db, shot)
    refs: list[tuple[str, Path]] = []
    per_char = 2 if len(chars) == 1 else 1
    for ch in chars[:2]:
        for a in character_refs(db, ch, outfit_for(db, shot, ch), per_char, ep_no):
            refs.append((f"{ch.name} ({a.kind})", st.abs(a.path)))
    refs = refs[: 3 - min(len(shot_refs(shot)), 1)] + shot_refs(shot)  # keep room for at least one shot reference
    la = location_ref(db, shot.location_id)
    if la and len(refs) < 3:
        refs.append(("location", st.abs(la.path)))
    return [(lbl, p) for lbl, p in refs if p.exists()][:3]


def keyframe_refs(db: Session, shot: Shot, continuity_frame: Path | None) -> list[tuple[str, Path]]:
    """Characters first (their look is what must match), then the shot's own references, props, the location, and
    last the previous shot's frame, which is only for lighting and positions."""
    st = get_storage()
    limit = 8
    own = shot_refs(shot)  # always kept: the user attached them so the keyframe follows them
    la = location_ref(db, shot.location_id)
    loc = [("location reference", st.abs(la.path))] if la and st.abs(la.path).exists() else []
    chars = _chars(db, shot)[:4]
    ep_no = _episode_no(db, shot)
    room = max(limit - len(own) - len(loc), len(chars))  # every character keeps at least one reference
    refs: list[tuple[str, Path]] = []
    for ch in chars:
        look = look_of(db, ch, ep_no)
        per_char = lock_core.refs_per_char(look["lock"]) if chars and room >= 2 * len(chars) else 1
        for a in character_refs(db, ch, outfit_for(db, shot, ch), per_char, ep_no):
            kind = "your photo" if a.kind == "source" else a.kind.replace("_", " ")
            p = st.abs(a.path)
            if p.exists():
                refs.append((f"{ch.name} — reference ({kind}): keep this exact face and look", p))
    refs += own
    refs += prop_refs(db, shot)
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
