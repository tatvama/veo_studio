/**
 * Levels for the SFX engine (docs/EDITOR.md §15.1): integrated loudness (ITU-R BS.1770-4 with the gating of
 * audiofx/loudness.ts: its K-weighting, 100 ms sub-blocks and 400 ms blocks, so the numbers are the meter's), the true
 * peak with the standard's 4× interpolator, an offline true-peak limiter (look-ahead by construction: the gain is a
 * smoothed sliding minimum of what each peak needs, so it never lets one through) and `normalise`, which brings a
 * sound to −16 LUFS with its true peak at or below −1 dBTP. Very short sounds that can't reach the target under the
 * ceiling are soft-clipped into it. Pure: no DOM.
 */
import { gatedLoudness, kWeighting, TRUE_PEAK_TAPS } from "../audiofx/loudness.ts";
import { clamp, db, type Sig, type Stereo } from "./dsp.ts";

export const TARGET_LUFS = -16;
export const CEILING_DBTP = -1;
/** The limiter aims a little under the ceiling (the final check trims to `FINAL_DBTP`). */
const LIMIT_DBTP = -1.3;
const FINAL_DBTP = -1.05;

type Chan = ArrayLike<number>;

/**
 * Integrated loudness (LUFS) of whole channels: K-weighted, mean square summed over the channels, 400 ms blocks
 * every 100 ms, gated at −70 LUFS and −10 LU (audiofx/loudness.ts LoudnessMeter's blocks). A sound shorter than one
 * block is measured as if followed by silence up to 400 ms. −Infinity for silence.
 */
export function integratedLufs(ch: Chan[], sr: number): number {
  const n = ch[0]?.length ?? 0;
  if (!n) return -Infinity;
  const [s, h] = kWeighting(sr);
  const subLen = Math.round(sr / 10), nSub = Math.max(4, Math.floor(n / subLen));
  const subs = new Float64Array(nSub);
  for (const x of ch) {
    let sx1 = 0, sx2 = 0, sy1 = 0, sy2 = 0, hx1 = 0, hx2 = 0, hy1 = 0, hy2 = 0;
    const end = Math.min(n, nSub * subLen);
    for (let i = 0; i < end; i++) {
      const v = x[i];
      const y = s.b[0] * v + s.b[1] * sx1 + s.b[2] * sx2 - s.a[1] * sy1 - s.a[2] * sy2;
      sx2 = sx1; sx1 = v; sy2 = sy1; sy1 = y;
      const z = h.b[0] * y + h.b[1] * hx1 + h.b[2] * hx2 - h.a[1] * hy1 - h.a[2] * hy2;
      hx2 = hx1; hx1 = y; hy2 = hy1; hy1 = z;
      subs[(i / subLen) | 0] += z * z;
    }
  }
  for (let j = 0; j < nSub; j++) subs[j] /= subLen;
  const blocks = new Float64Array(nSub - 3);
  for (let j = 3; j < nSub; j++) blocks[j - 3] = (subs[j] + subs[j - 1] + subs[j - 2] + subs[j - 3]) / 4;
  return gatedLoudness(blocks);
}

const TAPS = TRUE_PEAK_TAPS.map((t) => Float64Array.from(t));
/** The largest gain the interpolator can give a window of samples (Σ|taps| of its worst phase). */
const TP_GAIN = Math.max(...TRUE_PEAK_TAPS.map((t) => t.reduce((s, v) => s + Math.abs(v), 0)));
const BLK = 16;

/** Block maxima of |x| (16 samples a block), so quiet stretches skip the interpolator. */
function blockMax(x: Chan): Float64Array {
  const nb = Math.ceil(x.length / BLK), out = new Float64Array(nb);
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); const b = (i / BLK) | 0; if (a > out[b]) out[b] = a; }
  return out;
}

/** The interpolated peak at sample i of one channel: max(|x[i]|, |the 4 phases from x[i−11..i]|) (TruePeak.step). */
function tpAt(x: Chan, i: number): number {
  let m = Math.abs(x[i]);
  for (let p = 0; p < 4; p++) {
    const t = TAPS[p];
    let y = 0;
    for (let k = 0; k < 12 && k <= i; k++) y += t[k] * x[i - k];
    const a = Math.abs(y);
    if (a > m) m = a;
  }
  return m;
}

