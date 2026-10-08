"""Import a prepared script (Word, PDF, text) into scenes and shots.

1. `extract_text` reads the file. A .docx is a zip of XML, so it is read directly (no compiled dependency).
2. `parse_marked` reads scripts written in a recognisable layout: scene headings (SCENE 1, INT./EXT.), shots
   (SHOT 2), visual prompts (VISUAL: / PROMPT:), dialogue (NAME: line, or a NAME line above the words), voice-over
   (VO: / NARRATOR: / NAME (V.O.):) and optional DURATION / CAMERA / FRAMING lines.
3. Anything else goes to `ai_arrange`, which only splits the text into scenes and shots and tags speakers; it is told
   to copy every word. `mark_changed` then compares each dialogue line with the source and flags any that differ, so
   the review screen can show them.

The result is a *draft* in the same shape the shot list (core/board.py) uses, with character names instead of ids;
the import wizard maps names to characters before saving.
"""
from __future__ import annotations

import io
import re
import zipfile
from typing import Any
from xml.etree import ElementTree

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..agents import prompts
from ..agents import schemas as S
from ..models import Project, User

MAX_CHARS = 60_000
VO_NAMES = {"VO", "V.O.", "V.O", "VOICE OVER", "VOICE-OVER", "VOICEOVER", "NARRATOR", "NARRATION"}
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


# ── 1. text ──────────────────────────────────────────────────────────────────

def extract_text(filename: str, data: bytes) -> str:
    name = (filename or "").lower()
    if name.endswith(".docx") or data[:2] == b"PK":
        return _docx_text(data)
    if name.endswith(".pdf") or data[:5] == b"%PDF-":
        return _pdf_text(data)
    if name.endswith((".doc",)):
        raise HTTPException(400, "Old .doc files can't be read — save it as .docx (Word: File → Save As) or PDF")
    # UTF-16 only with its byte-order mark: without one, any even-length cp1252 file "decodes" into nonsense
    encs = ("utf-16",) if data[:2] in (b"\xff\xfe", b"\xfe\xff") else ("utf-8-sig", "cp1252")
    for enc in encs:
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    raise HTTPException(400, "Couldn't read this file as text")


def _docx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            root = ElementTree.fromstring(z.read("word/document.xml"))
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError) as e:
        raise HTTPException(400, f"This doesn't look like a Word (.docx) file: {e}")
    out: list[str] = []
    body = root.find(f"{W}body")
    for el in (body if body is not None else []):
        if el.tag == f"{W}p":
            out.append(_para(el))
        elif el.tag == f"{W}tbl":  # tables: one line per row, cells joined with " | "
            for row in el.iter(f"{W}tr"):
                cells = [" ".join(_para(p) for p in c.iter(f"{W}p")).strip() for c in row.iter(f"{W}tc")]
                out.append(" | ".join(c for c in cells if c))
    return "\n".join(out)


def _para(p) -> str:
    parts = []
    for node in p.iter():
        if node.tag == f"{W}t" and node.text:
            parts.append(node.text)
        elif node.tag in (f"{W}tab",):
            parts.append("\t")
        elif node.tag in (f"{W}br", f"{W}cr"):
            parts.append("\n")
    return "".join(parts)


def _pdf_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError:  # pragma: no cover
        raise HTTPException(500, "PDF support is not installed (pip install pypdf)")
    try:
        reader = PdfReader(io.BytesIO(data))
        text = "\n".join((pg.extract_text() or "") for pg in reader.pages)
    except Exception as e:
        raise HTTPException(400, f"Couldn't read this PDF: {e}")
    if not text.strip():
        raise HTTPException(400, "This PDF has no text layer (it's a scan or image). Export it from Word or paste the text instead.")
    return text


# ── 2. recognisable layouts ──────────────────────────────────────────────────

