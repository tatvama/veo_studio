"""Shared API helpers: lookups and JSON views of rows (with media URLs)."""
from __future__ import annotations

from typing import Any, TypeVar

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core import budget, studio
from ..models import (AudioAsset, Character, CharacterAsset, Comment, Episode, Export, Job, Location, LocationAsset, Project,
                      Shot, Take, User, VoiceProfile)
from ..pipeline.prompting import effective_quality, effective_voice_mode
from ..pipeline.selection import current
from ..storage import get_storage

T = TypeVar("T")


def get_or_404(db: Session, model: type[T], id_: Any, what: str | None = None) -> T:
    row = db.get(model, id_)
    if row is None:
        raise HTTPException(404, f"{what or model.__name__} not found")
    return row


def url(path: str) -> str:
    return get_storage().url(path) if path else ""


def take_out(t: Take | None) -> dict | None:
    if t is None:
        return None
    return t.to_dict(url=url(t.path), thumb_url=url(t.thumb_path))


def user_brief(u: User | None) -> dict | None:
    return {"id": u.id, "name": u.name or u.email.split("@")[0], "email": u.email, "role": u.role} if u else None


def shot_out(db: Session, s: Shot, project: Project, lang: str | None = None) -> dict:
    lang = lang or project.primary_language
    active = [j.type for j in db.query(Job.type).filter(Job.shot_id == s.id, Job.status.in_(("queued", "running"))).all()]
    n_comments = db.query(func.count(Comment.id)).filter(Comment.target_type == "shot", Comment.target_id == s.id,
                                                          Comment.resolved.is_(False)).scalar()
    return s.to_dict(
        keyframe=take_out(current(db, s.id, "keyframe")),
        video=take_out(current(db, s.id, "video")),
        voice=take_out(current(db, s.id, "voice", lang)),
        narration_take=take_out(current(db, s.id, "narration", lang)),
        lipsync=take_out(current(db, s.id, "lipsync", lang)),
        voicelock=take_out(current(db, s.id, "voicelock", lang)),
        effective_quality=effective_quality(s, project),
        effective_voice_mode=effective_voice_mode(s, project, lang),
        active_jobs=active,
        comments=n_comments,
        ref_images=[{**r, "url": url(r.get("path", ""))} for r in (s.ref_images or [])],
    )


def project_out(db: Session, p: Project, full: bool = False) -> dict:
    eps = db.query(Episode).filter(Episode.project_id == p.id).order_by(Episode.number).all()
    thumb = ""
    ex = (db.query(Export).filter(Export.project_id == p.id, Export.status == "ready")
          .order_by(Export.id.desc()).first())
    if ex:
        thumb = url(ex.thumbnail_path)
    else:
        t = (db.query(Take).join(Shot, Shot.id == Take.shot_id).join(Episode, Episode.id == Shot.episode_id)
             .filter(Episode.project_id == p.id, Take.kind == "keyframe", Take.archived.is_(False))
             .order_by(Take.id).first())
        thumb = url(t.thumb_path or t.path) if t else ""
    out = p.to_dict(episodes=[e.to_dict() for e in eps] if full else [{"id": e.id, "number": e.number, "title": e.title,
                                                                         "kind": e.kind} for e in eps],
                    spent_usd=round(budget.spent(db, project_id=p.id), 4), thumb_url=thumb,
                    owner=user_brief(db.get(User, p.created_by)) if p.created_by else None)
    ap = dict(p.autopilot or {})
    if ap.get("status") == "running":  # the run ended without saying so (e.g. the server stopped): don't show it as running
        from ..models import Job
        j = db.get(Job, ap.get("job_id")) if ap.get("job_id") else None
        if not j or j.status not in ("queued", "running"):
            ap["status"] = "failed" if j and j.status == "failed" else "stopped"
            ap["error"] = ap.get("error") or (j.error[:300] if j and j.error else "")
        out["autopilot"] = ap
    if full:
        out["cast"] = [character_out(db, c, brief=True) for c in studio.cast(db, p)]
        out["locations"] = [location_out(db, l, brief=True) for l in studio.locations(db, p)]
    return out


def character_out(db: Session, c: Character, brief: bool = False) -> dict:
    assets = (db.query(CharacterAsset).filter(CharacterAsset.character_id == c.id, CharacterAsset.archived.is_(False))
              .order_by(CharacterAsset.id).all())
    front = (next((a for a in assets if a.kind == "source" and a.approved), None)  # the user's own photo
             or next((a for a in assets if a.kind == "front" and a.approved), None) or next((a for a in assets if a.kind == "front"), None)
             or (assets[0] if assets else None))
    out = c.to_dict(avatar_url=url(front.path) if front else "")
    ident = dict(c.identity or {})
    if ident.get("status") in ("preparing", "training"):  # the run ended without saying so: don't show it as in progress
        j = db.get(Job, ident.get("job_id")) if ident.get("job_id") else None
        if not j or j.status not in ("queued", "running"):
            ident["status"] = "cancelled" if j and j.status == "cancelled" else "failed"
            ident["error"] = ident.get("error") or (j.error[:300] if j and j.error else "Training stopped before it finished")
        out["identity"] = ident
    if not brief:
        from ..core import identity as identity_core
        out["training"] = identity_core.summary(db, c)
        out["assets"] = [a.to_dict(url=url(a.path)) for a in assets]
        from ..core import lock as lock_core
        from ..models import CharacterVersion, Costume
        out["lock_effective"] = lock_core.effective(c)
        out["versions"] = [v.to_dict() for v in db.query(CharacterVersion).filter(CharacterVersion.character_id == c.id)
                           .order_by(CharacterVersion.version)]
        out["costumes"] = [x.to_dict() for x in db.query(Costume).filter(Costume.character_id == c.id, Costume.archived.is_(False))
                           .order_by(Costume.id)]
        out["voices"] = [v.to_dict(sample_url=url(v.sample_path))
                         for v in db.query(VoiceProfile).filter(VoiceProfile.character_id == c.id).order_by(VoiceProfile.language)]
    else:
        out["voices"] = [v.language for v in db.query(VoiceProfile).filter(VoiceProfile.character_id == c.id)]
        out["asset_count"] = len(assets)
    return out


def location_out(db: Session, l: Location, brief: bool = False) -> dict:
    assets = (db.query(LocationAsset).filter(LocationAsset.location_id == l.id, LocationAsset.archived.is_(False))
              .order_by(LocationAsset.id).all())
    out = l.to_dict(thumb_url=url(assets[0].path) if assets else "")
    if not brief:
        out["assets"] = [a.to_dict(url=url(a.path)) for a in assets]
    return out


def export_out(e: Export) -> dict:
    return e.to_dict(url=url(e.path), srt_url=url(e.srt_path), thumb_url=url(e.thumbnail_path))


def audio_out(a: AudioAsset) -> dict:
    return a.to_dict(url=url(a.path))
