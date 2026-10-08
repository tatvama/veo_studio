"""Tools the Director agent can call. Same functions the UI uses, so the agent can do anything a person can."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from sqlalchemy.orm import Session

from .. import catalog
from ..core import budget, continuity, dependencies, generation, jobs, lock as lock_core, studio
from ..models import Character, Episode, Project, Shot, User
from ..pipeline.selection import current


@dataclass
class AgentCtx:
    db: Session
    user: User
    project: Project
    episode: Episode | None
    proposals: list[dict] = field(default_factory=list)
    actions: list[str] = field(default_factory=list)
    confirmations: list[dict] = field(default_factory=list)  # actions waiting for the user's OK (would replace work)
    confirmed: bool = False  # set when the user pressed "Yes, do it" on one of those

    @property
    def copilot(self) -> bool:
        return self.project.agent_mode != "autopilot"

    def ep(self) -> Episode:
        if self.episode is None:
            self.episode = (self.db.query(Episode).filter(Episode.project_id == self.project.id)
                            .order_by(Episode.number).first())
            if self.episode is None:
                self.episode = Episode(project_id=self.project.id, number=1, title="Episode 1")
                self.db.add(self.episode)
                self.db.commit()
        return self.episode

    def shots(self, codes: list[str] | None = None) -> list[Shot]:
        return generation.episode_shots(self.db, self.ep(), codes=[c.upper() for c in codes] if codes else None)

    def submit(self, specs: list[dict], what: str) -> dict:
        if not specs:
            return {"status": "nothing_to_do", "message": f"No {what} needed."}
        res = jobs.submit(self.db, self.user, self.project, specs, propose=self.copilot)
        entry = {"batch_id": res["batch_id"], "status": res["status"], "total_usd": res["total_usd"], "what": what,
                 "count": len(res["jobs"]), "reason": res.get("reason", "")}
        if res["status"] == "proposed":
            self.proposals.append(entry)
        self.actions.append(f"{what}: {res['status']} ({len(res['jobs'])} jobs, ${res['total_usd']:.2f})")
        return entry


def _shot_brief(db: Session, s: Shot, lang: str) -> dict:
    kf, vid = current(db, s.id, "keyframe"), current(db, s.id, "video")
    return {"code": s.code, "dur": s.duration_s, "framing": s.framing, "action": s.action[:120],
            "lines": len((s.dialogue or {}).get(lang) or []), "keyframe": bool(kf), "video": bool(vid),
            "qc": (vid.qc or {}).get("identity_match") if vid else None, "status": s.status}


# ── tool implementations ─────────────────────────────────────────────────────

def get_project_state(c: AgentCtx) -> dict:
    p, ep = c.project, c.ep()
    db = c.db
    return {
        "project": {"title": p.title, "type": p.type, "aspect": p.aspect, "languages": p.languages,
                    "primary_language": p.primary_language, "quality_mode": p.quality_mode, "agent_mode": p.agent_mode},
        "brief": {k: (p.brief or {}).get(k) for k in ("duration_s", "tone", "audience", "key_message")},
        "episode": {"number": ep.number, "title": ep.title, "hooks": len(ep.hooks or []),
                    "selected_hook": ((ep.hooks or [])[ep.selected_hook]["text"] if ep.selected_hook is not None and ep.hooks else None),
                    "script_scenes": len((ep.script or {}).get("scenes", []))},
        "cast": [{"name": ch.name, "locked": ch.locked} for ch in studio.cast(db, p)],
        "locations": [l.name for l in studio.locations(db, p)],
        "shots": [_shot_brief(db, s, p.primary_language) for s in c.shots()][:60],
        "budget": budget.team_status(db),
        "project_spent_usd": round(budget.spent(db, project_id=p.id), 4),
    }


def update_brief(c: AgentCtx, fields: dict | None = None, **kw) -> dict:
    fields = {**(fields or {}), **kw}
    allowed = {"title", "audience", "tone", "duration_s", "key_message", "cta", "notes", "platform"}
    upd = {k: v for k, v in fields.items() if k in allowed}
    if "title" in upd:
        c.project.title = str(upd.pop("title"))[:200]
    c.project.brief = {**(c.project.brief or {}), **upd}
    c.db.commit()
    c.actions.append("brief updated")
    return {"brief": c.project.brief}


def generate_hooks(c: AgentCtx, n: int = 6, angle: str = "") -> dict:
    hooks = studio.generate_hooks(c.db, c.user, c.ep(), int(n or 6), angle or "")
    c.actions.append(f"{len(hooks)} hooks written")
    return {"hooks": [{"index": i, "text": h["text"], "total": h["total"]} for i, h in enumerate(hooks)]}


def select_hook(c: AgentCtx, index: int = 0) -> dict:
    studio.select_hook(c.db, c.ep(), int(index))
    c.actions.append(f"hook #{index} selected")
    return {"ok": True}


def write_script(c: AgentCtx, instructions: str = "") -> dict:
    sc = studio.generate_script(c.db, c.user, c.ep(), instructions or "")
    c.actions.append("script written")
    return {"logline": sc.get("logline"), "scenes": len(sc.get("scenes", []))}


def plan_series(c: AgentCtx, episodes: int = 5) -> dict:
    story = studio.generate_series_arc(c.db, c.user, c.project, int(episodes or 5))
    c.actions.append("season planned")
    return {"logline": story.get("logline"), "episodes": [e["title"] for e in story.get("episodes", [])]}


def build_bible(c: AgentCtx) -> dict:
    r = studio.propose_bible(c.db, c.user, c.project, c.ep())
    c.actions.append("bible proposed")
    return r


def breakdown_shots(c: AgentCtx) -> dict:
    shots = studio.breakdown(c.db, c.user, c.ep())
    c.actions.append(f"{len(shots)} shots planned")
    return {"shots": [s["code"] for s in shots], "total_seconds": sum(s["duration_s"] for s in shots)}


def update_shot(c: AgentCtx, shot_code: str, changes: dict | None = None, **kw) -> dict:
    changes = {**(changes or {}), **kw}
    shots = c.shots([shot_code])
    if not shots:
        return {"error": f"No shot {shot_code}"}
    s = shots[0]
    studio.save_revision(c.db, "shot", s, studio.SHOT_FIELDS, c.user)
    for k in ("framing", "camera", "action", "sfx", "music_cue", "mode", "quality_mode", "voice_mode", "notes"):
        if k in changes:
            setattr(s, k, str(changes[k]))
    if "duration_s" in changes and int(changes["duration_s"]) in (4, 6, 8):
        s.duration_s = int(changes["duration_s"])
    if "include" in changes:
        s.include = bool(changes["include"])
    c.db.commit()
    c.actions.append(f"{s.code} updated")
    return {"shot": _shot_brief(c.db, s, c.project.primary_language)}


def set_outfit(c: AgentCtx, character: str, outfit: str, description: str = "", regenerate_keyframes: bool = True) -> dict:
    ch = next((x for x in studio.cast(c.db, c.project) if x.name.lower() == character.lower()), None)
    if not ch:
        return {"error": f"No character named {character}"}
    specs = [generation.outfit_spec(c.db, c.project.id, ch, outfit, description or outfit, c.ep().number)]
    affected = []
    for s in c.shots():
        if ch.id in [int(i) for i in (s.characters or [])]:
            s.outfits = {**(s.outfits or {}), str(ch.id): outfit}
            affected.append(s)
    c.db.commit()
    if regenerate_keyframes:
        specs += generation.keyframe_specs(c.db, c.project, affected)
    r = c.submit(specs, f"outfit '{outfit}' for {ch.name} + {len(affected)} keyframes")
    return {**r, "shots": [s.code for s in affected]}


def generate_keyframes(c: AgentCtx, shot_codes: list[str] | None = None) -> dict:
    shots = c.shots(shot_codes or None)
    return c.submit(generation.keyframe_specs(c.db, c.project, shots, only_missing=not shot_codes), "keyframes")


def generate_videos(c: AgentCtx, shot_codes: list[str] | None = None, quality: str = "") -> dict:
    q = quality if quality in catalog.QUALITY_MODES else None
    shots = c.shots(shot_codes or None)
    return c.submit(generation.video_specs(c.db, c.project, shots, q, only_missing=not shot_codes), f"videos ({q or 'project default'})")


def voice_and_lipsync(c: AgentCtx, language: str = "", shot_codes: list[str] | None = None) -> dict:
    lang = language or c.project.primary_language
    shots = c.shots(shot_codes or None)
    need = [s for s in shots if budget.Estimator.needs_lipsync(s, c.project, lang)]
    narr = [s for s in shots if (s.narration or {}).get(lang) and s not in need]
    specs = generation.lipsync_specs(c.db, c.project, need, lang) + generation.voice_specs(c.db, c.project, narr, lang)
    return c.submit(specs, f"voices & lip-sync [{lang}]")


def generate_music(c: AgentCtx, prompt: str = "") -> dict:
    return c.submit([generation.music_spec(c.db, c.project, c.ep(), prompt or "")], "music")


def make_animatic(c: AgentCtx, language: str = "") -> dict:
    lang = language or c.project.primary_language
    res = jobs.submit(c.db, c.user, c.project, [generation.render_spec(c.project, c.ep(), lang, "animatic", "draft")])
    c.actions.append(f"animatic [{lang}] queued")
    return {"status": res["status"], "batch_id": res["batch_id"]}


def dub_episode(c: AgentCtx, language: str) -> dict:
    lang = language.lower()[:2] if language.lower()[:2] in catalog.LANGUAGES else next(
        (k for k, v in catalog.LANGUAGES.items() if v["name"].lower() == language.lower()), "")
    if not lang:
        return {"error": f"Unknown language {language}. Use one of {list(catalog.LANGUAGES)}"}
    return c.submit([generation.dub_spec(c.db, c.project, c.ep(), lang)], f"dub → {catalog.LANGUAGES[lang]['name']}")


def export_video(c: AgentCtx, language: str = "", preset: str = "") -> dict:
    lang = language or c.project.primary_language
    preset = preset if preset in catalog.EXPORT_PRESETS else ("youtube" if c.project.aspect == "16:9" else "shorts")
    res = jobs.submit(c.db, c.user, c.project, [generation.render_spec(c.project, c.ep(), lang, "final", preset, {"captions": True})])
    c.actions.append(f"export [{lang}/{preset}] queued")
    return {"status": res["status"], "batch_id": res["batch_id"]}


def edit_clip(c: AgentCtx, shot_code: str, instruction: str) -> dict:
    shots = c.shots([shot_code])
    if not shots:
        return {"error": f"No shot {shot_code}"}
    take = current(c.db, shots[0].id, "video")
    if not take:
        return {"error": f"{shot_code} has no video to edit"}
    return c.submit([generation.omni_edit_spec(c.db, c.project, take, instruction)], f"edit {shot_code}")


def make_cutdowns(c: AgentCtx, count: int = 3, seconds: int = 30) -> dict:
    ids = studio.make_cutdowns(c.db, c.user, c.ep(), int(count or 3), int(seconds or 30))
    c.actions.append(f"{len(ids)} cut-downs created")
    return {"cutdown_episode_ids": ids}


def start_autopilot(c: AgentCtx, through: str = "final") -> dict:
    from ..core import autopilot as ap_def
    est = generation.autopilot_estimate(c.db, c.project, c.ep())
    label = ap_def.MILESTONE_BY_ID.get(through, {}).get("label") or ap_def.STAGE_LABELS.get(through, through)
    spec = jobs.spec("autopilot", payload={"through": through}, project_id=c.project.id, episode_id=c.ep().id,
                     estimate=est, label=f"Autopilot → {label}")
    return c.submit([spec], f"autopilot through '{through}'")


# ── confirmation for actions that replace work ───────────────────────────────
# Free actions run at once, but these would overwrite or pile onto what the user already has, so the Director asks
# first (in both approval modes: this is about the user's work, not money).

def _char(c: AgentCtx, name: str) -> Character:
    low = (name or "").strip().lower()
    for ch in studio.cast(c.db, c.project):
        if ch.name.strip().lower() == low or ch.name.strip().lower().split()[0] == low.split()[0]:
            return ch
    raise ValueError(f"No cast member called {name!r}")


def continuity_state(c: AgentCtx, scene_number: int = 1) -> dict:
    """Write the Continuity Bible entry (state at the end of a scene) with AI."""
    from ..models import Scene
    sc = (c.db.query(Scene).filter(Scene.episode_id == c.ep().id).order_by(Scene.order, Scene.id).all())
    if not sc or scene_number < 1 or scene_number > len(sc):
        return {"error": f"There are {len(sc)} scenes; pick 1..{len(sc)}"}
    state = continuity.end_state(c.db, c.user, c.project, c.ep(), sc[scene_number - 1])
    c.actions.append(f"continuity state written for scene {scene_number}")
    return state


def wardrobe_report(c: AgentCtx) -> dict:
    """Who wears what in every scene, and where an outfit changes without the script saying so."""
    return continuity.wardrobe_timeline(c.db, c.project, c.ep())


def impact_report(c: AgentCtx) -> dict:
    """Everything stale after recent edits (keyframes, videos, voices, lip-syncs) and what redoing it costs."""
    return dependencies.impact(c.db, c.project, c.ep())


def regenerate_stale(c: AgentCtx, shot_codes: list[str] | None = None) -> dict:
    ids = [s.id for s in c.shots(shot_codes)] if shot_codes else None
    specs = dependencies.regenerate_specs(c.db, c.project, c.ep(), ids)
    return c.submit(specs, "regenerate stale takes")


def next_shot(c: AgentCtx, shot_code: str, action: str = "", mode: str = "last_frame", generate: bool = False) -> dict:
    """Add the shot after `shot_code` with the same cast/wardrobe/location, linked by last frame or as an extension."""
    src = next((s for s in c.shots([shot_code])), None)
    if not src:
        return {"error": f"No shot {shot_code}"}
    n = studio.add_next_shot(c.db, src, action, mode=mode)
    c.db.commit()
    c.actions.append(f"added {n.code} after {src.code} ({mode})")
    out: dict = {"shot": _shot_brief(c.db, n, c.project.primary_language), "code": n.code}
    if generate:
        out["jobs"] = c.submit(generation.video_specs(c.db, c.project, [n]), f"video {n.code}")
    return out


def lock_character(c: AgentCtx, character: str, lock: dict | None = None, **kw) -> dict:
    """Set the Character Lock (face, body, skin_hair, voice, costume_continuity, gestures, age, lighting, strictness)."""
    ch = _char(c, character)
    data = {**(lock or {}), **kw}
    ch.lock = {k: v for k, v in {**(ch.lock or {}), **data}.items() if k in lock_core.DEFAULT}
    c.db.commit()
    c.actions.append(f"lock updated for {ch.name}")
    return {"character": ch.name, "lock": lock_core.effective(ch), "prompt_text": lock_core.prompt_text(ch)}


def freeze_look(c: AgentCtx, character: str, label: str = "", episode_from: int | None = None, episode_to: int | None = None,
                dna_text: str = "", voice_description: str = "") -> dict:
    """Freeze the character's current look as a version for a range of episodes (how a character ages or changes)."""
    from ..models import CharacterAsset, CharacterVersion
    ch = _char(c, character)
    last = (c.db.query(CharacterVersion).filter(CharacterVersion.character_id == ch.id)
            .order_by(CharacterVersion.version.desc()).first())
    approved = [a.id for a in c.db.query(CharacterAsset).filter(CharacterAsset.character_id == ch.id, CharacterAsset.archived.is_(False),
                                                               CharacterAsset.approved.is_(True)).all()]
    v = CharacterVersion(character_id=ch.id, version=(last.version + 1) if last else 1, label=label or f"v{(last.version + 1) if last else 1}",
                         episode_from=episode_from, episode_to=episode_to, dna_text=dna_text or ch.dna_text,
                         voice_description=voice_description or ch.voice_description, lock=dict(ch.lock or {}), asset_ids=approved,
                         identity=dict(ch.identity or {}), created_by=c.user.id)
    c.db.add(v)
    ch.version = v.version
    c.db.commit()
    c.actions.append(f"froze {ch.name} as {v.label}")
    return v.to_dict()


