"""Model Hub: catalog of every generation engine, live sync, pricing, and the per-shot router.

* Built-in engines (Google Veo/Omni/Nano Banana direct, sync.so direct) are always present.
* fal.ai models are discovered automatically (daily or on demand) with their input schemas, so new
  releases (Kling, Seedance, Wan, MiniMax, LTX, Flux, Luma, Grok …) appear without a code change.
* Engine chains ("policy") decide which engines a quality tier / task uses, in order, with fallback.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from .. import catalog, settings_store
from ..db import SessionLocal, utcnow
from ..events import emit
from ..models import AIModel
from ..providers import fal as fal_api
from ..providers.schema_map import build_param_map, derive_capabilities
from ..providers.services import provider_mode

V = ["16:9", "9:16"]
BUILTINS: list[dict[str, Any]] = [
    {"id": "google:video_saver", "provider": "google", "endpoint": "video_saver", "task": "video", "family": "Veo 3.1",
     "maker": "google", "display_name": "Veo 3.1 Lite", "tier": "draft",
     "capabilities": {"modes": ["t2v", "i2v", "flf"], "durations": [4, 6, 8], "resolutions": ["720p", "1080p"], "aspects": V,
                      "native_audio": True, "max_refs": 0}},
    {"id": "google:video_balanced", "provider": "google", "endpoint": "video_balanced", "task": "video", "family": "Veo 3.1",
     "maker": "google", "display_name": "Veo 3.1 Fast", "tier": "standard",
     "capabilities": {"modes": ["t2v", "i2v", "flf", "ref2v", "extend"], "durations": [4, 6, 8],
                      "resolutions": ["720p", "1080p", "4k"], "aspects": V, "native_audio": True, "max_refs": 3}},
    {"id": "google:video_hero", "provider": "google", "endpoint": "video_hero", "task": "video", "family": "Veo 3.1",
     "maker": "google", "display_name": "Veo 3.1", "tier": "premium",
     "capabilities": {"modes": ["t2v", "i2v", "flf", "ref2v", "extend"], "durations": [4, 6, 8],
                      "resolutions": ["720p", "1080p", "4k"], "aspects": V, "native_audio": True, "max_refs": 3}},
    {"id": "google:omni", "provider": "google", "endpoint": "omni", "task": "edit", "family": "Gemini Omni",
     "maker": "google", "display_name": "Gemini Omni Flash 1.1", "tier": "standard",
     "capabilities": {"modes": ["edit", "extend"], "durations": {"min": 3, "max": 10}, "aspects": V, "native_audio": True}},
    {"id": "google:image", "provider": "google", "endpoint": "image", "task": "image", "family": "Nano Banana",
     "maker": "google", "display_name": "Nano Banana 2.1", "tier": "standard",
     "capabilities": {"modes": ["t2i", "i2i"], "max_refs": 10}},
    {"id": "google:image_hero", "provider": "google", "endpoint": "image_hero", "task": "image", "family": "Nano Banana",
     "maker": "google", "display_name": "Nano Banana Pro (Gemini 3 Pro Image)", "tier": "premium",
     "capabilities": {"modes": ["t2i", "i2i"], "max_refs": 10}},
    {"id": "sync:lipsync", "provider": "sync", "endpoint": "lipsync", "task": "lipsync", "family": "sync.so",
     "maker": "sync", "display_name": "sync.so lipsync-2", "tier": "draft", "capabilities": {"modes": ["lipsync"]}},
    {"id": "sync:lipsync_pro", "provider": "sync", "endpoint": "lipsync_pro", "task": "lipsync", "family": "sync.so",
     "maker": "sync", "display_name": "sync.so lipsync-2-pro", "tier": "standard", "capabilities": {"modes": ["lipsync"]}},
    {"id": "sync:lipsync_angles", "provider": "sync", "endpoint": "lipsync_angles", "task": "lipsync", "family": "sync.so",
     "maker": "sync", "display_name": "sync.so sync-3 (side angles, 4K)", "tier": "premium", "capabilities": {"modes": ["lipsync"]}},
]

# Engine chains: tried in order; the first enabled engine whose provider is usable and that supports
# the needed mode wins; on a non-retryable failure (e.g. safety block, bad input) the next one is tried.
DEFAULT_POLICY: dict[str, list[str]] = {
    "video.saver": ["google:video_saver", "fal:alibaba/wan-3.0/image-to-video", "fal:bytedance/seedance-2.0/mini/image-to-video",
                    "fal:xai/grok-imagine-video/v1.5/lite/image-to-video", "fal:lightricks/ltx-2.5/image-to-video/fast"],
    "video.balanced": ["google:video_balanced", "fal:fal-ai/kling-video/v3/pro/image-to-video",
                       "fal:bytedance/seedance-2.5/reference-to-video", "fal:minimax/h3-max/image-to-video",
                       "fal:alibaba/wan-3.0/reference-to-video"],
    "video.hero": ["google:video_hero", "fal:fal-ai/kling-video/o3/4k/reference-to-video",
                   "fal:alibaba/wan-3.0-prime/image-to-video", "fal:bytedance/seedance-2.5/image-to-video"],
    "dialogue": ["fal:minimax/h3-max/lip-sync/image-to-video", "fal:fal-ai/kling-video/ai-avatar/v2/pro",
                 "fal:lightricks/ltx-2.5/audio-to-video/pro", "fal:fal-ai/sync-lipsync/v3/image-to-video"],
    "lipsync": ["sync:lipsync", "fal:fal-ai/sync-lipsync/v3", "fal:fal-ai/heygen/v3/lipsync/precision", "fal:veed/lipsync/v2",
                "sync:lipsync_pro"],
    "image": ["google:image", "fal:google/nano-banana-2.1", "fal:bytedance/seedream/v5/pro/edit"],
    "edit": ["google:omni", "fal:google/gemini-omni-flash/v1.1/edit", "fal:minimax/h3-max/recast"],
    "extend": ["google:video_balanced", "fal:minimax/h3-max-turbo/extend-video"],
}
CHAIN_LABELS = {
    "video.saver": "Video — Saver", "video.balanced": "Video — Balanced", "video.hero": "Video — Hero",
    "dialogue": "Dialogue (audio → talking video)", "lipsync": "Lip-sync (re-dub existing video)",
    "image": "Keyframes & character images", "edit": "Edit a clip with words", "extend": "Extend a clip",
}
TASK_DEFAULT_PRICE = {"video": 0.12, "avatar": 0.08, "lipsync": 0.06, "edit": 0.12, "image": 0.05, "tts": 0.03, "music": 0.10}


# ── catalog ──────────────────────────────────────────────────────────────────

def seed_builtins() -> None:
    with SessionLocal() as db:
        for b in BUILTINS:
            row = db.get(AIModel, b["id"])
            if row is None:
                row = AIModel(id=b["id"], status="enabled", builtin=True)
                db.add(row)
            row.provider, row.endpoint, row.task = b["provider"], b["endpoint"], b["task"]
            row.family, row.maker, row.display_name = b["family"], b["maker"], b["display_name"]
            row.capabilities = b["capabilities"]
            row.tier = row.tier or b["tier"]
            row.builtin = True
            if row.price_source != "manual":  # keep a price the admin set by hand
                row.price_source = "catalog"
            row.last_seen = utcnow()
        db.commit()


def policy(db: Session) -> dict[str, list[str]]:
    saved = settings_store.get_setting(db, "engine_policy") or {}
    return {k: list(saved.get(k, v)) for k, v in DEFAULT_POLICY.items()}


def _tier_guess(eid: str) -> str:
    e = eid.lower()
    if any(w in e for w in ("lite", "mini", "turbo", "fast", "draft", "flash", "speed")):
        return "draft"
    if any(w in e for w in ("pro", "prime", "max", "4k", "quality", "precision", "ultra")):
        return "premium"
    return "standard"


def _maker(eid: str) -> str:
    parts = eid.split("/")
    if parts[0] == "fal-ai" and len(parts) > 1:
        return parts[1].split("-")[0]
    return parts[0]


def sync_catalog(full_schemas: bool = False) -> dict[str, Any]:
    """Pull fal.ai's catalog, map schemas of new/changed models, refresh prices, retire vanished ones."""
    key = settings_store.api_key("fal")
    listed = fal_api.list_models(key=key)
    now = utcnow()
    in_policy = {i for chain in DEFAULT_POLICY.values() for i in chain}
    with SessionLocal() as db:
        auto_enable = bool(settings_store.get_setting(db, "hub_auto_enable"))
        in_policy |= {i for chain in policy(db).values() for i in chain}
        existing = {m.id: m for m in db.query(AIModel).filter(AIModel.provider == "fal").all()}
        # First sync: the whole catalog is "new", which would bury the team in reviews. File the models that aren't
        # in a routing chain as available-but-off; later syncs flag genuinely new arrivals for review.
        first_sync = not existing
        need_schema: list[str] = []
        new_ids: list[str] = []
        for m in listed:
            md = m.get("metadata", {}) or {}
            mid = f"fal:{m['endpoint_id']}"
            row = existing.get(mid)
            changed = row is None or full_schemas or (md.get("updated_at") and md.get("updated_at") != (row.tags or [None])[-1:][0])
            if row is None:
                status = "enabled" if (mid in in_policy or auto_enable) else ("disabled" if first_sync else "new")
                row = AIModel(id=mid, provider="fal", endpoint=m["endpoint_id"], first_seen=now, status=status,
                              tier=_tier_guess(m["endpoint_id"]))
                db.add(row)
                if not first_sync:
                    new_ids.append(mid)
            row.display_name = md.get("display_name") or m["endpoint_id"]
            row.description = md.get("description") or ""
            row.category = md.get("category") or ""
            row.family = ((md.get("group") or {}).get("key") or "").replace("-", " ").title() or row.display_name
            row.maker = _maker(m["endpoint_id"])
            row.thumbnail_url = md.get("thumbnail_url") or ""
            row.released_at = (md.get("date") or "")[:10]
            row.tags = [*(md.get("tags") or []), md.get("updated_at") or ""]
            row.last_seen = now
            if row.status == "retired":
                row.status = "enabled" if mid in in_policy else "new"
            if changed or not row.param_map:
                need_schema.append(m["endpoint_id"])
        db.commit()
        schemas = fal_api.get_openapi(need_schema, key=key) if need_schema else {}
        for eid, spec in schemas.items():
            row = db.get(AIModel, f"fal:{eid}")
            if not row:
                continue
            pm = build_param_map(spec)
            row.param_map = pm
            caps = derive_capabilities(row.category, eid, pm)
            row.capabilities = caps
            row.task = caps["task"]
        prices = fal_api.get_pricing([m["endpoint_id"] for m in listed], key) if key else {}
        for eid, p in prices.items():
            row = db.get(AIModel, f"fal:{eid}")
            if row and row.price_source != "manual" and p.get("unit_price"):  # no price is unknown, not free
                row.price_usd, row.price_unit, row.price_source = p["unit_price"], p["unit"], "live"
        listed_ids = {f"fal:{m['endpoint_id']}" for m in listed}
        retired = 0
        for mid, row in existing.items():
            if mid not in listed_ids and row.status != "retired":
                row.status = "retired"
                retired += 1
        summary = {"at": now.isoformat() + "Z", "total": len(listed), "new": new_ids[:200], "new_count": len(new_ids),
                   "schemas_mapped": len(schemas), "priced": len(prices), "retired": retired,
                   "first_sync": first_sync}
        settings_store.set_setting(db, "hub_last_sync", summary)
        db.commit()
    emit(None, None, "models.synced", {k: v for k, v in summary.items() if k != "new"} | {"new": new_ids[:20]})
    return summary


