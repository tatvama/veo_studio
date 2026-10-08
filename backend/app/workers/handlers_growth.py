"""Growth jobs: marketing pack (copy + thumbnails), sound design, semantic search index, publishing, analytics."""
from __future__ import annotations

import json

from .. import settings_store
from ..agents import prompts
from ..agents import schemas as S
from ..core import studio, youtube
from ..db import SessionLocal, utcnow
from ..events import emit
from ..models import (Character, Episode, Export, Integration, PostMetric, Project, Scene, SearchItem, Shot, Take)
from ..pipeline import ffmpeg as ff
from ..storage import get_storage
from .handlers import _user, gen_image
from .worker import JobContext, handler


@handler("marketing")
def marketing(ctx: JobContext) -> dict:
    st = get_storage()
    p = ctx.payload
    with SessionLocal() as db:
        ep = db.get(Episode, ctx.episode_id)
        project = db.get(Project, ep.project_id)
        user = _user(db, ctx)
        langs = p.get("languages") or project.languages or [project.primary_language]
        platforms = p.get("platforms") or (["youtube"] if project.aspect == "16:9" else ["youtube_shorts", "instagram_reels"])
        pack = studio.marketing_copy(db, user, ep, platforms, langs)
        aspect = "16:9" if project.aspect == "16:9" else "9:16"
        style = project.brief.get("tone", "") if project.brief else ""
        kf = (db.query(Take).join(Shot, Shot.id == Take.shot_id)
              .filter(Shot.episode_id == ep.id, Take.kind == "keyframe", Take.selected.is_(True)).order_by(Shot.order).first())
        ref = st.abs(kf.path) if kf and st.exists(kf.path) else None
        db.commit()
    files = []
    for i, th in enumerate(pack.get("thumbnails", [])[:3]):
        ctx.progress(0.4 + 0.2 * i, f"Thumbnail {i + 1}")
        prompt = (f"YouTube thumbnail, {aspect}. {th['image_prompt']}. Big bold readable text overlay: \"{th['overlay_text']}\". "
                  f"High contrast, expressive face, clean composition, {style}. Keep characters identical to the reference image.")
        res, engine = gen_image(ctx, prompt, [ref] if ref else [], aspect, title="thumbnail")
        rel = st.save_bytes(st.new_path(f"projects/{ctx.project_id}/marketing", res.ext), res.data)
        ctx.cost(res.usage)
        files.append({"path": rel, "url": st.url(rel), "overlay_text": th["overlay_text"], "concept": th["concept"]})
    with SessionLocal() as db:
        ep = db.get(Episode, ctx.episode_id)
        ep.marketing = {**(ep.marketing or {}), "thumbnail_files": files}
        db.commit()
        emit(db, ctx.project_id, "episode.updated", {"episode_id": ctx.episode_id, "what": "marketing"})
    return {"copies": len(pack.get("copies", [])), "thumbnails": len(files)}


@handler("sfx")
def sfx(ctx: JobContext) -> dict:
    """Sound design: plan ambience/spot effects per shot, generate them, store per shot for the mix."""
    st = get_storage()
    with SessionLocal() as db:
        ep = db.get(Episode, ctx.episode_id)
        project = db.get(Project, ep.project_id)
        shots = db.query(Shot).filter(Shot.episode_id == ep.id, Shot.include.is_(True)).order_by(Shot.order).all()
        if ctx.payload.get("shot_ids"):
            shots = [s for s in shots if s.id in ctx.payload["shot_ids"]]
        listing = "\n".join(f"{s.code} ({s.duration_s}s): {s.action}; written sfx: {s.sfx}" for s in shots)
        plan, usage = ctx.services.llm_json("sfx_plan", prompts.SOUND_DESIGNER,
                                            f"Concept: {project.concept}\nSHOTS:\n{listing}", S.SfxPlanOut,
                                            mock_ctx={"codes": [s.code for s in shots]})
        ctx.cost(usage, db)
        by_code = {s.code: s for s in shots}
        cues = [(by_code[c.shot_code], c) for c in plan.cues if c.shot_code in by_code]
        db.commit()
    made = 0
    for i, (shot, cue) in enumerate(cues):
        ctx.check_cancel()
        ctx.progress(i / max(len(cues), 1), f"SFX {shot.code}")
        res = ctx.services.sound_effect(cue.prompt, min(max(cue.duration, 1.0), float(shot.duration_s)))
        rel = st.save_bytes(st.new_path(f"projects/{ctx.project_id}/sfx", res.ext), res.data)
        with SessionLocal() as db:
            s = db.get(Shot, shot.id)
            s.sfx_track = {"path": rel, "prompt": cue.prompt, "start": cue.start, "volume_db": cue.volume_db}
            ctx.cost(res.usage, db)
            db.commit()
        made += 1
    emit(None, ctx.project_id, "episode.updated", {"episode_id": ctx.episode_id, "what": "sfx"})
    return {"cues": made}


