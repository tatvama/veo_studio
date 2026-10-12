/**
 * Animated title templates (docs/EDITOR.md §10, editor-looks): generated from styles × animations, so the list is
 * deterministic (the same ids every build) — headlines (clean, bold, cinematic, neon, handwritten), lower thirds (12
 * plates), news tickers, end cards, subscribe / like stickers, quote cards, chapter titles and countdowns. A template
 * is a TitleSpec at 1080 lines with a `look` (render/title.ts) and its fields (the text and a sub line). Pure.
 */
import type { ShapeSpec, TitleLook, TitleSpec } from "../model/types.ts";

export type TemplateCategory = "Headlines" | "Lower thirds" | "News" | "End cards" | "Social" | "Quotes" | "Chapters" | "Countdowns";
export const TEMPLATE_CATEGORIES: TemplateCategory[] = ["Headlines", "Lower thirds", "News", "End cards", "Social", "Quotes", "Chapters", "Countdowns"];

export interface TitleTemplate {
  id: string; name: string; category: TemplateCategory;
  /** Default length in seconds. */
  seconds: number;
  /** What the user fills in: the text and (lower thirds, end cards) a sub line. */
  fields: { text: string; sub?: string };
  /** At 1080 lines (templateSpec scales it to the sequence). */
  spec: TitleSpec;
}

const SHADOW = { color: "#000000aa", blur: 14, x: 0, y: 4 };
const base = (over: Partial<TitleSpec>): TitleSpec => ({
  text: "Title", font: "Inter Variable", size: 110, color: "#ffffff", weight: 700, align: "center", box: [0.08, 0.36, 0.84, 0.28],
  animIn: "none", animOut: "none", shadow: SHADOW, ...over,
});

const ANIM_LABEL: Record<string, string> = {
  fade: "Fade", rise: "Rise", pop: "Pop", typewriter: "Typewriter", blur: "Blur in", zoom: "Zoom", wipe: "Wipe", bounce: "Bounce",
  slide_left: "Slide", glitch: "Glitch", tracking: "Tracking", elastic: "Elastic", flip: "Flip", drop: "Drop", spin: "Spin",
};

// ── headlines: 5 styles × 8 animations, plus one signature each ─────────────

interface Style { id: string; name: string; spec: Partial<TitleSpec>; look: TitleLook; extra: { anim: string; look?: TitleLook; name: string } }
const HEADLINE_STYLES: Style[] = [
  { id: "clean", name: "Clean", spec: { font: "Inter Variable", weight: 600, size: 104 }, look: {}, extra: { anim: "slide_left", name: "Slide", look: { stagger: "word" } } },
  { id: "bold", name: "Bold", spec: { font: "Anton", weight: 400, size: 150, outline: { color: "#000000", width: 4 } }, look: { upper: true }, extra: { anim: "glitch", name: "Glitch" } },
  { id: "cinematic", name: "Cinematic", spec: { font: "Cinzel Variable", weight: 700, size: 112, color: "#f8e7b5" }, look: { tracking: 0.18, upper: true, gradient: ["#fff3d1", "#c9a24a"] },
    extra: { anim: "tracking", name: "Tracking", look: { inDur: 1.4 } } },
  { id: "neon", name: "Neon", spec: { font: "Oswald Variable", weight: 500, size: 120, color: "#fdf4ff", shadow: undefined }, look: { glow: { color: "#ff2bd6", blur: 30 }, upper: true },
    extra: { anim: "fade", name: "Flicker", look: { loop: "flicker" } } },
  { id: "handwritten", name: "Handwritten", spec: { font: "Permanent Marker", weight: 400, size: 120, color: "#fff7d6" }, look: {}, extra: { anim: "elastic", name: "Elastic" } },
];
const HEADLINE_ANIMS = ["fade", "rise", "pop", "typewriter", "blur", "zoom", "wipe", "bounce"];
/** Staggered per letter / word for the ones that read better that way. */
const STAGGER: Record<string, TitleLook["stagger"]> = { rise: "word", bounce: "char", pop: "word" };

const HEADLINE_TEXT: Record<string, string> = { clean: "Your Title Here", bold: "Big News", cinematic: "The Last Light", neon: "Night Drive", handwritten: "Summer Diaries" };

