/**
 * `get_frame` (docs/EDITOR.md §13.2): the program at time t, rendered exactly as the export draws it (the GPU
 * engine in "exact" mode: effects, titles, transitions), as a PNG at most 1280 px on its long side. One small engine
 * is kept for a minute between calls.
 */
import type { Engine } from "../../engine";
import { buildComposition, engineModule, generatedSources, registerDesktopShaders } from "../../editor/engine";
import type { EditProject, MediaItem } from "../../editor/model/types";
import { ensureFont } from "../../editor/render/title";
import { ensureGraphicAssets } from "../../editor/newsroom/render";

let engine: { eng: Engine; w: number; h: number } | null = null;
let idle: number | null = null;
let shadersDone = false;
let queue: Promise<unknown> = Promise.resolve();

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The frame as PNG (base64) and its size. */
export function renderProgramFrame(project: EditProject, sequenceId: string, seconds: number, maxWidth: number,
  urls: { urlFor(m: MediaItem): string | undefined; lutUrl(look: string): string | undefined }): Promise<{ data: string; width: number; height: number; warnings: string[] }> {
  const run = async () => {
    const seq = project.sequences.find((s) => s.id === sequenceId);
    if (!seq) throw new Error("No such sequence");
    const long = Math.max(16, Math.min(1280, Math.round(maxWidth)));
    const k = long / Math.max(seq.width, seq.height);
    const w = Math.max(16, Math.round((seq.width * k) / 2) * 2), h = Math.max(16, Math.round((seq.height * k) / 2) * 2);
    const m = await engineModule();
    if (!shadersDone) { shadersDone = true; await registerDesktopShaders().catch(() => undefined); }
    if (!engine || engine.w !== w || engine.h !== h) {
      engine?.eng.dispose();
      engine = { eng: await m.createEngine({ width: w, height: h }), w, h };
    }
    if (idle !== null) window.clearTimeout(idle);
    idle = window.setTimeout(() => { engine?.eng.dispose(); engine = null; idle = null; }, 60_000);
    await Promise.all(seq.clips.filter((c) => c.source.type === "title").map((c) => ensureFont((c.source as { text: Parameters<typeof ensureFont>[0] }).text).catch(() => undefined)));
    const r = buildComposition(project, sequenceId, { urlFor: urls.urlFor, lutUrl: urls.lutUrl });
    // News Room graphics: fonts and pictures in before the frame (as the export does)
    await Promise.all(Object.values(r.generated).map((g) => (g.kind === "graphic" ? ensureGraphicAssets(g.input).catch(() => undefined) : undefined)));
    const eng = engine.eng;
    await eng.load(r.comp, { mode: "exact", sources: generatedSources(r.generated) });
    await eng.renderExact(Math.max(0, seconds));
    const rgba = eng.readRgba();
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    const px = new Uint8ClampedArray(rgba.length);
    px.set(rgba);
    ctx.putImageData(new ImageData(px, w, h), 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return { data: toBase64(await blob.arrayBuffer()), width: w, height: h, warnings: [...new Set([...r.warnings, ...eng.warnings])].slice(0, 5) };
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}
