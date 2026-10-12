/**
 * Loudness maths (ITU-R BS.1770-4 / EBU R128): K-weighting for any sample rate (libebur128's analogue-prototype
 * derivation; at 48 kHz it gives the standard's coefficients), momentary (400 ms), short-term (3 s) and gated
 * integrated loudness, true peak (4× oversampling with the standard's 48-tap interpolator) and the stereo phase
 * correlation. Used by the meter worklet (audiofx/worklet.ts), "Match loudness" in a plain browser and the tests.
 * Pure: no DOM.
 */

export interface BiquadCoefs { b: [number, number, number]; a: [number, number, number] }

/** The two K-weighting stages (pre-filter shelf, RLB high-pass) at `fs`. */
export function kWeighting(fs: number): [BiquadCoefs, BiquadCoefs] {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  const shelf: BiquadCoefs = {
    b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  };
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  const d = 1 + K / Q + K * K;
  const hp: BiquadCoefs = { b: [1, -2, 1], a: [1, (2 * (K * K - 1)) / d, (1 - K / Q + K * K) / d] };
  return [shelf, hp];
}

/** BS.1770-4 table 1 and 2: the 48 kHz coefficients. */
export const K48_REFERENCE: [BiquadCoefs, BiquadCoefs] = [
  { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] },
  { b: [1, -2, 1], a: [1, -1.99004745483398, 0.99007225036621] },
];

