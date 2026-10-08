"""Writing-room operations (synchronous LLM calls, cheap): brief, hooks, script, series arc, bible, shot breakdown,
localisation, episode memory and cut-downs. Shared by the REST API, the Director agent and Autopilot."""
from __future__ import annotations

import json
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .. import catalog
from ..agents import prompts
from ..agents import schemas as S
from ..db import utcnow
from ..events import emit
from ..models import (Character, Episode, Location, Project, ProjectCast, ProjectLocation, Revision, Scene, ScriptVersion, Shot,
                      Style, Take, User)
from ..providers.services import Services
from . import budget


def _llm(db: Session, user: User | None, project: Project, task: str, system: str, prompt: str, schema, mock_ctx: dict,
         pro: bool = False):
    svc = Services()
    obj, usage = svc.llm_json(task, system, prompt, schema, pro=pro, mock_ctx=mock_ctx)
    budget.record_cost(db, usage, user_id=user.id if user else None, project_id=project.id, job_id=None)
    return obj


def lang_name(code: str) -> str:
    return catalog.LANGUAGES.get(code, {}).get("name", code)


def cast(db: Session, project: Project) -> list[Character]:
    ids = [r.character_id for r in db.query(ProjectCast).filter(ProjectCast.project_id == project.id).all()]
    return db.query(Character).filter(Character.id.in_(ids), Character.archived.is_(False)).order_by(Character.id).all() if ids else []


def locations(db: Session, project: Project) -> list[Location]:
    ids = [r.location_id for r in db.query(ProjectLocation).filter(ProjectLocation.project_id == project.id).all()]
    return db.query(Location).filter(Location.id.in_(ids), Location.archived.is_(False)).order_by(Location.id).all() if ids else []


def context_text(db: Session, project: Project, episode: Episode | None = None) -> str:
    b = project.brief or {}
    parts = [f"PROJECT: {project.title} ({project.type}, {project.aspect}). Concept: {project.concept}",
             f"Languages: primary {lang_name(project.primary_language)}; also {', '.join(lang_name(l) for l in project.languages)}."]
    if b:
        parts.append("BRIEF: " + json.dumps({k: b.get(k) for k in ("audience", "tone", "platform", "key_message", "cta", "duration_s")},
                                            ensure_ascii=False))
    st = project.story or {}
    if st.get("logline"):
        parts.append(f"SERIES: {st.get('logline')} ARC: {st.get('arc', '')}")
    chars = cast(db, project)
    if chars:
        parts.append("CAST: " + " | ".join(f"{c.name} ({c.role}): {c.dna_text}" for c in chars))
    locs = locations(db, project)
    if locs:
        parts.append("LOCATIONS: " + " | ".join(f"{l.name}: {l.description_text}" for l in locs))
    if episode and project.type == "series":
        prev = (db.query(Episode).filter(Episode.project_id == project.id, Episode.number < episode.number, Episode.kind == "episode")
                .order_by(Episode.number.desc()).first())
        if prev and prev.summary_for_next:
            parts.append(f"PREVIOUSLY (Episode {prev.number}): {prev.summary_for_next}")
        if episode.outline:
            parts.append(f"THIS EPISODE ({episode.number}) OUTLINE: {episode.outline}")
    return "\n".join(parts)


def target_duration(project: Project) -> int:
    return int((project.brief or {}).get("duration_s") or catalog.PROJECT_TYPES.get(project.type, {}).get("duration_s", 45))


# ── brief / arc / hooks / script ─────────────────────────────────────────────

def generate_brief(db: Session, user: User, project: Project) -> dict:
    prompt = (f"Write a production brief for this {catalog.PROJECT_TYPES.get(project.type, {}).get('label', project.type)}.\n"
              f"Concept: {project.concept}\nAspect: {project.aspect}. Languages: {', '.join(lang_name(l) for l in project.languages)}.\n"
              f"Target length about {target_duration(project)} seconds unless the concept says otherwise.")
    out = _llm(db, user, project, "brief", prompts.WRITER, prompt, S.BriefOut,
               {"concept": project.concept, "type": project.type, "aspect": project.aspect, "duration_s": target_duration(project)})
    brief = {**(project.brief or {}), **out.model_dump()}
    project.brief = brief
    if not project.title or project.title.lower().startswith("untitled"):
        project.title = out.title[:200]
    db.commit()
    emit(db, project.id, "project.updated", {"what": "brief"})
    return brief


