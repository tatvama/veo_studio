/**
 * Decoded pictures for graphics (photos, the look's logo, map images), by URL, shared by every graphic. The first ask
 * starts loading and returns null (the preview draws without it and redraws when it lands: `assetEpoch` changes);
 * the export awaits `loadImage` first, so its frames never miss a picture. No DOM at import.
 */

type Entry = { img: CanvasImageSource | null; failed: boolean; p: Promise<CanvasImageSource | null> };
const cache = new Map<string, Entry>();
let epoch = 0;
const subs = new Set<() => void>();

/** Bumps whenever a picture or a font arrives (frame keys include it, so a late asset redraws). */
export const assetEpoch = () => epoch;
export function bumpAssets(): void { epoch++; subs.forEach((f) => f()); }
/** Called when an asset arrives (the shared preview redraws a paused graphic). */
export function onAssets(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }

function start(url: string): Entry {
  let e = cache.get(url);
  if (e) return e;
  const entry: Entry = { img: null, failed: false, p: Promise.resolve(null) };
  entry.p = (async () => {
    if (typeof Image === "undefined") return null;
    try {
      const im = new Image();
      im.decoding = "async";
      if (!/^(data:|blob:)/.test(url)) im.crossOrigin = "anonymous";
      im.src = url;
      await im.decode();
      entry.img = im;
      bumpAssets();
      return im;
    } catch {
      entry.failed = true;
      return null;
    }
  })();
  cache.set(url, entry);
  if (cache.size > 300) { const k = cache.keys().next().value as string; if (k !== url) cache.delete(k); }
  e = entry;
  return e;
}

/** The decoded picture, or null while it loads (or when it can't be read). */
export function imageFor(url: string | undefined | null): CanvasImageSource | null {
  if (!url) return null;
  return start(url).img;
}
/** Loads and decodes a picture (resolves null when it can't be read). */
export const loadImage = (url: string): Promise<CanvasImageSource | null> => start(url).p;

/** Natural size of a picture source. */
export function sizeOf(img: CanvasImageSource): { w: number; h: number } {
  const x = img as { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number; width?: number | { baseVal?: { value: number } }; height?: number | { baseVal?: { value: number } } };
  const w = x.naturalWidth || x.videoWidth || (typeof x.width === "number" ? x.width : x.width?.baseVal?.value) || 1;
  const h = x.naturalHeight || x.videoHeight || (typeof x.height === "number" ? x.height : x.height?.baseVal?.value) || 1;
  return { w, h };
}
