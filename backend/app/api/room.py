"""Writers' room API: scene cards, script versions, critic, continuity, table read, trends, marketing, sound design."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import catalog
from ..core import generation, jobs, studio
from ..db import get_db
from ..events import emit
from ..models import Episode, Project, Scene, ScriptVersion, User
from ..security import current_user, require
from .common import get_or_404, url

router = APIRouter(prefix="/api", tags=["writers-room"])


def _ep(db: Session, eid: int) -> tuple[Episode, Project]:
    e = get_or_404(db, Episode, eid)
    return e, db.get(Project, e.project_id)


@router.post("/episodes/{eid}/scenes/plan")
def plan_scenes(eid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e, _ = _ep(db, eid)
    return studio.plan_scene_cards(db, user, e)


class ScenePatch(BaseModel):
    title: str | None = None
    summary: str | None = None
    goal: str | None = None
    conflict: str | None = None
    turn: str | None = None
    emotion: str | None = None
    time_of_day: str | None = None
    location_id: int | None = None
    characters: list[int] | None = None
    props: list[str] | None = None
    wardrobe: dict[str, str] | None = None
    prop_ids: list[int] | None = None
    continuity_notes: str | None = None
    coverage: list[str] | None = None
    blocking: str | None = None
    approved: bool | None = None


@router.patch("/scenes/{scid}")
def patch_scene(scid: int, body: ScenePatch, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    sc = get_or_404(db, Scene, scid)
    data = body.model_dump(exclude_unset=True)
    old_wardrobe, old_props = dict(sc.wardrobe or {}), list(sc.prop_ids or [])
    for k, v in data.items():
        setattr(sc, k, v)
    # change impact: shots that inherit the scene wardrobe or props now need new keyframes and videos
    if ("wardrobe" in data and (sc.wardrobe or {}) != old_wardrobe) or ("prop_ids" in data and list(sc.prop_ids or []) != old_props):
        from ..core import dependencies
        from ..models import Shot
        changed_chars = {c for c in set(old_wardrobe) | set(sc.wardrobe or {}) if old_wardrobe.get(c) != (sc.wardrobe or {}).get(c)}
        for s_ in db.query(Shot).filter(Shot.scene_id == sc.id, Shot.include.is_(True)).all():
            inherits = any(str(c) in {str(x) for x in (s_.characters or [])} and not (s_.outfits or {}).get(str(c)) for c in changed_chars)
            if inherits or ("prop_ids" in data and not s_.prop_ids):
                dependencies.mark_stale(db, s_, {"outfits"} if inherits else {"prop_ids"}, note="scene wardrobe changed")
    db.commit()
    ep = db.get(Episode, sc.episode_id)
    emit(db, ep.project_id, "episode.updated", {"episode_id": ep.id, "what": "scenes"}, user_id=user.id)
    return sc.to_dict()


@router.get("/episodes/{eid}/script/versions")
def script_versions(eid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.query(ScriptVersion).filter(ScriptVersion.episode_id == eid).order_by(ScriptVersion.version.desc()).limit(100).all()
    return [r.to_dict() for r in rows]


@router.post("/episodes/{eid}/script/versions/{vid}/restore")
def restore_version(eid: int, vid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e, _ = _ep(db, eid)
    return studio.restore_script_version(db, user, e, vid)


class CriticIn(BaseModel):
    rounds: int | None = None


@router.post("/episodes/{eid}/critic")
def critic_loop(eid: int, body: CriticIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e, p = _ep(db, eid)
    return jobs.submit(db, user, p, [generation.critic_spec(p, e, body.rounds)])


@router.post("/episodes/{eid}/critic/once")
def critic_once(eid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e, _ = _ep(db, eid)
    return studio.critique(db, user, e)


@router.post("/episodes/{eid}/continuity")
def continuity(eid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e, _ = _ep(db, eid)
    return studio.continuity_check(db, user, e)


class LangIn(BaseModel):
    language: str | None = None


@router.post("/episodes/{eid}/table-read")
def table_read(eid: int, body: LangIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e, p = _ep(db, eid)
    lang = body.language or p.primary_language
    if lang not in catalog.LANGUAGES:
        raise HTTPException(400, "unknown language")
    return jobs.submit(db, user, p, [generation.table_read_spec(db, p, e, lang)])


@router.get("/episodes/{eid}/table-read")
def get_table_read(eid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e = get_or_404(db, Episode, eid)
    return {lang: {**tr, "url": url(tr.get("path", ""))} for lang, tr in (e.table_read or {}).items()}


@router.post("/episodes/{eid}/polish")
def polish(eid: int, body: LangIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e, p = _ep(db, eid)
    lang = body.language or p.primary_language
    return {"polished": studio.native_polish(db, user, e, lang)}


@router.post("/projects/{pid}/trends")
def trends(pid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    return studio.trend_scout(db, user, get_or_404(db, Project, pid))


class MarketingIn(BaseModel):
    platforms: list[str] | None = None
    languages: list[str] | None = None


@router.post("/episodes/{eid}/marketing")
def marketing(eid: int, body: MarketingIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e, p = _ep(db, eid)
    return jobs.submit(db, user, p, [generation.marketing_spec(db, p, e, body.platforms, body.languages)])


@router.get("/episodes/{eid}/marketing")
def get_marketing(eid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e = get_or_404(db, Episode, eid)
    m = dict(e.marketing or {})
    m["thumbnail_files"] = [{**f, "url": url(f.get("path", ""))} for f in m.get("thumbnail_files", [])]
    return m


class SfxIn(BaseModel):
    shot_ids: list[int] | None = None


@router.post("/episodes/{eid}/sfx")
def sound_design(eid: int, body: SfxIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e, p = _ep(db, eid)
    return jobs.submit(db, user, p, [generation.sfx_spec(db, p, e, body.shot_ids)])


class OverlayIn(BaseModel):
    overlays: list[dict[str, Any]]


@router.put("/shots/{sid}/overlays")
def set_overlays(sid: int, body: OverlayIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    from ..models import Shot
    s = get_or_404(db, Shot, sid)
    s.overlays = [{"text": str(o.get("text", ""))[:120], "start": float(o.get("start", 0)), "end": float(o.get("end", 0) or 0),
                   "kind": o.get("kind", "title") if o.get("kind") in ("title", "lower_third") else "title"}
                  for o in body.overlays if o.get("text")]
    db.commit()
    return s.to_dict()
