/**
 * Synthetic sound for the audio-tools tests (docs/EDITOR.md §15.4): harmonic tone "words", breath-shaped noise bursts
 * (band-passed 1–6 kHz, a rise and a longer fall), room noise, and things that must not count as breaths (a click, a
 * loud burst, a long fan noise, a hum, a fricative stuck to a word). Seeded, so every run is the same.
 */
import { dbAmp, rng } from "../audiotools/dsp.ts";

export const RATE = 16000;

/** Gaussian-ish noise (sum of four uniforms), seeded. */
export function gauss(seed: number): () => number {
  const r = rng(seed);
  return () => (r() + r() + r() + r() - 2) * 1.732;
}

/** RBJ band-pass (constant 0 dB peak) biquad as a function of one sample. */
export function bandpass(fc: number, q: number, fs = RATE): (x: number) => number {
  const w = (2 * Math.PI * fc) / fs, al = Math.sin(w) / (2 * q), a0 = 1 + al;
  const b0 = al / a0, b2 = -al / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => { const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}

export function rmsDb(x: Float32Array): number {
  let e = 0;
  for (const v of x) e += v * v;
  return 10 * Math.log10(e / Math.max(1, x.length) + 1e-30);
}
export function scaleTo(x: Float32Array, db: number): Float32Array {
  const k = dbAmp(db) / dbAmp(rmsDb(x));
  for (let i = 0; i < x.length; i++) x[i] *= k;
  return x;
}

/** A voiced "word": harmonics of a gliding f0 with a formant tilt, syllable modulation and soft edges. */
export function word(len: number, f0: number, db: number, seed: number, rate = RATE): Float32Array {
  const n = Math.round(len * rate), x = new Float32Array(n), r = rng(seed);
  const glide = (r() - 0.5) * 0.3, ph = Array.from({ length: 40 }, () => r() * 6.28);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate, f = f0 * (1 + glide * (t / len));
    phase += (2 * Math.PI * f) / rate;
    let v = 0;
    for (let k = 1; k * f < Math.min(rate / 2 - 200, 5000) && k < 40; k++) {
      const fk = k * f;
      const formant = 1 + 2.5 * Math.exp(-(((fk - 600) / 300) ** 2)) + 1.5 * Math.exp(-(((fk - 1700) / 500) ** 2));
      v += (Math.sin(k * phase + ph[k]) * formant) / k;
    }
    const env = Math.min(1, t / 0.015, (len - t) / 0.03) * (1 - 0.35 * (0.5 + 0.5 * Math.cos(2 * Math.PI * 4 * t)));
    x[i] = v * Math.max(0, env);
  }
  return scaleTo(x, db);
}

/** A breath: noise band-passed around 1–6 kHz, rising for 40 % of its length and falling for the rest. */
export function breath(len: number, db: number, seed: number, rate = RATE): Float32Array {
  const n = Math.round(len * rate), x = new Float32Array(n), g = gauss(seed);
  const a = bandpass(2400, 0.45, rate), b = bandpass(4200, 0.7, rate), c = bandpass(900, 1.2, rate);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const env = u < 0.4 ? Math.sin((u / 0.4) * (Math.PI / 2)) ** 2 : Math.cos(((u - 0.4) / 0.6) * (Math.PI / 2)) ** 2;
    const w = g();
    x[i] = (a(w) + 0.6 * b(w) + 0.15 * c(w)) * env;
  }
  return scaleTo(x, db);
}

export function noiseBed(len: number, db: number, seed: number, rate = RATE): Float32Array {
  const n = Math.round(len * rate), x = new Float32Array(n), g = gauss(seed);
  let y = 0;
  for (let i = 0; i < n; i++) { y += 0.35 * (g() - y); x[i] = y; }
  return scaleTo(x, db);
}

export function addAt(buf: Float32Array, x: Float32Array, at: number, rate = RATE) {
  const o = Math.round(at * rate);
  for (let i = 0; i < x.length && o + i < buf.length; i++) if (o + i >= 0) buf[o + i] += x[i];
}

export interface Planted { start: number; end: number; db?: number }
export interface Speech { samples: Float32Array; rate: number; words: Planted[]; breaths: Planted[]; distractors: (Planted & { kind: string })[]; duration: number }

/**
 * A minute of "speech": words with gaps, a breath in most gaps that have room for one, room noise under it all, and
 * the distractors spread in the remaining gaps.
 */
export function syntheticSpeech(seed = 7, opts: { noiseDb?: number; rate?: number } = {}): Speech {
  const rate = opts.rate ?? RATE;
  const r = rng(seed);
  const duration = 60;
  const s = new Float32Array(Math.round(duration * rate));
  const words: Planted[] = [], breaths: Planted[] = [], distractors: (Planted & { kind: string })[] = [];
  const kinds = ["click", "loud", "fan", "hum", "fricative"];
  let t = 0.4, gapNo = 0;
  while (t < duration - 2) {
    // a phrase of 2–4 words with short gaps
    const nw = 2 + Math.floor(r() * 3);
    for (let i = 0; i < nw && t < duration - 1.5; i++) {
      const len = 0.25 + r() * 0.45;
      addAt(s, word(len, 110 + r() * 110, -18 - r() * 4, Math.floor(r() * 1e6), rate), t, rate);
      words.push({ start: t, end: t + len });
      t += len + 0.04 + r() * 0.12;
    }
    // a pause between phrases: a breath, a distractor, or nothing
    const kind = gapNo % 3 === 2 ? kinds[Math.floor(gapNo / 3) % kinds.length] : "breath";
    const gap = kind === "fan" ? 1.8 + r() * 0.4 : 0.55 + r() * 1.1;
    if (kind === "breath") {
      const len = Math.min(0.2 + r() * 0.32, gap - 0.2);
      const at = t + 0.07 + r() * Math.max(0, gap - len - 0.16);
      const db = -40 + r() * 12;
      addAt(s, breath(len, db, Math.floor(r() * 1e6), rate), at, rate);
      breaths.push({ start: at, end: at + len, db });
    } else {
      const at = t + 0.1;
      let x: Float32Array;
      if (kind === "click") x = scaleTo(breath(0.006, -10, gapNo, rate), -10);
      else if (kind === "loud") x = breath(0.3, -14, gapNo + 1, rate);
      else if (kind === "fan") x = breath(1.4, -35, gapNo + 2, rate).map((v, i, a) => v * Math.min(1, i / (0.05 * rate), (a.length - i) / (0.05 * rate)));
      else if (kind === "hum") x = word(0.35, 100, -34, gapNo + 3, rate);
      else { // a fricative stuck to the end of the last word
        const b = bandpass(5500, 1.5, rate), g = gauss(gapNo + 4);
        x = scaleTo(Float32Array.from({ length: Math.round(0.1 * rate) }, () => b(g())), -24);
        addAt(s, x, t - 0.04, rate);
        distractors.push({ start: t - 0.04, end: t - 0.04 + 0.1, kind });
        x = new Float32Array(0);
      }
      if (x.length) { addAt(s, x, at, rate); distractors.push({ start: at, end: at + x.length / rate, kind }); }
    }
    gapNo++;
    t += gap;
  }
  addAt(s, noiseBed(duration, opts.noiseDb ?? -62, seed + 99, rate), 0, rate);
  return { samples: s, rate, words, breaths, distractors, duration };
}
