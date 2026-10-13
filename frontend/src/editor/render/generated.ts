/**
 * The editor's generated pictures as engine custom sources (editor/engine.ts generatedSources): titles with a template
 * look, karaoke words or a shape (drawn by render/title.ts) and colour mattes, each on its own frame-sized canvas.
 *
 * A title is drawn only when its picture changes: the engine asks `version(t)` first (no draw or upload while it is
 * the same) and `bounds(t)` after a draw (only the union with the last box is uploaded). A font that arrives late
 * counts as a change, and so does a GPU reset: the browser brings 2D canvases back blank (engine/sources/canvasLoss.ts),
 * so a title holding still between its animations would otherwise stay transparent on the monitor until it moved
 * again. A matte is painted once, and again (a new version) after a reset. Pure apart from the canvas it makes
 * (`makeCanvas`, a parameter for the tests).
 */
import type { CustomSource } from "../../engine/sources/source.ts";
import { watchCanvas } from "../../engine/sources/canvasLoss.ts";
import type { GeneratedSource } from "../model/toComposition.ts";
import { drawTitle, ensureFont, titleFrameKey } from "./title.ts";

type Canvas2D = { width: number; height: number; getContext(kind: "2d"): unknown };
export type MakeCanvas = (w: number, h: number) => Canvas2D;
type G = CanvasRenderingContext2D;

const pageCanvas: MakeCanvas = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
};

/** A title or a colour matte as a custom source (visualisers: audiotools/source.ts). */
export function generatedPicture(g: GeneratedSource, makeCanvas: MakeCanvas = pageCanvas): CustomSource {
  const c = makeCanvas(g.width, g.height);
  const ctx = c.getContext("2d") as G;
  if (g.kind === "color") {
    let painted = 0;
    const paint = () => { ctx.clearRect(0, 0, g.width, g.height); ctx.fillStyle = g.color; ctx.fillRect(0, 0, g.width, g.height); };
    paint();
    watchCanvas(c, () => { paint(); painted++; });
    return { kind: "canvas", width: g.width, height: g.height, still: true, version: () => painted, draw: () => c as unknown as TexImageSource };
  }
  let fonts = 0, last = "", vKey = "", vNum = 0;
  let box: [number, number, number, number] | null = [0, 0, g.width, g.height];
  void ensureFont(g.spec).then(() => { fonts++; });
  const restores = watchCanvas(c);
  const keyAt = (t: number) => `${fonts}|${restores()}|${titleFrameKey(g.spec, t, g.duration)}`;
  return {
    kind: "canvas", width: g.width, height: g.height,
    version(t: number) { const k = keyAt(t); if (k !== vKey) { vKey = k; vNum++; } return vNum; },
    draw(t: number) {
      // static between its animations (and karaoke words): drawn once, and again after a reset
      const key = keyAt(t);
      if (key !== last) { last = key; box = drawTitle(ctx, g.spec, g.width, g.height, t, g.duration); }
      return c as unknown as TexImageSource;
    },
    bounds: () => box,
  };
}
