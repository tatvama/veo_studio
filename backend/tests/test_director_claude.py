"""The Director on Claude: tool loop, append-only thread memory, fresh threads, refusals, cost, engine choice and
confirm-card replies in the next turn's context. No live key: a fake Anthropic client returns scripted SDK responses."""
from __future__ import annotations

import copy
import json
from datetime import timedelta
from types import SimpleNamespace

import anthropic
import httpx2
import pytest
from anthropic.types.beta import BetaMessage
from fastapi.testclient import TestClient

from app import settings_store
from app.agents import director, prompts
from app.agents import director_claude as DC
from app.agents.tools import TOOL_DECLS
from app.db import SessionLocal, utcnow
from app.models import AgentMessage, CostEntry
from conftest import H, ok

USAGE = {"input_tokens": 1000, "output_tokens": 200, "cache_creation_input_tokens": 500, "cache_read_input_tokens": 3000}
THINK = {"type": "thinking", "thinking": "", "signature": "sig-1"}  # adaptive thinking: empty text, signed


def text(t: str) -> dict:
    return {"type": "text", "text": t}


def tool(tid: str, name: str, args: dict | None = None) -> dict:
    return {"type": "tool_use", "id": tid, "name": name, "input": args or {}}


def msg(content: list[dict], stop: str = "end_turn", usage: dict | None = None, **kw) -> BetaMessage:
    return BetaMessage.model_validate({"id": "msg_test", "type": "message", "role": "assistant", "model": "claude-sonnet-5-5",
                                       "content": content, "stop_reason": stop, "stop_sequence": None,
                                       "usage": usage or USAGE, **kw})


def bad_request() -> anthropic.BadRequestError:
    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return anthropic.BadRequestError("thinking block history was edited", response=httpx2.Response(400, request=req), body=None)


class FakeClient:
    """Stands in for anthropic.Anthropic: records each beta.messages.create call and plays back a script."""

    def __init__(self, *script):
        self.script, self.calls = list(script), []
        self.beta = SimpleNamespace(messages=self)

    def create(self, **kw):
        self.calls.append(copy.deepcopy(kw))
        r = self.script.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


@pytest.fixture
def claude(monkeypatch):
    """Anthropic live, Gemini mock (so tools still use mock providers); returns a loader for the fake client's script."""
    monkeypatch.setattr(director, "provider_mode", lambda p: {"anthropic": "live"}.get(p, "mock"))
    box: dict = {}

    def load(*script) -> FakeClient:
        box["fake"] = FakeClient(*script)
        return box["fake"]

    monkeypatch.setattr(DC, "_client", lambda key: box["fake"])
    return load


def project(c: TestClient, concept: str = "A lamp that remembers every prayer") -> tuple[int, int]:
    p = ok(c.post("/api/projects", headers=H, json={"concept": concept, "type": "short"}))
    return p["id"], p["episodes"][0]["id"]


def chat(c: TestClient, pid: int, eid: int, message: str) -> dict:
    return ok(c.post(f"/api/projects/{pid}/agent/chat", headers=H, json={"message": message, "episode_id": eid}))[0]


def segments(pid: int) -> list[dict]:
    with SessionLocal() as db:
        rows = (db.query(AgentMessage).filter(AgentMessage.project_id == pid, AgentMessage.role == "assistant")
                .order_by(AgentMessage.id).all())
        return [r.data["claude"] for r in rows if (r.data or {}).get("claude")]


