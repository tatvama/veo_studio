/**
 * Effect look packs (docs/EDITOR.md §15.3, presets-pack): six packs of five looks, each a chain of the GPU engine's
 * registry effects with fixed parameters (no new effects). They behave like moods without the transitions, titles and
 * music: one click puts the chain first on the chosen clips, a track or the whole sequence (one undo step), at an
 * intensity, and replaces an earlier mood or look (they share the mood tag, so "Remove mood", the LUT browser and the
 * scopes treat a look exactly like a mood). Pure: data, intensity maths and the apply itself.
 */
import { scaleParam, MAX_INTENSITY, type MoodEffect } from "../../../lib/moods.ts";
import { uid } from "../../model/ids.ts";
import { normalize, type Ctx } from "../../model/ops.ts";
import type { EffectInstance, Sequence } from "../../model/types.ts";
import { isMoodEffect, MOOD_TAG, scopeClips, type MoodScope } from "../apply.ts";

export type LookPackId = "cinematic" | "vintage" | "music_video" | "gaming" | "wedding" | "documentary";
export interface LookDef {
  /** "<pack>.<look>", stable (the clip's tag is "mood:look.<id>:<n>"). */
  id: string; pack: LookPackId; label: string; blurb: string;
  /** In chain order, at full strength. */
  effects: MoodEffect[];
  swatch: [string, string];
}
export interface LookPack { id: LookPackId; label: string; blurb: string }

export const LOOK_PACKS: LookPack[] = [
  { id: "cinematic", label: "Cinematic", blurb: "Feature-film grades" },
  { id: "vintage", label: "Vintage film", blurb: "Old stocks, gates and prints" },
  { id: "music_video", label: "Music video", blurb: "Bold, stylised and glitchy" },
  { id: "gaming", label: "Gaming", blurb: "Arcade, pixels and neon" },
  { id: "wedding", label: "Wedding", blurb: "Soft, warm and timeless" },
  { id: "documentary", label: "Documentary", blurb: "True to life, with texture" },
];

// ── building blocks (registry ids and params, engine/effects/**) ────────────
const E = (type: string, params: Record<string, unknown>): MoodEffect => ({ type, params });
const look = (id: string, s: number) => E("look", { look: id, lut_strength: s });
const adj = (p: Record<string, number>) => E("adjust", p);
const vig = (amount: number, size = 0.55, feather = 0.5) => E("vignette_pro", { amount, size, roundness: 0.5, feather, centre: [0.5, 0.5], color: "#000000", highlights: 0.3 });
const grain = (stock: "fine" | "35mm" | "16mm" | "8mm", amount: number) => E("film_grain", { stock, amount, size: 1, colour: 0.3, shadows: 0.6, highlights: 0.4 });
const split = (shadows: string, sa: number, highlights: string, ha: number, balance = 0) => E("split_toning", { shadows, shadow_amount: sa, highlights, highlight_amount: ha, balance });
const glow = (amount: number, threshold = 0.7, radius = 0.4) => E("glow", { amount, threshold, radius });
const halation = (amount: number, threshold = 0.72, radius = 14) => E("halation", { amount, threshold, radius, tint: "#ff4a1c" });
const diffusion = (strength: number, warmth = 0.1) => E("diffusion", { strength, radius: 20, threshold: 0.55, warmth });
const weave = (amount: number) => E("gate_weave", { amount, rotation: 0.12, speed: 1, zoom: 1.01 });
const flicker = (amount: number) => E("light_flicker", { amount, speed: 1, colour: 0.2, uneven: 0.3 });
const dust = (scratches: number, d: number) => E("scratches_dust", { scratches, dust: d, hairs: 0.2, opacity: 0.75, light: false });
const ca = (amount: number) => E("chromatic_aberration", { amount, falloff: 1.5, centre: [0.5, 0.5], soft: true });
const curve = (master: number[][]) => E("curves", { master, r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] });

