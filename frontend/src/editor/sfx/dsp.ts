/**
 * The SFX engine's building blocks (docs/EDITOR.md §15.1): oscillators (sine, saw, square and triangle with polyBLEP,
 * two-operator FM, detuned stacks), noise (white, pink, brown, sparse dust), state-variable filters that sweep, RBJ
 * shelves and peaks, envelopes (percussive, ADSR, swells, breakpoints), pitch glides, tanh drive, bitcrush, comb and
 * feedback delays, a Freeverb-style reverb tail, stereo spread (decorrelation, Haas, pan, M/S width), granular scatter,
 * variable-speed playback (tape stop, scratch) and the mixing helpers.
 *
 * Everything works on Float64 sample arrays with a seeded PRNG (mulberry32), and uses nothing but arithmetic and the
 * Math functions: pure, no DOM and no WebAudio, so the node tests, a worker and the page render the same samples.
 */
import { mulberry32 } from "../audiofx/ir.ts";

export type Sig = Float64Array;
/** A constant, or one value per sample. */
export type Curve = number | Sig;
export type Stereo = [Sig, Sig];

export const TAU = 2 * Math.PI;
const LN1000 = 6.907755278982137; // −60 dB = e^−6.9078

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const at = (c: Curve, i: number) => (typeof c === "number" ? c : c[i]);
/** A frequency ratio for semitones. */
export const semis = (s: number) => Math.pow(2, s / 12);
export const db = (d: number) => Math.pow(10, d / 20);
export const sig = (n: number): Sig => new Float64Array(Math.max(0, Math.floor(n)));
export const secs = (s: number, sr: number) => Math.max(0, Math.round(s * sr));

/** A 32-bit mix of two integers (seeds for independent random streams). */
export function mix32(a: number, b: number): number {
  let h = Math.imul((a ^ 0x9e3779b9) >>> 0, 0x85ebca6b) ^ Math.imul((b + 0x7f4a7c15) >>> 0, 0xc2b2ae35);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A seeded random source. `fork(k)` gives an independent stream, so one layer's numbers don't move when another
 *  layer's length changes. */
export class Rng {
  readonly seed: number;
  private r: () => number;
  constructor(seed: number) { this.seed = seed >>> 0; this.r = mulberry32(this.seed); }
  next(): number { return this.r(); }
  /** −1..1 */
  bi(): number { return 2 * this.r() - 1; }
  range(a: number, b: number): number { return a + (b - a) * this.r(); }
  int(a: number, b: number): number { return a + Math.floor(this.r() * (b - a + 1)); }
  chance(p: number): boolean { return this.r() < p; }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.r() * xs.length) % xs.length]; }
  gauss(): number { const u = Math.max(1e-12, this.r()), v = this.r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); }
  fork(k: number): Rng { return new Rng(mix32(this.seed, k)); }
}

// ── envelopes and curves ────────────────────────────────────────────────────────────────────────────────

/** Linear attack (s), an optional hold, then an exponential decay that is −60 dB `decay` s later. */
export function perc(n: number, sr: number, attack: number, decay: number, hold = 0): Sig {
  const out = sig(n), a = Math.max(1, Math.round(attack * sr)), h = Math.round(hold * sr);
  const k = -LN1000 / Math.max(1, decay * sr);
  for (let i = 0; i < n; i++) out[i] = i < a ? i / a : i < a + h ? 1 : Math.exp(k * (i - a - h));
  return out;
}

/** ADSR over the whole buffer (s): linear attack, exponential decay to `s`, then a release over the last `r` s. */
export function adsr(n: number, sr: number, a: number, d: number, s: number, r: number): Sig {
  const out = sig(n), A = Math.max(1, Math.round(a * sr)), R = Math.max(1, Math.min(n - A, Math.round(r * sr)));
  const relAt = Math.max(A, n - R), kd = -LN1000 / 1.5 / Math.max(1, d * sr);
  let v = 0;
  for (let i = 0; i < relAt; i++) { v = i < A ? i / A : s + (1 - s) * Math.exp(kd * (i - A)); out[i] = v; }
  for (let i = relAt; i < n; i++) { const u = (i - relAt) / R; out[i] = v * (1 - u) * Math.exp(-3 * u); }
  return out;
}

