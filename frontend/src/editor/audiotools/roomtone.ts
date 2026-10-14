/**
 * Room-tone finding (docs/EDITOR.md §15.4): the quietest 1–3 s stretch of a dialogue recording that still has sound
 * (every 10 ms above −70 dBFS, so not digital silence) and no speech (inside a quiet stretch of the silence
 * analysis: FFmpeg's silencedetect on the desktop, `silenceSegments` here otherwise). Steady stretches win over ones
 * with a bump (a breath, a click). Filling the gaps with it is edits.ts `roomToneFill`. Pure.
 */
import { percentile, powDb } from "./dsp.ts";

export interface RoomTone {
  /** Seconds from the start of what was analysed. */
  start: number; end: number;
  /** Its level (power mean, dBFS) and how much its loudest 10 ms stands above that (dB). */
  rmsDb: number; spreadDb: number;
  /** No quiet stretch of minS was there: this one is shorter (at least fallbackS), so it loops more often. */
  short?: boolean;
}
export interface RoomToneOptions {
  minS?: number; maxS?: number;
  /** Below this every 10 ms counts as digital silence (dBFS, default −70). */
  digitalDb?: number;
  /** Kept clear of the quiet stretch's edges, where words fade (s, default 0.12). */
  margin?: number;
  /** When no stretch of minS exists, the shortest one still taken (s, default 0.5; 0 = none). */
  fallbackS?: number;
}
export const ROOM_TONE_DEFAULTS = { minS: 1, maxS: 3, digitalDb: -70, margin: 0.12, fallbackS: 0.5 };

/**
 * The silencedetect threshold for a recording: a little above its noise floor (10th percentile of the 10 ms levels),
 * well under its speech (90th percentile), within −60 … −25 dBFS.
 */
export function quietThreshold(rmsDb: ArrayLike<number>): number {
  const floor = percentile(rmsDb, 0.1, (x) => x > -150);
  const loud = percentile(rmsDb, 0.9, (x) => x > -150);
  if (!Number.isFinite(floor) || !Number.isFinite(loud)) return -40;
  const t = floor + Math.max(8, 0.35 * (loud - floor));
  return Math.round(Math.min(-25, Math.max(-60, t)) * 10) / 10;
}

/** silencedetect on 10 ms levels: stretches of at least `minS` where every hop is under `thresholdDb`. */
export function silenceSegments(rmsDb: ArrayLike<number>, hopS: number, thresholdDb: number, minS = 0.5): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let a = -1;
  for (let i = 0; i <= rmsDb.length; i++) {
    const q = i < rmsDb.length && rmsDb[i] < thresholdDb;
    if (q && a < 0) a = i;
    if (!q && a >= 0) {
      if ((i - a) * hopS >= minS) out.push({ start: Math.round(a * hopS * 1000) / 1000, end: Math.round(i * hopS * 1000) / 1000 });
      a = -1;
    }
  }
  return out;
}

/** The best room-tone stretch, or null when no quiet stretch is long enough (or all of them are digital silence). A
 *  recording without a 1 s pause gets its best shorter one (fallbackS … minS), marked `short`. */
export function findRoomTone(rmsDb: ArrayLike<number>, hopS: number, silences: { start: number; end: number }[], opts: RoomToneOptions = {}): RoomTone | null {
  const o = { ...ROOM_TONE_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) } as Required<RoomToneOptions>;
  const hit = bestStretch(rmsDb, hopS, silences, o);
  if (hit || !(o.fallbackS > 0) || o.fallbackS >= o.minS) return hit;
  const short = bestStretch(rmsDb, hopS, silences, { ...o, minS: o.fallbackS, maxS: o.minS });
  return short ? { ...short, short: true } : null;
}

function bestStretch(rmsDb: ArrayLike<number>, hopS: number, silences: { start: number; end: number }[], o: Required<RoomToneOptions>): RoomTone | null {
  const n = rmsDb.length;
  const pw = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pw[i + 1] = pw[i] + Math.pow(10, rmsDb[i] / 10);
  const step = Math.max(1, Math.round(0.05 / hopS));
  let best: (RoomTone & { score: number }) | null = null;
  const lens: number[] = [];
  for (let L = o.maxS; L >= o.minS - 1e-9; L -= 0.5) lens.push(Math.round(L / hopS));
  if (!lens.includes(Math.round(o.minS / hopS))) lens.push(Math.round(o.minS / hopS));
  for (const s of silences) {
    const a = Math.max(0, Math.ceil((s.start + o.margin) / hopS)), b = Math.min(n, Math.floor((s.end - o.margin) / hopS));
    // hops of digital silence split the stretch
    let seg0 = a;
    for (let i = a; i <= b; i++) {
      if (i < b && rmsDb[i] > o.digitalDb) continue;
      const lo = seg0, hi = i;
      seg0 = i + 1;
      for (const len of lens) {
        if (hi - lo < len) continue;
        for (let w = lo; w + len <= hi; w += step) {
          const mean = powDb((pw[w + len] - pw[w]) / len);
          let mx = -Infinity;
          for (let k = w; k < w + len; k++) if (rmsDb[k] > mx) mx = rmsDb[k];
          const spread = mx - mean;
          // quieter is better, a bump costs, a longer stretch earns a little (fewer loops when filling)
          const score = mean + 0.5 * Math.max(0, spread - 6) - 0.5 * (len * hopS - o.minS);
          if (!best || score < best.score - 1e-9) best = { start: w * hopS, end: (w + len) * hopS, rmsDb: mean, spreadDb: spread, score };
        }
      }
    }
  }
  if (!best) return null;
  const r = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
  return { start: r(best.start), end: r(best.end), rmsDb: r(best.rmsDb, 1), spreadDb: r(best.spreadDb, 1) };
}
