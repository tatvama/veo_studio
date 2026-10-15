"""Character board jobs.

* board_split: label the panels of an uploaded character board with a vision model, after finding them with it when the
  layout wasn't clean enough to cut on gutters (core/char_board.py has the upload and the save).
* sheet_board: a whole character board (turnaround, expressions, an outfit) in ONE request to BytePlus Seedream (group
  generation), each image saved as its view; images BytePlus didn't return are made one by one on the same engine.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..agents import prompts
from ..agents import schemas as S
from ..core import char_board, credit, jobs as jobs_core, model_hub, ratelimit
from ..db import SessionLocal
from ..events import emit
from ..models import AIModel, Character, CharacterAsset
from ..pipeline import board_split
from ..providers.base import (ProviderBlocked, ProviderError, ProviderNotConfigured, ProviderOutOfCredit,
                              RetryableProviderError)
from ..storage import get_storage
from .handlers import EXPRESSIONS, SHEET_VIEWS, _char_ref, _save_char_asset, _sheet_prompt, _style_of, gen_image
from .worker import GROUP_OF, Cancelled, JobContext, handler

GROUP_OF.setdefault("board_split", "llm")
GROUP_OF.setdefault("sheet_board", "image")
jobs_core.JOB_LABELS.setdefault("board_split", "Split a character board")
jobs_core.JOB_LABELS.setdefault("sheet_board", "Full board in one go")

CROP_SIDE = 640  # crops go to the vision model at most this big (cheap, and plenty to tell a profile from a back)


# ── split an uploaded board ──────────────────────────────────────────────────

def _save_board(ctx: JobContext, aid: int, **values: Any) -> None:
    with SessionLocal() as db:
        a = db.get(CharacterAsset, aid)
        if a is not None:
            char_board.set_board_state(db, a, **values)
            emit(db, ctx.project_id, "bible.updated", {"character_id": a.character_id, "asset_id": aid})


@handler("board_split")
def board_split_job(ctx: JobContext) -> dict:
    aid = int(ctx.payload["asset_id"])
    try:
        return _board_split(ctx, aid)
    except (Cancelled, RetryableProviderError):
        raise  # stopped, or a brief error the worker retries: the panels found so far stay as they are
    except Exception as e:
        _save_board(ctx, aid, status="failed", error=str(e)[:300])  # the user can still label the panels by hand
        raise


def _board_split(ctx: JobContext, aid: int) -> dict:
    st = get_storage()
    with SessionLocal() as db:
        a = db.get(CharacterAsset, aid)
        if not char_board.is_board(a) or a.archived or not st.exists(a.path):
            return {"skipped": "the board is gone"}
        board = char_board.board_state(a)
        ch = db.get(Character, a.character_id)
        who = f"{ch.name}: {ch.dna_text[:400]}" if ch else ""
        data = st.abs(a.path).read_bytes()
    img = board_split.load(data)
    W, H = img.size
    panels = [board_split.clamp(p, W, H) for p in board.get("panels") or []]
    panels = [p for p in panels if p]
    usages = []
    method = board.get("method") or ""
    if ctx.payload.get("find_boxes") or not panels:
        ctx.progress(0.1, "Finding the pictures on the board")
        preview = board_split.to_bytes(board_split.crop(img, {"x": 0, "y": 0, "w": W, "h": H}, max_side=1536))
        obj, usage = ctx.services.llm_json("board_boxes", prompts.BOARD_BOXES, f"The board is {W}x{H} pixels.",
                                           S.BoardBoxesOut, images=[preview], mock_ctx={})
        usages.append(usage)
        panels = board_split.from_fractions(obj.panels, W, H) or [{"x": 0, "y": 0, "w": W, "h": H}]
        method = "vision"
    ctx.progress(0.5, f"Labelling {len(panels)} views")
    crops = [board_split.to_bytes(board_split.crop(img, p, max_side=CROP_SIDE)) for p in panels]
    prompt = (f"{len(crops)} pictures cut out of one character board, numbered 1 to {len(crops)} in the order given."
              + (f"\nThe character: {who}" if who else ""))
    obj, usage = ctx.services.llm_json("board_labels", prompts.BOARD_LABELS, prompt, S.BoardLabelsOut, images=crops,
                                       mock_ctx={"n": len(crops)})
    usages.append(usage)
    labelled = char_board.label_panels(panels, obj.panels)
    with SessionLocal() as db:
        for u in usages:
            ctx.cost(u, db)
        db.commit()
    _save_board(ctx, aid, status="ready", panels=labelled, method=method, error="")
    kinds: dict[str, int] = {}
    for p in labelled:
        kinds[p["kind"]] = kinds.get(p["kind"], 0) + 1
    return {"asset_id": aid, "panels": len(labelled), "kinds": kinds, "method": method}


# ── a whole board in one request (BytePlus Seedream group generation) ───────

VIEW_KEYS = list(SHEET_VIEWS)
EXPRESSION_KEYS = {e.split(",")[0].strip(): e for e in EXPRESSIONS}  # "happy" → "happy, warm smile"
OUTFIT_VIEWS = ["front", "three_quarter", "full_body"]
BOARD_ASPECT = "2:3"  # one size for every image of the set: portraits and full-body views both fit


def panel_keys(outfit: bool = False) -> list[str]:
    """The default board: the turnaround, the five expressions and, with an outfit, its mini turnaround."""
    return [*VIEW_KEYS, *(f"expression:{k}" for k in EXPRESSION_KEYS), *((f"outfit:{v}" for v in OUTFIT_VIEWS) if outfit else ())]


def valid_key(key: str) -> bool:
    kind, _, rest = key.partition(":")
    return (key in SHEET_VIEWS or (kind == "expression" and rest in EXPRESSION_KEYS)
            or (kind == "outfit" and rest in SHEET_VIEWS))


def panel_info(key: str, outfit: dict | None = None) -> dict[str, str]:
    """What one panel is: its asset kind/view/label and the line that describes it in the prompt."""
    kind, _, rest = key.partition(":")
    if kind == "expression":
        return {"kind": "expression", "view": "", "label": rest, "outfit": "",
                "text": f"Head-and-shoulders portrait with a {EXPRESSION_KEYS[rest]} expression"}
    if kind == "outfit":
        name = (outfit or {}).get("name") or "outfit"
        return {"kind": "outfit", "view": rest, "label": f"outfit: {name} ({rest.replace('_', ' ')})", "outfit": name,
                "text": f"{SHEET_VIEWS[rest][0]}, now wearing the outfit \"{name}\": {(outfit or {}).get('description', '')}"}
    return {"kind": key, "view": "", "label": key.replace("_", " "), "outfit": "", "text": SHEET_VIEWS[key][0]}


def board_prompt(ch: Character, style, infos: list[dict[str, str]], has_ref: bool) -> str:
    look = style.look if style else "photorealistic cinematic"
    items = "\n".join(f"{i}. {p['text'].rstrip('.')}." for i, p in enumerate(infos, 1))
    same = ("the same person as the reference image in every image: identical face, hair, skin tone, age and build"
            if has_ref else "the same person in every image: identical face, hair, skin tone, age and build")
    return (f"Character reference board for an AI film: {len(infos)} separate images of one character, one image per "
            f"item below, in exactly this order.\n{items}\n"
            f"It is {same}, wearing the main outfit unless an item names another one. {ch.dna_text}\n"
            "Every image: one pose of the single person (no collage, no panels, no split screen), plain neutral "
            f"light-grey studio background, soft even lighting, face clearly visible and sharp. Rendering style: {look}. "
            "No text, no labels, no watermark.")


@handler("sheet_board")
def sheet_board(ctx: JobContext) -> dict:
    p = ctx.payload
    cid = int(p["character_id"])
    outfit = p.get("outfit") or None
    keys = [k for k in (p.get("panels") or panel_keys(bool(outfit))) if valid_key(k) and (outfit or not k.startswith("outfit:"))]
    with SessionLocal() as db:
        ch = db.get(Character, cid)
        style = _style_of(db, p.get("project_id"))
        ref = _char_ref(db, ch)
        m = db.get(AIModel, p.get("engine") or "")
        name = ch.name
        db.commit()
    if model_hub.group_max(m) <= 0:
        raise ProviderError(f"{m.display_name if m else p.get('engine')} can't make a board in one request")
    refs: list[Path] = [ref] if ref else []
    done: dict[str, int] = dict(ctx.result.get("board_saved") or {})  # panel → asset id (a resumed run never pays twice)
    errors: dict[str, str] = dict(ctx.result.get("board_errors") or {})
    todo = [k for k in keys if k not in done]
    infos = {k: panel_info(k, outfit) for k in keys}
    from_group = int(ctx.result.get("from_group") or 0)
    if todo and not ctx.result.get("group_called"):
        mode = model_hub.provider_mode(m.provider)
        if mode == "missing":
            raise ProviderNotConfigured(f"No {m.provider} API key for {m.display_name}", provider=m.provider)
        with SessionLocal() as db:
            held = credit.held(db, m.provider)
        if held:
            raise ProviderOutOfCredit(f"{m.display_name}: {held}", provider=m.provider)
        short = credit.short_of(m.provider, model_hub.price_for(m) * len(todo)) if mode == "live" else ""
        if short:
            raise ProviderOutOfCredit(short, provider=m.provider)
        hold = ratelimit.cooling(m.provider)
        if hold:
            err = RetryableProviderError(f"{m.provider} is rate limited; trying again in {int(hold)}s", status=429,
                                         provider=m.provider, retry_after=hold)
            err.cooled = True
            raise err
        ctx.progress(0.1, f"{name}: {len(todo)} images in one request ({m.display_name})")
        prompt = board_prompt(ch, style, [infos[k] for k in todo], bool(refs))
        try:
            outs, usage = ctx.services.seedream_group(m, prompt, refs, BOARD_ASPECT, len(todo),
                                                      labels=[infos[k]["label"] for k in todo])
        except RetryableProviderError as e:
            if e.rate_limited:
                e.retry_after = ratelimit.cool(m.provider, e.retry_after)
                e.cooled = True
            raise
        ctx.save_result(group_called=True)  # paid for: a retry after this point never asks for the set again
        made = sum(1 for r, _ in outs if r is not None)
        share = round(usage.usd / made, 5) if made else 0.0
        with SessionLocal() as db:
            ctx.cost(usage, db)
            db.commit()
        model_hub.record_outcome(m.id, made > 0)
        for i, key in enumerate(todo):
            res, err = outs[i] if i < len(outs) else (None, "not returned in the set")
            if res is None:
                errors[key] = err
                continue
            res.usage.usd = share
            info = infos[key]
            with SessionLocal() as db:
                a = _save_char_asset(db, ctx, db.get(Character, cid), info["kind"], res, prompt, label=info["label"],
                                     outfit=info["outfit"], view=info["view"], engine=m.id, book=False)
                a.meta = {**(a.meta or {}), "board_panel": key, "one_request": True}
                db.commit()
                done[key] = a.id
            errors.pop(key, None)
            from_group += 1
            ctx.save_result(board_saved=done, board_errors=errors, from_group=from_group)
        ctx.save_result(board_saved=done, board_errors=errors, from_group=from_group)
    missing = [k for k in keys if k not in done]
    filled = 0
    if missing and p.get("fill_missing", True):
        # what BytePlus didn't return is made one by one on the same engine (within the same estimate: each image is
        # billed alike); an image refused again stays missing
        for i, key in enumerate(missing):
            ctx.check_cancel()
            info = infos[key]
            ctx.progress(0.6 + 0.35 * i / len(missing), f"{name}: {info['label']} (one by one)")
            prompt1 = _sheet_prompt(ch, info["text"], style, bool(refs))
            try:
                res, used = gen_image(ctx, prompt1, refs, SHEET_VIEWS.get(info["view"] or info["kind"], ("", "3:4"))[1],
                                      title=f"{name} · {info['label']}", explicit=m.id, only=True)
            except (ProviderBlocked, ProviderNotConfigured, ProviderOutOfCredit) as e:
                errors[key] = str(e)[:300]
                continue
            except ProviderError as e:
                if isinstance(e, RetryableProviderError) or str(e) == "cancelled":
                    raise
                errors[key] = str(e)[:300]
                continue
            with SessionLocal() as db:
                a = _save_char_asset(db, ctx, db.get(Character, cid), info["kind"], res, prompt1, label=info["label"],
                                     outfit=info["outfit"], view=info["view"], engine=used)
                a.meta = {**(a.meta or {}), "board_panel": key, "one_request": False}
                db.commit()
                done[key] = a.id
            errors.pop(key, None)
            filled += 1
            ctx.save_result(board_saved=done, board_errors=errors)
    missing = [k for k in keys if k not in done]
    if not done:
        raise ProviderError(f"{m.display_name} made none of the {len(keys)} images: "
                            f"{'; '.join(sorted(set(errors.values())))[:300] or 'nothing came back'}", provider=m.provider)
    with SessionLocal() as db:
        emit(db, ctx.project_id, "bible.updated", {"character_id": cid})
        if outfit and outfit.get("name"):
            from ..models import Costume
            if not db.query(Costume).filter(Costume.character_id == cid, Costume.name == outfit["name"],
                                            Costume.archived.is_(False)).first():
                db.add(Costume(character_id=cid, name=outfit["name"], description=outfit.get("description", "")))
                db.commit()
    ctx.progress(1.0, f"{len(done)} of {len(keys)} images" + (f" ({len(missing)} missing)" if missing else ""))
    return {"assets": [done[k] for k in keys if k in done], "from_one_request": from_group, "made_one_by_one": filled,
            "missing": missing, "errors": {k: errors[k] for k in missing if k in errors}}


def default_board_engine(db) -> AIModel | None:
    """The first BytePlus engine that makes a whole board in one request and can run now."""
    from ..core import sheet_engine
    rows = [m for m in sheet_engine.image_engines(db) if model_hub.group_max(m) > 0]
    rows.sort(key=lambda m: (model_hub.provider_mode(m.provider) != "live", model_hub.price_for(m), m.id))
    return rows[0] if rows else None

