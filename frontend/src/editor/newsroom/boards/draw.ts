/**
 * Canvas helpers shared by the board kinds (number, list, bars, table, pins): plates in the look's style, tabular
 * figures, fitted text, enter / leave moves for parts that a kind animates itself, and small vector marks (arrows,
 * ticks, pins). Draws only into the context it is handed; nothing runs at import.
 */
import type { ChannelLook, GfxLayer, Paint } from "../types.ts";
import type { Ctx2D, LayerRenderContext } from "../render/contract.ts";
import { scriptOf } from "../format.ts";
import { cssFont } from "../render/paint.ts";
import { clamp01, easeBy, fitText } from "./math.ts";

export type Rect = [number, number, number, number];

// ── props ────────────────────────────────────────────────────────────────────

/** Typed reads of a layer's props with defaults. */
export const P = {
  num: (p: Record<string, unknown>, k: string, d: number): number => { const v = p[k]; return typeof v === "number" && Number.isFinite(v) ? v : d; },
  str: (p: Record<string, unknown>, k: string, d: string): string => { const v = p[k]; return typeof v === "string" ? v : d; },
  bool: (p: Record<string, unknown>, k: string, d: boolean): boolean => { const v = p[k]; return typeof v === "boolean" ? v : d; },
  paint: (p: Record<string, unknown>, k: string, d: Paint): Paint => { const v = p[k]; return typeof v === "string" || (v && typeof v === "object" && "gradient" in (v as object)) ? (v as Paint) : d; },
};

/** Choice options from "value|Label" strings. */
export const choices = (...xs: string[]): { value: string; label: string }[] =>
  xs.map((x) => { const [value, label] = x.split("|"); return { value, label: label ?? value }; });

// ── shapes ───────────────────────────────────────────────────────────────────

/** A rounded rectangle path (r clamped to the shorter side). */
export function rrPath(g: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  if (k <= 0.01) { g.rect(x, y, w, h); return; }
  g.moveTo(x + k, y);
  g.arcTo(x + w, y, x + w, y + h, k);
  g.arcTo(x + w, y + h, x, y + h, k);
  g.arcTo(x, y + h, x, y, k);
  g.arcTo(x, y, x + w, y, k);
  g.closePath();
}

/** The plate shape a look uses: angled (slanted ends), rounded / glass (radius) or flat (square corners). */
export function platePath(g: Ctx2D, look: ChannelLook, x: number, y: number, w: number, h: number, o: { radius?: number; slant?: number } = {}): void {
  if (look.plate === "angled" && o.slant !== 0) {
    const s = Math.min(o.slant ?? h * 0.28, w / 3);
    g.beginPath();
    g.moveTo(x + s, y); g.lineTo(x + w, y); g.lineTo(x + w - s, y + h); g.lineTo(x, y + h); g.closePath();
    return;
  }
  const r = o.radius ?? (look.plate === "flat" ? Math.min(look.radius, 3) : look.radius);
  rrPath(g, x, y, w, h, r);
}

/** Fills a plate: the paint, and for glass looks a translucent body with a light top edge and hairline border. */
export function fillPlate(g: Ctx2D, rc: LayerRenderContext, x: number, y: number, w: number, h: number, paint: Paint, o: { radius?: number; slant?: number; alpha?: number } = {}): void {
  if (w <= 0 || h <= 0) return;
  const a0 = g.globalAlpha;
  platePath(g, rc.look, x, y, w, h, o);
  g.fillStyle = rc.paint(paint);
  const glass = rc.look.plate === "glass";
  g.globalAlpha = a0 * (o.alpha ?? 1) * (glass ? 0.82 : 1);
  g.fill();
  if (glass) {
    g.save();
    g.clip();
    const lg = g.createLinearGradient(0, y, 0, y + h);
    lg.addColorStop(0, "rgba(255,255,255,0.20)");
    lg.addColorStop(0.45, "rgba(255,255,255,0.04)");
    lg.addColorStop(1, "rgba(255,255,255,0)");
    g.globalAlpha = a0 * (o.alpha ?? 1);
    g.fillStyle = lg;
    g.fillRect(x, y, w, h);
    g.restore();
    platePath(g, rc.look, x + 0.5, y + 0.5, w - 1, h - 1, o);
    g.strokeStyle = "rgba(255,255,255,0.22)";
    g.lineWidth = 1.5;
    g.globalAlpha = a0 * (o.alpha ?? 1);
    g.stroke();
  }
  g.globalAlpha = a0;
}

/** A small up / down triangle (markets, changes), centred at x, y. */
export function triangle(g: Ctx2D, x: number, y: number, size: number, up: boolean): void {
  const h = size * 0.8, w = size;
  g.beginPath();
  if (up) { g.moveTo(x, y - h / 2); g.lineTo(x + w / 2, y + h / 2); g.lineTo(x - w / 2, y + h / 2); }
  else { g.moveTo(x, y + h / 2); g.lineTo(x + w / 2, y - h / 2); g.lineTo(x - w / 2, y - h / 2); }
  g.closePath();
  g.fill();
}

