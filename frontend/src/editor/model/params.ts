/**
 * Animatable parameters: evaluate a Param at a clip-relative frame and the keyframe operations (stopwatch, add,
 * move, remove, ease). Numbers and number tuples interpolate; anything else holds. Pure, immutable.
 */
import { bounceOut, cubicBezier, elasticOut, LINEAR_IN, LINEAR_OUT, spatialPoint, splitBezier, splitSpatial } from "./bezier.ts";
import type { Easing, Keyframe, Param, TimelineClip } from "./types.ts";

/** Progress 0..1 of an ease kind at time fraction x ("bezier" needs its handles: see segmentProgress). */
export function ease(kind: Easing | undefined, x: number): number {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  switch (kind) {
    case "ease_in": return t * t * t;
    case "ease_out": { const u = 1 - t; return 1 - u * u * u; }
    case "ease_in_out": return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case "hold": return 0;
    case "bounce": return bounceOut(t);
    case "elastic": return elasticOut(t);
    default: return t;
  }
}

/** Progress of the segment a → b at time fraction x: a's ease, a bezier through a.out and b.in. */
export function segmentProgress<T>(a: Keyframe<T>, b: Keyframe<T>, x: number): number {
  if (a.ease === "bezier") {
    const o = a.out ?? LINEAR_OUT, i = b.in ?? LINEAR_IN;
    return cubicBezier(o[0], o[1], i[0], i[1], x);
  }
  return ease(a.ease, x);
}

const numArr = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === "number");
/** True when the segment a → b follows a spatial curve (position keyframes with tangents). */
const spatial = <T>(a: Keyframe<T>, b: Keyframe<T>) => !!(a.tangentOut || b.tangentIn) && numArr(a.value) && numArr(b.value) && a.value.length === (b.value as number[]).length;

function lerp<T>(a: T, b: T, p: number): T {
  if (typeof a === "number" && typeof b === "number") return (a + (b - a) * p) as T;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v) => typeof v === "number")) {
    return a.map((v: number, i) => v + ((b[i] as number) - v) * p) as T;
  }
  return (p < 1 ? a : b);
}

/** The value between two keyframes at progress p (straight, or along the motion path's curve — which, like the
 *  engine's, stays between its ends when an ease overshoots). */
export function interpolate<T>(a: Keyframe<T>, b: Keyframe<T>, p: number): T {
  if (a.ease !== "hold" && spatial(a, b)) return spatialPoint(a.value as number[], a.tangentOut, b.tangentIn, b.value as number[], Math.min(1, Math.max(0, p))) as T;
  return lerp(a.value, b.value, p);
}

export const isAnimated = (p: Param<unknown> | undefined) => !!p?.keyframes?.length;

/** The value at `frame` (clip-relative): between keyframes eased by the earlier one, held outside them. */
export function valueAt<T>(p: Param<T>, frame: number): T {
  const ks = p.keyframes;
  if (!ks?.length) return p.value;
  if (frame <= ks[0].frame) return ks[0].value;
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1], b = ks[i];
    if (frame < b.frame) {
      const span = b.frame - a.frame;
      return span <= 0 ? b.value : interpolate(a, b, segmentProgress(a, b, (frame - a.frame) / span));
    }
  }
  return ks[ks.length - 1].value;
}

/**
 * The handles and tangents a new keyframe at `frame` needs so the curve keeps its shape: the segment it falls in is
 * split in two (bezier handles and motion-path tangents). Returns the patched neighbours and the new key's extras.
 */
function splitAt<T>(ks: Keyframe<T>[], frame: number): { prev?: Keyframe<T>; next?: Keyframe<T>; key: Partial<Keyframe<T>> } {
  const j = ks.findIndex((k) => k.frame > frame);
  if (j <= 0) return { key: {} };
  const a = ks[j - 1], b = ks[j];
  if (a.frame >= frame) return { key: {} };
  const x = (frame - a.frame) / (b.frame - a.frame);
  const prev: Keyframe<T> = { ...a }, next: Keyframe<T> = { ...b }, key: Partial<Keyframe<T>> = {};
  if (a.ease === "bezier") {
    const sp = splitBezier(a.out ?? LINEAR_OUT, b.in ?? LINEAR_IN, x);
    prev.out = sp.left.out; key.in = sp.left.in; key.ease = "bezier"; key.out = sp.right.out; next.in = sp.right.in;
  }
  if (a.ease !== "hold" && spatial(a, b)) {
    const ss = splitSpatial(a.value as number[], a.tangentOut, b.tangentIn, b.value as number[], segmentProgress(a, b, x));
    prev.tangentOut = ss.leftOut; key.tangentIn = ss.leftIn; key.tangentOut = ss.rightOut; next.tangentIn = ss.rightIn;
  }
  return { prev, next, key };
}

