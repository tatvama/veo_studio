/**
 * Reading the free on-PC analyses (`bridge.editor.analyze(path, mediaId, kind, opts)`, docs/EDITOR.md §8; lib/desktop.ts
 * AnalyzeResult). The answers, all times in seconds of the whole media file:
 *   silence  → { kind, segments: [{ start, end }], duration }
 *   scenes   → { kind, cuts: [seconds], duration }
 *   beats    → { kind, beats: [seconds], bpm, duration }
 *   loudness → { kind, lufs, lra, truePeak }        (integrated LUFS, true peak dBTP; null when unmeasurable)
 * The readers also take a bare array and a few other spellings, so a slightly different bridge still works. Pure.
 */

export type AnalyzeKind = "silence" | "scenes" | "beats" | "loudness";

/** `peak` is NaN when the bridge couldn't measure it. */
export interface Loudness { lufs: number; peak: number; lra?: number }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function list(v: unknown, keys: string[]): unknown[] {
  if (Array.isArray(v)) return v;
  const o = obj(v);
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
  return [];
}

export function readSilences(v: unknown): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const x of list(v, ["segments", "silences", "ranges", "silence", "items"])) {
    let a: number | null, b: number | null;
    if (Array.isArray(x)) { a = num(x[0]); b = num(x[1]); }
    else { const o = obj(x); a = num(o.start ?? o.from ?? o.silence_start); b = num(o.end ?? o.to ?? o.silence_end); }
    if (a !== null && b !== null && b > a) out.push({ start: Math.max(0, a), end: b });
  }
  return out.sort((x, y) => x.start - y.start);
}

function times(v: unknown, keys: string[]): number[] {
  const out: number[] = [];
  for (const x of list(v, keys)) {
    const t = num(x) ?? num(obj(x).time ?? obj(x).at ?? obj(x).start ?? obj(x).t);
    if (t !== null && t >= 0) out.push(t);
  }
  return [...new Set(out.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
}

export const readCuts = (v: unknown) => times(v, ["cuts", "scenes", "changes", "times"]);
export const readBeats = (v: unknown) => times(v, ["beats", "onsets", "times"]);
export const readBpm = (v: unknown): number | null => num(obj(v).bpm ?? obj(v).tempo);

export function readLoudness(v: unknown): Loudness | null {
  const o = obj(v);
  const lufs = num(o.lufs ?? o.integrated ?? o.I ?? o.i ?? o.input_i);
  const peak = num(o.peak ?? o.truePeak ?? o.true_peak ?? o.tp ?? o.input_tp);
  if (lufs === null) return null;
  const lra = num(o.lra ?? o.LRA ?? o.input_lra);
  return { lufs, peak: peak ?? Number.NaN, ...(lra !== null ? { lra } : {}) };
}
