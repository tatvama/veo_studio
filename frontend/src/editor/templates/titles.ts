/**
 * Animated title templates (docs/EDITOR.md §10, §15.3): headlines (clean, bold, cinematic, neon, handwritten), lower
 * thirds (12 plates), news tickers, end cards, subscribe / like stickers, quote cards, chapter titles and countdowns,
 * then the presets pack's nine categories (templates/packs/titles.ts). Every template is built from the design system
 * (templates/design.ts: the type scale, the 8 px grid inside title safe, ten palettes with 4.5:1 text, the bundled
 * font pairings and the motion presets), so each category reads as one family. The ids are generated and stable (an
 * edit keeps the spec it was given; the id only names where it came from). A template is a TitleSpec at 1080 lines
 * with a `look` (render/title.ts) and its fields (the text and a sub line). Pure.
 */
import type { ShapeSpec, TitleSpec } from "../model/types.ts";
import { designed, gridBox, LAYOUT, palette, RADIUS, STROKE, type DesignOpts, type MotionId, type TitleDesign } from "./design.ts";
import { PACK_TITLE_CATEGORIES, packTitleTemplates, type PackTitleCategory } from "./packs/titles.ts";

/** The wave-3 categories, then the §15.3 presets pack's (templates/packs/titles.ts). */
export type TemplateCategory = "Headlines" | "Lower thirds" | "News" | "End cards" | "Social" | "Quotes" | "Chapters" | "Countdowns" | PackTitleCategory;
export const TEMPLATE_CATEGORIES: TemplateCategory[] = ["Headlines", "Lower thirds", "News", "End cards", "Social", "Quotes", "Chapters", "Countdowns", ...PACK_TITLE_CATEGORIES];

export interface TitleTemplate {
  id: string; name: string; category: TemplateCategory;
  /** Default length in seconds. */
  seconds: number;
  /** What the user fills in: the text and (lower thirds, end cards) a sub line. */
  fields: { text: string; sub?: string };
  /** At 1080 lines (templateSpec scales it to the sequence). */
  spec: TitleSpec;
  /** The design tokens it was built from (templates/design.ts). */
  design?: TitleDesign;
  /** "serious" styles never use the expressive moves (bounce, elastic, glitch, spin, pop). */
  tone?: "serious" | "expressive";
}

// ── headlines: 5 styles × 8 entrances, plus one signature each ──────────────

interface Style {
  id: string; name: string; text: string; tone: "serious" | "expressive";
  opts: Omit<DesignOpts, "motion" | "box">;
  signature: { id: string; name: string; motion: MotionId; loop?: string };
}
const HEADLINE_STYLES: Style[] = [
  { id: "clean", name: "Clean", text: "Your Title Here", tone: "serious", opts: { palette: "ink", pairing: "modern", size: "display" }, signature: { id: "slide", name: "Slide", motion: "slide" } },
  { id: "bold", name: "Bold", text: "Big News", tone: "expressive", opts: { palette: "ink", pairing: "impact", size: "hero", upper: true, outline: true }, signature: { id: "glitch", name: "Glitch", motion: "glitch" } },
  { id: "cinematic", name: "Cinematic", text: "The Last Light", tone: "serious", opts: { palette: "navy_gold", pairing: "cinematic", size: "headline", upper: true, tracking: 0.18, gradient: true },
    signature: { id: "tracking", name: "Tracking", motion: "reveal" } },
  { id: "neon", name: "Neon", text: "Night Drive", tone: "expressive", opts: { palette: "plum", pairing: "newsroom", size: "display", upper: true, tracking: 0.04, glow: 28 },
    signature: { id: "flicker", name: "Flicker", motion: "fade", loop: "flicker" } },
  { id: "handwritten", name: "Handwritten", text: "Summer Diaries", tone: "expressive", opts: { palette: "amber", pairing: "handmade", size: "display" }, signature: { id: "elastic", name: "Elastic", motion: "elastic" } },
];
/** The eight entrances (ids kept); serious styles take a calm move in place of the playful ones. */
const HEAD_ANIMS: { id: string; name: string; motion: MotionId; calm?: { name: string; motion: MotionId } }[] = [
  { id: "fade", name: "Fade", motion: "fade" }, { id: "rise", name: "Rise", motion: "rise" },
  { id: "pop", name: "Pop", motion: "pop", calm: { name: "Flip up", motion: "flip" } },
  { id: "typewriter", name: "Typewriter", motion: "type" }, { id: "blur", name: "Blur in", motion: "blur" }, { id: "zoom", name: "Zoom", motion: "zoom" },
  { id: "wipe", name: "Wipe", motion: "wipe" },
  { id: "bounce", name: "Bounce", motion: "bounce", calm: { name: "Drop", motion: "drop" } },
];