function headlines(): TitleTemplate[] {
  const out: TitleTemplate[] = [];
  for (const st of HEADLINE_STYLES) {
    const make = (id: string, name: string, anim: string, extra?: TitleLook) => out.push({
      id: `headline.${st.id}.${id}`, name: `${st.name} · ${name}`, category: "Headlines", seconds: 4, fields: { text: HEADLINE_TEXT[st.id] },
      spec: base({ ...st.spec, look: { ...st.look, in: anim, out: "fade", stagger: STAGGER[anim] ?? "none", ...extra } }),
    });
    for (const a of HEADLINE_ANIMS) make(a, ANIM_LABEL[a] ?? a, a);
    // each style's signature move (neon flicker = a fade in and a flicker loop)
    make(st.extra.name.toLowerCase(), st.extra.name, st.extra.anim, st.extra.look);
  }
  return out;
}

// ── lower thirds: 12 plates × 3 animations ──────────────────────────────────

interface Plate { id: string; name: string; spec: Partial<TitleSpec>; look: TitleLook }
const LT_BOX: [number, number, number, number] = [0.06, 0.72, 0.5, 0.14];
const PLATES: Plate[] = [
  { id: "bar", name: "Accent bar", spec: { font: "Montserrat Variable", weight: 700, size: 58 }, look: { decor: { kind: "bar", color: "#f59e0b", size: 0.14 } } },
  { id: "split", name: "Two-tone", spec: { font: "Montserrat Variable", weight: 800, size: 54, color: "#111827", shadow: undefined }, look: { decor: { kind: "split", color: "#ffffff", color2: "#2563eb" } } },
  { id: "pill", name: "Pill", spec: { font: "Poppins", weight: 600, size: 52, color: "#ffffff", shadow: undefined }, look: { decor: { kind: "pill", color: "#7c3aedd9" } } },
  { id: "box", name: "Solid box", spec: { font: "Inter Variable", weight: 700, size: 56, color: "#ffffff", shadow: undefined }, look: { decor: { kind: "box", color: "#000000cc" } } },
  { id: "underline", name: "Underline", spec: { font: "Montserrat Variable", weight: 700, size: 58 }, look: { decor: { kind: "underline", color: "#22d3ee", size: 0.12 } } },
  { id: "bracket", name: "Brackets", spec: { font: "Oswald Variable", weight: 500, size: 60 }, look: { upper: true, tracking: 0.06, decor: { kind: "bracket", color: "#fbbf24", size: 0.14 } } },
  { id: "glass", name: "Glass", spec: { font: "Inter Variable", weight: 600, size: 54, shadow: undefined }, look: { decor: { kind: "glass", color: "#ffffff26", color2: "#ffffff66" } } },
  { id: "slash", name: "Slash", spec: { font: "Anton", weight: 400, size: 62, shadow: undefined }, look: { upper: true, decor: { kind: "slash", color: "#e11d48" } } },
  { id: "minimal", name: "Minimal", spec: { font: "Inter Variable", weight: 500, size: 54 }, look: {} },
  { id: "gradient", name: "Gradient text", spec: { font: "Poppins", weight: 800, size: 60 }, look: { gradient: ["#fde68a", "#f97316"] } },
  { id: "frame", name: "Frame", spec: { font: "Playfair Display Variable", weight: 600, size: 58 }, look: { decor: { kind: "frame", color: "#ffffffcc", size: 0.12 } } },
  { id: "sport", name: "Sport", spec: { font: "Teko Variable", weight: 600, size: 72, shadow: undefined }, look: { upper: true, decor: { kind: "split", color: "#16a34a", color2: "#052e16" } } },
];
const LT_ANIMS = ["slide_left", "wipe", "rise"];

function lowerThirds(): TitleTemplate[] {
  return PLATES.flatMap((p) => LT_ANIMS.map((a) => ({
    id: `lower.${p.id}.${a}`, name: `${p.name} · ${ANIM_LABEL[a]}`, category: "Lower thirds" as const, seconds: 5,
    fields: { text: "Asha Rao", sub: "Director, Tatvam Films" },
    spec: base({ ...p.spec, align: "left", box: LT_BOX, look: { ...p.look, in: a, out: a === "wipe" ? "wipe" : "fade", inDur: 0.6,
      sub: { text: "Director, Tatvam Films", size: Math.round((p.spec.size ?? 56) * 0.62), color: p.id === "split" ? "#ffffff" : "#e5e7eb", weight: 500 } } }),
  })));
}

