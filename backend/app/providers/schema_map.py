"""Reads a model's OpenAPI input schema and maps the studio's standard request onto it.

Every hosted model names its inputs differently (start_image_url vs image_url, image_urls vs elements,
duration "5" vs 5 …). This module finds the matching field for each *slot* (prompt, first frame, refs,
audio, duration …), derives what the model can do, and builds the request body. New models that follow
common naming work automatically; admins can still override the mapping per model.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

SLOT_ALIASES: dict[str, list[str]] = {
    "prompt": ["prompt", "text_prompt"],
    "text": ["text", "input"],  # TTS
    "negative": ["negative_prompt"],
    "first_frame": ["start_image_url", "image_url", "first_frame_url", "first_frame_image_url", "input_image_url",
                    "init_image_url"],
    "last_frame": ["end_image_url", "last_frame_url", "tail_image_url", "last_frame_image_url"],
    "refs": ["image_urls", "reference_image_urls", "reference_images", "ref_image_urls", "subject_image_urls",
             "input_image_urls"],
    "elements": ["elements"],
    "audio": ["audio_url", "target_audio_url", "driving_audio_url", "speech_url", "voice_url"],
    "audios": ["audio_urls", "reference_audio_urls"],
    "video": ["video_url", "input_video_url", "source_video_url"],
    "videos": ["video_urls", "reference_video_urls"],
    "duration": ["duration", "duration_seconds", "num_seconds", "seconds"],
    "aspect": ["aspect_ratio"],
    "resolution": ["resolution", "video_resolution"],
    "image_size": ["image_size"],
    "seed": ["seed"],
    "gen_audio": ["generate_audio", "audio", "enable_audio", "with_audio"],
    "num_images": ["num_images", "num_outputs"],
    "voice": ["voice", "voice_id", "speaker"],
    "language": ["language", "language_code", "lang"],
    "loras": ["loras", "lora_weights"],
}
SLOT_KIND = {  # expected JSON type for a slot
    "prompt": "string", "text": "string", "negative": "string", "first_frame": "string", "last_frame": "string",
    "refs": "array", "elements": "array", "audio": "string", "audios": "array", "video": "string", "videos": "array",
    "duration": "number", "aspect": "string", "resolution": "string", "image_size": "any", "seed": "integer",
    "gen_audio": "boolean", "num_images": "integer", "voice": "string", "language": "string", "loras": "array",
}
VIDEO_CATS = {"text-to-video", "image-to-video", "video-to-video", "audio-to-video", "reference-to-video"}
IMAGE_CATS = {"text-to-image", "image-to-image"}


@dataclass
class GenRequest:
    """The studio's standard request. Any engine receives the same thing."""
    mode: str  # t2v i2v ref2v flf a2v lipsync extend edit t2i i2i tts
    prompt: str = ""
    negative: str = ""
    first_frame: Path | None = None
    last_frame: Path | None = None
    refs: list[Path] = field(default_factory=list)
    audio: Path | None = None
    video: Path | None = None
    video_uri: str = ""  # the engine's own URI for `video` (Veo extends its clips only by URI)
    duration: float | None = None
    aspect: str = "9:16"
    resolution: str = "720p"
    seed: int | None = None
    generate_audio: bool = True
    text: str = ""
    voice: str = ""
    language: str = ""
    loras: list[dict] = field(default_factory=list)  # [{path, scale}] for engines with a loras input


# ── schema reading ───────────────────────────────────────────────────────────

def _resolve(v: dict, comps: dict) -> dict:
    if "$ref" in v:
        return comps.get(v["$ref"].split("/")[-1], {})
    if "allOf" in v and v["allOf"]:
        merged = dict(_resolve(v["allOf"][0], comps))
        merged.update({k: x for k, x in v.items() if k != "allOf"})
        return merged
    return v


