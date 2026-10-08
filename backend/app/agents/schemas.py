"""Structured-output schemas for every writing task. Gemini is forced to return exactly these shapes."""
from __future__ import annotations

from pydantic import BaseModel, Field


class BriefOut(BaseModel):
    title: str
    format: str = Field(description="series | short | ad | explainer | devotional")
    duration_s: int
    aspect: str = Field(description="9:16 or 16:9 or 1:1")
    audience: str
    tone: str
    platform: str
    key_message: str
    cta: str = ""
    notes: str = ""


class HookScores(BaseModel):
    curiosity: float
    clarity: float
    visual: float
    platform_fit: float


class Hook(BaseModel):
    text: str = Field(description="What is seen/said in the first 1.5–3 seconds")
    type: str = Field(description="question | bold_claim | visual_shock | pattern_break | story | curiosity_gap")
    visual: str = Field(description="The opening image in one sentence")
    scores: HookScores
    total: float


class HooksOut(BaseModel):
    hooks: list[Hook]


class ScriptLine(BaseModel):
    character: str = Field(description="Character name, or NARRATOR for voice-over")
    line: str
    emotion: str = ""


class ScriptScene(BaseModel):
    title: str
    location: str
    time_of_day: str = ""
    summary: str
    action: str = ""
    lines: list[ScriptLine] = []


class ScriptOut(BaseModel):
    logline: str
    beats: list[str]
    scenes: list[ScriptScene]


class EpisodeOutline(BaseModel):
    number: int
    title: str
    outline: str


class SeriesArcOut(BaseModel):
    logline: str
    arc: str
    episodes: list[EpisodeOutline]


class CharacterOut(BaseModel):
    name: str
    role: str
    gender: str = Field(description="male | female | neutral")
    age: str
    dna_text: str = Field(description="60–80 words: name, age, face, skin, hair, eyes, build, signature outfit, marks. Starts with 'Name:'")
    personality: str
    voice_description: str = Field(description="How the voice sounds: age, pitch, texture, pace, accent")


class LocationOut(BaseModel):
    name: str
    description_text: str


class StyleOut(BaseModel):
    name: str
    look: str
    lens: str
    grade: str
    grain: str
    avoid_list: str


class BibleOut(BaseModel):
    characters: list[CharacterOut]
    locations: list[LocationOut]
    style: StyleOut


class ShotOut(BaseModel):
    scene_index: int
    framing: str
    camera: str
    action: str
    characters: list[str] = Field(description="Names of characters visible in the shot")
    location: str
    dialogue: list[ScriptLine] = Field(description="Lines spoken ON SCREEN in this shot. Max one speaking character per shot.")
    narration: str = Field(default="", description="Voice-over text for this shot, if any")
    sfx: str = ""
    music_cue: str = ""
    duration_s: int = Field(description="4, 6 or 8")
    mode: str = Field(default="auto", description="auto (keyframe first) | interpolate (continuous move into the next shot)")


class BreakdownOut(BaseModel):
    shots: list[ShotOut]


class ImportLine(BaseModel):
    speaker: str = Field(description="Character name exactly as written in the script, or VO for voice-over / narration")
    text: str = Field(description="The spoken words copied character-for-character from the script")
    emotion: str = Field(default="", description="Parenthetical or delivery note from the script, if any")


class ImportShot(BaseModel):
    prompt: str = Field(description="The visual description for this shot, copied from the script's own wording")
    characters: list[str] = Field(default=[], description="Names of characters visible in the shot")
    lines: list[ImportLine] = []
    duration_s: int = Field(default=8, description="4, 6 or 8; use the script's timing if it gives one")
    framing: str = ""
    camera: str = ""


class ImportScene(BaseModel):
    title: str
    location: str = ""
    time_of_day: str = ""
    summary: str = ""
    shots: list[ImportShot]


class ImportOut(BaseModel):
    title: str = ""
    scenes: list[ImportScene]


class LocalizedItem(BaseModel):
    key: str
    text: str


class LocalizeOut(BaseModel):
    items: list[LocalizedItem]


class EndStateCharacter(BaseModel):
    name: str
    outfit: str = ""
    state: str = ""


class EndStateOut(BaseModel):
    characters: list[EndStateCharacter] = []
    props: list[str] = []
    time_of_day: str = ""
    weather: str = ""
    notes: str = ""