def sync_due(db: Session) -> bool:
    from ..config import get_settings
    if get_settings().mock_providers == "true" or not settings_store.get_setting(db, "hub_auto_sync"):
        return False
    last = (settings_store.get_setting(db, "hub_last_sync") or {}).get("at")
    hours = float(settings_store.get_setting(db, "hub_sync_hours") or 24)
    if not last:
        return True
    try:
        t = datetime.fromisoformat(last.rstrip("Z"))
    except ValueError:
        return True
    return utcnow() - t > timedelta(hours=hours)


# ── pricing ──────────────────────────────────────────────────────────────────

def price_for(m: AIModel, seconds: float = 8.0, resolution: str = "720p", units: float = 1.0) -> float:
    """Estimated USD for one generation. 0 when the provider is in mock mode."""
    if provider_mode(m.provider) != "live":
        return 0.0
    if m.builtin and m.price_source != "manual":  # a price set by hand in the Hub wins over the catalog
        prices = settings_store.prices()
        models = settings_store.models()
        if m.provider == "google" and m.task in ("video", "edit"):
            table = prices["video_per_second"].get(models.get(m.endpoint, ""), {})
            return float(table.get(resolution) or table.get("720p") or 0.4) * seconds
        if m.provider == "google" and m.task == "image":
            return float(prices["image_each"].get(models.get(m.endpoint, ""), 0.07)) * units
        if m.provider == "sync":
            return float(prices["lipsync_per_second"].get(models.get(m.endpoint, ""), 0.05)) * seconds
    p = m.price_usd
    if p is None:
        return TASK_DEFAULT_PRICE.get(m.task, 0.1) * (seconds if m.task in ("video", "avatar", "lipsync", "edit") else units)
    unit = (m.price_unit or "").lower()
    if "second" in unit or unit in ("s", "sec"):
        return p * seconds
    if "minute" in unit:
        return p * seconds / 60
    return p * units  # per video / image / request / generation


