/**
 * Make my look (docs/EDITOR.md §16.8): a logo's main colours by k-means on its pixels (in OKLab, so clusters follow
 * what the eye sees), then a channel palette from them with readable text: white or near-black text on the primary
 * plate (WCAG contrast ≥ 4.5, the plate darkened or lightened until it is), white on the secondary, dark on the
 * accent. Deterministic: the same logo always gives the same look. Pure.
 */
import type { ChannelLook, LookColor } from "../types.ts";

export type Lab = [number, number, number];
export interface Swatch {
  hex: string;
  /** Fraction of the logo's (non-background) pixels. */
  share: number;
  /** OKLCh: lightness 0..1, chroma (0 = grey, ~0.3 = vivid), hue in degrees. */
  L: number; C: number; h: number;
}

// ── colour maths ─────────────────────────────────────────────────────────────

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** "#rgb", "#rrggbb" or "#rrggbbaa" → [r, g, b] 0..255 (alpha ignored); null when it isn't one. */
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
export const toHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("").toUpperCase();

export function rgbToOklab(r: number, g: number, b: number): Lab {
  const R = toLin(r / 255), G = toLin(g / 255), B = toLin(b / 255);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function oklabToRgb([L, a, b]: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [toGamma(clamp01(R)) * 255, toGamma(clamp01(G)) * 255, toGamma(clamp01(B)) * 255];
}
const labToHex = (lab: Lab) => toHex(...oklabToRgb(lab));
const hexToLab = (hex: string): Lab => { const c = parseHex(hex) ?? [0, 0, 0]; return rgbToOklab(c[0], c[1], c[2]); };
const lch = ([L, a, b]: Lab) => ({ L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 });
const fromLch = (L: number, C: number, h: number): Lab => [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
const dist = (p: Lab, q: Lab) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** WCAG relative luminance of a colour (0 black … 1 white). */
export function luminance(hex: string): number {
  const c = parseHex(hex) ?? [0, 0, 0];
  const [r, g, b] = c.map((v) => toLin(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio of two colours (1 … 21). */
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * The colour moved darker (toward = "dark") or lighter until `text` on it reaches `min` contrast, keeping its hue
 * (OKLCh lightness steps; chroma eases off near black and white so it stays in gamut).
 */
export function withContrast(color: string, text: string, min = 4.5, toward: "dark" | "light" = luminance(text) > 0.5 ? "dark" : "light"): string {
  if (contrast(color, text) >= min) return color.toUpperCase();
  const { L, C, h } = lch(hexToLab(color));
  for (let i = 1; i <= 100; i++) {
    const nL = toward === "dark" ? L - i * 0.01 : L + i * 0.01;
    if (nL <= 0 || nL >= 1) break;
    const edge = Math.min(nL, 1 - nL) * 2;
    const out = labToHex(fromLch(nL, Math.min(C, 0.35 * edge + 0.02), h));
    if (contrast(out, text) >= min) return out;
  }
  return toward === "dark" ? "#000000" : "#FFFFFF";
}

// ── k-means ──────────────────────────────────────────────────────────────────

/** A small seeded random generator (mulberry32): the same seed, the same numbers. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k-means (k-means++ start from a fixed seed, Lloyd steps until nothing moves). Deterministic for the same points. */
export function kmeans(points: Lab[], k: number, maxIter = 30, seed = 1234): { centers: Lab[]; counts: number[]; assign: Int32Array } {
  const n = points.length;
  const kk = Math.max(1, Math.min(k, n));
  const assign = new Int32Array(n);
  if (!n) return { centers: [], counts: [], assign };
  const rand = rng(seed);
  const centers: Lab[] = [points[Math.floor(rand() * n)].slice() as Lab];
  const d2 = new Float64Array(n).fill(Infinity);
  while (centers.length < kk) {
    const c = centers[centers.length - 1];
    let sum = 0;
    for (let i = 0; i < n; i++) { const d = dist(points[i], c) ** 2; if (d < d2[i]) d2[i] = d; sum += d2[i]; }
    if (sum <= 1e-12) break;
    let r = rand() * sum, pick = n - 1;
    for (let i = 0; i < n; i++) { r -= d2[i]; if (r <= 0) { pick = i; break; } }
    centers.push(points[pick].slice() as Lab);
  }
  const counts = new Array<number>(centers.length).fill(0);
  for (let it = 0; it < maxIter; it++) {
    let moved = false;
    counts.fill(0);
    const sums = centers.map(() => [0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < centers.length; j++) { const d = dist(points[i], centers[j]); if (d < bd) { bd = d; best = j; } }
      if (assign[i] !== best) { moved = true; assign[i] = best; }
      counts[best]++;
      const s = sums[best]; s[0] += points[i][0]; s[1] += points[i][1]; s[2] += points[i][2];
    }
    for (let j = 0; j < centers.length; j++) if (counts[j]) centers[j] = [sums[j][0] / counts[j], sums[j][1] / counts[j], sums[j][2] / counts[j]];
    if (!moved && it > 0) break;
  }
  return { centers, counts, assign };
}

/**
 * The main colours of a logo (RGBA pixels, row by row): transparent pixels and a flat background (the colour most of
 * the border has) are left out, up to `maxSamples` pixels are clustered, and close clusters are merged. 1–5 swatches,
 * biggest first.
 */
export function logoPalette(rgba: ArrayLike<number>, width: number, height: number, o: { k?: number; maxSamples?: number } = {}): Swatch[] {
  const total = Math.min(width * height, Math.floor(rgba.length / 4));
  if (!total) return [];
  const opaque = (i: number) => rgba[i * 4 + 3] >= 128;
  // a flat background: ≥ 60 % of the opaque border pixels within a small distance of one colour
  const border: Lab[] = [];
  const edge = (x: number, y: number) => { const i = y * width + x; if (i < total && opaque(i)) border.push(rgbToOklab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2])); };
  const stepB = Math.max(1, Math.floor((width + height) / 200));
  for (let x = 0; x < width; x += stepB) { edge(x, 0); edge(x, height - 1); }
  for (let y = 0; y < height; y += stepB) { edge(0, y); edge(width - 1, y); }
  let bg: Lab | null = null;
  if (border.length >= 8) {
    const { centers, counts } = kmeans(border, 3, 12, 99);
    const top = counts.indexOf(Math.max(...counts));
    if (counts[top] / border.length >= 0.6) bg = centers[top];
  }
  const maxSamples = o.maxSamples ?? 6000;
  const stride = Math.max(1, Math.floor(total / maxSamples));
  const pts: Lab[] = [], all: Lab[] = [];
  for (let i = 0; i < total; i += stride) {
    if (!opaque(i)) continue;
    const p = rgbToOklab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    all.push(p);
    if (!bg || dist(p, bg) > 0.06) pts.push(p);
  }
  const use = pts.length >= Math.max(4, all.length * 0.03) ? pts : all;
  if (!use.length) return [];
  const { centers, counts } = kmeans(use, o.k ?? 5);
  // merge near-identical clusters, drop specks (< 2 %)
  const groups: { lab: Lab; n: number }[] = [];
  centers.map((c, j) => ({ lab: c, n: counts[j] })).sort((a, b) => b.n - a.n).forEach((c) => {
    const g = groups.find((x) => dist(x.lab, c.lab) < 0.07);
    if (!g) { groups.push({ lab: c.lab.slice() as Lab, n: c.n }); return; }
    const t = g.n + c.n;
    g.lab = [(g.lab[0] * g.n + c.lab[0] * c.n) / t, (g.lab[1] * g.n + c.lab[1] * c.n) / t, (g.lab[2] * g.n + c.lab[2] * c.n) / t];
    g.n = t;
  });
  const n = use.length;
  return groups.filter((g) => g.n / n >= 0.02).sort((a, b) => b.n - a.n).slice(0, 5)
    .map((g) => ({ hex: labToHex(g.lab), share: g.n / n, ...lch(g.lab) }));
}

// ── a channel palette from the swatches ──────────────────────────────────────

export interface BrandColors { primary: string; secondary: string; accent: string }
const NEAR_BLACK = "#0B0F19";

/**
 * Primary = the strongest brand colour (share × colourfulness); secondary = a deep colour for the second plate (the
 * logo's darkest colourful swatch, else the primary made deep); accent = the swatch furthest in hue from the primary
 * and bright enough to stand out, else a warm gold. Greys never win the primary unless the logo has nothing else.
 */
export function brandColors(sw: Swatch[]): BrandColors {
  if (!sw.length) return { primary: "#C8102E", secondary: "#101A33", accent: "#FFC20E" };
  const score = (s: Swatch) => s.share * (0.15 + Math.min(s.C, 0.3) * 6) * (s.L > 0.93 || s.L < 0.12 ? 0.3 : 1);
  const primary = [...sw].sort((a, b) => score(b) - score(a))[0];
  const rest = sw.filter((s) => s !== primary);
  const deep = rest.filter((s) => s.L < 0.45 && s.share >= 0.04).sort((a, b) => a.L - b.L || b.share - a.share)[0];
  const secondary = deep ? deep.hex
    : labToHex(fromLch(0.24, Math.min(primary.C, 0.09), primary.C < 0.03 ? 260 : primary.h + (primary.L > 0.6 ? 0 : 12)));
  // an accent stands apart by hue, or by being much brighter in the same family (lime on green, gold on orange)
  const apart = (s: Swatch) => hueGap(s.h, primary.h) + 120 * Math.abs(s.L - primary.L);
  const lively = rest.filter((s) => s.C >= 0.06 && s.L >= 0.55 && apart(s) >= 35).sort((a, b) => apart(b) * b.C - apart(a) * a.C)[0];
  const accent = lively ? lively.hex : primary.L > 0.75 && hueGap(primary.h, 85) < 30 ? "#FFFFFF" : "#FFC20E";
  return { primary: primary.hex, secondary, accent };
}

/**
 * The full look palette: brand colours made readable (text on the primary ≥ 4.5 with the better of white and
 * near-black, white on the secondary and dark ≥ 4.5, dark text on the accent ≥ 4.5), dark and light from the
 * secondary's hue; breaking, live, up and down from the base look.
 */
export function lookColors(b: BrandColors, base: Record<LookColor, string>): Record<LookColor, string> {
  const wOn = contrast(b.primary, "#FFFFFF"), kOn = contrast(b.primary, NEAR_BLACK);
  // News plates read best with white text: keep white unless the primary is genuinely light (yellow, cyan, lime)
  const textOnPrimary = wOn >= 4.5 || wOn * 1.6 >= kOn ? "#FFFFFF" : NEAR_BLACK;
  const primary = withContrast(b.primary, textOnPrimary, 4.5);
  const secondary = withContrast(b.secondary, "#FFFFFF", 4.5, "dark");
  const sec = lch(hexToLab(secondary));
  const dark = labToHex(fromLch(0.16, Math.min(sec.C, 0.05), sec.h));
  const light = labToHex(fromLch(0.97, Math.min(sec.C, 0.015), sec.h));
  const accent = withContrast(b.accent, dark, 4.5, "light");
  return { ...base, primary, secondary, accent, dark, light, text: "#FFFFFF", textOnPrimary };
}

/** Every text-on-plate pair of a look with its contrast (for the look editor's warnings and the tests). */
export function contrastChecks(c: Record<LookColor, string>): { label: string; text: string; plate: string; ratio: number }[] {
  return [
    { label: "Text on primary", text: c.textOnPrimary, plate: c.primary },
    { label: "Text on secondary", text: c.text, plate: c.secondary },
    { label: "Text on dark", text: c.text, plate: c.dark },
    { label: "Dark text on accent", text: c.dark, plate: c.accent },
    { label: "Text on breaking", text: c.text, plate: c.breaking },
  ].map((x) => ({ ...x, ratio: Math.round(contrast(x.text, x.plate) * 100) / 100 }));
}

/** A new look from a base style (fonts, motion, plates…) and a logo's palette. */
export function lookFromLogo(base: ChannelLook, sw: Swatch[], o: { id: string; name: string; logo?: ChannelLook["logo"] }): ChannelLook {
  const l = JSON.parse(JSON.stringify(base)) as ChannelLook;
  delete l.builtIn;
  l.id = o.id; l.name = o.name;
  l.colors = lookColors(brandColors(sw), base.colors);
  if (o.logo) l.logo = o.logo;
  return l;
}
