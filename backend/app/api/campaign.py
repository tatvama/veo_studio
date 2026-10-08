"""Ads & Reels: estimate / start / read a campaign (language × aspect × duration variants) and the reel highlights."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import catalog
from ..core import budget, campaign as campaign_core, generation, jobs
from ..db import get_db
from ..models import BrandKit, Episode, Project, User
from ..security import current_user, require
from .common import get_or_404

router = APIRouter(prefix="/api", tags=["campaign"])


class CampaignIn(BaseModel):
    languages: list[str] = Field(default_factory=list)  # the primary language is always included
    aspects: list[str] = Field(default_factory=lambda: ["9:16"])  # 9:16 | 16:9 | 1:1
    durations: list[int] = Field(default_factory=list)  # extra cut-down lengths (seconds); full length is always made
    brand_kit_id: int | None = None
    cta: str = ""  # overrides the kit's CTA text for this campaign
    captions: bool = True
    publish: bool = False
    brief: dict[str, Any] = Field(default_factory=dict)  # product/offer, audience, tone (kept with the campaign)
    redub: bool = False  # dub again even when a language already has lines and voices


def _ctx(db: Session, eid: int) -> tuple[Episode, Project]:
    e = get_or_404(db, Episode, eid)
    return e, db.get(Project, e.project_id)


def _validate(db: Session, project: Project, episode: Episode, body: CampaignIn) -> None:
    for l in body.languages:
        if l not in catalog.LANGUAGES:
            raise HTTPException(400, f"unknown language {l}")
    if not [a for a in body.aspects if a in campaign_core.ASPECT_PRESET]:
        raise HTTPException(400, "Pick at least one aspect ratio (9:16, 16:9 or 1:1)")
    for d in body.durations:
        if d not in campaign_core.DURATIONS:
            raise HTTPException(400, f"durations must be some of {campaign_core.DURATIONS}")
    if body.brand_kit_id and not db.get(BrandKit, body.brand_kit_id):
        raise HTTPException(404, "Brand kit not found")
    if not generation.episode_shots(db, episode):
        raise HTTPException(400, "The shot list is empty: add or import shots first")


@router.post("/episodes/{eid}/campaign/estimate")
def estimate(eid: int, body: CampaignIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e, p = _ctx(db, eid)
    _validate(db, p, e, body)
    total, items = campaign_core.plan(db, p, e, body)
    full = campaign_core.episode_length(db, e)
    cfg = campaign_core.normalize(p, full, body)
    variants = campaign_core.variant_grid(cfg, full)
    return {"total_usd": total, "count": len(items), "items": items, "variants": variants, "episode_length_s": full,
            "languages": cfg["languages"], "aspects": cfg["aspects"], "durations": cfg["durations"],
            "skipped_durations": [d for d in body.durations if d not in cfg["durations"]],
            "budget": budget.check(db, user, p, total), "team": budget.team_status(db)}


@router.post("/episodes/{eid}/campaign")
def start(eid: int, body: CampaignIn, user: User = Depends(require("creator")), db: Session = Depends(get_db)):
    e, p = _ctx(db, eid)
    _validate(db, p, e, body)
    other = campaign_core.active_campaign(db, e)
    if other:
        raise HTTPException(409, f"A campaign is already running for this episode (job #{other.id}). Wait for it or stop it first.")
    return jobs.submit(db, user, p, [campaign_core.campaign_spec(db, p, e, body)])


@router.get("/episodes/{eid}/campaign")
def read(eid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e, _ = _ctx(db, eid)
    return campaign_core.state(db, e)


@router.get("/episodes/{eid}/highlights")
def read_highlights(eid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e, _ = _ctx(db, eid)
    return {"episode_id": e.id, "total_s": campaign_core.episode_length(db, e), "highlights": campaign_core.highlights(db, e)}
