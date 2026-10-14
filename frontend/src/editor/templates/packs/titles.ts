/**
 * More title templates (docs/EDITOR.md §15.3, presets-pack): nine categories — gaming, wedding, corporate, real
 * estate, food, travel, fitness, education and podcast — each one family built from the design system
 * (templates/design.ts): one palette system, one font pairing set, the shared layouts on the 8 px grid inside title
 * safe, the type scale and the motion presets. Each category has two headline styles × two entrances, a lower third ×
 * two entrances and one signature piece (7 each, 63 in all); the ids are generated and stable. Serious categories
 * (wedding, corporate, real estate, education, podcast, travel) use only the calm moves. Pure; titles.ts appends these
 * to titleTemplates().
 */
import { designed, gridBox, LAYOUT, palette, RADIUS, STROKE, type DesignOpts, type MotionId } from "../design.ts";
import type { TitleTemplate } from "../titles.ts";

export type PackTitleCategory = "Gaming" | "Wedding" | "Corporate" | "Real estate" | "Food" | "Travel" | "Fitness" | "Education" | "Podcast";
export const PACK_TITLE_CATEGORIES: PackTitleCategory[] = ["Gaming", "Wedding", "Corporate", "Real estate", "Food", "Travel", "Fitness", "Education", "Podcast"];

/** The renderer's entrance ids (they name the templates) → the motion presets. */
const MOTION_OF: Record<string, MotionId> = {
  fade: "fade", rise: "rise", slide_left: "slide", wipe: "wipe", blur: "blur", zoom: "zoom", tracking: "reveal", typewriter: "type",
  pop: "pop", bounce: "bounce", glitch: "glitch",
};
const ANIM_LABEL: Record<string, string> = {
  fade: "Fade", rise: "Rise", pop: "Pop", typewriter: "Typewriter", blur: "Blur in", zoom: "Zoom", wipe: "Wipe", bounce: "Bounce",
  slide_left: "Slide", glitch: "Glitch", tracking: "Tracking",
};

type Look = Omit<DesignOpts, "motion" | "box">;
interface Design { id: string; name: string; opts: Look; sub?: string }
interface Category {
  cat: PackTitleCategory; key: string; tone: "serious" | "expressive"; text: string;
  heads: [Design, Design]; headAnims: [string, string];
  lower: { id: string; name: string; text: string; sub: string; opts: Omit<Look, "size"> }; lowerAnims: [string, string];
  extra: { id: string; name: string; seconds: number; fields: TitleTemplate["fields"]; opts: DesignOpts };
}

const plum = palette("plum"), terracotta = palette("terracotta");

