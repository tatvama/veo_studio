/**
 * Title clips drawn with Canvas2D (the browser shapes Indic scripts with HarfBuzz): wrapped text in its box with
 * outline, shadow and a background, animated in and out. Used by the engine (as a custom source) and the Text panel.
 *
 * Wave 3 (editor-looks) adds, all optional on the TitleSpec:
 * - `look`: template animations (fade, rise, pop, typewriter, blur, wipe, glitch, bounce …) per title, letter, word or
 *   line, loops (pulse, float, flicker, ticker …), decorations (bars, boxes, brackets, tickers, lower-third plates), a
 *   gradient fill, glow, tracking, a sub line and counters (countdowns);
 * - `karaoke`: word-by-word highlight timed to the clip ("word", "fill" or "bounce");
 * - `shape`: stickers and shapes (rect, ellipse, line, arrow, callout, star, heart, burst, emoji, subscribe, like, bell).
 * A title without them draws exactly as before. Pure apart from the canvas it's handed (no DOM at import).
 */
import type { KaraokeSpec, ShapeSpec, TitleLook, TitleSpec } from "../model/types";

type G = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const ANIM_S = 0.5;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
const easeBack = (x: number) => { const c = 1.70158, t = clamp01(x) - 1; return 1 + (c + 1) * t * t * t + c * t * t; };
const easeBounce = (x: number) => {
  let t = clamp01(x);
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) { t -= 1.5 / d; return n * t * t + 0.75; }
  if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + 0.9375; }
  t -= 2.625 / d; return n * t * t + 0.984375;
};
const easeElastic = (x: number) => { const t = clamp01(x); return t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1; };
/** A repeatable 0..1 noise for frame-stepped effects (flicker, glitch). */
const hash = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

