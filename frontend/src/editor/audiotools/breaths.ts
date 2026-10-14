/**
 * The breath remover (docs/EDITOR.md §15.4). Detection works on the per-10 ms features (features.ts):
 *  - speech: voiced frames (harmonicity ≥ 0.45) above the noise floor, and anything louder than a breath can be;
 *  - a breath: 150–600 ms that isn't speech, at −45 to −25 dBFS, broadband with its energy mainly at 1–6 kHz (hf),
 *    noise-like there (high spectral flatness: voice has harmonics, so low flatness rules it out), not voiced, clearly
 *    above the room noise, and between words (speech before and / or after it).
 * Each range gets a confidence (0..1) from how well it fits each rule. Applying it (edits.ts breathGain) writes gain
 * keyframes that lower every breath by the chosen amount (or mute it): the sound is never cut. Pure: no DOM.
 */
import { clamp, percentile, powDb } from "./dsp.ts";
import type { Features } from "./features.ts";

export interface BreathRange {
  /** Seconds from the start of what was analysed. */
  start: number; end: number;
  confidence: number;
  /** The breath's level (power mean of its hops) and its loudest hop, dBFS. */
  rmsDb: number; peakDb: number;
}
export interface BreathOptions {
  minS?: number; maxS?: number;
  /** The level window (dBFS RMS). */
  minDb?: number; maxDb?: number;
  /** The confidence a range needs (0..1, default 0.5). */
  threshold?: number;
  /** Quiet stretches from FFmpeg's silencedetect (seconds): nothing inside one is speech. */
  quiet?: { start: number; end: number }[];
}
export interface BreathResult { breaths: BreathRange[]; speech: { start: number; end: number }[]; noiseFloorDb: number; candidates: number }

export const BREATH_DEFAULTS = { minS: 0.15, maxS: 0.6, minDb: -45, maxDb: -25, threshold: 0.5 };
const VOICED = 0.45;

/** 1 inside [a, b], falling linearly to 0 at a − da and b + db. */
const plateau = (x: number, a: number, b: number, da: number, db: number) =>
  x < a ? clamp(1 - (a - x) / da, 0, 1) : x > b ? clamp(1 - (x - b) / db, 0, 1) : 1;

/** Runs [a, b) of hops where `on` holds, joined across gaps of at most `gap` hops. */
export function runs(on: ArrayLike<boolean | number>, gap = 0): [number, number][] {
  const out: [number, number][] = [];
  let a = -1;
  for (let i = 0; i <= on.length; i++) {
    const v = i < on.length && !!on[i];
    if (v && a < 0) a = i;
    if (!v && a >= 0) {
      const last = out[out.length - 1];
      if (last && a - last[1] <= gap) last[1] = i; else out.push([a, i]);
      a = -1;
    }
  }
  return out;
}

/** Speech hops: voiced and above the floor, or louder than any breath; joined over 60 ms, at least 40 ms long. */
export function speechHops(f: Features, floorDb: number, o: Required<Omit<BreathOptions, "quiet">>, quiet: { start: number; end: number }[] = []): Uint8Array {
  const n = f.n, hop = f.hopS;
  const raw = new Uint8Array(n);
  const inQuiet = new Uint8Array(n);
  for (const q of quiet) for (let i = Math.max(0, Math.ceil(q.start / hop)); i < Math.min(n, Math.floor(q.end / hop)); i++) inQuiet[i] = 1;
  for (let i = 0; i < n; i++) {
    const loud = f.rms[i] > o.maxDb + 4;
    const voiced = (f.voiced[i] ?? 0) >= VOICED && f.rms[i] > Math.max(o.minDb - 5, floorDb + 10);
    raw[i] = !inQuiet[i] && (loud || voiced) ? 1 : 0;
  }
  const out = new Uint8Array(n);
  for (const [a, b] of runs(raw, Math.round(0.06 / hop))) if (b - a >= Math.round(0.04 / hop)) out.fill(1, a, b);
  return out;
}

