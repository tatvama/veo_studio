/**
 * The graphics check in the page (docs/EDITOR.md §16.10): text measured on a canvas in the same fonts the renderer
 * uses, and letters the fonts can't draw found by drawing each one next to a letter no font has (U+FFFF-style "tofu"):
 * a letter that draws exactly like it is missing. Fonts are loaded first (`document.fonts.load`), so the answers match
 * the export. Browser only.
 */
import type { EditProject } from "../../model/types";
import { runQc, type Finding, type QcDeps } from "./checks";

let canvas: HTMLCanvasElement | null = null;
const ctx = () => {
  if (!canvas) { canvas = document.createElement("canvas"); canvas.width = 96; canvas.height = 96; }
  return canvas.getContext("2d", { willReadFrequently: true })!;
};

/** Fonts used by some text, loaded before measuring (a font that never arrives is skipped after 3 s). */
export async function loadFonts(list: { font: string; text: string }[]): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const uniq = new Map<string, string>();
  for (const { font, text } of list) { const f = font.replace(/[\d.]+px/, "48px"); const t = uniq.get(f) ?? ""; if (t.length < 400) uniq.set(f, t + text.slice(0, 200)); }
  await Promise.race([
    Promise.all([...uniq].map(([f, t]) => document.fonts.load(f, t).catch(() => []))),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
}

const widthCache = new Map<string, number>();
function measure(font: string, text: string): number {
  const k = `${font}|${text}`;
  let w = widthCache.get(k);
  if (w === undefined) {
    const g = ctx();
    g.font = font;
    w = g.measureText(text).width;
    if (widthCache.size > 20000) widthCache.clear();
    widthCache.set(k, w);
  }
  return w;
}

const TOFU = "\u{10FFFD}";
const glyphCache = new Map<string, boolean>();
/** A picture of one letter at 48 px (as a string of alpha values), for comparing. */
function shape(font: string, ch: string): string {
  const g = ctx();
  g.clearRect(0, 0, 96, 96);
  g.font = font.replace(/(\d+(?:\.\d+)?)px/, "48px");
  g.fillStyle = "#000";
  g.textBaseline = "middle";
  g.fillText(ch, 8, 48);
  const d = g.getImageData(0, 0, 96, 96).data;
  let s = "";
  for (let i = 3; i < d.length; i += 16) s += d[i] > 127 ? "1" : "0";
  return s;
}

/** Letters of `text` the font stack draws as an empty box. */
function missing(font: string, text: string): string[] {
  const out: string[] = [];
  const seg = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  const parts = seg ? [...seg.segment(text)].map((x) => x.segment) : [...text];
  let tofu: string | null = null;
  for (const ch of new Set(parts)) {
    if (!ch.trim() || /^[\p{P}\p{S}\d]$/u.test(ch) && ch.charCodeAt(0) < 0x2000) continue;
    const k = `${font}|${ch}`;
    let bad = glyphCache.get(k);
    if (bad === undefined) {
      tofu ??= shape(font, TOFU);
      const base = [...ch][0];
      bad = shape(font, base) === tofu && measure(font, base) === measure(font, TOFU);
      glyphCache.set(k, bad);
    }
    if (bad) out.push(ch);
  }
  return out;
}

/** The checks' measuring and letter finding, in this page. */
export function browserDeps(): QcDeps {
  return { measure, missing, now: Date.now() };
}

/** Runs the check with real fonts: a first pass finds the fonts and texts, they load, then the real pass measures. */
export async function runQcInPage(p: EditProject, seqId: string): Promise<Finding[]> {
  const used: { font: string; text: string }[] = [];
  runQc(p, seqId, { measure: (font, text) => { if (used.length < 2000) used.push({ font, text }); return text.length * 10; } });
  await loadFonts(used);
  return runQc(p, seqId, browserDeps());
}
