"""The Director agent loop: Claude (director_claude.py) or Gemini function calling over the Interactions API, plus a
keyword mock for keyless use."""
from __future__ import annotations

import json
import re
from typing import Any

from sqlalchemy.orm import Session

from .. import catalog, settings_store
from ..core import budget
from ..events import emit
from ..models import AgentMessage, Episode, Project, User
from ..providers.base import ProviderError, Usage
from ..providers.services import Services, provider_mode
from . import prompts
from .tools import TOOL_DECLS, TOOL_FUNCS, AgentCtx, run_tool

MAX_STEPS = 8


def _save(db: Session, project: Project, user: User | None, role: str, content: str, data: dict | None = None) -> AgentMessage:
    m = AgentMessage(project_id=project.id, user_id=user.id if user else None, role=role, content=content, data=data or {})
    db.add(m)
    db.commit()
    emit(db, project.id, "agent.message", {"message_id": m.id, "role": role})
    return m


def _call(c: AgentCtx, name: str, args: Any) -> dict:
    if isinstance(args, str):
        try:
            args = json.loads(args or "{}")
        except json.JSONDecodeError:
            args = {}
    if name not in TOOL_FUNCS:
        return {"error": f"unknown tool {name}"}
    try:
        return run_tool(c, name, dict(args or {}))
    except TypeError as e:
        return {"error": f"bad arguments for {name}: {e}"}
    except Exception as e:  # tools surface errors to the model instead of crashing the chat
        c.db.rollback()
        detail = getattr(e, "detail", None) or str(e)
        return {"error": str(detail)[:500]}


def engine(db: Session) -> str:
    """Who answers the chat: "claude", "gemini" or "mock". Claude when the team prefers it (the default) and the Anthropic
    key is live; Gemini when its key is live and the team picked Gemini or there is no Anthropic key; else the mock.
    A team that picked Gemini never gets Claude."""
    pref = settings_store.get_setting(db, "director_engine")
    claude, gemini = provider_mode("anthropic"), provider_mode("gemini")
    if pref != "gemini" and claude == "live":
        return "claude"
    if gemini == "live" and (pref == "gemini" or claude != "live"):
        return "gemini"
    return "mock"


def public(d: dict) -> dict:
    """A chat message for the UI, without the stored Claude conversation (raw API messages, only the engine needs them)."""
    data = d.get("data")
    if isinstance(data, dict) and "claude" in data:
        d = {**d, "data": {k: v for k, v in data.items() if k != "claude"}}
    return d


def run(db: Session, user: User, project: Project, episode: Episode | None, message: str,
        selection: dict | None = None) -> list[dict]:
    selection = selection or {}
    um = _save(db, project, user, "user", message, {"selection": selection})
    c = AgentCtx(db=db, user=user, project=project, episode=episode)
    eng = engine(db)
    extra: dict = {}
    if eng == "claude":
        from . import director_claude
        text, extra = director_claude.run(c, message, selection, um.id)
    elif eng == "gemini":
        text = _live_agent(c, message, selection)
    else:
        text = _mock_agent(c, message)
    msg = _save(db, project, None, "assistant", text, {"proposals": c.proposals, "actions": c.actions,
                                                         "confirmations": c.confirmations,
                                                         "interaction_id": getattr(c, "_iid", ""), "engine": eng, **extra})
    return [public(msg.to_dict())]


def _summary(tool: str, out: dict) -> str:
    if tool == "write_script":
        return f"Script rewritten: {out.get('scenes', 0)} scenes."
    if tool == "breakdown_shots":
        return f"Shot list re-planned: {len(out.get('shots', []))} shots ({out.get('total_seconds', 0)} s)."
    if tool == "generate_hooks":
        return f"{len(out.get('hooks', []))} new hooks written."
    if tool == "select_hook":
        return "Hook changed. Rewrite the script when you're ready, so it matches."
    if tool == "plan_series":
        return f"Season re-planned: {len(out.get('episodes', []))} episodes."
    if tool == "build_bible":
        added = out.get("characters_created") or []
        return f"Added {', '.join(added)} from the script." if added else "The cast already covers the script; nothing added."
    if tool == "make_cutdowns":
        return f"Created {len(out.get('cutdown_episode_ids', []))} cut-down episodes."
    return "Done."


