/**
 * Channel looks (docs/EDITOR.md §16.2): the five ready looks (Classic red, Modern blue, Business, Sports, Regional) and
 * how an edit picks its look. Colours are broadcast palettes checked for white-on-primary legibility; fonts are the
 * bundled ones (pages/posters/fonts.ts family names) with an Anek face per Indian script. Pure.
 */
import type { EditProject } from "../model/types.ts";
import type { ChannelLook, FontRef, ScriptId } from "./types.ts";

export const DEFAULT_LOOK_ID = "look.classic_red";

/** The bundled family names (the @fontsource CSS registers these). */
export const FONT = {
  oswald: "Oswald Variable", teko: "Teko Variable", inter: "Inter Variable", montserrat: "Montserrat Variable",
  poppins: "Poppins", bebas: "Bebas Neue", anton: "Anton",
  deva: "Anek Devanagari Variable", knda: "Anek Kannada Variable", telu: "Anek Telugu Variable", taml: "Anek Tamil Variable",
} as const;

/** A font per Indian script (Anek), at a weight. */
export function anekScripts(weight: number): Partial<Record<ScriptId, FontRef>> {
  return { deva: { family: FONT.deva, weight }, knda: { family: FONT.knda, weight }, telu: { family: FONT.telu, weight }, taml: { family: FONT.taml, weight } };
}

const f = (family: string, weight: number): FontRef => ({ family, weight });

export const BUILTIN_LOOKS: ChannelLook[] = [
  {
    id: "look.classic_red", name: "Classic red", builtIn: true,
    colors: {
      primary: "#C8102E", secondary: "#101A33", accent: "#FFC20E", dark: "#0A0F1E", light: "#F4F5F7",
      text: "#FFFFFF", textOnPrimary: "#FFFFFF", breaking: "#E10600", live: "#E8112D", up: "#21C063", down: "#F0323C",
    },
    fonts: { headline: f(FONT.oswald, 700), body: f(FONT.inter, 600), numbers: f(FONT.oswald, 600), scripts: anekScripts(700) },
    logo: { text: "TATVAM NEWS" },
    motion: "sharp", plate: "angled", radius: 4, upper: true,
    bug: { corner: "tr", scale: 1, opacity: 0.92 },
    numbers: { system: "indian", digits: "latin", currency: "₹" },
    clock: { hours: 24, zone: "Asia/Kolkata", date: "dmy" },
    separator: "diamond", sounds: { in: "whoosh", out: "swish", stinger: "impact" },
  },
  {
    id: "look.modern_blue", name: "Modern blue", builtIn: true,
    colors: {
      primary: "#1255CC", secondary: "#0A1A33", accent: "#22C7F2", dark: "#071224", light: "#EEF3FA",
      text: "#FFFFFF", textOnPrimary: "#FFFFFF", breaking: "#E53935", live: "#FF3B30", up: "#22C55E", down: "#EF4444",
    },
    fonts: { headline: f(FONT.montserrat, 800), body: f(FONT.inter, 500), numbers: f(FONT.montserrat, 700), scripts: anekScripts(700) },
    logo: { text: "TATVAM 24" },
    motion: "smooth", plate: "glass", radius: 10, upper: false,
    bug: { corner: "tr", scale: 1, opacity: 0.9 },
    numbers: { system: "indian", digits: "latin", currency: "₹" },
    clock: { hours: 12, zone: "Asia/Kolkata", date: "dmy" },
    separator: "dot", sounds: { in: "swish", out: "swish", stinger: "whoosh" },
  },
  {
    id: "look.business", name: "Business", builtIn: true,
    colors: {
      primary: "#0B2545", secondary: "#16365F", accent: "#C9A227", dark: "#06142A", light: "#F5F1E6",
      text: "#FFFFFF", textOnPrimary: "#FFFFFF", breaking: "#B3261E", live: "#D62828", up: "#2EB872", down: "#E63946",
    },
    fonts: { headline: f(FONT.montserrat, 700), body: f(FONT.inter, 500), numbers: f(FONT.inter, 600), scripts: anekScripts(600) },
    logo: { text: "TATVAM BUSINESS" },
    motion: "smooth", plate: "flat", radius: 2, upper: false,
    bug: { corner: "tr", scale: 0.9, opacity: 0.9 },
    numbers: { system: "indian", digits: "latin", currency: "₹" },
    clock: { hours: 24, zone: "Asia/Kolkata", date: "dmy" },
    separator: "bar", sounds: { in: "swish", out: "swish", stinger: "whoosh" },
  },
  {
    id: "look.sports", name: "Sports", builtIn: true,
    colors: {
      primary: "#0E9F4A", secondary: "#111111", accent: "#D7FF2F", dark: "#070707", light: "#F2F2F2",
      text: "#FFFFFF", textOnPrimary: "#FFFFFF", breaking: "#FF2E2E", live: "#FF2E2E", up: "#3BE37A", down: "#FF4B4B",
    },
    fonts: { headline: f(FONT.teko, 600), body: f(FONT.inter, 600), numbers: f(FONT.teko, 600), scripts: anekScripts(700) },
    logo: { text: "TATVAM SPORTS" },
    motion: "bouncy", plate: "angled", radius: 0, upper: true,
    bug: { corner: "tr", scale: 1, opacity: 0.95 },
    numbers: { system: "indian", digits: "latin", currency: "₹" },
    clock: { hours: 24, zone: "Asia/Kolkata", date: "dmy" },
    separator: "slash", sounds: { in: "impact", out: "swish", stinger: "impact" },
  },
  {
    id: "look.regional", name: "Regional", builtIn: true,
    colors: {
      primary: "#E35D0A", secondary: "#12306B", accent: "#FFD54A", dark: "#0A1B40", light: "#FFF6EC",
      text: "#FFFFFF", textOnPrimary: "#FFFFFF", breaking: "#D7141A", live: "#E5161D", up: "#25B865", down: "#E5383B",
    },
    fonts: { headline: f(FONT.deva, 700), body: f(FONT.deva, 500), numbers: f(FONT.deva, 600), scripts: anekScripts(700) },
    logo: { text: "TATVAM" },
    motion: "smooth", plate: "rounded", radius: 12, upper: false,
    bug: { corner: "tr", scale: 1, opacity: 0.92 },
    numbers: { system: "indian", digits: "latin", currency: "₹" },
    clock: { hours: 12, zone: "Asia/Kolkata", date: "long" },
    separator: "dot", sounds: { in: "swish", out: "swish", stinger: "whoosh" },
  },
];

export const builtinLook = (id: string): ChannelLook | undefined => BUILTIN_LOOKS.find((l) => l.id === id);

/** The look for an id in this edit (its own copy first, then the built-ins), else the edit's look, else the default. */
export function resolveLook(p: EditProject, id?: string): ChannelLook {
  const nr = p.newsroom;
  const find = (x?: string) => (x ? nr?.looks?.[x] ?? builtinLook(x) : undefined);
  return find(id) ?? find(nr?.look) ?? builtinLook(DEFAULT_LOOK_ID)!;
}

/** A deep copy of a look under a new id and name (for "Duplicate" and Make my look). */
export function copyLook(l: ChannelLook, id: string, name: string): ChannelLook {
  const c = JSON.parse(JSON.stringify(l)) as ChannelLook;
  c.id = id; c.name = name; delete c.builtIn;
  return c;
}
