/**
 * Ready-made layouts. Each template builds a full layer stack from proportions, so it fits any size. Empty image slots
 * (src "") show a drop zone on the canvas; AI or a drag from the panels fills them. Brand kits recolour and re-font.
 */
import { newEffect, newImage, newShape, newText, uid } from "./doc";
import type { DesignDoc, EffectLayer, ImageLayer, Layer, Role, ShapeLayer, TextLayer } from "./types";

export type TemplateCategory = "Film" | "Series" | "YouTube" | "Social" | "Ads" | "Festival" | "Events";

export interface BrandInput {
  colors: string[];
  headingFont?: string;
  bodyFont?: string;
  logo?: { src: string; asset?: string; width: number; height: number } | null;
  tagline?: string;
  cta?: string;
}

export interface TemplateCtx {
  width: number;
  height: number;
  title?: string;
  tagline?: string;
  credits?: string;
  cta?: string;
  badge?: string;
  palette?: string[];
  brand?: BrandInput | null;
}

export interface Template {
  key: string;
  label: string;
  category: TemplateCategory;
  description: string;
  /** best-fit format keys (any size works) */
  formats: string[];
  /** two colours for the gallery card before a live preview renders */
  swatch: [string, string];
  /** what to ask the AI for when filling the background slot */
  backgroundPrompt: string;
  build: (ctx: TemplateCtx) => DesignDoc;
}

// ── helpers ──────────────────────────────────────────────

/** Add transparency to a #rrggbb colour (other colour formats are returned as they are). */
const al = (c: string, aa: string) => (/^#[0-9a-f]{6}$/i.test(c) ? `${c}${aa}` : c);

function kit(ctx: TemplateCtx, fallback: string[]) {
  const pal = ctx.palette?.length ? ctx.palette : ctx.brand?.colors?.length ? ctx.brand.colors : fallback;
  return { pal, a: pal[1] ?? fallback[1], b: pal[2] ?? pal[1] ?? fallback[2], dark: pal[0] ?? fallback[0], light: pal[3] ?? "#f8fafc" };
}

function slot(name: string, slotKey: string, role: Role, x: number, y: number, w: number, h: number, extra: Partial<ImageLayer> = {}): ImageLayer {
  const l = newImage("", 1, 1, w, h, { role, name, cover: role === "background" });
  return { ...l, id: uid("i"), x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h), slot: slotKey,
    fit: role === "background" ? "cover" : "contain", naturalWidth: undefined, naturalHeight: undefined, ...extra };
}

function txt(preset: Parameters<typeof newText>[0], W: number, H: number, box: { x: number; y: number; w: number; h: number },
  over: Partial<TextLayer>, ctx: TemplateCtx): TextLayer {
  const t = newText(preset, W, H, over);
  const heading = preset === "title" || preset === "devanagari";
  const fam = heading ? ctx.brand?.headingFont : preset === "body" || preset === "credits" ? ctx.brand?.bodyFont : undefined;
  return { ...t, id: uid("t"), x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.w), height: Math.round(box.h),
    ...(fam ? { fontFamily: fam } : {}), ...over, ...(fam && !over.fontFamily ? { fontFamily: fam } : {}) };
}

function logoLayer(ctx: TemplateCtx, W: number, H: number, corner: "tl" | "tr" | "bl" | "br" | "bc", size = 0.12): Layer[] {
  const logo = ctx.brand?.logo;
  if (!logo) return [];
  const s = Math.min(W, H) * size;
  const k = Math.min(s / logo.width, s / logo.height);
  const w = logo.width * k, h = logo.height * k, m = Math.min(W, H) * 0.05;
  const x = corner.includes("l") ? m : corner === "bc" ? (W - w) / 2 : W - w - m;
  const y = corner.startsWith("t") ? m : H - h - m;
  return [{ ...newImage(logo.src, logo.width, logo.height, W, H, { asset: logo.asset, role: "logo", name: "Logo" }),
    x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h), slot: "logo" }];
}

const doc = (bg: string, layers: Layer[], gradient: DesignDoc["background"]["gradient"] = null, palette?: string[]): DesignDoc =>
  ({ v: 1, background: { color: bg, gradient }, layers, meta: palette ? { palette } : undefined });

const fx = (e: EffectLayer["effect"], W: number, H: number, over: Partial<EffectLayer> = {}) => ({ ...newEffect(e, W, H, over), id: uid("e") });
const sh = (k: ShapeLayer["shape"], W: number, H: number, over: Partial<ShapeLayer>) => ({ ...newShape(k, W, H, over), id: uid("s") });

// ── templates ────────────────────────────────────────────

