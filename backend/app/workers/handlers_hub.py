"""Model Hub jobs: catalog sync, character identity (LoRA) training, and registering characters with BytePlus."""
from __future__ import annotations

import re
import shutil
import time
import zipfile

from .. import settings_store
from ..core import identity as identity_core
from ..core import model_hub
from ..db import SessionLocal, utcnow
from ..events import emit
from ..models import Character, CharacterAsset
from ..providers.base import ProviderError, RetryableProviderError
from ..providers.services import provider_mode
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


# ── BytePlus asset library ───────────────────────────────────────────────────

# the character sheet views BytePlus gets, best first (never "source": the library's AI-character groups must not
# show a real person; real people verify themselves in the BytePlus console instead)
REGISTER_KINDS = ["front", "three_quarter", "full_body", "profile", "outfit"]
REGISTER_MAX = 4


def register_images(db, ch: Character) -> list[CharacterAsset]:
    """The approved sheet views, or (like identity training) the whole AI-made sheet while none is approved yet."""
    sheet = (db.query(CharacterAsset).filter(CharacterAsset.character_id == ch.id, CharacterAsset.archived.is_(False),
                                             CharacterAsset.kind.in_(REGISTER_KINDS))
             .order_by(CharacterAsset.id.desc()).all())
    rows = [a for a in sheet if a.approved] or sheet
    rows.sort(key=lambda a: REGISTER_KINDS.index(a.kind))
    out, kinds = [], set()
    for a in rows:  # one image per view first, then more if there is room
        if a.kind not in kinds:
            kinds.add(a.kind)
            out.append(a)
    out += [a for a in rows if a not in out]
    return out[:REGISTER_MAX]


def _library():
    from ..config import get_settings
    from ..providers.byteplus import AssetLibrary
    s = get_settings()
    return AssetLibrary(settings_store.api_key("byteplus_iam"), s.byteplus_region, s.byteplus_project)


def made_from_photo(db, ch: Character) -> bool:
    """The character comes from someone's own photo (a real person): never registered automatically."""
    return db.query(CharacterAsset).filter(CharacterAsset.character_id == ch.id, CharacterAsset.kind == "source",
                                           CharacterAsset.archived.is_(False)).count() > 0


def auto_register_reason(db, ch: Character) -> str:
    """Why this character isn't registered with BytePlus by itself right now ("" = it would be)."""
    from ..config import get_settings
    if not settings_store.get_setting(db, "byteplus_auto_register"):
        return "Automatic registration is off (Settings → AI services)"
    mode = provider_mode("byteplus_iam")
    if mode == "missing":
        return "No BytePlus access key + secret"
    if mode == "live" and get_settings().storage_backend != "s3":
        return "BytePlus fetches images by link, which needs bucket storage"
    if made_from_photo(db, ch):
        return "Made from a photo: a real person verifies themselves in the BytePlus console"
    images = register_images(db, ch)
    if not images:
        return "No character sheet yet"
    reg = (ch.provider_assets or {}).get("byteplus") or {}
    have = {a.get("source_id") for a in reg.get("assets") or [] if a.get("status") in ("Active", "Processing")}
    if all(a.id in have for a in images):
        return "Already registered"
    return ""


def maybe_auto_register(db, user, ch: Character, project_id: int | None = None) -> int | None:
    """Queue a BytePlus registration when the team asked for it to happen by itself (sheet approved, character
    locked). Returns the job id, or None when nothing was queued."""
    from fastapi import HTTPException

    from ..core import generation, jobs
    from ..models import Job, Project
    if auto_register_reason(db, ch):
        return None
    for j in db.query(Job).filter(Job.type == "byteplus_register", Job.status.in_(jobs.ACTIVE)).all():
        if (j.payload or {}).get("character_id") == ch.id:
            return None  # a run that's waiting picks up the newly approved images too
    p = db.get(Project, project_id) if project_id else None
    try:
        out = jobs.submit(db, user, p, [generation.byteplus_register_spec(project_id, ch)], skip_budget=True)
    except HTTPException:
        return None  # e.g. a reviewer approved the image: they can't start jobs, the team can register by hand
    return out["jobs"][0]["id"] if out["jobs"] else None


