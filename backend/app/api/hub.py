"""Model Hub API: catalog, engine policy (chains), per-shot engine choice and shootouts."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import catalog, settings_store
from ..core import jobs, model_hub
from ..core.audit import audit
from ..core.budget import Estimator
from ..core.generation import shootout_specs
from ..db import get_db
from ..events import emit
from ..models import AIModel, Episode, Project, Shot, Take, User
from ..pipeline.prompting import effective_quality, effective_voice_mode, shot_lines
from ..pipeline.selection import select
from ..providers.services import provider_mode
from ..security import current_user, require
from .common import get_or_404, take_out

router = APIRouter(prefix="/api", tags=["models"])


def model_out(m: AIModel, est_seconds: float = 8.0) -> dict:
    d = m.to_dict()
    d.pop("param_map", None)
    d["provider_mode"] = provider_mode(m.provider)
    d["price_label"] = (f"${m.price_usd:g}/{m.price_unit or 'run'}" if m.price_usd is not None
                        else ("catalog price" if m.builtin else "price unknown"))
    d["est_8s_usd"] = round(model_hub.price_for(m, seconds=est_seconds), 4) if m.task in ("video", "avatar", "lipsync", "edit") else None
    d["unmapped_required"] = (m.param_map or {}).get("unmapped_required", [])
    return d


SORTS = ("newest", "name", "price", "rating", "uses")


@router.get("/models")
def list_models(task: str | None = None, status: str | None = None, q: str | None = None, provider: str | None = None,
                mode: str | None = None, sort: str = "newest", limit: int = 400, offset: int = 0,
                user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Catalog list. `total` is the number of matches before paging; use limit/offset to page (max 1000 per call)."""
    query = db.query(AIModel)
    if task:
        query = query.filter(AIModel.task.in_(task.split(",")))
    if status:
        query = query.filter(AIModel.status.in_(status.split(",")))
    else:
        query = query.filter(AIModel.status != "retired")
    if provider:
        query = query.filter(AIModel.provider == provider)
    if q:
        like = f"%{q.lower()}%"
        query = query.filter(or_(AIModel.display_name.ilike(like), AIModel.endpoint.ilike(like), AIModel.family.ilike(like),
                                 AIModel.description.ilike(like)))
    if sort not in SORTS:
        raise HTTPException(400, f"sort must be one of {', '.join(SORTS)}")
    order = {
        "newest": [AIModel.released_at.desc(), AIModel.display_name],
        "name": [AIModel.display_name],
        "price": [AIModel.price_usd.is_(None), AIModel.price_usd, AIModel.display_name],  # unpriced last
        "rating": [AIModel.rating.is_(None), AIModel.rating.desc(), AIModel.wins.desc(), AIModel.display_name],
        "uses": [AIModel.uses.desc(), AIModel.wins.desc(), AIModel.display_name],
    }[sort]
    rows = query.order_by(AIModel.builtin.desc(), *order).all()
    if mode:  # modes live in JSON, so filter in Python before paging
        rows = [m for m in rows if mode in ((m.capabilities or {}).get("modes") or [])]
    total = len(rows)
    start = max(offset, 0)
    rows = rows[start:start + max(1, min(limit, 1000))]
    last = settings_store.get_setting(db, "hub_last_sync") or {}
    counts = {s: db.query(AIModel).filter(AIModel.status == s).count() for s in ("enabled", "new", "disabled", "retired")}
    return {"models": [model_out(m) for m in rows], "total": total, "offset": start, "last_sync": last, "counts": counts}


@router.get("/models/policy")
def get_policy(user: User = Depends(current_user), db: Session = Depends(get_db)):
    pol = model_hub.policy(db)
    ids = {i for chain in pol.values() for i in chain}
    rows = {m.id: m for m in db.query(AIModel).filter(AIModel.id.in_(ids)).all()} if ids else {}
    return {"chains": pol, "labels": model_hub.CHAIN_LABELS, "defaults": model_hub.DEFAULT_POLICY,
            "models": {i: model_out(rows[i]) for i in ids if i in rows}}


class PolicyIn(BaseModel):
    chains: dict[str, list[str]]


@router.put("/models/policy")
def put_policy(body: PolicyIn, request: Request, admin: User = Depends(require("admin")), db: Session = Depends(get_db)):
    bad = [k for k in body.chains if k not in model_hub.DEFAULT_POLICY]
    if bad:
        raise HTTPException(400, f"Unknown chains: {bad}")
    for chain, ids in body.chains.items():  # anything placed in a chain is switched on
        for mid in ids:
            m = db.get(AIModel, mid)
            if m and m.status in ("new", "disabled"):
                m.status = "enabled"
    settings_store.set_setting(db, "engine_policy", body.chains)
    audit(db, admin, "models.policy", detail={k: v[:6] for k, v in body.chains.items()}, request=request)
    return get_policy(admin, db)


@router.post("/models/sync")
def sync_now(full: bool = False, admin: User = Depends(require("admin")), db: Session = Depends(get_db)):
    return jobs.submit(db, admin, None, [jobs.spec("model_sync", payload={"full": full}, label="Model Hub sync")], skip_budget=True)


