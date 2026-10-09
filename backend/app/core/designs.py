"""Poster Studio: design documents, AI prompts for poster layers, and the green-screen cut-out.

A design is a JSON document: {v, background, layers}. Layers are drawn by the browser (Konva), which shapes Hindi,
Kannada, Telugu and Tamil correctly; the server stores documents, media, thumbnails and exports, and runs AI jobs.

Layer (common): id, type (image|text|shape|effect), name, x, y, width, height, rotation, opacity, visible, locked,
role (background|character|product|logo|title|tagline|credits|badge|cta|decor|effect), blend, shadow, slot.
Image layers keep `asset` (storage-relative path) and get `src` (a URL) when read.
"""
from __future__ import annotations

import io
import json
from typing import Any

import numpy as np
from PIL import Image, ImageFilter

from ..storage import get_storage

MIN_SIDE, MAX_SIDE = 64, 8000
MAX_LAYERS = 300
MAX_DOC_BYTES = 2_000_000
# storage areas a design may point at; private consent releases are never allowed
ASSET_PREFIXES = ("designs/", "characters/", "brand/", "projects/", "locations/", "library/")


def clamp_size(w: Any, h: Any) -> tuple[int, int]:
    def one(v: Any) -> int:
        try:
            return max(MIN_SIDE, min(MAX_SIDE, int(v)))
        except (TypeError, ValueError):
            return 1080
    return one(w), one(h)


def _asset_ok(path: Any) -> bool:
    p = str(path or "").replace("\\", "/").lstrip("/")
    return bool(p) and ".." not in p.split("/") and p.startswith(ASSET_PREFIXES)


def clean_doc(doc: Any) -> dict[str, Any]:
    """Validate a document from the browser. Drops URLs the server can rebuild and asset paths outside the allowed areas."""
    if not isinstance(doc, dict):
        raise ValueError("The design must be an object")
    layers = doc.get("layers") or []
    if not isinstance(layers, list) or len(layers) > MAX_LAYERS:
        raise ValueError(f"A design can have up to {MAX_LAYERS} layers")
    out_layers = []
    for layer in layers:
        if not isinstance(layer, dict) or not layer.get("id") or layer.get("type") not in ("image", "text", "shape", "effect"):
            continue
        layer = dict(layer)
        if layer["type"] == "image":
            if layer.get("asset"):
                if not _asset_ok(layer["asset"]):
                    layer.pop("asset", None)
                    layer["src"] = ""
                else:
                    layer.pop("src", None)  # rebuilt on read
            elif not str(layer.get("src") or "").startswith(("data:image/", "/showcase/", "/posters/")):
                layer["src"] = ""  # only server media, bundled art or small inline images
        out_layers.append(layer)
    clean = {"v": 1, "background": doc.get("background") if isinstance(doc.get("background"), dict) else {"color": "#0b0f17"},
             "layers": out_layers}
    for k in ("guides", "meta"):
        if isinstance(doc.get(k), (dict, list)):
            clean[k] = doc[k]
    if len(json.dumps(clean)) > MAX_DOC_BYTES:
        raise ValueError("This design is too large to save (inline images? upload them instead)")
    return clean


def resolve_doc(doc: Any) -> dict[str, Any]:
    """The document as the browser needs it: every stored image gets its URL."""
    st = get_storage()
    d = dict(doc or {})
    d["layers"] = [({**layer, "src": st.url(layer["asset"])} if layer.get("type") == "image" and layer.get("asset") else layer)
                   for layer in (d.get("layers") or []) if isinstance(layer, dict)]
    d.setdefault("background", {"color": "#0b0f17"})
    d.setdefault("v", 1)
    return d


def assets_in(doc: Any) -> list[str]:
    return [str(layer["asset"]) for layer in (doc or {}).get("layers") or [] if isinstance(layer, dict) and layer.get("asset")]


# ── AI prompts ──────────────────────────────────────────────

ASPECTS = {"1:1": 1.0, "4:5": 0.8, "3:4": 0.75, "2:3": 2 / 3, "9:16": 9 / 16, "16:9": 16 / 9, "4:3": 4 / 3, "3:2": 1.5, "21:9": 21 / 9}
GREEN = "Place the subject on a perfectly flat, evenly lit, pure chroma-key green (#00FF00) background with no shadows, " \
        "no floor and no other objects, sharp clean edges, nothing green on the subject."
NO_TEXT = "No text, no letters, no words, no logos, no watermark."


def nearest_aspect(w: float, h: float) -> str:
    r = (w or 1) / (h or 1)
    return min(ASPECTS, key=lambda k: abs(ASPECTS[k] - r))


