"""Desktop finishing room jobs: the AI upscale step (core/desktop.py, docs/DESKTOP.md §2.6)."""
from __future__ import annotations

from .. import settings_store
from ..db import SessionLocal
from ..events import emit
from ..models import Shot, Take
from ..providers.base import ProviderError
from ..storage import get_storage
from .handlers import save_take
from .worker import JobContext, handler


@handler("upscale")
def upscale(ctx: JobContext) -> dict:
    """Upscale a shot's video take on fal and keep it as Take(kind="upscale", parent_take_id=<that video>)."""
    p = ctx.payload
    with SessionLocal() as db:
        src = db.get(Take, p.get("take_id"))
        if src is None or src.archived or not src.path or src.kind != "video":
            raise ProviderError("The video to upscale is gone (archived or deleted)")
        team = settings_store.all_settings(db)
        endpoint = str(team.get("upscale_fal_endpoint") or "fal-ai/topaz/upscale/video")
        model = str(team.get("upscale_model") or "Proteus")
        price = float(team.get("upscale_price_per_s") or 0.08)
        src_id, video = src.id, get_storage().abs(src.path)
    ctx.progress(0.05, "Upscaling")
    res = ctx.services.upscale_video(video, int(p["w"]), int(p["h"]), float(p["factor"]), endpoint, model, price,
                                     on_tick=ctx.tick("Upscaling", 300), on_request=lambda rid: ctx.save_result(request_id=rid),
                                     resume=ctx.result.get("request_id"))
    with SessionLocal() as db:
        shot = db.get(Shot, ctx.shot_id)
        t = save_take(db, ctx, shot, "upscale", res.data, res.ext, provider="fal", model=endpoint,
                      params={"w": int(p["w"]), "h": int(p["h"]), "factor": float(p["factor"]), "endpoint": endpoint, "model": model},
                      duration=res.duration_s, cost=res.usage.usd, remote_ref=res.remote_ref, parent=src_id)
        ctx.cost(res.usage, db)
        db.commit()
        emit(db, ctx.project_id, "take.created", {"shot_id": shot.id, "take_id": t.id, "kind": "upscale"})
    return {"take_id": t.id}
