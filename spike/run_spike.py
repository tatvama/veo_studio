"""Phase 0 — prove every model/service works on YOUR keys, and collect samples for the team's listening tests.

Usage (from VEO_STUDIO/):
    backend/.venv/Scripts/python spike/run_spike.py --list
    backend/.venv/Scripts/python spike/run_spike.py --only models,text,image,tts_gemini --budget 5
    backend/.venv/Scripts/python spike/run_spike.py --all --budget 30
    backend/.venv/Scripts/python spike/run_spike.py --only image_consistency,dialogue --budget 15   # language matrix

Keys are read from VEO_STUDIO/.env (GEMINI_API_KEY, ELEVENLABS_API_KEY, SYNC_API_KEY, SARVAM_API_KEY).
Every test prints its estimated cost first; the run stops before the total would pass --budget.
Results land in spike/results/<timestamp>/ with report.md, results.json and all media.
TTS samples are saved under blind codes (A1, B2…) with a separate answer key, for an honest listening test.
"""
from __future__ import annotations

import argparse
import json
import random
import string
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import os  # noqa: E402

for _stream in (sys.stdout, sys.stderr):  # Windows consoles default to cp1252, which cannot print the report symbols
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

os.environ["MOCK_PROVIDERS"] = "false"  # never fake results in the spike
os.environ.setdefault("DATA_ROOT", str(ROOT / "spike" / ".data"))
os.environ.setdefault("MEDIA_ROOT", str(ROOT / "spike" / ".media"))

from app import catalog  # noqa: E402
from app.agents import schemas as S  # noqa: E402
from app.db import Base, engine  # noqa: E402
from app.pipeline import ffmpeg as ff  # noqa: E402
from app.providers.base import ProviderError  # noqa: E402
from app.providers.services import Services, provider_mode  # noqa: E402

Base.metadata.create_all(bind=engine)

LINES = {
    "en": "I saw him again last night. The lamp was moving by itself.",
    "hi": "मैंने उसे कल रात फिर देखा। दीया अपने आप हिल रहा था।",
    "kn": "ನಿನ್ನೆ ರಾತ್ರಿ ಅವನನ್ನು ಮತ್ತೆ ನೋಡಿದೆ. ದೀಪ ತಾನಾಗಿಯೇ ಅಲುಗಾಡುತ್ತಿತ್ತು.",
    "te": "నిన్న రాత్రి అతన్ని మళ్ళీ చూశాను. దీపం దానంతట అదే కదులుతోంది.",
    "ta": "நேற்று இரவு அவனை மீண்டும் பார்த்தேன். விளக்கு தானாகவே அசைந்தது.",
}
DNA = ("Ravi: 28-year-old Indian man, lean build, short wavy black hair, light stubble, deep-set brown eyes, "
       "cream kurta with maroon border, thin silver chain.")
STYLE = "Cinematic, warm tungsten and dusk-blue palette, 35mm, shallow depth of field, soft haze."
PLACE = "Temple courtyard at dusk, worn stone floor, rows of brass oil lamps, distant gopuram silhouette."


class Ctx:
    def __init__(self, out: Path, budget: float):
        self.out = out
        self.budget = budget
        self.spent = 0.0
        self.svc = Services()
        self.results: list[dict[str, Any]] = []
        self.blind: dict[str, str] = {}
        self.cache: dict[str, Any] = {}
        self.matrix: list[dict[str, Any]] = []  # dialogue matrix rows
        self.blocked: dict[str, str] = {}  # provider -> why its remaining tests are skipped

    def save(self, name: str, data: bytes) -> Path:
        p = self.out / name
        p.write_bytes(data)
        return p

    def blind_name(self, label: str, ext: str) -> str:
        code = random.choice(string.ascii_uppercase) + "".join(random.choices(string.digits, k=3))
        while code in self.blind:
            code = random.choice(string.ascii_uppercase) + "".join(random.choices(string.digits, k=3))
        self.blind[code] = label
        return f"listen/{code}.{ext}"


Test = tuple[str, str, float, Callable[[Ctx], dict[str, Any]]]  # (name, provider, est_usd, fn)
TESTS: list[Test] = []