def describe(v: dict, comps: dict) -> dict[str, Any]:
    """→ {types:set, enum:list|None, items:dict|None, min, max, default, max_items}"""
    v = _resolve(v, comps)
    types: set[str] = set()
    enum = v.get("enum")
    items = None
    if "anyOf" in v or "oneOf" in v:
        for alt in v.get("anyOf") or v.get("oneOf"):
            d = describe(alt, comps)
            types |= d["types"]
            enum = enum or d["enum"]
            items = items or d["items"]
    t = v.get("type")
    if isinstance(t, list):
        types |= set(t)
    elif t:
        types.add(t)
    if "items" in v:
        items = _resolve(v["items"], comps)
    types.discard("null")
    return {"types": types or {"any"}, "enum": enum, "items": items, "min": v.get("minimum"), "max": v.get("maximum"),
            "default": v.get("default"), "max_items": v.get("maxItems")}


def input_schema(openapi: dict) -> tuple[dict, dict]:
    comps = (openapi or {}).get("components", {}).get("schemas", {})
    for path, ops in (openapi or {}).get("paths", {}).items():
        post = (ops or {}).get("post")
        if post and "requestBody" in post and "/requests/" not in path:
            sch = post["requestBody"].get("content", {}).get("application/json", {}).get("schema", {})
            return _resolve(sch, comps), comps
    name = next((k for k in comps if k.endswith("Input")), None)
    return comps.get(name, {}), comps


def _type_ok(kind: str, types: set[str]) -> bool:
    if kind == "any" or "any" in types:
        return True
    if kind == "number":
        return bool(types & {"number", "integer", "string"})
    return kind in types or (kind == "integer" and "number" in types)


def build_param_map(openapi: dict) -> dict[str, Any]:
    """Derive {slots:{slot:{name,types,enum,...}}, required_defaults:{}, unmapped_required:[]} from an OpenAPI doc."""
    sch, comps = input_schema(openapi)
    props = sch.get("properties", {}) or {}
    required = list(sch.get("required", []) or [])
    slots: dict[str, dict] = {}
    used: set[str] = set()
    for slot, aliases in SLOT_ALIASES.items():
        for name in aliases:
            if name in props and name not in used:
                d = describe(props[name], comps)
                if not _type_ok(SLOT_KIND[slot], d["types"]):
                    continue
                if slot == "gen_audio" and "boolean" not in d["types"]:
                    continue
                slots[slot] = {"name": name, "types": sorted(d["types"]), "enum": d["enum"], "min": d["min"],
                               "max": d["max"], "default": d["default"], "max_items": d["max_items"],
                               "required": name in required}
                used.add(name)
                break
    required_defaults, unmapped = {}, []
    for name in required:
        if name in used:
            continue
        d = describe(props.get(name, {}), comps)
        if d["default"] is not None:
            required_defaults[name] = d["default"]
        else:
            unmapped.append(name)
    return {"slots": slots, "required_defaults": required_defaults, "unmapped_required": unmapped,
            "property_names": sorted(props)}


def _durations(slot: dict | None) -> Any:
    if not slot:
        return None
    if slot.get("enum"):
        vals = []
        for e in slot["enum"]:
            try:
                vals.append(float(e))
            except (TypeError, ValueError):
                continue
        return sorted(set(vals)) or None
    if slot.get("min") is not None or slot.get("max") is not None:
        return {"min": slot.get("min"), "max": slot.get("max")}
    return None


