"""Poster Studio jobs: AI images for design layers (backgrounds, characters as cut-outs, elements, products, relighting)."""
from __future__ import annotations

import uuid
from pathlib import Path

from ..core import designs as dz
from ..db import SessionLocal
from ..events import emit
from ..models import Character, CharacterAsset, Design
from ..pipeline import faces
from ..storage import get_storage
from .handlers import _char_ref, _style_of, gen_image
from .worker import JobContext, handler


def _outfit_ref(db, ch: Character, outfit: str) -> Path | None:
    """An approved image of the character in the named outfit, so the poster shows the same clothes as the film."""
    if not outfit:
        return None
    st = get_storage()
    q = (db.query(CharacterAsset).filter(CharacterAsset.character_id == ch.id, CharacterAsset.archived.is_(False),
                                         CharacterAsset.kind == "outfit", CharacterAsset.outfit == outfit)
         .order_by(CharacterAsset.approved.desc(), CharacterAsset.id.desc()))
    a = q.first()
    return st.abs(a.path) if a and st.exists(a.path) else None


@handler("design_image")
def design_image(ctx: JobContext) -> dict:
    p = ctx.payload
    st = get_storage()
    kind = p.get("kind", "background")
    with SessionLocal() as db:
        d = db.get(Design, p["design_id"])
        if not d:
            raise ValueError("The design was deleted")
        ch = db.get(Character, p["character_id"]) if p.get("character_id") else None
        refs: list[Path] = []
        if ch:
            base = _char_ref(db, ch)
            refs += [x for x in (base, _outfit_ref(db, ch, p.get("outfit", ""))) if x]
        style = _style_of(db, d.project_id)
        style_txt = p.get("style") or (style.look if style else "")
        embedding = list(ch.face_embedding or []) if ch else []
        name = ch.name if ch else ""
        design_id, project_id = d.id, d.project_id
        # keep only what the prompt builder reads, after the session closes
        char_info = type("C", (), {"name": ch.name, "dna_text": ch.dna_text})() if ch else None
    for a in [p.get("source_asset", ""), *(p.get("ref_assets") or [])]:
        if a and st.exists(a):
            refs.append(st.abs(a))

    cutout = bool(p.get("cutout")) and kind in ("character", "element", "product")
    prompt = dz.prompt_for(kind, p.get("prompt", ""), style=style_txt, character=char_info, outfit=p.get("outfit", ""),
                           pose=p.get("pose", ""), cutout=cutout, has_ref=bool(ch and refs))
    if p.get("variation"):
        prompt += f" Variation {int(p['variation']) + 1}: a distinctly different take."
    ctx.check_cancel()
    ctx.progress(0.1, f"Painting the {kind}" + (f" of {name}" if name else ""))
    res, engine = gen_image(ctx, prompt, refs, p.get("aspect") or "1:1", title=f"Poster {kind}{' · ' + name if name else ''}")
    data, ext = res.data, res.ext
    if cutout:
        ctx.progress(0.85, "Cutting out")
        data, w, h = dz.cutout_green(data)
        ext = "png"
    else:
        w, h = dz.image_size(data)
    rel = st.save_bytes(f"designs/{design_id}/ai/{kind}_{uuid.uuid4().hex[:10]}.{ext}", data)
    ctx.cost(res.usage)

    face_match = None
    if embedding and faces.identity_available():
        try:
            emb = faces.embedding(st.abs(rel))
            face_match = round(faces.similarity(embedding, emb), 3) if emb else None
        except Exception:  # the check is advisory; never fail the image over it
            face_match = None
    out = {"asset": rel, "src": st.url(rel), "width": w, "height": h, "layer_id": p.get("layer_id", ""), "kind": kind,
           "cutout": cutout, "engine": engine, "prompt": prompt, "face_match": face_match, "variation": p.get("variation", 0)}
    ctx.save_result(**out)
    with SessionLocal() as db:
        emit(db, project_id, "design.ai", {"design_id": design_id, "job_id": ctx.job_id, "layer_id": out["layer_id"]})
    return out
