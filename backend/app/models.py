"""Database tables. Hierarchy: Project → Episode → Scene → Shot → Take."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, inspect
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base, utcnow

ROLES = ["viewer", "reviewer", "creator", "producer", "admin"]


def role_rank(role: str) -> int:
    return ROLES.index(role) if role in ROLES else 0


class Serializable:
    """Turns a row into a JSON-friendly dict (datetimes → ISO with Z)."""

    _hidden: tuple[str, ...] = ()

    def to_dict(self, **extra: Any) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for attr in inspect(self).mapper.column_attrs:
            if attr.key in self._hidden:
                continue
            v = getattr(self, attr.key)
            if isinstance(v, datetime):
                v = v.isoformat() + "Z"
            out[attr.key] = v
        out.update(extra)
        return out


# ── People & settings ────────────────────────────────────────────────────────

class User(Base, Serializable):
    __tablename__ = "users"
    _hidden = ("password_hash",)
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    role: Mapped[str] = mapped_column(String(20), default="creator")
    monthly_limit_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    session_version: Mapped[int] = mapped_column(Integer, default=1)
    prefs: Mapped[Any] = mapped_column(JSON, default=dict)  # ui language, theme, onboarding
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AppSetting(Base, Serializable):
    __tablename__ = "app_settings"
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, default=dict)


class ApiKey(Base, Serializable):
    __tablename__ = "api_keys"
    _hidden = ("encrypted",)
    provider: Mapped[str] = mapped_column(String(40), primary_key=True)
    encrypted: Mapped[str] = mapped_column(Text)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# ── Bible (shared library) ───────────────────────────────────────────────────

class Style(Base, Serializable):
    __tablename__ = "styles"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    look: Mapped[str] = mapped_column(Text, default="")
    lens: Mapped[str] = mapped_column(Text, default="")
    grade: Mapped[str] = mapped_column(Text, default="")
    grain: Mapped[str] = mapped_column(Text, default="")
    avoid_list: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    shared: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Character(Base, Serializable):
    __tablename__ = "characters"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(120), default="")
    gender: Mapped[str] = mapped_column(String(20), default="")
    age: Mapped[str] = mapped_column(String(40), default="")
    dna_text: Mapped[str] = mapped_column(Text, default="")
    personality: Mapped[str] = mapped_column(Text, default="")
    voice_description: Mapped[str] = mapped_column(Text, default="")
    shared: Mapped[bool] = mapped_column(Boolean, default=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    # trained identity: {status, trainer, base_endpoint, lora_url, trigger, scale, images, job_id, trained_at, error}
    identity: Mapped[Any] = mapped_column(JSON, default=dict)
    # face embedding (ArcFace) of the approved front image, for objective face-match QC
    face_embedding: Mapped[Any] = mapped_column(JSON, default=list)
    # Character Lock: structured constraints that steer prompts, reference picking and QC thresholds (core/lock.py)
    # {face, body, skin_hair, voice, costume_continuity, gestures, age, lighting, strictness: 0..1}
    lock: Mapped[Any] = mapped_column(JSON, default=dict)
    # the character registered with outside services, e.g. {"byteplus": {status, group_id, assets: [{asset_id,
    # source_id, path, kind, status, error}], job_id, error, updated_at}} (BytePlus asset library, for Seedance)
    provider_assets: Mapped[Any] = mapped_column(JSON, default=dict)
    # how the name is said, for voices and prompts, e.g. RAH-vee
    name_pronunciation: Mapped[str] = mapped_column(String(120), default="")
    # signature gestures, posture, speaking style (fed into prompts)
    performance_notes: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class CharacterAsset(Base, Serializable):
    __tablename__ = "character_assets"
    id: Mapped[int] = mapped_column(primary_key=True)
    character_id: Mapped[int] = mapped_column(ForeignKey("characters.id"), index=True)
    kind: Mapped[str] = mapped_column(String(40))  # source/front/three_quarter/profile/full_body/expression/outfit
    label: Mapped[str] = mapped_column(String(120), default="")
    outfit: Mapped[str] = mapped_column(String(120), default="")
    episode_scope: Mapped[int | None] = mapped_column(Integer, nullable=True)
    view: Mapped[str] = mapped_column(String(40), default="")  # front/three_quarter/profile/back/full_body (outfit + lighting sets)
    lighting: Mapped[str] = mapped_column(String(40), default="")  # day/dusk/night_interior for lighting variants
    path: Mapped[str] = mapped_column(String(500))
    prompt: Mapped[str] = mapped_column(Text, default="")
    approved: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class CharacterVersion(Base, Serializable):
    """A frozen look of a character (DNA, voice, lock, reference pack) for a range of episodes, so a character can
    age, change hairstyle or grow a beard in season 2 while season 1 keeps the old look."""
    __tablename__ = "character_versions"
    id: Mapped[int] = mapped_column(primary_key=True)
    character_id: Mapped[int] = mapped_column(ForeignKey("characters.id"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    label: Mapped[str] = mapped_column(String(160), default="")  # e.g. Season 2: older, grey beard
    episode_from: Mapped[int | None] = mapped_column(Integer, nullable=True)  # inclusive episode numbers; None = open
    episode_to: Mapped[int | None] = mapped_column(Integer, nullable=True)
    dna_text: Mapped[str] = mapped_column(Text, default="")
    voice_description: Mapped[str] = mapped_column(Text, default="")
    lock: Mapped[Any] = mapped_column(JSON, default=dict)
    asset_ids: Mapped[Any] = mapped_column(JSON, default=list)  # the approved reference pack at that time
    identity: Mapped[Any] = mapped_column(JSON, default=dict)  # trained identity snapshot (lora_url, trigger)
    note: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Costume(Base, Serializable):
    """A named outfit of a character. Its reference images are CharacterAssets with kind=outfit and the same name."""
    __tablename__ = "costumes"
    id: Mapped[int] = mapped_column(primary_key=True)
    character_id: Mapped[int] = mapped_column(ForeignKey("characters.id"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    episode_from: Mapped[int | None] = mapped_column(Integer, nullable=True)
    episode_to: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Prop(Base, Serializable):
    """A reusable object (lamp, sword, phone) with an optional reference image, mentioned in scripts with @."""
    __tablename__ = "props"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text, default="")
    path: Mapped[str] = mapped_column(String(500), default="")  # reference image
    shared: Mapped[bool] = mapped_column(Boolean, default=True)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ProjectProp(Base):
    __tablename__ = "project_props"
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    prop_id: Mapped[int] = mapped_column(ForeignKey("props.id"), primary_key=True)


class VoiceProfile(Base, Serializable):
    __tablename__ = "voice_profiles"
    __table_args__ = (UniqueConstraint("character_id", "language", name="uq_voice_char_lang"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    character_id: Mapped[int] = mapped_column(ForeignKey("characters.id"), index=True)
    language: Mapped[str] = mapped_column(String(8))
    provider: Mapped[str] = mapped_column(String(20), default="gemini")  # gemini | elevenlabs | sarvam
    voice_id: Mapped[str] = mapped_column(String(200), default="")
    voice_name: Mapped[str] = mapped_column(String(120), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    style_prompt: Mapped[str] = mapped_column(Text, default="")
    sample_path: Mapped[str] = mapped_column(String(500), default="")
    sts_voice_id: Mapped[str] = mapped_column(String(200), default="")  # ElevenLabs voice for Voice Lock
    settings: Mapped[Any] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Location(Base, Serializable):
    __tablename__ = "locations"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    description_text: Mapped[str] = mapped_column(Text, default="")
    shared: Mapped[bool] = mapped_column(Boolean, default=True)
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class LocationAsset(Base, Serializable):
    __tablename__ = "location_assets"
    id: Mapped[int] = mapped_column(primary_key=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"), index=True)
    kind: Mapped[str] = mapped_column(String(40))  # wide/medium/detail/source
    label: Mapped[str] = mapped_column(String(120), default="")
    time_of_day: Mapped[str] = mapped_column(String(40), default="")
    path: Mapped[str] = mapped_column(String(500))
    prompt: Mapped[str] = mapped_column(Text, default="")
    approved: Mapped[bool] = mapped_column(Boolean, default=False)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# ── Projects ─────────────────────────────────────────────────────────────────

class Project(Base, Serializable):
    __tablename__ = "projects"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    type: Mapped[str] = mapped_column(String(20), default="short")
    concept: Mapped[str] = mapped_column(Text, default="")
    aspect: Mapped[str] = mapped_column(String(8), default="9:16")
    languages: Mapped[Any] = mapped_column(JSON, default=lambda: ["en"])
    primary_language: Mapped[str] = mapped_column(String(8), default="en")
    quality_mode: Mapped[str] = mapped_column(String(20), default="saver")
    agent_mode: Mapped[str] = mapped_column(String(20), default="copilot")
    # how the project is made: "director" (from an idea), "script" (imported) or "shots" (built shot by shot);
    # the two own-material ways open on a short set of tabs
    workflow: Mapped[str] = mapped_column(String(20), default="director")
    luts: Mapped[Any] = mapped_column(JSON, default=list)  # the team's colour LUTs (.cube): [{id, name, path}]
    pronunciations: Mapped[Any] = mapped_column(JSON, default=dict)  # {term: how to say it}, applied before every voice call
    budget_cap_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    brief: Mapped[Any] = mapped_column(JSON, default=dict)
    story: Mapped[Any] = mapped_column(JSON, default=dict)  # series: logline, arc, episode outlines
    style_id: Mapped[int | None] = mapped_column(ForeignKey("styles.id"), nullable=True)
    brand_kit_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(30), default="draft")
    autopilot: Mapped[Any] = mapped_column(JSON, default=dict)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class ProjectCast(Base):
    __tablename__ = "project_cast"
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    character_id: Mapped[int] = mapped_column(ForeignKey("characters.id"), primary_key=True)


class ProjectLocation(Base):
    __tablename__ = "project_locations"
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"), primary_key=True)


class Season(Base, Serializable):
    __tablename__ = "seasons"
    __table_args__ = (UniqueConstraint("project_id", "number", name="uq_season_project_number"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    number: Mapped[int] = mapped_column(Integer, default=1)
    title: Mapped[str] = mapped_column(String(200), default="")
    arc: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(30), default="draft")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Episode(Base, Serializable):
    __tablename__ = "episodes"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    number: Mapped[int] = mapped_column(Integer, default=1)
    season: Mapped[int] = mapped_column(Integer, default=1)
    kind: Mapped[str] = mapped_column(String(20), default="episode")  # episode | cutdown
    title: Mapped[str] = mapped_column(String(200), default="")
    outline: Mapped[str] = mapped_column(Text, default="")
    hooks: Mapped[Any] = mapped_column(JSON, default=list)
    selected_hook: Mapped[int | None] = mapped_column(Integer, nullable=True)
    script: Mapped[Any] = mapped_column(JSON, default=dict)
    summary_for_next: Mapped[str] = mapped_column(Text, default="")
    settings: Mapped[Any] = mapped_column(JSON, default=dict)  # timeline-wide: music volume, captions, titles…
    layers: Mapped[Any] = mapped_column(JSON, default=dict)  # extra video & audio layers over the shots (pipeline/layers.py)
    critic: Mapped[Any] = mapped_column(JSON, default=dict)  # last script-critic report
    continuity: Mapped[Any] = mapped_column(JSON, default=dict)  # last continuity check report
    table_read: Mapped[Any] = mapped_column(JSON, default=dict)  # {language: {path, duration, lines:[…]}}
    marketing: Mapped[Any] = mapped_column(JSON, default=dict)  # titles, descriptions, hashtags, thumbnails per platform/lang
    status: Mapped[str] = mapped_column(String(30), default="draft")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Scene(Base, Serializable):
    __tablename__ = "scenes"
    id: Mapped[int] = mapped_column(primary_key=True)
    episode_id: Mapped[int] = mapped_column(ForeignKey("episodes.id"), index=True)
    order: Mapped[int] = mapped_column(Integer, default=0)
    title: Mapped[str] = mapped_column(String(200), default="")
    location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id"), nullable=True)
    time_of_day: Mapped[str] = mapped_column(String(40), default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    # scene card (writers' room)
    goal: Mapped[str] = mapped_column(Text, default="")
    conflict: Mapped[str] = mapped_column(Text, default="")
    turn: Mapped[str] = mapped_column(Text, default="")
    emotion: Mapped[str] = mapped_column(String(200), default="")
    characters: Mapped[Any] = mapped_column(JSON, default=list)
    props: Mapped[Any] = mapped_column(JSON, default=list)
    wardrobe: Mapped[Any] = mapped_column(JSON, default=dict)  # {character_id: outfit}
    continuity_notes: Mapped[str] = mapped_column(Text, default="")
    prop_ids: Mapped[Any] = mapped_column(JSON, default=list)  # Prop ids mentioned with @ or picked by hand
    # Continuity Bible: the state of the world at the END of this scene (core/continuity.py)
    # {characters: {id: {outfit, state}}, props: [...], time_of_day, weather, notes, source: ai|manual}
    end_state: Mapped[Any] = mapped_column(JSON, default=dict)
    coverage: Mapped[Any] = mapped_column(JSON, default=list)  # planned shots [{framing, purpose}]
    blocking: Mapped[str] = mapped_column(Text, default="")
    approved: Mapped[bool] = mapped_column(Boolean, default=False)
    # the shot whose keyframe sets the scene's look (set, light, palette, wardrobe); None = the first shot in order
    anchor_shot_id: Mapped[int | None] = mapped_column(Integer, nullable=True)


class Shot(Base, Serializable):
    __tablename__ = "shots"
    id: Mapped[int] = mapped_column(primary_key=True)
    episode_id: Mapped[int] = mapped_column(ForeignKey("episodes.id"), index=True)
    scene_id: Mapped[int | None] = mapped_column(ForeignKey("scenes.id"), nullable=True)
    order: Mapped[int] = mapped_column(Integer, default=0)
    code: Mapped[str] = mapped_column(String(40), default="")
    duration_s: Mapped[int] = mapped_column(Integer, default=8)
    framing: Mapped[str] = mapped_column(String(200), default="")
    camera: Mapped[str] = mapped_column(String(300), default="")
    action: Mapped[str] = mapped_column(Text, default="")
    characters: Mapped[Any] = mapped_column(JSON, default=list)  # character ids
    outfits: Mapped[Any] = mapped_column(JSON, default=dict)  # {character_id: outfit name}
    location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id"), nullable=True)
    dialogue: Mapped[Any] = mapped_column(JSON, default=dict)  # {lang: [{character_id, line, emotion}]}
    narration: Mapped[Any] = mapped_column(JSON, default=dict)  # {lang: text}
    sfx: Mapped[str] = mapped_column(Text, default="")
    music_cue: Mapped[str] = mapped_column(Text, default="")
    mode: Mapped[str] = mapped_column(String(30), default="auto")  # auto/keyframe_to_video/reference_to_video/text_to_video/interpolate/extend
    quality_mode: Mapped[str | None] = mapped_column(String(20), nullable=True)
    engine: Mapped[str] = mapped_column(String(200), default="auto")  # "auto" or an AIModel id
    overlays: Mapped[Any] = mapped_column(JSON, default=list)  # title / lower-third text overlays [{text, start, end, style}]
    sfx_track: Mapped[Any] = mapped_column(JSON, default=dict)  # generated sound effects {path, prompt}
    fx: Mapped[Any] = mapped_column(JSON, default=dict)  # transition in, look, adjustments, speed, moves (pipeline/fx.py)
    voice_mode: Mapped[str] = mapped_column(String(20), default="auto")  # auto/native/voice_lock/audio_first/narration/none
    ref_images: Mapped[Any] = mapped_column(JSON, default=list)  # the user's references for this shot [{path, label}]
    extend_to: Mapped[int] = mapped_column(Integer, default=0)  # target length in seconds via chained extensions (0 = none)
    extend_prompt: Mapped[str] = mapped_column(Text, default="")  # what happens in the extension (default: the action continues)
    continuity_from_prev: Mapped[bool] = mapped_column(Boolean, default=False)
    # explicit shot-to-shot link (Film Map edge): take the last frame of that shot, or extend its video
    continuity_from_shot_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    continuity_mode: Mapped[str] = mapped_column(String(20), default="last_frame")  # last_frame | extend
    prop_ids: Mapped[Any] = mapped_column(JSON, default=list)
    include: Mapped[bool] = mapped_column(Boolean, default=True)
    trim_in: Mapped[float] = mapped_column(Float, default=0.0)
    trim_out: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String(30), default="draft")
    notes: Mapped[str] = mapped_column(Text, default="")
    generating: Mapped[bool] = mapped_column(Boolean, default=False)
    locked_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Take(Base, Serializable):
    __tablename__ = "takes"
    id: Mapped[int] = mapped_column(primary_key=True)
    shot_id: Mapped[int] = mapped_column(ForeignKey("shots.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))  # keyframe/video/voice/narration/voicelock/lipsync
    language: Mapped[str | None] = mapped_column(String(8), nullable=True)
    provider: Mapped[str] = mapped_column(String(40), default="")
    model: Mapped[str] = mapped_column(String(80), default="")
    params: Mapped[Any] = mapped_column(JSON, default=dict)
    prompt: Mapped[str] = mapped_column(Text, default="")
    path: Mapped[str] = mapped_column(String(500), default="")
    thumb_path: Mapped[str] = mapped_column(String(500), default="")
    duration_s: Mapped[float] = mapped_column(Float, default=0.0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    qc: Mapped[Any] = mapped_column(JSON, default=dict)
    selected: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(20), default="ready")
    # change impact (core/dependencies.py): the shot changed after this take was made
    stale: Mapped[bool] = mapped_column(Boolean, default=False)
    stale_reason: Mapped[str] = mapped_column(String(200), default="")
    error: Mapped[str] = mapped_column(Text, default="")
    remote_ref: Mapped[str] = mapped_column(Text, default="")
    interaction_id: Mapped[str] = mapped_column(String(200), default="")
    parent_take_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class AudioAsset(Base, Serializable):
    __tablename__ = "audio_assets"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    episode_id: Mapped[int | None] = mapped_column(ForeignKey("episodes.id"), nullable=True)
    kind: Mapped[str] = mapped_column(String(20), default="music")
    language: Mapped[str | None] = mapped_column(String(8), nullable=True)
    provider: Mapped[str] = mapped_column(String(40), default="")
    model: Mapped[str] = mapped_column(String(80), default="")
    prompt: Mapped[str] = mapped_column(Text, default="")
    path: Mapped[str] = mapped_column(String(500), default="")
    duration_s: Mapped[float] = mapped_column(Float, default=0.0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    selected: Mapped[bool] = mapped_column(Boolean, default=False)
    params: Mapped[Any] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Export(Base, Serializable):
    __tablename__ = "exports"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    episode_id: Mapped[int] = mapped_column(ForeignKey("episodes.id"), index=True)
    language: Mapped[str] = mapped_column(String(8), default="en")
    preset: Mapped[str] = mapped_column(String(20), default="shorts")
    kind: Mapped[str] = mapped_column(String(20), default="final")  # final | animatic
    options: Mapped[Any] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    path: Mapped[str] = mapped_column(String(500), default="")
    srt_path: Mapped[str] = mapped_column(String(500), default="")
    thumbnail_path: Mapped[str] = mapped_column(String(500), default="")
    duration_s: Mapped[float] = mapped_column(Float, default=0.0)
    warnings: Mapped[Any] = mapped_column(JSON, default=list)
    peaks: Mapped[Any] = mapped_column(JSON, default=list)  # audio waveform peaks for the review player
    published: Mapped[Any] = mapped_column(JSON, default=dict)  # {platform: {status, url, video_id, at}}
    ai_disclosure: Mapped[bool] = mapped_column(Boolean, default=True)
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    approved_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# ── Work, money, collaboration ───────────────────────────────────────────────

class Job(Base, Serializable):
    __tablename__ = "jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    type: Mapped[str] = mapped_column(String(40), index=True)
    status: Mapped[str] = mapped_column(String(30), default="queued", index=True)
    # proposed → (confirm) → queued → running → succeeded | failed | cancelled ; awaiting_approval for limit breaches
    project_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    episode_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    shot_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    payload: Mapped[Any] = mapped_column(JSON, default=dict)
    result: Mapped[Any] = mapped_column(JSON, default=dict)
    label: Mapped[str] = mapped_column(String(200), default="")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    message: Mapped[str] = mapped_column(Text, default="")
    cost_estimate: Mapped[float] = mapped_column(Float, default=0.0)
    cost_actual: Mapped[float] = mapped_column(Float, default=0.0)
    batch_id: Mapped[str] = mapped_column(String(40), default="", index=True)
    parent_job_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    error: Mapped[str] = mapped_column(Text, default="")
    requested_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    approved_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    run_after: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Approval(Base, Serializable):
    __tablename__ = "approvals"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    batch_id: Mapped[str] = mapped_column(String(40), index=True)
    requested_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reason: Mapped[str] = mapped_column(Text, default="")
    needs_role: Mapped[str] = mapped_column(String(20), default="producer")
    amount_usd: Mapped[float] = mapped_column(Float, default=0.0)
    summary: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="pending")
    decided_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class CostEntry(Base, Serializable):
    __tablename__ = "cost_ledger"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    project_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    provider: Mapped[str] = mapped_column(String(40), default="")
    model: Mapped[str] = mapped_column(String(80), default="")
    kind: Mapped[str] = mapped_column(String(40), default="")
    units: Mapped[float] = mapped_column(Float, default=0.0)
    unit_type: Mapped[str] = mapped_column(String(20), default="")
    usd: Mapped[float] = mapped_column(Float, default=0.0)
    mock: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class Comment(Base, Serializable):
    __tablename__ = "comments"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(Integer, index=True)
    target_type: Mapped[str] = mapped_column(String(20))  # shot | take | episode | export
    target_id: Mapped[int] = mapped_column(Integer)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    guest_name: Mapped[str] = mapped_column(String(120), default="")  # client comments via review link
    body: Mapped[str] = mapped_column(Text)
    timecode: Mapped[float | None] = mapped_column(Float, nullable=True)  # seconds into the video
    drawing: Mapped[Any] = mapped_column(JSON, default=list)  # frame annotation strokes [{color, points:[[x,y]…]}] in 0–1 coords
    mentions: Mapped[Any] = mapped_column(JSON, default=list)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class AgentMessage(Base, Serializable):
    __tablename__ = "agent_messages"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(Integer, index=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    role: Mapped[str] = mapped_column(String(20))  # user | assistant | tool
    content: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[Any] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Event(Base, Serializable):
    __tablename__ = "events"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    type: Mapped[str] = mapped_column(String(60))
    payload: Mapped[Any] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class Revision(Base, Serializable):
    __tablename__ = "revisions"
    id: Mapped[int] = mapped_column(primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(30), index=True)
    entity_id: Mapped[int] = mapped_column(Integer, index=True)
    data: Mapped[Any] = mapped_column(JSON, default=dict)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# ── Model Hub ────────────────────────────────────────────────────────────────

class AIModel(Base, Serializable):
    """One generation engine (any provider). Synced from catalogs; admins enable/disable and rank them."""
    __tablename__ = "ai_models"
    id: Mapped[str] = mapped_column(String(300), primary_key=True)  # "fal:fal-ai/kling-video/v3/pro/image-to-video"
    provider: Mapped[str] = mapped_column(String(30))  # google | fal | sync | elevenlabs | sarvam
    endpoint: Mapped[str] = mapped_column(String(300))
    family: Mapped[str] = mapped_column(String(160), default="")
    maker: Mapped[str] = mapped_column(String(80), default="")
    display_name: Mapped[str] = mapped_column(String(200), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[str] = mapped_column(String(40), default="")
    task: Mapped[str] = mapped_column(String(20), default="other", index=True)  # video avatar lipsync edit image tts music train other
    capabilities: Mapped[Any] = mapped_column(JSON, default=dict)
    param_map: Mapped[Any] = mapped_column(JSON, default=dict)
    param_overrides: Mapped[Any] = mapped_column(JSON, default=dict)  # admin fixes to the auto mapping / extra fixed args
    price_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    price_unit: Mapped[str] = mapped_column(String(30), default="")  # second | video | image | request | minute | 1k_chars
    price_source: Mapped[str] = mapped_column(String(20), default="")  # live | manual | estimate
    status: Mapped[str] = mapped_column(String(20), default="new", index=True)  # new | enabled | disabled | retired
    tier: Mapped[str] = mapped_column(String(20), default="")  # draft | standard | premium
    rating: Mapped[float | None] = mapped_column(Float, nullable=True)
    wins: Mapped[int] = mapped_column(Integer, default=0)  # shootout wins (take chosen)
    uses: Mapped[int] = mapped_column(Integer, default=0)
    failures: Mapped[int] = mapped_column(Integer, default=0)
    tags: Mapped[Any] = mapped_column(JSON, default=list)
    thumbnail_url: Mapped[str] = mapped_column(Text, default="")
    released_at: Mapped[str] = mapped_column(String(40), default="")
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[str] = mapped_column(Text, default="")
    first_seen: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


# ── Writers' room ────────────────────────────────────────────────────────────

class ScriptVersion(Base, Serializable):
    __tablename__ = "script_versions"
    id: Mapped[int] = mapped_column(primary_key=True)
    episode_id: Mapped[int] = mapped_column(Integer, index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    script: Mapped[Any] = mapped_column(JSON, default=dict)
    note: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(30), default="manual")  # ai | manual | critic | restore
    critic: Mapped[Any] = mapped_column(JSON, default=dict)
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# ── Growth ───────────────────────────────────────────────────────────────────

class BrandKit(Base, Serializable):
    __tablename__ = "brand_kits"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    logo_path: Mapped[str] = mapped_column(String(500), default="")
    colors: Mapped[Any] = mapped_column(JSON, default=list)  # ["#F97316", …]
    fonts: Mapped[Any] = mapped_column(JSON, default=dict)  # {heading, body}
    tagline: Mapped[str] = mapped_column(Text, default="")
    cta: Mapped[str] = mapped_column(Text, default="")
    website: Mapped[str] = mapped_column(String(300), default="")
    product_assets: Mapped[Any] = mapped_column(JSON, default=list)  # [{path, label}]
    voice_tone: Mapped[str] = mapped_column(Text, default="")
    rules: Mapped[str] = mapped_column(Text, default="")  # do / don't
    end_card: Mapped[Any] = mapped_column(JSON, default=dict)  # {enabled, seconds, text}
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# ── Poster Studio ──────────────────────────────────────────────

class Design(Base, Serializable):
    """A poster, thumbnail or social creative: a stack of layers (see api/designs.py for the layer schema).
    The browser renders it (so Indian scripts are shaped correctly) and uploads thumbnails and exports."""
    __tablename__ = "designs"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(200), default="Untitled design")
    format: Mapped[str] = mapped_column(String(40), default="custom")  # preset key, e.g. film_poster, yt_thumb
    width: Mapped[int] = mapped_column(Integer, default=1080)
    height: Mapped[int] = mapped_column(Integer, default=1350)
    # {v: 1, background: {...}, layers: [...]}; image layers keep a storage-relative `asset` and get `src` on read
    doc: Mapped[Any] = mapped_column(JSON, default=dict)
    template: Mapped[str] = mapped_column(String(60), default="")
    brand_kit_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    thumb_path: Mapped[str] = mapped_column(String(500), default="")
    status: Mapped[str] = mapped_column(String(20), default="draft")  # draft | approved
    revision: Mapped[int] = mapped_column(Integer, default=1)  # bumped on every save; guards against overwriting a teammate
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class DesignVersion(Base, Serializable):
    """A named snapshot of a design, to compare or roll back to."""
    __tablename__ = "design_versions"
    id: Mapped[int] = mapped_column(primary_key=True)
    design_id: Mapped[int] = mapped_column(ForeignKey("designs.id"), index=True)
    note: Mapped[str] = mapped_column(String(200), default="")
    doc: Mapped[Any] = mapped_column(JSON, default=dict)
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    thumb_path: Mapped[str] = mapped_column(String(500), default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class DesignExport(Base, Serializable):
    """A finished file made from a design (PNG, JPG, WebP or PDF)."""
    __tablename__ = "design_exports"
    id: Mapped[int] = mapped_column(primary_key=True)
    design_id: Mapped[int] = mapped_column(ForeignKey("designs.id"), index=True)
    project_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(10), default="png")
    path: Mapped[str] = mapped_column(String(500))
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    bytes: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class SearchItem(Base, Serializable):
    """Semantic search index over takes, shots, characters and exports."""
    __tablename__ = "search_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(20), index=True)
    entity_id: Mapped[int] = mapped_column(Integer, index=True)
    project_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    text: Mapped[str] = mapped_column(Text, default="")
    thumb_path: Mapped[str] = mapped_column(String(500), default="")
    vector: Mapped[Any] = mapped_column(JSON, default=list)
    model: Mapped[str] = mapped_column(String(80), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Consent(Base, Serializable):
    __tablename__ = "consents"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(30))  # voice_replication | likeness | music | other
    subject_name: Mapped[str] = mapped_column(String(160))
    character_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    file_path: Mapped[str] = mapped_column(String(500), default="")
    scope: Mapped[str] = mapped_column(Text, default="")
    expires_on: Mapped[str] = mapped_column(String(20), default="")
    recorded_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class AuditEntry(Base, Serializable):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    action: Mapped[str] = mapped_column(String(80), index=True)
    target: Mapped[str] = mapped_column(String(160), default="")
    detail: Mapped[Any] = mapped_column(JSON, default=dict)
    ip: Mapped[str] = mapped_column(String(60), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class Integration(Base, Serializable):
    __tablename__ = "integrations"
    _hidden = ("secrets",)
    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(30))  # youtube | instagram
    account_name: Mapped[str] = mapped_column(String(200), default="")
    account_id: Mapped[str] = mapped_column(String(200), default="")
    secrets: Mapped[str] = mapped_column(Text, default="")  # Fernet-encrypted token JSON
    connected_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class PostMetric(Base, Serializable):
    __tablename__ = "post_metrics"
    id: Mapped[int] = mapped_column(primary_key=True)
    export_id: Mapped[int] = mapped_column(Integer, index=True)
    platform: Mapped[str] = mapped_column(String(30))
    video_id: Mapped[str] = mapped_column(String(200), default="")
    views: Mapped[int] = mapped_column(Integer, default=0)
    likes: Mapped[int] = mapped_column(Integer, default=0)
    avg_view_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    retention: Mapped[Any] = mapped_column(JSON, default=list)  # [[t_ratio, pct]…]
    hook_text: Mapped[str] = mapped_column(Text, default="")
    fetched_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ReviewLink(Base, Serializable):
    """View-only link for clients: watch a render and leave timecoded comments without an account."""
    __tablename__ = "review_links"
    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[int] = mapped_column(Integer, index=True)
    export_id: Mapped[int] = mapped_column(Integer, index=True)
    allow_comments: Mapped[bool] = mapped_column(Boolean, default=True)
    label: Mapped[str] = mapped_column(String(160), default="")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