def derive_capabilities(category: str, endpoint: str, pm: dict) -> dict[str, Any]:
    s = pm.get("slots", {})
    eid = endpoint.lower()
    modes: set[str] = set()
    has = lambda k: k in s  # noqa: E731
    req = lambda k: has(k) and s[k].get("required")  # noqa: E731
    if category in VIDEO_CATS:
        image_required = req("first_frame") or req("refs")
        if category == "text-to-video" or (has("prompt") and not image_required and not req("video") and not req("audio")
                                           and category != "video-to-video"):
            modes.add("t2v")
        if has("first_frame") and not req("audio"):
            modes.add("i2v")
        if has("first_frame") and has("last_frame"):
            modes.add("flf")
        if (has("refs") or has("elements")) and not req("audio"):
            modes.add("ref2v")
        if has("audio") and (has("first_frame") or has("refs")) and (
                category == "audio-to-video" or req("audio") or "lip" in eid or "avatar" in eid or "target_audio" in s["audio"]["name"]):
            modes.add("a2v")
        if category == "audio-to-video" and has("audio"):
            modes.add("a2v")
        if has("video") and has("audio") and category == "video-to-video":
            modes.add("lipsync")
        if has("video") and "extend" in eid:
            modes.add("extend")
        if has("video") and has("prompt") and category == "video-to-video" and ("edit" in eid or "recast" in eid):
            modes.add("edit")
    elif category in IMAGE_CATS:
        if has("prompt"):
            modes.add("t2i") if not (req("refs") or req("first_frame")) else None
            if has("refs") or has("first_frame"):
                modes.add("i2i")
    elif category == "text-to-speech":
        modes.add("tts")
    if "lipsync" in modes:
        task = "lipsync"
    elif modes & {"t2v", "i2v", "ref2v", "flf"}:
        task = "video"
    elif "a2v" in modes:
        task = "avatar"
    elif modes & {"extend", "edit"}:
        task = "edit"
    elif modes & {"t2i", "i2i"}:
        task = "image"
    elif "tts" in modes:
        task = "tts"
    elif category == "training":
        task = "train"
    elif "music" in eid and category in ("text-to-audio",):
        task = "music"
    else:
        task = "other"
    refs_slot = s.get("refs")
    native_audio = bool(has("gen_audio")) and (s["gen_audio"].get("default") is not False or True)
    return {
        "task": task,
        "modes": sorted(modes),
        # gateway flags (plan section 11): what this engine can do for characters and dialogue
        "speech_in_video": task == "video" and native_audio,  # speaks the line itself (voice + lips in one pass)
        "audio_driven": "a2v" in modes,  # animates a face from a given voice track
        "lora_input": has("loras"),  # accepts a trained identity (LoRA weights)
        "lipsync_to_audio": "lipsync" in modes,  # re-syncs lips of an existing clip to given audio
        "max_refs": (refs_slot or {}).get("max_items") or (4 if refs_slot or has("elements") else 0),
        "durations": _durations(s.get("duration")),
        "resolutions": (s.get("resolution") or {}).get("enum"),
        "aspects": (s.get("aspect") or {}).get("enum"),
        "native_audio": native_audio,
        "usable": not pm.get("unmapped_required"),
    }


# ── request building ─────────────────────────────────────────────────────────

def pick_duration(slot: dict, want: float) -> Any:
    enum = slot.get("enum")
    as_str = "string" in slot.get("types", []) and "number" not in slot.get("types", []) and "integer" not in slot.get("types", [])
    if enum:
        nums = []
        for e in enum:
            try:
                nums.append((float(e), e))
            except (TypeError, ValueError):
                continue
        if not nums:
            return None
        nums.sort()
        for n, raw in nums:
            if n >= want - 0.01:
                return raw
        return nums[-1][1]
    v = want
    if slot.get("min") is not None:
        v = max(v, float(slot["min"]))
    if slot.get("max") is not None:
        v = min(v, float(slot["max"]))
    v = int(round(v)) if "integer" in slot.get("types", []) or float(v).is_integer() else v
    return str(v) if as_str else v


def pick_enum(slot: dict, want: str, fallbacks: tuple[str, ...] = ("auto", "adaptive")) -> Any:
    enum = slot.get("enum")
    if not enum:
        return want
    for e in enum:
        if str(e).lower() == str(want).lower():
            return e
    for fb in fallbacks:
        for e in enum:
            if str(e).lower() == fb:
                return e
    return None


def pick_resolution(slot: dict, want: str) -> Any:
    enum = slot.get("enum")
    if not enum:
        return want
    exact = pick_enum(slot, want, ())
    if exact is not None:
        return exact

    def px(s: str) -> int:
        m = re.search(r"(\d+)", str(s))
        n = int(m.group(1)) if m else 0
        return n * 1000 if str(s).lower().endswith("k") and n < 10 else n
    target = px(want)
    return min(enum, key=lambda e: abs(px(e) - target))


IMAGE_SIZE_FOR = {"9:16": "portrait_16_9", "16:9": "landscape_16_9", "1:1": "square_hd", "3:4": "portrait_4_3",
                  "4:3": "landscape_4_3"}


