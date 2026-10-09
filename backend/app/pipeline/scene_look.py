"""Scene continuity: one look per scene, an anchor keyframe the other shots follow, and the previous shot's frame.

Shots of one scene used to be made independently, so consecutive shots drifted apart (another set, other light, other
clothes). Now, unless the team setting `auto_scene_continuity` is off:
- the scene's anchor (the shot pinned on the Scene, else the first shot in order) is made first, and its current
  keyframe goes into every other keyframe of the scene as a reference for set, light, palette and wardrobe (never for
  faces: those come from the character references);
- within the same scene and location, the previous shot's frame (the last frame of its video, else its keyframe) is a
  reference for positions and props by default; an explicit Film Map link or "continue from previous shot" still wins;
- every keyframe and video prompt of the scene carries the same "scene look" block (time of day, weather, light,
  palette, set dressing), so every shot is described the same way.
Ordering of a batch (anchor first) is done when jobs are claimed: see core/scene_order.py.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

from ..models import Job, Location, Prop, Scene, Shot
from ..storage import get_storage
from .selection import current, is_real


def auto_on(db: Session) -> bool:
    from .. import settings_store
    return bool(settings_store.get_setting(db, "auto_scene_continuity"))


def scene_of(db: Session, shot: Shot) -> Scene | None:
    return db.get(Scene, shot.scene_id) if shot.scene_id else None


# ── the anchor ───────────────────────────────────────────────────────────────

def anchor_shot(db: Session, scene: Scene | None) -> Shot | None:
    """The shot whose keyframe sets the scene's look: the pinned one while it is still in the scene, else the first."""
    if scene is None:
        return None
    if scene.anchor_shot_id:
        s = db.get(Shot, scene.anchor_shot_id)
        if s and s.scene_id == scene.id and s.include:
            return s
    return (db.query(Shot).filter(Shot.scene_id == scene.id, Shot.include.is_(True))
            .order_by(Shot.order, Shot.id).first())


def anchor_for(db: Session, shot: Shot) -> Shot | None:
    """The anchor this shot follows: None for the anchor itself, a shot without a scene, or with the setting off."""
    if not shot.scene_id or not auto_on(db):
        return None
    a = anchor_shot(db, scene_of(db, shot))
    return a if a and a.id != shot.id else None


def anchor_map(db: Session, shots: list[Shot]) -> dict[int, int]:
    """{shot id: anchor shot id} for the given shots that follow an anchor."""
    if not auto_on(db):
        return {}
    out: dict[int, int] = {}
    by_scene: dict[int, int | None] = {}
    for s in shots:
        if not s.scene_id:
            continue
        if s.scene_id not in by_scene:
            a = anchor_shot(db, db.get(Scene, s.scene_id))
            by_scene[s.scene_id] = a.id if a else None
        a_id = by_scene[s.scene_id]
        if a_id and a_id != s.id:
            out[s.id] = a_id
    return out


# ── frames ───────────────────────────────────────────────────────────────────

def _being_remade(db: Session, shot_id: int) -> bool:
    """A keyframe for this shot is waiting or running: its current frame is about to be replaced."""
    return db.query(Job.id).filter(Job.shot_id == shot_id, Job.type.in_(("keyframe", "keyframe_qc")),
                                   Job.status.in_(("queued", "running"))).first() is not None


def prev_in_scene(db: Session, shot: Shot) -> Shot | None:
    """Default continuity: the previous shot, when it is in the same scene and location and not being remade."""
    if not shot.scene_id or not auto_on(db):
        return None
    prev = (db.query(Shot).filter(Shot.episode_id == shot.episode_id, Shot.include.is_(True), Shot.order < shot.order)
            .order_by(Shot.order.desc()).first())
    if not prev or prev.scene_id != shot.scene_id or prev.location_id != shot.location_id:
        return None
    return None if _being_remade(db, prev.id) else prev


def continuity_source(db: Session, shot: Shot) -> Shot | None:
    """The shot this one continues from: an explicit Film Map link first, else the previous shot when asked, else (by
    default) the previous shot when it is in the same scene and location."""
    if shot.continuity_from_shot_id:
        src = db.get(Shot, shot.continuity_from_shot_id)
        if src and src.episode_id == shot.episode_id:
            return src
    if shot.continuity_from_prev:
        return (db.query(Shot).filter(Shot.episode_id == shot.episode_id, Shot.include.is_(True), Shot.order < shot.order)
                .order_by(Shot.order.desc()).first())
    return prev_in_scene(db, shot)


