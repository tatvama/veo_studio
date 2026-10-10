"""The Director on Claude (Anthropic Messages API): a manual tool loop with prompt caching, server-side refusal fallback,
a task budget that lets Claude pace a long multi-step turn, the web search server tool, and pictures in tool results
(look_at_shot), so it can see the keyframes and videos it judges.

Memory: the exact API messages of each turn are saved on that turn's assistant AgentMessage (data["claude"]) and
replayed append-only. Claude's thinking blocks are only valid while the system prompt, the tools and every earlier
message stay byte-identical, so nothing stored is ever edited: per-turn facts (project, UI selection, what happened
since the last reply) go at the start of the new user turn instead. A thread starts over when the model, system prompt
or tools change, after 6 idle hours, past ~60k input tokens, or when the API rejects the stored history."""
from __future__ import annotations

import base64
import hashlib
import json
import uuid
from datetime import timedelta
from typing import Any

import anthropic
from sqlalchemy.orm import Session

from .. import settings_store
from ..core import budget
from ..db import utcnow
from ..models import AgentMessage
from ..providers.base import Usage
from . import prompts
from .director import _step, progress
from .tools import TOOL_DECLS, TOOL_FUNCS, AgentCtx, memory_text, step_label

DEFAULT_MODEL = "claude-sonnet-5-5"
MAX_TOKENS = 16000
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# server-side fallback (with fallbacks="default": a cyber / frontier-LLM decline is retried server-side) + task budgets
BETAS = ["server-side-fallback-2026-07-01", "task-budgets-2026-03-13"]
CLAUDE_MAX_STEPS = 30  # model calls per chat turn (Gemini keeps director.MAX_STEPS)
TASK_BUDGET = 120_000  # tokens Claude may spend across one turn's steps: it sees a countdown and paces itself (min 20k)
THREAD_IDLE = timedelta(hours=6)
THREAD_MAX_INPUT = 60_000  # prompt tokens of the last call; past this the next turn starts a new thread
RESULT_CHARS = 12000

# Same tools, same order, every call (they render first: any change breaks the cache and the stored thread). Web search
# runs on Anthropic's side; its results come back inside the assistant turn (server_tool_use / web_search_tool_result).
WEB_SEARCH = {"type": "web_search_20260209", "name": "web_search", "max_uses": 5}
TOOLS: list[dict] = [{"name": d["name"], "description": d["description"], "input_schema": d["parameters"]}
                     for d in sorted(TOOL_DECLS, key=lambda d: d["name"])] + [WEB_SEARCH]


def _client(key: str) -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=key)  # retries 429 / 5xx / connection errors twice by itself


