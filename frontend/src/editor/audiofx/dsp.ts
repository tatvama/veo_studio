/**
 * Sample-level DSP for the audio effects the WebAudio nodes can't do the FFmpeg way: ports of FFmpeg's agate,
 * compand (expander), acrusher, aphaser, flanger and vibrato (their published algorithms, re-written here), a
 * modulated-delay chorus, the asoftclip curves, the acrossfade curves, Chromium's compressor make-up gain (so the
 * preview can cancel it, like acompressor which has none) and the doppler path. Used by the AudioWorklet
 * (audiofx/worklet.ts) and by the tests. Pure: no DOM.
 */

export const dbToLin = (db: number) => (db <= -200 ? 0 : Math.pow(10, db / 20));
export const linToDb = (x: number) => (x <= 0 ? -Infinity : 20 * Math.log10(x));
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// ── asoftclip (FFmpeg af_asoftclip.c, threshold = output = param = 1) ─────────────────────────────────────
export type ClipType = "hard" | "tanh" | "atan" | "cubic" | "exp" | "alg" | "quintic" | "sin" | "erf";

/** Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7), as erf isn't in Math. */
export function erf(x: number): number {
  const s = Math.sign(x), a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

export function softclip(type: string, x: number): number {
  switch (type) {
    case "hard": return clamp(x, -1, 1);
    case "atan": return (2 / Math.PI) * Math.atan(x);
    case "cubic": return Math.abs(x) >= 1.5 ? Math.sign(x) : x - 0.1481 * x * x * x;
    case "exp": return 2 / (1 + Math.exp(-2 * x)) - 1;
    case "alg": return x / Math.sqrt(1 + x * x);
    case "quintic": return Math.abs(x) >= 1.25 ? Math.sign(x) : x - 0.08192 * Math.pow(x, 5);
    case "sin": return Math.abs(x) >= Math.PI / 2 ? Math.sign(x) : Math.sin(x);
    case "erf": return erf(x);
    case "tanh": default: return Math.tanh(x);
  }
}

/** A WaveShaper curve: input x in [-1, 1] (before the drive) → softclip(x · drive) · out. */
export function shaperCurve(type: string, drive: number, out = 1, size = 16385): Float32Array {
  const c = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i * 2) / (size - 1) - 1;
    c[i] = softclip(type, x * drive) * out;
  }
  return c;
}

// ── Chromium's DynamicsCompressor static curve (DynamicsCompressorKernel) ────────────────────────────────
/** The make-up gain (linear) Chromium's DynamicsCompressorNode applies by itself for these settings. The preview
 *  divides it out: acompressor has no automatic make-up. */
export function chromeCompressorMakeup(thresholdDb: number, kneeDb: number, ratio: number): number {
  const linThr = dbToLin(thresholdDb);
  const kneeCurve = (x: number, k: number) => (x < linThr ? x : linThr + (1 - Math.exp(-k * (x - linThr))) / k);
  const slopeAt = (x: number, k: number) => {
    if (x < linThr) return 1;
    const x2 = x * 1.001;
    const xDb = linToDb(x), x2Db = linToDb(x2), yDb = linToDb(kneeCurve(x, k)), y2Db = linToDb(kneeCurve(x2, k));
    return (y2Db - yDb) / (x2Db - xDb);
  };
  const desired = 1 / ratio;
  const xKnee = dbToLin(thresholdDb + kneeDb);
  let minK = 0.1, maxK = 10000, k = 5;
  for (let i = 0; i < 15; i++) {
    if (slopeAt(xKnee, k) < desired) maxK = k; else minK = k;
    k = Math.sqrt(minK * maxK);
  }
  const kneeThrDb = thresholdDb + kneeDb, kneeThr = dbToLin(kneeThrDb);
  const yKneeDb = linToDb(kneeCurve(kneeThr, k));
  const saturate = (x: number) => {
    if (x < linThr) return x;
    if (x < kneeThr) return kneeCurve(x, k);
    return dbToLin(yKneeDb + desired * (linToDb(x) - kneeThrDb));
  };
  const full = saturate(1);
  return full > 0 ? Math.pow(1 / full, 0.6) : 1;
}

