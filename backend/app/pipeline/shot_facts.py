"""A shot's facts, apart from the prompt builder: its quality mode, its lines, and how its voice is made.

pipeline/prompting.py serves them too. core/recovery.py, core/budget.py, core/generation.py and pipeline/voice.py read
them from here: prompting imports core/continuity and pipeline/scene_look, whose imports lead back to budget, so reading
them from prompting closes import cycles. This module imports nothing of core or pipeline.
"""
from __future__ import annotations

import time
from typing import Any

from .. import catalog
from ..models import Project, Shot


def effective_quality(shot: Shot, project: Project) -> str:
    q = shot.quality_mode or project.quality_mode or "saver"
    return q if q in catalog.QUALITY_MODES else "saver"


def shot_lines(shot: Shot, lang: str) -> list[dict]:
    return list((shot.dialogue or {}).get(lang) or [])


def offscreen_only(shot: Shot, project: Project) -> bool:
    """Every line of the shot is heard from off-screen (O.S.): voiced over the clip, nobody seen saying it, so never
    lip-synced. The flag is on the primary language's lines (a translation keeps the staging)."""
    lines = shot_lines(shot, project.primary_language)
    return bool(lines) and all(l.get("off_screen") for l in lines)


_settings_cache: dict[str, Any] = {"at": 0.0, "v": -1, "values": {}}
_TEAM_KEYS = ("dialogue_method", "native_dialogue_languages")


def team_setting(key: str) -> Any:
    """A team setting read at most every 30 s (and immediately after a change) from inside the pipeline."""
    from .. import settings_store
    now = time.time()
    if now - _settings_cache["at"] > 30 or _settings_cache["v"] != settings_store.VERSION["n"]:
        from ..db import SessionLocal
        with SessionLocal() as db:
            _settings_cache["values"] = {k: settings_store.get_setting(db, k) for k in _TEAM_KEYS}
        _settings_cache["at"], _settings_cache["v"] = now, settings_store.VERSION["n"]
    return _settings_cache["values"].get(key)


def team_dialogue_method() -> str:
    """Team default for dialogue shots (Settings): audio_first | audio_driven | voice_lock | native | native_when_possible."""
    return team_setting("dialogue_method") or "audio_first"


def native_languages(project: Project | None = None) -> set[str]:
    """Languages Veo may speak itself. The project brief can narrow or widen the team list."""
    langs = (project.brief or {}).get("native_languages") if project else None
    if langs is None:
        langs = team_setting("native_dialogue_languages") or ["en"]
    return {str(x) for x in langs}


def effective_voice_mode(shot: Shot, project: Project, lang: str | None = None) -> str:
    lang = lang or project.primary_language
    if shot.voice_mode and shot.voice_mode != "auto":
        return shot.voice_mode
    has_lines = bool(shot_lines(shot, project.primary_language) or shot_lines(shot, lang))
    has_narr = bool((shot.narration or {}).get(project.primary_language) or (shot.narration or {}).get(lang))
    if not has_lines:
        return "narration" if has_narr else "none"
    method = (project.brief or {}).get("dialogue_method") or team_dialogue_method()
    if method == "auto" or not method:
        method = "audio_first"
    native_ok = lang in native_languages(project)
    if method in ("native", "native_when_possible"):
        return "native" if native_ok else "audio_first"
    if method == "audio_first" and project.type in ("short", "ad") and len(project.languages or []) <= 1 and native_ok:
        return "native"  # a one-language short or ad: the cheapest route, speech and lips in one pass
    return method if method in ("audio_first", "audio_driven", "voice_lock") else "audio_first"