function wrap(g: G, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const next = line + w;
      if (line && g.measureText(next.trimEnd()).width > maxW && w.trim()) { out.push(line.trimEnd()); line = w.trimStart(); }
      else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

const fontOf = (s: { font: string; weight: number; size: number }, scale: number, italic = false) =>
  `${italic ? "italic " : ""}${s.weight} ${Math.max(1, Math.round(s.size * scale))}px "${s.font}", "Inter Variable", "Anek Devanagari Variable", "Anek Kannada Variable", "Anek Telugu Variable", "Anek Tamil Variable", system-ui, sans-serif`;
const font = (s: TitleSpec, scale: number) => `${s.weight} ${Math.max(1, Math.round(s.size * scale))}px "${s.font}", "Inter Variable", system-ui, sans-serif`;

/** The text a title shows (karaoke: its words; counters: "#" replaced) — for font loading and names. */
export function titleText(s: TitleSpec): string {
  if (s.karaoke?.words.length) return s.karaoke.words.map((w) => w.text).join(" ");
  return s.text;
}

/** Starts loading the title's fonts for its text (the canvas falls back until they're there). */
export function ensureFont(s: TitleSpec): Promise<unknown> {
  try {
    const sample = (titleText(s) || "Aa").slice(0, 60);
    const jobs: Promise<unknown>[] = [document.fonts.load(font(s, 1), sample)];
    if (s.look?.sub) jobs.push(document.fonts.load(fontOf({ font: s.look.sub.font ?? s.font, weight: s.look.sub.weight ?? 500, size: s.look.sub.size }, 1), s.look.sub.text.slice(0, 40) || "Aa"));
    return Promise.all(jobs);
  } catch { return Promise.resolve(); }
}

// ── animations ───────────────────────────────────────────────────────────────

export const TITLE_ANIMS: { id: string; label: string }[] = [
  { id: "none", label: "None" }, { id: "fade", label: "Fade" }, { id: "rise", label: "Rise" }, { id: "drop", label: "Drop" },
  { id: "slide_left", label: "Slide from left" }, { id: "slide_right", label: "Slide from right" }, { id: "pop", label: "Pop" },
  { id: "zoom", label: "Zoom" }, { id: "blur", label: "Blur in" }, { id: "typewriter", label: "Typewriter" }, { id: "wipe", label: "Wipe" },
  { id: "tracking", label: "Tracking in" }, { id: "spin", label: "Spin" }, { id: "bounce", label: "Bounce" }, { id: "flip", label: "Flip" },
  { id: "glitch", label: "Glitch" }, { id: "elastic", label: "Elastic" },
];
export const TITLE_LOOPS: { id: string; label: string }[] = [
  { id: "none", label: "None" }, { id: "pulse", label: "Pulse" }, { id: "float", label: "Float" }, { id: "flicker", label: "Neon flicker" },
  { id: "shake", label: "Shake" }, { id: "wiggle", label: "Wiggle" }, { id: "glow", label: "Glow pulse" }, { id: "ticker", label: "Ticker scroll" },
  { id: "spin", label: "Spin" },
];

interface Pose { a: number; dx: number; dy: number; s: number; sx: number; sy: number; r: number; blur: number; reveal: number; glitch: number }
const REST: Pose = { a: 1, dx: 0, dy: 0, s: 1, sx: 1, sy: 1, r: 0, blur: 0, reveal: 1, glitch: 0 };

/** The pose of an animation at progress p (0 = start of "in", 1 = settled); `unit` = a size in pixels (line height). */
export function animPose(id: string | undefined, p: number, unit: number, seed = 0): Pose {
  const q = clamp01(p);
  if (!id || id === "none" || q >= 1) return REST;
  const e = easeOut(q);
  switch (id) {
    case "fade": return { ...REST, a: e };
    case "rise": return { ...REST, a: e, dy: (1 - e) * unit * 0.9 };
    case "drop": return { ...REST, a: e, dy: -(1 - e) * unit * 0.9 };
    case "slide_left": return { ...REST, a: e, dx: -(1 - e) * unit * 3 };
    case "slide_right": return { ...REST, a: e, dx: (1 - e) * unit * 3 };
    case "pop": return { ...REST, a: clamp01(q * 3), s: 0.6 + 0.4 * easeBack(q) };
    case "zoom": return { ...REST, a: e, s: 1.6 - 0.6 * e };
    case "blur": return { ...REST, a: e, blur: (1 - e) * unit * 0.35 };
    case "typewriter": return { ...REST, a: q > 0 ? 1 : 0 };
    case "wipe": return { ...REST, reveal: e };
    case "tracking": return { ...REST, a: e, sx: 0.75 + 0.25 * e };
    case "spin": return { ...REST, a: e, r: (1 - e) * -Math.PI / 2, s: 0.7 + 0.3 * e };
    case "bounce": return { ...REST, a: clamp01(q * 4), dy: -(1 - easeBounce(q)) * unit * 1.6 };
    case "flip": return { ...REST, a: clamp01(q * 2), sy: Math.max(0.01, e) };
    case "glitch": return { ...REST, a: q < 0.15 ? hash(seed + Math.floor(q * 40)) : 1, dx: (hash(seed * 7 + Math.floor(q * 30)) - 0.5) * unit * (1 - q) * 0.8, glitch: 1 - q };
    case "elastic": return { ...REST, a: clamp01(q * 3), s: Math.max(0.01, easeElastic(q)) };
    default: return { ...REST, a: e };
  }
}

/** The legacy animIn / animOut as template animation ids. */
const LEGACY_IN: Record<string, string> = { fade: "fade", slide_up: "rise", typewriter: "typewriter", pop: "pop" };
const LEGACY_OUT: Record<string, string> = { fade: "fade", slide_down: "rise" };

const isPlain = (s: TitleSpec) => !s.look && !s.karaoke?.words.length && !s.shape;
/** Text outside Latin (Indic and other complex scripts): animated per word, never per letter (letters join). */
const complexScript = (text: string) => /[ऀ-෿฀-໿က-႟؀-ۿ]/.test(text);

interface Timing { inId: string; outId: string; inDur: number; outDur: number; spread: number }
function timing(s: TitleSpec, dur: number): Timing {
  const L: TitleLook = s.look ?? {};
  const inId = L.in ?? LEGACY_IN[s.animIn ?? "none"] ?? "none";
  const outId = L.out ?? LEGACY_OUT[s.animOut ?? "none"] ?? "none";
  const anim = Math.min(ANIM_S, dur / 3);
  const typeT = Math.max(anim, Math.min(dur * 0.4, 0.04 * titleText(s).length));
  const inDur = inId === "none" ? 0 : Math.min(dur * 0.45, L.inDur ?? (inId === "typewriter" ? typeT : anim));
  const outDur = outId === "none" ? 0 : Math.min(dur * 0.3, L.outDur ?? anim);
  const stag = L.stagger ?? (inId === "typewriter" ? "char" : "none");
  const spread = stag === "none" ? 0 : inId === "typewriter" ? inDur : inDur * 0.55;
  return { inId, outId, inDur, outDur, spread };
}

// ── karaoke ──────────────────────────────────────────────────────────────────

/**
 * Where a karaoke caption is at `t` seconds into its clip: the word being sung (index; -1 before the first, n after
 * the last) and how far through it (0..1). Between two words the last one sung stays current until the next starts.
 */
export function karaokeAt(k: KaraokeSpec, t: number): { index: number; progress: number } {
  const w = k.words;
  if (!w.length || t < w[0].start) return { index: -1, progress: 0 };
  for (let i = w.length - 1; i >= 0; i--) {
    if (t >= w[i].start) {
      if (i === w.length - 1 && t >= w[i].end) return { index: w.length, progress: 1 };
      const span = Math.max(1e-3, w[i].end - w[i].start);
      return { index: i, progress: clamp01((t - w[i].start) / span) };
    }
  }
  return { index: -1, progress: 0 };
}

/** The colour and lift of word i at `t` (the renderer's rule, here so tests can check it). */
export function karaokeWordStyle(k: KaraokeSpec, i: number, t: number): { color: string; fill: number; lift: number; scale: number } {
  const { index, progress } = karaokeAt(k, t);
  const cur = i === index, past = i < index;
  switch (k.mode) {
    case "fill": return { color: past ? k.highlightColor : k.color, fill: past ? 1 : cur ? progress : 0, lift: 0, scale: 1 };
    case "bounce": return { color: cur ? k.highlightColor : k.color, fill: cur ? 1 : 0, lift: cur ? Math.sin(Math.PI * Math.min(1, progress * 2)) : 0, scale: cur ? 1.06 : 1 };
    default: return { color: cur ? k.highlightColor : k.color, fill: cur ? 1 : 0, lift: 0, scale: cur ? 1.08 : 1 };
  }
}

/** The number a counter shows at `t` (counts down with ceil, up with floor, so each number holds its share). */
export function countAt(c: { from: number; to: number }, t: number, dur: number): number {
  const k = clamp01(t / Math.max(1e-3, dur));
  const v = c.from + (c.to - c.from) * k;
  return c.to < c.from ? Math.max(c.to, Math.ceil(v - 1e-9)) : Math.min(c.to, Math.floor(v + 1e-9));
}

/**
 * A key that changes exactly when the picture changes (a caller redraws a cached raster only then): "static" while a
 * title rests between its in and out animations.
 */
export function titleFrameKey(s0: TitleSpec, t: number, dur: number): string {
  const s = visibleWords(s0, dur) ?? s0;
  if (isPlain(s)) {
    const anim = s.animIn === "typewriter" ? dur : 0.5;
    return t < anim || t > dur - 0.5 ? `t${t}` : "static";
  }
  const tm = timing(s, dur);
  const L = s.look ?? {};
  if (L.loop && L.loop !== "none") return `t${t}`;
  if (t < tm.inDur + 1e-6 || t > dur - tm.outDur - 1e-6) return `t${t}`;
  const parts: string[] = [];
  if (s.karaoke?.words.length) {
    const k = karaokeAt(s.karaoke, t);
    parts.push(`k${k.index}`);
    if (s.karaoke.mode !== "word" && k.index >= 0 && k.index < s.karaoke.words.length) parts.push(k.progress.toFixed(s.karaoke.mode === "fill" ? 2 : 3));
  }
  if (L.count) parts.push(`n${countAt(L.count, t, dur)}`);
  if (L.decor?.kind === "ring" && L.count) parts.push(`r${(t / dur).toFixed(3)}`);
  return parts.length ? parts.join(":") : "static";
}

/** True when the title needs the extended renderer (template look, karaoke or a shape). */
export const isExtendedTitle = (s: TitleSpec) => !isPlain(s);

// ── drawing ──────────────────────────────────────────────────────────────────

/** What the current drawTitle touched (x0, y0, x1, y1 in canvas pixels), for the uploaded part (CustomSource.bounds). */
let marks: [number, number, number, number] | null = null;
function mark(x: number, y: number, w: number, h: number) {
  if (!(w > 0 && h > 0) || !Number.isFinite(x + y + w + h)) return;
  marks = marks ? [Math.min(marks[0], x), Math.min(marks[1], y), Math.max(marks[2], x + w), Math.max(marks[3], y + h)] : [x, y, x + w, y + h];
}

/** True while the title moves as a whole (in / out animations, moving loops): its picture can be anywhere. */
function moving(s: TitleSpec, t: number, dur: number): boolean {
  if (isPlain(s)) {
    const anim = s.animIn === "typewriter" ? dur : 0.5;
    return (!!s.animIn && s.animIn !== "none" && t < anim) || (!!s.animOut && s.animOut !== "none" && t > dur - 0.5);
  }
  const tm = timing(s, dur);
  const loop = s.look?.loop ?? "none";
  if (!["none", "ticker", "flicker", "glow"].includes(loop)) return true;
  return (tm.inId !== "none" && t < tm.inDur + 1e-6) || (tm.outId !== "none" && t > dur - tm.outDur - 1e-6);
}

/** Room around what was drawn for the outline, the shadow and the glow. */
function margin(s: TitleSpec, scale: number): number {
  let m = 4;
  if (s.outline) m += s.outline.width * 2 * scale;
  if (s.shadow) m += s.shadow.blur * scale * 1.5 + Math.max(Math.abs(s.shadow.x), Math.abs(s.shadow.y)) * scale;
  if (s.look?.glow) m += s.look.glow.blur * scale * 2.2;
  if (s.shape?.strokeWidth) m += s.shape.strokeWidth * scale;
  return Math.ceil(m);
}

/**
 * Draws the title onto a W×H canvas at `t` seconds into a clip `dur` seconds long (transparent outside the text).
 * `scale` = canvas height / sequence height, for previews drawn smaller than the sequence.
 */
/**
 * A karaoke caption shows only the words inside its clip. Trims keep the words they push out (trimming back restores
 * them, docs: model/captions.ts), so they're hidden here. Null when every word is outside.
 */
export function visibleWords(s: TitleSpec, dur: number): TitleSpec | null {
  const k = s.karaoke;
  if (!k?.words.length) return s;
  const words = k.words.filter((w) => w.end > 0 && w.start < dur);
  if (words.length === k.words.length) return s;
  return words.length ? { ...s, karaoke: { ...k, words } } : null;
}

/**
 * Draws the title; returns the part of the canvas it drew into ([x, y, w, h] with a margin for outline, shadow and
 * glow; the whole canvas while the title moves; null when nothing shows) — a CustomSource's `bounds`.
 */
export function drawTitle(g: G, s0: TitleSpec, W: number, H: number, t: number, dur: number, scale = 1): [number, number, number, number] | null {
  marks = null;
  const s = visibleWords(s0, dur);
  if (!s) { g.clearRect(0, 0, W, H); return null; }
  if (isPlain(s)) drawPlain(g, s, W, H, t, dur, scale);
  else { g.clearRect(0, 0, W, H); drawExtended(g, s, W, H, t, dur, scale); }
  const got = marks as [number, number, number, number] | null;
  marks = null;
  if (!got) return null;
  if (moving(s, t, dur)) return [0, 0, W, H];
  const m = margin(s, scale);
  const x0 = Math.max(0, Math.floor(got[0] - m)), y0 = Math.max(0, Math.floor(got[1] - m));
  const x1 = Math.min(W, Math.ceil(got[2] + m)), y1 = Math.min(H, Math.ceil(got[3] + m));
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

/** The original title renderer (unchanged). */
function drawPlain(g: G, s: TitleSpec, W: number, H: number, t: number, dur: number, scale: number) {
  g.clearRect(0, 0, W, H);
  const anim = Math.min(ANIM_S, dur / 3);
  const inP = s.animIn && s.animIn !== "none" && anim > 0 ? Math.min(1, t / (s.animIn === "typewriter" ? Math.max(anim, Math.min(dur * 0.4, 0.04 * s.text.length)) : anim)) : 1;
  const outP = s.animOut && s.animOut !== "none" && anim > 0 ? Math.min(1, Math.max(0, (dur - t) / anim)) : 1;
  let alpha = 1, dy = 0, k = 1, text = s.text;
  if (s.animIn === "fade") alpha *= easeOut(inP);
  if (s.animIn === "slide_up") { alpha *= easeOut(inP); dy += (1 - easeOut(inP)) * H * 0.06; }
  if (s.animIn === "pop") { alpha *= Math.min(1, inP * 3); k = 0.6 + 0.4 * easeBack(inP); }
  if (s.animIn === "typewriter") text = s.text.slice(0, Math.round(s.text.length * inP));
  if (s.animOut === "fade") alpha *= easeOut(outP);
  if (s.animOut === "slide_down") { alpha *= easeOut(outP); dy += (1 - easeOut(outP)) * H * 0.06; }
  if (alpha <= 0.001) return;
  const [bx, by, bw, bh] = s.box;
  const box = { x: bx * W, y: by * H, w: Math.max(1, bw * W), h: Math.max(1, bh * H) };
  g.save();
  g.globalAlpha = alpha;
  g.font = font(s, scale);
  g.textBaseline = "alphabetic";
  const lines = wrap(g, text, box.w);
  const size = s.size * scale;
  const lh = size * 1.18;
  const widths = lines.map((l) => g.measureText(l).width);
  const blockH = lines.length * lh;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2 + dy;
  g.translate(cx, cy); g.scale(k, k); g.translate(-cx, -cy);
  const top = cy - blockH / 2;
  const xOf = (w: number) => (s.align === "left" ? box.x : s.align === "right" ? box.x + box.w - w : box.x + (box.w - w) / 2);
  if (s.background) {
    const pad = s.background.padding * scale;
    const maxW = Math.max(0, ...widths);
    const x0 = s.align === "left" ? box.x : s.align === "right" ? box.x + box.w - maxW : box.x + (box.w - maxW) / 2;
    g.fillStyle = s.background.color;
    g.beginPath();
    const r = s.background.radius * scale;
    const rx = x0 - pad, ry = top - pad, rw = maxW + pad * 2, rh = blockH + pad * 2;
    if (typeof g.roundRect === "function") g.roundRect(rx, ry, rw, rh, r); else g.rect(rx, ry, rw, rh);
    g.fill();
    mark(rx, ry, rw, rh);
  }
  lines.forEach((line, i) => {
    const x = xOf(widths[i]);
    const y = top + i * lh + size * 0.92;
    mark(x, top + i * lh, widths[i], lh + size * 0.2);
    if (s.outline && s.outline.width > 0) {
      g.lineJoin = "round";
      g.lineWidth = s.outline.width * 2 * scale;
      g.strokeStyle = s.outline.color;
      g.strokeText(line, x, y);
    }
    if (s.shadow) {
      g.shadowColor = s.shadow.color; g.shadowBlur = s.shadow.blur * scale;
      g.shadowOffsetX = s.shadow.x * scale; g.shadowOffsetY = s.shadow.y * scale;
    }
    g.fillStyle = s.color;
    g.fillText(line, x, y);
    g.shadowColor = "transparent";
  });
  g.restore();
}

interface Unit { text: string; x: number; y: number; w: number; line: number; word: number }

const setTracking = (g: G, px: number) => { const x = g as unknown as { letterSpacing?: string }; if ("letterSpacing" in x) x.letterSpacing = `${px}px`; };

function roundRect(g: G, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  if (typeof g.roundRect === "function") g.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2))); else g.rect(x, y, w, h);
}