def test(name: str, provider: str, est: float):
    def deco(fn):
        TESTS.append((name, provider, est, fn))
        return fn
    return deco


def video_price(svc: Services, key: str, res: str = "720p") -> float:
    return svc.video_price(svc.models[key], res)


# ── tests ────────────────────────────────────────────────────────────────────

@test("models", "gemini", 0.0)
def t_models(c: Ctx) -> dict:
    """Check every configured Google model ID is visible to this key."""
    import httpx
    from app import settings_store
    r = httpx.get("https://generativelanguage.googleapis.com/v1beta/models", params={"pageSize": 1000},
                  headers={"x-goog-api-key": settings_store.api_key("gemini")}, timeout=60)
    r.raise_for_status()
    names = {m["name"].split("/")[-1] for m in r.json().get("models", [])}
    google_keys = [k for k, v in c.svc.models.items() if not k.endswith(("_elevenlabs", "_sarvam")) and not k.startswith("lipsync")]
    found = {k: c.svc.models[k] in names for k in google_keys}
    missing = [f"{k}={c.svc.models[k]}" for k, ok in found.items() if not ok]
    (c.out / "models_available.txt").write_text("\n".join(sorted(names)), encoding="utf-8")
    return {"ok": not missing, "notes": ("Missing (set overrides in Settings → Advanced): " + ", ".join(missing)) if missing else "All model IDs found",
            "files": ["models_available.txt"]}


@test("veo_access", "gemini", 0.20)
def t_veo_access(c: Ctx) -> dict:
    """Does this key's Google project have Veo quota? (Veo needs a billing account linked in AI Studio: Tier 1+.)
    One 4-second Lite clip, the cheapest possible Veo call. Run `--only veo_access` before the expensive tests."""
    r = c.svc.video(model_key="video_saver", prompt="A brass oil lamp flickers on a worn stone floor at dusk.",
                    aspect="9:16", duration=4, resolution="720p")
    p = c.save("veo_access.mp4", r.data)
    return {"ok": True, "usd": r.usage.usd, "notes": "Veo quota OK on this key", "files": [p.name]}


@test("text", "gemini", 0.01)
def t_text(c: Ctx) -> dict:
    obj, usage = c.svc.llm_json("brief", "You write production briefs.", "Concept: a temple priest finds a lamp that moves by itself. 45s vertical short, Kannada + English.", S.BriefOut)
    (c.out / "text_brief.json").write_text(obj.model_dump_json(indent=2), encoding="utf-8")
    return {"ok": True, "usd": usage.usd, "notes": f"tokens={usage.units}", "files": ["text_brief.json"]}


@test("image_consistency", "gemini", 0.30)
def t_image(c: Ctx) -> dict:
    """1 front portrait + 3 scenes using it as reference → judge if the face stays the same."""
    front = c.svc.image(f"Character reference portrait, front view, plain grey background. {DNA}", [], "3:4")
    fp = c.save(f"char_front.{front.ext}", front.data)
    c.cache["front"] = fp
    usd = front.usage.usd
    files = [fp.name]
    for i, scene in enumerate(["lighting an oil lamp, close-up", "walking through the courtyard, wide shot", "startled, looking over his shoulder, medium shot"]):
        r = c.svc.image(f"Film still, 9:16. Same man as the reference image, identical face and outfit. {DNA} {scene}. {PLACE} {STYLE}", [fp], "9:16")
        p = c.save(f"char_scene_{i + 1}.{r.ext}", r.data)
        files.append(p.name)
        usd += r.usage.usd
        if i == 0:
            c.cache["keyframe"] = p
    return {"ok": True, "usd": usd, "notes": "Check by eye: same face in all 4 images?", "files": files}