def generate_series_arc(db: Session, user: User, project: Project, episodes: int = 5) -> dict:
    prompt = (f"{context_text(db, project)}\n\nPlan a season of {episodes} episodes, each {target_duration(project)} seconds. "
              "Each episode must end on a hook/cliffhanger. Give a logline, the season arc, and one-paragraph outlines.")
    out = _llm(db, user, project, "series_arc", prompts.WRITER, prompt, S.SeriesArcOut,
               {"concept": project.concept, "episodes": episodes}, pro=True)
    project.story = {**(project.story or {}), "logline": out.logline, "arc": out.arc,
                     "episodes": [e.model_dump() for e in out.episodes]}
    existing = {e.number: e for e in db.query(Episode).filter(Episode.project_id == project.id, Episode.kind == "episode").all()}
    for e in out.episodes:
        ep = existing.get(e.number)
        if ep is None:
            db.add(Episode(project_id=project.id, number=e.number, title=e.title, outline=e.outline))
        elif not ep.outline:
            ep.title, ep.outline = ep.title or e.title, e.outline
    db.commit()
    emit(db, project.id, "project.updated", {"what": "arc"})
    return project.story


def generate_hooks(db: Session, user: User, episode: Episode, n: int = 6, angle: str = "") -> list[dict]:
    project = db.get(Project, episode.project_id)
    learned = _hook_learnings(db)
    trends = (project.brief or {}).get("trends") or {}
    prompt = (f"{context_text(db, project, episode)}\n\nWrite {n} different hooks for the opening 1.5–3 seconds "
              f"in {lang_name(project.primary_language)}. {('Angle: ' + angle) if angle else ''}\n"
              f"{learned}"
              f"{('Current hook patterns that work: ' + '; '.join(trends.get('hook_patterns', []))) if trends else ''}")
    out = _llm(db, user, project, "hooks", prompts.HOOKS, prompt, S.HooksOut, {"concept": project.concept, "n": n})
    hooks = sorted([h.model_dump() for h in out.hooks], key=lambda h: -h["total"])
    episode.hooks = hooks
    episode.selected_hook = None
    db.commit()
    emit(db, project.id, "episode.updated", {"episode_id": episode.id, "what": "hooks"})
    return hooks


def select_hook(db: Session, episode: Episode, index: int | None = None, text: str | None = None) -> None:
    hooks = list(episode.hooks or [])
    if text:
        hooks.insert(0, {"text": text, "type": "custom", "visual": "", "scores": {}, "total": 0})
        index = 0
    if index is None or index >= len(hooks):
        raise HTTPException(400, "Invalid hook")
    episode.hooks = hooks
    episode.selected_hook = index
    db.commit()
    emit(db, episode.project_id, "episode.updated", {"episode_id": episode.id, "what": "hook"})


def generate_script(db: Session, user: User, episode: Episode, instructions: str = "") -> dict:
    project = db.get(Project, episode.project_id)
    hook = (episode.hooks or [])[episode.selected_hook] if episode.selected_hook is not None and episode.hooks else None
    prompt = (f"{context_text(db, project, episode)}\n\n"
              f"Write the full script for {'episode ' + str(episode.number) if project.type == 'series' else 'this video'} "
              f"in {lang_name(project.primary_language)} (dialogue in {lang_name(project.primary_language)}, "
              f"scene descriptions in English). Target length: {target_duration(project)} seconds.\n"
              f"{('Open with this hook: ' + hook['text']) if hook else ''}\n"
              f"Use NARRATOR for voice-over lines. Keep each line short (under ~15 words).\n{instructions}")
    out = _llm(db, user, project, "script", prompts.WRITER, prompt, S.ScriptOut,
               {"concept": project.concept, "type": project.type, "language": project.primary_language},
               pro=project.type == "series")
    episode.script = out.model_dump()
    if not episode.title:
        episode.title = out.logline[:120]
    save_script_version(db, episode, "ai", user, note=instructions[:300])
    db.commit()
    emit(db, project.id, "episode.updated", {"episode_id": episode.id, "what": "script"})
    return episode.script


# ── bible ────────────────────────────────────────────────────────────────────

def link_character(db: Session, project: Project, ch: Character) -> None:
    if not db.get(ProjectCast, {"project_id": project.id, "character_id": ch.id}):
        db.add(ProjectCast(project_id=project.id, character_id=ch.id))


def link_location(db: Session, project: Project, loc: Location) -> None:
    if not db.get(ProjectLocation, {"project_id": project.id, "location_id": loc.id}):
        db.add(ProjectLocation(project_id=project.id, location_id=loc.id))


