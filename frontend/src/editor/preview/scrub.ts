/**
 * Hover maths of the preview cards (preview-polish): where the pointer is across a card → a progress 0..1 (with a
 * small dead zone at each edge so the ends are easy to hit), what that progress means for each kind of item (a
 * transition's progress, a title's in → hold → out, an effect's or a look's intensity), which pre-rendered frame
 * of a strip shows, how a held card loops (15 fps), and the slightly exaggerated parameters an effect's card shows.
 * Pure.
 */
import type { TitleSpec } from "../model/types.ts";

/** Cards play their loops at this rate. */
export const LOOP_FPS = 15;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** The pointer's x across a card [left, left + width] → 0..1; the outer `edge` fraction at each side is 0 or 1. */
export function scrubProgress(x: number, left: number, width: number, edge = 0.06): number {
  if (!(width > 0) || !Number.isFinite(x)) return 0;
  const u = (x - left) / width;
  const e = Math.min(0.45, Math.max(0, edge));
  return clamp01((u - e) / (1 - 2 * e));
}

/** When a title is fully in and when it starts to leave (seconds into a clip `dur` long), as render/title.ts times it. */
export function titleTiming(s: Pick<TitleSpec, "text" | "look" | "animIn" | "animOut" | "karaoke">, dur: number): { inEnd: number; outStart: number; hold: number } {
  const L = s.look ?? {};
  const LEGACY_IN: Record<string, string> = { fade: "fade", slide_up: "rise", typewriter: "typewriter", pop: "pop" };
  const LEGACY_OUT: Record<string, string> = { fade: "fade", slide_down: "rise" };
  const inId = L.in ?? LEGACY_IN[s.animIn ?? "none"] ?? "none";
  const outId = L.out ?? LEGACY_OUT[s.animOut ?? "none"] ?? "none";
  const anim = Math.min(0.5, dur / 3);
  const text = s.karaoke?.words.length ? s.karaoke.words.map((w) => w.text).join(" ") : s.text ?? "";
  const typeT = Math.max(anim, Math.min(dur * 0.4, 0.04 * text.length));
  const inEnd = inId === "none" ? 0 : Math.min(dur * 0.45, L.inDur ?? (inId === "typewriter" ? typeT : anim));
  const outDur = outId === "none" ? 0 : Math.min(dur * 0.3, L.outDur ?? anim);
  const outStart = Math.max(inEnd, dur - outDur);
  // a little past the middle of the rest: sub lines and decorations that follow the text are in by then
  return { inEnd, outStart, hold: Math.min(outStart, inEnd + (outStart - inEnd) * 0.55) };
}

/**
 * A title's time for a hover progress: the first 30 % of the card plays the entrance, the middle 40 % holds, the
 * last 30 % plays the exit (so both animations get room under the pointer).
 */
export function titleTimeAt(p: number, dur: number, inEnd: number, outStart: number): number {
  const q = clamp01(p);
  if (q <= 0.3) return (q / 0.3) * inEnd;
  if (q < 0.7) return inEnd + ((q - 0.3) / 0.4) * (outStart - inEnd);
  return outStart + ((q - 0.7) / 0.3) * (dur - outStart);
}

/** The strip frame for a progress (n frames spread over 0..1). */
export function stripIndex(p: number, n: number): number {
  return n <= 1 ? 0 : Math.round(clamp01(p) * (n - 1));
}

/**
 * Which frame of an n-frame strip a held card shows `elapsedMs` after it started: "loop" plays 0..n−1 and holds the
 * last frame `hold` frames; "pingpong" goes there and back (a Ken Burns move never jumps).
 */
export function loopIndex(elapsedMs: number, n: number, mode: "loop" | "pingpong" = "loop", hold = 0, fps = LOOP_FPS): number {
  if (n <= 1) return 0;
  const f = Math.max(0, Math.floor((elapsedMs * fps) / 1000));
  if (mode === "pingpong") { const period = 2 * (n - 1); const k = f % period; return k < n ? k : period - k; }
  const k = f % (n + Math.max(0, hold));
  return Math.min(n - 1, k);
}

/** A strip of `n` frames over `seconds` at most `fps` a second: their times. */
export function stripTimes(seconds: number, n: number): number[] {
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) => (i / (n - 1)) * seconds);
}

// ── an effect's card parameters ──────────────────────────────────────────────────────────────────────────

export interface NumParam { name: string; type: string; default: unknown; min?: number; max?: number }

/** Parameters that say how much of the effect there is. */
const INTENSITY = /amount|strength|intensity|mix|opacity|depth|drive|glow|grain|dust|scratch|distort|wet|bloom|halation|flicker|weave|noise|fade|vignette|aberration|bleed|smear|jitter|wobble|warp|shake|bend|power|level|blur|radius|softness|sharpen|detail|saturation|vibrance/;

/** True for a parameter that scales the effect's strength. */
export const isIntensityParam = (p: NumParam) => (p.type === "float" || p.type === "number" || p.type === "int") && typeof p.default === "number" && INTENSITY.test(p.name.toLowerCase());

/**
 * An effect's parameters for its card at `k` (0 = none of it, 1 = the card's picture: the defaults pushed 30 % of
 * the way to their maximum, or to a quarter of the range when the default is "off"; up to 1.5 for more). Only the
 * strength-like parameters move; the rest keep their defaults.
 */
export function cardParams(params: readonly NumParam[], k = 1): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    if (!isIntensityParam(p)) continue;
    const d = p.default as number;
    const lo = typeof p.min === "number" ? p.min : 0, hi = typeof p.max === "number" ? p.max : Math.max(1, d * 2);
    const neutral = lo <= 0 && hi >= 0 ? 0 : lo;
    const full = d === neutral ? neutral + (hi - neutral) * 0.25 : d + (hi - d) * 0.3;
    let v = neutral + (full - neutral) * Math.max(0, Math.min(1.5, k));
    v = Math.max(lo, Math.min(hi, v));
    out[p.name] = p.type === "int" ? Math.round(v) : Math.round(v * 1e4) / 1e4;
  }
  return out;
}