# a heading word on its own, followed by a number and/or a separator (so "Scarlett: hi", "Screaming…" and
# "Shots ring out." stay text)
SCENE_RE = re.compile(r"^\s*(?:#+\s*)?(?:scene\b|sc\.)\s*(\d+)?\s*([:.\-–—)]*)\s*(.*)$", re.I)
SLUG_RE = re.compile(r"^\s*(INT\.?/EXT\.?|EXT\.?/INT\.?|INT\.|EXT\.|I/E\.?)\s+(.+?)(?:\s*[-–—]\s*(.+))?\s*$", re.I)
SHOT_RE = re.compile(r"^\s*(?:#+\s*)?shot\b\s*(\d+)?\s*([:.\-–—)]*)\s*(.*)$", re.I)
FIELD_RE = re.compile(r"^\s*(visual(?:\s+prompt)?|prompt|action|description|camera|framing|shot\s*type|duration|length|location|time(?:\s+of\s+day)?|setting)\s*[:\-–—]\s*(.*)$", re.I)
SPEAK_RE = re.compile(r"^\s*([A-Zऀ-෿][\wऀ-෿ .'’-]{0,38}?)\s*(\((?:v\.?o\.?|o\.?s\.?|voice[ -]?over|off[ -]?screen)\))?\s*(\([^)]{1,60}\))?\s*[:：]\s*(.+)$", re.U)
CUE_RE = re.compile(r"^\s*([A-Z][A-Z0-9 .'’-]{1,30}?)\s*(\((?:V\.?O\.?|O\.?S\.?|CONT'?D)\))?\s*$")
PAREN_RE = re.compile(r"^\s*\(([^)]{1,80})\)\s*$")
# "LABEL: text" lines that are notes for the shot, not someone speaking
NOT_SPEAKERS = {"note", "notes", "music", "bgm", "score", "song", "sfx", "fx", "vfx", "sound", "sounds", "sound effect",
                "sound effects", "ambience", "ambient", "audio", "cut to", "fade in", "fade out", "fade to", "dissolve to",
                "transition", "title", "titles", "caption", "captions", "text", "on screen", "on-screen text",
                "onscreen text", "super", "graphic", "graphics", "logo", "cta", "hook", "insert", "montage", "b-roll",
                "broll", "beat", "pause", "lighting", "light", "mood", "tone", "style", "look", "lens", "angle", "pov",
                "props", "prop", "wardrobe", "costume", "makeup", "direction", "stage direction", "editor", "edit",
                "close up", "close-up", "closeup", "extreme close up", "wide", "medium", "establishing",
                "end", "the end", "time", "date", "day", "night", "voice", "aspect", "format", "product", "brand"}


def _is_label(name: str) -> bool:
    n = name.strip().rstrip(".").strip().lower()
    if n in NOT_SPEAKERS or n.endswith((" shot", " angle", " view")):
        return True
    # names are Title Case or CAPS: "She sees it: a gun" is a sentence, not a speaker
    words = name.strip().split()
    return any(w[:1].isascii() and w[:1].isalpha() and w[:1].islower() for w in words[1:])


DUR_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)\b", re.I)


def _dur(text: str) -> int:
    m = DUR_RE.search(text or "")
    if not m:
        return 8
    v = float(m.group(1))
    return 4 if v <= 4.5 else 6 if v <= 6.5 else 8


def _new_shot() -> dict[str, Any]:
    return {"prompt": "", "characters": [], "lines": [], "duration_s": 8, "framing": "", "camera": ""}


def _speaker(name: str, vo_tag: str | None) -> str:
    n = name.strip().rstrip(".").strip()
    if n.upper() in VO_NAMES or vo_tag:
        return "VO"
    return n.title() if n.isupper() else n  # screenplay CAPS → the name as the cast spells it


