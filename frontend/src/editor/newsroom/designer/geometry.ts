/**
 * Template Designer geometry (docs/EDITOR.md §16.4 / §16.8): safe areas per ratio (16:9 graphics-safe 5 %; 9:16 keeps
 * clear of the top 12 %, bottom 22 % and right 16 % where Reels and Shorts draw their buttons), snapping a moved or
 * resized box to the frame, the safe area and other layers' edges and centres, resize handles, nudges and hit tests.
 * All in design pixels. Pure.
 */
import { DESIGN } from "../templates/kit.ts";
import type { Box, GfxDesign, GfxLayer, GfxRatio } from "../types.ts";

/** Insets (top, right, bottom, left) of a ratio's safe area: the design's own, else the format's. */
export function safeInsets(ratio: GfxRatio, design?: Pick<GfxDesign, "safe">): [number, number, number, number] {
  if (design?.safe) return design.safe;
  const { w, h } = DESIGN[ratio];
  return ratio === "9:16" ? [h * 0.12, w * 0.16, h * 0.22, w * 0.05] : [h * 0.05, w * 0.05, h * 0.05, w * 0.05];
}
/** The safe area as a box. */
export function safeBox(ratio: GfxRatio, design?: Pick<GfxDesign, "safe">): Box {
  const [t, r, b, l] = safeInsets(ratio, design);
  const { w, h } = DESIGN[ratio];
  return [l, t, w - l - r, h - t - b];
}
/** True when a box sits inside the safe area (a pixel of slack). */
export function insideSafe(box: Box, ratio: GfxRatio, design?: Pick<GfxDesign, "safe">): boolean {
  const s = safeBox(ratio, design);
  return box[0] >= s[0] - 1 && box[1] >= s[1] - 1 && box[0] + box[2] <= s[0] + s[2] + 1 && box[1] + box[3] <= s[1] + s[3] + 1;
}

export interface Guides { x: number[]; y: number[] }
/** Lines a box snaps to: frame edges and centre, the safe area, and the other (visible) layers' edges and centres. */
export function guidesFor(ratio: GfxRatio, design: GfxDesign, exclude: ReadonlySet<string>): Guides {
  const { w, h } = DESIGN[ratio];
  const s = safeBox(ratio, design);
  const x = [0, w / 2, w, s[0], s[0] + s[2]], y = [0, h / 2, h, s[1], s[1] + s[3]];
  for (const l of design.layers) {
    if (exclude.has(l.id) || l.hidden) continue;
    const [bx, by, bw, bh] = l.box;
    x.push(bx, bx + bw / 2, bx + bw); y.push(by, by + bh / 2, by + bh);
  }
  const uniq = (a: number[]) => [...new Set(a.map((v) => Math.round(v * 100) / 100))].sort((p, q) => p - q);
  return { x: uniq(x), y: uniq(y) };
}

/** The nearest guide to any of `edges` within `threshold`: the shift to apply and the guide. */
function nearest(edges: number[], lines: number[], threshold: number): { d: number; line: number } | null {
  let best: { d: number; line: number } | null = null;
  for (const e of edges) for (const g of lines) {
    const d = g - e;
    if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line: g };
  }
  return best;
}

export interface Snapped { box: Box; lines: { x?: number; y?: number } }
/** Snaps a moved box: its left / centre / right to the x guides, its top / middle / bottom to the y guides. */
export function snapMove(box: Box, g: Guides, threshold: number): Snapped {
  const [x, y, w, h] = box;
  const sx = nearest([x, x + w / 2, x + w], g.x, threshold), sy = nearest([y, y + h / 2, y + h], g.y, threshold);
  return { box: [x + (sx?.d ?? 0), y + (sy?.d ?? 0), w, h], lines: { x: sx?.line, y: sy?.line } };
}

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/**
 * A box resized by dragging a handle by (dx, dy) design px. Shift keeps the shape (corner handles), Alt resizes from
 * the centre; never smaller than `min`.
 */
export function resizeBox(b: Box, handle: Handle, dx: number, dy: number, o: { keepAspect?: boolean; fromCenter?: boolean; min?: number } = {}): Box {
  const min = o.min ?? 4;
  let [x, y, w, h] = b;
  const k = o.fromCenter ? 2 : 1;
  const east = handle.includes("e"), west = handle.includes("w"), north = handle.includes("n"), south = handle.includes("s");
  let nw = w + (east ? dx * k : west ? -dx * k : 0), nh = h + (south ? dy * k : north ? -dy * k : 0);
  if (o.keepAspect && (east || west) && (north || south) && w > 0 && h > 0) {
    const s = Math.max(nw / w, nh / h);
    nw = w * s; nh = h * s;
  }
  nw = Math.max(min, nw); nh = Math.max(min, nh);
  if (o.fromCenter) { x -= (nw - w) / 2; y -= (nh - h) / 2; }
  else { if (west) x += w - nw; if (north) y += h - nh; }
  w = nw; h = nh;
  return [x, y, w, h];
}

/** Snaps the edges a resize moves (only those) to the guides. */
export function snapResize(box: Box, handle: Handle, g: Guides, threshold: number): Snapped {
  let [x, y, w, h] = box;
  const lines: Snapped["lines"] = {};
  if (handle.includes("e")) { const s = nearest([x + w], g.x, threshold); if (s) { w += s.d; lines.x = s.line; } }
  else if (handle.includes("w")) { const s = nearest([x], g.x, threshold); if (s) { x += s.d; w -= s.d; lines.x = s.line; } }
  if (handle.includes("s")) { const s = nearest([y + h], g.y, threshold); if (s) { h += s.d; lines.y = s.line; } }
  else if (handle.includes("n")) { const s = nearest([y], g.y, threshold); if (s) { y += s.d; h -= s.d; lines.y = s.line; } }
  return { box: [x, y, Math.max(1, w), Math.max(1, h)], lines };
}

/** Arrow-key nudge: 1 design px, 10 with Shift. */
export function nudge(box: Box, key: string, big: boolean): Box | null {
  const s = big ? 10 : 1;
  const [x, y, w, h] = box;
  switch (key) {
    case "ArrowLeft": return [x - s, y, w, h];
    case "ArrowRight": return [x + s, y, w, h];
    case "ArrowUp": return [x, y - s, w, h];
    case "ArrowDown": return [x, y + s, w, h];
    default: return null;
  }
}

/** Whether a design point is inside a layer's (rotated) box. */
export function layerContains(l: Pick<GfxLayer, "box" | "rotation">, px: number, py: number, pad = 0): boolean {
  const [x, y, w, h] = l.box;
  let qx = px, qy = py;
  if (l.rotation) {
    const cx = x + w / 2, cy = y + h / 2, a = (-l.rotation * Math.PI) / 180;
    const dx = px - cx, dy = py - cy;
    qx = cx + dx * Math.cos(a) - dy * Math.sin(a); qy = cy + dx * Math.sin(a) + dy * Math.cos(a);
  }
  return qx >= x - pad && qx <= x + w + pad && qy >= y - pad && qy <= y + h + pad;
}

/** The topmost visible, unlocked layer under a design point (layers draw in order, so the last one is on top). */
export function hitLayer(layers: GfxLayer[], px: number, py: number, pad = 0): GfxLayer | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (l.hidden || l.locked) continue;
    if (layerContains(l, px, py, pad)) return l;
  }
  return undefined;
}

/** A box rounded to whole design pixels (what's saved). */
export const roundBox = (b: Box): Box => [Math.round(b[0]), Math.round(b[1]), Math.round(b[2]), Math.round(b[3])];
