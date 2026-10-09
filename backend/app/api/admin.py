"""Team management, settings, API keys, provider status, costs."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import catalog, settings_store
from ..core import autopilot as autopilot_def
from ..core import budget
from ..db import get_db
from ..models import ROLES, CostEntry, Project, User
from ..providers.services import provider_status
from ..core.audit import audit
from ..security import current_user, hash_password, require
from .common import get_or_404, user_brief

router = APIRouter(prefix="/api", tags=["admin"])


@router.get("/users")
def list_users(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.query(User).order_by(User.id).all()
    since = budget.month_start()
    out = []
    for u in rows:
        d = u.to_dict(spent_month_usd=round(budget.spent(db, user_id=u.id, since=since), 4),
                      effective_limit_usd=budget.user_limit(db, u))
        if user.role != "admin":
            d = {k: d[k] for k in ("id", "name", "email", "role", "active")}
        out.append(d)
    return out


class UserIn(BaseModel):
    email: str
    name: str = ""
    role: str = "creator"
    password: str | None = Field(default=None, min_length=8)
    monthly_limit_usd: float | None = None


@router.post("/users")
def create_user(body: UserIn, admin: User = Depends(require("admin")), db: Session = Depends(get_db)):
    if body.role not in ROLES:
        raise HTTPException(400, f"role must be one of {ROLES}")
    email = body.email.strip().lower()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(400, "A user with this email already exists")
    u = User(email=email, name=body.name, role=body.role, monthly_limit_usd=body.monthly_limit_usd,
             password_hash=hash_password(body.password) if body.password else None)
    db.add(u)
    audit(db, admin, "user.create", email, {"role": body.role}, commit=False)
    db.commit()
    return u.to_dict()


class UserPatch(BaseModel):
    name: str | None = None
    role: str | None = None
    active: bool | None = None
    monthly_limit_usd: float | None = None
    clear_limit: bool = False
    password: str | None = Field(default=None, min_length=8)


@router.patch("/users/{uid}")
def update_user(uid: int, body: UserPatch, admin: User = Depends(require("admin")), db: Session = Depends(get_db)):
    u = get_or_404(db, User, uid)
    if body.role is not None:
        if body.role not in ROLES:
            raise HTTPException(400, "bad role")
        if u.id == admin.id and body.role != "admin":
            raise HTTPException(400, "You can't remove your own admin role")
        u.role = body.role
    if body.name is not None:
        u.name = body.name
    if body.active is not None:
        if u.id == admin.id and not body.active:
            raise HTTPException(400, "You can't disable yourself")
        u.active = body.active
        u.session_version += 1
    if body.monthly_limit_usd is not None:
        u.monthly_limit_usd = body.monthly_limit_usd
    if body.clear_limit:
        u.monthly_limit_usd = None
    if body.password:
        u.password_hash = hash_password(body.password)
        u.session_version += 1
    audit(db, admin, "user.update", u.email, body.model_dump(exclude_unset=True, exclude={"password"}), commit=False)
    db.commit()
    return u.to_dict()


# ── settings ─────────────────────────────────────────────────────────────────

@router.get("/settings")
def get_settings_(user: User = Depends(current_user), db: Session = Depends(get_db)):
    s = settings_store.all_settings(db)
    for k in ("alerts_sent", "credit_holds", "credit_balances"):  # bookkeeping, not settings (see /api/providers/credit)
        s.pop(k, None)
    return {"settings": s, "models": settings_store.models(db), "prices": settings_store.prices(db),
            "catalog": {"languages": catalog.LANGUAGES, "quality_modes": catalog.QUALITY_MODES,
                        "project_types": catalog.PROJECT_TYPES, "export_presets": catalog.EXPORT_PRESETS,
                        "style_presets": catalog.STYLE_PRESETS, "gemini_voices": catalog.GEMINI_PREBUILT_VOICES,
                        "sarvam_speakers": catalog.SARVAM_SPEAKERS, "sts_languages": sorted(catalog.STS_LANGUAGES),
                        "roles": ROLES, "autopilot": autopilot_def.catalog()},
            "providers": provider_status(), "team": budget.team_status(db)}


ALLOWED = set(settings_store.DEFAULTS)


@router.patch("/settings")
def patch_settings(body: dict[str, Any], admin: User = Depends(require("admin")), db: Session = Depends(get_db)):
    bad = [k for k in body if k not in ALLOWED]
    if bad:
        raise HTTPException(400, f"Unknown settings: {bad}")
    for k, v in body.items():
        settings_store.set_setting(db, k, v)
    audit(db, admin, "settings.update", ",".join(body)[:160], {k: (v if k not in ("prices", "models") else "…") for k, v in body.items()}, commit=False)
    db.commit()
    return get_settings_(admin, db)


@router.get("/settings/api-keys")
def api_keys(admin: User = Depends(require("admin")), db: Session = Depends(get_db)):
    return [{"provider": p, "source": settings_store.key_source(db, p), "masked": settings_store.mask(settings_store.api_key(p))}
            for p in settings_store.PROVIDERS]


class KeyIn(BaseModel):
    key: str = Field(min_length=8)


@router.put("/settings/api-keys/{provider}")
def set_key(provider: str, body: KeyIn, admin: User = Depends(require("admin")), db: Session = Depends(get_db)):
    if provider not in settings_store.PROVIDERS:
        raise HTTPException(404, "unknown provider")
    if provider == "byteplus_iam":  # saved together as "ACCESS_KEY:SECRET"
        ak, _, sk = body.key.partition(":")
        if not ak.strip() or not sk.strip():
            raise HTTPException(400, "Enter the BytePlus Access Key ID and Secret Access Key")
    settings_store.save_api_key(db, provider, body.key, admin.id)
    audit(db, admin, "apikey.set", provider, commit=False)
    from ..core import credit
    credit.release(db, "byteplus" if provider == "byteplus_iam" else provider)  # a new key: try that provider again
    db.commit()
    settings_store.VERSION["n"] += 1  # the key cache re-reads the committed key
    if provider == "openrouter":  # pull its video models and prices into the Model Hub right away
        from ..core import jobs
        jobs.submit(db, admin, None, [jobs.spec("model_sync", payload={"full": False}, label="Model Hub sync")],
                    skip_budget=True)
    return {"ok": True, "providers": provider_status()}


@router.delete("/settings/api-keys/{provider}")
def delete_key(provider: str, admin: User = Depends(require("admin")), db: Session = Depends(get_db)):
    settings_store.delete_api_key(db, provider)
    audit(db, admin, "apikey.delete", provider, commit=False)
    db.commit()
    settings_store.VERSION["n"] += 1
    return {"ok": True, "providers": provider_status()}


@router.get("/providers")
def providers(user: User = Depends(current_user)):
    return provider_status()


# ── costs ────────────────────────────────────────────────────────────────────

@router.get("/costs/summary")
def cost_summary(user: User = Depends(current_user), db: Session = Depends(get_db)):
    since = budget.month_start()
    by_project = (db.query(CostEntry.project_id, func.sum(CostEntry.usd)).filter(CostEntry.created_at >= since)
                  .group_by(CostEntry.project_id).all())
    by_user = (db.query(CostEntry.user_id, func.sum(CostEntry.usd)).filter(CostEntry.created_at >= since)
               .group_by(CostEntry.user_id).all())
    by_provider = (db.query(CostEntry.provider, CostEntry.kind, func.sum(CostEntry.usd), func.count(CostEntry.id))
                   .filter(CostEntry.created_at >= since).group_by(CostEntry.provider, CostEntry.kind).all())
    projects = {p.id: p.title for p in db.query(Project).all()}
    users = {u.id: u for u in db.query(User).all()}
    return {
        "team": budget.team_status(db),
        "mine": {"spent_usd": round(budget.spent(db, user_id=user.id, since=since), 4), "limit_usd": budget.user_limit(db, user)},
        "by_project": [{"project_id": pid, "title": projects.get(pid, "—"), "usd": round(v or 0, 4)} for pid, v in by_project],
        "by_user": [{"user": user_brief(users.get(uid)), "usd": round(v or 0, 4)} for uid, v in by_user],
        "by_provider": [{"provider": p, "kind": k, "usd": round(v or 0, 4), "count": n} for p, k, v, n in by_provider],
    }


@router.get("/costs/ledger")
def ledger(project_id: int | None = None, limit: int = 200, user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = db.query(CostEntry)
    if project_id:
        q = q.filter(CostEntry.project_id == project_id)
    return [e.to_dict() for e in q.order_by(CostEntry.id.desc()).limit(min(limit, 1000)).all()]
