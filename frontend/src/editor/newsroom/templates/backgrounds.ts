/**
 * Built-in "Backgrounds" templates (docs/EDITOR.md §16.4). Owner: nr-wipes. Ids "nr.backgrounds.<name>", stable. Ten
 * procedural backgrounds (render/kinds/bg.ts) that loop seamlessly: each repeats exactly after `period` seconds, so
 * they fill a sequence of any length (and export as clean loops). Both ratios, the look's colours. They go on the
 * Background track, below the pictures.
 */
import type { GfxTemplate } from "../types.ts";
import type { BgStyle } from "../wipes/bgscene.ts";
import { DESIGN, layer, tpl } from "./kit.ts";

type Row = [id: string, name: string, description: string, style: BgStyle, p: Record<string, unknown>];

const ROWS: Row[] = [
  ["news_grid", "News grid", "A glowing perspective grid floor gliding towards you.", "grid", { period: 8 }],
  ["light_streaks", "Light streaks", "Soft streaks of light racing diagonally.", "streaks", { period: 10 }],
  ["globe", "Wireframe globe", "A turning wireframe globe with an orbiting light.", "globe", { period: 12 }],
  ["world_dots", "Dotted globe", "A dotted globe turning once per loop, with pulsing cities.", "dots", { period: 30 }],
  ["bokeh", "Bokeh", "Out-of-focus lights drifting and breathing.", "bokeh", { period: 16, vignette: 0.6 }],
  ["waves", "Waves", "Layered lines rolling like a signal.", "waves", { period: 10 }],
  ["particles", "Drifting particles", "Fine particles rising slowly.", "particles", { period: 15, top: "@dark", bottom: "@secondary" }],
  ["hex_mesh", "Hex mesh", "A honeycomb mesh with light pulsing through it.", "hex", { period: 8 }],
  ["gradient_flow", "Gradient flow", "Big soft colours flowing into each other.", "gradient", { period: 20, vignette: 0.4 }],
  ["ticker_tape", "Ticker tape", "Rows of market figures sliding past (business shows).", "tape", { period: 20, vignette: 0.7 }],
];

const bgLayer = (style: BgStyle, p: Record<string, unknown>, ratio: "16:9" | "9:16", seed: number) => {
  const { w, h } = DESIGN[ratio];
  return layer("bg", "bg", [0, 0, w, h], {
    style, period: 12, speed: 1, density: 1, seed, top: "@secondary", bottom: "@dark", main: "@primary", accent: "@accent", light: "@light",
    intensity: 1, vignette: 0.5, ...p,
  }, { name: "Background", pin: { x: "stretch", y: "stretch" } });
};

export const BACKGROUNDS: GfxTemplate[] = ROWS.map(([id, name, description, style, p], i) => tpl({
  id: `nr.backgrounds.${id}`, name, category: "Backgrounds", role: "background", kind: "loop", description, tags: ["background", "loop", style],
  seconds: 0, timing: { in: 0, out: 0 }, fields: [], loop: true, hold: "fill",
  designs: { "16:9": [bgLayer(style, p, "16:9", 11 + i * 7)], "9:16": [bgLayer(style, p, "9:16", 11 + i * 7)] },
}));
