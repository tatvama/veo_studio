/**
 * Colour science for camera log inputs, HDR outputs and the 10-bit read-back (docs/EDITOR.md §10). Pure maths (unit
 * tested) plus the GLSL the effects and the read-back compile from the same constants. Our own implementation of the
 * published specifications, each cited where it is used:
 *
 *   Sony S-Log3 / S-Gamut3.Cine  "Technical Summary for S-Gamut3.Cine/S-Log3 and S-Gamut3/S-Log3", Sony (2014)
 *   ARRI LogC3 (EI 800) / AWG3   "ALEXA Log C Curve – Usage in VFX", ARRI (H. Brendel, 2017)
 *   ARRI LogC4 / AWG4            "ARRI LogC4 Logarithmic Color Space – Specification", ARRI (2022)
 *   Panasonic V-Log / V-Gamut    "V-Log/V-Gamut Reference Manual", Panasonic (2014)
 *   Canon Log 3 / Cinema Gamut   "Canon Log Gamma Curves" white paper, Canon (2020, v1.2 constants, legal range)
 *   DJI D-Log / D-Gamut          "White Paper on D-Log and D-Gamut of DJI Cinema Color System", DJI (rev. 1.0, 2017)
 *   Blackmagic Film Gen 5 / WG   "Blackmagic Generation 5 Color Science", Blackmagic Design (2021)
 *   BT.709 / BT.1886 / BT.2020 / BT.2100 (PQ, HLG) / BT.2408 (203 cd/m² reference white), ITU-R; IEC 61966-2-1 (sRGB);
 *   SMPTE RP 177 (normalised primary matrix from chromaticities).
 *
 * The engine's working space: BT.709 primaries, display-referred, BT.1886-encoded (γ 2.4), 1.0 = reference white.
 * Half-float targets keep values above 1.0 (HDR headroom) and below 0.0 (colours outside BT.709).
 */

export type Mat3 = number[];  // row-major 3×3
export type Chroma = [number, number];
export interface Gamut { name: string; r: Chroma; g: Chroma; b: Chroma; white: Chroma }

export const D65: Chroma = [0.3127, 0.329];
export const GAMUTS = {
  bt709: { name: "Rec.709 / sRGB", r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06], white: D65 },
  bt2020: { name: "Rec.2020", r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046], white: D65 },
  sgamut3cine: { name: "S-Gamut3.Cine", r: [0.766, 0.275], g: [0.225, 0.8], b: [0.089, -0.087], white: D65 },
  awg3: { name: "ARRI Wide Gamut 3", r: [0.684, 0.313], g: [0.221, 0.848], b: [0.0861, -0.102], white: D65 },
  awg4: { name: "ARRI Wide Gamut 4", r: [0.7347, 0.2653], g: [0.1424, 0.8576], b: [0.0991, -0.0308], white: D65 },
  vgamut: { name: "V-Gamut", r: [0.73, 0.28], g: [0.165, 0.84], b: [0.1, -0.03], white: D65 },
  cinemagamut: { name: "Cinema Gamut", r: [0.74, 0.27], g: [0.17, 1.14], b: [0.08, -0.1], white: D65 },
  dgamut: { name: "D-Gamut", r: [0.71, 0.31], g: [0.21, 0.88], b: [0.09, -0.08], white: D65 },
  bmdwg5: { name: "Blackmagic Wide Gamut Gen 5", r: [0.7177215, 0.3171181], g: [0.228041, 0.861569], b: [0.1005841, -0.0820452], white: [0.312717, 0.3290312] },
} satisfies Record<string, Gamut>;
export type GamutId = keyof typeof GAMUTS;