def propose_bible(db: Session, user: User, project: Project, episode: Episode | None) -> dict:
    script = (episode.script if episode else {}) or {}
    prompt = (f"{context_text(db, project, episode)}\n\nSCRIPT:\n{json.dumps(script, ensure_ascii=False)[:12000]}\n\n"
              "Define every speaking or recurring character (not NARRATOR), every location, and one visual style. "
              "Reuse existing CAST/LOCATIONS names exactly if they already exist.")
    out = _llm(db, user, project, "bible", prompts.CASTING, prompt, S.BibleOut, {"concept": project.concept})
    existing_c = {c.name.lower(): c for c in cast(db, project)}
    created_c, created_l = [], []
    for c in out.characters:
        if c.name.strip().upper() == "NARRATOR":
            continue
        if c.name.lower() in existing_c:
            continue
        ch = Character(name=c.name, role=c.role, gender=c.gender.lower(), age=c.age, dna_text=c.dna_text,
                       personality=c.personality, voice_description=c.voice_description, created_by=user.id)
        db.add(ch)
        db.flush()
        link_character(db, project, ch)
        created_c.append(ch.name)
    existing_l = {l.name.lower(): l for l in locations(db, project)}
    for l in out.locations:
        if l.name.lower() in existing_l:
            continue
        loc = Location(name=l.name, description_text=l.description_text)
        db.add(loc)
        db.flush()
        link_location(db, project, loc)
        created_l.append(loc.name)
    if not project.style_id:
        s = out.style
        style = Style(name=s.name, look=s.look, lens=s.lens, grade=s.grade, grain=s.grain, avoid_list=s.avoid_list)
        db.add(style)
        db.flush()
        project.style_id = style.id
    db.commit()
    emit(db, project.id, "bible.updated", {"characters": created_c, "locations": created_l})
    return {"characters_created": created_c, "locations_created": created_l, "style_id": project.style_id}


# ── shot breakdown ───────────────────────────────────────────────────────────

def _find_char(db: Session, project: Project, name: str, user: User) -> Character | None:
    if not name or name.strip().upper() == "NARRATOR":
        return None
    for c in cast(db, project):
        if c.name.lower() == name.strip().lower() or c.name.lower().split()[0] == name.strip().lower().split()[0]:
            return c
    ch = Character(name=name.strip(), dna_text=f"{name.strip()}: (describe this character in the Bible)", created_by=user.id)
    db.add(ch)
    db.flush()
    link_character(db, project, ch)
    return ch


def _find_loc(db: Session, project: Project, name: str) -> Location | None:
    if not name:
        return None
    low = name.strip().lower()
    locs = locations(db, project)
    # the exact name first ("Office Lobby" must not become "Office"), then a loose match
    for l in locs:
        if l.name.strip().lower() == low:
            return l
    for l in sorted(locs, key=lambda l: -len(l.name)):
        if l.name.lower() in low or low in l.name.lower():
            return l
    loc = Location(name=name, description_text=name)
    db.add(loc)
    db.flush()
    link_location(db, project, loc)
    return loc


def add_next_shot(db: Session, src: Shot, action: str = "", framing: str = "", camera: str = "", duration_s: int = 8,
                  mode: str = "last_frame") -> Shot:
    """The shot after `src` with the same cast, wardrobe, location and props, linked so its keyframe starts from the
    last frame of `src` (or its video extends src's clip)."""
    for later in db.query(Shot).filter(Shot.episode_id == src.episode_id, Shot.order > src.order).all():
        later.order += 1
    n = Shot(episode_id=src.episode_id, scene_id=src.scene_id, order=src.order + 1,
             duration_s=duration_s if duration_s in (4, 6, 8) else 8, framing=framing or src.framing, camera=camera or "static",
             action=action or f"The action continues directly from {src.code}.", characters=list(src.characters or []),
             outfits=dict(src.outfits or {}), location_id=src.location_id, prop_ids=list(src.prop_ids or []),
             quality_mode=src.quality_mode, engine=src.engine or "auto", continuity_from_shot_id=src.id,
             continuity_mode=mode if mode in ("last_frame", "extend") else "last_frame", mode="auto")
    db.add(n)
    db.flush()
    renumber(db, db.get(Episode, src.episode_id))
    return n


def renumber(db: Session, episode: Episode) -> None:
    shots = db.query(Shot).filter(Shot.episode_id == episode.id).order_by(Shot.order, Shot.id).all()
    prefix = f"E{episode.number:02}" if episode.kind == "episode" else f"C{episode.id:02}"
    for i, s in enumerate(shots, 1):
        s.order = i
        s.code = f"{prefix}-SH{i:02}"


