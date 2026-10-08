"""Tools the Director agent can call. Same functions the UI uses, so the agent can do anything a person can."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from sqlalchemy.orm import Session

from .. import catalog
from ..core import budget, generation, jobs, studio
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
]
