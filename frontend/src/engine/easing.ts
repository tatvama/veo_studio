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
    default: return t;
  }
}
