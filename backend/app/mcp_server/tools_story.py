"""MCP tools, part 1: projects, the script (write, import, critique, improve, versions), scenes, cast and the
Continuity Bible. Part 2 (tools_production.py) is the storyboard, generation and jobs."""
from __future__ import annotations

from typing import Annotated, Any

from mcp.server.mcpserver.exceptions import ToolError
from pydantic import BaseModel, Field

from .. import catalog
from ..core import continuity, dependencies, mentions, scene_chain, studio
from ..events import emit
from ..models import (CharacterAsset, Costume, Episode, Job, Location, Project, Scene, ScriptVersion, Shot,
                      VoiceProfile)
from ..pipeline.selection import current, is_real
from .common import (EDIT, READ, REPLACE, Confirm, EpisodeNo, Lang, ProjectId, RunNow, SceneNo, character, director, location,
                     names, wardrobe_by_name)
from .context import call

# ── projects ─────────────────────────────────────────────────────────────────


def list_projects() -> dict:
    """List the Tatvam projects you can work on (newest first), with their episodes. Start here to get a project_id."""
    with call("read") as c:
        q = c.db.query(Project).filter(Project.archived.is_(False))
        if c.who.project_ids:
            q = q.filter(Project.id.in_(c.who.project_ids))
        out = []
        for p in q.order_by(Project.updated_at.desc()).limit(100).all():
            eps = c.db.query(Episode).filter(Episode.project_id == p.id).order_by(Episode.number).all()
            out.append({"id": p.id, "title": p.title, "type": p.type, "aspect": p.aspect, "languages": p.languages,
                        "workflow": p.workflow, "status": p.status, "concept": (p.concept or "")[:200],
                        "episodes": [{"number": e.number, "title": e.title, "kind": e.kind,
                                      "scenes": len((e.script or {}).get("scenes") or [])} for e in eps]})
        return {"projects": out}


def create_project(
    concept: Annotated[str, Field(description="What the film is about, one or two sentences.")],
    title: str = "",
    type: Annotated[str, Field(description=f"One of {', '.join(catalog.PROJECT_TYPES)}.")] = "short",
    aspect: Annotated[str, Field(description="9:16, 16:9 or 1:1. Empty = the type's default.")] = "",
    languages: Annotated[list[str] | None, Field(description="Language codes, main language first (en, hi, kn, te, ta).")] = None,
    workflow: Annotated[str, Field(description="director (from an idea), script (you bring the script) or shots.")] = "script",
) -> dict:
    """Create a project with its first episode. Use workflow="script" when you will import or write the script here."""
    from ..api.projects import ProjectIn, create_project as api_create

    with call("write") as c:
        body = ProjectIn(concept=concept, title=title, type=type, aspect=aspect or None, languages=languages or ["en"],
                         workflow=workflow, auto_brief=True)
        p = api_create(body, c.user, c.db)
        if c.who.project_ids:  # a token limited to some projects can still work on the one it just made
            from ..models import ApiToken
            row = c.db.get(ApiToken, c.who.token_id) if c.who.token_id else None
            if row is not None:
                row.project_ids = [*row.project_ids, p["id"]]
                c.db.commit()
        return {"project_id": p["id"], "title": p["title"], "type": p["type"], "aspect": p["aspect"],
                "languages": p["languages"], "episodes": [e.get("number") for e in p.get("episodes", [])],
                "next": "Import a script (import_script), or write one (save_script / write_script)."}


def get_project(project_id: ProjectId, episode: EpisodeNo = None) -> dict:
    """The project and one episode at a glance: brief, cast, locations, scenes, shots (with keyframe / video status),
    budget, money spent and anything waiting for approval."""
    from ..agents.tools import get_project_state

    with call("read") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        state = get_project_state(c.agent(p, ep))
        state["episodes"] = [{"number": e.number, "title": e.title} for e in
                             c.db.query(Episode).filter(Episode.project_id == p.id).order_by(Episode.number).all()]
        state["scenes"] = [{"scene": s.order + 1, "title": s.title, "time_of_day": s.time_of_day,
                            "has_end_state": bool(s.end_state)} for s in c.scenes(ep)]
        pending = c.db.query(Job).filter(Job.project_id == p.id, Job.status.in_(("proposed", "awaiting_approval"))).all()
        state["waiting_for_approval"] = sorted({j.batch_id for j in pending})
        state["project_id"] = p.id
        return state


