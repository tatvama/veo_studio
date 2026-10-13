/**
 * Ticker items as drawn pieces: an item's parts (number badge, tag chip, icon, text, value, ▲ / ▼ change, the
 * separator after it) laid out at a font size, drawn once into an offscreen canvas at the output scale and cached,
 * so a crawl only moves bitmaps each frame. Flip and stack cells fit their text (shrink, two lines, then "…").
 * No DOM at import time.
 */
import { drawIcon, iconDef } from "../render/icons.ts";
import { textOn } from "../render/paint.ts";
import { clearWithFonts, fitText, measurer, type Measure } from "../render/text.ts";
import type { Ctx2D, LayerRenderContext } from "../render/contract.ts";
import type { ChannelLook, GfxListItem, GfxValue } from "../types.ts";
import { cacheEpoch, capsFor, centreBaseline, fieldPaint, makeCanvas, paintKey, platePath, setTracking, solid, triangle, type AnyCanvas } from "./canvas.ts";
import { deltaParts } from "./math.ts";
import { decimalsFor, type TickerProps } from "./props.ts";

export type RC = LayerRenderContext;

/** A list field's value as items: lists as they are, plain strings one per line, empty texts dropped. */
export function itemsOf(v: GfxValue | undefined): GfxListItem[] {
  if (Array.isArray(v)) {
    return (v as unknown[]).map((x) => (typeof x === "string" ? { text: x } : x && typeof x === "object" ? (x as GfxListItem) : null))
      .filter((x): x is GfxListItem => !!x && typeof x.text === "string" && (x.text.trim() !== "" || x.value !== undefined));
  }
  if (typeof v === "string") return v.split(/\r?\n/).map((t) => t.trim()).filter(Boolean).map((text) => ({ text }));
  return [];
}

// ── layout ───────────────────────────────────────────────────────────────────

export type Part =
  | { k: "badge" | "chip"; x: number; w: number; h: number; text: string; font: string; fill: string; color: string }
  | { k: "icon"; x: number; w: number; name: string }
  | { k: "text"; x: number; w: number; lines: string[]; font: string; size: number; color: string }
  | { k: "value"; x: number; w: number; text: string; font: string; color: string }
  | { k: "arrow"; x: number; w: number; up: boolean; color: string }
  | { k: "delta"; x: number; w: number; text: string; font: string; color: string }
  | { k: "sep"; x: number; w: number };

export interface ItemLayout {
  parts: Part[];
  /** Width of the item itself, and with the separator after it. */
  contentW: number; w: number;
  flash: boolean;
}

export interface LayoutOpts {
  /** Row height (design px). */
  h: number;
  /** Fit the item into this width (flip and stack); Infinity for a crawl. */
  maxW: number;
  /** Add the separator after the item (crawl). */
  sep: boolean;
  /** The item's number (1-based) for the badge, and how many there are. */
  num: number; count: number;
}

/** The separator the ticker uses ("look" = the look's). */
export const sepOf = (P: TickerProps, look: Pick<ChannelLook, "separator">): Exclude<TickerProps["separator"], "look"> =>
  P.separator === "look" ? look.separator : P.separator;

/** The gap around a separator (design px). */
export const gapOf = (P: TickerProps) => (P.gap > 0 ? P.gap : P.size * 1.15);

/** Makes a measurer for a font and letter spacing (px): the shared cached one, or a caller's (period.ts). */
export type MeasureFor = (font: string, track: number) => Measure;

