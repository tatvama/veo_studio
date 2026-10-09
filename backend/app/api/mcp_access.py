"""MCP access: personal tokens for MCP clients (Settings → MCP access) and the OAuth consent step (/oauth/consent)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db, utcnow
from ..models import ApiToken, Project, User, role_rank
from ..security import current_user
from ..mcp_server import tokens

router = APIRouter(prefix="/api", tags=["mcp"])


def _allowed_scopes(user: User) -> list[str]:
    return list(tokens.SCOPES) if role_rank(user.role) >= role_rank("creator") else ["read"]


@router.get("/mcp/info")
def info(user: User = Depends(current_user)):
    from ..mcp_server.auth import oauth_possible
    from ..mcp_server.server import tool_names

    base = get_settings().public_base_url.rstrip("/")
    return {"enabled": get_settings().mcp_enabled, "url": f"{base}/mcp", "oauth": oauth_possible(),
            "scopes": _allowed_scopes(user), "tools": tool_names()}


class TokenIn(BaseModel):
    name: str = "MCP token"
    scopes: list[str] = ["read", "write"]
    project_ids: list[int] = []
    expires_days: int | None = None


@router.get("/mcp/tokens")
def list_tokens(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = (db.query(ApiToken).filter(ApiToken.user_id == user.id, ApiToken.revoked.is_(False),
                                      ApiToken.kind.in_(("personal", "oauth_access")))
            .order_by(ApiToken.id.desc()).all())
    return [tokens.out(r) for r in rows if r.kind == "personal" or r.expires_at is None or r.expires_at > utcnow()]


@router.post("/mcp/tokens")
def create_token(body: TokenIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    bad = [s for s in body.scopes if s not in _allowed_scopes(user)]
    if bad:
        raise HTTPException(403, f"Your role cannot give a token these scopes: {', '.join(bad)}")
    for pid in body.project_ids:
        if db.get(Project, pid) is None:
            raise HTTPException(400, f"No project {pid}")
    if body.expires_days is not None and not 1 <= body.expires_days <= 3650:
        raise HTTPException(400, "expires_days must be between 1 and 3650")
    row, raw = tokens.create(db, user, body.name.strip() or "MCP token", body.scopes, body.project_ids, body.expires_days)
    db.commit()
    return tokens.out(row, raw)


@router.post("/mcp/tokens/{tid}/revoke")
def revoke_token(tid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    row = db.get(ApiToken, tid)
    if row is None or (row.user_id != user.id and user.role != "admin"):
        raise HTTPException(404, "Token not found")
    tokens.revoke_pair(db, row)
    return {"ok": True}


# ── OAuth consent (the page an MCP client sends you to) ──────────────────────

@router.get("/oauth/requests/{rid}")
def oauth_request(rid: str, user: User = Depends(current_user)):
    from ..mcp_server.auth import consent_view
    view = consent_view(rid)
    if view is None:
        raise HTTPException(404, "Sign-in request not found. Start again from the app you are connecting.")
    return {**view, "allowed_scopes": _allowed_scopes(user)}


class DecideIn(BaseModel):
    approve: bool
    scopes: list[str] | None = None


@router.post("/oauth/requests/{rid}/decide")
def oauth_decide(rid: str, body: DecideIn, user: User = Depends(current_user)):
    from ..mcp_server.auth import decide
    scopes = [s for s in (body.scopes or []) if s in _allowed_scopes(user)] or None
    if body.approve and scopes is None and role_rank(user.role) < role_rank("creator"):
        scopes = ["read"]
    try:
        return {"redirect": decide(rid, user, body.approve, scopes)}
    except ValueError as e:
        raise HTTPException(400, str(e))
