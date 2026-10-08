"""The one definition of Autopilot's steps. The worker, the REST API, the Director and every screen read it from here.

Stages are the fine-grained steps the worker runs. Milestones group them into the four things a person cares about
(script, cast, storyboard, final video); a run goes "through" a milestone and can stop for approval after each one.
"""
from __future__ import annotations

STAGES = ["brief", "hooks", "script", "critic", "scenes", "bible", "sheets", "voices", "shots", "continuity",
          "keyframes", "videos", "dialogue", "music", "sfx", "dubs", "export", "marketing"]

STAGE_LABELS = {
    "brief": "Brief", "hooks": "Hooks", "script": "Script", "critic": "Critic pass", "scenes": "Scene cards",
    "bible": "Characters & places", "sheets": "Character images", "voices": "Voices", "shots": "Shot list",
    "continuity": "Continuity check", "keyframes": "Keyframes", "videos": "Videos", "dialogue": "Voices & lip-sync",
    "music": "Music", "sfx": "Sound effects", "dubs": "Dubbing", "export": "Final export", "marketing": "Marketing pack",
}

MILESTONES = [
    {"id": "script", "label": "Script", "until": "critic", "tab": "story",
     "description": "Brief, hooks, the script and a critic pass"},
    {"id": "cast", "label": "Cast & scenes", "until": "voices", "tab": "bible",
     "description": "Scene cards, characters and places, their images and voices"},
    {"id": "storyboard", "label": "Storyboard", "until": "keyframes", "tab": "storyboard",
     "description": "The shot list and a keyframe for every shot (cents each)"},
    {"id": "final", "label": "Final video", "until": "export", "tab": "export",
     "description": "Videos, lip-sync, music, sound, dubs and the finished export"},
]
MILESTONE_BY_ID = {m["id"]: m for m in MILESTONES}


def resolve_through(value: str | None) -> str:
    """A milestone id or a stage name → the last stage to run (default: the final export)."""
    if value in MILESTONE_BY_ID:
        return MILESTONE_BY_ID[value]["until"]
    return value if value in STAGES else "export"


def milestone_of(stage: str) -> dict | None:
    """The milestone whose last stage this is (where a run may pause)."""
    return next((m for m in MILESTONES if m["until"] == stage), None)


def milestone_containing(stage: str) -> dict:
    i = STAGES.index(stage) if stage in STAGES else len(STAGES) - 1
    for m in MILESTONES:
        if i <= STAGES.index(m["until"]):
            return m
    return MILESTONES[-1]


def catalog() -> dict:
    return {"stages": STAGES, "labels": STAGE_LABELS, "milestones": MILESTONES}
