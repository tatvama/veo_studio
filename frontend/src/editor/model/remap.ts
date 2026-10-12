/**
 * Speed ramps (editor-motion, docs/EDITOR.md §10). `TimelineClip.timeRemap` is the speed in % of the clip's `speed`
 * (100 = as `speed` says, 0 = a freeze) as a keyframed curve over clip frames; the source advances by its integral.
 * Here: the curve's integral ("speed-frames": timeline frames at 1×, multiply by sourceRate for source frames), the
 * constant-speed pieces the engine and the mixer draw a ramp as, and the presets. Pure maths; the clip-level edits
 * that use it are in retime.ts.
 */
import { valueAt } from "./params.ts";
import type { Easing, Keyframe, Param, TimelineClip } from "./types.ts";

/** Highest ramp speed (% of the clip's speed). */
export const RAMP_MAX = 1000;
/** A stretch slower than this multiplier is shown as a freeze (one held frame). */
export const FREEZE_BELOW = 0.02;
const SUB = 8;

/** The speed multiplier (1 = the clip's speed) of a ramp at clip frame `f` (held before / after its keyframes). */
export const rampAt = (p: Param<number>, f: number) => Math.max(0, Math.min(RAMP_MAX, Number(valueAt(p, f)) || 0)) / 100;

const tables = new WeakMap<Param<number>, number[]>();
/** cum[i] = ∫₀ⁱ ramp for integers 0 ≤ i ≤ n (midpoint rule, 8 steps a frame: exact for steps and straight ramps). */
function cumTo(p: Param<number>, n: number): number[] {
  let t = tables.get(p);
  if (!t) { t = [0]; tables.set(p, t); }
  while (t.length <= n) {
    const i = t.length - 1;
    let s = 0;
    for (let k = 0; k < SUB; k++) s += rampAt(p, i + (k + 0.5) / SUB);
    t.push(t[i] + s / SUB);
  }
  return t;
}

/** ∫ₐᵇ ramp (speed-frames; negative when b < a). Before frame 0 and after the last keyframe the speed holds. */
export function rampSpan(p: Param<number>, a: number, b: number): number {
  if (b < a) return -rampSpan(p, b, a);
  const ks = p.keyframes ?? [];
  const L = Math.max(0, Math.ceil(ks.length ? ks[ks.length - 1].frame : 0));
  const F = (x: number): number => {
    if (x <= 0) return x * rampAt(p, 0);
    if (x >= L) { const t = cumTo(p, L); return t[L] + (x - L) * rampAt(p, L + 0.5); }
    const i = Math.floor(x), t = cumTo(p, i + 1);
    return t[i] + (x - i) * (t[i + 1] - t[i]);
  };
  return F(b) - F(a);
}

/** Speed-frames a clip uses between clip frames a and b (b − a without a ramp). Source frames = this × sourceRate. */
export const clipSpan = (c: Pick<TimelineClip, "timeRemap">, a: number, b: number) => (c.timeRemap ? rampSpan(c.timeRemap, a, b) : b - a);
/** The ramp multiplier at clip frame f (1 without a ramp). */
export const clipRampAt = (c: Pick<TimelineClip, "timeRemap">, f: number) => (c.timeRemap ? rampAt(c.timeRemap, f) : 1);
export const hasRamp = (c: Pick<TimelineClip, "timeRemap">) => !!c.timeRemap && (!!c.timeRemap.keyframes?.length || Math.abs(c.timeRemap.value - 100) > 1e-6);

/** Clip frame (fractional) where the clip has used `s` speed-frames (the inverse of clipSpan from 0; for freezes the
 *  first frame that gets there). */
export function frameForSpan(c: Pick<TimelineClip, "timeRemap" | "duration">, s: number): number {
  if (!c.timeRemap) return s;
  let lo = 0, hi = Math.max(1, c.duration);
  while (clipSpan(c, 0, hi) < s && hi < 1e7) hi *= 2;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (clipSpan(c, 0, m) < s) lo = m; else hi = m; }
  return hi;
}

// ── pieces: how the engine and the mixer play a ramp ─────────────────────────

export interface RampPiece {
  /** Clip frames [from, to). */
  from: number; to: number;
  /** Speed-frames used before `from`. */
  offset: number;
  /** The piece's average multiplier (it plays at this constant speed); 0 for a freeze. */
  speed: number;
  freeze: boolean;
}

/**
 * The clip as constant-speed pieces: consecutive frames stay in one piece while the speed changes by less than
 * `tolerance` (relative), freezes are their own pieces, and the tolerance grows until there are at most `maxPieces`.
 * Each piece's speed is its exact average, so the pieces meet without a jump in the source.
 */
export function rampPieces(c: Pick<TimelineClip, "timeRemap" | "duration">, opts: { tolerance?: number; maxPieces?: number } = {}): RampPiece[] {
  const D = Math.max(1, Math.round(c.duration));
  if (!c.timeRemap) return [{ from: 0, to: D, offset: 0, speed: 1, freeze: false }];
  const p = c.timeRemap;
  const per = Array.from({ length: D }, (_, f) => rampSpan(p, f, f + 1));
  let tol = opts.tolerance ?? 0.05;
  // each piece is its own <video> / decoder in the engine until it can play a time map itself: keep them few
  const max = Math.max(1, opts.maxPieces ?? 12);
  for (;;) {
    const out: RampPiece[] = [];
    let a = 0;
    while (a < D) {
      const frozen = per[a] < FREEZE_BELOW;
      let lo = per[a], hi = per[a], b = a + 1;
      while (b < D) {
        const v = per[b];
        if ((v < FREEZE_BELOW) !== frozen) break;
        const nlo = Math.min(lo, v), nhi = Math.max(hi, v);
        if (!frozen && nhi - nlo > tol * Math.max(nhi, 0.05)) break;
        lo = nlo; hi = nhi; b++;
      }
      const span = rampSpan(p, a, b);
      out.push({ from: a, to: b, offset: rampSpan(p, 0, a), speed: frozen ? 0 : span / (b - a), freeze: frozen });
      a = b;
    }
    if (out.length <= max || tol > 4) return out;
    tol *= 1.6;
  }
}