def build_args(pm: dict, caps: dict, req: GenRequest, upload: Callable[[Path], str]) -> dict[str, Any]:
    s = pm.get("slots", {})
    args: dict[str, Any] = dict(pm.get("required_defaults", {}))

    def put(slot: str, value: Any) -> None:
        if slot in s and value is not None and value != "":
            args[s[slot]["name"]] = value

    put("prompt", req.prompt or (req.text if req.mode == "tts" else None) or (None if not s.get("prompt", {}).get("required") else "."))
    put("negative", req.negative)
    put("text", req.text if req.mode == "tts" else None)
    put("voice", req.voice)
    put("language", req.language)
    first_url = upload(req.first_frame) if req.first_frame else None
    if req.mode in ("i2v", "flf", "a2v", "i2i") or (req.mode == "ref2v" and not (has_any(s, "refs", "elements"))):
        put("first_frame", first_url)
    if req.mode == "flf" and req.last_frame:
        put("last_frame", upload(req.last_frame))
    if req.refs and req.mode in ("ref2v", "i2i", "a2v", "t2i"):
        max_refs = caps.get("max_refs") or 4
        urls = [upload(p) for p in req.refs[:max_refs]]
        if "refs" in s:
            put("refs", urls)
        elif "elements" in s:
            args[s["elements"]["name"]] = [{"frontal_image_url": urls[0], "reference_image_urls": urls[1:]}]
        elif "first_frame" in s and s["first_frame"]["name"] not in args:
            put("first_frame", urls[0])
    if req.mode == "a2v" and "first_frame" not in s and first_url:
        if "refs" in s:
            put("refs", [first_url])
    if req.audio and req.mode in ("a2v", "lipsync"):
        url = upload(req.audio)
        if "audio" in s:
            put("audio", url)
        elif "audios" in s:
            put("audios", [url])
    if req.video and req.mode in ("lipsync", "extend", "edit"):
        url = upload(req.video)
        if "video" in s:
            put("video", url)
        elif "videos" in s:
            put("videos", [url])
    if req.duration and "duration" in s and req.mode not in ("a2v", "lipsync", "t2i", "i2i", "tts"):
        put("duration", pick_duration(s["duration"], float(req.duration)))
    if "aspect" in s and req.aspect:
        put("aspect", pick_enum(s["aspect"], req.aspect))
    elif "image_size" in s and req.mode in ("t2i", "i2i"):
        put("image_size", IMAGE_SIZE_FOR.get(req.aspect, "portrait_16_9"))
    if "resolution" in s and req.resolution and req.mode not in ("t2i", "i2i"):
        put("resolution", pick_resolution(s["resolution"], req.resolution))
    if req.seed is not None:
        put("seed", req.seed)
    if req.loras and "loras" in s and req.mode not in ("lipsync", "tts"):
        put("loras", req.loras)
    if "gen_audio" in s and req.mode not in ("t2i", "i2i", "tts"):
        put("gen_audio", bool(req.generate_audio))
    if "num_images" in s and req.mode in ("t2i", "i2i"):
        put("num_images", 1)
    return args


def has_any(s: dict, *slots: str) -> bool:
    return any(x in s for x in slots)


# ── output parsing ───────────────────────────────────────────────────────────

MEDIA_KEYS = {"video": ["video", "videos", "output", "result"], "image": ["images", "image", "output"],
              "audio": ["audio", "audio_file", "audio_url", "output"]}
EXT = {"video": (".mp4", ".mov", ".webm"), "image": (".png", ".jpg", ".jpeg", ".webp"), "audio": (".mp3", ".wav", ".m4a", ".ogg")}


def extract_url(result: Any, kind: str) -> str | None:
    def from_obj(o: Any) -> str | None:
        if isinstance(o, str) and o.startswith("http"):
            return o
        if isinstance(o, dict) and isinstance(o.get("url"), str):
            return o["url"]
        if isinstance(o, list) and o:
            return from_obj(o[0])
        return None
    if isinstance(result, dict):
        for k in MEDIA_KEYS.get(kind, []):
            if k in result:
                u = from_obj(result[k])
                if u:
                    return u
    # last resort: walk everything for a URL with the right extension / content type
    stack = [result]
    while stack:
        o = stack.pop()
        if isinstance(o, dict):
            url = o.get("url")
            ct = str(o.get("content_type", ""))
            if isinstance(url, str) and (ct.startswith(kind) or url.lower().split("?")[0].endswith(EXT.get(kind, ()))):
                return url
            stack.extend(o.values())
        elif isinstance(o, list):
            stack.extend(o)
    return None
