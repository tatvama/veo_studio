"""VEO STUDIO — FastAPI entry point.

Run (dev):   backend/.venv/Scripts/python -m uvicorn app.main:app --reload --port 8100   (from backend/)
"""
from __future__ import annotations

import mimetypes
from contextlib import asynccontextmanager
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

from .api import (admin, auth, bible, board, campaign, designs, fx, generate, growth, hub, layers, production, projects, rates,
                  room, shots,
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
    yield
    if settings.run_worker_in_process:
        from .workers.worker import stop_worker
        stop_worker()


app = FastAPI(title="VEO STUDIO", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=[settings.frontend_origin], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])
app.add_middleware(RetryReads)  # re-run a GET once if a dropped database connection failed it (see middleware.py)

for r in (auth.router, admin.router, projects.router, bible.router, shots.router, generate.router, work.router, hub.router,
          room.router, growth.router, board.router, fx.router, layers.router, production.router, campaign.router, rates.router,
          designs.router):
    app.include_router(r)


@app.exception_handler(ProviderError)
async def provider_error(_: Request, exc: ProviderError):
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.get("/api/health")
def health():
    from .providers.services import provider_status
    return {"ok": True, "providers": provider_status()}


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
