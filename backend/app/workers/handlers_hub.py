"""Model Hub jobs: catalog sync and character identity (LoRA) training."""
from __future__ import annotations

import re
import shutil
import zipfile

from .. import settings_store
from ..core import identity as identity_core
from ..core import model_hub
from ..db import SessionLocal, utcnow
from ..events import emit
from ..models import Character, CharacterAsset
from ..providers.base import ProviderError, RetryableProviderError
from ..storage import get_storage
from .handlers import _save_char_asset, _sheet_prompt, _style_of, gen_image
from .worker import Cancelled, JobContext, handler

VARIATIONS = [
    "Front view portrait, neutral expression, soft daylight", "Three-quarter view, gentle smile, warm indoor light",
    "Side profile, serious expression, window light", "Full body standing, natural pose", "Close-up portrait, laughing",
    "Medium shot sitting, looking slightly away, evening light", "Three-quarter view from slightly above, calm",
    "Close-up, surprised expression, cinematic light", "Medium shot walking, outdoors daylight",
    "Front view, determined expression, dramatic side light", "Over-the-shoulder glance back", "Low angle medium shot, confident",
]


@handler("model_sync")
def model_sync(ctx: JobContext) -> dict:
    ctx.progress(0.1, "Reading the model catalog")
    return model_hub.sync_catalog(full_schemas=bool(ctx.payload.get("full")))


def _trigger(ch: Character) -> str:
    base = re.sub(r"[^a-z]", "", ch.name.lower())[:8] or "char"
    return f"{base}_{ch.id}vs"


def _set_identity(ctx: JobContext, cid: int, **values) -> None:
    with SessionLocal() as db:
        c = db.get(Character, cid)
        c.identity = {**(c.identity or {}), **values}
        db.commit()
        emit(db, ctx.project_id, "bible.updated", {"character_id": cid})


@handler("identity_variations")
def identity_variations(ctx: JobContext) -> dict:
    """AI variations of the user's own photo (other angles, light, expressions) for the training set. They are saved
    unapproved: the user keeps the ones that look like the person, and only those are trained on."""
    cid = ctx.payload["character_id"]
    n = max(1, min(int(ctx.payload.get("count") or 6), len(VARIATIONS)))
    with SessionLocal() as db:
        ch = db.get(Character, cid)
        style = _style_of(db, ctx.payload.get("project_id"))
        own = identity_core.training_set(db, ch)
        base = next((get_storage().abs(a.path) for a in own["assets"] if a.kind == "source"), None)
        start = db.query(CharacterAsset).filter(CharacterAsset.character_id == cid, CharacterAsset.kind == "training").count()
    if not base:
        raise ProviderError("Upload a photo of this person first: variations are made from your photo")
    made = []
    for i in range(n):
        ctx.check_cancel()
        ctx.progress(i / n, f"Variation {i + 1} of {n}")
        view = VARIATIONS[(start + i) % len(VARIATIONS)]
        prompt = _sheet_prompt(ch, view, style, True) + " Same person as the reference photo: identical face, age and features."
        res, _ = gen_image(ctx, prompt, [base], "3:4", title=f"{ch.name} · variation {start + i + 1}")
        with SessionLocal() as db:
            a = _save_char_asset(db, ctx, db.get(Character, cid), "training", res, prompt, label=f"variation {start + i + 1}")
            a.approved = False  # waiting for the user's review
            db.commit()
            made.append(a.id)
    return {"variations": made}


@handler("train_identity")
def train_identity(ctx: JobContext) -> dict:
    """Train a face model (LoRA) so every keyframe keeps the same face. Trains only on the approved training set
    (core/identity.py): never on images the user hasn't seen."""
    cid = ctx.payload["character_id"]
    try:
        return _train_identity(ctx, cid)
    except Cancelled:
        _set_identity(ctx, cid, status="cancelled", error="Stopped before it finished")
        raise
    except RetryableProviderError:
        raise  # the worker queues it again (rate limit / brief error): still in progress, not failed
    except Exception as e:
        _set_identity(ctx, cid, status="failed", error=str(e)[:300])
        raise