/** A swell over the buffer: up to 1 at `peak` (0..1) and back to 0 at the end, raised-cosine segments shaped by the
 *  exponents (> 1 = slower start of the rise, or a faster fall). */
export function swell(n: number, peak: number, rise = 1, fall = 1): Sig {
  const out = sig(n), p = clamp(peak, 0.001, 0.999);
  for (let i = 0; i < n; i++) {
    const u = n > 1 ? i / (n - 1) : 0;
    const s = u < p ? u / p : (1 - u) / (1 - p);
    out[i] = Math.pow(0.5 - 0.5 * Math.cos(Math.PI * s), u < p ? rise : fall);
  }
  return out;
}

/** Breakpoints `[seconds, value, curve?]`: power-curved segments (1 = straight); the last value holds. */
export function bpf(n: number, sr: number, pts: [number, number, number?][]): Sig {
  const out = sig(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    while (k < pts.length - 1 && t >= pts[k + 1][0]) k++;
    const a = pts[k], b = pts[Math.min(k + 1, pts.length - 1)];
    if (b === a || t <= a[0]) { out[i] = t < pts[0][0] ? pts[0][1] : a[1]; continue; }
    const u = clamp((t - a[0]) / Math.max(1e-9, b[0] - a[0]), 0, 1);
    out[i] = a[1] + (b[1] - a[1]) * Math.pow(u, b[2] ?? 1);
  }
  return out;
}

/** Values from `a` to `b` over the buffer (or its first `dur` s), shaped by u^curve. */
export function ramp(n: number, a: number, b: number, curve = 1, sr = 0, dur = 0): Sig {
  const out = sig(n), N = dur > 0 && sr > 0 ? Math.max(1, Math.min(n, secs(dur, sr))) : n;
  for (let i = 0; i < n; i++) out[i] = a + (b - a) * Math.pow(Math.min(1, i / Math.max(1, N - 1)), curve);
  return out;
}

/** An exponential glide in frequency from f0 to f1 over the buffer (or its first `dur` s), shaped by u^curve. */
export function glide(n: number, f0: number, f1: number, curve = 1, sr = 0, dur = 0): Sig {
  const out = sig(n), N = dur > 0 && sr > 0 ? Math.max(1, Math.min(n, secs(dur, sr))) : n, r = Math.log(f1 / f0);
  for (let i = 0; i < n; i++) out[i] = f0 * Math.exp(r * Math.pow(Math.min(1, i / Math.max(1, N - 1)), curve));
  return out;
}

/** A smooth random wander in −1..1 (cosine-interpolated random points `rate` times a second). */
export function wander(n: number, sr: number, rng: Rng, rate: number): Sig {
  const out = sig(n), step = Math.max(1, Math.round(sr / Math.max(0.01, rate)));
  let a = rng.bi(), b = rng.bi();
  for (let i = 0; i < n; i++) {
    const k = i % step;
    if (k === 0 && i > 0) { a = b; b = rng.bi(); }
    const u = k / step;
    out[i] = a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * u));
  }
  return out;
}

// ── oscillators ─────────────────────────────────────────────────────────────────────────────────────────

export type Wave = "sine" | "saw" | "square" | "tri";