const L = (pack: LookPackId, id: string, label: string, blurb: string, swatch: [string, string], effects: MoodEffect[]): LookDef =>
  ({ id: `${pack}.${id}`, pack, label, blurb, effects, swatch });

export const LOOKS: LookDef[] = [
  // cinematic
  L("cinematic", "teal_orange", "Teal & orange", "Blockbuster teal shadows, warm skin", ["#0e7490", "#f97316"],
    [look("teal_orange", 0.8), split("#1f6f8b", 0.3, "#f0a35e", 0.25), adj({ contrast: 0.15, vibrance: 0.1 }), vig(0.3)]),
  L("cinematic", "bleach_bypass", "Bleach bypass", "Silvery, desaturated, hard contrast", ["#a3a3a3", "#3f3f46"],
    [look("bleach_bypass", 0.85), adj({ contrast: 0.2, saturation: -0.25, sharpen: 0.2 }), grain("35mm", 0.2), vig(0.3)]),
  L("cinematic", "anamorphic", "Anamorphic flare", "Scope bars, blue streaks, soft fringes", ["#4d8cff", "#0f172a"],
    [look("cinematic", 0.6), E("anamorphic_flare", { intensity: 0.9, threshold: 0.72, length_: 700, tint: "#4d8cff" }), ca(2),
      E("letterbox", { aspect: 2.39, color: "#000000", opacity: 1, offset: 0, feather: 0 }), vig(0.25)]),
  L("cinematic", "moody_night", "Moody night", "Cold blue night, deep shadows", ["#1e3a8a", "#020617"],
    [look("moonlight", 0.7), adj({ exposure: -0.15, contrast: 0.15, saturation: -0.2, temperature: -0.25 }), split("#12304f", 0.4, "#9fb8d8", 0.15), vig(0.45), grain("fine", 0.15)]),
  L("cinematic", "golden_hour", "Golden hour", "Low sun, warm haze, glowing edges", ["#fbbf24", "#b45309"],
    [look("golden_hour", 0.75), adj({ exposure: 0.05, temperature: 0.25, vibrance: 0.15 }), diffusion(0.35, 0.3), halation(0.3), vig(0.2)]),
  // vintage film
  L("vintage", "super8", "Super 8", "Home-movie gate, grain and warmth", ["#d6b88a", "#78350f"],
    [E("film_8mm", { amount: 0.8, grain: 0.5, jitter: 0.5, gate: 0.6, warmth: 0.5 }), adj({ saturation: -0.1, temperature: 0.15 }), weave(2), flicker(0.2)]),
  L("vintage", "seventies", "Seventies print", "Warm print stock with halation", ["#f59e0b", "#7c2d12"],
    [look("vintage", 0.7), E("film_print", { amount: 0.7, contrast: 0.5, black: 0.04, shadow_tint: "#1a3a4a", highlight_tint: "#fff2dc" }), grain("35mm", 0.3), halation(0.4), vig(0.3)]),
  L("vintage", "faded", "Faded memories", "Lifted blacks, washed colour, dust", ["#e7d7c1", "#a8a29e"],
    [look("faded_film", 0.8), adj({ contrast: -0.15, saturation: -0.2 }), curve([[0, 0.08], [0.5, 0.52], [1, 0.95]]), grain("16mm", 0.3), dust(0.25, 0.3)]),
  L("vintage", "silent_film", "Silent film", "Flickering black and white, scratched", ["#e5e5e5", "#262626"],
    [look("black_white", 1), E("old_film", { sepia: 0.25, noise: 0.3, noiseSize: 1, scratch: 0.4, scratchDensity: 0.3, scratchWidth: 1, vignetting: 0.35, vignettingAlpha: 1, vignettingBlur: 0.3 }),
      flicker(0.4), weave(3)]),
  L("vintage", "vivid_fifties", "Vivid fifties", "Saturated three-strip colour", ["#ef4444", "#2563eb"],
    [look("vivid", 0.6), E("film_print", { amount: 0.6, contrast: 0.6, black: 0.03, shadow_tint: "#2a1a3a", highlight_tint: "#fff6e0" }), adj({ saturation: 0.2 }), halation(0.3), grain("fine", 0.15)]),
  // music video
  L("music_video", "neon_nights", "Neon nights", "Magenta and cyan glow", ["#e879f9", "#22d3ee"],
    [look("cross_process", 0.4), adj({ saturation: 0.25, contrast: 0.2, tint: 0.15 }), glow(0.55, 0.55, 0.5), E("rgb_split", { red: [-3, 0], green: [0, 0], blue: [3, 0] }), vig(0.35)]),
  L("music_video", "vhs", "VHS tape", "Tracking lines, bleed and noise", ["#a855f7", "#0f172a"],
    [E("vhs", { amount: 0.7, bleed: 6, tracking: 0.3, noise: 0.4, scanlines: 0.3 }), adj({ saturation: -0.05 }), ca(3), E("noise", { amount: 0.06, animate: true })]),
  L("music_video", "duotone_pop", "Duotone pop", "Two inks: violet and hot pink", ["#3a0ca3", "#ff5d8f"],
    [E("duotone", { shadows: "#3a0ca3", highlights: "#ff5d8f", contrast: 0.15, amount: 0.85 }), adj({ contrast: 0.1 }), glow(0.2)]),
  L("music_video", "prism_dream", "Prism dream", "Split light, pastel haze, a leak", ["#c4b5fd", "#fda4af"],
    [look("pastel", 0.5), E("prism", { amount: 10, angle: 0, radial: false, mix_: 0.6 }), diffusion(0.4), E("light_leak", { color1: "#ff7a1f", color2: "#ffd36b", intensity: 0.5, speed: 0.3, side: "left", seed: 3 })]),
  L("music_video", "glitch", "Glitch", "Sliced, shifted and crunchy", ["#22e1ff", "#ff2bd6"],
    [E("glitch", { slices: 10, offset: 60, direction: 0, seed: 0.5, animate: true, fillMode: 3, red: [-6, 0], green: [0, 0], blue: [6, 0] }),
      E("rgb_split", { red: [-6, 0], green: [0, 0], blue: [6, 0] }), adj({ contrast: 0.2 })]),
  // gaming
  L("gaming", "arcade_crt", "Arcade CRT", "Curved glass, scan lines, bright colour", ["#22c55e", "#052e16"],
    [E("crt", { curvature: 1, lineWidth: 1, lineContrast: 0.3, verticalLine: false, noise: 0.1, noiseSize: 1, vignetting: 0.3, vignettingAlpha: 1, vignettingBlur: 0.3, speed: 10 }),
      adj({ saturation: 0.25, contrast: 0.1 }), glow(0.3)]),
  L("gaming", "pixel", "8-bit pixels", "Big pixels, few colours", ["#f43f5e", "#1e1b4b"],
    [E("pixelate", { size: [6, 6] }), E("posterize", { levels: 6, gamma: 1, dither: 0 }), adj({ saturation: 0.3 })]),
  L("gaming", "cyber_hud", "Cyber HUD", "Cool tint with glowing edges", ["#06b6d4", "#0f172a"],
    [look("cool", 0.5), E("neon_edges", { intensity: 1, glow: 6, background: 0.35, rainbow: false }), adj({ contrast: 0.2 }), ca(3)]),
  L("gaming", "esports", "Esports punch", "Crisp, saturated, high energy", ["#f97316", "#7c3aed"],
    [look("vivid", 0.7), adj({ contrast: 0.25, saturation: 0.2, sharpen: 0.35, vibrance: 0.2 }), glow(0.25, 0.75, 0.35), vig(0.35)]),
  L("gaming", "cel_shaded", "Cel shaded", "Flat colour with ink outlines", ["#facc15", "#111827"],
    [E("toon", { levels: 6, edges: 0.7, thickness: 1.5, smooth_: 0.6, saturation: 1.2 }), adj({ saturation: 0.15 })]),
  // wedding
  L("wedding", "soft_romance", "Soft romance", "Pastel, airy and gently diffused", ["#fbcfe8", "#fde68a"],
    [look("pastel", 0.5), diffusion(0.45, 0.25), adj({ exposure: 0.05, contrast: -0.1 }), vig(0.2)]),
  L("wedding", "golden_vows", "Golden vows", "Warm gold light with a glow", ["#fcd34d", "#92400e"],
    [look("golden_hour", 0.6), glow(0.35, 0.65, 0.45), adj({ temperature: 0.2, vibrance: 0.15 }), halation(0.25)]),
  L("wedding", "ivory", "Ivory film", "Matte, creamy highlights, fine grain", ["#fff1dc", "#6b5a4a"],
    [look("matte", 0.6), split("#6b5a4a", 0.2, "#fff1dc", 0.25), adj({ saturation: -0.15, contrast: -0.05, temperature: 0.08 }), grain("fine", 0.15)]),
  L("wedding", "classic_bw", "Classic black & white", "Rich monochrome portraits", ["#f5f5f5", "#171717"],
    [look("black_white", 1), adj({ contrast: 0.15 }), grain("35mm", 0.2), vig(0.3)]),
  L("wedding", "sangeet", "Sangeet colour", "Festive, saturated and warm", ["#f472b6", "#facc15"],
    [look("vivid", 0.6), adj({ saturation: 0.2, vibrance: 0.3, temperature: 0.12 }), glow(0.3), E("light_leak", { color1: "#ff4d6d", color2: "#ffd36b", intensity: 0.35, speed: 0.3, side: "right", seed: 7 })]),
  // documentary
  L("documentary", "natural", "Natural", "Clean and true to life", ["#a3a3a3", "#365314"],
    [look("cinematic", 0.25), adj({ contrast: 0.05, sharpen: 0.1 })]),
  L("documentary", "verite", "Vérité", "Handheld 16 mm texture", ["#a8a29e", "#44403c"],
    [look("bleach_bypass", 0.3), adj({ contrast: 0.1, saturation: -0.1 }), grain("16mm", 0.3), weave(1)]),
  L("documentary", "archival", "Archival", "Old footage: damage, flicker and dust", ["#d6d3d1", "#57534e"],
    [look("sepia", 0.6), E("film_damage", { amount: 0.4, blotches: 0.5, jumps: 0.3, fade: 0.4 }), dust(0.4, 0.4), flicker(0.3), weave(2)]),
  L("documentary", "nature", "Nature vivid", "Clear air, rich greens and blues", ["#22c55e", "#0ea5e9"],
    [look("vivid", 0.4), E("dehaze", { amount: 0.3, airlight: "#e6ecf2", radius: 12 }), adj({ vibrance: 0.25, sharpen: 0.15 })]),
  L("documentary", "interview", "Interview clean", "Flattering skin, a quiet vignette", ["#fda4af", "#334155"],
    [look("cinematic", 0.3), E("skin_smoothing", { amount: 0.25, radius: 8, tolerance: 0.12, detail: 0.25, range: 0.5, show_mask: false }), adj({ contrast: 0.05, vibrance: 0.05 }), vig(0.2)]),
];

