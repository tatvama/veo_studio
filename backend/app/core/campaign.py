"""Ads campaign: one produced episode → every language × aspect (× duration) variant with locked brand facts.
Also the Reels highlight proposals (no LLM: scored from the shots you already have)."""
from __future__ import annotations

import math
from typing import Any

from sqlalchemy.orm import Session

from .. import catalog
from ..db import utcnow
from ..models import BrandKit, Episode, Export, Job, Project, Shot
from ..pipeline.prompting import shot_lines
from ..pipeline.selection import current
from ..storage import get_storage
from . import generation
from .jobs import spec

# aspect → export preset (catalog.EXPORT_PRESETS keys)
ASPECT_PRESET: dict[str, str] = {"9:16": "shorts", "16:9": "youtube", "1:1": "square"}
DURATIONS = [6, 10, 15, 30, 45, 60, 90]
SETTINGS_KEY = "campaign"


# ── brand facts ──────────────────────────────────────────────────────────────

def brand_facts(db: Session, kit_id: int | None, cta: str = "") -> dict[str, Any]:
    """A frozen snapshot of the brand kit: the renderer and the copywriter read these, no model may invent them."""
    kit = db.get(BrandKit, kit_id) if kit_id else None
    if not kit:
        return {"brand_kit_id": None, "name": "", "logo_path": "", "logo_url": "", "colors": [], "tagline": "",
                "cta": (cta or "").strip(), "website": "", "fonts": {}, "product_assets": [], "end_card": {},
                "locked_at": utcnow().isoformat() + "Z"}
    st = get_storage()
    return {
        "brand_kit_id": kit.id, "name": kit.name, "logo_path": kit.logo_path or "",
        "logo_url": st.url(kit.logo_path) if kit.logo_path else "",
        "colors": [str(c) for c in (kit.colors or [])], "tagline": kit.tagline or "",
        "cta": (cta or "").strip() or (kit.cta or ""), "website": kit.website or "", "fonts": dict(kit.fonts or {}),
        "product_assets": [{"label": str(a.get("label", "")), "path": str(a.get("path", "")), "url": st.url(a.get("path", ""))}
                           for a in (kit.product_assets or []) if isinstance(a, dict)],
        "end_card": dict(kit.end_card or {}), "locked_at": utcnow().isoformat() + "Z",
    }


# ── the plan ─────────────────────────────────────────────────────────────────

def episode_length(db: Session, episode: Episode) -> float:
    return float(sum(max(s.extend_to or 0, s.duration_s) for s in generation.episode_shots(db, episode)))


def normalize(project: Project, episode_len: float, body: Any) -> dict[str, Any]:
    """Clean the request: languages (primary first, known codes only), aspects, durations shorter than the episode."""
    primary = project.primary_language
    langs = [primary]
    for l in list(getattr(body, "languages", None) or []):
        if l in catalog.LANGUAGES and l not in langs:
            langs.append(l)
    aspects = [a for a in dict.fromkeys(getattr(body, "aspects", None) or []) if a in ASPECT_PRESET] or [project.aspect if project.aspect in ASPECT_PRESET else "9:16"]
    durations = sorted({int(d) for d in (getattr(body, "durations", None) or []) if int(d) in DURATIONS and int(d) < episode_len * 0.9})
    return {"languages": langs, "aspects": aspects, "durations": durations, "brand_kit_id": getattr(body, "brand_kit_id", None) or project.brand_kit_id,
            "cta": (getattr(body, "cta", "") or "").strip(), "captions": bool(getattr(body, "captions", True)),
            "publish": bool(getattr(body, "publish", False)), "brief": dict(getattr(body, "brief", None) or {}),
            "redub": bool(getattr(body, "redub", False))}


def needs_dub(db: Session, project: Project, episode: Episode, lang: str) -> bool:
    """A language still has to be dubbed when some spoken shot has no lines (or no voice) in it yet."""
    if lang == project.primary_language:
        return False
    for s in generation.episode_shots(db, episode):
        spoken = bool(shot_lines(s, project.primary_language)) or bool((s.narration or {}).get(project.primary_language))
        if not spoken:
            continue
        if not shot_lines(s, lang) and not (s.narration or {}).get(lang):
            return True
        if shot_lines(s, lang) and not (current(db, s.id, "lipsync", lang) or current(db, s.id, "voice", lang)):
            return True
        if (s.narration or {}).get(lang) and not current(db, s.id, "narration", lang):
            return True
    return False


