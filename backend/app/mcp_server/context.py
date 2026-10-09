"""Who is calling and what they may touch, for every MCP tool call.

Over HTTP the bearer token is checked by the SDK's auth middleware (see auth.TatvamOAuthProvider.load_access_token)
and arrives here as an AccessToken. Over stdio (`python -m app.mcp_server`) there is no HTTP layer, so the token
comes from the TATVAM_TOKEN environment variable and is checked here.
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator

from fastapi import HTTPException
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.mcpserver.exceptions import ToolError
from sqlalchemy.orm import Session

from ..agents.tools import AgentCtx
from ..db import SessionLocal
from ..models import Episode, Project, Scene, Shot, User, role_rank
from . import tokens


@dataclass
class Caller:
    user_id: int
    scopes: list[str]
    project_ids: list[int] = field(default_factory=list)  # empty = every project
    token_id: int | None = None

    def can(self, scope: str) -> bool:
        return scope in self.scopes


def caller() -> Caller:
    at = get_access_token()
    if at is not None:
        claims = at.claims or {}
        return Caller(user_id=int(at.subject or 0), scopes=list(at.scopes or []),
                      project_ids=[int(p) for p in claims.get("project_ids") or []], token_id=claims.get("token_id"))
    raw = os.environ.get("TATVAM_TOKEN", "").strip()
    if raw:
        with SessionLocal() as db:
            row = tokens.lookup(db, raw)
            if row is not None:
                tokens.touch(db, row)
                return Caller(user_id=row.user_id, scopes=list(row.scopes or []), project_ids=list(row.project_ids or []),
                              token_id=row.id)
    raise ToolError("Not signed in: connect with a Tatvam MCP token (Settings → MCP access).")


class McpCtx(AgentCtx):
    """The Director's tool context, driven by an MCP client. Paid work is always PROPOSED (an estimate the user or a
    `spend` token approves) unless the call asked to run it now and the token may spend."""

    run_now: bool = False

    @property
    def copilot(self) -> bool:  # type: ignore[override]
        return not self.run_now


@dataclass
class Call:
    db: Session
    who: Caller
    user: User

    def need(self, scope: str) -> None:
        if not self.who.can(scope):
            hint = {"write": "changing things", "spend": "spending money (approving or starting paid work)"}.get(scope, scope)
            raise ToolError(f"This token has no '{scope}' scope, which is needed for {hint}. "
                            f"Make a token with it on Settings → MCP access, or do this step in Tatvam.")
        if scope != "read" and role_rank(self.user.role) < role_rank("creator"):
            raise ToolError(f"Your Tatvam role ({self.user.role}) can only look, not change things.")

    def project(self, project_id: int) -> Project:
        p = self.db.get(Project, int(project_id))
        if p is None or (self.who.project_ids and p.id not in self.who.project_ids):
            raise ToolError(f"No project {project_id} (or this token is limited to other projects). Use list_projects.")
        return p

    def episode(self, project: Project, number: int | None = None) -> Episode:
        q = self.db.query(Episode).filter(Episode.project_id == project.id)
        if number:
            ep = q.filter(Episode.number == int(number), Episode.kind == "episode").first() or q.filter(Episode.number == int(number)).first()
            if ep is None:
                have = [e.number for e in q.order_by(Episode.number).all()]
                raise ToolError(f"Episode {number} not found; this project has episodes {have}.")
            return ep
        ep = q.filter(Episode.kind == "episode").order_by(Episode.number).first() or q.order_by(Episode.number).first()
        if ep is None:
            ep = Episode(project_id=project.id, number=1, title="Episode 1")
            self.db.add(ep)
            self.db.commit()
        return ep

    def scenes(self, episode: Episode) -> list[Scene]:
        return self.db.query(Scene).filter(Scene.episode_id == episode.id).order_by(Scene.order, Scene.id).all()

    def scene(self, episode: Episode, number: int) -> Scene:
        rows = self.scenes(episode)
        if not rows:
            raise ToolError("This episode has no scenes yet: write or import a script, then plan_scenes or breakdown_shots.")
        if not 1 <= int(number) <= len(rows):
            raise ToolError(f"Scene {number} not found; pick 1..{len(rows)}.")
        return rows[int(number) - 1]

    def shot(self, episode: Episode, code: str) -> Shot:
        s = (self.db.query(Shot).filter(Shot.episode_id == episode.id, Shot.code == (code or "").strip().upper()).first())
        if s is None:
            raise ToolError(f"No shot {code} in episode {episode.number}. Use get_storyboard to see the shot codes.")
        return s

    def agent(self, project: Project, episode: Episode, *, confirm: bool = False, run_now: bool = False) -> McpCtx:
        c = McpCtx(db=self.db, user=self.user, project=project, episode=episode, confirmed=bool(confirm))
        c.run_now = bool(run_now)
        return c


@contextmanager
def call(scope: str = "read") -> Iterator[Call]:
    """One tool call: who is calling, a database session, and errors turned into messages the model can act on."""
    who = caller()
    db = SessionLocal()
    try:
        user = db.get(User, who.user_id)
        if user is None or not user.active:
            raise ToolError("The user behind this token no longer exists or is disabled.")
        c = Call(db=db, who=who, user=user)
        c.need(scope)
        yield c
    except ToolError:
        db.rollback()
        raise
    except HTTPException as e:
        db.rollback()
        raise ToolError(str(e.detail)) from e
    except ValueError as e:
        db.rollback()
        raise ToolError(str(e)) from e
    finally:
        db.close()


def agent_result(out: dict[str, Any]) -> dict[str, Any]:
    """A Director tool result: its own {"error": ...} becomes a tool error, so the client sees it failed."""
    if isinstance(out, dict) and out.get("error") and len(out) == 1:
        raise ToolError(str(out["error"]))
    return out
