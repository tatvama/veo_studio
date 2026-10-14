"""Bundle and describe the recorded sound effects (Kenney, CC0): frontend/public/sfx/recorded/** and its manifest.

    python -I scripts/dev/gen_recorded_sfx.py                       # re-measure the bundled files, rewrite the manifest + NOTICE
    python -I scripts/dev/gen_recorded_sfx.py import <zip> [<zip>…]  # check and unpack Kenney's ZIPs, then the above

The packs, their pinned ZIP hashes and every sound family's name, category and tags live in the tables below; a ZIP
whose SHA-256 or size differs from its pin, that isn't CC0, or that holds anything unsafe (an absolute path, "..", a
link, an executable) is refused. Only audio is unpacked (Kenney's names, lower-cased); the pack-preview montages, the
.url shortcuts and desktop.ini stay out. A file over 1 MB is re-encoded as OGG Vorbis q5. The audio itself is never
changed otherwise: `gainDb` is what the editor sets as clip gain to reach −16 LUFS, capped so the true peak stays at or
below −1 dBTP (both measured with FFmpeg's ebur128; a sound shorter than 400 ms is measured as if followed by silence
up to 400 ms, like the procedural engine's own meter).

Writes frontend/src/editor/sfx/recorded.ts (one typed entry per file) and frontend/public/sfx/recorded/NOTICE.md.
FFmpeg: --ffmpeg, else $FFMPEG, else imageio-ffmpeg's binary in the backend venv, else `ffmpeg` on PATH.
Run it with `python -I` (the ZIPs and the audio are downloaded data).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "frontend" / "public" / "sfx" / "recorded"
MANIFEST = ROOT / "frontend" / "src" / "editor" / "sfx" / "recorded.ts"
NOTICE = OUT_DIR / "NOTICE.md"

TARGET_LUFS = -16.0
MAX_TRUE_PEAK = -1.0
MAX_GAIN = 24.0
MAX_FILE_BYTES = 1024 * 1024
MAX_TOTAL_BYTES = 30 * 1024 * 1024
MIN_BLOCK_S = 0.4

AUDIO_EXTS = {".ogg", ".wav", ".mp3"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg"}
# never in a sound pack: refuse the whole ZIP
EXEC_EXTS = {".exe", ".dll", ".bat", ".cmd", ".com", ".scr", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".msi", ".msp",
             ".lnk", ".jar", ".sh", ".py", ".pyc", ".hta", ".cpl", ".reg", ".app", ".dmg", ".so", ".dylib"}
# known, harmless, not wanted: left in the ZIP
SKIP_NAMES = {"desktop.ini": "a folder setting", "kenney.url": "a web shortcut", "patreon.url": "a web shortcut", "visit kenney.url": "a web shortcut",
              "visit patreon.url": "a web shortcut"}
SAFE_NAME = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,100}\.(ogg|wav|mp3)$")

CC0_URL = "creativecommons.org/publicdomain/zero/1.0"

# id, label, page, ZIP (pinned: size and SHA-256 as downloaded on 14 October 2026), the licence line of its License.txt,
# what of the ZIP stays out, and the files dropped as byte-for-byte copies of another (both checked on import)
_URLS = ["Kenney.url (a web shortcut)", "Patreon.url (a web shortcut)"]
_VISIT = ["Visit Kenney.url (a web shortcut)", "Visit Patreon.url (a web shortcut)"]
PACKS = [
    {"id": "impact", "label": "Impact Sounds", "url": "https://kenney.nl/assets/impact-sounds", "zip": "kenney_impact-sounds.zip",
     "bytes": 800850, "sha256": "029d734af1582474edf3a694d1b0cebc97c1c152f2f39fa34d4c2bafc5de77f8", "licence": "License: (Creative Commons Zero, CC0)",
     "left": _URLS, "dups": {"footstep_carpet_002.ogg": "footstep_carpet_001.ogg", "footstep_carpet_004.ogg": "footstep_carpet_003.ogg"}},
    {"id": "interface", "label": "Interface Sounds", "url": "https://kenney.nl/assets/interface-sounds", "zip": "kenney_interface-sounds.zip",
     "bytes": 834536, "sha256": "f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232", "licence": "License: (Creative Commons Zero, CC0)",
     "left": _URLS},
    {"id": "ui", "label": "UI Audio", "url": "https://kenney.nl/assets/ui-audio", "zip": "kenney_ui-audio.zip",
     "bytes": 411949, "sha256": "946fc23a63d535d693eb31b2eabb80c8c28d6351e2186b344ceb71b2cb1d5eb6", "licence": "License (Creative Commons Zero, CC0)",
     "left": ["Preview.ogg (the pack's preview montage)", *_VISIT]},
    {"id": "digital", "label": "Digital Audio", "url": "https://kenney.nl/assets/digital-audio", "zip": "kenney_digital-audio.zip",
     "bytes": 990367, "sha256": "24e6ce28b76a6d8c89cff4d331e0965ff5c3de8a73c612028e9d363cc64e4f06", "licence": "License (Creative Commons Zero, CC0)",
     "left": ["Preview.ogg (the pack's preview montage)", "Audio/desktop.ini (a folder setting)", *_VISIT]},
    {"id": "scifi", "label": "Sci-fi Sounds", "url": "https://kenney.nl/assets/sci-fi-sounds", "zip": "kenney_sci-fi-sounds.zip",
     "bytes": 5875104, "sha256": "119340f351a5098ad814f78719438c0da355a9ce8a4c8a3af6a8d48aa3d49e04", "licence": "License: (Creative Commons Zero, CC0)",
     "left": ["Audio/desktop.ini (a folder setting)", *_URLS]},
]
PACK = {p["id"]: p for p in PACKS}

# The 20 categories of the procedural library (frontend/src/editor/sfx/engine.ts SFX_CATEGORIES) plus the
# recorded-only collections (frontend/src/editor/sfx/recorded.ts RECORDED_COLLECTIONS).
CATEGORIES = {"whoosh", "riser", "downlifter", "impact", "sub_drop", "braam", "hit", "pop", "ui", "typing", "camera", "bell", "glitch", "tape",
              "reverse", "tick", "cash", "heartbeat", "ambience", "crowd"}
COLLECTIONS = [("footsteps", "Footsteps"), ("laser", "Lasers & zaps"), ("tones", "Tones & power-ups"), ("machines", "Sci-fi machines")]
# frontend/src/editor/sfx/types.ts SFX_TAGS
TAGS = ["whoosh", "swish", "riser", "downlifter", "impact", "boom", "sub_drop", "hit", "pop", "click", "typing", "shutter", "ding", "glitch",
        "static", "tape_stop", "scratch", "reverse", "tick", "countdown", "braam", "cash", "heartbeat", "wind", "rain", "applause"]

# (pack, family) → name, category, tags. A family is the lower-cased file name without its number.
FAMILIES: dict[tuple[str, str], tuple[str, str, list[str]]] = {
    **{("impact", f"footstep_{s}"): (f"Footstep, {s}", "footsteps", []) for s in ("carpet", "concrete", "grass", "snow", "wood")},
    ("impact", "impactbell_heavy"): ("Bell strike, heavy", "bell", ["ding"]),
    ("impact", "impactgeneric_light"): ("Impact, light", "impact", ["impact", "hit"]),
    **{("impact", f"impactglass_{w}"): (f"Glass knock, {w}", "hit", ["hit"]) for w in ("heavy", "medium", "light")},
    **{("impact", f"impactmetal_{w}"): (f"Metal impact, {w}", "impact", ["impact", "hit"]) for w in ("heavy", "medium", "light")},
    ("impact", "impactmining"): ("Pickaxe hit", "hit", ["hit", "impact"]),
    ("impact", "impactplank_medium"): ("Plank impact, medium", "impact", ["impact", "hit"]),
    **{("impact", f"impactplate_{w}"): (f"Plate impact, {w}", "impact", ["impact", "hit"]) for w in ("heavy", "medium", "light")},
    **{("impact", f"impactpunch_{w}"): (f"Punch, {w}", "hit", ["hit", "impact"]) for w in ("heavy", "medium")},
    **{("impact", f"impactsoft_{w}"): (f"Soft thud, {w}", "impact", ["impact"]) for w in ("heavy", "medium")},
    ("impact", "impacttin_medium"): ("Tin knock, medium", "hit", ["hit"]),
    **{("impact", f"impactwood_{w}"): (f"Wood impact, {w}", "impact", ["impact", "hit"]) for w in ("heavy", "medium", "light")},

    ("interface", "back"): ("Back", "ui", ["click"]),
    ("interface", "bong"): ("Bong", "bell", ["ding"]),
    ("interface", "click"): ("Click", "ui", ["click"]),
    ("interface", "close"): ("Close", "ui", ["click"]),
    ("interface", "confirmation"): ("Confirmation", "bell", ["ding"]),
    ("interface", "drop"): ("Drop", "pop", ["pop"]),
    ("interface", "error"): ("Error", "ui", []),
    ("interface", "glass"): ("Glass ting", "bell", ["ding"]),
    ("interface", "glitch"): ("Glitch", "glitch", ["glitch"]),
    ("interface", "maximize"): ("Maximise", "ui", ["pop"]),
    ("interface", "minimize"): ("Minimise", "ui", ["pop"]),
    ("interface", "open"): ("Open", "ui", ["pop"]),
    ("interface", "pluck"): ("Pluck", "pop", ["pop"]),
    ("interface", "question"): ("Question", "bell", ["ding"]),
    ("interface", "scratch"): ("Scratch", "tape", ["scratch"]),
    ("interface", "scroll"): ("Scroll", "ui", ["click"]),
    ("interface", "select"): ("Select", "ui", ["click"]),
    ("interface", "switch"): ("Switch", "ui", ["click"]),
    ("interface", "tick"): ("Tick", "tick", ["tick", "click"]),
    ("interface", "toggle"): ("Toggle", "ui", ["click"]),

    ("ui", "click"): ("UI click", "ui", ["click"]),
    ("ui", "mouseclick"): ("Mouse click", "ui", ["click"]),
    ("ui", "mouserelease"): ("Mouse release", "ui", ["click"]),
    ("ui", "rollover"): ("Rollover", "ui", ["click"]),
    ("ui", "switch"): ("UI switch", "ui", ["click"]),

    ("digital", "highdown"): ("High down", "tones", []),
    ("digital", "highup"): ("High up", "tones", []),
    ("digital", "laser"): ("Laser", "laser", []),
    ("digital", "lowdown"): ("Low down", "tones", []),
    ("digital", "lowrandom"): ("Low random", "tones", []),
    ("digital", "lowthreetone"): ("Low three-tone", "tones", []),
    ("digital", "pepsound"): ("Pep", "tones", ["pop"]),
    ("digital", "phasejump"): ("Phase jump", "laser", []),
    ("digital", "phaserdown"): ("Phaser down", "laser", []),
    ("digital", "phaserup"): ("Phaser up", "laser", []),
    ("digital", "powerup"): ("Power-up", "tones", []),
    ("digital", "spacetrash"): ("Space trash", "glitch", ["glitch"]),
    ("digital", "threetone"): ("Three-tone", "tones", ["ding"]),
    ("digital", "tone"): ("Tone", "tones", ["ding"]),
    ("digital", "twotone"): ("Two-tone", "tones", ["ding"]),
    ("digital", "zap"): ("Zap", "laser", []),
    ("digital", "zapthreetonedown"): ("Zap three-tone down", "laser", []),
    ("digital", "zapthreetoneup"): ("Zap three-tone up", "laser", []),
    ("digital", "zaptwotone"): ("Zap two-tone", "laser", []),

    ("scifi", "computernoise"): ("Computer noise", "glitch", ["glitch"]),
    ("scifi", "doorclose"): ("Sci-fi door close", "machines", []),
    ("scifi", "dooropen"): ("Sci-fi door open", "machines", []),
    ("scifi", "enginecircular"): ("Engine, circular", "machines", []),
    ("scifi", "explosioncrunch"): ("Explosion crunch", "impact", ["impact", "boom"]),
    ("scifi", "forcefield"): ("Force field", "machines", []),
    ("scifi", "impactmetal"): ("Sci-fi metal impact", "impact", ["impact", "hit"]),
    ("scifi", "laserlarge"): ("Laser, large", "laser", []),
    ("scifi", "laserretro"): ("Laser, retro", "laser", []),
    ("scifi", "lasersmall"): ("Laser, small", "laser", []),
    ("scifi", "lowfrequency_explosion"): ("Low-frequency explosion", "sub_drop", ["boom", "sub_drop"]),
    ("scifi", "slime"): ("Slime", "machines", []),
    ("scifi", "spaceengine"): ("Space engine", "machines", []),
    ("scifi", "spaceenginelarge"): ("Space engine, large", "machines", []),
    ("scifi", "spaceenginelow"): ("Space engine, low", "machines", []),
    ("scifi", "spaceenginesmall"): ("Space engine, small", "machines", []),
    ("scifi", "thrusterfire"): ("Thruster fire", "machines", []),
}
for (_p, _f), (_n, _c, _t) in FAMILIES.items():
    assert _c in CATEGORIES or _c in dict(COLLECTIONS), (_p, _f, _c)
    assert all(t in TAGS for t in _t), (_p, _f, _t)

NUM = re.compile(r"^(?P<fam>.*?)(?:_?(?P<num>\d+))?$")


def find_ffmpeg(arg: str | None) -> str:
    for c in (arg, os.environ.get("FFMPEG")):
        if c:
            return c
    try:
        import imageio_ffmpeg  # the backend venv has it

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 - any failure: try PATH
        pass
    w = shutil.which("ffmpeg")
    if not w:
        sys.exit("FFmpeg not found: give --ffmpeg or set FFMPEG")
    return w


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# ── import ───────────────────────────────────────────────────────────────────


class Refused(Exception):
    pass


def check_zip(z: zipfile.ZipFile) -> tuple[list[zipfile.ZipInfo], list[str], str]:
    """The audio entries to unpack, what stays in the ZIP (and why), and License.txt. Raises Refused."""
    audio: list[zipfile.ZipInfo] = []
    left: list[str] = []
    licence = ""
    for i in z.infolist():
        n = i.filename
        mode = (i.external_attr >> 16) & 0xFFFF
        parts = n.split("/")
        if n.startswith(("/", "\\")) or "\\" in n or ":" in n or "\x00" in n or ".." in parts or (len(n) > 1 and n[1] == ":"):
            raise Refused(f"unsafe path {n!r}")
        if stat.S_ISLNK(mode):
            raise Refused(f"a link {n!r}")
        if n.endswith("/"):
            continue
        base = posixpath.basename(n)
        ext = posixpath.splitext(base)[1].lower()
        if ext in EXEC_EXTS:
            raise Refused(f"an executable {n!r}")
        if i.file_size > 50 * 1024 * 1024 or (i.compress_size and i.file_size / i.compress_size > 100):
            raise Refused(f"{n!r} is too large or compresses suspiciously well")
        if base.lower() == "license.txt":
            licence = z.read(i).decode("utf-8", "replace")
        elif ext in AUDIO_EXTS and base.lower() == "preview.ogg":
            left.append(f"{n} (the pack's preview montage)")
        elif ext in AUDIO_EXTS:
            audio.append(i)
        elif ext in IMAGE_EXTS:
            left.append(f"{n} (a preview image)")
        elif base.lower() in SKIP_NAMES:
            left.append(f"{n} ({SKIP_NAMES[base.lower()]})")
        else:
            raise Refused(f"an unexpected file {n!r}")
    if not licence:
        raise Refused("no License.txt")
    return audio, left, licence


def import_zips(zips: list[Path], ffmpeg: str) -> None:
    by_name = {p["zip"]: p for p in PACKS}
    seen: set[str] = set()
    for zp in zips:
        pack = by_name.get(zp.name)
        if not pack:
            sys.exit(f"{zp.name}: not one of the approved packs ({', '.join(by_name)})")
        data = zp.read_bytes()
        if len(data) != pack["bytes"] or sha256(data) != pack["sha256"]:
            sys.exit(f"{zp.name}: size {len(data)} / SHA-256 {sha256(data)} differs from the pinned {pack['bytes']} / {pack['sha256']}")
        with zipfile.ZipFile(zp) as z:
            try:
                audio, left, licence = check_zip(z)
            except Refused as e:
                sys.exit(f"{zp.name}: refused, {e}")
            flat = " ".join(licence.split())
            if "CC0" not in flat or CC0_URL not in flat or pack["licence"] not in flat:
                sys.exit(f"{zp.name}: License.txt doesn't say CC0 1.0 — stopping")
            if sorted(left) != sorted(pack["left"]):
                sys.exit(f"{zp.name}: left out {sorted(left)}, expected {sorted(pack['left'])}: check the ZIP, then update PACKS")
            dest = OUT_DIR / pack["id"]
            if dest.exists():
                shutil.rmtree(dest)
            dest.mkdir(parents=True)
            names: set[str] = set()
            by_hash: dict[str, str] = {}
            dups: dict[str, str] = {}
            for i in audio:
                n = posixpath.basename(i.filename).lower()
                if not SAFE_NAME.match(n) or n in names:
                    sys.exit(f"{zp.name}: {i.filename!r} has no safe, unique lower-case name")
                fam = NUM.match(Path(n).stem)["fam"]
                if (pack["id"], fam) not in FAMILIES:
                    sys.exit(f"{zp.name}: {i.filename!r}: add the family {fam!r} to FAMILIES first")
                names.add(n)
                b = z.read(i)
                h = sha256(b)
                if h in by_hash:
                    dups[n] = by_hash[h]
                    continue
                by_hash[h] = n
                out = dest / n
                if len(b) > MAX_FILE_BYTES:
                    out = out.with_suffix(".ogg")
                    with tempfile.TemporaryDirectory() as td:
                        src = Path(td) / f"in{Path(n).suffix}"
                        src.write_bytes(b)
                        subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), "-map_metadata", "-1",
                                        "-c:a", "libvorbis", "-q:a", "5", str(out)], check=True)
                    print(f"  {n}: {len(b)} bytes, re-encoded as OGG q5 ({out.stat().st_size} bytes)")
                else:
                    out.write_bytes(b)
            if dups != pack.get("dups", {}):
                sys.exit(f"{zp.name}: copies {dups}, expected {pack.get('dups', {})}: check the ZIP, then update PACKS")
            print(f"{pack['id']}: {len(names) - len(dups)} files unpacked, {len(dups)} copies dropped, {len(left)} left in the ZIP")
            seen.add(pack["id"])
    missing = [p["id"] for p in PACKS if p["id"] not in seen and not (OUT_DIR / p["id"]).exists()]
    if missing:
        print(f"note: packs not imported yet: {', '.join(missing)}")


# ── measuring ────────────────────────────────────────────────────────────────

STREAM = re.compile(r"Audio: [^,]+, (\d+) Hz, ([^,]+),")
INTEGRATED = re.compile(r"^\s*I:\s+(-?[\d.]+|-inf) LUFS", re.M)
PEAK = re.compile(r"True peak:\s*\n\s*Peak:\s+(-?[\d.]+|-inf) dBFS", re.M)


def measure(ffmpeg: str, f: Path) -> dict:
    # samples, channels and rate: the decoded PCM itself
    r = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-i", str(f), "-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "-"],
                       capture_output=True, check=True)
    m = STREAM.search(r.stderr.decode("utf-8", "replace"))
    if not m:
        raise SystemExit(f"{f}: no audio stream")
    sr = int(m[1])
    layout = m[2].strip()
    ch = 1 if layout == "mono" else 2 if layout == "stereo" else int(re.match(r"(\d+) channels", layout)[1])
    frames = len(r.stdout) // (4 * ch)
    # loudness and true peak (ebur128; shorter than a block: followed by silence up to 400 ms)
    r = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-i", str(f), "-map", "0:a:0",
                        "-af", f"apad=whole_dur={MIN_BLOCK_S},ebur128=peak=true:framelog=quiet", "-f", "null", "-"], capture_output=True, check=True)
    err = r.stderr.decode("utf-8", "replace")
    i, p = INTEGRATED.findall(err), PEAK.findall(err)
    if not i or not p:
        raise SystemExit(f"{f}: no ebur128 summary")
    lufs = float(i[-1]) if i[-1] != "-inf" else -70.0
    tp = float(p[-1]) if p[-1] != "-inf" else -70.0
    want = min(TARGET_LUFS - lufs, MAX_TRUE_PEAK - tp)
    # in tenths of a dB, rounded down (so the true peak never goes over), within ±24 dB
    gain = max(-MAX_GAIN, min(MAX_GAIN, math.floor(want * 10 + 1e-6) / 10))
    return {"duration": round(frames / sr, 4), "channels": ch, "sampleRate": sr, "lufs": round(lufs, 1), "truePeak": round(tp, 1), "gainDb": round(gain, 1)}


def humanise(pack: str, fam: str, num: str | None, fam_min: int) -> str:
    base = FAMILIES[(pack, fam)][0]
    if num is None:
        return base
    return f"{base} {int(num) + (1 if fam_min == 0 else 0)}"


def ts(v) -> str:
    return json.dumps(v, ensure_ascii=False)


def write_manifest(ffmpeg: str) -> None:
    entries: list[dict] = []
    packs_out = []
    total = 0
    for pack in PACKS:
        d = OUT_DIR / pack["id"]
        files = sorted(x for x in d.iterdir() if x.suffix in AUDIO_EXTS) if d.exists() else []
        if not files:
            sys.exit(f"{pack['id']}: nothing bundled; run the import first")
        nums: dict[str, list[int]] = {}
        for f in files:
            m = NUM.match(f.stem)
            if m["num"] is not None:
                nums.setdefault(m["fam"], []).append(int(m["num"]))
        for f in files:
            if not SAFE_NAME.match(f.name):
                sys.exit(f"{f}: not a safe name")
            b = f.read_bytes()
            if len(b) > MAX_FILE_BYTES:
                sys.exit(f"{f}: over 1 MB")
            total += len(b)
            m = NUM.match(f.stem)
            fam = m["fam"]
            name, cat, tags = FAMILIES[(pack["id"], fam)]
            info = measure(ffmpeg, f)
            entries.append({"id": f"rec.{pack['id']}.{f.stem}", "name": humanise(pack["id"], fam, m["num"], min(nums.get(fam, [1]))), "pack": pack["id"],
                            "file": f.name, "category": cat, "tags": tags, **info, "bytes": len(b), "sha256": sha256(b)})
        packs_out.append({**pack, "files": len(files)})
        print(f"{pack['id']}: {len(files)} files measured")
    if total > MAX_TOTAL_BYTES:
        sys.exit(f"The recorded sounds are {total / 1e6:.1f} MB: over the 30 MB budget")

    lines = [
        "/**",
        " * Recorded sound effects: Kenney's CC0 packs (kenney.nl), bundled in frontend/public/sfx/recorded/<pack>/ (docs/EDITOR.md §15).",
        " * GENERATED by scripts/dev/gen_recorded_sfx.py from the bundled files: re-run it instead of editing this file.",
        " * Each sound: its measured length, channels, integrated loudness and true peak (FFmpeg ebur128), the clip gain that",
        " * brings it to −16 LUFS with its true peak at or below −1 dBTP (the file itself is unchanged), and its SHA-256.",
        " * Pure data, Node-safe.",
        " */",
        'import type { SfxCategory, SfxTag } from "./types.ts";',
        "",
        f"export type RecordedPackId = {' | '.join(ts(p['id']) for p in PACKS)};",
        f"export type RecordedCollection = {' | '.join(ts(c) for c, _ in COLLECTIONS)};",
        "/** One of the 20 procedural categories, or a recorded-only collection. */",
        "export type RecordedCategory = SfxCategory | RecordedCollection;",
        "",
        "export interface RecordedPack {",
        "  id: RecordedPackId; label: string; url: string; licence: \"CC0-1.0\"; author: string;",
        "  /** The ZIP as downloaded (pinned in the generator). */",
        "  zip: string; zipBytes: number; zipSha256: string;",
        "  /** Sounds bundled from it. */",
        "  files: number;",
        "}",
        "",
        "export interface RecordedSfx {",
        "  /** \"rec.<pack>.<file name without extension>\": stable. */",
        "  id: string;",
        "  name: string; pack: RecordedPackId;",
        "  /** The file in /sfx/recorded/<pack>/. */",
        "  file: string;",
        "  category: RecordedCategory; tags: SfxTag[];",
        "  /** Seconds. */",
        "  duration: number; channels: number; sampleRate: number;",
        "  /** Integrated loudness (LUFS) and true peak (dBTP) of the file as it is. */",
        "  lufs: number; truePeak: number;",
        "  /** Clip gain to −16 LUFS, capped so the true peak stays ≤ −1 dBTP; within ±24 dB. */",
        "  gainDb: number;",
        "  bytes: number; sha256: string;",
        "}",
        "",
        f"export const RECORDED_TARGET_LUFS = {TARGET_LUFS:g};",
        f"export const RECORDED_MAX_TRUE_PEAK = {MAX_TRUE_PEAK:g};",
        f"export const RECORDED_MAX_FILE_BYTES = {MAX_FILE_BYTES};",
        f"export const RECORDED_MAX_TOTAL_BYTES = {MAX_TOTAL_BYTES};",
        "",
        "export const RECORDED_COLLECTIONS: { id: RecordedCollection; label: string }[] = [",
        *[f"  {{ id: {ts(c)}, label: {ts(lbl)} }}," for c, lbl in COLLECTIONS],
        "];",
        "",
        "export const RECORDED_PACKS: RecordedPack[] = [",
        *[f"  {{ id: {ts(p['id'])}, label: {ts(p['label'])}, url: {ts(p['url'])}, licence: \"CC0-1.0\", author: \"Kenney (kenney.nl)\", zip: {ts(p['zip'])}, "
          f"zipBytes: {p['bytes']}, zipSha256: {ts(p['sha256'])}, files: {p['files']} }}," for p in packs_out],
        "];",
        "",
        "export const RECORDED_SFX: RecordedSfx[] = [",
    ]
    for e in entries:
        lines.append("  { " + ", ".join(f"{k}: {ts(e[k])}" for k in ("id", "name", "pack", "file", "category", "tags", "duration", "channels", "sampleRate",
                                                                    "lufs", "truePeak", "gainDb", "bytes", "sha256")) + " },")
    lines += ["];", ""]
    MANIFEST.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    write_notice(packs_out, entries, total)
    g = [e["gainDb"] for e in entries]
    lu = [e["lufs"] for e in entries]
    print(f"{len(entries)} sounds, {total / 1e6:.2f} MB; loudness {min(lu)} … {max(lu)} LUFS, gain {min(g)} … {max(g)} dB → {MANIFEST.relative_to(ROOT)}")


def write_notice(packs: list[dict], entries: list[dict], total: int) -> None:
    out = [
        "# Recorded sound effects: notice",
        "",
        "These sounds are by **Kenney** ([kenney.nl](https://kenney.nl)), released under **Creative Commons Zero (CC0 1.0)**,",
        "a public domain dedication (<https://creativecommons.org/publicdomain/zero/1.0/>). CC0 asks for no credit; we credit",
        "Kenney anyway, with thanks.",
        "",
        "Kenney's file names are kept, lower-cased, and the audio is as it came (OGG Vorbis; a file over 1 MB would be re-encoded",
        "as OGG Vorbis q5, and none was). The editor sets each sound's clip gain from `frontend/src/editor/sfx/recorded.ts`. Bundled by",
        "`scripts/dev/gen_recorded_sfx.py`, which pins each ZIP's size and SHA-256.",
        "",
        f"{len(entries)} files in {len(packs)} packs, {total / 1e6:.2f} MB in all.",
        "",
    ]
    for p in packs:
        out += [
            f"## {p['label']} (`{p['id']}/`)",
            "",
            f"- Source: <{p['url']}>",
            f"- Licence: CC0 1.0. Its License.txt says: \"{p['licence']}\" and \"http://{CC0_URL}/\"",
            f"- ZIP: `{p['zip']}`, {p['bytes']} bytes, SHA-256 `{p['sha256']}`",
            f"- Files bundled: {p['files']}",
        ]
        if p.get("dups"):
            out.append(f"- Dropped as byte-for-byte copies: {'; '.join(f'{a} (the same as {b})' for a, b in sorted(p['dups'].items()))}")
        if p["left"]:
            out.append(f"- Left out: {'; '.join(p['left'])}")
        out.append("")
    NOTICE.write_text("\n".join(out), encoding="utf-8", newline="\n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", nargs="?", default="manifest", choices=["manifest", "import"])
    ap.add_argument("zips", nargs="*", type=Path)
    ap.add_argument("--ffmpeg")
    a = ap.parse_args()
    ff = find_ffmpeg(a.ffmpeg)
    if a.cmd == "import":
        if not a.zips:
            sys.exit("import: give the ZIPs")
        import_zips(a.zips, ff)
    write_manifest(ff)


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
