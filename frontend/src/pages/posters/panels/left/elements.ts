/**
 * Elements the left panel offers: shapes, multi-layer badges and stickers, effects and gradient overlays. Builders take
 * the design size so every item comes out in proportion on any format. Colours here are poster content, not UI chrome.
 */
import { newShape, newText } from "../../doc";
import type { EffectKind, Gradient, Layer, ShapeKind, ShapeLayer, TextLayer } from "../../types";
import { centreOnPage } from "./actions";

// ── shapes ───────────────────────────────────────────────

/** `asLayers`: the item tweaks the default shape (corner radius), so it travels as a ready-made layer. */
export interface ShapeItem { key: string; label: string; shape: ShapeKind; over?: (s: number) => Partial<ShapeLayer>; asLayers?: boolean }

export const SHAPES: ShapeItem[] = [
  { key: "rect", label: "Rectangle", shape: "rect", over: () => ({ cornerRadius: 0, name: "Rectangle" }), asLayers: true },
  { key: "rounded", label: "Rounded rectangle", shape: "rect", over: (s) => ({ cornerRadius: Math.round(s * 0.18), name: "Rounded rectangle" }), asLayers: true },
  { key: "ellipse", label: "Circle", shape: "ellipse", over: () => ({ name: "Circle" }) },
  { key: "triangle", label: "Triangle", shape: "triangle" },
  { key: "star", label: "Star", shape: "star" },
  { key: "burst", label: "Burst", shape: "burst" },
  { key: "ring", label: "Ring", shape: "ring" },
  { key: "polygon", label: "Hexagon", shape: "polygon", over: () => ({ sides: 6, name: "Hexagon" }) },
  { key: "line", label: "Line", shape: "line" },
  { key: "arrow", label: "Arrow", shape: "arrow", over: (s) => ({ width: Math.round(s * 1.2), height: Math.round(s * 0.36), name: "Arrow" }), asLayers: true },
];

export function shapeLayer(item: ShapeItem, W: number, H: number): ShapeLayer {
  const s = Math.round(Math.min(W, H) * 0.3);
  const l = newShape(item.shape, W, H, item.over?.(s) ?? {});
  // keep it centred when the item changes the default box
  return { ...l, x: Math.round((W - l.width) / 2), y: Math.round((H - l.height) / 2) };
}

// ── badges & stickers ────────────────────────────────────

type Box = { x: number; y: number; w: number; h: number };

/** A plain text layer for a sticker: no auto background, no shadow, no auto-fit. */
function label(W: number, H: number, text: string, family: string, size: number, fill: string, b: Box, over: Partial<TextLayer> = {}): TextLayer {
  return newText("subtitle", W, H, {
    text, fontFamily: family, fontSize: Math.round(size), fontWeight: 400, fill, x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.w),
    height: Math.round(b.h), letterSpacing: 0, align: "center", verticalAlign: "middle", uppercase: false, lineHeight: 1, shadow: null, background: null,
    autoFit: false, role: "badge", ...over,
  });
}

function block(W: number, H: number, shape: ShapeKind, fill: ShapeLayer["fill"], b: Box, over: Partial<ShapeLayer> = {}): ShapeLayer {
  return newShape(shape, W, H, { fill, x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.w), height: Math.round(b.h), cornerRadius: 0,
    role: "decor", ...over });
}

export interface StickerItem { key: string; label: string; build: (W: number, H: number) => Layer[] }

