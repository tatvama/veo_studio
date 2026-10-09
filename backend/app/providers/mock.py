"""Mock providers: produce real (placeholder) images, videos and audio with no API calls.

Used automatically when an API key is missing (MOCK_PROVIDERS=auto) so the whole studio
can be developed and demoed for free. Every mock output is clearly labelled "MOCK".
"""
from __future__ import annotations

import hashlib
import io
import re
import shutil
import sys
import textwrap
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from ..pipeline import ffmpeg as ff


def _h(s: str) -> int:
    return int(hashlib.sha1(s.encode("utf-8", "ignore")).hexdigest()[:8], 16)


def _font(size: int) -> ImageFont.ImageFont:
    candidates = (["C:/Windows/Fonts/Nirmala.ttc", "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf"]
                  if sys.platform == "win32" else
                  ["/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"])
    for c in candidates:
        try:
            return ImageFont.truetype(c, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def _aspect_size(aspect: str) -> tuple[int, int]:
    return {"9:16": (720, 1280), "16:9": (1280, 720), "1:1": (1024, 1024)}.get(aspect, (720, 1280))


def image(prompt: str, aspect: str = "9:16", title: str = "", refs: int = 0) -> bytes:
    w, h = _aspect_size(aspect)
    seed = _h(prompt)
    c1 = ((seed >> 0) % 120 + 40, (seed >> 8) % 120 + 30, (seed >> 16) % 120 + 50)
    c2 = ((seed >> 4) % 80 + 10, (seed >> 12) % 80 + 10, (seed >> 20) % 80 + 30)
    img = Image.new("RGB", (w, h), c2)
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        d.line([(0, y), (w, y)], fill=tuple(int(c1[i] * (1 - t) + c2[i] * t) for i in range(3)))
    # simple figure silhouettes for each character mentioned
    m = re.search(r"(?:\[CHARACTERS\]|Characters:)(.*)", prompt)
    names = re.findall(r"\b([A-Z][a-z]{2,}):", m.group(1))[:3] if m else []
    if not names and re.search(r"character reference|portrait", prompt, re.I):
        names = ["Figure"]
    for i, _ in enumerate(names):
        cx = int(w * (i + 1) / (len(names) + 1))
        r = int(min(w, h) * 0.07)
        cy = int(h * 0.52)
        col = (240, 220, 200)
        d.ellipse([cx - r, cy - 3 * r, cx + r, cy - r], fill=col)
        d.rounded_rectangle([cx - int(r * 1.5), cy - r + 6, cx + int(r * 1.5), cy + int(r * 3.2)], radius=r // 2, fill=col)
    big, small = _font(max(w // 22, 22)), _font(max(w // 40, 14))
    d.rectangle([0, 0, w, int(h * 0.11)], fill=(0, 0, 0))
    d.text((24, 18), f"MOCK · {title or 'image'}", font=big, fill=(255, 196, 64))
    if refs:
        d.text((24, 18 + big.size + 6), f"{refs} reference image(s) used", font=small, fill=(220, 220, 220))
    body = re.sub(r"\s+", " ", prompt)[:600]
    y = int(h * 0.70)
    for line in textwrap.wrap(body, width=max(int(w / (small.size * 0.55)), 20))[:10]:
        d.text((24, y), line, font=small, fill=(255, 255, 255))
        y += small.size + 6
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def video_from(first_frame: bytes | None, prompt: str, out: Path, seconds: float, aspect: str,
               with_tone: bool = True) -> Path:
    tmp = out.parent / f"{out.stem}_frame.png"
    tmp.write_bytes(first_frame or image(prompt, aspect, "video"))
    w, h = _aspect_size(aspect)
    audio = None
    if with_tone:
        audio = out.parent / f"{out.stem}_tone.wav"
        ff.write_tone_wav(audio, seconds, freq=110 + _h(prompt) % 220, volume=0.06)
    ff.still_to_video(tmp, out, seconds, w, h, audio=audio)
    tmp.unlink(missing_ok=True)
    if audio:
        audio.unlink(missing_ok=True)
    return out


def tts(text: str, voice: str, out: Path) -> Path:
    clean = re.sub(r"<[^>]+>", "", text)
    seconds = max(1.0, min(len(clean) / 14.0, 20.0))
    return ff.write_tone_wav(out, seconds, freq=140 + _h(voice) % 200)


def music(out: Path, seconds: float = 30.0) -> Path:
    return ff.write_tone_wav(out, seconds, freq=196, volume=0.12, syllables=False)


def lipsync(video: Path, audio: Path, out: Path) -> Path:
    return ff.mux_audio(video, audio, out)


def omni_edit(video: Path, out: Path) -> Path:
    ff.run(["-i", video, "-vf", "hue=s=0.5,eq=brightness=0.04", "-c:a", "copy", out])
    return out


def copy(src: Path, out: Path) -> Path:
    shutil.copyfile(src, out)
    return out


# ── Mock "LLM" ───────────────────────────────────────────────────────────────

SAMPLE_LINES = {
    "en": ["I saw him again last night.", "Then it wasn't a dream.", "We have to tell someone.",
           "Not yet. First we find out who he is.", "Look — the lamp is moving on its own."],
    "hi": ["मैंने उसे कल रात फिर देखा।", "तो वह सपना नहीं था।", "हमें किसी को बताना होगा।",
           "अभी नहीं। पहले पता करते हैं वह कौन है।", "देखो — दीया अपने आप हिल रहा है।"],
    "kn": ["ನಿನ್ನೆ ರಾತ್ರಿ ಅವನನ್ನು ಮತ್ತೆ ನೋಡಿದೆ.", "ಹಾಗಾದರೆ ಅದು ಕನಸಲ್ಲ.", "ನಾವು ಯಾರಿಗಾದರೂ ಹೇಳಬೇಕು.",
           "ಈಗಲ್ಲ. ಮೊದಲು ಅವನು ಯಾರು ಎಂದು ತಿಳಿಯೋಣ.", "ನೋಡು — ದೀಪ ತಾನಾಗಿಯೇ ಅಲುಗಾಡುತ್ತಿದೆ."],
    "te": ["నిన్న రాత్రి అతన్ని మళ్ళీ చూశాను.", "అయితే అది కల కాదు.", "మనం ఎవరికైనా చెప్పాలి.",
           "ఇప్పుడు కాదు. ముందు అతను ఎవరో తెలుసుకుందాం.", "చూడు — దీపం దానంతట అదే కదులుతోంది."],
    "ta": ["நேற்று இரவு அவனை மீண்டும் பார்த்தேன்.", "அப்படியானால் அது கனவு இல்லை.", "நாம் யாரிடமாவது சொல்ல வேண்டும்.",
           "இப்போது இல்லை. முதலில் அவன் யார் என்று கண்டுபிடிப்போம்.", "பார் — விளக்கு தானாகவே அசைகிறது."],
}


def _title_from(concept: str) -> str:
    words = re.findall(r"[A-Za-z]+", concept)[:4]
    return " ".join(w.capitalize() for w in words) or "Untitled"


def llm(task: str, ctx: dict[str, Any]) -> dict[str, Any]:
    concept = ctx.get("concept") or "A mysterious story"
    lang = ctx.get("language", "en")
    if task == "poster_copy":
        kind, n = ctx.get("kind", "tagline"), int(ctx.get("n", 6))
        pool = {
            "title": ["THE LAMP", "LAST LIGHT", "DIYA", "AFTER DUSK", "THE KEEPER", "EMBER", "SILENT FLAME", "NIGHT WATCH"],
            "tagline": ["Some lights refuse to go out.", "Every flame remembers.", "The night is listening.",
                        "Faith burns brightest in the dark.", "What moves when no one is watching?", "Light finds a way home."],
            "cta": ["Watch now", "Streaming Friday", "Book tickets", "Shop the look", "Join the premiere", "Follow for part 2"],
            "credits": ["TATVAM STUDIOS PRESENTS A FILM BY ASHA RAO  WRITTEN BY RAVI KUMAR  MUSIC BY MEERA IYER  "
                        "CINEMATOGRAPHY BY ARJUN NAIR  PRODUCED BY TATVAM AI STUDIO"],
        }.get(kind, [f"{concept[:40]} ({kind} option)"])
        return {"suggestions": [f"{pool[i % len(pool)]}" for i in range(n)]}
    if task == "poster_brief":
        return {"template": "film_onesheet", "title": _title_from(concept).upper()[:40], "tagline": "Some lights refuse to go out.",
                "credits": "A TATVAM STUDIOS FILM  DIRECTED BY ASHA RAO", "cta": "Coming soon", "badge": "IN CINEMAS",
                "background_prompt": f"Moody cinematic scene for: {concept[:160]}. Dusk light, haze, depth.",
                "palette": ["#0b0f17", "#f5b041", "#22d3ee", "#f8fafc"], "style": "cinematic, warm practical light, film grain"}
    if task == "brief":
        return {
            "title": _title_from(concept), "format": ctx.get("type", "short"),
            "duration_s": ctx.get("duration_s", 45), "aspect": ctx.get("aspect", "9:16"),
            "audience": "Indian audience, 18–45, mobile-first", "tone": "emotional, suspenseful",
            "platform": "YouTube Shorts / Instagram Reels", "key_message": concept[:200],
            "cta": "Follow for part 2", "notes": "MOCK brief — add an API key for real writing.",
        }
    if task == "hooks":
        n = int(ctx.get("n", 6))
        kinds = ["question", "bold_claim", "visual_shock", "pattern_break", "story", "curiosity_gap"]
        hooks = []
        for i in range(n):
            k = kinds[i % len(kinds)]
            score = {"curiosity": 6 + (i * 3) % 4, "clarity": 7 + i % 3, "visual": 5 + (i * 2) % 5, "platform_fit": 6 + i % 4}
            hooks.append({"text": f"[{k}] What if {concept[:60].lower()}… (option {i + 1})", "type": k,
                          "visual": "Extreme close-up, sudden movement, warm lamp light", "scores": score,
                          "total": round(sum(score.values()) / 4, 1)})
        return {"hooks": hooks}
    if task == "series_arc":
        n = int(ctx.get("episodes", 5))
        return {"logline": f"{_title_from(concept)}: {concept[:160]}", "arc": "Mystery → discovery → betrayal → truth.",
                "episodes": [{"number": i + 1, "title": f"Episode {i + 1}", "outline": f"Part {i + 1} of the story: {concept[:100]}"}
                             for i in range(n)]}
    if task == "script":
        n_scenes = 2 if ctx.get("type") in ("short", "ad") else 3
        lines = SAMPLE_LINES.get(lang, SAMPLE_LINES["en"])
        scenes = []
        for s in range(n_scenes):
            scenes.append({
                "title": f"Scene {s + 1}", "location": "Temple courtyard" if s % 2 == 0 else "Old library",
                "time_of_day": "dusk" if s % 2 == 0 else "night",
                "summary": f"Story beat {s + 1}: {concept[:80]}",
                "action": "Ravi turns from the lamp to face Meera, hesitant.",
                "lines": [{"character": "Ravi", "line": lines[(2 * s) % len(lines)], "emotion": "hushed, uneasy"},
                          {"character": "Meera", "line": lines[(2 * s + 1) % len(lines)], "emotion": "calm, certain"}],
            })
        return {"logline": concept[:200], "beats": ["Hook", "Discovery", "Twist", "Cliffhanger"], "scenes": scenes}
    if task == "bible":
        return {
            "characters": [
                {"name": "Ravi", "role": "protagonist", "gender": "male", "age": "28",
                 "dna_text": "Ravi: 28-year-old Indian man, lean build, short wavy black hair, light stubble, deep-set brown eyes, "
                             "cream kurta with maroon border, thin silver chain.",
                 "personality": "curious, anxious, loyal", "voice_description": "young male voice, soft, slightly husky, Indian English accent"},
                {"name": "Meera", "role": "deuteragonist", "gender": "female", "age": "26",
                 "dna_text": "Meera: 26-year-old Indian woman, slim, long braided black hair, sharp dark eyes, small nose stud, "
                             "indigo cotton saree with gold border, silver anklets.",
                 "personality": "calm, decisive, wise", "voice_description": "warm female voice, steady, low pitch, confident"},
            ],
            "locations": [
                {"name": "Temple courtyard", "description_text": "Temple courtyard at dusk, worn stone floor, rows of brass oil lamps, distant gopuram silhouette."},
                {"name": "Old library", "description_text": "Dusty old library at night, tall teak shelves, a single green desk lamp, floating dust."},
            ],
            "style": {"name": "Cinematic Warm", "look": "Cinematic, warm tungsten and dusk-blue palette, soft haze",
                      "lens": "35mm, shallow depth of field", "grade": "warm teal-orange", "grain": "subtle 35mm grain",
                      "avoid_list": "subtitles, on-screen text, extra people, warped hands"},
        }
    if task == "import_script":
        # one scene per blank-line block, one shot per line; "Name: words" lines become dialogue
        scenes = []
        for bi, block in enumerate(b for b in re.split(r"\n\s*\n", ctx.get("text", "")) if b.strip()):
            shots = []
            for ln in (l.strip() for l in block.splitlines() if l.strip()):
                m = re.match(r"^([A-Za-z][\w .'-]{0,30}):\s*(.+)$", ln)
                if m:
                    who = m.group(1).strip()
                    shots.append({"prompt": f"{who} speaks.", "characters": [] if who.upper() in ("VO", "NARRATOR") else [who],
                                  "lines": [{"speaker": "VO" if who.upper() in ("VO", "NARRATOR") else who, "text": m.group(2).strip()}],
                                  "duration_s": 6})
                else:
                    shots.append({"prompt": ln, "characters": [], "lines": [], "duration_s": 6})
            scenes.append({"title": f"Scene {bi + 1}", "location": "", "shots": shots})
        return {"title": "Imported script", "scenes": scenes}
    if task == "breakdown":
        shots = []
        for si, sc in enumerate(ctx.get("scenes", [])):
            lines = sc.get("lines", [])
            shots.append({"scene_index": si, "framing": "wide establishing shot", "camera": "slow push-in",
                          "action": sc.get("action") or sc.get("summary", ""), "characters": list({l["character"] for l in lines}),
                          "location": sc.get("location", ""), "dialogue": [], "narration": "", "sfx": "ambient sounds",
                          "music_cue": "soft drone", "duration_s": 6, "mode": "auto"})
            for li in lines:
                shots.append({"scene_index": si, "framing": "medium close-up", "camera": "static, slight handheld",
                              "action": f"{li['character']} speaks.", "characters": [li["character"]],
                              "location": sc.get("location", ""), "dialogue": [li], "narration": "", "sfx": "",
                              "music_cue": "", "duration_s": 6, "mode": "auto"})
        return {"shots": shots}
    if task == "localize":
        tgt = ctx.get("target_language", "hi")
        samples = SAMPLE_LINES.get(tgt, SAMPLE_LINES["en"])
        return {"items": [{"key": it["key"], "text": samples[i % len(samples)]} for i, it in enumerate(ctx.get("items", []))]}
    if task == "qc":
        seed = _h(str(ctx.get("take_id", "")))
        return {"identity_match": round(0.75 + (seed % 22) / 100, 2), "outfit_match": True, "extra_people": False,
                "text_artifacts": False, "hand_issues": seed % 7 == 0, "matches_action": True,
                "notes": "MOCK QC — real QC runs with a Gemini key."}
    if task == "summary":
        return {"summary": f"MOCK summary of episode: {concept[:120]}"}
    if task == "cutdown":
        codes = ctx.get("codes", [])
        n = int(ctx.get("n", 3))
        size = max(len(codes) // max(n, 1), 1)
        return {"cuts": [{"title": f"Short {i + 1}", "shot_codes": codes[i * size:(i + 1) * size] or codes[:1]} for i in range(n)]}
    if task == "music_prompt":
        return {"prompt": "Instrumental only, no vocals. Soft tanpura drone with gentle bansuri flute, suspenseful, cinematic."}
    if task == "voice_pick":
        return {"speaker": "anand" if ctx.get("gender") == "male" else "kavya"}
    if task == "end_state":
        wardrobe = ctx.get("wardrobe") or {}
        return {"characters": [{"name": n, "outfit": wardrobe.get(n, ""), "state": "as at the start of the scene"}
                               for n in (ctx.get("characters") or []) if n],
                "props": list(ctx.get("props") or []), "time_of_day": "", "weather": "", "notes": "MOCK continuity state"}
    if task == "dialogue_check":
        return {"heard": ctx.get("line", ""), "language": ctx.get("language_name", "English"), "word_match": 0.92,
                "pronunciation": 0.85, "sync_score": 0.8, "subtitles_burned": False, "notes": "MOCK dialogue check"}
    if task == "lipsync_qc":
        seed = _h(str(ctx.get("take_id", "")))
        return {"sync_score": round(0.72 + (seed % 25) / 100, 2), "face_visible": True, "artifacts": False,
                "mismatched_moments": [], "notes": "MOCK lip-sync QC"}
    if task == "scene_cards":
        cards = []
        for i, sc in enumerate(ctx.get("scenes", [])):
            names = sorted({l.get("character") for l in sc.get("lines", []) if l.get("character") and l.get("character") != "NARRATOR"})
            cards.append({"scene_index": i, "title": sc.get("title", f"Scene {i + 1}"),
                          "goal": f"{names[0] if names else 'The hero'} wants to understand the mystery",
                          "conflict": "Fear and disbelief", "turn": "A small proof changes their mind",
                          "emotion": "suspense", "characters": names, "location": sc.get("location", ""),
                          "time_of_day": sc.get("time_of_day", ""), "props": ["brass oil lamp"],
                          "wardrobe": [f"{n}: same outfit as previous scene" for n in names],
                          "continuity_notes": "Lamp flame flickers left in every shot.",
                          "blocking": "Ravi near the lamp, Meera by the pillar.",
                          "coverage": ["wide master", *[f"MCU {n}" for n in names], "insert: lamp flame"]})
        return {"scenes": cards}
    if task == "critic":
        rnd = int(ctx.get("round", 0))
        base = 6.8 + rnd * 0.9
        return {"scores": {"hook": base, "clarity": base + 0.5, "pacing": base - 0.2, "emotion": base, "dialogue": base,
                           "cultural_fit": 8.5, "visual_potential": base + 0.4},
                "overall": round(base + 0.2, 1), "strengths": ["Strong mystery", "Clear setting"],
                "problems": ["Scene 2 repeats information from scene 1", "Ending needs a sharper cliffhanger"],
                "rewrite_instructions": "Cut repetition in scene 2; end on a visual reveal with one line of dialogue."}
    if task == "continuity":
        return {"ok": True, "issues": [{"severity": "low", "where": "E01-SH03", "problem": "Lamp is unlit here but lit in SH02",
                                        "fix": "Mention the lit lamp in SH03's action"}]}
    if task == "native_polish":
        return {"items": [{"key": it["key"], "text": it["text"], "note": "MOCK — unchanged"} for it in ctx.get("items", [])]}
    if task == "marketing":
        langs = ctx.get("languages", ["en"])
        copies = [{"platform": p, "language": l, "titles": [f"{_title_from(concept)} — Part 1", "You won't believe this lamp",
                                                           "The temple secret"],
                   "description": f"{concept[:150]}\n#AIStory", "hashtags": ["#shorts", "#mystery", "#temple"],
                   "pinned_comment": "Part 2 tomorrow 🔔"}
                  for p in ("youtube_shorts", "instagram_reels") for l in langs]
        return {"copies": copies, "thumbnails": [
            {"concept": "Close-up of the glowing lamp with a shocked face", "overlay_text": "IT MOVED!",
             "image_prompt": "Dramatic close-up of a brass temple lamp glowing, shocked young man in background, high contrast"}],
            "posting_tips": ["Post at 7–9 pm IST", "Pin the part-2 comment"]}
    if task == "trends":
        return {"trends": ["Mythology mini-series with cliffhangers", "POV hooks in regional languages"],
                "hook_patterns": ["Start mid-action", "Ask a question the viewer can't ignore"],
                "sounds_or_formats": ["Tanpura drone + sudden silence"], "cautions": ["Avoid misrepresenting real deities"]}
    if task == "sfx_plan":
        return {"cues": [{"shot_code": c, "prompt": "temple bells far away, crickets, soft wind", "start": 0, "duration": 4,
                          "volume_db": -10} for c in ctx.get("codes", [])[:6]]}
    return {}