def update_brief(project_id: ProjectId,
                 fields: Annotated[dict[str, Any], Field(
                     description="Any of: title, audience, tone, duration_s, key_message, cta, platform, notes")]) -> dict:
    """Change the project brief (audience, tone, target length, key message…). The writer and every prompt read it."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p), "update_brief", {"fields": fields})


# ── script ───────────────────────────────────────────────────────────────────

class Line(BaseModel):
    character: str = Field(description="Speaker's name (use @Name to link a cast member), or NARRATOR for voice-over")
    line: str = Field(description="What is said, in the project's main language; keep it under ~15 words")
    emotion: str = ""


class SceneText(BaseModel):
    title: str
    location: str = Field(description="Where it happens (@Name links a saved location)")
    time_of_day: str = ""
    summary: str = Field(description="One or two sentences: what happens in the scene")
    action: str = Field(default="", description="What we SEE: action and visuals, present tense")
    lines: list[Line] = []


class Script(BaseModel):
    logline: str
    beats: list[str] = []
    scenes: list[SceneText]


def _script_out(c, ep: Episode, raw: bool) -> dict:
    script = ep.script or {}
    shown = script if raw else mentions.plain_script(script)
    versions = (c.db.query(ScriptVersion).filter(ScriptVersion.episode_id == ep.id)
                .order_by(ScriptVersion.version.desc()).limit(10).all())
    critic = ep.critic or {}
    return {"episode": ep.number, "title": ep.title, "script": shown,
            "scenes": len(script.get("scenes") or []),
            "critic": {k: critic.get(k) for k in ("overall", "scores", "problems", "strengths", "rewrite_instructions")
                       if k in critic} or None,
            "versions": [{"version": v.version, "source": v.source, "note": v.note,
                          "at": v.created_at.isoformat() + "Z" if v.created_at else None,
                          "critic_score": (v.critic or {}).get("overall")} for v in versions]}


def get_script(project_id: ProjectId, episode: EpisodeNo = None,
               raw: Annotated[bool, Field(description="true keeps @[Name](character:12) link tokens")] = False) -> dict:
    """Read the episode's script (logline, beats, scenes with action and dialogue), the last critic report and the
    recent versions. Edit it yourself and send it back with save_script, or let Tatvam's writer do it (improve_script)."""
    with call("read") as c:
        p = c.project(project_id)
        return _script_out(c, c.episode(p, episode), raw)


def save_script(project_id: ProjectId, script: Script, episode: EpisodeNo = None,
                note: Annotated[str, Field(description="What changed, kept with the version")] = "") -> dict:
    """Save a script you wrote or improved (the whole script: logline, beats, scenes). The old one stays as a version
    (restore_script). Dialogue changes flag the shots that speak them, so their voices / videos are redone."""
    with call("write") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        old = dict(ep.script or {})
        new = script.model_dump()
        for sc in new["scenes"]:
            for ln in sc["lines"]:
                if ln["character"].strip().upper() in ("VO", "V.O.", "NARRATOR"):
                    ln["character"] = "NARRATOR"
        new, _ = mentions.resolve_script(c.db, p, new, create_missing=False, user=c.user)
        ep.script = new
        if not ep.title:
            ep.title = script.logline[:120]
        mentions.attach_entities(c.db, p, ep.script)
        v = studio.save_script_version(c.db, ep, "manual", c.user, note=(note or "Saved from MCP")[:300])
        touched = dependencies.apply_script_changes(c.db, p, ep, old, ep.script)
        c.db.commit()
        emit(c.db, p.id, "episode.updated", {"episode_id": ep.id, "what": ["script"]}, user_id=c.user.id)
        shots = c.db.query(Shot).filter(Shot.episode_id == ep.id, Shot.include.is_(True)).count()
        return {"saved": True, "version": v.version, "scenes": len(new["scenes"]), "shots_changed": touched,
                "next": ("Shots already exist from the earlier script: changed lines were updated in them. If scenes "
                         "were added, removed or reordered, re-plan with breakdown_shots(confirm=true).") if shots else
                        "Next: plan_scenes (scene cards), build_bible (cast & places), then breakdown_shots."}