# ── router ───────────────────────────────────────────────────────────────────

def candidates(db: Session, chain: str, modes_ok: list[str], explicit: str | None = None,
               need_refs: int = 0) -> list[tuple[AIModel, str]]:
    """Ordered (model, mode) pairs to try. Explicit engine (shot setting / shootout) wins and is the only choice."""
    ids = [explicit] if explicit and explicit != "auto" else policy(db).get(chain, [])
    out: list[tuple[AIModel, str]] = []
    for mid in ids:
        m = db.get(AIModel, mid)
        if not m or m.status == "retired" or (not explicit and m.status != "enabled"):
            continue
        if provider_mode(m.provider) == "missing":
            continue
        caps = m.capabilities or {}
        if caps.get("usable") is False:
            continue
        modes = set(caps.get("modes") or [])
        for mode in modes_ok:
            if mode in modes:
                if mode == "ref2v" and need_refs and (caps.get("max_refs") or 0) < 1:
                    continue
                out.append((m, mode))
                break
    # a live engine exists: never fall through to a mock one (a placeholder would be saved as real work);
    # with no live engine at all (dev mode) the mock ones keep the app usable
    live = [t for t in out if provider_mode(t[0].provider) == "live"]
    if live:
        out = live
    if not explicit and settings_store.get_setting(db, "google_first") is not False:
        google = [t for t in out if t[0].provider == "google"]
        if google:  # Google can do it: use only Google (fal stays for what Google can't do, or when picked by hand)
            return google
    return out


def first_choice(db: Session, chain: str, modes_ok: list[str], explicit: str | None = None) -> tuple[AIModel, str] | None:
    c = candidates(db, chain, modes_ok, explicit)
    return c[0] if c else None


def clamp_duration(m: AIModel, want: float) -> float:
    d = (m.capabilities or {}).get("durations")
    if isinstance(d, list) and d:
        for x in sorted(d):
            if x >= want - 0.01:
                return float(x)
        return float(max(d))
    if isinstance(d, dict):
        lo, hi = d.get("min"), d.get("max")
        if lo is not None:
            want = max(want, float(lo))
        if hi is not None:
            want = min(want, float(hi))
    return float(want)


def record_outcome(model_id: str, ok: bool) -> None:
    with SessionLocal() as db:
        m = db.get(AIModel, model_id)
        if m:
            if ok:
                m.uses = (m.uses or 0) + 1
            else:
                m.failures = (m.failures or 0) + 1
            db.commit()


def label(db: Session, model_id: str) -> str:
    m = db.get(AIModel, model_id) if model_id else None
    return m.display_name if m else model_id
