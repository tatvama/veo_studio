from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings

_settings = get_settings()
_is_sqlite = _settings.db_url.startswith("sqlite")

_pool = {} if _is_sqlite else {
    "pool_size": _settings.db_pool_size,
    "max_overflow": _settings.db_max_overflow,
    "pool_timeout": 30,  # seconds to wait for a free connection before failing the request
    "pool_recycle": _settings.db_pool_recycle_s,
}
engine = create_engine(
    _settings.db_url,
    # pg8000 and psycopg both accept `timeout` for the TCP connect; SQLite uses it as the lock wait
    connect_args={"check_same_thread": False, "timeout": 30} if _is_sqlite else {"timeout": _settings.db_connect_timeout_s},
    pool_pre_ping=True,
    future=True,
    **_pool,
)

if _is_sqlite:
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _):  # pragma: no cover - trivial
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=30000")
        cur.close()

SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)


class Base(DeclarativeBase):
    pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def is_sqlite() -> bool:
    return _is_sqlite