def _tts_all(c: Ctx, provider: str, voice_for: Callable[[str], str]) -> dict:
    files, usd = [], 0.0
    for lang, line in LINES.items():
        try:
            r = c.svc.tts(provider, line, voice_for(lang), lang)
        except ProviderError as e:
            files.append(f"{lang}: ERROR {e}")
            continue
        name = c.blind_name(f"{provider} / {lang} / {voice_for(lang)}", r.ext)
        (c.out / name).parent.mkdir(exist_ok=True)
        c.save(name, r.data)
        files.append(name)
        usd += r.usage.usd
    return {"ok": True, "usd": usd, "notes": "Blind samples saved in listen/ — answer key in listen/ANSWER_KEY.txt", "files": files}


@test("tts_gemini", "gemini", 0.02)
def t_tts_gemini(c: Ctx) -> dict:
    return _tts_all(c, "gemini", lambda l: "Charon")


@test("voice_design_gemini", "gemini", 0.02)
def t_vd_gemini(c: Ctx) -> dict:
    vid, sample, usage = c.svc.design_voice("gemini", "Ravi spike", "young male voice, soft, slightly husky, mid-20s, Kannada accent", "kn", "male")
    c.cache["gemini_voice"] = vid
    p = c.save("voice_design_gemini.wav", sample) if sample else None
    r = c.svc.tts("gemini", LINES["kn"], vid, "kn")
    name = c.blind_name(f"gemini designed voice / kn / {vid}", r.ext)
    (c.out / name).parent.mkdir(exist_ok=True)
    c.save(name, r.data)
    return {"ok": True, "usd": usage.usd + r.usage.usd, "notes": f"voice id {vid}", "files": [x for x in [p.name if p else None, name] if x]}


@test("tts_elevenlabs", "elevenlabs", 0.10)
def t_tts_eleven(c: Ctx) -> dict:
    voices = c.svc.eleven().list_voices()
    if not voices:
        return {"ok": False, "notes": "No voices in this ElevenLabs account"}
    vid = voices[0]["voice_id"]
    c.cache["eleven_voice"] = vid
    return _tts_all(c, "elevenlabs", lambda l: vid)


@test("tts_sarvam", "sarvam", 0.02)
def t_tts_sarvam(c: Ctx) -> dict:
    return _tts_all(c, "sarvam", lambda l: "anand")


@test("veo_lite_i2v", "gemini", 0.40)
def t_veo_lite(c: Ctx) -> dict:
    """Saver mode depends on this: does Lite keep the face from the keyframe?"""
    kf = c.cache.get("keyframe")
    if not kf:
        return {"ok": False, "notes": "run image_consistency first"}
    r = c.svc.video(model_key="video_saver", prompt=f"{STYLE} {DNA} He slowly lights the lamp and looks up, hesitant. Temple bells far away.",
                    aspect="9:16", duration=6, resolution="720p", first_frame=kf)
    p = c.save("veo_lite_i2v.mp4", r.data)
    c.cache["lite_video"] = p
    return {"ok": True, "usd": r.usage.usd, "notes": "Compare face with char_front — Saver mode viable?", "files": [p.name]}


def _scene(c: Ctx, n: int) -> Path | None:
    """char_scene_N.* saved by image_consistency (the extension depends on what the image model returns)."""
    return next(iter(sorted(c.out.glob(f"char_scene_{n}.*"))), None)


@test("veo_fast_refs", "gemini", 0.90)
def t_veo_refs(c: Ctx) -> dict:
    front = c.cache.get("front")
    scene = _scene(c, 2)
    refs = [x for x in [front, scene] if x]
    r = c.svc.video(model_key="video_balanced", prompt=f"{STYLE} {PLACE} {DNA} Medium shot, slow dolly-in. Ravi says quietly, \"I saw him again last night.\"",
                    aspect="9:16", duration=8, resolution="720p", refs=refs)
    p = c.save("veo_fast_refs.mp4", r.data)
    c.cache["fast_video"] = p
    c.cache["fast_video_uri"] = r.remote_ref
    return {"ok": True, "usd": r.usage.usd, "notes": f"{len(refs)} reference images", "files": [p.name]}