/** A direct-form-I biquad over one channel (state kept). */
export class Biquad {
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  private c: BiquadCoefs;
  constructor(c: BiquadCoefs) { this.c = c; }
  step(x: number): number {
    const { b, a } = this.c;
    const y = b[0] * x + b[1] * this.x1 + b[2] * this.x2 - a[1] * this.y1 - a[2] * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
  reset() { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
}

/** Loudness (LUFS) of a mean-square sum over the channels. */
export const lufsOfPower = (p: number) => (p > 0 ? -0.691 + 10 * Math.log10(p) : -Infinity);

/** Gated integrated loudness from 400 ms block powers (absolute −70 LUFS, then relative −10 LU). */
export function gatedLoudness(blocks: ArrayLike<number>, count = blocks.length): number {
  const absThr = Math.pow(10, (-70 + 0.691) / 10);
  let sum = 0, n = 0;
  for (let i = 0; i < count; i++) { const p = blocks[i]; if (p > absThr) { sum += p; n++; } }
  if (!n) return -Infinity;
  const relThr = (sum / n) * Math.pow(10, -10 / 10);
  let s2 = 0, n2 = 0;
  for (let i = 0; i < count; i++) { const p = blocks[i]; if (p > absThr && p > relThr) { s2 += p; n2++; } }
  return n2 ? lufsOfPower(s2 / n2) : -Infinity;
}

/** BS.1770-4 Annex 2: the 4-phase, 12-taps-per-phase true-peak interpolator. */
export const TRUE_PEAK_TAPS: number[][] = [
  [0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625, 0.97216796875, -0.102294921875, 0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500],
  [-0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625, 0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375],
  [-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625, 0.465087890625, -0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875],
  [-0.0083007812500, 0.0148925781250, -0.0266113281250, 0.0476074218750, -0.102294921875, 0.97216796875, 0.1373291015625, -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375],
];

/** True peak of one channel, streamed: the largest |x| of the 4× interpolated signal (and the samples). */
export class TruePeak {
  private h = new Float64Array(12); private pos = 0;
  max = 0;
  step(x: number): number {
    this.h[this.pos] = x;
    let m = Math.abs(x);
    for (const taps of TRUE_PEAK_TAPS) {
      let y = 0;
      for (let k = 0; k < 12; k++) y += taps[k] * this.h[(this.pos - k + 12) % 12];
      const a = Math.abs(y);
      if (a > m) m = a;
    }
    this.pos = (this.pos + 1) % 12;
    if (m > this.max) this.max = m;
    return m;
  }
}

/**
 * A streaming loudness meter (stereo or mono): K-weighted 100 ms sub-blocks give the momentary (last 4) and
 * short-term (last 30) loudness and, from every 400 ms block (75 % overlap), the gated integrated loudness. Also the
 * true peak (overall and over the last ~300 ms), the sample peak and the phase correlation (300 ms window).
 */
export class LoudnessMeter {
  private k: Biquad[][];
  private tp: TruePeak[];
  private sub = 0; private subN = 0; private readonly subLen: number;
  private subs: number[] = [];             // the last 30 sub-block powers
  private blocks = new Float64Array(1024); private nBlocks = 0;
  private lr = 0; private ll = 0; private rr = 0; private readonly cw: number;
  private recentTp = 0; private recentAt = 0;
  samplePeak = 0;
  readonly fs: number; readonly channels: number;
  constructor(fs: number, channels = 2) {
    this.fs = fs; this.channels = channels;
    const [s, h] = kWeighting(fs);
    this.k = Array.from({ length: channels }, () => [new Biquad(s), new Biquad(h)]);
    this.tp = Array.from({ length: channels }, () => new TruePeak());
    this.subLen = Math.round(fs / 10);
    this.cw = 1 - Math.exp(-1 / (0.3 * fs));
  }
  push(ch: Float32Array[], n: number) {
    const nc = Math.min(this.channels, ch.length);
    for (let i = 0; i < n; i++) {
      let e = 0;
      for (let c = 0; c < nc; c++) {
        const x = ch[c][i];
        const y = this.k[c][1].step(this.k[c][0].step(x));
        e += y * y;
        const t = this.tp[c].step(x);
        if (t > this.recentTp) this.recentTp = t;
        const a = Math.abs(x);
        if (a > this.samplePeak) this.samplePeak = a;
      }
      if (nc >= 2) {
        const L = ch[0][i], R = ch[1][i], w = this.cw;
        this.lr += w * (L * R - this.lr); this.ll += w * (L * L - this.ll); this.rr += w * (R * R - this.rr);
      }
      this.sub += e; this.subN++;
      if (this.subN >= this.subLen) this.closeSub();
    }
    this.recentAt += n;
    if (this.recentAt > this.fs * 0.3) { this.recentAt = 0; this.lastTp = this.recentTp; this.recentTp = 0; }
  }
  private lastTp = 0;
  private closeSub() {
    this.subs.push(this.sub / this.subN);
    if (this.subs.length > 30) this.subs.shift();
    this.sub = 0; this.subN = 0;
    if (this.subs.length >= 4) {
      const L = this.subs.length;
      const p = (this.subs[L - 1] + this.subs[L - 2] + this.subs[L - 3] + this.subs[L - 4]) / 4;
      if (this.nBlocks >= this.blocks.length) { const b = new Float64Array(this.blocks.length * 2); b.set(this.blocks); this.blocks = b; }
      this.blocks[this.nBlocks++] = p;
    }
  }
  private mean(k: number) {
    const L = this.subs.length;
    if (L < k) return -Infinity;
    let s = 0;
    for (let i = L - k; i < L; i++) s += this.subs[i];
    return lufsOfPower(s / k);
  }
  momentary() { return this.mean(4); }
  shortTerm() { return this.mean(30); }
  integrated() { return gatedLoudness(this.blocks, this.nBlocks); }
  /** dBTP: the largest so far, and over the last ~300 ms. */
  truePeak() { return 20 * Math.log10(Math.max(1e-12, ...this.tp.map((t) => t.max))); }
  truePeakNow() { return 20 * Math.log10(Math.max(1e-12, this.lastTp, this.recentTp)); }
  /** −1 (out of phase) … 0 (unrelated) … +1 (mono). */
  correlation() { const d = Math.sqrt(this.ll * this.rr); return d > 1e-12 ? Math.max(-1, Math.min(1, this.lr / d)) : 0; }
  reset() {
    for (const c of this.k) for (const b of c) b.reset();
    this.tp = Array.from({ length: this.channels }, () => new TruePeak());
    this.sub = 0; this.subN = 0; this.subs = []; this.nBlocks = 0; this.lr = this.ll = this.rr = 0; this.samplePeak = 0; this.lastTp = this.recentTp = 0;
  }
}

/** Integrated loudness (LUFS) and true peak (dBTP) of whole channels, in one pass. */
export function measureLoudness(ch: Float32Array[], fs: number): { lufs: number; truePeak: number; samplePeak: number } {
  const m = new LoudnessMeter(fs, ch.length);
  const n = ch[0]?.length ?? 0, step = 4096;
  for (let i = 0; i < n; i += step) {
    const k = Math.min(step, n - i);
    m.push(ch.map((c) => c.subarray(i, i + k)), k);
  }
  return { lufs: m.integrated(), truePeak: m.truePeak(), samplePeak: 20 * Math.log10(Math.max(1e-12, m.samplePeak)) };
}

/** The gain (dB) that brings `lufs` to `target`, clamped to ±`limit` (no change when it can't be measured). */
export function matchGain(lufs: number | null | undefined, target: number, limit = 30): number {
  if (lufs === null || lufs === undefined || !Number.isFinite(lufs)) return 0;
  return Math.max(-limit, Math.min(limit, Math.round((target - lufs) * 10) / 10));
}