@handler("search_index")
def search_index(ctx: JobContext) -> dict:
    """(Re)index a project's shots, takes, characters and exports for semantic search ("Ravi near the lamp at night")."""
    with SessionLocal() as db:
        pid = ctx.project_id
        project = db.get(Project, pid)
        names = {c.id: c.name for c in studio.cast(db, project)}
        rows: list[tuple[str, int, str, str]] = []
        eps = db.query(Episode).filter(Episode.project_id == pid).all()
        for ep in eps:
            for s in db.query(Shot).filter(Shot.episode_id == ep.id).all():
                chars = ", ".join(names.get(int(c), "") for c in (s.characters or []))
                lines = " ".join(l.get("line", "") for ls in (s.dialogue or {}).values() for l in ls)
                text = f"{s.code} {s.framing}. {s.action}. Characters: {chars}. {lines} {s.sfx} {s.music_cue}"
                cur = (db.query(Take).filter(Take.shot_id == s.id, Take.selected.is_(True), Take.kind.in_(("keyframe", "video")))
                       .order_by(Take.kind).first())
                thumb = (cur.thumb_path or (cur.path if cur.kind == "keyframe" else "")) if cur else ""
                rows.append(("shot", s.id, f"shot {text}", thumb))
                for t in db.query(Take).filter(Take.shot_id == s.id, Take.archived.is_(False),
                                               Take.kind.in_(("keyframe", "video", "lipsync"))).all():
                    rows.append(("take", t.id, f"{t.kind} of {text} engine {t.params.get('engine_label', t.model)} "
                                               f"{(t.qc or {}).get('notes', '')}", t.thumb_path or (t.path if t.kind == "keyframe" else "")))
            script = ep.script or {}
            if script.get("scenes"):
                body = " ".join(f"{sc.get('title', '')}. {sc.get('summary', '')}" for sc in script["scenes"])
                rows.append(("episode", ep.id, f"episode {ep.number} {ep.title}. {script.get('logline', '')} {body}", ""))
            for sc in db.query(Scene).filter(Scene.episode_id == ep.id).all():
                rows.append(("scene", sc.id, f"scene {sc.title}. {sc.summary} {sc.goal} {sc.conflict} {sc.emotion} "
                                             f"{sc.blocking} {' '.join(sc.coverage or [])}", ""))
        for c in studio.cast(db, project):
            rows.append(("character", c.id, f"{c.name} {c.role}. {c.dna_text} {c.personality}", ""))
        for loc in studio.locations(db, project):
            rows.append(("location", loc.id, f"location {loc.name}. {loc.description_text}", ""))
        for x in db.query(Export).filter(Export.project_id == pid, Export.status == "ready").all():
            rows.append(("export", x.id, f"{x.kind} render episode {x.episode_id} {x.language} {x.preset}", x.thumbnail_path))
        db.query(SearchItem).filter(SearchItem.project_id == pid).delete()
        db.commit()
    vectors, model = ctx.services.embed([r[2] for r in rows])
    with SessionLocal() as db:
        for (etype, eid, text, thumb), vec in zip(rows, vectors):
            db.add(SearchItem(entity_type=etype, entity_id=eid, project_id=pid, text=text[:4000], thumb_path=thumb or "",
                              vector=vec, model=model))
        db.commit()
    return {"indexed": len(rows), "model": model}


