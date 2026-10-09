/**
 * Poster fonts, bundled with the app (no font CDN). Imported only by the Poster Studio chunk.
 * The canvas draws text with the browser's own shaping, so Devanagari, Kannada, Telugu and Tamil render correctly
 * as long as the chosen family covers the script.
 */
import "@fontsource/anton";
import "@fontsource/bebas-neue";
import "@fontsource-variable/playfair-display";
import "@fontsource-variable/cinzel";
import "@fontsource-variable/oswald";
import "@fontsource-variable/montserrat";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/800.css";
import "@fontsource/abril-fatface";
import "@fontsource-variable/teko";
import "@fontsource-variable/bodoni-moda";
import "@fontsource/yatra-one";
import "@fontsource/rozha-one";
import "@fontsource-variable/baloo-2";
import "@fontsource-variable/anek-devanagari";
import "@fontsource-variable/anek-kannada";
import "@fontsource-variable/anek-telugu";
import "@fontsource-variable/anek-tamil";
import "@fontsource/great-vibes";
import "@fontsource/dm-serif-display";
import "@fontsource/permanent-marker";

export type Script = "latin" | "devanagari" | "kannada" | "telugu" | "tamil";
export type FontCategory = "Display" | "Serif" | "Sans" | "Script" | "Indian";

export interface FontDef {
  family: string;
  label: string;
  category: FontCategory;
  scripts: Script[];
  /** weights the font really has (variable fonts: the range) */
  weights: number[];
  /** a sample that shows off the font */
  sample: string;
}

const RANGE = (a: number, b: number) => Array.from({ length: (b - a) / 100 + 1 }, (_, i) => a + i * 100);

export const FONTS: FontDef[] = [
  { family: "Anton", label: "Anton", category: "Display", scripts: ["latin"], weights: [400], sample: "BLOCKBUSTER" },
  { family: "Bebas Neue", label: "Bebas Neue", category: "Display", scripts: ["latin"], weights: [400], sample: "THE LAST LIGHT" },
  { family: "Oswald Variable", label: "Oswald", category: "Display", scripts: ["latin"], weights: RANGE(200, 700), sample: "NOW STREAMING" },
  { family: "Teko Variable", label: "Teko", category: "Display", scripts: ["latin", "devanagari"], weights: RANGE(300, 700), sample: "ACTION · एक्शन" },
  { family: "Abril Fatface", label: "Abril Fatface", category: "Display", scripts: ["latin"], weights: [400], sample: "Grand Premiere" },
  { family: "Cinzel Variable", label: "Cinzel", category: "Serif", scripts: ["latin"], weights: RANGE(400, 900), sample: "EPIC SAGA" },
  { family: "Playfair Display Variable", label: "Playfair Display", category: "Serif", scripts: ["latin"], weights: RANGE(400, 900), sample: "A Love Story" },
  { family: "Bodoni Moda Variable", label: "Bodoni Moda", category: "Serif", scripts: ["latin"], weights: RANGE(400, 900), sample: "Couture" },
  { family: "DM Serif Display", label: "DM Serif Display", category: "Serif", scripts: ["latin"], weights: [400], sample: "Elegance" },
  { family: "Montserrat Variable", label: "Montserrat", category: "Sans", scripts: ["latin"], weights: RANGE(100, 900), sample: "Clean & Modern" },
  { family: "Poppins", label: "Poppins", category: "Sans", scripts: ["latin", "devanagari"], weights: [400, 600, 800], sample: "Shop the sale" },
  { family: "Inter Variable", label: "Inter", category: "Sans", scripts: ["latin"], weights: RANGE(100, 900), sample: "Credits & details" },
  { family: "Great Vibes", label: "Great Vibes", category: "Script", scripts: ["latin"], weights: [400], sample: "Happy Diwali" },
  { family: "Permanent Marker", label: "Permanent Marker", category: "Script", scripts: ["latin"], weights: [400], sample: "Raw & real" },
  { family: "Yatra One", label: "Yatra One", category: "Indian", scripts: ["devanagari", "latin"], weights: [400], sample: "शुभ दीपावली" },
  { family: "Rozha One", label: "Rozha One", category: "Indian", scripts: ["devanagari", "latin"], weights: [400], sample: "महाकाव्य" },
  { family: "Baloo 2 Variable", label: "Baloo 2", category: "Indian", scripts: ["devanagari", "latin"], weights: RANGE(400, 800), sample: "नमस्ते दोस्तों" },
  { family: "Anek Devanagari Variable", label: "Anek Devanagari", category: "Indian", scripts: ["devanagari", "latin"], weights: RANGE(100, 800), sample: "कहानी शुरू" },
  { family: "Anek Kannada Variable", label: "Anek Kannada", category: "Indian", scripts: ["kannada", "latin"], weights: RANGE(100, 800), sample: "ಕಥೆ ಆರಂಭ" },
  { family: "Anek Telugu Variable", label: "Anek Telugu", category: "Indian", scripts: ["telugu", "latin"], weights: RANGE(100, 800), sample: "కథ మొదలు" },
  { family: "Anek Tamil Variable", label: "Anek Tamil", category: "Indian", scripts: ["tamil", "latin"], weights: RANGE(100, 800), sample: "கதை தொடக்கம்" },
];

export const FONT_CATEGORIES: FontCategory[] = ["Display", "Serif", "Sans", "Script", "Indian"];

export function fontDef(family: string): FontDef | undefined {
  return FONTS.find((f) => f.family === family);
}

/** Which script a piece of text is mostly written in (by its first letters outside Latin). */
export function scriptOf(text: string): Script {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x0900 && c <= 0x097f) return "devanagari";
    if (c >= 0x0c80 && c <= 0x0cff) return "kannada";
    if (c >= 0x0c00 && c <= 0x0c7f) return "telugu";
    if (c >= 0x0b80 && c <= 0x0bff) return "tamil";
  }
  return "latin";
}

/** A good default family for a script, so typing Hindi into an Anton title doesn't fall back to boxes. */
export const SCRIPT_FALLBACK: Record<Script, string> = {
  latin: "Montserrat Variable",
  devanagari: "Anek Devanagari Variable",
  kannada: "Anek Kannada Variable",
  telugu: "Anek Telugu Variable",
  tamil: "Anek Tamil Variable",
};

export function supports(family: string, text: string): boolean {
  const def = fontDef(family);
  return !def || def.scripts.includes(scriptOf(text));
}

/** CSS font-family value with a fallback chain that covers every Indian script. */
export function familyStack(family: string): string {
  return `"${family}", "Anek Devanagari Variable", "Anek Kannada Variable", "Anek Telugu Variable", "Anek Tamil Variable", sans-serif`;
}

const loaded = new Set<string>();

/** Make sure a face is ready before the canvas measures or draws with it. Resolves quickly when already loaded. */
export async function loadFont(family: string, weight = 400, style: "normal" | "italic" = "normal", sample = "Aa"): Promise<void> {
  const key = `${family}|${weight}|${style}|${scriptOf(sample)}`;
  if (loaded.has(key) || typeof document === "undefined" || !document.fonts) return;
  try {
    await document.fonts.load(`${style} ${weight} 48px "${family}"`, sample);
    loaded.add(key);
  } catch {
    /* unknown family: the browser falls back */
  }
}

/** Load every face a document uses (call before drawing or exporting). */
export async function loadFontsFor(texts: { fontFamily: string; fontWeight: number; fontStyle: "normal" | "italic"; text: string }[]): Promise<void> {
  await Promise.all(texts.map((t) => loadFont(t.fontFamily, t.fontWeight, t.fontStyle, t.text.slice(0, 40) || "Aa")));
}