def breakdown(db: Session, user: User, episode: Episode) -> list[dict]:
    project = db.get(Project, episode.project_id)
    script = episode.script or {}
    if not script.get("scenes"):
        raise HTTPException(400, "Write the script first")
    hook = (episode.hooks or [])[episode.selected_hook] if episode.selected_hook is not None and episode.hooks else None
    carded = (db.query(Scene).filter(Scene.episode_id == episode.id, Scene.approved.is_(True)).order_by(Scene.order).all()
              or [s for s in db.query(Scene).filter(Scene.episode_id == episode.id).order_by(Scene.order).all() if s.coverage])
    cards_txt = ""
    if carded:
        cards_txt = "SCENE CARDS (follow the coverage plan, blocking and wardrobe):\n" + "\n".join(
            f"[{s.order}] {s.title}: goal={s.goal}; conflict={s.conflict}; turn={s.turn}; emotion={s.emotion}; blocking={s.blocking}; "
            f"coverage={'; '.join(s.coverage or [])}; props={', '.join(s.props or [])}" for s in carded)
    from . import mentions
    script_plain = mentions.plain_script(script)
    prompt = (f"{context_text(db, project, episode)}\n\nSCRIPT:\n{json.dumps(script_plain, ensure_ascii=False)[:14000]}\n\n"
              f"{cards_txt}\n"
              f"{('HOOK (shot 1): ' + hook['text'] + ' — ' + hook.get('visual', '')) if hook else ''}\n"
              f"Break this into shots. Target total length about {target_duration(project)} seconds. "
              f"Keep the dialogue text exactly as written in the script (language: {lang_name(project.primary_language)}). "
              f"scene_index refers to the script's scenes (0-based).")
    out = _llm(db, user, project, "breakdown", prompts.DP, prompt, S.BreakdownOut,
               {"scenes": script_plain.get("scenes", []), "concept": project.concept}, pro=project.type == "series")
    # replace existing shots (keep old ones archived by deleting rows without takes; shots with takes are excluded)
    old = db.query(Shot).filter(Shot.episode_id == episode.id).all()
    for s in old:
        if db.query(Take).filter(Take.shot_id == s.id).count():
            s.include = False
            s.order = 10_000 + s.order
            s.code = f"OLD-{s.code}"
        else:
            db.delete(s)
    # Scene rows are matched to script scenes by order (= script scene index). Cards keep their plan; approved ones
    # win if two rows claim the same scene; rows past the end of the script go unless shots still point at them.
    n_script = len(script.get("scenes", []))
    reuse: dict[int, Scene] = {}
    for sc in db.query(Scene).filter(Scene.episode_id == episode.id).order_by(Scene.approved.desc(), Scene.id).all():
        if 0 <= sc.order < n_script and sc.order not in reuse:
            reuse[sc.order] = sc
        elif not db.query(Shot).filter(Shot.scene_id == sc.id).count():
            db.delete(sc)
    db.flush()
    scenes: dict[int, Scene] = {}
    for i, sc in enumerate(script.get("scenes", [])):
        ment = mentions.scene_entities(sc)
        loc = (db.get(Location, ment["location"][0]) if ment["location"] else None) or _find_loc(db, project, mentions.plain(sc.get("location", "")))
        row = reuse.get(i)
        if row is None:
            row = Scene(episode_id=episode.id, order=i, title=sc.get("title", f"Scene {i + 1}"),
                        location_id=loc.id if loc else None, time_of_day=sc.get("time_of_day", ""), summary=sc.get("summary", ""))
            db.add(row)
            db.flush()
        if ment["prop"]:
            row.prop_ids = ment["prop"]
        if not row.approved:  # keep the card's plan, refresh what the script owns
            row.title = sc.get("title") or row.title
            row.summary = sc.get("summary") or row.summary
            row.time_of_day = sc.get("time_of_day") or row.time_of_day
            row.location_id = loc.id if loc else row.location_id
        scenes[i] = row
    lang = project.primary_language
    for i, so in enumerate(out.shots, 1):
        scene = scenes.get(so.scene_index) or (scenes[min(scenes)] if scenes else None)
        chars = [c for c in (_find_char(db, project, n, user) for n in so.characters) if c]
        dialogue = []
        for l in so.dialogue:
            ch = _find_char(db, project, l.character, user)
            if ch and ch not in chars:
                chars.append(ch)
            dialogue.append({"character_id": ch.id if ch else "NARRATOR", "line": l.line, "emotion": l.emotion})
        narration = so.narration.strip()
        for l in list(dialogue):
            if l["character_id"] == "NARRATOR":
                narration = (narration + " " + l["line"]).strip()
                dialogue.remove(l)
        loc = _find_loc(db, project, so.location) if so.location else (db.get(Location, scene.location_id) if scene and scene.location_id else None)
        dur = so.duration_s if so.duration_s in (4, 6, 8) else 8
        db.add(Shot(episode_id=episode.id, scene_id=scene.id if scene else None, order=i, duration_s=dur, framing=so.framing,
                    camera=so.camera, action=so.action, characters=[c.id for c in chars], location_id=loc.id if loc else None,
                    dialogue={lang: dialogue} if dialogue else {}, narration={lang: narration} if narration else {},
                    sfx=so.sfx, music_cue=so.music_cue, mode="interpolate" if so.mode == "interpolate" else "auto",
                    continuity_from_prev=i > 1 and out.shots[i - 2].scene_index == so.scene_index))
    db.flush()
    renumber(db, episode)
    episode.status = "shots"
    db.commit()
    emit(db, project.id, "episode.updated", {"episode_id": episode.id, "what": "shots"})
    return [s.to_dict() for s in db.query(Shot).filter(Shot.episode_id == episode.id, Shot.include.is_(True)).order_by(Shot.order)]


