/**
 * "Make vertical" (docs/EDITOR.md §16.8): builds (or rebuilds) a template's 9:16 design from its 16:9 one.
 *
 * - A layer with a `pin` keeps to those frame edges: left / right / top / bottom keep their distance to the safe area
 *   edge (scaled), centre stays centred, stretch maps its edges from the 16:9 safe area onto the 9:16 one.
 * - A layer without a pin that sits inside another layer (text on a plate, a stripe on its end) moves with that
 *   layer, so groups stay together; otherwise its pin is guessed from where it sits.
 * - Sizes are about 1.15× (vertical frames are 1080 wide, so the same text needs a little more); boxes stay inside the
 *   9:16 safe area (clear of the top 12 %, bottom 22 % and right 16 % that Reels and Shorts cover), and size
 *   properties (text size, radius, padding…) scale with them.
 * - Rebuilding keeps layers that only exist in the old vertical design, and what each layer's "hidden" said there.
 *
 * Pure.
 */
import { DESIGN } from "../templates/kit.ts";
import type { Box, GfxDesign, GfxLayer, GfxRatio, GfxTemplate } from "../types.ts";
import { safeBox } from "./geometry.ts";

type PinX = "left" | "right" | "center" | "stretch";
type PinY = "top" | "bottom" | "center" | "stretch";
export interface MakeVerticalOptions {
  /** Design to build from (default 16:9) and to build (default 9:16). */
  from?: GfxRatio; to?: GfxRatio;
  /** The current design of `to`, when rebuilding. */
  keep?: GfxDesign;
  /** `p` keys of a kind that are sizes in design px (scaled with the layer); default: common size names. */
  sizeKeys?(kind: string): string[];
  /** Size factor (default 1.15 for 9:16, else 1). */
  scale?: number;
}

const FALLBACK_SIZE_KEYS = ["size", "radius", "gap", "pad", "padding", "padX", "strokeWidth", "outlineWidth", "stripeWidth", "borderWidth", "lineWidth", "width",
  "thickness", "tracking", "rowHeight", "itemGap", "spacing"];

/** Where a layer keeps to, guessed from where it sits in the frame. */
export function inferPin(box: Box, W: number, H: number): { x: PinX; y: PinY } {
  const [x, y, w, h] = box;
  const cx = (x + w / 2) / W, cy = (y + h / 2) / H;
  return {
    x: w >= W * 0.9 ? "stretch" : cx < 0.4 ? "left" : cx > 0.6 ? "right" : "center",
    y: h >= H * 0.9 ? "stretch" : cy < 0.4 ? "top" : cy > 0.6 ? "bottom" : "center",
  };
}

/** Maps a coordinate between the frames piecewise: margin → margin, safe area → safe area. */
function mapEdge(e: number, s0: number, s1: number, W: number, t0: number, t1: number, TW: number): number {
  if (e <= s0) return s0 > 0 ? (e / s0) * t0 : t0 + (e - s0);
  if (e >= s1) return W > s1 ? t1 + ((e - s1) / (W - s1)) * (TW - t1) : t1 + (e - s1);
  return t0 + ((e - s0) / (s1 - s0)) * (t1 - t0);
}

/**
 * One axis of a top-level layer: position and length in the source frame (size W, safe s0..s1) → the target frame
 * (size TW, safe t0..t1), by its pin.
 */
