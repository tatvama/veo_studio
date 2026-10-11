"""Desktop finishing room (docs/DESKTOP.md §2): cut checkout locks, cut versions with rollback, the desktop manifest,
the render plan, chunked render uploads and the AI upscale step.

The desktop app does no AI work of its own. It renders the plan written here (the same timing and filters as
assembler.render), and every paid step goes through jobs with estimates, budgets and approvals, like on the web.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import settings_store
from ..config import get_settings
from ..db import utcnow
from ..events import emit
from ..models import (AudioAsset, CharacterAsset, CutLock, CutVersion, Episode, Export, Job, LocationAsset, Project,
                      ProjectProp, Prop, Scene, Shot, Take, User, role_rank)
from ..pipeline import assembler
from ..pipeline import ffmpeg as ff
from ..pipeline import fx as fxlib
from ..pipeline import layers as layerlib
from ..pipeline.selection import current, select, source_video_id, takes
from ..storage import get_storage
from . import collab, studio
from .audit import audit

CLIENTS = ("desktop", "web")
CUT_FIELDS = ("order", "include", "trim_in", "trim_out", "fx", "overlays")  # shot fields that change the cut
CHUNK = 8 * 1024 * 1024
UPLOAD_KEEP_S = 7 * 24 * 3600  # unfinished uploads are cleared after a week
MAX_UPSCALE = 4.0


def _name(u: User | None) -> str:
    return (u.name or u.email.split("@")[0]) if u else "someone"


def _iso(dt) -> str | None:
    return dt.isoformat() + "Z" if dt else None


# ── checkout lock ────────────────────────────────────────────────────────────

def lock_of(db: Session, episode_id: int) -> CutLock | None:
    return db.query(CutLock).filter(CutLock.episode_id == episode_id).first()


def _held(db: Session, lk: CutLock) -> HTTPException:
    return HTTPException(423, f"Checked out by {_name(db.get(User, lk.user_id))} on {lk.client} — the cut is read-only "
                              "until they check in")


def check_cut(db: Session, episode_id: int, user: User) -> None:
    """Refuse a cut edit while someone else has the cut checked out (the holder passes)."""
    lk = lock_of(db, episode_id)
    if lk and lk.user_id != user.id:
        raise _held(db, lk)


def check_cut_fields(db: Session, shot: Shot, user: User, values: dict[str, Any]) -> None:
    """check_cut, when these values change one of the shot's cut fields (order, include, trims, effects, titles)."""
    if any(k in values and values[k] != getattr(shot, k) for k in CUT_FIELDS):
        check_cut(db, shot.episode_id, user)


def _lock_event(db: Session, episode: Episode, user: User, lk: CutLock | None) -> None:
    collab.set_cut(episode.id, episode.project_id, db.get(User, lk.user_id) if lk else None)
    emit(db, episode.project_id, "episode.updated", {"episode_id": episode.id, "what": "checkout",
                                                     "holder_id": lk.user_id if lk else None, "client": lk.client if lk else None},
         user_id=user.id)


def checkout(db: Session, episode: Episode, user: User, client: str = "desktop", machine: str = "", force: bool = False,
             request: Request | None = None) -> CutLock:
    """Check the cut out (or renew your own checkout). `force` takes it from someone else: producers only, audited."""
    lk = lock_of(db, episode.id)
    if lk and lk.user_id != user.id:
        if not force:
            raise _held(db, lk)
        if role_rank(user.role) < role_rank("producer"):
            raise HTTPException(403, "Only a producer can take over a cut someone else has checked out")
        audit(db, user, "cut.checkout.force", f"episode {episode.id}",
              {"from_user_id": lk.user_id, "from": _name(db.get(User, lk.user_id)), "client": lk.client, "machine": lk.machine},
              request=request, commit=False)
        db.delete(lk)
        db.flush()
        lk = None
    now = utcnow()
    client, machine = client if client in CLIENTS else "desktop", (machine or "")[:120]
    changed = lk is None or (lk.client, lk.machine) != (client, machine)
    if lk is None:
        lk = CutLock(episode_id=episode.id, user_id=user.id, acquired_at=now)
        db.add(lk)
    lk.client, lk.machine, lk.heartbeat_at = client, machine, now
    try:
        db.commit()
    except IntegrityError:  # someone checked it out at the same moment
        db.rollback()
        other = lock_of(db, episode.id)
        if other and other.user_id != user.id:
            raise _held(db, other)
        raise HTTPException(409, "The cut was checked out at the same moment. Try again.")
    if changed:
        _lock_event(db, episode, user, lk)
    else:
        collab.set_cut(episode.id, episode.project_id, user)
    return lk


