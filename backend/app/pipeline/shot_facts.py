"""Plain facts read off a shot: its quality mode and its spoken lines.

pipeline/prompting.py re-exports them. core/budget.py, core/generation.py and core/recovery.py read them from here,
which keeps those modules out of the import cycles that prompting is in.
"""
from __future__ import annotations

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