# ── localisation (dub prep) ──────────────────────────────────────────────────

def localize(db: Session, user: User | None, episode: Episode, target: str, overwrite: bool = False) -> int:
    project = db.get(Project, episode.project_id)
    src = project.primary_language
    if target == src:
        return 0
    items, refs = [], []
    for s in db.query(Shot).filter(Shot.episode_id == episode.id).order_by(Shot.order).all():
        lines = (s.dialogue or {}).get(src) or []
        if lines and (overwrite or not (s.dialogue or {}).get(target)):
            for i, l in enumerate(lines):
                items.append({"key": f"{s.id}:d:{i}", "text": l["line"], "speaker": str(l.get("character_id"))})
                refs.append(("d", s, i))
        nar = (s.narration or {}).get(src)
        if nar and (overwrite or not (s.narration or {}).get(target)):
            items.append({"key": f"{s.id}:n:0", "text": nar, "speaker": "NARRATOR"})
            refs.append(("n", s, 0))
    if not items:
        return 0
    prompt = (f"Target language: {lang_name(target)} ({catalog.LANGUAGES[target]['script']} script). Source: {lang_name(src)}.\n"
              f"Context: {project.concept}\nTranslate every item; return the same keys.\n"
              + json.dumps([{k: it[k] for k in ("key", "text")} for it in items], ensure_ascii=False))
    out = _llm(db, user, project, "localize", prompts.LOCALIZER, prompt, S.LocalizeOut,
               {"items": items, "target_language": target})
    got = {it.key: it.text for it in out.items}
    n = 0
    for kind, s, i in refs:
        key = f"{s.id}:{kind}:{i}"
        if key not in got:
            continue
        if kind == "d":
            src_lines = (s.dialogue or {}).get(src) or []
            tgt = list((s.dialogue or {}).get(target) or [dict(l) for l in src_lines])
            while len(tgt) < len(src_lines):
                tgt.append(dict(src_lines[len(tgt)]))
            tgt[i] = {**src_lines[i], "line": got[key]}
            s.dialogue = {**(s.dialogue or {}), target: tgt}
        else:
            s.narration = {**(s.narration or {}), target: got[key]}
        n += 1
    db.commit()
    emit(db, project.id, "episode.updated", {"episode_id": episode.id, "what": f"localized:{target}"})
    return n


def summarize_episode(db: Session, user: User, episode: Episode) -> str:
    project = db.get(Project, episode.project_id)
    prompt = f"{context_text(db, project, episode)}\n\nSCRIPT:\n{json.dumps(episode.script or {}, ensure_ascii=False)[:12000]}"
    out = _llm(db, user, project, "summary", prompts.SUMMARY, prompt, S.SummaryOut, {"concept": project.concept})
    episode.summary_for_next = out.summary
    db.commit()
    return out.summary