function blep(t: number, dt: number): number {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

/** Adds `gain` × an oscillator at `freq` × `ratio` into `dst` (band-limited saw and square). Returns the end phase. */
export function oscInto(dst: Sig, sr: number, freq: Curve, wave: Wave, gain: Curve = 1, ratio = 1, phase = 0, pw = 0.5): number {
  let ph = phase - Math.floor(phase);
  const n = dst.length;
  for (let i = 0; i < n; i++) {
    const dt = Math.min(0.49, Math.abs(at(freq, i) * ratio) / sr);
    let y: number;
    if (wave === "saw") y = 2 * ph - 1 - blep(ph, dt);
    else if (wave === "square") {
      let t2 = ph - pw; if (t2 < 0) t2 += 1;
      y = (ph < pw ? 1 : -1) + blep(ph, dt) - blep(t2, dt);
    } else if (wave === "tri") y = 4 * Math.abs(ph - 0.5) - 1;
    else y = Math.sin(TAU * ph);
    dst[i] += at(gain, i) * y;
    ph += dt;
    if (ph >= 1) ph -= Math.floor(ph);
  }
  return ph;
}

export function osc(n: number, sr: number, freq: Curve, wave: Wave = "sine", phase = 0, pw = 0.5): Sig {
  const out = sig(n);
  oscInto(out, sr, freq, wave, 1, 1, phase, pw);
  return out;
}

/** Two-operator FM: sin(carrier + index · sin(modulator)), the modulator at `ratio` × the carrier. */
export function fm(n: number, sr: number, freq: Curve, ratio: number, index: Curve, phase = 0): Sig {
  const out = sig(n);
  let pc = phase, pm = 0;
  for (let i = 0; i < n; i++) {
    const f = at(freq, i);
    out[i] = Math.sin(TAU * pc + at(index, i) * Math.sin(TAU * pm));
    pc += f / sr; pm += (f * ratio) / sr;
    if (pc >= 1) pc -= Math.floor(pc);
    if (pm >= 1) pm -= Math.floor(pm);
  }
  return out;
}

/** A detuned stack ("supersaw"): `voices` spread over ±`cents`, random phases, panned alternately up to ±`spread`. */
export function stack(n: number, sr: number, freq: Curve, voices: number, cents: number, rng: Rng, spread = 0.6, wave: Wave = "saw"): Stereo {
  const L = sig(n), R = sig(n), g = 1 / Math.sqrt(Math.max(1, voices));
  for (let v = 0; v < voices; v++) {
    const d = voices > 1 ? (v / (voices - 1)) * 2 - 1 : 0;
    const p = clamp((v % 2 ? 1 : -1) * spread * (0.35 + 0.65 * Math.abs(d)), -1, 1);
    const th = ((p + 1) * Math.PI) / 4;
    const tmp = sig(n);
    oscInto(tmp, sr, freq, wave, 1, Math.pow(2, (d * cents + rng.bi() * cents * 0.15) / 1200), rng.next());
    add(L, tmp, g * Math.cos(th) * Math.SQRT2);
    add(R, tmp, g * Math.sin(th) * Math.SQRT2);
  }
  return [L, R];
}

/** Decaying partials ("modal" bells, bars, plates): `[ratio, amplitude, decay s]` over f0. */
export function modal(n: number, sr: number, f0: Curve, partials: [number, number, number][], rng?: Rng): Sig {
  const out = sig(n);
  for (const [ratio, amp, decay] of partials) {
    const k = -LN1000 / Math.max(1, decay * sr);
    let ph = rng ? rng.next() : 0;
    for (let i = 0; i < n; i++) {
      const f = at(f0, i) * ratio;
      if (f >= sr * 0.49) break;
      out[i] += amp * Math.exp(k * i) * Math.sin(TAU * ph);
      ph += f / sr;
      if (ph >= 1) ph -= 1;
    }
  }
  return out;
}

// ── noise ───────────────────────────────────────────────────────────────────────────────────────────────

export function white(n: number, rng: Rng): Sig {
  const out = sig(n);
  for (let i = 0; i < n; i++) out[i] = rng.bi();
  return out;
}

/** Pink noise (Paul Kellet's filter), about the level of the white noise it comes from. */
export function pink(n: number, rng: Rng): Sig {
  const out = sig(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng.bi();
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.16;
    b6 = w * 0.115926;
  }
  return out;
}

/** Brown (red) noise: leaky integrated white noise. */
export function brown(n: number, rng: Rng): Sig {
  const out = sig(n);
  let b = 0;
  for (let i = 0; i < n; i++) { b = (b + 0.02 * rng.bi()) / 1.02; out[i] = b * 3.5; }
  return out;
}

export type NoiseColor = "white" | "pink" | "brown";
export const noise = (color: NoiseColor, n: number, rng: Rng) => (color === "pink" ? pink(n, rng) : color === "brown" ? brown(n, rng) : white(n, rng));

/** Sparse single-sample clicks, `rate` a second on average, of random sign and size (crackle, rain, debris). */
export function dust(n: number, sr: number, rng: Rng, rate: Curve, size = 1): Sig {
  const out = sig(n);
  for (let i = 0; i < n; i++) if (rng.next() < at(rate, i) / sr) out[i] = (rng.chance(0.5) ? 1 : -1) * size * (0.2 + 0.8 * Math.pow(rng.next(), 2));
  return out;
}

// ── filters ─────────────────────────────────────────────────────────────────────────────────────────────

/** "bp" has 0 dB at the centre whatever the Q; "bpq" (resonant band) rises with Q. */
export type FType = "lp" | "hp" | "bp" | "bpq" | "notch";

/** The TPT state-variable filter (Zavalishin / Simper), 12 dB/oct: stable while the cutoff and Q sweep. */
export function svf(x: Sig, sr: number, type: FType, fc: Curve, q: Curve = Math.SQRT1_2): Sig {
  const n = x.length, out = sig(n), fixed = typeof fc === "number" && typeof q === "number";
  let ic1 = 0, ic2 = 0, k = 0, a1 = 0, a2 = 0, a3 = 0;
  const coef = (f: number, qq: number) => {
    const g = Math.tan((Math.PI * clamp(f, 5, sr * 0.49)) / sr);
    k = 1 / Math.max(0.05, qq); a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
  };
  if (fixed) coef(fc as number, q as number);
  for (let i = 0; i < n; i++) {
    if (!fixed) coef(at(fc, i), at(q, i));
    const v0 = x[i], v3 = v0 - ic2;
    const v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    out[i] = type === "lp" ? v2 : type === "hp" ? v0 - k * v1 - v2 : type === "bp" ? k * v1 : type === "bpq" ? v1 : v0 - k * v1;
  }
  return out;
}

/** Two SVF stages in series (24 dB/oct). */
export const svf2 = (x: Sig, sr: number, type: FType, fc: Curve, q: Curve = Math.SQRT1_2) => svf(svf(x, sr, type, fc, q), sr, type, fc, q);

/** RBJ cookbook biquads (static): a peaking band or a shelf, `gain` dB. */
export function eq(x: Sig, sr: number, type: "peak" | "lowshelf" | "highshelf", f: number, gain: number, q = 0.707): Sig {
  const A = Math.pow(10, gain / 40), w = (TAU * clamp(f, 5, sr * 0.49)) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type === "peak") { b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; } else {
    const sq = 2 * Math.sqrt(A) * al, s = type === "lowshelf" ? 1 : -1;
    b0 = A * ((A + 1) - s * (A - 1) * cs + sq); b1 = 2 * s * A * ((A - 1) - s * (A + 1) * cs); b2 = A * ((A + 1) - s * (A - 1) * cs - sq);
    a0 = (A + 1) + s * (A - 1) * cs + sq; a1 = -2 * s * ((A - 1) + s * (A + 1) * cs); a2 = (A + 1) + s * (A - 1) * cs - sq;
  }
  const out = sig(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; out[i] = y;
  }
  return out;
}

