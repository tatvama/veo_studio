"""Import a prepared script (Word, PDF, text) into scenes and shots.

1. `extract_text` reads the file. A .docx is a zip of XML, so it is read directly (no compiled dependency).
2. `parse_marked` reads scripts written in a recognisable layout: scene headings (SCENE 1, INT./EXT.), shots
   (SHOT 2), visual prompts (VISUAL: / PROMPT:), dialogue (NAME: line, or a NAME line above the words), voice-over
   (VO: / NARRATOR: / NAME (V.O.):) and optional DURATION / CAMERA / FRAMING lines. Notes are kept where they belong,
   so they carry through every shot: MOOD / LIGHTING / LOOK / WEATHER / AMBIENCE / MUSIC for the scene (written before
   the first scene: for every scene), SFX / SOUND for the shot, and a CHARACTERS (CAST) list or a description at a
   character's first appearance ("RAVI (35, grey beard)") for the cast. A cast name in a shot's visual puts that
   character in the shot, speaking or not.
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

# Lines are read with their whitespace collapsed to single spaces (parse_marked), so these patterns take at most one
# space where one may be, and never two space-eating parts in a row; each is anchored with ^ (and used with .match):
# they run in linear time on any line.
# a heading word on its own, followed by a number and/or a separator (so "Scarlett: hi", "Screaming…" and
# "Shots ring out." stay text)
SCENE_RE = re.compile(r"^(?:#+ ?)?(?:scene\b|sc\.) ?(\d+)? ?([:.\-–—)]*) ?(.*)", re.I)
SLUG_RE = re.compile(r"^(INT\.?/EXT\.?|EXT\.?/INT\.?|INT\.|EXT\.|I/E\.?) (.+)", re.I)
SHOT_RE = re.compile(r"^(?:#+ ?)?shot\b ?(\d+)? ?([:.\-–—)]*) ?(.*)", re.I)
FIELD_RE = re.compile(r"^(visual(?: prompt)?|prompt|action|description|camera|framing|shot ?type|duration|length|location|"
                      r"time(?: of day)?|setting) ?[:\-–—](.*)", re.I)
SPEAK_RE = re.compile(r"^\s*([A-Zऀ-෿][\wऀ-෿ .'’-]{0,38}?)\s*(\((?:v\.?o\.?|o\.?s\.?|voice[ -]?over|off[ -]?screen)\))?\s*(\([^)]{1,60}\))?\s*[:：]\s*(.+)$", re.U)
# a NAME line on its own (screenplay cue), words separated by single spaces; its length is checked by _cue
CUE_RE = re.compile(r"^([A-Z][A-Z0-9.'’-]*(?: [A-Z0-9.'’-]+)*)(?: ?(\((?:V\.?O\.?|O\.?S\.?|CONT'?D)\)))?$")
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
# a script's cover page: never a speaker
NOT_SPEAKERS |= {"genre", "logline", "log line", "synopsis", "summary", "theme", "themes", "language", "languages",
                 "platform", "target audience", "runtime", "run time", "tagline", "hashtags", "premise", "characters",
                 "character", "cast"}
# … and before the first scene these aren't speakers either (later "DIRECTOR: Cut!" may well be someone talking)
HEADER_ONLY = {"title", "episode", "series", "season", "written by", "writer", "writers", "author", "director",
               "directed by", "producer", "story", "concept", "duration", "length", "audience"}
# notes for the scene or the shot: "SFX: thunder", "MOOD: tense", "LIGHTING: one oil lamp" (a dash needs a space before
# it, so "Style-conscious Meera …" stays text)
META_RE = re.compile(r"^(sfx|fx|sound ?effects?|sounds?|foley|audio|ambien(?:ce|t)|music|bgm|background music|score|"
                     r"song|mood|tone|atmosphere|emotion|feel(?:ing)?|lighting|light|look|colou?r(?: palette)?|palette|"
                     r"grade|weather|style|visual style)(?: ?:| [-–—])(.+)", re.I)
META_KIND = [(r"^(sfx|fx|sound ?effects?|sounds?|foley|audio)$", "sfx"), (r"^ambien", "sound"),
             (r"^(music|bgm|background music|score|song)$", "music"), (r"^(mood|tone|atmosphere|emotion|feel)", "mood")]
CAST_HEAD_RE = re.compile(r"^(?:#+ ?)?(?:main )?(?:characters?|cast)(?: (?:list|descriptions?|details|bible|sheet|looks?))?",
                          re.I)
_NAME = r"([A-Zऀ-෿][\wऀ-෿ .'’-]{0,38}?)"
CAST_ENTRY_RE = re.compile(r"^(?:[-•*·] ?|\d+[.)] ?)?" + _NAME + r" ?(?:\(([^)]{1,160})\))?(?: ?:| [-–—])(.+)")
CAST_PAREN_RE = re.compile(r"^(?:[-•*·] ?|\d+[.)] ?)?" + _NAME + r" ?\(([^)]{3,200})\)\.?$")
# a character's first appearance in screenplay style: "RAVI (35, weathered, grey beard) steps in"
INTRO_RE = re.compile(r"\b([A-Z][A-Z'’.-]+(?:\s+[A-Z][A-Z'’.-]+){0,2})\s*\(([^)]{3,160})\)")
NOT_INTRO = re.compile(r"^(v\.?o\.?|o\.?s\.?|o\.?c\.?|cont'?d|voice[ -]?over|off[ -]?screen)$", re.I)


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
    return {"prompt": "", "characters": [], "lines": [], "duration_s": 8, "framing": "", "camera": "", "sfx": ""}


def _speaker(name: str, vo_tag: str | None) -> str:
    n = name.strip().rstrip(".").strip()
    if n.upper() in VO_NAMES or vo_tag:
        return "VO"
    return n.title() if n.isupper() else n  # screenplay CAPS → the name as the cast spells it


def _cue(line: str) -> re.Match | None:
    """A screenplay cue: a NAME (2-31 characters) on its own line, maybe with (V.O.) / (O.S.) / (CONT'D)."""
    m = CUE_RE.match(line)
    return m if m and 2 <= len(m.group(1)) <= 31 else None


def _slug(text: str) -> tuple[str, str] | None:
    """'INT. KITCHEN - MORNING' → ('KITCHEN', 'MORNING'); ('KITCHEN', '') without a time; None when not a slug line.
    The time follows the first spaced dash ("MOTHER-IN-LAW'S HOUSE - NIGHT"), else the first dash."""
    m = SLUG_RE.match(text)
    if not m:
        return None
    rest = m.group(2).strip()
    cuts = [i for i in (rest.find(f" {d} ") for d in "-–—") if i > 0]
    if cuts:
        i = min(cuts)
        place, when = rest[:i], rest[i + 3:]
    else:
        i = next((k for k, ch in enumerate(rest) if ch in "-–—" and k > 0), -1)
        place, when = (rest[:i], rest[i + 1:]) if i > 0 else (rest, "")
    place, when = place.strip(" -–—"), when.strip()
    return (place, when) if place else None


def _cast_head(line: str) -> str | None:
    """'CHARACTERS', 'Cast list:', 'CAST – Ravi (35), Meera (30)' → the text after the heading ('' when none);
    None when the line isn't a cast heading ("Characters gather in the hall", "Castle gates")."""
    m = CAST_HEAD_RE.match(line)
    if not m:
        return None
    rest = line[m.end():]
    if not rest.strip():
        return ""
    if rest.lstrip().startswith(":"):
        return rest.lstrip()[1:].strip()
    if rest[:1] == " " and rest[1:2] in ("-", "–", "—"):
        return rest[2:].strip()
    return None


def _meta_kind(label: str) -> str:
    """sfx | sound | music | mood | look for a META_RE label."""
    low = " ".join(label.lower().split())
    return next((kind for pat, kind in META_KIND if re.search(pat, low)), "look")


def _append(row: dict, key: str, val: str, sep: str = "; ") -> None:
    val = val.strip().rstrip(".").strip()
    if val and val.lower() not in (row.get(key) or "").lower():
        row[key] = f"{row[key]}{sep}{val}" if row.get(key) else val


def _split_top(text: str) -> list[str]:
    """'Ravi (35, farmer), Meera (30)' → the items, split on commas and semicolons outside brackets."""
    out, depth, cur = [], 0, ""
    for ch in text:
        depth += ch == "("
        depth -= ch == ")" and depth > 0
        if ch in ",;" and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    return [x.strip() for x in out + [cur] if x.strip()]


def _same_person(a: str, b: str) -> bool:
    """'Ravi' and 'Ravi Kumar' (whole words), never 'Al' and 'Sally'."""
    wa, wb = a.lower().split(), b.lower().split()
    return bool(wa and wb) and (wa == wb or set(wa) <= set(wb) or set(wb) <= set(wa))


def _mentions(text: str, name: str) -> bool:
    """The name, as written or in CAPS, as whole words (case-sensitive: "Will" the person, not "will")."""
    return bool(re.search(r"(?<!\w)(?:" + re.escape(name) + "|" + re.escape(name.upper()) + r")(?!\w)", text or ""))


def parse_marked(text: str) -> dict | None:
    """Parse scripts that use recognisable markers. Returns None when the text doesn't look marked up enough to trust."""
    scenes: list[dict] = []
    scene: dict | None = None
    shot: dict | None = None
    pending_cue: tuple[str, str] | None = None  # screenplay style: NAME on its own line, words below
    pending_emotion = ""
    cue_line: dict | None = None  # the line being spoken under the cue (its words may wrap over several lines)
    markers = {"scene": 0, "shot": 0, "visual": 0, "line": 0}
    film: dict[str, str] = {"title": "", "mood": "", "look": "", "sound": "", "music": ""}  # notes before scene 1
    cast: dict[str, str] = {}  # name → description, from a CHARACTERS list
    intros: dict[str, str] = {}  # name → description, from "RAVI (35, grey beard)" in the action
    cast_mode, cast_gap, cast_last = False, False, ""

    def ensure_scene() -> dict:
        nonlocal scene
        if scene is None:
            # "_explicit": this scene groups its shots with SHOT markers, so lines and visuals stay where they're written
            scene = {"title": f"Scene {len(scenes) + 1}", "location": "", "time_of_day": "", "summary": "", "mood": "",
                     "look": "", "sound": "", "music": "", "shots": [], "_explicit": False}
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

    def add_meta(label: str, val: str) -> None:
        """A note goes where it holds: before the first scene for every scene, before a scene's first shot for the
        whole scene, and a sound effect inside a shot for that shot."""
        kind = _meta_kind(label)
        low = " ".join(label.lower().split())
        if kind == "look" and low not in ("look", "style", "visual style"):
            val = f"{low}: {val}"  # "lighting: one oil lamp", "weather: heavy rain"
        if scene is None:
            _append(film, "sound" if kind == "sfx" else kind, val, ", " if kind == "mood" else "; ")
        elif kind == "sfx" and scene["shots"] and shot is not None:
            _append(shot, "sfx", val)
        else:
            _append(scene, "sound" if kind == "sfx" else kind, val, ", " if kind == "mood" else "; ")

    def add_cast(name: str, desc: str) -> None:
        nonlocal cast_last
        cast_last = name
        if name not in cast:
            cast[name] = ""
        _append(cast, name, desc, ", ")

    def cast_item(item: str) -> bool:
        m = CAST_PAREN_RE.match(item) or CAST_ENTRY_RE.match(item)
        name = m.group(1).strip().rstrip(".") if m else ""
        if not m or len(name.split()) > 4 or name.lower() in NOT_SPEAKERS | HEADER_ONLY or _is_label(name):
            return False
        who = _speaker(name, None)
        if who != "VO":  # the narrator isn't cast
            add_cast(who, ", ".join(x.strip() for x in m.groups()[1:] if x and x.strip()))
        return True

    def read_cast(line: str) -> bool:
        """A line of the CHARACTERS list (True), or the end of the list (False)."""
        nonlocal cast_gap, cast_last
        if _slug(line) or SCENE_RE.match(line) or SHOT_RE.match(line) or META_RE.match(line) or FIELD_RE.match(line):
            return False
        if cast_item(line):
            cast_gap = False
            return True
        m = _cue(line)  # a NAME line on its own, the description below it
        if (m and line.upper() == line and len(line.split()) <= 4 and not line.endswith((".", "!", "?", ","))
                and not _is_label(m.group(1)) and m.group(1).strip().lower() not in NOT_SPEAKERS | HEADER_ONLY):
            who = _speaker(m.group(1), m.group(2))
            if who != "VO":
                add_cast(who, "")
            cast_gap = False
            return True
        if cast_last and not cast_gap:  # the description goes on
            _append(cast, cast_last, line, " ")
            return True
        return False

    def note_intros(line: str) -> None:
        for m in INTRO_RE.finditer(line):
            name, desc = m.group(1).strip().rstrip("."), m.group(2).strip()
            if NOT_INTRO.match(desc) or name.upper() in VO_NAMES or name.upper() in ("INT", "EXT", "I/E"):
                continue
            if re.search(r"\d", desc) or "," in desc or len(desc.split()) >= 3:  # "(35, grey beard)", not "(smiling)"
                intros.setdefault(_speaker(name, None), desc)

    def is_marker(line: str) -> bool:
        if _slug(line) or FIELD_RE.match(line) or PAREN_RE.match(line) or META_RE.match(line):
            return True
        m = SCENE_RE.match(line) or SHOT_RE.match(line)
        if m and (m.group(1) or m.group(2) or not m.group(3)):
            return True
        m = SPEAK_RE.match(line)
        if m and len(m.group(1).split()) <= 4 and not _is_label(m.group(1)):
            return True
        m = _cue(line)
        return bool(m and line.upper() == line and len(line.split()) <= 4 and not line.endswith((".", "!", "?", ",")))

    for raw in text.splitlines():
        line = " ".join(raw.strip().strip("*_").split())  # one space between words (the patterns above rely on it)
        if not line:
            pending_cue, cue_line, pending_emotion = None, None, ""
            cast_gap = cast_mode
            continue
        if cast_mode:
            if read_cast(line):
                continue
            cast_mode = False  # the list ended: read this line as usual
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
        rest = _cast_head(line)
        if rest is not None:  # CHARACTERS / CAST: a list of who is who, one per line (or "Ravi (35, farmer), Meera (30)")
            cast_mode, cast_gap, cast_last = True, False, ""
            items = _split_top(rest) if "(" in rest or not re.search(r":|\s[-–—]\s", rest) else [rest]
            for x in items:
                if not cast_item(x) and x[:1].isupper() and len(x.split()) <= 4 and not _is_label(x):
                    if _speaker(x, None) != "VO":
                        add_cast(_speaker(x, None), "")  # just a name
            continue
        sl = _slug(line)
        if sl:
            scene, shot = None, None
            sc = ensure_scene()
            sc["location"], sc["time_of_day"] = sl[0].title(), sl[1].lower()
            sc["title"] = sc["location"] or sc["title"]
            markers["scene"] += 1
            continue
        m = SCENE_RE.match(line)
        if m and (m.group(1) or m.group(2) or not m.group(3)) and (m.group(1) or len(line) < 60):
            scene, shot = None, None
            sc = ensure_scene()
            rest = m.group(3).strip()
            if rest:
                sl = _slug(rest)
                if sl:
                    sc["location"], sc["time_of_day"] = sl[0].title(), sl[1].lower()
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
            if scene is None and key in ("duration", "length"):
                continue  # the film's running time on its cover page, not a shot's length
            if key.startswith(("visual", "prompt", "action", "description")):
                cur = ensure_shot()
                if cur["prompt"] and (cur["lines"] or not explicit()):
                    cur = ensure_shot(new=True)  # a new visual starts a new shot unless SHOT markers group them
                cur["prompt"] = (cur["prompt"] + " " + val).strip()
                note_intros(val)
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
        m = META_RE.match(line)
        if m:
            add_meta(m.group(1), m.group(2).strip())
            continue
        m = SPEAK_RE.match(line)
        if m and scene is None and m.group(1).strip().rstrip(".").lower() in NOT_SPEAKERS | HEADER_ONLY:
            if m.group(1).strip().lower() == "title":
                film["title"] = m.group(4).strip()
            continue  # the cover page: title, genre, logline … are not shots
        if m and len(m.group(1).split()) <= 4 and not _is_label(m.group(1)):
            who = _speaker(m.group(1), m.group(2))
            emotion = (m.group(3) or "").strip("() ")
            add_line(who, m.group(4), emotion)
            continue
        m = _cue(line)
        if (m and line.upper() == line and len(line.split()) <= 4 and not line.endswith((".", "!", "?", ","))
                and not _is_label(m.group(1))):
            pending_cue, cue_line, pending_emotion = (m.group(1), m.group(2)), None, ""
            continue
        # plain text: scene description before any shot, otherwise more visual detail for the current shot
        note_intros(line)
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
        # notes written before the first scene hold for every scene: its look comes first, its mood, sound and music
        # unless the scene has its own
        sc["look"] = "; ".join(x for x in (film["look"], sc["look"]) if x)
        for k in ("mood", "sound", "music"):
            sc[k] = sc[k] or film[k]
    scenes = [{k: v for k, v in s.items() if k != "_explicit"} for s in scenes if s["shots"]]
    trusted = markers["scene"] >= 1 and (markers["shot"] + markers["visual"] + markers["line"]) >= 1
    if not (trusted and scenes):
        return None
    speakers = list(dict.fromkeys(l["speaker"] for sc in scenes for sh in sc["shots"] for l in sh["lines"]
                                  if l["speaker"] != "VO"))
    return {"title": film["title"], "scenes": scenes, "cast": _cast_list(scenes, speakers, cast, intros)}


def _cast_list(scenes: list[dict], speakers: list[str], cast: dict[str, str], intros: dict[str, str]) -> list[dict]:
    """Who is who: the CHARACTERS list under the names the lines use ("Ravi Kumar – 35, farmer" describes the
    speaker "Ravi"), plus first-appearance descriptions of people who speak. Every cast name in a shot's visual puts
    that character in the shot, so a silent character keeps their look too."""
    out: dict[str, str] = {}
    for name, desc in cast.items():
        hits = [s for s in speakers if s.lower() == name.lower()] or [s for s in speakers if _same_person(s, name)]
        key = hits[0] if len(hits) == 1 else name
        out[key] = ", ".join(x for x in (out.get(key, ""), desc) if x)
    for name, desc in intros.items():  # only people who talk: "TV (old, flickering)" is set dressing
        hits = [s for s in speakers if s.lower() == name.lower()]
        if hits and not out.get(hits[0]):
            out[hits[0]] = desc
    known = list(dict.fromkeys([*speakers, *out]))
    for sc in scenes:
        for sh in sc["shots"]:
            for n in known:
                if n not in sh["characters"] and _mentions(sh["prompt"], n):
                    sh["characters"].append(n)
    return [{"name": n, "description": d} for n, d in out.items()]


# ── 3. AI arranging (wording kept) ───────────────────────────────────────────

ARRANGE_SYSTEM = (
    prompts.DP + "\n\nYou are importing a script the user already wrote. Your only job is to split it into scenes and shots "
    "and to tag who speaks each line. COPY every dialogue line and every visual description character-for-character "
    "from the script: never translate, paraphrase, shorten, fix grammar, or invent lines or visuals. Voice-over, "
    "narration and off-screen lines get speaker VO. Keep the script's own order. If the script gives a shot length, "
    "use it (4, 6 or 8 seconds); otherwise pick 8 for dialogue shots and 6 for silent ones. One on-screen speaker per "
    "shot: if two people talk, make a shot / reverse-shot pair. List every character visible in a shot, speaking or "
    "not. Keep the script's notes where they belong, copied the same way: a cast list or a character's description "
    "(age, looks, clothes; also one given at their first appearance) goes to cast; per scene its look (lighting, "
    "colour, weather, style), sound (ambience under the whole scene) and music; per shot its sound effects. A note "
    "written once for the whole film applies to every scene. Never invent these notes; only a scene's mood may be "
    "read from the scene when the script doesn't name it (a few words).")


def ai_arrange(db: Session, user: User, project: Project, text: str) -> dict:
    from .studio import _llm, lang_name

    prompt = (f"Script language: {lang_name(project.primary_language)} (keep the original language and script).\n"
              f"SCRIPT:\n<<<\n{text[:MAX_CHARS]}\n>>>")
    out = _llm(db, user, project, "import_script", ARRANGE_SYSTEM, prompt, S.ImportOut, {"text": text[:MAX_CHARS]},
               pro=len(text) > 20_000)
    return {"title": out.title, "cast": [{"name": c.name.strip(), "description": c.description.strip()} for c in out.cast
                                         if c.name.strip() and c.name.strip().upper() not in VO_NAMES],
            "scenes": [
        {"title": sc.title, "location": sc.location, "time_of_day": sc.time_of_day, "summary": sc.summary,
         "mood": sc.mood, "look": sc.look, "sound": sc.sound, "music": sc.music,
         "shots": [{"prompt": sh.prompt, "characters": sh.characters, "duration_s": sh.duration_s if sh.duration_s in (4, 6, 8) else 8,
                    "framing": sh.framing, "camera": sh.camera, "sfx": sh.sfx,
                    "lines": [{"speaker": "VO" if l.speaker.strip().upper() in VO_NAMES else l.speaker.strip(),
                               "text": l.text, "emotion": l.emotion} for l in sh.lines]}
                   for sh in sc.shots]}
        for sc in out.scenes]}


def description_for(described: dict[str, str], name: str) -> str:
    """The script's description of a character: under this exact name, else under a fuller or shorter form of it."""
    if described.get(name):
        return described[name]
    hits = [d for n, d in described.items() if d and _same_person(n, name)]
    return hits[0] if len(hits) == 1 else ""


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
    described = {c["name"]: c.get("description", "") for c in draft.get("cast") or []}
    shots = sum(len(sc["shots"]) for sc in draft["scenes"])
    return {"draft": draft, "method": used, "warnings": warnings,
            "characters": [{"name": k, "lines": v, "description": description_for(described, k)} for k, v in names.items()],
            "stats": {"scenes": len(draft["scenes"]), "shots": shots,
                      "lines": sum(len(sh["lines"]) for sc in draft["scenes"] for sh in sc["shots"])}}