def import_script(project_id: ProjectId,
                  text: Annotated[str, Field(description="The screenplay as plain text (Fountain, scene headings, "
                                                         "NAME: line, VISUAL: …, VO: …), up to ~60k characters")],
                  episode: EpisodeNo = None,
                  method: Annotated[str, Field(description="auto, markers (scene headings + NAME: lines) or ai")] = "auto",
                  create_missing_characters: bool = True, confirm: Confirm = False) -> dict:
    """Import an existing script: every speaker becomes a cast member (matched to the cast or created), the scenes and
    shots are laid out as written, and the Story script is saved. Replaces this episode's shot list."""
    from ..api.board import ImportApplyIn, _match, import_apply
    from ..core import script_import

    with call("write") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        if method not in ("auto", "markers", "ai"):
            raise ToolError("method must be auto, markers or ai")
        n = c.db.query(Shot).filter(Shot.episode_id == ep.id, Shot.include.is_(True)).count()
        if n and not confirm:
            return {"status": "needs_confirmation", "what": "Replace the shot list with the imported script",
                    "detail": f"Episode {ep.number} already has {n} shots. Shots with paid takes are dropped from the cut, "
                              "not deleted; the current script stays as a version.",
                    "next": "Ask the user; call again with confirm=true if they agree (or import into a new episode)."}
        draft = script_import.build_draft(c.db, c.user, p, text, method)
        mapping: dict[str, Any] = {}
        for ch in draft["characters"]:
            hit = _match(c.db, p, ch["name"])
            mapping[ch["name"]] = hit["id"] if hit else ("new" if create_missing_characters else "")
        out = import_apply(ep.id, ImportApplyIn(draft=draft["draft"], mapping=mapping, create_missing=create_missing_characters),
                           c.user, c.db)
        return {"scenes": draft["stats"].get("scenes"), "shots": draft["stats"].get("shots"), "method": draft.get("method"),
                "characters": out["characters"], "created": out["created"],
                "next": "Review with get_script / get_storyboard. Improve with critique_script + improve_script or "
                        "save_script; then plan_scenes and build_bible."}


def write_script(project_id: ProjectId,
                 instructions: Annotated[str, Field(description="What the script should do, tone, must-haves")] = "",
                 episode: EpisodeNo = None, confirm: Confirm = False) -> dict:
    """Have Tatvam's writer write the whole script from the brief (and the chosen hook). Replaces the current script
    (it stays as a version)."""
    with call("write") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        out = director(c, p, ep, "write_script", {"instructions": instructions}, confirm=confirm)
        if out.get("status") == "needs_confirmation":
            return out
        return {**_script_out(c, ep, False), "next": "critique_script to review it, or plan_scenes to go on."}


def critique_script(project_id: ProjectId, episode: EpisodeNo = None) -> dict:
    """Have the script editor review the script: scores (hook, structure, dialogue, pacing…), strengths, specific
    problems with scene/line references, and rewrite instructions. Nothing is changed."""
    with call("write") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        if not (ep.script or {}).get("scenes"):
            raise ToolError("There is no script yet: import_script, save_script or write_script first.")
        report = studio.critique(c.db, c.user, ep)
        studio.save_script_version(c.db, ep, "critic", c.user, note=f"Critic score {report['overall']}", critic=report)
        c.db.commit()
        return report