/** One-pole low-pass (6 dB/oct). */
export function lp1(x: Sig, sr: number, fc: Curve): Sig {
  const out = sig(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.exp((-TAU * clamp(at(fc, i), 1, sr * 0.49)) / sr); y += (1 - a) * (x[i] - y); out[i] = y; }
  return out;
}
/** One-pole high-pass (6 dB/oct). */
export function hp1(x: Sig, sr: number, fc: Curve): Sig {
  const l = lp1(x, sr, fc);
  for (let i = 0; i < x.length; i++) l[i] = x[i] - l[i];
  return l;
}

// ── shaping ─────────────────────────────────────────────────────────────────────────────────────────────

/** tanh saturation, `amount` 0..1 (small signals keep their level; loud ones flatten towards 1 / k). */
export function drive(x: Sig, amount: Curve): Sig {
  const out = sig(x.length);
  for (let i = 0; i < x.length; i++) { const k = 1 + 24 * clamp(at(amount, i), 0, 1); out[i] = Math.tanh(k * x[i]) / Math.sqrt(k); }
  return out;
}

/** Bit crusher: `bits` (1..24, may sweep) and a sample-and-hold of `hold` samples (≥ 1, may sweep). */
export function crush(x: Sig, bits: Curve, hold: Curve = 1): Sig {
  const out = sig(x.length);
  let held = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    if (cnt <= 0) { const q = Math.pow(2, clamp(at(bits, i), 1, 24) - 1); held = Math.round(x[i] * q) / q; cnt = Math.max(1, at(hold, i)); }
    out[i] = held; cnt--;
  }
  return out;
}