def variant_grid(cfg: dict[str, Any], full_len: float) -> list[dict[str, Any]]:
    """language × aspect × (full length + each cut-down duration), in render order."""
    out = []
    for d in [None, *cfg["durations"]]:
        for lang in cfg["languages"]:
            for a in cfg["aspects"]:
                out.append({"language": lang, "aspect": a, "preset": ASPECT_PRESET[a], "duration": d or int(round(full_len)),
                            "cut": d is not None, "status": "planned", "export_id": None, "episode_id": None})
    return out


def plan(db: Session, project: Project, episode: Episode, body: Any) -> tuple[float, list[dict]]:
    """(estimate_usd, items for the cost table). Dubs are priced with the existing dub estimate; renders are free."""
    full = episode_length(db, episode)
    cfg = normalize(project, full, body)
    items: list[dict] = []
    for lang in cfg["languages"]:
        if lang != project.primary_language and (cfg["redub"] or needs_dub(db, project, episode, lang)):
            s = generation.dub_spec(db, project, episode, lang)
            items.append({"label": s["label"], "usd": s["estimate"], "kind": "dub", "language": lang})
    for d in cfg["durations"]:
        items.append({"label": f"Cut-down ≈{d}s (Director picks the shots)", "usd": 0.0, "kind": "cutdown", "duration": d})
    for v in variant_grid(cfg, full):
        name = catalog.LANGUAGES.get(v["language"], {}).get("name", v["language"])
        items.append({"label": f"Export {v['aspect']} [{name}]" + (f" · {v['duration']}s cut" if v["cut"] else ""), "usd": 0.0,
                      "kind": "export", "language": v["language"], "aspect": v["aspect"], "duration": v["duration"]})
    return round(sum(i["usd"] for i in items), 4), items


def campaign_spec(db: Session, project: Project, episode: Episode, body: Any) -> dict:
    full = episode_length(db, episode)
    cfg = normalize(project, full, body)
    total, items = plan(db, project, episode, body)
    n = len(variant_grid(cfg, full))
    return spec("campaign", payload={**cfg, "items": items}, project_id=project.id, episode_id=episode.id, estimate=total,
                label=f"Campaign E{episode.number:02} ({n} variants)")


def active_campaign(db: Session, episode: Episode) -> Job | None:
    return (db.query(Job).filter(Job.episode_id == episode.id, Job.type == "campaign",
                                 Job.status.in_(("queued", "running", "awaiting_approval", "proposed"))).first())


# ── stored state ─────────────────────────────────────────────────────────────

def state(db: Session, episode: Episode) -> dict[str, Any]:
    """The campaign as stored on the episode, with the export row of every variant (url, thumb, status)."""
    st = dict((episode.settings or {}).get(SETTINGS_KEY) or {})
    if not st:
        return {"status": "none", "variants": [], "brand_facts": None}
    storage = get_storage()
    ids = [v.get("export_id") for v in st.get("variants", []) if v.get("export_id")]
    rows = {x.id: x for x in db.query(Export).filter(Export.id.in_(ids)).all()} if ids else {}
    out_variants = []
    for v in st.get("variants", []):
        x = rows.get(v.get("export_id"))
        row = None
        if x:
            row = {"id": x.id, "url": storage.url(x.path) if x.path else "", "thumb_url": storage.url(x.thumbnail_path) if x.thumbnail_path else "",
                   "srt_url": storage.url(x.srt_path) if x.srt_path else "", "preset": x.preset, "language": x.language,
                   "status": x.status, "duration_s": x.duration_s, "warnings": x.warnings or [], "episode_id": x.episode_id,
                   "published": x.published or {}, "approved_by": x.approved_by}
        status = v.get("status", "planned")
        if x and status in ("queued", "running", "ready", "failed"):
            status = {"ready": "ready", "failed": "failed"}.get(x.status, status)
        out_variants.append({**v, "status": status, "export": row})
    job = db.get(Job, st.get("job_id")) if st.get("job_id") else None
    if st.get("status") == "running" and (not job or job.status not in ("queued", "running")):
        # the run ended without saying so (server restart): don't show it as running
        st["status"] = {"failed": "failed", "cancelled": "cancelled"}.get(job.status if job else "", "stopped")
    done = sum(1 for v in out_variants if v["status"] == "ready")
    return {**st, "variants": out_variants, "progress": {"done": done, "failed": sum(1 for v in out_variants if v["status"] == "failed"),
                                                         "total": len(out_variants)},
            "job": {"id": job.id, "status": job.status, "progress": job.progress, "message": job.message, "error": job.error} if job else None}