def improve_script(project_id: ProjectId,
                   notes: Annotated[str, Field(description="Your own notes for the rewrite (optional)")] = "",
                   use_critic: Annotated[bool, Field(description="Also fix what the script editor found")] = True,
                   episode: EpisodeNo = None) -> dict:
    """One rewrite pass: the script editor reviews the script (unless use_critic=false), then the writer rewrites it
    fixing those problems and your notes. The previous script stays as a version (restore_script). Call again for
    another pass, and critique_script to see the new score."""
    with call("write") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        if not (ep.script or {}).get("scenes"):
            raise ToolError("There is no script yet: import_script, save_script or write_script first.")
        before = None
        instr = []
        if use_critic:
            report = studio.critique(c.db, c.user, ep)
            studio.save_script_version(c.db, ep, "critic", c.user, note=f"Critic score {report['overall']}", critic=report)
            before = report["overall"]
            instr.append(f"Script editor notes — fix ALL of these:\n{report['rewrite_instructions']}\n"
                         f"Problems: {'; '.join(report['problems'])}\nKeep what works: {'; '.join(report['strengths'])}")
        if notes:
            instr.append(f"Director's notes (highest priority):\n{notes}")
        if not instr:
            raise ToolError("Give notes, or keep use_critic=true, so the writer knows what to change.")
        old = dict(ep.script or {})
        studio.generate_script(c.db, c.user, ep, instructions="\n\n".join(instr))  # keeps the old one as a version
        shots = c.db.query(Shot).filter(Shot.episode_id == ep.id, Shot.include.is_(True)).count()
        out = _script_out(c, ep, False)
        out.update(score_before=before, changed=old != (ep.script or {}),
                   next=("The shot list was made from the earlier script: re-plan it with breakdown_shots(confirm=true) "
                         "when you are happy with the script.") if shots else "critique_script for the new score, or plan_scenes.")
        return out


def polish_dialogue(project_id: ProjectId, language: Lang = "", episode: EpisodeNo = None) -> dict:
    """A native speaker's pass over the dialogue in one language so it sounds natural, not translated."""
    with call("write") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        lang = language or p.primary_language
        if lang not in catalog.LANGUAGES:
            raise ToolError(f"Unknown language {language}; use one of {list(catalog.LANGUAGES)}")
        return {"language": lang, "lines_polished": studio.native_polish(c.db, c.user, ep, lang)}


def restore_script(project_id: ProjectId, version: Annotated[int, Field(description="Version number from get_script")],
                   episode: EpisodeNo = None) -> dict:
    """Bring back an earlier version of the script (the current one is kept as a version too)."""
    with call("write") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        row = c.db.query(ScriptVersion).filter(ScriptVersion.episode_id == ep.id, ScriptVersion.version == int(version)).first()
        if row is None:
            raise ToolError(f"No version {version}; see get_script for the list.")
        studio.restore_script_version(c.db, c.user, ep, row.id)
        return _script_out(c, ep, False)


def generate_hooks(project_id: ProjectId, n: int = 6, angle: str = "", episode: EpisodeNo = None,
                   confirm: Confirm = False) -> dict:
    """Write N options for the opening seconds (scored). Pick one with select_hook before write_script."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "generate_hooks", {"n": max(2, min(int(n), 12)), "angle": angle},
                        confirm=confirm)


def select_hook(project_id: ProjectId, index: int, episode: EpisodeNo = None, confirm: Confirm = False) -> dict:
    """Choose the opening hook by its index (from generate_hooks)."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "select_hook", {"index": int(index)}, confirm=confirm)


