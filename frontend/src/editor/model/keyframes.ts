/**
 * Keyframe editing for the graph editor and Effect Controls (editor-motion): several keyframes at once — ease presets
 * (bezier handles included), auto-bezier, moving in time and value, deleting, copy and paste, handle drags — and the
 * speed (rate of change) the speed graph draws. Frames are clip-relative. Pure, immutable.
 */
import { autoBezierHandles, EASE_PRESETS, LINEAR_IN, LINEAR_OUT, type EasePresetId, type Vec2 } from "./bezier.ts";
import { valueAt } from "./params.ts";
import type { Keyframe, Param } from "./types.ts";

const sortK = <T>(ks: Keyframe<T>[]) => [...ks].sort((a, b) => a.frame - b.frame);
const keysOf = <T>(p: Param<T>) => p.keyframes ?? [];

/** The ease preset on the segments that start at `frames` (all keys when omitted). */
export function applyEasePreset<T>(p: Param<T>, frames: number[] | undefined, id: EasePresetId): Param<T> {
  const pr = EASE_PRESETS.find((x) => x.id === id);
  const ks = keysOf(p);
  if (!pr || !ks.length) return p;
  const sel = new Set(frames ?? ks.map((k) => k.frame));
  const out = ks.map((k) => ({ ...k }));
  for (let i = 0; i < out.length; i++) {
    if (!sel.has(out[i].frame)) continue;
    out[i].ease = pr.ease;
    if (pr.ease === "bezier") {
      out[i].out = pr.out ?? LINEAR_OUT;
      if (out[i + 1]) out[i + 1].in = pr.in ?? LINEAR_IN;
    } else delete out[i].out;
  }
  return { ...p, keyframes: out };
}

/** Smooth bezier handles (autoBezierHandles) on the segments that start at `frames` (all when omitted). */
export function autoBezier<T>(p: Param<T>, frames?: number[]): Param<T> {
  const ks = keysOf(p);
  if (ks.length < 2 || !ks.every((k) => typeof k.value === "number" || Array.isArray(k.value))) return p;
  const h = autoBezierHandles(ks.map((k) => ({ frame: k.frame, value: k.value as unknown as number | number[] })));
  const sel = new Set(frames ?? ks.map((k) => k.frame));
  const out = ks.map((k) => ({ ...k }));
  for (let i = 0; i < out.length - 1; i++) {
    if (!sel.has(out[i].frame)) continue;
    out[i].ease = "bezier"; out[i].out = h[i].out; out[i + 1].in = h[i].in;
  }
  return { ...p, keyframes: out };
}

/** Moves the keyframes at `frames` by `df` frames and adds `dv` to their values (a number, or one per component).
 *  A moved key replaces one already at its new frame. */
export function moveKeys<T>(p: Param<T>, frames: number[], df: number, dv: number | number[] = 0): Param<T> {
  const ks = keysOf(p);
  if (!ks.length || !frames.length) return p;
  const sel = new Set(frames);
  const d = Math.round(df);
  const add = (v: T): T => {
    if (typeof v === "number") return (v + (typeof dv === "number" ? dv : dv[0] ?? 0)) as T;
    if (Array.isArray(v)) return v.map((x, i) => (typeof x === "number" ? x + (typeof dv === "number" ? dv : dv[i] ?? 0) : x)) as T;
    return v;
  };
  const moved = ks.filter((k) => sel.has(k.frame)).map((k) => ({ ...k, frame: k.frame + d, value: (dv === 0 ? k.value : add(k.value)) }));
  const to = new Set(moved.map((k) => k.frame));
  const rest = ks.filter((k) => !sel.has(k.frame) && !to.has(k.frame));
  return { ...p, keyframes: sortK([...rest, ...moved]) };
}

/** Removes the keyframes at `frames` (none left: the value where the first one was). */
export function deleteKeys<T>(p: Param<T>, frames: number[]): Param<T> {
  const sel = new Set(frames);
  const ks = keysOf(p).filter((k) => !sel.has(k.frame));
  if (ks.length) return { ...p, keyframes: ks };
  return { value: valueAt(p, frames[0] ?? 0) };
}

/** The keyframes at `frames`, relative to the first (what Ctrl+C in the graph editor keeps). */
export function copyKeys<T>(p: Param<T>, frames: number[]): Keyframe<T>[] {
  const sel = new Set(frames);
  const ks = keysOf(p).filter((k) => sel.has(k.frame));
  if (!ks.length) return [];
  const f0 = ks[0].frame;
  return ks.map((k) => ({ ...k, frame: k.frame - f0 }));
}

/** Pastes copied keyframes with the first at `at` (replacing keys on those frames; the stopwatch turns on). */
export function pasteKeys<T>(p: Param<T>, keys: Keyframe<T>[], at: number): Param<T> {
  if (!keys.length) return p;
  const placed = keys.map((k) => ({ ...k, frame: Math.round(at + k.frame) }));
  const to = new Set(placed.map((k) => k.frame));
  return { ...p, keyframes: sortK([...keysOf(p).filter((k) => !to.has(k.frame)), ...placed]) };
}

/** Sets the bezier handle leaving (`out`) or arriving at (`in`) the keyframe at `frame`; with `mirror` the key's other
 *  handle turns with it (a smooth key), keeping its own length. */
export function setHandle<T>(p: Param<T>, frame: number, side: "out" | "in", h: Vec2, opts: { mirror?: boolean } = {}): Param<T> {
  const ks = keysOf(p);
  const i = ks.findIndex((k) => k.frame === frame);
  if (i < 0) return p;
  const out = ks.map((k) => ({ ...k }));
  const x = Math.max(0, Math.min(1, h[0]));
  if (side === "out") {
    if (!out[i + 1]) return p;
    out[i].ease = "bezier"; out[i].out = [x, h[1]];
    if (opts.mirror && out[i - 1]) {
      // the incoming handle of the same key, on the segment before it, along the same slope
      const a = out[i - 1], b = out[i], c = out[i + 1];
      const slope = segSlope(b, c, [x, h[1]]);
      const dt = b.frame - a.frame, dv = num(b.value) - num(a.value);
      const len = 1 - (b.in ?? LINEAR_IN)[0];
      if (Math.abs(dv) > 1e-9) { a.ease = "bezier"; a.out ??= LINEAR_OUT; b.in = [1 - len, 1 - (slope * len * dt) / dv]; }
    }
  } else {
    if (!out[i - 1]) return p;
    out[i - 1].ease = "bezier"; out[i - 1].out ??= LINEAR_OUT; out[i].in = [x, h[1]];
  }
  return { ...p, keyframes: out };
}

const num = (v: unknown) => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : 0);
/** Value per frame leaving key b along handle h towards c. */
function segSlope<T>(b: Keyframe<T>, c: Keyframe<T>, h: Vec2): number {
  const dt = c.frame - b.frame, dv = num(c.value) - num(b.value);
  return h[0] > 1e-6 && dt > 0 ? (h[1] / h[0]) * (dv / dt) : 0;
}

/** Rate of change at clip frame `f`, per frame: signed for numbers, the length of the change for pairs. */
export function speedAt<T>(p: Param<T>, f: number, h = 0.25): number {
  const a = valueAt(p, f - h), b = valueAt(p, f + h);
  if (typeof a === "number" && typeof b === "number") return (b - a) / (2 * h);
  if (Array.isArray(a) && Array.isArray(b)) return Math.hypot(...a.map((x, i) => (Number(b[i]) - Number(x)))) / (2 * h);
  return 0;
}
