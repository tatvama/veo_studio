# Tatvam MCP server

*Added 10 October 2026. Code: `backend/app/mcp_server/`, scene runner: `backend/app/core/scene_chain.py`.*

The MCP server lets Claude Code, Claude Desktop, claude.ai or any other MCP app work in Tatvam: read and improve a
script, plan scenes, storyboard, and make the videos scene by scene with continuity carried forward. It runs inside
the app, on the same port: **`<PUBLIC_BASE_URL>/mcp`** (for example `http://localhost:8100/mcp`).

## Connect

1. In Tatvam: **Settings → MCP access → Create a token**. Pick the scopes:
   - `read`: look at projects, scripts, storyboards, jobs
   - `write`: change scripts, scenes and shots, run AI writing, and **propose** paid work (nothing is spent)
   - `spend`: approve proposals and start paid work (team and project budget limits still apply)
2. Claude Code:
   ```
   claude mcp add --transport http tatvam http://localhost:8100/mcp --header "Authorization: Bearer tvm_…"
   ```
3. Claude Desktop and other apps (JSON config):
   ```json
   {"mcpServers": {"tatvam": {"type": "http", "url": "http://localhost:8100/mcp",
                              "headers": {"Authorization": "Bearer tvm_…"}}}}
   ```
   Apps that can only start a command can use stdio instead (the app on port 8100 must keep running, because it runs
   the jobs): `cd backend` then `set TATVAM_TOKEN=tvm_…` and `.venv\Scripts\python -m app.mcp_server`.
4. claude.ai (custom connector): add the `/mcp` address. claude.ai registers itself, sends you to
   `/oauth/consent` in Tatvam, and you approve it and choose its scopes. This needs an **HTTPS** `PUBLIC_BASE_URL`
   (Cloudflare Tunnel / Coolify); on plain HTTP only personal tokens work. Connected apps are listed in
   Settings → MCP access, where you can disconnect them.

Tokens are stored as hashes; personal tokens can expire, OAuth access tokens last 8 hours and refresh for 60 days.
A token can be limited to some projects.

## The flow, and the tools

| Step | Tools |
| --- | --- |
| Find or make a project | `list_projects`, `create_project`, `get_project`, `update_brief` |
| Script in | `import_script` (an existing screenplay), `save_script` (one Claude wrote or edited), `write_script` (Tatvam's writer), `generate_hooks`, `select_hook`, `plan_series` |
| Improve the script | `get_script`, `critique_script` (scores, problems, rewrite notes), `improve_script` (one critic + rewrite pass with your notes), `polish_dialogue` (native speaker pass), `restore_script` |
| Scenes | `plan_scenes` (scene cards: goal, conflict, turn, wardrobe, props, blocking, coverage), `list_scenes`, `update_scene` |
| Cast & places | `build_bible`, `get_cast`, `lock_character`, `add_costume`, `set_outfit`, `freeze_look`, `set_dialogue_route` |
| Storyboard | `breakdown_shots`, `get_storyboard` (returns the keyframe pictures), `get_shot` (exact prompt, takes, QC, a 6-hour link to watch the clip), `update_shot` (incl. `continues_from`), `add_shot_after`, `generate_keyframes` |
| Video, scene by scene | `generate_scenes` (see below), `generate_videos` (single shots), `regenerate_stale`, `impact_report`, `edit_clip` |
| Continuity | `get_continuity` (end states, wardrobe timeline, every shot link: ok / waiting / broken), `continuity_state`, `edit_end_state`, `continuity_check` |
| Finish | `voice_and_lipsync`, `generate_music`, `make_animatic`, `export_video`, `dub_episode`, `make_cutdowns`, `start_autopilot` |
| Jobs & money | `job_status` (with `wait_seconds`, reports progress), `list_pending`, `approve_spend`, `cancel_jobs` |

Prompts (slash commands in Claude Code): `film_from_script`, `improve_script`, `storyboard_review`, `continue_scenes`.

## Safety rules

- **Money**: every paid tool returns a *proposal* (batch id + estimate) and spends nothing. It starts only after
  `approve_spend` (token with `spend`) or approval in Tatvam (Queue). `run_now=true` skips the proposal and needs
  `spend`. Budget caps, Google-first and cheapest-route routing and producer approvals all apply as in the app.
- **Replacing work**: tools that would overwrite the script, the shot list, scene cards or hooks answer
  `needs_confirmation` first; the client must ask you and call again with `confirm=true`. Old scripts stay as versions.
- Roles: a viewer's token can only read. Every call is made as the token's user and shows in the app's activity.

## Continuity carried forward (`generate_scenes`)

`generate_scenes` submits one `scene_chain` job. For each scene, in order:

1. The **end state** of every earlier scene is written if missing (outfits, physical state, props in hand, time of
   day, weather, from the script and the scene before). The scene's prompts carry it as `[CONTINUITY]`.
2. When the scene picks up straight from the previous one (`link_scenes=auto`: same place, same time of day, someone
   in common), its first shot is linked to the previous scene's last shot.
3. Its shots are made **in link order**: a shot that continues another (a Film Map link, or "continue from previous",
   which the breakdown sets inside a scene) waits for that clip, then starts from its **real last frame** (or extends
   it). A storyboard keyframe that was made from the previous shot's *keyframe* is remade from the clip first.
4. QC and retakes finish before the next scene; then the scene's own end state is written for the scene after.

`plan_only=true` shows what would be made and the cost per scene. `pause_after_each_scene` stops after each scene
for review (run again to continue; finished shots are skipped). `fix_links=true` remakes clips whose link is already
broken (made before the clip they continue from).

The same ordering now also runs inside **Autopilot** (videos stage; its continuity stage also writes every scene's
end state before keyframes) and **Produce all** (videos step). Each keyframe records which clip it started from
(`continuity_take_id`), so `get_continuity` can tell a real link from a broken one.

## Files

- `app/mcp_server/server.py`: the server, instructions, prompts, mounting on the app (`/mcp`, OAuth endpoints)
- `app/mcp_server/tools_story.py`, `tools_production.py`: the tools (most call the Director's tools in `agents/tools.py`, the same code the UI uses)
- `app/mcp_server/auth.py`, `tokens.py`, `api/mcp_access.py`: tokens, OAuth provider, consent page API
- `app/mcp_server/context.py`: who is calling, scopes, project limits, errors as tool errors
- `app/core/scene_chain.py`, `app/workers/handlers_scene.py`: the scene runner
- Tests: `backend/tests/test_mcp.py` (HTTP + tokens, OAuth sign-in, the whole pipeline in mock mode with the
  continuity checks, the spend scope)
