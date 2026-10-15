"""Job type groups shared by the queue (core/jobs.py), the budget (core/budget.py) and the workers.

A module of its own: core.budget must not import the worker package, which imports core.budget.
"""
from __future__ import annotations

# Runs that enqueue child jobs with estimates of their own (dub, autopilot, produce, campaign, scene_chain,
# storyboard_frames). While one is running it reserves nothing itself: its children hold their own cost, else the same
# money is reserved twice.
ORCHESTRATORS = frozenset({"dub", "autopilot", "produce", "campaign", "scene_chain", "storyboard_frames"})
