"""Pictures attached to Director chat messages.

A picture is uploaded first (POST /api/projects/{pid}/agent/attachments), then sent with a message together with a tag
the user gave it: an existing character / location / prop, a new name (to become cast), or a look / style reference.
The message keeps the list in its data["attachments"]; the AI sees the pictures in that turn (Claude as image blocks,
Gemini as a text note) and can look at one again later with look_at_attachment.
"""
from __future__ import annotations

import io
import re
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import AgentAttachment, Character, Location, Project, ProjectLocation, ProjectProp, Prop, User
from ..storage import get_storage
from . import reference_images, studio

MAX_PER_MESSAGE = 8
MAX_PIXELS = 50_000_000  # a decompression bomb is refused before it is decoded
MODEL_EDGE, MODEL_QUALITY = 1024, 82  # what the AI sees: enough to describe a face, small enough to keep in the thread
THUMB_EDGE = 320
CAST_KINDS = ("character", "location", "prop")
TAG_KINDS = (*CAST_KINDS, "style")
KIND_WORD = {"character": "character", "location": "location", "prop": "prop"}


# ── upload ───────────────────────────────────────────────────────────────────

def _jpeg(im: Any, edge: int, quality: int) -> bytes:
    im = im.convert("RGB")
    im.thumbnail((edge, edge))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def save_upload(db: Session, user: User, project: Project, data: bytes, content_type: str, filename: str) -> AgentAttachment:
    """Check and store an uploaded picture (PNG, JPG or WEBP up to 15 MB and 50 megapixels) with a small thumbnail."""
    from PIL import Image, ImageOps

    ext = reference_images.sniff(data)  # the bytes decide, not the name or the browser's content type
    ctype = (content_type or "").split(";")[0].strip().lower()
    if not ext or (ctype and not ctype.startswith("image/") and ctype != "application/octet-stream"):
        raise HTTPException(400, "Attach a PNG, JPG or WEBP image")
    if len(data) > reference_images.MAX_BYTES:
        raise HTTPException(400, "Image too large (max 15 MB)")
    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.width * im.height > MAX_PIXELS:
                raise HTTPException(400, "Image too large (max 50 megapixels)")
            im.verify()
        with Image.open(io.BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im)
            width, height = im.size
            thumb = _jpeg(im, THUMB_EDGE, 80)
    except HTTPException:
        raise
    except Exception:  # truncated or not really an image
        raise HTTPException(400, "That file isn't a readable image")
    st = get_storage()
    rel = st.save_bytes(st.new_path(f"agent/{project.id}", ext), data)
    thumb_rel = st.save_bytes(rel.rsplit(".", 1)[0] + "_t.jpg", thumb)
    name = re.sub(r"[\x00-\x1f]", "", (filename or "").strip())[:200] or f"image.{ext}"
    att = AgentAttachment(project_id=project.id, user_id=user.id, path=rel, thumb_path=thumb_rel,
                          mime="image/jpeg" if ext == "jpg" else f"image/{ext}", filename=name, width=width, height=height,
                          size_bytes=len(data), tag={})
    db.add(att)
    db.commit()
    return att


def out(att: AgentAttachment) -> dict:
    st = get_storage()
    return {"id": att.id, "url": st.url(att.path), "thumb_url": st.url(att.thumb_path or att.path), "name": att.filename,
            "width": att.width, "height": att.height}


# ── lookup ───────────────────────────────────────────────────────────────────