@test("veo_image_plus_refs", "gemini", 0.90)
def t_veo_combo(c: Ctx) -> dict:
    """Does Veo accept a first frame AND reference images together? (decides keyframe + refs strategy)"""
    from app import settings_store
    from app.providers.gemini import GeminiClient, guess_mime
    kf, front = c.cache.get("keyframe"), c.cache.get("front")
    if not (kf and front):
        return {"ok": False, "notes": "run image_consistency first"}
    g = GeminiClient(settings_store.api_key("gemini"))
    inst = {"prompt": f"{DNA} He turns towards the camera.", "image": g.inline(kf.read_bytes(), guess_mime(kf.read_bytes())),
            "referenceImages": [{"image": g.inline(front.read_bytes(), guess_mime(front.read_bytes())), "referenceType": "asset"}]}
    try:
        op = g.veo_start(c.svc.models["video_balanced"], inst, {"aspectRatio": "9:16", "resolution": "720p", "durationSeconds": 8})
    except ProviderError as e:
        return {"ok": True, "usd": 0.0, "notes": f"NOT supported (API said: {str(e)[:200]}) → keep keyframe and refs as separate routes"}
    resp = g.veo_wait(op)
    data = g.download_file(g.veo_video_uri(resp))
    p = c.save("veo_image_plus_refs.mp4", data)
    return {"ok": True, "usd": video_price(c.svc, "video_balanced") * 8, "notes": "SUPPORTED — can combine keyframe + refs", "files": [p.name]}


@test("veo_interpolate", "gemini", 0.90)
def t_veo_interp(c: Ctx) -> dict:
    a, b = _scene(c, 1), _scene(c, 3)
    if not (a and b):
        return {"ok": False, "notes": "run image_consistency first"}
    r = c.svc.video(model_key="video_balanced", prompt=f"{STYLE} Smooth continuous move from the first moment to the second. {DNA}",
                    aspect="9:16", duration=8, resolution="720p", first_frame=a, last_frame=b)
    p = c.save("veo_interpolate.mp4", r.data)
    return {"ok": True, "usd": r.usage.usd, "files": [p.name]}


@test("veo_extend", "gemini", 0.80)
def t_veo_extend(c: Ctx) -> dict:
    v = c.cache.get("fast_video")
    if not v:
        return {"ok": False, "notes": "run veo_fast_refs first"}
    r = c.svc.video(model_key="video_balanced", prompt="He steps closer to the lamp; the flame bends towards him.", aspect="9:16",
                    duration=8, resolution="720p", extend_from=v, extend_uri=c.cache.get("fast_video_uri", ""))
    p = c.save("veo_extend.mp4", r.data)
    return {"ok": True, "usd": r.usage.usd, "notes": f"duration {ff.duration(p):.1f}s", "files": [p.name]}


def _native(lang: str):
    def fn(c: Ctx) -> dict:
        r = c.svc.video(model_key="video_balanced", prompt=f"{STYLE} {PLACE} {DNA} Close-up, he speaks quietly to camera: \"{LINES[lang]}\"",
                        aspect="9:16", duration=8, resolution="720p")
        p = c.save(f"veo_native_{lang}.mp4", r.data)
        c.cache[f"native_{lang}"] = p
        return {"ok": True, "usd": r.usage.usd, "notes": f"Native {catalog.LANGUAGES[lang]['name']} dialogue — is pronunciation usable?", "files": [p.name]}
    return fn


for _l in ("hi", "kn", "te", "ta"):
    test(f"veo_native_{_l}", "gemini", 0.85)(_native(_l))


# ── Phase 0 dialogue matrix: can Veo speak our languages well enough to be the default? ──────────────
# 4 languages × (close-up | medium) × (Fast | Lite), in the language's own script, plus a romanised variant.
# Every clip is scored by Gemini (what was said, language, pronunciation, lip-sync). `--only dialogue` runs them all.

ROMAN = {
    "hi": "Maine use kal raat phir dekha. Diya apne aap hil raha tha.",
    "kn": "Ninne raatri avanannu matte nodide. Deepa taanaagiye alugaaduttittu.",
    "te": "Ninna raatri atanni malli choosaanu. Deepam daanantata ade kadulutondi.",
    "ta": "Netru iravu avanai meendum paarthen. Vilakku thaanaagave asainthathu.",
}
VOICE = "Voice: a man in his late twenties, warm medium-low voice, calm and unhurried, soft regional accent."
FRAMINGS = {"closeup": "Close-up on his face, eyes to camera", "medium": "Medium shot, he faces the camera, hands visible"}
ENGINES = {"fast": "video_balanced", "lite": "video_saver"}