def heartbeat(db: Session, episode: Episode, user: User) -> CutLock:
    lk = lock_of(db, episode.id)
    if not lk or lk.user_id != user.id:
        raise HTTPException(409, "You no longer have this cut checked out. Check it out again to keep editing.")
    lk.heartbeat_at = utcnow()
    db.commit()
    collab.set_cut(episode.id, episode.project_id, user)
    return lk


def release(db: Session, episode: Episode, user: User, request: Request | None = None) -> None:
    """Free the cut without saving a version: the holder, or a producer (audited)."""
    lk = lock_of(db, episode.id)
    if not lk:
        return
    if lk.user_id != user.id:
        if role_rank(user.role) < role_rank("producer"):
            raise HTTPException(403, "Only the editor who checked it out, or a producer, can release this cut")
        audit(db, user, "cut.checkout.release", f"episode {episode.id}",
              {"from_user_id": lk.user_id, "from": _name(db.get(User, lk.user_id)), "client": lk.client, "machine": lk.machine},
              request=request, commit=False)
    db.delete(lk)
    db.commit()
    _lock_event(db, episode, user, None)


def checkin(db: Session, episode: Episode, user: User, note: str = "") -> CutVersion:
    """Save the cut as a version and free it."""
    lk = lock_of(db, episode.id)
    if not lk or lk.user_id != user.id:
        raise HTTPException(409, "You don't have this cut checked out")
    v = save_version(db, episode, user, note.strip() or f"Checked in from {lk.machine or lk.client}", lk.client)
    db.delete(lk)
    db.commit()
    _lock_event(db, episode, user, None)
    emit(db, episode.project_id, "episode.updated", {"episode_id": episode.id, "what": "versions", "version": v.number},
         user_id=user.id)
    return v


# ── cut versions ─────────────────────────────────────────────────────────────

def _current_takes(db: Session, shot_ids: list[int]) -> dict[int, dict[str, Take]]:
    """Each shot's current take per "kind" or "kind:lang" (the selection.current rule), in one query."""
    out: dict[int, dict[str, Take]] = {}
    if not shot_ids:
        return out
    rows = (db.query(Take).filter(Take.shot_id.in_(shot_ids), Take.archived.is_(False), Take.status == "ready")
            .order_by(Take.id.desc()).all())
    for t in rows:
        key = f"{t.kind}:{t.language}" if t.language else t.kind
        cur = out.setdefault(t.shot_id, {})
        if key not in cur or (t.selected and not cur[key].selected):
            cur[key] = t
    return out


def _state(db: Session, episode: Episode) -> tuple[dict[str, Any], dict[str, Any]]:
    """(snapshot, stats) of the cut as it is now."""
    shots = db.query(Shot).filter(Shot.episode_id == episode.id).order_by(Shot.order, Shot.id).all()
    cur = _current_takes(db, [s.id for s in shots])
    music = (db.query(AudioAsset).filter(AudioAsset.episode_id == episode.id, AudioAsset.kind == "music",
                                         AudioAsset.selected.is_(True)).order_by(AudioAsset.id.desc()).first())
    rows, length = [], 0.0
    for s in shots:
        picks = cur.get(s.id, {})
        rows.append({"id": s.id, "order": s.order, "include": bool(s.include), "trim_in": float(s.trim_in or 0),
                     "trim_out": float(s.trim_out or 0), "fx": dict(s.fx or {}), "overlays": list(s.overlays or []),
                     "sfx_track": dict(s.sfx_track or {}), "selected": {k: picks[k].id for k in sorted(picks)}})
        if s.include:
            v = picks.get("video")
            if v and v.duration_s:
                speed = float((s.fx or {}).get("speed") or 1.0)
                length += max(v.duration_s - (s.trim_in or 0) - (s.trim_out or 0), 0.5) / speed
            else:
                length += float(s.duration_s or 0)
    snap = {"shots": rows, "settings": dict(episode.settings or {}),
            "layers": {k: v for k, v in (episode.layers or {}).items() if k != "rev"}, "music_id": music.id if music else None}
    stats = {"shots": len(rows), "included": sum(1 for r in rows if r["include"]), "duration_s": round(length, 2)}
    return snap, stats


def snapshot(db: Session, episode: Episode) -> dict[str, Any]:
    return _state(db, episode)[0]


def fingerprint(snap: dict[str, Any]) -> str:
    """sha1 of the cut (the layers' media library left out: adding a file to it doesn't change the cut)."""
    s = {**snap, "layers": {k: v for k, v in (snap.get("layers") or {}).items() if k != "media"}}
    return hashlib.sha1(json.dumps(s, sort_keys=True, default=str).encode()).hexdigest()


def latest_number(db: Session, episode_id: int) -> int:
    return int(db.query(func.max(CutVersion.number)).filter(CutVersion.episode_id == episode_id).scalar() or 0)