def add_costume(c: AgentCtx, character: str, name: str, description: str = "", episode_from: int | None = None,
                episode_to: int | None = None, generate: bool = True) -> dict:
    """Give a character a named outfit (3-angle turnaround generated when `generate`)."""
    from ..models import Costume
    ch = _char(c, character)
    row = c.db.query(Costume).filter(Costume.character_id == ch.id, Costume.name == name, Costume.archived.is_(False)).first()
    if row is None:
        row = Costume(character_id=ch.id, name=name)
        c.db.add(row)
    row.description, row.episode_from, row.episode_to = description, episode_from, episode_to
    c.db.commit()
    out: dict = {"costume": row.to_dict()}
    if generate:
        scope = episode_from if episode_from == episode_to else None
        out["jobs"] = c.submit([generation.outfit_spec(c.db, c.project.id, ch, name, description, scope)], f"outfit {name}")
    return out


def set_dialogue_route(c: AgentCtx, method: str = "native", native_languages: list[str] | None = None) -> dict:
    """How dialogue is made for this project: native (Veo speaks the line itself, voice + lips in one pass),
    audio_first (locked TTS voice + lip-sync), audio_driven, voice_lock."""
    if method not in ("native", "audio_first", "audio_driven", "voice_lock", "native_when_possible"):
        return {"error": "method must be native, audio_first, audio_driven, voice_lock or native_when_possible"}
    brief = dict(c.project.brief or {})
    brief["dialogue_method"] = method
    if native_languages is not None:
        brief["native_languages"] = [x for x in native_languages if x in catalog.LANGUAGES]
    c.project.brief = brief
    c.db.commit()
    c.actions.append(f"dialogue route: {method}")
    return {"dialogue_method": method, "native_languages": brief.get("native_languages")}