// ── FFmpeg's ff_generate_wave_table (libavfilter/generate_wave_table.c) ─────────────────────────────────
export function waveTable(kind: "sin" | "tri", size: number, min: number, max: number, phase: number, ints: boolean): Float64Array<ArrayBuffer> {
  const t = new Float64Array(Math.max(1, size));
  const off = Math.floor((phase / Math.PI / 2) * size + 0.5);
  for (let i = 0; i < size; i++) {
    const point = (i + off) % size;
    let d: number;
    if (kind === "sin") d = (Math.sin((point / size) * 2 * Math.PI) + 1) / 2;
    else {
      d = (point * 2) / size;
      const q = Math.floor((4 * point) / size);
      if (q === 0) d = d + 0.5; else if (q === 1 || q === 2) d = 1.5 - d; else d = d - 1.5;
    }
    d = d * (max - min) + min;
    t[i] = ints ? Math.trunc(d + (d < 0 ? -0.5 : 0.5)) : d;
  }
  return t;
}

// ── processors: process(inputs per channel, outputs per channel, n) — state kept between blocks ─────────

/** FFmpeg agate (downward, link = average, detection peak or rms, makeup 1). Times in seconds, levels in dB. */
export class Gate {
  private slope = 0;
  private thres = 0; private kneeStart = 0; private kneeStop = 0; private linKneeStop = 0;
  private att = 1; private rel = 1; private range = 0; private ratio = 2; private knee = 2.828427; private rms = false;
  private sr: number;
  constructor(sr: number) { this.sr = sr; }
  set(p: { threshold: number; range: number; attack: number; release: number; ratio: number; knee?: number; detection?: "peak" | "rms" }) {
    this.rms = p.detection === "rms";
    this.knee = p.knee ?? 2.828427;
    let lt = dbToLin(p.threshold);
    if (this.rms) lt *= lt;
    const ks = Math.sqrt(this.knee);
    this.att = Math.min(1, 1 / ((p.attack * 1000 * this.sr) / 4000));
    this.rel = Math.min(1, 1 / ((p.release * 1000 * this.sr) / 4000));
    this.linKneeStop = lt * ks;
    this.thres = Math.log(lt); this.kneeStart = Math.log(lt / ks); this.kneeStop = Math.log(lt * ks);
    this.range = dbToLin(p.range); this.ratio = p.ratio;
  }
  private gain(lin: number): number {
    const slope = Math.log(lin);
    let g = (slope - this.thres) * this.ratio + this.thres;
    if (this.knee > 1 && slope > this.kneeStart) g = hermite(slope, this.kneeStart, this.kneeStop, (this.kneeStart - this.thres) * this.ratio + this.thres, this.kneeStop, this.ratio, 1);
    return Math.max(this.range, Math.exp(g - slope));
  }
  process(inp: Float32Array[], out: Float32Array[], n: number) {
    const nc = inp.length;
    for (let i = 0; i < n; i++) {
      let a = 0;
      for (let c = 0; c < nc; c++) a += Math.abs(inp[c][i]);
      a /= nc || 1;
      if (this.rms) a *= a;
      this.slope += (a - this.slope) * (a > this.slope ? this.att : this.rel);
      const g = this.slope > 0 && this.slope < this.linKneeStop ? this.gain(this.slope) : 1;
      for (let c = 0; c < nc; c++) out[c][i] = inp[c][i] * g;
    }
  }
}

function hermite(x: number, x0: number, x1: number, p0: number, p1: number, m0: number, m1: number): number {
  const w = x1 - x0, t = (x - x0) / w;
  m0 *= w; m1 *= w;
  const t2 = t * t, t3 = t2 * t;
  const c2 = -3 * p0 - 2 * m0 + 3 * p1 - m1, c3 = 2 * p0 + m0 - 2 * p1 + m1;
  return c3 * t3 + c2 * t2 + m0 * t + p0;
}

/**
 * FFmpeg compand as a downward expander: `points=-90/<o>|<T>/<T>|0/0`, per-channel envelopes (attack / decay rates
 * 1 − e^(−1/(sr·t))), initial volume −90 dB, gain flat below −90 dB.
 */
export class Expander {
  private vol: number[] = [];
  private att = 1; private dec = 1; private T = -40; private ratio = 2;
  private sr: number;
  constructor(sr: number) { this.sr = sr; }
  set(p: { threshold: number; ratio: number; attack: number; release: number }) {
    const rate = (s: number) => (s > 1 / this.sr ? 1 - Math.exp(-1 / (this.sr * s)) : 1);
    this.att = rate(p.attack); this.dec = rate(p.release); this.T = p.threshold; this.ratio = p.ratio;
  }
  /** Gain (dB) at an envelope level (dB): (ratio − 1)(in − T) below T, 0 above, held below −90 dB. */
  gainDb(inDb: number): number {
    const x = Math.max(-90, inDb);
    return x >= this.T ? 0 : (x - this.T) * (this.ratio - 1);
  }
  process(inp: Float32Array[], out: Float32Array[], n: number) {
    for (let c = 0; c < inp.length; c++) {
      let v = this.vol[c] ?? dbToLin(-90);
      const a = inp[c], o = out[c];
      for (let i = 0; i < n; i++) {
        const x = Math.abs(a[i]), d = x - v;
        v += d * (d > 0 ? this.att : this.dec);
        o[i] = a[i] * dbToLin(this.gainDb(linToDb(v)));
      }
      this.vol[c] = v;
    }
  }
}