def plan_series(project_id: ProjectId, episodes: int = 5, confirm: Confirm = False) -> dict:
    """Plan a season for a series project: logline, arc and one outline per episode."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p), "plan_series", {"episodes": int(episodes)}, confirm=confirm)


# ── scenes ───────────────────────────────────────────────────────────────────

def _scene_out(c, p: Project, sc: Scene, with_shots: bool = True) -> dict:
    loc = c.db.get(Location, sc.location_id) if sc.location_id else None
    out: dict[str, Any] = {
        "scene": sc.order + 1, "title": sc.title, "location": loc.name if loc else None, "time_of_day": sc.time_of_day,
        "summary": sc.summary, "goal": sc.goal, "conflict": sc.conflict, "turn": sc.turn, "emotion": sc.emotion,
        "characters": names(c.db, sc.characters), "wardrobe": wardrobe_by_name(c.db, sc.wardrobe), "props": sc.props or [],
        "continuity_notes": sc.continuity_notes, "blocking": sc.blocking, "coverage": sc.coverage or [],
        "approved": sc.approved, "end_state": sc.end_state or None}
    if with_shots:
        shots = scene_chain.scene_shots(c.db, sc)
        out["shots"] = [{"code": s.code, "keyframe": is_real(current(c.db, s.id, "keyframe")),
                         "video": is_real(current(c.db, s.id, "video")),
                         "link": (ls := scene_chain.link_status(c.db, s)) and f"{ls['mode']} from {ls['from']}: {ls['status']}"}
                        for s in shots]
    return out


def list_scenes(project_id: ProjectId, episode: EpisodeNo = None) -> dict:
    """Every scene in order: scene card (goal, conflict, turn, emotion, blocking, coverage), wardrobe, props, the
    Continuity Bible end state, and its shots with keyframe / video / link status."""
    with call("read") as c:
        p = c.project(project_id)
        return {"scenes": [_scene_out(c, p, sc) for sc in c.scenes(c.episode(p, episode))]}


def plan_scenes(project_id: ProjectId, episode: EpisodeNo = None, confirm: Confirm = False) -> dict:
    """Write a scene card for every script scene: goal, conflict, turn, emotion, who is in it, wardrobe, props,
    continuity notes, blocking and a coverage plan (which shots to film). The shot breakdown follows these cards."""
    with call("write") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        planned = [s for s in c.scenes(ep) if s.goal or s.approved]
        if planned and not confirm:
            return {"status": "needs_confirmation", "what": "Re-plan the scene cards",
                    "detail": f"{len(planned)} scenes already have cards"
                              f"{' (some approved)' if any(s.approved for s in planned) else ''}; this rewrites them.",
                    "next": "Ask the user; call again with confirm=true if they agree, or edit one with update_scene."}
        studio.plan_scene_cards(c.db, c.user, ep)
        return {"scenes": [_scene_out(c, p, sc, with_shots=False) for sc in c.scenes(ep)],
                "next": "Adjust a card with update_scene (approved cards are kept when shots are re-planned); then "
                        "build_bible and breakdown_shots."}


class SceneChanges(BaseModel):
    title: str | None = None
    summary: str | None = None
    goal: str | None = None
    conflict: str | None = None
    turn: str | None = None
    emotion: str | None = None
    time_of_day: str | None = None
    location: str | None = Field(default=None, description="A saved location's name")
    characters: list[str] | None = Field(default=None, description="Cast names in the scene")
    wardrobe: dict[str, str] | None = Field(default=None, description="{character name: outfit} for this scene")
    props: list[str] | None = None
    continuity_notes: str | None = None
    blocking: str | None = None
    coverage: list[str] | None = Field(default=None, description="Planned shots, e.g. 'wide: establish the courtyard'")
    approved: bool | None = Field(default=None, description="Approved cards are kept when the shot list is re-planned")


def update_scene(project_id: ProjectId, scene: SceneNo, changes: SceneChanges, episode: EpisodeNo = None) -> dict:
    """Edit a scene card. Changing the scene wardrobe or props flags the keyframes / videos of shots that use them."""
    from ..api.room import ScenePatch, patch_scene

    with call("write") as c:
        p = c.project(project_id)
        sc = c.scene(c.episode(p, episode), scene)
        data = changes.model_dump(exclude_unset=True)
        if "location" in data:
            loc_name = data.pop("location")
            data["location_id"] = location(c.db, p, loc_name).id if loc_name else None
        if "characters" in data:
            data["characters"] = [character(c.db, p, n).id for n in data.pop("characters") or []]
        if "wardrobe" in data:
            data["wardrobe"] = {str(character(c.db, p, n).id): o for n, o in (data.pop("wardrobe") or {}).items()}
        patch_scene(sc.id, ScenePatch(**data), c.user, c.db)
        c.db.refresh(sc)
        return _scene_out(c, p, sc)


# ── cast & places ────────────────────────────────────────────────────────────

def build_bible(project_id: ProjectId, episode: EpisodeNo = None, confirm: Confirm = False) -> dict:
    """Create the characters and locations the script needs (with look descriptions) and the visual style."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "build_bible", {}, confirm=confirm)


