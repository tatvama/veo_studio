"""Brand kits, semantic search, consent records, audit log, YouTube publishing/analytics, client review links,
character identity training and per-user UI preferences."""
from __future__ import annotations

import math
from pathlib import Path
import secrets
from datetime import datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import get_settings
from ..core import generation, jobs, youtube
from ..core.audit import audit
from ..db import get_db, utcnow
from ..events import emit
from ..models import (AuditEntry, BrandKit, Character, CharacterAsset, Comment, Consent, Episode, Export, Integration, PostMetric, Project,
                      ReviewLink, SearchItem, Take, User)
from ..providers.services import Services
from ..security import current_user, require
from ..storage import get_storage
from .common import export_out, get_or_404, url, user_brief

router = APIRouter(prefix="/api", tags=["growth"])
IMG = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg"}


# ── brand kits ───────────────────────────────────────────────────────────────

def kit_out(k: BrandKit) -> dict:
    return k.to_dict(logo_url=url(k.logo_path), product_urls=[{**p, "url": url(p.get("path", ""))} for p in (k.product_assets or [])])


@router.get("/brand-kits")
def list_kits(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return [kit_out(k) for k in db.query(BrandKit).order_by(BrandKit.name).all()]


class KitIn(BaseModel):
    name: str
    colors: list[str] = []
    fonts: dict[str, str] = {}
    tagline: str = ""
    cta: str = ""
    website: str = ""
    voice_tone: str = ""
    rules: str = ""
    end_card: dict[str, Any] = {}


@router.post("/brand-kits")
def create_kit(body: KitIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    k = BrandKit(**body.model_dump())
    db.add(k)
    db.commit()
    return kit_out(k)


class KitPatch(BaseModel):
    name: str | None = None
    colors: list[str] | None = None
    fonts: dict[str, str] | None = None
    tagline: str | None = None
    cta: str | None = None
    website: str | None = None
    voice_tone: str | None = None
    rules: str | None = None
    end_card: dict[str, Any] | None = None
    product_assets: list[dict[str, Any]] | None = None  # send the list without the removed items


@router.patch("/brand-kits/{kid}")
def patch_kit(kid: int, body: KitPatch, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    k = get_or_404(db, BrandKit, kid)
    data = body.model_dump(exclude_unset=True)
    if "product_assets" in data:  # only removal/relabel of uploaded files; paths can't be invented
        known = {a.get("path") for a in (k.product_assets or [])}
        data["product_assets"] = [{"path": a["path"], "label": str(a.get("label", ""))[:80]}
                                  for a in data["product_assets"] or [] if a.get("path") in known]
    for key, v in data.items():
        setattr(k, key, v)
    db.commit()
    return kit_out(k)


@router.delete("/brand-kits/{kid}")
def delete_kit(kid: int, request: Request, user: User = Depends(require("producer")), db: Session = Depends(get_db)):
    k = get_or_404(db, BrandKit, kid)
    for p in db.query(Project).filter(Project.brand_kit_id == kid).all():
        p.brand_kit_id = None
    audit(db, user, "brand_kit.delete", k.name, request=request, commit=False)
    db.delete(k)
    db.commit()
    return {"ok": True}


@router.post("/brand-kits/{kid}/logo")
async def kit_logo(kid: int, file: UploadFile = File(...), user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    k = get_or_404(db, BrandKit, kid)
    ext = IMG.get(file.content_type or "")
    if not ext:
        raise HTTPException(400, "Upload PNG, JPG, WEBP or SVG")
    st = get_storage()
    k.logo_path = st.save_bytes(st.new_path(f"brand/{kid}", ext), await file.read())
    db.commit()
    return kit_out(k)


@router.post("/brand-kits/{kid}/products")
async def kit_product(kid: int, label: str = Form(""), file: UploadFile = File(...), user: User = Depends(require("creator")),
                      db: Session = Depends(get_db)):
    k = get_or_404(db, BrandKit, kid)
    ext = IMG.get(file.content_type or "")
    if not ext:
        raise HTTPException(400, "Upload PNG, JPG or WEBP")
    st = get_storage()
    rel = st.save_bytes(st.new_path(f"brand/{kid}/products", ext), await file.read())
    k.product_assets = [*(k.product_assets or []), {"path": rel, "label": label}]
    db.commit()
    return kit_out(k)


# ── semantic search ──────────────────────────────────────────────────────────

class SearchIn(BaseModel):
    q: str = Field(min_length=1)
    project_id: int | None = None
    limit: int = 24


@router.post("/search")
def search(body: SearchIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = db.query(SearchItem)
    if body.project_id:
        q = q.filter(SearchItem.project_id == body.project_id)
    items = q.all()
    if not items:
        return {"results": [], "indexed": 0}
    model = items[0].model
    svc = Services()
    if model == "hash-256":
        from ..providers.services import hash_embed
        qv = hash_embed(body.q)
    else:
        vecs, _ = svc.embed([body.q])
        qv = vecs[0]
    def cos(a: list[float], b: list[float]) -> float:
        if len(a) != len(b):
            return -1.0
        na = math.sqrt(sum(x * x for x in a)) or 1
        nb = math.sqrt(sum(x * x for x in b)) or 1
        return sum(x * y for x, y in zip(a, b)) / (na * nb)
    words = [w for w in body.q.lower().split() if len(w) > 2]
    scored = []
    for it in items:
        s = cos(qv, it.vector or [])
        s += 0.05 * sum(1 for w in words if w in it.text.lower())  # small keyword boost
        scored.append((s, it))
    scored.sort(key=lambda x: -x[0])
    top = scored[: body.limit]
    take_ids = [it.entity_id for _, it in top if it.entity_type == "take"]
    shot_of = dict(db.query(Take.id, Take.shot_id).filter(Take.id.in_(take_ids)).all()) if take_ids else {}
    out = []
    for s, it in top:
        sid = it.entity_id if it.entity_type == "shot" else shot_of.get(it.entity_id) if it.entity_type == "take" else None
        out.append(it.to_dict(score=round(s, 3), thumb_url=url(it.thumb_path), shot_id=sid) | {"vector": None})
    return {"indexed": len(items), "results": out}


@router.post("/projects/{pid}/search/index")
def index_project(pid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    p = get_or_404(db, Project, pid)
    return jobs.submit(db, user, p, [generation.search_index_spec(p)])


# ── consent records ──────────────────────────────────────────────────────────

@router.get("/consents")
def list_consents(user: User = Depends(require("producer")), db: Session = Depends(get_db)):
    return [c.to_dict(file_url=url(c.file_path)) for c in db.query(Consent).order_by(Consent.id.desc()).all()]


@router.post("/consents")
async def add_consent(request: Request, kind: str = Form(...), subject_name: str = Form(...), scope: str = Form(""),
                      expires_on: str = Form(""), character_id: int | None = Form(None), file: UploadFile | None = File(None),
                      user: User = Depends(require("producer")), db: Session = Depends(get_db)):
    rel = ""
    if file is not None:
        st = get_storage()
        ext = (file.filename or "file").rsplit(".", 1)[-1].lower()[:5] or "bin"
        rel = st.save_bytes(st.new_path("consents", ext), await file.read())
    c = Consent(kind=kind, subject_name=subject_name, scope=scope, expires_on=expires_on, character_id=character_id,
                file_path=rel, recorded_by=user.id)
    db.add(c)
    audit(db, user, "consent.add", subject_name, {"kind": kind, "character_id": character_id}, request=request, commit=False)
    db.commit()
    return c.to_dict(file_url=url(rel))


# ── audit log ────────────────────────────────────────────────────────────────

@router.get("/audit")
def audit_log(limit: int = 300, admin: User = Depends(require("admin")), db: Session = Depends(get_db)):
    users = {u.id: u for u in db.query(User).all()}
    rows = db.query(AuditEntry).order_by(AuditEntry.id.desc()).limit(min(limit, 2000)).all()
    return [r.to_dict(user=user_brief(users.get(r.user_id))) for r in rows]


# ── YouTube integration ──────────────────────────────────────────────────────

_oauth_states: dict[str, int] = {}


@router.get("/integrations")
def integrations(user: User = Depends(current_user), db: Session = Depends(get_db)):
    s = get_settings()
    return {"youtube_ready": bool(s.google_client_id and s.google_client_secret), "redirect_uri": youtube.redirect_uri(),
            "accounts": [i.to_dict() for i in db.query(Integration).order_by(Integration.id).all()]}


@router.get("/integrations/youtube/connect")
def yt_connect(admin: User = Depends(require("producer"))):
    state = secrets.token_urlsafe(20)
    _oauth_states[state] = admin.id
    return {"url": youtube.auth_url(state)}


@router.get("/integrations/youtube/callback")
def yt_callback(code: str = "", state: str = "", db: Session = Depends(get_db)):
    uid = _oauth_states.pop(state, None)
    if not code or uid is None:
        raise HTTPException(400, "Invalid YouTube connect attempt")
    youtube.finish_connect(db, code, uid)
    audit(db, db.get(User, uid), "integration.youtube.connect")
    s = get_settings()
    return RedirectResponse((s.frontend_origin if "5173" in s.frontend_origin else "") + "/settings?connected=youtube")


@router.delete("/integrations/{iid}")
def remove_integration(iid: int, request: Request, admin: User = Depends(require("admin")), db: Session = Depends(get_db)):
    i = get_or_404(db, Integration, iid)
    db.delete(i)
    audit(db, admin, "integration.remove", i.provider, request=request)
    return {"ok": True}


class PublishIn(BaseModel):
    integration_id: int
    title: str | None = None
    description: str | None = None
    tags: list[str] | None = None
    privacy: str = "unlisted"
    publish_at: datetime | None = None  # schedule: uploads as private, YouTube makes it public at this time
    use_thumbnail: bool = True  # upload the thumbnail picked in the marketing pack


@router.post("/exports/{xid}/publish")
def publish(xid: int, body: PublishIn, request: Request, user: User = Depends(require("producer")), db: Session = Depends(get_db)):
    x = get_or_404(db, Export, xid)
    if x.status != "ready":
        raise HTTPException(400, "Render isn't ready")
    if body.privacy not in ("private", "unlisted", "public"):
        raise HTTPException(400, "privacy must be private, unlisted or public")
    if body.publish_at and body.publish_at.replace(tzinfo=None) <= datetime.utcnow():
        raise HTTPException(400, "Schedule time must be in the future")
    p = db.get(Project, x.project_id)
    audit(db, user, "export.publish", f"export {xid}", {"privacy": body.privacy}, request=request, commit=False)
    return jobs.submit(db, user, p, [jobs.spec("publish_youtube", payload={"export_id": xid, **body.model_dump(mode="json")},
                                               project_id=p.id, episode_id=x.episode_id, label=f"Publish to YouTube #{xid}")],
                       skip_budget=True)


@router.post("/metrics/refresh")
def refresh_metrics(user: User = Depends(require("producer")), db: Session = Depends(get_db)):
    return jobs.submit(db, user, None, [jobs.spec("fetch_metrics", label="YouTube analytics")], skip_budget=True)


@router.get("/insights/hooks")
def hook_insights(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Which hooks kept viewers watching — fed back into the hook writer."""
    latest = (db.query(PostMetric.export_id, func.max(PostMetric.id)).group_by(PostMetric.export_id).all())
    rows = [db.get(PostMetric, mid) for _, mid in latest]
    rows = [r for r in rows if r and r.hook_text]
    rows.sort(key=lambda r: -(r.avg_view_pct or 0))
    return [{"hook": r.hook_text, "avg_view_pct": r.avg_view_pct, "views": r.views, "export_id": r.export_id,
             "retention": r.retention} for r in rows[:50]]


# ── client review links (no login) ───────────────────────────────────────────

class ReviewLinkIn(BaseModel):
    label: str = ""
    allow_comments: bool = True
    expires_days: int | None = 14


@router.post("/exports/{xid}/review-links")
def create_review_link(xid: int, body: ReviewLinkIn, request: Request, user: User = Depends(require("creator")),
                       db: Session = Depends(get_db)):
    x = get_or_404(db, Export, xid)
    if x.status != "ready" or not x.path:
        raise HTTPException(400, "Render isn't ready")
    tok = secrets.token_urlsafe(24)
    rl = ReviewLink(token=tok, project_id=x.project_id, export_id=xid, allow_comments=body.allow_comments, label=body.label,
                    expires_at=utcnow() + timedelta(days=body.expires_days) if body.expires_days else None, created_by=user.id)
    db.add(rl)
    audit(db, user, "review_link.create", f"export {xid}", {"label": body.label}, request=request, commit=False)
    db.commit()
    return rl.to_dict(url=f"{get_settings().public_base_url.rstrip('/')}/review/{tok}")


@router.get("/exports/{xid}/review-links")
def list_review_links(xid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    base = get_settings().public_base_url.rstrip("/")
    return [r.to_dict(url=f"{base}/review/{r.token}") for r in db.query(ReviewLink).filter(ReviewLink.export_id == xid)]


@router.delete("/review-links/{token}")
def revoke_review_link(token: str, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    r = get_or_404(db, ReviewLink, token)
    r.revoked = True
    db.commit()
    return {"ok": True}


def _link(db: Session, token: str) -> ReviewLink:
    r = db.get(ReviewLink, token)
    if not r or r.revoked or (r.expires_at and r.expires_at < utcnow()):
        raise HTTPException(404, "This review link has expired or was revoked")
    return r


@router.get("/review/{token}")
def review_info(token: str, db: Session = Depends(get_db)):
    r = _link(db, token)
    x = db.get(Export, r.export_id)
    p = db.get(Project, r.project_id)
    ep = db.get(Episode, x.episode_id)
    return {"project": p.title, "episode": ep.title or f"Episode {ep.number}", "label": r.label, "allow_comments": r.allow_comments,
            "duration_s": x.duration_s, "language": x.language, "peaks": x.peaks or [],
            "expires_at": r.expires_at.isoformat() + "Z" if r.expires_at else None,
            "video_url": f"/api/review/{token}/video", "poster_url": f"/api/review/{token}/poster"}


@router.get("/review/{token}/video")
def review_video(token: str, db: Session = Depends(get_db)):
    x = db.get(Export, _link(db, token).export_id)
    return FileResponse(_review_file(x.path if x else ""), media_type="video/mp4")


def _review_file(rel: str) -> Path:
    p = get_storage().abs(rel) if rel else None
    if not p or not p.is_file():
        raise HTTPException(404, "File not available")
    return p


@router.get("/review/{token}/poster")
def review_poster(token: str, db: Session = Depends(get_db)):
    x = db.get(Export, _link(db, token).export_id)
    return FileResponse(_review_file(x.thumbnail_path if x else ""))


@router.get("/review/{token}/comments")
def review_comments(token: str, db: Session = Depends(get_db)):
    r = _link(db, token)
    users = {u.id: u for u in db.query(User).all()}
    rows = (db.query(Comment).filter(Comment.target_type == "export", Comment.target_id == r.export_id)
            .order_by(Comment.timecode, Comment.id).all())
    return [c.to_dict(author=(users[c.user_id].name if c.user_id in users else c.guest_name or "Guest")) for c in rows]


class GuestCommentIn(BaseModel):
    guest_name: str = Field(min_length=1, max_length=80)
    body: str = Field(min_length=1, max_length=2000)
    timecode: float | None = None
    drawing: list[dict] = []


@router.post("/review/{token}/comments")
def review_comment(token: str, body: GuestCommentIn, db: Session = Depends(get_db)):
    r = _link(db, token)
    if not r.allow_comments:
        raise HTTPException(403, "Comments are off for this link")
    c = Comment(project_id=r.project_id, target_type="export", target_id=r.export_id, user_id=None, guest_name=body.guest_name,
                body=body.body, timecode=body.timecode, drawing=body.drawing[:50])
    db.add(c)
    db.commit()
    emit(db, r.project_id, "comment.created", {"comment_id": c.id, "target_type": "export", "target_id": r.export_id,
                                               "by": f"{body.guest_name} (client)", "excerpt": body.body[:120], "mentions": []})
    return c.to_dict(author=body.guest_name)


# ── character identity (LoRA) ────────────────────────────────────────────────

class TrainIn(BaseModel):
    project_id: int | None = None


@router.post("/characters/{cid}/train")
def train_identity(cid: int, body: TrainIn, request: Request, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    from ..core import identity as identity_core
    from .bible import _check_unlocked
    ch = get_or_404(db, Character, cid)
    _check_unlocked(ch, user)
    ts = identity_core.summary(db, ch)
    if ts["count"] < ts["min"]:
        raise HTTPException(400, f"Needs at least {ts['min']} approved images to learn the face (has {ts['count']}). "
                                 "Upload more photos, or make variations of your photo and approve the good ones.")
    p = db.get(Project, body.project_id) if body.project_id else None
    audit(db, user, "character.train", ch.name, {"images": ts["count"], "basis": ts["basis"]}, request=request, commit=False)
    return jobs.submit(db, user, p, [generation.train_identity_spec(db, body.project_id, ch)])


class VariationsIn(BaseModel):
    count: int = 6
    project_id: int | None = None


@router.post("/characters/{cid}/training/variations")
def identity_variations(cid: int, body: VariationsIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Make AI variations of the character's own photo for the training set; they wait for review (approve the good ones)."""
    from .bible import _check_unlocked
    ch = get_or_404(db, Character, cid)
    _check_unlocked(ch, user)
    if not db.query(CharacterAsset).filter(CharacterAsset.character_id == cid, CharacterAsset.kind == "source",
                                           CharacterAsset.approved.is_(True), CharacterAsset.archived.is_(False)).count():
        raise HTTPException(400, "Upload a photo of this person first: variations are made from your photo")
    p = db.get(Project, body.project_id) if body.project_id else None
    return jobs.submit(db, user, p, [generation.identity_variations_spec(db, body.project_id, ch, max(1, min(body.count, 12)))])


@router.delete("/characters/{cid}/identity")
def reset_identity(cid: int, user: User = Depends(require("producer")), db: Session = Depends(get_db)):
    ch = get_or_404(db, Character, cid)
    ch.identity = {}
    db.commit()
    emit(db, None, "bible.updated", {"character_id": ch.id, "what": "identity"}, user_id=user.id)
    return {"ok": True}


# ── per-user UI preferences ──────────────────────────────────────────────────

class PrefsIn(BaseModel):
    ui_language: Literal["en", "hi", "kn", "te", "ta"] | None = None
    theme: Literal["dark", "light", "system"] | None = None
    onboarding_done: bool | None = None
    motion: Literal["full", "reduced"] | None = None


@router.get("/me/prefs")
def get_prefs(user: User = Depends(current_user)):
    return user.prefs or {}


@router.patch("/me/prefs")
def patch_prefs(body: PrefsIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    u = db.get(User, user.id)
    u.prefs = {**(u.prefs or {}), **body.model_dump(exclude_unset=True)}
    db.commit()
    return u.prefs