# ── Reels: highlight windows ─────────────────────────────────────────────────

def highlights(db: Session, episode: Episode, max_n: int = 5) -> list[dict[str, Any]]:
    """3–5 windows worth cutting into a reel: hook shot first, then dialogue-dense runs of approved shots with video.
    Deterministic — no model call."""
    project = db.get(Project, episode.project_id)
    primary = project.primary_language if project else "en"
    shots: list[Shot] = generation.episode_shots(db, episode)
    if not shots:
        return []
    info = []
    t = 0.0
    for s in shots:
        dur = max(1.0, float(max(s.extend_to or 0, s.duration_s)) - float(s.trim_in or 0) - float(s.trim_out or 0))
        chars = sum(len(l.get("line", "")) for l in shot_lines(s, primary)) + len((s.narration or {}).get(primary, "") or "")
        density = chars / dur
        approved = s.status == "approved"
        has_video = current(db, s.id, "video") is not None
        score = min(density, 12.0) / 6.0 + (1.5 if approved else 0.0) + (0.6 if has_video else 0.0) + (0.3 if s.characters else 0.0)
        info.append({"code": s.code, "start": t, "end": t + dur, "dur": dur, "score": score, "approved": approved,
                     "video": has_video, "density": density})
        t += dur
    n = len(info)
    windows: list[dict] = []
    for i in range(n):
        acc = 0.0
        for j in range(i, n):
            acc += info[j]["dur"]
            if acc >= 6:
                run = info[i:j + 1]
                mean = sum(r["score"] for r in run) / len(run)
                fit = 0.0 if 10 <= acc <= 35 else -0.4 if acc < 10 else -0.6
                windows.append({"i": i, "j": j, "seconds": acc, "score": mean * (1 + 0.08 * len(run)) + fit + (2.0 if i == 0 else 0.0)})
            if acc >= 45:
                break
    if not windows:  # a very short episode: the whole thing is the highlight
        windows = [{"i": 0, "j": n - 1, "seconds": t, "score": 1.0}]
    windows.sort(key=lambda w: (-w["score"], w["i"]))
    picked: list[dict] = []
    hook = next((w for w in windows if w["i"] == 0), None)
    if hook:
        picked.append(hook)
    for w in windows:
        if len(picked) >= max_n:
            break
        if any(not (w["j"] < p["i"] or w["i"] > p["j"]) for p in picked):
            continue
        picked.append(w)
    out = []
    for w in picked:
        run = info[w["i"]:w["j"] + 1]
        reasons = []
        if w["i"] == 0:
            reasons.append("hook")
        if all(r["approved"] for r in run):
            reasons.append("approved")
        elif any(r["approved"] for r in run):
            reasons.append("some_approved")
        if sum(r["density"] for r in run) / len(run) >= 4:
            reasons.append("dialogue")
        if all(r["video"] for r in run):
            reasons.append("video")
        out.append({"start_s": round(run[0]["start"], 1), "end_s": round(run[-1]["end"], 1), "seconds": int(math.ceil(w["seconds"])),
                    "shot_codes": [r["code"] for r in run], "reasons": reasons, "score": round(w["score"], 2),
                    "reason": _reason_text(reasons, len(run))})
    out.sort(key=lambda h: (0 if "hook" in h["reasons"] else 1, h["start_s"]))
    return out[:max_n]


def _reason_text(reasons: list[str], n: int) -> str:
    bits = {"hook": "opens with the hook shot", "approved": "all shots approved", "some_approved": "some shots approved",
            "dialogue": "dialogue-heavy", "video": "every shot has video"}
    parts = [bits[r] for r in reasons if r in bits]
    return (f"{n} shot{'s' if n != 1 else ''}" + (" · " + " · ".join(parts) if parts else ""))