const xyz = ([x, y]: Chroma) => [x / y, 1, (1 - x - y) / y];

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
}
export function inv3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("singular matrix");
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((x) => x / det);
}
export const apply3 = (m: Mat3, v: number[]): [number, number, number] =>
  [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

/** RGB → XYZ for a gamut (SMPTE RP 177 normalised primary matrix). */
export function npm(g: Gamut): Mat3 {
  const [R, G, B, W] = [xyz(g.r), xyz(g.g), xyz(g.b), xyz(g.white)];
  const P: Mat3 = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]];
  const S = apply3(inv3(P), W);
  return [P[0] * S[0], P[1] * S[1], P[2] * S[2], P[3] * S[0], P[4] * S[1], P[5] * S[2], P[6] * S[0], P[7] * S[1], P[8] * S[2]];
}
/** Linear RGB in one gamut → linear RGB in another (same white: no adaptation needed for the D65 gamuts here). */
export const gamutMatrix = (from: Gamut, to: Gamut): Mat3 => mul3(inv3(npm(to)), npm(from));
/** A row-major 3×3 as a GLSL mat3 constructor argument list (column-major). */
export const glslMat = (m: Mat3) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]].map(fl).join(", ");
const fl = (x: number) => { const s = Number.isFinite(x) ? x.toPrecision(10) : "0"; return /[.e]/.test(s) ? s : `${s}.0`; };

// ── camera log curves: code value (0..1 of the full 10-bit range, i.e. CV / 1023) ↔ scene-linear (0.18 = grey) ─────
export interface LogCurve { id: string; label: string; gamut: GamutId; decode(x: number): number; encode(x: number): number; glsl: string; cite: string }

