"""Import a prepared script (Word, PDF, text) into scenes and shots.

1. `extract_text` reads the file. A .docx is a zip of XML, so it is read directly (no compiled dependency).
2. `parse_marked` reads scripts written in a recognisable layout: scene headings (SCENE 1, INT./EXT.), shots
   (SHOT 2), visual prompts (VISUAL: / PROMPT:), dialogue (NAME: line, or a NAME line above the words), voice-over
   (VO: / NARRATOR: / NAME (V.O.):) and optional DURATION / CAMERA / FRAMING lines. A line marked (O.S.) / (O.C.) is
   the speaker heard from off-screen ("off_screen": voiced, never lip-synced); (CONT'D) is the same speaker going on.
   Notes are kept where they belong, so they carry through every shot: MOOD / LIGHTING / LOOK / WEATHER / AMBIENCE /
   MUSIC for the scene (written before the first scene: for every scene), SFX / SOUND for the shot, WARDROBE /
   COSTUME / OUTFIT lines for who wears what in the scene, and a CHARACTERS (CAST) list or a description at a
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
from typing import Any, Callable
from xml.etree import ElementTree

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..agents import prompts
from ..agents import schemas as S
from ..models import Project, User
from ..pipeline.captions import words_per_second

MAX_CHARS = 60_000
CONTINUES = "The moment continues: "  # a shot made for a line that is only heard, on the picture of the shot before
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
SPEAK_RE = re.compile(r"^([A-Zऀ-෿][\wऀ-෿ .'’-]{0,38}?) ?(\((?i:v\.?o\.?|o\.?[sc]\.?|cont['’]?d|voice[ -]?over|off[ -]?screen)\))? ?(\([^)]{1,60}\))? ?[:：] ?(.+)$", re.U)
# a NAME line on its own (screenplay cue), words separated by single spaces; its length is checked by _cue
CUE_RE = re.compile(r"^([A-Z][A-Z0-9.'’-]*(?: [A-Z0-9.'’-]+)*)(?: ?(\((?:V\.?O\.?|O\.?[SC]\.?|CONT['’]?D)\)))?$")
# what a speaker's tag says: the narrator (V.O.), someone heard but not seen (O.S. / O.C.), or the same speaker going on
VO_TAG = re.compile(r"^(?:v\.? ?o\.?|voice[ -]?over|narrat(?:or|ion))$", re.I)
OFF_TAG = re.compile(r"^(?:o\.? ?[sc]\.?|off[ -]?(?:screen|camera))$", re.I)
CONT_TAG = re.compile(r"^(?:cont['’]?d\.?|cont\.|continued|continuing)$", re.I)
# who wears what: "WARDROBE: Ravi – white kurta; Meera – red saree" (or COSTUME: / OUTFIT:, the entries maybe below)
WARDROBE_RE = re.compile(r"^(?:#+ ?)?(?:wardrobe|costumes?|outfits?)(?: ?:| [-–—])(.*)", re.I)
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


# a length in seconds ("6s", "8 sec"); a few digits at most and never from inside a longer number, so a long run of
# digits can't make the search slow
DUR_RE = re.compile(r"(?<![\d.])(\d{1,3}(?:\.\d{1,2})?) ?(?:s|sec|secs|seconds)\b", re.I)


def _dur(text: str) -> int:
    m = DUR_RE.search(text or "")
    if not m:
        return 8
    v = float(m.group(1))
    return 4 if v <= 4.5 else 6 if v <= 6.5 else 8


def _new_shot() -> dict[str, Any]:
    return {"prompt": "", "characters": [], "lines": [], "duration_s": 8, "framing": "", "camera": "", "sfx": ""}


def _tag(tag: str | None) -> str:
    """A speaker's tag: "vo" (V.O., voice-over), "off" (O.S., O.C., off-screen: heard, not seen), "cont" (CONT'D: the
    same speaker going on) or "" (none, or a delivery note such as "(whispering)")."""
    t = (tag or "").strip().strip("()").strip()
    if not t:
        return ""
    return "vo" if VO_TAG.match(t) else "off" if OFF_TAG.match(t) else "cont" if CONT_TAG.match(t) else ""


def _speaker(name: str, tag: str | None) -> str:
    """VO for the narrator (a narrator's name, or a V.O. tag); anyone else keeps their name, also when they speak from
    off-screen or carry on after (CONT'D)."""
    n = name.strip().rstrip(".").strip()
    if n.upper() in VO_NAMES or _tag(tag) == "vo":
        return "VO"
    return n.title() if n.isupper() else n  # screenplay CAPS → the name as the cast spells it


def _heard(line: dict) -> bool:
    """A line that is heard but nobody is seen saying: the narrator, or a speaker off-screen."""
    return line.get("speaker") == "VO" or bool(line.get("off_screen"))


def _wardrobe_items(text: str) -> list[tuple[str, str]]:
    """'Ravi – white kurta, brown shawl; Meera (red saree)' → [('Ravi', 'white kurta, brown shawl'), ('Meera', 'red
    saree')]: a new entry starts wherever a name with its outfit does; anything else goes on with the outfit before."""
    out: list[list[str]] = []
    for part in _split_top(text):
        m = CAST_ENTRY_RE.match(part)
        outfit = m.group(3) if m else ""
        if not m:
            m = CAST_PAREN_RE.match(part)
            outfit = m.group(2) if m else ""
        name = m.group(1).strip().rstrip(".") if m else ""
        if (m and len(name.split()) <= 4 and not _is_label(name) and name.lower() not in NOT_SPEAKERS | HEADER_ONLY
                and not _tag(outfit)):  # "RAVI (O.S.)" is a speaker's cue, not an outfit
            out.append([_speaker(name, None), outfit.strip()])
        elif out:
            out[-1][1] = ", ".join(x for x in (out[-1][1], part.strip()) if x)
    return [(n, o.rstrip(".").strip()) for n, o in out if n != "VO" and o.strip()]


def known_name(name: str, known: list[str]) -> str:
    """The name the lines use for a character a note names ("Ravi Kumar" in a WARDROBE line is the speaker "Ravi")."""
    hits = [k for k in known if k.lower() == name.lower()] or [k for k in known if _same_person(k, name)]
    return hits[0] if len(hits) == 1 else name


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
    film_wardrobe: dict[str, str] = {}  # who wears what in every scene (a WARDROBE line before scene 1)
    cast: dict[str, str] = {}  # name → description, from a CHARACTERS list
    intros: dict[str, str] = {}  # name → description, from "RAVI (35, grey beard)" in the action
    cast_mode, cast_gap, cast_last = False, False, ""
    wardrobe_mode = False  # a bare "WARDROBE:" line: its entries follow, one per line

    def ensure_scene() -> dict:
        nonlocal scene
        if scene is None:
            # "_explicit": this scene groups its shots with SHOT markers, so lines and visuals stay where they're written
            scene = {"title": f"Scene {len(scenes) + 1}", "location": "", "time_of_day": "", "summary": "", "mood": "",
                     "look": "", "sound": "", "music": "", "wardrobe": {}, "shots": [], "_explicit": False}
            scenes.append(scene)
        return scene

    def add_wardrobe(text: str) -> bool:
        """Who wears what, for this scene (before the first scene: for every scene). False when it names nobody."""
        items = _wardrobe_items(text)
        for name, outfit in items:
            (film_wardrobe if scene is None else scene["wardrobe"])[name] = outfit[:300]
        return bool(items)

    def explicit() -> bool:
        return bool(scene and scene["_explicit"])

    def ensure_shot(new: bool = False) -> dict:
        nonlocal shot
        sc = ensure_scene()
        if shot is None or new:
            shot = _new_shot()
            sc["shots"].append(shot)
        return shot

    def add_line(who: str, words: str, emotion: str = "", off: bool = False) -> dict:
        nonlocal shot
        cur = ensure_shot()
        heard = who == "VO" or off  # heard, nobody seen saying it: the narrator, or someone off-screen
        seen = {l["speaker"] for l in cur["lines"] if not _heard(l)}
        # unless the shot was written explicitly with SHOT markers: a second on-screen speaker gets their own shot (one
        # speaker per shot lip-syncs best), and a line that is only heard never shares a shot with on-screen dialogue
        # (its voice would play over a talking face): it gets its own shot of the same picture, the moment carrying on
        if cur["lines"] and not explicit() and ((heard and seen) or (not heard and who not in seen)):
            prev = cur
            cur = ensure_shot(new=True)
            cur["prompt"] = prev["prompt"]
            if heard or not seen:  # the same picture goes on ("The moment continues: …", added at the end)
                cur["characters"], cur["_cont"] = list(prev["characters"]), True
        entry = {"speaker": who, "text": words.strip(), "emotion": emotion}
        if off and who != "VO":
            entry["off_screen"] = True
        cur["lines"].append(entry)
        if not heard and who not in cur["characters"]:
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

    def starts_new(line: str) -> bool:
        """A heading, a shot, a field or a note: a list above it (cast, wardrobe) has ended."""
        return bool(_slug(line) or SCENE_RE.match(line) or SHOT_RE.match(line) or META_RE.match(line)
                    or FIELD_RE.match(line) or WARDROBE_RE.match(line))

    def read_cast(line: str) -> bool:
        """A line of the CHARACTERS list (True), or the end of the list (False)."""
        nonlocal cast_gap, cast_last
        if starts_new(line):
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
        if _slug(line) or FIELD_RE.match(line) or PAREN_RE.match(line) or META_RE.match(line) or WARDROBE_RE.match(line):
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
            cast_gap, wardrobe_mode = cast_mode, False
            continue
        if cast_mode:
            if read_cast(line):
                continue
            cast_mode = False  # the list ended: read this line as usual
        if wardrobe_mode:  # until a blank line, a new heading or note, or a line that isn't "Name – outfit" (a NAME cue)
            if not starts_new(line) and not (_cue(line) and line.upper() == line) and add_wardrobe(line):
                continue
            wardrobe_mode = False
        if pending_cue and cue_line is not None and is_marker(line):
            pending_cue, cue_line, pending_emotion = None, None, ""  # the speech ended without a blank line
        if pending_cue:  # words under a NAME cue, until a blank line
            m = PAREN_RE.match(line)
            if m and cue_line is None:
                if _tag(m.group(1)) in ("off", "vo"):  # "(O.S.)" on its own line under the name
                    pending_cue = (pending_cue[0], m.group(0).strip())
                else:
                    pending_emotion = m.group(1)
                continue
            if cue_line is None:
                cue_line = add_line(_speaker(*pending_cue), line, pending_emotion, off=_tag(pending_cue[1]) == "off")
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
                cur["duration_s"], cur["_timed"] = _dur(rest), True  # the script's own length: kept as written
                rest = re.sub(r"[(\[]? ?" + DUR_RE.pattern + r" ?[)\]]?", "", rest, flags=re.I).strip(" -–—:")
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
                cur = ensure_shot()
                cur["duration_s"], cur["_timed"] = (_dur(val) if DUR_RE.search(val) else _dur(val + "s")), True
            elif key in ("location", "setting"):
                ensure_scene()["location"] = val
            elif key.startswith("time"):
                if DUR_RE.fullmatch(val.strip()):  # "Time: 10s" is a length, not a time of day
                    cur = ensure_shot()
                    cur["duration_s"], cur["_timed"] = _dur(val), True
                else:
                    ensure_scene()["time_of_day"] = val
            continue
        m = META_RE.match(line)
        if m:
            add_meta(m.group(1), m.group(2).strip())
            continue
        m = WARDROBE_RE.match(line)
        if m:
            rest = m.group(1).strip()
            if not rest:
                wardrobe_mode = True  # the entries follow, one per line
            elif not add_wardrobe(rest):
                add_meta("look", f"wardrobe: {rest}")  # names nobody ("everyone soaked"): a note on the look
            continue
        m = SPEAK_RE.match(line)
        if m and scene is None and m.group(1).strip().rstrip(".").lower() in NOT_SPEAKERS | HEADER_ONLY:
            if m.group(1).strip().lower() == "title":
                film["title"] = m.group(4).strip()
            continue  # the cover page: title, genre, logline … are not shots
        if m and len(m.group(1).split()) <= 4 and not _is_label(m.group(1)):
            tag, emotion = m.group(2), (m.group(3) or "")
            if not tag and _tag(emotion):  # "RAVI (O.S.): …" written in capitals: the tag, not a delivery note
                tag, emotion = emotion, ""
            add_line(_speaker(m.group(1), tag), m.group(4), emotion.strip("() "), off=_tag(tag) == "off")
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
            if sh.pop("_cont", False) and sh["prompt"] and not sh["prompt"].startswith(CONTINUES):
                sh["prompt"] = CONTINUES + sh["prompt"]
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
    cast_out = _cast_list(scenes, speakers, cast, intros)
    known = list(dict.fromkeys([*speakers, *(c["name"] for c in cast_out)]))
    for sc in scenes:  # a WARDROBE line before scene 1 dresses every scene, the scene's own line wins
        sc["wardrobe"] = {known_name(n, known): o for n, o in {**film_wardrobe, **sc["wardrobe"]}.items()}
    return {"title": film["title"], "scenes": scenes, "cast": cast_out}


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
    "from the script: never translate, paraphrase, shorten, fix grammar, or invent lines or visuals. Voice-over and "
    "narration get speaker VO. A character heard but not seen (O.S., O.C., off-screen) keeps their own name with "
    "off_screen true; (CONT'D) is the same speaker going on. Keep the script's own order. If the script gives a shot "
    "length, use it (4, 6 or 8 seconds); otherwise pick 8 for dialogue shots and 6 for silent ones. One on-screen "
    "speaker per shot: if two people talk, make a shot / reverse-shot pair; a voice-over or off-screen line gets its "
    "own shot, never one where someone is seen talking. List every character visible in a shot, speaking or not. Keep "
    "the script's notes where they belong, copied the same way: a cast list or a character's description (age, "
    "looks, clothes; also one given at their first appearance) goes to cast; per scene its look (lighting, colour, "
    "weather, style), sound (ambience under the whole scene), music and wardrobe (WARDROBE / COSTUME / OUTFIT lines: "
    "who wears what); per shot its sound effects. A note written once for the whole film applies to every scene. "
    "Never invent these notes; only a scene's mood may be read from the scene when the script doesn't name it (a few "
    "words).")


def ai_arrange(db: Session, user: User, project: Project, text: str) -> dict:
    from .studio import _llm, lang_name

    prompt = (f"Script language: {lang_name(project.primary_language)} (keep the original language and script).\n"
              f"SCRIPT:\n<<<\n{text[:MAX_CHARS]}\n>>>")
    out = _llm(db, user, project, "import_script", ARRANGE_SYSTEM, prompt, S.ImportOut, {"text": text[:MAX_CHARS]},
               pro=len(text) > 20_000)

    def line(l: S.ImportLine) -> dict:
        who = "VO" if l.speaker.strip().upper() in VO_NAMES else l.speaker.strip()
        return {"speaker": who, "text": l.text, "emotion": l.emotion, **({"off_screen": True} if l.off_screen and who != "VO" else {})}

    return {"title": out.title, "cast": [{"name": c.name.strip(), "description": c.description.strip(),
                                          "gender": c.gender.strip().lower()} for c in out.cast
                                         if c.name.strip() and c.name.strip().upper() not in VO_NAMES],
            "scenes": [
        {"title": sc.title, "location": sc.location, "time_of_day": sc.time_of_day, "summary": sc.summary,
         "mood": sc.mood, "look": sc.look, "sound": sc.sound, "music": sc.music,
         "wardrobe": dict(_wardrobe_items("; ".join(sc.wardrobe))),
         "shots": [{"prompt": sh.prompt, "characters": sh.characters, "duration_s": sh.duration_s if sh.duration_s in (4, 6, 8) else 8,
                    "framing": sh.framing, "camera": sh.camera, "sfx": sh.sfx, "lines": [line(l) for l in sh.lines]}
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


# ── who sounds like whom, and how long the words take ───────────────────────

# words that say who someone is: a noun says it outright, a pronoun only hints (weights 2 and 1); Indian kinship
# words and names of address too ("Ajji", "Amma", "Appa")
_FEMALE = {**dict.fromkeys(("woman", "women", "girl", "lady", "wife", "mother", "mom", "mum", "grandmother", "granny",
                            "grandma", "daughter", "sister", "aunt", "aunty", "auntie", "niece", "queen", "princess",
                            "bride", "actress", "heroine", "mrs", "ms", "miss", "madam", "female", "widow", "girlfriend",
                            "saree", "sari", "pregnant", "amma", "ajji", "dadi", "nani", "maa", "didi", "bhabhi", "beti",
                            "akka", "paati", "ammamma", "mausi", "chachi", "bua", "ammi", "maasi", "atte", "chikkamma"), 2),
           **dict.fromkeys(("she", "her", "hers", "herself"), 1)}
_MALE = {**dict.fromkeys(("man", "men", "boy", "guy", "husband", "father", "dad", "grandfather", "grandpa", "son",
                          "brother", "uncle", "nephew", "king", "prince", "groom", "actor", "hero", "mr", "sir", "male",
                          "widower", "boyfriend", "beard", "bearded", "moustache", "mustache", "appa", "ajja", "dada",
                          "bhaiya", "bhai", "beta", "thatha", "chacha", "abba", "chikkappa",
                          "dodappa", "babuji"), 2),
         **dict.fromkeys(("he", "him", "his", "himself"), 1)}


def guess_gender(name: str, description: str = "") -> str:
    """'female' / 'male' from how the script describes someone ("30, his wife, green saree" → female: the first word
    that names who they are decides; pronouns only when no such word), else from a kinship name ("Ajji"); '' when the
    script doesn't say. Without it every new character would get a male default voice."""
    for w in re.findall(r"[a-zऀ-෿]+", (description or "").lower()):
        if _FEMALE.get(w) == 2 and _MALE.get(w) != 2:
            return "female"
        if _MALE.get(w) == 2:
            return "male"
    words = re.findall(r"[a-z]+", (description or "").lower())
    f = sum(_FEMALE.get(w, 0) for w in words if _FEMALE.get(w) == 1)
    m = sum(_MALE.get(w, 0) for w in words if _MALE.get(w) == 1)
    if f != m:
        return "female" if f > m else "male"
    first = (name or "").strip().lower().split()[:1]
    if first and _FEMALE.get(first[0]) == 2:
        return "female"
    if first and _MALE.get(first[0]) == 2:
        return "male"
    return ""


_AGE_FIRST = re.compile(r"^((?:early |mid |mid-|late )?\d0s|\d{1,2})\b", re.I)  # "35, farmer", "70s, silver bun"
_AGE_SAID = re.compile(r"\b(\d{1,2})[ -]?(?:years?|yrs?)[ -]?old\b|\bage[ds]? (\d{1,2})\b|\b((?:early |mid |mid-|late )?\d0s)\b",
                       re.I)  # "a 35-year-old farmer", "aged 60", "in her late 40s"


def guess_age(description: str) -> str:
    """'35', '70s' or 'late 40s' when the description starts with an age or says one; a number elsewhere ("ten cows",
    "2 children") is not an age."""
    text = (description or "").strip()
    m = _AGE_FIRST.match(text) or _AGE_SAID.search(text)
    age = next((g for g in m.groups() if g), "") if m else ""
    return age if not age.isdigit() or 3 <= int(age) <= 99 else ""


EXTEND_STEPS = (15, 22, 29)  # the shot list's "Extend to" lengths (core/board.py: 8 s plus ~7 s per extension)


def fit_lengths(draft: dict, lang: str = "en") -> list[str]:
    """Give every shot enough time for its words, at the pace of the project's language (pipeline/captions.py). A shot
    the script didn't time gets at least the 4/6/8 s its lines need; words that are only heard (voice-over, someone
    off-screen) longer than one 8 s clip get extensions ("Extend to"), so the picture keeps moving under them instead of
    freezing on its last frame. A line said on screen can't be extended (it is lip-synced to one clip): when it can't
    fit 8 s, the warning names the shot. Returns warnings for the review screen."""
    wps = words_per_second(lang)
    longer, too_long, crowded = 0, [], []
    for sc in draft["scenes"]:
        for i, sh in enumerate(sc["shots"], 1):
            timed = sh.pop("_timed", False)
            heard = sum(len(l["text"].split()) for l in sh["lines"] if _heard(l))
            said = sum(len(l["text"].split()) for l in sh["lines"] if not _heard(l))
            need = (heard + said) / wps + 0.8 if (heard or said) else 0  # (both: the narration follows the dialogue)
            if need and not timed and sh.get("duration_s", 8) < need:
                sh["duration_s"] = next((d for d in (4, 6, 8) if d >= need), 8)
            if heard and not said and need > max(sh.get("duration_s", 8), sh.get("extend_to") or 0) + 0.3:
                sh["extend_to"] = next((x for x in EXTEND_STEPS if x >= need), EXTEND_STEPS[-1])
                longer += 1
                if need > EXTEND_STEPS[-1]:
                    too_long.append(f"{sc['title'] or 'a scene'} ({int(need)}s)")
            if said and said / wps + 0.8 > 8.05:
                crowded.append(f"{sc['title'] or 'a scene'}, shot {i} (about {round(said / wps + 0.8)}s)")
    out = []
    if longer:
        out.append(f"{longer} voice-over line(s) run longer than one 8-second clip: those shots get extensions "
                   "(\"Extend to\"), so the picture keeps moving until the words end.")
    if too_long:
        out.append("Very long voice-over (over 29 s) in " + ", ".join(too_long[:5]) + ": split it over more shots.")
    if crowded:
        out.append("Dialogue too long for one 8-second clip in " + "; ".join(crowded[:5])
                   + (f" and {len(crowded) - 5} more" if len(crowded) > 5 else "") + ": split it or shorten it.")
    return out


def starting_look(name: str, age: str = "", gender: str = "") -> str:
    """A first look for a character the script doesn't describe, from what is known of them: "Ravi: a 35-year-old
    man", "Ajji: a woman in her 70s". Without one every keyframe makes up a new face. '' when neither the age nor the
    gender is known."""
    age, gender = (age or "").strip(), (gender or "").strip().lower()
    if not age and gender not in ("female", "male"):
        return ""
    young = age.isdigit() and int(age) < 13
    teen = age.isdigit() and 13 <= int(age) < 18
    noun = {"female": "girl" if young else "teenage girl" if teen else "woman",
            "male": "boy" if young else "teenage boy" if teen else "man"}.get(gender, "child" if young else "person")
    if age.isdigit():
        return f"{name}: {'an' if age.startswith('8') or age in ('11', '18') else 'a'} {age}-year-old {noun}"
    if age:
        return f"{name}: a {noun} in {({'female': 'her', 'male': 'his'}).get(gender, 'their')} {age}"
    return f"{name}: a {noun}"


def undescribed_warning(names: list[str]) -> str:
    who = ", ".join(names[:8]) + (f" and {len(names) - 8} more" if len(names) > 8 else "")
    return (f"The script doesn't describe {who}: add a photo or a line about them, or every keyframe makes up their face "
            "(they start from their name, age and gender).")


def build_draft(db: Session, user: User, project: Project, text: str, method: str = "auto",
                has_look: Callable[[str], bool] | None = None) -> dict:
    """method: auto (markers if the layout is recognisable, else AI) | markers | ai. has_look(name): the character
    this name will be already has a look (a photo or a description), so the script needn't describe them."""
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
    warnings += fit_lengths(draft, project.primary_language)
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
    # who each person is: the script's description, and the gender and age it gives (for the voice and the look)
    cast = {c["name"]: c for c in draft.get("cast") or []}
    for n in names:
        if n not in cast:
            cast[n] = {"name": n, "description": description_for({k: v.get("description", "") for k, v in cast.items()}, n)}
    for c in cast.values():
        c["gender"] = c.get("gender") if c.get("gender") in ("female", "male") else guess_gender(c["name"], c.get("description", ""))
        c["age"] = c.get("age") or guess_age(c.get("description", ""))
    draft["cast"] = list(cast.values())
    bare = [n for n in names if not (cast[n].get("description") or "").strip() and not (has_look and has_look(n))]
    if bare:
        warnings.append(undescribed_warning(bare))
    shots = sum(len(sc["shots"]) for sc in draft["scenes"])
    return {"draft": draft, "method": used, "warnings": warnings,
            "characters": [{"name": k, "lines": v, "description": cast[k].get("description", ""), "gender": cast[k]["gender"],
                            "age": cast[k]["age"]} for k, v in names.items()],
            "stats": {"scenes": len(draft["scenes"]), "shots": shots,
                      "lines": sum(len(sh["lines"]) for sc in draft["scenes"] for sh in sc["shots"])}}
