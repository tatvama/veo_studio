/**
 * The built-in impulse responses (docs/EDITOR.md §11): one deterministic recipe shared by the preview and the export.
 * The desktop writes these as 48 kHz stereo float WAVs to `userData/irs/<preset>.wav` and serves them at
 * `/__media/irs/<preset>.wav`; the preview's ConvolverNode loads that file, and generates the same samples itself with
 * `makeIr()` when the file isn't there (a plain browser). Pure, no DOM: copy this file verbatim to the desktop so the
 * WAVs are bit-identical (only Math.exp / Math.sin / Math.sqrt and float32 rounding are involved).
 *
 * Reverbs: early reflections (a sparse set of signed taps) followed by exponentially decaying noise in two bands, the
 * highs dying faster with `damping`; the right channel's noise is decorrelated by `width`. Cabinets (guitar amp):
 * a short band-limited burst with a low resonance. Every channel is scaled to unit energy (Σh² = 1), so a wet signal
 * keeps the dry signal's level for noise-like material; the convolution runs with no further normalisation
 * (ConvolverNode.normalize = false, afir irnorm=-1 irgain=1).
 */

export const IR_RATE = 48000;

export interface ReverbIrSpec { kind: "reverb"; /** metres */ size: number; /** RT60, seconds */ decay: number; /** 0..1 */ damping: number; /** ms */ predelay: number; /** 0..1 */ width: number }
export interface CabinetIrSpec { kind: "cabinet"; /** Hz */ lowpass: number; highpass: number; resonance: number; /** ms */ length: number }
export type IrSpec = ReverbIrSpec | CabinetIrSpec;

export const IR_PRESETS: Record<string, IrSpec> = {
  room: { kind: "reverb", size: 5, decay: 0.6, damping: 0.5, predelay: 5, width: 0.7 },
  studio: { kind: "reverb", size: 4, decay: 0.35, damping: 0.6, predelay: 3, width: 0.6 },
  hall: { kind: "reverb", size: 25, decay: 2.2, damping: 0.4, predelay: 25, width: 1 },
  plate: { kind: "reverb", size: 2, decay: 1.6, damping: 0.2, predelay: 0, width: 1 },
  church: { kind: "reverb", size: 30, decay: 3.2, damping: 0.45, predelay: 30, width: 0.9 },
  cathedral: { kind: "reverb", size: 50, decay: 5, damping: 0.5, predelay: 45, width: 1 },
  stage: { kind: "reverb", size: 15, decay: 1.4, damping: 0.4, predelay: 15, width: 0.9 },
  bathroom: { kind: "reverb", size: 2.5, decay: 0.9, damping: 0.15, predelay: 2, width: 0.5 },
  stairwell: { kind: "reverb", size: 8, decay: 2, damping: 0.3, predelay: 10, width: 0.6 },
  cab_1x12: { kind: "cabinet", lowpass: 5000, highpass: 90, resonance: 110, length: 20 },
  cab_2x12: { kind: "cabinet", lowpass: 4200, highpass: 80, resonance: 100, length: 25 },
  cab_4x12: { kind: "cabinet", lowpass: 3400, highpass: 70, resonance: 90, length: 30 },
};
export const IR_NAMES = Object.keys(IR_PRESETS);

/** FNV-1a 32-bit of a string (the preset's seed). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** mulberry32: a tiny deterministic PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LN1000 = 6.907755278982137; // -60 dB = e^-6.9078

/** One-pole low-pass coefficient for a cutoff (y += (1 - a)(x - y)). */
const onePole = (fc: number, rate: number) => Math.exp((-2 * Math.PI * fc) / rate);

function unitEnergy(ch: Float32Array[]): Float32Array[] {
  for (const c of ch) {
    let e = 0;
    for (let i = 0; i < c.length; i++) e += c[i] * c[i];
    const k = e > 0 ? 1 / Math.sqrt(e) : 0;
    for (let i = 0; i < c.length; i++) c[i] *= k;
  }
  return ch;
}

