from __future__ import annotations

import secrets
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db, utcnow
from ..models import User
from ..security import COOKIE, current_user, hash_password, set_session_cookie, verify_password
from .common import user_brief

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    email: str
    password: str


class SetupIn(BaseModel):
    email: str
    name: str = ""
    password: str = Field(min_length=8)


@router.get("/status")
def status(request: Request, db: Session = Depends(get_db)):
    from ..security import user_from_token
    s = get_settings()
    user = user_from_token(db, request.cookies.get(COOKIE))
    return {"setup_needed": db.query(User).count() == 0, "google_enabled": bool(s.google_client_id and s.google_client_secret),
            "user": user_brief(user) if user else None, "app_name": s.app_name}


@router.post("/setup")
def setup(body: SetupIn, response: Response, db: Session = Depends(get_db)):
    if db.query(User).count() > 0:
        raise HTTPException(400, "Setup already done")
    u = User(email=body.email.strip().lower(), name=body.name.strip(), password_hash=hash_password(body.password),
             role="admin", last_login_at=utcnow())
    db.add(u)
    db.commit()
    set_session_cookie(response, u)
    return {"user": user_brief(u)}


@router.post("/login")
def login(body: LoginIn, response: Response, db: Session = Depends(get_db)):
    u = db.query(User).filter(User.email == body.email.strip().lower()).first()
    if not u or not u.active or not verify_password(body.password, u.password_hash):
        raise HTTPException(401, "Wrong email or password")
    u.last_login_at = utcnow()
    db.commit()
    set_session_cookie(response, u)
    return {"user": user_brief(u)}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(current_user)):
    return {"user": user_brief(user)}


class PasswordIn(BaseModel):
    current: str
    new: str = Field(min_length=8)


@router.post("/password")
def change_password(body: PasswordIn, response: Response, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if user.password_hash and not verify_password(body.current, user.password_hash):
        raise HTTPException(400, "Current password is wrong")
    u = db.get(User, user.id)
    u.password_hash = hash_password(body.new)
    u.session_version += 1
    db.commit()
    set_session_cookie(response, u)
    return {"ok": True}


# ── Google sign-in (optional) ────────────────────────────────────────────────

_states: dict[str, float] = {}


@router.get("/google/start")
def google_start():
    s = get_settings()
    if not s.google_client_id:
        raise HTTPException(404, "Google sign-in is not configured")
    state = secrets.token_urlsafe(24)
    _states[state] = utcnow().timestamp()
    q = urlencode({"client_id": s.google_client_id, "redirect_uri": f"{s.public_base_url.rstrip('/')}/api/auth/google/callback",
                   "response_type": "code", "scope": "openid email profile", "state": state, "prompt": "select_account"})
    return RedirectResponse(f"https://accounts.google.com/o/oauth2/v2/auth?{q}")


@router.get("/google/callback")
def google_callback(code: str = "", state: str = "", db: Session = Depends(get_db)):
    s = get_settings()
    if not code or state not in _states:
        raise HTTPException(400, "Invalid sign-in attempt")
    _states.pop(state, None)
    tok = httpx.post("https://oauth2.googleapis.com/token", data={
        "code": code, "client_id": s.google_client_id, "client_secret": s.google_client_secret,
        "redirect_uri": f"{s.public_base_url.rstrip('/')}/api/auth/google/callback", "grant_type": "authorization_code"},
        timeout=20).json()
    if "access_token" not in tok:
        raise HTTPException(400, "Google sign-in failed")
    info = httpx.get("https://openidconnect.googleapis.com/v1/userinfo",
                     headers={"Authorization": f"Bearer {tok['access_token']}"}, timeout=20).json()
    email = (info.get("email") or "").lower()
    if not email or not info.get("email_verified", False):
        raise HTTPException(400, "Google account email is not verified")
    u = db.query(User).filter(User.email == email).first()
    if not u:
        domains = [d.strip().lower() for d in s.allowed_google_domains.split(",") if d.strip()]
        if email.split("@")[-1] not in domains:
            raise HTTPException(403, "This Google account has not been invited. Ask an admin to add you.")
        u = User(email=email, name=info.get("name", ""), role="viewer")
        db.add(u)
    if not u.active:
        raise HTTPException(403, "Account disabled")
    u.last_login_at = utcnow()
    db.commit()
    resp = RedirectResponse(s.frontend_origin if "localhost:5173" in s.frontend_origin else "/")
    set_session_cookie(resp, u)
    return resp
