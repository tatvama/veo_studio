"""Production control (v3): dashboards, change impact, seasons, @mentions, the Continuity Bible, character versions,
costumes and props."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core import continuity, dashboard, dependencies, generation, jobs, lock as lock_core, mentions, studio
from ..db import get_db
from ..events import emit
from ..models import (Character, CharacterAsset, CharacterVersion, Costume, Episode, Project, ProjectProp, Prop, Scene, Season,
                      Shot, User)
from ..pipeline.prompting import dialogue_warnings, look_of
from ..security import current_user, require
from ..storage import get_storage
from .common import get_or_404, url

router = APIRouter(prefix="/api", tags=["production"])
IMG_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}


def _episode(db: Session, eid: int) -> tuple[Episode, Project]:
    e = get_or_404(db, Episode, eid)
    return e, db.get(Project, e.project_id)


# ── dashboards ───────────────────────────────────────────────────────────────

@router.get("/episodes/{eid}/dashboard")
def episode_dash(eid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e, p = _episode(db, eid)
    return dashboard.episode_dashboard(db, p, e)


@router.get("/projects/{pid}/dashboard")
def project_dash(pid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return dashboard.project_dashboard(db, get_or_404(db, Project, pid))


# ── change impact ────────────────────────────────────────────────────────────

@router.get("/episodes/{eid}/impact")
def impact(eid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e, p = _episode(db, eid)
    return dependencies.impact(db, p, e)


class RegenIn(BaseModel):
    shot_ids: list[int] | None = None
    kinds: list[str] | None = None  # keyframe | video | voice | lipsync


@router.post("/episodes/{eid}/impact/regenerate")
def regenerate_stale(eid: int, body: RegenIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e, p = _episode(db, eid)
    specs = dependencies.regenerate_specs(db, p, e, body.shot_ids, body.kinds)
    if not specs:
        raise HTTPException(400, "Nothing stale to regenerate")
    return jobs.submit(db, user, p, specs)


@router.post("/takes/{tid}/fresh")
def mark_fresh(tid: int, user: User = Depends(require("reviewer")), db: Session = Depends(get_db)):
    """The editor looked at a stale take and decided it is still fine."""
    from ..models import Take
    t = get_or_404(db, Take, tid)
    t.stale, t.stale_reason = False, ""
    db.commit()
    return t.to_dict()


@router.get("/shots/{sid}/dialogue-check")
def dialogue_check(sid: int, lang: str | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    s = get_or_404(db, Shot, sid)
    p = db.get(Project, db.get(Episode, s.episode_id).project_id)
    return {"warnings": dialogue_warnings(s, lang or p.primary_language)}


# ── seasons ──────────────────────────────────────────────────────────────────

def _ensure_seasons(db: Session, project: Project) -> list[Season]:
    have = {s.number: s for s in db.query(Season).filter(Season.project_id == project.id).all()}
    for (n,) in db.query(Episode.season).filter(Episode.project_id == project.id).distinct().all():
        if n not in have:
            s = Season(project_id=project.id, number=n, title=f"Season {n}")
            db.add(s)
            have[n] = s
    db.flush()
    return sorted(have.values(), key=lambda s: s.number)


def _season_out(db: Session, s: Season) -> dict:
    eps = db.query(Episode).filter(Episode.project_id == s.project_id, Episode.season == s.number).order_by(Episode.number).all()
    return s.to_dict(episodes=[{"id": e.id, "number": e.number, "title": e.title, "status": e.status} for e in eps])


@router.get("/projects/{pid}/seasons")
def list_seasons(pid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = get_or_404(db, Project, pid)
    out = [_season_out(db, s) for s in _ensure_seasons(db, p)]
    db.commit()
    return out


class SeasonIn(BaseModel):
    number: int | None = None
    title: str = ""
    arc: str = ""
    episodes: int = 0  # how many empty episodes to create in it


@router.post("/projects/{pid}/seasons")
def add_season(pid: int, body: SeasonIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    p = get_or_404(db, Project, pid)
    seasons = _ensure_seasons(db, p)
    number = body.number or (max((s.number for s in seasons), default=0) + 1)
    if any(s.number == number for s in seasons):
        raise HTTPException(400, f"Season {number} already exists")
    s = Season(project_id=p.id, number=number, title=body.title or f"Season {number}", arc=body.arc)
    db.add(s)
    db.flush()
    for i in range(max(0, min(body.episodes, 50))):
        db.add(Episode(project_id=p.id, season=number, number=i + 1, title=f"Episode {i + 1}"))
    db.commit()
    emit(db, p.id, "project.updated", {"what": ["seasons"]}, user_id=user.id)
    return _season_out(db, s)


class SeasonPatch(BaseModel):
    title: str | None = None
    arc: str | None = None
    status: str | None = None


@router.patch("/seasons/{sid}")
def patch_season(sid: int, body: SeasonPatch, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    s = get_or_404(db, Season, sid)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(s, k, v)
    db.commit()
    return _season_out(db, s)


# ── @mentions ────────────────────────────────────────────────────────────────

@router.get("/projects/{pid}/mentions")
def mention_candidates(pid: int, q: str = "", user: User = Depends(current_user), db: Session = Depends(get_db)):
    return mentions.candidates(db, get_or_404(db, Project, pid), q)


class ResolveIn(BaseModel):
    create_missing: bool = True


@router.post("/episodes/{eid}/script/resolve")
def resolve_mentions(eid: int, body: ResolveIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Turn bare @Names in the script into tokens; unknown names become new characters in the cast."""
    e, p = _episode(db, eid)
    script, created = mentions.resolve_script(db, p, e.script, body.create_missing, user)
    found = mentions.attach_entities(db, p, script)
    if script != (e.script or {}):
        e.script = script
        studio.save_script_version(db, e, "manual", user, note="Resolved @mentions")
    db.commit()
    emit(db, p.id, "episode.updated", {"episode_id": e.id, "what": "script"}, user_id=user.id)
    return {"script": e.script, "created": created, "entities": found}