def get_cast(project_id: ProjectId) -> dict:
    """The cast (look description, Character Lock, costumes, reference images, voices) and the locations."""
    from ..core import lock as lock_core

    with call("read") as c:
        p = c.project(project_id)
        chars = []
        for ch in studio.cast(c.db, p):
            assets = c.db.query(CharacterAsset).filter(CharacterAsset.character_id == ch.id, CharacterAsset.archived.is_(False)).all()
            chars.append({"name": ch.name, "role": ch.role, "age": ch.age, "look": ch.dna_text, "personality": ch.personality,
                          "voice": ch.voice_description, "pronunciation": ch.name_pronunciation, "locked": ch.locked,
                          "lock": lock_core.effective(ch), "version": ch.version,
                          "costumes": [{"name": k.name, "description": k.description, "episodes": [k.episode_from, k.episode_to]}
                                       for k in c.db.query(Costume).filter(Costume.character_id == ch.id, Costume.archived.is_(False)).all()],
                          "reference_images": len(assets), "approved_images": sum(1 for a in assets if a.approved),
                          "voices": [v.language for v in c.db.query(VoiceProfile).filter(VoiceProfile.character_id == ch.id).all()]})
        locs = [{"name": l.name, "description": l.description_text} for l in studio.locations(c.db, p)]
        return {"characters": chars, "locations": locs}


def lock_character(project_id: ProjectId, character_name: Annotated[str, Field(description="Cast member's name")],
                   lock: Annotated[dict[str, Any], Field(description="face, body, skin_hair, voice, costume_continuity "
                                                                     "(true/false); gestures, age, lighting (text); strictness 0-1")]) -> dict:
    """Set a character's Character Lock: what must never change between shots. It goes into every prompt and QC."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p), "lock_character", {"character": character_name, "lock": lock})


def add_costume(project_id: ProjectId, character_name: str, name: str, description: str = "",
                episode_from: int | None = None, episode_to: int | None = None,
                generate_images: Annotated[bool, Field(description="Make the 3-angle turnaround (paid images, proposed first)")] = True,
                run_now: RunNow = False) -> dict:
    """Give a character a named outfit for an episode range, with a 3-angle reference turnaround."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p), "add_costume",
                        {"character": character_name, "name": name, "description": description, "episode_from": episode_from,
                         "episode_to": episode_to, "generate": generate_images}, run_now=run_now)


def set_outfit(project_id: ProjectId, character_name: str, outfit: str, description: str = "",
               regenerate_keyframes: bool = True, episode: EpisodeNo = None, run_now: RunNow = False) -> dict:
    """Put a character in a new outfit for this episode's shots (and propose their new keyframes)."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p, episode), "set_outfit",
                        {"character": character_name, "outfit": outfit, "description": description,
                         "regenerate_keyframes": regenerate_keyframes}, run_now=run_now)


def freeze_look(project_id: ProjectId, character_name: str, label: str = "", episode_from: int | None = None,
                episode_to: int | None = None, look: str = "", voice: str = "") -> dict:
    """Freeze a character's current look as a version for an episode range (older, new hairstyle, a beard…)."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p), "freeze_look",
                        {"character": character_name, "label": label, "episode_from": episode_from,
                         "episode_to": episode_to, "dna_text": look, "voice_description": voice})