def confirm(db: Session, user: User, project: Project, message_id: int, item_id: str, approve: bool) -> dict:
    """The user answered a confirmation card: run the action (it may replace work, which they have now agreed to)
    or drop it. The card records the outcome and the Director posts a one-line reply."""
    from fastapi import HTTPException

    # lock the card: two clicks (or two people) must not run the same replacing action twice
    msg = db.query(AgentMessage).filter(AgentMessage.id == message_id).with_for_update().first()
    if not msg or msg.project_id != project.id:
        raise HTTPException(404, "Message not found")
    data = dict(msg.data or {})
    items = [dict(i) for i in data.get("confirmations") or []]
    item = next((i for i in items if i.get("id") == item_id), None)
    if not item:
        raise HTTPException(404, "Nothing to confirm")
    if item.get("status") != "pending":
        raise HTTPException(400, "Already answered")
    if approve:
        from .tools import _needs_confirmation
        c = AgentCtx(db=db, user=user, project=project, episode=db.get(Episode, item.get("episode_id")) if item.get("episode_id") else None,
                     confirmed=True)
        now = _needs_confirmation(c, item["tool"], item.get("args") or {})
        if now and now[1] != item.get("detail"):  # things changed since the card was shown: ask again with the facts of now
            item["what"], item["detail"] = now
            data["confirmations"] = [item if i.get("id") == item_id else i for i in items]
            msg.data = data
            db.commit()
            raise HTTPException(409, f"This changed since I asked: {now[1]} Please confirm again.")
        item["status"] = "running"  # claimed: a second click now gets "Already answered"
        data["confirmations"] = [item if i.get("id") == item_id else i for i in items]
        msg.data = dict(data)
        db.commit()
        items = [item if i.get("id") == item_id else i for i in items]
        out = _call(c, item["tool"], item.get("args") or {})
        if "error" in out:
            item["status"], item["result"] = "failed", str(out["error"])[:300]
            reply = f"I couldn't do that: {item['result']}"
        else:
            item["status"], item["result"] = "done", _summary(item["tool"], out)
            reply = item["result"]
    else:
        item["status"], item["result"] = "declined", "Left as it is."
        reply = "OK, I left it as it is."
    data["confirmations"] = items
    msg.data = data  # new dict so the JSON column is saved
    db.commit()
    # "confirm" lets the next Claude turn say what happened (this reply is not part of its stored conversation)
    _save(db, project, None, "assistant", reply, {"actions": [reply] if item["status"] == "done" else [],
                                                  "confirm": {"what": item.get("what"), "tool": item["tool"],
                                                              "status": item["status"]}})
    return item


def _live_agent(c: AgentCtx, message: str, selection: dict) -> str:
    svc = Services()
    model = svc.models["text"]
    client = svc.gemini()
    ep = c.ep()
    system = (prompts.DIRECTOR_AGENT + f"\n\nCurrent project: '{c.project.title}' ({c.project.type}, {c.project.aspect}, "
              f"primary language {c.project.primary_language}, languages {c.project.languages}, quality "
              f"{c.project.quality_mode}, mode {c.project.agent_mode}). Current episode: {ep.number} '{ep.title}'.")
    last = (c.db.query(AgentMessage).filter(AgentMessage.project_id == c.project.id, AgentMessage.role == "assistant")
            .order_by(AgentMessage.id.desc()).first())
    prev_iid = (last.data or {}).get("interaction_id") if last else None
    sel = f"\n[Selected in UI: {json.dumps(selection)}]" if selection else ""
    input_: Any = [{"type": "user_input", "content": message + sel}]
    text = ""
    for _ in range(MAX_STEPS):
        try:
            resp = client.agent_step(model, system, input_, TOOL_DECLS, prev_iid)
        except ProviderError as e:
            if prev_iid:  # stored conversation may have expired — start fresh
                prev_iid = None
                resp = client.agent_step(model, system, input_, TOOL_DECLS, None)
            else:
                return f"Sorry — the AI service failed: {e}"
        tin, tout = client.usage(resp)
        budget.record_cost(c.db, Usage("gemini", model, "agent", tin + tout, "tokens", svc.text_cost(model, tin, tout)),
                           user_id=c.user.id, project_id=c.project.id, job_id=None)
        c.db.commit()
        prev_iid = resp.get("id") or prev_iid
        calls = client.function_calls(resp)
        if not calls:
            text = client.output_text(resp)
            break
        results = []
        for call in calls:
            out = _call(c, call.get("name", ""), call.get("arguments") or call.get("args") or {})
            results.append({"type": "function_result", "name": call.get("name"), "call_id": call.get("id"),
                            "result": [{"type": "text", "text": json.dumps(out, ensure_ascii=False, default=str)[:12000]}]})
        input_ = results
    c._iid = prev_iid or ""  # type: ignore[attr-defined]
    return text or "Done. " + "; ".join(c.actions)


# ── keyword mock (no Anthropic or Gemini key) ────────────────────────────────

def _lang_in(msg: str) -> str | None:
    low = msg.lower()
    for code, v in catalog.LANGUAGES.items():
        if v["name"].lower() in low:
            return code
    return None


