"""A shot's quality mode, apart from the prompt builder.

pipeline/prompting.py serves it too. core/recovery.py reads it from here, which keeps recovery (and core/generation.py,
which imports it) out of the import cycles that prompting is in.
"""
from __future__ import annotations

from .. import catalog
from ..models import Project, Shot


def effective_quality(shot: Shot, project: Project) -> str:
    q = shot.quality_mode or project.quality_mode or "saver"
    return q if q in catalog.QUALITY_MODES else "saver"