export const STICKERS: StickerItem[] = [
  {
    key: "new_burst", label: "“NEW” burst",
    build: (W, H) => {
      const u = Math.min(W, H) * 0.1, d = u * 2.4;
      return [block(W, H, "burst", "#e11d48", { x: 0, y: 0, w: d, h: d }, { points: 16, innerRatio: 0.8, name: "Burst" }),
        label(W, H, "NEW", "Anton", u * 0.7, "#ffffff", { x: 0, y: d / 2 - u * 0.45, w: d, h: u * 0.9 }, { letterSpacing: Math.round(u * 0.04), name: "NEW" })];
    },
  },
  {
    key: "4k_pill", label: "“4K” pill",
    build: (W, H) => {
      const u = Math.min(W, H) * 0.1;
      return [block(W, H, "rect", null, { x: 0, y: 0, w: u * 3.4, h: u }, { cornerRadius: Math.round(u / 2), stroke: { color: "#f8fafc", width: Math.max(2, Math.round(u * 0.06)) }, name: "Pill outline" }),
        label(W, H, "4K", "Montserrat Variable", u * 0.48, "#f8fafc", { x: u * 0.2, y: 0, w: u * 1.1, h: u }, { fontWeight: 900, name: "4K" }),
        label(W, H, "ULTRA HD", "Montserrat Variable", u * 0.26, "#f8fafc", { x: u * 1.25, y: 0, w: u * 1.95, h: u }, { fontWeight: 600, letterSpacing: Math.round(u * 0.03), align: "left", name: "Ultra HD" })];
    },
  },
  {
    key: "cinemas_ribbon", label: "“IN CINEMAS” ribbon",
    build: (W, H) => {
      const u = Math.min(W, H) * 0.1;
      return [
        block(W, H, "rect", "#9f1239", { x: -u * 0.5, y: u * 0.25, w: u * 1.2, h: u }, { name: "Ribbon tail" }),
        block(W, H, "rect", "#9f1239", { x: u * 4.3, y: u * 0.25, w: u * 1.2, h: u }, { name: "Ribbon tail" }),
        block(W, H, "rect", "#e11d48", { x: 0, y: 0, w: u * 5, h: u }, { name: "Ribbon" }),
        label(W, H, "IN CINEMAS NOW", "Bebas Neue", u * 0.62, "#ffffff", { x: 0, y: 0, w: u * 5, h: u }, { letterSpacing: Math.round(u * 0.06), name: "In cinemas" }),
      ];
    },
  },
  {
    key: "price_tag", label: "“₹ PRICE” tag",
    build: (W, H) => {
      const u = Math.min(W, H) * 0.1;
      return [
        block(W, H, "rect", "#facc15", { x: 0, y: 0, w: u * 3, h: u * 1.4 }, { cornerRadius: Math.round(u * 0.2), name: "Tag" }),
        block(W, H, "ellipse", "#1c1917", { x: u * 0.2, y: u * 0.58, w: u * 0.24, h: u * 0.24 }, { name: "Tag hole" }),
        label(W, H, "ONLY", "Montserrat Variable", u * 0.22, "#1c1917", { x: u * 0.55, y: u * 0.12, w: u * 2.3, h: u * 0.3 }, { fontWeight: 700, letterSpacing: Math.round(u * 0.03), name: "Only" }),
        label(W, H, "₹299", "Anton", u * 0.78, "#1c1917", { x: u * 0.55, y: u * 0.4, w: u * 2.3, h: u * 0.9 }, { name: "Price" }),
      ];
    },
  },
  {
    key: "episode_label", label: "“EPISODE 01” label",
    build: (W, H) => {
      const u = Math.min(W, H) * 0.1;
      return [block(W, H, "rect", "#22d3ee", { x: 0, y: 0, w: u * 0.12, h: u }, { name: "Accent bar" }),
        label(W, H, "EPISODE 01", "Bebas Neue", u * 0.78, "#ffffff", { x: u * 0.32, y: 0, w: u * 3.6, h: u }, { align: "left", letterSpacing: Math.round(u * 0.05), name: "Episode" })];
    },
  },
  {
    key: "live_pill", label: "“LIVE” pill",
    build: (W, H) => {
      const u = Math.min(W, H) * 0.1;
      return [block(W, H, "rect", "#dc2626", { x: 0, y: 0, w: u * 2.3, h: u * 0.9 }, { cornerRadius: Math.round(u * 0.45), name: "Pill" }),
        block(W, H, "ellipse", "#ffffff", { x: u * 0.32, y: u * 0.3, w: u * 0.3, h: u * 0.3 }, { name: "Live dot" }),
        label(W, H, "LIVE", "Montserrat Variable", u * 0.42, "#ffffff", { x: u * 0.75, y: 0, w: u * 1.35, h: u * 0.9 }, { fontWeight: 800, align: "left", letterSpacing: Math.round(u * 0.04), name: "Live" })];
    },
  },
  {
    key: "rating", label: "Rating stars",
    build: (W, H) => {
      const u = Math.min(W, H) * 0.1, s = u * 0.8, g = u * 0.14;
      const stars = [0, 1, 2, 3, 4].map((i) => block(W, H, "star", i < 4 ? "#facc15" : "#facc1555", { x: i * (s + g), y: 0, w: s, h: s },
        { points: 5, innerRatio: 0.45, name: `Star ${i + 1}` }));
      return [...stars, label(W, H, "4.5/5", "Montserrat Variable", u * 0.42, "#ffffff", { x: 5 * (s + g) + g, y: 0, w: u * 1.5, h: s }, { fontWeight: 800, align: "left", name: "Rating" })];
    },
  },
  {
    key: "subscribe", label: "“SUBSCRIBE” button",
    build: (W, H) => {
      const u = Math.min(W, H) * 0.1;
      return [block(W, H, "rect", "#ff0033", { x: 0, y: 0, w: u * 3.6, h: u }, { cornerRadius: Math.round(u * 0.2), name: "Button" }),
        label(W, H, "SUBSCRIBE", "Montserrat Variable", u * 0.4, "#ffffff", { x: 0, y: 0, w: u * 3.6, h: u }, { fontWeight: 800, letterSpacing: Math.round(u * 0.04), name: "Subscribe", role: "cta" })];
    },
  },
  {
    key: "coming_soon", label: "“COMING SOON” stamp",
    build: (W, H) => {
      const u = Math.min(W, H) * 0.1, d = u * 2.8;
      return [block(W, H, "ring", "#f8fafc", { x: 0, y: 0, w: d, h: d }, { innerRatio: 0.92, name: "Stamp ring" }),
        block(W, H, "ring", "#f8fafc", { x: d * 0.09, y: d * 0.09, w: d * 0.82, h: d * 0.82 }, { innerRatio: 0.97, name: "Inner ring" }),
        label(W, H, "COMING\nSOON", "Bebas Neue", u * 0.62, "#f8fafc", { x: 0, y: d / 2 - u * 0.66, w: d, h: u * 1.32 }, { lineHeight: 1.05, letterSpacing: Math.round(u * 0.05), name: "Coming soon" })];
    },
  },
  {
    key: "streaming", label: "“NOW STREAMING” badge",
    build: (W, H) => {
      const u = Math.min(W, H) * 0.1;
      return [block(W, H, "rect", "#05070bcc", { x: 0, y: 0, w: u * 4.2, h: u * 0.9 }, { cornerRadius: Math.round(u * 0.12), stroke: { color: "#22d3ee", width: Math.max(2, Math.round(u * 0.04)) }, name: "Badge" }),
        label(W, H, "NOW STREAMING", "Bebas Neue", u * 0.55, "#22d3ee", { x: 0, y: 0, w: u * 4.2, h: u * 0.9 }, { letterSpacing: Math.round(u * 0.08), name: "Now streaming" })];
    },
  },
  {
    key: "offer_flag", label: "“LIMITED OFFER” flag",
    build: (W, H) => {
      const u = Math.min(W, H) * 0.1;
      return [block(W, H, "rect", "#16a34a", { x: 0, y: 0, w: u * 4, h: u * 0.85 }, { cornerRadius: Math.round(u * 0.42), name: "Flag" }),
        label(W, H, "LIMITED OFFER", "Montserrat Variable", u * 0.36, "#ffffff", { x: 0, y: 0, w: u * 4, h: u * 0.85 }, { fontWeight: 800, letterSpacing: Math.round(u * 0.05), name: "Limited offer" })];
    },
  },
  {
    key: "hindi_badge", label: "“अभी देखें” badge",
    build: (W, H) => {
      const u = Math.min(W, H) * 0.1;
      return [block(W, H, "rect", "#f97316", { x: 0, y: 0, w: u * 3.4, h: u * 1.05 }, { cornerRadius: Math.round(u * 0.2), name: "Badge" }),
        label(W, H, "अभी देखें", "Anek Devanagari Variable", u * 0.5, "#ffffff", { x: 0, y: 0, w: u * 3.4, h: u * 1.05 }, { fontWeight: 800, lineHeight: 1.3, name: "Watch now" })];
    },
  },
];

