"""Split a character board (one image with many views: turnaround, expressions, outfits) into its panels.

Deterministic first: on a plain background the panels are separated by gutters, so a recursive cut along empty rows and
columns (an XY-cut) finds them; figures that overlap in both directions fall back to connected regions. When the
background isn't plain or nothing separates, the board is "not clean" and a vision model returns the boxes instead
(workers/handlers_board.py). Boxes are in the board's own pixels: {x, y, w, h}.
"""
from __future__ import annotations

import io
from typing import Any

import numpy as np
from PIL import Image, ImageOps

ANALYSIS_SIDE = 1024  # the board is analysed at this size (long side); boxes are scaled back to full size
TOL = 28  # max channel difference from the background colour that still counts as background (JPEG noise)
MAX_PANELS = 30
KINDS = ("front", "three_quarter", "profile", "back", "full_body", "expression", "outfit", "other")
VIEWS = ("front", "three_quarter", "profile", "back", "full_body")


def load(data: bytes) -> Image.Image:
    """The board as RGB, upright (EXIF), transparent parts on white."""
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        flat = Image.new("RGB", img.size, (255, 255, 255))
        flat.paste(img, mask=img.getchannel("A"))
        return flat
    return img.convert("RGB")


def _background(a: np.ndarray) -> tuple[np.ndarray, bool]:
    """The background colour (median of the outer ring) and whether the ring is plain enough to cut on."""
    h, w, _ = a.shape
    r = max(2, round(min(h, w) * 0.01))
    ring = np.concatenate([a[:r].reshape(-1, 3), a[-r:].reshape(-1, 3), a[:, :r].reshape(-1, 3), a[:, -r:].reshape(-1, 3)])
    bg = np.median(ring, axis=0)
    close = (np.abs(ring - bg).max(axis=1) <= TOL).mean()
    return bg, bool(close >= 0.85)


def _runs(profile: np.ndarray, noise: int, min_gap: int) -> list[tuple[int, int]]:
    """Runs of filled lines [start, end), merging runs separated by fewer than `min_gap` empty lines."""
    idx = np.flatnonzero(profile > noise)
    if idx.size == 0:
        return []
    runs: list[tuple[int, int]] = []
    start = prev = int(idx[0])
    for i in idx[1:]:
        i = int(i)
        if i - prev > min_gap:
            runs.append((start, prev + 1))
            start = i
        prev = i
    runs.append((start, prev + 1))
    return runs


