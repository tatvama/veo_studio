"""Durable audit log for sensitive actions (users, keys, settings, approvals, locks, publishing, engines)."""
from __future__ import annotations

from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from ..models import AuditEntry, User


def audit(db: Session, user: User | None, action: str, target: str = "", detail: dict[str, Any] | None = None,
          request: Request | None = None, commit: bool = True) -> None:
    ip = ""
    if request is not None:
        ip = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for", "").split(",")[0] or (
            request.client.host if request.client else "")
    db.add(AuditEntry(user_id=user.id if user else None, action=action, target=target[:160], detail=detail or {}, ip=ip[:60]))
    if commit:
        db.commit()
