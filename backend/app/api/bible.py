"""Bible: characters (+ sheets, outfits, expressions, voices), locations, styles. Shared library across projects."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import catalog
from ..core import generation, jobs, studio
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


@router.patch("/characters/{cid}")
def patch_character(cid: int, body: CharacterPatch, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    c = get_or_404(db, Character, cid)
    _check_unlocked(c, user)
    for k, v in body.model_dump(exclude_unset=True).items():
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


@router.post("/characters/{cid}/sheet")
def gen_sheet(cid: int, body: SheetIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    c = get_or_404(db, Character, cid)
    p = db.get(Project, body.project_id) if body.project_id else None
    return jobs.submit(db, user, p, [generation.character_sheet_spec(db, body.project_id, c, body.kinds)])


class OutfitIn(BaseModel):
    name: str
    description: str
    episode_scope: int | None = None
    project_id: int | None = None


@router.post("/characters/{cid}/outfits")
def gen_outfit(cid: int, body: OutfitIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    c = get_or_404(db, Character, cid)
    p = db.get(Project, body.project_id) if body.project_id else None
    return jobs.submit(db, user, p, [generation.outfit_spec(db, body.project_id, c, body.name, body.description, body.episode_scope)])


@router.post("/characters/{cid}/expressions")
def gen_expressions(cid: int, body: SheetIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    c = get_or_404(db, Character, cid)
    p = db.get(Project, body.project_id) if body.project_id else None
    return jobs.submit(db, user, p, [generation.expressions_spec(db, body.project_id, c)])


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