// ── delays ──────────────────────────────────────────────────────────────────────────────────────────────

/** A feedback comb / flanger: y = x + fb · damped(y delayed by `delay` s, swept, linear interpolation), mixed with
 *  the dry signal by `mix`. */
export function comb(x: Sig, sr: number, delay: Curve, fb: number, damp = 0, mix = 0.5): Sig {
  const n = x.length, out = sig(n);
  let maxD = 0;
  if (typeof delay === "number") maxD = delay; else for (let i = 0; i < n; i++) if (delay[i] > maxD) maxD = delay[i];
  const size = Math.ceil(maxD * sr) + 4, buf = new Float64Array(size);
  let w = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const d = clamp(at(delay, i) * sr, 1, size - 2);
    let r = w - d; if (r < 0) r += size;
    const i0 = Math.floor(r), fr = r - i0, s0 = buf[i0], s1 = buf[(i0 + 1) % size];
    const dl = s0 + (s1 - s0) * fr;
    lp += (1 - damp) * (dl - lp);
    const y = x[i] + fb * lp;
    buf[w] = y; w = (w + 1) % size;
    out[i] = (1 - mix) * x[i] + mix * y;
  }
  return out;
}

/** A stereo feedback echo, ping-pong when asked: `time` s, feedback, wet `mix`, damping of the repeats. */
export function echo(st: Stereo, sr: number, time: number, fb: number, mix: number, damp = 0.3, pingpong = true): Stereo {
  const n = st[0].length, d = Math.max(1, Math.round(time * sr));
  const bl = new Float64Array(d), br = new Float64Array(d), L = sig(n), R = sig(n);
  let w = 0, ll = 0, lr = 0;
  for (let i = 0; i < n; i++) {
    const dl = bl[w], dr = br[w];
    ll += (1 - damp) * (dl - ll); lr += (1 - damp) * (dr - lr);
    if (pingpong) { bl[w] = st[0][i] * 0.7 + st[1][i] * 0.3 + fb * lr; br[w] = fb * ll; } else { bl[w] = st[0][i] + fb * ll; br[w] = st[1][i] + fb * lr; }
    w = (w + 1) % d;
    L[i] = st[0][i] + mix * ll; R[i] = st[1][i] + mix * lr;
  }
  return [L, R];
}

// ── reverb (Freeverb's structure: 8 damped combs + 4 allpasses per side, Jezar's public-domain tunings) ─────

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const APS = [556, 441, 341, 225];
const SPREAD = 23;
export interface VerbOpts { size: number; wet: number; dry?: number; damp?: number; width?: number; predelay?: number }

/** The feedback of the combs for a room `size` 0..1. */
const roomFb = (size: number) => 0.7 + 0.28 * clamp(size, 0, 1);
/** Seconds the reverb's tail takes to fall 60 dB for a `size` (cap 10 s). */
export const reverbTail = (size: number) => Math.min(10, (3 * 0.0306) / -Math.log10(roomFb(size)));

