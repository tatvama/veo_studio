"""VEO STUDIO — FastAPI entry point.

Run (dev):   backend/.venv/Scripts/python -m uvicorn app.main:app --reload --port 8100   (from backend/)
"""
from __future__ import annotations

import mimetypes
import time
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("video/mp4", ".mp4")

from . import __version__
from .api import (admin, auth, bible, board, campaign, designs, fx, generate, growth, hub, layers, mcp_access, production,
                  projects, rates, room, shots,
                  work)
from .config import ROOT, get_settings
from .db import Base, engine
from .middleware import RetryReads
from .providers.base import ProviderError

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    from .db_migrate import migrate
    from .core.model_hub import seed_builtins

    migrate()
    seed_builtins()
    if settings.run_worker_in_process:
        from .workers.worker import start_worker
        start_worker()
    async with AsyncExitStack() as stack:
        if settings.mcp_enabled:
            from .mcp_server.server import session_manager
            await stack.enter_async_context(session_manager().run())
        yield
    if settings.run_worker_in_process:
        from .workers.worker import stop_worker
        stop_worker()


app = FastAPI(title="VEO STUDIO", version=__version__, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=[settings.frontend_origin], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])
app.add_middleware(RetryReads)  # re-run a GET once if a dropped database connection failed it (see middleware.py)

for r in (auth.router, admin.router, projects.router, bible.router, shots.router, generate.router, work.router, hub.router,
          room.router, growth.router, board.router, fx.router, layers.router, production.router, campaign.router, rates.router,
          designs.router, mcp_access.router):
    app.include_router(r)

if settings.mcp_enabled:  # /mcp and the OAuth endpoints for MCP clients (app/mcp_server), before the web app catch-all
    from .mcp_server.server import routes as mcp_routes
    app.router.routes.extend(mcp_routes())


@app.exception_handler(ProviderError)
async def provider_error(_: Request, exc: ProviderError):
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.get("/api/health")
def health():
    from .providers.services import provider_status
    return {"ok": True, "providers": provider_status()}


@app.get("/api/health/live")
def health_live():
    """Liveness: the process answers. Never touches the database, so a slow database can't get the app restarted."""
    from . import health as h
    return {"ok": True, "version": app.version, "uptime_s": round(time.time() - h.STARTED_AT)}


@app.get("/api/health/ready")
def health_ready():
    """Readiness: the database answers, and (when the worker runs inside this process) the job worker is alive."""
    from . import health as h
    db_ok, db_ms, db_err = h.check_database()
    in_process = settings.run_worker_in_process
    worker_ok = h.worker_alive() if in_process else None
    ok = db_ok and (worker_ok is not False)
    body = {"ok": ok, "database": {"ok": db_ok, "ms": db_ms, **({"error": db_err} if db_err else {})},
            "worker": {"in_process": in_process, "ok": worker_ok, "heartbeat_age_s": (round(h.heartbeat_age() or 0) if in_process else None)}}
    return JSONResponse(status_code=200 if ok else 503, content=body)


# Serve the built frontend (production). In dev, Vite serves it on :5173 and proxies /api and /media here.
DIST = ROOT / "frontend" / "dist"


@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str):
    if full_path.startswith(("api/", "media/")):
        raise HTTPException(404)
    if not DIST.exists():
        return JSONResponse({"detail": "Frontend not built. Run `npm run build` in frontend/ or use the Vite dev server."}, 404)
    f = (DIST / full_path).resolve()
    if full_path and f.is_file() and DIST.resolve() in f.parents:
        # hashed build files never change → cache for a year; everything else (sw.js, manifest, icons) revalidates
        immutable = full_path.startswith("assets/")
        return FileResponse(f, headers={"Cache-Control": "public, max-age=31536000, immutable" if immutable else "no-cache"})
    return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})