/**
 * Bitcrusher: FFmpeg acrusher's sample reduction (hold every `samples`) then its linear bit reduction
 * (coeff 2^bits − 1, dc 1, aa 0), mixed with the dry signal by `mix` (1 = all crushed).
 */
export class Crusher {
  private srCount: number[] = []; private last: number[] = [];
  private coeff = 255; private round = 1; private mix = 1;
  set(p: { bits: number; samples: number; mix: number }) {
    this.coeff = Math.pow(2, p.bits) - 1; this.round = Math.max(1, Math.round(p.samples)); this.mix = p.mix;
  }
  crush(x: number): number {
    const y = (x + 1) * this.coeff;
    return Math.round(y) / this.coeff - 1;
  }
  process(inp: Float32Array[], out: Float32Array[], n: number) {
    for (let c = 0; c < inp.length; c++) {
      let cnt = this.srCount[c] ?? 0, last = this.last[c] ?? 0;
      const a = inp[c], o = out[c];
      for (let i = 0; i < n; i++) {
        cnt++;
        if (cnt >= this.round) { last = a[i]; cnt = 0; }
        const k = this.crush(last);
        o[i] = a[i] * (1 - this.mix) + k * this.mix;
      }
      this.srCount[c] = cnt; this.last[c] = last;
    }
  }
}

/** FFmpeg aphaser: a modulated feedback delay (triangle or sine), delay in ms. */
export class Phaser {
  private buf: Float64Array[] = []; private mod = new Float64Array(1);
  private dlen = 1; private mlen = 1; private dpos = 0; private mpos = 0; private key = "";
  private inGain = 0.4; private outGain = 0.74; private decay = 0.4;
  private sr: number;
  constructor(sr: number) { this.sr = sr; }
  set(p: { inGain: number; outGain: number; delay: number; decay: number; speed: number; type: string }, channels = 2) {
    this.inGain = p.inGain; this.outGain = p.outGain; this.decay = p.decay;
    const key = `${p.delay}|${p.speed}|${p.type}|${channels}`;
    if (key === this.key) return;
    this.key = key;
    this.dlen = Math.max(1, Math.floor(p.delay * 0.001 * this.sr + 0.5));
    this.mlen = Math.max(1, Math.floor(this.sr / p.speed + 0.5));
    this.mod = waveTable(p.type === "s" ? "sin" : "tri", this.mlen, 1, this.dlen, Math.PI / 2, true);
    this.buf = Array.from({ length: channels }, () => new Float64Array(this.dlen));
    this.dpos = 0; this.mpos = 0;
  }
  process(inp: Float32Array[], out: Float32Array[], n: number) {
    const nc = Math.min(inp.length, this.buf.length);
    for (let i = 0; i < n; i++) {
      const m = this.mod[this.mpos];
      let rd = this.dpos + m; if (rd >= this.dlen) rd -= this.dlen;
      const np = this.dpos + 1 >= this.dlen ? 0 : this.dpos + 1;
      for (let c = 0; c < nc; c++) {
        const b = this.buf[c];
        const v = inp[c][i] * this.inGain + b[rd] * this.decay;
        b[np] = v;
        out[c][i] = v * this.outGain;
      }
      this.mpos = this.mpos + 1 >= this.mlen ? 0 : this.mpos + 1;
      this.dpos = np;
    }
  }
}