def save_version(db: Session, episode: Episode, user: User | None, note: str = "", client: str = "web",
                 restored_from: int | None = None) -> CutVersion:
    """Save the cut as the episode's next version (no commit)."""
    snap, stats = _state(db, episode)
    v = CutVersion(episode_id=episode.id, number=latest_number(db, episode.id) + 1, note=(note or "")[:2000], snapshot=snap,
                   stats=stats, client=client if client in CLIENTS else "web", created_by=user.id if user else None,
                   restored_from=restored_from)
    db.add(v)
    db.flush()
    return v


def client_of(db: Session, episode_id: int, user: User) -> str:
    """Where this person edits the cut from: their checkout's client, else the web."""
    lk = lock_of(db, episode_id)
    return lk.client if lk and lk.user_id == user.id else "web"


def restore(db: Session, v: CutVersion, user: User) -> CutVersion:
    """Write a version back. The current cut is saved first; shots deleted since are skipped, shots added since go
    after the restored ones, layers keep counting their rev. Then "Restored vN" is saved and returned."""
    ep = db.get(Episode, v.episode_id)
    check_cut(db, ep.id, user)
    client = client_of(db, ep.id, user)
    save_version(db, ep, user, f"Before restoring v{v.number}", client)
    snap = v.snapshot or {}
    shots = {s.id: s for s in db.query(Shot).filter(Shot.episode_id == ep.id).all()}
    seen: set[int] = set()
    for row in snap.get("shots") or []:
        s = shots.get(row.get("id"))
        if s is None:
            continue
        seen.add(s.id)
        s.order, s.include = int(row.get("order") or 0), bool(row.get("include", True))
        s.trim_in, s.trim_out = float(row.get("trim_in") or 0), float(row.get("trim_out") or 0)
        s.fx, s.overlays, s.sfx_track = dict(row.get("fx") or {}), list(row.get("overlays") or []), dict(row.get("sfx_track") or {})
        for tid in (row.get("selected") or {}).values():
            t = db.get(Take, tid)
            if t is not None and t.shot_id == s.id and not t.archived and t.status == "ready":
                select(db, t)
    top = max([s.order for s in shots.values() if s.id in seen] or [0])
    for s in sorted((s for s in shots.values() if s.id not in seen), key=lambda s: (s.order, s.id)):
        top += 1
        s.order = top
    studio.renumber(db, ep)
    ep.settings = dict(snap.get("settings") or {})
    cur = dict(ep.layers or {})
    lay = dict(snap.get("layers") or {})
    media = list(cur.get("media") or [])  # the media library only grows: files added since stay available
    have = {m.get("src") for m in media}
    media += [m for m in lay.get("media") or [] if m.get("src") not in have]
    ep.layers = {**lay, "media": media, "rev": int(cur.get("rev") or 0) + 1}
    mid = snap.get("music_id")
    for a in db.query(AudioAsset).filter(AudioAsset.episode_id == ep.id, AudioAsset.kind == "music").all():
        a.selected = a.id == mid
    db.flush()
    out = save_version(db, ep, user, f"Restored v{v.number}", client, restored_from=v.number)
    db.commit()
    emit(db, ep.project_id, "episode.updated", {"episode_id": ep.id, "what": "restore", "version": out.number,
                                                "restored_from": v.number}, user_id=user.id)
    return out


def next_export_version(db: Session, episode_id: int) -> int:
    """The next render number of an episode: server renders and desktop uploads share one counter."""
    return int(db.query(func.max(Export.version)).filter(Export.episode_id == episode_id).scalar() or 0) + 1


# ── manifest: what the desktop's local project folder should hold ────────────

TAKE_FOLDER = {"video": "Takes", "keyframe": "Takes", "lipsync": "Takes", "voicelock": "Takes", "upscale": "Takes",
               "voice": "Audio/Voice", "narration": "Audio/Voice"}
TAKE_LABEL = {"video": "Video", "keyframe": "Keyframe", "lipsync": "Lip-sync", "voicelock": "Voice lock", "upscale": "Upscale",
              "voice": "Voice", "narration": "Narration"}
DERIVED = {"lipsync", "voicelock", "upscale"}  # made from a video: useless once that video isn't current