/** Lays out units (words or letters) on wrapped lines inside the box. */
function layout(g: G, text: string, box: { x: number; y: number; w: number; h: number }, align: TitleSpec["align"], lh: number, per: "char" | "word" | "line" | "none", dyBlock: number) {
  const lines = wrap(g, text, box.w);
  const widths = lines.map((l) => g.measureText(l).width);
  const blockH = lines.length * lh;
  const top = box.y + box.h / 2 - blockH / 2 + dyBlock;
  const units: Unit[] = [];
  let wordIx = 0;
  lines.forEach((line, li) => {
    const x0 = align === "left" ? box.x : align === "right" ? box.x + box.w - widths[li] : box.x + (box.w - widths[li]) / 2;
    const y = top + li * lh + lh / 2;
    if (per === "none" || per === "line") { units.push({ text: line, x: x0, y, w: widths[li], line: li, word: wordIx }); wordIx += line.split(/\s+/).filter(Boolean).length; return; }
    const parts = per === "word" ? line.split(/(\s+)/) : [...line];
    let acc = "";
    for (const p of parts) {
      const before = g.measureText(acc).width;
      acc += p;
      if (!p.trim()) continue;
      const w = g.measureText(p).width;
      units.push({ text: p, x: x0 + before, y, w, line: li, word: wordIx });
      if (per === "word") wordIx++;
    }
    if (per === "char") wordIx += line.split(/\s+/).filter(Boolean).length;
  });
  const maxW = Math.max(1, ...widths);
  const bx0 = align === "left" ? box.x : align === "right" ? box.x + box.w - maxW : box.x + (box.w - maxW) / 2;
  return { units, lines, bounds: { x: bx0, y: top, w: maxW, h: blockH } };
}