def make_cutdowns(db: Session, user: User, episode: Episode, n: int = 3, seconds: int = 30) -> list[int]:
    """'Cut this episode into three 30 s shorts' → new cut-down episodes reusing existing takes."""
    project = db.get(Project, episode.project_id)
    shots = db.query(Shot).filter(Shot.episode_id == episode.id, Shot.include.is_(True)).order_by(Shot.order).all()
    listing = "\n".join(f"{s.code} ({s.duration_s}s): {s.action} | {json.dumps((s.dialogue or {}).get(project.primary_language, []), ensure_ascii=False)}"
                        for s in shots)
    prompt = (f"{context_text(db, project, episode)}\n\nSHOTS:\n{listing}\n\nPick shots for {n} standalone shorts of about "
              f"{seconds} seconds each. Each must open with a strong hook shot and make sense alone. Use shot codes only.")
    out = _llm(db, user, project, "cutdown", prompts.DP, prompt, S.CutdownOut, {"codes": [s.code for s in shots], "n": n})
    by_code = {s.code: s for s in shots}
    created = []
    max_no = max([e.number for e in db.query(Episode).filter(Episode.project_id == project.id).all()] or [0])
    for k, cut in enumerate(out.cuts, 1):
        ep = Episode(project_id=project.id, number=max_no + k, kind="cutdown", title=cut.title[:200],
                     outline=f"Cut-down of episode {episode.number}", settings=dict(episode.settings or {}))
        db.add(ep)
        db.flush()
        for i, code in enumerate(cut.shot_codes, 1):
            src = by_code.get(code)
            if not src:
                continue
            data = {c: getattr(src, c) for c in ("duration_s", "framing", "camera", "action", "characters", "outfits",
                                                  "location_id", "dialogue", "narration", "sfx", "music_cue", "mode",
                                                  "quality_mode", "voice_mode", "trim_in", "trim_out")}
            new = Shot(episode_id=ep.id, scene_id=src.scene_id, order=i, status=src.status, **data)
            db.add(new)
            db.flush()
            for t in db.query(Take).filter(Take.shot_id == src.id, Take.archived.is_(False), Take.selected.is_(True)).all():
                db.add(Take(shot_id=new.id, kind=t.kind, language=t.language, provider=t.provider, model=t.model,
                            params=t.params, prompt=t.prompt, path=t.path, thumb_path=t.thumb_path, duration_s=t.duration_s,
                            cost_usd=0.0, qc=t.qc, selected=True, remote_ref=t.remote_ref, parent_take_id=t.id,
                            created_by=user.id))
        renumber(db, ep)
        created.append(ep.id)
    db.commit()
    emit(db, project.id, "project.updated", {"what": "cutdowns", "episodes": created})
    return created


# ── revisions (undo) ─────────────────────────────────────────────────────────

SHOT_FIELDS = ["duration_s", "framing", "camera", "action", "characters", "outfits", "location_id", "dialogue", "narration",
               "sfx", "music_cue", "mode", "quality_mode", "voice_mode", "engine", "continuity_from_prev", "include", "trim_in",
               "trim_out", "notes", "scene_id", "overlays", "extend_to", "extend_prompt", "ref_images", "fx"]


def save_revision(db: Session, entity: str, row: Any, fields: list[str], user: User | None) -> None:
    db.add(Revision(entity_type=entity, entity_id=row.id, data={f: getattr(row, f) for f in fields},
                    user_id=user.id if user else None, created_at=utcnow()))


def undo(db: Session, entity: str, row: Any) -> bool:
    rev = (db.query(Revision).filter(Revision.entity_type == entity, Revision.entity_id == row.id)
           .order_by(Revision.id.desc()).first())
    if not rev:
        return False
    for k, v in (rev.data or {}).items():
        setattr(row, k, v)
    db.delete(rev)
    db.commit()
    return True


# ── Writers' room v2: script versions, scene cards, critic, continuity, native polish, trends, marketing ───────

def save_script_version(db: Session, episode: Episode, source: str, user: User | None, note: str = "",
                        critic: dict | None = None) -> ScriptVersion:
    last = (db.query(ScriptVersion).filter(ScriptVersion.episode_id == episode.id)
            .order_by(ScriptVersion.version.desc()).first())
    if last and last.script == (episode.script or {}) and source != "restore":
        if critic:  # same text, new review: keep the critic report with that version
            last.critic = critic
            last.note = (last.note + " · " if last.note else "") + note
        return last
    v = ScriptVersion(episode_id=episode.id, version=(last.version + 1) if last else 1, script=episode.script or {},
                      source=source, note=note, critic=critic or {}, created_by=user.id if user else None)
    db.add(v)
    db.flush()
    return v


def restore_script_version(db: Session, user: User, episode: Episode, version_id: int) -> dict:
    v = db.get(ScriptVersion, version_id)
    if not v or v.episode_id != episode.id:
        raise HTTPException(404, "Version not found")
    episode.script = v.script
    save_script_version(db, episode, "restore", user, note=f"Restored v{v.version}")
    db.commit()
    emit(db, episode.project_id, "episode.updated", {"episode_id": episode.id, "what": "script"})
    return episode.script