def set_dialogue_route(project_id: ProjectId,
                       method: Annotated[str, Field(description="native (Veo speaks the line), native_when_possible, "
                                                                "audio_first (locked voice + lip-sync), audio_driven, voice_lock")],
                       native_languages: list[str] | None = None) -> dict:
    """How dialogue is made for this project, and which languages Veo may speak itself."""
    with call("write") as c:
        p = c.project(project_id)
        return director(c, p, c.episode(p), "set_dialogue_route", {"method": method, "native_languages": native_languages})


# ── continuity bible ─────────────────────────────────────────────────────────

def get_continuity(project_id: ProjectId, episode: EpisodeNo = None) -> dict:
    """The Continuity Bible: each scene's end state (outfits, physical state, props in hand, time of day, weather),
    the wardrobe timeline with unexplained outfit changes, every shot-to-shot link with its status (ok / waiting /
    broken), and the last continuity check."""
    with call("read") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        links = []
        for s in c.db.query(Shot).filter(Shot.episode_id == ep.id, Shot.include.is_(True)).order_by(Shot.order).all():
            ls = scene_chain.link_status(c.db, s)
            if ls:
                links.append({"shot": s.code, **ls})
        wardrobe = continuity.wardrobe_timeline(c.db, p, ep)
        return {"scenes": [{"scene": sc.order + 1, "title": sc.title, "wardrobe": wardrobe_by_name(c.db, sc.wardrobe),
                            "end_state": sc.end_state or None} for sc in c.scenes(ep)],
                "wardrobe": [{"character": w["name"], "scenes": [{"scene": r["order"] + 1, "outfit": r["outfit"],
                                                                   "break": r["break"]} for r in w["scenes"]]}
                             for w in wardrobe["characters"]],
                "wardrobe_breaks": wardrobe["breaks"], "links": links,
                "broken_links": [l["shot"] for l in links if l["status"] == "broken"],
                "last_check": ep.continuity or None}


def continuity_state(project_id: ProjectId, scene: SceneNo, episode: EpisodeNo = None) -> dict:
    """Have the continuity supervisor write the state at the END of a scene (from the script and the scene before):
    the next scene's prompts carry it forward. Replaces an earlier AI state; hand-edited states are kept unless you
    edit them with edit_end_state."""
    with call("write") as c:
        p = c.project(project_id)
        ep = c.episode(p, episode)
        sc = c.scene(ep, scene)
        if (sc.end_state or {}).get("source") == "manual":
            return {"kept": True, "end_state": sc.end_state,
                    "note": "This end state was written by hand; change it with edit_end_state."}
        return {"scene": scene, "end_state": continuity.end_state(c.db, c.user, p, ep, sc)}


def edit_end_state(project_id: ProjectId, scene: SceneNo,
                   characters: Annotated[dict[str, dict[str, str]] | None, Field(
                       description="{character name: {outfit, state}} at the end of the scene")] = None,
                   props: list[str] | None = None, time_of_day: str | None = None, weather: str | None = None,
                   notes: str | None = None, episode: EpisodeNo = None) -> dict:
    """Correct a scene's end state by hand (kept from then on; AI runs will not overwrite it)."""
    with call("write") as c:
        p = c.project(project_id)
        sc = c.scene(c.episode(p, episode), scene)
        state = dict(sc.end_state or {})
        if characters is not None:
            chars = dict(state.get("characters") or {})
            for n, v in characters.items():
                ch = character(c.db, p, n)
                chars[str(ch.id)] = {"name": ch.name, "outfit": v.get("outfit", ""), "state": v.get("state", "")}
            state["characters"] = chars
        for k, v in (("props", props), ("time_of_day", time_of_day), ("weather", weather), ("notes", notes)):
            if v is not None:
                state[k] = v
        state["source"] = "manual"
        sc.end_state = state
        c.db.commit()
        return {"scene": scene, "end_state": state}


def continuity_check(project_id: ProjectId, episode: EpisodeNo = None) -> dict:
    """The continuity supervisor reads the scene cards and the shot list and lists problems (wrong outfit, prop that
    appears from nowhere, time-of-day jumps…) with fixes."""
    with call("write") as c:
        p = c.project(project_id)
        return studio.continuity_check(c.db, c.user, c.episode(p, episode))