def prompt_for(kind: str, prompt: str, *, style: str = "", character: Any = None, outfit: str = "", pose: str = "",
               cutout: bool = False, has_ref: bool = False) -> str:
    style_txt = f" Visual style: {style}." if style else ""
    prompt = (prompt or "").strip()
    if kind == "background":
        return (f"Poster background plate: {prompt}. Cinematic composition with clean open space for a title and credits, "
                f"rich colour grade, professional key art quality.{style_txt} {NO_TEXT}")
    if kind == "character":
        same = ("Same person as the reference image: identical face, facial structure, hair, skin tone and age. " if has_ref else "")
        dna = f"{character.dna_text}. " if character is not None and getattr(character, "dna_text", "") else ""
        who = f"{character.name}. " if character is not None else ""
        return (f"Key-art photograph of {who}{same}{dna}Pose and framing: {pose or prompt or 'heroic three-quarter pose, waist up'}. "
                f"{'Outfit: ' + outfit + '. ' if outfit else ''}{prompt + '. ' if prompt and pose else ''}"
                f"Dramatic film-poster lighting.{style_txt} Single person only. {GREEN if cutout else ''} {NO_TEXT}").strip()
    if kind in ("element", "product"):
        return (f"{'Product shot' if kind == 'product' else 'Poster element'}: {prompt}. High detail, studio quality.{style_txt} "
                f"{GREEN if cutout else ''} {NO_TEXT}").strip()
    if kind == "harmonize":
        return ("Relight and colour-match this poster composition so every element shares the same light direction, colour "
                "grade, atmosphere and film grain, as if shot together. Keep every person's face, identity, pose, size and "
                f"position exactly as they are; keep the layout. {prompt}{style_txt} {NO_TEXT}").strip()
    if kind == "restyle":
        return (f"Redraw this image in a new style while keeping its subject, layout and identity: {prompt}.{style_txt} {NO_TEXT}").strip()
    return f"{prompt}.{style_txt} {NO_TEXT}".strip()


# ── cut-out ─────────────────────────────────────────────────

def cutout_green(data: bytes, pad: int = 8) -> tuple[bytes, int, int]:
    """Key out a chroma-green background: soft alpha from how green each pixel is, green spill removed from the edges,
    then trimmed to the subject. Returns PNG bytes with transparency and the new size."""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    a = np.asarray(img).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    greenness = g - np.maximum(r, b)  # how much greener than the other channels
    alpha = 1.0 - np.clip((greenness - 18.0) / (70.0 - 18.0), 0.0, 1.0)
    # despill: where green leaks onto the subject, pull it back to the brighter of red and blue
    spill = np.clip(greenness, 0, None) * (alpha > 0.02)
    g2 = g - spill * 0.9
    rgb = np.stack([r, np.clip(g2, 0, 255), b], axis=-1).astype(np.uint8)
    mask = Image.fromarray((alpha * 255).astype(np.uint8), "L").filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
    out = Image.fromarray(rgb, "RGB").convert("RGBA")
    out.putalpha(mask)
    box = mask.point(lambda v: 255 if v > 24 else 0).getbbox()
    if box:
        x0, y0, x1, y1 = box
        out = out.crop((max(0, x0 - pad), max(0, y0 - pad), min(out.width, x1 + pad), min(out.height, y1 + pad)))
    buf = io.BytesIO()
    out.save(buf, "PNG", optimize=True)
    return buf.getvalue(), out.width, out.height


def image_size(data: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(data)) as im:
        return im.width, im.height


def convert_export(png: bytes, kind: str, quality: int = 92) -> tuple[bytes, str]:
    """Turn the browser's PNG render into the requested file. PDF pages are sized at 300 dpi."""
    im = Image.open(io.BytesIO(png))
    buf = io.BytesIO()
    if kind == "png":
        im.save(buf, "PNG", optimize=True)
        return buf.getvalue(), "png"
    flat = Image.new("RGB", im.size, (255, 255, 255))
    flat.paste(im.convert("RGBA"), mask=im.convert("RGBA").split()[3])
    if kind == "jpg":
        flat.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
        return buf.getvalue(), "jpg"
    if kind == "webp":
        im.save(buf, "WEBP", quality=quality, method=6)
        return buf.getvalue(), "webp"
    if kind == "pdf":
        flat.save(buf, "PDF", resolution=300.0)
        return buf.getvalue(), "pdf"
    raise ValueError("Choose png, jpg, webp or pdf")