/** Lays out one item's parts from x = 0 (`mf` measures instead of g, for sizes without drawing). */
export function layoutItem(g: Ctx2D, rc: RC, P: TickerProps, it: GfxListItem, o: LayoutOpts, mf?: MeasureFor): ItemLayout {
  const measureFn = (_g: Ctx2D, font: string, track = 0): Measure => (mf ? mf(font, track) : measurer(g, font, track));
  const S = P.size, H = o.h, look = rc.look;
  const weight = P.weight > 0 ? P.weight : undefined;
  const parts: Part[] = [];
  const flash = !!it.flash;
  let x = flash ? S * 0.42 : 0;
  // number badge (speed news)
  if (P.numbered) {
    const t = String(o.num).padStart(o.count >= 10 ? 2 : 1, "0");
    const font = rc.font("@numbers", S * 0.78, 700, t);
    const tw = measureFn(g, font)(t);
    const bh = Math.min(H * 0.8, S * 1.3), bw = Math.max(bh, tw + S * 0.62);
    parts.push({ k: "badge", x, w: bw, h: bh, text: t, font, fill: solid(rc, P.numberFill, "#FFC20E"), color: solid(rc, P.numberColor, "#111111") });
    x += bw + S * 0.42;
  }
  // tag chip
  if (P.tags === "inline" && it.tag?.trim()) {
    const ts = P.tagSize > 0 ? P.tagSize : Math.round(S * 0.56);
    const t = capsFor(rc.text(it.tag.trim()), P.tagUpper, look);
    const font = rc.font(P.tagFont, ts, 700, t);
    const tw = measureFn(g, font, ts * 0.04)(t);
    const fill = it.color || solid(rc, P.tagFill, "#FFC20E");
    const color = it.color || P.tagColor === "auto" ? textOn(fill) : solid(rc, P.tagColor, "#111111");
    const ch = Math.min(H * 0.72, ts * 1.75);
    parts.push({ k: "chip", x, w: tw + ts * 1.1, h: ch, text: t, font, fill, color });
    x += tw + ts * 1.1 + S * 0.38;
  }
  // icon
  if (it.icon && iconDef(it.icon)) {
    const iw = Math.min(H * 0.8, S * 1.15);
    parts.push({ k: "icon", x, w: iw, name: it.icon });
    x += iw + S * 0.3;
  }
  // value and change: measured first so the text can fit around them
  const tail: Part[] = [];
  let tailW = 0;
  const showVal = P.values === "auto";
  if (showVal && it.value !== undefined && it.value !== null && Number.isFinite(it.value)) {
    const t = rc.number(it.value, { decimals: decimalsFor(P.decimals, it.value), currency: P.currency, prefix: P.prefix || undefined, suffix: P.suffix || undefined });
    const font = rc.font(P.valueFont, S, weight ?? 600, t);
    const w = measureFn(g, font)(t);
    tailW += S * 0.45;
    tail.push({ k: "value", x: tailW, w, text: t, font, color: flash ? solid(rc, P.flashColor, "#FFFFFF") : solid(rc, P.valueColor, "#FFFFFF") });
    tailW += w;
  }
  if (showVal && it.delta !== undefined && it.delta !== null && Number.isFinite(it.delta)) {
    const d = deltaParts(it.value, it.delta, P.deltaStyle);
    const color = d.dir > 0 ? solid(rc, P.upColor, "#21C063") : d.dir < 0 ? solid(rc, P.downColor, "#F0323C") : solid(rc, "@text/60", "#BBBBBB");
    const pct = d.pct !== undefined ? rc.number(d.pct, { decimals: 2, suffix: "%" }) : "";
    const abs = d.abs !== undefined ? rc.number(d.abs, { decimals: decimalsFor(P.decimals, d.abs) }) : "";
    const t = abs && pct ? `${abs} (${pct})` : abs || pct;
    const ds = S * 0.82;
    const font = rc.font(P.valueFont, ds, weight ?? 600, t);
    const aw = S * 0.5;
    tailW += S * 0.32;
    if (d.dir !== 0) { tail.push({ k: "arrow", x: tailW, w: aw, up: d.dir > 0, color }); tailW += aw + S * 0.16; }
    const w = measureFn(g, font)(t);
    tail.push({ k: "delta", x: tailW, w, text: t, font, color });
    tailW += w;
  }
  // the text
  const raw = capsFor(rc.text(it.text ?? ""), P.upper, look).trim();
  const color = flash ? solid(rc, P.flashColor, "#FFFFFF") : solid(rc, fieldPaint(P.color, rc) ?? "@text", "#FFFFFF");
  const track = P.tracking * S;
  const flashPad = flash ? S * 0.42 : 0;
  if (raw) {
    const font = rc.font(P.font, S, weight, raw);
    const m = measureFn(g, font, track);
    if (!Number.isFinite(o.maxW)) {
      const w = m(raw);
      parts.push({ k: "text", x, w, lines: [raw], font, size: S, color });
      x += w;
    } else {
      const avail = Math.max(S, o.maxW - x - tailW - flashPad);
      const at = (s: number) => measureFn(g, rc.font(P.font, s, weight, raw), P.tracking * s);
      let fit = fitText(raw, avail, H, { size: S, lineHeight: 1.1, maxLines: 1, fit: "shrink", minScale: 0.62 }, at);
      if (P.lines === 2 && (fit.scale < 0.86 || fit.ellipsized)) {
        const s2 = Math.min(S, (H * 0.92) / 2.16);
        const two = fitText(raw, avail, H * 0.92, { size: s2, lineHeight: 1.08, maxLines: 2, fit: "shrink", minScale: 0.7 }, at);
        if (two.lines.length > 1 && (!two.ellipsized || fit.ellipsized)) fit = two;
      }
      const font2 = rc.font(P.font, fit.size, weight, raw);
      parts.push({ k: "text", x, w: fit.width, lines: fit.lines, font: font2, size: fit.size, color });
      x += fit.width;
    }
  }
  for (const p of tail) parts.push({ ...p, x: x + p.x } as Part);
  x += tailW + flashPad;
  const contentW = x;
  if (o.sep) {
    const sep = sepOf(P, look);
    const G = gapOf(P);
    let sw = G;
    if (sep === "logo") {
      const img = rc.logo();
      if (img) { const { w, h } = imgSize(img); sw = G + (S * 0.95 * w) / Math.max(1, h); }
      else if (look.logo?.text) sw = G + measureFn(g, rc.font(P.tagFont, S * 0.5, 800, look.logo.text), S * 0.03)(look.logo.text);
    }
    parts.push({ k: "sep", x, w: sw });
    x += sw;
  }
  return { parts, contentW, w: Math.max(1, x), flash };
}