def parse_marked(text: str) -> dict | None:
    """Parse scripts that use recognisable markers. Returns None when the text doesn't look marked up enough to trust."""
    scenes: list[dict] = []
    scene: dict | None = None
    shot: dict | None = None
    pending_cue: tuple[str, str] | None = None  # screenplay style: NAME on its own line, words below
    pending_emotion = ""
    cue_line: dict | None = None  # the line being spoken under the cue (its words may wrap over several lines)
    markers = {"scene": 0, "shot": 0, "visual": 0, "line": 0}

    def ensure_scene() -> dict:
        nonlocal scene
        if scene is None:
            # "_explicit": this scene groups its shots with SHOT markers, so lines and visuals stay where they're written
            scene = {"title": f"Scene {len(scenes) + 1}", "location": "", "time_of_day": "", "summary": "", "shots": [],
                     "_explicit": False}
            scenes.append(scene)
        return scene

    def explicit() -> bool:
        return bool(scene and scene["_explicit"])

    def ensure_shot(new: bool = False) -> dict:
        nonlocal shot
        sc = ensure_scene()
        if shot is None or new:
            shot = _new_shot()
            sc["shots"].append(shot)
        return shot

    def add_line(who: str, words: str, emotion: str = "") -> dict:
        nonlocal shot
        cur = ensure_shot()
        # a second on-screen speaker gets their own shot (one speaker per shot lip-syncs best),
        # unless the shot was written explicitly with SHOT markers
        speakers = {l["speaker"] for l in cur["lines"] if l["speaker"] != "VO"}
        if who != "VO" and speakers and who not in speakers and not explicit():
            prev_prompt = cur["prompt"]
            cur = ensure_shot(new=True)
            cur["prompt"] = prev_prompt
        entry = {"speaker": who, "text": words.strip(), "emotion": emotion}
        cur["lines"].append(entry)
        if who != "VO" and who not in cur["characters"]:
            cur["characters"].append(who)
        markers["line"] += 1
        return entry

    def is_marker(line: str) -> bool:
        if SLUG_RE.match(line) or FIELD_RE.match(line) or PAREN_RE.match(line):
            return True
        m = SCENE_RE.match(line) or SHOT_RE.match(line)
        if m and (m.group(1) or m.group(2) or not m.group(3)):
            return True
        m = SPEAK_RE.match(line)
        if m and len(m.group(1).split()) <= 4 and not _is_label(m.group(1)):
            return True
        m = CUE_RE.match(line)
        return bool(m and line.upper() == line and len(line.split()) <= 4 and not line.endswith((".", "!", "?", ",")))

    for raw in text.splitlines():
        line = raw.strip().strip("*_").strip()
        if not line:
            pending_cue, cue_line, pending_emotion = None, None, ""
            continue
        if pending_cue and cue_line is not None and is_marker(line):
            pending_cue, cue_line, pending_emotion = None, None, ""  # the speech ended without a blank line
        if pending_cue:  # words under a NAME cue, until a blank line
            m = PAREN_RE.match(line)
            if m and cue_line is None:
                pending_emotion = m.group(1)
                continue
            if cue_line is None:
                cue_line = add_line(_speaker(*pending_cue), line, pending_emotion)
            else:
                cue_line["text"] = (cue_line["text"] + " " + line).strip()
            continue
        m = SLUG_RE.match(line)
        if m:
            scene, shot = None, None
            sc = ensure_scene()
            sc["location"] = m.group(2).strip().title()
            sc["time_of_day"] = (m.group(3) or "").strip().lower()
            sc["title"] = sc["location"] or sc["title"]
            markers["scene"] += 1
            continue
        m = SCENE_RE.match(line)
        if m and (m.group(1) or m.group(2) or not m.group(3)) and (m.group(1) or len(line) < 60):
            scene, shot = None, None
            sc = ensure_scene()
            rest = m.group(3).strip()
            if rest:
                sl = SLUG_RE.match(rest)
                if sl:
                    sc["location"], sc["time_of_day"] = sl.group(2).strip().title(), (sl.group(3) or "").strip().lower()
                sc["title"] = rest
            markers["scene"] += 1
            continue
        m = SHOT_RE.match(line)
        if m and (m.group(1) or m.group(2) or not m.group(3)) and (m.group(1) or len(line) < 40):
            cur = ensure_shot(new=True)
            scene["_explicit"] = True
            rest = m.group(3).strip()
            if DUR_RE.search(rest):
                cur["duration_s"] = _dur(rest)
                rest = re.sub(r"[(\[]?\s*" + DUR_RE.pattern + r"\s*[)\]]?", "", rest, flags=re.I).strip(" -–—:")
            if rest:
                cur["prompt"] = rest
            markers["shot"] += 1
            continue
        m = FIELD_RE.match(line)
        if m:
            key, val = m.group(1).lower(), m.group(2).strip()
            if key.startswith(("visual", "prompt", "action", "description")):
                cur = ensure_shot()
                if cur["prompt"] and (cur["lines"] or not explicit()):
                    cur = ensure_shot(new=True)  # a new visual starts a new shot unless SHOT markers group them
                cur["prompt"] = (cur["prompt"] + " " + val).strip()
                markers["visual"] += 1
            elif key == "camera":
                ensure_shot()["camera"] = val
            elif key in ("framing",) or key.startswith("shot"):
                ensure_shot()["framing"] = val
            elif key in ("duration", "length"):
                ensure_shot()["duration_s"] = _dur(val) if DUR_RE.search(val) else _dur(val + "s")
            elif key in ("location", "setting"):
                ensure_scene()["location"] = val
            elif key.startswith("time"):
                if DUR_RE.fullmatch(val.strip()):  # "Time: 10s" is a length, not a time of day
                    ensure_shot()["duration_s"] = _dur(val)
                else:
                    ensure_scene()["time_of_day"] = val
            continue
        m = SPEAK_RE.match(line)
        if m and len(m.group(1).split()) <= 4 and not _is_label(m.group(1)):
            who = _speaker(m.group(1), m.group(2))
            emotion = (m.group(3) or "").strip("() ")
            add_line(who, m.group(4), emotion)
            continue
        m = CUE_RE.match(line)
        if (m and line.upper() == line and len(line.split()) <= 4 and not line.endswith((".", "!", "?", ","))
                and not _is_label(m.group(1))):
            pending_cue, cue_line, pending_emotion = (m.group(1), m.group(2)), None, ""
            continue
        # plain text: scene description before any shot, otherwise more visual detail for the current shot
        if scene is not None and not scene["shots"]:
            scene["summary"] = (scene["summary"] + " " + line).strip()
        else:
            cur = ensure_shot()
            if cur["lines"] and not explicit():
                cur = ensure_shot(new=True)
            cur["prompt"] = (cur["prompt"] + " " + line).strip()

    # scenes that only had a description become one shot each
    for sc in scenes:
        if not sc["shots"] and sc["summary"]:
            sh = _new_shot()
            sh["prompt"] = sc["summary"]
            sc["shots"].append(sh)
        for sh in sc["shots"]:
            if not sh["prompt"]:
                sh["prompt"] = sc["summary"] or sc["title"]
    scenes = [{k: v for k, v in s.items() if k != "_explicit"} for s in scenes if s["shots"]]
    trusted = markers["scene"] >= 1 and (markers["shot"] + markers["visual"] + markers["line"]) >= 1
    return {"title": "", "scenes": scenes} if trusted and scenes else None


