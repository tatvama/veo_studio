"""@mentions in scripts: `@[Ravi](character:12)`, `@[Temple courtyard](location:3)`, `@[Oil lamp](prop:5)`.

A mention is stored as a token with the entity id, so renaming a character updates every script and the shot
breakdown knows exactly who is in each scene. The editor shows the token as a chip; LLM prompts and the shot
list only ever see the plain name (`plain()`).
"""
from __future__ import annotations

import re
from typing import Any, Callable

from sqlalchemy.orm import Session

from ..models import Character, Location, Project, ProjectLocation, ProjectProp, Prop, User

KINDS = ("character", "location", "prop")
TOKEN_RE = re.compile(r"@\[([^\]\n]+)\]\((character|location|prop):(\d+)\)")
# a bare @Name typed or imported without the picker: one word, any script (Latin, Devanagari, Kannada ...)
BARE_RE = re.compile(r"(?<![\w@\]])@([^\s@\[\]().,;:!?\"']+)", re.U)
TEXT_FIELDS = ("action", "summary", "logline")  # script text fields that may hold mentions (plus every line)


def token(kind: str, id_: int, name: str) -> str:
    return f"@[{name}]({kind}:{int(id_)})"


def find(text: str) -> list[tuple[str, int, str]]:
    """Every mention in `text` as (kind, id, name), in order, duplicates kept."""
    return [(m.group(2), int(m.group(3)), m.group(1)) for m in TOKEN_RE.finditer(text or "")]


def plain(text: str) -> str:
    """Tokens replaced by the plain name: what prompts, voices and the shot list see."""
    return TOKEN_RE.sub(lambda m: m.group(1), text or "")


def ids(text: str, kind: str) -> list[int]:
    out: list[int] = []
    for k, i, _ in find(text):
        if k == kind and i not in out:
            out.append(i)
    return out


# ── whole scripts ────────────────────────────────────────────────────────────

def walk(script: dict | None, fn: Callable[[str], str]) -> dict:
    """Apply `fn` to every text field of a script (scene action/summary, every line, the logline)."""
    s = dict(script or {})
    for f in TEXT_FIELDS:
        if isinstance(s.get(f), str):
            s[f] = fn(s[f])
    scenes = []
    for sc in s.get("scenes") or []:
        sc = dict(sc)
        for f in TEXT_FIELDS:
            if isinstance(sc.get(f), str):
                sc[f] = fn(sc[f])
        lines = []
        for l in sc.get("lines") or []:
            l = dict(l)
            for f in ("line", "character"):
                if isinstance(l.get(f), str):
                    l[f] = fn(l[f])
            lines.append(l)
        sc["lines"] = lines
        scenes.append(sc)
    s["scenes"] = scenes
    return s


def plain_script(script: dict | None) -> dict:
    return walk(script, plain)


def entities(script: dict | None) -> dict[str, list[int]]:
    """Every entity mentioned anywhere in the script: {character: [ids], location: [...], prop: [...]}."""
    found: dict[str, list[int]] = {k: [] for k in KINDS}

    def collect(text: str) -> str:
        for k, i, _ in find(text):
            if i not in found[k]:
                found[k].append(i)
        return text

    walk(script, collect)
    return found


def scene_entities(scene: dict | None) -> dict[str, list[int]]:
    return entities({"scenes": [scene or {}]})


# ── resolving names ──────────────────────────────────────────────────────────

def _norm(s: str) -> str:
    return " ".join((s or "").strip().lower().split())


def _match_name(name: str, rows: list[Any]) -> Any | None:
    """Whole-word name match: Ravi matches Ravi Kumar, never Ravindra."""
    low = _norm(name)
    if not low:
        return None
    words = set(low.split())
    for exact in (True, False):
        for r in rows:
            rn = _norm(getattr(r, "name", ""))
            if not rn:
                continue
            hit = rn == low if exact else (rn.split()[0] == low.split()[0] or words <= set(rn.split()) or set(rn.split()) <= words)
            if hit:
                return r
    return None


