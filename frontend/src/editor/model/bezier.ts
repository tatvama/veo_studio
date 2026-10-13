/**
 * Keyframe curve maths (editor-motion): cubic-bezier easing (CSS cubic-bezier semantics: handles are fractions of a
 * segment's time and change), the bounce / elastic presets, splitting a bezier segment in two (a razor through an
 * eased segment keeps its look), spatial bezier paths for positions, auto-bezier handles and the ease presets the
 * graph editor offers. Pure, no imports.
 */

export type Vec2 = [number, number];

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : Number.isFinite(v) ? v : 0);

/** The straight segment's handles: cubic-bezier(1/3, 1/3, 2/3, 2/3) is linear. */
export const LINEAR_OUT: Vec2 = [1 / 3, 1 / 3];
export const LINEAR_IN: Vec2 = [2 / 3, 2 / 3];

function coeffs(p1: number, p2: number) {
  const c = 3 * p1, b = 3 * (p2 - p1) - c, a = 1 - c - b;
  return { a, b, c };
}
const sample = (k: { a: number; b: number; c: number }, t: number) => ((k.a * t + k.b) * t + k.c) * t;
const slope = (k: { a: number; b: number; c: number }, t: number) => (3 * k.a * t + 2 * k.b) * t + k.c;

/** The curve parameter t where the bezier's x equals `x` (x1, x2 are clamped to 0..1, so x is monotone in t). */
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
  let lo = 0, hi = 1;
  t = tx;
  for (let i = 0; i < 60; i++) {
    const v = sample(X, t);
    if (Math.abs(v - tx) < 1e-7) return t;
    if (v < tx) lo = t; else hi = t;
    t = (lo + hi) / 2;
  }
  return t;
}

/** cubic-bezier(x1, y1, x2, y2) at time fraction x: the progress (0 at 0, 1 at 1; may overshoot between). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const t = solveT(x1, x2, x);
  return sample(coeffs(y1, y2), t);
}

/** d(progress)/d(time fraction) of a bezier segment at x (the speed graph). */
export function cubicBezierSlope(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const t = solveT(x1, x2, clamp01(x));
  const dx = slope(coeffs(clamp01(x1), clamp01(x2)), t), dy = slope(coeffs(y1, y2), t);
  return Math.abs(dx) < 1e-9 ? (dy >= 0 ? 1e6 : -1e6) : dy / dx;
}

/** Robert Penner's ease-out bounce. */
export function bounceOut(x: number): number {
  let t = clamp01(x);
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) { t -= 1.5 / d; return n * t * t + 0.75; }
  if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + 0.9375; }
  t -= 2.625 / d;
  return n * t * t + 0.984375;
}

/** Ease-out elastic (one and a half wobbles past the target). */
export function elasticOut(x: number): number {
  const t = clamp01(x);
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
}

const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * Splits the easing segment cubic-bezier(out, in) at time fraction x: the handles of the left part (0..x) and the
 * right part (x..1), each normalised to its own segment, plus the progress at the cut.
 */
export function splitBezier(out: Vec2, inn: Vec2, x: number): { left: { out: Vec2; in: Vec2 }; right: { out: Vec2; in: Vec2 }; progress: number } {
  const o: Vec2 = [clamp01(out[0]), out[1]], i: Vec2 = [clamp01(inn[0]), inn[1]];
  const t = solveT(o[0], i[0], x);
  const P0: Vec2 = [0, 0], P3: Vec2 = [1, 1];
  const a = lerp2(P0, o, t), b = lerp2(o, i, t), c = lerp2(i, P3, t);
  const d = lerp2(a, b, t), e = lerp2(b, c, t);
  const m = lerp2(d, e, t);  // the point on the curve
  const X = m[0], Y = m[1];
  const nx = (v: number, lo: number, span: number) => (Math.abs(span) < 1e-9 ? 0 : (v - lo) / span);
  const ny = (v: number, lo: number, span: number, dflt: number) => (Math.abs(span) < 1e-9 ? dflt : (v - lo) / span);
  return {
    progress: Y,
    left: { out: [nx(a[0], 0, X), ny(a[1], 0, Y, 1 / 3)], in: [nx(d[0], 0, X), ny(d[1], 0, Y, 2 / 3)] },
    right: { out: [nx(e[0], X, 1 - X), ny(e[1], Y, 1 - Y, 1 / 3)], in: [nx(c[0], X, 1 - X), ny(c[1], Y, 1 - Y, 2 / 3)] },
  };
}

// ── spatial paths (positions) ────────────────────────────────────────────────