// ── the rest ─────────────────────────────────────────────────────────────────

const shape = (s: ShapeSpec) => s;
function others(): TitleTemplate[] {
  const T = (id: string, name: string, category: TemplateCategory, seconds: number, fields: TitleTemplate["fields"], spec: TitleSpec): TitleTemplate => ({ id, name, category, seconds, fields, spec });
  const TICKER_BOX: [number, number, number, number] = [0, 0.88, 1, 0.07];
  return [
    // news tickers
    T("news.ticker.red", "Ticker · Red band", "News", 12, { text: "Breaking: heavy rain expected across the coast tonight · Markets close higher · Festival dates announced" },
      base({ font: "Inter Variable", weight: 700, size: 44, align: "left", box: TICKER_BOX, shadow: undefined, look: { decor: { kind: "ticker", color: "#b91c1c", color2: "#111111" }, loop: "ticker" } })),
    T("news.ticker.blue", "Ticker · Blue band", "News", 12, { text: "Live updates · Scores · Weather · Traffic on the ring road is moving again" },
      base({ font: "Montserrat Variable", weight: 700, size: 42, align: "left", box: TICKER_BOX, shadow: undefined, look: { decor: { kind: "ticker", color: "#1d4ed8" }, loop: "ticker" } })),
    T("news.breaking", "Breaking news", "News", 6, { text: "BREAKING NEWS", sub: "Story developing" },
      base({ font: "Anton", weight: 400, size: 76, align: "left", box: [0.05, 0.7, 0.6, 0.14], shadow: undefined,
        look: { in: "wipe", out: "wipe", upper: true, decor: { kind: "split", color: "#dc2626", color2: "#111827" }, sub: { text: "Story developing", size: 40, color: "#ffffff", weight: 600 } } })),
    // end cards
    T("end.thanks", "Thanks for watching", "End cards", 6, { text: "Thanks for watching", sub: "See you in the next one" },
      base({ font: "Playfair Display Variable", weight: 600, size: 100, look: { in: "rise", out: "fade", stagger: "word", sub: { text: "See you in the next one", size: 46, color: "#d1d5db" } } })),
    T("end.next", "Watch next", "End cards", 8, { text: "Watch next", sub: "Two more stories you'll like" },
      base({ font: "Montserrat Variable", weight: 800, size: 84, box: [0.08, 0.08, 0.84, 0.18], look: { in: "pop", out: "fade", upper: true, decor: { kind: "underline", color: "#f43f5e", size: 0.1 }, sub: { text: "Two more stories you'll like", size: 40, color: "#e5e7eb" } } })),
    T("end.follow", "Follow for more", "End cards", 5, { text: "Follow for more" },
      base({ font: "Poppins", weight: 800, size: 96, look: { in: "bounce", out: "fade", stagger: "char", gradient: ["#a5f3fc", "#818cf8"] } })),
    T("end.credits", "Closing credit", "End cards", 6, { text: "A Tatvam Film", sub: "Written and directed by Asha Rao" },
      base({ font: "Cinzel Variable", weight: 600, size: 84, color: "#f5f5f4", look: { in: "fade", out: "fade", inDur: 1.2, tracking: 0.2, upper: true, sub: { text: "Written and directed by Asha Rao", size: 38, color: "#a8a29e", weight: 400 } } })),
    // subscribe / like
    T("social.subscribe.pop", "Subscribe button · Pop", "Social", 4, { text: "SUBSCRIBE" },
      base({ font: "Montserrat Variable", weight: 800, size: 60, box: [0.36, 0.74, 0.28, 0.11], shadow: SHADOW, shape: shape({ kind: "subscribe", fill: "#dc2626", stroke: "#ffffff" }), look: { in: "pop", out: "fade" } })),
    T("social.subscribe.slide", "Subscribe button · Slide", "Social", 4, { text: "SUBSCRIBE" },
      base({ font: "Montserrat Variable", weight: 800, size: 60, box: [0.05, 0.78, 0.26, 0.1], shadow: SHADOW, shape: shape({ kind: "subscribe", fill: "#dc2626", stroke: "#ffffff" }), look: { in: "slide_left", out: "fade" } })),
    T("social.like.pop", "Like button", "Social", 4, { text: "LIKE" },
      base({ font: "Montserrat Variable", weight: 800, size: 60, box: [0.4, 0.74, 0.2, 0.11], shadow: SHADOW, shape: shape({ kind: "like", fill: "#2563eb", stroke: "#ffffff" }), look: { in: "pop", out: "fade" } })),
    T("social.bell", "Notification bell", "Social", 3, { text: "" },
      base({ size: 60, box: [0.45, 0.4, 0.1, 0.18], shape: shape({ kind: "bell", fill: "#facc15", stroke: "#78350f", strokeWidth: 4 }), look: { in: "pop", out: "fade", loop: "wiggle" } })),
    T("social.likesub", "Like and subscribe", "Social", 5, { text: "Like & Subscribe" },
      base({ font: "Baloo 2 Variable", weight: 800, size: 96, color: "#ffffff", outline: { color: "#dc2626", width: 6 }, look: { in: "pop", out: "fade", stagger: "word", loop: "pulse" } })),
    T("social.burst", "Burst sticker", "Social", 4, { text: "NEW!" },
      base({ font: "Anton", weight: 400, size: 90, color: "#111827", box: [0.4, 0.3, 0.2, 0.36], shadow: undefined, shape: shape({ kind: "burst", fill: "#fde047", stroke: "#111827", strokeWidth: 5 }), look: { in: "spin", out: "fade", loop: "pulse" } })),
    // quotes
    T("quote.serif", "Quote · Serif", "Quotes", 6, { text: "“The best stories are the ones we live.”", sub: "— Anonymous" },
      base({ font: "Playfair Display Variable", weight: 500, size: 78, box: [0.12, 0.3, 0.76, 0.34], look: { in: "fade", out: "fade", inDur: 1, italic: true, stagger: "line", sub: { text: "— Anonymous", size: 40, color: "#d6d3d1" } } })),
    T("quote.modern", "Quote · Modern", "Quotes", 6, { text: "Make it simple. Make it memorable.", sub: "Brand book" },
      base({ font: "Montserrat Variable", weight: 800, size: 84, align: "left", box: [0.1, 0.32, 0.7, 0.32], look: { in: "rise", out: "fade", stagger: "word", decor: { kind: "bar", color: "#22c55e", size: 0.1 }, sub: { text: "Brand book", size: 36, color: "#a3a3a3" } } })),
    T("quote.hand", "Quote · Handwritten", "Quotes", 6, { text: "Collect moments, not things." },
      base({ font: "Great Vibes", weight: 400, size: 120, color: "#fff7ed", look: { in: "wipe", out: "fade", inDur: 1.6 } })),
    T("quote.callout", "Quote · Speech bubble", "Quotes", 5, { text: "Wait… what?!" },
      base({ font: "Baloo 2 Variable", weight: 800, size: 72, color: "#111827", box: [0.3, 0.2, 0.4, 0.3], shadow: undefined, shape: shape({ kind: "callout", fill: "#ffffff", stroke: "#111827", strokeWidth: 4, radius: 36 }), look: { in: "pop", out: "fade" } })),
    // chapters
    T("chapter.lines", "Chapter · Lines", "Chapters", 4, { text: "Chapter One" },
      base({ font: "Cinzel Variable", weight: 600, size: 84, look: { in: "fade", out: "fade", inDur: 0.9, tracking: 0.16, upper: true, decor: { kind: "lines", color: "#e7e5e4", size: 0.12 } } })),
    T("chapter.part", "Chapter · Part", "Chapters", 4, { text: "Part I", sub: "The Journey Begins" },
      base({ font: "Playfair Display Variable", weight: 700, size: 120, look: { in: "tracking", out: "fade", inDur: 1.2, sub: { text: "The Journey Begins", size: 48, color: "#d4d4d8", weight: 400 } } })),
    T("chapter.number", "Chapter · Big number", "Chapters", 4, { text: "01", sub: "Origins" },
      base({ font: "Anton", weight: 400, size: 260, color: "#ffffff", look: { in: "zoom", out: "fade", sub: { text: "Origins", size: 56, color: "#fbbf24", weight: 600 } } })),
    T("chapter.left", "Chapter · Side bar", "Chapters", 4, { text: "Chapter 2", sub: "Into the city" },
      base({ font: "Montserrat Variable", weight: 800, size: 92, align: "left", box: [0.08, 0.38, 0.6, 0.2], look: { in: "slide_left", out: "fade", upper: true, decor: { kind: "bar", color: "#38bdf8", size: 0.12 }, sub: { text: "Into the city", size: 44, color: "#e5e7eb" } } })),
    T("chapter.underline", "Chapter · Underline", "Chapters", 4, { text: "Act Three" },
      base({ font: "DM Serif Display", weight: 400, size: 110, look: { in: "rise", out: "fade", stagger: "word", decor: { kind: "underline", color: "#f472b6", size: 0.08 } } })),
    // countdowns
    T("count.ring", "Countdown · Ring", "Countdowns", 5, { text: "#" },
      base({ font: "Oswald Variable", weight: 600, size: 220, box: [0.35, 0.3, 0.3, 0.4], look: { in: "pop", out: "fade", count: { from: 5, to: 0 }, decor: { kind: "ring", color: "#ffffff", color2: "#22d3ee", size: 0.08 } } })),
    T("count.big", "Countdown · Big numbers", "Countdowns", 3, { text: "#" },
      base({ font: "Anton", weight: 400, size: 300, outline: { color: "#000000", width: 6 }, look: { in: "zoom", out: "fade", count: { from: 3, to: 1 }, loop: "pulse" } })),
    T("count.starting", "Countdown · Starting in", "Countdowns", 10, { text: "Starting in #" },
      base({ font: "Montserrat Variable", weight: 700, size: 90, look: { in: "fade", out: "fade", count: { from: 10, to: 0 }, decor: { kind: "pill", color: "#00000099" } } })),
  ];
}