// Sony: S-Log3 (Technical Summary §2, the 10-bit form)
const slog3: LogCurve = {
  id: "slog3", label: "Sony S-Log3 / S-Gamut3.Cine", gamut: "sgamut3cine", cite: "Sony, Technical Summary for S-Gamut3.Cine/S-Log3 (2014)",
  decode: (x) => (x * 1023 >= 171.2102946929 ? Math.pow(10, (x * 1023 - 420) / 261.5) * (0.18 + 0.01) - 0.01 : ((x * 1023 - 95) * 0.01125) / (171.2102946929 - 95)),
  encode: (y) => (y >= 0.01125 ? (420 + Math.log10((y + 0.01) / (0.18 + 0.01)) * 261.5) / 1023 : ((y * (171.2102946929 - 95)) / 0.01125 + 95) / 1023),
  glsl: `float decodeLog(float x) { float c = x * 1023.0; return c >= 171.2102946929 ? pow(10.0, (c - 420.0) / 261.5) * 0.19 - 0.01 : (c - 95.0) * 0.01125 / (171.2102946929 - 95.0); }`,
};
// ARRI LogC3, EI 800 (ALEXA Log C Curve – Usage in VFX, table for EI 800)
const C3 = { cut: 0.010591, a: 5.555556, b: 0.052272, c: 0.24719, d: 0.385537, e: 5.367655, f: 0.092809 };
const logc3: LogCurve = {
  id: "logc3", label: "ARRI LogC3 (EI 800) / AWG3", gamut: "awg3", cite: "ARRI, ALEXA Log C Curve – Usage in VFX (2017), EI 800",
  decode: (t) => (t > C3.e * C3.cut + C3.f ? (Math.pow(10, (t - C3.d) / C3.c) - C3.b) / C3.a : (t - C3.f) / C3.e),
  encode: (x) => (x > C3.cut ? C3.c * Math.log10(C3.a * x + C3.b) + C3.d : C3.e * x + C3.f),
  glsl: `float decodeLog(float t) { return t > ${fl(C3.e * C3.cut + C3.f)} ? (pow(10.0, (t - ${fl(C3.d)}) / ${fl(C3.c)}) - ${fl(C3.b)}) / ${fl(C3.a)} : (t - ${fl(C3.f)}) / ${fl(C3.e)}; }`,
};
// ARRI LogC4 (LogC4 Specification §4: a, b, c, s, t)
const C4 = (() => {
  const a = (2 ** 18 - 16) / 117.45, b = (1023 - 95) / 1023, c = 95 / 1023;
  const s = (7 * Math.LN2 * 2 ** (7 - (14 * c) / b)) / (a * b), t = (2 ** (14 * (-c / b) + 6) - 64) / a;
  return { a, b, c, s, t };
})();
const logc4: LogCurve = {
  id: "logc4", label: "ARRI LogC4 / AWG4", gamut: "awg4", cite: "ARRI, LogC4 Logarithmic Color Space Specification (2022)",
  decode: (x) => (x >= 0 ? (2 ** ((14 * (x - C4.c)) / C4.b + 6) - 64) / C4.a : x * C4.s + C4.t),
  encode: (e) => (e >= C4.t ? ((Math.log2(C4.a * e + 64) - 6) / 14) * C4.b + C4.c : (e - C4.t) / C4.s),
  glsl: `float decodeLog(float x) { return x >= 0.0 ? (exp2(14.0 * (x - ${fl(C4.c)}) / ${fl(C4.b)} + 6.0) - 64.0) / ${fl(C4.a)} : x * ${fl(C4.s)} + ${fl(C4.t)}; }`,
};
// Panasonic V-Log (V-Log/V-Gamut Reference Manual §2.1)
const VL = { cut1: 0.01, cut2: 0.181, b: 0.00873, c: 0.241514, d: 0.598206 };
const vlog: LogCurve = {
  id: "vlog", label: "Panasonic V-Log / V-Gamut", gamut: "vgamut", cite: "Panasonic, V-Log/V-Gamut Reference Manual (2014)",
  decode: (x) => (x < VL.cut2 ? (x - 0.125) / 5.6 : Math.pow(10, (x - VL.d) / VL.c) - VL.b),
  encode: (l) => (l < VL.cut1 ? 5.6 * l + 0.125 : VL.c * Math.log10(l + VL.b) + VL.d),
  glsl: `float decodeLog(float x) { return x < ${fl(VL.cut2)} ? (x - 0.125) / 5.6 : pow(10.0, (x - ${fl(VL.d)}) / ${fl(VL.c)}) - ${fl(VL.b)}; }`,
};
// Canon Log 3 (Canon white paper, v1.2 constants: legal-range code values), reflectance = linear × 0.9
const clog3: LogCurve = {
  id: "clog3", label: "Canon Log 3 / Cinema Gamut", gamut: "cinemagamut", cite: "Canon, Canon Log Gamma Curves white paper (v1.2 constants)",
  decode: (x) => 0.9 * (x < 0.097465473 ? -(Math.pow(10, (0.12783901 - x) / 0.36726845) - 1) / 14.98325
    : x <= 0.15277891 ? (x - 0.12512219) / 1.9754798 : (Math.pow(10, (x - 0.12240537) / 0.36726845) - 1) / 14.98325),
  encode: (y) => {
    const x = y / 0.9;
    const lo = -(Math.pow(10, (0.12783901 - 0.097465473) / 0.36726845) - 1) / 14.98325, hi = (0.15277891 - 0.12512219) / 1.9754798;
    return x < lo ? -0.36726845 * Math.log10(-x * 14.98325 + 1) + 0.12783901 : x <= hi ? 1.9754798 * x + 0.12512219 : 0.36726845 * Math.log10(x * 14.98325 + 1) + 0.12240537;
  },
  glsl: `float decodeLog(float x) {
  float l = x < 0.097465473 ? -(pow(10.0, (0.12783901 - x) / 0.36726845) - 1.0) / 14.98325
    : x <= 0.15277891 ? (x - 0.12512219) / 1.9754798 : (pow(10.0, (x - 0.12240537) / 0.36726845) - 1.0) / 14.98325;
  return 0.9 * l;
}`,
};
// DJI D-Log (white paper rev. 1.0: linear ↔ D-Log)
const dlog: LogCurve = {
  id: "dlog", label: "DJI D-Log / D-Gamut", gamut: "dgamut", cite: "DJI, White Paper on D-Log and D-Gamut (2017)",
  decode: (x) => (x <= 0.14 ? (x - 0.0929) / 6.025 : (Math.pow(10, 3.89616 * x - 2.27752) - 0.0108) / 0.9892),
  encode: (l) => (l <= 0.0078 ? 6.025 * l + 0.0929 : Math.log10(l * 0.9892 + 0.0108) * 0.256663 + 0.584555),
  glsl: `float decodeLog(float x) { return x <= 0.14 ? (x - 0.0929) / 6.025 : (pow(10.0, 3.89616 * x - 2.27752) - 0.0108) / 0.9892; }`,
};
// DJI D-Log M has no published curve: it is decoded with the D-Log / D-Gamut white paper's curve (as Resolve's
// colour space transform does); grade from there.
const dlogm: LogCurve = { ...dlog, id: "dlogm", label: "DJI D-Log M (decoded as D-Log / D-Gamut)", cite: "DJI publishes no D-Log M curve; the D-Log white paper's curve and gamut are used" };
// Blackmagic Film Generation 5 (Blackmagic Generation 5 Color Science, 2021)
const BM = { A: 0.08692876065491224, B: 0.005494072432257808, C: 0.5300133392291939, D: 8.283605932402494, E: 0.09246575342465753, LIN_CUT: 0.005 };
const bmd5: LogCurve = {
  id: "bmdfilm5", label: "Blackmagic Film Gen 5 / Wide Gamut", gamut: "bmdwg5", cite: "Blackmagic Design, Blackmagic Generation 5 Color Science (2021)",
  decode: (y) => (y < BM.D * BM.LIN_CUT + BM.E ? (y - BM.E) / BM.D : Math.exp((y - BM.C) / BM.A) - BM.B),
  encode: (x) => (x < BM.LIN_CUT ? BM.D * x + BM.E : BM.A * Math.log(x + BM.B) + BM.C),
  glsl: `float decodeLog(float y) { return y < ${fl(BM.D * BM.LIN_CUT + BM.E)} ? (y - ${fl(BM.E)}) / ${fl(BM.D)} : exp((y - ${fl(BM.C)}) / ${fl(BM.A)}) - ${fl(BM.B)}; }`,
};