def _needs_confirmation(c: AgentCtx, name: str, args: dict) -> tuple[str, str] | None:
    """(what, detail) when running `name` now would replace existing work; None when it is safe to just do it."""
    ep = c.ep()
    scenes = len((ep.script or {}).get("scenes") or [])
    if name == "write_script" and scenes:
        return ("Rewrite the script",
                f"Replaces the current {scenes}-scene script. The old one stays in Story → Versions, so you can restore it.")
    if name == "breakdown_shots":
        n = len(c.shots())
        if n:
            return ("Re-plan the shot list",
                    f"Replaces the current {n} shots with a new plan. Shots that already have paid takes are dropped from the "
                    "cut, not deleted. To change a few shots, edit them instead.")
    if name == "generate_hooks" and ep.hooks:
        chosen = " and the one you chose" if ep.selected_hook is not None else ""
        return ("Write new hooks", f"Replaces the {len(ep.hooks)} current hooks{chosen}.")
    if name == "select_hook" and scenes and ep.selected_hook is not None and int(args.get("index", 0)) != ep.selected_hook:
        return ("Change the chosen hook", "The script was written for the current hook; you'd want to rewrite it afterwards.")
    if name == "plan_series" and (c.project.story or {}).get("logline"):
        return ("Re-plan the season", "Replaces the season logline, arc and episode outlines.")
    if name == "build_bible":
        cast = studio.cast(c.db, c.project)
        if cast:
            return ("Add characters & places from the script",
                    f"You already have {len(cast)} characters. This adds anyone in the script who isn't in the cast yet "
                    "(it can bring back a character you removed).")
    if name == "make_cutdowns":
        n, secs = int(args.get("count") or 3), int(args.get("seconds") or 30)
        return (f"Cut into {n} shorts", f"Creates {n} new cut-down episodes of about {secs}s each from this episode's shots.")
    return None