def parse_id(value: Any) -> int | None:
    """12, "12", "#12", "att-12", "attachment 12" → 12."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    m = re.search(r"\d+", str(value or ""))
    return int(m.group()) if m else None


def get(db: Session, project: Project, value: Any) -> AgentAttachment | None:
    i = parse_id(value)
    att = db.get(AgentAttachment, i) if i is not None else None
    return att if att is not None and att.project_id == project.id else None


# ── tags ─────────────────────────────────────────────────────────────────────

def _project_rows(db: Session, project: Project, kind: str) -> list[Any]:
    if kind == "character":
        return studio.cast(db, project)
    if kind == "location":
        return studio.locations(db, project)
    ids = {r.prop_id for r in db.query(ProjectProp).filter(ProjectProp.project_id == project.id).all()}
    return [p for p in db.query(Prop).filter(Prop.archived.is_(False)).order_by(Prop.id).all() if p.id in ids]


def _entity(db: Session, project: Project, kind: str, id_: int) -> Any | None:
    """The character / location / prop with this id when this project may use it (its own, or the shared library)."""
    model = {"character": Character, "location": Location, "prop": Prop}[kind]
    row = db.get(model, id_)
    if row is None or row.archived:
        return None
    if row in _project_rows(db, project, kind) or getattr(row, "shared", False):
        return row
    if kind == "location" and db.get(ProjectLocation, {"project_id": project.id, "location_id": row.id}):
        return row
    return None


def find_by_name(db: Session, project: Project, kind: str, name: str) -> Any | None:
    low = " ".join((name or "").lower().split())
    if not low:
        return None
    return next((r for r in _project_rows(db, project, kind) if " ".join(r.name.lower().split()) == low), None)


def normalize_tag(db: Session, project: Project, tag: Any) -> dict | None:
    """{kind, id?, name?} from the client → {kind, id, name, new} checked against the project (None = untagged).
    An id the project can't use is dropped (its name is kept as a new entry)."""
    if not isinstance(tag, dict):
        return None
    kind = str(tag.get("kind") or "").strip().lower()
    if kind not in TAG_KINDS:
        return None
    if kind == "style":
        return {"kind": "style"}
    name = " ".join(str(tag.get("name") or "").split())[:120]
    raw_id = parse_id(tag.get("id")) if tag.get("id") not in (None, "") else None
    row = _entity(db, project, kind, raw_id) if raw_id is not None else None
    if row is None and name:
        row = find_by_name(db, project, kind, name)
    if row is not None:
        return {"kind": kind, "id": row.id, "name": row.name, "new": False}
    return {"kind": kind, "name": name, "new": True} if name else None


def for_message(db: Session, project: Project, refs: list[dict]) -> list[dict]:
    """The attachments of a message being sent: each checked (this project's, at most 8), with its tag checked."""
    if len(refs) > MAX_PER_MESSAGE:
        raise HTTPException(400, f"Attach at most {MAX_PER_MESSAGE} images to one message")
    entries, seen = [], set()
    for ref in refs:
        att = get(db, project, ref.get("id"))
        if att is None:
            raise HTTPException(404, "Attachment not found (upload it again)")
        if att.id in seen:
            continue
        seen.add(att.id)
        entries.append({**out(att), "tag": normalize_tag(db, project, ref.get("tag"))})
    return entries


def link(db: Session, message_id: int, entries: list[dict]) -> None:
    """Record which message the attachments went with, and their tags (no commit)."""
    for e in entries:
        att = db.get(AgentAttachment, e["id"])
        if att is not None:
            att.message_id = message_id
            att.tag = e.get("tag") or {}


# ── what the AI is told ──────────────────────────────────────────────────────

def tag_text(db: Session, tag: dict | None) -> str:
    if not tag:
        return "not tagged (ask what it is if that matters)"
    kind = tag.get("kind")
    if kind == "style":
        return "a look / style reference (not a cast member): match its lighting, colour, framing and mood"
    word = KIND_WORD.get(kind, kind)
    if tag.get("new") or not tag.get("id"):
        return f"a NEW {word} named '{tag.get('name')}' (not in the project yet)"
    extra = ""
    if kind == "character":
        ch = db.get(Character, tag["id"])
        if ch is not None:
            from ..models import CharacterAsset
            n = db.query(CharacterAsset).filter(CharacterAsset.character_id == ch.id, CharacterAsset.archived.is_(False),
                                                CharacterAsset.approved.is_(True)).count()
            extra = f"; {n} approved reference image{'' if n == 1 else 's'} so far" + ("; locked" if ch.locked else "")
    return f"the existing {word} '{tag.get('name')}' (#{tag['id']}{extra})"


def label(db: Session, entry: dict, n: int | None = None, total: int | None = None) -> str:
    """One line about an attachment, shown to the AI right before the picture."""
    pos = f"image {n} of {total}, " if n and total else ""
    return (f"Attachment #{entry['id']} ({pos}'{entry.get('name')}', {entry.get('width')}×{entry.get('height')}): "
            f"{tag_text(db, entry.get('tag'))}.")


def placeholder(db: Session, entry: dict) -> str:
    """The picture as text, for turns that don't carry it: the AI can look again with look_at_attachment."""
    return f"{label(db, entry)} look_at_attachment({entry['id']}) shows it."


def model_jpeg(att: AgentAttachment, edge: int = MODEL_EDGE) -> bytes | None:
    """The picture as a JPEG small enough to send to the AI (None when the file can't be read)."""
    from PIL import Image, ImageOps

    st = get_storage()
    try:
        if not st.exists(att.path):
            return None
        with Image.open(st.abs(att.path)) as im:
            return _jpeg(ImageOps.exif_transpose(im), edge, MODEL_QUALITY)
    except Exception:
        return None


def read_original(att: AgentAttachment) -> bytes:
    st = get_storage()
    return st.abs(att.path).read_bytes()


def ext_of(att: AgentAttachment) -> str:
    return att.path.rsplit(".", 1)[-1].lower() if "." in att.path else "jpg"
