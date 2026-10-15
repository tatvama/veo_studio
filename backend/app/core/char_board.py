"""Character boards: an uploaded image with many views of one character, split into separate, labelled views.

1. Upload: the board is kept as the character's `source` asset (origin "board", not approved), so it counts as the
   user's own picture everywhere a photo does (the "made from a photo of a real person" safeguards), but is never used
   whole as a look reference. Its panels are found right away when the layout is clean (pipeline/board_split.py).
2. A small paid job labels the panels with a vision model, and finds them first when the layout wasn't clean
   (workers/handlers_board.py). The board's state lives in asset.meta["board"].
3. The user reviews the crops (label, discard, adjust the box) and saves them: each becomes a character asset of the
   chosen kind with origin "board:<board asset id>". Those crops are the uploader's own images, never AI-generated
   sheet views: they are not sent to BytePlus (handlers_hub.register_images).
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Character, CharacterAsset, Costume
from ..pipeline import board_split
from ..storage import get_storage

ORIGIN = "board"


def crop_origin(board_id: int) -> str:
    return f"{ORIGIN}:{board_id}"


def is_board(a: CharacterAsset | None) -> bool:
    return bool(a) and a.kind == "source" and a.origin == ORIGIN


def board_state(a: CharacterAsset) -> dict[str, Any]:
    return dict((a.meta or {}).get("board") or {})


def set_board_state(db: Session, a: CharacterAsset, **values: Any) -> dict[str, Any]:
    meta = dict(a.meta or {})
    board = {**(meta.get("board") or {}), **values}
    meta["board"] = board
    a.meta = meta
    db.commit()
    return board


def add_board(db: Session, ch: Character, data: bytes, ext: str, label: str = "") -> CharacterAsset:
    """Save the uploaded board as a source asset and find its panels when the layout is clean."""
    try:
        found = board_split.detect_panels(data)
    except Exception as e:  # not an image Pillow can read
        raise HTTPException(400, "Couldn't read that image. Upload a PNG, JPG or WEBP board.") from e
    st = get_storage()
    rel = st.save_bytes(st.new_path(f"characters/{ch.id}", ext), data)
    panels = [{**p, "id": i + 1, "kind": "other", "name": "", "description": "", "keep": True}
              for i, p in enumerate(found["panels"])]
    a = CharacterAsset(character_id=ch.id, kind="source", label=(label.strip() or "character board")[:80], path=rel,
                       approved=False, origin=ORIGIN,
                       meta={"board": {"status": "detected", "width": found["width"], "height": found["height"],
                                       "clean": found["clean"], "method": found["method"], "background": found["background"],
                                       "panels": panels}})
    db.add(a)
    db.commit()
    return a


def label_panels(panels: list[dict[str, Any]], labels: list[Any]) -> list[dict[str, Any]]:
    """Put a vision model's labels on the panels (by their 1-based number; the rest stay "other")."""
    def get(lab: Any, key: str) -> Any:
        return (lab.get(key) if isinstance(lab, dict) else getattr(lab, key, None)) or ""

    by_index: dict[int, Any] = {}
    for lab in labels:
        try:
            by_index[int(get(lab, "index") or 0)] = lab
        except (TypeError, ValueError):
            continue
    out = []
    for i, p in enumerate(panels):
        lab = by_index.get(i + 1)
        kind, name = board_split.normalize_label(str(get(lab, "kind")), str(get(lab, "name"))) if lab is not None else ("other", "")
        out.append({**p, "id": i + 1, "kind": kind, "name": name,
                    "description": str(get(lab, "description"))[:160] if lab is not None else "", "keep": kind != "other"})
    return out


def save_views(db: Session, board: CharacterAsset, panels: list[dict[str, Any]]) -> list[CharacterAsset]:
    """Cut the reviewed panels out of the board and save each as a character asset of its kind (approved: the user
    just checked them). Outfit panels get their costume, so they show up under Outfits too."""
    if not is_board(board):
        raise HTTPException(400, "That image isn't a character board")
    st = get_storage()
    if not st.exists(board.path):
        raise HTTPException(404, "The board image is gone")
    img = board_split.load(st.abs(board.path).read_bytes())
    W, H = img.size
    ch = db.get(Character, board.character_id)
    made: list[CharacterAsset] = []
    costumes: set[str] = set()
    for i, p in enumerate(panels[: board_split.MAX_PANELS]):
        if not p.get("keep", True):
            continue
        box = board_split.clamp(p, W, H)
        if box is None:
            raise HTTPException(400, f"Panel {i + 1}: the box is outside the board or too small (16 px at least)")
        kind, name = board_split.normalize_label(str(p.get("kind") or ""), str(p.get("name") or ""))
        if kind == "other":
            kind = "board_panel"  # kept for the record, never used as a look reference
        view = kind if kind in board_split.VIEWS else ""
        outfit = ""
        if kind == "outfit":
            outfit = name or "board outfit"
            view = str(p.get("view") or "") if p.get("view") in board_split.VIEWS else "full_body"
            costumes.add(outfit)
        label = {"expression": name or "expression", "outfit": f"outfit: {outfit} ({view.replace('_', ' ')})",
                 "board_panel": name or "from the board"}.get(kind, kind.replace("_", " "))
        rel = st.save_bytes(st.new_path(f"characters/{ch.id}", "jpg"), board_split.to_bytes(board_split.crop(img, box)))
        a = CharacterAsset(character_id=ch.id, kind=kind, label=label[:120], outfit=outfit, view=view, path=rel,
                           prompt=str(p.get("description") or "")[:500], approved=True, version=ch.version,
                           origin=crop_origin(board.id), meta={"box": box, "board_asset_id": board.id})
        db.add(a)
        made.append(a)
    if not made:
        raise HTTPException(400, "Keep at least one panel")
    for name in costumes:
        if not db.query(Costume).filter(Costume.character_id == ch.id, Costume.name == name, Costume.archived.is_(False)).first():
            db.add(Costume(character_id=ch.id, name=name, description="From the character board"))
    db.flush()
    saved = [a.id for a in made]
    set_board_state(db, board, status="saved", saved_asset_ids=[*board_state(board).get("saved_asset_ids", []), *saved],
                    panels=[{**p, "id": i + 1} for i, p in enumerate(panels)])
    return made
