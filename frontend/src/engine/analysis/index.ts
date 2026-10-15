/**
 * Colour analysis in the browser (docs/EDITOR.md §10): a frame of any image or video URL (cached), its CIELAB
 * statistics and an auto white balance (analyzeColor), and shot matching / grading from a reference (matchColor:
 * Reinhard transfer in Lab, as effect parameters and a 33³ LUT registered as a look id). The maths: colorMath.ts.
 */
import { registerLut } from "../luts";
import { lutToCube, type Lut3D } from "../cube";
import { labStats, matchParams, reinhardRgb, samplePixels, suggestWb, type LabStats, type MatchParams, type WbSuggestion, type WheelsParams } from "./colorMath";
import { fnv1a } from "../transitions/pack/mattes";
import { RefCache } from "../refcache.ts";
import { waitFor } from "../sources/live.ts";

export type { LabStats, WbSuggestion, WheelsParams } from "./colorMath";

/** A picture to analyse: a URL (an image, or a video at `t` seconds) or a decoded image. */
export type FrameRef = { url: string; t?: number } | { image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | ImageData };

const isImageUrl = (u: string) => /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)(\?|#|$)/i.test(u) || u.startsWith("data:image/");

/** Grabbed frames by [url, t, maxW]: held while a thumbnail or an analysis uses one (a frame in use is never closed
 *  under it), and the last 12 released ones stay for the next request. */
const frames = new RefCache<ImageBitmap>((key) => { const [url, t, maxW] = JSON.parse(key) as [string, number, number]; return loadFrame(url, t, maxW); }, (b) => b.close(), 12);
const frameKey = (url: string, t: number, maxW: number) => JSON.stringify([url, t, maxW]);

async function loadFrame(url: string, t: number, maxW: number): Promise<ImageBitmap> {
  if (isImageUrl(url)) {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    if (bmp.width <= maxW) return bmp;
    const out = await createImageBitmap(bmp, { resizeWidth: maxW, resizeHeight: Math.round((bmp.height * maxW) / bmp.width), resizeQuality: "medium" });
    bmp.close();
    return out;
  }
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous";
  v.src = url;
  try {
    await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error(`${url}: ${v.error?.message || "can't load the video"}`)); });
    const seeked = waitFor(v, ["seeked"], ["error"], 4000, () => `${url}: ${v.error?.message || "the video failed while seeking"}`);
    v.currentTime = Math.max(0, Math.min(t, (v.duration || t + 1) - 0.01));
    await seeked;
    const sc = Math.min(1, maxW / Math.max(v.videoWidth, 1));
    return await createImageBitmap(v, { resizeWidth: Math.max(2, Math.round(v.videoWidth * sc)), resizeHeight: Math.max(2, Math.round(v.videoHeight * sc)), resizeQuality: "medium" });
  } finally { v.removeAttribute("src"); v.load(); }
}

/** The frame of `url` at `t` seconds as an ImageBitmap at most `maxW` wide, held for the caller: releaseFrame() with
 *  the same arguments when done (the cache may then close it). */
export function acquireFrame(url: string, t = 0, maxW = 640): Promise<ImageBitmap> { return frames.acquire(frameKey(url, t, maxW)); }
export function releaseFrame(url: string, t = 0, maxW = 640): void { frames.release(frameKey(url, t, maxW)); }
/** Frames cached right now (tests, the lab). */
export const cachedFrames = () => frames.size;

/** The frame of `url` at `t` seconds as an ImageBitmap at most `maxW` wide (cached, the last 12). The bitmap is the
 *  caller's own copy: close() it when done. */
export async function grabFrame(url: string, t = 0, maxW = 640): Promise<ImageBitmap> {
  const key = frameKey(url, t, maxW);
  try {
    const b = await frames.acquire(key);
    return await createImageBitmap(b);
  } finally { frames.release(key); }
}