/** A reverb tail. `wet` 1 gives a tail of about the dry sound's energy; the buffer must already have room for it. */
export function reverb(st: Stereo, sr: number, o: VerbOpts): Stereo {
  const n = st[0].length, sc = sr / 44100, fb = roomFb(o.size), d1 = clamp(o.damp ?? 0.4, 0, 1) * 0.4, d2 = 1 - d1;
  // energy of the 8 combs' impulse responses (≈ 8 / (1 − fb²), less with damping): wet 1 ≈ the dry energy
  const gIn = (1 / Math.sqrt((8 * 2) / (1 - fb * fb))) * (1 + d1 * 1.5);
  const width = clamp(o.width ?? 1, 0, 1), wet1 = o.wet * (width / 2 + 0.5), wet2 = o.wet * ((1 - width) / 2), dry = o.dry ?? 1;
  const pre = Math.max(0, Math.round((o.predelay ?? 0) * sr));
  // the send is high-passed (12 dB/oct at 160 Hz): the lows stay dry and centred, so the tail never cancels in mono
  const sum = sig(n);
  for (let i = 0; i < n; i++) sum[i] = st[0][i] + st[1][i];
  const send = svf(sum, sr, "hp", 160, Math.SQRT1_2);
  const outs: Sig[] = [];
  for (let side = 0; side < 2; side++) {
    const off = side ? SPREAD : 0;
    const cb = COMBS.map((c) => new Float64Array(Math.max(2, Math.round((c + off) * sc))));
    const ci = new Array(8).fill(0), cs = new Array(8).fill(0);
    const ab = APS.map((a) => new Float64Array(Math.max(2, Math.round((a + off) * sc))));
    const ai = new Array(4).fill(0);
    const out = sig(n);
    for (let i = 0; i < n; i++) {
      const j = i - pre;
      const input = j >= 0 ? send[j] * gIn : 0;
      let acc = 0;
      for (let c = 0; c < 8; c++) {
        const b = cb[c], k = ci[c], y = b[k];
        cs[c] = y * d2 + cs[c] * d1;
        b[k] = input + cs[c] * fb;
        ci[c] = k + 1 === b.length ? 0 : k + 1;
        acc += y;
      }
      for (let a = 0; a < 4; a++) {
        const b = ab[a], k = ai[a], bo = b[k];
        b[k] = acc + bo * 0.5;
        acc = bo - acc;
        ai[a] = k + 1 === b.length ? 0 : k + 1;
      }
      out[i] = acc;
    }
    outs.push(out);
  }
  const L = sig(n), R = sig(n);
  for (let i = 0; i < n; i++) {
    L[i] = outs[0][i] * wet1 + outs[1][i] * wet2 + st[0][i] * dry;
    R[i] = outs[1][i] * wet1 + outs[0][i] * wet2 + st[1][i] * dry;
  }
  return [L, R];
}

// ── stereo ──────────────────────────────────────────────────────────────────────────────────────────────

export const mono = (x: Sig): Stereo => [x, Float64Array.from(x)];

/** Constant-power pan, unity at the centre (like the export's mono pan): `p` −1 (left) … 1 (right), may move. */
export function pan(x: Sig, p: Curve): Stereo {
  const n = x.length, L = sig(n), R = sig(n);
  for (let i = 0; i < n; i++) {
    const th = ((clamp(at(p, i), -1, 1) + 1) * Math.PI) / 4;
    L[i] = x[i] * Math.cos(th) * Math.SQRT2; R[i] = x[i] * Math.sin(th) * Math.SQRT2;
  }
  return [L, R];
}

function allpasses(x: Sig, sr: number, taps: [number, number][]): Sig {
  let y = x;
  for (const [ms, g] of taps) {
    const d = Math.max(1, Math.round((ms / 1000) * sr)), buf = new Float64Array(d), out = sig(y.length);
    let w = 0;
    for (let i = 0; i < y.length; i++) { const bo = buf[w]; const v = y[i] + g * bo; out[i] = bo - g * v; buf[w] = v; w = (w + 1) % d; }
    y = out;
  }
  return y;
}
const AP_L: [number, number][] = [[2.31, 0.5], [7.03, 0.45], [1.23, 0.4], [4.61, 0.35]];
const AP_R: [number, number][] = [[3.11, 0.5], [5.87, 0.45], [1.49, 0.4], [3.73, 0.35]];

