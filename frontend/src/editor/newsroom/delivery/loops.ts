/**
 * Seamless loops (docs/EDITOR.md §16.11): a ticker, bug or animated background exported as N seconds that play
 * end to end without a jump. Graphics are a pure function of time (§16.3), so the frame after the last equals the
 * first when N is a whole number of every loop period in the design (blink, pulse, shine, float …; a background's
 * own period). The loop is cut after the in phase (so it starts fully shown) and well before any out phase.
 * A crawl's period depends on how long its text is drawn: with the look given (in the browser, where text can be
 * measured), `crawlPeriods` reads it exactly (tickers/period.ts); otherwise `findSeamless` finds the length where the
 * picture repeats by drawing small frames (the panel passes the renderer in).
 * Pure.
 */
import { uid } from "../../model/ids.ts";
import { fpsExact } from "../../model/time.ts";
import type { Sequence } from "../../model/types.ts";
import { blankSequence, placeColor, placeGraphic } from "./build.ts";
import { crawlPeriod } from "../render/kinds/ticker.ts";
import { valuesOf } from "../render/layout.ts";
import { DESIGN } from "../templates/kit.ts";
import type { ChannelLook, GfxInstance, GfxRatio, GfxTemplate } from "../types.ts";

/** Kinds whose picture moves in a way the template can't tell the period of. */
const OPEN_KINDS: Record<string, string> = {
  ticker: "a crawl's length depends on its text", clock: "a clock counts on", number: "a number counts",
};

/** Loop periods (seconds) in a template's design: layer loops and kinds' own `period` / `loopSeconds`. */
export function loopPeriods(t: GfxTemplate, ratio: GfxRatio = "16:9"): number[] {
  const d = t.designs[ratio] ?? t.designs["16:9"] ?? Object.values(t.designs)[0];
  const out: number[] = [];
  for (const l of d?.layers ?? []) {
    if (l.hidden) continue;
    const per = Number(l.anim?.loop?.period);
    if (per > 0 && Number.isFinite(per)) out.push(per);
    for (const k of ["period", "loopSeconds"]) {
      const v = Number((l.p as Record<string, unknown>)?.[k]);
      if (v > 0 && Number.isFinite(v)) out.push(v);
    }
  }
  return [...new Set(out.map((v) => Math.round(v * 1e6) / 1e6))];
}

/** Why a template's loop can't be checked from its design alone (empty = it can). */
export function openReasons(t: GfxTemplate, ratio: GfxRatio = "16:9"): string[] {
  const d = t.designs[ratio] ?? t.designs["16:9"] ?? Object.values(t.designs)[0];
  return [...new Set((d?.layers ?? []).filter((l) => !l.hidden && OPEN_KINDS[l.kind]).map((l) => OPEN_KINDS[l.kind]))];
}

/**
 * Each ticker's own cycle (seconds per pass; flips and stacks by their pages) when it can be measured, else null for
 * that ticker. Tickers that don't move give no period.
 */
export function crawlPeriods(t: GfxTemplate, gfx: Omit<GfxInstance, "template">, look: ChannelLook, ratio: GfxRatio, fps: number): (number | null)[] {
  const d = t.designs[ratio] ?? t.designs["16:9"] ?? Object.values(t.designs)[0];
  const D = DESIGN[ratio];
  const values = valuesOf(t, gfx.values ?? {});
  return (d?.layers ?? []).filter((l) => !l.hidden && l.kind === "ticker").map((l) => {
    try { return crawlPeriod(l, values, look, { designW: D.w, designH: D.h, fps }); } catch { return null; }
  });
}

/**
 * Frames of one cycle of all the periods together: the smallest n where every period fits a whole number of times
 * (within `tol` frames, so 1.2 s at 29.97 fps = 35.96 frames counts as 36). 1 when nothing loops; null when no cycle
 * is shorter than `max` frames.
 */
export function cycleFrames(periods: number[], fps: number, max = Math.round(fpsExact(fps) * 600), tol = 0.1): number | null {
  const pf = periods.filter((p) => p > 0).map((p) => p * fpsExact(fps));
  if (!pf.length) return 1;
  for (let n = 1; n <= max; n++) if (pf.every((f) => { const k = Math.round(n / f); return k >= 1 && Math.abs(n - k * f) <= tol; })) return n;
  return null;
}

export interface LoopLength { frames: number; seconds: number; cycles: number; cycle: number | null; exact: boolean }

/** The loop length nearest to `seconds` that is a whole number of cycles (at least one); as asked when unknown. */
export function loopLength(seconds: number, fps: number, cycle: number | null): LoopLength {
  const f = fpsExact(fps);
  const want = Math.max(1, Math.round(seconds * f));
  if (!cycle) return { frames: want, seconds: want / f, cycles: 1, cycle: null, exact: false };
  const cycles = Math.max(1, Math.round(want / cycle));
  return { frames: cycles * cycle, seconds: (cycles * cycle) / f, cycles, cycle, exact: true };
}

/** Where a loop can start: after the in phase (whole frames). */
export const loopStart = (t: GfxTemplate, fps: number) => Math.ceil(Math.max(0, t.timing?.in ?? 0) * fpsExact(fps) - 1e-6);

