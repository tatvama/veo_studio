/**
 * Curves (fx.curves): monotone cubic interpolation (Fritsch–Carlson) through 2..16 points, baked into 256-entry
 * tables. The r/g/b curve applies first, then master (as FFmpeg's curves "master" post-pass).
 */
import type { Curves } from "./types.ts";

export type CurvePoints = [number, number][];
export const CURVE_SIZE = 256;

/** Points cleaned like the server: finite, clamped to 0..1, sorted by x, one per x, at most 16 (null = identity). */
export function cleanPoints(pts: unknown): CurvePoints | null {
  if (!Array.isArray(pts)) return null;
  const byX = new Map<number, number>();
  for (const p of pts) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]), y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    byX.set(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)));
  }
  const out = [...byX.entries()].sort((a, b) => a[0] - b[0]).slice(0, 16) as CurvePoints;
  return out.length >= 2 ? out : null;
}

/** A function y(x) through the points: monotone between them, flat outside them. */
export function monotone(points: CurvePoints): (x: number) => number {
  const n = points.length;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const d: number[] = [], m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(xs[i + 1] - xs[i], 1e-9));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {  // Fritsch–Carlson: keep each segment monotone
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    return Math.min(1, Math.max(0, y));
  };
}

/** One curve as a 256-entry table (identity when the points are missing or invalid). */
export function curveTable(points: unknown): Float32Array {
  const pts = cleanPoints(points);
  const out = new Float32Array(CURVE_SIZE);
  const f = pts ? monotone(pts) : (x: number) => x;
  for (let i = 0; i < CURVE_SIZE; i++) out[i] = f(i / (CURVE_SIZE - 1));
  return out;
}

/** True when fx.curves changes anything. */
export const hasCurves = (c: Curves | undefined) => !!c && (["master", "r", "g", "b"] as const).some((k) => cleanPoints(c[k]));

/** The composed per-channel tables as RGBA float texels (master ∘ channel), ready for a 256×1 texture. */
export function bakeCurves(c: Curves | undefined): Float32Array {
  const master = cleanPoints(c?.master);
  const mf = master ? monotone(master) : (x: number) => x;
  const out = new Float32Array(CURVE_SIZE * 4);
  const chans = (["r", "g", "b"] as const).map((k) => { const p = cleanPoints(c?.[k]); return p ? monotone(p) : (x: number) => x; });
  for (let i = 0; i < CURVE_SIZE; i++) {
    const x = i / (CURVE_SIZE - 1);
    for (let ch = 0; ch < 3; ch++) out[i * 4 + ch] = mf(chans[ch](x));
    out[i * 4 + 3] = 1;
  }
  return out;
}
