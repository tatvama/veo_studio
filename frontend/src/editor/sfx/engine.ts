/**
 * The procedural sound-effects engine (docs/EDITOR.md §15.1): the preset catalogue and `renderSfx`, which turns a
 * preset, its values and a seed into samples. Every render is deterministic (the same inputs give the same samples in
 * node, a worker and the page), 48 kHz stereo by default, and levelled to −16 LUFS with its true peak at or below
 * −1 dBTP. Loops come out seamless. Pure: no DOM, no WebAudio.
 */
import { fnv1a } from "../audiofx/ir.ts";
import { fades, fitSt, mix32, mono, Rng, secs, type Stereo } from "./dsp.ts";
import { loopCrossfade, loopWrap, normalise, type NormaliseInfo } from "./level.ts";
import { BRAAMS, HITS, IMPACTS, REVERSES, SUB_DROPS } from "./presets/impacts.ts";
import { DOWNLIFTERS, RISERS, WHOOSH } from "./presets/motion.ts";
import { AMBIENCE, CROWD, GLITCH, HEARTBEATS, TAPE } from "./presets/textures.ts";
import { BELLS, CAMERA, CASH, POPS, TICKS, TYPING, UI } from "./presets/ui.ts";
import type { SfxCategory, SfxDef, SfxPreset, Values } from "./types.ts";

/** Part of every saved sound's hash: bump it when a change to the engine changes the samples. */
export const SFX_ENGINE_VERSION = 1;
export const DEFAULT_SEED = 1;
export const SFX_SAMPLE_RATE = 48000;
/** One-shots are at least this long (one loudness block). */
const MIN_SECONDS = 0.5;

export const SFX_CATEGORIES: { id: SfxCategory; label: string }[] = [
  { id: "whoosh", label: "Whoosh & swish" }, { id: "riser", label: "Risers" }, { id: "downlifter", label: "Downlifters" },
  { id: "impact", label: "Impacts & booms" }, { id: "sub_drop", label: "Sub drops" }, { id: "braam", label: "Braams" },
  { id: "hit", label: "Hits & stabs" }, { id: "pop", label: "Pops & bubbles" }, { id: "ui", label: "Clicks & UI" },
  { id: "typing", label: "Typing & keys" }, { id: "camera", label: "Camera" }, { id: "bell", label: "Dings & bells" },
  { id: "glitch", label: "Glitch & digital" }, { id: "tape", label: "Tape & vinyl" }, { id: "reverse", label: "Reverse" },
  { id: "tick", label: "Ticks & countdown" }, { id: "cash", label: "Cash & coins" }, { id: "heartbeat", label: "Heartbeat" },
  { id: "ambience", label: "Ambience loops" }, { id: "crowd", label: "Crowd" },
];

const DEFS: SfxDef[] = [
  ...WHOOSH, ...RISERS, ...DOWNLIFTERS, ...IMPACTS, ...SUB_DROPS, ...BRAAMS, ...HITS, ...POPS, ...UI, ...TYPING, ...CAMERA, ...BELLS,
  ...GLITCH, ...TAPE, ...REVERSES, ...TICKS, ...CASH, ...HEARTBEATS, ...AMBIENCE, ...CROWD,
];
const BY_ID = new Map(DEFS.map((d) => [d.id, d]));

const defOf = (id: string): SfxDef => {
  const d = BY_ID.get(id);
  if (!d) throw new Error(`No sound effect "${id}"`);
  return d;
};

/** A preset's values: its defaults, with `values` over them clamped to each param's range (unknown keys dropped). */
export function resolveValues(id: string, values: Record<string, number> = {}): Values {
  const out: Values = {};
  for (const p of defOf(id).params) {
    const x = Number(values[p.name]);
    out[p.name] = Number.isFinite(x) ? Math.min(p.max, Math.max(p.min, x)) : p.default;
  }
  return out;
}
export const sfxDefaults = (id: string): Values => resolveValues(id, {});

/** Seconds a render of these values lasts (a loop: its length). */
export function sfxSeconds(id: string, values: Record<string, number> = {}): number {
  const d = defOf(id), v = resolveValues(id, values), s = d.len(v);
  return d.loop ? Math.max(0.1, s) : Math.max(MIN_SECONDS, s);
}