function axis(a: number, len: number, pin: PinX | PinY, k: number, W: number, s0: number, s1: number, TW: number, t0: number, t1: number): [number, number] {
  const lo = a, hi = a + len, safeLen = t1 - t0;
  const inside = lo >= s0 - 1 && hi <= s1 + 1;
  if (pin === "stretch") {
    const n0 = mapEdge(lo, s0, s1, W, t0, t1, TW), n1 = mapEdge(hi, s0, s1, W, t0, t1, TW);
    return [n0, n1 - n0];
  }
  let size = len * k;
  if (inside) size = Math.min(size, safeLen);
  let start: number;
  if (pin === "left" || pin === "top") {
    start = lo >= s0 ? t0 + (lo - s0) * k : mapEdge(lo, s0, s1, W, t0, t1, TW);
    if (hi > s1 + 1) size = mapEdge(hi, s0, s1, W, t0, t1, TW) - start; // bleeds off the far edge: keep bleeding
    else if (start + size > t1) {
      // too long for the safe area: shorten it (keeps its offset from the near edge), or slide it back when that's too much
      if (t1 - start >= size * 0.6) size = t1 - start;
      else start = Math.max(t0, t1 - size);
    }
  } else if (pin === "right" || pin === "bottom") {
    let end = hi <= s1 ? t1 - (s1 - hi) * k : mapEdge(hi, s0, s1, W, t0, t1, TW);
    if (lo < s0 - 1) start = mapEdge(lo, s0, s1, W, t0, t1, TW);
    else {
      start = end - size;
      if (start < t0) {
        if (end - t0 >= size * 0.6) start = t0;
        else { end = Math.min(t1, t0 + size); start = end - size; }
      }
    }
    size = end - start;
  } else {
    const c = lo + len / 2;
    const nc = Math.abs(c - W / 2) <= W * 0.01 ? TW / 2 : mapEdge(c, s0, s1, W, t0, t1, TW);
    start = nc - size / 2;
  }
  if (inside && pin !== "left" && pin !== "top" && pin !== "right" && pin !== "bottom") {
    start = Math.min(Math.max(start, t0), t1 - size);
  }
  return [start, size];
}

/** One axis of a layer that moves with its parent (old interval p0 + plen → new n0 + nlen). */
function inParent(a: number, len: number, p0: number, plen: number, n0: number, nlen: number, k: number): [number, number] {
  const s = nlen / plen;
  const span = len / plen;
  if (span >= 0.9 || Math.abs(s - k) / k < 0.15) return [n0 + (a - p0) * s, len * s];
  const rc = (a + len / 2 - p0) / plen;
  const size = Math.min(len * k, nlen);
  if (rc < 0.4) return [n0 + (a - p0) * Math.min(k, s), size];
  if (rc > 0.6) { const end = n0 + nlen - (p0 + plen - (a + len)) * Math.min(k, s); return [end - size, size]; }
  const nc = n0 + nlen / 2 + (a + len / 2 - (p0 + plen / 2)) * Math.min(k, s);
  return [nc - size / 2, size];
}

const contains = (o: Box, i: Box, slack = 2) => i[0] >= o[0] - slack && i[1] >= o[1] - slack && i[0] + i[2] <= o[0] + o[2] + slack && i[1] + i[3] <= o[1] + o[3] + slack;
const area = (b: Box) => Math.max(0, b[2]) * Math.max(0, b[3]);
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Scales a layer's size-like properties (and its grow limits, shadow and slide distances) by `s`. */
function scaleProps(l: GfxLayer, s: number, keys: string[], maxW: number): void {
  // only positive sizes: -1 / 0 mean "follow the look" and stay as they are
  for (const k of keys) if (typeof l.p[k] === "number" && (l.p[k] as number) > 0) l.p[k] = r2((l.p[k] as number) * s);
  const g = l.p.grow as { pad?: number; min?: number; max?: number } | undefined;
  if (g && typeof g === "object") {
    const n = { ...g };
    if (typeof n.pad === "number") n.pad = r2(n.pad * s);
    if (typeof n.min === "number") n.min = r2(n.min * s);
    if (typeof n.max === "number") n.max = r2(Math.min(n.max * s, maxW));
    l.p.grow = n;
  }
  if (l.shadow) l.shadow = { ...l.shadow, blur: r2(l.shadow.blur * s), x: r2(l.shadow.x * s), y: r2(l.shadow.y * s) };
  for (const ph of ["in", "out"] as const) {
    const st = l.anim?.[ph];
    if (st?.distance !== undefined) l.anim![ph] = { ...st, distance: r2(st.distance * s) };
  }
}