/** RGBA bytes of a picture (drawn at most `maxW` wide). */
export async function pixelsOf(ref: FrameRef, maxW = 320): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  let img: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | ImageData;
  let held: (() => void) | null = null;
  if ("url" in ref) {
    const u = ref.url, t = ref.t ?? 0, mw = Math.max(maxW, 320);
    img = await acquireFrame(u, t, mw);
    held = () => releaseFrame(u, t, mw);
  } else img = ref.image;
  try {
    if (img instanceof ImageData && img.width <= maxW) return { data: img.data, w: img.width, h: img.height };
    const sw = img.width, sh = img.height, sc = Math.min(1, maxW / Math.max(sw, 1));
    const w = Math.max(1, Math.round(sw * sc)), h = Math.max(1, Math.round(sh * sc));
    const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const g = cv.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    if (img instanceof ImageData) { const tmp = new OffscreenCanvas(sw, sh); tmp.getContext("2d")!.putImageData(img, 0, 0); g.drawImage(tmp, 0, 0, w, h); }
    else g.drawImage(img as CanvasImageSource, 0, 0, w, h);
    return { data: g.getImageData(0, 0, w, h).data, w, h };
  } finally { held?.(); }
}

export interface ColorAnalysis {
  /** Suggested adjust.temperature / adjust.tint to neutralise the picture (and the exact wheels.gain alternative). */
  wb: WbSuggestion;
  /** CIELAB mean and spread, luma histogram. */
  stats: LabStats;
}

/**
 * Statistics and an auto white balance of a frame (`url` at `t`, or a picture). wb is in the `adjust` effect's units
 * with its sign convention: temperature > 0 warms (more red, less blue), tint > 0 adds magenta. A warm (orange) frame
 * therefore gets a negative temperature; `wb.confidence` is low when the frame has few near-neutral pixels (sunsets,
 * coloured light), and the suggestion is halved then.
 */
export async function analyzeColor(ref: FrameRef | string, t = 0): Promise<ColorAnalysis> {
  const r = typeof ref === "string" ? { url: ref, t } : ref;
  const px = await pixelsOf(r);
  const s = samplePixels(px.data, px.w, px.h);
  return { wb: suggestWb(s), stats: labStats(s) };
}

// a type (not an interface) so it also reads as a plain record
export type ColorMatch = {
  /** Apply adjust.saturation, then wheels (the `adjust` and `wheels` effects, or fx.adjust + fx.wheels). */
  adjust: { saturation: number };
  wheels: WheelsParams;
  /** The exact Reinhard transfer, registered as a look id (use it as fx.look or the "look" effect's look). */
  lut: { id: string; name: string; size: number; lut: Lut3D };
  /** The LUT as .cube text: save it (e.g. into the edit folder) and use its URL as the look "url:<url>", or in
   *  Composition.lutUrls[lut.id], so another window (the export) loads the same LUT. */
  cube: string;
  /** Statistics: the source, the reference, and the source through the LUT (closer to the reference). */
  source: LabStats; reference: LabStats; result: LabStats;
};

/**
 * Shot match / grade from a reference: what turns `source` toward `reference` (Reinhard colour transfer in CIELAB).
 * The LUT is registered as `opts.id` (default "match:<hash>") unless `register` is false.
 */
export async function matchColor(source: FrameRef, reference: FrameRef, opts: { id?: string; size?: number; register?: boolean } = {}): Promise<ColorMatch> {
  const [a, b] = await Promise.all([pixelsOf(source), pixelsOf(reference)]);
  const sa = samplePixels(a.data, a.w, a.h, 12000), sb = samplePixels(b.data, b.w, b.h, 12000);
  const ref = labStats(sb);
  const m: MatchParams = matchParams(sa, ref, opts.size ?? 33);
  const size = opts.size ?? 33;
  const lut: Lut3D = { size, title: "Tatvam shot match", domainMin: [0, 0, 0], domainMax: [1, 1, 1], data: m.lut };
  const id = opts.id ?? `match:${fnv1a(`${JSON.stringify(m.source.mean)}${JSON.stringify(ref.mean)}${JSON.stringify(ref.std)}`).toString(36)}`;
  if (opts.register !== false) registerLut(id, lut);
  const result = labStats(sa.map((c) => reinhardRgb(c, m.source, ref)));
  return { adjust: m.adjust, wheels: m.wheels, lut: { id, name: "Shot match", size, lut }, cube: lutToCube(lut), source: m.source, reference: ref, result };
}