/** A point on the cubic path from p0 (leaving with tangent t0) to p1 (arriving with tangent t1) at s (0..1). */
export function spatialPoint(p0: number[], t0: number[] | undefined, t1: number[] | undefined, p1: number[], s: number): number[] {
  const u = 1 - s;
  return p0.map((a, k) => {
    const b = p1[k];
    const c1 = a + (t0?.[k] ?? (b - a) / 3), c2 = b + (t1?.[k] ?? (a - b) / 3);
    return u * u * u * a + 3 * u * u * s * c1 + 3 * u * s * s * c2 + s * s * s * b;
  });
}

/** Splits a spatial segment at s: the point there and the tangents of both halves (leaving p0, arriving at the cut,
 *  leaving the cut, arriving at p1). */
export function splitSpatial(p0: number[], t0: number[] | undefined, t1: number[] | undefined, p1: number[], s: number):
  { point: number[]; leftOut: number[]; leftIn: number[]; rightOut: number[]; rightIn: number[] } {
  const c1 = p0.map((a, k) => a + (t0?.[k] ?? (p1[k] - a) / 3));
  const c2 = p1.map((b, k) => b + (t1?.[k] ?? (p0[k] - b) / 3));
  const L = (x: number[], y: number[]) => x.map((v, k) => v + (y[k] - v) * s);
  const a = L(p0, c1), b = L(c1, c2), c = L(c2, p1), d = L(a, b), e = L(b, c), m = L(d, e);
  return {
    point: m,
    leftOut: a.map((v, k) => v - p0[k]), leftIn: d.map((v, k) => v - m[k]),
    rightOut: e.map((v, k) => v - m[k]), rightIn: c.map((v, k) => v - p1[k]),
  };
}

// ── auto-bezier and presets ──────────────────────────────────────────────────

export interface CurveKey { frame: number; value: number | number[] }

const asArr = (v: number | number[]) => (Array.isArray(v) ? v : [v]);

/**
 * Smooth handles through every keyframe (Catmull-Rom tangents; flat at the ends and at local extremes, so the curve
 * doesn't overshoot): for each segment i → i+1 the `out` handle of key i and the `in` handle of key i+1.
 */
export function autoBezierHandles(keys: CurveKey[]): { out: Vec2; in: Vec2 }[] {
  const n = keys.length;
  const slopes: number[][] = keys.map((k, i) => {
    const v = asArr(k.value);
    if (i === 0 || i === n - 1) return v.map(() => 0);
    const a = asArr(keys[i - 1].value), b = asArr(keys[i + 1].value);
    const dt = keys[i + 1].frame - keys[i - 1].frame;
    return v.map((x, d) => {
      // a local extreme stays flat
      if ((x >= a[d] && x >= b[d]) || (x <= a[d] && x <= b[d])) return 0;
      return dt > 0 ? (b[d] - a[d]) / dt : 0;
    });
  });
  const out: { out: Vec2; in: Vec2 }[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = asArr(keys[i].value), b = asArr(keys[i + 1].value);
    const dt = keys[i + 1].frame - keys[i].frame;
    const dv = a.map((x, d) => b[d] - x);
    const len2 = dv.reduce((s, x) => s + x * x, 0);
    // progress slope at each end: the value slope projected on the segment's change
    const prog = (m: number[]) => (len2 > 1e-12 ? (m.reduce((s, x, d) => s + x * dv[d], 0) * dt) / len2 : 0);
    const s0 = prog(slopes[i]), s1 = prog(slopes[i + 1]);
    out.push({ out: [1 / 3, s0 / 3], in: [2 / 3, 1 - s1 / 3] });
  }
  return out;
}

export type EasePresetId = "linear" | "ease_in" | "ease_out" | "ease_in_out" | "easy_ease" | "back" | "back_in_out" | "bounce" | "elastic" | "hold";

/** The graph editor's presets: an ease kind, plus handles for the bezier ones (out on the key, in on the next). */
export const EASE_PRESETS: { id: EasePresetId; label: string; ease: "linear" | "ease_in" | "ease_out" | "ease_in_out" | "bezier" | "bounce" | "elastic" | "hold"; out?: Vec2; in?: Vec2 }[] = [
  { id: "linear", label: "Linear", ease: "linear" },
  { id: "ease_in", label: "Ease in", ease: "ease_in" },
  { id: "ease_out", label: "Ease out", ease: "ease_out" },
  { id: "ease_in_out", label: "Ease in and out", ease: "ease_in_out" },
  { id: "easy_ease", label: "Easy ease (bezier)", ease: "bezier", out: [0.333, 0], in: [0.667, 1] },
  { id: "back", label: "Back (overshoot)", ease: "bezier", out: [0.34, 1.56], in: [0.64, 1] },
  { id: "back_in_out", label: "Back in and out", ease: "bezier", out: [0.68, -0.6], in: [0.32, 1.6] },
  { id: "bounce", label: "Bounce", ease: "bounce" },
  { id: "elastic", label: "Elastic", ease: "elastic" },
  { id: "hold", label: "Hold", ease: "hold" },
];