/** "look.<pack>.<id>" (a clip's mood tag) or "<pack>.<id>". */
export const LOOK_TAG = "look.";
export const lookById = (id: string | null | undefined): LookDef | undefined => (id ? LOOKS.find((l) => l.id === id || `${LOOK_TAG}${l.id}` === id) : undefined);
export const looksOf = (pack: LookPackId) => LOOKS.filter((l) => l.pack === pack);

// ── intensity ────────────────────────────────────────────────────────────────

/**
 * Neutral values for the wave-3 effects the packs use that the moods' table doesn't cover (lib/moods.ts NEUTRAL):
 * the parameter that sets how much of the effect shows.
 */
const EXTRA_NEUTRAL: Record<string, Record<string, { n: number | number[]; min: number; max: number }>> = {
  film_grain: { amount: { n: 0, min: 0, max: 1 } },
  halation: { amount: { n: 0, min: 0, max: 2 } },
  gate_weave: { amount: { n: 0, min: 0, max: 20 } },
  light_flicker: { amount: { n: 0, min: 0, max: 1 } },
  scratches_dust: { opacity: { n: 0, min: 0, max: 1 } },
  film_damage: { amount: { n: 0, min: 0, max: 1 } },
  film_print: { amount: { n: 0, min: 0, max: 1 } },
  film_8mm: { amount: { n: 0, min: 0, max: 1 } },
  anamorphic_flare: { intensity: { n: 0, min: 0, max: 3 } },
  chromatic_aberration: { amount: { n: 0, min: -40, max: 40 } },
  vignette_pro: { amount: { n: 0, min: -1, max: 1 } },
  diffusion: { strength: { n: 0, min: 0, max: 1 } },
  split_toning: { shadow_amount: { n: 0, min: 0, max: 1 }, highlight_amount: { n: 0, min: 0, max: 1 } },
  letterbox: { opacity: { n: 0, min: 0, max: 1 } },
  light_leak: { intensity: { n: 0, min: 0, max: 2 } },
  prism: { mix_: { n: 0, min: 0, max: 1 } },
  vhs: { amount: { n: 0, min: 0, max: 1 } },
  duotone: { amount: { n: 0, min: 0, max: 1 } },
  neon_edges: { background: { n: 1, min: 0, max: 1 } },
  dehaze: { amount: { n: 0, min: -1, max: 1 } },
  skin_smoothing: { amount: { n: 0, min: 0, max: 1 } },
  posterize: { dither: { n: 0, min: 0, max: 1 } },
};
const round = (v: number) => Math.round(v * 10000) / 10000;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** One parameter at intensity k: the packs' own table first, then the moods' rules. */
export function scaleLookParam(type: string, name: string, value: unknown, k: number): unknown {
  k = clamp(k, 0, MAX_INTENSITY);
  const nd = EXTRA_NEUTRAL[type]?.[name];
  if (nd && typeof value === "number" && typeof nd.n === "number") return round(clamp(nd.n + (value - nd.n) * k, nd.min, nd.max));
  return scaleParam(type, name, value, k);
}

/** A look's chain at intensity k (0..1.5). At 0 nothing is applied, so the picture stays as it is. */
export function lookEffects(l: LookDef, k = 1): MoodEffect[] {
  if (k <= 1e-3) return [];
  return l.effects.map((e) => ({ type: e.type, params: Object.fromEntries(Object.entries(e.params).map(([n, v]) => [n, scaleLookParam(e.type, n, v, k)])) }));
}

/** The look's effects as clip effect instances, tagged like a mood ("mood:look.<pack>.<id>:<n>"). */
export function lookInstances(l: LookDef, k = 1): EffectInstance[] {
  return lookEffects(l, k).map((e) => ({
    id: `${MOOD_TAG}${LOOK_TAG}${l.id}:${uid("e")}`, type: e.type, enabled: true,
    params: Object.fromEntries(Object.entries(e.params).map(([n, v]) => [n, { value: Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : v }])),
  }));
}

/**
 * Applies a look to the clips in scope (video tracks, unlocked; titles are left alone): an earlier mood or look goes
 * and this chain comes first, the clip's own effects stay after it. The same rules as applyMood without transitions
 * and titles. Returns the sequence and how many clips changed.
 */
export function applyLook(seq: Sequence, ctx: Ctx, l: LookDef, scope: MoodScope, intensity = 1): { seq: Sequence; clips: number } {
  const ids = new Set(scopeClips(seq, scope).filter((c) => c.source.type !== "title").map((c) => c.id));
  if (!ids.size) return { seq, clips: 0 };
  const clips = seq.clips.map((c) => (ids.has(c.id) ? { ...c, effects: [...lookInstances(l, intensity), ...c.effects.filter((e) => !isMoodEffect(e))] } : c));
  return { seq: normalize({ ...seq, clips }, ctx), clips: ids.size };
}
