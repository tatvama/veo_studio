"""Learning from what the user approves: faces from the keyframes they pick become "approved still" references.

When a keyframe take is picked ("Use this") or its shot is approved, every character in it gets a CharacterAsset of
kind approved_still: the whole frame for a one-character shot, or for several characters a crop of each face matched
with the face models (only when they are installed; without them a group shot teaches nothing rather than the wrong
face). character_refs() reaches for these right after the approved sheet views, so later keyframes converge on the
look the user liked. The newest MAX_STILLS per character stay in use; older ones are archived, never deleted.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from .. import settings_store
from ..models import Character, CharacterAsset, Shot, Take
from ..storage import get_storage
from . import faces
from .prompting import STILL_KIND, character_refs, outfit_for
from .selection import is_real

MAX_STILLS = 6
SUGGEST_TRAIN_SHOTS = 6  # a character in this many shots without a trained identity: suggest training one


def char_embedding(db: Session, ch: Character) -> list[float] | None:
    """The character's face embedding (cached on the row), from its photo or sheet; None without the face models."""
    if ch.face_embedding:
        return ch.face_embedding
    if not faces.identity_available():
        return None
    st = get_storage()
    for a in character_refs(db, ch, None, 3):
        if a.kind in ("front", "source", "three_quarter") and st.exists(a.path):
            emb = faces.embedding(st.abs(a.path))
            if emb:
                ch.face_embedding = emb
                return emb
    return None


def _face_crops(db: Session, path, chars: list[Character]) -> dict[int, bytes]:
    """{character id: PNG of their face} for the faces in the frame that clearly match a character."""
    cv2 = faces._cv()
    img = faces._read(path)
    found = faces.detect(img)[:8]
    if not found:
        return {}
    rec = faces._recognizer()
    feats = [[float(v) for v in rec.feature(rec.alignCrop(img, f["raw"])).flatten()] if f["raw"] is not None else None
             for f in found]
    thr = float(settings_store.get_setting(db, "face_match_threshold") or 0.36)
    pairs = []
    for ch in chars:
        emb = char_embedding(db, ch)
        if not emb:
            continue
        for i, ft in enumerate(feats):
            if ft is not None:
                sim = faces.similarity(ft, emb)
                if sim >= thr:
                    pairs.append((sim, ch.id, i))
    out: dict[int, bytes] = {}
    used: set[int] = set()
    h, w = img.shape[:2]
    for sim, cid, i in sorted(pairs, reverse=True):  # best matches first, one face per character
        if cid in out or i in used:
            continue
        x, y, bw, bh = found[i]["box"]
        side = max(bw, bh) * 2.2  # head and shoulders around the face
        cx, cy = x + bw / 2, y + bh / 2
        x0, y0 = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
        x1, y1 = int(min(w, cx + side / 2)), int(min(h, cy + side / 2))
        ok, buf = cv2.imencode(".png", img[y0:y1, x0:x1])
        if ok:
            out[cid] = buf.tobytes()
            used.add(i)
    return out


def _prune(db: Session, ch: Character) -> None:
    rows = (db.query(CharacterAsset).filter(CharacterAsset.character_id == ch.id, CharacterAsset.kind == STILL_KIND,
                                            CharacterAsset.archived.is_(False)).order_by(CharacterAsset.id.desc()).all())
    for a in rows[MAX_STILLS:]:
        a.archived = True


def learn_from_keyframe(db: Session, take: Take) -> list[CharacterAsset]:
    """Save the faces of an approved keyframe as approved stills. No commit. Returns the new assets."""
    if take is None or take.kind != "keyframe" or take.archived or not is_real(take):
        return []  # a placeholder made without an API key teaches nothing
    shot = db.get(Shot, take.shot_id)
    ids = [int(c) for c in (shot.characters or [])] if shot else []
    chars = [c for c in (db.get(Character, i) for i in ids) if c and not c.archived]
    st = get_storage()
    if not chars or not st.exists(take.path):
        return []
    tag = f"take #{take.id}"
    src = st.abs(take.path)
    if len(chars) == 1:
        crops: dict[int, bytes | None] = {chars[0].id: None}  # the whole frame: face, hair and clothes together
    elif faces.identity_available():
        try:
            crops = dict(_face_crops(db, src, chars))
        except Exception as e:  # never let learning break picking a take
            print(f"[approved_stills] face crops for take {take.id}: {e}")
            return []
    else:
        return []
    made = []
    for ch in chars:
        if ch.id not in crops:
            continue
        seen = (db.query(CharacterAsset.id).filter(CharacterAsset.character_id == ch.id, CharacterAsset.kind == STILL_KIND,
                                                   CharacterAsset.label.like(f"%{tag}")).first())
        if seen:
            continue
        data = crops[ch.id]
        folder = f"characters/{ch.id}"
        rel = st.save_bytes(st.new_path(folder, "png"), data) if data is not None else \
            st.save_file(st.new_path(folder, src.suffix.lstrip(".") or "png"), src)
        a = CharacterAsset(character_id=ch.id, kind=STILL_KIND, label=f"approved still · {shot.code} · {tag}",
                           outfit=outfit_for(db, shot, ch), path=rel, approved=True, version=ch.version,
                           prompt=f"From the keyframe of {shot.code} you approved")
        db.add(a)
        db.flush()
        _prune(db, ch)
        made.append(a)
    return made


def shots_with(db: Session, ch: Character) -> int:
    """How many shots (in the cut) this character appears in, across projects."""
    return sum(1 for (cs,) in db.query(Shot.characters).filter(Shot.include.is_(True)).all()
               if ch.id in {int(x) for x in (cs or []) if str(x).isdigit()})


def train_suggested(db: Session, ch: Character) -> tuple[bool, int]:
    """(suggest training an identity, shots it appears in): many shots and no trained (or training) face model."""
    status = (ch.identity or {}).get("status")
    n = shots_with(db, ch)
    return n >= SUGGEST_TRAIN_SHOTS and status not in ("ready", "training", "preparing"), n