def run_tool(c: AgentCtx, name: str, args: dict) -> dict:
    """Run a tool, unless it would replace work: then queue a confirmation for the user and tell the model to wait."""
    fn = TOOL_FUNCS.get(name)
    if not fn:
        return {"error": f"unknown tool {name}"}
    if not c.confirmed:
        need = _needs_confirmation(c, name, args)
        if need:
            item = {"id": uuid.uuid4().hex[:12], "tool": name, "args": args, "episode_id": c.ep().id,
                    "what": need[0], "detail": need[1], "status": "pending"}
            c.confirmations.append(item)
            return {"status": "waiting_for_user_confirmation", "what": need[0], "detail": need[1],
                    "message": "Not done yet: this would replace the user's existing work, so a Confirm button is shown under "
                               "your reply. Do not call this tool again now. Tell the user briefly what would be replaced."}
    return fn(c, **args)


TOOL_FUNCS: dict[str, Callable[..., dict]] = {
    "get_project_state": get_project_state, "update_brief": update_brief, "generate_hooks": generate_hooks,
    "select_hook": select_hook, "write_script": write_script, "plan_series": plan_series, "build_bible": build_bible,
    "breakdown_shots": breakdown_shots, "update_shot": update_shot, "set_outfit": set_outfit,
    "generate_keyframes": generate_keyframes, "generate_videos": generate_videos, "voice_and_lipsync": voice_and_lipsync,
    "generate_music": generate_music, "make_animatic": make_animatic, "dub_episode": dub_episode,
    "export_video": export_video, "edit_clip": edit_clip, "make_cutdowns": make_cutdowns, "start_autopilot": start_autopilot,
    # v3: continuity, change impact, Film Map, Character Lab, dialogue route
    "continuity_state": continuity_state, "wardrobe_report": wardrobe_report, "impact_report": impact_report,
    "regenerate_stale": regenerate_stale, "next_shot": next_shot, "lock_character": lock_character, "freeze_look": freeze_look,
    "add_costume": add_costume, "set_dialogue_route": set_dialogue_route,
}

