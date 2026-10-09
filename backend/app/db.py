from __future__ import annotations

import socket
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator

from sqlalchemy import create_engine, event, make_url
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings

_settings = get_settings()
_is_sqlite = _settings.db_url.startswith("sqlite")


def _connect_args() -> dict:
    if _is_sqlite:
        return {"check_same_thread": False, "timeout": 30}  # SQLite: lock wait
    if make_url(_settings.db_url).get_driver_name() == "pg8000":
        return {"timeout": _settings.db_connect_timeout_s}  # TCP connect; keepalive is set on the socket below
    # psycopg / psycopg2 (libpq): connect timeout plus TCP keepalive probes, same timings as _keepalive()
    return {"connect_timeout": _settings.db_connect_timeout_s, "keepalives": 1, "keepalives_idle": 20,
            "keepalives_interval": 5, "keepalives_count": 4}


_pool = {} if _is_sqlite else {
    "pool_size": _settings.db_pool_size,
    "max_overflow": _settings.db_max_overflow,
    "pool_timeout": 30,  # seconds to wait for a free connection before failing the request
    "pool_recycle": _settings.db_pool_recycle_s,
}
engine = create_engine(
    _settings.db_url,
    connect_args=_connect_args(),
    pool_pre_ping=True,
    future=True,
    **_pool,
)

_NET_HINTS = ("network error", "timed out", "connection reset", "forcibly closed", "server closed the connection",
              "can't create a connection", "connection is closed", "broken pipe", "connection refused", "connection aborted")


def is_network_error(exc: BaseException | None) -> bool:
    """True when a database call failed because the network to the server stalled or dropped (not a SQL or data error).
    Looks through SQLAlchemy and driver wrappers to the root cause."""
    seen = 0
    while exc is not None and seen < 6:
        if isinstance(exc, (TimeoutError, ConnectionError)):
            return True
        if type(exc).__name__ in ("InterfaceError", "OperationalError") and any(h in str(exc).lower() for h in _NET_HINTS):
            return True
        exc = getattr(exc, "orig", None) or exc.__cause__ or exc.__context__
        seen += 1
    return False


def _keepalive(dbapi_conn) -> None:
    """Probe idle connections every 20 s. A remote server reached over a home or mobile link sits behind NAT that forgets
    idle TCP connections after a few minutes; the probes keep the mapping alive and expose a dead peer quickly."""
    sock = getattr(dbapi_conn, "_usock", None)  # pg8000 keeps the raw socket here
    if sock is None:
        return
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        if hasattr(socket, "SIO_KEEPALIVE_VALS"):  # Windows: (on, idle ms, interval ms)
            sock.ioctl(socket.SIO_KEEPALIVE_VALS, (1, 20_000, 5_000))
        else:
            for opt, val in (("TCP_KEEPIDLE", 20), ("TCP_KEEPINTVL", 5), ("TCP_KEEPCNT", 4)):
                if hasattr(socket, opt):
                    sock.setsockopt(socket.IPPROTO_TCP, getattr(socket, opt), val)
    except OSError:
        pass


if not _is_sqlite:
    @event.listens_for(engine, "connect")
    def _pg_connect(dbapi_conn, _):
        _keepalive(dbapi_conn)

    @event.listens_for(engine, "handle_error")
    def _drop_broken_connections(ctx):
        # A stalled or reset socket leaves the connection unusable: have the pool throw it away (and re-check its
        # siblings) instead of handing it to the next request.
        if is_network_error(ctx.original_exception):
            ctx.is_disconnect = True

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
