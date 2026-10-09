"""The Tatvam MCP server: the whole film pipeline as tools for Claude Code, Claude Desktop, claude.ai and other MCP
clients. Served at /mcp on the same port as the app (Streamable HTTP, stateless), or over stdio with
`python -m app.mcp_server` and a TATVAM_TOKEN.

    script → critique / improve → scene cards → cast & places → shot list → keyframes (storyboard)
           → videos scene by scene with continuity carried forward → voices, music → export
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.routing import Route

from ..config import get_settings
from . import tools_production, tools_story

INSTRUCTIONS = """Tatvam AI Studio makes AI films and series: script → scenes → storyboard → videos → voices → export.

Typical flow:
1. list_projects (or create_project). Every tool takes the project_id; episode defaults to the first one.
2. Script: import_script (an existing screenplay), save_script (one you wrote or improved — read it first with
   get_script), or write_script (Tatvam's writer). Improve it with critique_script and improve_script.
3. plan_scenes (scene cards: goal, conflict, wardrobe, props, coverage), build_bible (cast & places), get_cast,
   lock_character / add_costume to keep people consistent.
4. breakdown_shots → get_storyboard (shows the keyframe pictures) → update_shot to adjust → generate_keyframes.
5. generate_scenes: videos scene by scene with continuity carried forward (end states, linked shots start from the
   previous clip's last frame). Use plan_only=true first to show the user what it makes and costs.
6. job_status(batch_id, wait_seconds=50) to follow; get_continuity to check links and wardrobe; get_shot for a
   signed link to watch a clip.
7. voice_and_lipsync, generate_music, make_animatic (free preview), export_video.

Money: every paid tool returns a PROPOSAL with an estimate and spends nothing. Show the estimate to the user. It
starts only after approve_spend(batch_id) (token with the 'spend' scope, and only when the user agreed) or approval
in Tatvam. Budget limits still apply.
Replacing work: tools that would overwrite the script, shot list or scene cards answer needs_confirmation first;
ask the user and call again with confirm=true only if they agree."""

PROMPTS: dict[str, tuple[str, str]] = {
    "film_from_script": (
        "Take a script to finished scenes",
        "Help me turn a script into a film in Tatvam{project}. Steps: find or create the project; import the script "
        "I give you (or read the current one); critique it and propose improvements, and save the improved script only "
        "after I agree; plan the scene cards and build the cast; lock the main characters; break it into shots and show "
        "me the storyboard; make the keyframes; then plan generate_scenes (plan_only) and show me the cost per scene "
        "before anything is spent; after I approve, follow the jobs and check continuity between scenes. Ask me "
        "before every paid step and before replacing work."),
    "improve_script": (
        "Critique and improve a script",
        "Read the script of project {project_id} with get_script, run critique_script, and suggest specific "
        "improvements scene by scene (hook, stakes, dialogue under 15 words a line, visual action). Rewrite it with "
        "my approval: either save_script with your version or improve_script with notes. Show the score before and after."),
    "storyboard_review": (
        "Review a storyboard",
        "Show me the storyboard of project {project_id} (get_storyboard with pictures). For each scene, check the shots "
        "against the scene cards and the Continuity Bible (get_continuity): framing variety, who is in shot, outfits, "
        "props, links between shots. List problems and suggested update_shot changes; apply them only after I agree."),
    "continue_scenes": (
        "Make the next scenes with continuity",
        "In project {project_id}, find the next scenes without videos (list_scenes), run generate_scenes with "
        "plan_only for them and show me the plan and cost. After I approve, start it, follow job_status until it is "
        "done, then check get_continuity for broken links or wardrobe breaks and tell me what to fix."),
}


def _allowed_hosts() -> TransportSecuritySettings:
    """DNS-rebinding protection: only our own host names (every request also needs a valid token)."""
    s = get_settings()
    extra = [h.strip() for h in (s.mcp_allowed_hosts or "").split(",") if h.strip()]
    if "*" in extra:
        return TransportSecuritySettings(enable_dns_rebinding_protection=False)
    u = urlparse(s.public_base_url)
    hosts = ["localhost", "127.0.0.1", "[::1]", "localhost:*", "127.0.0.1:*", "[::1]:*", *extra]
    origins = ["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"]
    if u.hostname:
        hosts += [u.hostname, f"{u.hostname}:*"]
        origins += [f"{u.scheme}://{u.netloc}"]
    return TransportSecuritySettings(enable_dns_rebinding_protection=True, allowed_hosts=hosts, allowed_origins=origins)


def build(with_auth: bool = True) -> MCPServer:
    """The server with every tool and prompt. `with_auth=False` is for stdio, where TATVAM_TOKEN identifies the user."""
    kw: dict[str, Any] = {}
    if with_auth:
        from .auth import build_auth
        auth, provider, verifier = build_auth()
        kw = {"auth": auth, "auth_server_provider": provider, "token_verifier": verifier}
    server = MCPServer(name="tatvam", title="Tatvam AI Studio", instructions=INSTRUCTIONS, version="1.0.0",
                       website_url=get_settings().public_base_url, **kw)
    for module in (tools_story, tools_production):
        for fn, title, hints in module.TOOLS:
            server.add_tool(fn, title=title, annotations=hints, structured_output=False)
    for name, (title, text) in PROMPTS.items():
        _add_prompt(server, name, title, text)
    for uri, fn, title, mime in tools_story.RESOURCES:
        server.resource(uri, name=fn.__name__, title=title, description=fn.__doc__, mime_type=mime)(fn)
    return server


def _add_prompt(server: MCPServer, name: str, title: str, text: str) -> None:
    if "{project_id}" in text:
        def fn(project_id: str) -> str:
            return text.format(project_id=project_id)
    else:
        def fn(project: str = "") -> str:
            return text.format(project=f" (project: {project})" if project else "")
    fn.__name__ = name
    server.prompt(name=name, title=title, description=title)(fn)


# ── serving it from the FastAPI app on the same port ─────────────────────────

_server: MCPServer | None = None


def http_server() -> MCPServer:
    global _server
    if _server is None:
        _server = build()
    return _server


def routes() -> list[Route]:
    """Routes for the FastAPI app: /mcp and the OAuth endpoints, all served by the SDK's Starlette app (which brings
    its own auth middleware). They must come before the web app's catch-all route."""
    server = http_server()
    asgi = server.streamable_http_app(streamable_http_path="/mcp", stateless_http=True,
                                      transport_security=_allowed_hosts())
    out = []
    for r in asgi.routes:
        path = getattr(r, "path", None)
        if path:
            out.append(Route(path, endpoint=asgi, methods=None, include_in_schema=False))
    return out


def session_manager():
    return http_server().session_manager


def tool_names() -> list[str]:
    return [fn.__name__ for module in (tools_story, tools_production) for fn, _, _ in module.TOOLS]
