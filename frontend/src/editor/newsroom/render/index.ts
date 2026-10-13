/**
 * The News Room renderer (docs/EDITOR.md §16.3). Owner: nr-core. PLACEHOLDER: the signatures are the contract; nr-core
 * replaces the bodies. Draws a graphic (template + values + look) into a W×H Canvas2D at t seconds of a clip `dur` long.
 */
import type { GfxDesign, GfxRatio, GfxTemplate } from "../types.ts";
import type { Ctx2D, DirtyRect, GfxRenderInput } from "./contract.ts";
import "./kinds/index.ts";

/** The nearest ratio for a W×H frame. */
export function ratioOf(W: number, H: number): GfxRatio {
  const a = W / H;
  return a > 1.3 ? "16:9" : a < 0.7 ? "9:16" : a < 0.9 ? "4:5" : "1:1";
}
/** The design for a ratio: its own, else one made automatically from the nearest design (by the layers' pins). */
export function designFor(t: GfxTemplate, ratio: GfxRatio): GfxDesign {
  return t.designs[ratio] ?? t.designs["16:9"] ?? t.designs["9:16"] ?? { layers: [] };
}
/** Draws the graphic; returns the canvas rectangle that holds pixels (for partial uploads), null = nothing drawn. */
export function drawGraphic(_g: Ctx2D, _input: GfxRenderInput, _W: number, _H: number, _t: number, _dur: number): DirtyRect { return null; }
/** The same key → the same picture (the source redraws only when the key changes). */
export function graphicFrameKey(_input: GfxRenderInput, _W: number, _H: number, t: number, _dur: number): string { return `t${t}`; }
/** CSS font strings and image URLs the graphic needs. */
export function graphicAssets(_input: GfxRenderInput): { fonts: string[]; images: string[] } { return { fonts: [], images: [] }; }
/** Loads every font and decodes every image (the export calls it before the first frame). */
export async function ensureGraphicAssets(_input: GfxRenderInput): Promise<void> {}
