/**
 * The GPU render window's side of a News Room export (pages/desktop/RenderJob.tsx; docs/EDITOR.md §16.11). The
 * desktop's job carries `news` (desktop/src/shared/types.ts NewsGpuOptions):
 *  - `prepareNewsJob` makes the edit to draw (language, other ratio, graphics only: prepare.ts) before the
 *    composition is built, so the export is drawn exactly like the preview;
 *  - `setupNews` gives an opaque graphics-only export its background colour, and for alpha exports makes the engine
 *    draw on transparency and returns the reader that hands over each frame as RGBA8 (straight alpha, rows top first).
 * Transparency, best first: the engine's own `Composition.transparent` (when it has it), else the root drawn like a
 * nested composition (on transparency), else a black and a white render per frame turned into a matte. Each is
 * checked on an empty frame before it's used. No DOM at import time.
 */
import type { Composition, Engine } from "../../../engine/index.ts";
import type { EditProject } from "../../model/types.ts";
import { hexRgb, matteFromPair, prepareNewsProject, type NewsGpuOptions } from "./prepare.ts";

export type AlphaMode = "native" | "root" | "matte";

/** The edit and sequence the window draws, with the news options applied (the job is changed in place). */
export function prepareNewsJob(job: { project: unknown; sequenceId: string; news?: NewsGpuOptions }): void {
  if (!job.news) return;
  const r = prepareNewsProject(job.project as EditProject, job.sequenceId, job.news);
  job.project = r.project;
  job.sequenceId = r.sequenceId;
}

/** Composition options for the language (resolve.ts reads `lang`). */
export const newsCompositionOptions = (news?: NewsGpuOptions): { lang?: string } => (news?.lang ? { lang: news.lang } : {});

type Transparent = Composition & { transparent?: boolean };
type RootDraw = { drawComp?: (ctx: unknown, fs: unknown, opaque: boolean) => unknown };

/** Does an empty frame come back see-through? (A white background shows when it doesn't.) */
async function seeThrough(engine: Engine, w: number, h: number, native: boolean): Promise<boolean> {
  const probe: Transparent = { width: w, height: h, fps: 25, duration: 1, tracks: [], background: [1, 1, 1], ...(native ? { transparent: true } : {}) };
  await engine.load(probe, { mode: "exact" });
  await engine.renderExact(0);
  const px = engine.readRgba();
  return px[3] === 0 && px[px.length - 1] === 0;
}

/** Draws the root composition the way a nested one is drawn: on transparency (a per-engine patch). */
function rootOnTransparency(engine: Engine): boolean {
  const r = engine.renderer as unknown as RootDraw;
  const draw = r.drawComp;
  if (typeof draw !== "function") return false;
  r.drawComp = function (this: unknown, ctx: unknown, fs: unknown) { return draw.call(this, ctx, fs, false); };
  return true;
}

/** Picks the transparency the engine can do (before the real composition is loaded). */
export async function alphaMode(engine: Engine, w: number, h: number): Promise<AlphaMode> {
  if (await seeThrough(engine, w, h, true)) return "native";
  if (rootOnTransparency(engine) && (await seeThrough(engine, w, h, false))) return "root";
  return "matte";
}

/**
 * Before `engine.load(comp)`: the background for opaque graphics-only exports; for alpha exports the transparent
 * drawing and the frame reader (call it after `engine.renderExact(t)`, with the same t). Null = read YUV as usual.
 */
export async function setupNews(engine: Engine, comp: Composition, news?: NewsGpuOptions): Promise<((t: number) => Promise<Uint8Array>) | null> {
  if (!news) return null;
  if (!news.alpha) {
    if (news.background) comp.background = hexRgb(news.background);
    return null;
  }
  const mode = await alphaMode(engine, engine.width || comp.width, engine.height || comp.height);
  const c = comp as Transparent;
  c.background = [0, 0, 0];
  if (mode === "native") c.transparent = true;
  if (mode !== "matte") return async () => engine.readRgba();
  // the same frame over black (already drawn) and over white: the renderer keeps this composition object
  return async (t: number) => {
    const black = engine.readRgba().slice();
    c.background = [1, 1, 1];
    try {
      await engine.renderExact(t);
      return matteFromPair(black, engine.readRgba(), black);
    } finally { c.background = [0, 0, 0]; }
  };
}
