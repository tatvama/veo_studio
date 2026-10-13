/**
 * MediaPipe Tasks Vision (Google, Apache-2.0; @mediapipe/tasks-vision 1.1.0) for the background effects and the face
 * tracker (docs/EDITOR.md §10). Loaded on first use only (its own chunk, its WASM as build assets): nothing of it is in
 * the main bundle. Models: frontend/public/models/mediapipe (selfie segmenter, BlazeFace short range; sources, licence
 * and SHA-256 in NOTICE.md there). Works in the browser and in Electron (the UI is served over http by the desktop
 * gateway, so the same /models/ and /assets/ URLs work).
 *
 *   segmentPerson(image)                      the person mask (8-bit, the model's 256×256 resized by MediaPipe) or null
 *   trackFaces(url, from, to, { fps })        face boxes over time (auto-reframe keyframes)
 */
import type { FaceDetector, ImageSegmenter } from "@mediapipe/tasks-vision";
import wasmLoaderUrl from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryUrl from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";

let modelBase = `${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"}models/mediapipe/`;
let delegate: "CPU" | "GPU" = "CPU";
/** Where the .tflite models are served (default /models/mediapipe/), and the MediaPipe delegate (default CPU: the same
 *  result on every machine, and no second WebGL context next to the engine's). */
export function setMediaPipeOptions(o: { modelBase?: string; delegate?: "CPU" | "GPU" }) {
  const changed = (o.delegate && o.delegate !== delegate) || (o.modelBase && o.modelBase !== modelBase);
  if (o.modelBase) modelBase = o.modelBase.endsWith("/") ? o.modelBase : `${o.modelBase}/`;
  if (o.delegate) delegate = o.delegate;
  if (changed) {  // the next use loads again with the new options
    seg?.close(); seg = null; segP = null; status.segmenter = "idle";
    void faceP?.then((d) => d.close()).catch(() => undefined); faceP = null; status.faces = "idle";
  }
}

export interface MediaPipeStatus {
  segmenter: "idle" | "loading" | "ready" | "failed"; faces: "idle" | "loading" | "ready" | "failed"; error?: string; delegate: string;
  /** Milliseconds of the last segmentation (inference and mask read-back). */
  segmentMs?: number;
}
const status: MediaPipeStatus = { segmenter: "idle", faces: "idle", delegate };
export const mediaPipeStatus = (): MediaPipeStatus => ({ ...status, delegate });

const fileset = () => ({ wasmLoaderPath: wasmLoaderUrl, wasmBinaryPath: wasmBinaryUrl });

let segP: Promise<ImageSegmenter> | null = null;
let seg: ImageSegmenter | null = null;
/** Loads the selfie segmenter once (IMAGE mode: frames can come in any order, as an export seeks). */
export function loadSegmenter(): Promise<ImageSegmenter> {
  segP ??= (async () => {
    status.segmenter = "loading";
    try {
      const mp = await import("@mediapipe/tasks-vision");
      const s = await mp.ImageSegmenter.createFromOptions(fileset(), {
        baseOptions: { modelAssetPath: `${modelBase}selfie_segmenter.tflite`, delegate },
        runningMode: "IMAGE", outputConfidenceMasks: true, outputCategoryMask: false,
      });
      seg = s;
      status.segmenter = "ready";
      return s;
    } catch (e) {
      status.segmenter = "failed"; status.error = (e as Error).message;
      segP = null;
      throw e;
    }
  })();
  return segP;
}
/** The segmenter if it has loaded (synchronous: the renderer calls it mid-frame). */
export const segmenterReady = () => seg;

/** The person mask of a picture: confidence 0..255 per pixel at the mask's size (MediaPipe resizes to the input). */
export function segmentPerson(image: TexImageSource): { data: Uint8Array; w: number; h: number } | null {
  if (!seg) return null;
  const t0 = performance.now();
  const r = seg.segment(image);
  try {
    const m = r.confidenceMasks?.[0];
    if (!m) return null;
    const f = m.getAsFloat32Array();
    const out = new Uint8Array(f.length);
    for (let i = 0; i < f.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(f[i] * 255)));
    return { data: out, w: m.width, h: m.height };
  } finally { r.close(); status.segmentMs = performance.now() - t0; }
}