class DialogueCheck(BaseModel):
    heard: str = Field(description="the words you hear, written in the script of the language spoken")
    language: str = Field(description="language actually spoken, e.g. Kannada, Hindi, English, none")
    word_match: float = Field(description="0-1: how much of the expected line was spoken correctly")
    pronunciation: float = Field(description="0-1: how natural a native speaker would find it")
    sync_score: float = Field(description="0-1: mouth shapes and timing match the speech")
    subtitles_burned: bool = Field(description="any on-screen text or captions in the picture")
    notes: str = ""


def _dialogue_prompt(lang: str, framing: str, roman: bool) -> str:
    # The shape that works best for Veo: attribution first, the line early, one speaker, a voice description,
    # and the look after the dialogue so a long style block cannot push the line out.
    line = ROMAN[lang] if roman else LINES[lang]
    name = catalog.LANGUAGES[lang]["name"]
    return (f'{FRAMINGS[framing]}. Ravi says in {name}, quietly and clearly: "{line}" {VOICE} '
            f"{DNA} {PLACE} {STYLE} No subtitles, no on-screen text.")


def _check_dialogue(c: Ctx, path: Path, lang: str, roman: bool) -> tuple[dict, float]:
    expected = ROMAN[lang] if roman else LINES[lang]
    prompt = (f"Expected language: {catalog.LANGUAGES[lang]['name']}. Expected line: {expected}\n"
              "Listen to the clip. Transcribe exactly what is spoken, name the language actually spoken, score word "
              "accuracy, pronunciation and lip-sync, and say whether any text is burned into the picture.")
    obj, usage = c.svc.llm_json("dialogue_check", "You are a strict native-speaker reviewer of AI-generated dialogue.",
                                prompt, DialogueCheck, videos=[path.read_bytes()])
    return obj.model_dump(), usage.usd


def _matrix(lang: str, framing: str, engine: str, roman: bool = False):
    def fn(c: Ctx) -> dict:
        kf = c.cache.get("keyframe")  # same face in every clip when image_consistency ran first
        r = c.svc.video(model_key=ENGINES[engine], prompt=_dialogue_prompt(lang, framing, roman), aspect="9:16",
                        duration=8, resolution="720p", **({"first_frame": kf} if kf else {}))
        name = f"dialogue_{lang}_{'roman' if roman else 'script'}_{framing}_{engine}.mp4"
        p = c.save(name, r.data)
        chk, qc_usd = _check_dialogue(c, p, lang, roman)
        c.matrix.append({"lang": lang, "script": "roman" if roman else "native", "framing": framing, "engine": engine,
                         "file": name, **chk})
        ok = chk["word_match"] >= 0.8 and chk["sync_score"] >= 0.6 and not chk["subtitles_burned"]
        return {"ok": ok, "usd": r.usage.usd + qc_usd, "files": [name],
                "notes": (f"{chk['language']} · words {chk['word_match']:.2f} · pron {chk['pronunciation']:.2f} · "
                          f"lips {chk['sync_score']:.2f} · heard: {chk['heard'][:60]}")}
    return fn


for _l in ("hi", "kn", "te", "ta"):
    for _f in FRAMINGS:
        for _e, _est in (("fast", 0.82), ("lite", 0.42)):
            test(f"dialogue_{_l}_{_f}_{_e}", "gemini", _est)(_matrix(_l, _f, _e))
    test(f"dialogue_{_l}_roman", "gemini", 0.82)(_matrix(_l, "closeup", "fast", roman=True))