def plan_scene_cards(db: Session, user: User, episode: Episode) -> list[dict]:
    project = db.get(Project, episode.project_id)
    script = episode.script or {}
    if not script.get("scenes"):
        raise HTTPException(400, "Write the script first")
    prompt = (f"{context_text(db, project, episode)}\n\nSCRIPT:\n{json.dumps(script, ensure_ascii=False)[:14000]}\n\n"
              "Write one scene card per script scene (same order, scene_index 0-based).")
    out = _llm(db, user, project, "scene_cards", prompts.SCENE_PLANNER, prompt, S.SceneCardsOut,
               {"scenes": script.get("scenes", [])}, pro=project.type == "series")
    existing = {s.order: s for s in db.query(Scene).filter(Scene.episode_id == episode.id).all()}
    for card in out.scenes:
        sc = existing.get(card.scene_index)
        if sc is None:
            loc = _find_loc(db, project, card.location)
            sc = Scene(episode_id=episode.id, order=card.scene_index, location_id=loc.id if loc else None)
            db.add(sc)
        sc.title, sc.goal, sc.conflict, sc.turn, sc.emotion = card.title, card.goal, card.conflict, card.turn, card.emotion
        sc.time_of_day = card.time_of_day or sc.time_of_day
        sc.props, sc.continuity_notes, sc.blocking, sc.coverage = card.props, card.continuity_notes, card.blocking, card.coverage
        chars = [c for c in (_find_char(db, project, n, user) for n in card.characters) if c]
        sc.characters = [c.id for c in chars]
        wardrobe: dict[str, str] = {}
        for entry in card.wardrobe:
            if ":" in entry:
                name, outfit = entry.split(":", 1)
                ch = _find_char(db, project, name.strip(), user)
                if ch:
                    wardrobe[str(ch.id)] = outfit.strip()
        sc.wardrobe = wardrobe
        if not sc.summary and card.scene_index < len(script["scenes"]):
            sc.summary = script["scenes"][card.scene_index].get("summary", "")
    db.commit()
    emit(db, project.id, "episode.updated", {"episode_id": episode.id, "what": "scenes"})
    return [s.to_dict() for s in db.query(Scene).filter(Scene.episode_id == episode.id).order_by(Scene.order)]


def critique(db: Session, user: User | None, episode: Episode, round_: int = 0) -> dict:
    project = db.get(Project, episode.project_id)
    prompt = (f"{context_text(db, project, episode)}\n\nSCRIPT (dialogue in {lang_name(project.primary_language)}):\n"
              f"{json.dumps(episode.script or {}, ensure_ascii=False)[:14000]}")
    out = _llm(db, user, project, "critic", prompts.CRITIC, prompt, S.CriticOut, {"round": round_}, pro=True)
    report = out.model_dump() | {"round": round_, "at": utcnow().isoformat() + "Z"}
    episode.critic = report
    db.commit()
    emit(db, project.id, "episode.updated", {"episode_id": episode.id, "what": "critic"})
    return report


def continuity_check(db: Session, user: User | None, episode: Episode) -> dict:
    project = db.get(Project, episode.project_id)
    shots = db.query(Shot).filter(Shot.episode_id == episode.id, Shot.include.is_(True)).order_by(Shot.order).all()
    scenes = db.query(Scene).filter(Scene.episode_id == episode.id).order_by(Scene.order).all()
    names = {c.id: c.name for c in cast(db, project)}
    listing = "\n".join(
        f"{s.code} [scene {s.scene_id}] {s.framing}; {s.action}; chars={[names.get(int(c), c) for c in (s.characters or [])]}; "
        f"outfits={s.outfits}; lines={json.dumps((s.dialogue or {}).get(project.primary_language, []), ensure_ascii=False)}"
        for s in shots)
    cards = "\n".join(f"scene {s.id} '{s.title}' ({s.time_of_day}): props={s.props}; wardrobe={s.wardrobe}; notes={s.continuity_notes}"
                      for s in scenes)
    prompt = f"{context_text(db, project, episode)}\n\nSCENE CARDS:\n{cards}\n\nSHOTS:\n{listing[:14000]}"
    out = _llm(db, user, project, "continuity", prompts.CONTINUITY, prompt, S.ContinuityOut, {})
    report = out.model_dump() | {"at": utcnow().isoformat() + "Z"}
    episode.continuity = report
    db.commit()
    emit(db, project.id, "episode.updated", {"episode_id": episode.id, "what": "continuity"})
    return report


