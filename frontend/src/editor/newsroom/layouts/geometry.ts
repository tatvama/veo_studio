/**
 * Screen layout geometry (docs/EDITOR.md §16.6). Where a layout's box is at a moment (design px), how it comes in,
 * goes out or glides from the previous layout (the morph), and how a picture fills it: Motion position (px), scale (%
 * of the size fitted inside the frame) and crop (% of the picture). The "slot" kind (the holes) and slots.ts (the
 * pictures) both use these, so a hole and its picture always agree to the pixel. Pure.
 */
import { clamp01, easeFn, poseOf } from "../render/anim.ts";
import { DESIGN } from "../templates/kit.ts";
import type { AnimDir, AnimStep, Box, ChannelLook, GfxLayer, GfxRatio, SlotBinding } from "../types.ts";

/** A box as fractions of the frame: x, y (top-left), w, h. */
export type Frac = [number, number, number, number];

/**
 * What the composition adds to a slot layer's `p.morph` when layouts follow each other (slots.ts layoutOverrides),
 * per ratio: glide in from a box, glide out to a box, or hold the box through the out phase (the next layout takes
 * over from here).
 */
export interface SlotMorph {
  from?: Partial<Record<GfxRatio, Frac>>;
  to?: Partial<Record<GfxRatio, Frac>>;
  hold?: Partial<Record<GfxRatio, boolean>>;
}

export type FrameStyle = "none" | "line" | "thick" | "glow" | "rounded";
export type LabelStyle = "plate" | "bar" | "tab" | "minimal";
export type Corner = "tl" | "tr" | "bl" | "br";
export type TagStyle = "live" | "location" | "plain";

/** A slot layer's properties with their defaults (the kind's `props`). */
export interface SlotProps {
  index: number; hole: boolean;
  fill: unknown;
  frame: FrameStyle; frameColor: unknown; frameWidth: number; radius: number; inner: number;
  label: string; sub: string; labelStyle: LabelStyle; labelPos: Corner | "top" | "bottom"; labelSize: number;
  labelFill: unknown; labelColor: unknown;
  tag: string; tagStyle: TagStyle; tagPos: Corner; tagOn: string;
  morph?: SlotMorph;
}

const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function slotProps(layer: Pick<GfxLayer, "p">): SlotProps {
  const p = layer.p ?? {};
  return {
    index: Math.max(0, Math.round(num(p.index, 0))), hole: p.hole !== false,
    fill: p.fill ?? "@dark",
    frame: str(p.frame, "line") as FrameStyle, frameColor: p.frameColor ?? "@light/85", frameWidth: num(p.frameWidth, 0), radius: num(p.radius, 0),
    inner: num(p.inner, 0.35),
    label: str(p.label, ""), sub: str(p.sub, ""), labelStyle: str(p.labelStyle, "plate") as LabelStyle,
    labelPos: str(p.labelPos, "bl") as SlotProps["labelPos"], labelSize: num(p.labelSize, 0),
    labelFill: p.labelFill ?? "@primary", labelColor: p.labelColor ?? "@textOnPrimary",
    tag: str(p.tag, ""), tagStyle: str(p.tagStyle, "live") as TagStyle, tagPos: str(p.tagPos, "tl") as Corner, tagOn: str(p.tagOn, ""),
    morph: p.morph && typeof p.morph === "object" ? (p.morph as SlotMorph) : undefined,
  };
}

// ── boxes ────────────────────────────────────────────────────────────────────

