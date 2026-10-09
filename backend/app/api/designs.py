"""Poster Studio API: designs (posters, thumbnails, social creatives), versions, uploads, exports and AI layers.

The browser edits and renders a design; the server keeps the document, media, thumbnails and exported files, and runs
AI image jobs (backgrounds, characters as cut-outs, elements, relighting) through the normal job queue and budget.
"""
from __future__ import annotations

import io
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..core import budget, designs as dz, jobs
from ..db import get_db, utcnow
from ..events import emit
from ..models import Character, Design, DesignExport, DesignVersion, Job, Project, User, role_rank
from ..providers.services import Services
from ..security import current_user, require
from ..storage import get_storage
from .common import get_or_404

router = APIRouter(prefix="/api", tags=["designs"])
MAX_UPLOAD_MB = 25
MAX_EXPORT_MB = 80
KEEP_VERSIONS = 50


def design_out(d: Design, full: bool = False) -> dict[str, Any]:
    st = get_storage()
    out = d.to_dict(thumb_url=st.url(d.thumb_path) if d.thumb_path else "")
    out.pop("doc", None)
    if full:
        out["doc"] = dz.resolve_doc(d.doc)
    return out


def _can_edit(user: User, d: Design) -> None:
    if role_rank(user.role) < role_rank("creator"):
        raise HTTPException(403, "Your role can view designs but not change them")


# ── designs ──────────────────────────────────────────────

@router.get("/designs")
def list_designs(project_id: int | None = None, q: str = "", archived: bool = False, limit: int = 200,
                 user: User = Depends(current_user), db: Session = Depends(get_db)):
    qry = db.query(Design).filter(Design.archived.is_(archived))
    if project_id:
        qry = qry.filter(Design.project_id == project_id)
    if q.strip():
        like = f"%{q.strip()}%"
        qry = qry.filter(or_(Design.title.ilike(like), Design.template.ilike(like), Design.format.ilike(like)))
    return [design_out(d) for d in qry.order_by(Design.updated_at.desc()).limit(min(limit, 500)).all()]


class DesignIn(BaseModel):
    title: str = Field("Untitled design", max_length=200)
    format: str = Field("custom", max_length=40)
    width: int = 1080
    height: int = 1350
    project_id: int | None = None
    template: str = Field("", max_length=60)
    brand_kit_id: int | None = None
    doc: dict[str, Any] | None = None