export const TEMPLATES: Template[] = [
  {
    key: "film_onesheet", label: "Cinematic one-sheet", category: "Film", formats: ["film_poster", "a3_poster", "story"],
    description: "Hero over a moody scene, giant title, tagline up top, billing block and release badge at the foot.",
    swatch: ["#0b0f17", "#f59e0b"], backgroundPrompt: "Moody cinematic establishing scene, dusk, haze, deep shadows, room for a title",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, dark } = kit(ctx, ["#05070b", "#f59e0b", "#22d3ee", "#f8fafc"]);
      return doc(dark, [
        slot("Background scene", "background", "background", 0, 0, W, H),
        slot("Hero character", "hero", "character", W * 0.12, H * 0.16, W * 0.76, H * 0.62),
        fx("fade", W, H, { color: dark, intensity: 0.95, angle: 90, name: "Fade to base" }),
        fx("vignette", W, H, { intensity: 0.6 }),
        txt("subtitle", W, H, { x: W * 0.1, y: H * 0.045, w: W * 0.8, h: S * 0.06 }, { text: ctx.tagline ?? "Some lights refuse to go out.",
          uppercase: true, letterSpacing: S * 0.006, fontWeight: 500, fontSize: Math.round(S * 0.032), fill: "#e5e7eb", role: "tagline", slot: "tagline" }, ctx),
        txt("title", W, H, { x: W * 0.06, y: H * 0.7, w: W * 0.88, h: H * 0.14 }, { text: ctx.title ?? "THE LAST LIGHT", fontSize: Math.round(S * 0.17),
          fill: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: a }] }, slot: "title" }, ctx),
        txt("badge", W, H, { x: W * 0.32, y: H * 0.845, w: W * 0.36, h: S * 0.05 }, { text: ctx.badge ?? "IN CINEMAS 14 NOV", fontSize: Math.round(S * 0.026),
          background: { color: a, padding: Math.round(S * 0.012), radius: Math.round(S * 0.006) }, fill: dark, slot: "badge" }, ctx),
        txt("credits", W, H, { x: W * 0.09, y: H * 0.9, w: W * 0.82, h: H * 0.07 }, { ...(ctx.credits ? { text: ctx.credits } : {}), slot: "credits" }, ctx),
        fx("grain", W, H, { intensity: 0.14 }),
        ...logoLayer(ctx, W, H, "tr", 0.1),
      ], null, pal);
    },
  },
  {
    key: "character_spotlight", label: "Character spotlight", category: "Film", formats: ["film_poster", "ig_post", "story"],
    description: "One character cut out in front of a giant outlined name and a coloured glow. Great for cast reveals.",
    swatch: ["#111827", "#e11d48"], backgroundPrompt: "Abstract smoky studio backdrop with coloured rim light",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, b, dark } = kit(ctx, ["#0a0a12", "#e11d48", "#f97316", "#fafafa"]);
      const name = (ctx.title ?? "MEERA").toUpperCase();
      return doc(dark, [
        sh("ellipse", W, H, { name: "Glow", x: W * 0.05, y: H * 0.12, width: W * 0.9, height: W * 0.9, fill: { type: "radial", angle: 0,
          stops: [{ offset: 0, color: a }, { offset: 0.55, color: al(a, "55") }, { offset: 1, color: al(dark, "00") }] }, role: "decor", locked: true }),
        txt("title", W, H, { x: -W * 0.05, y: H * 0.16, w: W * 1.1, h: H * 0.3 }, { text: name, fontSize: Math.round(S * 0.32), fill: al(b, "00"),
          stroke: { color: b, width: Math.max(2, Math.round(S * 0.004)) }, shadow: null, autoFit: true, name: "Name outline", slot: "name_back" }, ctx),
        slot("Character cut-out", "hero", "character", W * 0.14, H * 0.18, W * 0.72, H * 0.74),
        fx("fade", W, H, { color: dark, intensity: 0.85, angle: 90 }),
        txt("title", W, H, { x: W * 0.08, y: H * 0.8, w: W * 0.84, h: H * 0.09 }, { text: name, fontSize: Math.round(S * 0.1), fill: "#ffffff", slot: "title" }, ctx),
        txt("subtitle", W, H, { x: W * 0.15, y: H * 0.895, w: W * 0.7, h: S * 0.05 }, { text: ctx.tagline ?? "THE KEEPER OF THE FLAME", fill: a,
          fontSize: Math.round(S * 0.03), slot: "tagline" }, ctx),
        fx("grain", W, H, { intensity: 0.12 }),
        ...logoLayer(ctx, W, H, "tl", 0.09),
      ], null, pal);
    },
  },
  {
    key: "minimal_title", label: "Minimal typographic", category: "Film", formats: ["film_poster", "a4_flyer", "square"],
    description: "Elegant serif title on a deep gradient with fine rules. Festival-selection energy.",
    swatch: ["#1c1917", "#d6d3d1"], backgroundPrompt: "",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, dark } = kit(ctx, ["#1c1917", "#d4af37", "#78716c", "#fafaf9"]);
      return doc(dark, [
        sh("rect", W, H, { name: "Top rule", x: W * 0.2, y: H * 0.36, width: W * 0.6, height: Math.max(2, S * 0.002), fill: a, cornerRadius: 0 }),
        txt("title", W, H, { x: W * 0.08, y: H * 0.39, w: W * 0.84, h: H * 0.16 }, { text: ctx.title ?? "The Last Light", uppercase: false,
          fontFamily: "Playfair Display Variable", fontWeight: 700, fontStyle: "italic", fontSize: Math.round(S * 0.13), letterSpacing: 0,
          fill: "#fafaf9", shadow: null, slot: "title" }, ctx),
        sh("rect", W, H, { name: "Bottom rule", x: W * 0.2, y: H * 0.57, width: W * 0.6, height: Math.max(2, S * 0.002), fill: a, cornerRadius: 0 }),
        txt("subtitle", W, H, { x: W * 0.15, y: H * 0.6, w: W * 0.7, h: S * 0.05 }, { text: ctx.tagline ?? "A FILM IN FIVE LANGUAGES",
          fill: a, fontSize: Math.round(S * 0.026), slot: "tagline" }, ctx),
        txt("credits", W, H, { x: W * 0.12, y: H * 0.86, w: W * 0.76, h: H * 0.07 }, { fill: "#a8a29e", ...(ctx.credits ? { text: ctx.credits } : {}), slot: "credits" }, ctx),
        fx("grain", W, H, { intensity: 0.1 }),
        ...logoLayer(ctx, W, H, "bc", 0.08),
      ], { type: "radial", angle: 0, stops: [{ offset: 0, color: "#3f3a36" }, { offset: 1, color: dark }] }, pal);
    },
  },
  {
    key: "youtube_thumbnail", label: "YouTube thumbnail", category: "YouTube", formats: ["yt_thumbnail", "ott_landscape", "landscape"],
    description: "Huge two-line hook with a heavy outline, face on the right, arrow and episode badge. Built to be read at a glance.",
    swatch: ["#facc15", "#dc2626"], backgroundPrompt: "Vibrant dramatic background scene, high contrast, blurred depth",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, b, dark } = kit(ctx, ["#0b0b0b", "#facc15", "#dc2626", "#ffffff"]);
      return doc(dark, [
        slot("Background", "background", "background", 0, 0, W, H, { filters: { brightness: -0.12, blur: 2 } }),
        sh("rect", W, H, { name: "Left shade", x: 0, y: 0, width: W * 0.62, height: H, fill: { type: "linear", angle: 0,
          stops: [{ offset: 0, color: al(dark, "ee") }, { offset: 1, color: al(dark, "00") }] }, cornerRadius: 0, locked: true }),
        slot("Face / character", "hero", "character", W * 0.52, H * 0.04, W * 0.5, H * 0.98),
        txt("title", W, H, { x: W * 0.04, y: H * 0.1, w: W * 0.58, h: H * 0.5 }, { text: ctx.title ?? "IT MOVED\nBY ITSELF", fontSize: Math.round(S * 0.22),
          fill: "#ffffff", stroke: { color: dark, width: Math.round(S * 0.012) }, lineHeight: 0.92, align: "left", autoFit: true, slot: "title",
          shadow: { color: "#000000", blur: Math.round(S * 0.03), x: 0, y: Math.round(S * 0.012), opacity: 0.8 } }, ctx),
        txt("cta", W, H, { x: W * 0.04, y: H * 0.66, w: W * 0.4, h: S * 0.13 }, { text: ctx.tagline ?? "REAL FOOTAGE?", fontSize: Math.round(S * 0.07),
          background: { color: a, padding: Math.round(S * 0.02), radius: Math.round(S * 0.015) }, fill: dark, rotation: -3, slot: "tagline" }, ctx),
        sh("arrow", W, H, { name: "Arrow", x: W * 0.43, y: H * 0.74, width: W * 0.14, height: S * 0.05, fill: b, rotation: -24 }),
        txt("badge", W, H, { x: W * 0.83, y: H * 0.05, w: W * 0.14, h: S * 0.1 }, { text: ctx.badge ?? "EP 5", fontSize: Math.round(S * 0.055),
          background: { color: b, padding: Math.round(S * 0.015), radius: Math.round(S * 0.012) }, fill: "#ffffff", slot: "badge" }, ctx),
      ], null, pal);
    },
  },
  {
    key: "product_ad", label: "Product ad", category: "Ads", formats: ["ig_post", "square", "story"],
    description: "Product on a halo ring, bold headline, price burst and a call-to-action button. Drop in a brand kit.",
    swatch: ["#fef3c7", "#16a34a"], backgroundPrompt: "Soft studio backdrop with natural props, premium product photography",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, b, dark } = kit(ctx, ["#fff7ed", "#16a34a", "#f97316", "#1c1917"]);
      return doc(dark, [
        sh("ellipse", W, H, { name: "Halo", x: W * 0.16, y: H * 0.26, width: W * 0.68, height: W * 0.68, fill: al(a, "26"), locked: true }),
        sh("ring", W, H, { name: "Ring", x: W * 0.12, y: H * 0.235, width: W * 0.76, height: W * 0.76, fill: a, innerRatio: 0.965 }),
        slot("Product", "product", "product", W * 0.2, H * 0.29, W * 0.6, W * 0.6, { shadow: { color: "#000000", blur: Math.round(S * 0.04), x: 0, y: Math.round(S * 0.02), opacity: 0.25 } }),
        txt("title", W, H, { x: W * 0.07, y: H * 0.05, w: W * 0.86, h: H * 0.15 }, { text: ctx.title ?? "Grandma's Mango Pickle", uppercase: false,
          fontFamily: "Montserrat Variable", fontWeight: 900, fontSize: Math.round(S * 0.085), fill: pal[3] ?? "#1c1917", shadow: null, letterSpacing: -1, slot: "title" }, ctx),
        txt("tagline", W, H, { x: W * 0.12, y: H * 0.19, w: W * 0.76, h: S * 0.06 }, { text: ctx.tagline ?? "Made in Udupi. Sun-cured for 21 days.", fontStyle: "normal",
          fontFamily: "Montserrat Variable", fontWeight: 500, fontSize: Math.round(S * 0.032), fill: "#57534e", slot: "tagline" }, ctx),
        sh("burst", W, H, { name: "Price burst", x: W * 0.7, y: H * 0.56, width: S * 0.24, height: S * 0.24, fill: b, points: 18, innerRatio: 0.84, rotation: 8 }),
        txt("badge", W, H, { x: W * 0.705, y: H * 0.56 + S * 0.08, w: S * 0.23, h: S * 0.08 }, { text: ctx.badge ?? "₹299", background: null,
          fontFamily: "Anton", fontSize: Math.round(S * 0.07), fill: "#ffffff", rotation: 8, slot: "badge" }, ctx),
        txt("cta", W, H, { x: W * 0.28, y: H * 0.86, w: W * 0.44, h: S * 0.09 }, { text: ctx.cta ?? ctx.brand?.cta ?? "ORDER ON WHATSAPP",
          background: { color: a, padding: Math.round(S * 0.022), radius: Math.round(S * 0.05) }, fill: "#ffffff", slot: "cta" }, ctx),
        ...logoLayer(ctx, W, H, "tl", 0.1),
      ], { type: "linear", angle: 90, stops: [{ offset: 0, color: "#fffbeb" }, { offset: 1, color: "#fde68a" }] }, pal);
    },
  },
  {
    key: "festival_greeting", label: "Festival greeting", category: "Festival", formats: ["square", "ig_post", "whatsapp_status"],
    description: "Warm glow, ornamental frame, a script greeting with the Hindi line underneath. Swap the festival in a click.",
    swatch: ["#7c2d12", "#fbbf24"], backgroundPrompt: "Rows of glowing diyas and marigolds at night, bokeh, warm festive light",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, dark } = kit(ctx, ["#431407", "#fbbf24", "#f97316", "#fff7ed"]);
      return doc(dark, [
        slot("Festive background", "background", "background", 0, 0, W, H, { opacity: 0.85 }),
        fx("vignette", W, H, { intensity: 0.75, color: "#1c0a02" }),
        fx("glow", W, H, { color: a, intensity: 0.45, name: "Warm glow" }),
        sh("rect", W, H, { name: "Ornate frame", x: W * 0.05, y: H * 0.05, width: W * 0.9, height: H * 0.9, fill: null,
          stroke: { color: a, width: Math.max(2, Math.round(S * 0.004)) }, cornerRadius: Math.round(S * 0.03), locked: true }),
        sh("rect", W, H, { name: "Inner frame", x: W * 0.07, y: H * 0.07, width: W * 0.86, height: H * 0.86, fill: null,
          stroke: { color: al(a, "88"), width: Math.max(1, Math.round(S * 0.0015)) }, cornerRadius: Math.round(S * 0.025), dash: [S * 0.01, S * 0.008], locked: true }),
        txt("title", W, H, { x: W * 0.08, y: H * 0.3, w: W * 0.84, h: H * 0.2 }, { text: ctx.title ?? "Happy Diwali", uppercase: false,
          fontFamily: "Great Vibes", fontSize: Math.round(S * 0.16), letterSpacing: 0, fill: { type: "linear", angle: 90,
            stops: [{ offset: 0, color: "#fff7ed" }, { offset: 1, color: a }] }, slot: "title" }, ctx),
        txt("devanagari", W, H, { x: W * 0.1, y: H * 0.52, w: W * 0.8, h: H * 0.12 }, { text: ctx.tagline ?? "शुभ दीपावली", fontSize: Math.round(S * 0.08),
          fill: a, shadow: null, slot: "tagline" }, ctx),
        txt("body", W, H, { x: W * 0.15, y: H * 0.68, w: W * 0.7, h: H * 0.08 }, { text: "May the festival of lights bring joy to your home",
          align: "center", fill: "#fed7aa", fontSize: Math.round(S * 0.03), slot: "message" }, ctx),
        ...logoLayer(ctx, W, H, "bc", 0.09),
      ], { type: "radial", angle: 0, stops: [{ offset: 0, color: "#9a3412" }, { offset: 1, color: dark }] }, pal);
    },
  },
  {
    key: "cast_lineup", label: "Cast line-up", category: "Series", formats: ["landscape", "ott_landscape", "yt_banner"],
    description: "Three characters side by side with name plates and the show title above. Ensemble announcements.",
    swatch: ["#0f172a", "#38bdf8"], backgroundPrompt: "Dark cinematic gradient backdrop with soft spotlight beams",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, dark } = kit(ctx, ["#020617", "#38bdf8", "#a78bfa", "#f8fafc"]);
      const names = ["MEERA", "RAVI", "ARJUN"];
      const cols = names.map((n, i) => {
        const cw = W * 0.28, x = W * 0.08 + i * (cw + W * 0.02);
        return [
          slot(`Character ${i + 1}`, `character_${i + 1}`, "character", x, H * 0.22, cw, H * 0.64),
          txt("subtitle", W, H, { x, y: H * 0.86, w: cw, h: S * 0.07 }, { text: n, fontFamily: "Bebas Neue", fontSize: Math.round(S * 0.06), letterSpacing: S * 0.004,
            fill: "#ffffff", fontWeight: 400, slot: `name_${i + 1}` }, ctx),
        ];
      }).flat();
      return doc(dark, [
        slot("Backdrop", "background", "background", 0, 0, W, H, { opacity: 0.7 }),
        fx("fade", W, H, { color: dark, intensity: 0.8, angle: 90 }),
        txt("title", W, H, { x: W * 0.1, y: H * 0.04, w: W * 0.8, h: H * 0.16 }, { text: ctx.title ?? "THE LAMP · SEASON 2", fontSize: Math.round(S * 0.12),
          fill: { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: a }] }, slot: "title" }, ctx),
        ...cols,
        ...logoLayer(ctx, W, H, "br", 0.1),
      ], null, pal);
    },
  },
  {
    key: "episode_card", label: "Episode card", category: "Series", formats: ["ott_landscape", "landscape", "yt_thumbnail"],
    description: "Still on the left, episode number, title and logline on a solid panel. For weekly drops.",
    swatch: ["#18181b", "#a3e635"], backgroundPrompt: "Key moment from the episode, cinematic still",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, dark } = kit(ctx, ["#09090b", "#a3e635", "#22d3ee", "#fafafa"]);
      return doc(dark, [
        slot("Episode still", "background", "photo", 0, 0, W * 0.58, H, { fit: "cover" }),
        sh("rect", W, H, { name: "Panel", x: W * 0.52, y: 0, width: W * 0.48, height: H, fill: { type: "linear", angle: 0,
          stops: [{ offset: 0, color: al(dark, "00") }, { offset: 0.18, color: dark }, { offset: 1, color: dark }] }, cornerRadius: 0, locked: true }),
        txt("badge", W, H, { x: W * 0.6, y: H * 0.18, w: W * 0.2, h: S * 0.08 }, { text: ctx.badge ?? "EPISODE 03", align: "left", fill: dark,
          background: { color: a, padding: Math.round(S * 0.015), radius: Math.round(S * 0.008) }, fontSize: Math.round(S * 0.045), slot: "badge" }, ctx),
        txt("title", W, H, { x: W * 0.6, y: H * 0.3, w: W * 0.36, h: H * 0.3 }, { text: ctx.title ?? "WHAT THE FLAME SAW", align: "left",
          fontSize: Math.round(S * 0.11), fill: "#ffffff", autoFit: true, slot: "title" }, ctx),
        txt("body", W, H, { x: W * 0.6, y: H * 0.62, w: W * 0.34, h: H * 0.18 }, { text: ctx.tagline ?? "The priest returns at midnight and finds the lamp lit, the doors barred from inside.",
          fill: "#d4d4d8", fontSize: Math.round(S * 0.034), slot: "logline" }, ctx),
        txt("cta", W, H, { x: W * 0.6, y: H * 0.84, w: W * 0.24, h: S * 0.08 }, { text: ctx.cta ?? "NEW EVERY FRIDAY", align: "left",
          background: null, fill: a, fontSize: Math.round(S * 0.03), letterSpacing: S * 0.004, slot: "cta" }, ctx),
        ...logoLayer(ctx, W, H, "tr", 0.09),
      ], null, pal);
    },
  },
  {
    key: "event_flyer", label: "Event flyer", category: "Events", formats: ["a4_flyer", "ig_post", "story"],
    description: "Premiere, launch or screening: big date block, title, venue details and an RSVP button.",
    swatch: ["#1e1b4b", "#f472b6"], backgroundPrompt: "Red carpet premiere night, spotlights, bokeh crowd",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, b, dark } = kit(ctx, ["#1e1b4b", "#f472b6", "#818cf8", "#ffffff"]);
      return doc(dark, [
        slot("Event photo", "background", "background", 0, 0, W, H * 0.55, { fit: "cover", mask: "fade-bottom" }),
        txt("subtitle", W, H, { x: W * 0.08, y: H * 0.5, w: W * 0.84, h: S * 0.06 }, { text: ctx.tagline ?? "YOU'RE INVITED TO THE PREMIERE", fill: a,
          fontSize: Math.round(S * 0.035), slot: "tagline" }, ctx),
        txt("title", W, H, { x: W * 0.06, y: H * 0.56, w: W * 0.88, h: H * 0.14 }, { text: ctx.title ?? "THE LAST LIGHT", fontSize: Math.round(S * 0.13),
          fill: "#ffffff", slot: "title" }, ctx),
        sh("rect", W, H, { name: "Date block", x: W * 0.08, y: H * 0.73, width: W * 0.26, height: H * 0.13, fill: { type: "linear", angle: 45,
          stops: [{ offset: 0, color: a }, { offset: 1, color: b }] }, cornerRadius: Math.round(S * 0.02) }),
        txt("title", W, H, { x: W * 0.08, y: H * 0.735, w: W * 0.26, h: H * 0.07 }, { text: "14", fontSize: Math.round(S * 0.08), fill: "#ffffff", shadow: null,
          autoFit: false, name: "Day", slot: "day" }, ctx),
        txt("subtitle", W, H, { x: W * 0.08, y: H * 0.805, w: W * 0.26, h: H * 0.04 }, { text: "NOVEMBER", fontSize: Math.round(S * 0.028), fill: "#ffffff",
          name: "Month", slot: "month" }, ctx),
        txt("body", W, H, { x: W * 0.4, y: H * 0.73, w: W * 0.52, h: H * 0.13 }, { text: "7:00 PM onwards\nPVR Forum Mall, Bengaluru\nDress code: festive black",
          fill: "#e0e7ff", fontSize: Math.round(S * 0.032), lineHeight: 1.5, slot: "details" }, ctx),
        txt("cta", W, H, { x: W * 0.3, y: H * 0.895, w: W * 0.4, h: S * 0.08 }, { text: ctx.cta ?? "RSVP NOW",
          background: { color: "#ffffff", padding: Math.round(S * 0.02), radius: Math.round(S * 0.04) }, fill: dark, slot: "cta" }, ctx),
        ...logoLayer(ctx, W, H, "tr", 0.09),
      ], null, pal);
    },
  },
  {
    key: "quote_card", label: "Quote card", category: "Social", formats: ["square", "ig_post", "whatsapp_status"],
    description: "A line from the film in a big serif, giant quote marks and the character's name. Perfect for promos.",
    swatch: ["#0c4a6e", "#e0f2fe"], backgroundPrompt: "Soft blurred still from the film, muted colours",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, dark } = kit(ctx, ["#082f49", "#38bdf8", "#f0abfc", "#f0f9ff"]);
      return doc(dark, [
        slot("Background still", "background", "background", 0, 0, W, H, { filters: { blur: 8, brightness: -0.25 }, opacity: 0.6 }),
        txt("title", W, H, { x: W * 0.06, y: H * 0.08, w: W * 0.3, h: H * 0.25 }, { text: "“", uppercase: false, fontFamily: "DM Serif Display",
          fontSize: Math.round(S * 0.45), fill: a, shadow: null, align: "left", name: "Quote mark", autoFit: false, slot: "mark" }, ctx),
        txt("quote", W, H, { x: W * 0.1, y: H * 0.3, w: W * 0.8, h: H * 0.38 }, { text: ctx.title ?? "The flame remembers every prayer we were too afraid to say aloud.",
          fill: "#f0f9ff", fontSize: Math.round(S * 0.062), align: "left", slot: "quote" }, ctx),
        sh("rect", W, H, { name: "Rule", x: W * 0.1, y: H * 0.72, width: W * 0.12, height: Math.max(3, S * 0.006), fill: a, cornerRadius: 2 }),
        txt("subtitle", W, H, { x: W * 0.1, y: H * 0.75, w: W * 0.6, h: S * 0.06 }, { text: ctx.tagline ?? "MEERA · THE LAST LIGHT", align: "left", fill: a,
          fontSize: Math.round(S * 0.03), slot: "author" }, ctx),
        ...logoLayer(ctx, W, H, "br", 0.09),
      ], { type: "linear", angle: 135, stops: [{ offset: 0, color: "#0c4a6e" }, { offset: 1, color: dark }] }, pal);
    },
  },
  {
    key: "teaser_silhouette", label: "Teaser: coming soon", category: "Film", formats: ["film_poster", "story", "ig_post"],
    description: "A silhouette half lost in the dark, one cryptic line and a date. Builds mystery before the full reveal.",
    swatch: ["#030712", "#ef4444"], backgroundPrompt: "Lone silhouette against a single shaft of light in thick fog, almost black, high contrast",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, dark } = kit(ctx, ["#030712", "#ef4444", "#f97316", "#f8fafc"]);
      return doc(dark, [
        slot("Silhouette scene", "background", "background", 0, 0, W, H, { filters: { brightness: -0.15, contrast: 15 } }),
        fx("vignette", W, H, { intensity: 0.85 }),
        fx("fade", W, H, { color: dark, intensity: 0.9, angle: 90 }),
        sh("rect", W, H, { name: "Accent rule", x: W * 0.45, y: H * 0.6, width: W * 0.1, height: Math.max(3, Math.round(S * 0.004)), fill: a, cornerRadius: 0 }),
        txt("tagline", W, H, { x: W * 0.1, y: H * 0.625, w: W * 0.8, h: S * 0.07 }, { text: ctx.tagline ?? "Every light hides a shadow.", fill: "#e5e7eb",
          fontSize: Math.round(S * 0.036), slot: "tagline" }, ctx),
        txt("title", W, H, { x: W * 0.06, y: H * 0.71, w: W * 0.88, h: H * 0.11 }, { text: ctx.title ?? "THE LAST LIGHT", fontFamily: "Cinzel Variable",
          fontWeight: 700, fontSize: Math.round(S * 0.095), letterSpacing: Math.round(S * 0.015), fill: "#f8fafc", slot: "title" }, ctx),
        txt("subtitle", W, H, { x: W * 0.2, y: H * 0.845, w: W * 0.6, h: S * 0.05 }, { text: ctx.badge ?? "COMING SOON", fill: a,
          fontSize: Math.round(S * 0.03), letterSpacing: Math.round(S * 0.012), slot: "badge" }, ctx),
        fx("grain", W, H, { intensity: 0.2 }),
        ...logoLayer(ctx, W, H, "bc", 0.07),
      ], null, pal);
    },
  },
  {
    key: "yt_versus", label: "Versus thumbnail", category: "YouTube", formats: ["yt_thumbnail", "ott_landscape", "landscape"],
    description: "Two faces on split colours with a blazing VS burst between them. Face-offs, debates and comparisons.",
    swatch: ["#1d4ed8", "#dc2626"], backgroundPrompt: "",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, b, dark } = kit(ctx, ["#0b0b0b", "#2563eb", "#dc2626", "#ffffff"]);
      const r = S * 0.17;
      return doc(dark, [
        sh("rect", W, H, { name: "Left side", x: 0, y: 0, width: W * 0.5, height: H, cornerRadius: 0, locked: true,
          fill: { type: "linear", angle: 0, stops: [{ offset: 0, color: a }, { offset: 1, color: al(a, "bb") }] } }),
        sh("rect", W, H, { name: "Right side", x: W * 0.5, y: 0, width: W * 0.5, height: H, cornerRadius: 0, locked: true,
          fill: { type: "linear", angle: 0, stops: [{ offset: 0, color: al(b, "bb") }, { offset: 1, color: b }] } }),
        slot("Left face", "character_1", "character", W * 0.02, H * 0.06, W * 0.44, H * 0.94),
        slot("Right face", "character_2", "character", W * 0.54, H * 0.06, W * 0.44, H * 0.94),
        sh("burst", W, H, { name: "VS burst", x: W * 0.5 - r, y: H * 0.42 - r, width: r * 2, height: r * 2, fill: "#facc15", points: 14, innerRatio: 0.72 }),
        txt("title", W, H, { x: W * 0.5 - r, y: H * 0.42 - r * 0.6, w: r * 2, h: r * 1.2 }, { text: "VS", fontSize: Math.round(S * 0.15), fill: dark,
          shadow: null, autoFit: false, name: "VS", slot: "vs" }, ctx),
        txt("title", W, H, { x: W * 0.04, y: H * 0.76, w: W * 0.92, h: H * 0.2 }, { text: ctx.title ?? "WHO WINS?", fontSize: Math.round(S * 0.15),
          fill: "#ffffff", stroke: { color: dark, width: Math.round(S * 0.01) }, slot: "title" }, ctx),
      ], null, pal);
    },
  },
  {
    key: "sale_banner", label: "Sale announcement", category: "Ads", formats: ["square", "ig_post", "story", "fb_cover"],
    description: "A giant discount, the product on a colour blob, the offer details and a shop-now button.",
    swatch: ["#4c1d95", "#facc15"], backgroundPrompt: "Bright festive shopping backdrop, confetti, soft gradient, empty product podium",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, b, dark } = kit(ctx, ["#2e1065", "#facc15", "#ec4899", "#ffffff"]);
      return doc(dark, [
        sh("ellipse", W, H, { name: "Colour blob", x: W * 0.4, y: H * 0.28, width: S * 0.72, height: S * 0.72, fill: al(b, "cc"), locked: true }),
        slot("Product", "product", "product", W * 0.44, H * 0.32, W * 0.5, H * 0.5, { shadow: { color: "#000000", blur: Math.round(S * 0.04), x: 0,
          y: Math.round(S * 0.02), opacity: 0.3 } }),
        txt("subtitle", W, H, { x: W * 0.06, y: H * 0.07, w: W * 0.62, h: S * 0.06 }, { text: ctx.tagline ?? "FESTIVE SALE · 3 DAYS ONLY", align: "left", fill: a,
          fontSize: Math.round(S * 0.032), slot: "tagline" }, ctx),
        txt("title", W, H, { x: W * 0.05, y: H * 0.14, w: W * 0.56, h: H * 0.36 }, { text: ctx.title ?? "FLAT\n50%\nOFF", align: "left",
          fontSize: Math.round(S * 0.16), lineHeight: 0.92, fill: "#ffffff", slot: "title" }, ctx),
        txt("body", W, H, { x: W * 0.06, y: H * 0.53, w: W * 0.36, h: H * 0.16 }, { text: "On every jar, pickle and podi.\nFree delivery over ₹499.",
          fill: "#ede9fe", fontSize: Math.round(S * 0.028), slot: "details" }, ctx),
        txt("cta", W, H, { x: W * 0.06, y: H * 0.79, w: W * 0.4, h: S * 0.09 }, { text: ctx.cta ?? ctx.brand?.cta ?? "SHOP NOW",
          background: { color: a, padding: Math.round(S * 0.022), radius: Math.round(S * 0.05) }, fill: dark, slot: "cta" }, ctx),
        txt("badge", W, H, { x: W * 0.06, y: H * 0.91, w: W * 0.5, h: S * 0.045 }, { text: ctx.badge ?? "USE CODE TATVAM50", background: null, fill: a,
          align: "left", fontSize: Math.round(S * 0.026), slot: "badge" }, ctx),
        ...logoLayer(ctx, W, H, "tr", 0.1),
      ], { type: "linear", angle: 135, stops: [{ offset: 0, color: "#4c1d95" }, { offset: 1, color: dark }] }, pal);
    },
  },
  {
    key: "season_premiere", label: "Season premiere", category: "Series", formats: ["film_poster", "ig_post", "story"],
    description: "A huge outlined season number behind the lead, the show title and the streaming date.",
    swatch: ["#030712", "#22d3ee"], backgroundPrompt: "Atmospheric night cityscape with neon reflections on wet streets",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, dark } = kit(ctx, ["#030712", "#22d3ee", "#a855f7", "#f8fafc"]);
      return doc(dark, [
        slot("Backdrop", "background", "background", 0, 0, W, H, { opacity: 0.55 }),
        fx("fade", W, H, { color: dark, intensity: 0.9, angle: 90 }),
        txt("title", W, H, { x: 0, y: H * 0.06, w: W, h: H * 0.58 }, { text: "2", fontFamily: "Anton", fontSize: Math.round(Math.min(W * 0.9, H * 0.55)),
          fill: al(a, "00"), stroke: { color: a, width: Math.max(3, Math.round(S * 0.006)) }, shadow: null, autoFit: false, name: "Season number",
          slot: "season_number" }, ctx),
        slot("Lead character", "hero", "character", W * 0.15, H * 0.14, W * 0.7, H * 0.6),
        txt("subtitle", W, H, { x: W * 0.1, y: H * 0.7, w: W * 0.8, h: S * 0.05 }, { text: "SEASON 2", fill: a, fontSize: Math.round(S * 0.034),
          letterSpacing: Math.round(S * 0.015), slot: "season" }, ctx),
        txt("title", W, H, { x: W * 0.06, y: H * 0.75, w: W * 0.88, h: H * 0.11 }, { text: ctx.title ?? "THE LAMP", fontSize: Math.round(S * 0.13),
          fill: "#ffffff", slot: "title" }, ctx),
        txt("badge", W, H, { x: W * 0.25, y: H * 0.88, w: W * 0.5, h: S * 0.05 }, { text: ctx.badge ?? "STREAMING FROM 14 NOV", fill: dark,
          background: { color: a, padding: Math.round(S * 0.012), radius: Math.round(S * 0.006) }, fontSize: Math.round(S * 0.026), slot: "badge" }, ctx),
        fx("grain", W, H, { intensity: 0.12 }),
        ...logoLayer(ctx, W, H, "tl", 0.09),
      ], null, pal);
    },
  },
  {
    key: "story_announcement", label: "Story announcement", category: "Social", formats: ["story", "whatsapp_status", "ig_post"],
    description: "A framed photo card, a bold headline and a swipe-up button. Drops, news and behind-the-scenes.",
    swatch: ["#0c0a09", "#0ea5e9"], backgroundPrompt: "Behind the scenes on an Indian film set, warm practical lights, candid moment",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, b, dark } = kit(ctx, ["#0c0a09", "#0ea5e9", "#f43f5e", "#fafaf9"]);
      return doc(dark, [
        sh("rect", W, H, { name: "Accent glow", x: 0, y: H * 0.55, width: W, height: H * 0.45, cornerRadius: 0, locked: true,
          fill: { type: "linear", angle: 90, stops: [{ offset: 0, color: al(a, "00") }, { offset: 1, color: al(a, "66") }] } }),
        slot("Photo", "background", "photo", W * 0.08, H * 0.1, W * 0.84, H * 0.5, { fit: "cover", cornerRadius: Math.round(S * 0.04),
          stroke: { color: "#ffffff", width: Math.max(2, Math.round(S * 0.006)) } }),
        txt("badge", W, H, { x: W * 0.08, y: H * 0.045, w: W * 0.4, h: S * 0.05 }, { text: ctx.badge ?? "JUST ANNOUNCED", align: "left", fill: "#ffffff",
          background: { color: b, padding: Math.round(S * 0.012), radius: Math.round(S * 0.008) }, fontSize: Math.round(S * 0.03), slot: "badge" }, ctx),
        txt("title", W, H, { x: W * 0.08, y: H * 0.63, w: W * 0.84, h: H * 0.15 }, { text: ctx.title ?? "WE START SHOOTING MONDAY", align: "left",
          fontSize: Math.round(S * 0.1), lineHeight: 1, fill: "#ffffff", slot: "title" }, ctx),
        txt("tagline", W, H, { x: W * 0.08, y: H * 0.79, w: W * 0.84, h: H * 0.06 }, { text: ctx.tagline ?? "Thirty days. Five languages. One lamp.",
          align: "left", fill: "#e7e5e4", fontSize: Math.round(S * 0.04), slot: "tagline" }, ctx),
        txt("cta", W, H, { x: W * 0.3, y: H * 0.88, w: W * 0.4, h: S * 0.09 }, { text: ctx.cta ?? ctx.brand?.cta ?? "SWIPE UP",
          background: { color: a, padding: Math.round(S * 0.022), radius: Math.round(S * 0.05) }, fill: "#ffffff", slot: "cta" }, ctx),
        ...logoLayer(ctx, W, H, "tr", 0.09),
      ], null, pal);
    },
  },
  {
    key: "harvest_festival", label: "Harvest festival", category: "Festival", formats: ["square", "ig_post", "story"],
    description: "Kolam rings, a sugarcane-gold palette and a greeting in Tamil under the English line. Pongal, Sankranti, Onam.",
    swatch: ["#052e16", "#facc15"], backgroundPrompt: "Clay pot overflowing with pongal, sugarcane, marigolds, kolam on the floor, morning sun",
    build: (ctx) => {
      const W = ctx.width, H = ctx.height, S = Math.min(W, H);
      const { pal, a, dark } = kit(ctx, ["#052e16", "#facc15", "#f97316", "#fefce8"]);
      const cy = H * 0.42;
      return doc(dark, [
        slot("Festive scene", "background", "background", 0, 0, W, H, { opacity: 0.5 }),
        fx("vignette", W, H, { intensity: 0.7, color: "#021208" }),
        sh("ring", W, H, { name: "Kolam ring", x: W / 2 - S * 0.36, y: cy - S * 0.36, width: S * 0.72, height: S * 0.72, fill: al(a, "aa"),
          innerRatio: 0.97, locked: true }),
        sh("star", W, H, { name: "Kolam star", x: W / 2 - S * 0.31, y: cy - S * 0.31, width: S * 0.62, height: S * 0.62, fill: null,
          stroke: { color: al(a, "66"), width: Math.max(2, Math.round(S * 0.003)) }, points: 8, innerRatio: 0.72, locked: true }),
        txt("tamil", W, H, { x: W * 0.08, y: cy - H * 0.11, w: W * 0.84, h: H * 0.13 }, { text: ctx.title ?? "இனிய பொங்கல்", fill: a,
          fontSize: Math.round(S * 0.09), slot: "title" }, ctx),
        txt("subtitle", W, H, { x: W * 0.1, y: cy + H * 0.04, w: W * 0.8, h: S * 0.06 }, { text: ctx.tagline ?? "HAPPY PONGAL", fill: "#fefce8",
          fontSize: Math.round(S * 0.04), letterSpacing: Math.round(S * 0.012), slot: "tagline" }, ctx),
        txt("body", W, H, { x: W * 0.15, y: H * 0.78, w: W * 0.7, h: H * 0.08 }, { text: "May the harvest fill every home with sweetness",
          align: "center", fill: "#fef9c3", fontSize: Math.round(S * 0.028), slot: "message" }, ctx),
        ...logoLayer(ctx, W, H, "bc", 0.08),
      ], { type: "radial", angle: 0, stops: [{ offset: 0, color: "#166534" }, { offset: 1, color: dark }] }, pal);
    },
  },
];