def byteplus_refresh(db, ch: Character) -> dict:
    """Ask BytePlus for each registered image's status again (accepted, still checking, rejected, deleted)."""
    reg = dict((ch.provider_assets or {}).get("byteplus") or {})
    assets = [dict(a) for a in reg.get("assets") or []]
    if assets and provider_mode("byteplus_iam") == "live":
        lib = _library()
        for a in assets:
            try:
                info = lib.get_asset(a["asset_id"])
            except ProviderError as e:
                if "notfound" not in str(e).lower().replace(".", "").replace(" ", ""):
                    raise
                a["status"], a["error"] = "Missing", "No longer in the BytePlus library"
                continue
            a["status"] = str(info.get("Status") or a.get("status") or "Processing")
            if a["status"] == "Failed":
                a["error"] = str(info.get("FailedReason") or info.get("ErrorMessage") or "rejected by BytePlus review")[:200]
    if assets:
        reg["status"] = ("ready" if any(a["status"] == "Active" for a in assets) else
                         "registering" if any(a["status"] == "Processing" for a in assets) else "failed")
        if reg["status"] == "failed":
            reg["error"] = reg.get("error") or "No image is active in BytePlus any more"
    reg["assets"], reg["checked_at"] = assets, utcnow().isoformat() + "Z"
    pa = dict(ch.provider_assets or {})
    pa["byteplus"] = reg
    ch.provider_assets = pa
    db.commit()
    return reg


def byteplus_remove(db, ch: Character) -> int:
    """Delete the character's images and group from the BytePlus asset library, and forget the registration."""
    reg = (ch.provider_assets or {}).get("byteplus") or {}
    removed = 0
    if provider_mode("byteplus_iam") == "live" and (reg.get("assets") or reg.get("group_id")):
        lib = _library()
        for a in reg.get("assets") or []:
            if a.get("asset_id") and a.get("status") != "Missing":
                lib.delete_asset(a["asset_id"])
                removed += 1
        if reg.get("group_id"):
            lib.delete_group(reg["group_id"])
    else:
        removed = len(reg.get("assets") or [])
    pa = dict(ch.provider_assets or {})
    pa.pop("byteplus", None)
    ch.provider_assets = pa
    db.commit()
    return removed


def _save_reg(ctx: JobContext, cid: int, **values) -> dict:
    with SessionLocal() as db:
        c = db.get(Character, cid)
        pa = dict(c.provider_assets or {})
        reg = {**(pa.get("byteplus") or {}), **values, "updated_at": utcnow().isoformat() + "Z"}
        pa["byteplus"] = reg
        c.provider_assets = pa
        db.commit()
        emit(db, ctx.project_id, "bible.updated", {"character_id": cid})
        return reg


@handler("byteplus_register")
def byteplus_register(ctx: JobContext) -> dict:
    """Register a character's approved sheet images in the BytePlus asset library (one AI-character group per
    character). Seedance then takes them as asset:// references, the sanctioned way to keep an AI character
    consistent without its real-person filter blocking the clip."""
    cid = ctx.payload["character_id"]
    try:
        return _byteplus_register(ctx, cid)
    except Cancelled:
        _save_reg(ctx, cid, status="failed", error="Stopped before it finished")
        raise
    except RetryableProviderError:
        raise  # rate limit / brief error: the worker runs it again and it carries on where it stopped
    except Exception as e:
        _save_reg(ctx, cid, status="failed", error=str(e)[:300])
        raise


