/** Small offscreen bitmaps used as repeating fills by effect layers (film grain, scanlines). Generated once, cached. */
import { parseColor } from "./paint";

const grainCache = new Map<string, HTMLCanvasElement>();
const lineCache = new Map<string, HTMLCanvasElement>();

/** 256×256 monochrome noise tinted by `color` (mid-grey for white, so overlay/soft-light blends stay neutral). */
export function grainPattern(color: string): HTMLCanvasElement {
  const hit = grainCache.get(color);
  if (hit) return hit;
  const size = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const [r, g, b] = parseColor(color) ?? [255, 255, 255, 1];
  // deterministic PRNG so the grain is identical in the editor and in every export
  let seed = 0x2f6b9a1d;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 10000) / 10000; };
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (rnd() + rnd() + rnd()) / 3; // soft, film-like distribution around the middle
    img.data[i] = r * v;
    img.data[i + 1] = g * v;
    img.data[i + 2] = b * v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  grainCache.set(color, cv);
  return cv;
}

/** A 1-pixel-wide tile with one line of `color` every `period` pixels. */
export function scanlinePattern(color: string, period: number): HTMLCanvasElement {
  const p = Math.max(2, Math.round(period));
  const key = `${color}|${p}`;
  const hit = lineCache.get(key);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = 4;
  cv.height = p;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 4, Math.max(1, Math.round(p / 2)));
  lineCache.set(key, cv);
  return cv;
}