_codes = {"type": "array", "items": {"type": "string"}, "description": "Shot codes like E01-SH03. Empty = all that still need it."}
_lang = {"type": "string", "enum": list(catalog.LANGUAGES), "description": "en, hi, kn, te or ta"}


def _t(name: str, desc: str, props: dict | None = None, required: list[str] | None = None) -> dict:
    return {"type": "function", "name": name, "description": desc,
            "parameters": {"type": "object", "properties": props or {}, "required": required or []}}


TOOL_DECLS = [
    _t("get_project_state", "Read the current project, episode, cast, shots and budget."),
    _t("update_brief", "Change brief fields.", {"fields": {"type": "object", "description": "title, audience, tone, duration_s, key_message, cta, platform, notes"}}, ["fields"]),
    _t("generate_hooks", "Write N hook options for the opening seconds.", {"n": {"type": "integer"}, "angle": {"type": "string"}}),
    _t("select_hook", "Choose a hook by index.", {"index": {"type": "integer"}}, ["index"]),
    _t("write_script", "Write or rewrite the episode script.", {"instructions": {"type": "string"}}),
    _t("plan_series", "Plan a season (series projects).", {"episodes": {"type": "integer"}}),
    _t("build_bible", "Create characters, locations and style from the script."),
    _t("breakdown_shots", "Turn the script into a shot list (replaces existing shots)."),
    _t("update_shot", "Edit one shot.", {"shot_code": {"type": "string"}, "changes": {"type": "object",
        "description": "framing, camera, action, duration_s (4/6/8), quality_mode, voice_mode, mode, sfx, music_cue, include"}},
       ["shot_code", "changes"]),
    _t("set_outfit", "Give a character a new outfit in this episode and redo their keyframes.",
       {"character": {"type": "string"}, "outfit": {"type": "string"}, "description": {"type": "string"},
        "regenerate_keyframes": {"type": "boolean"}}, ["character", "outfit"]),
    _t("generate_keyframes", "Generate keyframe images (cheap).", {"shot_codes": _codes}),
    _t("generate_videos", "Generate videos for shots (paid).", {"shot_codes": _codes,
        "quality": {"type": "string", "enum": list(catalog.QUALITY_MODES)}}),
    _t("voice_and_lipsync", "Voice the dialogue/narration and lip-sync it (paid).", {"language": _lang, "shot_codes": _codes}),
    _t("generate_music", "Compose background music for the episode.", {"prompt": {"type": "string"}}),
    _t("make_animatic", "Render a cheap preview from keyframes + voices + music.", {"language": _lang}),
    _t("dub_episode", "Dub the whole episode into another language (adapt script, voices, lip-sync).", {"language": _lang}, ["language"]),
    _t("export_video", "Render the final video.", {"language": _lang, "preset": {"type": "string", "enum": list(catalog.EXPORT_PRESETS)}}),
    _t("edit_clip", "Edit a generated clip with a natural-language instruction (Gemini Omni).",
       {"shot_code": {"type": "string"}, "instruction": {"type": "string"}}, ["shot_code", "instruction"]),
    _t("make_cutdowns", "Cut the episode into N standalone shorts.", {"count": {"type": "integer"}, "seconds": {"type": "integer"}}),
    _t("start_autopilot", "Run the whole pipeline automatically up to a milestone: script, cast (scenes, characters, voices), "
       "storyboard (shot list + keyframes) or final (videos through the finished export).",
       {"through": {"type": "string", "enum": ["script", "cast", "storyboard", "final"]}}),
    # v3
    _t("continuity_state", "Write the Continuity Bible entry for a scene: who wears what, props in hand, time of day, weather at the END of it.",
       {"scene_number": {"type": "integer"}}, ["scene_number"]),
    _t("wardrobe_report", "Who wears what in every scene, with continuity breaks flagged."),
    _t("impact_report", "What became stale after edits (keyframes, videos, voices, lip-syncs) and the cost of redoing it."),
    _t("regenerate_stale", "Redo every stale take (paid).", {"shot_codes": _codes}),
    _t("next_shot", "Add the shot after a given one with the same cast, wardrobe and location, starting from its last frame or extending its clip.",
       {"shot_code": {"type": "string"}, "action": {"type": "string"}, "mode": {"type": "string", "enum": ["last_frame", "extend"]},
        "generate": {"type": "boolean"}}, ["shot_code"]),
    _t("lock_character", "Set a character's lock: face, body, skin_hair, voice, costume_continuity (booleans), gestures, age, lighting (text), strictness 0-1.",
       {"character": {"type": "string"}, "lock": {"type": "object"}}, ["character", "lock"]),
    _t("freeze_look", "Freeze a character's current look as a version for an episode range (older, new hairstyle, beard...).",
       {"character": {"type": "string"}, "label": {"type": "string"}, "episode_from": {"type": "integer"},
        "episode_to": {"type": "integer"}, "dna_text": {"type": "string"}, "voice_description": {"type": "string"}}, ["character"]),
    _t("add_costume", "Give a character a named outfit with a 3-angle turnaround (paid images).",
       {"character": {"type": "string"}, "name": {"type": "string"}, "description": {"type": "string"},
        "episode_from": {"type": "integer"}, "episode_to": {"type": "integer"}, "generate": {"type": "boolean"}}, ["character", "name"]),
    _t("set_dialogue_route", "Choose how dialogue is made: native (Veo speaks the line itself) or audio_first (locked voice + lip-sync), and which languages Veo may speak.",
       {"method": {"type": "string", "enum": ["native", "audio_first", "audio_driven", "voice_lock", "native_when_possible"]},
        "native_languages": {"type": "array", "items": {"type": "string"}}}, ["method"]),
]
