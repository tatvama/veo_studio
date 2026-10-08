"""Login sessions (signed cookie), password hashing and role checks."""
from __future__ import annotations

import bcrypt
from fastapi import Depends, HTTPException, Request, WebSocket
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import User, role_rank

COOKIE = "veo_session"
MAX_AGE = 60 * 60 * 24 * 14  # 14 days


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().app_secret, salt="veo-session")


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(pw: str, hashed: str | None) -> bool:
    if not hashed:
        return False
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except ValueError:
        return False


def make_session_token(user: User) -> str:
    return _serializer().dumps({"uid": user.id, "v": user.session_version})


def read_session_token(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        return _serializer().loads(token, max_age=MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None


def user_from_token(db: Session, token: str | None) -> User | None:
    data = read_session_token(token)
    if not data:
        return None
    user = db.get(User, data.get("uid"))
    if not user or not user.active or user.session_version != data.get("v"):
        return None
    return user


def set_session_cookie(response, user: User) -> None:
    response.set_cookie(COOKIE, make_session_token(user), max_age=MAX_AGE, httponly=True, samesite="lax",
                        secure=get_settings().cookie_secure, path="/")


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    user = user_from_token(db, request.cookies.get(COOKIE))
    if not user:
        raise HTTPException(401, "Please log in")
    # CSRF guard: state-changing requests must carry our custom header (forces a CORS preflight).
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("x-requested-with") != "veo-studio":
        raise HTTPException(403, "Missing X-Requested-With header")
    return user


def require(role: str):
    def dep(user: User = Depends(current_user)) -> User:
        if role_rank(user.role) < role_rank(role):
            raise HTTPException(403, f"This needs the {role} role or higher")
        return user

    return dep


def ws_user(ws: WebSocket, db: Session) -> User | None:
    return user_from_token(db, ws.cookies.get(COOKIE))