function imgSize(img: CanvasImageSource): { w: number; h: number } {
  const x = img as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
  return { w: x.naturalWidth || (typeof x.width === "number" ? x.width : 1) || 1, h: x.naturalHeight || (typeof x.height === "number" ? x.height : 1) || 1 };
}

// ── drawing ──────────────────────────────────────────────────────────────────

/** Draws a separator glyph centred at (cx, cy). */
export function drawSep(g: Ctx2D, rc: RC, P: TickerProps, cx: number, cy: number, w: number): void {
  const S = P.size, look = rc.look;
  const col = solid(rc, P.sepColor, "#FFC20E");
  const sep = sepOf(P, look);
  g.save();
  g.fillStyle = col; g.strokeStyle = col;
  switch (sep) {
    case "dot": g.beginPath(); g.arc(cx, cy, S * 0.12, 0, Math.PI * 2); g.fill(); break;
    case "diamond": { const r = S * 0.17; g.beginPath(); g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy); g.closePath(); g.fill(); break; }
    case "bar": g.fillRect(cx - S * 0.04, cy - S * 0.42, S * 0.08, S * 0.84); break;
    case "slash": g.lineWidth = S * 0.09; g.lineCap = "butt"; g.beginPath(); g.moveTo(cx + S * 0.16, cy - S * 0.42); g.lineTo(cx - S * 0.16, cy + S * 0.42); g.stroke(); break;
    case "logo": {
      const img = rc.logo();
      const G = gapOf(P);
      if (img) {
        const { w: iw, h: ih } = imgSize(img);
        const h = S * 0.95, ww = (h * iw) / Math.max(1, ih);
        g.drawImage(img, cx - ww / 2, cy - h / 2, ww, h);
      } else if (look.logo?.text) {
        g.font = rc.font(P.tagFont, S * 0.5, 800, look.logo.text);
        setTracking(g, 0.03, S * 0.5);
        g.textAlign = "center"; g.textBaseline = "alphabetic";
        g.fillText(look.logo.text, cx, centreBaseline(g, look.logo.text, cy), Math.max(1, w - G * 0.6));
      } else { const r = S * 0.17; g.beginPath(); g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy); g.closePath(); g.fill(); }
      break;
    }
    default: break;
  }
  g.restore();
}