const sortK = <T>(ks: Keyframe<T>[]) => [...ks].sort((a, b) => a.frame - b.frame);

/** Sets the value: with the stopwatch on, adds or replaces the keyframe at `frame`; else the static value. */
export function setParam<T>(p: Param<T>, value: T, frame: number): Param<T> {
  if (!p.keyframes?.length) return { ...p, value };
  return addKeyframe(p, frame, value);
}

export function addKeyframe<T>(p: Param<T>, frame: number, value: T = valueAt(p, frame), ease: Easing = "linear"): Param<T> {
  const f = Math.round(frame);
  const ks = p.keyframes ?? [];
  const at = ks.findIndex((k) => k.frame === f);
  if (at >= 0) return { ...p, keyframes: ks.map((k, i) => (i === at ? { ...k, value } : k)) };
  // inside a bezier / curved segment: split it so the curve keeps its shape
  const sp = splitAt(ks, f);
  const list = ks.map((k) => (sp.prev && k.frame === sp.prev.frame ? sp.prev : sp.next && k.frame === sp.next.frame ? sp.next : k));
  return { ...p, keyframes: sortK([...list, { frame: f, value, ease, ...sp.key }]) };
}

export function removeKeyframe<T>(p: Param<T>, frame: number): Param<T> {
  const ks = (p.keyframes ?? []).filter((k) => k.frame !== Math.round(frame));
  if (!ks.length) return { value: valueAt(p, frame) };
  return { ...p, keyframes: ks };
}

/** Moves the keyframe at `from` to `to` (replacing one already there). */
export function moveKeyframe<T>(p: Param<T>, from: number, to: number): Param<T> {
  const ks = p.keyframes ?? [];
  const k = ks.find((x) => x.frame === from);
  if (!k || from === to) return p;
  const rest = ks.filter((x) => x !== k && x.frame !== Math.round(to));
  return { ...p, keyframes: sortK([...rest, { ...k, frame: Math.round(to) }]) };
}

export function setKeyframeEase<T>(p: Param<T>, frame: number, e: Easing): Param<T> {
  if (!p.keyframes) return p;
  return { ...p, keyframes: p.keyframes.map((k) => (k.frame === frame ? { ...k, ease: e } : k)) };
}

/** The stopwatch: on puts a keyframe at `frame` with the current value; off keeps the value at `frame` and drops them. */
export function toggleStopwatch<T>(p: Param<T>, frame: number): Param<T> {
  if (p.keyframes?.length) return { value: valueAt(p, frame) };
  return { value: p.value, keyframes: [{ frame: Math.round(frame), value: p.value, ease: "linear" }] };
}

export function nextKeyframe(p: Param<unknown>, frame: number): number | null {
  const k = (p.keyframes ?? []).find((x) => x.frame > frame);
  return k ? k.frame : null;
}
export function prevKeyframe(p: Param<unknown>, frame: number): number | null {
  const ks = (p.keyframes ?? []).filter((x) => x.frame < frame);
  return ks.length ? ks[ks.length - 1].frame : null;
}

/**
 * The part of a param from clip frame `from` on (a razor's right half, a trimmed start): keyframes shift by -from;
 * when the cut falls between keyframes a keyframe with the value there is added, so the animation looks the same.
 */
export function sliceParam<T>(p: Param<T>, from: number, to: number): Param<T> {
  const ks = p.keyframes;
  if (!ks?.length) return p;
  const first = ks[0].frame, last = ks[ks.length - 1].frame;
  let list = ks;
  // a cut inside a segment becomes a keyframe there (bezier handles and path tangents split, so the look stays)
  const cut = (f: number, tail: boolean) => {
    if (list.some((k) => k.frame === f)) return;
    const sp = splitAt(list, f);
    const prev = [...list].reverse().find((k) => k.frame < f);
    const key: Keyframe<T> = { frame: f, value: valueAt(p, f), ease: tail ? "linear" : prev?.ease ?? "linear", ...sp.key };
    if (tail) { delete key.out; delete key.tangentOut; key.ease = "linear"; } else { delete key.in; delete key.tangentIn; }
    list = sortK([...list.map((k) => (sp.prev && k.frame === sp.prev.frame ? (tail ? sp.prev : k) : sp.next && k.frame === sp.next.frame ? (tail ? k : sp.next) : k)), key]);
  };
  if (from > first) cut(from, false);
  if (to < last) cut(to, true);
  const out: Keyframe<T>[] = list.filter((k) => k.frame >= from && k.frame <= to).map((k) => ({ ...k, frame: k.frame - from }));
  if (!out.length) return { value: valueAt(p, from) };
  return { value: p.value, keyframes: out };
}