def keyframe_of(db: Session, shot: Shot | None) -> Path | None:
    """A shot's current keyframe on disk. Placeholders made without an API key never guide real work."""
    if shot is None:
        return None
    st = get_storage()
    k = current(db, shot.id, "keyframe")
    return st.abs(k.path) if k and is_real(k) and st.exists(k.path) else None


def end_frame(db: Session, src: Shot, tmp: Path | None) -> tuple[Path | None, str]:
    """(frame, "video" | "keyframe" | ""): the last frame of the shot's current video (needs a tmp folder to extract
    it into), else its keyframe."""
    st = get_storage()
    if tmp is not None:
        v = current(db, src.id, "video")
        if v and is_real(v) and st.exists(v.path):
            try:
                from . import ffmpeg as ff
                return ff.extract_frame(st.abs(v.path), tmp / f"end_{src.id}.png", "last"), "video"
            except Exception as e:  # a broken clip: its keyframe still shows where things are
                print(f"[scene_look] last frame of shot {src.id}: {e}")
    k = keyframe_of(db, src)
    return (k, "keyframe") if k else (None, "")


@dataclass
class Frames:
    prev: Path | None = None
    prev_from: str = ""  # video | keyframe
    anchor: Path | None = None
    anchor_shot_id: int | None = None


def continuity_frames(db: Session, shot: Shot, src: Shot | None, tmp: Path | None) -> Frames:
    """The frames a keyframe follows: the continuity source's end frame and the scene anchor's keyframe."""
    out = Frames()
    if src is not None:
        out.prev, out.prev_from = end_frame(db, src, tmp)
    a = anchor_for(db, shot)
    if a is not None:
        out.anchor, out.anchor_shot_id = keyframe_of(db, a), a.id
    return out


# ── the scene look block ─────────────────────────────────────────────────────

_EXT = re.compile(r"\b(ext\.?|exterior|outdoors?|outside|street|road|field|forest|river|beach|garden|courtyard|market|"
                  r"village square|rooftop|hill|mountain|lake|riverbank|ghat|highway|park)\b", re.I)
_INT = re.compile(r"\b(int\.?|interior|inside|indoors?|room|kitchen|hall|office|house|home|hut|shop|store|corridor|"
                  r"classroom|bedroom|courtroom|cafe|restaurant|cabin|studio|apartment|flat|sanctum|library|hospital)\b", re.I)

# (pattern, light, palette, motivating source inside, outside)
_LIGHT = [
    (r"\b(dawn|sunrise|first light|daybreak)\b", "low soft sunrise light, cool shadows", "soft peach, pale gold and cool blue",
     "the window", "the rising sun"),
    (r"\b(golden hour|sunset|dusk|evening|twilight)\b", "low warm golden light, long soft shadows", "amber, gold and dusky blue",
     "the window", "the low sun"),
    (r"\b(night|midnight|late night)\b", "", "", "the lamps", "the moon and practical lights"),
    (r"\b(morning)\b", "fresh soft morning daylight", "clean whites, warm highlights, light blue shadows",
     "the window", "the morning sun"),
    (r"\b(noon|midday|afternoon|day|daytime)\b", "bright natural daylight, soft shadows", "natural, true-to-life colours",
     "the window", "the sun"),
]


def _interior(loc: Location | None, scene: Scene) -> bool | None:
    text = " ".join(x for x in [loc.name if loc else "", loc.description_text if loc else "", scene.title or ""] if x)
    if re.search(r"\bint\.", text, re.I):
        return True
    if re.search(r"\bext\.", text, re.I):
        return False
    if _INT.search(text):
        return True
    if _EXT.search(text):
        return False
    return None


def _light(tod: str, interior: bool | None) -> tuple[str, str, str]:
    """(light, palette, what motivates the key light) for a time of day."""
    for pat, light, palette, src_in, src_out in _LIGHT:
        if re.search(pat, tod, re.I):
            if "night" in pat:  # night light depends on where we are
                if interior is False:
                    return ("moonlight with warm practical lights, low-key, deep shadows",
                            "cool blue moonlight with warm practical accents", src_out)
                return "warm practical lamps and tungsten, deep shadows", "warm amber pools against deep shadow", src_in
            return light, palette, (src_in if interior else src_out)
    return "", "", ""