@router.post("/designs")
def create_design(body: DesignIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    if body.project_id:
        get_or_404(db, Project, body.project_id)
    w, h = dz.clamp_size(body.width, body.height)
    try:
        doc = dz.clean_doc(body.doc or {"layers": []})
    except ValueError as e:
        raise HTTPException(400, str(e))
    d = Design(title=body.title.strip() or "Untitled design", format=body.format, width=w, height=h, project_id=body.project_id,
               template=body.template, brand_kit_id=body.brand_kit_id, doc=doc, created_by=user.id, updated_by=user.id)
    db.add(d)
    db.commit()
    emit(db, d.project_id, "design.created", {"design_id": d.id}, user_id=user.id)
    return design_out(d, full=True)


@router.get("/designs/{did}")
def get_design(did: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return design_out(get_or_404(db, Design, did, "Design"), full=True)


class DesignPatch(BaseModel):
    title: str | None = Field(None, max_length=200)
    format: str | None = Field(None, max_length=40)
    width: int | None = None
    height: int | None = None
    doc: dict[str, Any] | None = None
    status: Literal["draft", "approved"] | None = None
    project_id: int | None = None
    brand_kit_id: int | None = None
    base_revision: int | None = None  # the revision the editor started from; a newer one on the server means a teammate saved
    force: bool = False


@router.put("/designs/{did}")
def save_design(did: int, body: DesignPatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    d = get_or_404(db, Design, did, "Design")
    _can_edit(user, d)
    if body.base_revision is not None and body.base_revision != d.revision and not body.force:
        raise HTTPException(409, f"Someone else saved this design (revision {d.revision}). Reload to see their changes, "
                                 "or save again to keep yours.")
    if body.status == "approved" and role_rank(user.role) < role_rank("producer"):
        raise HTTPException(403, "Only a producer can approve a design")
    if body.doc is not None:
        try:
            d.doc = dz.clean_doc(body.doc)
        except ValueError as e:
            raise HTTPException(400, str(e))
    if body.width is not None or body.height is not None:
        d.width, d.height = dz.clamp_size(body.width or d.width, body.height or d.height)
    for k in ("title", "format", "status", "brand_kit_id"):
        v = getattr(body, k)
        if v is not None:
            setattr(d, k, v.strip() if isinstance(v, str) and k == "title" else v)
    if "project_id" in body.model_fields_set:
        if body.project_id:
            get_or_404(db, Project, body.project_id)
        d.project_id = body.project_id
    d.revision += 1
    d.updated_at, d.updated_by = utcnow(), user.id
    db.commit()
    emit(db, d.project_id, "design.updated", {"design_id": d.id, "revision": d.revision}, user_id=user.id)
    return {"id": d.id, "revision": d.revision, "updated_at": d.to_dict()["updated_at"]}


@router.post("/designs/{did}/duplicate")
def duplicate_design(did: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    src = get_or_404(db, Design, did, "Design")
    d = Design(title=f"{src.title} (copy)"[:200], format=src.format, width=src.width, height=src.height, project_id=src.project_id,
               template=src.template, brand_kit_id=src.brand_kit_id, doc=src.doc, thumb_path=src.thumb_path,
               created_by=user.id, updated_by=user.id)
    db.add(d)
    db.commit()
    emit(db, d.project_id, "design.created", {"design_id": d.id}, user_id=user.id)
    return design_out(d)


@router.delete("/designs/{did}")
def archive_design(did: int, restore: bool = False, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    d = get_or_404(db, Design, did, "Design")
    d.archived = not restore
    d.updated_at = utcnow()
    db.commit()
    emit(db, d.project_id, "design.updated", {"design_id": d.id, "archived": d.archived}, user_id=user.id)
    return {"ok": True, "archived": d.archived}


# ── media: uploads, thumbnails, exports ─────────────────────

async def _read_image(file: UploadFile, max_mb: int) -> tuple[bytes, Image.Image]:
    data = await file.read()
    if len(data) > max_mb * 1024 * 1024:
        raise HTTPException(400, f"That file is too large (max {max_mb} MB)")
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except (UnidentifiedImageError, OSError):
        raise HTTPException(400, "That isn't an image this studio can read (use PNG, JPG, WebP or GIF)")
    if im.format not in ("PNG", "JPEG", "WEBP", "GIF", "MPO"):
        raise HTTPException(400, "Use a PNG, JPG, WebP or GIF image")
    return data, im


@router.post("/designs/{did}/upload")
async def upload_image(did: int, file: UploadFile = File(...), user: User = Depends(require("creator")),
                       db: Session = Depends(get_db)):
    """Add a photo, logo or graphic to the design's media. Large photos are kept as they are; the editor scales them."""
    d = get_or_404(db, Design, did, "Design")
    data, im = await _read_image(file, MAX_UPLOAD_MB)
    ext = {"PNG": "png", "JPEG": "jpg", "MPO": "jpg", "WEBP": "webp", "GIF": "gif"}[im.format]
    st = get_storage()
    rel = st.save_bytes(f"designs/{d.id}/uploads/{uuid.uuid4().hex[:12]}.{ext}", data)
    return {"asset": rel, "src": st.url(rel), "width": im.width, "height": im.height, "name": (file.filename or "image")[:120]}


@router.post("/designs/{did}/thumbnail")
async def save_thumbnail(did: int, file: UploadFile = File(...), user: User = Depends(require("creator")),
                         db: Session = Depends(get_db)):
    d = get_or_404(db, Design, did, "Design")
    data, im = await _read_image(file, 8)
    im = im.convert("RGB")
    im.thumbnail((720, 720))
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=80)
    st = get_storage()
    d.thumb_path = st.save_bytes(f"designs/{d.id}/thumb_{uuid.uuid4().hex[:8]}.webp", buf.getvalue())
    db.commit()
    return {"thumb_url": st.url(d.thumb_path)}


@router.post("/designs/{did}/export")
async def export_design(did: int, file: UploadFile = File(...), kind: str = Form("png"), user: User = Depends(require("creator")),
                        db: Session = Depends(get_db)):
    """The browser renders the design at full size and sends a PNG; the server turns it into PNG, JPG, WebP or a 300 dpi
    PDF, keeps the file and returns its link."""
    d = get_or_404(db, Design, did, "Design")
    data, im = await _read_image(file, MAX_EXPORT_MB)
    try:
        out, ext = dz.convert_export(data, kind.lower())
    except ValueError as e:
        raise HTTPException(400, str(e))
    st = get_storage()
    safe = "".join(c if c.isalnum() or c in "-_ " else "_" for c in d.title).strip().replace(" ", "_")[:60] or "design"
    rel = st.save_bytes(f"designs/{d.id}/exports/{safe}_{im.width}x{im.height}_{uuid.uuid4().hex[:6]}.{ext}", out)
    x = DesignExport(design_id=d.id, project_id=d.project_id, kind=ext, path=rel, width=im.width, height=im.height,
                     bytes=len(out), created_by=user.id)
    db.add(x)
    db.commit()
    emit(db, d.project_id, "design.exported", {"design_id": d.id, "export_id": x.id, "kind": ext}, user_id=user.id)
    return x.to_dict(url=st.url(rel))


@router.get("/designs/{did}/exports")
def list_exports(did: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    get_or_404(db, Design, did, "Design")
    st = get_storage()
    rows = db.query(DesignExport).filter(DesignExport.design_id == did).order_by(DesignExport.id.desc()).limit(50).all()
    return [x.to_dict(url=st.url(x.path)) for x in rows]


# ── versions ─────────────────────────────────────────────

class VersionIn(BaseModel):
    note: str = Field("", max_length=200)


@router.get("/designs/{did}/versions")
def list_versions(did: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    get_or_404(db, Design, did, "Design")
    st = get_storage()
    rows = db.query(DesignVersion).filter(DesignVersion.design_id == did).order_by(DesignVersion.id.desc()).limit(KEEP_VERSIONS).all()
    return [{**{k: v for k, v in r.to_dict().items() if k != "doc"}, "thumb_url": st.url(r.thumb_path) if r.thumb_path else ""}
            for r in rows]


@router.post("/designs/{did}/versions")
def save_version(did: int, body: VersionIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    d = get_or_404(db, Design, did, "Design")
    v = DesignVersion(design_id=d.id, note=body.note.strip() or f"Version {d.revision}", doc=d.doc, width=d.width, height=d.height,
                      thumb_path=d.thumb_path, created_by=user.id)
    db.add(v)
    db.flush()
    old = (db.query(DesignVersion).filter(DesignVersion.design_id == d.id).order_by(DesignVersion.id.desc()).offset(KEEP_VERSIONS).all())
    for o in old:
        db.delete(o)
    db.commit()
    return {"id": v.id, "note": v.note}


@router.post("/designs/{did}/versions/{vid}/restore")
def restore_version(did: int, vid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    d = get_or_404(db, Design, did, "Design")
    v = get_or_404(db, DesignVersion, vid, "Version")
    if v.design_id != d.id:
        raise HTTPException(404, "Version not found")
    db.add(DesignVersion(design_id=d.id, note=f"Before restoring “{v.note}”"[:200], doc=d.doc, width=d.width, height=d.height,
                         thumb_path=d.thumb_path, created_by=user.id))
    d.doc, d.width, d.height = v.doc, v.width or d.width, v.height or d.height
    if v.thumb_path:
        d.thumb_path = v.thumb_path
    d.revision += 1
    d.updated_at, d.updated_by = utcnow(), user.id
    db.commit()
    emit(db, d.project_id, "design.updated", {"design_id": d.id, "revision": d.revision}, user_id=user.id)
    return design_out(d, full=True)


# ── AI layers ────────────────────────────────────────────

class AiImageIn(BaseModel):
    kind: Literal["background", "character", "element", "product", "harmonize", "restyle"] = "background"
    prompt: str = Field("", max_length=2000)
    style: str = Field("", max_length=300)
    layer_id: str = Field("", max_length=64)  # the layer to fill when the job finishes
    character_id: int | None = None
    outfit: str = Field("", max_length=300)
    pose: str = Field("", max_length=300)
    cutout: bool = False  # transparent background (characters, elements, products)
    source_asset: str = Field("", max_length=500)  # for harmonize / restyle: a render or image to work from
    ref_assets: list[str] = Field(default_factory=list, max_length=6)  # extra reference images (e.g. a product photo)
    aspect: str = ""  # default: the layer's shape, else the design's
    width: float | None = None
    height: float | None = None
    count: int = Field(1, ge=1, le=4)  # variations


@router.post("/designs/{did}/ai/image")
def ai_image(did: int, body: AiImageIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Generate a layer image with AI as a normal job (budget checks and approvals apply). Poll /designs/jobs for the result."""
    d = get_or_404(db, Design, did, "Design")
    project = db.get(Project, d.project_id) if d.project_id else None
    if body.kind == "character" and not body.character_id and not body.prompt.strip():
        raise HTTPException(400, "Pick a character or describe the person")
    if body.kind in ("harmonize", "restyle") and not body.source_asset:
        raise HTTPException(400, "This needs an image to work from")
    for a in [body.source_asset, *body.ref_assets]:
        if a and not dz._asset_ok(a):
            raise HTTPException(400, "That image can't be used here")
    ch = get_or_404(db, Character, body.character_id, "Character") if body.character_id else None
    aspect = body.aspect if body.aspect in dz.ASPECTS else dz.nearest_aspect(body.width or d.width, body.height or d.height)
    est = budget.Estimator(db).image(1)
    label = {"background": "Poster background", "character": f"Poster character{': ' + ch.name if ch else ''}",
             "element": "Poster element", "product": "Poster product", "harmonize": "Poster relight", "restyle": "Poster restyle"}[body.kind]
    payload = {"design_id": d.id, **body.model_dump(exclude={"count"}), "aspect": aspect}
    specs = [jobs.spec("design_image", payload={**payload, "variation": i}, project_id=d.project_id, estimate=est, label=label)
             for i in range(body.count)]
    return jobs.submit(db, user, project, specs)


@router.get("/designs/jobs/status")
def job_status(ids: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Status and result of the given poster jobs (comma-separated ids)."""
    try:
        wanted = [int(x) for x in ids.split(",") if x.strip()][:50]
    except ValueError:
        raise HTTPException(400, "ids must be numbers")
    rows = db.query(Job).filter(Job.id.in_(wanted)).all() if wanted else []
    return [{"id": j.id, "status": j.status, "progress": j.progress, "message": j.message, "error": (j.error or "")[:300],
             "result": j.result or {}, "label": j.label} for j in rows if j.type == "design_image"]


class CopyIn(BaseModel):
    kind: Literal["title", "tagline", "cta", "credits", "festival", "headline", "caption"] = "tagline"
    context: str = Field("", max_length=3000)
    project_id: int | None = None
    language: str = Field("en", max_length=8)
    tone: str = Field("", max_length=120)
    n: int = Field(6, ge=1, le=12)


class CopyOut(BaseModel):
    suggestions: list[str]


COPY_SYSTEM = ("You write short, punchy text for film posters, thumbnails and ads for Indian audiences. Return only the text "
               "itself, no quotes or emojis unless asked. Titles: 1-4 words. Taglines: under 9 words, evocative. CTAs: 2-4 words. "
               "Credits: a film billing block in one paragraph (role names in caps). Write in the requested language and script.")
LANGS = {"en": "English", "hi": "Hindi (Devanagari)", "kn": "Kannada", "te": "Telugu", "ta": "Tamil"}


@router.post("/designs/ai/copy")
def ai_copy(body: CopyIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Title, tagline, call-to-action or credits ideas for a poster, from the project's story when there is one."""
    project = db.get(Project, body.project_id) if body.project_id else None
    ctx = body.context.strip()
    if project:
        brief = project.brief or {}
        ctx = (f"Project: {project.title}. Logline: {project.concept or ''}. "
               f"Tone: {brief.get('tone', '') if isinstance(brief, dict) else ''}. {ctx}").strip()
    prompt = (f"Write {body.n} different {body.kind} options. Language: {LANGS.get(body.language, body.language)}. "
              f"{'Tone: ' + body.tone + '. ' if body.tone else ''}Context: {ctx or 'a cinematic Indian short film'}")
    svc = Services()
    try:
        out, usage = svc.llm_json("poster_copy", COPY_SYSTEM, prompt, CopyOut,
                                  mock_ctx={"concept": ctx or "A mysterious story", "kind": body.kind, "n": body.n})
    except Exception as e:  # provider problems become a readable message
        raise HTTPException(502, f"Couldn't write suggestions right now: {str(e)[:200]}")
    budget.record_cost(db, usage, user_id=user.id, project_id=project.id if project else None, job_id=None)
    db.commit()
    return {"suggestions": [s.strip().strip('"') for s in out.suggestions if s.strip()][: body.n]}


class BriefIn(BaseModel):
    brief: str = Field(..., min_length=3, max_length=3000)
    format: str = Field("film_poster", max_length=40)
    project_id: int | None = None
    language: str = Field("en", max_length=8)


class BriefOut(BaseModel):
    template: str
    title: str
    tagline: str
    credits: str = ""
    cta: str = ""
    badge: str = ""
    background_prompt: str
    palette: list[str] = []
    style: str = ""


BRIEF_SYSTEM = ("You are a key-art director for Indian films, series, ads and social posts. From a brief, plan one poster: pick "
                "the best template, write the title, tagline, optional credits/CTA/badge, describe the background image "
                "(no text in it), give a 3-5 colour hex palette and a short visual style. Templates: film_onesheet, "
                "character_spotlight, minimal_title, youtube_thumbnail, product_ad, festival_greeting, cast_lineup, "
                "episode_card, event_flyer, quote_card.")


@router.post("/designs/ai/brief")
def ai_brief(body: BriefIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """One-line brief to a full poster plan (template, copy, background prompt, palette). The editor builds it."""
    project = db.get(Project, body.project_id) if body.project_id else None
    ctx = body.brief
    if project:
        ctx += f"\nProject: {project.title}. Logline: {project.concept or ''}."
    svc = Services()
    try:
        out, usage = svc.llm_json("poster_brief", BRIEF_SYSTEM,
                                  f"Format: {body.format}. Language for text: {LANGS.get(body.language, body.language)}.\nBrief: {ctx}",
                                  BriefOut, mock_ctx={"concept": body.brief, "format": body.format})
    except Exception as e:
        raise HTTPException(502, f"Couldn't plan the poster right now: {str(e)[:200]}")
    budget.record_cost(db, usage, user_id=user.id, project_id=project.id if project else None, job_id=None)
    db.commit()
    return out.model_dump()