/** Shifts every keyframe by `delta` frames (a clip's start trimmed or slipped against its keyframes). */
export function shiftParam<T>(p: Param<T>, delta: number): Param<T> {
  if (!p.keyframes?.length || !delta) return p;
  return { ...p, keyframes: p.keyframes.map((k) => ({ ...k, frame: k.frame + delta })) };
}

/** Scales keyframe times (rate stretch). */
export function scaleParam<T>(p: Param<T>, k: number): Param<T> {
  if (!p.keyframes?.length || k === 1) return p;
  return { ...p, keyframes: p.keyframes.map((x) => ({ ...x, frame: Math.round(x.frame * k) })) };
}

// ── addressing a clip's params by path ─────────────────────────────────────
// "motion.position" | "motion.scale" | "motion.rotation" | "motion.anchor" | "motion.opacity" | "audio.gain" |
// "audio.pan" | "fx.<effect id>.<param>" | "timeRemap"

export type ParamPath = string;

export function getParam(c: TimelineClip, path: ParamPath): Param<unknown> | undefined {
  const [a, b, d] = path.split(".");
  if (a === "motion") return (c.motion as unknown as Record<string, Param<unknown>>)[b];
  if (a === "audio") return c.audio ? (c.audio as unknown as Record<string, Param<unknown>>)[b] : undefined;
  if (a === "fx") return c.effects.find((e) => e.id === b)?.params[d];
  if (a === "timeRemap") return c.timeRemap;
  return undefined;
}

export function withParam(c: TimelineClip, path: ParamPath, fn: (p: Param<unknown>) => Param<unknown>): TimelineClip {
  const [a, b, d] = path.split(".");
  if (a === "motion") {
    const cur = (c.motion as unknown as Record<string, Param<unknown>>)[b];
    if (!cur) return c;
    return { ...c, motion: { ...c.motion, [b]: fn(cur) } };
  }
  if (a === "audio" && c.audio) {
    const cur = (c.audio as unknown as Record<string, Param<unknown>>)[b];
    if (!cur) return c;
    return { ...c, audio: { ...c.audio, [b]: fn(cur) } };
  }
  if (a === "fx") {
    return { ...c, effects: c.effects.map((e) => (e.id === b && e.params[d] ? { ...e, params: { ...e.params, [d]: fn(e.params[d]) } } : e)) };
  }
  if (a === "timeRemap" && c.timeRemap) return { ...c, timeRemap: fn(c.timeRemap) as Param<number> };
  return c;
}

/** Every animatable param of a clip, with its path. */
export function clipParams(c: TimelineClip): { path: ParamPath; param: Param<unknown> }[] {
  const out: { path: ParamPath; param: Param<unknown> }[] = [];
  for (const k of ["position", "scale", "rotation", "anchor", "opacity"] as const) out.push({ path: `motion.${k}`, param: c.motion[k] as Param<unknown> });
  if (c.audio) { out.push({ path: "audio.gain", param: c.audio.gain }); out.push({ path: "audio.pan", param: c.audio.pan }); }
  for (const e of c.effects) for (const [k, p] of Object.entries(e.params)) out.push({ path: `fx.${e.id}.${k}`, param: p });
  if (c.timeRemap) out.push({ path: "timeRemap", param: c.timeRemap });
  return out;
}

/** Applies `fn` to every param of a clip (slice, shift, scale). */
export function mapParams(c: TimelineClip, fn: (p: Param<unknown>) => Param<unknown>): TimelineClip {
  let out: TimelineClip = {
    ...c,
    motion: { ...c.motion, position: fn(c.motion.position) as Param<[number, number]>, scale: fn(c.motion.scale) as Param<number>,
      rotation: fn(c.motion.rotation) as Param<number>, anchor: fn(c.motion.anchor) as Param<[number, number]>, opacity: fn(c.motion.opacity) as Param<number> },
    effects: c.effects.map((e) => ({ ...e, params: Object.fromEntries(Object.entries(e.params).map(([k, p]) => [k, fn(p)])) })),
  };
  if (c.audio) out = { ...out, audio: { ...c.audio, gain: fn(c.audio.gain) as Param<number>, pan: fn(c.audio.pan) as Param<number> } };
  if (c.timeRemap) out = { ...out, timeRemap: fn(c.timeRemap) as Param<number> };
  return out;
}