let cache: TitleTemplate[] | null = null;
/** Every title template, in a fixed order. */
export function titleTemplates(): TitleTemplate[] {
  return (cache ??= [...headlines(), ...lowerThirds(), ...others()]);
}
export const titleTemplate = (id: string) => titleTemplates().find((t) => t.id === id);

const sc = (v: number, k: number) => Math.round(v * k * 10) / 10;

/**
 * A template as the TitleSpec of a new clip in a sequence `height` lines high: sizes scaled from 1080, the fields
 * filled in, its id kept in `template`.
 */
export function templateSpec(t: TitleTemplate, height = 1080, fields: Partial<TitleTemplate["fields"]> = {}): TitleSpec {
  const k = height / 1080;
  const s: TitleSpec = JSON.parse(JSON.stringify(t.spec));
  s.text = fields.text ?? t.fields.text;
  s.size = sc(s.size, k);
  if (s.outline) s.outline.width = sc(s.outline.width, k);
  if (s.shadow) s.shadow = { ...s.shadow, blur: sc(s.shadow.blur, k), x: sc(s.shadow.x, k), y: sc(s.shadow.y, k) };
  if (s.background) s.background = { ...s.background, padding: sc(s.background.padding, k), radius: sc(s.background.radius, k) };
  if (s.look?.sub) s.look.sub = { ...s.look.sub, text: fields.sub ?? t.fields.sub ?? s.look.sub.text, size: sc(s.look.sub.size, k) };
  if (s.look?.glow) s.look.glow = { ...s.look.glow, blur: sc(s.look.glow.blur, k) };
  if (s.shape?.strokeWidth) s.shape.strokeWidth = sc(s.shape.strokeWidth, k);
  if (s.shape?.radius) s.shape.radius = sc(s.shape.radius, k);
  s.template = t.id;
  return s;
}

