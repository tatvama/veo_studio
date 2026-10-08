"""Campaign orchestrator: lock the brand facts, dub every extra language, cut the shorter durations, then render
every language × aspect variant through the existing export job. Progress and results live in episode.settings["campaign"]."""
from __future__ import annotations

from typing import Any

from ..core import campaign as campaign_core, generation, studio
from ..db import SessionLocal, utcnow
from ..events import emit
from ..models import Episode, Job, Project
from .handlers import _user
from .worker import Cancelled, JobContext, handler


def _save(ctx: JobContext, patch: dict[str, Any]) -> dict[str, Any]:
    """Merge into episode.settings["campaign"] and tell the UI."""
    with SessionLocal() as db:
        ep = db.get(Episode, ctx.episode_id)
        st = {**((ep.settings or {}).get(campaign_core.SETTINGS_KEY) or {}), **patch}
        ep.settings = {**(ep.settings or {}), campaign_core.SETTINGS_KEY: st}
        db.commit()
        emit(db, ctx.project_id, "episode.updated", {"episode_id": ctx.episode_id, "what": "campaign"})
        return st


@handler("campaign")
def campaign(ctx: JobContext) -> dict:
    p = ctx.payload
    now = utcnow().isoformat() + "Z"
    with SessionLocal() as db:
        ep = db.get(Episode, ctx.episode_id)
        project = db.get(Project, ep.project_id)
        user = _user(db, ctx)
        primary = project.primary_language
        full = campaign_core.episode_length(db, ep)
        cfg = campaign_core.normalize(project, full, _Body(p))
        # (a) lock the brand facts: a snapshot nothing downstream may change or invent
        facts = campaign_core.brand_facts(db, cfg["brand_kit_id"], cfg["cta"])
        if facts["brand_kit_id"] and project.brand_kit_id != facts["brand_kit_id"]:
            project.brand_kit_id = facts["brand_kit_id"]  # the renderer draws the end card from the project's kit
        for lang in cfg["languages"]:
            if lang not in (project.languages or []):
                project.languages = [*(project.languages or []), lang]
        variants = campaign_core.variant_grid(cfg, full)
        dub_langs = [l for l in cfg["languages"] if l != primary and (cfg["redub"] or campaign_core.needs_dub(db, project, ep, l))]
        dub_est = {l: generation.dub_spec(db, project, ep, l)["estimate"] for l in dub_langs}
        db.commit()
    _save(ctx, {"status": "running", "job_id": ctx.job_id, "brand_facts": facts, "brief": cfg["brief"], "languages": cfg["languages"],
                "aspects": cfg["aspects"], "durations": cfg["durations"], "captions": cfg["captions"], "variants": variants,
                "cuts": {}, "started_at": now, "finished_at": None, "failed": 0, "error": ""})
    try:
        # (b) dub every extra language (nested orchestrators run side by side)
        bad_langs: set[str] = set()
        if dub_langs:
            ctx.progress(0.05, f"Dubbing into {', '.join(dub_langs)}")
            kids = {l: ctx.enqueue_child("dub", {"language": l, "then_export": None, "campaign": ctx.job_id},
                                         estimate=dub_est.get(l, 0.0), label=f"Dub E{ep.number:02} → {l}") for l in dub_langs}
            st = ctx.wait_children(list(kids.values()), "Dubs")
            bad_langs = {l for l, jid in kids.items() if st.get(jid) != "succeeded"}
            if bad_langs:
                variants = [{**v, "status": "failed", "error": "dub failed"} if v["language"] in bad_langs else v for v in variants]
                _save(ctx, {"variants": variants})
        # (c) shorter durations: cut-down episodes made from the shots (and the dubbed takes) we already have
        cuts: dict[str, int] = {}
        for d in cfg["durations"]:
            ctx.check_cancel()
            ctx.progress(0.3, f"Cutting a {d}s version")
            try:
                with SessionLocal() as db:
                    ep_row = db.get(Episode, ctx.episode_id)
                    ids = studio.make_cutdowns(db, _user(db, ctx) or user, ep_row, 1, int(d))
                    if ids:
                        cut = db.get(Episode, ids[0])
                        cut.title = (cut.title or f"Cut {d}s")[:160] + f" · {d}s"
                        cut.settings = {**(cut.settings or {}), "campaign_of": ctx.episode_id, "campaign_duration": d}
                        db.commit()
                        cuts[str(d)] = ids[0]
            except Cancelled:
                raise
            except Exception as e:  # one bad cut must not stop the full-length variants
                variants = [{**v, "status": "failed", "error": f"cut-down failed: {str(e)[:160]}"} if v["cut"] and v["duration"] == d else v
                            for v in variants]
        _save(ctx, {"cuts": cuts, "variants": variants})
        # (d) one export per variant
        ctx.progress(0.35, "Rendering variants")
        opts = {"captions": cfg["captions"], "music": True, "auto_reframe": True, "brand_kit_id": facts["brand_kit_id"], "end_card": True,
                "cta": facts["cta"], "publish": cfg["publish"], "campaign": ctx.job_id}
        jobs_of: dict[int, int] = {}
        for i, v in enumerate(variants):
            if v["status"] == "failed":
                continue
            target = ctx.episode_id if not v["cut"] else cuts.get(str(v["duration"]))
            if not target:
                variants[i] = {**v, "status": "failed", "error": "no cut-down for this duration"}
                continue
            payload = {"language": v["language"], "preset": v["preset"], "options": opts,
                       "variant": {"aspect": v["aspect"], "duration": v["duration"], "cut": v["cut"]}}
            jid = ctx.enqueue_child("export", payload, episode_id=target, label=f"Export {v['aspect']} [{v['language']}]"
                                    + (f" {v['duration']}s" if v["cut"] else ""))
            jobs_of[i] = jid
            variants[i] = {**v, "status": "queued", "job_id": jid, "episode_id": target}
        _save(ctx, {"variants": variants})
        st = ctx.wait_children(list(jobs_of.values()), "Variants") if jobs_of else {}
        with SessionLocal() as db:
            for i, jid in jobs_of.items():
                j = db.get(Job, jid)
                xid = (j.result or {}).get("export_id") if j else None
                ok = st.get(jid) == "succeeded"
                variants[i] = {**variants[i], "status": "ready" if ok else "failed", "export_id": xid,
                               "error": "" if ok else ((j.error or "")[:200] if j else "")}
        # (e) record
        failed = sum(1 for v in variants if v["status"] != "ready")
        status = "done" if not failed else ("failed" if failed == len(variants) else "partial")
        _save(ctx, {"status": status, "variants": variants, "failed": failed, "finished_at": utcnow().isoformat() + "Z"})
        return {"variants": len(variants), "ready": len(variants) - failed, "failed": failed, "dubbed": [l for l in dub_langs if l not in bad_langs],
                "cuts": cuts}
    except Cancelled:
        _save(ctx, {"status": "cancelled", "finished_at": utcnow().isoformat() + "Z"})
        raise
    except Exception as e:
        _save(ctx, {"status": "failed", "error": str(e)[:300], "finished_at": utcnow().isoformat() + "Z"})
        raise


class _Body:
    """Lets core.campaign.normalize read a job payload like a request body."""

    def __init__(self, d: dict[str, Any]):
        self.__dict__.update(d)