def _ext(key: str) -> str:
    name = key.rsplit("/", 1)[-1]
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def manifest(db: Session, project: Project, scope: str = "approved", episode_id: int | None = None) -> dict[str, Any]:
    """approved: current takes of approved shots plus every take picked by hand; cut: every current take of every
    shot in the cut. Both add the music, sound effects, renders (approved ones / all ready ones), captions, the
    approved Bible stills and the layers' media."""
    if scope not in ("approved", "cut"):
        raise HTTPException(400, "scope must be approved or cut")
    st = get_storage()
    eps = db.query(Episode).filter(Episode.project_id == project.id).order_by(Episode.season, Episode.number, Episode.id).all()
    if episode_id:
        eps = [e for e in eps if e.id == episode_id]
        if not eps:
            raise HTTPException(404, "Episode not found in this project")
    langs = set(project.languages or []) | {project.primary_language}
    items: list[dict[str, Any]] = []
    seen_keys: set[str] = set()

    def item(key: str, folder: str, kind: str, role: str, ep: Episode | None, series: dict | None = None, **kw: Any) -> None:
        if not key or key in seen_keys:
            return
        seen_keys.add(key)
        items.append({"key": key, "url": st.url(key), "folder": folder, "kind": kind, "role": role,
                      "episode_id": ep.id if ep else None, "scene_id": None, "shot_id": None, "take_id": None, "language": None,
                      "series": {"season": ep.season if ep else 0, "episode": ep.number if ep else 0, "scene": 0, "shot": 0,
                                 "cut": 0, "take": 0, "version": 0, "code": "", **(series or {})},
                      "approved": False, "selected": False, "duration_s": 0.0, "updated_at": None, "ext": _ext(key), "label": "",
                      **kw})

    episodes = []
    for ep in eps:
        scenes = db.query(Scene).filter(Scene.episode_id == ep.id).order_by(Scene.order, Scene.id).all()
        scene_no = {sc.id: i for i, sc in enumerate(scenes, 1)}
        shots = db.query(Shot).filter(Shot.episode_id == ep.id).order_by(Shot.order, Shot.id).all()
        cut_no: dict[int, int] = {}
        for s in shots:
            if s.include:
                cut_no[s.id] = len(cut_no) + 1
        ids = [s.id for s in shots]
        take_no: dict[int, int] = {}  # take id → its number among the shot's takes of that kind + language
        counts: dict[tuple, int] = {}
        for tid, sid, kind, lang in (db.query(Take.id, Take.shot_id, Take.kind, Take.language)
                                     .filter(Take.shot_id.in_(ids), Take.archived.is_(False)).order_by(Take.id).all() if ids else []):
            counts[(sid, kind, lang)] = take_no[tid] = counts.get((sid, kind, lang), 0) + 1
        cur = _current_takes(db, ids)
        episodes.append({"id": ep.id, "number": ep.number, "season": ep.season, "title": ep.title, "kind": ep.kind,
                         "cut_version": latest_number(db, ep.id),
                         "scenes": [{"id": sc.id, "order": scene_no[sc.id], "title": sc.title} for sc in scenes],
                         "shots": [{"id": s.id, "code": s.code, "order": s.order, "cut_index": cut_no.get(s.id), "include": bool(s.include),
                                    "scene_id": s.scene_id, "scene_order": scene_no.get(s.scene_id), "status": s.status,
                                    "duration_s": s.duration_s} for s in shots]})
        for s in shots:
            approved = s.status == "approved"
            if scope == "cut" and not s.include:
                continue
            ser = {"scene": scene_no.get(s.scene_id, 0), "shot": s.order, "cut": cut_no.get(s.id, 0), "code": s.code}
            at = {"scene_id": s.scene_id, "shot_id": s.id, "approved": approved}
            picks = cur.get(s.id, {})
            video = picks.get("video")
            for t in sorted(picks.values(), key=lambda t: t.id):
                if t.kind not in TAKE_FOLDER or not t.path or (t.language and t.language not in langs):
                    continue
                if scope == "approved" and not (approved or t.selected):
                    continue
                if t.kind in DERIVED and video is not None and source_video_id(db, t) not in (None, video.id):
                    continue
                n = take_no.get(t.id, 1)
                item(t.path, TAKE_FOLDER[t.kind], t.kind, "take", ep, {**ser, "take": n, "version": n}, **at, take_id=t.id,
                     language=t.language, selected=bool(t.selected), duration_s=float(t.duration_s or 0),
                     updated_at=_iso(t.created_at), label=f"{TAKE_LABEL[t.kind]} take {n}" + (f" ({t.language})" if t.language else ""))
            sfx = s.sfx_track or {}
            if sfx.get("path") and (scope == "cut" or approved):
                item(sfx["path"], "Audio/SFX", "sfx", "sfx", ep, {**ser, "take": 1, "version": 1}, **at,
                     duration_s=float(sfx.get("duration") or 0), label=f"Sound effects {s.code}")
        m = assembler.music_track(db, ep)
        if m and m.path:
            n = db.query(AudioAsset).filter(AudioAsset.episode_id == ep.id, AudioAsset.kind == "music", AudioAsset.id <= m.id).count()
            item(m.path, "Audio/Music", "music", "music", ep, {"take": n, "version": n}, asset_id=m.id, language=m.language,
                 approved=bool(m.selected), selected=bool(m.selected), duration_s=float(m.duration_s or 0),
                 updated_at=_iso(m.created_at), label=f"Music {n}")
        for x in db.query(Export).filter(Export.episode_id == ep.id, Export.status == "ready").order_by(Export.id).all():
            if scope == "approved" and not x.approved_by:
                continue
            common = {"export_id": x.id, "language": x.language, "preset": x.preset, "approved": bool(x.approved_by),
                      "duration_s": float(x.duration_s or 0), "updated_at": _iso(x.created_at)}
            vtxt = f"v{x.version}" if x.version else f"#{x.id}"
            item(x.path, "Renders", "render", "render", ep, {"version": x.version or 0}, **common,
                 label=f"Render {vtxt} ({x.language}, {x.preset})")
            item(x.srt_path, "Captions", "captions", "captions", ep, {"version": x.version or 0}, **common,
                 label=f"Captions {vtxt} ({x.language})")
        for md in (ep.layers or {}).get("media") or []:
            name = str(md.get("name") or "")
            imp = name.startswith("IMP_") or md.get("origin") == "desktop"
            item(str(md.get("src") or ""), "Imports" if imp else "Media", "media", "import" if imp else "media", ep,
                 media_kind=md.get("kind"), duration_s=float(md.get("duration") or 0), label=name[:80])

    for c in studio.cast(db, project):
        for a in (db.query(CharacterAsset).filter(CharacterAsset.character_id == c.id, CharacterAsset.approved.is_(True),
                                                  CharacterAsset.archived.is_(False)).order_by(CharacterAsset.id).all()):
            item(a.path, "Bible/Characters", "character", "bible", None, {"take": a.version or 1, "version": a.version or 1},
                 asset_id=a.id, character_id=c.id, approved=True, updated_at=_iso(a.created_at),
                 label=f"{c.name} {a.label or a.kind.replace('_', ' ')}".strip())
    for loc in studio.locations(db, project):
        for a in (db.query(LocationAsset).filter(LocationAsset.location_id == loc.id, LocationAsset.approved.is_(True),
                                                 LocationAsset.archived.is_(False)).order_by(LocationAsset.id).all()):
            item(a.path, "Bible/Locations", "location", "bible", None, {"take": 1, "version": 1}, asset_id=a.id, location_id=loc.id,
                 approved=True, updated_at=_iso(a.created_at), label=f"{loc.name} {a.label or a.kind}".strip())
    props = (db.query(Prop).join(ProjectProp, ProjectProp.prop_id == Prop.id)
             .filter(ProjectProp.project_id == project.id, Prop.archived.is_(False), Prop.path != "").order_by(Prop.id).all())
    for pr in props:
        item(pr.path, "Bible/Props", "prop", "bible", None, {"take": 1, "version": 1}, asset_id=pr.id, prop_id=pr.id, approved=True,
             updated_at=_iso(pr.created_at), label=pr.name)
    return {"project": {"id": project.id, "title": project.title, "aspect": project.aspect, "languages": list(project.languages or []),
                        "primary_language": project.primary_language},
            "scope": scope, "generated_at": _iso(utcnow()), "episodes": episodes, "items": items}


