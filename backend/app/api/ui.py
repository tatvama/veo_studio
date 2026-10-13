"""The screens' manifest for Tatvam Desktop (docs/DESKTOP.md §4.3): what the built frontend in `frontend/dist` contains,
so a desktop app can keep a verified offline copy of this server's screens.

`GET /api/ui/manifest` needs no sign-in (the files are public anyway: the SPA route serves them to anyone). It is
computed once and cached until `index.html` changes (its modification time first, then its hash).
"""
from __future__ import annotations

import hashlib
import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import __version__
from ..config import ROOT

router = APIRouter(prefix="/api/ui", tags=["ui"])

DIST: Path = ROOT / "frontend" / "dist"
# `tatvam.requiresDesktop` lives in frontend/package.json (next to dist/)
PACKAGE_JSON: Path | None = None

_lock = threading.Lock()
_cache: dict = {"key": None, "hash": None, "manifest": None}


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _requires_desktop(dist: Path) -> str:
    pkg = PACKAGE_JSON or dist.parent / "package.json"
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
        v = (data.get("tatvam") or {}).get("requiresDesktop")
        return str(v) if v else "0.0.0"
    except (OSError, ValueError, AttributeError):
        return "0.0.0"


def build_manifest(dist: Path) -> dict:
    """Every file of the build with its size and sha256 (paths relative, with forward slashes, sorted)."""
    index = dist / "index.html"
    root = dist.resolve()
    files = []
    for p in sorted(dist.rglob("*")):
        if not p.is_file() or p.is_symlink():
            continue
        rp = p.resolve()
        if root not in rp.parents:
            continue
        files.append({"path": p.relative_to(dist).as_posix(), "size": p.stat().st_size, "sha256": _sha256(p)})
    index_sha = next((f["sha256"] for f in files if f["path"] == "index.html"), _sha256(index))
    built = datetime.fromtimestamp(index.stat().st_mtime, tz=timezone.utc)
    return {
        "build": index_sha[:12],
        "version": __version__,
        "built_at": built.isoformat().replace("+00:00", "Z"),
        "requires_desktop": _requires_desktop(dist),
        "files": files,
    }


def current_manifest(dist: Path | None = None) -> dict | None:
    """The cached manifest, rebuilt when index.html's modification time and then its hash say the build changed."""
    dist = dist or DIST
    index = dist / "index.html"
    try:
        st = index.stat()
    except OSError:
        return None
    key = (str(dist), st.st_mtime_ns, st.st_size)
    with _lock:
        if _cache["key"] == key and _cache["manifest"] is not None:
            return _cache["manifest"]
        digest = _sha256(index)
        if _cache["hash"] == (str(dist), digest) and _cache["manifest"] is not None:
            _cache["key"] = key  # touched but unchanged
            return _cache["manifest"]
        manifest = build_manifest(dist)
        _cache.update(key=key, hash=(str(dist), digest), manifest=manifest)
        return manifest


@router.get("/manifest")
def ui_manifest():
    m = current_manifest()
    if m is None:
        return JSONResponse({"detail": "The frontend isn't built on this server"}, status_code=404)
    return JSONResponse(m, headers={"Cache-Control": "no-cache"})