def _train_identity(ctx: JobContext, cid: int) -> dict:
    st = get_storage()
    with SessionLocal() as db:
        cfg = {**(settings_store.DEFAULTS["identity_trainer"]), **(settings_store.get_setting(db, "identity_trainer") or {})}
        ch = db.get(Character, cid)
        ts = identity_core.training_set(db, ch)
        imgs = [(st.abs(a.path), "photo" if a.kind == "source" else a.kind) for a in ts["assets"] if st.exists(a.path)]
        trigger = _trigger(ch)
        if len(imgs) < ts["min"]:
            raise ProviderError(f"Needs at least {ts['min']} approved images to learn the face; has {len(imgs)}. "
                                "Upload more photos, or make variations of your photo and approve the good ones.")
        ch.identity = {**(ch.identity or {}), "status": "preparing", "trigger": trigger, "job_id": ctx.job_id, "error": "",
                       "basis": ts["basis"]}
        style = _style_of(db, ctx.payload.get("project_id"))
        db.commit()
        emit(db, ctx.project_id, "bible.updated", {"character_id": cid})
    if ts["auto_fill"]:  # AI-designed character only: fill up with variations of its own sheet
        front = imgs[0][0]
        need = max(int(cfg.get("min_images", 12)) - len(imgs), 0)
        for i in range(min(need, len(VARIATIONS))):
            ctx.check_cancel()
            ctx.progress(0.05 + 0.25 * i / max(need, 1), f"Building training set {len(imgs) + 1}")
            prompt = _sheet_prompt(ch, VARIATIONS[i], style, True)
            res, _ = gen_image(ctx, prompt, [front], "3:4", title=f"{ch.name} · training {i + 1}")
            with SessionLocal() as db:
                a = _save_char_asset(db, ctx, db.get(Character, cid), "training", res, prompt, label=f"training {i + 1}")
                a.approved = True
                db.commit()
                imgs.append((st.abs(a.path), "training"))
    tmp = st.tmp_dir()
    zpath = tmp / f"{trigger}.zip"
    gender = (ch.gender or "person").replace("neutral", "person")
    word = {"male": "man", "female": "woman"}.get(gender, "person")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for i, (p, kind) in enumerate(imgs[:40]):
            z.write(p, f"{i:03}{p.suffix}")
            z.writestr(f"{i:03}.txt", f"{trigger}, a {word}, {kind.replace('_', ' ')} view")
    with SessionLocal() as db:
        c = db.get(Character, cid)
        c.identity = {**(c.identity or {}), "status": "training", "images": len(imgs[:40])}
        db.commit()
        emit(db, ctx.project_id, "bible.updated", {"character_id": cid})
    ctx.progress(0.35, f"Training identity on {len(imgs[:40])} images (10–30 min)")
    lora, usage = ctx.services.train_identity(cfg["trainer"], zpath, trigger, int(cfg.get("steps", 1000)),
                                              on_tick=ctx.tick("Training", 1200),
                                              on_request=lambda rid: ctx.save_result(train_request=rid),
                                              resume=ctx.result.get("train_request"))
    with SessionLocal() as db:
        c = db.get(Character, cid)
        c.identity = {**(c.identity or {}), "status": "ready", "lora_url": lora, "trainer": cfg["trainer"],
                      "inference": cfg["inference"], "scale": float(cfg.get("scale", 1.0)),
                      "trained_at": utcnow().isoformat() + "Z", "error": ""}
        ctx.cost(usage, db)
        db.commit()
    ctx.progress(0.9, "Test portrait with the trained identity")
    try:  # the trained model is paid for and saved: a failed test portrait must not throw it away
        res = ctx.services.lora_image(cfg["inference"], f"{trigger}, a {word}, front view portrait, plain background, {ch.dna_text}",
                                      [{"path": lora, "scale": float(cfg.get("scale", 1.0))}], "3:4", title=f"{ch.name} identity test")
        with SessionLocal() as db:
            _save_char_asset(db, ctx, db.get(Character, cid), "identity_test", res, "identity test", label="identity test")
            emit(db, ctx.project_id, "bible.updated", {"character_id": cid})
    except Exception as e:
        print(f"[identity] test portrait failed for character {cid}: {e}")
        with SessionLocal() as db:
            emit(db, ctx.project_id, "bible.updated", {"character_id": cid})
    shutil.rmtree(tmp, ignore_errors=True)
    return {"lora_url": lora, "images": len(imgs[:40])}
