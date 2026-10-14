/**
 * Text layout for graphics (docs/EDITOR.md §16.3): measuring with a cache, wrapping, fitting (shrink to 60 %, then
 * wrap to `maxLines`, then an ellipsis) and splitting into animation parts. Indic text is never split per letter
 * (letters join): its smallest part is a word; Latin text splits into grapheme clusters (Intl.Segmenter). Pure: the
 * measuring function is passed in, so the fitting maths is Node-testable.
 */
import { scriptOf } from "../format.ts";
import type { Ctx2D } from "./contract.ts";
import { assetEpoch } from "./images.ts";

/** Width of a string in the current font (design px). */
export type Measure = (s: string) => number;

const widths = new Map<string, number>();
let epoch = -1;
/** Measurements made before a font arrived are wrong: every cache starts over when an asset lands. */
export function freshCaches(): void {
  const e = assetEpoch();
  if (e !== epoch) { epoch = e; widths.clear(); fitCache.clear(); onFresh.forEach((f) => f()); }
}
const onFresh = new Set<() => void>();
/** Also clear this cache when fonts or pictures arrive. */
export const clearWithFonts = (f: () => void) => { onFresh.add(f); };

/** A cached measurer for a context's current font and letter spacing. */
export function measurer(g: Ctx2D, font: string, tracking = 0): Measure {
  freshCaches();
  return (s: string) => {
    const k = `${font}|${tracking}|${s}`;
    let w = widths.get(k);
    if (w === undefined) {
      if (g.font !== font) g.font = font;
      const ls = (g as { letterSpacing?: string }).letterSpacing;
      if (ls && ls !== "0px") (g as { letterSpacing?: string }).letterSpacing = "0px";
      w = g.measureText(s).width;
      if (ls && ls !== "0px") (g as { letterSpacing?: string }).letterSpacing = ls;
      // letterSpacing adds after every character; we draw with it, so measure it the same way
      if (tracking) w += tracking * [...s].length;
      if (widths.size > 20000) widths.clear();
      widths.set(k, w);
    }
    return w;
  };
}

/** True when the text uses a script whose letters join (never animate or break it per letter). */
export const isIndic = (s: string) => scriptOf(s) !== "latn";

const segCache = new Map<string, Intl.Segmenter | null>();
function segmenter(by: "grapheme" | "word"): Intl.Segmenter | null {
  let s = segCache.get(by);
  if (s === undefined) {
    try { s = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: by }) : null; } catch { s = null; }
    segCache.set(by, s);
  }
  return s;
}

/** Grapheme clusters (Latin per letter) or, for Indic text, words with their trailing spaces. */
export function charParts(s: string): string[] {
  if (isIndic(s)) return wordParts(s);
  const seg = segmenter("grapheme");
  return seg ? [...seg.segment(s)].map((x) => x.segment) : [...s];
}
/** Words, each with the spaces after it (so the parts join back into the line). */
export function wordParts(s: string): string[] {
  const out: string[] = [];
  const re = /\S+\s*|\s+/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (!m[0].trim() && out.length) out[out.length - 1] += m[0]; else out.push(m[0]);
  }
  return out;
}

/** Wraps one paragraph to `maxW` at spaces (a word longer than the line stays whole). */
export function wrapLine(text: string, maxW: number, measure: Measure): string[] {
  const words = text.split(/(\s+)/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (!w) continue;
    const next = line + w;
    if (line.trim() && w.trim() && measure(next.trimEnd()) > maxW) { out.push(line.trimEnd()); line = w; }
    else line = next;
  }
  out.push(line.trimEnd());
  return out;
}

/** Wraps text (newlines kept) to `maxW`. */
export const wrapText = (text: string, maxW: number, measure: Measure): string[] =>
  text.split(/\r?\n/).flatMap((p) => wrapLine(p, maxW, measure));

