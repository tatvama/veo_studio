/** Easing curves for transition progress and keyframe segments (cubic). Input and output 0..1, clamped. */
import type { Easing } from "./types.ts";

export const EASINGS: Easing[] = ["linear", "ease_in", "ease_out", "ease_in_out"];

export const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : Number.isFinite(v) ? v : 0);

export function ease(kind: Easing | string | undefined, x: number): number {
  const t = clamp01(x);
  switch (kind) {
    case "ease_in": return t * t * t;
    case "ease_out": { const u = 1 - t; return 1 - u * u * u; }
    case "ease_in_out": return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case "bounce": return bounceOut(t);
    case "elastic": return elasticOut(t);
    default: return t;
  }
}

/** Robert Penner's easeOutBounce. */
export function bounceOut(t: number): number {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) { const u = t - 1.5 / d; return n * u * u + 0.75; }
  if (t < 2.5 / d) { const u = t - 2.25 / d; return n * u * u + 0.9375; }
  const u = t - 2.625 / d;
  return n * u * u + 0.984375;
}
/** Robert Penner's easeOutElastic (overshoots above 1 before it settles). */
export function elasticOut(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
}

/** CSS cubic-bezier(x1, y1, x2, y2) at time x (0..1): solves x(u) = x (Newton, then bisection), returns y(u). The value
 *  may leave 0..1 when y1 / y2 do (overshoot). x1 and x2 are clamped to 0..1 as CSS requires. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const t = clamp01(x);
  x1 = clamp01(x1); x2 = clamp01(x2);
  const bx = (u: number) => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  const by = (u: number) => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  const dx = (u: number) => 3 * (1 - u) * (1 - u) * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2);
  let u = t;
  for (let i = 0; i < 8; i++) {
    const e = bx(u) - t, d = dx(u);
    if (Math.abs(e) < 1e-7) return by(u);
    if (Math.abs(d) < 1e-6) break;
    u = Math.min(1, Math.max(0, u - e / d));
  }
  let lo = 0, hi = 1;
  u = t;
  for (let i = 0; i < 40; i++) { if (bx(u) < t) lo = u; else hi = u; u = (lo + hi) / 2; }
  return by(u);
}