class MentionCreateIn(BaseModel):
    kind: str  # character | location | prop
    name: str
    project_id: int


@router.post("/mentions/create")
def mention_create(body: MentionCreateIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """The editor's quick-create for an unknown @name."""
    p = get_or_404(db, Project, body.project_id)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name is empty")
    if body.kind == "character":
        row = Character(name=name, shared=False, created_by=user.id)
        db.add(row)
        db.flush()
        studio.link_character(db, p, row)
    elif body.kind == "location":
        row = studio._find_loc(db, p, name)
    elif body.kind == "prop":
        row = Prop(name=name, shared=False)
        db.add(row)
        db.flush()
        db.add(ProjectProp(project_id=p.id, prop_id=row.id))
    else:
        raise HTTPException(400, "kind must be character, location or prop")
    db.commit()
    emit(db, p.id, "bible.updated", {body.kind + "_id": row.id}, user_id=user.id)
    return {"kind": body.kind, "id": row.id, "name": row.name, "token": mentions.token(body.kind, row.id, row.name)}


# ── continuity bible ─────────────────────────────────────────────────────────

@router.post("/scenes/{scid}/end-state")
def ai_end_state(scid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    sc = continuity.get_scene(db, scid)
    e, p = _episode(db, sc.episode_id)
    state = continuity.end_state(db, user, p, e, sc)
    emit(db, p.id, "episode.updated", {"episode_id": e.id, "what": "continuity"}, user_id=user.id)
    return state


class EndStateIn(BaseModel):
    characters: dict[str, Any] | None = None
    props: list[str] | None = None
    time_of_day: str | None = None
    weather: str | None = None
    notes: str | None = None


@router.patch("/scenes/{scid}/end-state")
def edit_end_state(scid: int, body: EndStateIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    sc = continuity.get_scene(db, scid)
    state = {**(sc.end_state or {}), **body.model_dump(exclude_unset=True), "source": "manual"}
    sc.end_state = state
    db.commit()
    return state


@router.get("/episodes/{eid}/wardrobe")
def wardrobe(eid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e, p = _episode(db, eid)
    return continuity.wardrobe_timeline(db, p, e)


@router.get("/episodes/{eid}/continuity-bible")
def continuity_bible(eid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e, p = _episode(db, eid)
    scenes = db.query(Scene).filter(Scene.episode_id == e.id).order_by(Scene.order, Scene.id).all()
    return {"episode_id": e.id, "scenes": [{"id": s.id, "order": s.order, "title": s.title, "wardrobe": s.wardrobe or {},
                                             "props": s.props or [], "prop_ids": s.prop_ids or [], "end_state": s.end_state or {}}
                                            for s in scenes]}


# ── character lock, versions, costumes ───────────────────────────────────────

@router.get("/characters/{cid}/lock")
def get_lock(cid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    c = get_or_404(db, Character, cid)
    return {"lock": lock_core.effective(c), "defaults": lock_core.DEFAULT, "prompt_text": lock_core.prompt_text(c)}


class LockConfigIn(BaseModel):
    lock: dict[str, Any]


@router.put("/characters/{cid}/lock")
def set_lock(cid: int, body: LockConfigIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    c = get_or_404(db, Character, cid)
    c.lock = {k: v for k, v in body.lock.items() if k in lock_core.DEFAULT}
    db.commit()
    emit(db, None, "bible.updated", {"character_id": c.id})
    return {"lock": lock_core.effective(c), "prompt_text": lock_core.prompt_text(c)}


def _version_out(v: CharacterVersion) -> dict:
    return v.to_dict()


@router.get("/characters/{cid}/versions")
def list_versions(cid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    get_or_404(db, Character, cid)
    rows = db.query(CharacterVersion).filter(CharacterVersion.character_id == cid).order_by(CharacterVersion.version).all()
    return [_version_out(v) for v in rows]


class VersionIn(BaseModel):
    label: str = ""
    episode_from: int | None = None
    episode_to: int | None = None
    note: str = ""
    dna_text: str | None = None  # defaults to the current DNA
    voice_description: str | None = None
    lock: dict[str, Any] | None = None


@router.post("/characters/{cid}/versions")
def create_version(cid: int, body: VersionIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Freeze the current look (or a changed one) for an episode range."""
    c = get_or_404(db, Character, cid)
    if body.episode_from is not None and body.episode_to is not None and body.episode_to < body.episode_from:
        raise HTTPException(400, "episode_to must not be before episode_from")
    last = db.query(CharacterVersion).filter(CharacterVersion.character_id == cid).order_by(CharacterVersion.version.desc()).first()
    approved = [a.id for a in db.query(CharacterAsset).filter(CharacterAsset.character_id == cid, CharacterAsset.archived.is_(False),
                                                             CharacterAsset.approved.is_(True)).all()]
    v = CharacterVersion(character_id=cid, version=(last.version + 1) if last else 1, label=body.label or f"v{(last.version + 1) if last else 1}",
                         episode_from=body.episode_from, episode_to=body.episode_to,
                         dna_text=body.dna_text if body.dna_text is not None else c.dna_text,
                         voice_description=body.voice_description if body.voice_description is not None else c.voice_description,
                         lock={k: x for k, x in (body.lock or c.lock or {}).items() if k in lock_core.DEFAULT},
                         asset_ids=approved, identity=dict(c.identity or {}), note=body.note, created_by=user.id)
    db.add(v)
    c.version = v.version
    db.commit()
    emit(db, None, "bible.updated", {"character_id": c.id, "version": v.version})
    return _version_out(v)


class VersionPatch(BaseModel):
    label: str | None = None
    episode_from: int | None = None
    episode_to: int | None = None
    note: str | None = None
    dna_text: str | None = None
    voice_description: str | None = None
    lock: dict[str, Any] | None = None
    asset_ids: list[int] | None = None


@router.patch("/character-versions/{vid}")
def patch_version(vid: int, body: VersionPatch, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    v = get_or_404(db, CharacterVersion, vid)
    for k, x in body.model_dump(exclude_unset=True).items():
        setattr(v, k, x)
    db.commit()
    return _version_out(v)


@router.delete("/character-versions/{vid}")
def delete_version(vid: int, user: User = Depends(require("producer")), db: Session = Depends(get_db)):
    v = get_or_404(db, CharacterVersion, vid)
    db.delete(v)
    db.commit()
    return {"ok": True}


@router.post("/character-versions/{vid}/restore")
def restore_version(vid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Roll the character back to this version: DNA, voice, lock and trained identity."""
    v = get_or_404(db, CharacterVersion, vid)
    c = get_or_404(db, Character, v.character_id)
    c.dna_text, c.voice_description, c.lock = v.dna_text or c.dna_text, v.voice_description or c.voice_description, dict(v.lock or {})
    if v.identity:
        c.identity = dict(v.identity)
    c.version += 1
    db.commit()
    emit(db, None, "bible.updated", {"character_id": c.id, "restored": v.version})
    return {"character_id": c.id, "version": c.version, "look": {k: x for k, x in look_of(db, c, None).items() if k != "version"}}


@router.get("/characters/{cid}/look")
def character_look(cid: int, episode: int | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    c = get_or_404(db, Character, cid)
    look = look_of(db, c, episode)
    return {"dna": look["dna"], "voice": look["voice"], "lock": look["lock"], "asset_ids": look["asset_ids"],
            "version": _version_out(look["version"]) if look["version"] else None}


def _costume_out(db: Session, c: Costume) -> dict:
    imgs = (db.query(CharacterAsset).filter(CharacterAsset.character_id == c.character_id, CharacterAsset.kind == "outfit",
                                           CharacterAsset.outfit == c.name, CharacterAsset.archived.is_(False))
            .order_by(CharacterAsset.id).all())
    return c.to_dict(images=[a.to_dict(url=url(a.path)) for a in imgs])


@router.get("/characters/{cid}/costumes")
def list_costumes(cid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    get_or_404(db, Character, cid)
    rows = db.query(Costume).filter(Costume.character_id == cid, Costume.archived.is_(False)).order_by(Costume.id).all()
    return [_costume_out(db, c) for c in rows]


class CostumeIn(BaseModel):
    name: str
    description: str = ""
    episode_from: int | None = None
    episode_to: int | None = None
    is_default: bool = False
    generate: bool = True  # make the 3-angle turnaround now
    views: list[str] | None = None
    project_id: int | None = None


@router.post("/characters/{cid}/costumes")
def create_costume(cid: int, body: CostumeIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    c = get_or_404(db, Character, cid)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Give the outfit a name")
    row = db.query(Costume).filter(Costume.character_id == cid, Costume.name == name, Costume.archived.is_(False)).first()
    if row is None:
        row = Costume(character_id=cid, name=name)
        db.add(row)
    row.description, row.episode_from, row.episode_to = body.description, body.episode_from, body.episode_to
    if body.is_default:
        for other in db.query(Costume).filter(Costume.character_id == cid).all():
            other.is_default = False
        row.is_default = True
    db.commit()
    out = {"costume": _costume_out(db, row)}
    if body.generate:
        p = db.get(Project, body.project_id) if body.project_id else None
        scope = body.episode_from if body.episode_from == body.episode_to else None
        out["jobs"] = jobs.submit(db, user, p, [generation.outfit_spec(db, body.project_id, c, name, body.description, scope, body.views)])
    emit(db, None, "bible.updated", {"character_id": cid})
    return out


class CostumePatch(BaseModel):
    name: str | None = None
    description: str | None = None
    episode_from: int | None = None
    episode_to: int | None = None
    is_default: bool | None = None


@router.patch("/costumes/{coid}")
def patch_costume(coid: int, body: CostumePatch, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    c = get_or_404(db, Costume, coid)
    data = body.model_dump(exclude_unset=True)
    if data.get("name") and data["name"] != c.name:  # the images follow the name
        for a in db.query(CharacterAsset).filter(CharacterAsset.character_id == c.character_id, CharacterAsset.kind == "outfit",
                                                 CharacterAsset.outfit == c.name).all():
            a.outfit = data["name"]
    if data.get("is_default"):
        for other in db.query(Costume).filter(Costume.character_id == c.character_id).all():
            other.is_default = False
    for k, v in data.items():
        setattr(c, k, v)
    db.commit()
    return _costume_out(db, c)


@router.delete("/costumes/{coid}")
def delete_costume(coid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    c = get_or_404(db, Costume, coid)
    c.archived = True
    db.commit()
    return {"ok": True}


# ── props ────────────────────────────────────────────────────────────────────

def _prop_out(p: Prop) -> dict:
    return p.to_dict(url=url(p.path))


@router.get("/props")
def list_props(project_id: int | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = db.query(Prop).filter(Prop.archived.is_(False))
    if project_id:
        ids = {r.prop_id for r in db.query(ProjectProp).filter(ProjectProp.project_id == project_id).all()}
        rows = [p for p in q.order_by(Prop.id).all() if p.id in ids or p.shared]
        return [{**_prop_out(p), "in_project": p.id in ids} for p in rows]
    return [_prop_out(p) for p in q.order_by(Prop.id).all()]


class PropIn(BaseModel):
    name: str
    description: str = ""
    shared: bool = True
    project_id: int | None = None


@router.post("/props")
def create_prop(body: PropIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    if not body.name.strip():
        raise HTTPException(400, "Give the prop a name")
    p = Prop(name=body.name.strip(), description=body.description, shared=body.shared)
    db.add(p)
    db.flush()
    if body.project_id:
        db.add(ProjectProp(project_id=body.project_id, prop_id=p.id))
    db.commit()
    emit(db, body.project_id, "bible.updated", {"prop_id": p.id})
    return _prop_out(p)


class PropPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    shared: bool | None = None
    archived: bool | None = None


@router.patch("/props/{prid}")
def patch_prop(prid: int, body: PropPatch, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    p = get_or_404(db, Prop, prid)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(p, k, v)
    db.commit()
    return _prop_out(p)


@router.post("/props/{prid}/upload")
async def upload_prop_image(prid: int, file: UploadFile = File(...), user: User = Depends(require("creator")),
                            db: Session = Depends(get_db)):
    p = get_or_404(db, Prop, prid)
    ext = IMG_TYPES.get(file.content_type or "")
    if not ext:
        raise HTTPException(400, "Upload a PNG, JPEG or WebP image")
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(400, "Image is too large (max 15 MB)")
    st = get_storage()
    p.path = st.save_bytes(st.new_path(f"props/{p.id}", ext), data)
    db.commit()
    return _prop_out(p)


@router.post("/projects/{pid}/props/{prid}")
def add_prop_to_project(pid: int, prid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    get_or_404(db, Project, pid)
    get_or_404(db, Prop, prid)
    if not db.get(ProjectProp, (pid, prid)):
        db.add(ProjectProp(project_id=pid, prop_id=prid))
        db.commit()
    return {"ok": True}


@router.delete("/projects/{pid}/props/{prid}")
def remove_prop_from_project(pid: int, prid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    row = db.get(ProjectProp, (pid, prid))
    if row:
        db.delete(row)
        db.commit()
    return {"ok": True}