/** FFmpeg flanger (sine, linear interpolation, channel phase 25 %). Times in ms, regen / width in %. */
export class Flanger {
  private buf: Float64Array[] = []; private lfo = new Float64Array(1); private last: number[] = [];
  private max = 3; private lfoLen = 1; private pos = 0; private lfoPos = 0; private key = "";
  private inGain = 1; private dGain = 0; private fb = 0;
  private sr: number;
  constructor(sr: number) { this.sr = sr; }
  set(p: { delay: number; depth: number; regen: number; width: number; speed: number }, channels = 2) {
    const fb = p.regen / 100;
    let dg = p.width / 100;
    this.inGain = 1 / (1 + dg); dg /= 1 + dg; dg *= 1 - Math.abs(fb);
    this.dGain = dg; this.fb = fb;
    const key = `${p.delay}|${p.depth}|${p.speed}|${channels}`;
    if (key === this.key) return;
    this.key = key;
    const dmin = p.delay / 1000, depth = p.depth / 1000;
    this.max = Math.floor((dmin + depth) * this.sr + 2.5);
    this.lfoLen = Math.max(1, Math.floor(this.sr / p.speed));
    this.lfo = waveTable("sin", this.lfoLen, Math.round(dmin * this.sr), this.max - 2, 3 * Math.PI / 2, false);
    this.buf = Array.from({ length: channels }, () => new Float64Array(this.max));
    this.last = new Array(channels).fill(0);
    this.pos = 0; this.lfoPos = 0;
  }
  process(inp: Float32Array[], out: Float32Array[], n: number) {
    const nc = Math.min(inp.length, this.buf.length), M = this.max;
    for (let i = 0; i < n; i++) {
      this.pos = (this.pos + M - 1) % M;
      for (let c = 0; c < nc; c++) {
        const ph = Math.floor(c * this.lfoLen * 0.25 + 0.5);
        const d = this.lfo[(this.lfoPos + ph) % this.lfoLen];
        const id = Math.floor(d), fr = d - id;
        const b = this.buf[c], x = inp[c][i];
        b[this.pos] = x + this.last[c] * this.fb;
        const d0 = b[(this.pos + id) % M], d1 = b[(this.pos + id + 1) % M];
        const y = d0 + (d1 - d0) * fr;
        this.last[c] = y;
        out[c][i] = x * this.inGain + y * this.dGain;
      }
      this.lfoPos = (this.lfoPos + 1) % this.lfoLen;
    }
  }
}

/** FFmpeg vibrato: a sine-modulated delay of up to depth × 5 ms, fully wet. */
export class Vibrato {
  private buf: Float64Array[] = []; private wave = new Float64Array(1);
  private size = 1; private wsize = 1; private bi = 0; private wi = 0; private depth = 0.5; private key = "";
  private sr: number;
  constructor(sr: number) { this.sr = sr; }
  set(p: { rate: number; depth: number }, channels = 2) {
    this.depth = p.depth;
    const key = `${p.rate}|${channels}`;
    if (key === this.key) return;
    this.key = key;
    this.size = Math.max(2, Math.round(this.sr * 0.005));
    this.wsize = Math.max(1, Math.round(this.sr / p.rate));
    this.wave = waveTable("sin", this.wsize, 0, this.size - 1, 3 * Math.PI / 2, false);
    this.buf = Array.from({ length: channels }, () => new Float64Array(this.size));
    this.bi = 0; this.wi = 0;
  }
  process(inp: Float32Array[], out: Float32Array[], n: number) {
    const nc = Math.min(inp.length, this.buf.length), S = this.size;
    for (let i = 0; i < n; i++) {
      const v = this.depth * this.wave[this.wi];
      const integer = Math.floor(v), dec = v - integer;
      this.wi = this.wi + 1 >= this.wsize ? 0 : this.wi + 1;
      for (let c = 0; c < nc; c++) {
        const b = this.buf[c];
        let s1 = this.bi + integer; if (s1 >= S) s1 -= S;
        let s2 = s1 + 1; if (s2 >= S) s2 -= S;
        const x = inp[c][i];
        out[c][i] = b[s1] + dec * (b[s2] - b[s1]);
        b[this.bi] = x;
      }
      this.bi = this.bi + 1 >= S ? 0 : this.bi + 1;
    }
  }
}

/** Chorus: out = in + mix · in(t − (delay + depth·(1 + sin 2πft)/2)), times in ms (FFmpeg chorus, one voice). */
export class Chorus {
  private buf: Float64Array[] = []; private size = 1; private pos = 0; private phase = 0;
  private delay = 25; private depth = 2; private rate = 0.5; private mix = 0.5;
  private sr: number;
  constructor(sr: number) { this.sr = sr; }
  set(p: { delay: number; depth: number; rate: number; mix: number }, channels = 2) {
    Object.assign(this, { delay: p.delay, depth: p.depth, rate: p.rate, mix: p.mix });
    const need = Math.ceil(((p.delay + p.depth) / 1000) * this.sr) + 4;
    if (need > this.size || this.buf.length !== channels) {
      this.size = Math.max(need, 64);
      this.buf = Array.from({ length: channels }, () => new Float64Array(this.size));
      this.pos = 0;
    }
  }
  process(inp: Float32Array[], out: Float32Array[], n: number) {
    const nc = Math.min(inp.length, this.buf.length), S = this.size;
    const w = (2 * Math.PI * this.rate) / this.sr;
    for (let i = 0; i < n; i++) {
      const d = ((this.delay + this.depth * (1 + Math.sin(this.phase)) / 2) / 1000) * this.sr;
      this.phase += w; if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
      const id = Math.floor(d), fr = d - id;
      for (let c = 0; c < nc; c++) {
        const b = this.buf[c], x = inp[c][i];
        b[this.pos] = x;
        const a0 = b[(this.pos - id + S * 4) % S], a1 = b[(this.pos - id - 1 + S * 4) % S];
        out[c][i] = x + this.mix * (a0 + (a1 - a0) * fr);
      }
      this.pos = (this.pos + 1) % S;
    }
  }
}

