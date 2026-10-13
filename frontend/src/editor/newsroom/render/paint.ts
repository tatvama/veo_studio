/**
 * Colours and fonts by look token (docs/EDITOR.md §16.2): "@primary", "@textOnPrimary/80" (80 % opacity), plain
 * "#rrggbb[aa]" / css colours, two-colour gradients at an angle, and "@headline" / "@body" / "@numbers" fonts with the
 * look's per-script face for the text being drawn. Pure apart from the gradient (made on the context it's given).
 */
import { scriptOf } from "../format.ts";
import type { Box, ChannelLook, FontName, LookColor, Paint } from "../types.ts";
import type { Ctx2D } from "./contract.ts";

const LOOK_COLORS = new Set<string>(["primary", "secondary", "accent", "dark", "light", "text", "textOnPrimary", "breaking", "live", "up", "down"]);

/** "#abc" / "#aabbcc" / "#aabbccdd" → [r, g, b, a 0..1], or null. */
export function parseHex(c: string): [number, number, number, number] | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(c.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}

/** A css colour with its opacity multiplied by `a` (hex and rgb[a] only; others pass unchanged). */
export function withAlpha(c: string, a: number): string {
  if (a >= 1) return c;
  const h = parseHex(c);
  if (h) return `rgba(${h[0]},${h[1]},${h[2]},${+(h[3] * a).toFixed(3)})`;
  const m = /^rgba?\(([^)]+)\)$/i.exec(c.trim());
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return `rgba(${p[0]},${p[1]},${p[2]},${+((p[3] ?? 1) * a).toFixed(3)})`;
  }
  return c;
}

/** A colour token → a css colour: "@name" or "@name/NN" from the look, else as written. "" / "none" → "". */
export function color(token: string | undefined, look: Pick<ChannelLook, "colors">, fallback = ""): string {
  if (!token || token === "none" || token === "transparent") return token === "transparent" ? "rgba(0,0,0,0)" : fallback && fallback !== token ? color(fallback, look) : "";
  if (token[0] !== "@") return token;
  const [name, pct] = token.slice(1).split("/");
  const base = LOOK_COLORS.has(name) ? look.colors[name as LookColor] : undefined;
  if (!base) return fallback ? color(fallback, look) : "";
  const a = pct !== undefined ? Math.max(0, Math.min(100, Number(pct))) / 100 : 1;
  return withAlpha(base, Number.isFinite(a) ? a : 1);
}

/** Relative luminance 0..1 of a hex colour (for "readable text on this plate"). */
export function luminance(c: string): number {
  const h = parseHex(c);
  if (!h) return 0.5;
  const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(h[0]) + 0.7152 * f(h[1]) + 0.0722 * f(h[2]);
}
/** Black or white, whichever reads better on a colour. */
export const textOn = (bg: string) => (luminance(bg) > 0.42 ? "#111111" : "#FFFFFF");

/** A paint for the box: a colour, or a linear gradient across the box at `angle` degrees (0 = left → right). */
export function paintFor(g: Ctx2D | null, p: Paint | undefined, look: Pick<ChannelLook, "colors">, box: Box, fallback = ""): string | CanvasGradient {
  if (p && typeof p === "object" && Array.isArray(p.gradient)) {
    const a = color(p.gradient[0], look), b = color(p.gradient[1], look);
    if (!g) return a;
    const ang = ((p.angle ?? 0) * Math.PI) / 180;
    const [x, y, w, h] = box;
    const cx = x + w / 2, cy = y + h / 2;
    const half = (Math.abs(Math.cos(ang)) * w + Math.abs(Math.sin(ang)) * h) / 2;
    const dx = Math.cos(ang) * half, dy = Math.sin(ang) * half;
    const gr = g.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    gr.addColorStop(0, a || "rgba(0,0,0,0)"); gr.addColorStop(1, b || "rgba(0,0,0,0)");
    return gr;
  }
  return color(p as string | undefined, look, fallback);
}

// ── fonts ────────────────────────────────────────────────────────────────────

/** Faces that cover every Indian script we bundle (the end of every font stack). */
export const INDIC_STACK = `"Anek Devanagari Variable", "Anek Kannada Variable", "Anek Telugu Variable", "Anek Tamil Variable"`;

/** The family and weight a font token means for a text (the look's per-script face when the text isn't Latin). */
export function fontFace(name: FontName | undefined, look: Pick<ChannelLook, "fonts">, weight?: number, sample?: string): { family: string; weight: number } {
  const n = name || "@body";
  const ref = n === "@headline" ? look.fonts.headline : n === "@numbers" ? look.fonts.numbers : n === "@body" ? look.fonts.body : null;
  let family = ref ? ref.family : n;
  let w = weight && weight > 0 ? weight : ref?.weight ?? 400;
  if (sample) {
    const sc = scriptOf(sample);
    const s = sc !== "latn" ? look.fonts.scripts?.[sc] : undefined;
    if (s) { family = s.family; if (!(weight && weight > 0)) w = s.weight; }
  }
  return { family, weight: w };
}

/** A css font string: "italic 700 52px "Oswald Variable", <Indic faces>, sans-serif". */
export function cssFont(name: FontName | undefined, look: Pick<ChannelLook, "fonts">, size: number, weight?: number, sample?: string, italic = false): string {
  const f = fontFace(name, look, weight, sample);
  const px = Math.max(1, Math.round(size * 100) / 100);
  return `${italic ? "italic " : ""}${f.weight} ${px}px "${f.family}", ${INDIC_STACK}, "Inter Variable", system-ui, sans-serif`;
}