/** A tick (check) mark stroked inside a size×size square centred at x, y; `p` 0..1 draws it on. */
export function tick(g: Ctx2D, x: number, y: number, size: number, p = 1): void {
  const a: [number, number] = [x - size * 0.34, y + size * 0.02], b: [number, number] = [x - size * 0.08, y + size * 0.28], c: [number, number] = [x + size * 0.36, y - size * 0.26];
  const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const d = clamp01(p) * (l1 + l2);
  g.beginPath(); g.moveTo(a[0], a[1]);
  if (d <= l1) g.lineTo(a[0] + ((b[0] - a[0]) * d) / l1, a[1] + ((b[1] - a[1]) * d) / l1);
  else { g.lineTo(b[0], b[1]); const e = (d - l1) / l2; g.lineTo(b[0] + (c[0] - b[0]) * e, b[1] + (c[1] - b[1]) * e); }
  g.lineCap = "round"; g.lineJoin = "round"; g.lineWidth = Math.max(2, size * 0.16);
  g.stroke();
}

/** A map pin (teardrop) with its tip at x, y and a light inner dot. */
export function pinPath(g: Ctx2D, x: number, y: number, size: number): void {
  const r = size * 0.42, cy = y - size + r;
  g.beginPath();
  g.moveTo(x, y);
  g.bezierCurveTo(x - r * 0.35, y - size * 0.32, x - r, cy + r * 0.55, x - r, cy);
  g.arc(x, cy, r, Math.PI, 0, false);
  g.bezierCurveTo(x + r, cy + r * 0.55, x + r * 0.35, y - size * 0.32, x, y);
  g.closePath();
}

// ── text ─────────────────────────────────────────────────────────────────────

const DIGIT_ZEROS = [0x30, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66];
const zeroOf = (cp: number): number => DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9) ?? -1;
/**
 * Widths of the widest digit per script in the current font (one tabular cell), memoised per font string for this
 * frame only: a longer-lived cache would keep widths measured while the font was still loading.
 */
let cellFont = "", cellMemo = new Map<number, number>();
function digitCell(g: Ctx2D, zero: number): number {
  if (g.font !== cellFont) { cellFont = g.font; cellMemo = new Map(); }
  let w = cellMemo.get(zero);
  if (w === undefined) {
    w = 0;
    for (let i = 0; i < 10; i++) w = Math.max(w, g.measureText(String.fromCodePoint(zero + i)).width);
    cellMemo.set(zero, w);
  }
  return w;
}
/** Forget measured digit cells (call once per frame: fonts may have loaded since). */
export function resetDigitCells(): void { cellFont = ""; }
/** Width of text with tabular figures (every digit as wide as the widest), in the current font. */
export function tabularWidth(g: Ctx2D, s: string): number {
  let w = 0;
  for (const ch of s) {
    const z = zeroOf(ch.codePointAt(0) ?? 0);
    w += z >= 0 ? digitCell(g, z) : g.measureText(ch).width;
  }
  return w;
}
/** Draws text with tabular figures (a counting number never wobbles); returns its width. `align` is about x. */
export function fillTabular(g: Ctx2D, s: string, x: number, y: number, align: "left" | "center" | "right" = "left"): number {
  const w = tabularWidth(g, s);
  let at = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
  const keep = g.textAlign;
  g.textAlign = "left";
  // runs of non-digits draw as one string (Indic shaping, kerning); digits centre in their cell
  let run = "";
  const flush = () => { if (run) { g.fillText(run, at, y); at += g.measureText(run).width; run = ""; } };
  for (const ch of s) {
    const z = zeroOf(ch.codePointAt(0) ?? 0);
    if (z < 0) { run += ch; continue; }
    flush();
    const cell = digitCell(g, z), cw = g.measureText(ch).width;
    g.fillText(ch, at + (cell - cw) / 2, y);
    at += cell;
  }
  flush();
  g.textAlign = keep;
  return w;
}

/** Sets the font and returns a measurer at any size (for fitText). */
export function measurer(g: Ctx2D, rc: LayerRenderContext, font: string, weight: number, sample: string, tabular = false): (s: string, size: number) => number {
  return (s, size) => {
    g.font = rc.font(font, size, weight, sample);
    return tabular ? tabularWidth(g, s) : g.measureText(s).width;
  };
}

/** Text fitted into a box (shrink to 60 %, wrap to `maxLines`, then "…"); returns the size and lines. */
export function fitIn(g: Ctx2D, rc: LayerRenderContext, s: string, o: { font: string; weight: number; size: number; maxW: number; maxH: number; maxLines?: number; lineH?: number; minFrac?: number }) {
  return fitText(s, { maxW: o.maxW, maxH: o.maxH, size: o.size, maxLines: o.maxLines, lineH: o.lineH, minFrac: o.minFrac }, measurer(g, rc, o.font, o.weight, s));
}