let faceP: Promise<FaceDetector> | null = null;
export function loadFaceDetector(): Promise<FaceDetector> {
  faceP ??= (async () => {
    status.faces = "loading";
    try {
      const mp = await import("@mediapipe/tasks-vision");
      const d = await mp.FaceDetector.createFromOptions(fileset(), {
        baseOptions: { modelAssetPath: `${modelBase}blaze_face_short_range.tflite`, delegate }, runningMode: "IMAGE", minDetectionConfidence: 0.5,
      });
      status.faces = "ready";
      return d;
    } catch (e) {
      status.faces = "failed"; status.error = (e as Error).message;
      faceP = null;
      throw e;
    }
  })();
  return faceP;
}

/** One face: box top-left x, y and size w, h as fractions of the frame (0..1), centre cx, cy, detector score. */
export interface FaceBox { x: number; y: number; w: number; h: number; cx: number; cy: number; score: number }
/** A sample of trackFaces(): the subject's box at `t` (the most confident face, or, when no face is found with a score
 *  of 0.7 or more, the head of the main person from the segmentation: `source` says which), and every face found.
 *  Times with neither are left out. */
export interface FaceTrack extends FaceBox { t: number; faces: FaceBox[]; source: "face" | "person" }

const iou = (a: FaceBox, b: FaceBox) => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / Math.max(a.w * a.h + b.w * b.h - i, 1e-9);
};
/** Keeps the best of overlapping boxes (one inside another counts as overlapping). */
export function suppress(boxes: FaceBox[], thr = 0.3): FaceBox[] {
  const out: FaceBox[] = [];
  for (const b of [...boxes].sort((p, q) => q.score - p.score)) {
    const inside = (o: FaceBox) => { const x0 = Math.max(o.x, b.x), y0 = Math.max(o.y, b.y), x1 = Math.min(o.x + o.w, b.x + b.w), y1 = Math.min(o.y + o.h, b.y + b.h);
      return (Math.max(0, x1 - x0) * Math.max(0, y1 - y0)) / Math.max(Math.min(o.w * o.h, b.w * b.h), 1e-9) > 0.6; };
    if (out.every((o) => iou(o, b) < thr && !inside(o))) out.push(b);
  }
  return out;
}

let tileCanvas: HTMLCanvasElement | null = null;
/**
 * Faces in one picture (fractions of its size), the most confident first. BlazeFace short range looks at a 128×128
 * picture and is made for faces near the camera; `tiles` also looks in overlapping 2×2 and 3×3 windows for smaller
 * faces (off by default: on wide shots it finds false faces as often as real ones).
 */
export async function detectFaces(image: TexImageSource & { width?: number; height?: number }, w?: number, h?: number, opts: { tiles?: boolean; minScore?: number } = {}): Promise<FaceBox[]> {
  const d = await loadFaceDetector();
  const W = w ?? (image as { width: number }).width, H = h ?? (image as { height: number }).height;
  const min = opts.minScore ?? 0.5;
  const found: FaceBox[] = [];
  const add = (res: ReturnType<FaceDetector["detect"]>, ox: number, oy: number, sw: number, sh: number) => {
    for (const x of res.detections) {
      const b = x.boundingBox, score = x.categories?.[0]?.score ?? 0;
      if (!b || score < min) continue;
      const box = { x: ox + (b.originX / sw) * (sw / W), y: oy + (b.originY / sh) * (sh / H), w: b.width / W, h: b.height / H, score };
      found.push({ ...box, cx: box.x + box.w / 2, cy: box.y + box.h / 2 });
    }
  };
  add(d.detect(image), 0, 0, W, H);
  if (opts.tiles === true && typeof document !== "undefined") {
    tileCanvas ??= document.createElement("canvas");
    const g = tileCanvas.getContext("2d", { willReadFrequently: true })!;
    for (const [n, size] of [[2, 0.6], [3, 0.42]] as const) {
      const tw = Math.round(W * size), th = Math.round(H * size);
      tileCanvas.width = tw; tileCanvas.height = th;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const ox = Math.round(((W - tw) * i) / (n - 1)), oy = Math.round(((H - th) * j) / (n - 1));
        g.drawImage(image as CanvasImageSource, ox, oy, tw, th, 0, 0, tw, th);
        const res = d.detect(tileCanvas);
        for (const x of res.detections) {
          const b = x.boundingBox, score = x.categories?.[0]?.score ?? 0;
          if (!b || score < min) continue;
          const box = { x: (ox + b.originX) / W, y: (oy + b.originY) / H, w: b.width / W, h: b.height / H, score };
          found.push({ ...box, cx: box.x + box.w / 2, cy: box.y + box.h / 2 });
        }
      }
    }
  }
  return suppress(found);
}