export const TEMPLATE_CATEGORIES: TemplateCategory[] = ["Film", "Series", "YouTube", "Social", "Ads", "Festival", "Events"];

export const templateOf = (key: string | null | undefined) => TEMPLATES.find((t) => t.key === key);

/** Fill a document's text slots with new copy (AI brief, project data). Only touches slots that exist. */
export function fillSlots(doc: DesignDoc, values: Record<string, string | undefined>): DesignDoc {
  return { ...doc, layers: doc.layers.map((l) => (l.type === "text" && l.slot && values[l.slot] ? { ...l, text: values[l.slot]! } : l)) };
}

/** Recolour a document with a palette: backgrounds from [0], accents from [1]/[2]. Leaves photos alone. */
export function applyPalette(doc: DesignDoc, palette: string[]): DesignDoc {
  if (!palette.length) return doc;
  const [bg, a, b] = [palette[0], palette[1] ?? palette[0], palette[2] ?? palette[1] ?? palette[0]];
  return {
    ...doc,
    background: { ...doc.background, color: bg, gradient: doc.background.gradient ? { ...doc.background.gradient,
      stops: doc.background.gradient.stops.map((s, i, arr) => ({ ...s, color: i === arr.length - 1 ? bg : s.color })) } : null },
    layers: doc.layers.map((l) => {
      if (l.type === "text" && l.background) return { ...l, background: { ...l.background, color: a } };
      if (l.type === "shape" && typeof l.fill === "string" && l.role === "decor") return { ...l, fill: l.name.toLowerCase().includes("burst") ? b : a };
      if (l.type === "effect" && (l.effect === "fade")) return { ...l, color: bg };
      return l;
    }),
    meta: { ...(doc.meta ?? {}), palette },
  };
}