// ── presets ──────────────────────────────────────────────────────────────────

export type RampPresetId = "ramp_up" | "ramp_down" | "slowmo_burst" | "speed_burst" | "freeze";

export const RAMP_PRESETS: { id: RampPresetId; label: string; hint: string }[] = [
  { id: "ramp_up", label: "Ramp up", hint: "Starts in slow motion and speeds up to normal" },
  { id: "ramp_down", label: "Ramp down", hint: "Slows down into slow motion at the end" },
  { id: "slowmo_burst", label: "Slow-motion burst", hint: "Normal → slow motion around the playhead → normal" },
  { id: "speed_burst", label: "Speed burst", hint: "Fast → slow motion → normal (a velocity edit)" },
  { id: "freeze", label: "Freeze at playhead", hint: "Holds the frame at the playhead, then plays on" },
];

const k = (frame: number, value: number, ease: Easing): Keyframe<number> => ({ frame: Math.round(frame), value, ease });

/** Keyframes without two on one frame (the later wins), sorted. */
function tidy(ks: Keyframe<number>[], D: number): Keyframe<number>[] {
  const by = new Map<number, Keyframe<number>>();
  for (const x of ks) by.set(Math.max(0, Math.min(Math.max(0, D - 1), x.frame)), { ...x, frame: Math.max(0, Math.min(Math.max(0, D - 1), x.frame)) });
  return [...by.values()].sort((a, b) => a.frame - b.frame);
}

/**
 * A preset ramp for a clip `D` frames long. `at` = the clip frame it centres on (bursts, freeze; default the middle),
 * `slow` = the slow-motion speed in %, `hold` = freeze length in frames. `base` = an existing ramp the freeze goes into.
 */
export function rampPreset(id: RampPresetId, D: number, opts: { at?: number; slow?: number; fast?: number; hold?: number; base?: Param<number> } = {}): Param<number> {
  const slow = opts.slow ?? 30, fast = opts.fast ?? 250;
  const at = Math.max(0, Math.min(D - 1, Math.round(opts.at ?? D / 2)));
  switch (id) {
    case "ramp_up": return { value: 100, keyframes: tidy([k(0, slow, "ease_in_out"), k(D * 0.45, 100, "linear")], D) };
    case "ramp_down": return { value: 100, keyframes: tidy([k(D * 0.55, 100, "ease_in_out"), k(D - 1, slow, "linear")], D) };
    case "slowmo_burst": {
      const w = Math.max(6, Math.round(D * 0.3)), r = Math.max(3, Math.round(D * 0.08));
      const a = Math.max(r, at - Math.floor(w / 2)), b = Math.min(D - 1 - r, a + w);
      return { value: 100, keyframes: tidy([k(a - r, 100, "ease_in_out"), k(a, slow, "linear"), k(b, slow, "ease_in_out"), k(b + r, 100, "linear")], D) };
    }
    case "speed_burst":
      return { value: 100, keyframes: tidy([k(0, fast, "linear"), k(D * 0.35, fast, "ease_in_out"), k(D * 0.45, slow, "linear"), k(D * 0.72, slow, "ease_in_out"), k(D * 0.85, 100, "linear")], D) };
    case "freeze": return freezeInRamp(opts.base, at, Math.max(1, Math.round(opts.hold ?? 25)));
  }
}

/**
 * A freeze of `n` frames at clip frame `f` put into a ramp (or into plain 100 %): the curve before `f` stays, the frame
 * holds for n frames, then the rest of the curve plays on (its keyframes move n frames later).
 */
export function freezeInRamp(base: Param<number> | undefined, f: number, n: number): Param<number> {
  const p = base ?? { value: 100 };
  const ks = p.keyframes ?? [];
  const before = ks.filter((x) => x.frame < f - 1);
  const after = ks.filter((x) => x.frame > f).map((x) => ({ ...x, frame: x.frame + n }));
  const vPrev = valueAt(p, Math.max(0, f - 1)), vAt = valueAt(p, f);
  const seg = [...ks].reverse().find((x) => x.frame <= f)?.ease ?? "linear";
  const out: Keyframe<number>[] = [...before];
  if (f > 0) out.push(k(f - 1, vPrev, "hold"));
  out.push(k(f, 0, "hold"), k(f + n, vAt, seg === "hold" ? "hold" : seg), ...after);
  return { value: p.value, keyframes: tidy(out, Number.MAX_SAFE_INTEGER) };
}

/** Clip duration that plays `span` speed-frames with ramp `p` (how long the clip gets when it keeps all its frames). */
export function durationForSpan(p: Param<number>, span: number, guess: number): number {
  let lo = 1, hi = Math.max(2, guess * 2);
  while (rampSpan(p, 0, hi) < span && hi < 1e7) hi *= 2;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (rampSpan(p, 0, m) < span) lo = m; else hi = m; }
  return Math.max(1, Math.round(hi));
}
