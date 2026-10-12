/**
 * Clip pictures for the timeline, drawn into a canvas covering only the clip's visible part: a filmstrip (the media's
 * sprite of equally spaced frames, else its thumbnail repeated) and a waveform (MediaItem.peaks, evenly spread over
 * the media, else decoded in the browser).
 */
import { decodePeaks } from "../../components/review/Waveform";
import type { MediaItem } from "../model/types";

const images = new Map<string, Promise<HTMLImageElement | null>>();

export function loadImage(url: string): Promise<HTMLImageElement | null> {
  let p = images.get(url);
  if (!p) {
    p = new Promise((res) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = url;
    });
    images.set(url, p);
    if (images.size > 300) images.delete(images.keys().next().value as string);
  }
  return p;
}

const peakCache = new Map<string, Promise<{ peaks: ArrayLike<number>; duration: number } | null>>();
/** Peaks for a media item: its own, else decoded from its URL (100 per second). */
export function peaksFor(m: MediaItem, url: string | undefined): Promise<{ peaks: ArrayLike<number>; duration: number } | null> {
  if (m.peaks?.length) return Promise.resolve({ peaks: m.peaks, duration: m.duration / (m.fps || 1) });
  if (!url || url.startsWith("demo:")) return Promise.resolve(null);
  let p = peakCache.get(url);
  if (!p) {
    p = decodePeaks(url).then((d) => {
      if (!d) return null;
      let max = 0;
      for (let i = 0; i < d.peaks.length; i++) max = Math.max(max, d.peaks[i]);
      const k = max > 0 ? 1 / max : 1;
      return { peaks: Array.from(d.peaks, (v) => v * k), duration: d.duration };
    });
    peakCache.set(url, p);
  }
  return p;
}

export interface StripGeom {
  /** Visible part of the clip in clip-local pixels. */
  x0: number; x1: number; height: number;
  /** Pixels per timeline frame, the clip's first source frame and source frames per timeline frame. */
  zoom: number; srcIn: number; rate: number; reverse: boolean; duration: number;
  /** The media's length in source frames. */
  mediaFrames: number;
}

/** Source frame at a clip-local x. */
const srcAt = (g: StripGeom, x: number) => {
  const k = Math.max(0, Math.min(g.duration, x / g.zoom));
  return g.reverse ? g.srcIn + (g.duration - k) * g.rate : g.srcIn + k * g.rate;
};

export function drawFilmstrip(c: CanvasRenderingContext2D, img: HTMLImageElement, sprite: boolean, g: StripGeom, aspect: number, dpr: number) {
  const h = g.height;
  const tileW = Math.max(16, h * aspect);
  const frames = sprite ? Math.max(1, Math.round(img.naturalWidth / (img.naturalHeight * aspect))) : 1;
  const fw = img.naturalWidth / frames;
  const first = Math.floor(g.x0 / tileW), last = Math.ceil(g.x1 / tileW);
  c.save();
  c.scale(dpr, dpr);
  for (let i = first; i < last; i++) {
    const x = i * tileW - g.x0;
    const s = srcAt(g, i * tileW + tileW / 2);
    const fi = sprite ? Math.max(0, Math.min(frames - 1, Math.floor((s / Math.max(1, g.mediaFrames)) * frames))) : 0;
    c.drawImage(img, fi * fw, 0, fw, img.naturalHeight, x, 0, tileW, h);
  }
  c.restore();
}

export function drawWaveform(c: CanvasRenderingContext2D, peaks: ArrayLike<number>, mediaSeconds: number, srcFps: number, g: StripGeom, color: string, dpr: number) {
  const w = Math.max(1, Math.round((g.x1 - g.x0) * dpr)), h = g.height * dpr;
  const n = peaks.length;
  if (!n) return;
  const perFrame = n / Math.max(1e-6, mediaSeconds * srcFps);
  const mid = h / 2;
  c.fillStyle = color;
  c.beginPath();
  const step = 1;
  for (let px = 0; px < w; px += step) {
    const a = srcAt(g, g.x0 + px / dpr), b = srcAt(g, g.x0 + (px + step) / dpr);
    let i0 = Math.floor(Math.min(a, b) * perFrame), i1 = Math.ceil(Math.max(a, b) * perFrame);
    if (i1 <= i0) i1 = i0 + 1;
    let m = 0;
    for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) if (peaks[i] > m) m = peaks[i];
    const y = Math.max(0.5, m * mid * 0.92);
    c.rect(px, mid - y, step, y * 2);
  }
  c.fill();
}