def test_tool_loop_request_shape_and_cost(client: TestClient, claude):
    pid, eid = project(client)
    fake = claude(msg([THINK, tool("tu1", "get_project_state"), tool("tu2", "update_shot", {"shot_code": "E09-SH99", "changes": {}})],
                      "tool_use"),
                  msg([THINK, text("All good.")]))
    out = chat(client, pid, eid, "how is it going?")
    assert out["content"] == "All good." and out["data"]["engine"] == "claude"
    assert "claude" not in out["data"]  # the raw API conversation stays on the server

    first, second = fake.calls
    # tools: TOOL_DECLS in the Anthropic shape, sorted by name, the same every call
    assert [t["name"] for t in first["tools"]] == sorted(d["name"] for d in TOOL_DECLS)
    decl = next(d for d in TOOL_DECLS if d["name"] == "update_shot")
    assert next(t for t in first["tools"] if t["name"] == "update_shot") == {
        "name": "update_shot", "description": decl["description"], "input_schema": decl["parameters"]}
    assert second["tools"] == first["tools"] and second["system"] == first["system"] == prompts.DIRECTOR_AGENT
    # request: model, effort, automatic caching, server-side fallback; no thinking / tool_choice / temperature
    assert first["model"] == "claude-sonnet-5-5" and first["max_tokens"] == 16000
    assert first["output_config"] == {"effort": "medium"} and first["cache_control"] == {"type": "ephemeral"}
    assert first["betas"] == ["server-side-fallback-2026-07-01"] and first["fallbacks"] == "default"
    assert not {"thinking", "tool_choice", "temperature"} & set(first)
    # the user turn: the studio's context first, then the message
    [user] = first["messages"]
    assert user["role"] == "user" and user["content"][0]["text"].startswith("[Context")
    assert "Current episode: 1" in user["content"][0]["text"] and user["content"][1]["text"] == "how is it going?"
    # step 2: the assistant turn sent back unchanged (signed thinking + both calls), then ONE user message with both results
    assert second["messages"][0] == user
    assert second["messages"][1] == {"role": "assistant", "content": [THINK, tool("tu1", "get_project_state"),
                                                                      tool("tu2", "update_shot", {"shot_code": "E09-SH99", "changes": {}})]}
    results = second["messages"][2]
    assert results["role"] == "user" and len(second["messages"]) == 3
    assert [(r["type"], r["tool_use_id"]) for r in results["content"]] == [("tool_result", "tu1"), ("tool_result", "tu2")]
    assert json.loads(results["content"][0]["content"])["episode"]["number"] == 1 and "is_error" not in results["content"][0]
    assert results["content"][1]["is_error"] is True and "No shot" in results["content"][1]["content"]

    with SessionLocal() as db:  # one cost entry per step, input / cache write / cache read / output each at its own rate
        rows = db.query(CostEntry).filter(CostEntry.project_id == pid, CostEntry.provider == "anthropic").all()
        assert len(rows) == 2 and rows[0].model == "claude-sonnet-5-5" and rows[0].kind == "agent"
        assert rows[0].units == 4700 and rows[0].usd == pytest.approx((1000 * 2 + 500 * 2.5 + 3000 * 0.2 + 200 * 10) / 1e6)


def test_cost_counts_every_fallback_attempt(client: TestClient):
    its = [{"type": "message", "input_tokens": 800, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
           {"type": "fallback_message", "model": "claude-sonnet-5", "input_tokens": 800, "output_tokens": 100,
            "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}]
    m = msg([text("x")], usage={**USAGE, "iterations": its})
    tokens, usd = DC.cost(settings_store.prices(), "claude-sonnet-5-5", m.usage)
    assert tokens == 1700 and usd == pytest.approx((1600 * 2 + 100 * 10) / 1e6)


def test_second_turn_replays_the_first_unchanged(client: TestClient, claude):
    pid, eid = project(client)
    fake = claude(msg([THINK, tool("a1", "get_project_state")], "tool_use"), msg([THINK, text("Hello.")]),
                  msg([THINK, text("Second.")]))
    chat(client, pid, eid, "hi")
    assert chat(client, pid, eid, "and again")["content"] == "Second."
    c1, c2, c3 = fake.calls
    turn1 = c2["messages"] + [{"role": "assistant", "content": [THINK, text("Hello.")]}]
    assert c3["messages"][: len(turn1)] == turn1  # append-only: the whole first turn, byte for byte
    assert c3["system"] == c1["system"] and c3["tools"] == c1["tools"]
    nxt = c3["messages"][len(turn1)]
    assert len(c3["messages"]) == len(turn1) + 1 and nxt["role"] == "user" and nxt["content"][1]["text"] == "and again"
    s1, s2 = segments(pid)
    assert s1["thread"] == s2["thread"] and (s1["turn"], s2["turn"]) == (0, 1) and s1["messages"] == turn1
    assert s2["input_tokens"] == 4500 and s2["fingerprint"] == DC.fingerprint("claude-sonnet-5-5")
    assert all("claude" not in m["data"] for m in ok(client.get(f"/api/projects/{pid}/agent/messages")))


def test_fresh_thread_after_bad_request_and_fingerprint_change(client: TestClient, claude, monkeypatch):
    pid, eid = project(client)
    fake = claude(msg([text("One.")]), bad_request(), msg([text("Two.")]))
    chat(client, pid, eid, "one")
    assert chat(client, pid, eid, "two")["content"] == "Two."
    _, rejected, retried = fake.calls
    assert len(rejected["messages"]) == 3  # turn 1 + the new user turn: rejected …
    assert len(retried["messages"]) == 1 and retried["messages"][0]["content"][1]["text"] == "two"  # … so a fresh thread
    s1, s2 = segments(pid)
    assert s1["thread"] != s2["thread"] and s2["turn"] == 0

    # tools changed (or the model, or the system prompt): the stored thread can't continue
    monkeypatch.setattr(DC, "TOOLS", DC.TOOLS[:-1])
    fake = claude(msg([text("Three.")]))
    chat(client, pid, eid, "three")
    [call] = fake.calls
    assert len(call["messages"]) == 1 and len(call["tools"]) == len(TOOL_DECLS) - 1
    assert segments(pid)[-1]["thread"] not in (s1["thread"], s2["thread"])

    # a rejected request on a thread with no history is reported, not retried, and stores nothing
    monkeypatch.setattr(DC, "TOOLS", DC.TOOLS[:-1])
    fake = claude(bad_request())
    out = chat(client, pid, eid, "four")
    assert out["content"].startswith("Sorry — the AI service failed (400)") and len(fake.calls) == 1
    assert len(segments(pid)) == 3


def test_thread_rotates_when_large_or_idle(client: TestClient, claude):
    pid, eid = project(client)
    fake = claude(msg([text("One.")]), msg([text("Two.")]), msg([text("Three.")]))

    def last_turn(change) -> None:
        with SessionLocal() as db:
            m = (db.query(AgentMessage).filter(AgentMessage.project_id == pid, AgentMessage.role == "assistant")
                 .order_by(AgentMessage.id.desc()).first())
            change(m)
            db.commit()

    chat(client, pid, eid, "one")
    last_turn(lambda m: setattr(m, "data", {**m.data, "claude": {**m.data["claude"], "input_tokens": 70_000}}))
    chat(client, pid, eid, "two")
    last_turn(lambda m: setattr(m, "created_at", utcnow() - timedelta(hours=7)))
    chat(client, pid, eid, "three")
    assert [len(call["messages"]) for call in fake.calls] == [1, 1, 1]
    assert len({s["thread"] for s in segments(pid)}) == 3


def test_refusal_is_reported_and_not_replayed(client: TestClient, claude):
    pid, eid = project(client)
    fake = claude(msg([text("Hi.")]),
                  msg([], "refusal", stop_details={"type": "refusal", "category": "cyber", "explanation": None}),
                  msg([text("Back.")]))
    chat(client, pid, eid, "hi")
    out = chat(client, pid, eid, "something it declines")
    assert "declined" in out["content"] and out["data"]["refusal"] == "cyber" and out["data"]["engine"] == "claude"
    assert len(segments(pid)) == 1  # the declined turn is not part of the thread
    chat(client, pid, eid, "next")
    c3 = fake.calls[2]
    assert [m["role"] for m in c3["messages"]] == ["user", "assistant", "user"]
    assert c3["messages"][:2] == fake.calls[0]["messages"] + [{"role": "assistant", "content": [text("Hi.")]}]
    ctx = c3["messages"][2]["content"][0]["text"]
    assert "declined the user's previous request" in ctx and "something it declines" not in ctx


def test_cut_off_reply_keeps_the_thread_valid(client: TestClient, claude):
    pid, eid = project(client)
    fake = claude(msg([THINK, text("Partial answer"), tool("x1", "get_project_state")], "max_tokens"), msg([text("ok")]))
    assert chat(client, pid, eid, "a")["content"] == "Partial answer"
    chat(client, pid, eid, "b")
    roles = [m["role"] for m in fake.calls[1]["messages"]]
    assert roles == ["user", "assistant", "user", "user"]
    [res] = fake.calls[1]["messages"][2]["content"]
    assert res["tool_use_id"] == "x1" and res["is_error"] is True  # the cut-off call is answered, never run


def test_confirm_reply_shows_up_in_the_next_context(client: TestClient, claude):
    pid, eid = project(client, "A boatman who ferries ghosts")
    ok(client.post(f"/api/episodes/{eid}/script/generate", headers=H, json={}))
    fake = claude(msg([THINK, tool("w1", "write_script", {"instructions": "darker"})], "tool_use"),
                  msg([text("That would replace your script. Confirm below if you want it.")]),
                  msg([text("Glad it worked.")]))
    first = chat(client, pid, eid, "rewrite the script, darker")
    [item] = first["data"]["confirmations"]
    assert item["status"] == "pending" and item["tool"] == "write_script"
    waiting = json.loads(fake.calls[1]["messages"][2]["content"][0]["content"])
    assert waiting["status"] == "waiting_for_user_confirmation"

    done = ok(client.post(f"/api/projects/{pid}/agent/messages/{first['id']}/confirm", headers=H,
                          json={"id": item["id"], "approve": True}))
    assert done["status"] == "done" and done["result"].startswith("Script rewritten")
    chat(client, pid, eid, "thanks")
    c3 = fake.calls[2]
    turn1 = fake.calls[1]["messages"] + [{"role": "assistant", "content": [text("That would replace your script. Confirm below if you want it.")]}]
    assert c3["messages"][: len(turn1)] == turn1 and len(c3["messages"]) == len(turn1) + 1  # the card kept the thread intact
    ctx = c3["messages"][-1]["content"][0]["text"]
    assert f"the user confirmed 'Rewrite the script' → {done['result']}" in ctx


ENGINE_CASES = [  # (team preference, Anthropic, Gemini) → engine
    ("claude", "live", "live", "claude"), ("claude", "live", "mock", "claude"), ("claude", "mock", "live", "gemini"),
    ("claude", "missing", "live", "gemini"), ("claude", "mock", "mock", "mock"),
    ("gemini", "live", "live", "gemini"), ("gemini", "mock", "live", "gemini"),
    ("gemini", "live", "mock", "mock"),  # picked Gemini: never silently Claude
]


@pytest.mark.parametrize("pref,anth,gem,want", ENGINE_CASES)
def test_engine_choice(client: TestClient, monkeypatch, pref, anth, gem, want):
    monkeypatch.setattr(director, "provider_mode", lambda p: {"anthropic": anth, "gemini": gem}.get(p, "mock"))
    with SessionLocal() as db:
        settings_store.set_setting(db, "director_engine", pref)
        db.commit()
        try:
            assert director.engine(db) == want
        finally:
            settings_store.set_setting(db, "director_engine", "claude")
            db.commit()


def test_engine_setting_key_and_mock_banner(client: TestClient, monkeypatch):
    assert settings_store.DEFAULTS["director_engine"] == "claude" and settings_store.DEFAULTS["director_claude_effort"] == "medium"
    s = ok(client.patch("/api/settings", headers=H, json={"director_engine": "gemini"}))
    assert s["settings"]["director_engine"] == "gemini" and s["models"]["director_claude"] == "claude-sonnet-5-5"
    ok(client.patch("/api/settings", headers=H, json={"director_engine": "claude"}))
    # the Anthropic key: listed with the other services, saved from Settings or read from .env
    assert any(p["provider"] == "anthropic" for p in ok(client.get("/api/providers")))
    assert "anthropic" in [k["provider"] for k in ok(client.get("/api/settings/api-keys"))]
    ok(client.put("/api/settings/api-keys/anthropic", headers=H, json={"key": "sk-ant-test-0123456789"}))
    try:
        assert settings_store.api_key("anthropic") == "sk-ant-test-0123456789"
    finally:
        ok(client.delete("/api/settings/api-keys/anthropic", headers=H))
    monkeypatch.setattr(settings_store.get_settings(), "anthropic_api_key", "sk-ant-env-0123456789")
    assert settings_store.api_key("anthropic") == "sk-ant-env-0123456789"
    # MOCK_PROVIDERS=true: the keyword mock answers, and says which keys bring the real Director
    pid, eid = project(client)
    out = chat(client, pid, eid, "how is it going?")
    assert out["data"]["engine"] == "mock" and out["content"].startswith("(Mock agent — add an Anthropic or Gemini key")