/** A sticker's layers, centred on the page. */
export const stickerLayers = (s: StickerItem, W: number, H: number) => centreOnPage(s.build(W, H), W, H);

// ── effects ──────────────────────────────────────────────

export interface EffectItem { effect: EffectKind; label: string; description: string }

export const EFFECTS: EffectItem[] = [
  { effect: "vignette", label: "Vignette", description: "Darkens the edges to pull the eye to the centre." },
  { effect: "fade", label: "Fade to colour", description: "Melts the bottom into a solid colour for titles and credits." },
  { effect: "grain", label: "Film grain", description: "Fine grain that makes AI images feel shot on film." },
  { effect: "light-leak", label: "Light leak", description: "A warm flare of light spilling in from a corner." },
  { effect: "glow", label: "Glow", description: "A soft coloured bloom over the whole poster." },
  { effect: "scanlines", label: "Scanlines", description: "Thin horizontal lines for a retro screen look." },
  { effect: "frame", label: "Frame", description: "A clean border inset from the page edge." },
];

// ── gradients ────────────────────────────────────────────

export interface GradientItem { key: string; label: string; gradient: Gradient; opacity: number }

const lin = (angle: number, ...colors: string[]): Gradient =>
  ({ type: "linear", angle, stops: colors.map((color, i) => ({ offset: colors.length === 1 ? 0 : i / (colors.length - 1), color })) });