def _cut(mask: np.ndarray, x0: int, y0: int, x1: int, y1: int, min_gap: int, depth: int = 0) -> list[tuple[int, int, int, int]]:
    """Recursive XY-cut of the region: split on empty rows, else on empty columns, until nothing splits."""
    region = mask[y0:y1, x0:x1]
    if not region.any():
        return []
    if depth < 8:
        for axis in (1, 0):  # rows first (a profile per row sums along the columns), then columns
            profile = region.sum(axis=axis)
            width = region.shape[axis]
            runs = _runs(profile, max(1, int(width * 0.003)), min_gap)
            if len(runs) > 1:
                # each part reaches half-way into the gutters around it, so padding never takes from a neighbour
                edges = [0] + [(runs[i][1] + runs[i + 1][0]) // 2 for i in range(len(runs) - 1)] + [len(profile)]
                out: list[tuple[int, int, int, int]] = []
                for a, b in zip(edges, edges[1:]):
                    if axis == 1:
                        out += _cut(mask, x0, y0 + a, x1, y0 + b, min_gap, depth + 1)
                    else:
                        out += _cut(mask, x0 + a, y0, x0 + b, y1, min_gap, depth + 1)
                return out
    return [(x0, y0, x1, y1)]


def _trim(mask: np.ndarray, box: tuple[int, int, int, int], pad: float = 0.04) -> tuple[int, int, int, int]:
    """The box shrunk to its content, then padded a little (never past the part it was cut from)."""
    x0, y0, x1, y1 = box
    ys, xs = np.nonzero(mask[y0:y1, x0:x1])
    if ys.size == 0:
        return box
    tx0, tx1, ty0, ty1 = x0 + int(xs.min()), x0 + int(xs.max()) + 1, y0 + int(ys.min()), y0 + int(ys.max()) + 1
    px, py = max(2, round((tx1 - tx0) * pad)), max(2, round((ty1 - ty0) * pad))
    return max(x0, tx0 - px), max(y0, ty0 - py), min(x1, tx1 + px), min(y1, ty1 + py)


def _keep(boxes: list[tuple[int, int, int, int]], w: int, h: int) -> list[tuple[int, int, int, int]]:
    """Drop what isn't a panel: specks, captions and title strips (small next to the others, or very long and thin)."""
    def area(b):
        return (b[2] - b[0]) * (b[3] - b[1])
    big = [b for b in boxes if (b[2] - b[0]) >= w * 0.04 and (b[3] - b[1]) >= h * 0.04 and area(b) >= w * h * 0.004]
    big = [b for b in big if 1 / 6 <= (b[2] - b[0]) / max(b[3] - b[1], 1) <= 6]
    if not big:
        return []
    median = float(np.median([area(b) for b in big]))
    return [b for b in big if area(b) >= median * 0.2]


def _regions(mask: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Connected regions of content (slightly grown so one figure's parts stay together)."""
    try:
        import cv2
    except ImportError:  # OpenCV is a dependency, but the gutter cut works without it
        return []
    h, w = mask.shape
    k = max(3, round(max(h, w) * 0.012))
    grown = cv2.dilate(mask.astype(np.uint8), np.ones((k, k), np.uint8))
    n, _, stats, _ = cv2.connectedComponentsWithStats(grown, connectivity=8)
    out = []
    for i in range(1, n):
        x, y, bw, bh, _ = (int(v) for v in stats[i])
        out.append((x, y, min(w, x + bw), min(h, y + bh)))
    return out


def reading_order(boxes: list[dict[str, int]]) -> list[dict[str, int]]:
    """Rows top to bottom (boxes whose tops are close together share a row), left to right inside a row. A tall figure
    beside a grid of heads joins the grid's first row."""
    if not boxes:
        return []
    tol = 0.3 * float(np.median([b["h"] for b in boxes]))
    rows: list[tuple[int, list[dict[str, int]]]] = []
    for b in sorted(boxes, key=lambda b: b["y"]):
        if rows and b["y"] - rows[-1][0] <= tol:
            rows[-1][1].append(b)
        else:
            rows.append((b["y"], [b]))
    return [b for _, row in rows for b in sorted(row, key=lambda b: b["x"])]


def detect_panels(data: bytes) -> dict[str, Any]:
    """{width, height, panels: [{x, y, w, h}], clean, method, background}. `clean` = the panels were found without a
    vision model (plain background and at least two panels)."""
    img = load(data)
    W, H = img.size
    scale = min(1.0, ANALYSIS_SIDE / max(W, H))
    small = img.resize((max(1, round(W * scale)), max(1, round(H * scale))), Image.BILINEAR) if scale < 1 else img
    a = np.asarray(small, dtype=np.int16)
    bg, plain = _background(a)
    out: dict[str, Any] = {"width": W, "height": H, "panels": [], "clean": False, "method": "",
                           "background": "#%02x%02x%02x" % tuple(int(v) for v in bg)}
    if not plain:
        return out
    mask = np.abs(a - bg).max(axis=2) > TOL
    h, w = mask.shape
    min_gap = max(2, round(max(h, w) * 0.006))
    boxes = _keep([_trim(mask, b) for b in _cut(mask, 0, 0, w, h, min_gap)], w, h)
    method = "gutters"
    if len(boxes) < 2:
        boxes = _keep([_trim(mask, b, pad=0.03) for b in _regions(mask)], w, h)
        method = "regions"
    if len(boxes) < 2 or len(boxes) > MAX_PANELS:
        return out
    panels = [{"x": int(x0 / scale), "y": int(y0 / scale), "w": min(W, int(round(x1 / scale))) - int(x0 / scale),
               "h": min(H, int(round(y1 / scale))) - int(y0 / scale)} for x0, y0, x1, y1 in boxes]
    out.update(panels=reading_order(panels), clean=True, method=method)
    return out


def clamp(box: dict[str, Any], W: int, H: int) -> dict[str, int] | None:
    """A box kept inside the board, at least 16 px a side; None when it can't be."""
    try:
        x, y = max(0, int(box["x"])), max(0, int(box["y"]))
        w, h = int(box["w"]), int(box["h"])
    except (KeyError, TypeError, ValueError):
        return None
    w, h = min(w, W - x), min(h, H - y)
    if w < 16 or h < 16:
        return None
    return {"x": x, "y": y, "w": w, "h": h}


def from_fractions(items: list[Any], W: int, H: int) -> list[dict[str, int]]:
    """Boxes a vision model gave as fractions of the board (x, y, w, h in 0–1) → pixels, in reading order."""
    out = []
    for it in items[:MAX_PANELS]:
        get = (lambda k: getattr(it, k, None)) if not isinstance(it, dict) else it.get
        try:
            fx, fy, fw, fh = (min(max(float(get(k) or 0), 0.0), 1.0) for k in ("x", "y", "w", "h"))
        except (TypeError, ValueError):
            continue
        b = clamp({"x": round(fx * W), "y": round(fy * H), "w": round(fw * W), "h": round(fh * H)}, W, H)
        if b:
            out.append(b)
    return reading_order(out)


def crop(img: Image.Image, box: dict[str, int], max_side: int | None = None) -> Image.Image:
    c = img.crop((box["x"], box["y"], box["x"] + box["w"], box["y"] + box["h"]))
    if max_side and max(c.size) > max_side:
        c.thumbnail((max_side, max_side), Image.LANCZOS)
    return c


def to_bytes(img: Image.Image, fmt: str = "JPEG") -> bytes:
    b = io.BytesIO()
    if fmt == "JPEG":
        img.save(b, "JPEG", quality=94)
    else:
        img.save(b, fmt)
    return b.getvalue()


def normalize_label(kind: str, name: str = "") -> tuple[str, str]:
    """A vision model's label → (kind, name). "expression:happy" and "three-quarter" are understood too."""
    k = (kind or "").strip().lower().replace("-", "_").replace(" ", "_")
    if k.startswith("expression"):
        rest = k.split(":", 1)[1] if ":" in k else ""
        return "expression", (name or rest.replace("_", " ")).strip()[:60] or "neutral"
    aliases = {"3/4": "three_quarter", "three_quarters": "three_quarter", "34": "three_quarter", "side": "profile",
               "side_profile": "profile", "fullbody": "full_body", "full": "full_body", "rear": "back", "back_view": "back",
               "front_view": "front", "costume": "outfit"}
    k = aliases.get(k, k)
    return (k if k in KINDS else "other"), (name or "").strip()[:60]