function headlines(): TitleTemplate[] {
  const out: TitleTemplate[] = [];
  for (const st of HEADLINE_STYLES) {
    for (const a of HEAD_ANIMS) {
      const m = st.tone === "serious" && a.calm ? a.calm : a;
      out.push(designed(`headline.${st.id}.${a.id}`, `${st.name} · ${m.name}`, "Headlines", 4, { text: st.text }, { ...st.opts, motion: m.motion, box: LAYOUT.head, tone: st.tone }));
    }
    const sg = st.signature;
    out.push(designed(`headline.${st.id}.${sg.id}`, `${st.name} · ${sg.name}`, "Headlines", 4, { text: st.text },
      { ...st.opts, motion: sg.motion, box: LAYOUT.head, tone: st.tone, ...(sg.loop ? { loop: sg.loop } : {}) }));
  }
  return out;
}

// ── lower thirds: 12 plates × 3 entrances, one grid, one type pair ──────────

interface Plate { id: string; name: string; opts: Omit<DesignOpts, "motion" | "box" | "size"> }
const PLATES: Plate[] = [
  { id: "bar", name: "Accent bar", opts: { palette: "ink", pairing: "modern", plate: "bar" } },
  { id: "split", name: "Two-tone", opts: { palette: "ink", pairing: "modern", plate: "split" } },
  { id: "pill", name: "Pill", opts: { palette: "plum", pairing: "friendly", plate: "pill" } },
  { id: "box", name: "Solid box", opts: { palette: "ink", pairing: "modern", plate: "box" } },
  { id: "underline", name: "Underline", opts: { palette: "ocean", pairing: "modern", plate: "underline" } },
  { id: "bracket", name: "Brackets", opts: { palette: "amber", pairing: "newsroom", plate: "bracket", upper: true, tracking: 0.06 } },
  { id: "glass", name: "Glass", opts: { palette: "ink", pairing: "modern", plate: "glass" } },
  { id: "slash", name: "Slash", opts: { palette: "broadcast", pairing: "impact", plate: "slash", upper: true } },
  { id: "minimal", name: "Minimal", opts: { palette: "ink", pairing: "modern", role: "text" } },
  { id: "gradient", name: "Gradient text", opts: { palette: "amber", pairing: "friendly", gradient: true } },
  { id: "frame", name: "Frame", opts: { palette: "navy_gold", pairing: "editorial", plate: "frame" } },
  { id: "sport", name: "Sport", opts: { palette: "emerald", pairing: "athletic", plate: "split", upper: true } },
];
const LT_ANIMS: { id: string; name: string; motion: MotionId }[] = [{ id: "slide_left", name: "Slide", motion: "slide" }, { id: "wipe", name: "Wipe", motion: "wipe" }, { id: "rise", name: "Rise", motion: "rise" }];

function lowerThirds(): TitleTemplate[] {
  return PLATES.flatMap((p) => LT_ANIMS.map((a) => designed(`lower.${p.id}.${a.id}`, `${p.name} · ${a.name}`, "Lower thirds", 5,
    { text: "Asha Rao", sub: "Director, Tatvam Films" }, { ...p.opts, size: "title", motion: a.motion, box: LAYOUT.lower, align: "left", tone: "serious" })));
}

// ── the rest ─────────────────────────────────────────────────────────────────

