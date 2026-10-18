"""The shot list ("board"): an episode as scenes → shots → lines, edited by hand.

Used by the manual shot builder and by the script-import wizard (which fills a board from a file). Saving is a full
sync of the episode in the order given: rows with an id are updated, rows without one are created, and rows that are
no longer listed are removed (a shot that already has paid takes is only dropped from the cut, like DELETE /shots).

A line's speaker is a character id, or "VO" for voice-over (stored in Shot.narration, read by the project narrator).
Only the primary language is edited here; other languages are left as they are.

A scene's mood, look, sound, music and wardrobe and a shot's sound effects are the script's own notes: every shot of
the scene carries them (pipeline/prompting.py, the score and the sound design). Left out (None) they stay as they are,
so an older editor that doesn't send them never wipes them; the same goes for a line's off-screen flag.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..events import emit
from ..models import Character, Episode, Location, Project, Scene, Shot, Take, User
from ..pipeline.selection import current
from ..storage import get_storage
from . import studio

EXTEND_STEP_S = 7  # each Veo extension adds about 7 seconds
MAX_EXTEND_S = 8 + 3 * EXTEND_STEP_S


class BoardLine(BaseModel):
    speaker: int | str = Field(description='character id, or "VO" for voice-over')
    text: str = ""
    emotion: str = ""
    # heard, not seen saying it (O.S.): voiced, never lip-synced. None = keep what the line had (an editor that doesn't
    # know the flag never drops it)
    off_screen: bool | None = None


class BoardShot(BaseModel):
    id: int | None = None
    prompt: str = ""
    characters: list[int] = []
    lines: list[BoardLine] = []
    duration_s: int = 8
    extend_to: int = 0
    extend_prompt: str = ""
    framing: str = ""
    camera: str = ""
    engine: str = "auto"  # the video model for this shot: "auto" (Google first) or an engine id
    sfx: str | None = None  # sound effects in this shot (None = keep)


class BoardScene(BaseModel):
    id: int | None = None
    title: str = ""
    location: str = ""
    time_of_day: str = ""
    summary: str = ""
    mood: str | None = None  # None = keep what the scene has
    look: str | None = None
    sound: str | None = None
    music: str | None = None
    wardrobe: dict | None = None  # who wears what in the scene, {character id: outfit} (None = keep)
    shots: list[BoardShot] = []


class Board(BaseModel):
    scenes: list[BoardScene]
    # the version the editor loaded; when it no longer matches, someone else changed the shot list meanwhile
    version: str | None = None


def board_version(db: Session, episode: Episode) -> str:
    """Fingerprint of what the shot list says (not of statuses, which change while jobs run)."""
    import hashlib
    import json
    scenes = db.query(Scene).filter(Scene.episode_id == episode.id).order_by(Scene.id).all()
    shots = db.query(Shot).filter(Shot.episode_id == episode.id, Shot.include.is_(True)).order_by(Shot.id).all()
    data = [[sc.id, sc.order, sc.title, sc.location_id, sc.time_of_day, sc.summary, sc.emotion, sc.look, sc.sound,
             sc.music] for sc in scenes] + [
        [h.id, h.order, h.scene_id, h.action, h.characters, h.dialogue, h.narration, h.duration_s, h.extend_to,
         h.extend_prompt, h.framing, h.camera, h.sfx] for h in shots]
    return hashlib.sha1(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()[:16]


def _engine(db: Session, engine_id: str) -> str:
    eid = (engine_id or "").strip()
    if not eid or eid == "auto":
        return "auto"
    from ..models import AIModel
    if not db.get(AIModel, eid):
        raise HTTPException(400, f"Unknown video model {eid!r}: pick another or Auto")
    return eid


def _vo(speaker: Any) -> bool:
    return isinstance(speaker, str) and speaker.strip().upper() in ("VO", "NARRATOR")


def get_board(db: Session, project: Project, episode: Episode) -> dict:
    lang = project.primary_language
    st = get_storage()
    scenes = db.query(Scene).filter(Scene.episode_id == episode.id).order_by(Scene.order, Scene.id).all()
    shots = (db.query(Shot).filter(Shot.episode_id == episode.id, Shot.include.is_(True)).order_by(Shot.order, Shot.id).all())
    by_scene: dict[int | None, list[Shot]] = {}
    for s in shots:
        by_scene.setdefault(s.scene_id if any(sc.id == s.scene_id for sc in scenes) else None, []).append(s)

    def shot_out(s: Shot) -> dict:
        lines = []
        narr = (s.narration or {}).get(lang, "").strip()
        if narr:
            lines.append({"speaker": "VO", "text": narr, "emotion": ""})
        for l in (s.dialogue or {}).get(lang, []):
            lines.append({"speaker": "VO" if _vo(l.get("character_id")) else l.get("character_id"),
                          "text": l.get("line", ""), "emotion": l.get("emotion", ""),
                          **({"off_screen": True} if l.get("off_screen") else {})})
        kf, vid = current(db, s.id, "keyframe"), current(db, s.id, "video")
        return {"id": s.id, "code": s.code, "prompt": s.action, "characters": s.characters or [], "lines": lines,
                "duration_s": s.duration_s, "extend_to": s.extend_to or 0, "extend_prompt": s.extend_prompt or "",
                "framing": s.framing, "camera": s.camera, "engine": s.engine or "auto", "sfx": s.sfx or "",
                "status": s.status, "generating": s.generating,
                "thumb_url": st.url(kf.thumb_path or kf.path) if kf else "", "keyframe_uploaded": bool(kf and kf.provider == "upload"),
                "ref_images": [{"label": r.get("label", ""), "url": st.url(r.get("path", ""))} for r in (s.ref_images or [])],
                "video_s": round(vid.duration_s, 1) if vid else 0, "has_video": bool(vid)}

    from . import problems
    out = []
    for sc in scenes:
        loc = db.get(Location, sc.location_id) if sc.location_id else None
        out.append({"id": sc.id, "title": sc.title, "location": loc.name if loc else "", "time_of_day": sc.time_of_day,
                    "summary": sc.summary, "mood": sc.emotion or "", "look": sc.look or "", "sound": sc.sound or "",
                    "music": sc.music or "", "shots": [shot_out(s) for s in by_scene.get(sc.id, [])]})
    if by_scene.get(None):  # shots added before any scene existed
        out.append({"id": None, "title": "Unsorted shots", "location": "", "time_of_day": "", "summary": "", "mood": "",
                    "look": "", "sound": "", "music": "", "shots": [shot_out(s) for s in by_scene[None]]})
    return {"episode_id": episode.id, "language": lang, "scenes": out, "version": board_version(db, episode),
            # a Produce all run that stopped for the new looks and voices to be checked (workers/handlers_room.produce)
            "produce_paused": (episode.settings or {}).get("produce_paused"),
            # what the last run (Produce all, Autopilot, Scenes in order) couldn't make and still stands, and what to do
            # (core/problems.py: a step made since, or a shot taken out of the cut, drops off the list)
            "run_problems": problems.live(db, episode),
            "limits": {"durations": [4, 6, 8], "extend_step_s": EXTEND_STEP_S, "max_extend_s": MAX_EXTEND_S}}


def save_board(db: Session, user: User, project: Project, episode: Episode, board: Board) -> dict:
    lang = project.primary_language
    from . import collab
    collab.check(user, f"board:{episode.id}")
    if board.version and board.version != board_version(db, episode):
        raise HTTPException(409, "The shot list was changed somewhere else since you opened it (another tab, a teammate, "
                                 "the Director or Autopilot). Copy anything you need, then reload to see the latest.")
    from ..models import Job
    busy_ids = {i for (i,) in db.query(Job.shot_id).join(Shot, Shot.id == Job.shot_id).filter(Shot.episode_id == episode.id,
                                                            Job.status.in_(("proposed", "queued", "running",
                                                                            "awaiting_approval"))).all()}
    cast_ids = {c.id for c in db.query(Character.id).all()}
    names = {c.id: c.name for c in db.query(Character).filter(Character.id.in_(cast_ids)).all()} if cast_ids else {}
    old_scenes = {s.id: s for s in db.query(Scene).filter(Scene.episode_id == episode.id).all()}
    old_shots = {s.id: s for s in db.query(Shot).filter(Shot.episode_id == episode.id).all()}
    cut_before = [s.id for s in sorted(old_shots.values(), key=lambda s: (s.order, s.id)) if s.include]
    keep_scenes: set[int] = set()
    keep_shots: set[int] = set()
    order = 0
    script_scenes: list[dict] = []

    for si, bs in enumerate(board.scenes):
        if not bs.shots and not bs.title.strip():
            continue
        sc = old_scenes.get(bs.id) if bs.id else None
        old_loc = sc.location_id if sc else None
        if sc is None:
            sc = Scene(episode_id=episode.id)
            db.add(sc)
        loc = studio._find_loc(db, project, bs.location.strip()) if bs.location.strip() else None
        title = bs.title.strip()
        if bs.id is None and title == "Unsorted shots":  # the board's group for shots without a scene
            title = ""
        sc.order, sc.title = si, title or f"Scene {si + 1}"
        sc.time_of_day, sc.summary = bs.time_of_day.strip(), bs.summary.strip()
        for field, col, cap in (("mood", "emotion", 200), ("look", "look", 4000), ("sound", "sound", 4000),
                                ("music", "music", 4000)):
            if getattr(bs, field) is not None:
                setattr(sc, col, getattr(bs, field).strip()[:cap])
        old_wardrobe = dict(sc.wardrobe or {})
        if bs.wardrobe is not None:  # keyed by character id as text, like the scene card (pipeline/prompting.outfit_for)
            sc.wardrobe = {str(k): str(v).strip()[:300] for k, v in bs.wardrobe.items()
                           if str(k).isdigit() and int(k) in cast_ids and str(v or "").strip()}
        sc.location_id = loc.id if loc else None
        db.flush()
        keep_scenes.add(sc.id)
        scene_lines: list[dict] = []
        scene_chars: list[int] = []
        scene_shots: list[Shot] = []

        for b in bs.shots:
            if b.duration_s not in (4, 6, 8):
                raise HTTPException(400, f"Shot length must be 4, 6 or 8 seconds (scene {si + 1})")
            ext = int(b.extend_to or 0)
            if ext and (ext <= b.duration_s or ext > MAX_EXTEND_S):
                raise HTTPException(400, f"Extend-to must be more than the shot length and at most {MAX_EXTEND_S}s")
            dialogue, narration, chars = [], [], [c for c in b.characters if c in cast_ids]
            was = old_shots.get(b.id) if b.id else None
            was_lines = list((was.dialogue or {}).get(lang) or []) if was else []
            was_off = {(l.get("character_id"), l.get("line", "")) for l in was_lines if l.get("off_screen")}
            for l in b.lines:
                if not l.text.strip():
                    continue
                if _vo(l.speaker):
                    narration.append(l.text.strip())
                    scene_lines.append({"character": "NARRATOR", "line": l.text.strip(), "emotion": l.emotion})
                    continue
                try:
                    cid = int(l.speaker)
                except (TypeError, ValueError):
                    raise HTTPException(400, f"Unknown speaker {l.speaker!r}: pick a character or Voice-over")
                if cid not in cast_ids:
                    raise HTTPException(400, f"Speaker #{cid} doesn't exist")
                # not sent: the flag of the same line before (the same words, or the same speaker in its place)
                at = was_lines[len(dialogue)] if len(dialogue) < len(was_lines) else {}
                off = l.off_screen if l.off_screen is not None else (
                    (cid, l.text.strip()) in was_off or (at.get("character_id") == cid and bool(at.get("off_screen"))))
                if cid not in chars and not off:
                    chars.append(cid)  # whoever speaks on screen is in the shot
                dialogue.append({"character_id": cid, "line": l.text.strip(), "emotion": l.emotion.strip(),
                                 **({"off_screen": True} if off else {})})
                scene_lines.append({"character": names.get(cid, ""), "line": l.text.strip(), "emotion": l.emotion})
            for c in chars:
                if c not in scene_chars:
                    scene_chars.append(c)
                ch = db.get(Character, c)
                if ch:
                    studio.link_character(db, project, ch)

            order += 1
            s = old_shots.get(b.id) if b.id else None
            # a shot follows its scene's location unless it was set to a different place on its own
            shot_loc = loc.id if loc else None
            if s is not None and s.location_id and s.location_id != old_loc:
                shot_loc = s.location_id
            new_vals = {"action": b.prompt.strip(), "characters": chars, "duration_s": b.duration_s, "extend_to": ext,
                        "extend_prompt": b.extend_prompt.strip(), "framing": b.framing.strip(), "camera": b.camera.strip(),
                        "engine": _engine(db, b.engine),
                        **({"sfx": b.sfx.strip()} if b.sfx is not None else {}),
                        "dialogue": {**((s.dialogue or {}) if s else {}), lang: dialogue},
                        "narration": {**((s.narration or {}) if s else {}), lang: " ".join(narration)},
                        "scene_id": sc.id, "location_id": shot_loc}
            if s is not None:  # translations of lines that were rewritten or removed are out of date: drop them
                old_text = [l.get("line", "") for l in (s.dialogue or {}).get(lang, [])]
                if old_text != [l["line"] for l in dialogue]:
                    new_vals["dialogue"] = {lang: dialogue}
                if (s.narration or {}).get(lang, "") != " ".join(narration):
                    new_vals["narration"] = {lang: " ".join(narration)}
            if not dialogue:
                new_vals["dialogue"].pop(lang, None)
            if not narration:
                new_vals["narration"].pop(lang, None)
            if s is None:
                s = Shot(episode_id=episode.id, order=order, **new_vals)
                db.add(s)
            else:
                changed = [k for k, v in new_vals.items() if getattr(s, k) != v]
                if changed:
                    collab.check(user, f"shot:{s.id}")  # someone has this shot open for editing
                    studio.save_revision(db, "shot", s, studio.SHOT_FIELDS, user)
                    dlg_before = {k: list(v or []) for k, v in (s.dialogue or {}).items()}
                    narr_before = dict(s.narration or {})
                    for k in changed:
                        setattr(s, k, new_vals[k])
                    from . import dependencies
                    dependencies.mark_stale(db, s, set(changed), dialogue_before=dlg_before, narration_before=narr_before)
                    if s.status == "approved" and set(changed) & {"action", "characters", "dialogue", "narration", "duration_s"}:
                        s.status = "video_ready"
                s.order, s.include = order, True
            db.flush()
            keep_shots.add(s.id)
            scene_shots.append(s)
        changed_outfits = {c for c in set(old_wardrobe) | set(sc.wardrobe or {})
                           if old_wardrobe.get(c) != (sc.wardrobe or {}).get(c)}
        if changed_outfits and bs.id:  # shots that wear the scene's outfits need new keyframes and videos (api/room.py)
            from . import dependencies
            for s in scene_shots:
                if any(c in {str(x) for x in s.characters or []} and not (s.outfits or {}).get(c) for c in changed_outfits):
                    dependencies.mark_stale(db, s, {"outfits"}, note="scene wardrobe changed")
        sc.characters = scene_chars
        script_scenes.append({"title": sc.title, "location": bs.location.strip(), "time_of_day": sc.time_of_day,
                              "summary": sc.summary, "mood": sc.emotion or "",
                              "action": " ".join(b.prompt.strip() for b in bs.shots)[:2000], "lines": scene_lines})

    # what's no longer on the board
    for sid, s in old_shots.items():
        if sid in keep_shots or not s.include:
            continue
        if sid in busy_ids or db.query(Take).filter(Take.shot_id == sid).count():
            s.include, s.order = False, 10_000 + s.order  # keep paid media, drop it from the cut
        else:
            db.delete(s)
    db.flush()
    for scid, sc in old_scenes.items():
        if scid in keep_scenes:
            continue
        for s in db.query(Shot).filter(Shot.scene_id == scid).all():
            s.scene_id = None
        db.delete(sc)
    db.flush()
    studio.renumber(db, episode)
    cut_after = [i for (i,) in db.query(Shot.id).filter(Shot.episode_id == episode.id, Shot.include.is_(True))
                 .order_by(Shot.order, Shot.id).all()]
    if cut_after[:len(cut_before)] != cut_before:  # moved or dropped shots change the cut (new ones at the end don't)
        from .desktop import check_cut
        check_cut(db, episode.id, user)

    # keep the episode script in step, so the Story tab, table read and dubbing see the same words
    prev = episode.script or {}
    episode.script = {"logline": prev.get("logline", ""), "beats": prev.get("beats", []), "scenes": script_scenes}
    studio.save_script_version(db, episode, "board", user, note="Shot list saved")
    episode.status = "shots" if keep_shots else episode.status
    db.commit()
    emit(db, project.id, "episode.updated", {"episode_id": episode.id, "what": "shots"}, user_id=user.id)
    return get_board(db, project, episode)