@router.get("/models/{model_id:path}")
def get_model(model_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    m = get_or_404(db, AIModel, model_id, "Model")
    d = model_out(m)
    d["param_map"] = m.param_map
    return d


class ModelPatch(BaseModel):
    status: str | None = None
    tier: str | None = None
    rating: float | None = None
    notes: str | None = None
    price_usd: float | None = None
    price_unit: str | None = None
    param_overrides: dict[str, Any] | None = None


@router.patch("/models/{model_id:path}")
def patch_model(model_id: str, body: ModelPatch, request: Request, admin: User = Depends(require("admin")),
                db: Session = Depends(get_db)):
    m = get_or_404(db, AIModel, model_id, "Model")
    data = body.model_dump(exclude_unset=True)
    if "status" in data and data["status"] not in ("enabled", "disabled", "new"):
        raise HTTPException(400, "status must be enabled, disabled or new")
    if "price_usd" in data:
        m.price_source = "manual"
    for k, v in data.items():
        setattr(m, k, v)
    audit(db, admin, "models.update", m.id, data, request=request, commit=False)
    db.commit()
    emit(db, None, "models.updated", {"model_id": m.id})
    return model_out(m)


# ── per-shot engines & shootout ──────────────────────────────────────────────

def video_fit(caps: dict) -> dict:
    """What a video engine can take from a shot (for the shot list's model picker and its warnings).
    characters / location: "refs" (the images go straight to the model), "keyframe" (through the first frame,
    which is made from them) or "none" (text only: the look is not kept)."""
    modes = set(caps.get("modes") or [])
    max_refs = int(caps.get("max_refs") or 0)
    via = "refs" if "ref2v" in modes and max_refs > 0 else "keyframe" if modes & {"i2v", "flf"} else "none"
    return {"characters": via, "location": via, "max_refs": max_refs if via == "refs" else 0,
            "start_frame": bool(modes & {"i2v", "flf"}), "end_frame": "flf" in modes,
            "sound": bool(caps.get("native_audio")), "extend": "extend" in modes, "talking": "a2v" in modes}


@router.get("/engines/video")
def video_engines(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Video models you can pick for a shot, with what each can use (characters, location, sound) and a price for
    an 8-second clip. Auto follows the team policy (Google first)."""
    rows = db.query(AIModel).filter(AIModel.status == "enabled", AIModel.task == "video").all()
    out = []
    for m in rows:
        caps = m.capabilities or {}
        if caps.get("usable") is False or provider_mode(m.provider) == "missing":
            continue
        if not set(caps.get("modes") or []) & {"t2v", "i2v", "ref2v", "flf"}:
            continue
        d = model_out(m)
        d["fit"] = video_fit(caps)
        out.append(d)
    rank = {"refs": 0, "keyframe": 1, "none": 2}
    out.sort(key=lambda d: (d["provider"] != "google", rank[d["fit"]["characters"]], d["est_8s_usd"] or 0))
    pol = model_hub.policy(db)
    ids = {d["id"] for d in out}
    # what Auto tries first, per quality mode (the shot's or the project's)
    auto = {q: next((x for x in pol.get(f"video.{q}", []) if x in ids), None) for q in ("saver", "balanced", "hero")}
    return {"engines": out, "auto_first": auto,
            "google_first": settings_store.get_setting(db, "google_first") is not False}

@router.get("/shots/{sid}/engines")
def shot_engines(sid: int, purpose: str = "video", user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Engines that can make this shot, with an estimated price each — for the engine picker / shootout."""
    s = get_or_404(db, Shot, sid)
    p = db.get(Project, db.get(Episode, s.episode_id).project_id)
    est = Estimator(db)
    if purpose == "lipsync":
        modes, tasks = {"lipsync"}, ("lipsync",)
    elif purpose == "dialogue":
        modes, tasks = {"a2v"}, ("avatar", "video")
    else:
        modes, tasks = {"i2v", "t2v", "ref2v", "flf"}, ("video",)
    rows = db.query(AIModel).filter(AIModel.status == "enabled", AIModel.task.in_(tasks)).all()
    out = []
    for m in rows:
        caps = m.capabilities or {}
        if not (set(caps.get("modes") or []) & modes) or caps.get("usable") is False:
            continue
        if provider_mode(m.provider) == "missing":
            continue
        d = model_out(m)
        d["estimate_usd"] = round(est.engine_video(s, p, m.id), 4)
        out.append(d)
    out.sort(key=lambda d: (not d["builtin"], d["estimate_usd"]))
    q = effective_quality(s, p)
    vm = effective_voice_mode(s, p)
    chain = "dialogue" if vm == "audio_driven" and shot_lines(s, p.primary_language) else f"video.{q}"
    return {"engines": out, "current": s.engine or "auto", "auto_chain": model_hub.policy(db).get(chain, []), "chain": chain}


class ShootoutIn(BaseModel):
    engines: list[str]


@router.post("/shots/{sid}/shootout")
def shootout(sid: int, body: ShootoutIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    if not 2 <= len(body.engines) <= 4:
        raise HTTPException(400, "Pick 2–4 engines")
    s = get_or_404(db, Shot, sid)
    p = db.get(Project, db.get(Episode, s.episode_id).project_id)
    return jobs.submit(db, user, p, shootout_specs(db, p, s, body.engines))


@router.post("/takes/{tid}/winner")
def mark_winner(tid: int, user: User = Depends(require("reviewer")), db: Session = Depends(get_db)):
    """Pick a shootout winner: selects the take and credits the engine (shown in Model Hub ratings)."""
    t = get_or_404(db, Take, tid)
    select(db, t)
    if t.kind == "video" and (t.params or {}).get("audio_driven"):  # its speaking twin becomes the final lip-sync take
        for twin in db.query(Take).filter(Take.shot_id == t.shot_id, Take.kind == "lipsync").all():
            if (twin.params or {}).get("video_take_id") == t.id:
                select(db, twin)
    engine = (t.params or {}).get("engine")
    m = db.get(AIModel, engine) if engine else None
    if m:
        m.wins = (m.wins or 0) + 1
    db.commit()
    s = db.get(Shot, t.shot_id)
    emit(db, db.get(Episode, s.episode_id).project_id, "shot.updated", {"shot_id": s.id, "winner": t.id}, user_id=user.id)
    return take_out(t)