# ── 3. AI arranging (wording kept) ───────────────────────────────────────────

ARRANGE_SYSTEM = (
    prompts.DP + "\n\nYou are importing a script the user already wrote. Your only job is to split it into scenes and shots "
    "and to tag who speaks each line. COPY every dialogue line and every visual description character-for-character "
    "from the script: never translate, paraphrase, shorten, fix grammar, or invent lines or visuals. Voice-over, "
    "narration and off-screen lines get speaker VO. Keep the script's own order. If the script gives a shot length, "
    "use it (4, 6 or 8 seconds); otherwise pick 8 for dialogue shots and 6 for silent ones. One on-screen speaker per "
    "shot: if two people talk, make a shot / reverse-shot pair.")


def ai_arrange(db: Session, user: User, project: Project, text: str) -> dict:
    from .studio import _llm, lang_name

    prompt = (f"Script language: {lang_name(project.primary_language)} (keep the original language and script).\n"
              f"SCRIPT:\n<<<\n{text[:MAX_CHARS]}\n>>>")
    out = _llm(db, user, project, "import_script", ARRANGE_SYSTEM, prompt, S.ImportOut, {"text": text[:MAX_CHARS]},
               pro=len(text) > 20_000)
    return {"title": out.title, "scenes": [
        {"title": sc.title, "location": sc.location, "time_of_day": sc.time_of_day, "summary": sc.summary,
         "shots": [{"prompt": sh.prompt, "characters": sh.characters, "duration_s": sh.duration_s if sh.duration_s in (4, 6, 8) else 8,
                    "framing": sh.framing, "camera": sh.camera,
                    "lines": [{"speaker": "VO" if l.speaker.strip().upper() in VO_NAMES else l.speaker.strip(),
                               "text": l.text, "emotion": l.emotion} for l in sh.lines]}
                   for sh in sc.shots]}
        for sc in out.scenes]}


def _norm(s: str) -> str:
    return re.sub(r"[\W_]+", " ", (s or "").lower(), flags=re.U).strip()


def mark_changed(draft: dict, source: str) -> int:
    """Flag dialogue lines whose words don't appear in the source text. Returns how many were flagged."""
    src = " " + _norm(source) + " "
    n = 0
    for sc in draft["scenes"]:
        for sh in sc["shots"]:
            for l in sh["lines"]:
                l["changed"] = bool(_norm(l["text"])) and f" {_norm(l['text'])} " not in src
                n += l["changed"]
    return n


def build_draft(db: Session, user: User, project: Project, text: str, method: str = "auto") -> dict:
    """method: auto (markers if the layout is recognisable, else AI) | markers | ai."""
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        raise HTTPException(400, "The script is empty")
    warnings: list[str] = []
    if len(text) > MAX_CHARS:
        warnings.append(f"The script is long; only the first {MAX_CHARS:,} characters were imported. Import the rest as a second episode.")
    draft = None if method == "ai" else parse_marked(text[:MAX_CHARS])
    used = "markers"
    if draft is None:
        if method == "markers":
            raise HTTPException(400, "No scene headings found (SCENE 1 / INT. / EXT.). Use the template layout, or let the AI arrange it.")
        draft = ai_arrange(db, user, project, text)
        used = "ai"
    changed = mark_changed(draft, text)
    if changed:
        warnings.append(f"{changed} dialogue line(s) don't match your script word-for-word — they're highlighted; please check them.")
    names: dict[str, int] = {}
    for sc in draft["scenes"]:
        for sh in sc["shots"]:
            for n in sh["characters"]:
                names.setdefault(n, 0)
            for l in sh["lines"]:
                if l["speaker"] != "VO":
                    names[l["speaker"]] = names.get(l["speaker"], 0) + 1
    shots = sum(len(sc["shots"]) for sc in draft["scenes"])
    return {"draft": draft, "method": used, "warnings": warnings, "characters": [{"name": k, "lines": v} for k, v in names.items()],
            "stats": {"scenes": len(draft["scenes"]), "shots": shots,
                      "lines": sum(len(sh["lines"]) for sc in draft["scenes"] for sh in sc["shots"])}}