def _dressing(db: Session, scene: Scene) -> list[str]:
    out = [str(p).strip() for p in (scene.props or []) if str(p).strip()]
    ids = [int(x) for x in (scene.prop_ids or [])]
    if ids:
        for p in db.query(Prop).filter(Prop.id.in_(ids), Prop.archived.is_(False)).all():
            if p.name not in out:
                out.append(p.name + (f" ({p.description})" if p.description else ""))
    return out[:8]


def light_source(db: Session, scene: Scene | None) -> str:
    if scene is None:
        return ""
    loc = db.get(Location, scene.location_id) if scene.location_id else None
    tod = (scene.time_of_day or (scene.end_state or {}).get("time_of_day") or "").strip()
    return _light(tod, _interior(loc, scene))[2]


def scene_look(db: Session, scene: Scene | None) -> str:
    """One text block, the same for every shot of the scene: set, time of day, weather, light, palette, dressing, mood."""
    if scene is None:
        return ""
    loc = db.get(Location, scene.location_id) if scene.location_id else None
    end = scene.end_state or {}
    tod = (scene.time_of_day or end.get("time_of_day") or "").strip()
    weather = (end.get("weather") or "").strip()
    light, palette, source = _light(tod, _interior(loc, scene))
    bits = []
    if loc:
        desc = (loc.description_text or "").strip().rstrip(".")
        bits.append(f"set: {loc.name}" + (f" ({desc})" if desc and desc.lower() != loc.name.strip().lower() else ""))
    if tod:
        bits.append(f"time of day: {tod}")
    if weather:
        bits.append(f"weather: {weather}")
    if light:
        bits.append(f"light: {light}, the key light from the same side in every shot, motivated by {source}")
    if palette:
        bits.append(f"colour palette: {palette}")
    dressing = _dressing(db, scene)
    if dressing:
        bits.append("set dressing: " + ", ".join(dressing))
    if scene.emotion:
        bits.append(f"mood: {scene.emotion.strip().rstrip('.')}")
    return "; ".join(bits) + "." if bits else ""


# ── cinematography by framing ────────────────────────────────────────────────

_LENS = [  # most specific first: "medium close-up" before "close-up" and "medium"
    (r"\b(extreme close[- ]?up|ecu|macro|insert|detail)\b", "100mm lens, very shallow depth of field", "the detail fills the frame"),
    (r"\b(medium close[- ]?up|mcu)\b", "65mm lens, shallow depth of field", "chest-up, eyes on the upper third"),
    (r"\b(close[- ]?up|cu|close shot|tight|head[- ]and[- ]shoulders?)\b",
     "85mm lens, shallow depth of field, soft background, eyes in sharp focus", "eyes on the upper third"),
    (r"\b(over[- ]the[- ]shoulder|ots)\b", "50mm lens, moderate depth of field", "the listener's shoulder soft in the foreground"),
    (r"\b(medium wide|medium long|mws)\b", "35mm lens, deep focus", "knees-up, the set around them"),
    (r"\b(medium|mid|waist|cowboy|two[- ]shot)\b", "50mm lens, moderate depth of field", "waist-up, rule of thirds"),
    (r"\b(extreme wide|establishing|wide|long shot|full shot|full[- ]body|aerial|drone)\b", "24-35mm lens, deep focus",
     "the whole set readable, characters placed within it, foreground depth"),
]


def camera_notes(shot: Shot, n_chars: int, speaking: bool, source: str = "") -> str:
    """Lens, depth of field, composition, eyelines and light motivation for this framing (a few words each)."""
    text = f"{shot.framing or ''} {shot.camera or ''}".lower()
    bits: list[str] = []
    for pat, lens, comp in _LENS:
        if re.search(pat, text):
            bits += [lens, comp]
            break
    if n_chars >= 2:
        bits.append("eyelines meet between the characters, consistent screen direction (180-degree rule)")
    elif n_chars == 1 and speaking:
        bits.append("eyeline just off camera, not into the lens")
    if source:
        bits.append(f"key light motivated by {source}")
    return "; ".join(bits)


def scene_seed(shot: Shot, project_id: int, retake: int = 0) -> int | None:
    """A stable seed per scene for engines that take one (a retake moves it, so it doesn't repeat the same image)."""
    if not shot.scene_id:
        return None
    h = int(hashlib.sha1(f"{project_id}:{shot.scene_id}".encode()).hexdigest()[:8], 16)
    return (h + retake * 7919) % 2_147_483_647
