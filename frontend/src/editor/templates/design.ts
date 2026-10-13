/**
 * The title design system (docs/EDITOR.md §15.3, presets-pack): one set of tokens every title template is built from,
 * so a category reads as one family — the same grid, type, palette system and motion — instead of unrelated
 * variations. Restrained broadcast / agency taste: few sizes, generous safe margins, plates with real contrast,
 * short eased moves, and no bounce or elastic on serious styles.
 *
 * - **Type scale**: six sizes at 1080 lines (×1.4–1.5 steps): hero 180, display 120, headline 84, title 56, body 40,
 *   caption 28. Sub lines take a smaller step than their text.
 * - **Grid**: 8 px at 1920×1080, scaled to the frame. Layout boxes sit on it.
 * - **Safe areas** (EBU R95): action safe 3.5 % and title (graphics) safe 5 % of each side. Every template's text box
 *   is inside title safe; ticker *bands* still bleed to the frame edges (the renderer draws them full width).
 * - **Palettes**: ten curated sets of plate, accent, text, sub text and text-on-accent, each pair at WCAG contrast
 *   4.5:1 or more. Text floating over footage gets a soft shadow; plates are 90 % opaque.
 * - **Font pairings**: display + text from the bundled fonts only (pages/posters/fonts.ts, plus Inter), each with the
 *   font that sets Devanagari, Kannada, Telugu and Tamil (the display/text font when it covers the script, else the
 *   renderer's Anek fallback for it).
 * - **Motion**: in 0.35–0.6 s, out 0.25–0.4 s, cubic ease-out (a slight back ease for "pop"), staggered 30–60 ms per
 *   word, line or letter. Bounce, elastic, glitch, spin and pop are *expressive*: never on serious styles.
 * - **Plates and decor**: padding 0.35 em and corner radii from the renderer (box 0.08 em, glass 0.3 em, pill = half
 *   the height); bar / underline / line / bracket / frame / ring thickness as a fixed fraction of the text size.
 * Pure (Node runs the tests on it as written).
 */
import type { ShapeSpec, TitleLook, TitleSpec } from "../model/types.ts";
import type { TemplateCategory, TitleTemplate } from "./titles.ts";

// ── type ─────────────────────────────────────────────────────────────────────

export const TYPE_SCALE = { hero: 180, display: 120, headline: 84, title: 56, body: 40, caption: 28 } as const;
export type TypeStep = keyof typeof TYPE_SCALE;
export const TYPE_SIZES: number[] = Object.values(TYPE_SCALE);
/** The step below (sub lines): hero→body, display→body, headline→body, title→body, body→caption, caption→caption. */
export const SUB_STEP: Record<TypeStep, TypeStep> = { hero: "body", display: "body", headline: "body", title: "body", body: "caption", caption: "caption" };

// ── grid and safe areas ──────────────────────────────────────────────────────

export const GRID_PX = 8;
/** The reference frame the grid and the layouts are drawn on. */
export const REF = { width: 1920, height: 1080 } as const;
/** n grid units in pixels of a frame `height` lines high. */
export const grid = (n: number, height = 1080) => (n * GRID_PX * height) / 1080;
/** EBU R95 margins, as fractions of each side. */
export const ACTION_SAFE = 0.035;
export const TITLE_SAFE = 0.05;
export interface SafeRect { top: number; bottom: number; left: number; right: number }
export const TITLE_SAFE_AREA: SafeRect = { top: TITLE_SAFE, bottom: TITLE_SAFE, left: TITLE_SAFE, right: TITLE_SAFE };
export const ACTION_SAFE_AREA: SafeRect = { top: ACTION_SAFE, bottom: ACTION_SAFE, left: ACTION_SAFE, right: ACTION_SAFE };
export const insideSafe = (box: TitleSpec["box"], s: SafeRect = TITLE_SAFE_AREA) => {
  const [x, y, w, h] = box, e = 1e-4;
  return x >= s.left - e && y >= s.top - e && x + w <= 1 - s.right + e && y + h <= 1 - s.bottom + e;
};

/** A box from pixels on the 1920×1080 grid (each edge a multiple of 8 px) → fractions of the frame. */
export function gridBox(x: number, y: number, w: number, h: number): [number, number, number, number] {
  for (const v of [x, y, w, h]) if (v % GRID_PX) throw new Error(`${v} px is off the ${GRID_PX} px grid`);
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return [r(x / REF.width), r(y / REF.height), r(w / REF.width), r(h / REF.height)];
}
/** True when a box's edges are on the grid of the reference frame. */
export const onGrid = (box: TitleSpec["box"]) => {
  const px = [box[0] * REF.width, box[1] * REF.height, box[2] * REF.width, box[3] * REF.height];
  return px.every((v) => Math.abs(v / GRID_PX - Math.round(v / GRID_PX)) < 1e-3);
};