def native_polish(db: Session, user: User | None, episode: Episode, lang: str) -> int:
    """Second pass by a 'native speaker' so dubbed lines sound natural, not translated."""
    project = db.get(Project, episode.project_id)
    items, refs = [], []
    for s in db.query(Shot).filter(Shot.episode_id == episode.id).order_by(Shot.order).all():
        for i, l in enumerate((s.dialogue or {}).get(lang) or []):
            items.append({"key": f"{s.id}:d:{i}", "text": l.get("line", "")})
            refs.append(("d", s, i))
        if (s.narration or {}).get(lang):
            items.append({"key": f"{s.id}:n:0", "text": s.narration[lang]})
            refs.append(("n", s, 0))
    if not items:
        return 0
    prompt = (f"Language: {lang_name(lang)}. Story: {project.concept}\n"
              + json.dumps(items, ensure_ascii=False))
    out = _llm(db, user, project, "native_polish", prompts.NATIVE_POLISH, prompt, S.NativePolishOut, {"items": items})
    got = {it.key: it.text for it in out.items if it.text.strip()}
    n = 0
    for kind, s, i in refs:
        key = f"{s.id}:{kind}:{i}"
        if key not in got:
            continue
        if kind == "d":
            lines = [dict(x) for x in (s.dialogue or {}).get(lang) or []]
            lines[i]["line"] = got[key]
            s.dialogue = {**(s.dialogue or {}), lang: lines}
        else:
            s.narration = {**(s.narration or {}), lang: got[key]}
        n += 1
    db.commit()
    emit(db, project.id, "episode.updated", {"episode_id": episode.id, "what": "polish", "language": lang, "lines": n})
    return n


def trend_scout(db: Session, user: User, project: Project) -> dict:
    prompt = (f"Audience: {(project.brief or {}).get('audience', 'Indian, 18–45')}. Platform: {(project.brief or {}).get('platform', 'Shorts/Reels')}. "
              f"Genre/concept: {project.concept}. Languages: {', '.join(lang_name(l) for l in project.languages)}.")
    svc = Services()
    obj, usage = svc.llm_json("trends", prompts.TREND_SCOUT, prompt, S.TrendOut, mock_ctx={}, tools=[{"type": "google_search"}])
    budget.record_cost(db, usage, user_id=user.id, project_id=project.id, job_id=None)
    project.brief = {**(project.brief or {}), "trends": obj.model_dump() | {"at": utcnow().isoformat() + "Z"}}
    db.commit()
    emit(db, project.id, "project.updated", {"what": "trends"})
    return project.brief["trends"]


def marketing_copy(db: Session, user: User | None, episode: Episode, platforms: list[str], languages: list[str]) -> dict:
    project = db.get(Project, episode.project_id)
    hook = (episode.hooks or [])[episode.selected_hook]["text"] if episode.selected_hook is not None and episode.hooks else ""
    prompt = (f"{context_text(db, project, episode)}\nHOOK: {hook}\nLOGLINE: {(episode.script or {}).get('logline', '')}\n"
              f"Platforms: {', '.join(platforms)}. Languages: {', '.join(lang_name(l) for l in languages)} "
              f"(write each language in its own script).")
    out = _llm(db, user, project, "marketing", prompts.MARKETING, prompt, S.MarketingOut,
               {"concept": project.concept, "languages": languages})
    episode.marketing = {**(episode.marketing or {}), **out.model_dump(), "at": utcnow().isoformat() + "Z"}
    db.commit()
    emit(db, project.id, "episode.updated", {"episode_id": episode.id, "what": "marketing"})
    return episode.marketing


def _hook_learnings(db: Session) -> str:
    """Our own published hooks ranked by audience retention (YouTube Analytics) — the hook writer learns from them."""
    from ..models import PostMetric
    rows = [r for r in db.query(PostMetric).filter(PostMetric.hook_text != "", PostMetric.avg_view_pct.isnot(None))
            .order_by(PostMetric.id.desc()).limit(200).all()]
    if len(rows) < 2:
        return ""
    best: dict[str, float] = {}
    for r in rows:
        best[r.hook_text] = max(best.get(r.hook_text, 0), float(r.avg_view_pct or 0))
    ranked = sorted(best.items(), key=lambda kv: -kv[1])
    top = "; ".join(f'"{h[:90]}" ({v:.0f}% watched)' for h, v in ranked[:5])
    low = "; ".join(f'"{h[:90]}" ({v:.0f}%)' for h, v in ranked[-3:])
    return f"OUR DATA — hooks that kept viewers: {top}. Hooks that lost them: {low}. Learn from the pattern, don't copy.\n"
