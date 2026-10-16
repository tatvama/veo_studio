"""Durable audit log for sensitive actions (users, keys, settings, approvals, locks, publishing, engines)."""
from __future__ import annotations

from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from ..models import AuditEntry, User


def client_ip(request: Request | None) -> str:
    """The caller's address: Cloudflare's header, else the first X-Forwarded-For hop, else the socket peer."""
    if request is None:
        return ""
    return request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
        request.client.host if request.client else "")


def audit(db: Session, user: User | None, action: str, target: str = "", detail: dict[str, Any] | None = None,
          request: Request | None = None, commit: bool = True) -> None:
    ip = client_ip(request)
    db.add(AuditEntry(user_id=user.id if user else None, action=action, target=target[:160], detail=detail or {}, ip=ip[:60]))
    if commit:
        db.commit()