/** How different two RGBA frames are: the mean absolute difference over every channel, 0..1. */
export function frameDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return 1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length / 255;
}

/** Below this the seam can't be seen (about a tenth of a level on average). */
export const SEAMLESS = 0.0005;

/** The first frame against the frame after the last: is the loop seamless? `draw(t)` = RGBA of the graphic at t seconds. */
export function seamCheck(draw: (t: number) => ArrayLike<number> | null, startFrame: number, frames: number, fps: number): { diff: number; ok: boolean } | null {
  const f = fpsExact(fps);
  const a = draw(startFrame / f), b = draw((startFrame + frames) / f);
  if (!a || !b) return null;
  const diff = frameDifference(a, b);
  return { diff, ok: diff <= SEAMLESS };
}

/**
 * The length between `minFrames` and `maxFrames` where the picture comes back closest to the first frame (a crawl
 * repeats when its text has gone round once). Returns the best length and how different that frame still is.
 */
export function findSeamless(draw: (t: number) => ArrayLike<number> | null, startFrame: number, fps: number, minFrames: number, maxFrames: number):
  { frames: number; diff: number } | null {
  const f = fpsExact(fps);
  const first = draw(startFrame / f);
  if (!first) return null;
  let best = { frames: Math.max(1, minFrames), diff: Infinity };
  for (let n = Math.max(1, minFrames); n <= maxFrames; n++) {
    const px = draw((startFrame + n) / f);
    if (!px) return null;
    const d = frameDifference(first, px);
    if (d < best.diff - 1e-9) best = { frames: n, diff: d };
    if (d <= SEAMLESS) break;
  }
  return best;
}

/** findSeamless in steps of `chunk` frames, letting the page breathe in between (a crawl may need a minute of frames). */
export async function findSeamlessAsync(draw: (t: number) => ArrayLike<number> | null, startFrame: number, fps: number, minFrames: number, maxFrames: number,
  chunk = 50): Promise<{ frames: number; diff: number } | null> {
  let best: { frames: number; diff: number } | null = null;
  for (let a = Math.max(1, minFrames); a <= maxFrames; a += chunk) {
    const r = findSeamless(draw, startFrame, fps, a, Math.min(maxFrames, a + chunk - 1));
    if (!r) return null;
    if (!best || r.diff < best.diff - 1e-9) best = r;
    if (best.diff <= SEAMLESS) break;
    await new Promise((res) => setTimeout(res, 0));
  }
  return best;
}

export interface LoopPlan {
  sequence: Sequence; range: { in: number; out: number };
  length: LoopLength; startFrame: number; periods: number[];
  /** Why the seam can't be promised from the design (a crawl, a clock …). */
  open: string[];
  /** Nothing moves once it's in: any length loops. */
  still: boolean;
}

/**
 * A sequence that holds one graphic long enough for a loop of about `seconds` (whole cycles when the design has
 * periods): the range to export starts after the in phase. `background` "#rrggbb" puts a colour under it (an mp4
 * loop), else it's on transparency.
 */
export function planLoop(t: GfxTemplate, gfx: Omit<GfxInstance, "template">, o: { seconds: number; width: number; height: number; fps: number;
  background?: string | null; frames?: number; ratio?: GfxRatio; look?: ChannelLook }): LoopPlan {
  const ratio = o.ratio ?? (o.width >= o.height ? "16:9" : "9:16");
  const periods = loopPeriods(t, ratio);
  let open = openReasons(t, ratio);
  // tickers whose cycle can be measured loop exactly: their periods join the rest
  if (o.look && open.includes(OPEN_KINDS.ticker)) {
    const per = crawlPeriods(t, gfx, o.look, ratio, o.fps);
    if (per.every((x) => x !== null)) {
      for (const x of per) if (x! > 0) periods.push(Math.round(x! * 1e6) / 1e6);
      open = open.filter((r) => r !== OPEN_KINDS.ticker);
    }
  }
  const still = !periods.length && !open.length;
  // a crawl or a clock: its own motion can't be read from the design, so whole cycles of the rest promise nothing
  const cycle = open.length ? null : cycleFrames(periods, o.fps);
  const length = o.frames ? { frames: o.frames, seconds: o.frames / fpsExact(o.fps), cycles: 1, cycle: null, exact: false } : loopLength(o.seconds, o.fps, cycle);
  const startFrame = loopStart(t, o.fps);
  // past the loop: the out phase and a second of room, so the out never reaches the exported frames
  const tail = Math.ceil(((t.loop ? 0 : t.timing?.out ?? 0) + 1) * fpsExact(o.fps));
  const total = startFrame + length.frames + tail;
  let seq = { ...blankSequence(`Loop · ${t.name}`, o), id: uid("s") };
  if (o.background) {
    const v1 = seq.tracks.find((x) => x.kind === "video")!;
    seq = placeColor(seq, v1.id, 0, total, o.background, "Background");
  }
  seq = placeGraphic(seq, t, 0, total, gfx).seq;
  return { sequence: seq, range: { in: startFrame, out: startFrame + length.frames }, length, startFrame, periods, open, still };
}