def matrix_report(rows: list[dict[str, Any]]) -> str:
    """Per-language table plus the decision the plan needs: native Veo, or TTS + lip-sync."""
    out = ["# Dialogue matrix", "", "Scores are Gemini's; native speakers should confirm by watching the clips.", ""]
    for lang in ("hi", "kn", "te", "ta"):
        rs = [r for r in rows if r["lang"] == lang]
        if not rs:
            continue
        out += [f"## {catalog.LANGUAGES[lang]['name']}", "",
                "| Script | Framing | Engine | Language heard | Words | Pronunciation | Lips | Text burned | Heard |",
                "|---|---|---|---|---|---|---|---|---|"]
        for r in rs:
            out.append(f"| {r['script']} | {r['framing']} | {r['engine']} | {r['language']} | {r['word_match']:.2f} | "
                       f"{r['pronunciation']:.2f} | {r['sync_score']:.2f} | {'yes' if r['subtitles_burned'] else 'no'} | "
                       f"{str(r['heard']).replace('|', '/')[:80]} |")
        best = max(rs, key=lambda r: (r["word_match"] + r["pronunciation"] + r["sync_score"]))
        native_ok = best["word_match"] >= 0.8 and best["pronunciation"] >= 0.7 and best["sync_score"] >= 0.6
        out += ["", (f"**Decision:** native Veo dialogue looks viable (best: {best['script']} script, {best['framing']}, "
                     f"{best['engine']})." if native_ok
                     else "**Decision:** use Gemini TTS + lip-sync for this language until Veo improves."), ""]
    return "\n".join(out)


@test("lipsync_kn", "sync", 0.70)
def t_lipsync(c: Ctx) -> dict:
    video = c.cache.get("native_kn") or c.cache.get("fast_video")
    if not video:
        return {"ok": False, "notes": "needs a Veo clip (run veo_native_kn or veo_fast_refs)"}
    r = c.svc.tts("gemini", LINES["kn"], c.cache.get("gemini_voice", "Charon"), "kn") if provider_mode("gemini") == "live" else None
    if not r:
        return {"ok": False, "notes": "needs Gemini TTS"}
    audio = c.save("lipsync_kn_input.wav", r.data)
    files, usd = [], r.usage.usd
    for model in ("lipsync-2", "lipsync-2-pro"):
        out = c.svc.lipsync(video, audio, model)
        p = c.save(f"lipsync_kn_{model}.mp4", out.data)
        files.append(p.name)
        usd += out.usage.usd
    return {"ok": True, "usd": usd, "notes": "Compare lipsync-2 vs lipsync-2-pro on Kannada", "files": files}


@test("voice_changer_hi", "elevenlabs", 0.10)
def t_sts(c: Ctx) -> dict:
    video = c.cache.get("native_hi")
    vid = c.cache.get("eleven_voice")
    if not (video and vid):
        return {"ok": False, "notes": "needs veo_native_hi and tts_elevenlabs"}
    wav = ff.extract_audio(video, c.out / "native_hi_audio.wav")
    iso = c.svc.isolate_voice(wav)
    iso_p = c.save(f"native_hi_vocals.{iso.ext}", iso.data)
    conv = c.svc.voice_change(ff.to_wav(iso_p, c.out / "native_hi_vocals_in.wav", 44100), vid)
    out_a = c.save(f"voice_changed_hi.{conv.ext}", conv.data)
    muxed = ff.mux_audio(video, out_a, c.out / "voice_changed_hi.mp4")
    return {"ok": True, "usd": iso.usage.usd + conv.usage.usd, "notes": "Voice Lock on Hindi — lips still match? accent kept?", "files": [muxed.name]}


@test("omni_edit", "gemini", 1.80)
def t_omni(c: Ctx) -> dict:
    v = c.cache.get("lite_video") or c.cache.get("fast_video")
    if not v:
        return {"ok": False, "notes": "needs a Veo clip"}
    r = c.svc.omni_edit("Make it night with soft moonlight; keep the man and the lamp exactly the same.", "9:16", video=v)
    p = c.save("omni_edit.mp4", r.data)
    return {"ok": True, "usd": r.usage.usd, "notes": f"interaction {r.interaction_id}", "files": [p.name]}


