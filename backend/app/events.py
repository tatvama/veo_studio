"""Event log. Workers and API write events; the WebSocket endpoint streams them to browsers."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy.orm import Session

from .db import SessionLocal, utcnow
from .models import Event


def emit(db: Session | None, project_id: int | None, type_: str, payload: dict[str, Any] | None = None,
         user_id: int | None = None, commit: bool = True) -> None:
    own = db is None
    db = db or SessionLocal()
    try:
        db.add(Event(project_id=project_id, type=type_, payload=payload or {}, user_id=user_id))
        if commit or own:
            db.commit()
    finally:
        if own:
            db.close()


def prune(db: Session, keep_hours: int = 48) -> int:
    cutoff = utcnow() - timedelta(hours=keep_hours)
    n = db.query(Event).filter(Event.created_at < cutoff).delete()
    db.commit()
    return n
