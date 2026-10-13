/**
 * Logo pictures for looks (docs/EDITOR.md §16.2 / §16.8): load a picture from the bin or a file, read a small copy's
 * pixels for Make my look, and shrink it to an embedded data: URL of at most 256 KB so a look file travels on its own.
 * Browser only (canvas).
 */
import { MAX_LOGO_BYTES, dataUrlBytes } from "./validate";

export function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    try { if (/^https?:/.test(src) && new URL(src).origin !== window.location.origin) img.crossOrigin = "anonymous"; } catch { /* a relative URL */ }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That picture couldn't be opened."));
    img.src = src;
  });
}

const canvasFor = (w: number, h: number) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const fitIn = (img: HTMLImageElement, max: number) => {
  const s = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  return [Math.max(1, Math.round((img.naturalWidth || 1) * s)), Math.max(1, Math.round((img.naturalHeight || 1) * s))] as const;
};

/** The pixels of a small copy (for the colour clusters). */
export function pixelsOf(img: HTMLImageElement, max = 160): { data: Uint8ClampedArray; w: number; h: number } {
  const [w, h] = fitIn(img, max);
  const c = canvasFor(w, h);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, w, h);
  return { data: g.getImageData(0, 0, w, h).data, w, h };
}

/** The picture as a data: URL no larger than `maxBytes` (shrinking it, WebP first, keeping transparency). */
export function logoDataUrl(img: HTMLImageElement, maxBytes = MAX_LOGO_BYTES): string {
  for (const size of [640, 512, 384, 256, 192, 128, 96]) {
    const [w, h] = fitIn(img, size);
    const c = canvasFor(w, h);
    c.getContext("2d")!.drawImage(img, 0, 0, w, h);
    for (const [type, q] of [["image/webp", 0.92], ["image/png", undefined], ["image/webp", 0.75]] as const) {
      const u = c.toDataURL(type, q);
      if (u.startsWith(`data:${type}`) && dataUrlBytes(u) <= maxBytes) return u;
    }
  }
  throw new Error("That picture is too detailed to keep inside the look.");
}

export function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("The file couldn't be read."));
    r.readAsDataURL(f);
  });
}

/** The browser's picture picker; null when cancelled. */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/svg+xml,image/gif";
    let done = false;
    const finish = (f: File | null) => { if (!done) { done = true; resolve(f); } };
    input.onchange = () => finish(input.files?.[0] ?? null);
    window.addEventListener("focus", () => setTimeout(() => { if (!input.files?.length) finish(null); }, 800), { once: true });
    input.click();
  });
}
