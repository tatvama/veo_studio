"""Projects, episodes and the writing room (brief, arc, hooks, script, bible proposal, breakdown, localisation)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import catalog, settings_store
from ..core import studio
from ..db import get_db
from ..events import emit
from ..models import AudioAsset, Episode, Export, Project, Scene, Shot, Style, User
from ..security import current_user, require
from .common import audio_out, export_out, get_or_404, project_out, shot_out

router = APIRouter(prefix="/api", tags=["projects"])


WORKFLOWS = ("director", "script", "shots")


class ProjectIn(BaseModel):
    concept: str = Field(min_length=3)
    title: str = ""
    type: str = "short"
    aspect: str | None = None
    languages: list[str] = ["en"]
    primary_language: str | None = None
    quality_mode: str | None = None
    agent_mode: str = "copilot"
    budget_cap_usd: float | None = None
    style_preset: str | None = None
    auto_brief: bool = True
    workflow: str = "director"


@router.get("/projects")
def list_projects(archived: bool = False, user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.query(Project).filter(Project.archived.is_(archived)).order_by(Project.updated_at.desc()).all()
    return [project_out(db, p) for p in rows]


@router.post("/projects")
def create_project(body: ProjectIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    if body.type not in catalog.PROJECT_TYPES:
        raise HTTPException(400, f"type must be one of {list(catalog.PROJECT_TYPES)}")
    if body.aspect and body.aspect not in ("9:16", "16:9", "1:1"):
        raise HTTPException(400, "aspect must be 9:16, 16:9 or 1:1")
    if body.quality_mode and body.quality_mode not in catalog.QUALITY_MODES:
        raise HTTPException(400, "bad quality_mode")
    langs = [l for l in body.languages if l in catalog.LANGUAGES] or ["en"]
    primary = body.primary_language if body.primary_language in langs else langs[0]
    p = Project(title=body.title or "Untitled", type=body.type, concept=body.concept.strip(),
                aspect=body.aspect or catalog.PROJECT_TYPES[body.type]["aspect"], languages=langs, primary_language=primary,
                quality_mode=body.quality_mode or settings_store.get_setting(db, "default_quality_mode") or "saver",
                agent_mode=body.agent_mode if body.agent_mode in ("copilot", "autopilot") else "copilot",
                budget_cap_usd=body.budget_cap_usd, created_by=user.id,
                workflow=body.workflow if body.workflow in WORKFLOWS else "director",
                brief={"duration_s": catalog.PROJECT_TYPES[body.type]["duration_s"]})
    db.add(p)
    db.flush()
    if body.style_preset:
        preset = next((s for s in catalog.STYLE_PRESETS if s["name"] == body.style_preset), None)
        if preset:
            st = Style(**preset)
            db.add(st)
            db.flush()
            p.style_id = st.id
    db.add(Episode(project_id=p.id, number=1, title="Episode 1" if body.type == "series" else ""))
    db.commit()
    emit(db, p.id, "project.created", {"title": p.title}, user_id=user.id)
    if body.auto_brief:
        try:
            studio.generate_brief(db, user, p)
        except Exception as e:  # brief is a convenience; project creation must not fail because of it
            print(f"[projects] auto brief failed: {e}")
    return project_out(db, p, full=True)


@router.get("/projects/{pid}")
def get_project(pid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = get_or_404(db, Project, pid)
    out = project_out(db, p, full=True)
    out["style"] = db.get(Style, p.style_id).to_dict() if p.style_id else None
    return out


class ProjectPatch(BaseModel):
    title: str | None = None
    concept: str | None = None
    aspect: str | None = None
    languages: list[str] | None = None
    primary_language: str | None = None
    quality_mode: str | None = None
    agent_mode: str | None = None
    budget_cap_usd: float | None = None
    clear_budget_cap: bool = False
    brief: dict[str, Any] | None = None
    style_id: int | None = None
    brand_kit_id: int | None = None
    archived: bool | None = None
    workflow: str | None = None
    pronunciations: dict[str, str] | None = None  # {term: how to say it}


@router.patch("/projects/{pid}")
def patch_project(pid: int, body: ProjectPatch, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    p = get_or_404(db, Project, pid)
    data = body.model_dump(exclude_unset=True)
    if "languages" in data:
        data["languages"] = [l for l in data["languages"] if l in catalog.LANGUAGES] or p.languages
    if data.get("quality_mode") and data["quality_mode"] not in catalog.QUALITY_MODES:
        raise HTTPException(400, "bad quality_mode")
    if data.get("aspect") and data["aspect"] not in ("9:16", "16:9", "1:1"):
        raise HTTPException(400, "aspect must be 9:16, 16:9 or 1:1")
    if "workflow" in data and data["workflow"] not in WORKFLOWS:
        raise HTTPException(400, f"workflow must be one of {list(WORKFLOWS)}")
    if "budget_cap_usd" in data and user.role not in ("producer", "admin"):
        raise HTTPException(403, "Only producers can change the project budget")
    if data.pop("clear_budget_cap", False):
        p.budget_cap_usd = None
    if "brief" in data:
        p.brief = {**(p.brief or {}), **data.pop("brief")}
    for k, v in data.items():
        setattr(p, k, v)
    if p.primary_language not in p.languages:
        p.languages = [p.primary_language, *p.languages]
    db.commit()
    emit(db, p.id, "project.updated", {"what": list(data)}, user_id=user.id)
    return get_project(pid, user, db)


@router.post("/projects/{pid}/brief/generate")
def gen_brief(pid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    return studio.generate_brief(db, user, get_or_404(db, Project, pid))


class ArcIn(BaseModel):
    episodes: int = 5


@router.post("/projects/{pid}/arc/generate")
def gen_arc(pid: int, body: ArcIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    return studio.generate_series_arc(db, user, get_or_404(db, Project, pid), max(1, min(body.episodes, 30)))


class BibleIn(BaseModel):
    episode_id: int | None = None


@router.post("/projects/{pid}/bible/propose")
def bible_propose(pid: int, body: BibleIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    p = get_or_404(db, Project, pid)
    ep = db.get(Episode, body.episode_id) if body.episode_id else None
    return studio.propose_bible(db, user, p, ep)


# ── episodes ─────────────────────────────────────────────────────────────────

class EpisodeIn(BaseModel):
    title: str = ""
    outline: str = ""


@router.post("/projects/{pid}/episodes")
def add_episode(pid: int, body: EpisodeIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    p = get_or_404(db, Project, pid)
    n = (max([e.number for e in db.query(Episode).filter(Episode.project_id == pid)] or [0])) + 1
    e = Episode(project_id=pid, number=n, title=body.title or f"Episode {n}", outline=body.outline)
    db.add(e)
    db.commit()
    emit(db, p.id, "project.updated", {"what": "episodes"})
    return e.to_dict()


@router.get("/episodes/{eid}")
def get_episode(eid: int, lang: str | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e = get_or_404(db, Episode, eid)
    p = db.get(Project, e.project_id)
    shots = db.query(Shot).filter(Shot.episode_id == eid).order_by(Shot.include.desc(), Shot.order, Shot.id).all()
    scenes = db.query(Scene).filter(Scene.episode_id == eid).order_by(Scene.order).all()
    music = db.query(AudioAsset).filter(AudioAsset.episode_id == eid, AudioAsset.kind == "music").order_by(AudioAsset.id.desc()).all()
    exports = db.query(Export).filter(Export.episode_id == eid).order_by(Export.id.desc()).all()
    return e.to_dict(scenes=[s.to_dict() for s in scenes], shots=[shot_out(db, s, p, lang) for s in shots],
                     music=[audio_out(a) for a in music], exports=[export_out(x) for x in exports],
                     total_duration_s=sum(s.duration_s for s in shots if s.include))


class EpisodePatch(BaseModel):
    title: str | None = None
    outline: str | None = None
    season: int | None = None
    script: dict[str, Any] | None = None
    settings: dict[str, Any] | None = None
    summary_for_next: str | None = None


@router.patch("/episodes/{eid}")
def patch_episode(eid: int, body: EpisodePatch, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e = get_or_404(db, Episode, eid)
    data = body.model_dump(exclude_unset=True)
    if "settings" in data:
        e.settings = {**(e.settings or {}), **data.pop("settings")}
    old_script = dict(e.script or {})
    touched: list[dict] = []
    for k, v in data.items():
        setattr(e, k, v)
    if "script" in data:
        from ..core import dependencies, mentions
        p = db.get(Project, e.project_id)
        e.script, _created = mentions.resolve_script(db, p, e.script, create_missing=False, user=user)
        mentions.attach_entities(db, p, e.script)
        studio.save_script_version(db, e, "manual", user, note="Edited in Story")
        touched = dependencies.apply_script_changes(db, p, e, old_script, e.script)
    db.commit()
    emit(db, e.project_id, "episode.updated", {"episode_id": e.id, "what": list(body.model_dump(exclude_unset=True))},
         user_id=user.id)
    return e.to_dict(script_changes=touched)


class HooksIn(BaseModel):
    n: int = 6
    angle: str = ""


@router.post("/episodes/{eid}/hooks/generate")
def gen_hooks(eid: int, body: HooksIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    return studio.generate_hooks(db, user, get_or_404(db, Episode, eid), max(2, min(body.n, 12)), body.angle)


class HookSelect(BaseModel):
    index: int | None = None
    text: str | None = None


@router.post("/episodes/{eid}/hooks/select")
def sel_hook(eid: int, body: HookSelect, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e = get_or_404(db, Episode, eid)
    studio.select_hook(db, e, body.index, body.text)
    return e.to_dict()


class ScriptIn(BaseModel):
    instructions: str = ""


@router.post("/episodes/{eid}/script/generate")
def gen_script(eid: int, body: ScriptIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    return studio.generate_script(db, user, get_or_404(db, Episode, eid), body.instructions)


@router.post("/episodes/{eid}/shots/breakdown")
def gen_breakdown(eid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    return studio.breakdown(db, user, get_or_404(db, Episode, eid))


class LocalizeIn(BaseModel):
    language: str
    overwrite: bool = False


@router.post("/episodes/{eid}/localize")
def localize(eid: int, body: LocalizeIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    if body.language not in catalog.LANGUAGES:
        raise HTTPException(400, "unknown language")
    n = studio.localize(db, user, get_or_404(db, Episode, eid), body.language, body.overwrite)
    return {"translated": n}


@router.post("/episodes/{eid}/summary/generate")
def gen_summary(eid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    return {"summary": studio.summarize_episode(db, user, get_or_404(db, Episode, eid))}


@router.post("/exports/{xid}/approve")
def approve_export(xid: int, user: User = Depends(require("producer")), db: Session = Depends(get_db)):
    x = get_or_404(db, Export, xid)
    x.approved_by = None if x.approved_by else user.id
    db.commit()
    emit(db, x.project_id, "export.updated", {"export_id": x.id, "status": x.status, "approved": bool(x.approved_by)},
         user_id=user.id)
    return export_out(x)


@router.post("/audio/{aid}/select")
def select_audio(aid: int, user: User = Depends(require("reviewer")), db: Session = Depends(get_db)):
    a = get_or_404(db, AudioAsset, aid)
    for other in db.query(AudioAsset).filter(AudioAsset.episode_id == a.episode_id, AudioAsset.kind == a.kind).all():
        other.selected = other.id == a.id
    db.commit()
    emit(db, a.project_id, "episode.updated", {"episode_id": a.episode_id, "what": "music"}, user_id=user.id)
    return audio_out(a)


class CutIn(BaseModel):
    count: int = 3
    seconds: int = 30


@router.post("/episodes/{eid}/cutdowns")
def cutdowns(eid: int, body: CutIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    return {"episode_ids": studio.make_cutdowns(db, user, get_or_404(db, Episode, eid), max(1, min(body.count, 6)),
                                                body.seconds)}
