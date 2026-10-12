/**
 * Keyframe curves and speed ramps for the export mix, ported from the editor's own model so the sound follows exactly
 * what the timeline shows (frontend/src/editor/model/params.ts `ease` / `segmentProgress` / `valueAt`, bezier.ts
 * `cubicBezier` / `bounceOut` / `elasticOut`, remap.ts `rampSpan` / `rampPieces`; same maths, numbers only).
 *
 * Easings: ease_in t³, ease_out 1 − (1 − t)³, ease_in_out the cubic in-out, hold, bezier (the keyframe's `out` and the
 * next one's `in` handles, CSS cubic-bezier semantics), bounce and elastic (ease-out presets).
 * Speed ramps: `TimelineClip.timeRemap` is the speed in % of the clip's speed over clip frames; `rampPieces` cuts a clip
 * into constant-speed pieces (freezes are their own pieces) whose speeds are their exact averages.
 * Pure (test/editor-audio.test.ts).
 */
import type { Easing, Keyframe, Param } from "../shared/types.ts";

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : Number.isFinite(v) ? v : 0);
export const LINEAR_OUT: [number, number] = [1 / 3, 1 / 3];
export const LINEAR_IN: [number, number] = [2 / 3, 2 / 3];

function coeffs(p1: number, p2: number) {
  const c = 3 * p1;
  const b = 3 * (p2 - p1) - c;
  return { a: 1 - c - b, b, c };
}
const sample = (k: { a: number; b: number; c: number }, t: number) => ((k.a * t + k.b) * t + k.c) * t;
const slope = (k: { a: number; b: number; c: number }, t: number) => (3 * k.a * t + 2 * k.b) * t + k.c;

/** The curve parameter t where the bezier's x equals `x` (Newton, then bisection). */
export function solveT(x1: number, x2: number, x: number): number {
  const X = coeffs(clamp01(x1), clamp01(x2));
  const tx = clamp01(x);
  let t = tx;
  for (let i = 0; i < 8; i++) {
    const e = sample(X, t) - tx;
    if (Math.abs(e) < 1e-7) return t;
    const d = slope(X, t);
    if (Math.abs(d) < 1e-6) break;
    t -= e / d;
  }
  let lo = 0;
  let hi = 1;
  t = tx;
  for (let i = 0; i < 60; i++) {
    const v = sample(X, t);
    if (Math.abs(v - tx) < 1e-7) return t;
    if (v < tx) lo = t; else hi = t;
    t = (lo + hi) / 2;
  }
  return t;
}

/** cubic-bezier(x1, y1, x2, y2) at time fraction x. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  return sample(coeffs(y1, y2), solveT(x1, x2, x));
}

export function bounceOut(x: number): number {
  let t = clamp01(x);
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) { t -= 1.5 / d; return n * t * t + 0.75; }
  if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + 0.9375; }
  t -= 2.625 / d;
  return n * t * t + 0.984375;
}

export function elasticOut(x: number): number {
  const t = clamp01(x);
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
}

/** Progress 0..1 of an ease kind at time fraction x ("bezier" needs its handles: segmentProgress). */
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

export function segmentProgress<T>(a: Keyframe<T>, b: Keyframe<T>, x: number): number {
  if (a.ease === "bezier") {
    const o = a.out ?? LINEAR_OUT;
    const i = b.in ?? LINEAR_IN;
    return cubicBezier(o[0], o[1], i[0], i[1], x);
  }
  return ease(a.ease, x);
}

/** A number param at a frame (held before the first keyframe and after the last). Keyframes must be sorted. */
export function valueAt(p: Param<number>, frame: number): number {
  const ks = p.keyframes;
  if (!ks?.length) return Number(p.value) || 0;
  if (frame <= ks[0].frame) return Number(ks[0].value);
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1];
    const b = ks[i];
    if (frame < b.frame) {
      const span = b.frame - a.frame;
      if (span <= 0) return Number(b.value);
      const pr = segmentProgress(a, b, (frame - a.frame) / span);
      return Number(a.value) + (Number(b.value) - Number(a.value)) * pr;
    }
  }
  return Number(ks[ks.length - 1].value);
}

/** Easings an FFmpeg expression draws as they are (the others are sampled into straight pieces). */
export const EXPR_EASINGS = new Set<Easing>(["linear", "ease_in", "ease_out", "ease_in_out", "hold"]);
const DENSE = 16;

/**
 * Keyframes (frame-sorted copies) → [seconds, value, ease] points for pwlExpr: frame / fps + shift. Segments with a
 * bezier, bounce or elastic ease become 16 straight pieces each (their exact values at those points).
 */
