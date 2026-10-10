"""Writing and reviews on Claude (Anthropic Messages API): every writing task returns exactly its pydantic schema.

The schema goes in as structured output (the SDK turns the pydantic model into a strict JSON schema), images go in
natively, a video clip goes in as frames sampled across it (Claude reads images, not video or sound), and a task that
asked for Google Search researches with Anthropic's web search first, then answers in the schema. Adaptive thinking is
always on; effort sets how hard Claude thinks. A decline is retried server-side on another model (fallbacks="default").
Requests stream, so long answers (a whole shot list) never hit the HTTP timeout."""
from __future__ import annotations

import base64
import io
import tempfile
from pathlib import Path
from typing import Any, TypeVar

import anthropic
from pydantic import BaseModel, ValidationError

from .base import ProviderBlocked, ProviderError, ProviderNotConfigured, ProviderOutOfCredit, RetryableProviderError

T = TypeVar("T", bound=BaseModel)

DEFAULT_MODEL = "claude-opus-5-5"
EFFORTS = ("low", "medium", "high", "xhigh", "max")
BETAS = ["server-side-fallback-2026-07-01"]  # with fallbacks="default": a decline is retried on another model, same call
MAX_TOKENS = 64000  # thinking counts toward it; streaming keeps a long answer clear of the request timeout
WEB_SEARCH = {"type": "web_search_20260209", "name": "web_search", "max_uses": 3}  # results are input-heavy: 6 searches ≈ 60k tokens
IMAGE_EDGE = 1568  # Claude scales larger images down to this itself; doing it here keeps requests small
VIDEO_FRAMES = 8
# Scoring a picture against references needs little thinking: these run at low effort whatever the writing effort is
REVIEWS = {"qc", "keyframe_qc", "lipsync_qc", "dialogue_check"}


def effort_for(task: str, base: Any, pro: bool) -> str:
    """Reviews think little; "pro" tasks (the script critic) one level harder than the team's writing effort."""
    base = base if base in EFFORTS else "medium"
    if task in REVIEWS:
        return "low"
    if pro:
        return EFFORTS[min(EFFORTS.index(base) + 1, len(EFFORTS) - 1)]
    return base


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


def image_block(data: bytes) -> dict:
    """An image for Claude: at most IMAGE_EDGE px on the long side, as JPEG (PNG keyframes are often several MB)."""
    from PIL import Image
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception as e:  # noqa: BLE001 - anything Pillow can't read can't be shown to Claude either
        raise ProviderError(f"not an image Claude can read: {e}", provider="anthropic") from e
    if max(im.size) > IMAGE_EDGE:
        im.thumbnail((IMAGE_EDGE, IMAGE_EDGE))
    if im.mode != "RGB":
        im = im.convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=88)
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                        "data": base64.b64encode(buf.getvalue()).decode()}}


def video_frames(data: bytes, n: int = VIDEO_FRAMES) -> tuple[list[bytes], float]:
    """`n` frames sampled evenly across a clip, and the clip's length in seconds."""
    from ..pipeline import ffmpeg as ff
    d = Path(tempfile.mkdtemp(prefix="veo_claude_"))
    clip = d / "clip.mp4"
    clip.write_bytes(data)
    return [f.read_bytes() for f in ff.extract_frames(clip, d, n) if f.exists()], ff.duration(clip)


def _text(content: list[Any]) -> str:
    return "".join(getattr(b, "text", "") or "" for b in content if getattr(b, "type", "") == "text").strip()


def _error(e: anthropic.APIError) -> ProviderError:
    """The studio's own error types, so the job queue retries, waits or stops as it does for every provider."""
    if isinstance(e, anthropic.RateLimitError):
        after = e.response.headers.get("retry-after")
        return RetryableProviderError(f"Anthropic rate limit: {e.message}", provider="anthropic", status=429,
                                      retry_after=float(after) if after and after.replace(".", "", 1).isdigit() else None)
    if isinstance(e, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return ProviderError(f"The Anthropic key was rejected ({e.status_code}). Check it in Settings → AI services.",
                             provider="anthropic", status=e.status_code)
    if isinstance(e, anthropic.APIStatusError):
        if e.status_code >= 500 or e.status_code in (408, 409):
            return RetryableProviderError(f"Anthropic failed ({e.status_code}): {e.message}", provider="anthropic",
                                          status=e.status_code)
        if "credit balance" in (e.message or "").lower():
            return ProviderOutOfCredit(f"Anthropic: {e.message}", provider="anthropic", status=e.status_code)
        return ProviderError(f"Anthropic rejected the request ({e.status_code}): {e.message}", provider="anthropic",
                             status=e.status_code)
    return RetryableProviderError(f"couldn't reach Anthropic: {e}", provider="anthropic")  # connection, timeout


def _client(key: str) -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=key)  # retries 429 / 5xx / connection errors twice by itself