const CATEGORIES: Category[] = [
  { cat: "Gaming", key: "gaming", tone: "expressive", text: "Game On",
    heads: [
      { id: "neon", name: "Neon", opts: { palette: "plum", pairing: "athletic", size: "display", upper: true, tracking: 0.06, glow: 28 } },
      { id: "arcade", name: "Arcade", opts: { palette: "plum", pairing: "impact", size: "hero", upper: true, gradient: true, outline: true } },
    ], headAnims: ["glitch", "zoom"],
    lower: { id: "player", name: "Player card", text: "ShadowStrike", sub: "Level 42 · Streamer", opts: { palette: "plum", pairing: "athletic", plate: "split", upper: true } },
    lowerAnims: ["slide_left", "wipe"],
    extra: { id: "victory", name: "Victory burst", seconds: 3, fields: { text: "VICTORY!" },
      opts: { palette: "plum", pairing: "impact", size: "headline", motion: "spin", box: LAYOUT.square, color: plum.onAccent,
        shape: { kind: "burst", fill: plum.accent, stroke: plum.bg, strokeWidth: STROKE.thin } } } },
  { cat: "Wedding", key: "wedding", tone: "serious", text: "Ananya & Rohan",
    heads: [
      { id: "script", name: "Script", sub: "12 · 12 · 2026", opts: { palette: "navy_gold", pairing: "romance", size: "display" } },
      { id: "gold", name: "Gold serif", opts: { palette: "navy_gold", pairing: "cinematic", size: "headline", upper: true, tracking: 0.12, gradient: true } },
    ], headAnims: ["fade", "blur"],
    lower: { id: "names", name: "Elegant names", text: "Ananya & Rohan", sub: "The wedding · Udaipur", opts: { palette: "ivory", pairing: "editorial", plate: "box" } },
    lowerAnims: ["fade", "rise"],
    extra: { id: "save_the_date", name: "Save the date", seconds: 5, fields: { text: "Save the Date", sub: "December 12, 2026" },
      opts: { palette: "navy_gold", pairing: "cinematic", size: "headline", plate: "lines", upper: true, tracking: 0.18, motion: "fade", box: LAYOUT.head } } },
  { cat: "Corporate", key: "corporate", tone: "serious", text: "Quarterly Results",
    heads: [
      { id: "clean", name: "Clean", opts: { palette: "ink", pairing: "modern", size: "display", plate: "underline" } },
      { id: "bold", name: "Bold", opts: { palette: "ink", pairing: "modern", size: "headline", plate: "bar", upper: true, tracking: 0.04 } },
    ], headAnims: ["slide_left", "fade"],
    lower: { id: "speaker", name: "Speaker", text: "Priya Menon", sub: "Chief Financial Officer", opts: { palette: "ink", pairing: "modern", plate: "box" } },
    lowerAnims: ["wipe", "slide_left"],
    extra: { id: "key_figure", name: "Key figure", seconds: 4, fields: { text: "48%", sub: "Growth this quarter" },
      opts: { palette: "ink", pairing: "modern", size: "hero", gradient: true, motion: "zoom", box: LAYOUT.centre } } },
  { cat: "Real estate", key: "real_estate", tone: "serious", text: "Your Dream Home",
    heads: [
      { id: "luxury", name: "Luxury", sub: "Private villas · Goa", opts: { palette: "navy_gold", pairing: "luxury", size: "headline", upper: true, tracking: 0.08 } },
      { id: "modern", name: "Modern", opts: { palette: "navy_gold", pairing: "modern", size: "headline", plate: "box", upper: true, tracking: 0.1 } },
    ], headAnims: ["fade", "rise"],
    lower: { id: "listing", name: "Listing", text: "3 BHK · Sea view", sub: "Bandra West, Mumbai", opts: { palette: "navy_gold", pairing: "modern", plate: "split" } },
    lowerAnims: ["slide_left", "wipe"],
    extra: { id: "price_tag", name: "Price tag", seconds: 4, fields: { text: "₹ 2.4 Cr", sub: "Just listed" },
      opts: { palette: "navy_gold", pairing: "friendly", role: "text", size: "headline", plate: "accent", motion: "fade", box: LAYOUT.block } } },
  { cat: "Food", key: "food", tone: "expressive", text: "Today's Special",
    heads: [
      { id: "chalk", name: "Chalk", opts: { palette: "terracotta", pairing: "handmade", size: "display" } },
      { id: "bistro", name: "Bistro", opts: { palette: "terracotta", pairing: "display_serif", size: "display", plate: "underline" } },
    ], headAnims: ["pop", "bounce"],
    lower: { id: "recipe", name: "Recipe card", text: "Butter Chicken", sub: "Prep 20 min · Serves 4", opts: { palette: "terracotta", pairing: "friendly", plate: "pill" } },
    lowerAnims: ["slide_left", "rise"],
    extra: { id: "tip", name: "Chef's tip bubble", seconds: 4, fields: { text: "Add a pinch of salt!" },
      opts: { palette: "terracotta", pairing: "friendly", size: "title", motion: "pop", box: gridBox(576, 216, 768, 328), color: terracotta.onAccent,
        shape: { kind: "callout", fill: terracotta.text, stroke: terracotta.bg, strokeWidth: STROKE.thin, radius: RADIUS.lg } } } },
  { cat: "Travel", key: "travel", tone: "serious", text: "Wander More",
    heads: [
      { id: "postcard", name: "Postcard", opts: { palette: "ocean", pairing: "poster", size: "display", gradient: true } },
      { id: "explorer", name: "Explorer", opts: { palette: "ocean", pairing: "condensed", size: "display", plate: "lines", upper: true, tracking: 0.12 } },
    ], headAnims: ["zoom", "tracking"],
    lower: { id: "location", name: "Location", text: "Leh, Ladakh", sub: "Day 3 · 3,500 m", opts: { palette: "ocean", pairing: "newsroom", plate: "bracket", upper: true, tracking: 0.05 } },
    lowerAnims: ["slide_left", "wipe"],
    extra: { id: "next_stop", name: "Next stop", seconds: 4, fields: { text: "Next stop: Goa" },
      opts: { palette: "ocean", pairing: "modern", size: "headline", plate: "accent", motion: "drop", box: LAYOUT.block } } },
  { cat: "Fitness", key: "fitness", tone: "expressive", text: "No Excuses",
    heads: [
      { id: "power", name: "Power", opts: { palette: "emerald", pairing: "impact", size: "hero", upper: true, outline: true } },
      { id: "sport", name: "Sport", opts: { palette: "emerald", pairing: "athletic", size: "display", plate: "slash", upper: true } },
    ], headAnims: ["pop", "slide_left"],
    lower: { id: "workout", name: "Workout", text: "Burpees", sub: "3 sets · 12 reps", opts: { palette: "emerald", pairing: "athletic", plate: "split", upper: true } },
    lowerAnims: ["slide_left", "wipe"],
    extra: { id: "interval", name: "Interval timer", seconds: 30, fields: { text: "#" },
      opts: { palette: "emerald", pairing: "newsroom", size: "hero", plate: "ring", motion: "zoom", box: LAYOUT.square, count: { from: 30, to: 0 } } } },
  { cat: "Education", key: "education", tone: "serious", text: "Lesson One",
    heads: [
      { id: "lesson", name: "Lesson", opts: { palette: "amber", pairing: "friendly", size: "display", plate: "underline" } },
      { id: "chalkboard", name: "Chalkboard", opts: { palette: "amber", pairing: "friendly", size: "headline", plate: "box" } },
    ], headAnims: ["typewriter", "rise"],
    lower: { id: "teacher", name: "Teacher", text: "Dr. Kavya Iyer", sub: "Physics · Class 11", opts: { palette: "amber", pairing: "modern", plate: "bar" } },
    lowerAnims: ["slide_left", "rise"],
    extra: { id: "key_term", name: "Key term", seconds: 6, fields: { text: "Photosynthesis", sub: "How plants make food from light" },
      opts: { palette: "amber", pairing: "modern", size: "headline", plate: "glass", motion: "rise", box: LAYOUT.centre } } },
  { cat: "Podcast", key: "podcast", tone: "serious", text: "The Long Game",
    heads: [
      { id: "episode", name: "Episode", sub: "Episode 12", opts: { palette: "ink", pairing: "newsroom", size: "headline", plate: "bracket", upper: true, tracking: 0.08 } },
      { id: "studio", name: "Studio", opts: { palette: "ink", pairing: "modern", size: "display", gradient: true } },
    ], headAnims: ["fade", "wipe"],
    lower: { id: "guest", name: "Guest", text: "Arjun Sharma", sub: "Founder, Chai Labs", opts: { palette: "ink", pairing: "modern", plate: "glass" } },
    lowerAnims: ["slide_left", "wipe"],
    extra: { id: "now_playing", name: "Now playing", seconds: 6, fields: { text: "Episode 12 · The Long Game", sub: "Listen wherever you get podcasts" },
      opts: { palette: "ink", pairing: "modern", size: "title", plate: "pill", motion: "slide", box: LAYOUT.lowerWide, align: "left" } } },
];

/** The pack's templates, in a fixed order (category by category: headlines, lower thirds, the signature piece). */
export function packTitleTemplates(): TitleTemplate[] {
  const out: TitleTemplate[] = [];
  for (const c of CATEGORIES) {
    for (const d of c.heads) for (const a of c.headAnims) out.push(designed(`${c.key}.${d.id}.${a}`, `${d.name} · ${ANIM_LABEL[a] ?? a}`, c.cat, 4,
      { text: c.text, ...(d.sub ? { sub: d.sub } : {}) }, { ...d.opts, motion: MOTION_OF[a], box: LAYOUT.head, tone: c.tone }));
    const lw = c.lower;
    for (const a of c.lowerAnims) out.push(designed(`${c.key}.lower.${a}`, `${lw.name} · ${ANIM_LABEL[a] ?? a}`, c.cat, 5, { text: lw.text, sub: lw.sub },
      { ...lw.opts, size: "title", motion: MOTION_OF[a], box: LAYOUT.lower, align: "left", tone: c.tone }));
    out.push(designed(`${c.key}.${c.extra.id}`, c.extra.name, c.cat, c.extra.seconds, c.extra.fields, { ...c.extra.opts, tone: c.tone }));
  }
  return out;
}