@test("music", "gemini", 0.10)
def t_music(c: Ctx) -> dict:
    r = c.svc.music("Instrumental only, no vocals. Soft tanpura drone with bansuri flute, suspenseful, cinematic, slow.", 30)
    p = c.save(f"music.{r.ext}", r.data)
    return {"ok": True, "usd": r.usage.usd, "notes": f"{r.duration_s:.0f}s", "files": [p.name]}


# ── runner ───────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--budget", type=float, default=float(os.environ.get("SPIKE_BUDGET_USD", 30)))
    a = ap.parse_args()
    if a.list or not (a.all or a.only):
        print(f"{'test':24} {'provider':11} {'est $':>6}  key")
        for name, prov, est, _ in TESTS:
            print(f"{name:24} {prov:11} {est:6.2f}  {provider_mode(prov)}")
        print(f"\nTotal if all run: ${sum(t[2] for t in TESTS):.2f}. Use --all or --only a,b,c  (budget default ${a.budget:.0f})")
        return
    only = [x.strip() for x in a.only.split(",") if x.strip()]
    wanted = [t for t in TESTS if a.all or t[0] in only or any(t[0].startswith(g + "_") for g in only)]
    out = ROOT / "spike" / "results" / datetime.now().strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    c = Ctx(out, a.budget)
    for name, prov, est, fn in wanted:
        row: dict[str, Any] = {"test": name, "provider": prov, "est_usd": est}
        if provider_mode(prov) != "live":
            row.update(status="skipped", notes=f"no {prov} API key")
        elif prov in c.blocked:
            row.update(status="skipped", notes=c.blocked[prov])
        elif c.spent + est > c.budget:
            row.update(status="skipped", notes=f"would exceed budget (${c.spent:.2f} + ${est:.2f} > ${c.budget:.2f})")
        else:
            print(f"▶ {name} (≈${est:.2f}) …", flush=True)
            t0 = time.time()
            try:
                res = fn(c)
                row.update(status="ok" if res.get("ok") else "check", **res)
            except Exception as e:  # keep going; record the exact failure for debugging
                row.update(status="error", notes=f"{type(e).__name__}: {e}", trace=traceback.format_exc()[-1500:])
                if "check your plan and billing" in str(e):  # no quota at all: every later call would fail the same way
                    c.blocked[prov] = (f"{prov} project has no quota for this (billing not linked / free tier). "
                                       "Link a billing account in AI Studio, then rerun.")
                    print(f"  !! {c.blocked[prov]}")
            row["seconds"] = round(time.time() - t0, 1)
            c.spent += float(row.get("usd") or 0)
        print(f"  {row['status']:8} {row.get('notes', '')}")
        c.results.append(row)
    if c.blind:
        (out / "listen").mkdir(exist_ok=True)
        (out / "listen" / "ANSWER_KEY.txt").write_text("\n".join(f"{k}: {v}" for k, v in sorted(c.blind.items())), encoding="utf-8")
    (out / "results.json").write_text(json.dumps(c.results, indent=2, ensure_ascii=False), encoding="utf-8")
    lines = ["# Phase 0 results", "", f"Run: {out.name} · spent ≈ ${c.spent:.2f} of ${c.budget:.2f}", "",
             "| Test | Status | Time | Cost | Notes |", "|---|---|---|---|---|"]
    for r in c.results:
        lines.append(f"| {r['test']} | {r['status']} | {r.get('seconds', '')}s | ${float(r.get('usd') or 0):.2f} | {str(r.get('notes', '')).replace('|', '/')} |")
    lines += ["", "## Listening test", "Play the files in `listen/` without looking at ANSWER_KEY.txt; score each 1–5 for naturalness,",
              "pronunciation and emotion. Then set the winner per language in Settings → Voices."]
    (out / "report.md").write_text("\n".join(lines), encoding="utf-8")
    if c.matrix:
        (out / "dialogue_matrix.md").write_text(matrix_report(c.matrix), encoding="utf-8")
        print(f"Dialogue matrix: {out / 'dialogue_matrix.md'}")
    print(f"\nDone. Report: {out / 'report.md'}")


if __name__ == "__main__":
    main()