function drawExtended(g: G, s: TitleSpec, W: number, H: number, t: number, dur: number, scale: number) {
  const L: TitleLook = s.look ?? {};
  const tm = timing(s, dur);
  const outP = tm.outDur > 0 ? clamp01((dur - t) / tm.outDur) : 1;
  const size = Math.max(1, s.size * scale);
  const lh = size * 1.2;
  const [bxf, byf, bwf, bhf] = s.box;
  const box = { x: bxf * W, y: byf * H, w: Math.max(1, bwf * W), h: Math.max(1, bhf * H) };
  const outPose = animPose(tm.outId, outP, lh, 99);
  if (outPose.a <= 0.001) return;
  // loops
  const loop = L.loop ?? "none";
  let loopA = 1, loopDx = 0, loopDy = 0, loopS = 1, loopR = 0, glowK = 1;
  if (loop === "pulse") loopS = 1 + 0.035 * Math.sin(t * Math.PI * 2);
  else if (loop === "float") loopDy = Math.sin((t * Math.PI * 2) / 3) * H * 0.01;
  else if (loop === "flicker") { const f = Math.floor(t * 14); loopA = hash(f) < 0.12 ? 0.35 : hash(f + 3) < 0.08 ? 0.7 : 1; }
  else if (loop === "shake") { const f = Math.floor(t * 24); loopDx = (hash(f) - 0.5) * size * 0.06; loopDy = (hash(f + 9) - 0.5) * size * 0.06; }
  else if (loop === "wiggle") loopR = Math.sin(t * Math.PI * 2 * 1.5) * 0.05;
  else if (loop === "glow") glowK = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2));
  else if (loop === "spin") loopR = t * Math.PI;

  g.save();
  g.globalAlpha = outPose.a * loopA;
  // the whole title moves with the out pose and the loop, about the box centre
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  g.translate(cx + outPose.dx + loopDx, cy + outPose.dy + loopDy);
  g.rotate(outPose.r + loopR);
  g.scale(outPose.s * loopS * outPose.sx, outPose.s * loopS * outPose.sy);
  g.translate(-cx, -cy);
  if (outPose.blur > 0.3) g.filter = `blur(${outPose.blur.toFixed(1)}px)`;
  if (outPose.reveal < 1) { g.beginPath(); g.rect(box.x - W, box.y - H, (box.w + W) * outPose.reveal + W, box.h + 2 * H); g.clip(); }

  const blockIn = tm.spread > 0 ? REST : animPose(tm.inId, tm.inDur > 0 ? t / tm.inDur : 1, lh, 1);
  if (s.shape) drawShape(g, s, s.shape, box, t, dur, scale, tm, lh);
  const text = L.count ? s.text.replace("#", String(countAt(L.count, t, dur))) : titleText(s);
  const labelled = s.shape && (s.shape.kind === "subscribe" || s.shape.kind === "like");
  if (text.trim() && !labelled) drawText(g, s, L, text, box, W, H, t, dur, scale, size, lh, tm, blockIn, glowK);
  g.restore();
}