export const LOG_CURVES: LogCurve[] = [slog3, logc3, logc4, vlog, clog3, dlog, dlogm, bmd5];
export const logCurve = (id: string) => LOG_CURVES.find((c) => c.id === id);
/** Camera gamut → linear BT.709 (the working primaries). */
export const cameraToRec709 = (c: LogCurve): Mat3 => gamutMatrix(GAMUTS[c.gamut], GAMUTS.bt709);

// ── display and HDR transfer functions ─────────────────────────────────────────────────────────────────────────
/** BT.1886 with black 0: display light (1.0 = reference white) ↔ signal. Extended past 1.0 and mirrored below 0. */
export const bt1886Eotf = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 2.4);
export const bt1886Inverse = (l: number) => Math.sign(l) * Math.pow(Math.abs(l), 1 / 2.4);
/** IEC 61966-2-1 sRGB. */
export const srgbEncode = (l: number) => (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
export const srgbDecode = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
/** SMPTE ST 2084 / BT.2100 PQ: absolute luminance in cd/m² ↔ signal 0..1. */
const PQ = { m1: 2610 / 16384, m2: (2523 / 4096) * 128, c1: 3424 / 4096, c2: (2413 / 4096) * 32, c3: (2392 / 4096) * 32 };
export function pqEncode(nits: number): number {
  const y = Math.max(0, nits) / 10000, p = Math.pow(y, PQ.m1);
  return Math.pow((PQ.c1 + PQ.c2 * p) / (1 + PQ.c3 * p), PQ.m2);
}
export function pqDecode(v: number): number {
  const p = Math.pow(Math.max(0, v), 1 / PQ.m2);
  return 10000 * Math.pow(Math.max(p - PQ.c1, 0) / (PQ.c2 - PQ.c3 * p), 1 / PQ.m1);
}
/** BT.2100 HLG OETF: scene light 0..1 ↔ signal 0..1. */
const HLG = { a: 0.17883277, b: 1 - 4 * 0.17883277, c: 0.5 - 0.17883277 * Math.log(4 * 0.17883277) };
export const hlgOetf = (e: number) => (e <= 1 / 12 ? Math.sqrt(3 * Math.max(e, 0)) : HLG.a * Math.log(12 * e - HLG.b) + HLG.c);
export const hlgInverse = (v: number) => (v <= 0.5 ? (v * v) / 3 : (Math.exp((v - HLG.c) / HLG.a) + HLG.b) / 12);
/** BT.2408 reference white for HDR (the working space's 1.0). */
export const REF_WHITE_NITS = 203;
/** BT.2100 HLG: system gamma for a nominal-peak display (1.2 at 1000 cd/m²). */
export const hlgGamma = (peak = 1000) => 1.2 + 0.42 * Math.log10(peak / 1000);

export type Transfer = "sdr" | "hlg" | "pq";
export type Primaries = "bt709" | "bt2020";
export const LUMA_K: Record<Primaries, [number, number]> = { bt709: [0.2126, 0.0722], bt2020: [0.2627, 0.0593] };

/**
 * One working-space pixel → the output signal R'G'B' (0..1) for a delivery transfer and primaries (BT.2408 mapping:
 * 1.0 = 203 cd/m²; HLG on a 1000 cd/m² nominal display through the inverse OOTF). SDR in BT.2020 re-encodes BT.1886.
 */
export function encodeOutput(rgb: number[], transfer: Transfer, primaries: Primaries): [number, number, number] {
  const lin = rgb.map(bt1886Eotf);
  const m = primaries === "bt2020" ? apply3(REC709_TO_2020, lin) : [lin[0], lin[1], lin[2]];
  if (transfer === "sdr") return m.map((v) => bt1886Inverse(Math.min(1, Math.max(0, v)))) as [number, number, number];
  if (transfer === "pq") return m.map((v) => pqEncode(Math.max(0, v) * REF_WHITE_NITS)) as [number, number, number];
  const [kr, kb] = LUMA_K[primaries];
  const fd = m.map((v) => (Math.max(0, v) * REF_WHITE_NITS) / 1000);
  const yd = kr * fd[0] + (1 - kr - kb) * fd[1] + kb * fd[2];
  const g = hlgGamma(1000), k = yd > 0 ? Math.pow(yd, (1 - g) / g) : 0;
  return fd.map((v) => hlgOetf(Math.min(1, v * k))) as [number, number, number];
}
export const REC709_TO_2020 = gamutMatrix(GAMUTS.bt709, GAMUTS.bt2020);

/** R'G'B' signal → 10-bit limited-range Y'CbCr codes (unrounded) for the primaries' matrix (BT.709 / BT.2020 NCL). */
export function ycc10(rgb: number[], primaries: Primaries): [number, number, number] {
  const [kr, kb] = LUMA_K[primaries], kg = 1 - kr - kb;
  const y = kr * rgb[0] + kg * rgb[1] + kb * rgb[2];
  return [64 + 876 * y, 512 + 896 * ((rgb[2] - y) / (2 * (1 - kb))), 512 + 896 * ((rgb[0] - y) / (2 * (1 - kr)))];
}

// ── tone mapping (scene-linear → display light, 1.0 = reference white) ────────────────────────────────────────────
/** "filmic": an ACES-like curve (K. Narkowicz's fit, input scaled by 0.6) that rolls highlights off into 1.0. */
export const filmic = (x: number) => { const v = Math.max(0, x) * 0.6; return Math.min(1, (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14)); };
/** "hdr": linear through the mid-tones (0.18 → ~0.14 like filmic), an exponential shoulder into `peak` (×ref white). */
export const hdrShoulder = (x: number, peak: number) => peak * (1 - Math.exp((-Math.max(0, x) * 0.78) / peak));

/** The same functions in GLSL (for effects and the read-back). */
export const TRANSFER_GLSL = `
vec3 tfEotf1886(vec3 v) { return sign(v) * pow(abs(v), vec3(2.4)); }
vec3 tfInv1886(vec3 l) { return sign(l) * pow(abs(l), vec3(1.0 / 2.4)); }
vec3 tfSrgbEncode(vec3 l) { l = max(l, 0.0); return mix(12.92 * l, 1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), l)); }
vec3 tfPq(vec3 nits) {
  vec3 p = pow(max(nits, 0.0) / 10000.0, vec3(${fl(PQ.m1)}));
  return pow((${fl(PQ.c1)} + ${fl(PQ.c2)} * p) / (1.0 + ${fl(PQ.c3)} * p), vec3(${fl(PQ.m2)}));
}
vec3 tfHlg(vec3 e) {
  e = clamp(e, 0.0, 1.0);
  return mix(sqrt(3.0 * e), ${fl(HLG.a)} * log(max(12.0 * e - ${fl(HLG.b)}, 1e-6)) + ${fl(HLG.c)}, step(vec3(1.0 / 12.0), e));
}
vec3 tmFilmic(vec3 x) { vec3 v = max(x, 0.0) * 0.6; return min((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), 1.0); }
vec3 tmHdr(vec3 x, float peak) { return peak * (1.0 - exp(-max(x, 0.0) * 0.78 / peak)); }
// highlights above the knee compressed smoothly into [knee, peak] (display light)
vec3 tmSoftClip(vec3 x, float peak) {
  float knee = 0.8 * peak;
  vec3 over = max(x - knee, 0.0);
  return min(x, vec3(knee)) + (peak - knee) * (1.0 - exp(-over / (peak - knee)));
}
`;

/** GLSL for the read-back: working RGB → output signal R'G'B' (`encodeOutput`). u_out: x transfer (0 sdr, 1 hlg, 2 pq),
 *  y primaries (0 bt709, 1 bt2020). */
export const OUTPUT_GLSL = `${TRANSFER_GLSL}
const mat3 M709_2020 = mat3(${glslMat(REC709_TO_2020)});
vec3 encodeOut(vec3 c, vec2 o) {
  vec3 lin = tfEotf1886(c);
  if (o.y > 0.5) lin = M709_2020 * lin;
  if (o.x < 0.5) return tfInv1886(clamp(lin, 0.0, 1.0));
  if (o.x > 1.5) return tfPq(max(lin, 0.0) * ${fl(REF_WHITE_NITS)});
  vec3 kw = o.y > 0.5 ? vec3(${LUMA_K.bt2020[0]}, ${fl(1 - LUMA_K.bt2020[0] - LUMA_K.bt2020[1])}, ${LUMA_K.bt2020[1]}) : vec3(${LUMA_K.bt709[0]}, ${fl(1 - LUMA_K.bt709[0] - LUMA_K.bt709[1])}, ${LUMA_K.bt709[1]});
  vec3 fd = max(lin, 0.0) * ${fl(REF_WHITE_NITS / 1000)};
  float yd = dot(fd, kw);
  float g = ${fl(hlgGamma(1000))};
  float k = yd > 0.0 ? pow(yd, (1.0 - g) / g) : 0.0;
  return tfHlg(fd * k);
}
vec3 ycc10(vec3 rgb, vec2 o) {
  float kr = o.y > 0.5 ? ${LUMA_K.bt2020[0]} : ${LUMA_K.bt709[0]}, kb = o.y > 0.5 ? ${LUMA_K.bt2020[1]} : ${LUMA_K.bt709[1]};
  float y = kr * rgb.r + (1.0 - kr - kb) * rgb.g + kb * rgb.b;
  return vec3(64.0 + 876.0 * y, 512.0 + 896.0 * (rgb.b - y) / (2.0 * (1.0 - kb)), 512.0 + 896.0 * (rgb.r - y) / (2.0 * (1.0 - kr)));
}
`;

/** GLSL constants of a log profile: `decodeLog(float)` and `const mat3 M_CAM` (camera gamut → BT.709). */
export function logProfileGlsl(c: LogCurve): string {
  return `${c.glsl}\nconst mat3 M_CAM = mat3(${glslMat(cameraToRec709(c))});`;
}

const code10 = (v: number) => Math.min(1023, Math.max(0, Math.round(v)));
/** CPU reference of readYuv420p10(): working-space RGBA floats (rows top first) → planar 4:2:0 10-bit codes for the
 *  output (encoded per pixel, chroma = the 2×2 mean of the encoded R'G'B', as the GPU does). */
export function packI420p10(rgba: ArrayLike<number>, w: number, h: number, transfer: Transfer = "sdr", primaries: Primaries = "bt709"): Uint16Array {
  const out = new Uint16Array(w * h * 1.5);
  const enc: [number, number, number][] = new Array(w * h);
  for (let i = 0; i < w * h; i++) enc[i] = encodeOutput([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]], transfer, primaries);
  for (let i = 0; i < w * h; i++) out[i] = code10(ycc10(enc[i], primaries)[0]);
  const cw = w / 2, ch = h / 2;
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    const s = [0, 0, 0];
    for (let k = 0; k < 4; k++) { const e = enc[(2 * cy + (k >> 1)) * w + 2 * cx + (k & 1)]; s[0] += e[0] / 4; s[1] += e[1] / 4; s[2] += e[2] / 4; }
    const c = ycc10(s, primaries);
    out[w * h + cy * cw + cx] = code10(c[1]);
    out[w * h + cw * ch + cy * cw + cx] = code10(c[2]);
  }
  return out;
}