class DialogueCheckOut(BaseModel):
    heard: str = Field(default="", description="the words you hear, written in the script of the language spoken")
    language: str = Field(default="", description="language actually spoken, e.g. Kannada, Hindi, English, none")
    word_match: float = Field(default=0.0, description="0-1: how much of the expected line was spoken correctly")
    pronunciation: float = Field(default=0.0, description="0-1: how natural a native speaker would find it")
    sync_score: float = Field(default=0.0, description="0-1: mouth shapes and timing match the speech")
    subtitles_burned: bool = Field(default=False, description="any on-screen text or captions in the picture")
    notes: str = ""


class QCOut(BaseModel):
    identity_match: float = Field(description="0–1, does the person look like the reference sheet")
    outfit_match: bool
    extra_people: bool
    text_artifacts: bool
    hand_issues: bool
    matches_action: bool
    notes: str = ""


class SummaryOut(BaseModel):
    summary: str


class Cut(BaseModel):
    title: str
    shot_codes: list[str]


class CutdownOut(BaseModel):
    cuts: list[Cut]


class MusicPromptOut(BaseModel):
    prompt: str


# ── accuracy ─────────────────────────────────────────────────────────────────

class LipsyncQCOut(BaseModel):
    sync_score: float = Field(description="0–1: how well mouth shapes and timing match the speech audio")
    face_visible: bool
    artifacts: bool = Field(description="teeth/mouth blur, jaw warping, double mouth, flicker")
    mismatched_moments: list[str] = []
    notes: str = ""


# ── writers' room ────────────────────────────────────────────────────────────

class SceneCard(BaseModel):
    scene_index: int
    title: str
    goal: str = Field(description="What the main character wants in this scene")
    conflict: str = Field(description="What stands in the way")
    turn: str = Field(description="What changes by the end of the scene")
    emotion: str = Field(description="Dominant emotion / mood")
    characters: list[str]
    location: str
    time_of_day: str
    props: list[str] = []
    wardrobe: list[str] = Field(default=[], description="'Name: outfit' entries that must stay consistent")
    continuity_notes: str = ""
    blocking: str = Field(default="", description="Who stands where, entrances/exits, eyelines")
    coverage: list[str] = Field(default=[], description="Planned shots, e.g. 'wide master', 'OTS Ravi→Meera', 'CU Meera reaction', 'insert: lamp'")


class SceneCardsOut(BaseModel):
    scenes: list[SceneCard]


class CriticScores(BaseModel):
    hook: float
    clarity: float
    pacing: float
    emotion: float
    dialogue: float
    cultural_fit: float
    visual_potential: float


class CriticOut(BaseModel):
    scores: CriticScores
    overall: float = Field(description="0–10")
    strengths: list[str]
    problems: list[str] = Field(description="Specific, fixable problems with scene/line references")
    rewrite_instructions: str = Field(description="Concrete instructions for the writer's next draft")


class ContinuityIssue(BaseModel):
    severity: str = Field(description="high | medium | low")
    where: str = Field(description="Shot code or scene title")
    problem: str
    fix: str


class ContinuityOut(BaseModel):
    ok: bool
    issues: list[ContinuityIssue]


class NativePolishItem(BaseModel):
    key: str
    text: str
    note: str = ""


class NativePolishOut(BaseModel):
    items: list[NativePolishItem]


# ── growth ───────────────────────────────────────────────────────────────────

class PlatformCopy(BaseModel):
    platform: str = Field(description="youtube_shorts | instagram_reels | youtube | facebook | whatsapp_status")
    language: str
    titles: list[str] = Field(description="3 title options, best first")
    description: str
    hashtags: list[str]
    pinned_comment: str = ""


class ThumbnailIdea(BaseModel):
    concept: str
    overlay_text: str = Field(description="2–5 punchy words to put on the thumbnail")
    image_prompt: str


class MarketingOut(BaseModel):
    copies: list[PlatformCopy]
    thumbnails: list[ThumbnailIdea]
    posting_tips: list[str] = []


class TrendOut(BaseModel):
    trends: list[str] = Field(description="What is working now for this audience/platform")
    hook_patterns: list[str]
    sounds_or_formats: list[str] = []
    cautions: list[str] = []


class SfxCue(BaseModel):
    shot_code: str
    prompt: str = Field(description="Sound effect / ambience description for an SFX model")
    start: float = 0.0
    duration: float = 4.0
    volume_db: float = -8.0


class SfxPlanOut(BaseModel):
    cues: list[SfxCue]