export function keyPoints(ks: Keyframe<number>[], fps: number, shift = 0): [number, number, Easing][] {
  const k = [...ks].filter((x) => Number.isFinite(x?.frame) && Number.isFinite(Number(x?.value))).sort((a, b) => a.frame - b.frame);
  const out: [number, number, Easing][] = [];
  const sec = (f: number) => f / (fps || 1) + shift;
  for (let i = 0; i < k.length; i++) {
    const a = k[i];
    const b = k[i + 1];
    const e: Easing = a.ease ?? "linear";
    if (!b || EXPR_EASINGS.has(e)) { out.push([sec(a.frame), Number(a.value), e]); continue; }
    const p: Param<number> = { value: Number(a.value), keyframes: [a, b] as Keyframe<number>[] };
    for (let j = 0; j < DENSE; j++) {
      const f = a.frame + ((b.frame - a.frame) * j) / DENSE;
      out.push([sec(f), valueAt(p, f), "linear"]);
    }
  }
  return out;
}

// ── speed ramps (remap.ts) ──

export const RAMP_MAX = 1000;
export const FREEZE_BELOW = 0.02;
const SUB = 8;

/** The speed multiplier (1 = the clip's speed) of a ramp at clip frame f. */
export const rampAt = (p: Param<number>, f: number) => Math.max(0, Math.min(RAMP_MAX, valueAt(p, f) || 0)) / 100;

function sorted(p: Param<number>): Param<number> {
  return p.keyframes?.length ? { ...p, keyframes: [...p.keyframes].sort((a, b) => a.frame - b.frame) } : p;
}

/** ∫ₐᵇ ramp in speed-frames (midpoint rule, 8 steps a frame; the speed holds before 0 and after the last keyframe). */
export function rampSpan(p0: Param<number>, a: number, b: number): number {
  if (b < a) return -rampSpan(p0, b, a);
  const p = sorted(p0);
  const ks = p.keyframes ?? [];
  const L = Math.max(0, Math.ceil(ks.length ? ks[ks.length - 1].frame : 0));
  const cum: number[] = [0];
  const cumTo = (n: number) => {
    while (cum.length <= n) {
      const i = cum.length - 1;
      let s = 0;
      for (let k = 0; k < SUB; k++) s += rampAt(p, i + (k + 0.5) / SUB);
      cum.push(cum[i] + s / SUB);
    }
    return cum;
  };
  const F = (x: number): number => {
    if (x <= 0) return x * rampAt(p, 0);
    if (x >= L) { const t = cumTo(L); return t[L] + (x - L) * rampAt(p, L + 0.5); }
    const i = Math.floor(x);
    const t = cumTo(i + 1);
    return t[i] + (x - i) * (t[i + 1] - t[i]);
  };
  return F(b) - F(a);
}

export const hasRamp = (c: { timeRemap?: Param<number> }) => !!c.timeRemap && (!!c.timeRemap.keyframes?.length || Math.abs(Number(c.timeRemap.value) - 100) > 1e-6);

export interface RampPiece { from: number; to: number; offset: number; speed: number; freeze: boolean }

/** The clip as constant-speed pieces (remap.ts rampPieces: tolerance 5 %, at most 12 pieces, growing the tolerance). */
export function rampPieces(c: { timeRemap?: Param<number>; duration: number }, opts: { tolerance?: number; maxPieces?: number } = {}): RampPiece[] {
  const D = Math.max(1, Math.round(c.duration));
  if (!c.timeRemap) return [{ from: 0, to: D, offset: 0, speed: 1, freeze: false }];
  const p = sorted(c.timeRemap);
  // per-frame integrals (the same midpoint rule as rampSpan) and their prefix sums: O(D)
  const per = Array.from({ length: D }, (_, f) => { let v = 0; for (let k = 0; k < SUB; k++) v += rampAt(p, f + (k + 0.5) / SUB); return v / SUB; });
  const pre = [0];
  for (let f = 0; f < D; f++) pre.push(pre[f] + per[f]);
  let tol = opts.tolerance ?? 0.05;
  const max = Math.max(1, opts.maxPieces ?? 12);
  for (;;) {
    const out: RampPiece[] = [];
    let a = 0;
    while (a < D) {
      const frozen = per[a] < FREEZE_BELOW;
      let lo = per[a];
      let hi = per[a];
      let b = a + 1;
      while (b < D) {
        const v = per[b];
        if ((v < FREEZE_BELOW) !== frozen) break;
        const nlo = Math.min(lo, v);
        const nhi = Math.max(hi, v);
        if (!frozen && nhi - nlo > tol * Math.max(nhi, 0.05)) break;
        lo = nlo; hi = nhi; b++;
      }
      const span = pre[b] - pre[a];
      out.push({ from: a, to: b, offset: pre[a], speed: frozen ? 0 : span / (b - a), freeze: frozen });
      a = b;
    }
    if (out.length <= max || tol > 4) return out;
    tol *= 1.6;
  }
}