const shape = (s: ShapeSpec) => s;
function others(): TitleTemplate[] {
  const S = "serious" as const, X = "expressive" as const;
  const broadcast = palette("broadcast"), paper = palette("paper"), amber = palette("amber");
  return [
    // news (a ticker band bleeds to the frame edges; its text line sits inside title safe): one solid band each
    (() => {
      const t = designed("news.ticker.red", "Ticker · Red band", "News", 12, { text: "Breaking: heavy rain expected across the coast tonight · Markets close higher · Festival dates announced" },
        { palette: "broadcast", pairing: "newsroom", role: "text", size: "body", plate: "ticker", motion: "fade", out: "none", box: LAYOUT.ticker, align: "left", loop: "ticker", tone: S });
      if (t.spec.look?.decor) t.spec.look.decor = { kind: "ticker", color: broadcast.accent };   // the red band, white text (5.9:1)
      t.spec.color = broadcast.onAccent;
      return t;
    })(),
    (() => {
      const t = designed("news.ticker.blue", "Ticker · Blue band", "News", 12, { text: "Live updates · Scores · Weather · Traffic on the ring road is moving again" },
        { palette: "ocean", pairing: "newsroom", role: "text", size: "body", plate: "ticker", motion: "fade", out: "none", box: LAYOUT.ticker, align: "left", loop: "ticker", tone: S });
      if (t.spec.look?.decor) delete t.spec.look.decor.color2;   // one calm band, no label block
      return t;
    })(),
    designed("news.breaking", "Breaking news", "News", 6, { text: "BREAKING NEWS", sub: "Story developing" },
      { palette: "broadcast", pairing: "impact", size: "headline", plate: "split", upper: true, motion: "wipe", box: LAYOUT.lowerWide, align: "left", tone: S }),
    // end cards
    designed("end.thanks", "Thanks for watching", "End cards", 6, { text: "Thanks for watching", sub: "See you in the next one" },
      { palette: "navy_gold", pairing: "editorial", size: "display", motion: "rise", box: LAYOUT.head, tone: S }),
    designed("end.next", "Watch next", "End cards", 8, { text: "Watch next", sub: "Two more stories you'll like" },
      { palette: "ink", pairing: "modern", size: "headline", plate: "underline", upper: true, motion: "rise", box: LAYOUT.top, tone: S }),
    designed("end.follow", "Follow for more", "End cards", 5, { text: "Follow for more" },
      { palette: "ocean", pairing: "friendly", size: "display", gradient: true, motion: "rise", box: LAYOUT.head, tone: S }),
    designed("end.credits", "Closing credit", "End cards", 6, { text: "A Tatvam Film", sub: "Written and directed by Asha Rao" },
      { palette: "navy_gold", pairing: "cinematic", size: "headline", upper: true, tracking: 0.2, motion: "fade", box: LAYOUT.head, tone: S }),
    // subscribe / like
    designed("social.subscribe.pop", "Subscribe button · Pop", "Social", 4, { text: "SUBSCRIBE" },
      { palette: "broadcast", pairing: "modern", size: "title", motion: "pop", box: LAYOUT.button, tone: X, shape: shape({ kind: "subscribe", fill: broadcast.accent, stroke: "#ffffff" }), color: "#ffffff" }),
    designed("social.subscribe.slide", "Subscribe button · Slide", "Social", 4, { text: "SUBSCRIBE" },
      { palette: "broadcast", pairing: "modern", size: "title", motion: "slide", box: LAYOUT.buttonLeft, tone: X, shape: shape({ kind: "subscribe", fill: broadcast.accent, stroke: "#ffffff" }), color: "#ffffff" }),
    designed("social.like.pop", "Like button", "Social", 4, { text: "LIKE" },
      { palette: "paper", pairing: "modern", size: "title", motion: "pop", box: gridBox(808, 856, 304, 120), tone: X, shape: shape({ kind: "like", fill: paper.accent, stroke: "#ffffff" }), color: "#ffffff" }),
    designed("social.bell", "Notification bell", "Social", 3, { text: "" },
      { palette: "amber", pairing: "modern", size: "title", motion: "pop", box: gridBox(864, 432, 192, 216), tone: X, loop: "wiggle", shape: shape({ kind: "bell", fill: amber.accent, stroke: amber.bg, strokeWidth: STROKE.thin }) }),
    designed("social.likesub", "Like and subscribe", "Social", 5, { text: "Like & Subscribe" },
      { palette: "broadcast", pairing: "friendly", size: "display", outline: true, motion: "pop", box: LAYOUT.head, tone: X }),
    designed("social.burst", "Burst sticker", "Social", 4, { text: "NEW!" },
      { palette: "amber", pairing: "impact", size: "headline", motion: "spin", box: LAYOUT.square, tone: X, shape: shape({ kind: "burst", fill: amber.accent, stroke: amber.bg, strokeWidth: STROKE.thin }), color: amber.onAccent }),
    // quotes
    designed("quote.serif", "Quote · Serif", "Quotes", 6, { text: "“The best stories are the ones we live.”", sub: "— Anonymous" },
      { palette: "ink", pairing: "editorial", size: "headline", italic: true, motion: "lines", box: LAYOUT.centre, tone: S }),
    designed("quote.modern", "Quote · Modern", "Quotes", 6, { text: "Make it simple. Make it memorable.", sub: "Brand book" },
      { palette: "ink", pairing: "modern", size: "headline", plate: "bar", motion: "rise", box: LAYOUT.centre, align: "left", tone: S }),
    designed("quote.hand", "Quote · Handwritten", "Quotes", 6, { text: "Collect moments, not things." },
      { palette: "amber", pairing: "romance", size: "display", motion: "wipe", box: LAYOUT.head, tone: S }),
    designed("quote.callout", "Quote · Speech bubble", "Quotes", 5, { text: "Wait… what?!" },
      { palette: "paper", pairing: "friendly", size: "title", motion: "fade", box: gridBox(576, 216, 768, 328), tone: S, color: paper.text,
        shape: shape({ kind: "callout", fill: paper.bg, stroke: paper.text, strokeWidth: STROKE.thin, radius: RADIUS.lg }) }),
    // chapters
    designed("chapter.lines", "Chapter · Lines", "Chapters", 4, { text: "Chapter One" },
      { palette: "navy_gold", pairing: "cinematic", size: "headline", plate: "lines", upper: true, tracking: 0.16, motion: "fade", box: LAYOUT.head, tone: S }),
    designed("chapter.part", "Chapter · Part", "Chapters", 4, { text: "Part I", sub: "The Journey Begins" },
      { palette: "navy_gold", pairing: "editorial", size: "display", motion: "reveal", box: LAYOUT.head, tone: S }),
    designed("chapter.number", "Chapter · Big number", "Chapters", 4, { text: "01", sub: "Origins" },
      { palette: "navy_gold", pairing: "impact", size: "hero", gradient: true, motion: "zoom", box: LAYOUT.head, tone: S }),
    designed("chapter.left", "Chapter · Side bar", "Chapters", 4, { text: "Chapter 2", sub: "Into the city" },
      { palette: "navy_gold", pairing: "modern", size: "headline", plate: "bar", upper: true, motion: "slide", box: gridBox(96, 384, 1152, 232), align: "left", tone: S }),
    designed("chapter.underline", "Chapter · Underline", "Chapters", 4, { text: "Act Three" },
      { palette: "navy_gold", pairing: "display_serif", size: "display", plate: "underline", motion: "rise", box: LAYOUT.head, tone: S }),
    // countdowns
    designed("count.ring", "Countdown · Ring", "Countdowns", 5, { text: "#" },
      { palette: "ocean", pairing: "newsroom", size: "hero", plate: "ring", motion: "zoom", box: LAYOUT.square, count: { from: 5, to: 0 }, tone: S }),
    designed("count.big", "Countdown · Big numbers", "Countdowns", 3, { text: "#" },
      { palette: "ink", pairing: "impact", size: "hero", outline: true, motion: "zoom", box: LAYOUT.square, count: { from: 3, to: 1 }, tone: S }),
    designed("count.starting", "Countdown · Starting in", "Countdowns", 10, { text: "Starting in #" },
      { palette: "ink", pairing: "modern", size: "headline", plate: "pill", motion: "fade", box: LAYOUT.block, count: { from: 10, to: 0 }, tone: S }),
  ];
}

let cache: TitleTemplate[] | null = null;
/** Every title template, in a fixed order. */
export function titleTemplates(): TitleTemplate[] {
  return (cache ??= [...headlines(), ...lowerThirds(), ...others(), ...packTitleTemplates()]);
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
