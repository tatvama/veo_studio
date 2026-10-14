/**
 * Shared pieces of the SFX recipes: the parameter vocabulary (length, pitch, brightness, punch, tail, width …),
 * what the common parameters mean, and the reverb "spaces" a tail plays in. Pure.
 */
import { clamp, reverb, reverbTail, semis, type Stereo } from "../dsp.ts";
import type { SfxParam, Values } from "../types.ts";

export const P = {
  length: (d: number, min = 0.1, max = 10, label = "Length"): SfxParam => ({ name: "length", label, min, max, default: d, step: 0.05, unit: "s" }),
  pitch: (d = 0, range = 12): SfxParam => ({ name: "pitch", label: "Pitch", min: -range, max: range, default: d, step: 1, unit: "st" }),
  brightness: (d = 0.5): SfxParam => ({ name: "brightness", label: "Brightness", min: 0, max: 1, default: d, step: 0.01 }),
  punch: (d = 0.5): SfxParam => ({ name: "punch", label: "Punch", min: 0, max: 1, default: d, step: 0.01 }),
  tail: (d = 0.3): SfxParam => ({ name: "tail", label: "Tail", min: 0, max: 1, default: d, step: 0.01 }),
  width: (d = 0.6): SfxParam => ({ name: "width", label: "Stereo width", min: 0, max: 1, default: d, step: 0.01 }),
  drive: (d = 0.3): SfxParam => ({ name: "drive", label: "Drive", min: 0, max: 1, default: d, step: 0.01 }),
  intensity: (d = 0.5): SfxParam => ({ name: "intensity", label: "Intensity", min: 0, max: 1, default: d, step: 0.01 }),
  num: (name: string, label: string, d: number, min: number, max: number, step = 1, unit?: string): SfxParam => ({ name, label, min, max, default: d, step, ...(unit ? { unit } : {}) }),
};

/** Brightness as a frequency factor: 0 → ×0.5, 0.5 → ×1, 1 → ×2. */
export const bright = (v: Values) => Math.pow(2, clamp(v.brightness ?? 0.5, 0, 1) * 2 - 1);
/** Pitch as a frequency factor. */
export const pk = (v: Values) => semis(v.pitch ?? 0);
export const val = (v: Values, k: string, d: number) => (Number.isFinite(v[k]) ? v[k] : d);

/** A room for a sound's tail: the reverb `size` (0..1), its wet level when `tail` = 0.5, damping, pre-delay (s). */
export interface Space { size: number; wet: number; damp?: number; predelay?: number }
export const ROOM: Space = { size: 0.42, wet: 0.45, damp: 0.5, predelay: 0.004 };
export const STUDIO: Space = { size: 0.3, wet: 0.35, damp: 0.55 };
export const PLATE: Space = { size: 0.66, wet: 0.5, damp: 0.15, predelay: 0.01 };
export const HALL: Space = { size: 0.8, wet: 0.55, damp: 0.35, predelay: 0.02 };
export const HUGE: Space = { size: 0.92, wet: 0.6, damp: 0.3, predelay: 0.03 };

/** Seconds the tail adds for these values (0 with no tail). */
export function tailSeconds(v: Values, s: Space): number {
  const t = clamp(v.tail ?? 0, 0, 1);
  if (t < 0.005) return 0;
  return reverbTail(s.size) * (0.3 + 0.55 * Math.min(1, t * 1.6));
}

/** The sound in its space (the buffer already holds the tail's room); unchanged with no tail. */
export function inSpace(st: Stereo, sr: number, v: Values, s: Space, widthOverride?: number): Stereo {
  const t = clamp(v.tail ?? 0, 0, 1);
  if (t < 0.005) return st;
  // a tail a little narrower than the full Freeverb width: on tones its two sides would otherwise lean out of phase
  return reverb(st, sr, { size: s.size, wet: s.wet * t * 2, damp: s.damp ?? 0.4, predelay: s.predelay ?? 0, width: widthOverride ?? clamp(0.45 + 0.35 * (v.width ?? 0.6), 0, 1) });
}

/** smoothstep 0..1 */
export const smooth = (u: number) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };
