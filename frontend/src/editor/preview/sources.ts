/**
 * The pictures the preview renders start from (preview-polish): the sample stills (decoded once, 720 wide) and the
 * user's frame, as engine custom sources at a card's size with the gentle Ken Burns move of samples.ts; and title
 * specs drawn by render/title.ts (the very renderer the timeline and the export use). A source object stays the same
 * for the same picture, size and move, so the shared engine keeps its texture between renders; after a GPU reset (its
 * canvas back blank, engine/sources/canvasLoss.ts) it draws again.
 */
import type { CustomSource } from "../../engine";
import { watchCanvas } from "../../engine/sources/canvasLoss";
import { drawTitle, ensureFont, titleFrameKey } from "../render/title";
import type { TitleSpec } from "../model/types";
import { coverCrop, kenBurns, sampleById, type Sample, type SampleId } from "./samples";

type Pic = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

const canvas2d = (w: number, h: number): { c: OffscreenCanvas | HTMLCanvasElement; g: Ctx2D } => {
  const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  return { c, g: c.getContext("2d") as Ctx2D };
};

// ── the samples ─────────────────────────────────────────────────────────────────────────────────────────

const decoded = new Map<string, Promise<ImageBitmap | null>>();
/** A sample's still (the 720-wide copy), decoded once. */
export function sampleImage(id: SampleId): Promise<ImageBitmap | null> {
  let p = decoded.get(id);
  if (!p) {
    const s = sampleById(id);
    p = s ? fetch(s.smUrl).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status))))).then((b) => createImageBitmap(b)).catch(() => null) : Promise.resolve(null);
    decoded.set(id, p);
    void p.then((b) => { if (!b) decoded.delete(id); });
  }
  return p;
}

/** A source, the URL the compositions name it by, and what it shows (for cache keys). */
export interface Src { url: string; source: CustomSource; key: string }

const made = new Map<string, Src>();
const remember = (key: string, mk: () => Src): Src => {
  let s = made.get(key);
  if (!s) {
    s = mk(); made.set(key, s);
    if (made.size > 160) for (const k of [...made.keys()].slice(0, 40)) made.delete(k);
  }
  return s;
};

/** A picture drawn at w × h with the Ken Burns move of `kb` (none: a still crop), redrawn when the move moves. */
function movingSource(url: string, pic: Pic, w: number, h: number, kb: Sample["kb"] | null): CustomSource {
  const { c, g } = canvas2d(w, h);
  let last = NaN;
  const pw = pic.width, ph = pic.height;
  const paint = (t: number) => {
    const m = kb ? kenBurns(kb, t) : { zoom: 1, cx: 0.5, cy: 0.5 };
    const r = coverCrop(pw, ph, w, h, m.zoom, m.cx, m.cy);
    g.imageSmoothingQuality = "high";
    g.drawImage(pic as CanvasImageSource, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
  };
  // 30 steps a second of the move (a held card loops at 15 fps); a restore counts as a new picture
  const restores = watchCanvas(c);
  const step = (t: number) => (kb ? Math.round(t * 30) : 0) + restores() * 1e6;
  return {
    kind: "canvas", width: w, height: h,
    version: (t) => step(t),
    draw(t) { const k = step(t); if (k !== last) { last = k; paint(t); } return c; },
  };
}

/** A sample as a source at w × h (`motion`: its Ken Burns move). */
export async function sampleSource(id: SampleId, w: number, h: number, motion = true): Promise<Src | null> {
  const pic = await sampleImage(id);
  const s = sampleById(id);
  if (!pic || !s) return null;
  const key = `s:${id}`;
  return remember(`${key}|${w}x${h}|${motion ? 1 : 0}`, () => {
    const url = `preview:${key}:${w}x${h}:${motion ? "m" : "s"}`;
    return { url, key, source: movingSource(url, pic, w, h, motion ? s.kb : null) };
  });
}

/** The user's frame (a canvas from engineLooks.grabFrame) as a source at w × h, with a gentle push-in when `motion`. */
const USER_KB: Sample["kb"] = { z0: 1, z1: 1.06, x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.48 };
const frameIds = new WeakMap<object, number>();
let frameN = 0;
export function frameSource(frame: HTMLCanvasElement | ImageBitmap, key: string, w: number, h: number, motion = true): Src {
  let fid = frameIds.get(frame);
  if (!fid) { fid = ++frameN; frameIds.set(frame, fid); }
  return remember(`f${fid}|${w}x${h}|${motion ? 1 : 0}`, () => ({ url: `preview:f${fid}:${w}x${h}:${motion ? "m" : "s"}`, key, source: movingSource(key, frame, w, h, motion ? USER_KB : null) }));
}

// ── titles ──────────────────────────────────────────────────────────────────────────────────────────────

/** Waits for a title's fonts (at most 2.5 s), so a card never caches the fallback font. */
export function fontsReady(spec: TitleSpec): Promise<void> {
  return Promise.race([ensureFont(spec).then(() => undefined, () => undefined), new Promise<void>((r) => setTimeout(r, 2500))]);
}

/** A title spec (at `specH` lines) drawn at w × h by render/title.ts, transparent around it. */
export function titleSource(spec: TitleSpec, dur: number, w: number, h: number, specH = 1080, key = ""): Src {
  // a page canvas: it sees the document's loaded fonts
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const g = c.getContext("2d")!;
  let last = "";
  const restores = watchCanvas(c);
  const url = `preview:title:${key || Math.random().toString(36).slice(2)}:${w}x${h}`;
  const source: CustomSource = {
    kind: "canvas", width: w, height: h,
    version: (t) => { const k = titleFrameKey(spec, t, dur); return (k === "static" ? 0 : Math.round(t * 1000) + 1) + restores() * 1e8; },
    draw(t) {
      const k = titleFrameKey(spec, t, dur);
      const kk = `${k === "static" ? k : `${k}@${t}`}|${restores()}`;
      if (kk !== last) { last = kk; drawTitle(g, spec, w, h, t, dur, h / specH); }
      return c;
    },
  };
  return { url, key: `t:${key}`, source };
}
