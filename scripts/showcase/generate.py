"""Generate the sign-in page showreel: six cinematic stills and, optionally, two motion loops.

usage (from the repo root, with the backend venv):
  backend/.venv/Scripts/python scripts/showcase/generate.py            # stills with Google Nano Banana (~$0.42)
  backend/.venv/Scripts/python scripts/showcase/generate.py fal        # stills with fal.ai FLUX1.1 [pro] ultra (~$0.36)
  backend/.venv/Scripts/python scripts/showcase/generate.py fal --loops   # + two 5 s Kling 2.5 loops (~$0.70 more)

Writes web-ready media to frontend/public/showcase/ and the slide list to frontend/src/pages/login/slides.generated.ts.
Keys come from the server .env (GEMINI_API_KEY, FAL_KEY)."""
import io
import json
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from PIL import Image  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.providers.fal import FalClient  # noqa: E402
from app.providers.gemini import GeminiClient  # noqa: E402

PROVIDER = next((a for a in sys.argv[1:] if a in ("gemini", "fal")), "gemini")
WANT_LOOPS = "--loops" in sys.argv

OUT = ROOT / "frontend" / "public" / "showcase"
MANIFEST = ROOT / "frontend" / "src" / "pages" / "login" / "slides.generated.ts"
OUT.mkdir(parents=True, exist_ok=True)
MANIFEST.parent.mkdir(parents=True, exist_ok=True)

STYLE = ("cinematic film still, anamorphic lens, shallow depth of field, rich colour grade, volumetric light, "
         "fine film grain, 8k detail, no text, no watermark")
SHOTS = [
    ("lamp", "The Lamp", "A glowing brass oil lamp on worn stone steps inside an ancient South Indian temple at dusk, carved granite "
     "pillars receding into darkness, incense smoke drifting through shafts of golden light, a single flame reflected in a puddle"),
    ("monsoon", "Monsoon Rooftop", "A young Indian woman in a deep teal silk saree standing on a Mumbai rooftop at blue hour in the "
     "monsoon rain, city lights and neon reflections on wet concrete, hair moving in the wind, seen in profile, moody"),
    ("holi", "Colours of Holi", "A narrow old-city street in Jaipur during Holi, clouds of pink, saffron and turquoise powder hanging in "
     "the air, children laughing, pink sandstone havelis, low golden afternoon sun backlighting the colour"),
    ("backwaters", "Backwaters at Dawn", "Kerala backwaters at sunrise, a lone wooden canoe gliding over mirror-still water, coconut palm "
     "silhouettes, soft pink and gold mist, wide establishing shot"),
    ("nightshoot", "Night Shoot", "Behind the scenes of an Indian film set at night in a rain-soaked bazaar, a cinema camera on a dolly track, "
     "crew silhouettes, practical lanterns and a large soft light, haze, a director pointing at a monitor"),
    ("dance", "Temple Dance", "A Bharatanatyam dancer frozen mid-pose in a temple courtyard at night, rows of oil lamps, dramatic warm rim "
     "light, silk costume with gold border, motion in the pleats, reverent atmosphere"),
]
LOOPS = {
    "lamp": "Slow gentle push-in. The lamp flame flickers softly, incense smoke curls and drifts through the light shafts, dust "
            "motes float. Calm, steady camera, no cuts.",
    "monsoon": "Subtle slow dolly. Steady rain falls, neon reflections ripple on the wet floor, her saree and hair move gently in the "
               "wind, city lights twinkle. Calm, no cuts.",
}
IMG_MODEL, VID_MODEL = "fal-ai/flux-pro/v1.1-ultra", "fal-ai/kling-video/v2.5-turbo/pro/image-to-video"

cfg = get_settings()
fal = FalClient(cfg.fal_key) if cfg.fal_key else None
gem = GeminiClient(cfg.gemini_api_key) if cfg.gemini_api_key else None
MODEL_NAME = {"gemini": "Nano Banana 2.1", "fal": "FLUX1.1 [pro] ultra"}[PROVIDER]


