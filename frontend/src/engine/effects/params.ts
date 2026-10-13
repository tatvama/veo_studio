/**
 * Shot fx → effect parameters, with the exact numbers backend/app/pipeline/fx.py adjust_filters() hands FFmpeg, and
 * the plan of passes a clip needs. Pure (unit-tested); the shaders in shaders.ts consume it.
 */
import { hasCurves } from "../curves.ts";
import type { AdjustKey, ShotFx } from "../types.ts";

export interface AdjustParams {
  /** eq: luma = brightness / contrast / gamma, chroma = saturation (each only when it changes something). */
  eq?: { brightness: number; contrast: number; gamma: number; saturation: number; luma: boolean; chroma: boolean };
  /** colorbalance midtones (rm, gm, bm). */
  cb?: [number, number, number];
  /** vibrance intensity. */
  vibrance?: number;
  /** hue rotation, degrees. */
  hue?: number;
  /** unsharp 5×5 luma amount. */
  sharpen?: number;
  /** gblur sigma, pixels at the export size. */
  blur?: number;
  /** vignette angle, radians. */
  vignette?: number;
  /** noise strength (alls), code values. */
  grain?: number;
}

const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** fx.adjust → the FFmpeg parameters (same rounding as the Python). */
export function adjustParams(a: Partial<Record<AdjustKey, number>> | undefined): AdjustParams {
  const out: AdjustParams = {};
  if (!a) return out;
  const v = (k: AdjustKey) => (typeof a[k] === "number" && Number.isFinite(a[k]) ? (a[k] as number) : 0);
  if (v("exposure") || v("contrast") || v("saturation") || v("gamma")) {
    const brightness = v("exposure") ? r(v("exposure") * 0.25, 4) : 0;
    const contrast = v("contrast") ? r(1 + v("contrast") * 0.6, 4) : 1;
    const saturation = v("saturation") ? r(1 + v("saturation"), 4) : 1;
    const gamma = v("gamma") ? r(1 + v("gamma") * 0.5, 4) : 1;
    out.eq = { brightness, contrast, gamma, saturation, luma: contrast !== 1 || brightness !== 0 || gamma !== 1, chroma: saturation !== 1 };
  }
  if (v("temperature") || v("tint")) out.cb = [r(0.15 * v("temperature"), 4), r(-0.15 * v("tint"), 4), r(-0.15 * v("temperature"), 4)];
  if (v("vibrance")) out.vibrance = r(v("vibrance") * 0.6, 4);
  if (v("hue")) out.hue = r(v("hue") * 180, 2);
  if (v("sharpen")) out.sharpen = r(v("sharpen") * 1.5, 3);
  if (v("blur")) out.blur = r(v("blur") * 8, 3);
  if (v("vignette")) out.vignette = r(0.25 + v("vignette") * 0.9, 4);
  if (v("grain")) out.grain = Math.trunc(v("grain") * 40);
  return out;
}

/** FFmpeg eq's integer path (gamma 1) for one plane: [k, offset] with pel = (src·k >> 12) + offset. */
export function eqInt(contrast: number, brightness: number): [number, number] {
  const c = Math.fround(contrast), b = Math.fround(brightness);  // eq keeps them as float: −0.15 gives ⌊84.99…⌋ = 84
  const k = Math.trunc(c * 256 * 16);
  return [k, Math.trunc((Math.trunc(100 * b + 100) * 511) / 200) - 128 - Math.trunc(k / 32)];
}

/** "#RRGGBB" → [r, g, b] 0..1 (null when it isn't a colour). */
export function hexRgb(hex: string | undefined): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const nz = (v: number[] | undefined) => !!v && v.some((x) => Math.abs(Number(x) || 0) > 1e-4);

/** Which passes a clip needs. `lut` = a LUT is loaded for its look. */
export interface FxPlan {
  adjust: AdjustParams;
  lut: boolean; wheels: boolean; curves: boolean; chroma: boolean; glow: boolean; mask: boolean;
  /** Any per-pixel grade (LUT, eq, colorbalance, vibrance, hue, wheels, curves, chroma key). */
  point: boolean;
  /** Needs neighbouring pixels (glow, sharpen, blur): more than one pass. */
  neighbourhood: boolean;
  /** Anything at all besides sampling (fades are separate). */
  any: boolean;
}

export function fxPlan(fx: ShotFx | undefined, lut: boolean): FxPlan {
  const adjust = adjustParams(fx?.adjust);
  const wheels = !!fx?.wheels && (nz(fx.wheels.lift) || nz(fx.wheels.gamma) || nz(fx.wheels.gain));
  const curves = hasCurves(fx?.curves);
  const chroma = !!fx?.chroma && !!hexRgb(fx.chroma.color);
  const glow = !!fx?.glow && (fx.glow.amount ?? 0) > 1e-3;
  const mask = !!fx?.mask && (fx.mask.w ?? 0) > 0 && (fx.mask.h ?? 0) > 0;
  const point = lut || !!adjust.eq || !!adjust.cb || adjust.vibrance !== undefined || adjust.hue !== undefined || wheels || curves || chroma;
  const neighbourhood = glow || !!adjust.sharpen || !!adjust.blur;
  return { adjust, lut, wheels, curves, chroma, glow, mask, point, neighbourhood,
    any: point || neighbourhood || mask || !!adjust.vignette || !!adjust.grain };
}

/** The two-sided geometric kernel FFmpeg's gblur (one IIR step) amounts to: weight ∝ nu^|x|. */
export function gblurNu(sigma: number): number {
  const lambda = (sigma * sigma) / 2;
  return lambda > 0 ? (1 + 2 * lambda - Math.sqrt(1 + 4 * lambda)) / (2 * lambda) : 0;
}

/** Normalised 1D weights for offsets 0..R (the kernel is symmetric), cut where they fall under 0.2 %. */
export function gblurWeights(sigma: number, maxR = 64): number[] {
  const nu = gblurNu(sigma);
  if (nu <= 0) return [1];
  const R = Math.min(maxR, Math.max(1, Math.ceil(Math.log(0.002) / Math.log(nu))));
  const w = Array.from({ length: R + 1 }, (_, i) => Math.pow(nu, i));
  const sum = w.reduce((s, x, i) => s + (i ? 2 * x : x), 0);
  return w.map((x) => x / sum);
}

/** Pairs of taps merged into single bilinear fetches: [offset, weight] for offsets ≥ 1 (plus the centre weight). */
export function linearTaps(w: number[]): { center: number; taps: [number, number][] } {
  const taps: [number, number][] = [];
  for (let i = 1; i < w.length; i += 2) {
    const a = w[i], b = i + 1 < w.length ? w[i + 1] : 0;
    const s = a + b;
    taps.push([s > 0 ? i + b / s : i, s]);
  }
  return { center: w[0], taps };
}
