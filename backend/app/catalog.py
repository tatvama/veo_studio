"""Model IDs, prices, languages and voices.

Admins can override MODELS and PRICES from the Settings page (stored in app_settings),
so a model rename or price change never needs a code change.
Prices are USD estimates from Sept/Oct 2026 public pages — verify before relying on them.
"""
from __future__ import annotations

MODELS: dict[str, str] = {
    # Google
    "text": "gemini-3.8-flash",
    "text_pro": "gemini-3.1-pro-preview",
    "image": "gemini-nano-banana-2.1",
    "image_hero": "gemini-3-pro-image",
    "video_saver": "veo-3.1-lite-generate-preview",
    "video_balanced": "veo-3.1-fast-generate-preview",
    "video_hero": "veo-3.1-generate-preview",
    "omni": "gemini-omni-1.1-flash",
    "tts_gemini": "gemini-3.8-flash-tts",
    "music": "lyria-3.5",
    "music_clip": "lyria-3-clip-preview",
    "embedding": "gemini-embedding-001",
    # ElevenLabs
    "tts_elevenlabs": "eleven_v3",
    "sts_elevenlabs": "eleven_multilingual_sts_v2",
    "ttv_elevenlabs": "eleven_ttv_v3",
    # Sarvam
    "tts_sarvam": "bulbul:v3",
    # sync.so
    "lipsync": "lipsync-2",
    "lipsync_pro": "lipsync-2-pro",
    "lipsync_angles": "sync-3",
    # Anthropic: the Director chat agent (Settings → Generation → Director)
    "director_claude": "claude-sonnet-5-5",
}

PRICES: dict[str, dict] = {
    # $ per second of output video, by resolution
    "video_per_second": {
        "veo-3.1-lite-generate-preview": {"720p": 0.05, "1080p": 0.08},
        "veo-3.1-fast-generate-preview": {"720p": 0.10, "1080p": 0.12, "4k": 0.30},
        "veo-3.1-generate-preview": {"720p": 0.40, "1080p": 0.40, "4k": 0.60},
        "gemini-omni-1.1-flash": {"720p": 0.10, "1080p": 0.10, "4k": 0.10},
    },
    # $ per generated image (estimate)
    "image_each": {
        "gemini-nano-banana-2.1": 0.067,
        "gemini-3-pro-image": 0.134,
    },
    # $ per 1,000 characters of speech (estimates)
    "tts_per_1k_chars": {"gemini": 0.02, "elevenlabs": 0.20, "sarvam": 0.036},
    # $ per minute of voice-changer audio (estimate)
    "sts_per_minute": {"elevenlabs": 0.30},
    "isolation_per_minute": {"elevenlabs": 0.30},
    # $ per second of lip-synced video (sync.so Hobbyist/Creator rates)
    "lipsync_per_second": {"lipsync-2": 0.05, "lipsync-2-pro": 0.083, "sync-3": 0.133, "lipsync-1.9.0-beta": 0.025},
    # $ per music generation (estimate)
    "music_each": {"lyria-3.5": 0.10, "lyria-3-clip-preview": 0.04},
    # $ per 1M tokens (estimates) for text models
    "text_per_million": {
        "gemini-3.8-flash": {"in": 0.30, "out": 2.50},
        "gemini-3.1-pro-preview": {"in": 2.00, "out": 12.00},
        # cache_write = 5-minute prompt-cache writes, cache_read = prompt-cache hits
        "claude-sonnet-5-5": {"in": 2.00, "out": 10.00, "cache_write": 2.50, "cache_read": 0.20},
        "claude-opus-5-5": {"in": 4.00, "out": 20.00, "cache_write": 5.00, "cache_read": 0.20},
        "claude-haiku-5-5": {"in": 0.10, "out": 0.50, "cache_write": 0.125, "cache_read": 0.01},
        "claude-fable-5-1": {"in": 10.00, "out": 50.00, "cache_write": 12.50, "cache_read": 0.25},
    },
    "voice_design_each": {"gemini": 0.01, "elevenlabs": 0.05, "sarvam": 0.0},
}

QUALITY_MODES = {
    "saver": {"model_key": "video_saver", "resolution": "720p", "label": "Saver — keyframe → Veo 3.1 Lite"},
    "balanced": {"model_key": "video_balanced", "resolution": "720p", "label": "Balanced — Veo 3.1 Fast with refs"},
    "hero": {"model_key": "video_hero", "resolution": "1080p", "label": "Hero — Veo 3.1 Standard"},
}

LANGUAGES: dict[str, dict] = {
    "en": {"name": "English", "bcp47": "en-IN", "sarvam": "en-IN", "script": "Latin"},
    "hi": {"name": "Hindi", "bcp47": "hi-IN", "sarvam": "hi-IN", "script": "Devanagari"},
    "kn": {"name": "Kannada", "bcp47": "kn-IN", "sarvam": "kn-IN", "script": "Kannada"},
    "te": {"name": "Telugu", "bcp47": "te-IN", "sarvam": "te-IN", "script": "Telugu"},
    "ta": {"name": "Tamil", "bcp47": "ta-IN", "sarvam": "ta-IN", "script": "Tamil"},
}

