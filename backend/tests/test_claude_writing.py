"""Writing and reviews on Claude: routing (who writes, listening checks), structured output, images, video frames, web
research, effort, cost and errors. No live key: a fake Anthropic client returns scripted SDK responses."""
from __future__ import annotations

import base64
import io
import json
from types import SimpleNamespace

import anthropic
import httpx2
import pytest
from anthropic.types.beta import BetaMessage
from PIL import Image

from app import settings_store
from app.agents import prompts
from app.agents import schemas as S
from app.db import SessionLocal
from app.providers import claude_text as CT
from app.providers import mock
from app.providers import services as services_mod
from app.providers.base import ProviderBlocked, ProviderNotConfigured, RetryableProviderError

USAGE = {"input_tokens": 1000, "output_tokens": 500, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
HOOKS = {"hooks": [{"text": "Who lit the lamp?", "type": "question", "visual": "A diya flickers in an empty room",
                    "scores": {"curiosity": 9, "clarity": 8, "visual": 9, "platform_fit": 8}, "total": 8.5}]}
TRENDS = {"trends": ["POV mini-dramas"], "hook_patterns": ["Cold open on the twist"], "sounds_or_formats": [], "cautions": []}


def msg(content: list[dict], stop: str = "end_turn", **kw) -> BetaMessage:
    return BetaMessage.model_validate({"id": "msg_test", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
                                       "content": content, "stop_reason": stop, "stop_sequence": None, "usage": USAGE, **kw})


def answer(data: dict) -> BetaMessage:
    return msg([{"type": "thinking", "thinking": "", "signature": "sig"}, {"type": "text", "text": json.dumps(data)}])


class FakeStream:
    def __init__(self, m):
        self.m = m

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_final_message(self):
        return self.m


class FakeClient:
    """Stands in for anthropic.Anthropic: records each beta.messages.stream call and plays back a script."""

    def __init__(self, *script):
        self.script, self.calls = list(script), []
        self.beta = SimpleNamespace(messages=self)

    def stream(self, **kw):
        self.calls.append(kw)
        r = self.script.pop(0)
        if isinstance(r, Exception):
            raise r
        return FakeStream(r)


def set_settings(**kw) -> None:
    with SessionLocal() as db:
        for k, v in kw.items():
            settings_store.set_setting(db, k, v)
        db.commit()


@pytest.fixture
def claude(client, monkeypatch):
    """Anthropic live (Gemini/OpenRouter mock) with a key; returns a loader for the fake client's script. Settings this
    test changes go back to their defaults afterwards."""
    modes = {"anthropic": "live"}
    monkeypatch.setattr(services_mod, "provider_mode", lambda p: modes.get(p, "mock"))
    real_key = settings_store.api_key
    monkeypatch.setattr(settings_store, "api_key", lambda p: "sk-test" if p == "anthropic" else real_key(p))
    box: dict = {"modes": modes}

    def load(*script) -> FakeClient:
        box["fake"] = FakeClient(*script)
        return box["fake"]

    monkeypatch.setattr(CT, "_client", lambda key: box["fake"])
    load.modes = modes  # type: ignore[attr-defined]
    yield load
    defaults = settings_store.DEFAULTS
    set_settings(**{k: defaults[k] for k in ("text_provider", "writer_claude_model", "writer_claude_effort",
                                              "listen_checks_gemini")})


def png(w: int = 3000, h: int = 2000) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", (w, h), (200, 120, 40, 255)).save(buf, "PNG")
    return buf.getvalue()


def test_route_claude_by_default_listening_on_gemini(claude):
    svc = services_mod.Services()
    modes = claude.modes
    assert settings_store.DEFAULTS["text_provider"] == "anthropic"
    modes["gemini"] = "live"
    assert svc.text_route() == "anthropic"
    assert svc.text_route(videos=True) == "gemini" and svc.can_listen()  # Claude can't hear: listening checks on Gemini
    set_settings(listen_checks_gemini=False)
    assert svc.text_route(videos=True) == "anthropic" and not svc.can_listen()  # Anthropic only: listening checks skipped
    set_settings(text_provider="gemini")
    assert svc.text_route() == "gemini"  # a team that picked Gemini never gets Claude
    set_settings(text_provider="anthropic")
    modes["anthropic"] = "missing"
    assert svc.text_route() == "gemini"  # no Anthropic key: Gemini writes
    modes["openrouter"], modes["gemini"] = "live", "missing"
    assert svc.text_route() == "openrouter"  # nor Gemini: OpenRouter writes


def test_writing_on_claude_structured_output(claude):
    fake = claude(answer(HOOKS))
    with SessionLocal() as db:
        prices = settings_store.prices(db)
    obj, usage = services_mod.Services().llm_json("hooks", prompts.HOOKS, "Write 1 hook.", S.HooksOut, images=[png()])
    assert obj.hooks[0].text == "Who lit the lamp?"
    p = prices["text_per_million"]["claude-opus-5-5"]
    assert (usage.provider, usage.model, usage.kind, usage.units) == ("anthropic", "claude-opus-5-5", "llm:hooks", 1500)
    assert usage.usd == pytest.approx((1000 * p["in"] + 500 * p["out"]) / 1e6)
    call = fake.calls[0]
    assert call["model"] == "claude-opus-5-5" and call["system"] == prompts.HOOKS
    assert call["betas"] == ["server-side-fallback-2026-07-01"] and call["fallbacks"] == "default"
    assert "thinking" not in call and "temperature" not in call  # adaptive thinking is on by itself; sampling is fixed
    fmt = call["output_config"]["format"]
    assert call["output_config"]["effort"] == "medium" and fmt["type"] == "json_schema"
    assert fmt["schema"]["additionalProperties"] is False and "hooks" in fmt["schema"]["required"]
    content = call["messages"][0]["content"]
    assert [b["type"] for b in content] == ["image", "text"] and content[-1]["text"] == "Write 1 hook."
    img = Image.open(io.BytesIO(base64.b64decode(content[0]["source"]["data"])))
    assert content[0]["source"]["media_type"] == "image/jpeg" and max(img.size) == CT.IMAGE_EDGE  # downscaled JPEG


def test_model_and_effort_settings(claude):
    set_settings(writer_claude_model="claude-sonnet-5-5", writer_claude_effort="high")
    fake = claude(answer({"overall": 8, "scores": {k: 8 for k in S.CriticScores.model_fields}, "strengths": [],
                          "problems": [], "rewrite_instructions": "Tighten scene 2."}),
                  answer({"identity_match": 0.9, "outfit_match": True, "extra_people": False, "text_artifacts": False,
                          "hand_issues": False, "matches_action": True}))
    svc = services_mod.Services()
    _, usage = svc.llm_json("critic", prompts.CRITIC, "Critique.", S.CriticOut, pro=True)
    svc.llm_json("qc", prompts.QC, "Check.", S.QCOut)
    assert usage.model == "claude-sonnet-5-5" and fake.calls[0]["model"] == "claude-sonnet-5-5"
    assert [c["output_config"]["effort"] for c in fake.calls] == ["xhigh", "low"]  # critic one higher, reviews low
    assert CT.effort_for("script", "nonsense", False) == "medium" and CT.effort_for("critic", "max", True) == "max"


def test_trend_scout_researches_then_answers(claude):
    fake = claude(msg([{"type": "text", "text": "Mini-dramas with a cold open are rising on Reels."}]), answer(TRENDS))
    obj, usage = services_mod.Services().llm_json("trends", prompts.TREND_SCOUT, "Kannada devotional shorts.", S.TrendOut,
                                                  tools=[{"type": "google_search"}])
    assert obj.trends == ["POV mini-dramas"] and usage.units == 3000  # both calls billed
    research, final = fake.calls
    assert research["tools"] == [CT.WEB_SEARCH] and "format" not in research["output_config"]  # citations + schema don't mix
    assert "tools" not in final and final["output_config"]["format"]["type"] == "json_schema"
    assert "Mini-dramas with a cold open" in final["messages"][0]["content"][-1]["text"]


def test_paused_search_turn_is_continued(claude):
    paused = msg([{"type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": {"query": "reels trends"}}],
                 "pause_turn")
    fake = claude(paused, msg([{"type": "text", "text": "Found it."}]), answer(TRENDS))
    services_mod.Services().llm_json("trends", prompts.TREND_SCOUT, "x", S.TrendOut, tools=[{"type": "google_search"}])
    resumed = fake.calls[1]["messages"]
    assert [m["role"] for m in resumed] == ["user", "assistant"] and resumed[1]["content"][0]["type"] == "server_tool_use"


def test_video_goes_in_as_frames(claude, tmp_path):
    clip = tmp_path / "clip.mp4"
    mock.video_from(None, "a lamp", clip, 2, "9:16")
    fake = claude(answer({"sync_score": 0.8, "face_visible": True, "artifacts": False}))
    claude.modes["gemini"] = "mock"  # no live Gemini: even a listening prompt reaches Claude, which sees only frames
    services_mod.Services().llm_json("lipsync_qc", "Review.", "Score it.", S.LipsyncQCOut, videos=[clip.read_bytes()])
    content = fake.calls[0]["messages"][0]["content"]
    assert [b["type"] for b in content].count("image") == CT.VIDEO_FRAMES
    assert "can't hear its audio" in content[-1]["text"]


def test_errors_map_to_studio_errors(claude):
    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    limited = anthropic.RateLimitError("slow down", response=httpx2.Response(429, request=req, headers={"retry-after": "12"}),
                                       body=None)
    svc = services_mod.Services()
    claude(limited)
    with pytest.raises(RetryableProviderError) as e:
        svc.llm_json("hooks", prompts.HOOKS, "x", S.HooksOut)
    assert e.value.status == 429 and e.value.retry_after == 12
    claude(msg([], "refusal", stop_details={"type": "refusal", "category": "cyber", "explanation": None}))
    with pytest.raises(ProviderBlocked):
        svc.llm_json("hooks", prompts.HOOKS, "x", S.HooksOut)
    bad = msg([{"type": "text", "text": '{"hooks": [{"text": "cut off'}], "max_tokens")
    fake = claude(bad, bad)
    with pytest.raises(RetryableProviderError):
        svc.llm_json("hooks", prompts.HOOKS, "x", S.HooksOut)
    assert len(fake.calls) == 2  # retried once
    with pytest.raises(ProviderNotConfigured):
        CT.ClaudeText("")