class ClaudeText:
    def __init__(self, api_key: str, model: str = DEFAULT_MODEL, prices: dict | None = None):
        if not api_key:
            raise ProviderNotConfigured("No API key for anthropic. Add it in Admin → Settings or .env", provider="anthropic")
        self.client = _client(api_key)
        self.model = model
        self.prices = prices or {}

    def _ask(self, system: str, messages: list[dict], output_config: dict, **kw) -> tuple[Any, int, float]:
        """One streamed request (fallback on, adaptive thinking). Returns (final message, tokens, USD)."""
        if not self.model.startswith("claude-haiku"):  # Haiku has no server-side fallback: a decline stays declined
            kw.update(betas=BETAS, fallbacks="default")
        try:
            with self.client.beta.messages.stream(
                    model=self.model, max_tokens=MAX_TOKENS, system=system, messages=messages, output_config=output_config,
                    **kw) as stream:
                msg = stream.get_final_message()
        except anthropic.APIError as e:
            raise _error(e) from e
        tokens, usd = cost(self.prices, self.model, msg.usage)
        if msg.stop_reason == "refusal":  # before reading content: a decline can come back empty or cut short
            category = getattr(getattr(msg, "stop_details", None), "category", None)
            raise ProviderBlocked(f"Claude declined this request{f' ({category})' if category else ''}", provider="anthropic")
        return msg, tokens, usd

    def research(self, system: str, prompt: str, effort: str) -> tuple[str, int, float]:
        """Findings from Anthropic's web search, as plain text (search answers carry citations, which can't be combined
        with structured output, so the schema comes in a second call)."""
        messages: list[dict] = [{"role": "user", "content": prompt}]
        tokens, usd, parts = 0, 0.0, []
        for _ in range(4):  # a long search turn pauses; sending it back lets it carry on
            msg, t, u = self._ask(system, messages, {"effort": effort}, tools=[WEB_SEARCH])
            tokens, usd = tokens + t, usd + u
            parts.append(_text(msg.content))
            if msg.stop_reason != "pause_turn":
                break
            messages = [*messages, {"role": "assistant", "content": [b.to_dict(mode="json") for b in msg.content]}]
        return "\n\n".join(p for p in parts if p), tokens, usd

    def json(self, system: str, prompt: str, schema: type[T], *, effort: str = "medium",
             images: list[bytes] | None = None, videos: list[bytes] | None = None,
             search: bool = False) -> tuple[T, int, float]:
        """The answer as an instance of `schema`, plus (tokens, USD) for the cost ledger."""
        tokens, usd = 0, 0.0
        if search:
            found, tokens, usd = self.research(system, prompt, effort)
            prompt = f"{prompt}\n\nWhat your web research found:\n{found or '(nothing useful)'}"
        content: list[dict] = [image_block(b) for b in images or []]
        notes = []
        for v in videos or []:
            frames, secs = video_frames(v)
            content += [image_block(f) for f in frames]
            notes.append(f"{len(frames)} frames sampled evenly across a {secs:.1f} s clip")
        if notes:  # be honest about what Claude can judge: it sees frames and hears nothing
            prompt += ("\n\n(The video is shown as " + "; ".join(notes) + ". You can't hear its audio: judge only what "
                       "the frames show.)")
        content.append({"type": "text", "text": prompt})
        # the strict JSON schema the API enforces (constraints it doesn't support move into descriptions); the answer is
        # validated here rather than by the SDK while it streams, so a cut-off answer is retried and still billed
        fmt = {"type": "json_schema", "schema": anthropic.transform_schema(schema)}
        last: Exception | None = None
        for _ in range(2):
            msg, t, u = self._ask(system, [{"role": "user", "content": content}], {"effort": effort, "format": fmt})
            tokens, usd = tokens + t, usd + u
            try:
                return schema.model_validate_json(_text(msg.content)), tokens, usd
            except ValidationError as e:  # cut off at the token limit, most likely
                last = e
        raise RetryableProviderError(f"model output did not match schema: {last}", provider="anthropic")