/** The breaths in a signal's features (seconds from its start), best first within their time order. */
export function detectBreaths(f: Features, opts: BreathOptions = {}): BreathResult {
  const o = { ...BREATH_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) } as Required<Omit<BreathOptions, "quiet">> & { quiet?: BreathOptions["quiet"] };
  const n = f.n, hop = f.hopS;
  if (!n || f.hf.length !== n) return { breaths: [], speech: [], noiseFloorDb: Number.NaN, candidates: 0 };
  const floor = percentile(f.rms, 0.1, (x) => x > -150);
  const floorDb = Number.isFinite(floor) ? floor : -120;
  const sp = speechHops(f, floorDb, o, o.quiet);
  // the speech around a hop, dilated 30 ms: a breath doesn't touch a word's edge
  const guard = Math.round(0.03 / hop);
  const near = new Uint8Array(n);
  for (const [a, b] of runs(sp)) near.fill(1, Math.max(0, a - guard), Math.min(n, b + guard));
  const cand = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = f.rms[i];
    cand[i] = !near[i] && r >= o.minDb - 8 && r <= o.maxDb + 3 && r >= floorDb + 6 && f.hf[i] >= 0.3 && f.flat[i] >= 0.1 && f.voiced[i] < VOICED ? 1 : 0;
  }
  const speech = runs(sp).map(([a, b]) => ({ start: a * hop, end: b * hop }));
  const sStarts = speech.map((s) => s.start), sEnds = speech.map((s) => s.end);
  const breaths: BreathRange[] = [];
  const cands = runs(cand, Math.round(0.03 / hop));
  for (const [a0, b0] of cands) {
    // trim the tails that sit near the floor (the envelope's skirts)
    let pk = -Infinity;
    for (let i = a0; i < b0; i++) pk = Math.max(pk, f.rms[i]);
    let a = a0, b = b0;
    while (a < b && f.rms[a] < pk - 24) a++;
    while (b > a && f.rms[b - 1] < pk - 24) b--;
    const dur = (b - a) * hop;
    if (dur < o.minS * 0.8 || dur > o.maxS * 1.6) continue;
    let pw = 0, hf = 0, fl = 0, vo = 0, peak = -Infinity;
    for (let i = a; i < b; i++) {
      pw += Math.pow(10, f.rms[i] / 10); hf += f.hf[i]; fl += f.flat[i]; vo += f.voiced[i]; peak = Math.max(peak, f.peak[i]);
    }
    const k = b - a;
    const level = powDb(pw / k);
    hf /= k; fl /= k; vo /= k;
    const t0 = a * hop, t1 = b * hop;
    // between words: speech ending shortly before and / or starting shortly after
    const before = sEnds.filter((e) => e <= t0 + 1e-6 && t0 - e < 2.5).length > 0;
    const after = sStarts.filter((s) => s >= t1 - 1e-6 && s - t1 < 2.5).length > 0;
    const scores = [
      plateau(dur, o.minS, o.maxS, o.minS * 0.25, o.maxS * 0.6),
      plateau(level, o.minDb, o.maxDb, 6, 4),
      clamp((hf - 0.3) / 0.3, 0, 1),
      clamp((fl - 0.1) / 0.2, 0, 1),
      clamp(1 - (vo - 0.2) / (VOICED - 0.2), 0, 1),
      clamp((level - floorDb - 6) / 8, 0, 1),
      before && after ? 1 : before || after ? 0.85 : 0.35,
    ];
    if (scores.some((s) => s <= 0)) continue;
    // the geometric mean, pulled down by the weakest rule (one bad fit is enough to doubt it)
    const gm = Math.exp(scores.reduce((s, x) => s + Math.log(x), 0) / scores.length);
    const conf = Math.pow(gm, 0.6) * Math.pow(Math.min(...scores), 0.4);
    if (conf < o.threshold) continue;
    breaths.push({ start: r3(t0), end: r3(t1), confidence: Math.round(conf * 100) / 100, rmsDb: Math.round(level * 10) / 10, peakDb: Math.round(peak * 10) / 10 });
  }
  return { breaths, speech: speech.map((s) => ({ start: r3(s.start), end: r3(s.end) })), noiseFloorDb: Math.round(floorDb * 10) / 10, candidates: cands.length };
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** How a list of found ranges matches the planted ones: a found range hits a planted one when they overlap by half the shorter. */
export function matchRanges(found: { start: number; end: number }[], truth: { start: number; end: number }[]): { tp: number; fp: number; fn: number; precision: number; recall: number } {
  const used = new Set<number>();
  let tp = 0;
  for (const g of found) {
    const j = truth.findIndex((t, i) => !used.has(i) && Math.min(g.end, t.end) - Math.max(g.start, t.start) >= 0.5 * Math.min(g.end - g.start, t.end - t.start));
    if (j >= 0) { used.add(j); tp++; }
  }
  const fp = found.length - tp, fn = truth.length - tp;
  return { tp, fp, fn, precision: found.length ? tp / found.length : 1, recall: truth.length ? tp / truth.length : 1 };
}
