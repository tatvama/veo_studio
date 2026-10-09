/**
 * The live canvas registers an exporter here so toolbar, panels and autosave can render the design without holding a
 * reference to the Konva stage. Renders are of the page itself at design size × pixelRatio, never of the zoomed view,
 * and never include selection handles, guides or hover outlines.
 */
import type { LayerType } from "../types";

export interface RenderOptions {
  /** output scale relative to the design size (1 = design pixels). Ignored when maxSide is set and smaller. */
  pixelRatio?: number;
  /** cap the longer side of the output, in pixels (thumbnails) */
  maxSide?: number;
  mime?: "image/png" | "image/jpeg" | "image/webp";
  quality?: number;
  /** leave these layer types out (e.g. text, for an AI relight pass that must not touch the lettering) */
  hideTypes?: LayerType[];
  hideIds?: string[];
  /** draw the page background colour/gradient (default true); false gives a transparent PNG */
  background?: boolean;
}

export interface Exporter {
  render(opts?: RenderOptions): Promise<Blob>;
}

let current: Exporter | null = null;

export function registerExporter(e: Exporter | null): void {
  current = e;
}

export function getExporter(): Exporter | null {
  return current;
}