TOOLS = [
    (list_projects, "List projects", READ), (create_project, "Create a project", EDIT),
    (get_project, "Project overview", READ), (update_brief, "Edit the brief", EDIT),
    (get_script, "Read the script", READ), (save_script, "Save a script", REPLACE),
    (import_script, "Import a script", REPLACE), (write_script, "Write the script with AI", REPLACE),
    (critique_script, "Critique the script", EDIT), (improve_script, "Improve the script", REPLACE),
    (polish_dialogue, "Polish dialogue", EDIT), (restore_script, "Restore a script version", REPLACE),
    (generate_hooks, "Write opening hooks", EDIT), (select_hook, "Choose a hook", EDIT),
    (plan_series, "Plan a season", REPLACE),
    (list_scenes, "List scenes", READ), (plan_scenes, "Plan scene cards", REPLACE), (update_scene, "Edit a scene", EDIT),
    (build_bible, "Create cast & places", EDIT), (get_cast, "Cast & locations", READ),
    (lock_character, "Lock a character", EDIT), (add_costume, "Add a costume", EDIT), (set_outfit, "Change an outfit", EDIT),
    (freeze_look, "Freeze a character look", EDIT), (set_dialogue_route, "Dialogue route", EDIT),
    (get_continuity, "Continuity Bible", READ), (continuity_state, "Write a scene end state", EDIT),
    (edit_end_state, "Edit a scene end state", EDIT), (continuity_check, "Continuity check", EDIT),
]


# ── resources (readable documents, e.g. @-mentioned in Claude Code) ──────────

def screenplay_text(project_id: str) -> str:
    """The episode-1 script as a readable screenplay (Markdown)."""
    with call("read") as c:
        p = c.project(int(project_id))
        ep = c.episode(p)
        s = mentions.plain_script(ep.script or {})
        out = [f"# {p.title} — episode {ep.number}", "", f"*{s.get('logline', '')}*", ""]
        for i, sc in enumerate(s.get("scenes") or [], 1):
            out += [f"## Scene {i}: {sc.get('title', '')}", f"**{sc.get('location', '')}** — {sc.get('time_of_day', '')}", "",
                    sc.get("summary", ""), ""]
            if sc.get("action"):
                out += [f"_{sc['action']}_", ""]
            for ln in sc.get("lines") or []:
                emo = f" ({ln['emotion']})" if ln.get("emotion") else ""
                out.append(f"**{ln.get('character', '')}**{emo}: {ln.get('line', '')}  ")
            out.append("")
        return "\n".join(out)


def continuity_text(project_id: str) -> str:
    """The Continuity Bible of episode 1 (Markdown): each scene's wardrobe and end state."""
    with call("read") as c:
        p = c.project(int(project_id))
        ep = c.episode(p)
        out = [f"# Continuity Bible — {p.title}, episode {ep.number}", ""]
        for sc in c.scenes(ep):
            st = sc.end_state or {}
            out += [f"## Scene {sc.order + 1}: {sc.title}"]
            for who, outfit in wardrobe_by_name(c.db, sc.wardrobe).items():
                out.append(f"- wears: {who} — {outfit}")
            for ch in (st.get("characters") or {}).values():
                out.append(f"- end: {ch.get('name', '')} — {', '.join(x for x in (ch.get('outfit'), ch.get('state')) if x)}")
            for k in ("props", "time_of_day", "weather", "notes"):
                if st.get(k):
                    out.append(f"- {k.replace('_', ' ')}: {', '.join(st[k]) if isinstance(st[k], list) else st[k]}")
            if not st:
                out.append("- (no end state yet: continuity_state or generate_scenes writes it)")
            out.append("")
        return "\n".join(out)


RESOURCES = [
    ("tatvam://projects/{project_id}/screenplay", screenplay_text, "Screenplay", "text/markdown"),
    ("tatvam://projects/{project_id}/continuity", continuity_text, "Continuity Bible", "text/markdown"),
]