/** The head of the main person in a picture, from the selfie segmenter's mask: the top sixth of the silhouette (the
 *  columns holding the middle 80 % of its pixels there). Score 0.3 (an estimate). Null when there's no person. */
export async function personHead(image: TexImageSource): Promise<FaceBox | null> {
  await loadSegmenter();
  const m = segmentPerson(image);
  if (!m) return null;
  const { data, w, h } = m;
  const rows: number[] = [];
  for (let y = 0; y < h; y++) { let n = 0; for (let x = 0; x < w; x++) if (data[y * w + x] > 127) n++; rows.push(n); }
  const min = Math.max(2, w * 0.01);
  const y0 = rows.findIndex((n) => n >= min);
  if (y0 < 0) return null;
  let y1 = h - 1;
  while (y1 > y0 && rows[y1] < min) y1--;
  const band = Math.max(2, Math.round((y1 - y0 + 1) / 6));
  const xs: number[] = [];
  for (let y = y0; y < Math.min(h, y0 + band); y++) for (let x = 0; x < w; x++) if (data[y * w + x] > 127) xs.push(x);
  if (xs.length < 4) return null;
  xs.sort((a, b) => a - b);
  const xa = xs[Math.floor(xs.length * 0.1)], xb = xs[Math.floor(xs.length * 0.9)];
  const box = { x: xa / w, y: y0 / h, w: Math.max(1, xb - xa + 1) / w, h: band / h, score: 0.3 };
  return { ...box, cx: box.x + box.w / 2, cy: box.y + box.h / 2 };
}

/**
 * The subject over a video (or a still) between `from` and `to` seconds, sampled at `fps` (default 4), for
 * auto-reframe keyframes: faces (BlazeFace), and the person's head from the segmentation when no face is found
 * confidently (wide shots). Each frame is drawn at most 640 px wide.
 */
export async function trackFaces(url: string, from: number, to: number, opts: { fps?: number; signal?: AbortSignal; onProgress?: (k: number) => void } = {}): Promise<FaceTrack[]> {
  await loadFaceDetector();
  const fps = Math.max(0.1, Math.min(30, opts.fps ?? 4));
  const out: FaceTrack[] = [];
  const isImage = /\.(png|jpe?g|webp|gif|avif|bmp)(\?|#|$)/i.test(url) || url.startsWith("data:image/");
  if (isImage) {
    const bmp = await createImageBitmap(await (await fetch(url, { credentials: "same-origin" })).blob());
    out.push(...await subjectAt(bmp, bmp.width, bmp.height, from));
    bmp.close();
    return out;
  }
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous";
  v.src = url;
  await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error(`${url}: ${v.error?.message || "can't load the video"}`)); });
  const end = Math.min(to, Number.isFinite(v.duration) ? v.duration : to);
  const scale = Math.min(1, 640 / Math.max(v.videoWidth, 1));
  const cv = document.createElement("canvas");
  cv.width = Math.max(2, Math.round(v.videoWidth * scale)); cv.height = Math.max(2, Math.round(v.videoHeight * scale));
  const g = cv.getContext("2d", { willReadFrequently: true })!;
  const n = Math.max(1, Math.floor((end - from) * fps) + 1);
  try {
    for (let i = 0; i < n; i++) {
      if (opts.signal?.aborted) break;
      const t = Math.min(end, from + i / fps);
      await new Promise<void>((res) => {
        const done = () => { v.removeEventListener("seeked", done); res(); };
        v.addEventListener("seeked", done);
        v.currentTime = Math.max(0, t);
        setTimeout(done, 3000);
      });
      g.drawImage(v, 0, 0, cv.width, cv.height);
      out.push(...await subjectAt(cv, cv.width, cv.height, t));
      opts.onProgress?.((i + 1) / n);
    }
  } finally { v.removeAttribute("src"); v.load(); }
  return out;
}

/** One sample: the confident face, else the person's head, else the weak face (or nothing). */
async function subjectAt(image: TexImageSource & { width: number; height: number }, w: number, h: number, t: number): Promise<FaceTrack[]> {
  const faces = await detectFaces(image, w, h);
  if (faces[0] && faces[0].score >= 0.7) return [{ t, ...faces[0], faces, source: "face" }];
  const head = await personHead(image).catch(() => null);
  if (head) return [{ t, ...head, faces, source: "person" }];
  return faces[0] ? [{ t, ...faces[0], faces, source: "face" }] : [];
}