/**
 * Square-ish boxes for stickers: `w` is a fraction of the frame width, the height follows the frame's aspect so a
 * shape stays round in any format.
 */
export function squareBox(cx: number, cy: number, w: number, W: number, H: number, aspect = 1): [number, number, number, number] {
  const h = (w * W) / H / aspect;
  return [Math.max(0, cx - w / 2), Math.max(0, cy - h / 2), w, h];
}

export interface Sticker { id: string; name: string; group: "Shapes" | "Arrows" | "Callouts" | "Emoji"; shape: ShapeSpec; text?: string; aspect?: number; w?: number }
const EMOJI = ["😀", "😂", "😍", "🥳", "😎", "🤯", "😢", "😡", "👍", "👏", "🙏", "🔥", "✨", "💯", "❤️", "⭐", "🎉", "🎬", "📍", "💡", "⚡", "🌧️", "🪔", "🌸"];
/** Shapes, arrows, callouts and an emoji set as title-clip stickers. */
export const STICKERS: Sticker[] = [
  { id: "rect", name: "Rectangle", group: "Shapes", shape: { kind: "rect", fill: "#ffffff", radius: 0 }, aspect: 1.6 },
  { id: "rounded", name: "Rounded box", group: "Shapes", shape: { kind: "rect", fill: "#111827cc", radius: 28 }, aspect: 1.6 },
  { id: "outline", name: "Outline box", group: "Shapes", shape: { kind: "rect", fill: "none", stroke: "#facc15", strokeWidth: 8, radius: 8 }, aspect: 1.6 },
  { id: "ellipse", name: "Ellipse", group: "Shapes", shape: { kind: "ellipse", fill: "#ffffff" } },
  { id: "ring", name: "Circle outline", group: "Shapes", shape: { kind: "ellipse", fill: "none", stroke: "#ef4444", strokeWidth: 10 } },
  { id: "line", name: "Line", group: "Shapes", shape: { kind: "line", stroke: "#ffffff", strokeWidth: 8 }, aspect: 8 },
  { id: "star", name: "Star", group: "Shapes", shape: { kind: "star", fill: "#facc15" } },
  { id: "heart", name: "Heart", group: "Shapes", shape: { kind: "heart", fill: "#f43f5e" } },
  { id: "burst", name: "Burst", group: "Shapes", shape: { kind: "burst", fill: "#fde047", stroke: "#111827", strokeWidth: 4 } },
  { id: "arrow-right", name: "Arrow right", group: "Arrows", shape: { kind: "arrow", fill: "#facc15", direction: "right" }, aspect: 2.2 },
  { id: "arrow-left", name: "Arrow left", group: "Arrows", shape: { kind: "arrow", fill: "#facc15", direction: "left" }, aspect: 2.2 },
  { id: "arrow-up", name: "Arrow up", group: "Arrows", shape: { kind: "arrow", fill: "#22d3ee", direction: "up" }, aspect: 0.45 },
  { id: "arrow-down", name: "Arrow down", group: "Arrows", shape: { kind: "arrow", fill: "#22d3ee", direction: "down" }, aspect: 0.45 },
  { id: "callout", name: "Speech bubble", group: "Callouts", shape: { kind: "callout", fill: "#ffffff", stroke: "#111827", strokeWidth: 4, radius: 32 }, text: "Hello!", aspect: 1.5, w: 0.28 },
  { id: "callout-dark", name: "Dark bubble", group: "Callouts", shape: { kind: "callout", fill: "#111827", radius: 28 }, text: "Note", aspect: 1.5, w: 0.28 },
  { id: "subscribe", name: "Subscribe", group: "Callouts", shape: { kind: "subscribe", fill: "#dc2626", stroke: "#ffffff" }, text: "SUBSCRIBE", aspect: 2.6, w: 0.26 },
  { id: "like", name: "Like", group: "Callouts", shape: { kind: "like", fill: "#2563eb", stroke: "#ffffff" }, text: "LIKE", aspect: 1.9, w: 0.2 },
  { id: "bell", name: "Bell", group: "Callouts", shape: { kind: "bell", fill: "#facc15", stroke: "#78350f", strokeWidth: 3 }, w: 0.1 },
  ...EMOJI.map((e, i): Sticker => ({ id: `emoji-${i}`, name: e, group: "Emoji", shape: { kind: "emoji", emoji: e }, w: 0.12 })),
];

/** A sticker as a title spec for a W×H sequence, centred at (cx, cy) (fractions). */
export function stickerSpec(st: Sticker, W: number, H: number, cx = 0.5, cy = 0.5): TitleSpec {
  const k = H / 1080;
  const shape: ShapeSpec = { ...st.shape };
  if (shape.strokeWidth) shape.strokeWidth = sc(shape.strokeWidth, k);
  if (shape.radius) shape.radius = sc(shape.radius, k);
  const dark = shape.fill === "#ffffff" && st.group === "Callouts";
  return {
    text: st.text ?? "", font: "Baloo 2 Variable", size: sc(st.group === "Callouts" ? 64 : 80, k), color: dark ? "#111827" : "#ffffff", weight: 800, align: "center",
    box: squareBox(cx, cy, st.w ?? 0.16, W, H, st.aspect ?? 1), animIn: "none", animOut: "none",
    look: { in: "pop", out: "fade" }, shape, template: `sticker.${st.id}`,
  };
}