def _mock_agent(c: AgentCtx, msg: str) -> str:
    low = msg.lower()
    codes = [x.upper() for x in re.findall(r"\be\d{2}-sh\d{2}\b", low)]
    out: list[str] = []

    def do(name: str, **kw) -> dict:
        r = _call(c, name, kw)
        if "error" in r:
            out.append(f"⚠ {name}: {r['error']}")
        return r

    if re.search(r"autopilot|make it for me|do everything|full video", low):
        r = do("start_autopilot")
        out.append(f"Autopilot proposed (estimate ${r.get('total_usd', 0):.2f}). Approve it to start.")
    elif "cut" in low and "short" in low:
        n = int((re.search(r"(\d+)\s*(?:x\s*)?(?:\d+\s*s\s*)?shorts", low) or re.search(r"(\d+)", low) or [None, 3])[1])
        r = do("make_cutdowns", count=min(n, 5))
        out.append(f"Created {len(r.get('cutdown_episode_ids', []))} cut-down episodes.")
    elif "dub" in low or ("into" in low and _lang_in(low)):
        lang = _lang_in(low) or "hi"
        r = do("dub_episode", language=lang)
        out.append(f"Dub into {catalog.LANGUAGES[lang]['name']} proposed (${r.get('total_usd', 0):.2f}).")
    elif "hook" in low:
        r = do("generate_hooks", n=6)
        out.append("New hooks:\n" + "\n".join(f"{h['index']}. {h['text']} ({h['total']})" for h in r.get("hooks", [])))
    elif "series" in low or "season" in low:
        r = do("plan_series", episodes=5)
        out.append("Season planned: " + ", ".join(r.get("episodes", [])))
    elif "script" in low or "story" in low:
        r = do("write_script", instructions=msg)
        out.append(f"Script written: {r.get('scenes', 0)} scenes.")
    elif re.search(r"bible|character|cast|location", low) and "outfit" not in low:
        r = do("build_bible")
        out.append(f"Bible: new characters {r.get('characters_created')}, locations {r.get('locations_created')}.")
    elif "outfit" in low:
        names = [ch for ch in re.findall(r"\b([A-Z][a-z]+)\b", msg) if ch not in ("Ep", "Episode", "Regenerate", "Make", "Give")]
        r = do("set_outfit", character=names[0] if names else "", outfit="new outfit", description=msg)
        out.append(f"Outfit change proposed for shots {r.get('shots', [])}.")
    elif "breakdown" in low or "shot list" in low or ("shots" in low and "plan" in low):
        r = do("breakdown_shots")
        out.append(f"Planned {len(r.get('shots', []))} shots ({r.get('total_seconds', 0)} s).")
    elif "keyframe" in low or "storyboard" in low:
        r = do("generate_keyframes", shot_codes=codes)
        out.append(f"Keyframes proposed: {r.get('count', 0)} (${r.get('total_usd', 0):.2f}).")
    elif "edit" in low and codes:
        r = do("edit_clip", shot_code=codes[0], instruction=msg)
        out.append(f"Edit proposed for {codes[0]}.")
    elif re.search(r"\bvideo|animate|clip", low):
        q = "hero" if "hero" in low else ("balanced" if "balanced" in low else "")
        r = do("generate_videos", shot_codes=codes, quality=q)
        out.append(f"Videos proposed: {r.get('count', 0)} (${r.get('total_usd', 0):.2f}).")
    elif "lip" in low or "voice" in low:
        r = do("voice_and_lipsync", language=_lang_in(low) or "", shot_codes=codes)
        out.append(f"Voices & lip-sync proposed: {r.get('count', 0)} jobs.")
    elif "music" in low:
        r = do("generate_music")
        out.append("Music proposed.")
    elif "animatic" in low or "preview" in low:
        r = do("make_animatic", language=_lang_in(low) or "")
        out.append("Animatic rendering.")
    elif "export" in low or "render" in low:
        r = do("export_video", language=_lang_in(low) or "")
        out.append("Export rendering.")
    elif codes and re.search(r"tense|dramatic|slower|faster|closer|wider", low):
        r = do("update_shot", shot_code=codes[0], changes={"camera": "slow push-in, tighter framing", "action": msg})
        out.append(f"Updated {codes[0]}. Regenerate its keyframe/video to see it.")
    else:
        st = do("get_project_state")
        shots = st.get("shots", [])
        out.append(f"Project '{st['project']['title']}': {len(shots)} shots, "
                   f"{sum(1 for s in shots if s['keyframe'])} keyframes, {sum(1 for s in shots if s['video'])} videos.\n"
                   "Try: 'write hooks', 'write the script', 'build the bible', 'plan shots', 'generate keyframes', "
                   "'generate videos', 'voices and lip-sync', 'music', 'animatic', 'export', 'dub into Kannada', "
                   "'cut into 3 shorts', or 'autopilot'.")
    if c.confirmations:  # the action is waiting for the user's OK, so nothing above actually happened yet
        w = c.confirmations[-1]
        out = [f"Before I do that — {w['what'].lower()}: {w['detail']} Confirm below if you want it."]
    if settings_store.get_setting(c.db, "director_engine") == "gemini" and provider_mode("anthropic") == "live":
        banner = "(Mock agent — the Director is set to Gemini, which has no key. Add a Gemini key or pick Claude in Settings.)"
    else:
        banner = "(Mock agent — add an Anthropic or Gemini key for the real Director.)"
    return banner + "\n" + "\n".join(out)
