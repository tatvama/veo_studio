"""Bearer tokens for the MCP server: personal access tokens and OAuth tokens, kept as SHA-256 hashes.

Scopes:  read  = look at projects, scripts, storyboards, jobs
         write = change scripts, scenes and shots, run AI writing, and PROPOSE paid work (nothing is spent)
         spend = approve proposals and start paid work (budget limits and approvals still apply)
"""
from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from ..db import utcnow
from ..models import ApiToken, User

SCOPES = ("read", "write", "spend")
DEFAULT_SCOPES = ["read", "write"]
PREFIX = "tvm_"
ACCESS_TTL = timedelta(hours=8)  # OAuth access tokens; personal tokens never expire unless asked
REFRESH_TTL = timedelta(days=60)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def new_raw() -> str:
    return PREFIX + secrets.token_urlsafe(32)


def clean_scopes(scopes: list[str] | None, default: list[str] | None = None) -> list[str]:
    picked = [s for s in (scopes or []) if s in SCOPES]
    if not picked:
        picked = list(default if default is not None else DEFAULT_SCOPES)
    if "spend" in picked and "write" not in picked:
        picked.append("write")
    if "read" not in picked:
        picked.insert(0, "read")
    return [s for s in SCOPES if s in picked]


def create(db: Session, user: User, name: str, scopes: list[str] | None = None, project_ids: list[int] | None = None,
           expires_days: int | None = None, *, kind: str = "personal", client_id: str = "", resource: str = "",
           pair_id: str = "", expires_at: datetime | None = None) -> tuple[ApiToken, str]:
    """Make a token. Returns (row, raw token); the raw token is shown once and never stored."""
    raw = new_raw()
    if expires_at is None and expires_days:
        expires_at = utcnow() + timedelta(days=int(expires_days))
    row = ApiToken(user_id=user.id, name=(name or "MCP token")[:120], kind=kind, token_hash=hash_token(raw),
                   prefix=raw[: len(PREFIX) + 6], scopes=clean_scopes(scopes), project_ids=[int(p) for p in (project_ids or [])],
                   client_id=client_id[:200], resource=resource[:500], pair_id=pair_id, expires_at=expires_at)
    db.add(row)
    db.flush()
    return row, raw


def issue_pair(db: Session, user: User, client_id: str, scopes: list[str], resource: str = "",
               name: str = "") -> tuple[str, str, ApiToken]:
    """An OAuth access token + refresh token for an MCP client. Returns (access, refresh, access row)."""
    pair = uuid.uuid4().hex
    acc, raw_acc = create(db, user, name or f"OAuth: {client_id}", scopes, kind="oauth_access", client_id=client_id,
                          resource=resource, pair_id=pair, expires_at=utcnow() + ACCESS_TTL)
    _, raw_ref = create(db, user, name or f"OAuth: {client_id}", scopes, kind="oauth_refresh", client_id=client_id,
                        resource=resource, pair_id=pair, expires_at=utcnow() + REFRESH_TTL)
    return raw_acc, raw_ref, acc


def lookup(db: Session, raw: str | None, kinds: tuple[str, ...] = ("personal", "oauth_access")) -> ApiToken | None:
    """The live token row for a raw bearer token (not revoked, not expired, user still active), or None."""
    if not raw or not raw.startswith(PREFIX):
        return None
    row = db.query(ApiToken).filter(ApiToken.token_hash == hash_token(raw)).first()
    if row is None or row.revoked or row.kind not in kinds:
        return None
    if row.expires_at is not None and row.expires_at < utcnow():
        return None
    user = db.get(User, row.user_id)
    if user is None or not user.active:
        return None
    return row


def touch(db: Session, row: ApiToken) -> None:
    """Record use, at most once a minute (every MCP call checks the token)."""
    now = utcnow()
    if row.last_used_at is None or (now - row.last_used_at).total_seconds() > 60:
        row.last_used_at = now
        db.commit()


def revoke_pair(db: Session, row: ApiToken) -> None:
    rows = [row] if not row.pair_id else db.query(ApiToken).filter(ApiToken.pair_id == row.pair_id).all()
    for r in rows:
        r.revoked = True
    db.commit()


def out(row: ApiToken, raw: str | None = None) -> dict[str, Any]:
    d = row.to_dict()
    if raw:
        d["token"] = raw
    return d
