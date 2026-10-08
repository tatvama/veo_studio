"""Team presence and edit locks.

Presence: every open browser tab reports (over the live WebSocket) which project it is in, which view it shows and
what it is editing. Everyone in the same project sees who else is there.

Edit locks: while someone edits a shot (or the whole shot list), others can look but not change it. A lock is a short
lease (LOCK_TTL seconds) that the editing tab renews; it ends when they save, close, or their tab goes away, so a lock
is never stuck. Saving or generating on something another person holds is refused with HTTP 423.

Kept in memory: one API process holds it (a restart simply clears all locks, which are leases anyway).
"""
from __future__ import annotations

import threading
import time
from typing import Any

from fastapi import HTTPException

LOCK_TTL = 45.0  # seconds; the editing tab renews every ~15 s
PRESENCE_TTL = 60.0

_mx = threading.Lock()
_people: dict[str, dict[str, Any]] = {}  # connection id -> {user_id, name, project_id, view, editing, seen}
_locks: dict[str, dict[str, Any]] = {}  # target ("shot:12", "board:3") -> {user_id, name, project_id, since, expires}
_version = 0


def _bump() -> None:
    global _version
    _version += 1


def version() -> int:
    return _version


def _sweep(now: float) -> None:
    gone = [k for k, v in _locks.items() if v["expires"] < now]
    gone_p = [k for k, v in _people.items() if now - v["seen"] > PRESENCE_TTL]
    for k in gone:
        _locks.pop(k, None)
    for k in gone_p:
        _people.pop(k, None)
    if gone or gone_p:
        _bump()


# ── presence ─────────────────────────────────────────────────────────────────

def report(conn: str, user, project_id: int | None, view: str = "", editing: str = "") -> None:
    with _mx:
        cur = _people.get(conn)
        new = {"user_id": user.id, "name": user.name or user.email, "project_id": project_id,
               "view": (view or "")[:40], "editing": (editing or "")[:60], "seen": time.time()}
        changed = not cur or any(cur.get(k) != new[k] for k in ("project_id", "view", "editing"))
        _people[conn] = new
        if changed:
            _bump()


def leave(conn: str) -> None:
    with _mx:
        if _people.pop(conn, None):
            _bump()


def snapshot(project_id: int | None) -> dict[str, Any]:
    now = time.time()
    with _mx:
        _sweep(now)
        people: dict[int, dict[str, Any]] = {}
        for p in _people.values():
            if project_id is None or p["project_id"] != project_id:
                continue
            q = people.setdefault(p["user_id"], {"user_id": p["user_id"], "name": p["name"], "views": [], "editing": []})
            if p["view"] and p["view"] not in q["views"]:
                q["views"].append(p["view"])
            if p["editing"] and p["editing"] not in q["editing"]:
                q["editing"].append(p["editing"])
        locks = [{"target": k, "user_id": v["user_id"], "name": v["name"], "since": v["since"]}
                 for k, v in _locks.items() if project_id is None or v["project_id"] == project_id]
    return {"people": list(people.values()), "locks": locks}


# ── locks ────────────────────────────────────────────────────────────────────

def acquire(target: str, user, project_id: int | None) -> tuple[bool, dict | None]:
    """Take or renew a lock. Returns (ok, holder): holder is the other person when it's theirs."""
    now = time.time()
    with _mx:
        _sweep(now)
        cur = _locks.get(target)
        if cur and cur["user_id"] != user.id:
            return False, {"user_id": cur["user_id"], "name": cur["name"], "since": cur["since"]}
        fresh = cur is None
        _locks[target] = {"user_id": user.id, "name": user.name or user.email, "project_id": project_id,
                          "since": cur["since"] if cur else now, "expires": now + LOCK_TTL}
        if fresh:
            _bump()
    return True, None


def release(target: str, user) -> None:
    with _mx:
        cur = _locks.get(target)
        if cur and cur["user_id"] == user.id:
            _locks.pop(target, None)
            _bump()


def holder(target: str, user=None) -> dict | None:
    """Who holds this lock, when it's someone other than `user`."""
    now = time.time()
    with _mx:
        cur = _locks.get(target)
        if not cur or cur["expires"] < now:
            return None
        if user is not None and cur["user_id"] == user.id:
            return None
        return dict(cur)


def check(user, *targets: str) -> None:
    """Refuse a change while another person is editing one of these targets."""
    for t in targets:
        h = holder(t, user)
        if h:
            what = "this shot" if t.startswith("shot:") else "the shot list" if t.startswith("board:") else "this"
            raise HTTPException(423, f"{h['name']} is editing {what} right now. You can look; changes open up when they finish.")


def check_shot(user, shot) -> None:
    check(user, f"shot:{shot.id}", f"board:{shot.episode_id}")


def reset() -> None:  # tests
    with _mx:
        _people.clear()
        _locks.clear()
        _bump()