def _byteplus_register(ctx: JobContext, cid: int) -> dict:
    from ..config import get_settings
    from ..providers.byteplus import AssetLibrary
    st = get_storage()
    mock = provider_mode("byteplus_iam") == "mock"
    with SessionLocal() as db:
        ch = db.get(Character, cid)
        name = ch.name
        images = [(a.id, a.kind, a.path) for a in register_images(db, ch)]
        reg = dict((ch.provider_assets or {}).get("byteplus") or {})
        qpm = max(1, int(settings_store.get_setting(db, "byteplus_asset_qpm") or 3))
    if not images:
        raise ProviderError("Make this character's sheet (front, three-quarter, full body) first")
    assets = [a for a in reg.get("assets") or [] if a.get("status") in ("Active", "Processing")]
    done = {a.get("source_id") for a in assets}
    _save_reg(ctx, cid, status="registering", job_id=ctx.job_id, error="", assets=assets)
    s = get_settings()
    lib = None if mock else AssetLibrary(settings_store.api_key("byteplus_iam"), s.byteplus_region, s.byteplus_project)
    group = reg.get("group_id") or ""
    if not group:
        ctx.progress(0.05, "Creating the character's group in BytePlus")
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "character"
        group = f"mock-group-{cid}" if mock else lib.ensure_group(f"tatvam-{cid}-{slug}", f"Tatvam AI Studio character: {name}")
        _save_reg(ctx, cid, group_id=group)
    todo = [im for im in images if im[0] not in done]
    for i, (aid, kind, path) in enumerate(todo):
        ctx.check_cancel()
        ctx.progress(0.1 + 0.5 * i / max(len(todo), 1), f"Uploading {kind.replace('_', ' ')} view ({i + 1}/{len(todo)})")
        if i:  # the library allows only a few uploads a minute on the Entry tier
            wait_until = time.time() + 60.0 / qpm
            while time.time() < wait_until and not mock:
                ctx.check_cancel()
                time.sleep(1)
        if mock:
            asset_id, status = f"asset-mock-{cid}-{aid}", "Active"
        else:
            url = st.public_url(st.abs(path))
            if not url:
                raise ProviderError("BytePlus downloads the images by link, which needs bucket storage "
                                    "(STORAGE_BACKEND=s3 with the R2 settings)")
            asset_id, status = lib.create_asset(group, url, f"{name} {kind.replace('_', ' ')}"), "Processing"
        assets.append({"asset_id": asset_id, "source_id": aid, "path": path, "kind": kind, "status": status, "error": ""})
        _save_reg(ctx, cid, assets=assets)
    deadline = time.time() + 900
    while any(a["status"] == "Processing" for a in assets):
        ctx.check_cancel()
        if time.time() > deadline:
            raise RetryableProviderError("BytePlus is still checking the images; trying again shortly", provider="byteplus")
        ready = sum(a["status"] != "Processing" for a in assets)
        ctx.progress(0.65 + 0.3 * ready / len(assets), f"BytePlus is checking the images ({ready}/{len(assets)} done)")
        time.sleep(5)
        for a in assets:
            if a["status"] == "Processing":
                info = lib.get_asset(a["asset_id"])
                a["status"] = str(info.get("Status") or "Processing")
                if a["status"] == "Failed":
                    a["error"] = str(info.get("FailedReason") or info.get("ErrorMessage") or info.get("Error") or
                                     "rejected by BytePlus review")[:200]
        _save_reg(ctx, cid, assets=assets)
    active = [a for a in assets if a["status"] == "Active"]
    failed = [a for a in assets if a["status"] == "Failed"]
    if not active:
        reg = _save_reg(ctx, cid, status="failed", error="; ".join(a["error"] for a in failed)[:300] or "No image was accepted")
        raise ProviderError(f"BytePlus accepted none of {name}'s images: {reg['error']}", provider="byteplus")
    _save_reg(ctx, cid, status="ready", error=f"{len(failed)} image(s) rejected" if failed else "",
              registered_at=utcnow().isoformat() + "Z")
    return {"character_id": cid, "group_id": group, "active": len(active), "failed": len(failed)}


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
