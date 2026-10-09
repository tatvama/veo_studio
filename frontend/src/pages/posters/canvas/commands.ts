import { FORMATS, formatOf, type Format } from "../formats";

/** Tiny command bus so toolbar and bottom-bar controls can drive the live canvas (fit, zoom about the centre). */
export type CanvasCommand = { type: "fit" } | { type: "zoom"; z: number } | { type: "zoomBy"; factor: number };

const subs = new Set<(c: CanvasCommand) => void>();

export function canvasCommand(c: CanvasCommand): void {
  subs.forEach((s) => s(c));
}

export function onCanvasCommand(fn: (c: CanvasCommand) => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/** Text written to the system clipboard when layers are copied, so they can be pasted into another design or tab. */
export const CLIP_PREFIX = "tatvam-poster-layers:";

export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 8;
export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/**
 * The format preset that really describes a W×H page: the stored key when its size still matches (undo can restore an
 * older size without the key), else any preset of exactly that size, else "custom".
 */
export function effectiveFormat(key: string | null | undefined, W: number, H: number): { key: string; format: Format | undefined } {
  const cur = formatOf(key);
  if (cur && cur.width === W && cur.height === H) return { key: cur.key, format: cur };
  const match = FORMATS.find((f) => f.width === W && f.height === H);
  return match ? { key: match.key, format: match } : { key: "custom", format: undefined };
}