def ffmpeg() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def still(slug: str, title: str, prompt: str) -> dict:
    url = None
    if PROVIDER == "fal":
        res = fal.run(IMG_MODEL, {"prompt": f"{prompt}. {STYLE}", "aspect_ratio": "16:9", "num_images": 1,
                                  "output_format": "jpeg", "enable_safety_checker": True, "safety_tolerance": "2"})
        url = res["images"][0]["url"]
        data = fal.download(url)
    else:
        data, _ = gem.image("gemini-nano-banana-2.1", f"{prompt}. {STYLE}", [], "16:9", "2K")
    img = Image.open(io.BytesIO(data)).convert("RGB")
    if url is None:  # Kling needs a public image URL: upload the still to fal's CDN only when making loops
        tmpf = OUT / f".{slug}.jpg"
        img.save(tmpf, "JPEG", quality=92)
        url = fal.upload(tmpf) if (WANT_LOOPS and fal) else None
        tmpf.unlink(missing_ok=True)
    for name, width, q in ((f"{slug}.webp", 1920, 80), (f"{slug}-sm.webp", 720, 74)):
        im = img.copy()
        im.thumbnail((width, width), Image.LANCZOS)
        im.save(OUT / name, "WEBP", quality=q, method=6)
    print(f"still {slug}: {img.size} -> {(OUT / f'{slug}.webp').stat().st_size // 1024} KB", flush=True)
    return {"slug": slug, "title": title, "model": MODEL_NAME, "prompt": prompt, "url": url}


def loop(slug: str, image_url: str) -> None:
    res = fal.run(VID_MODEL, {"prompt": LOOPS[slug], "image_url": image_url, "duration": "5",
                              "negative_prompt": "blur, distort, low quality, text, watermark, cut, scene change"})
    raw = fal.download(res["video"]["url"])
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "src.mp4"
        src.write_bytes(raw)
        # play forward then backward so the clip loops without a jump; small, silent, web-friendly H.264
        cmd = [ffmpeg(), "-y", "-i", str(src), "-filter_complex",
               "[0:v]scale=1280:-2,fps=24,split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0,format=yuv420p[v]",
               "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-movflags", "+faststart",
               str(OUT / f"loop-{slug}.mp4")]
        subprocess.run(cmd, check=True, capture_output=True)
    print(f"loop {slug}: {(OUT / f'loop-{slug}.mp4').stat().st_size // 1024} KB", flush=True)


with ThreadPoolExecutor(3) as pool:
    shots = list(pool.map(lambda s: still(*s), SHOTS))
by = {s["slug"]: s for s in shots}
made = set()
if WANT_LOOPS:
    with ThreadPoolExecutor(2) as pool:
        list(pool.map(lambda slug: loop(slug, by[slug]["url"]), LOOPS))
    made = set(LOOPS)

manifest = [{"slug": s["slug"], "title": s["title"], "model": s["model"],
             "loop": (f"loop-{s['slug']}.mp4" if s["slug"] in made else None),
             "loopModel": ("Kling 2.5 Turbo Pro" if s["slug"] in made else None)} for s in shots]
lines = []
for m in manifest:
    extra = f', loop: "{m["loop"]}", loopModel: "{m["loopModel"]}"' if m["loop"] else ""
    lines.append(f'  {{ slug: "{m["slug"]}", title: "{m["title"]}", model: "{m["model"]}"{extra} }},')
header = ("// Written by scripts/showcase/generate.py. Re-run it to refresh the sign-in showreel.\n"
          'import type { Slide } from "./showcase";\n\nexport const SLIDES: Slide[] = [\n')
MANIFEST.write_text(header + "\n".join(lines) + "\n];\n", encoding="utf-8")
print("manifest written:", MANIFEST, flush=True)
print("approx spend: $%.2f" % (len(SHOTS) * (0.06 if PROVIDER == "fal" else 0.07) + len(made) * 5 * 0.07), flush=True)
