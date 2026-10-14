/**
 * The user's frames for the previews (preview-polish): a media URL's picture at a time, as a canvas — the demo's
 * procedural clips drawn directly, stills decoded, videos seeked in a muted <video>. Unlike a plain cache, a frame
 * that fails to load (offline, a codec, a seek that never lands) or comes back blank (a video read before its first
 * picture) is never kept: the next request tries again, after a backoff (1 s, 3 s, 9 s, then every 30 s).
 */
import { customSource } from "../demoSources";

const ok = new Map<string, HTMLCanvasElement>();
const inflight = new Map<string, Promise<HTMLCanvasElement | null>>();
const failed = new Map<string, { n: number; at: number }>();
const isImageUrl = (u: string) => /\.(png|jpe?g|webp|gif|bmp|tiff?|avif)(\?|$)/i.test(u);

/** The wait after `n` failures. */
export const frameBackoff = (n: number) => (n <= 0 ? 0 : Math.min(30000, 1000 * Math.pow(3, n - 1)));

function toCanvas(src: CanvasImageSource, w0: number, h0: number, maxW: number): HTMLCanvasElement {
  const k = Math.min(1, maxW / Math.max(1, w0));
  const c = document.createElement("canvas");
  c.width = Math.max(2, Math.round(w0 * k)); c.height = Math.max(2, Math.round(h0 * k));
  c.getContext("2d", { willReadFrequently: true })!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** True when a canvas is (nearly) all one flat black: nothing was drawn. */
export function isBlank(c: HTMLCanvasElement | OffscreenCanvas): boolean {
  try {
    const g = (c as HTMLCanvasElement).getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
    if (!g) return false;
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const step = Math.max(4, Math.floor(d.length / 4 / 600) * 4);
    for (let i = 0; i < d.length; i += step) if (d[i] > 6 || d[i + 1] > 6 || d[i + 2] > 6) return false;
    return true;
  } catch { return false; }
}

function seekVideo(url: string, t: number, maxW: number): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true; v.preload = "auto"; v.playsInline = true; v.crossOrigin = "anonymous";
    let done = false;
    const finish = (c: HTMLCanvasElement | null) => { if (done) return; done = true; window.clearTimeout(timer); v.removeAttribute("src"); v.load(); resolve(c); };
    const timer = window.setTimeout(() => finish(null), 8000);
    v.onerror = () => finish(null);
    v.onloadedmetadata = () => { v.currentTime = Math.max(0, Math.min(Math.max(0, (v.duration || 0) - 0.05), t)); };
    v.onseeked = () => {
      // a seeked event before the picture is decoded gives a black canvas: wait a frame for it
      const grab = () => { try { finish(v.videoWidth ? toCanvas(v, v.videoWidth, v.videoHeight, maxW) : null); } catch { finish(null); } };
      const rv = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
      if (rv && v.readyState < 2) rv.call(v, grab); else grab();
    };
    v.src = url;
  });
}

/** The picture of `url` at `t` s (at most maxW wide), or null; failures and blank frames are retried later, never kept. */
export function userFrame(url: string, t: number, opts: { maxW?: number; image?: boolean } = {}): Promise<HTMLCanvasElement | null> {
  const maxW = opts.maxW ?? 480;
  const key = `${url}@${t.toFixed(2)}@${maxW}`;
  const have = ok.get(key);
  if (have) return Promise.resolve(have);
  const f = failed.get(key);
  if (f && performance.now() - f.at < frameBackoff(f.n)) return Promise.resolve(null);
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const cus = customSource(url);
      if (cus) return toCanvas(cus.draw(t) as CanvasImageSource, cus.width, cus.height, maxW);
      if (opts.image || isImageUrl(url)) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = url;
        await img.decode();
        return toCanvas(img, img.naturalWidth, img.naturalHeight, maxW);
      }
      return seekVideo(url, t, maxW);
    })().catch(() => null).then((c) => {
      inflight.delete(key);
      if (!c || isBlank(c)) { const n = (failed.get(key)?.n ?? 0) + 1; failed.set(key, { n, at: performance.now() }); return null; }
      failed.delete(key);
      ok.set(key, c);
      while (ok.size > 24) ok.delete(ok.keys().next().value as string);
      return c;
    });
    inflight.set(key, p);
  }
  return p;
}

/** When to try a failed frame again (ms from now), or null when it hasn't failed. */
export function frameRetryIn(url: string, t: number, maxW = 480): number | null {
  const f = failed.get(`${url}@${t.toFixed(2)}@${maxW}`);
  return f ? Math.max(0, frameBackoff(f.n) - (performance.now() - f.at)) : null;
}
