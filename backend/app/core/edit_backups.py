"""Backups of Tatvam Editor edits on the studio (docs/EDITOR.md §10): the editor (or Tatvam Desktop) sends the edit's
.tatvamedit JSON; it is checked, kept as projects/{pid}/edit_backups/<iso>-<hash>.json and listed with what's in it.

The same content is kept once. Retention: the newest 50 backups of an edit, plus the newest one of each day for the
last 30 days; older ones are removed when a new backup comes in. Restoring gives the JSON back for the PC to write.
The endpoints live in api/edits.py."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta
from typing import Any, Iterable

from sqlalchemy.orm import Session

from ..db import utcnow
from ..models import EditBackup, Project, User
from ..storage import get_storage

MAX_BYTES = 20 * 1024 * 1024
KEEP_LAST = 50
DAILY_DAYS = 30
FORMAT = "tatvam-edit"


class BackupError(Exception):
    def __init__(self, msg: str, status: int = 400):
        super().__init__(msg)
        self.status = status


def read_doc(data: bytes) -> dict[str, Any]:
    """The edit document in `data`, or BackupError when it isn't a .tatvamedit file."""
    if not data:
        raise BackupError("The file is empty")
    if len(data) > MAX_BYTES:
        raise BackupError(f"An edit backup is at most {MAX_BYTES // (1024 * 1024)} MB", 413)
    try:
        doc = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as e:
        raise BackupError("That isn't a Tatvam Editor edit (not JSON)") from e
    if not isinstance(doc, dict) or doc.get("format") != FORMAT:
        raise BackupError("That isn't a Tatvam Editor edit (format must be “tatvam-edit”)")
    if not isinstance(doc.get("sequences"), list) or not isinstance(doc.get("media", []), list):
        raise BackupError("That edit has no sequences")
    return doc


def _num(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def summary(doc: dict[str, Any]) -> dict[str, Any]:
    """What a backup holds: its name, how many clips and sequences, and the active sequence's length in seconds."""
    seqs = [s for s in doc.get("sequences") or [] if isinstance(s, dict)]
    clips = sum(len(s.get("clips") or []) for s in seqs)
    active = next((s for s in seqs if s.get("id") == doc.get("activeSequenceId")), seqs[0] if seqs else None)
    duration = 0.0
    if active:
        fps = _num(active.get("fps"), 25.0) or 25.0
        end = max((_num(c.get("start")) + _num(c.get("duration")) for c in active.get("clips") or [] if isinstance(c, dict)),
                  default=0.0)
        duration = round(end / fps, 3)
    return {"name": str(doc.get("name") or "")[:200], "edit_id": str(doc.get("id") or "")[:80],
            "edit_modified": str(doc.get("modified") or "")[:40], "clip_count": clips, "sequence_count": len(seqs),
            "duration_s": duration}


def keep_ids(rows: Iterable[tuple[int, datetime]], now: datetime | None = None, keep_last: int = KEEP_LAST,
             daily_days: int = DAILY_DAYS) -> set[int]:
    """Which backups stay: the newest `keep_last`, plus the newest of each day (UTC) of the last `daily_days` days."""
    now = now or utcnow()
    ordered = sorted(rows, key=lambda r: (r[1], r[0]), reverse=True)
    keep = {i for i, _ in ordered[:keep_last]}
    since = (now - timedelta(days=daily_days)).date()
    days: set = set()
    for i, at in ordered:
        d = at.date()
        if d >= since and d not in days:
            days.add(d)
            keep.add(i)
    return keep


def prune(db: Session, project_id: int, now: datetime | None = None) -> int:
    """Removes the backups retention no longer keeps (rows and files). → how many."""
    rows = db.query(EditBackup).filter(EditBackup.project_id == project_id).all()
    keep = keep_ids([(b.id, b.created_at) for b in rows], now)
    st = get_storage()
    gone = 0
    for b in rows:
        if b.id in keep:
            continue
        st.delete(b.key)
        db.delete(b)
        gone += 1
    return gone


def save(db: Session, project: Project, data: bytes, *, device: str = "", note: str = "",
         user: User | None = None) -> tuple[EditBackup, bool]:
    """Keeps `data` as a backup of the edit. → (the backup, True when the same content was already kept)."""
    doc = read_doc(data)
    sha = hashlib.sha256(data).hexdigest()
    st = get_storage()
    have = (db.query(EditBackup).filter(EditBackup.project_id == project.id, EditBackup.sha256 == sha)
            .order_by(EditBackup.id.desc()).first())
    if have is not None:
        if not st.exists(have.key):  # the file went missing: put it back
            st.save_bytes(have.key, data)
        return have, True
    now = utcnow()
    key = f"projects/{project.id}/edit_backups/{now.strftime('%Y%m%dT%H%M%S')}{now.microsecond // 1000:03d}Z-{sha[:12]}.json"
    st.save_bytes(key, data)
    b = EditBackup(project_id=project.id, key=key, sha256=sha, size=len(data), device=device.strip()[:120],
                   note=note.strip()[:200], created_by=user.id if user else None, created_at=now, **summary(doc))
    db.add(b)
    db.flush()
    prune(db, project.id, now)
    return b, False


def load(b: EditBackup) -> dict[str, Any]:
    st = get_storage()
    if not st.exists(b.key):
        raise BackupError("That backup's file is gone from the studio", 404)
    return read_doc(st.abs(b.key).read_bytes())


def out(b: EditBackup, by: dict | None = None) -> dict[str, Any]:
    return {"id": b.id, "project_id": b.project_id, "created_at": b.created_at.isoformat() + "Z" if b.created_at else None,
            "size": b.size, "sha256": b.sha256, "name": b.name, "edit_id": b.edit_id, "edit_modified": b.edit_modified,
            "clip_count": b.clip_count, "sequence_count": b.sequence_count, "duration": b.duration_s, "device": b.device,
            "note": b.note, "by": by, "download_url": f"/api/edits/{b.project_id}/backups/{b.id}"}