function fillFor(g: G, s: TitleSpec, L: TitleLook, color: string, y: number, size: number): string | CanvasGradient {
  if (!L.gradient) return color;
  const gr = g.createLinearGradient(0, y - size / 2, 0, y + size / 2);
  gr.addColorStop(0, L.gradient[0]); gr.addColorStop(1, L.gradient[1]);
  void s;
  return gr;
}

function drawText(g: G, s: TitleSpec, L: TitleLook, text: string, box: { x: number; y: number; w: number; h: number }, W: number, H: number, t: number, dur: number,
  scale: number, size: number, lh: number, tm: Timing, blockIn: Pose, glowK: number) {
  const k = s.karaoke?.words.length ? s.karaoke : null;
  const shown = L.upper ? text.toUpperCase() : text;
  g.font = fontOf(s, scale, L.italic);
  g.textBaseline = "middle";
  g.textAlign = "left";
  setTracking(g, (L.tracking ?? 0) * size);
  let per: "char" | "word" | "line" | "none" = k ? "word" : L.stagger ?? (tm.inId === "typewriter" ? "char" : "none");
  if (per === "char" && complexScript(shown)) per = "word";
  const ticker = L.decor?.kind === "ticker" || L.loop === "ticker";
  const subH = L.sub ? L.sub.size * scale * 1.3 : 0;
  const dyBlock = L.sub ? -subH / 2 : 0;
  const lay = ticker ? null : layout(g, shown, box, s.align, lh, per, dyBlock);

  // decoration behind the text: as wide as the text or its sub line, whichever is wider
  let b = lay ? lay.bounds : { x: 0, y: box.y + box.h / 2 - lh / 2, w: W, h: lh };
  if (lay && L.sub?.text) {
    g.save();
    g.font = fontOf({ font: L.sub.font ?? s.font, weight: L.sub.weight ?? 500, size: L.sub.size }, scale);
    setTracking(g, 0);
    const sw = g.measureText(L.sub.text).width;
    g.restore();
    if (sw > b.w) b = { ...b, w: sw, x: s.align === "left" ? b.x : s.align === "right" ? b.x + b.w - sw : b.x + (b.w - sw) / 2 };
  }
  const pin = tm.inDur > 0 ? clamp01(t / tm.inDur) : 1;
  const totalH = b.h + subH;
  if (L.decor) {
    drawDecor(g, s, L, b, totalH, size, scale, W, box, pin, t, dur);
    const k = L.decor.kind;
    if (k === "ticker") mark(0, box.y, W, box.h);
    else {
      const ext = k === "lines" ? size * 3.6 : k === "ring" ? Math.max(b.w, b.h) * 0.8 : size * 0.6;
      const vext = k === "ring" ? Math.max(b.w, b.h) * 0.8 : size * 0.5;
      mark(b.x - ext, b.y - vext, b.w + ext * 2, totalH + vext * 2);
    }
  }
  if (s.background && !ticker) {
    const pad = s.background.padding * scale;
    g.save();
    g.globalAlpha *= blockIn.a;
    g.fillStyle = s.background.color;
    roundRect(g, b.x - pad, b.y - pad, b.w + pad * 2, totalH + pad * 2, s.background.radius * scale);
    g.fill();
    g.restore();
    mark(b.x - pad, b.y - pad, b.w + pad * 2, totalH + pad * 2);
  }

  const glow = L.glow;
  const drawUnit = (u: { text: string; w: number }, color: string | CanvasGradient, x: number, y: number) => {
    if (s.outline && s.outline.width > 0) {
      g.lineJoin = "round"; g.lineWidth = s.outline.width * 2 * scale; g.strokeStyle = s.outline.color;
      g.strokeText(u.text, x, y);
    }
    if (glow) { g.shadowColor = glow.color; g.shadowBlur = glow.blur * scale * glowK; g.shadowOffsetX = 0; g.shadowOffsetY = 0; g.fillStyle = color; g.fillText(u.text, x, y); }
    if (s.shadow) { g.shadowColor = s.shadow.color; g.shadowBlur = s.shadow.blur * scale; g.shadowOffsetX = s.shadow.x * scale; g.shadowOffsetY = s.shadow.y * scale; }
    else if (!glow) g.shadowColor = "transparent";
    g.fillStyle = color;
    g.fillText(u.text, x, y);
    g.shadowColor = "transparent";
  };

  if (ticker || !lay) {
    // one line scrolling right to left through the band, clipped to it
    const w = g.measureText(shown).width;
    const speed = Math.max(W * 0.12, (W + w) / Math.max(1, dur));
    const x = W - ((t * speed) % (W + w + size));
    const y = box.y + box.h / 2;
    g.save();
    g.beginPath(); g.rect(0, box.y, W, box.h); g.clip();
    mark(0, box.y, W, box.h);
    drawUnit({ text: shown, w }, fillFor(g, s, L, s.color, y, size), x, y);
    g.restore();
    return;
  }

  // layout word → karaoke word (a karaoke "word" may hold a space)
  const kmap: number[] = [];
  if (k) k.words.forEach((w, i) => { for (const part of w.text.split(/\s+/)) if (part) kmap.push(i); });
  const n = lay.units.length;
  lay.units.forEach((u, i) => {
    let p = 1;
    if (tm.inDur > 0) {
      if (tm.spread > 0) {
        const delay = n > 1 ? (i / (n - 1)) * tm.spread : 0;
        const unitDur = tm.inId === "typewriter" ? 1e-3 : Math.max(1e-3, tm.inDur - tm.spread);
        p = tm.inId === "typewriter" ? (t >= delay ? 1 : 0) : clamp01((t - delay) / unitDur);
      } else p = clamp01(t / tm.inDur);
    }
    const pose = tm.spread > 0 ? animPose(tm.inId, p, lh, i + 1) : blockIn;
    if (pose.a <= 0.001) return;
    let color: string | CanvasGradient = fillFor(g, s, L, s.color, 0, size);
    let lift = 0, ks = 1, fill = 0, hi = "";
    if (k) {
      const st = karaokeWordStyle(k, kmap[u.word] ?? u.word, t);
      color = st.color; lift = st.lift * size * 0.22; ks = st.scale; fill = st.fill; hi = k.highlightColor;
    }
    const ux = u.x + u.w / 2, uy = u.y;
    mark(ux - (u.w / 2) * ks - size * 0.1, uy - lift - (lh / 2) * ks, u.w * ks + size * 0.2, lh * ks);
    g.save();
    g.globalAlpha *= pose.a;
    g.translate(ux + pose.dx, uy + pose.dy - lift);
    g.rotate(pose.r);
    g.scale(pose.s * pose.sx * ks, pose.s * pose.sy * ks);
    if (pose.blur > 0.3) g.filter = `blur(${pose.blur.toFixed(1)}px)`;
    if (pose.reveal < 1) { g.beginPath(); g.rect(-u.w / 2 - size, -lh, (u.w + size) * pose.reveal, lh * 2); g.clip(); }
    if (pose.glitch > 0.02) {
      g.save(); g.globalAlpha *= 0.55 * pose.glitch;
      g.fillStyle = "#ff2bd6"; g.fillText(u.text, -u.w / 2 - size * 0.04, 0);
      g.fillStyle = "#22e1ff"; g.fillText(u.text, -u.w / 2 + size * 0.04, 0);
      g.restore();
    }
    if (k && k.mode === "fill" && fill > 0 && fill < 1) {
      drawUnit(u, k.color, -u.w / 2, 0);
      g.save(); g.beginPath(); g.rect(-u.w / 2, -lh, u.w * fill, lh * 2); g.clip();
      g.shadowColor = "transparent";
      g.fillStyle = hi; g.fillText(u.text, -u.w / 2, 0);
      g.restore();
    } else drawUnit(u, color, -u.w / 2, 0);
    g.restore();
  });

  // the sub line (lower thirds), coming in just after the text
  if (L.sub && L.sub.text) {
    const sub = L.sub;
    const ss = sub.size * scale;
    g.font = fontOf({ font: sub.font ?? s.font, weight: sub.weight ?? 500, size: sub.size }, scale);
    setTracking(g, 0);
    const sw = g.measureText(sub.text).width;
    const sx = s.align === "left" ? b.x : s.align === "right" ? b.x + b.w - sw : b.x + (b.w - sw) / 2;
    const sy = b.y + b.h + subH / 2;
    const delay = Math.min(0.15, dur * 0.05);
    const sp = tm.inDur > 0 ? animPose(tm.inId === "typewriter" ? "fade" : tm.inId, clamp01((t - delay) / Math.max(1e-3, tm.inDur)), ss * 1.2, 77) : REST;
    g.save();
    g.globalAlpha *= sp.a;
    g.translate(sp.dx, sp.dy);
    if (sp.reveal < 1) { g.beginPath(); g.rect(sx, sy - ss, sw * sp.reveal, ss * 2); g.clip(); }
    g.fillStyle = sub.color;
    g.shadowColor = s.shadow ? s.shadow.color : "transparent"; g.shadowBlur = s.shadow ? s.shadow.blur * scale * 0.6 : 0;
    g.fillText(sub.text, sx, sy);
    mark(sx, sy - ss * 0.75, sw, ss * 1.5);
    g.restore();
  }
}

