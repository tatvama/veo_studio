"""Who and where a project uses: its cast and locations, and adding a character or location to them.

core/studio.py serves them too. core/mentions.py reads them from here: studio imports mentions, so reading them from
studio closes an import cycle. This module imports nothing of core.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Character, Location, Project, ProjectCast, ProjectLocation


def cast(db: Session, project: Project) -> list[Character]:
    ids = [r.character_id for r in db.query(ProjectCast).filter(ProjectCast.project_id == project.id).all()]
    return db.query(Character).filter(Character.id.in_(ids), Character.archived.is_(False)).order_by(Character.id).all() if ids else []


def locations(db: Session, project: Project) -> list[Location]:
    ids = [r.location_id for r in db.query(ProjectLocation).filter(ProjectLocation.project_id == project.id).all()]
    return db.query(Location).filter(Location.id.in_(ids), Location.archived.is_(False)).order_by(Location.id).all() if ids else []


def link_character(db: Session, project: Project, ch: Character) -> None:
    if not db.get(ProjectCast, {"project_id": project.id, "character_id": ch.id}):
        db.add(ProjectCast(project_id=project.id, character_id=ch.id))


def link_location(db: Session, project: Project, loc: Location) -> None:
    if not db.get(ProjectLocation, {"project_id": project.id, "location_id": loc.id}):
        db.add(ProjectLocation(project_id=project.id, location_id=loc.id))