/** A design space (design px): the ratio's standard one (templates/kit.ts DESIGN) or an automatic one. */
export interface Space { w: number; h: number }
export const FULL: Frac = [0, 0, 1, 1];
export const toFrac = (b: Box, d: Space): Frac => [b[0] / d.w, b[1] / d.h, b[2] / d.w, b[3] / d.h];
export const fromFrac = (f: Frac, d: Space): Box => [f[0] * d.w, f[1] * d.h, f[2] * d.w, f[3] * d.h];
export const lerpBox = (a: Box, b: Box, k: number): Box => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
export const sameBox = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
/** The part of `a` inside `b` (zero size when they don't meet). */
export function intersect(a: Box, b: Box): Box {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

/** Glides between layouts: an unhurried in-out, a little softer for smooth looks. */
export function glideEase(x: number, motion: ChannelLook["motion"]): number {
  const t = clamp01(x);
  if (motion === "smooth") return t * t * t * (t * (t * 6 - 15) + 10);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ── a box at a moment ────────────────────────────────────────────────────────

export interface SlotPose {
  /** Where the picture is placed (design px): it fills this box. */
  box: Box;
  /** The part that shows (design px, inside `box`): the hole, and the picture's crop. */
  win: Box;
  /** How see-through the hole is (0..1): fades show the plate over the picture. */
  alpha: number;
  /** 0..1: the frame, label and tag build with the box (and fade as it leaves). */
  deco: number;
  /** True in the out phase: name tags fade whole instead of un-building. */
  leaving?: boolean;
}

/**
 * A slot layer's pose. `inX` is the linear progress of its in step (0 → 1; 1 when it has none), `outX` of its out
 * step (0 until it starts, → 1 as it leaves). A glide (p.morph from / to for this ratio) replaces the step's own
 * motion; otherwise the step's kind moves the box (slide, rise, drop, zoom, pop), reveals it (wipe, grow, unfold,
 * flip) or fades it, eased by the look like every other layer. An out step of kind "hold" keeps the box where it is
 * (only its name tag and frame fade).
 */
export function slotPose(layer: Pick<GfxLayer, "box" | "p" | "anim">, inX: number, outX: number, ratio: GfxRatio, space: Space, motion: ChannelLook["motion"]): SlotPose {
  const base = layer.box;
  const m = slotProps(layer).morph;
  const still: SlotPose = { box: base, win: base, alpha: 1, deco: 1 };
  const a = layer.anim;
  if (outX > 0) {
    const to = m?.to?.[ratio];
    if (to) {
      const box = lerpBox(base, fromFrac(to, space), glideEase(outX, motion));
      return { box, win: box, alpha: 1, deco: clamp01(1 - outX * 2.5), leaving: true };
    }
    if (m?.hold?.[ratio] || a?.out?.kind === "hold") return { ...still, deco: clamp01(1 - outX * 1.5), leaving: true };
    if (a?.out && a.out.kind !== "none") {
      const e = 1 - easeFn(a.out.ease, motion, true)(clamp01(outX));
      return { ...applyStep(a.out, e, base, true, a.in?.dir), leaving: true };
    }
    return still;
  }
  if (inX < 1) {
    const from = m?.from?.[ratio];
    if (from) {
      const box = lerpBox(fromFrac(from, space), base, glideEase(inX, motion));
      return { box, win: box, alpha: 1, deco: clamp01((inX - 0.55) / 0.45) };
    }
    if (a?.in && a.in.kind !== "none") {
      const e = easeFn(a.in.ease, motion, false)(clamp01(inX));
      return applyStep(a.in, e, base, false);
    }
  }
  return still;
}

/** The core's pose of a step (render/anim.ts poseOf) as a box: moves and even scales carry the picture; reveals,
 *  uneven scales and resizes only open the window. */
function applyStep(step: AnimStep, e: number, base: Box, leaving: boolean, inDir?: AnimDir): SlotPose {
  const pose = poseOf(step, e, base, leaving, inDir);
  let [x, y, w, h] = base;
  x += pose.dx; y += pose.dy;
  let box: Box = [x, y, w, h];
  if (pose.sx === pose.sy && pose.sx !== 1) {
    const s = Math.max(0, pose.sx);
    box = [x + (w * (1 - s)) / 2, y + (h * (1 - s)) / 2, w * s, h * s];
  }
  let win: Box = box;
  if (pose.sx !== pose.sy) {
    const sx = clamp01(Math.abs(pose.sx)), sy = clamp01(Math.abs(pose.sy));
    win = [x + (w * (1 - sx)) / 2, y + (h * (1 - sy)) / 2, w * sx, h * sy];
  }
  if (pose.size) {
    const { w: kw, h: kh, ax, ay } = pose.size;
    const nw = w * clamp01(kw), nh = h * clamp01(kh);
    win = intersect(win, [x + (w - nw) * ax, y + (h - nh) * ay, nw, nh]);
  }
  if (pose.reveal) {
    const [x0, y0, x1, y1] = pose.reveal;
    const [bx, by, bw, bh] = box;
    win = intersect(win, [bx + bw * clamp01(x0), by + bh * clamp01(y0), bw * Math.max(0, clamp01(x1) - clamp01(x0)), bh * Math.max(0, clamp01(y1) - clamp01(y0))]);
  }
  return { box, win, alpha: clamp01(pose.alpha), deco: clamp01(e) };
}

// ── a picture in a box ───────────────────────────────────────────────────────

export interface Placement {
  /** Motion position: the picture's centre, frame px. */
  position: [number, number];
  /** Motion scale: % of the size fitted inside the frame. */
  scale: number;
  /** Crop effect: left, right, top, bottom in % of the picture. */
  crop: [number, number, number, number];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** Nothing shows (a box the layout on screen doesn't have, or one not opened yet). */
export const HIDDEN = (W: number, H: number): Placement => ({ position: [r3(W / 2), r3(H / 2)], scale: 0, crop: [0, 0, 0, 0] });

/**
 * A pw×ph picture in a box of a W×H frame (frame px). cover (default) fills the box, contain shows the whole picture
 * inside it; `zoom` (1 = just filling) enlarges it; `offset` (-0.5..0.5 of the picture from its centre) aims it.
 * The picture never uncovers the box it covers (nor leaves a box it fits in). The crop keeps only `win` (default the
 * box), plus `bleed` frame px on every side so no seam shows at the hole's edge.
 */
export function placePicture(box: Box, pic: { w: number; h: number }, W: number, H: number, slot: Pick<SlotBinding, "fit" | "zoom" | "offset">,
  win: Box = box, bleed = 0): Placement {
  const pw = pic.w > 0 ? pic.w : W, ph = pic.h > 0 ? pic.h : H;
  const [bx, by, bw, bh] = box;
  if (!(bw > 0.01 && bh > 0.01) || !(win[2] > 0.01 && win[3] > 0.01)) return HIDDEN(W, H);
  const zoom = Math.max(0.05, slot.zoom ?? 1);
  const k = (slot.fit === "contain" ? Math.min(bw / pw, bh / ph) : Math.max(bw / pw, bh / ph)) * zoom;
  const dw = pw * k, dh = ph * k;
  const [ox, oy] = slot.offset ?? [0, 0];
  const aim = (c: number, size: number, o: number, lo: number, span: number) => {
    const v = c - o * size;
    const a = lo + span - size / 2, b = lo + size / 2;  // covering: [a, b]; inside: [b, a]
    return size >= span ? Math.min(b, Math.max(a, v)) : Math.min(a, Math.max(b, v));
  };
  const cx = aim(bx + bw / 2, dw, ox, bx, bw), cy = aim(by + bh / 2, dh, oy, by, bh);
  const fitK = Math.min(W / pw, H / ph);
  const left = cx - dw / 2, top = cy - dh / 2;
  const e = bleed > 0 && win[2] > 2 * bleed && win[3] > 2 * bleed ? bleed : 0;
  const pct = (v: number, size: number) => Math.min(100, Math.max(0, (v / size) * 100));
  let cl = pct(win[0] - e - left, dw), cr = pct(left + dw - (win[0] + win[2] + e), dw);
  let ct = pct(win[1] - e - top, dh), cb = pct(top + dh - (win[1] + win[3] + e), dh);
  if (cl + cr > 100) { const s = 100 / (cl + cr); cl *= s; cr *= s; }
  if (ct + cb > 100) { const s = 100 / (ct + cb); ct *= s; cb *= s; }
  return { position: [r3(cx), r3(cy)], scale: r4((k / fitK) * 100), crop: [r4(cl), r4(cr), r4(ct), r4(cb)] };
}

/** Design px → frame px as the renderer maps them: the design space fitted and centred in the W×H frame. */
export function designToFrame(b: Box, d: Space, W: number, H: number): Box {
  const k = Math.min(W / d.w, H / d.h), ox = (W - d.w * k) / 2, oy = (H - d.h * k) / 2;
  return [b[0] * k + ox, b[1] * k + oy, b[2] * k, b[3] * k];
}
/** The standard design space of a ratio. */
export const spaceOf = (r: GfxRatio): Space => DESIGN[r];
