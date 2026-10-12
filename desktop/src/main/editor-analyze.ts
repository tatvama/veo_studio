/**
 * Free analysis on this PC for the editor's AI tools (docs/EDITOR.md §8): silences (FFmpeg silencedetect), scene cuts
 * (the scene score with showinfo), beats (spectral-flux onsets on 22 050 Hz mono PCM, a tempo from the onsets'
 * autocorrelation and dynamic-programming beat tracking) and loudness (ebur128). Argument builders, parsers and the
 * beat detector are pure (test/editor-analyze.test.ts).
 */

export const BEAT_RATE = 22050;
const FRAME = 1024;
const HOP = 256;

const r3 = (x: number) => Math.round(x * 1000) / 1000;

// ── silence ──
export function silenceArgs(src: string, noiseDb = -35, minMs = 400): string[] {
  return ["-i", src, "-vn", "-af", `silencedetect=noise=${noiseDb}dB:d=${(minMs / 1000).toFixed(3)}`, "-f", "null", "-"];
}
export function parseSilence(lines: string[], duration: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const l of lines) {
    const s = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(l);
    if (s) { open = Math.max(0, Number(s[1])); continue; }
    const e = /silence_end:\s*(\d+(?:\.\d+)?)/.exec(l);
    if (e && open !== null) {
      out.push({ start: r3(open), end: r3(Number(e[1])) });
      open = null;
    }
  }
  if (open !== null && duration > open) out.push({ start: r3(open), end: r3(duration) });
  return out;
}

// ── scenes ──
export function scenesArgs(src: string, threshold = 0.3): string[] {
  const t = Math.min(0.95, Math.max(0.05, threshold));
  return ["-i", src, "-an", "-sn", "-vf", `scale=320:-2,select='gt(scene,${t.toFixed(3)})',showinfo`, "-f", "null", "-"];
}
export function parseScenes(lines: string[]): number[] {
  const out: number[] = [];
  for (const l of lines) {
    if (!/Parsed_showinfo/.test(l)) continue;
    const m = /pts_time:\s*(-?\d+(?:\.\d+)?)/.exec(l);
    if (m) {
      const t = r3(Number(m[1]));
      if (t > 0 && (!out.length || t - out[out.length - 1] > 0.04)) out.push(t);
    }
  }
  return out;
}

// ── loudness ──
export function loudnessArgs(src: string): string[] {
  return ["-nostats", "-i", src, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"];
}
/** The ebur128 summary: integrated loudness (LUFS), loudness range (LU) and true peak (dBTP). */
export function parseEbur128(lines: string[]): { lufs: number | null; lra: number | null; truePeak: number | null } {
  let i = lines.length - 1;
  while (i >= 0 && !/Summary:/.test(lines[i])) i--;
  const body = i >= 0 ? lines.slice(i) : lines;
  const val = (re: RegExp) => {
    for (const l of body) {
      const m = re.exec(l);
      if (m) return m[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(m[1]);
    }
    return null;
  };
  const fin = (v: number | null) => (v === null || !Number.isFinite(v) ? null : r3(v));
  return { lufs: fin(val(/^\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/)), lra: fin(val(/^\s*LRA:\s*(-?[\d.]+)\s*LU\b/)), truePeak: fin(val(/^\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/)) };
}

// ── beats ──
export function beatsArgs(src: string): string[] {
  return ["-i", src, "-vn", "-ac", "1", "-ar", String(BEAT_RATE), "-f", "f32le", "-"];
}

/** In-place radix-2 FFT (re, im of length 2^k). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
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

/** Onset strength per hop: half-wave rectified spectral flux of the log-compressed magnitude spectrum. */
export function onsetEnvelope(samples: Float32Array, rate = BEAT_RATE): { env: Float64Array; hopS: number } {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const env = new Float64Array(frames);
  const win = new Float64Array(FRAME).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  const half = FRAME / 2;
  let prev = new Float64Array(half);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    for (let i = 0; i < FRAME; i++) { re[i] = samples[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float64Array(half);
    let flux = 0;
    for (let k = 1; k < half; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = mag[k] - prev[k];
      if (d > 0) flux += d;
    }
    env[f] = f === 0 ? 0 : flux;
    prev = mag;
  }
  return { env, hopS: HOP / rate };
}

/**
 * Beats from mono PCM: tempo = the strongest autocorrelation lag of the onset envelope in 60–200 BPM (weighted
 * towards 120), then Ellis-style dynamic programming picks beats that sit on onsets at about that spacing.
 */
export function detectBeats(samples: Float32Array, rate = BEAT_RATE): { beats: number[]; bpm: number } {
  const { env: raw, hopS } = onsetEnvelope(samples, rate);
  const n = raw.length;
  if (n < 16) return { beats: [], bpm: 0 };
  // normalise: subtract a local mean (≈0.5 s), half-wave rectify, unit standard deviation
  const w = Math.max(2, Math.round(0.25 / hopS));
  const env = new Float64Array(n);
  let acc = 0;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { acc += raw[i]; pre[i + 1] = acc; }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(n, i + w + 1);
    env[i] = Math.max(0, raw[i] - (pre[b] - pre[a]) / (b - a));
  }
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  let sd = 0;
  for (const v of env) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / n) || 1;
  for (let i = 0; i < n; i++) env[i] /= sd;
  // tempo
  const minLag = Math.max(1, Math.floor(60 / 200 / hopS));
  const maxLag = Math.min(n - 1, Math.ceil(60 / 60 / hopS));
  let best = 0;
  let bestLag = 0;
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1 && lag < n; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    ac[lag] = s / (n - lag);
  }
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hopS);
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
    const score = ac[lag] * weight;
    if (score > best) { best = score; bestLag = lag; }
  }
  if (!bestLag) return { beats: [], bpm: 0 };
  // parabolic refinement of the lag
  const y0 = ac[bestLag - 1] ?? 0;
  const y1 = ac[bestLag];
  const y2 = ac[bestLag + 1] ?? 0;
  const den = y0 - 2 * y1 + y2;
  const lag = den !== 0 ? bestLag + Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : bestLag;
  const period = lag;
  const bpm = 60 / (period * hopS);
  // dynamic programming beat tracking
  const alpha = 100;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let bestPrev = -1;
    let bestVal = Number.NEGATIVE_INFINITY;
    const lo = Math.max(0, Math.floor(i - 2 * period));
    const hi = Math.min(i - 1, Math.ceil(i - period / 2));
    for (let j = lo; j <= hi; j++) {
      const v = score[j] - alpha * Math.log((i - j) / period) ** 2;
      if (v > bestVal) { bestVal = v; bestPrev = j; }
    }
    score[i] = env[i] + (bestPrev >= 0 ? Math.max(0, bestVal) : 0);
    back[i] = bestVal > 0 ? bestPrev : -1;
  }
  // start from the best score in the last period
  let end = n - 1;
  let top = Number.NEGATIVE_INFINITY;
  for (let i = Math.max(0, Math.floor(n - period)); i < n; i++) if (score[i] > top) { top = score[i]; end = i; }
  const idx: number[] = [];
  for (let i = end; i >= 0; i = back[i]) {
    idx.push(i);
    if (back[i] < 0) break;
  }
  idx.reverse();
  // flux frame f compares windows f-1 and f: the attack sits about a hop past window f's centre (measured on clicks)
  const beats = idx.map((f) => r3((f * HOP + FRAME / 2 + HOP) / rate));
  return { beats: beats.filter((t) => t >= 0), bpm: Math.round(bpm * 10) / 10 };
}
