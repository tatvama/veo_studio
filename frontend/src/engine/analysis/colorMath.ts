/**
 * Colour analysis maths (docs/EDITOR.md §10): CIELAB statistics of a picture, an auto white balance in the `adjust`
 * effect's own terms (its FFmpeg colorbalance maths, so the suggestion is what the effect will really do), Reinhard
 * colour transfer in Lab (Reinhard, Ashikhmin, Gooch & Shirley, "Color Transfer between Images", IEEE CG&A 2001; we
 * use CIELAB instead of lαβ) as a 33³ LUT, and the `wheels` / `adjust` parameters that come closest to it. Pure.
 *
 * Pixels are working-space RGB (BT.709 primaries, BT.1886 γ 2.4, 0..1); Lab is CIE 1976 L*a*b* against D65.
 */
import { apply3, GAMUTS, npm } from "../colour.ts";

const M = npm(GAMUTS.bt709);
const MI = (() => { const [a, b, c, d, e, f, g, h, i] = M; const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g; const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((x) => x / det); })();
const WHITE = apply3(M, [1, 1, 1]);
const lin = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 2.4);
const enc = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 1 / 2.4);
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fi = (t: number) => (t * t * t > 216 / 24389 ? t * t * t : (116 * t - 16) / (24389 / 27));