/**
 * The layouts every category uses (on the grid, inside title safe: 96 px from the sides, 56 px from the top and
 * bottom grid lines inside the 54 px margin).
 */
export const LAYOUT = {
  /** A full-frame title, centred. */
  head: gridBox(96, 392, 1728, 296),
  /** Upper third (headings over a clip). */
  top: gridBox(96, 56, 1728, 200),
  /** Lower third, left. */
  lower: gridBox(96, 768, 960, 160),
  /** Wider lower third (breaking news, long names). */
  lowerWide: gridBox(96, 768, 1248, 160),
  /** A centred card (quotes, figures, tags). */
  centre: gridBox(384, 336, 1152, 408),
  /** A smaller centred block (badges, price tags). */
  block: gridBox(576, 424, 768, 232),
  /** A square-ish centre (countdowns, stickers). */
  square: gridBox(720, 304, 480, 472),
  /** A sticker in the upper right. */
  corner: gridBox(1424, 120, 400, 304),
  /** Bottom buttons (subscribe, like). */
  button: gridBox(744, 856, 432, 120),
  buttonLeft: gridBox(96, 880, 496, 112),
  /** The news ticker band's text line (the band itself bleeds full width). */
  ticker: gridBox(96, 952, 1728, 72),
} as const;
export type LayoutId = keyof typeof LAYOUT;

// ── colour ───────────────────────────────────────────────────────────────────

export interface Palette {
  id: string; name: string;
  /** The plate text sits on (and the nominal backdrop for text over footage). */
  bg: string; accent: string; text: string; sub: string;
  /** Text on an accent-coloured plate. */
  onAccent: string;
}
export const PALETTES: Palette[] = [
  { id: "ink", name: "Ink", bg: "#0b1220", accent: "#3b82f6", text: "#ffffff", sub: "#cbd5e1", onAccent: "#0b1220" },
  { id: "paper", name: "Paper", bg: "#f8fafc", accent: "#1d4ed8", text: "#0f172a", sub: "#475569", onAccent: "#ffffff" },
  { id: "broadcast", name: "Broadcast", bg: "#111827", accent: "#c8102e", text: "#ffffff", sub: "#d1d5db", onAccent: "#ffffff" },
  { id: "navy_gold", name: "Navy and gold", bg: "#0f1e3d", accent: "#c9a227", text: "#ffffff", sub: "#d6deeb", onAccent: "#0f1e3d" },
  { id: "emerald", name: "Emerald", bg: "#052e1c", accent: "#22c55e", text: "#ffffff", sub: "#bbf7d0", onAccent: "#052e1c" },
  { id: "plum", name: "Plum", bg: "#1e0b3b", accent: "#d946ef", text: "#ffffff", sub: "#e9d5ff", onAccent: "#1e0b3b" },
  { id: "ivory", name: "Ivory", bg: "#fbf7f0", accent: "#7a5c33", text: "#2b2118", sub: "#6b5b4a", onAccent: "#ffffff" },
  { id: "amber", name: "Charcoal and amber", bg: "#1c1917", accent: "#f59e0b", text: "#fafaf9", sub: "#d6d3d1", onAccent: "#1c1917" },
  { id: "ocean", name: "Ocean", bg: "#0c4a6e", accent: "#38bdf8", text: "#ffffff", sub: "#e0f2fe", onAccent: "#082f49" },
  { id: "terracotta", name: "Terracotta", bg: "#7c2d12", accent: "#fdba74", text: "#fff7ed", sub: "#fed7aa", onAccent: "#431407" },
];
export type PaletteId = "ink" | "paper" | "broadcast" | "navy_gold" | "emerald" | "plum" | "ivory" | "amber" | "ocean" | "terracotta";
export const palette = (id: PaletteId): Palette => PALETTES.find((p) => p.id === id)!;
/** Plates are 90 % opaque (enough for 4.5:1 over any picture). */
export const PLATE_ALPHA = "e6";
export const plateColor = (hex: string) => `${hex.slice(0, 7)}${PLATE_ALPHA}`;
/** The soft shadow of text over footage. */
export const TEXT_SHADOW = { color: "#000000b3", blur: 16, x: 0, y: 2 };
export const MIN_CONTRAST = 4.5;

