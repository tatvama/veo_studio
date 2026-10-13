/**
 * How long one pass of a ticker takes (nr-delivery's loop export, docs/EDITOR.md §16.11): a crawl's strip length
 * over its speed; a flip's pages × seconds per page; a stack's items × seconds per step. A crawl's strip length needs
 * its text measured: in the browser this measures with a canvas, or the caller passes a measurer, or the strip width
 * it already knows. Exports that must loop exactly should draw the crawl with `startFull` on (the frame at the
 * period equals the first). No DOM at import time.
 */
import { fmtNumber } from "../format.ts";
import { cssFont } from "../render/paint.ts";
import type { Ctx2D, LayerRenderContext } from "../render/contract.ts";
import type { Measure } from "../render/text.ts";
import type { ChannelLook, GfxLayer, GfxValue } from "../types.ts";
import { makeCanvas } from "./canvas.ts";
import { crawlSpeed, frameSpeed, loopSpeed, pagesOf } from "./math.ts";
import { itemsOf, layoutItem } from "./pieces.ts";
import { tickerProps, type TickerProps } from "./props.ts";

/** The crawl's speed in design px/s for a design W × H: the preset (or custom), snapped to whole pixels a frame, or
 *  (loopFit) adjusted so `seconds` holds a whole number of strip lengths `cycle`. */
export function tickerSpeed(P: TickerProps, designW: number, designH: number, fps: number, cycle?: number, seconds?: number): number {
  const base = crawlSpeed(P.speed, designW, designH, P.speedPx);
  if (P.loopFit && cycle && seconds) return loopSpeed(base, cycle, seconds);
  return frameSpeed(base, fps);
}

/** Measures `text` in a CSS `font` (design px). */
export type TextMeasure = (font: string, text: string) => number;

/** A just-enough render context for laying items out (the same fonts, text and numbers the renderer uses). */
function layoutContext(values: Record<string, GfxValue>, look: ChannelLook): LayerRenderContext {
  const v = (id: string) => values[id] ?? null;
  return {
    t: 0, dur: 0, phase: { in: 1, out: 1 }, shown: 0, look, ratio: "16:9", designW: 1920, designH: 1080, scale: 1, seed: 0, fps: 25, clock: 0,
    value: v,
    text: (s) => (s ?? "").replace(/\{([\w.-]+)\}/g, (all, k: string) => { const x = values[k]; return typeof x === "string" || typeof x === "number" ? String(x) : k in values ? "" : all; }),
    paint: (p, fb) => (typeof p === "string" && p ? p : fb ?? ""),
    font: (name, size, weight, sample) => cssFont(name, look, size, weight, sample),
    image: () => null, logo: () => null,
    number: (n, f) => fmtNumber(n, look, f),
    rand: () => 0.5, ease: (x) => x,
  };
}

/**
 * The crawl strip's length in design px (every item and its separator), or null when it can't be measured here (no
 * canvas and no `measure`). A look with a picture logo used as the separator measures slightly short (its text logo).
 */
export function crawlStripWidth(layer: GfxLayer, values: Record<string, GfxValue>, look: ChannelLook, measure?: TextMeasure): number | null {
  const P = tickerProps(layer.p);
  const items = itemsOf(values[P.source]);
  if (!items.length) return 0;
  let g: Ctx2D | null = null;
  let mf: ((font: string, track: number) => Measure) | undefined;
  if (measure) mf = (font, track) => (s) => measure(font, s) + track * [...s].length;
  else {
    const c = makeCanvas(4, 4);
    if (!c) return null;
    g = c.g;
  }
  const ctx = (g ?? ({} as Ctx2D));
  const rc = layoutContext(values, look);
  const h = layer.box[3];
  return items.reduce((a, it, i) => a + layoutItem(ctx, rc, P, it, { h, maxW: Infinity, sep: true, num: i + 1, count: items.length }, mf).w, 0);
}

/**
 * Seconds of one pass of a ticker layer, after which the picture repeats; 0 = it doesn't move (any length loops);
 * null = a crawl whose strip can't be measured here (pass `stripW` or `measure`).
 * - crawl: strip length / speed (the speed for this design, frame rate and, with "Perfect loop", clip length `dur`);
 * - flip / tally: pages × seconds per page; stack: items × seconds per step (0 when every item fits on screen).
 */
export function crawlPeriod(layer: GfxLayer, values: Record<string, GfxValue>, look: ChannelLook,
  o: { designW: number; designH: number; fps: number; dur?: number; stripW?: number; measure?: TextMeasure }): number | null {
  const P = tickerProps(layer.p);
  const items = itemsOf(values[P.source]);
  if (!items.length) return 0;
  if (P.mode === "seats") return 0;
  if (P.mode === "stack") return items.length <= P.rows ? 0 : items.length * Math.max(0.5, P.hold);
  if (P.mode === "flip" || P.mode === "tally") {
    const n = pagesOf(items, P.perPage, P.mode === "flip" && P.byTag).length;
    return n <= 1 ? 0 : n * Math.max(0.5, P.hold);
  }
  const strip = o.stripW ?? crawlStripWidth(layer, values, look, o.measure);
  if (strip === null) return null;
  if (!(strip > 0)) return 0;
  return strip / tickerSpeed(P, o.designW, o.designH, o.fps, strip, o.dur);
}
