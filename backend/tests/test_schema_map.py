"""The schema mapper must turn real model schemas (captured from fal.ai, Oct 2026) into correct requests."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.providers.schema_map import GenRequest, build_args, build_param_map, derive_capabilities, extract_url

FIX = json.loads((Path(__file__).parent / "fixtures" / "fal_models.json").read_text(encoding="utf-8"))
MODELS = {m["endpoint_id"]: m for m in FIX["models"]}


def cap(eid: str):
    m = MODELS[eid]
    pm = build_param_map(m["openapi"])
    return pm, derive_capabilities(m["metadata"]["category"], eid, pm)


def upload(p: Path) -> str:
    return f"https://cdn.test/{p.name}"


@pytest.mark.parametrize("eid,task,modes", [
    ("fal-ai/kling-video/v3/pro/image-to-video", "video", {"i2v", "flf", "ref2v"}),
    ("bytedance/seedance-2.5/reference-to-video", "video", {"ref2v"}),
    ("alibaba/wan-3.0/image-to-video", "video", {"i2v", "flf"}),
    ("minimax/h3-max/lip-sync/image-to-video", "avatar", {"a2v"}),
    ("lightricks/ltx-2.5/audio-to-video/pro", "avatar", {"a2v"}),
    ("fal-ai/kling-video/ai-avatar/v2/pro", "avatar", {"a2v"}),
    ("fal-ai/sync-lipsync/v3", "lipsync", {"lipsync"}),
    ("veed/lipsync/v2", "lipsync", {"lipsync"}),
    ("fal-ai/heygen/v3/lipsync/precision", "lipsync", {"lipsync"}),
    ("blackforestlabs/flux-3/first-last-frame-to-video", "video", {"flf"}),
    ("google/nano-banana-2.1", "image", {"t2i"}),
    ("bytedance/seedream/v5/pro/edit", "image", {"i2i"}),
    ("alibaba/wan-3.0/text-to-video", "video", {"t2v"}),
])
def test_capabilities(eid, task, modes):
    pm, caps = cap(eid)
    assert caps["task"] == task, (eid, caps)
    assert modes <= set(caps["modes"]), (eid, caps["modes"])
    assert caps["usable"], pm["unmapped_required"]


def test_kling_i2v_request():
    pm, caps = cap("fal-ai/kling-video/v3/pro/image-to-video")
    args = build_args(pm, caps, GenRequest(mode="i2v", prompt="hello", first_frame=Path("kf.png"), duration=8,
                                           aspect="9:16", negative="blur"), upload)
    assert args["start_image_url"] == "https://cdn.test/kf.png"
    assert args["duration"] == "8" and isinstance(args["duration"], str)  # Kling wants a string enum
    assert args["prompt"] == "hello" and args["negative_prompt"] == "blur"
    assert args["generate_audio"] is True


def test_wan_integer_duration_and_aspect():
    pm, caps = cap("alibaba/wan-3.0/image-to-video")
    args = build_args(pm, caps, GenRequest(mode="i2v", prompt="x", first_frame=Path("a.png"), duration=6, aspect="9:16",
                                           resolution="720p"), upload)
    assert args["duration"] == 6 and args["aspect_ratio"] == "9:16" and args["resolution"] == "720p"


def test_seedance_refs_array():
    pm, caps = cap("bytedance/seedance-2.5/reference-to-video")
    args = build_args(pm, caps, GenRequest(mode="ref2v", prompt="x", refs=[Path("a.png"), Path("b.png")], duration=8,
                                           aspect="9:16"), upload)
    assert args["image_urls"] == ["https://cdn.test/a.png", "https://cdn.test/b.png"]
    assert args["duration"] == "8"


def test_kling_o3_elements_or_images():
    pm, caps = cap("fal-ai/kling-video/o3/4k/reference-to-video")
    args = build_args(pm, caps, GenRequest(mode="ref2v", prompt="x", refs=[Path("a.png")], duration=7), upload)
    assert args.get("image_urls") == ["https://cdn.test/a.png"] or args.get("elements")


def test_h3_audio_driven_required_defaults():
    pm, caps = cap("minimax/h3-max/lip-sync/image-to-video")
    args = build_args(pm, caps, GenRequest(mode="a2v", first_frame=Path("kf.png"), audio=Path("line.wav")), upload)
    assert args["image_url"] == "https://cdn.test/kf.png" and args["audio_url"] == "https://cdn.test/line.wav"
    assert "duration" not in args


def test_h3_i2v_keeps_required_default():
    pm, caps = cap("minimax/h3-max/image-to-video")
    args = build_args(pm, caps, GenRequest(mode="i2v", prompt="x", first_frame=Path("kf.png"), duration=6), upload)
    assert args["prompt_expansion_mode"] == "balanced"  # required field filled from its default


def test_resolution_nearest():
    pm, caps = cap("minimax/h3-max/image-to-video")
    args = build_args(pm, caps, GenRequest(mode="i2v", prompt="x", first_frame=Path("kf.png"), resolution="720p"), upload)
    assert args["resolution"] == "768P"


def test_lipsync_video_audio():
    pm, caps = cap("fal-ai/sync-lipsync/v3")
    args = build_args(pm, caps, GenRequest(mode="lipsync", video=Path("v.mp4"), audio=Path("a.wav")), upload)
    assert args["video_url"].endswith("v.mp4") and args["audio_url"].endswith("a.wav")


def test_image_aspect():
    pm, caps = cap("google/nano-banana-2.1")
    args = build_args(pm, caps, GenRequest(mode="t2i", prompt="x", aspect="9:16"), upload)
    assert args["aspect_ratio"] == "9:16" and args["prompt"] == "x"


def test_extract_url():
    assert extract_url({"video": {"url": "https://x/v.mp4"}}, "video") == "https://x/v.mp4"
    assert extract_url({"images": [{"url": "https://x/i.png"}]}, "image") == "https://x/i.png"
    assert extract_url({"data": {"out": [{"url": "https://x/z.mp4", "content_type": "video/mp4"}]}}, "video") == "https://x/z.mp4"