# ── render plan: the desktop renders exactly what the server would ───────────

def fresh_upscale(db: Session, shot_id: int, video: Take | None = None) -> Take | None:
    """A ready upscale of the shot's current video (an upscale goes stale once its video isn't current)."""
    video = video or current(db, shot_id, "video")
    if video is None:
        return None
    pick = current(db, shot_id, "upscale")
    if pick is not None and pick.parent_take_id == video.id and not pick.stale:
        return pick
    return next((t for t in takes(db, shot_id, "upscale") if t.parent_take_id == video.id and not t.stale), None)


def _even(v: float) -> int:
    return max(2, int(round(v / 2)) * 2)


def render_plan(db: Session, episode: Episode, lang: str | None = None, w: int | None = None, h: int | None = None,
                fps: int = 24, effects: bool = True, captions: bool = True, music: bool = True,
                upscaled: bool = False) -> dict[str, Any]:
    """The final render of this cut as data: per segment the source, timing, audio and ready-made filter strings for
    w×h, then the end card, layers, music, captions and loudness. Uses assembler.plan() and assembler.timeline(), the
    code the server render runs. LUT files are written @@LUT_<id>@@; every media reference is a storage key."""
    st = get_storage()
    project = db.get(Project, episode.project_id)
    lang = (lang or project.primary_language)[:8]
    if not w or not h:
        w, h = ff.dims_for(project.aspect, 1080)
    w, h = _even(min(max(int(w), 16), 8192)), _even(min(max(int(h), 16), 8192))
    fps = min(max(int(fps or 24), 1), 120)
    ro = assembler.render_options(db, episode, {})
    keys: list[str] = []

    def key(k: str) -> str:
        if k and k not in keys:
            keys.append(k)
        return k

    tmp = st.tmp_dir()
    try:
        segs, warnings = assembler.plan(db, episode, lang, "final", tmp)
        if not segs:
            raise HTTPException(400, "This episode has no shots to render")
        timed, cues, overlays = assembler.timeline(segs, effects, ro["sfx"])
        all_luts = {str(lt["id"]): lt["path"] for lt in project.luts or [] if lt.get("id") and lt.get("path") and st.exists(lt["path"])}
        marks = {i: f"@@LUT_{i}@@" for i in all_luts}
        used_luts: set[str] = set()
        out: list[dict[str, Any]] = []
        for i, tm in enumerate(timed):
            sg, fx = tm.sg, tm.fx
            src = sg.source_key or st.save_file(f"projects/{project.id}/desktop/placeholder_{sg.shot.id}.png", sg.source)
            up = fresh_upscale(db, sg.shot.id) if upscaled and sg.source_kind == "video" else None
            if up is not None:
                src = up.path
            look = str(fx.get("look") or "")
            if look.startswith("lut:") and look[4:] in all_luts:
                used_luts.add(look[4:])
            seg: dict[str, Any] = {
                "shot_id": sg.shot.id, "code": sg.shot.code, "source": key(src), "source_kind": sg.source_kind,
                "upscaled": up is not None, "duration": round(sg.duration, 3), "trim_in": round(sg.trim_in, 3), "speed": tm.speed,
                "seg_len": round(tm.seg_len, 3), "start": round(tm.start, 3), "audio_override": key(sg.audio_key) or None,
                "extra_audio": [{"key": key(e[3] if len(e) > 3 else ""), "offset": float(e[1]), "gain_db": float(e[2]) if len(e) > 2 else 0.0}
                                for e in sg.extra_audio],
                "keep_src_audio": sg.keep_src_audio, "src_gain_db": sg.src_gain_db,
                "transition": list(tm.transition) if tm.transition else None}
            if sg.source_kind == "still":
                seg.update(has_audio=False, pre="", stabilize=False, center=None, kenburns=ff.still_kenburns(fx),
                           vf_post=fxlib.video_filters(fx, w, h, sg.duration, fps, marks), af_fx=fxlib.audio_filters(fx, sg.duration),
                           vf=ff.still_vf(w, h, sg.duration, fps, True, fx, marks))
            else:
                path = st.abs(src)
                center = assembler._reframe_center(path, w, h, tmp, i) if ro["auto_reframe"] else None
                center = (round(center[0], 4), round(center[1], 4)) if center else None
                pre, post = ff.speed_filters(fx), fxlib.video_filters(fx, w, h, tm.seg_len, fps, marks)
                seg.update(has_audio=ff.has_audio(path), pre=pre, stabilize=bool(fx.get("stabilize")),
                           center=list(center) if center else None, kenburns=False, vf_post=post,
                           af_fx=ff.clip_audio_filters(fx, tm.seg_len), vf=ff.clip_vf(pre, w, h, center, fps, post))
            out.append(seg)

        total = timed[-1].start + timed[-1].seg_len
        end = None
        card = assembler._end_card(project, db, w, h, tmp)
        if card:
            k = st.save_file(f"projects/{project.id}/desktop/endcard_{episode.id}_{w}x{h}.png", card[0])
            tr = assembler.END_CARD_FADE if any(tm.transition for tm in timed) else None
            end = {"key": key(k), "seconds": card[1], "transition": list(tr) if tr else None,
                   "vf": ff.still_vf(w, h, card[1], fps, kenburns=False)}
            total += card[1] - (max(0.1, min(tr[1], card[1] / 2, total / 2)) if tr else 0)

        layers: dict[str, list] = {"pics": [], "sounds": []}
        if effects:
            pics, sounds = layerlib.resolve(episode.layers, lambda rel: rel if rel and st.exists(rel) else None)
            for c in pics:
                chain, x, y = layerlib.pic_chain(c, w, h, layerlib._aspect(st.abs(c["path"])))
                layers["pics"].append({"key": key(c["path"]), "kind": c["kind"], "start": c["start"], "in": c.get("in", 0),
                                       "dur": c["dur"], "chain": chain, "x": x, "y": y})
            for c in sounds:
                if ff.has_audio(st.abs(c["path"])):  # the mix skips files without sound
                    layers["sounds"].append({"key": key(c["path"]), "start": c["start"], "in": c.get("in", 0), "dur": c["dur"],
                                             "gain_db": c.get("gain_db", 0), "fade_in": c.get("fade_in", 0),
                                             "fade_out": c.get("fade_out", 0)})

        bed = None
        m = assembler.music_track(db, episode)
        settings = episode.settings or {}
        if music and m and m.path and st.exists(m.path):
            bed = {"key": key(m.path), "volume_db": float(settings.get("music_volume_db", -16)), "duck": bool(settings.get("duck", True))}
        elif music:
            warnings.append("No music track yet")

        burn = bool(captions) and ro["caption_style"] != "none"
        srt, ass = assembler.caption_files(cues, overlays, burn, ro["caption_style"], w, h, tmp)
        snap = snapshot(db, episode)
        return {
            "episode_id": episode.id, "project_id": project.id, "lang": lang, "w": w, "h": h, "fps": fps,
            "options": {"effects": effects, "captions": captions, "music": music, "upscaled": upscaled},
            "cut_version": latest_number(db, episode.id), "fingerprint": fingerprint(snap), "generated_at": _iso(utcnow()),
            "duration_s": round(total, 3), "warnings": warnings, "segments": out, "end_card": end, "layers": layers, "music": bed,
            "captions": {"srt": srt.read_text(encoding="utf-8") if srt else "", "ass": ass.read_text(encoding="utf-8") if ass else "",
                         "burn": burn, "style": ro["caption_style"], "font": get_settings().caption_font},
            "luts": {i: key(all_luts[i]) for i in sorted(used_luts)},
            "loudnorm": ff.LOUDNORM,
            "stabilize_filters": {"detect": ff.STAB_DETECT.format(trf="@@TRF@@"), "transform": ff.STAB_TRANSFORM.format(trf="@@TRF@@")},
            "keys": keys,
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ── chunked render upload (to the Render Center) ─────────────────────────────

def _uploads() -> Path:
    d = Path(get_storage().root) / "_uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def upload_files(uid: str) -> tuple[Path, Path]:
    """(the partial file, its JSON sidecar). Both survive a restart, so an upload can resume."""
    if not re.fullmatch(r"[0-9a-f]{32}", uid or ""):
        raise HTTPException(404, "Upload not found")
    d = _uploads()
    return d / f"{uid}.part", d / f"{uid}.json"


def upload_meta(uid: str, user: User) -> dict[str, Any]:
    part, side = upload_files(uid)
    if not side.exists():
        raise HTTPException(404, "Upload not found (finished, or cleared after a week)")
    meta = json.loads(side.read_text(encoding="utf-8"))
    if meta.get("user_id") != user.id and role_rank(user.role) < role_rank("producer"):
        raise HTTPException(403, "This upload belongs to someone else")
    return meta


def received(uid: str) -> int:
    part, _ = upload_files(uid)
    return part.stat().st_size if part.exists() else 0


def start_upload(db: Session, episode: Episode, user: User, body: dict[str, Any]) -> dict[str, Any]:
    max_mb = float(settings_store.get_setting(db, "desktop_upload_max_mb") or 8000)
    size = int(body.get("size") or 0)
    if size <= 0:
        raise HTTPException(400, "The render file is empty")
    if size > max_mb * 1024 * 1024:
        raise HTTPException(413, f"That render is {size / 1048576:,.0f} MB; the team allows at most {max_mb:,.0f} MB per upload")
    now = time.time()
    for f in _uploads().glob("*"):  # unfinished uploads older than a week
        try:
            if now - f.stat().st_mtime > UPLOAD_KEEP_S:
                f.unlink()
        except OSError:
            pass
    uid = uuid.uuid4().hex
    part, side = upload_files(uid)
    part.write_bytes(b"")
    side.write_text(json.dumps({**body, "size": size, "episode_id": episode.id, "project_id": episode.project_id,
                                "user_id": user.id, "started_at": _iso(utcnow())}), encoding="utf-8")
    return {"upload_id": uid, "chunk_size": CHUNK}


def _safe(s: str, n: int = 24) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "-", s or "").strip("-")[:n] or "render"


