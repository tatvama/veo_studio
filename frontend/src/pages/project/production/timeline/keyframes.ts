/**
 * Keyframe animation on picture layer clips. `t` is seconds from the clip's start; a property moves in a straight line
 * between the keyframes that set it and holds before the first / after the last; a property no keyframe sets keeps the
 * clip's own value. Mirrors backend/app/pipeline/layers.py (sample / kf_expr) so the preview matches the export.
 */
export type KfKey = "x" | "y" | "scale" | "opacity" | "rotation";
export interface Keyframe { t: number; x?: number; y?: number; scale?: number; opacity?: number; rotation?: number }
export interface Animatable { x?: number; y?: number; scale?: number; opacity?: number; rotation?: number; keyframes?: Keyframe[] }

export const KF_KEYS: KfKey[] = ["x", "y", "scale", "opacity", "rotation"];
export const KF_DEFAULT: Record<KfKey, number> = { x: 0.5, y: 0.5, scale: 0.35, opacity: 1, rotation: 0 };
/** [min, max] per property (the backend clamps to the same). */
export const KF_RANGE: Record<KfKey, [number, number]> = { x: [-0.5, 1.5], y: [-0.5, 1.5], scale: [0.05, 2], opacity: [0, 1], rotation: [-360, 360] };
export const MAX_KEYFRAMES = 20;

const clampKey = (k: KfKey, v: number) => Math.max(KF_RANGE[k][0], Math.min(KF_RANGE[k][1], v));

/** The value of `key` at `t` seconds into the clip. */
export function sampleKf(kfs: Keyframe[] | undefined, key: KfKey, base: number, t: number): number {
  const pts = (kfs ?? []).filter((k) => k[key] !== undefined).map((k) => [k.t, k[key] as number] as const);
  if (!pts.length) return base;
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
    if (t <= t1) return t1 - t0 < 1e-9 ? v1 : v0 + (v1 - v0) * (t - t0) / (t1 - t0);
  }
  return pts[pts.length - 1][1];
}

/** Every animatable property of a clip at `rel` seconds into it. */
export function stateAt(c: Animatable, rel: number): Record<KfKey, number> {
  const out = {} as Record<KfKey, number>;
  for (const k of KF_KEYS) out[k] = sampleKf(c.keyframes, k, c[k] ?? KF_DEFAULT[k], rel);
  return out;
}

/** Sorted by time, one keyframe per instant (the later one wins), values in range, at most MAX_KEYFRAMES. */
export function normalizeKf(kfs: Keyframe[], dur: number): Keyframe[] {
  const byT = new Map<number, Keyframe>();
  for (const k of kfs) {
    const t = Math.round(Math.max(0, Math.min(dur, k.t)) * 1000) / 1000;
    const kf: Keyframe = { t };
    for (const key of KF_KEYS) if (k[key] !== undefined && Number.isFinite(k[key])) kf[key] = Math.round(clampKey(key, k[key] as number) * 10000) / 10000;
    if (Object.keys(kf).length > 1) byT.set(t, kf);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t).slice(0, MAX_KEYFRAMES);
}

/** True when the property really changes over the keyframes. */
export const isAnimated = (kfs: Keyframe[] | undefined, key: KfKey) =>
  new Set((kfs ?? []).filter((k) => k[key] !== undefined).map((k) => Math.round((k[key] as number) * 10000))).size > 1;