function reverbIr(name: string, s: ReverbIrSpec, rate: number): Float32Array[] {
  const rnd = mulberry32(fnv1a(name));
  const t0 = s.predelay / 1000 + s.size / 343;          // the first reflection
  const len = Math.min(rate * 8, Math.round(rate * (t0 + s.decay * 1.1 + 0.05)));
  const L = new Float32Array(len), R = new Float32Array(len);
  // early reflections: signed taps over 2.5 "room crossings", decaying with the room
  const taps = 6 + Math.round(Math.min(s.size, 30) / 2);
  const er: [number, number, number][] = [];
  for (let k = 0; k < taps; k++) {
    const t = t0 + (s.size / 343) * rnd() * 2.5;
    const sign = rnd() < 0.5 ? -1 : 1;
    const aL = sign * (0.5 + 0.5 * rnd()), aR = sign * (0.5 + 0.5 * rnd()) * (rnd() < s.width * 0.5 ? -1 : 1);
    er.push([t, aL, aR]);
  }
  // the tail: two-band noise, highs decaying faster with damping
  const aLow = onePole(1500, rate);
  const hiDecay = s.decay * (1 - 0.85 * s.damping);
  const wn = Math.sqrt(s.width * s.width + (1 - s.width) * (1 - s.width)) || 1;
  let lowL = 0, lowR = 0;
  const start = Math.floor(t0 * rate);
  for (let i = 0; i < len; i++) {
    const uL = 2 * rnd() - 1, uR = 2 * rnd() - 1;
    const nL = uL, nR = (s.width * uR + (1 - s.width) * uL) / wn;
    lowL += (1 - aLow) * (nL - lowL); lowR += (1 - aLow) * (nR - lowR);
    if (i < start) continue;
    const t = (i - start) / rate;
    const eLo = Math.exp((-LN1000 * t) / s.decay), eHi = Math.exp((-LN1000 * t) / hiDecay);
    const ramp = Math.min(1, t / 0.004);
    L[i] = ramp * (lowL * eLo + (nL - lowL) * eHi) * 0.35;
    R[i] = ramp * (lowR * eLo + (nR - lowR) * eHi) * 0.35;
  }
  for (const [t, aL, aR] of er) {
    const i = Math.round(t * rate);
    if (i >= len) continue;
    const g = Math.exp((-LN1000 * (t - t0)) / s.decay);
    L[i] += aL * g; R[i] += aR * g;
  }
  return unitEnergy([L, R]);
}

function cabinetIr(name: string, s: CabinetIrSpec, rate: number): Float32Array[] {
  const rnd = mulberry32(fnv1a(name));
  const len = Math.round((rate * s.length) / 1000);
  const tau = s.length / 1000 / 5;
  const h = new Float32Array(len);
  const aHp = onePole(s.highpass, rate), aLp = onePole(s.lowpass, rate);
  let hpY = 0, hpX = 0, lp1 = 0, lp2 = 0;
  for (let i = 0; i < len; i++) {
    const t = i / rate;
    const x = (2 * rnd() - 1) * Math.exp(-t / tau) + 0.5 * Math.sin(2 * Math.PI * s.resonance * t) * Math.exp(-t / (2 * tau));
    // one-pole high-pass, then two one-pole low-passes
    hpY = aHp * (hpY + x - hpX); hpX = x;
    lp1 += (1 - aLp) * (hpY - lp1);
    lp2 += (1 - aLp) * (lp1 - lp2);
    h[i] = lp2;
  }
  return unitEnergy([h, Float32Array.from(h)]);
}

/** The impulse response of a preset: [left, right] at `rate` (48 kHz: the shared WAVs). */
export function makeIr(name: string, rate = IR_RATE): Float32Array[] {
  const s = IR_PRESETS[name];
  if (!s) throw new Error(`No impulse response "${name}"`);
  return s.kind === "reverb" ? reverbIr(name, s, rate) : cabinetIr(name, s, rate);
}

/** A float32 WAV (format 3) of the channels: what the desktop writes to userData/irs/<preset>.wav. */
export function wavFloat32(ch: Float32Array[], rate = IR_RATE): Uint8Array {
  const n = ch[0]?.length ?? 0, nc = ch.length, bytes = n * nc * 4;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + bytes, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, nc, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * nc * 4, true); v.setUint16(32, nc * 4, true); v.setUint16(34, 32, true);
  str(36, "data"); v.setUint32(40, bytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { v.setFloat32(o, ch[c][i], true); o += 4; }
  return new Uint8Array(buf);
}

/** The gateway URL of a preset's WAV. */
export const irUrl = (name: string) => `/__media/irs/${name}.wav`;
