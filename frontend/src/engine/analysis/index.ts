/**
 * Colour analysis in the browser (docs/EDITOR.md §10): a frame of any image or video URL (cached), its CIELAB
 * statistics and an auto white balance (analyzeColor), and shot matching / grading from a reference (matchColor:
 * Reinhard transfer in Lab, as effect parameters and a 33³ LUT registered as a look id). The maths: colorMath.ts.
 */
import { registerLut } from "../luts";
import { lutToCube, type Lut3D } from "../cube";
import { labStats, matchParams, reinhardRgb, samplePixels, suggestWb, type LabStats, type MatchParams, type WbSuggestion, type WheelsParams } from "./colorMath";
import { fnv1a } from "../transitions/pack/mattes";

export type { LabStats, WbSuggestion, WheelsParams } from "./colorMath";

/** A picture to analyse: a URL (an image, or a video at `t` seconds) or a decoded image. */
export type FrameRef = { url: string; t?: number } | { image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | ImageData };

const isImageUrl = (u: string) => /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)(\?|#|$)/i.test(u) || u.startsWith("data:image/");
const cache = new Map<string, Promise<ImageBitmap>>();

/** The frame of `url` at `t` seconds as an ImageBitmap at most `maxW` wide (cached, the last 12). */
export function grabFrame(url: string, t = 0, maxW = 640): Promise<ImageBitmap> {
  const key = `${url}@${t}@${maxW}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
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
        await new Promise<void>((res) => { const done = () => { v.removeEventListener("seeked", done); res(); }; v.addEventListener("seeked", done); v.currentTime = Math.max(0, Math.min(t, (v.duration || t + 1) - 0.01)); setTimeout(done, 4000); });
        const sc = Math.min(1, maxW / Math.max(v.videoWidth, 1));
        return await createImageBitmap(v, { resizeWidth: Math.max(2, Math.round(v.videoWidth * sc)), resizeHeight: Math.max(2, Math.round(v.videoHeight * sc)), resizeQuality: "medium" });
      } finally { v.removeAttribute("src"); v.load(); }
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    while (cache.size > 12) { const k = cache.keys().next().value as string; cache.get(k)?.then((b) => b.close()).catch(() => undefined); cache.delete(k); }
  }
  return p;
}

/** RGBA bytes of a picture (drawn at most `maxW` wide). */
export async function pixelsOf(ref: FrameRef, maxW = 320): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  let img: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | ImageData;
  if ("url" in ref) img = await grabFrame(ref.url, ref.t ?? 0, Math.max(maxW, 320));
  else img = ref.image;
  if (img instanceof ImageData && img.width <= maxW) return { data: img.data, w: img.width, h: img.height };
  const sw = img.width, sh = img.height, sc = Math.min(1, maxW / Math.max(sw, 1));
  const w = Math.max(1, Math.round(sw * sc)), h = Math.max(1, Math.round(sh * sc));
  const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const g = cv.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  if (img instanceof ImageData) { const tmp = new OffscreenCanvas(sw, sh); tmp.getContext("2d")!.putImageData(img, 0, 0); g.drawImage(tmp, 0, 0, w, h); }
  else g.drawImage(img as CanvasImageSource, 0, 0, w, h);
  return { data: g.getImageData(0, 0, w, h).data, w, h };
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