/** True peak (linear) of whole channels: the same numbers as audiofx/loudness.ts measureLoudness, faster. */
export function truePeakLin(ch: Chan[]): number {
  let m = 0;
  for (const x of ch) {
    const bm = blockMax(x);
    for (const v of bm) if (v > m) m = v;
  }
  for (const x of ch) {
    const bm = blockMax(x);
    for (let i = 0; i < x.length; i++) {
      const b = (i / BLK) | 0, lo = Math.max(0, ((i - 11) / BLK) | 0);
      if (Math.max(bm[b], bm[lo]) * TP_GAIN <= m) continue;
      const v = tpAt(x, i);
      if (v > m) m = v;
    }
  }
  return m;
}
export const truePeakDb = (ch: Chan[]) => 20 * Math.log10(Math.max(1e-12, truePeakLin(ch)));

/** The gain each sample needs so the interpolated peaks stay under `ceil` (1 where nothing is over). */
function neededGain(st: Stereo, ceil: number): Float64Array | null {
  const n = st[0].length, req = new Float64Array(n).fill(1);
  let any = false;
  for (const x of st) {
    const bm = blockMax(x);
    for (let i = 0; i < n; i++) {
      const b = (i / BLK) | 0, lo = Math.max(0, ((i - 11) / BLK) | 0);
      if (Math.max(bm[b], bm[lo]) * TP_GAIN <= ceil) continue;
      const v = tpAt(x, i);
      if (v > ceil) {
        // the interpolated point sits about 6 samples back; the sliding minimum below widens it to every neighbour
        const j = Math.max(0, i - 6), g = ceil / v;
        if (g < req[j]) req[j] = g;
        if (g < req[i]) req[i] = g;
        any = true;
      }
    }
  }
  return any ? req : null;
}

/** min over [i − h, i + h] (a monotonic deque), circular when `loop` (else the outside counts as 1). */
function slidingMin(x: Float64Array, h: number, loop: boolean): Float64Array {
  const n = x.length, val = (j: number) => (loop ? x[((j % n) + n) % n] : j < 0 || j >= n ? 1 : x[j]);
  const out = new Float64Array(n), di = new Int32Array(n + 2 * h + 1), dv = new Float64Array(n + 2 * h + 1);
  let head = 0, tail = 0;
  for (let j = -h; j < n + h; j++) {
    const v = val(j);
    while (tail > head && dv[tail - 1] >= v) tail--;
    di[tail] = j; dv[tail] = v; tail++;
    const c = j - h; // the window [c − h, c + h] is complete
    if (c >= 0) {
      while (di[head] < c - h) head++;
      out[c] = dv[head];
    }
  }
  return out;
}

/** The ±h moving average (circular when `loop`; the edges see 1). */
function boxAverage(x: Float64Array, h: number, loop: boolean): Float64Array {
  const n = x.length, w = 2 * h + 1, out = new Float64Array(n), val = (j: number) => (loop ? x[((j % n) + n) % n] : j < 0 || j >= n ? 1 : x[j]);
  let s = 0;
  for (let j = -h; j <= h; j++) s += val(j);
  for (let i = 0; i < n; i++) { out[i] = s / w; s += val(i + h + 1) - val(i - h); }
  return out;
}

/** An offline true-peak limiter to `ceilDb`: needed gains → sliding minimum (3 ms) → moving average (2.5 ms, which
 *  can't rise above the minimum's neighbourhood) → a 80 ms release. Returns whether it did anything. */
export function limit(st: Stereo, sr: number, ceilDb = LIMIT_DBTP, loop = false): boolean {
  const req = neededGain(st, db(ceilDb));
  if (!req) return false;
  const H = Math.max(8, Math.round(0.003 * sr)), h = Math.max(4, Math.round(0.0025 * sr));
  const g = boxAverage(slidingMin(req, H, loop), h, loop);
  const n = g.length, rel = 1 - Math.exp(-1 / (0.08 * sr));
  let r = loop ? g[n - 1] : 1;
  for (let pass = 0; pass < (loop ? 2 : 1); pass++) {
    for (let i = 0; i < n; i++) { r = Math.min(g[i], r + (1 - r) * rel); if (pass === (loop ? 1 : 0)) g[i] = r; }
  }
  for (const x of st) for (let i = 0; i < n; i++) x[i] *= g[i];
  return true;
}

const scaleSt = (st: Stereo, k: number) => { for (const x of st) for (let i = 0; i < x.length; i++) x[i] *= k; };

/** c · tanh(d · x / c): the gain `d` pushes the sound into a soft ceiling `c`. */
function softclipped(st: Stereo, d: number, c: number): Stereo {
  return st.map((x) => { const o = new Float64Array(x.length); for (let i = 0; i < x.length; i++) o[i] = c * Math.tanh((d * x[i]) / c); return o; }) as Stereo;
}