export type Vec3 = [number, number, number];
export function rgbToLab(r: number, g: number, b: number): Vec3 {
  const [X, Y, Z] = apply3(M, [lin(r), lin(g), lin(b)]);
  const fx = f(X / WHITE[0]), fy = f(Y / WHITE[1]), fz = f(Z / WHITE[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function labToRgb(L: number, a: number, b: number): Vec3 {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const [r, g, bb] = apply3(MI, [fi(fx) * WHITE[0], fi(fy) * WHITE[1], fi(fz) * WHITE[2]]);
  return [enc(r), enc(g), enc(bb)];
}

export interface LabStats {
  /** Mean and standard deviation of L*, a*, b*. */
  mean: Vec3; std: Vec3;
  /** Rec.709 luma (8-bit code of the working value) in 256 bins, as fractions of the pixels. */
  histogram: number[];
  count: number;
}

/** Samples of a picture: RGB triples 0..1 (from RGBA bytes or floats), every `step`-th pixel. */
export function samplePixels(rgba: ArrayLike<number>, w: number, h: number, maxSamples = 20000, scale = 255): Vec3[] {
  const n = w * h, step = Math.max(1, Math.floor(n / maxSamples));
  const out: Vec3[] = [];
  for (let i = 0; i < n; i += step) out.push([rgba[i * 4] / scale, rgba[i * 4 + 1] / scale, rgba[i * 4 + 2] / scale]);
  return out;
}

export function labStats(px: Vec3[]): LabStats {
  const n = Math.max(px.length, 1);
  const s = [0, 0, 0], s2 = [0, 0, 0], hist = new Array(256).fill(0);
  for (const [r, g, b] of px) {
    const lab = rgbToLab(r, g, b);
    for (let k = 0; k < 3; k++) { s[k] += lab[k]; s2[k] += lab[k] * lab[k]; }
    hist[Math.min(255, Math.max(0, Math.round((0.2126 * r + 0.7152 * g + 0.0722 * b) * 255)))]++;
  }
  const mean = s.map((x) => x / n) as Vec3;
  const std = s2.map((x, k) => Math.sqrt(Math.max(x / n - mean[k] * mean[k], 0))) as Vec3;
  return { mean, std, histogram: hist.map((x) => x / n), count: px.length };
}

/** A distance between two pictures' statistics (Lab means and spreads), for "did it get closer". */
export function statsDistance(a: LabStats, b: LabStats): number {
  let d = 0;
  for (let k = 0; k < 3; k++) d += (a.mean[k] - b.mean[k]) ** 2 + (a.std[k] - b.std[k]) ** 2;
  return Math.sqrt(d);
}

/** Reinhard transfer of one Lab colour from the source statistics to the reference's. */
export function reinhardLab(lab: Vec3, src: LabStats, ref: LabStats): Vec3 {
  return [0, 1, 2].map((k) => (lab[k] - src.mean[k]) * (ref.std[k] / Math.max(src.std[k], 1e-3)) + ref.mean[k]) as Vec3;
}
export function reinhardRgb(c: Vec3, src: LabStats, ref: LabStats): Vec3 {
  const o = labToRgb(...reinhardLab(rgbToLab(...c), src, ref));
  return o.map((v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))) as Vec3;
}
/** The transfer as an N³ LUT (red fastest, .cube order; Lut3D.data). */
export function reinhardLut(src: LabStats, ref: LabStats, size = 33): Float32Array {
  const out = new Float32Array(size * size * size * 3);
  let o = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const c = reinhardRgb([r / (size - 1), g / (size - 1), b / (size - 1)], src, ref);
    out[o++] = c[0]; out[o++] = c[1]; out[o++] = c[2];
  }
  return out;
}

// ── the adjust effect's temperature / tint (FFmpeg colorbalance midtones, renderer CB) ─────────────────────────────
const cbComp = (v: number, l: number, m: number) => {
  const w = Math.min(1, Math.max(0, (l - 0.333) * 4 + 0.5)) * Math.min(1, Math.max(0, (1 - l - 0.333) * 4 + 0.5)) * 0.7;
  return Math.min(1, Math.max(0, v + m * w));
};
/** adjust {temperature, tint} on one colour, as the engine draws it (colorbalance rm, gm, bm = 0.15·T, −0.15·tint, −0.15·T). */
export function adjustWb(c: Vec3, temperature: number, tint: number): Vec3 {
  const r = Math.min(1, Math.max(0, c[0])), g = Math.min(1, Math.max(0, c[1])), b = Math.min(1, Math.max(0, c[2]));
  const l = Math.max(r, g, b) + Math.min(r, g, b);
  return [cbComp(r, l, 0.15 * temperature), cbComp(g, l, -0.15 * tint), cbComp(b, l, -0.15 * temperature)];
}

/** Gray-world candidates: mid-tone pixels that aren't strongly coloured (all of them when too few are). */
export function neutralCandidates(px: Vec3[]): Vec3[] {
  const c = px.filter(([r, g, b]) => {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return y > 0.06 && y < 0.94 && mx - mn < 0.35 + 0.3 * y;
  });
  return c.length >= Math.max(50, px.length * 0.02) ? c : px;
}

const meanAb = (px: Vec3[], T: number, tint: number) => {
  let r = 0, g = 0, b = 0;
  for (const c of px) { const o = adjustWb(c, T, tint); r += o[0]; g += o[1]; b += o[2]; }
  const n = Math.max(px.length, 1), lab = rgbToLab(r / n, g / n, b / n);
  return lab[1] * lab[1] + lab[2] * lab[2];
};

/**
 * A white balance suggestion in the `adjust` effect's own units. Sign convention (the effect's): temperature > 0 makes
 * the picture warmer (more red, less blue), tint > 0 makes it more magenta (less green). So a picture with a warm
 * (orange) cast gets a NEGATIVE temperature, a cool (blue) one a positive temperature, a green cast a positive tint.
 */
export interface WbSuggestion {
  /** adjust.temperature / adjust.tint (−1..1) that neutralise the estimated cast (scaled down when unsure). */
  temperature: number; tint: number;
  /** wheels.gain (−1..1 per channel) that neutralises the estimate exactly (an alternative to temperature / tint). */
  gain: Vec3;
  /** The measured cast: a*, b* (CIELAB) of the estimated light. b* > 0 is warm (yellow-orange), a* > 0 magenta-red. */
  cast: [number, number];
  /** 0..1: how sure the estimate is (many near-neutral pixels: high; a sunset or a coloured stage: low). */
  confidence: number;
  /** How the light was estimated: from near-neutral pixels, or the shades-of-grey norm of everything. */
  method: "neutral" | "shades-of-grey";
}

/** The colour of the light: the mean of near-neutral mid-tones when there are enough of them, else the shades-of-grey
 *  estimate (Finlayson & Trezzi 2004, Minkowski p = 6) over the unclipped pixels. */
export function illuminantOf(px: Vec3[]): { rgb: Vec3; confidence: number; method: WbSuggestion["method"] } {
  const neutral = px.filter(([r, g, b]) => {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return y > 0.06 && y < 0.94 && mx < 0.985 && mx - mn < 0.1 + 0.22 * y;
  });
  const share = neutral.length / Math.max(px.length, 1);
  if (neutral.length >= 50 && share >= 0.05) {
    const s = [0, 0, 0];
    for (const c of neutral) for (let k = 0; k < 3; k++) s[k] += c[k];
    return { rgb: s.map((v) => v / neutral.length) as Vec3, confidence: Math.min(1, 0.4 + share * 1.5), method: "neutral" };
  }
  const p = 6, s = [0, 0, 0];
  let n = 0;
  for (const c of px) {
    const mx = Math.max(c[0], c[1], c[2]);
    if (mx >= 0.985 || mx < 0.03) continue;
    for (let k = 0; k < 3; k++) s[k] += Math.pow(c[k], p);
    n++;
  }
  const rgb = s.map((v) => Math.pow(v / Math.max(n, 1), 1 / p)) as Vec3;
  return { rgb, confidence: 0.3, method: "shades-of-grey" };
}

/**
 * Auto white balance: estimates the light (illuminantOf), then searches adjust.temperature / tint (coarse to fine,
 * through the effect's real FFmpeg colorbalance maths) that make mid-tone greys of that light neutral, which is the
 * range those controls act on. See WbSuggestion for the sign convention.
 */
export function suggestWb(px: Vec3[]): WbSuggestion {
  const ill = illuminantOf(px);
  const ly = Math.max(0.2126 * ill.rgb[0] + 0.7152 * ill.rgb[1] + 0.0722 * ill.rgb[2], 1e-4);
  const k = ill.rgb.map((v) => v / ly);
  const cand: Vec3[] = [0.16, 0.2, 0.24, 0.28, 0.32, 0.36].map((y) => k.map((c) => Math.min(1, c * y)) as Vec3);
  let best = { T: 0, tint: 0, e: meanAb(cand, 0, 0) };
  for (const [lo, hi, st] of [[-1, 1, 0.1], [-0.12, 0.12, 0.02], [-0.025, 0.025, 0.005]] as const) {
    const c0 = { ...best };
    for (let T = lo; T <= hi + 1e-9; T += st) for (let k = lo; k <= hi + 1e-9; k += st) {
      const tt = Math.min(1, Math.max(-1, c0.T + T)), kk = Math.min(1, Math.max(-1, c0.tint + k));
      const e = meanAb(cand, tt, kk);
      if (e < best.e - 1e-9) best = { T: tt, tint: kk, e };
    }
  }
  const [r, g, b] = ill.rgb;
  const gain = [r, g, b].map((v) => Math.min(1, Math.max(-1, ly / Math.max(v, 1e-3) - 1))) as Vec3;
  const lab = rgbToLab(r, g, b);
  const q = (v: number) => Math.round(v * 1000) / 1000;
  const f = 0.5 + 0.5 * ill.confidence;  // unsure (no neutrals): suggest half as much
  return { temperature: q(best.T * f), tint: q(best.tint * f), gain: gain.map((v) => q(v * f)) as Vec3, cast: [q(lab[1]), q(lab[2])],
    confidence: q(ill.confidence), method: ill.method };
}

// ── the wheels effect (renderer WHEELS): lift u = v·0.5, gain 1 + v, gamma 2^−v ───────────────────────────────────
export function wheel(c: number, lift: number, gamma: number, gain: number): number {
  const x = Math.min(1, Math.max(0, c));
  const y = (x + lift * 0.5 * (1 - x)) * (1 + gain);
  return Math.min(1, Math.max(0, Math.pow(Math.max(y, 0), Math.pow(2, -gamma))));
}
/** adjust.saturation (eq saturation 1 + s on chroma) on one colour. */
export function adjustSaturation(c: Vec3, s: number): Vec3 {
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return c.map((v) => Math.min(1, Math.max(0, y + (v - y) * (1 + s)))) as Vec3;
}

export type WheelsParams = { lift: Vec3; gamma: Vec3; gain: Vec3 };
/** The per-channel lift / gamma / gain (−1..1) that best map `src` onto `dst` (least squares, coarse-to-fine). */
export function fitWheels(src: Vec3[], dst: Vec3[]): WheelsParams {
  const out: WheelsParams = { lift: [0, 0, 0], gamma: [0, 0, 0], gain: [0, 0, 0] };
  const n = Math.min(src.length, dst.length);
  const idx = Array.from({ length: Math.min(n, 1500) }, (_, i) => Math.floor((i * n) / Math.min(n, 1500)));
  for (let ch = 0; ch < 3; ch++) {
    const err = (l: number, g: number, k: number) => { let e = 0; for (const i of idx) { const d = wheel(src[i][ch], l, g, k) - dst[i][ch]; e += d * d; } return e; };
    let best = { l: 0, g: 0, k: 0, e: err(0, 0, 0) };
    for (const st of [0.25, 0.08, 0.025, 0.008]) {
      const c0 = { ...best };
      for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) for (let c = -3; c <= 3; c++) {
        const l = Math.min(1, Math.max(-1, c0.l + a * st)), g = Math.min(1, Math.max(-1, c0.g + b * st)), k = Math.min(1, Math.max(-1, c0.k + c * st));
        const e = err(l, g, k);
        if (e < best.e) best = { l, g, k, e };
      }
    }
    const q = (v: number) => Math.round(v * 1000) / 1000;
    out.lift[ch] = q(best.l); out.gamma[ch] = q(best.g); out.gain[ch] = q(best.k);
  }
  return out;
}

export interface MatchParams {
  /** adjust.saturation for the chroma spread, then `wheels` per channel (apply both, in that order). */
  adjust: { saturation: number };
  wheels: WheelsParams;
  /** The exact transfer as a 33³ LUT (Lut3D.data, red fastest). */
  lut: Float32Array;
  source: LabStats; reference: LabStats;
}
/** Reinhard transfer from a picture's samples toward a reference's statistics, as effect parameters and a LUT. */
export function matchParams(src: Vec3[], ref: LabStats, size = 33): MatchParams {
  const s = labStats(src);
  const chroma = (st: LabStats) => Math.hypot(st.std[1], st.std[2]);
  const saturation = Math.round(Math.min(1, Math.max(-1, chroma(ref) / Math.max(chroma(s), 1e-3) - 1)) * 1000) / 1000;
  const sub = src.length > 1500 ? src.filter((_, i) => i % Math.ceil(src.length / 1500) === 0) : src;
  const target = sub.map((c) => reinhardRgb(c, s, ref));
  const wheels = fitWheels(sub.map((c) => adjustSaturation(c, saturation)), target);
  return { adjust: { saturation }, wheels, lut: reinhardLut(s, ref, size), source: s, reference: ref };
}
