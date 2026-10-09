/** Colour helpers for the property panels (pure, no React). Design colours are data: #rrggbb or #rrggbbaa. */
import type { CSSProperties } from "react";
import type { Gradient, GradientStop, Paint } from "../../types";

export interface Rgb { r: number; g: number; b: number }
export interface Hsv { h: number; s: number; v: number }

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");

/** Parse any colour the documents use (#rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(), "transparent"). */
export function parseColor(input: string | null | undefined): { rgb: Rgb; alpha: number } | null {
  const c = (input ?? "").trim().toLowerCase();
  if (!c) return null;
  if (c === "transparent") return { rgb: { r: 0, g: 0, b: 0 }, alpha: 0 };
  let m = /^#?([0-9a-f]{3,4})$/.exec(c);
  if (m) {
    const [r, g, b, a] = m[1].split("").map((x) => parseInt(x + x, 16));
    return { rgb: { r, g, b }, alpha: a === undefined ? 1 : a / 255 };
  }
  m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/.exec(c);
  if (m) {
    const n = parseInt(m[1], 16);
    return { rgb: { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }, alpha: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(c);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => (x.endsWith("%") ? (parseFloat(x) / 100) * 255 : parseFloat(x)));
    if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) {
      const a = p[3] === undefined ? 1 : m[1].includes("%") && p[3] > 1 ? p[3] / 255 : p[3];
      return { rgb: { r: p[0], g: p[1], b: p[2] }, alpha: clamp(a, 0, 1) };
    }
  }
  return null;
}

export const rgbToHex = ({ r, g, b }: Rgb) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** #rrggbb, or #rrggbbaa when not fully opaque. */
export function toHex(rgb: Rgb, alpha = 1): string {
  const a = clamp(alpha, 0, 1);
  return a >= 0.999 ? rgbToHex(rgb) : `${rgbToHex(rgb)}${hex2(a * 255)}`;
}

/** Normalise user input to the document format, or null when it isn't a colour. */
export function normColor(input: string): string | null {
  const p = parseColor(input); // a missing "#" is fine
  return p ? toHex(p.rgb, p.alpha) : null;
}

export const hex6 = (c: string) => { const p = parseColor(c); return p ? rgbToHex(p.rgb) : "#000000"; };
export const alphaOf = (c: string) => parseColor(c)?.alpha ?? 1;
export const withAlpha = (c: string, a: number) => { const p = parseColor(c); return p ? toHex(p.rgb, a) : c; };
export const isTransparent = (c: string | null | undefined) => !!c && (parseColor(c)?.alpha ?? 1) < 0.004;

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** Blend two colours (alpha included). */
export function mix(a: string, b: string, t: number): string {
  const A = parseColor(a), B = parseColor(b);
  if (!A || !B) return a;
  const l = (x: number, y: number) => x + (y - x) * t;
  return toHex({ r: l(A.rgb.r, B.rgb.r), g: l(A.rgb.g, B.rgb.g), b: l(A.rgb.b, B.rgb.b) }, l(A.alpha, B.alpha));
}

/** Perceived lightness 0…1 (to pick a readable mark on top of a swatch). */
export function luminance(c: string): number {
  const p = parseColor(c);
  if (!p) return 0;
  return (0.299 * p.rgb.r + 0.587 * p.rgb.g + 0.114 * p.rgb.b) / 255;
}

/** A second colour that pairs with the first in a fresh gradient. */
export const partner = (c: string) => (luminance(c) > 0.55 ? mix(c, "#000000", 0.55) : mix(c, "#ffffff", 0.55));

export const sortStops = (stops: GradientStop[]) => [...stops].sort((a, b) => a.offset - b.offset);

/** The colour a gradient has at `offset` (used when adding a stop). */
export function colorAt(stops: GradientStop[], offset: number): string {
  const s = sortStops(stops);
  if (!s.length) return "#ffffff";
  if (offset <= s[0].offset) return s[0].color;
  for (let i = 1; i < s.length; i++) {
    if (offset <= s[i].offset) {
      const a = s[i - 1], b = s[i];
      return mix(a.color, b.color, (offset - a.offset) / Math.max(1e-6, b.offset - a.offset));
    }
  }
  return s[s.length - 1].color;
}

/** CSS for a gradient. `bar` draws it left to right (the stop editor) whatever its own angle. */
export function gradientCss(g: Gradient, bar = false): string {
  const stops = sortStops(g.stops).map((s) => `${s.color} ${(s.offset * 100).toFixed(1)}%`).join(", ");
  if (bar) return `linear-gradient(90deg, ${stops})`;
  // documents: 0° = left→right, 90° = top→bottom; CSS: 90deg = left→right, 180deg = top→bottom
  return g.type === "radial" ? `radial-gradient(circle at 50% 50%, ${stops})` : `linear-gradient(${g.angle + 90}deg, ${stops})`;
}

/** CSS background for a paint swatch (null = none). */
export function paintCss(p: Paint | null | undefined): string {
  if (p == null) return "transparent";
  return typeof p === "string" ? p : gradientCss(p);
}

/** A transparency checkerboard drawn from theme tokens (sits under swatches). */
export const CHECKER: CSSProperties = {
  backgroundColor: "var(--color-raised)",
  backgroundImage: "conic-gradient(var(--color-line) 25%, transparent 0 50%, var(--color-line) 0 75%, transparent 0)",
  backgroundSize: "8px 8px",
};

/** Colours most designs reach for, offered under every picker. */
export const QUICK_COLORS = ["#ffffff", "#000000", "#0b0f17", "#f8fafc", "#e11d48", "#f97316", "#fbbf24", "#22c55e", "#22d3ee", "#3b82f6", "#a78bfa", "#ec4899"];