function drawDecor(g: G, s: TitleSpec, L: TitleLook, b: { x: number; y: number; w: number; h: number }, totalH: number, size: number, scale: number, W: number,
  box: { x: number; y: number; w: number; h: number }, pin: number, t: number, dur: number) {
  const d = L.decor!;
  const e = easeOut(pin);
  const pad = size * 0.35;
  g.save();
  g.shadowColor = "transparent";
  g.fillStyle = d.color; g.strokeStyle = d.color;
  const thick = Math.max(2, (d.size ?? 0.12) * size);
  switch (d.kind) {
    case "bar": {
      const x = s.align === "right" ? b.x + b.w + pad * 0.6 : b.x - pad * 0.6 - thick;
      g.fillRect(x, b.y + (totalH * (1 - e)) / 2, thick, totalH * e);
      break;
    }
    case "underline": {
      const w = b.w * e;
      const x = s.align === "left" ? b.x : s.align === "right" ? b.x + b.w - w : b.x + (b.w - w) / 2;
      g.fillRect(x, b.y + b.h + thick * 0.4, w, thick * 0.6);
      break;
    }
    case "box": case "pill": case "glass": case "slash": {
      const x = b.x - pad, y = b.y - pad * 0.6, w = (b.w + pad * 2) * (d.kind === "slash" ? 1 : e), h = totalH + pad * 1.2;
      if (d.kind === "slash") {
        const sk = h * 0.3, ww = (b.w + pad * 2) * e;
        g.beginPath(); g.moveTo(x + sk, y); g.lineTo(x + ww + sk, y); g.lineTo(x + ww - sk, y + h); g.lineTo(x - sk, y + h); g.closePath(); g.fill();
      } else {
        roundRect(g, x, y, w, h, d.kind === "pill" ? h / 2 : d.kind === "glass" ? size * 0.3 : size * 0.08);
        g.fill();
        if (d.kind === "glass") { g.lineWidth = Math.max(1, scale * 2); g.strokeStyle = d.color2 ?? "#ffffff55"; g.stroke(); }
      }
      break;
    }
    case "split": {
      // a two-tone lower-third plate: the name on colour, the sub line on colour2
      const x = b.x - pad, w = (b.w + pad * 2) * e;
      g.fillRect(x, b.y - pad * 0.5, w, b.h + pad);
      if (L.sub) { g.fillStyle = d.color2 ?? "#111827"; g.fillRect(x, b.y + b.h + pad * 0.5, w * Math.max(0, Math.min(1, e * 1.1)), totalH - b.h); }
      break;
    }
    case "bracket": {
      const x0 = b.x - pad, y0 = b.y - pad * 0.6, x1 = b.x + b.w + pad, y1 = b.y + totalH + pad * 0.6, a = size * 0.45 * e;
      g.lineWidth = thick * 0.45;
      g.beginPath();
      g.moveTo(x0, y0 + a); g.lineTo(x0, y0); g.lineTo(x0 + a, y0);
      g.moveTo(x1 - a, y1); g.lineTo(x1, y1); g.lineTo(x1, y1 - a);
      g.stroke();
      break;
    }
    case "frame": {
      g.lineWidth = thick * 0.4;
      g.globalAlpha *= e;
      g.strokeRect(b.x - pad, b.y - pad * 0.6, b.w + pad * 2, totalH + pad * 1.2);
      break;
    }
    case "ticker": {
      g.fillRect(0, box.y, W, box.h);
      if (d.color2) { g.fillStyle = d.color2; g.fillRect(0, box.y, Math.min(W * 0.18, box.h * 3.2), box.h); }
      break;
    }
    case "ring": {
      const r = Math.max(b.w, b.h) * 0.75;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      g.lineWidth = thick * 0.5;
      g.globalAlpha *= 0.35; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
      g.globalAlpha /= 0.35; g.strokeStyle = d.color2 ?? d.color;
      g.beginPath(); g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - clamp01(t / Math.max(1e-3, dur)))); g.stroke();
      break;
    }
    case "lines": {
      // thin lines either side of the text (chapter titles)
      const y = b.y + b.h / 2, gap = pad * 1.2, len = size * 2.2 * e;
      g.fillRect(b.x - gap - len, y - thick * 0.15, len, thick * 0.3);
      g.fillRect(b.x + b.w + gap, y - thick * 0.15, len, thick * 0.3);
      break;
    }
    default: break;
  }
  g.restore();
}