export const GRADIENTS: GradientItem[] = [
  { key: "sunset", label: "Sunset", gradient: lin(90, "#ff7e5f", "#feb47b"), opacity: 0.55 },
  { key: "neon", label: "Neon dusk", gradient: lin(45, "#22d3ee", "#a855f7", "#ec4899"), opacity: 0.5 },
  { key: "saffron", label: "Saffron", gradient: lin(90, "#f97316", "#facc15", "#fde68a"), opacity: 0.5 },
  { key: "midnight", label: "Midnight", gradient: lin(90, "#0f172a", "#1e3a8a", "#020617"), opacity: 0.6 },
  { key: "teal_orange", label: "Teal & orange", gradient: lin(0, "#0d9488", "#f97316"), opacity: 0.45 },
  { key: "royal", label: "Royal", gradient: lin(135, "#4c1d95", "#db2777"), opacity: 0.55 },
  { key: "monsoon", label: "Monsoon", gradient: lin(90, "#0f766e", "#0ea5e9", "#e0f2fe"), opacity: 0.45 },
  { key: "rose_gold", label: "Rose gold", gradient: lin(45, "#b76e79", "#f4c2c2", "#fde2e4"), opacity: 0.45 },
  { key: "emerald", label: "Emerald", gradient: lin(135, "#064e3b", "#10b981"), opacity: 0.5 },
  { key: "bottom_shade", label: "Bottom shade", gradient: lin(90, "#00000000", "#00000000", "#000000e6"), opacity: 1 },
  { key: "top_shade", label: "Top shade", gradient: lin(90, "#000000cc", "#00000000", "#00000000"), opacity: 1 },
  { key: "spotlight", label: "Spotlight", gradient: { type: "radial", angle: 0, stops: [{ offset: 0, color: "#00000000" }, { offset: 1, color: "#000000d9" }] }, opacity: 1 },
];

export function gradientLayer(g: GradientItem, W: number, H: number): ShapeLayer {
  return newShape("rect", W, H, { x: 0, y: 0, width: W, height: H, cornerRadius: 0, fill: g.gradient, opacity: g.opacity, name: `${g.label} overlay`, role: "decor" });
}

/** CSS for a gradient preview (layer angle 0 = left→right, 90 = top→bottom; CSS 90deg = left→right). */
export function gradientCss(g: Gradient): string {
  const stops = g.stops.map((s) => `${s.color} ${Math.round(s.offset * 100)}%`).join(", ");
  return g.type === "radial" ? `radial-gradient(circle, ${stops})` : `linear-gradient(${g.angle + 90}deg, ${stops})`;
}
