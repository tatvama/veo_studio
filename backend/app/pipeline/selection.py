"""Which take is 'current' for a shot (per kind + language)."""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Take


def takes(db: Session, shot_id: int, kind: str, language: str | None = None, any_language: bool = False) -> list[Take]:
    q = db.query(Take).filter(Take.shot_id == shot_id, Take.kind == kind, Take.archived.is_(False), Take.status == "ready")
    if not any_language:
        q = q.filter(Take.language == language) if language is not None else q.filter(Take.language.is_(None))
    return q.order_by(Take.id.desc()).all()


def current(db: Session, shot_id: int, kind: str, language: str | None = None) -> Take | None:
    rows = takes(db, shot_id, kind, language)
    for t in rows:
        if t.selected:
            return t
    return rows[0] if rows else None


def is_real(take: Take | None) -> bool:
    """A take that is actual work: not a placeholder made in mock mode while that provider now has a key."""
    if take is None:
        return False
    if (take.params or {}).get("mock"):
        from ..providers.services import provider_mode
        return provider_mode(take.provider) != "live"
    return True


def source_video_id(db: Session, take: Take | None) -> int | None:
    """The video take a lip-sync / voice-lock take was made from (through any edits of it)."""
    seen = set()
    while take is not None and take.kind != "video" and take.parent_take_id and take.id not in seen:
        seen.add(take.id)
        take = db.get(Take, take.parent_take_id)
    return take.id if take is not None and take.kind == "video" else None


def is_stale(db: Session, derived: Take | None, video: Take | None) -> bool:
    """True when a lip-sync / voice-lock take belongs to an older video than the current one."""
    if derived is None or video is None:
        return False
    src = source_video_id(db, derived)
    return src is not None and src != video.id


def select(db: Session, take: Take) -> None:
    for t in takes(db, take.shot_id, take.kind, take.language):
        t.selected = t.id == take.id
    take.selected = True
    db.flush()


def has_fresh(db: Session, shot_id: int, kind: str, language: str) -> bool:
    """A lip-sync / voice-lock take exists for this language and was made from the current video."""
    t = current(db, shot_id, kind, language)
    return t is not None and not is_stale(db, t, current(db, shot_id, "video"))