// ── shapes and stickers ──────────────────────────────────────────────────────

export const SHAPE_KINDS = ["rect", "ellipse", "line", "arrow", "callout", "star", "heart", "burst", "emoji", "subscribe", "like", "bell"] as const;

function starPath(g: G, cx: number, cy: number, r: number, inner: number, points: number) {
  g.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = (i * Math.PI) / points - Math.PI / 2, rr = i % 2 ? inner : r;
    if (i) g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); else g.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  g.closePath();
}

function heartPath(g: G, cx: number, cy: number, w: number, h: number) {
  const top = cy - h * 0.3;
  g.beginPath();
  g.moveTo(cx, cy + h * 0.45);
  g.bezierCurveTo(cx - w * 0.55, cy + h * 0.05, cx - w * 0.5, top - h * 0.25, cx, top);
  g.bezierCurveTo(cx + w * 0.5, top - h * 0.25, cx + w * 0.55, cy + h * 0.05, cx, cy + h * 0.45);
  g.closePath();
}

function bellPath(g: G, cx: number, cy: number, s: number) {
  g.beginPath();
  g.moveTo(cx - s * 0.42, cy + s * 0.28);
  g.quadraticCurveTo(cx - s * 0.32, cy + s * 0.1, cx - s * 0.32, cy - s * 0.08);
  g.quadraticCurveTo(cx - s * 0.3, cy - s * 0.42, cx, cy - s * 0.44);
  g.quadraticCurveTo(cx + s * 0.3, cy - s * 0.42, cx + s * 0.32, cy - s * 0.08);
  g.quadraticCurveTo(cx + s * 0.32, cy + s * 0.1, cx + s * 0.42, cy + s * 0.28);
  g.closePath();
  g.moveTo(cx + s * 0.1, cy + s * 0.36);
  g.arc(cx, cy + s * 0.36, s * 0.1, 0, Math.PI * 2);
}

function thumbPath(g: G, x: number, y: number, s: number) {
  // a thumbs-up: the cuff and the hand
  g.beginPath();
  g.rect(x, y + s * 0.42, s * 0.22, s * 0.52);
  g.moveTo(x + s * 0.3, y + s * 0.94);
  g.lineTo(x + s * 0.3, y + s * 0.44);
  g.lineTo(x + s * 0.52, y + s * 0.06);
  g.quadraticCurveTo(x + s * 0.66, y + s * 0.02, x + s * 0.64, y + s * 0.2);
  g.lineTo(x + s * 0.6, y + s * 0.38);
  g.lineTo(x + s * 0.9, y + s * 0.38);
  g.quadraticCurveTo(x + s * 1.0, y + s * 0.42, x + s * 0.96, y + s * 0.54);
  g.lineTo(x + s * 0.86, y + s * 0.88);
  g.quadraticCurveTo(x + s * 0.83, y + s * 0.94, x + s * 0.74, y + s * 0.94);
  g.closePath();
}