def candidates(db: Session, project: Project | None, q: str = "", limit: int = 12) -> list[dict]:
    """Autocomplete list for the editor: the project's cast, locations and props first, then the shared library."""
    from . import studio
    q = _norm(q)
    out: list[dict] = []
    cast = studio.cast(db, project) if project else []
    cast_ids = {c.id for c in cast}
    chars = cast + [c for c in db.query(Character).filter(Character.shared.is_(True), Character.archived.is_(False)).all()
                    if c.id not in cast_ids]
    locs = []
    if project:
        pl = {r.location_id for r in db.query(ProjectLocation).filter(ProjectLocation.project_id == project.id).all()}
        locs = [l for l in db.query(Location).filter(Location.archived.is_(False)).all() if l.id in pl]
        locs += [l for l in db.query(Location).filter(Location.shared.is_(True), Location.archived.is_(False)).all()
                 if l.id not in pl]
    props = []
    if project:
        pp = {r.prop_id for r in db.query(ProjectProp).filter(ProjectProp.project_id == project.id).all()}
        props = [p for p in db.query(Prop).filter(Prop.archived.is_(False)).all() if p.id in pp]
        props += [p for p in db.query(Prop).filter(Prop.shared.is_(True), Prop.archived.is_(False)).all() if p.id not in pp]
    for kind, rows in (("character", chars), ("location", locs), ("prop", props)):
        for r in rows:
            if q and q not in _norm(r.name):
                continue
            out.append({"kind": kind, "id": r.id, "name": r.name, "token": token(kind, r.id, r.name),
                        "in_project": bool(project) and (r in cast if kind == "character" else True)})
    return out[:limit] if q else out[: limit * 3]


def resolve(db: Session, project: Project | None, text: str, create_missing: bool = False,
            user: User | None = None, created: list[dict] | None = None) -> str:
    """Turn bare `@Name` into tokens where a character, location or prop matches. With `create_missing`, an unknown
    name becomes a new character in the project cast (the common case while writing)."""
    from . import studio
    if "@" not in (text or ""):
        return text or ""
    cast = studio.cast(db, project) if project else []
    chars = cast + [c for c in db.query(Character).filter(Character.shared.is_(True), Character.archived.is_(False)).all()
                    if c not in cast]
    locs = db.query(Location).filter(Location.archived.is_(False)).all()
    props = db.query(Prop).filter(Prop.archived.is_(False)).all()

    def sub(m: re.Match) -> str:
        name = m.group(1)
        for kind, rows in (("character", chars), ("location", locs), ("prop", props)):
            r = _match_name(name, rows)
            if r:
                return token(kind, r.id, r.name)
        if create_missing and project is not None:
            ch = Character(name=name, shared=False, created_by=user.id if user else None)
            db.add(ch)
            db.flush()
            studio.link_character(db, project, ch)
            db.flush()
            chars.append(ch)
            if created is not None:
                created.append({"kind": "character", "id": ch.id, "name": ch.name})
            return token("character", ch.id, ch.name)
        return m.group(0)

    return BARE_RE.sub(sub, text)


def resolve_script(db: Session, project: Project, script: dict | None, create_missing: bool = False,
                   user: User | None = None) -> tuple[dict, list[dict]]:
    created: list[dict] = []
    out = walk(script, lambda t: resolve(db, project, t, create_missing, user, created))
    return out, created


def rename(script: dict | None, kind: str, id_: int, new_name: str) -> dict:
    """Update the display name inside every token of that entity (the id is what matters)."""
    pat = re.compile(r"@\[[^\]\n]+\]\(" + re.escape(kind) + ":" + str(int(id_)) + r"\)")
    return walk(script, lambda t: pat.sub(token(kind, id_, new_name), t))


def attach_entities(db: Session, project: Project, script: dict | None) -> dict[str, list[int]]:
    """Make sure every mentioned entity belongs to the project (cast, locations, props). Returns what was found."""
    from . import studio
    found = entities(script)
    db.flush()  # sessions here do not autoflush: see cast links made a moment ago
    cast_ids = {c.id for c in studio.cast(db, project)}
    for cid in found["character"]:
        ch = db.get(Character, cid)
        if ch and cid not in cast_ids:
            studio.link_character(db, project, ch)
            cast_ids.add(cid)
            db.flush()
    have_loc = {r.location_id for r in db.query(ProjectLocation).filter(ProjectLocation.project_id == project.id).all()}
    for lid in found["location"]:
        if lid not in have_loc and db.get(Location, lid):
            db.add(ProjectLocation(project_id=project.id, location_id=lid))
    have_prop = {r.prop_id for r in db.query(ProjectProp).filter(ProjectProp.project_id == project.id).all()}
    for pid in found["prop"]:
        if pid not in have_prop and db.get(Prop, pid):
            db.add(ProjectProp(project_id=project.id, prop_id=pid))
    db.flush()
    return found
