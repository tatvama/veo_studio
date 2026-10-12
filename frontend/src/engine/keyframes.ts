/**
 * Keyframed layer properties, mirroring backend/app/pipeline/layers.py sample() (and timeline/keyframes.ts): a
 * property moves between the keyframes that set it and holds before the first / after the last; with no keyframe it
 * keeps the clip's own value. Optional per-segment easing (the keyframe that starts the segment names it).
 */
import { cubicBezier, ease } from "./easing.ts";
import type { KeyEase, Keyframe, KfKey, Param, ParamKey, Transform } from "./types.ts";

export const KF_KEYS: KfKey[] = ["x", "y", "scale", "opacity", "rotation"];
export const KF_DEFAULT: Record<KfKey, number> = { x: 0.5, y: 0.5, scale: 0.35, opacity: 1, rotation: 0 };

/** The value of `key` at `t` seconds into the clip. */
export function sample(kfs: Keyframe[] | undefined, key: KfKey, base: number, t: number): number {
  const pts = (kfs ?? []).filter((k) => typeof k[key] === "number" && Number.isFinite(k[key]));
  if (!pts.length) return base;
  if (t <= pts[0].t) return pts[0][key] as number;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (t <= b.t) {
      const v0 = a[key] as number, v1 = b[key] as number;
      if (b.t - a.t < 1e-9) return v1;
      return v0 + (v1 - v0) * ease(a.easing, (t - a.t) / (b.t - a.t));
    }
  }
  return pts[pts.length - 1][key] as number;
}

/** Every animatable property of a layer clip at `t` seconds into it. */
export function transformAt(tr: Partial<Transform> | undefined, t: number): Record<KfKey, number> {
  const out = {} as Record<KfKey, number>;
  for (const k of KF_KEYS) out[k] = sample(tr?.keyframes, k, tr?.[k] ?? KF_DEFAULT[k], t);
  return out;
}

// ── Param<T>: any keyframed value (motion, effect parameters) ──────────────────────────────────────────────────

/** True for {value, keyframes?} (an effect parameter can also be a plain value). */
export const isParam = (p: unknown): p is Param => !!p && typeof p === "object" && !Array.isArray(p) && "value" in (p as object);

const hexRe = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;
/** "#RRGGBB[AA]" → [r, g, b, a] 0..1 (null otherwise). */
export function parseHex(v: unknown): [number, number, number, number] | null {
  const m = typeof v === "string" ? hexRe.exec(v.trim()) : null;
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
}
const toHex = (c: number[]) => "#" + c.slice(0, 3).map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("");

/** Blend two values of one parameter: numbers and number arrays component-wise, colours in RGB, the rest held. */
export function lerpValue<T>(a: T, b: T, k: number): T {
  if (typeof a === "number" && typeof b === "number") return (a + (b - a) * k) as T;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x) => typeof x === "number"))
    return a.map((x, i) => (x as number) + ((b[i] as number) - (x as number)) * k) as T;
  const ca = parseHex(a), cb = parseHex(b);
  if (ca && cb) return toHex(ca.map((x, i) => x + (cb[i] - x) * k)) as T;
  return (k < 1 ? a : b) as T;
}

const keyTime = (k: ParamKey, fps: number) => (typeof k.t === "number" ? k.t : (k.frame ?? 0) / (fps || 24));
const shape = (e: KeyEase | undefined, x: number) => (e === "hold" ? 0 : ease(e, x));
const pair = (v: unknown): [number, number] | null =>
  Array.isArray(v) && v.length >= 2 && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1])) ? [Number(v[0]), Number(v[1])] : null;

/** The eased position 0..1 (or beyond, for bezier overshoot) of a segment from key `a` to key `b` at x (0..1). */
export function segmentEase(a: ParamKey, b: ParamKey, x: number): number {
  if (a.ease === "bezier") {
    const o = pair(a.out) ?? [1 / 3, 1 / 3], i = pair(b.in) ?? [2 / 3, 2 / 3];
    return cubicBezier(o[0], o[1], i[0], i[1], x);
  }
  return shape(a.ease, x);
}

/** A segment between two values at eased position k: numbers and arrays linearly, or along the spatial cubic when
 *  the keys carry tangents (number arrays of the same length). */
function segmentValue<T>(a: ParamKey<T>, b: ParamKey<T>, k: number): T {
  const va = a.value, vb = b.value;
  const to = a.tangentOut, ti = b.tangentIn;
  if ((to || ti) && Array.isArray(va) && Array.isArray(vb) && va.length === vb.length && va.every((x) => typeof x === "number") && vb.every((x) => typeof x === "number")) {
    const u = Math.min(1, Math.max(0, k)), w = 1 - u;
    return va.map((p0, j) => {
      const p3 = vb[j] as number, p1 = (p0 as number) + (Number(to?.[j]) || 0), p2 = p3 + (Number(ti?.[j]) || 0);
      return w * w * w * (p0 as number) + 3 * w * w * u * p1 + 3 * w * u * u * p2 + u * u * u * p3;
    }) as T;
  }
  return lerpValue(va, vb, k);
}

/** The value of a parameter `t` seconds into its clip (held before the first key and after the last). */
export function paramAt<T>(p: Param<T> | T | undefined, t: number, fps = 24): T | undefined {
  if (!isParam(p)) return p as T | undefined;
  const ks = (p.keyframes ?? []).filter((k) => k && "value" in k);
  if (!ks.length) return p.value as T;
  const ts = ks.map((k) => keyTime(k, fps));
  const order = ts.map((_, i) => i).sort((a, b) => ts[a] - ts[b]);
  if (t <= ts[order[0]]) return ks[order[0]].value as T;
  for (let j = 1; j < order.length; j++) {
    const a = order[j - 1], b = order[j];
    if (t < ts[b]) {
      const span = ts[b] - ts[a];
      return span <= 1e-9 ? (ks[b].value as T) : segmentValue(ks[a] as ParamKey<T>, ks[b] as ParamKey<T>, segmentEase(ks[a], ks[b], (t - ts[a]) / span));
    }
  }
  return ks[order[order.length - 1]].value as T;
}

/** True when the parameter changes over time (has two or more keyframes). */
export const isAnimated = (p: unknown) => isParam(p) && (p.keyframes?.length ?? 0) > 1;
