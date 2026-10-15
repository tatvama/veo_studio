"""Bible: characters (+ sheets, outfits, expressions, voices), locations, styles. Shared library across projects."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import catalog
from ..core import generation, jobs, sheet_engine, studio
from ..db import get_db
from ..events import emit
from ..models import (Character, CharacterAsset, Consent, Location, LocationAsset, Project, ProjectCast, ProjectLocation, Style,
                      User, VoiceProfile, role_rank)
from ..providers.services import Services, provider_mode
from ..security import current_user, require
from ..storage import get_storage
from .common import character_out, get_or_404, location_out

router = APIRouter(prefix="/api", tags=["bible"])
IMG_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}


def _check_unlocked(row, user: User) -> None:
    if getattr(row, "locked", False) and role_rank(user.role) < role_rank("producer"):
        raise HTTPException(403, "This item is locked. Ask a producer to unlock it.")


# ── characters ───────────────────────────────────────────────────────────────

@router.get("/characters")
def list_characters(project_id: int | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if project_id:
        p = get_or_404(db, Project, project_id)
        return [character_out(db, c) for c in studio.cast(db, p)]
    rows = db.query(Character).filter(Character.archived.is_(False), Character.shared.is_(True)).order_by(Character.name).all()
    return [character_out(db, c, brief=True) for c in rows]


class CharacterIn(BaseModel):
    name: str
    role: str = ""
    gender: str = ""
    age: str = ""
    dna_text: str = ""
    personality: str = ""
    voice_description: str = ""
    name_pronunciation: str = ""
    performance_notes: str = ""
    project_id: int | None = None


@router.post("/characters")
def create_character(body: CharacterIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    data = body.model_dump()
    pid = data.pop("project_id")
    c = Character(**data, created_by=user.id)
    if not c.dna_text:
        c.dna_text = f"{c.name}: "
    db.add(c)
    db.flush()
    if pid:
        studio.link_character(db, get_or_404(db, Project, pid), c)
    db.commit()
    emit(db, pid, "bible.updated", {"character_id": c.id})
    return character_out(db, c)


@router.get("/characters/{cid}")
def get_character(cid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return character_out(db, get_or_404(db, Character, cid))


class CharacterPatch(BaseModel):
    name: str | None = None
    role: str | None = None
    gender: str | None = None
    age: str | None = None
    dna_text: str | None = None
    personality: str | None = None
    voice_description: str | None = None
    shared: bool | None = None
    archived: bool | None = None
    lock: dict | None = None
    name_pronunciation: str | None = None
    performance_notes: str | None = None
    sheet_engine: str | None = None  # the image engine for this character's reference pack; "auto" = the team chain


@router.patch("/characters/{cid}")
def patch_character(cid: int, body: CharacterPatch, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    c = get_or_404(db, Character, cid)
    _check_unlocked(c, user)
    data = body.model_dump(exclude_unset=True)
    if "sheet_engine" in data:  # checked against the Model Hub's image engines, then remembered
        sheet_engine.resolve(db, c, data.pop("sheet_engine") or "auto")
    for k, v in data.items():
        setattr(c, k, v)
    db.commit()
    emit(db, None, "bible.updated", {"character_id": c.id})
    return character_out(db, c)


class LockIn(BaseModel):
    locked: bool


@router.post("/characters/{cid}/lock")
def lock_character(cid: int, body: LockIn, user: User = Depends(require("producer")), db: Session = Depends(get_db)):
    c = get_or_404(db, Character, cid)
    if c.locked and not body.locked:
        c.version += 1  # unlocking to change makes a new version; old takes keep their refs
    c.locked = body.locked
    from ..core.audit import audit
    audit(db, user, "character.lock" if body.locked else "character.unlock", c.name, {"version": c.version}, commit=False)
    db.commit()
    if c.locked:  # a locked AI character becomes Seedance-ready by itself when the team asked for that
        from ..workers.handlers_hub import maybe_auto_register
        maybe_auto_register(db, user, c)
    emit(db, None, "bible.updated", {"character_id": c.id, "locked": c.locked})
    return character_out(db, c)


@router.post("/projects/{pid}/cast/{cid}")
def add_to_cast(pid: int, cid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    p, c = get_or_404(db, Project, pid), get_or_404(db, Character, cid)
    studio.link_character(db, p, c)
    db.commit()
    emit(db, pid, "bible.updated", {"character_id": cid})
    return {"ok": True}


@router.delete("/projects/{pid}/cast/{cid}")
def remove_from_cast(pid: int, cid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    row = db.get(ProjectCast, {"project_id": pid, "character_id": cid})
    if row:
        db.delete(row)
        db.commit()
    emit(db, pid, "bible.updated", {"character_id": cid})
    return {"ok": True}


class SheetIn(BaseModel):
    kinds: list[str] | None = None
    project_id: int | None = None
    # the image engine (a Model Hub image engine id, e.g. "byteplus:seedream-5.0-pro"), remembered on the character for
    # its next sheets, expressions, lighting and outfits; "auto" = the team's image chain; left out = the last pick
    engine: str | None = None


@router.post("/characters/{cid}/sheet")
def gen_sheet(cid: int, body: SheetIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    c = get_or_404(db, Character, cid)
    p = db.get(Project, body.project_id) if body.project_id else None
    engine = sheet_engine.resolve(db, c, body.engine)
    return jobs.submit(db, user, p, [generation.character_sheet_spec(db, body.project_id, c, body.kinds, engine)])


class BoardGenIn(BaseModel):
    project_id: int | None = None
    engine: str | None = None  # an engine that makes a whole board in one request; default: the first one available
    panels: list[str] | None = None  # "front" … "back", "expression:happy", "outfit:front"; default: views + expressions
    outfit_name: str = ""  # with a description: the outfit's mini turnaround is on the board too
    outfit_description: str = ""
    fill_missing: bool = True  # images BytePlus doesn't return are made one by one on the same engine


@router.get("/characters/{cid}/sheet/board")
def board_options(cid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """What a whole board in one request can hold for this character: the panels, the engines that can make it, and
    how many images one request takes (references count toward the engine's limit)."""
    from ..core import model_hub
    from ..workers.handlers import _char_ref
    from ..workers.handlers_board import default_board_engine, panel_keys
    c = get_or_404(db, Character, cid)
    refs = 1 if _char_ref(db, c) else 0
    engines = [{"id": m.id, "display_name": m.display_name, "provider": m.provider,
                "provider_mode": provider_mode(m.provider), "price_usd": round(model_hub.price_for(m), 4),
                "max_images": max(0, min(model_hub.group_max(m), 15) - refs)}
               for m in sheet_engine.image_engines(db) if model_hub.group_max(m) > 0]
    d = default_board_engine(db)
    return {"engines": engines, "default_engine": d.id if d else None, "references": refs,
            "panels": panel_keys(outfit=True), "default_panels": panel_keys(outfit=False)}


@router.post("/characters/{cid}/sheet/board")
def gen_board(cid: int, body: BoardGenIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """A whole character board in ONE request (BytePlus Seedream group generation): turnaround, expressions and an
    outfit, each image saved as its view."""
    from ..core import model_hub
    from ..workers.handlers import _char_ref
    from ..workers.handlers_board import default_board_engine, panel_keys, valid_key
    c = get_or_404(db, Character, cid)
    _check_unlocked(c, user)
    m = sheet_engine.check(db, body.engine) if body.engine else default_board_engine(db)
    if m is None:
        raise HTTPException(400, "No engine here makes a whole board in one request. Switch on Seedream 5.0 Lite "
                                 "(BytePlus) in the Model Hub and add the BytePlus API key.")
    if model_hub.group_max(m) <= 0:
        raise HTTPException(400, f"{m.display_name} makes one image per request. Pick Seedream 5.0 Lite (BytePlus) for a "
                                 "board in one go (BytePlus doesn't offer it on Seedream 5.0 Pro yet).")
    outfit = None
    if body.outfit_name.strip() or body.outfit_description.strip():
        if not (body.outfit_name.strip() and body.outfit_description.strip()):
            raise HTTPException(400, "Give the outfit a name and a description")
        outfit = {"name": body.outfit_name.strip()[:120], "description": body.outfit_description.strip()[:600]}
    panels = list(dict.fromkeys(body.panels or panel_keys(outfit=bool(outfit))))
    bad = [k for k in panels if not valid_key(k)]
    if bad:
        raise HTTPException(400, f"Unknown panel(s): {', '.join(bad[:5])}")
    if any(k.startswith("outfit:") for k in panels) and not outfit:
        raise HTTPException(400, "Outfit panels need the outfit's name and description")
    refs = 1 if _char_ref(db, c) else 0
    room = min(model_hub.group_max(m), 15) - refs
    if not panels or len(panels) > room:
        raise HTTPException(400, f"One request makes at most {room} images here (references count toward BytePlus's limit "
                                 f"of 15): pick {room} panels or fewer")
    p = db.get(Project, body.project_id) if body.project_id else None
    return jobs.submit(db, user, p, [generation.sheet_board_spec(db, body.project_id, c, m, panels, outfit,
                                                                 body.fill_missing)])


class OutfitIn(BaseModel):
    name: str
    description: str
    episode_scope: int | None = None
    project_id: int | None = None
    views: list[str] | None = None  # default: front, three_quarter, full_body (a mini turnaround per outfit)
    engine: str | None = None  # as SheetIn.engine


@router.post("/characters/{cid}/outfits")
def gen_outfit(cid: int, body: OutfitIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    c = get_or_404(db, Character, cid)
    p = db.get(Project, body.project_id) if body.project_id else None
    from ..models import Costume
    row = db.query(Costume).filter(Costume.character_id == c.id, Costume.name == body.name.strip(), Costume.archived.is_(False)).first()
    if row is None:
        db.add(Costume(character_id=c.id, name=body.name.strip(), description=body.description,
                       episode_from=body.episode_scope, episode_to=body.episode_scope))
        db.commit()
    engine = sheet_engine.resolve(db, c, body.engine)
    return jobs.submit(db, user, p, [generation.outfit_spec(db, body.project_id, c, body.name, body.description, body.episode_scope,
                                                            body.views, engine)])


class LightingIn(BaseModel):
    project_id: int | None = None
    variants: list[str] | None = None  # day | dusk | night_interior
    engine: str | None = None  # as SheetIn.engine


@router.post("/characters/{cid}/lighting")
def gen_lighting(cid: int, body: LightingIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    c = get_or_404(db, Character, cid)
    p = db.get(Project, body.project_id) if body.project_id else None
    engine = sheet_engine.resolve(db, c, body.engine)
    return jobs.submit(db, user, p, [generation.lighting_spec(db, body.project_id, c, body.variants, engine)])


@router.post("/characters/{cid}/expressions")
def gen_expressions(cid: int, body: SheetIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    c = get_or_404(db, Character, cid)
    p = db.get(Project, body.project_id) if body.project_id else None
    engine = sheet_engine.resolve(db, c, body.engine)
    return jobs.submit(db, user, p, [generation.expressions_spec(db, body.project_id, c, engine)])


@router.post("/characters/{cid}/upload")
async def upload_character_photo(cid: int, file: UploadFile = File(...), label: str = Form(""),
                                 user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """The user's own photo of the character. Approved uploads are the first look reference everywhere."""
    c = get_or_404(db, Character, cid)
    _check_unlocked(c, user)
    ext = IMG_TYPES.get(file.content_type or "")
    if not ext:
        raise HTTPException(400, "Upload a PNG, JPG or WEBP image")
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(400, "Image too large (max 15 MB)")
    st = get_storage()
    rel = st.save_bytes(st.new_path(f"characters/{cid}", ext), data)
    a = CharacterAsset(character_id=cid, kind="source", label=(label.strip() or "your photo")[:80], path=rel, approved=True)
    db.add(a)
    db.commit()
    emit(db, None, "bible.updated", {"character_id": cid})
    return character_out(db, c)


@router.post("/characters/{cid}/board")
async def upload_board(cid: int, file: UploadFile = File(...), label: str = Form(""), project_id: int | None = Form(None),
                       user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Split a character board: one image with many views (turnaround, expressions, outfits). It is kept as the
    character's own picture (never used whole as a reference), its panels are found, and a small vision job labels them
    for you to review before anything is saved as a view."""
    from ..core import char_board
    c = get_or_404(db, Character, cid)
    _check_unlocked(c, user)
    ext = IMG_TYPES.get(file.content_type or "")
    if not ext:
        raise HTTPException(400, "Upload a PNG, JPG or WEBP image")
    data = await file.read()
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(400, "Image too large (max 25 MB)")
    a = char_board.add_board(db, c, data, ext, label)
    out = _label_board(db, user, c, a, project_id, find_boxes=not char_board.board_state(a).get("clean"))
    emit(db, None, "bible.updated", {"character_id": cid})
    return {"asset_id": a.id, "board": char_board.board_state(a), "jobs": out, "character": character_out(db, c)}


def _label_board(db: Session, user: User, c: Character, a: CharacterAsset, project_id: int | None, find_boxes: bool) -> dict:
    """Queue the labelling job. When it can't start (over budget) the panels stay for labelling by hand."""
    from ..core import char_board
    board = char_board.board_state(a)
    p = db.get(Project, project_id) if project_id else None
    try:
        out = jobs.submit(db, user, p, [generation.board_split_spec(db, project_id, c, a.id, len(board.get("panels") or []),
                                                                    find_boxes)])
    except HTTPException as e:
        char_board.set_board_state(db, a, status="ready" if board.get("panels") else "failed", error=str(e.detail)[:300])
        return {"status": "failed", "reason": str(e.detail), "jobs": [], "total_usd": 0}
    char_board.set_board_state(db, a, status="awaiting_approval" if out["status"] == "awaiting_approval" else "labelling",
                               error="")
    return out


class BoxIn(BaseModel):
    x: int
    y: int
    w: int
    h: int
    kind: str = "other"
    name: str = ""  # an expression's or an outfit's name
    view: str = ""  # an outfit panel's angle (front, three_quarter, full_body …)
    description: str = ""
    keep: bool = True


class BoardLabelIn(BaseModel):
    panels: list[BoxIn] | None = None  # the boxes as adjusted in the review (default: the ones found)
    find_boxes: bool = False  # ask the vision model to find the panels again
    project_id: int | None = None


@router.post("/character-assets/{aid}/board/label")
def relabel_board(aid: int, body: BoardLabelIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Label the board's panels (again) with the vision model, e.g. after adjusting the boxes."""
    from ..core import char_board
    a = get_or_404(db, CharacterAsset, aid)
    if not char_board.is_board(a):
        raise HTTPException(400, "That image isn't a character board")
    c = db.get(Character, a.character_id)
    _check_unlocked(c, user)
    if body.panels is not None:
        char_board.set_board_state(db, a, panels=[{**x.model_dump(), "id": i + 1}
                                                  for i, x in enumerate(body.panels[:30]) if x.w >= 16 and x.h >= 16])
    find = body.find_boxes or not char_board.board_state(a).get("panels")
    out = _label_board(db, user, c, a, body.project_id, find_boxes=find)
    emit(db, None, "bible.updated", {"character_id": c.id})
    return {"asset_id": a.id, "board": char_board.board_state(a), "jobs": out}


class BoardSaveIn(BaseModel):
    panels: list[BoxIn]


@router.post("/character-assets/{aid}/board/save")
def save_board_views(aid: int, body: BoardSaveIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Save the reviewed panels as the character's views (each its own image, marked as cut from this board)."""
    from ..core import char_board
    a = get_or_404(db, CharacterAsset, aid)
    c = db.get(Character, a.character_id)
    _check_unlocked(c, user)
    made = char_board.save_views(db, a, [x.model_dump() for x in body.panels])
    db.commit()
    emit(db, None, "bible.updated", {"character_id": c.id})
    return {"saved": [x.id for x in made], "character": character_out(db, c)}


class AssetPatch(BaseModel):
    approved: bool | None = None
    archived: bool | None = None
    kind: str | None = None
    label: str | None = None


@router.patch("/character-assets/{aid}")
def patch_char_asset(aid: int, body: AssetPatch, user: User = Depends(require("reviewer")), db: Session = Depends(get_db)):
    a = get_or_404(db, CharacterAsset, aid)
    _check_unlocked(db.get(Character, a.character_id), user)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(a, k, v)
    db.commit()
    from ..workers.handlers_hub import REGISTER_KINDS, maybe_auto_register
    if body.approved and a.kind in REGISTER_KINDS and not a.archived:  # an approved sheet view: register it by itself
        maybe_auto_register(db, user, db.get(Character, a.character_id))
    emit(db, None, "bible.updated", {"character_id": a.character_id})
    return a.to_dict()


# ── voices ───────────────────────────────────────────────────────────────────

class VoiceDesignIn(BaseModel):
    language: str
    provider: str = "gemini"
    description: str = ""
    project_id: int | None = None


@router.post("/characters/{cid}/voices/design")
def design_voice(cid: int, body: VoiceDesignIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    c = get_or_404(db, Character, cid)
    _check_unlocked(c, user)
    if body.language not in catalog.LANGUAGES or body.provider not in ("gemini", "elevenlabs", "sarvam"):
        raise HTTPException(400, "bad language or provider")
    if provider_mode(body.provider) == "missing":
        raise HTTPException(400, f"No API key for {body.provider}")
    p = db.get(Project, body.project_id) if body.project_id else None
    return jobs.submit(db, user, p, [generation.voice_design_spec(db, body.project_id, c, body.language, body.provider, body.description)])


class VoiceIn(BaseModel):
    language: str
    provider: str
    voice_id: str
    style_prompt: str = ""
    sts_voice_id: str = ""


@router.post("/characters/{cid}/voices")
def set_voice(cid: int, body: VoiceIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    """Pick a voice manually (e.g. a Gemini prebuilt voice name, an ElevenLabs voice id, or a Sarvam speaker)."""
    _check_unlocked(get_or_404(db, Character, cid), user)
    vp = db.query(VoiceProfile).filter(VoiceProfile.character_id == cid, VoiceProfile.language == body.language).first()
    if not vp:
        vp = VoiceProfile(character_id=cid, language=body.language)
        db.add(vp)
    vp.provider, vp.voice_id, vp.style_prompt = body.provider, body.voice_id, body.style_prompt
    vp.voice_name = body.voice_id
    vp.sts_voice_id = body.sts_voice_id or (body.voice_id if body.provider == "elevenlabs" else vp.sts_voice_id)
    db.commit()
    emit(db, None, "bible.updated", {"character_id": cid})
    return vp.to_dict()


AUDIO_TYPES = {"audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
               "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/ogg": "ogg", "audio/webm": "webm",
               "audio/flac": "flac", "audio/x-flac": "flac"}


@router.post("/characters/{cid}/voices/clone")
async def clone_voice(cid: int, request: Request, files: list[UploadFile] = File(...), subject_name: str = Form(...),
                      consent_confirmed: bool = Form(False), consent_scope: str = Form(""), consent_expires_on: str = Form(""),
                      languages: str = Form(""), remove_noise: bool = Form(True), release: UploadFile | None = File(None),
                      user: User = Depends(require("producer")), db: Session = Depends(get_db)):
    """Clone a real voice from 1–5 samples (ElevenLabs instant clone) and make it the character's voice.
    Needs the speaker's consent: it is recorded (with the signed release, if given) and audit-logged."""
    from ..core.audit import audit

    c = get_or_404(db, Character, cid)
    _check_unlocked(c, user)
    if not consent_confirmed or not subject_name.strip():
        raise HTTPException(400, "Confirm you have the speaker's permission and enter their name")
    if not 1 <= len(files) <= 5:
        raise HTTPException(400, "Upload 1 to 5 voice samples")
    if provider_mode("elevenlabs") == "missing":
        raise HTTPException(400, "Voice cloning needs an ElevenLabs API key (Settings → AI services)")
    langs = [l for l in (languages.split(",") if languages else list(catalog.LANGUAGES)) if l in catalog.LANGUAGES]
    if not langs:
        raise HTTPException(400, "Pick at least one language")
    st = get_storage()
    samples: list[tuple[str, bytes, str]] = []
    paths: list[str] = []
    total = 0
    for f in files:
        mime = (f.content_type or "").split(";")[0]
        ext = AUDIO_TYPES.get(mime)
        if not ext:
            raise HTTPException(400, f"{f.filename}: upload MP3, WAV, M4A, OGG, WEBM or FLAC audio")
        data = await f.read()
        total += len(data)
        if len(data) > 25 * 1024 * 1024 or total > 60 * 1024 * 1024:
            raise HTTPException(400, "Samples are too large (max 25 MB each, 60 MB in total)")
        samples.append((f.filename or f"sample.{ext}", data, mime))
        paths.append(st.save_bytes(st.new_path(f"characters/{cid}/voice_samples", ext), data))
    release_rel = ""
    if release is not None and release.filename:
        # a signed release: a PDF or a photo/scan of it, checked by its content (it is personal data, served back later)
        rdata = await release.read()
        if len(rdata) > 15 * 1024 * 1024:
            raise HTTPException(400, "The release file is too large (max 15 MB)")
        rext = ("pdf" if rdata[:5] == b"%PDF-" else "png" if rdata[:8] == b"\x89PNG\r\n\x1a\n"
                else "jpg" if rdata[:3] == b"\xff\xd8\xff" else "webp" if rdata[8:12] == b"WEBP" else "")
        if not rext:
            raise HTTPException(400, "Upload the signed release as a PDF, JPG, PNG or WEBP")
        release_rel = st.save_bytes(st.new_path("consents", rext), rdata)

    if provider_mode("elevenlabs") == "live":
        voice_id = Services().eleven().clone_voice(f"{c.name} (VEO Studio clone)", samples,
                                                   description=f"Cloned voice of {subject_name.strip()} for character {c.name}",
                                                   remove_background_noise=remove_noise)
    else:
        voice_id = f"mock-clone-{cid}-{len(paths)}"

    consent = Consent(kind="voice_replication", subject_name=subject_name.strip()[:160], character_id=cid, file_path=release_rel,
                      scope=consent_scope.strip() or f"Voice of {c.name} in VEO Studio productions", expires_on=consent_expires_on.strip(),
                      recorded_by=user.id)
    db.add(consent)
    for lang in langs:
        vp = db.query(VoiceProfile).filter(VoiceProfile.character_id == cid, VoiceProfile.language == lang).first()
        if not vp:
            vp = VoiceProfile(character_id=cid, language=lang)
            db.add(vp)
        vp.provider, vp.voice_id, vp.voice_name = "elevenlabs", voice_id, f"{c.name} · cloned voice"
        vp.description = f"Cloned from {len(paths)} uploaded sample(s) of {subject_name.strip()}"
        vp.sts_voice_id, vp.sample_path, vp.style_prompt = voice_id, paths[0], ""
    audit(db, user, "voice.clone", c.name, {"character_id": cid, "subject": subject_name.strip(), "samples": len(paths),
                                            "languages": langs, "voice_id": voice_id}, request=request, commit=False)
    db.commit()
    emit(db, None, "bible.updated", {"character_id": cid})
    return character_out(db, c)


class VoicePatch(BaseModel):
    style_prompt: str | None = None
    sts_voice_id: str | None = None
    voice_id: str | None = None


@router.patch("/voices/{vid}")
def patch_voice(vid: int, body: VoicePatch, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    vp = get_or_404(db, VoiceProfile, vid)
    _check_unlocked(db.get(Character, vp.character_id), user)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(vp, k, v)
    db.commit()
    return vp.to_dict()


@router.delete("/voices/{vid}")
def delete_voice(vid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    vp = get_or_404(db, VoiceProfile, vid)
    _check_unlocked(db.get(Character, vp.character_id), user)
    db.delete(vp)
    db.commit()
    return {"ok": True}


class PreviewIn(BaseModel):
    text: str = ""


@router.post("/voices/{vid}/preview")
def preview_voice(vid: int, body: PreviewIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    vp = get_or_404(db, VoiceProfile, vid)
    from ..core.budget import Estimator
    est = Estimator(db)
    cost = float(est.prices["tts_per_1k_chars"].get(vp.provider, 0.05)) * max(len(body.text), 80) / 1000 if est._live(vp.provider) else 0
    return jobs.submit(db, user, None, [jobs.spec("voice_preview", payload={"voice_profile_id": vid, "text": body.text},
                                                  estimate=cost, label="Voice preview")])


@router.get("/voices/library")
def voice_library(provider: str = "gemini", language: str = "en", user: User = Depends(current_user)):
    if provider == "gemini":
        out = [{"id": n, "name": n, "description": d} for n, d in catalog.GEMINI_PREBUILT_VOICES]
        if provider_mode("gemini") == "live":
            try:
                lib = Services().gemini().list_voices(catalog.LANGUAGES.get(language, {}).get("bcp47"))
                out += [{"id": v.get("id"), "name": v.get("display_name"), "description": v.get("description", "")} for v in lib]
            except Exception as e:
                print(f"[voices] library fetch failed: {e}")
        return out
    if provider == "sarvam":
        return [{"id": s, "name": s, "description": g} for g, lst in catalog.SARVAM_SPEAKERS.items() for s in lst]
    if provider == "elevenlabs" and provider_mode("elevenlabs") == "live":
        return [{"id": v["voice_id"], "name": v.get("name"), "description": (v.get("labels") or {}).get("description", "")}
                for v in Services().eleven().list_voices()]
    return []


# ── locations ────────────────────────────────────────────────────────────────

@router.get("/locations")
def list_locations(project_id: int | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if project_id:
        return [location_out(db, l) for l in studio.locations(db, get_or_404(db, Project, project_id))]
    return [location_out(db, l, brief=True) for l in db.query(Location).filter(Location.archived.is_(False)).order_by(Location.name)]


class LocationIn(BaseModel):
    name: str
    description_text: str = ""
    project_id: int | None = None


@router.post("/locations")
def create_location(body: LocationIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    l = Location(name=body.name, description_text=body.description_text or body.name)
    db.add(l)
    db.flush()
    if body.project_id:
        studio.link_location(db, get_or_404(db, Project, body.project_id), l)
    db.commit()
    emit(db, body.project_id, "bible.updated", {"location_id": l.id})
    return location_out(db, l)


class LocationPatch(BaseModel):
    name: str | None = None
    description_text: str | None = None
    locked: bool | None = None
    archived: bool | None = None


@router.patch("/locations/{lid}")
def patch_location(lid: int, body: LocationPatch, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    l = get_or_404(db, Location, lid)
    data = body.model_dump(exclude_unset=True)
    if "locked" in data and role_rank(user.role) < role_rank("producer"):
        raise HTTPException(403, "Only producers can lock/unlock")
    if "locked" not in data:
        _check_unlocked(l, user)
    for k, v in data.items():
        setattr(l, k, v)
    db.commit()
    emit(db, None, "bible.updated", {"location_id": l.id})
    return location_out(db, l)


@router.post("/projects/{pid}/locations/{lid}")
def add_location(pid: int, lid: int, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    studio.link_location(db, get_or_404(db, Project, pid), get_or_404(db, Location, lid))
    db.commit()
    return {"ok": True}


class LocImagesIn(BaseModel):
    kinds: list[str] | None = None
    time_of_day: str = ""
    project_id: int | None = None


@router.post("/locations/{lid}/images")
def gen_location_images(lid: int, body: LocImagesIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    l = get_or_404(db, Location, lid)
    p = db.get(Project, body.project_id) if body.project_id else None
    return jobs.submit(db, user, p, [generation.location_images_spec(db, body.project_id, l, body.kinds, body.time_of_day)])


@router.post("/locations/{lid}/upload")
async def upload_location_photo(lid: int, file: UploadFile = File(...), user: User = Depends(require("creator")),
                                db: Session = Depends(get_db)):
    l = get_or_404(db, Location, lid)
    ext = IMG_TYPES.get(file.content_type or "")
    if not ext:
        raise HTTPException(400, "Upload a PNG, JPG or WEBP image")
    st = get_storage()
    rel = st.save_bytes(st.new_path(f"locations/{lid}", ext), await file.read())
    db.add(LocationAsset(location_id=lid, kind="source", label="uploaded photo", path=rel, approved=True))
    db.commit()
    return location_out(db, l)


@router.patch("/location-assets/{aid}")
def patch_loc_asset(aid: int, body: AssetPatch, user: User = Depends(require("reviewer")), db: Session = Depends(get_db)):
    a = get_or_404(db, LocationAsset, aid)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(a, k, v)
    db.commit()
    return a.to_dict()


# ── styles ───────────────────────────────────────────────────────────────────

@router.get("/styles")
def list_styles(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return {"styles": [s.to_dict() for s in db.query(Style).order_by(Style.id.desc()).all()], "presets": catalog.STYLE_PRESETS}


class StyleIn(BaseModel):
    name: str
    look: str = ""
    lens: str = ""
    grade: str = ""
    grain: str = ""
    avoid_list: str = ""
    notes: str = ""
    project_id: int | None = None


@router.post("/styles")
def create_style(body: StyleIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    data = body.model_dump()
    pid = data.pop("project_id")
    s = Style(**data)
    db.add(s)
    db.flush()
    if pid:
        get_or_404(db, Project, pid).style_id = s.id
    db.commit()
    emit(db, pid, "project.updated", {"what": "style"})
    return s.to_dict()


class StylePatch(BaseModel):
    name: str | None = None
    look: str | None = None
    lens: str | None = None
    grade: str | None = None
    grain: str | None = None
    avoid_list: str | None = None
    notes: str | None = None
    locked: bool | None = None


@router.patch("/styles/{sid}")
def patch_style(sid: int, body: StylePatch, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    s = get_or_404(db, Style, sid)
    data = body.model_dump(exclude_unset=True)
    if "locked" in data and role_rank(user.role) < role_rank("producer"):
        raise HTTPException(403, "Only producers can lock/unlock")
    if "locked" not in data:
        _check_unlocked(s, user)
    for k, v in data.items():
        setattr(s, k, v)
    db.commit()
    return s.to_dict()
