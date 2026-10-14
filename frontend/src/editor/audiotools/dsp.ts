/**
 * Small DSP helpers for the audio tools (docs/EDITOR.md §15.4): an in-place radix-2 FFT, the Hann window, dB, a
 * percentile, a seeded random generator and a portable base64. The desktop (desktop/src/main/editor-audiotools.ts) and
 * the page run these same files, so their numbers agree. Pure: no DOM, no Node.
 */

/** In-place radix-2 FFT (re, im of length 2^k). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** The periodic Hann window of length n. */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Amplitude → dB (−240 for silence). */
export const ampDb = (a: number) => (a > 1e-12 ? 20 * Math.log10(a) : -240);
/** Power (mean square) → dB (−240 for silence). */
export const powDb = (p: number) => (p > 1e-24 ? 10 * Math.log10(p) : -240);
export const dbAmp = (db: number) => Math.pow(10, db / 20);
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** The p-th percentile (0..1) of the values that pass `keep` (NaN when none do). */
export function percentile(xs: ArrayLike<number>, p: number, keep: (x: number) => boolean = Number.isFinite): number {
  const v: number[] = [];
  for (let i = 0; i < xs.length; i++) if (keep(xs[i])) v.push(xs[i]);
  if (!v.length) return Number.NaN;
  v.sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
}

/** A small seeded PRNG (mulberry32): the same seed gives the same numbers everywhere. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A hash of an integer to 0..1 (stateless: particle i always gets the same value). */
export function hash01(i: number, salt = 0): number {
  let h = (Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 0x27d4eb2f, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Bytes → base64 (works in the page and in Node, without Buffer or btoa). */
export function toBase64(b: Uint8Array): string {
  const out: string[] = [];
  let chunk = "";
  for (let i = 0; i < b.length; i += 3) {
    const x = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    chunk += B64[(x >> 18) & 63] + B64[(x >> 12) & 63] + (i + 1 < b.length ? B64[(x >> 6) & 63] : "=") + (i + 2 < b.length ? B64[x & 63] : "=");
    if (chunk.length >= 8192) { out.push(chunk); chunk = ""; }
  }
  out.push(chunk);
  return out.join("");
}

/** base64 → bytes (whitespace ignored); throws on anything else. */
export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  if (clean.length % 4 !== 0) throw new Error("Not base64");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => {
      const c = clean.charCodeAt(i + k);
      if (clean[i + k] === "=") return 0;
      const d = c < 128 ? B64_INV[c] : -1;
      if (d < 0) throw new Error("Not base64");
      return d;
    });
    const x = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    if (o < out.length) out[o++] = (x >> 16) & 255;
    if (o < out.length) out[o++] = (x >> 8) & 255;
    if (o < out.length) out[o++] = x & 255;
  }
  return out;
}

/**
 * A growable sample buffer for streaming analysis: append chunks, read by absolute sample index (zeros outside what
 * it holds), and drop what is no longer needed.
 */
export class SampleQueue {
  private buf = new Float32Array(1 << 15);
  /** Absolute index of buf[0], and how many samples are held from there. */
  private base = 0;
  private len = 0;
  /** Samples pushed so far. */
  get total() { return this.base + this.len; }
  push(x: Float32Array) {
    if (this.len + x.length > this.buf.length) {
      const nb = new Float32Array(Math.max(this.buf.length * 2, this.len + x.length));
      nb.set(this.buf.subarray(0, this.len));
      this.buf = nb;
    }
    this.buf.set(x, this.len);
    this.len += x.length;
  }
  /** Copies samples [from, from + out.length) into `out` (zeros where there are none). */
  read(from: number, out: Float64Array | Float32Array) {
    for (let i = 0; i < out.length; i++) {
      const k = from + i - this.base;
      out[i] = k >= 0 && k < this.len ? this.buf[k] : 0;
    }
  }
  /** Forgets the samples before absolute index `keepFrom`. */
  drop(keepFrom: number) {
    const k = Math.min(this.len, Math.max(0, keepFrom - this.base));
    if (k <= 0) return;
    this.buf.copyWithin(0, k, this.len);
    this.len -= k;
    this.base += k;
  }
}