// ── acrossfade / afade curves (libavfilter/af_afade.c fade_gain) ────────────────────────────────────────
/** Gain 0..1 of a fade-in at progress x (0..1); a fade-out uses curve(1 − x). */
export function fadeGain(curve: string, x: number): number {
  const g = clamp(x, 0, 1);
  const cube = (a: number) => a * a * a;
  switch (curve) {
    case "qsin": return Math.sin((g * Math.PI) / 2);
    case "iqsin": return 0.6366198862296516 * Math.asin(g);
    case "esin": return 1 - Math.cos((Math.PI / 4) * (cube(2 * g - 1) + 1));
    case "hsin": return (1 - Math.cos(g * Math.PI)) / 2;
    case "ihsin": return 0.3183098861837907 * Math.acos(1 - 2 * g);
    case "exp": return Math.exp(-11.512925464970227 * (1 - g));
    case "log": return g <= 0 ? 0 : clamp(1 + 0.2 * Math.log10(g), 0, 1);
    case "par": return 1 - Math.sqrt(1 - g);
    case "ipar": return 1 - (1 - g) * (1 - g);
    case "qua": return g * g;
    case "cub": return cube(g);
    case "squ": return Math.sqrt(g);
    case "cbr": return Math.cbrt(g);
    case "dese": return g <= 0.5 ? Math.cbrt(2 * g) / 2 : 1 - Math.cbrt(2 * (1 - g)) / 2;
    case "desi": return g <= 0.5 ? cube(2 * g) / 2 : 1 - cube(2 * (1 - g)) / 2;
    case "losi": {
      const a = 1 / (1 - 0.787) - 1;
      const A = 1 / (1 + Math.exp(-((g - 0.5) * a * 2))), B = 1 / (1 + Math.exp(a)), C = 1 / (1 + Math.exp(-a));
      return (A - B) / (C - B);
    }
    case "sinc": return g >= 1 ? 1 : Math.sin(Math.PI * (1 - g)) / (Math.PI * (1 - g));
    case "isinc": return g <= 0 ? 0 : 1 - Math.sin(Math.PI * g) / (Math.PI * g);
    case "nofade": return 1;
    case "tri": default: return g;
  }
}

// ── doppler (registry "doppler") ─────────────────────────────────────────────────────────────────────────
export const SPEED_OF_SOUND = 343;
/**
 * A source on a straight path: "pass_lr" / "pass_rl" move along x at `speed` (m/s), `distance` metres in front of
 * the listener, closest at `center` × the clip's length; "approach" / "recede" move straight towards / away, reaching /
 * leaving the closest distance then. Returns the extra delay (s, relative to the closest point: what makes the pitch
 * change in the preview's delay line), the level (inverse distance, 1 at the closest point), the pan (x / distance) and
 * the pitch factor c / (c + radial speed) for the export.
 */
export function dopplerAt(p: { path: string; speed: number; distance: number; center: number }, t: number, duration: number) {
  const tc = clamp(p.center, 0, 1) * duration, d0 = Math.max(0.1, p.distance), v = Math.max(0, p.speed);
  const pos = (u: number): [number, number] => {
    if (p.path === "approach") return [0, d0 + v * Math.max(0, tc - u)];
    if (p.path === "recede") return [0, d0 + v * Math.max(0, u - tc)];
    const x = v * (u - tc);
    return [p.path === "pass_rl" ? -x : x, d0];
  };
  const dist = (u: number) => { const [x, y] = pos(u); return Math.hypot(x, y); };
  const [x] = pos(t), r = dist(t);
  const h = 1e-3, vr = (dist(t + h) - dist(t - h)) / (2 * h);
  return { delay: (r - d0) / SPEED_OF_SOUND, gain: Math.min(1, d0 / r), pan: clamp(x / r, -1, 1), rate: SPEED_OF_SOUND / (SPEED_OF_SOUND + vr), distance: r };
}