export const SFX_PRESETS: SfxPreset[] = DEFS.map((d) => ({
  id: d.id, name: d.name, category: d.category, tags: [...d.tags],
  duration: Math.round(sfxSeconds(d.id) * 1000) / 1000,
  params: d.params.map((p) => ({ ...p })),
  stereo: d.stereo,
  ...(d.loop ? { loop: true } : {}),
}));
const PRESET_BY_ID = new Map(SFX_PRESETS.map((p) => [p.id, p]));
export const sfxPreset = (id: string): SfxPreset | undefined => PRESET_BY_ID.get(id);

/** The random stream of a preset and seed. */
const rngFor = (id: string, seed: number) => new Rng(mix32(fnv1a(id), (Number.isFinite(seed) ? Math.trunc(seed) : DEFAULT_SEED) >>> 0));

/**
 * Renders a preset: deterministic, levelled to −16 LUFS with true peak ≤ −1 dBTP. Returns the channels at
 * `sampleRate` (always two; a non-stereo preset has identical channels, so it plays centred at the same loudness as
 * it measures).
 */
export function renderSfx(id: string, values: Record<string, number> = {}, seed = DEFAULT_SEED, sampleRate = SFX_SAMPLE_RATE): Float32Array[] {
  return renderSfxInfo(id, values, seed, sampleRate).channels;
}

/** renderSfx and what levelling did (the tests and the panel's info line use it). */
export function renderSfxInfo(id: string, values: Record<string, number> = {}, seed = DEFAULT_SEED, sampleRate = SFX_SAMPLE_RATE): { channels: Float32Array[]; level: NormaliseInfo } {
  const d = defOf(id);
  const sr = Math.round(sampleRate);
  if (!(sr >= 8000 && sr <= 192000)) throw new Error("Unsupported sample rate");
  const v = resolveValues(id, values);
  const n = Math.max(1, Math.round(sfxSeconds(id, v) * sr));
  const over = d.loop === "xfade" ? Math.max(1, Math.min(secs(0.75, sr), Math.floor(n * 0.2))) : d.loop === "wrap" ? secs(d.overhang ?? 1.5, sr) : 0;
  const out = d.render(v, { sr, n: n + over, rng: rngFor(id, seed), loopN: n });
  let st: Stereo = out instanceof Float64Array ? mono(out) : out;
  st = fitSt(st, n + over);
  st = d.loop === "xfade" ? loopCrossfade(st, n) : d.loop === "wrap" ? loopWrap(st, n) : fitSt(st, n);
  // no NaN / Inf, no DC, centred when not stereo, clean edges on one-shots
  for (const x of st) for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) x[i] = 0;
  if (d.loop) for (const x of st) { let m = 0; for (let i = 0; i < x.length; i++) m += x[i]; m /= x.length || 1; for (let i = 0; i < x.length; i++) x[i] -= m; }
  else {
    const a = Math.exp(-1 / ((sr / (2 * Math.PI)) / 8)); // an 8 Hz one-pole high-pass
    for (const x of st) { let y = 0, px = 0; for (let i = 0; i < x.length; i++) { y = a * (y + x[i] - px); px = x[i]; x[i] = y; } }
  }
  if (!d.stereo) for (let i = 0; i < n; i++) { const m = (st[0][i] + st[1][i]) / 2; st[0][i] = m; st[1][i] = m; }
  if (!d.loop) fades(st, sr, 0.001, 0.012);
  const level = normalise(st, sr, !!d.loop);
  return { channels: [Float32Array.from(st[0]), Float32Array.from(st[1])], level };
}

/** A short, stable key of a sound: preset, values (resolved), seed and the engine version. */
export function sfxKey(id: string, values: Record<string, number> = {}, seed = DEFAULT_SEED): string {
  const v = resolveValues(id, values);
  const vs = Object.keys(v).sort().map((k) => `${k}=${Number(v[k].toPrecision(6))}`).join(",");
  return hash53(`${id}|${vs}|${Math.trunc(seed) >>> 0}|v${SFX_ENGINE_VERSION}`);
}

/** cyrb53: a 53-bit string hash, as 14 hex digits. */
export function hash53(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** Whether `values` differ from the preset's defaults. */
export function isCustom(id: string, values: Record<string, number> = {}): boolean {
  const v = resolveValues(id, values), d = sfxDefaults(id);
  return Object.keys(d).some((k) => Math.abs(v[k] - d[k]) > 1e-9);
}