/** Draws an item's parts with its left edge at x0, centred on a row of height h starting at y0. */
export function drawItem(g: Ctx2D, rc: RC, P: TickerProps, L: ItemLayout, x0: number, y0: number, h: number): void {
  const cy = y0 + h / 2, S = P.size, look = rc.look;
  g.textBaseline = "alphabetic";
  g.textAlign = "left";
  for (const p of L.parts) {
    const x = x0 + p.x;
    switch (p.k) {
      case "badge": case "chip": {
        g.save();
        const y = cy - p.h / 2;
        if (p.k === "chip") platePath(g, x, y, p.w, p.h, { plate: look.plate === "angled" ? "flat" : look.plate, radius: Math.min(look.radius, p.h / 3) }, {});
        else platePath(g, x, y, p.w, p.h, look, look.plate === "angled" ? { right: true } : {});
        g.fillStyle = p.fill; g.fill();
        g.font = p.font; g.fillStyle = p.color; g.textAlign = "center";
        if (p.k === "chip") setTracking(g, 0.04, parseFloat(/(\d+(?:\.\d+)?)px/.exec(p.font)?.[1] ?? "20"));
        const ax = p.k === "badge" && look.plate === "angled" ? -p.h * 0.12 : 0;
        g.fillText(p.text, x + p.w / 2 + ax, centreBaseline(g, p.text, cy));
        g.restore();
        break;
      }
      case "icon": {
        const s = p.w;
        drawIcon(g, p.name, x, cy - s / 2, s, s, solid(rc, P.iconColor, "#FFFFFF"), solid(rc, P.icon2Color, "#FFC20E"));
        break;
      }
      case "text": {
        g.save();
        g.font = p.font; g.fillStyle = p.color;
        setTracking(g, P.tracking, p.size);
        const lh = p.size * 1.08;
        const top = cy - (lh * (p.lines.length - 1)) / 2;
        p.lines.forEach((ln, i) => g.fillText(ln, x, centreBaseline(g, ln, top + i * lh)));
        g.restore();
        break;
      }
      case "value": case "delta": {
        g.save();
        g.font = p.font; g.fillStyle = p.color;
        g.fillText(p.text, x, centreBaseline(g, "H", cy));
        g.restore();
        break;
      }
      case "arrow": triangle(g, x, cy - S * 0.21, p.w, S * 0.42, p.up, p.color); break;
      case "sep": drawSep(g, rc, P, x + p.w / 2, cy, p.w); break;
    }
  }
}

// ── cached bitmaps ───────────────────────────────────────────────────────────

export interface Piece { c: AnyCanvas | null; /** Design px: the bitmap's size and its left margin. */ w: number; h: number; m: number; L: ItemLayout }

const pieces = new Map<string, Piece>();
let piecePixels = 0;
const MAX_PIXELS = 24e6;

const lookKeys = new WeakMap<object, string>();
/** Everything about a look that changes how an item draws. */
export function lookKey(look: ChannelLook): string {
  let k = lookKeys.get(look);
  if (!k) { k = JSON.stringify([look.id, look.colors, look.fonts, look.plate, look.radius, look.upper, look.numbers, look.separator, look.logo]); lookKeys.set(look, k); }
  return k;
}

/** Drops every cached piece (fonts or pictures arrived, tests). */
export function clearPieces(): void { pieces.clear(); piecePixels = 0; }
clearWithFonts(clearPieces);

/**
 * An item drawn once into its own bitmap at the output scale (cached by everything that changes it). `null` canvas:
 * no canvas here (the caller draws the layout directly).
 */
export function pieceFor(g: Ctx2D, rc: RC, P: TickerProps, it: GfxListItem, o: LayoutOpts): Piece {
  const key = JSON.stringify([it, P, o, lookKey(rc.look), rc.scale, cacheEpoch(), P.separator === "logo" || rc.look.separator === "logo" ? !!rc.logo() : 0,
    paintKey(P.color), solid(rc, P.color), solid(rc, P.tagFill)]);
  const hit = pieces.get(key);
  if (hit) { pieces.delete(key); pieces.set(key, hit); return hit; }
  g.save();
  const L = layoutItem(g, rc, P, it, o);
  g.restore();
  const m = Math.ceil(P.size * 0.25);
  const w = L.w + m * 2, h = o.h;
  const cv = makeCanvas(w * rc.scale, h * rc.scale);
  let piece: Piece = { c: null, w, h, m, L };
  if (cv) {
    cv.g.setTransform(rc.scale, 0, 0, rc.scale, 0, 0);
    drawItem(cv.g, rc, P, L, m, 0, h);
    piece = { c: cv.c, w: cv.c.width / rc.scale, h: cv.c.height / rc.scale, m, L };
    piecePixels += cv.c.width * cv.c.height;
  }
  pieces.set(key, piece);
  while ((pieces.size > 600 || piecePixels > MAX_PIXELS) && pieces.size > 1) {
    const [k0, p0] = pieces.entries().next().value as [string, Piece];
    pieces.delete(k0);
    if (p0.c) piecePixels -= p0.c.width * p0.c.height;
  }
  return piece;
}

/** Draws a piece at x (its item's left edge), y (row top). */
export function drawPiece(g: Ctx2D, rc: RC, P: TickerProps, piece: Piece, x: number, y: number): void {
  if (piece.c) {
    const px = Math.round((x - piece.m) * rc.scale) / rc.scale;
    g.drawImage(piece.c, px, y, piece.w, piece.h);
  } else drawItem(g, rc, P, piece.L, x, y, piece.h);
}