/** Letter spacing in px when the context supports it (Chromium canvas). */
export function setTracking(g: Ctx2D, px: number): void {
  const c = g as unknown as { letterSpacing?: string };
  if (typeof c.letterSpacing === "string") c.letterSpacing = `${px}px`;
}

// ── moves for parts a kind animates itself ───────────────────────────────────

export type Move = "none" | "fade" | "slide" | "rise" | "drop" | "pop" | "zoom" | "wipe" | "grow" | "flip" | "blur" | (string & {});
/**
 * Applies an enter move at eased progress `e` (0 hidden → 1 in place) to the context for a part in `r`: alpha,
 * a shift, a scale about the part's centre, or a clip for wipes. Call between save() / restore(). Returns false when
 * the part is fully hidden.
 */
export function applyMove(g: Ctx2D, move: Move, e: number, r: Rect, dir: "left" | "right" | "up" | "down" = "left", distance?: number): boolean {
  const x = clamp01(e);
  if (move === "none") return true;
  if (x <= 0) return false;
  const [rx, ry, rw, rh] = r;
  switch (move) {
    case "slide": {
      const d = distance ?? Math.min(rw, 160) * 0.6;
      const k = (1 - x) * d;
      g.translate(dir === "left" ? -k : dir === "right" ? k : 0, dir === "up" ? -k : dir === "down" ? k : 0);
      g.globalAlpha *= clamp01(x * 1.6);
      return true;
    }
    case "rise": case "drop": {
      const d = distance ?? Math.min(rh, 80) * 0.6;
      g.translate(0, (move === "rise" ? 1 : -1) * (1 - x) * d);
      g.globalAlpha *= clamp01(x * 1.5);
      return true;
    }
    case "pop": case "zoom": {
      const s = move === "pop" ? 0.6 + 0.4 * x : 1.25 - 0.25 * x;
      g.translate(rx + rw / 2, ry + rh / 2); g.scale(s, s); g.translate(-(rx + rw / 2), -(ry + rh / 2));
      g.globalAlpha *= clamp01(x * 1.4);
      return true;
    }
    case "flip": {
      g.translate(0, ry + rh / 2); g.scale(1, Math.max(0.001, x)); g.translate(0, -(ry + rh / 2));
      g.globalAlpha *= clamp01(x * 2);
      return true;
    }
    case "grow": case "wipe": {
      g.beginPath();
      if (dir === "right") g.rect(rx + rw * (1 - x), ry - rh, rw * x + 4, rh * 3);
      else if (dir === "up") g.rect(rx - rw, ry + rh * (1 - x), rw * 3, rh * x + 4);
      else if (dir === "down") g.rect(rx - rw, ry - 4, rw * 3, rh * x + 4);
      else g.rect(rx - 4, ry - rh, rw * x + 4, rh * 3);
      g.clip();
      return true;
    }
    default:
      g.globalAlpha *= x;
      return true;
  }
}

/** Eased enter progress of a part: by the look's motion when `ease` is "look", else a named easing. */
export function easeIn(rc: LayerRenderContext, x: number, ease = "look"): number {
  return ease === "look" ? rc.ease(clamp01(x)) : easeBy(ease, x);
}

/** CSS fonts a layer uses (for loading before export): its font props at their weights, for its text's script. */
export function fontsOf(look: ChannelLook, fonts: [unknown, number][], texts: string[] = []): string[] {
  const out = new Set<string>();
  const sample = texts.join(" ").slice(0, 400);
  for (const [f, w] of fonts) {
    const name = typeof f === "string" && f ? f : "@body";
    out.add(cssFont(name, look, 48, w));
    if (sample && scriptOf(sample) !== "latn") out.add(cssFont(name, look, 48, w, sample));
  }
  return [...out];
}

/**
 * The layer's own in and out moves applied to the whole layer (kinds that own their animation and still come in as a
 * whole): false when it's hidden. Call between save() / restore().
 */
export function layerMoves(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext, defIn: Move = "fade"): boolean {
  const ai = layer.anim?.in, ao = layer.anim?.out;
  const kin = !ai || ai.kind === "stagger" ? defIn : ai.kind;
  if (rc.phase.in < 1 && !applyMove(g, kin, easeIn(rc, rc.phase.in, ai?.ease), layer.box, ai?.dir ?? "left", ai?.distance)) return false;
  const kout = !ao || ao.kind === "stagger" ? "fade" : ao.kind;
  if (rc.phase.out < 1 && !applyMove(g, kout, easeIn(rc, rc.phase.out, ao?.ease), layer.box, ao?.dir ?? "left", ao?.distance)) return false;
  return true;
}

/** The time the layer's in move starts (its anim.in delay; 0 without one). */
export const inStart = (layer: { anim?: { in?: { delay?: number } } }): number => Math.max(0, layer.anim?.in?.delay ?? 0);