# ElevenLabs voice changer language coverage (multilingual STS v2 list). Kannada/Telugu are not listed.
STS_LANGUAGES = {"en", "hi", "ta"}

GEMINI_PREBUILT_VOICES = [
    ("Zephyr", "Bright"), ("Puck", "Upbeat"), ("Charon", "Informative"), ("Kore", "Firm"),
    ("Fenrir", "Excitable"), ("Leda", "Youthful"), ("Orus", "Firm"), ("Aoede", "Breezy"),
    ("Callirrhoe", "Easy-going"), ("Autonoe", "Bright"), ("Enceladus", "Breathy"), ("Iapetus", "Clear"),
    ("Umbriel", "Easy-going"), ("Algieba", "Smooth"), ("Despina", "Smooth"), ("Erinome", "Clear"),
    ("Algenib", "Gravelly"), ("Rasalgethi", "Informative"), ("Laomedeia", "Upbeat"), ("Achernar", "Soft"),
    ("Alnilam", "Firm"), ("Schedar", "Even"), ("Gacrux", "Mature"), ("Pulcherrima", "Forward"),
    ("Achird", "Friendly"), ("Zubenelgenubi", "Casual"), ("Vindemiatrix", "Gentle"), ("Sadachbia", "Lively"),
    ("Sadaltager", "Knowledgeable"), ("Sulafat", "Warm"),
]

SARVAM_SPEAKERS = {
    "male": ["shubh", "aditya", "rahul", "rohan", "amit", "dev", "ratan", "varun", "manan", "sumit", "kabir",
             "aayan", "ashutosh", "advait", "anand", "tarun", "sunny", "mani", "gokul", "vijay", "mohit", "rehan", "soham"],
    "female": ["ritu", "priya", "neha", "pooja", "simran", "kavya", "ishita", "shreya", "roopa", "tanya",
               "shruti", "suhani", "kavitha", "rupali"],
}

PROJECT_TYPES = {
    "series": {"label": "Web series episode", "aspect": "9:16", "duration_s": 300},
    "short": {"label": "Short / Reel", "aspect": "9:16", "duration_s": 45},
    "ad": {"label": "Ad (15 / 30 s)", "aspect": "9:16", "duration_s": 30},
    "explainer": {"label": "Explainer / VO story", "aspect": "16:9", "duration_s": 90},
    "devotional": {"label": "Devotional / mythology story", "aspect": "9:16", "duration_s": 120},
}

EXPORT_PRESETS = {
    "shorts": {"label": "YouTube Shorts 9:16", "aspect": "9:16", "w": 1080, "h": 1920},
    "reels": {"label": "Instagram Reels 9:16", "aspect": "9:16", "w": 1080, "h": 1920},
    "youtube": {"label": "YouTube 16:9", "aspect": "16:9", "w": 1920, "h": 1080},
    "square": {"label": "Square 1:1", "aspect": "1:1", "w": 1080, "h": 1080},
    "draft": {"label": "Draft 720p (fast)", "aspect": None, "w": 720, "h": 1280},
}

STYLE_PRESETS = [
    {"name": "Cinematic Warm", "look": "Cinematic, warm tungsten key light with dusk-blue fill, rich contrast",
     "lens": "35mm, shallow depth of field", "grade": "teal-orange, soft highlights", "grain": "subtle 35mm film grain",
     "avoid_list": "subtitles, on-screen text, watermarks, extra people, warped hands"},
    {"name": "Devotional Glow", "look": "Reverent, soft golden light, incense haze, temple ambience",
     "lens": "50mm, gentle slow camera moves", "grade": "golden, saffron and deep maroon tones", "grain": "fine grain",
     "avoid_list": "subtitles, on-screen text, modern objects, disrespectful depiction of deities"},
    {"name": "Bright Commercial", "look": "Clean bright commercial lighting, high key, crisp",
     "lens": "24-70mm, smooth gimbal moves", "grade": "vibrant, clean whites", "grain": "none",
     "avoid_list": "subtitles, on-screen text, clutter, extra logos"},
    {"name": "Moody Thriller", "look": "Low key, hard shadows, practical lights, rain-soaked streets",
     "lens": "40mm anamorphic, slow push-ins", "grade": "desaturated cyan, crushed blacks", "grain": "heavy grain",
     "avoid_list": "subtitles, on-screen text, cheerful colors"},
    {"name": "3D Animated", "look": "Stylized 3D animation, soft global illumination, expressive characters",
     "lens": "animated camera, dynamic angles", "grade": "saturated, playful", "grain": "none",
     "avoid_list": "photorealism, subtitles, on-screen text"},
]


def merged(base: dict, override: dict | None) -> dict:
    """Recursive merge used for admin overrides (an override only replaces the leaves it names)."""
    out = {k: (merged(v, None) if isinstance(v, dict) else v) for k, v in base.items()}
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = merged(out[k], v)
        else:
            out[k] = v
    return out