def fingerprint(model: str) -> str:
    """Changes when anything ahead of the messages changes (model, system prompt, tools): a stored thread can't continue."""
    raw = json.dumps({"model": model, "system": prompts.DIRECTOR_AGENT, "tools": TOOLS}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def cost(prices: dict, model: str, usage: Any) -> tuple[int, float]:
    """(tokens, USD) of one response: input, 5-minute cache writes, cache reads and output each at their own rate.
    When the server-side fallback ran, every attempt is listed in usage.iterations (top-level usage is only the last)."""
    its = [i for i in (getattr(usage, "iterations", None) or []) if getattr(i, "type", "") in ("message", "fallback_message")]
    parts = its if any(i.type == "fallback_message" for i in its) else [usage]
    table = prices.get("text_per_million") or {}
    tokens, usd = 0, 0.0
    for u in parts:
        p = table.get(getattr(u, "model", None) or model) or table.get(model) or {"in": 2.0, "out": 10.0}
        tin, cw, cr, tout = (int(getattr(u, k, 0) or 0) for k in
                             ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"))
        tokens += tin + cw + cr + tout
        usd += (tin * p["in"] + cw * p.get("cache_write", p["in"] * 1.25) + cr * p.get("cache_read", p["in"] * 0.1)
                + tout * p["out"]) / 1e6
    return tokens, usd


def _prompt_tokens(usage: Any) -> int:
    return sum(int(getattr(usage, k, 0) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))


def _dump(block: Any) -> dict:
    """A response block exactly as the API sent it, which is also what it accepts back (the SDK sends models this way)."""
    return block.to_dict(mode="json") if hasattr(block, "to_dict") else dict(block)


def _text(content: list[dict]) -> str:
    return "\n\n".join(b["text"].strip() for b in content if b.get("type") == "text" and (b.get("text") or "").strip())


def _clip(s: str, n: int) -> str:
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _new_thread() -> str:
    return "t" + uuid.uuid4().hex[:12]


def _thread(db: Session, project_id: int, fp: str) -> tuple[str, list[dict], AgentMessage | None, int]:
    """(thread id, history, message holding its last turn, turns so far) of the thread to continue, or a new id and
    no history when there is none to continue."""
    rows = (db.query(AgentMessage).filter(AgentMessage.project_id == project_id, AgentMessage.role == "assistant")
            .order_by(AgentMessage.id.desc()).limit(200).all())
    segs: list[tuple[AgentMessage, dict]] = []
    for m in rows:
        seg = (m.data or {}).get("claude")
        if not isinstance(seg, dict) or not seg.get("messages"):
            continue
        if segs and seg.get("thread") != segs[0][1].get("thread"):
            break
        segs.append((m, seg))
    fresh = (_new_thread(), [], None, 0)
    if not segs:
        return fresh
    last_msg, last = segs[0]
    if (last.get("fingerprint") != fp or int(last.get("input_tokens") or 0) > THREAD_MAX_INPUT
            or (last_msg.created_at and utcnow() - last_msg.created_at > THREAD_IDLE)):
        return fresh
    segs.reverse()
    if [s.get("turn") for _, s in segs] != list(range(len(segs))):  # cut short (too old to load) or forked by two chats at once
        return fresh
    return str(last["thread"]), [msg for _, s in segs for msg in s["messages"]], last_msg, len(segs)


def _since(db: Session, project_id: int, after_id: int, before_id: int) -> list[str]:
    """What happened in the chat since Claude's last turn that isn't in its thread: confirmation cards the user
    answered, turns another engine answered, turns that failed."""
    rows = (db.query(AgentMessage).filter(AgentMessage.project_id == project_id, AgentMessage.id > after_id,
                                          AgentMessage.id < before_id).order_by(AgentMessage.id).all())
    out: list[str] = []
    asked = ""
    for m in rows:
        if m.role == "user":
            asked = m.content
            continue
        if m.role != "assistant":
            continue
        d = m.data or {}
        conf = d.get("confirm")
        if conf:
            what = conf.get("what") or "the action"
            if conf.get("status") == "done":
                line = f"the user confirmed '{what}' → {_clip(m.content, 300)}"
            elif conf.get("status") == "declined":
                line = f"the user declined '{what}', so it was left as it is"
            else:
                line = f"the user confirmed '{what}' but it failed: {_clip(m.content, 300)}"
        elif d.get("refusal") is not None:
            line = "the AI declined the user's previous request"
        elif d.get("engine") == "claude":
            line = f"your reply to '{_clip(asked, 200)}' did not go through: {_clip(m.content, 300)}"
        elif asked:
            line = f"the user wrote '{_clip(asked, 200)}' and the Director ({d.get('engine') or 'another engine'}) replied '{_clip(m.content, 300)}'"
        else:
            line = f"the Director said '{_clip(m.content, 300)}'"
        asked = ""
        out.append(line)
    return out[-8:]


def _turn(c: AgentCtx, message: str, selection: dict, since: list[str]) -> dict:
    """The user's turn: the studio's facts for this turn first (kept out of the system prompt so it never changes), then
    the message itself."""
    p, ep = c.project, c.ep()
    ctx = (f"[Context from the studio, not typed by the user] Project '{p.title}' ({p.type}, {p.aspect}, primary language "
           f"{p.primary_language}, languages {', '.join(p.languages or [])}, quality {p.quality_mode}, mode {p.agent_mode}). "
           f"Current episode: {ep.number} '{ep.title}'. Today is {utcnow():%A %d %B %Y} (UTC).")
    memory = memory_text(p)
    if memory:
        ctx += "\n" + memory
    if selection:
        ctx += f"\nSelected in the UI: {json.dumps(selection, sort_keys=True, ensure_ascii=False, default=str)}"
    if since:
        ctx += "\nSince your last reply:\n" + "\n".join(f"- {s}" for s in since)
    return {"role": "user", "content": [{"type": "text", "text": ctx}, {"type": "text", "text": message}]}


def _result(c: AgentCtx, block: dict) -> dict:
    raw = str(block.get("name") or "")
    name = raw if raw in TOOL_FUNCS else next((n for n in TOOL_FUNCS if n.lower() == raw.lower()), raw)  # bash → Bash slips
    out = _step(c, name, block.get("input") or {})
    images = out.pop("_images", None) if isinstance(out, dict) else None
    body = json.dumps(out, ensure_ascii=False, default=str)[:RESULT_CHARS]
    r: dict[str, Any] = {"type": "tool_result", "tool_use_id": block["id"], "content": body}
    if images:  # look_at_shot: the JSON first, then each picture after its label
        r["content"] = [{"type": "text", "text": body}]
        for label, data in images:
            r["content"] += [{"type": "text", "text": label},
                             {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                          "data": base64.b64encode(data).decode()}}]
    if isinstance(out, dict) and "error" in out:
        r["is_error"] = True
    return r


def _searches(c: AgentCtx, content: list[dict], seen: dict[str, int]) -> None:
    """Web searches have already run on Anthropic's side when a response comes back: list each one as a step then (a
    search cut short by pause_turn gets its result in the next response)."""
    for b in content:
        if b.get("type") == "server_tool_use" and b.get("name") == "web_search" and b.get("id") not in seen:
            c.steps.append({"tool": "web_search", "label": step_label("web_search", b.get("input")), "ok": None})
            seen[b["id"]] = len(c.steps) - 1
            progress(c, seen[b["id"]], **c.steps[-1])
    for b in content:
        i = seen.get(b.get("tool_use_id")) if b.get("type") == "web_search_tool_result" else None
        if i is not None and c.steps[i]["ok"] is None:
            c.steps[i]["ok"] = isinstance(b.get("content"), list)  # an error comes back as one object, not a list
            progress(c, i, **c.steps[i])


def _failure(e: Exception) -> str:
    if isinstance(e, anthropic.AuthenticationError):
        return "Sorry — the Anthropic key was rejected. An admin can check it in Settings → AI services."
    if isinstance(e, anthropic.RateLimitError):
        return "Sorry — the AI service is busy right now (rate limit). Please try again in a minute."
    if isinstance(e, anthropic.APIStatusError):
        return f"Sorry — the AI service failed ({e.status_code}): {_clip(e.message, 300)}"
    return f"Sorry — the AI service failed: couldn't reach Anthropic ({_clip(str(e), 200)})"


def run(c: AgentCtx, message: str, selection: dict, user_msg_id: int) -> tuple[str, dict]:
    """One chat turn on Claude. Returns (reply, extra data for the assistant message: the thread segment to store)."""
    db = c.db
    model = ((settings_store.get_setting(db, "director_claude_model") or "").strip()
             or settings_store.models(db).get("director_claude") or DEFAULT_MODEL)
    prices = settings_store.prices(db)
    effort = settings_store.get_setting(db, "director_claude_effort")
    effort = effort if effort in EFFORTS else "medium"
    fp = fingerprint(model)
    client = _client(settings_store.api_key("anthropic"))
    tid, history, last_msg, turn = _thread(db, c.project.id, fp)
    new = [_turn(c, message, selection, _since(db, c.project.id, last_msg.id, user_msg_id) if last_msg else [])]

    def ask(msgs: list[dict]):
        return client.beta.messages.create(
            model=model, max_tokens=MAX_TOKENS, system=prompts.DIRECTOR_AGENT, tools=TOOLS, messages=msgs,
            output_config={"effort": effort, "task_budget": {"type": "tokens", "total": TASK_BUDGET}},
            cache_control={"type": "ephemeral"}, betas=BETAS, fallbacks="default")

    text, keep, failed, prompt_tokens, limited = "", True, False, 0, False
    extra: dict[str, Any] = {}
    searches: dict[str, int] = {}
    last = CLAUDE_MAX_STEPS - 1
    for step in range(CLAUDE_MAX_STEPS):
        try:
            try:
                resp = ask(history + new)
            except anthropic.BadRequestError:
                if step or not history:
                    raise
                # the stored conversation was rejected (expired, edited, too long): start a fresh thread, once
                tid, history, turn = _new_thread(), [], 0
                new = [_turn(c, message, selection, [])]
                resp = ask(new)
        except anthropic.APIError as e:
            text, failed = _failure(e), True
            # nothing came back this turn, or the request itself was rejected: keep the thread as it was before the turn
            keep = step > 0 and not isinstance(e, anthropic.BadRequestError)
            break
        tokens, usd = cost(prices, model, resp.usage)
        budget.record_cost(db, Usage("anthropic", model, "agent", tokens, "tokens", usd),
                           user_id=c.user.id, project_id=c.project.id, job_id=None)
        db.commit()
        prompt_tokens = _prompt_tokens(resp.usage)
        if resp.stop_reason == "refusal":  # before reading content: a decline can come back empty or cut short
            extra["refusal"] = getattr(getattr(resp, "stop_details", None), "category", None) or ""
            text, keep, failed = "Sorry — the AI declined this request. Try rephrasing it.", False, True
            break
        content = [_dump(b) for b in resp.content]
        if content:  # an empty assistant turn can't be sent back
            new.append({"role": "assistant", "content": content})
        _searches(c, content, searches)
        if resp.stop_reason == "pause_turn":
            limited = step == last
            continue
        calls = [b for b in content if b.get("type") == "tool_use"]
        if resp.stop_reason == "tool_use" and calls and step < last:
            new.append({"role": "user", "content": [_result(c, b) for b in calls]})  # every result in one message
            continue
        text = _text(content)
        if resp.stop_reason == "tool_use" and calls:  # out of steps: answer the calls unrun, so the stored thread stays valid
            limited = True
            new.append({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": b["id"], "is_error": True,
                 "content": "Not run: the turn hit its step limit first. Call it again if it is still needed."} for b in calls]})
            break
        if calls:  # a tool call cut off (length limit): answer it so the stored thread stays valid
            new.append({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": b["id"], "is_error": True,
                 "content": "Not run: the reply hit the length limit."} for b in calls]})
        if resp.stop_reason == "max_tokens":
            text = text or "Sorry — my reply got too long and was cut off. Try asking for less at once."
        break
    if failed and c.actions:
        text += " Done before that: " + "; ".join(c.actions) + "."
    if limited:
        done = (" Done so far: " + "; ".join(c.actions) + ".") if c.actions else ""
        text = (text + "\n\n" if text else "") + (f"I stopped after {CLAUDE_MAX_STEPS} steps so this turn doesn't run on.{done} "
                                                  "Say \"continue\" and I'll pick up from here.")
    if keep:
        extra["claude"] = {"thread": tid, "turn": turn, "messages": new, "fingerprint": fp, "model": model,
                           "input_tokens": prompt_tokens}
    return text or "Done. " + "; ".join(c.actions), extra