@handler("publish_youtube")
def publish_youtube(ctx: JobContext) -> dict:
    st = get_storage()
    p = ctx.payload
    with SessionLocal() as db:
        ex = db.get(Export, p["export_id"])
        integ = db.get(Integration, p["integration_id"])
        if not ex or ex.status != "ready" or not integ:
            raise ValueError("Export not ready or channel not connected")
        ep = db.get(Episode, ex.episode_id)
        copy = next((c for c in (ep.marketing or {}).get("copies", [])
                     if c.get("language") == ex.language and "youtube" in c.get("platform", "")), None)
        title = p.get("title") or (copy["titles"][0] if copy else ep.title or "New video")
        desc = p.get("description") or (copy["description"] if copy else "")
        tags = p.get("tags") or [h.lstrip("#") for h in (copy or {}).get("hashtags", [])]
        if ex.ai_disclosure and "AI" not in desc:
            desc += "\n\nMade with AI (synthetic media)."
        if ex.preset in ("shorts", "reels") and "#shorts" not in desc.lower():
            desc += "\n#Shorts"
        video = st.abs(ex.path)
        thumb_rel = (ep.settings or {}).get("marketing_thumbnail") if p.get("use_thumbnail", True) else None
        thumb = st.abs(thumb_rel) if thumb_rel and st.exists(thumb_rel) else None
        db.commit()
    ctx.progress(0.2, "Uploading to YouTube")
    publish_at = p.get("publish_at")
    if publish_at and not str(publish_at).endswith("Z") and "+" not in str(publish_at):
        publish_at = f"{publish_at}Z"
    with SessionLocal() as db:
        res = youtube.upload(db, db.get(Integration, p["integration_id"]), video, title, desc, tags,
                             privacy=p.get("privacy", "unlisted"), synthetic=True, publish_at=publish_at, thumbnail=thumb)
        ex = db.get(Export, p["export_id"])
        ex.published = {**(ex.published or {}), "youtube": {**res, "status": "scheduled" if publish_at else "uploaded",
                                                             "title": title, "integration_id": p["integration_id"],
                                                             "at": utcnow().isoformat() + "Z"}}
        db.commit()
        emit(db, ctx.project_id, "export.updated", {"export_id": ex.id, "status": ex.status, "published": "youtube"})
    return res


@handler("fetch_metrics")
def fetch_metrics(ctx: JobContext) -> dict:
    """Pull YouTube analytics for published renders → retention feeds the hook engine."""
    n, errors = 0, []
    with SessionLocal() as db:
        channels = {i.id: i for i in db.query(Integration).filter(Integration.provider == "youtube").all()}
        if not channels:
            return {"skipped": "no YouTube channel connected"}
        fallback = next(iter(channels.values()))
        q = db.query(Export).filter(Export.status == "ready")
        if ctx.project_id:
            q = q.filter(Export.project_id == ctx.project_id)
        for ex in q.all():
            yt = (ex.published or {}).get("youtube")
            if not yt or not yt.get("video_id"):
                continue
            integ = channels.get(yt.get("integration_id")) or fallback  # uploads made before the id was stored
            try:
                m = youtube.metrics(db, integ, yt["video_id"])
            except Exception as e:  # one deleted or private video must not stop the rest
                errors.append(f"{yt['video_id']}: {str(e)[:120]}")
                continue
            ep = db.get(Episode, ex.episode_id)
            hook = (ep.hooks or [])[ep.selected_hook]["text"] if ep and ep.selected_hook is not None and ep.hooks else ""
            db.add(PostMetric(export_id=ex.id, platform="youtube", video_id=yt["video_id"], views=m["views"], likes=m["likes"],
                              avg_view_pct=m["avg_view_pct"], retention=m["retention"], hook_text=hook))
            ex.published = {**ex.published, "youtube": {**yt, "metrics": {
                "views": m["views"], "likes": m["likes"], "avg_view_pct": m["avg_view_pct"], "at": utcnow().isoformat() + "Z"}}}
            n += 1
        db.commit()
        if n:
            emit(db, ctx.project_id, "export.updated", {"metrics": n})
    return {"videos": n, "errors": errors[:20]}