/** Spreads a mono sound: `width` 0 = centred … 1 = two decorrelated channels (a different allpass chain each side).
 *  Below about 220 Hz it stays centred, so it sums to mono without cancelling. */
export function spread(x: Sig, sr: number, width: number): Stereo {
  const w = clamp(width, 0, 1);
  if (w <= 0) return mono(x);
  const low = svf(x, sr, "lp", 220, Math.SQRT1_2), hi = sig(x.length);
  for (let i = 0; i < x.length; i++) hi[i] = x[i] - low[i];
  const a = allpasses(hi, sr, AP_L), b = allpasses(hi, sr, AP_R), L = sig(x.length), R = sig(x.length);
  for (let i = 0; i < x.length; i++) { L[i] = low[i] + (1 - w) * hi[i] + w * a[i]; R[i] = low[i] + (1 - w) * hi[i] + w * b[i]; }
  return [L, R];
}

/** Haas: one side delayed by `ms`, so the sound leans to the other (`side` −1 leans left, 1 right). */
export function haas(x: Sig, sr: number, ms: number, side = 1): Stereo {
  const d = Math.round((ms / 1000) * sr), late = sig(x.length);
  for (let i = d; i < x.length; i++) late[i] = x[i - d];
  return side >= 0 ? [late, Float64Array.from(x)] : [Float64Array.from(x), late];
}

/** M/S width: 0 = mono, 1 = as it is, 2 = twice the side signal. */
export function width(st: Stereo, w: number): Stereo {
  const n = st[0].length, L = sig(n), R = sig(n);
  for (let i = 0; i < n; i++) { const m = (st[0][i] + st[1][i]) / 2, s = ((st[0][i] - st[1][i]) / 2) * w; L[i] = m + s; R[i] = m - s; }
  return [L, R];
}

/** Moves a stereo pair by a balance curve (−1 … 1). */
export function balance(st: Stereo, p: Curve): Stereo {
  const n = st[0].length;
  for (let i = 0; i < n; i++) {
    const v = clamp(at(p, i), -1, 1), th = ((v + 1) * Math.PI) / 4;
    st[0][i] *= Math.cos(th) * Math.SQRT2; st[1][i] *= Math.sin(th) * Math.SQRT2;
  }
  return st;
}

// ── mixing ──────────────────────────────────────────────────────────────────────────────────────────────

/** dst[offset + i] += g · src[i] (what fits). */
export function add(dst: Sig, src: Sig, g: Curve = 1, offset = 0): Sig {
  const from = Math.max(0, -offset), to = Math.min(src.length, dst.length - offset);
  if (typeof g === "number") { for (let i = from; i < to; i++) dst[offset + i] += g * src[i]; } else for (let i = from; i < to; i++) dst[offset + i] += g[i] * src[i];
  return dst;
}
/** Mixes a mono (centred) or stereo sound into a stereo buffer. */
export function addSt(dst: Stereo, src: Stereo | Sig, g: Curve = 1, offset = 0): Stereo {
  if (src instanceof Float64Array) { add(dst[0], src, g, offset); add(dst[1], src, g, offset); } else { add(dst[0], src[0], g, offset); add(dst[1], src[1], g, offset); }
  return dst;
}
/** x *= env (in place). */
export function mul(x: Sig, env: Curve): Sig {
  if (typeof env === "number") { for (let i = 0; i < x.length; i++) x[i] *= env; } else for (let i = 0; i < x.length; i++) x[i] *= env[Math.min(i, env.length - 1)];
  return x;
}
export const mulSt = (st: Stereo, env: Curve): Stereo => { mul(st[0], env); mul(st[1], env); return st; };
export const reverse = (x: Sig): Sig => Float64Array.from(x).reverse();
export const reverseSt = (st: Stereo): Stereo => [reverse(st[0]), reverse(st[1])];
/** A copy `n` samples long (cut or zero-padded). */
export function fit(x: Sig, n: number): Sig { const o = sig(n); o.set(x.length > n ? x.subarray(0, n) : x); return o; }
export const fitSt = (st: Stereo, n: number): Stereo => [fit(st[0], n), fit(st[1], n)];
export const stereo = (n: number): Stereo => [sig(n), sig(n)];
export function peakOf(x: Sig): number { let m = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; } return m; }
/** Scales a signal so its peak is `to`. */
export function norm(x: Sig, to = 1): Sig { const p = peakOf(x); return p > 0 ? mul(x, to / p) : x; }