def complete_upload(db: Session, uid: str, user: User, srt: str | None = None) -> Export:
    """Turn a finished upload into a ready Export (version = the episode's next render number)."""
    meta = upload_meta(uid, user)
    part, side = upload_files(uid)
    have = received(uid)
    if have != int(meta["size"]):
        raise HTTPException(409, f"The upload isn't finished: {have} of {meta['size']} bytes received")
    ep = db.get(Episode, meta["episode_id"])
    if ep is None:
        raise HTTPException(404, "Episode not found")
    project = db.get(Project, ep.project_id)
    st = get_storage()
    lang = str(meta.get("language") or project.primary_language)[:8]
    preset = _safe(str(meta.get("preset") or "custom"))
    ext = _ext(str(meta.get("filename") or ""))
    ext = ext if ext in ("mp4", "mov", "mkv", "webm") else "mp4"
    version = next_export_version(db, ep.id)
    opts = {"source": "desktop", **{k: meta.get(k) for k in ("w", "h", "fps", "codec", "encoder", "cut_version", "machine",
                                                             "fingerprint", "filename")}}
    ex = Export(project_id=project.id, episode_id=ep.id, language=lang, preset=f"desktop:{preset}"[:40], kind="final",
                options=opts, status="ready", version=version, created_by=user.id)
    db.add(ex)
    db.flush()
    base = f"projects/{project.id}/exports/e{ep.number:02}_{lang}_{preset}_v{version}_{ex.id}"
    ex.path = st.save_file(f"{base}.{ext}", part, move=True)
    src = st.abs(ex.path)
    try:
        ex.duration_s = float(meta.get("duration_s") or 0) or ff.duration(src)
    except Exception:
        ex.duration_s = float(meta.get("duration_s") or 0)
    tmp = st.tmp_dir()
    try:
        ex.thumbnail_path = st.save_file(f"{base}.jpg", ff.thumbnail(src, tmp / "thumb.jpg", width=480))
    except Exception as e:  # a render without a thumbnail is still a render
        print(f"[desktop] thumbnail failed for upload {uid}: {e}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    try:
        ex.peaks = ff.peaks(src)
    except Exception:
        ex.peaks = []
    if srt and srt.strip():
        ex.srt_path = st.save_bytes(f"{base}.srt", srt.encode("utf-8"))
    side.unlink(missing_ok=True)
    db.commit()
    emit(db, project.id, "export.updated", {"export_id": ex.id, "status": "ready", "source": "desktop", "version": version},
         user_id=user.id)
    return ex


# ── AI upscale step (a paid fal call, through jobs) ──────────────────────────

def upscale_plan(db: Session, episode: Episode, shot_ids: list[int] | None = None, target_h: int = 2160) -> dict[str, Any]:
    """Which shots' current videos to upscale so their short side reaches target_h (16:9 → 3840×2160, 9:16 → 2160×3840),
    with the price of each. Skipped: no video, already that big, already upscaled (not stale), or an upscale running."""
    from . import budget
    from .jobs import ACTIVE
    if not 360 <= int(target_h) <= 4320:
        raise HTTPException(400, "target_h must be between 360 and 4320")
    st = get_storage()
    q = db.query(Shot).filter(Shot.episode_id == episode.id)
    q = q.filter(Shot.id.in_(shot_ids)) if shot_ids else q.filter(Shot.include.is_(True))
    running = {sid for (sid,) in db.query(Job.shot_id).filter(Job.episode_id == episode.id, Job.type == "upscale",
                                                               Job.status.in_(ACTIVE)).all()}
    est = budget.Estimator(db)
    items, skipped = [], []
    for s in q.order_by(Shot.order, Shot.id).all():
        def skip(reason: str) -> None:
            skipped.append({"shot_id": s.id, "code": s.code, "reason": reason})
        v = current(db, s.id, "video")
        if v is None or not v.path:
            skip("No video yet")
            continue
        if fresh_upscale(db, s.id, v):
            skip("Already upscaled")
            continue
        if s.id in running:
            skip("An upscale is already on its way")
            continue
        sw, sh = ff.video_size(st.abs(v.path))
        if not sw or not sh:
            skip("Couldn't read the video's size")
            continue
        factor = min(target_h / min(sw, sh), MAX_UPSCALE)
        if factor <= 1.05:
            skip(f"Already {sw}×{sh}")
            continue
        secs = float(v.duration_s or 0) or ff.duration(st.abs(v.path))
        items.append({"shot_id": s.id, "code": s.code, "take_id": v.id, "from": [sw, sh], "to": [_even(sw * factor), _even(sh * factor)],
                      "factor": round(factor, 3), "seconds": round(secs, 2), "usd": round(est.upscale(secs), 4)})
    return {"items": items, "total_usd": round(sum(i["usd"] for i in items), 4), "skipped": skipped, "target_h": int(target_h)}


def upscale_specs(episode: Episode, plan: dict[str, Any]) -> list[dict]:
    from .jobs import spec
    return [spec("upscale", payload={"take_id": i["take_id"], "w": i["to"][0], "h": i["to"][1], "factor": i["factor"],
                                     "target_h": plan["target_h"]},
                 project_id=episode.project_id, episode_id=episode.id, shot_id=i["shot_id"], estimate=i["usd"],
                 label=f"Upscale {i['code']}") for i in plan["items"]]