export interface NormaliseInfo { lufs: number; truePeak: number; limited: boolean; clipDrive: number }

/**
 * Brings a sound to −16 LUFS integrated with its true peak at or below −1 dBTP (in place, and returned): a gain, then
 * the true-peak limiter with make-up gain until the loudness holds; a sound the limiter can't lift (very short and
 * peaky) is soft-clipped into the ceiling with the gain that reaches the target. `loop` limits circularly, so a loop
 * stays seamless.
 */
export function normalise(st: Stereo, sr: number, loop = false, target = TARGET_LUFS): NormaliseInfo {
  const info: NormaliseInfo = { lufs: -Infinity, truePeak: -Infinity, limited: false, clipDrive: 0 };
  let L = integratedLufs(st, sr);
  if (!Number.isFinite(L) || L < -120) return info;
  scaleSt(st, db(target - L));
  let prev = -Infinity;
  for (let k = 0; k < 8; k++) {
    if (!limit(st, sr, LIMIT_DBTP, loop)) break;
    info.limited = true;
    L = integratedLufs(st, sr);
    // reached, out of tries, or the limiter takes back everything the make-up gives (a sound shorter than its window)
    if (L >= target - 0.04 || k === 7 || L - prev < 0.03) break;
    prev = L;
    scaleSt(st, db(target - L));
  }
  L = integratedLufs(st, sr);
  if (L < target - 0.04 && info.limited) {
    // the limiter can't lift it (a click shorter than its window): soft-clip into the ceiling, finding the drive by bisection
    const c = db(LIMIT_DBTP);
    const fit = (aim: number) => {
      let lo = 1, hi = 256;
      for (let it = 0; it < 14; it++) { const mid = Math.sqrt(lo * hi); if (integratedLufs(softclipped(st, mid, c), sr) < aim) lo = mid; else hi = mid; }
      return hi;
    };
    let aim = target + 0.05;
    for (let k = 0; k < 3; k++) {
      const d = fit(aim), y = softclipped(st, d, c);
      limit(y, sr, LIMIT_DBTP, loop);
      const Ly = integratedLufs(y, sr);
      info.clipDrive = d;
      if (Ly >= target - 0.1 || k === 2) { st[0].set(y[0]); st[1].set(y[1]); break; }
      aim += target - Ly;
    }
  }
  L = integratedLufs(st, sr);
  if (L > target) { scaleSt(st, db(target - L)); L = target; }
  let tp = truePeakLin(st);
  const fin = db(FINAL_DBTP);
  if (tp > fin) { scaleSt(st, fin / tp); tp = fin; L = integratedLufs(st, sr); }
  info.lufs = L; info.truePeak = 20 * Math.log10(Math.max(1e-12, tp));
  return info;
}

/** Makes a seamless loop of `n` samples from a render `n + x` long: the overhang cross-fades into the start (equal
 *  power, for continuous textures). */
export function loopCrossfade(st: Stereo, n: number): Stereo {
  const x = st[0].length - n, out: Stereo = [st[0].slice(0, n), st[1].slice(0, n)];
  for (let c = 0; c < 2; c++) for (let i = 0; i < x && i < n; i++) {
    const u = (i + 0.5) / x;
    out[c][i] = st[c][i] * Math.sin((Math.PI / 2) * u) + st[c][n + i] * Math.cos((Math.PI / 2) * u);
  }
  return out;
}

/** Makes a loop of `n` samples from a render `n + x` long by adding the overhang (decaying tails of events) back onto
 *  the start: for loops of events on a grid (ticks, heartbeats). */
export function loopWrap(st: Stereo, n: number): Stereo {
  const out: Stereo = [st[0].slice(0, n), st[1].slice(0, n)];
  for (let c = 0; c < 2; c++) for (let i = n; i < st[c].length; i++) out[c][(i - n) % n] += st[c][i];
  return out;
}

/** Peaks for a waveform picture: `buckets` values 0..1 (the max |x| over the channels per bucket, scaled to the
 *  loudest). */
export function peaksOf(ch: ArrayLike<number>[], buckets = 64): number[] {
  const n = ch[0]?.length ?? 0, out = new Array<number>(buckets).fill(0);
  if (!n) return out;
  for (const x of ch) for (let i = 0; i < n; i++) { const b = Math.min(buckets - 1, Math.floor((i * buckets) / n)); const a = Math.abs(x[i]); if (a > out[b]) out[b] = a; }
  const m = Math.max(...out);
  return out.map((v) => (m > 0 ? Math.round(clamp(v / m, 0, 1) * 1000) / 1000 : 0));
}

export type { Sig };