const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
/** "#rrggbb(aa)" → [r, g, b, a] 0..1. */
export function rgba(hex: string): [number, number, number, number] {
  const h = hex.replace("#", "");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return [n(0), n(2), n(4), h.length >= 8 ? n(6) : 1];
}
const lum = ([r, g, b]: number[]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
/** WCAG 2 contrast ratio of two opaque colours. */
export function contrast(a: string, b: string): number {
  const x = lum(rgba(a)), y = lum(rgba(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** Contrast of text on a (possibly translucent) plate: the worst case with black or white footage behind it. */
export function plateContrast(text: string, plate: string): number {
  const [r, g, b, a] = rgba(plate);
  const over = (bk: number) => [r * a + bk * (1 - a), g * a + bk * (1 - a), b * a + bk * (1 - a)];
  const t = lum(rgba(text));
  return Math.min(...[0, 1].map((bk) => { const p = lum(over(bk)); return (Math.max(t, p) + 0.05) / (Math.min(t, p) + 0.05); }));
}

// ── fonts ────────────────────────────────────────────────────────────────────

export type IndicScript = "devanagari" | "kannada" | "telugu" | "tamil";
export const INDIC_SCRIPTS: IndicScript[] = ["devanagari", "kannada", "telugu", "tamil"];
/** The renderer's fallback per script (render/title.ts fontOf: Inter, then the Anek families). */
export const ANEK: Record<IndicScript, string> = {
  devanagari: "Anek Devanagari Variable", kannada: "Anek Kannada Variable", telugu: "Anek Telugu Variable", tamil: "Anek Tamil Variable",
};
export interface FontRef { family: string; weight: number }
export interface Pairing { id: string; name: string; display: FontRef; text: FontRef; indic: Record<IndicScript, string> }
const pair = (id: string, name: string, display: FontRef, text: FontRef, native: Partial<Record<IndicScript, string>> = {}): Pairing =>
  ({ id, name, display, text, indic: { ...ANEK, ...native } });
export const PAIRINGS: Pairing[] = [
  pair("modern", "Modern sans", { family: "Montserrat Variable", weight: 700 }, { family: "Inter Variable", weight: 500 }),
  pair("editorial", "Editorial serif", { family: "Playfair Display Variable", weight: 600 }, { family: "Inter Variable", weight: 400 }),
  pair("cinematic", "Cinematic", { family: "Cinzel Variable", weight: 600 }, { family: "Montserrat Variable", weight: 500 }),
  pair("newsroom", "Newsroom", { family: "Oswald Variable", weight: 600 }, { family: "Inter Variable", weight: 600 }),
  pair("athletic", "Athletic", { family: "Teko Variable", weight: 600 }, { family: "Oswald Variable", weight: 500 }, { devanagari: "Teko Variable" }),
  pair("friendly", "Friendly", { family: "Baloo 2 Variable", weight: 800 }, { family: "Poppins", weight: 600 }, { devanagari: "Baloo 2 Variable" }),
  pair("luxury", "Luxury", { family: "Bodoni Moda Variable", weight: 600 }, { family: "Montserrat Variable", weight: 500 }),
  pair("romance", "Romance", { family: "Great Vibes", weight: 400 }, { family: "Playfair Display Variable", weight: 500 }),
  pair("impact", "Impact", { family: "Anton", weight: 400 }, { family: "Inter Variable", weight: 600 }),
  pair("handmade", "Handmade", { family: "Permanent Marker", weight: 400 }, { family: "Poppins", weight: 600 }, { devanagari: "Poppins" }),
  pair("poster", "Poster", { family: "Abril Fatface", weight: 400 }, { family: "Montserrat Variable", weight: 500 }),
  pair("display_serif", "Display serif", { family: "DM Serif Display", weight: 400 }, { family: "Inter Variable", weight: 500 }),
  pair("condensed", "Condensed", { family: "Bebas Neue", weight: 400 }, { family: "Inter Variable", weight: 500 }),
];
export type PairingId = "modern" | "editorial" | "cinematic" | "newsroom" | "athletic" | "friendly" | "luxury" | "romance" | "impact" | "handmade" | "poster" | "display_serif" | "condensed";
export const pairing = (id: PairingId): Pairing => PAIRINGS.find((p) => p.id === id)!;

// ── motion ───────────────────────────────────────────────────────────────────

export interface MotionPreset {
  id: string; in: string; out: string;
  /** Seconds. */
  inDur: number; outDur: number;
  stagger: NonNullable<TitleLook["stagger"]>;
  /** Seconds between staggered units (renderer: look.staggerStep). */
  step?: number;
  ease: "out-cubic" | "back" | "bounce" | "elastic" | "steps";
  /** Bounce, elastic, glitch, spin, pop: only on playful styles. */
  expressive: boolean;
}
export const MOTION_LIMITS = { in: [0.35, 0.6], out: [0.25, 0.4], step: [0.03, 0.06] } as const;
const M = (id: string, inId: string, inDur: number, out: string, outDur: number, stagger: MotionPreset["stagger"] = "none", step?: number, ease: MotionPreset["ease"] = "out-cubic", expressive = false): MotionPreset =>
  ({ id, in: inId, out, inDur, outDur, stagger, ...(step !== undefined ? { step } : {}), ease, expressive });
export const MOTION: Record<string, MotionPreset> = {
  fade: M("fade", "fade", 0.5, "fade", 0.35),
  rise: M("rise", "rise", 0.5, "fade", 0.3, "word", 0.04),
  slide: M("slide", "slide_left", 0.45, "fade", 0.3, "word", 0.035),
  wipe: M("wipe", "wipe", 0.5, "wipe", 0.35),
  blur: M("blur", "blur", 0.5, "fade", 0.35, "word", 0.05),
  reveal: M("reveal", "tracking", 0.6, "fade", 0.4),
  type: M("type", "typewriter", 0.6, "fade", 0.3, "char", 0.03, "steps"),
  zoom: M("zoom", "zoom", 0.45, "fade", 0.3),
  drop: M("drop", "drop", 0.45, "fade", 0.3, "word", 0.04),
  lines: M("lines", "rise", 0.55, "fade", 0.35, "line", 0.06),
  flip: M("flip", "flip", 0.45, "fade", 0.3, "word", 0.04),
  // expressive
  pop: M("pop", "pop", 0.4, "fade", 0.25, "word", 0.04, "back", true),
  bounce: M("bounce", "bounce", 0.6, "fade", 0.3, "char", 0.03, "bounce", true),
  elastic: M("elastic", "elastic", 0.6, "fade", 0.3, "none", undefined, "elastic", true),
  glitch: M("glitch", "glitch", 0.4, "fade", 0.25, "none", undefined, "steps", true),
  spin: M("spin", "spin", 0.5, "fade", 0.3, "none", undefined, "back", true),
};
export type MotionId = keyof typeof MOTION;

// ── plates and decor ─────────────────────────────────────────────────────────

/** Thickness of each decoration as a fraction of the text size (renderer: decor.size). */
export const DECOR_SIZE = { bar: 0.12, underline: 0.08, lines: 0.06, bracket: 0.12, frame: 0.08, ring: 0.08 } as const;
/** Shape corner radii and strokes on the grid (px at 1080). */
export const RADIUS = { sm: 8, md: 16, lg: 32, pill: 64 } as const;
export const STROKE = { hair: 2, thin: 4, bold: 8 } as const;

/**
 * How the text sits: "none" (over footage, with the shadow), a plate in the palette's background ("box", "pill",
 * "glass"), an accent plate ("accent", "slash"), a two-tone "split" (text on the accent, the sub line on the
 * background), a "ticker" band, or accent marks only ("bar", "underline", "lines", "bracket", "frame", "ring").
 */
export type PlateKind = "none" | "box" | "pill" | "glass" | "accent" | "slash" | "split" | "ticker" | "bar" | "underline" | "lines" | "bracket" | "frame" | "ring";

/** The design a template was built from (kept on the template for the tests and the panel). */
export interface TitleDesign { palette: PaletteId; pairing: PairingId; motion: MotionId; plate: PlateKind; size: TypeStep; sub?: TypeStep }

export interface DesignOpts {
  palette: PaletteId; pairing: PairingId; motion: MotionId; plate?: PlateKind;
  size: TypeStep; role?: "display" | "text";
  box: TitleSpec["box"]; align?: TitleSpec["align"];
  sub?: { text: string; size?: TypeStep };
  upper?: boolean; tracking?: number; italic?: boolean;
  /** A gradient from the text colour to the accent. */
  gradient?: boolean;
  /** A glow in the accent (neon). */
  glow?: number;
  /** A thin outline in the palette's background (bold display type over busy footage). */
  outline?: boolean;
  loop?: string; count?: TitleLook["count"];
  shape?: ShapeSpec;
  /** Text colour override when a shape carries the text (it must still pass on the shape's fill). */
  color?: string;
  /** Overrides the motion's out animation (a ticker scrolls; a count holds). */
  out?: string;
}

/** A TitleSpec at 1080 lines from the design tokens (the text is filled in by the template). */
export function designTitle(text: string, o: DesignOpts): { spec: TitleSpec; design: TitleDesign } {
  const p = palette(o.palette), f = pairing(o.pairing), m = MOTION[o.motion];
  const font = o.role === "text" ? f.text : f.display;
  const plate = o.plate ?? "none";
  const size = TYPE_SCALE[o.size];
  const onPlate = plate === "accent" || plate === "slash" || plate === "split";
  const color = o.color ?? (onPlate ? p.onAccent : p.text);
  const decor: TitleLook["decor"] | undefined =
    plate === "box" || plate === "pill" ? { kind: plate, color: plateColor(p.bg) }
    : plate === "glass" ? { kind: "glass", color: plateColor(p.bg), color2: "#ffffff40" }
    : plate === "accent" ? { kind: "box", color: p.accent }
    : plate === "slash" ? { kind: "slash", color: p.accent }
    : plate === "split" ? { kind: "split", color: p.accent, color2: plateColor(p.bg) }
    : plate === "ticker" ? { kind: "ticker", color: p.bg, color2: p.accent }
    : plate === "none" ? undefined
    : { kind: plate, color: p.accent, size: DECOR_SIZE[plate as keyof typeof DECOR_SIZE], ...(plate === "ring" ? { color: `${p.text}59`, color2: p.accent } : {}) };
  const subStep = o.sub ? (o.sub.size ?? SUB_STEP[o.size]) : undefined;
  const look: TitleLook = {
    in: m.in, out: o.out ?? m.out, inDur: m.inDur, outDur: m.outDur, stagger: m.stagger, ...(m.step !== undefined ? { staggerStep: m.step } : {}),
    ...(decor ? { decor } : {}),
    ...(o.upper ? { upper: true } : {}), ...(o.tracking ? { tracking: o.tracking } : {}), ...(o.italic ? { italic: true } : {}),
    ...(o.gradient ? { gradient: [color, p.accent] as [string, string] } : {}),
    ...(o.glow ? { glow: { color: p.accent, blur: o.glow } } : {}),
    ...(o.loop ? { loop: o.loop } : {}), ...(o.count ? { count: o.count } : {}),
    ...(o.sub && subStep ? { sub: { text: o.sub.text, size: TYPE_SCALE[subStep], color: plate === "split" || !onPlate ? p.sub : p.onAccent, font: f.text.family, weight: f.text.weight } } : {}),
  };
  const spec: TitleSpec = {
    text, font: font.family, weight: font.weight, size, color, align: o.align ?? "center", box: o.box, animIn: "none", animOut: "none",
    ...(plate === "none" || plate === "bar" || plate === "underline" || plate === "lines" || plate === "bracket" || plate === "frame" || plate === "ring" ? { shadow: { ...TEXT_SHADOW } } : {}),
    ...(o.outline ? { outline: { color: p.bg, width: 3 } } : {}),
    look,
    ...(o.shape ? { shape: o.shape } : {}),
  };
  return { spec, design: { palette: o.palette, pairing: o.pairing, motion: o.motion, plate, size: o.size, ...(subStep ? { sub: subStep } : {}) } };
}

/**
 * The colours a template's text is read against, for the contrast checks: the plate under the text and under the sub
 * line (the palette's background for text over footage, which also has the shadow).
 */
export function readingPairs(spec: TitleSpec, p: Palette): { what: string; fg: string; bg: string }[] {
  const d = spec.look?.decor;
  const shape = spec.shape;
  const out: { what: string; fg: string; bg: string }[] = [];
  const main = shape?.fill && shape.fill !== "none" && shape.kind !== "line" ? shape.fill
    : d && ["box", "pill", "glass", "slash", "split", "ticker"].includes(d.kind) ? d.color : p.bg;
  if (spec.text.trim() || shape?.kind === "subscribe" || shape?.kind === "like") {
    const fg = shape?.kind === "subscribe" || shape?.kind === "like" ? (shape.stroke ?? "#ffffff") : spec.color;
    out.push({ what: "text", fg, bg: main });
    if (d?.kind === "ticker" && d.color2) out.push({ what: "text on the ticker label", fg, bg: d.color2 });
  }
  if (spec.look?.sub?.text) out.push({ what: "sub line", fg: spec.look.sub.color, bg: d?.kind === "split" ? (d.color2 ?? p.bg) : main });
  return out;
}

/** One title template from the design tokens (titles.ts and packs/titles.ts build every template with it). */
export function designed(id: string, name: string, category: TemplateCategory, seconds: number, fields: TitleTemplate["fields"], o: DesignOpts & { tone: "serious" | "expressive" }): TitleTemplate {
  const { tone, ...opts } = o;
  const { spec, design } = designTitle(fields.text, { ...opts, ...(fields.sub !== undefined && opts.sub === undefined ? { sub: { text: fields.sub } } : {}) });
  return { id, name, category, seconds, fields, spec, design, tone };
}