/** Cuts a line to fit `maxW` with "…" (at a word for Indic text, at a letter otherwise). */
export function ellipsize(line: string, maxW: number, measure: Measure): string {
  if (measure(line) <= maxW) return line;
  const parts = isIndic(line) ? wordParts(line) : charParts(line);
  let lo = 0, hi = parts.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(parts.slice(0, mid).join("").trimEnd() + "…") <= maxW) lo = mid; else hi = mid - 1;
  }
  return lo ? parts.slice(0, lo).join("").trimEnd() + "…" : "…";
}

export interface FitOptions {
  /** Design px at 100 %. */
  size: number;
  /** Line height as a multiple of the size. */
  lineHeight: number;
  /** 0 = as many as the box height holds. */
  maxLines: number;
  /** shrink (default): shrink (to minScale), wrap, then ellipsis; wrap: wrap then ellipsis; ellipsis: one line; none. */
  fit: "shrink" | "wrap" | "ellipsis" | "none";
  /** Smallest size as a share of `size` (0.6). */
  minScale: number;
}
export interface FitResult { lines: string[]; size: number; /** size / nominal */ scale: number; ellipsized: boolean; width: number }

/**
 * Fits text into w × h. `measureAt(size)` returns a measurer for that font size. A single-line box shrinks first; a
 * multi-line box wraps at full size first and shrinks only when the lines don't fit; the last resort is "…".
 */
export function fitText(text: string, w: number, h: number, o: FitOptions, measureAt: (size: number) => Measure): FitResult {
  const lh = o.lineHeight > 0 ? o.lineHeight : 1.15;
  const linesFor = (size: number) => Math.max(1, o.maxLines > 0 ? o.maxLines : Math.floor((h + size * 0.2) / (size * lh)));
  const widest = (ls: string[], m: Measure) => ls.reduce((a, l) => Math.max(a, m(l)), 0);
  const done = (lines: string[], size: number, ellipsized = false): FitResult =>
    ({ lines, size, scale: size / o.size, ellipsized, width: widest(lines, measureAt(size)) });
  const hard = text.split(/\r?\n/);
  if (o.fit === "none") return done(hard, o.size);
  const m0 = measureAt(o.size);
  const n0 = linesFor(o.size);
  const natural = widest(hard, m0);
  if (natural <= w && hard.length <= n0) return done(hard, o.size);
  const minSize = o.size * Math.min(1, Math.max(0.2, o.minScale || 0.6));
  if (o.fit === "ellipsis") return done([ellipsize(hard[0], w, m0)], o.size, true);
  if (o.fit === "shrink" && n0 <= 1 && hard.length <= 1) {
    // one line: width scales with the size
    const s = Math.max(minSize, Math.floor(o.size * (w / natural) * 4) / 4);
    const m = measureAt(s);
    const line = hard[0];
    return m(line) <= w ? done([line], s) : done([ellipsize(line, w, m)], s, true);
  }
  // wrap, shrinking (fit "shrink") in steps until the lines fit both ways
  const steps = o.fit === "shrink" ? 8 : 0;
  for (let i = 0; i <= steps; i++) {
    const s = o.size - ((o.size - minSize) * i) / Math.max(1, steps);
    const m = measureAt(s);
    const lines = wrapText(text, w, m);
    if (lines.length <= linesFor(s) && widest(lines, m) <= w + 0.5) return done(lines, s);
  }
  const s = o.fit === "shrink" ? minSize : o.size;
  const m = measureAt(s);
  const max = linesFor(s);
  const lines = wrapText(text, w, m);
  const kept = lines.slice(0, max);
  const cut = lines.length > max;
  if (cut) kept[max - 1] = ellipsize(kept[max - 1] + " " + lines.slice(max).join(" "), w, m);
  return done(kept.map((l) => (m(l) > w ? ellipsize(l, w, m) : l)), s, cut || kept.some((l) => l.endsWith("…")));
}

const fitCache = new Map<string, FitResult>();
/** fitText with a cache (by font, box and text). */
export function fitCached(key: string, run: () => FitResult): FitResult {
  freshCaches();
  let r = fitCache.get(key);
  if (!r) { r = run(); if (fitCache.size > 4000) fitCache.clear(); fitCache.set(key, r); }
  return r;
}
