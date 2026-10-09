"""Shared pieces of the MCP tools: parameter types, tool annotations, name lookups and the Director bridge."""
from __future__ import annotations

from typing import Annotated, Any

from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..agents.tools import TOOL_FUNCS, _needs_confirmation
from ..core import studio
from ..models import Character, Episode, Location, Project, Scene, Shot
from .context import Call, agent_result

# ── parameter types ──────────────────────────────────────────────────────────

ProjectId = Annotated[int, Field(description="Project id, from list_projects.")]
EpisodeNo = Annotated[int | None, Field(description="Episode number. Leave empty for the first episode.")]
SceneNo = Annotated[int, Field(description="Scene number, 1-based, in script order (see list_scenes).")]
ShotCode = Annotated[str, Field(description="Shot code like E01-SH03 (see get_storyboard).")]
ShotCodes = Annotated[list[str] | None, Field(
    description="Shot codes like E01-SH03. Leave empty for every shot that still needs it.")]
Lang = Annotated[str, Field(description="Language code: en, hi, kn, te or ta. Empty = the project's main language.")]
Confirm = Annotated[bool, Field(
    description="Leave false. If the reply says needs_confirmation, ask the user; call again with true only if they agree.")]
RunNow = Annotated[bool, Field(
    description="false (default) = return a cost proposal and spend nothing. true = start now; needs a token with the "
                "'spend' scope, and budget limits still apply.")]
Quality = Annotated[str, Field(description="saver, balanced or hero. Empty = the shot's or project's setting.")]

# ── tool annotations (clients use them to decide when to ask the user) ───────

READ = ToolAnnotations(read_only_hint=True, open_world_hint=False)
EDIT = ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=False)
REPLACE = ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False)
PAID = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=True)

NEXT_PROPOSAL = ("Nothing has been spent. Show the user the estimate. To start it, call approve_spend with the batch_id "
                 "(needs the 'spend' scope), or the user can approve it in Tatvam (Queue).")


# ── lookups by name ──────────────────────────────────────────────────────────

def character(db: Session, project: Project, name: str) -> Character:
    low = " ".join((name or "").strip().lstrip("@").lower().split())
    cast = studio.cast(db, project)
    for exact in (True, False):
        for c in cast:
            cn = " ".join(c.name.strip().lower().split())
            if (cn == low) if exact else (cn.split()[0] == low.split()[0] if low else False):
                return c
    raise ToolError(f"No cast member called {name!r}. Cast: {', '.join(c.name for c in cast) or 'none yet (build_bible)'}.")


def location(db: Session, project: Project, name: str) -> Location:
    low = (name or "").strip().lower()
    locs = studio.locations(db, project)
    for l in locs:
        if l.name.strip().lower() == low:
            return l
    for l in locs:
        if low and (low in l.name.lower() or l.name.lower() in low):
            return l
    raise ToolError(f"No location called {name!r}. Locations: {', '.join(l.name for l in locs) or 'none yet'}.")


def names(db: Session, ids: list[Any]) -> list[str]:
    out = []
    for i in ids or []:
        c = db.get(Character, int(i)) if str(i).isdigit() else None
        out.append(c.name if c else str(i))
    return out


def scene_number(db: Session, shot: Shot) -> int | None:
    sc = db.get(Scene, shot.scene_id) if shot.scene_id else None
    return sc.order + 1 if sc else None


def wardrobe_by_name(db: Session, wardrobe: dict | None) -> dict[str, str]:
    return {(db.get(Character, int(k)).name if str(k).isdigit() and db.get(Character, int(k)) else str(k)): v
            for k, v in (wardrobe or {}).items()}


# ── the Director bridge ──────────────────────────────────────────────────────

def director(c: Call, project: Project, episode: Episode, name: str, args: dict[str, Any], *, confirm: bool = False,
             run_now: bool = False) -> dict[str, Any]:
    """Run one of the Director's tools (agents/tools.py) for this caller: the same code the UI and the chat use.
    Work that would replace something asks first; paid work comes back as a proposal unless run_now."""
    if run_now:
        c.need("spend")
    ctx = c.agent(project, episode, confirm=confirm, run_now=run_now)
    if not confirm:
        need = _needs_confirmation(ctx, name, args)
        if need:
            return {"status": "needs_confirmation", "what": need[0], "detail": need[1],
                    "next": "Nothing was changed. Tell the user what would be replaced; if they agree, call this tool "
                            "again with confirm=true."}
    out = agent_result(TOOL_FUNCS[name](ctx, **args))
    return with_next(out)


def with_next(out: dict[str, Any]) -> dict[str, Any]:
    if isinstance(out, dict):
        if out.get("status") == "proposed":
            out = {**out, "next": NEXT_PROPOSAL}
        elif out.get("status") == "awaiting_approval":
            out = {**out, "next": "Over a budget limit: a producer must approve it in Tatvam (Approvals) before it runs."}
        elif out.get("status") == "queued":
            out = {**out, "next": "Started. Follow it with job_status(batch_id, wait_seconds=60)."}
    return out


class DialogueLine(BaseModel):
    character: str = Field(description="Cast member's name, or NARRATOR for voice-over")
    line: str
    emotion: str = ""