// ── events ──────────────────────────────────────────────────────────────────────────────────────────────

export interface Grain { x: Sig | Stereo; gain?: number; pan?: number }

/** Scatters grains over [from, to) as a Poisson process at `rate` events a second (a curve is sampled by thinning,
 *  so a rate that starts at 0 still fills in): `make` returns the grain (or null to skip one), mixed in at its pan.
 *  Returns how many were placed. */
export function scatter(out: Stereo, sr: number, rng: Rng, rate: Curve, make: (r: Rng, i: number, k: number) => Grain | null, from = 0, to = out[0].length): number {
  let top = 0;
  if (typeof rate === "number") top = rate; else for (let j = from; j < Math.min(to, rate.length); j++) if (rate[j] > top) top = rate[j];
  if (!(top > 0)) return 0;
  let i = from, k = 0;
  while (i < to) {
    i += Math.max(1, Math.round((-Math.log(Math.max(1e-9, rng.next())) / top) * sr));
    if (i >= to) break;
    if (typeof rate !== "number" && rng.next() * top > rate[Math.min(i, rate.length - 1)]) continue;
    const gr = make(rng, i, k++);
    if (!gr) continue;
    const g = gr.gain ?? 1;
    if (gr.x instanceof Float64Array) addSt(out, pan(gr.x, gr.pan ?? 0), g, i); else addSt(out, gr.x, g, i);
  }
  return k;
}

/** A short burst of band-passed noise (a clap, a drop, a key): centre `fc`, `q`, attack and decay (s). */
export function burst(sr: number, rng: Rng, fc: number, q: number, attack: number, decay: number, type: FType = "bp"): Sig {
  const n = secs(attack + decay * 1.2, sr) + 1;
  return mul(svf(white(n, rng), sr, type, fc, q), perc(n, sr, attack, decay));
}

/** A decaying sine ping (optionally gliding from f to f·`bend`). */
export function ping(sr: number, f: number, decay: number, attack = 0.001, bend = 1, bendTime = 0.02): Sig {
  const n = secs(attack + decay, sr) + 1;
  const fr = bend !== 1 ? glide(n, f, f * bend, 0.6, sr, bendTime) : f;
  return mul(osc(n, sr, fr), perc(n, sr, attack, decay));
}

/** Plays `x` at a varying speed (`rate` per output sample, may be negative): tape stop / start, scratching. Linear
 *  interpolation; silent outside the source. */
export function vari(x: Sig, rate: Curve, n: number, start = 0): Sig {
  const out = sig(n);
  let p = start;
  for (let i = 0; i < n; i++) {
    if (p >= 0 && p < x.length - 1) { const i0 = Math.floor(p), f = p - i0; out[i] = x[i0] + (x[i0 + 1] - x[i0]) * f; }
    p += at(rate, i);
  }
  return out;
}

/** Fades the first `inS` and last `outS` seconds (raised cosine) in place. */
export function fades(st: Stereo, sr: number, inS: number, outS: number): Stereo {
  const n = st[0].length, a = Math.min(n, secs(inS, sr)), b = Math.min(n, secs(outS, sr));
  for (let i = 0; i < a; i++) { const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / a); st[0][i] *= g; st[1][i] *= g; }
  for (let i = 0; i < b; i++) { const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / b); st[0][n - 1 - i] *= g; st[1][n - 1 - i] *= g; }
  return st;
}
