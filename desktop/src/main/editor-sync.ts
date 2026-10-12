/**
 * Audio sync for multicam (docs/EDITOR.md §10): two clips' sound decoded to 8 kHz mono (the first 120 s of each), a
 * light pre-emphasis so speech and claps give a sharp peak instead of a broad hum, then the normalised cross-correlation
 * over lags of ±maxOffset seconds, computed with one FFT pair (zero-padded, so nothing wraps around). Each lag is
 * normalised by the energy of the part where the two overlap (at least 2 s, or a quarter of the shorter clip). The peak
 * is refined to a fraction of a sample. Pure (test/editor-tools.test.ts).
 */

export const SYNC_RATE = 8000;
/** Seconds of each clip that are compared. */
export const SYNC_WINDOW_S = 120;
export const SYNC_MAX_OFFSET_S = 60;

export function syncDecodeArgs(src: string, seconds = SYNC_WINDOW_S): string[] {
  return ["-i", src, "-vn", "-map", "0:a:0", "-ac", "1", "-ar", String(SYNC_RATE), "-t", String(seconds), "-f", "f32le", "-"];
}

/** In-place radix-2 FFT; `inverse` without the 1/N scale. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function prep(x: Float32Array, n: number): Float64Array {
  const out = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n || 1;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i] - mean;
    out[i] = v - 0.97 * prev; // pre-emphasis
    prev = v;
  }
  return out;
}

/**
 * The offset (seconds) with `b(t + offset) ≈ a(t)`: the same moment is at t in a and at t + offset in b. Confidence is
 * |NCC| at the peak (0..1); margin is (peak − next best peak at least 50 ms away) / peak.
 */
export function syncOffset(a: Float32Array, b: Float32Array, rate = SYNC_RATE, maxOffsetS = SYNC_MAX_OFFSET_S): { offset: number; confidence: number; margin: number } {
  const la = a.length;
  const lb = b.length;
  if (la < rate / 4 || lb < rate / 4) throw new Error("Both clips need at least a quarter of a second of sound");
  const pa = prep(a, la);
  const pb = prep(b, lb);
  let n = 1;
  while (n < la + lb) n <<= 1;
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(pa);
  br.set(pb);
  fft(ar, ai);
  fft(br, bi);
  // conj(A) · B → r[τ] = Σ a[t]·b[t+τ]
  for (let k = 0; k < n; k++) {
    const xr = ar[k], xi = -ai[k], yr = br[k], yi = bi[k];
    ar[k] = xr * yr - xi * yi;
    ai[k] = xr * yi + xi * yr;
  }
  fft(ar, ai, true);
  // prefix sums of squares for the overlap energies
  const sa = new Float64Array(la + 1);
  const sb = new Float64Array(lb + 1);
  for (let i = 0; i < la; i++) sa[i + 1] = sa[i] + pa[i] * pa[i];
  for (let i = 0; i < lb; i++) sb[i + 1] = sb[i] + pb[i] * pb[i];
  const maxLag = Math.min(Math.round(maxOffsetS * rate), la + lb - 2);
  const minOverlap = Math.max(Math.min(2 * rate, Math.min(la, lb)), Math.floor(Math.min(la, lb) / 4));
  const lo = -Math.min(maxLag, la - 1);
  const hi = Math.min(maxLag, lb - 1);
  const ncc = new Float64Array(hi - lo + 1);
  let best = -1;
  let bestAbs = 0;
  for (let tau = lo; tau <= hi; tau++) {
    // overlap: t in [max(0, -tau), min(la, lb - tau))
    const t0 = Math.max(0, -tau);
    const t1 = Math.min(la, lb - tau);
    const len = t1 - t0;
    let v = 0;
    if (len >= minOverlap) {
      const ea = sa[t1] - sa[t0];
      const eb = sb[t1 + tau] - sb[t0 + tau];
      const den = Math.sqrt(ea * eb);
      if (den > 1e-12) v = ar[(tau + n) % n] / n / den;
    }
    ncc[tau - lo] = v;
    const av = Math.abs(v);
    if (av > bestAbs) { bestAbs = av; best = tau; }
  }
  if (best < lo || bestAbs <= 0) throw new Error("There's no sound in common to line the clips up by");
  // next best peak at least 50 ms away
  const guard = Math.round(rate * 0.05);
  let second = 0;
  for (let i = 0; i < ncc.length; i++) {
    const tau = i + lo;
    if (Math.abs(tau - best) <= guard) continue;
    const av = Math.abs(ncc[i]);
    if (av > second) second = av;
  }
  // parabolic refinement
  const i = best - lo;
  let delta = 0;
  if (i > 0 && i < ncc.length - 1) {
    const y0 = Math.abs(ncc[i - 1]), y1 = Math.abs(ncc[i]), y2 = Math.abs(ncc[i + 1]);
    const den = y0 - 2 * y1 + y2;
    if (den < 0) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
  }
  const offset = (best + delta) / rate;
  return { offset: Math.round(offset * 10000) / 10000, confidence: Math.round(Math.min(1, bestAbs) * 1000) / 1000,
    margin: Math.round(Math.max(0, (bestAbs - second) / bestAbs) * 1000) / 1000 };
}

/** f32le bytes → samples (a trailing partial sample is dropped). */
export function f32(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}