/** The `to` design (9:16 by default) built from the `from` design (16:9 by default). */
export function makeVertical(t: GfxTemplate, o: MakeVerticalOptions = {}): GfxDesign {
  const from = o.from ?? "16:9", to = o.to ?? "9:16";
  const src = t.designs[from] ?? t.designs["16:9"] ?? Object.values(t.designs)[0];
  if (!src) return { layers: [] };
  const { w: W, h: H } = DESIGN[from], { w: TW, h: TH } = DESIGN[to];
  const k = o.scale ?? (to === "9:16" ? 1.15 : 1);
  const S = safeBox(from, src), T = safeBox(to, o.keep);
  const sizeKeys = o.sizeKeys ?? (() => FALLBACK_SIZE_KEYS);
  const fullFrame = (b: Box) => b[2] >= W * 0.9 && b[3] >= H * 0.9;

  // each pin-less layer's parent: the smallest bigger layer that holds it (never a full-frame background)
  const parent = new Map<string, GfxLayer>();
  for (const l of src.layers) {
    if (l.pin) continue;
    let best: GfxLayer | undefined;
    for (const p of src.layers) {
      if (p === l || fullFrame(p.box) || area(p.box) <= area(l.box) * 1.2 || !contains(p.box, l.box)) continue;
      if (!best || area(p.box) < area(best.box)) best = p;
    }
    if (best) parent.set(l.id, best);
  }

  const done = new Map<string, Box>();
  const place = (l: GfxLayer, depth = 0): Box => {
    const have = done.get(l.id);
    if (have) return have;
    const [x, y, w, h] = l.box;
    let nb: Box;
    const p = parent.get(l.id);
    if (p && depth < 16) {
      const pb = place(p, depth + 1);
      const [nx, nw] = inParent(x, w, p.box[0], p.box[2], pb[0], pb[2], k);
      const [ny, nh] = inParent(y, h, p.box[1], p.box[3], pb[1], pb[3], k);
      nb = [nx, ny, nw, nh];
    } else {
      const guess = inferPin(l.box, W, H);
      const px = l.pin?.x ?? guess.x, py = l.pin?.y ?? guess.y;
      const [nx, nw] = axis(x, w, px, k, W, S[0], S[0] + S[2], TW, T[0], T[0] + T[2]);
      const [ny, nh] = axis(y, h, py, k, H, S[1], S[1] + S[3], TH, T[1], T[1] + T[3]);
      nb = [nx, ny, nw, nh];
    }
    nb = [Math.round(nb[0]), Math.round(nb[1]), Math.max(1, Math.round(nb[2])), Math.max(1, Math.round(nb[3]))];
    done.set(l.id, nb);
    return nb;
  };

  const layers: GfxLayer[] = src.layers.map((l) => {
    const n = JSON.parse(JSON.stringify(l)) as GfxLayer;
    n.box = place(l);
    const stretchedY = (l.pin?.y ?? inferPin(l.box, W, H).y) === "stretch" && !parent.has(l.id);
    const s = stretchedY ? k : Math.min(k, Math.max(0.5, n.box[3] / Math.max(1, l.box[3])));
    scaleProps(n, s, sizeKeys(l.kind), T[2]);
    const old = o.keep?.layers.find((x) => x.id === l.id);
    if (old) { if (old.hidden) n.hidden = true; else delete n.hidden; }
    return n;
  });
  if (o.keep) for (const l of o.keep.layers) if (!src.layers.some((x) => x.id === l.id)) layers.push(JSON.parse(JSON.stringify(l)) as GfxLayer);
  return { layers, ...(o.keep?.safe ? { safe: o.keep.safe } : {}) };
}

/** The template with its vertical design (re)built. */
export function withVertical(t: GfxTemplate, o: MakeVerticalOptions = {}): GfxTemplate {
  const to = o.to ?? "9:16";
  const c = JSON.parse(JSON.stringify(t)) as GfxTemplate;
  c.designs[to] = makeVertical(t, { ...o, keep: o.keep ?? t.designs[to] });
  return c;
}