function drawShape(g: G, s: TitleSpec, sh: ShapeSpec, box: { x: number; y: number; w: number; h: number }, t: number, dur: number, scale: number, tm: Timing, lh: number) {
  const pin = tm.inDur > 0 ? clamp01(t / tm.inDur) : 1;
  const pose = animPose(tm.inId, pin, Math.min(box.w, box.h) * 0.5, 5);
  if (pose.a <= 0.001) return;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  g.save();
  g.globalAlpha *= pose.a;
  g.translate(cx + pose.dx, cy + pose.dy);
  g.rotate(pose.r + ((sh.rotation ?? 0) * Math.PI) / 180);
  g.scale(pose.s * pose.sx, pose.s * pose.sy);
  g.translate(-cx, -cy);
  if (pose.reveal < 1) { g.beginPath(); g.rect(box.x, box.y, box.w * pose.reveal, box.h); g.clip(); }
  const fill = sh.fill ?? "#ffffff", stroke = sh.stroke, sw = (sh.strokeWidth ?? 0) * scale;
  const paint = () => {
    if (fill && fill !== "none") { g.fillStyle = fill; g.fill(); }
    if (stroke && sw > 0) { g.lineWidth = sw; g.strokeStyle = stroke; g.lineJoin = "round"; g.stroke(); }
  };
  if (s.shadow) { g.shadowColor = s.shadow.color; g.shadowBlur = s.shadow.blur * scale; g.shadowOffsetX = s.shadow.x * scale; g.shadowOffsetY = s.shadow.y * scale; }
  const m = Math.min(box.w, box.h);
  {
    // a turned shape needs its diagonal; the subscribe / like cursor reaches below the pill
    const d = sh.rotation ? Math.hypot(box.w, box.h) : 0;
    const cursor = sh.kind === "subscribe" || sh.kind === "like" ? box.h * 0.9 : 0;
    if (d) mark(cx - d / 2, cy - d / 2, d, d); else mark(box.x - box.w * 0.03, box.y - box.h * 0.03, box.w * 1.06, box.h * 1.06 + cursor);
  }
  switch (sh.kind) {
    case "rect": roundRect(g, box.x, box.y, box.w, box.h, (sh.radius ?? 0) * scale); paint(); break;
    case "ellipse": g.beginPath(); g.ellipse(cx, cy, box.w / 2, box.h / 2, 0, 0, Math.PI * 2); paint(); break;
    case "line": {
      g.beginPath(); g.moveTo(box.x, cy); g.lineTo(box.x + box.w, cy);
      g.lineWidth = Math.max(1, sw || box.h * 0.2); g.strokeStyle = stroke ?? fill; g.lineCap = "round"; g.stroke();
      break;
    }
    case "arrow": {
      const dir = sh.direction ?? "right";
      g.save();
      g.translate(cx, cy);
      g.rotate(dir === "left" ? Math.PI : dir === "up" ? -Math.PI / 2 : dir === "down" ? Math.PI / 2 : 0);
      const len = dir === "up" || dir === "down" ? box.h : box.w, th = dir === "up" || dir === "down" ? box.w : box.h;
      const head = Math.min(len * 0.4, th * 1.1), shaft = th * 0.34;
      g.beginPath();
      g.moveTo(-len / 2, -shaft / 2); g.lineTo(len / 2 - head, -shaft / 2); g.lineTo(len / 2 - head, -th / 2); g.lineTo(len / 2, 0);
      g.lineTo(len / 2 - head, th / 2); g.lineTo(len / 2 - head, shaft / 2); g.lineTo(-len / 2, shaft / 2); g.closePath();
      paint();
      g.restore();
      break;
    }
    case "callout": {
      const tail = Math.min(box.h * 0.35, box.w * 0.2);
      const bodyH = box.h - tail;
      roundRect(g, box.x, box.y, box.w, bodyH, (sh.radius ?? 24) * scale);
      g.moveTo(box.x + box.w * 0.22, box.y + bodyH - 1);
      g.lineTo(box.x + box.w * 0.16, box.y + box.h);
      g.lineTo(box.x + box.w * 0.36, box.y + bodyH - 1);
      paint();
      break;
    }
    case "star": starPath(g, cx, cy, m / 2, m * 0.2, 5); paint(); break;
    case "burst": starPath(g, cx, cy, m / 2, m * 0.36, 12); paint(); break;
    case "heart": heartPath(g, cx, cy, box.w, box.h); paint(); break;
    case "emoji": {
      g.shadowColor = "transparent";
      g.font = `${Math.round(m * 0.9)}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(sh.emoji ?? "⭐", cx, cy + m * 0.04);
      break;
    }
    case "bell": bellPath(g, cx, cy, m); paint(); break;
    case "subscribe": case "like": {
      // a pill with an icon and a label; the label is the title's text (or SUBSCRIBE / LIKE)
      const h = box.h, r = h / 2;
      const pulse = 1 + 0.04 * Math.sin(Math.max(0, t - tm.inDur) * Math.PI * 2);
      g.translate(cx, cy); g.scale(pulse, pulse); g.translate(-cx, -cy);
      roundRect(g, box.x, box.y, box.w, h, r);
      g.fillStyle = fill; g.fill();
      g.shadowColor = "transparent";
      const icon = h * 0.62, ix = box.x + h * 0.28, iy = box.y + (h - icon) / 2;
      g.fillStyle = sh.stroke ?? "#ffffff";
      if (sh.kind === "like") { thumbPath(g, ix, iy, icon); g.fill(); } else { bellPath(g, ix + icon / 2, iy + icon / 2, icon); g.fill(); }
      const label = (s.text || (sh.kind === "like" ? "LIKE" : "SUBSCRIBE")).toUpperCase();
      g.font = `800 ${Math.round(h * 0.42)}px "${s.font}", "Montserrat Variable", system-ui, sans-serif`;
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(label, (ix + icon + box.x + box.w) / 2 + h * 0.05, cy + h * 0.02);
      // a cursor that clicks once, a beat after it lands
      const click = clamp01((t - tm.inDur - 0.35) / 0.5);
      if (click > 0 && click < 1) {
        const px = box.x + box.w * (0.9 - 0.2 * easeOut(click)), py = box.y + h * (1.3 - 0.5 * easeOut(click));
        g.fillStyle = "#ffffff"; g.strokeStyle = "#000000"; g.lineWidth = Math.max(1, h * 0.03);
        g.beginPath(); g.moveTo(px, py); g.lineTo(px, py + h * 0.5); g.lineTo(px + h * 0.13, py + h * 0.38); g.lineTo(px + h * 0.32, py + h * 0.36); g.closePath(); g.fill(); g.stroke();
      }
      g.restore();
      return;
    }
    default: roundRect(g, box.x, box.y, box.w, box.h, 0); paint();
  }
  g.restore();
  void lh; void dur;
}
