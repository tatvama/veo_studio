/**
 * Text layout and drawing for poster text. We lay text out ourselves (instead of Konva.Text) so that letter spacing uses
 * the browser's native `ctx.letterSpacing` and complex scripts (Devanagari, Kannada, Telugu, Tamil) keep their shaping,
 * words wrap inside the box, and auto-fit can shrink the font until the copy fits.
 */
import { displayText } from "../doc";
import { familyStack, scriptOf } from "../fonts";
import type { TextLayer } from "../types";
import { canvasPaint, isTransparent } from "./paint";

export interface TextLine { text: string; width: number; x: number; y: number }
export interface TextLayout {
  lines: TextLine[];
  fontSize: number;
  letterSpacing: number;
  strokeWidth: number;
  lineH: number;
  ascent: number;
  descent: number;
  /** top of the first line box, inside the layer box */
  top: number;
  blockW: number;
  blockH: number;
  pad: number;
  /** the hugging rectangle for a background pill, in layer space */
  pill: { x: number; y: number; width: number; height: number } | null;
  /** auto-fit had to shrink the font */
  shrunk: boolean;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function mctx(): CanvasRenderingContext2D {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d")!;
  return measureCtx;
}

export const NATIVE_SPACING = typeof CanvasRenderingContext2D !== "undefined" && "letterSpacing" in CanvasRenderingContext2D.prototype;

export function fontString(l: Pick<TextLayer, "fontStyle" | "fontWeight" | "fontFamily">, size: number): string {
  return `${l.fontStyle === "italic" ? "italic" : "normal"} ${l.fontWeight || 400} ${Math.max(0.5, size)}px ${familyStack(l.fontFamily)}`;
}

function setSpacing(c: CanvasRenderingContext2D, ls: number) {
  if (NATIVE_SPACING) (c as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${ls}px`;
}

const segmenter: Intl.Segmenter | null = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
export function graphemes(s: string): string[] {
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

function measurer(c: CanvasRenderingContext2D, ls: number) {
  const memo = new Map<string, number>();
  return (s: string) => {
    let v = memo.get(s);
    if (v === undefined) {
      if (!s) v = 0;
      else if (NATIVE_SPACING) v = c.measureText(s).width - ls; // no trailing spacing after the last letter
      else v = c.measureText(s).width + ls * Math.max(0, graphemes(s).length - 1);
      memo.set(s, v);
    }
    return v;
  };
}

/** Greedy word wrap. Words wider than the line are broken between graphemes (never inside a conjunct). */
function wrap(text: string, maxW: number, measure: (s: string) => number): { lines: string[]; broke: boolean } {
  const out: string[] = [];
  let broke = false;
  const breakWord = (word: string): string => {
    broke = true;
    let cur = "";
    for (const g of graphemes(word)) {
      if (cur && measure(cur + g) > maxW) { out.push(cur); cur = g; } else cur += g;
    }
    return cur;
  };
  for (const para of text.split("\n")) {
    const tokens = para.match(/\S+|\s+/g) ?? [];
    let cur = "";
    for (const tok of tokens) {
      if (/^\s+$/.test(tok)) { if (cur) cur += tok; continue; }
      const cand = cur + tok;
      if (measure(cand.trimEnd()) <= maxW + 0.5) { cur = cand; continue; }
      if (cur.trim()) out.push(cur.trimEnd());
      cur = measure(tok) > maxW + 0.5 ? breakWord(tok) : tok;
    }
    out.push(cur.trimEnd());
  }
  return { lines: out, broke };
}

const cache = new Map<string, TextLayout>();

/** Lay a text layer out inside a w×h box. `fontsVersion` invalidates measurements once web fonts finish loading. */
export function layoutText(l: TextLayer, w: number, h: number, fontsVersion = 0, textOverride?: string): TextLayout {
  const text = textOverride ?? displayText(l);
  const key = [text, l.fontFamily, l.fontWeight, l.fontStyle, l.fontSize, l.lineHeight, l.letterSpacing, l.autoFit ? 1 : 0,
    l.background ? l.background.padding : -1, l.align, l.verticalAlign, l.stroke?.width ?? 0, Math.round(w * 10), Math.round(h * 10), fontsVersion].join("|");
  const hit = cache.get(key);
  if (hit) return hit;

  const c = mctx();
  const pad = l.background ? Math.max(0, l.background.padding) : 0;
  const availW = Math.max(1, w - pad * 2), availH = Math.max(1, h - pad * 2);
  const lh = l.lineHeight > 0 ? l.lineHeight : 1.2;

  const run = (size: number) => {
    const ls = l.fontSize ? (l.letterSpacing * size) / l.fontSize : l.letterSpacing;
    c.font = fontString(l, size);
    setSpacing(c, ls);
    const measure = measurer(c, ls);
    const { lines, broke } = wrap(text, availW, measure);
    const widths = lines.map(measure);
    return { size, ls, lines, widths, broke, blockH: lines.length * size * lh, blockW: Math.max(0, ...widths) };
  };

  let r = run(l.fontSize);
  let shrunk = false;
  if (l.autoFit && text.trim()) {
    const fits = (x: ReturnType<typeof run>) => !x.broke && x.blockH <= availH + 0.5 && x.blockW <= availW + 0.5;
    if (!fits(r)) {
      let lo = Math.min(4, l.fontSize), hi = l.fontSize, best: ReturnType<typeof run> | null = null;
      for (let i = 0; i < 14 && hi - lo > 0.25; i++) {
        const mid = (lo + hi) / 2;
        const t = run(mid);
        if (fits(t)) { best = t; lo = mid; } else hi = mid;
      }
      r = best ?? run(lo);
      shrunk = true;
    }
  }

  c.font = fontString(l, r.size);
  setSpacing(c, r.ls);
  const m = c.measureText(text.slice(0, 200) || "Hg");
  const ascent = m.fontBoundingBoxAscent ?? r.size * 0.8;
  const descent = m.fontBoundingBoxDescent ?? r.size * 0.2;
  const lineH = r.size * lh;
  const top = pad + (l.verticalAlign === "top" ? 0 : l.verticalAlign === "bottom" ? availH - r.blockH : (availH - r.blockH) / 2);
  const lines: TextLine[] = r.lines.map((t, i) => {
    const width = r.widths[i];
    const x = pad + (l.align === "left" ? 0 : l.align === "right" ? availW - width : (availW - width) / 2);
    const y = top + i * lineH + (lineH - (ascent + descent)) / 2 + ascent;
    return { text: t, width, x, y };
  });
  let pill: TextLayout["pill"] = null;
  if (l.background && text.trim()) {
    const used = lines.filter((x) => x.text);
    const minX = Math.min(...used.map((x) => x.x)), maxX = Math.max(...used.map((x) => x.x + x.width));
    pill = { x: minX - pad, y: top - pad, width: maxX - minX + pad * 2, height: r.blockH + pad * 2 };
  }
  const out: TextLayout = {
    lines, fontSize: r.size, letterSpacing: r.ls, strokeWidth: (l.stroke?.width ?? 0) * (l.fontSize ? r.size / l.fontSize : 1),
    lineH, ascent, descent, top, blockW: r.blockW, blockH: r.blockH, pad, pill, shrunk,
  };
  if (cache.size > 400) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}

/** Height the box needs so the text is not cut off (used after inline editing). */
export function neededHeight(l: TextLayer, w: number, text: string, fontsVersion = 0): number {
  const t = layoutText({ ...l, autoFit: false }, w, 1e6, fontsVersion, l.uppercase ? text.toLocaleUpperCase() : text);
  return Math.ceil(t.blockH + t.pad * 2);
}

function drawLine(c: CanvasRenderingContext2D, mode: "fillText" | "strokeText", line: TextLine, ls: number) {
  if (NATIVE_SPACING || !ls || scriptOf(line.text) !== "latin") {
    c[mode](line.text, line.x, line.y);
    return;
  }
  let x = line.x;
  for (const g of graphemes(line.text)) {
    c[mode](g, x, line.y);
    x += c.measureText(g).width + ls;
  }
}

/**
 * Draw the laid-out text with the native context (the Konva shape's transform, opacity and shadow are already applied).
 * The stroke goes behind the fill; only the first pass casts the shadow so the fill doesn't shade its own outline.
 */
export function drawText(c: CanvasRenderingContext2D, l: TextLayer, lay: TextLayout, w: number, h: number) {
  c.font = fontString(l, lay.fontSize);
  setSpacing(c, lay.letterSpacing);
  c.textBaseline = "alphabetic";
  c.textAlign = "left";
  const fillVisible = !isTransparent(l.fill);
  const stroke = l.stroke && lay.strokeWidth > 0 && !isTransparent(l.stroke.color) ? l.stroke : null;
  if (stroke) {
    c.lineJoin = "round";
    c.miterLimit = 2;
    c.strokeStyle = stroke.color;
    c.lineWidth = fillVisible ? lay.strokeWidth * 2 : lay.strokeWidth;
    for (const line of lay.lines) if (line.text) drawLine(c, "strokeText", line, lay.letterSpacing);
    c.shadowColor = "rgba(0,0,0,0)";
  }
  if (fillVisible) {
    c.fillStyle = canvasPaint(c, l.fill, w, h);
    for (const line of lay.lines) if (line.text) drawLine(c, "fillText", line, lay.letterSpacing);
  }
}
