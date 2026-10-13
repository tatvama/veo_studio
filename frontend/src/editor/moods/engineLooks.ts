/**
 * The looks tools' side of the GPU engine (docs/EDITOR.md §10 shared interfaces), through editor/engine.ts's module:
 * - frames of the user's own media at a time (grabFrame: the demo's procedural sources, stills, or a <video> seek),
 * - those frames through any effect chain (renderLook: a small offscreen engine, one composition per look, cached) —
 *   the Moods and LUT browser thumbnails,
 * - analyzeColor / matchColor / trackFaces / computeScopes when engine-pack's build has them, else the CPU fallbacks in
 *   moods/scopes.ts (grey-world white balance, a mean / spread match as colour wheels) or nothing (reframe centres).
 * Everything is feature-detected, so the panels work with this engine build and get better with the next.
 */
import type { Composition, CustomSource, Engine } from "../../engine";
import { customSource } from "../demoSources";
import { engineModule } from "../engine";
import type { EffectInstance } from "../model/types";
import { frameStats, greyWorldWb, matchWheels, type RgbaFrame } from "./scopes";
import type { FaceSample } from "../templates/formats";

type Mod = Awaited<ReturnType<typeof engineModule>> & Record<string, unknown>;
const mod = () => engineModule() as Promise<Mod>;

/** What this engine build offers the looks tools. */
export interface LookCaps { analyzeColor: boolean; matchColor: boolean; trackFaces: boolean; computeScopes: boolean; inputProfile: boolean; outputTransform: boolean }
let capsP: Promise<LookCaps> | null = null;
export function lookCaps(): Promise<LookCaps> {
  return (capsP ??= mod().then((m) => {
    const ids = new Set((m.listEffects?.() ?? []).map((e) => e.id));
    return {
      analyzeColor: typeof m.analyzeColor === "function", matchColor: typeof m.matchColor === "function", trackFaces: typeof m.trackFaces === "function",
      computeScopes: typeof m.computeScopes === "function", inputProfile: ids.has("input_profile"), outputTransform: ids.has("output_transform"),
    };
  }).catch(() => ({ analyzeColor: false, matchColor: false, trackFaces: false, computeScopes: false, inputProfile: false, outputTransform: false })));
}

// ── frames of the user's media ───────────────────────────────────────────────

const frames = new Map<string, Promise<HTMLCanvasElement | null>>();
const isImageUrl = (u: string) => /\.(png|jpe?g|webp|gif|bmp|tiff?|avif)(\?|$)/i.test(u);

function toCanvas(src: CanvasImageSource, w0: number, h0: number, maxW: number): HTMLCanvasElement {
  const k = Math.min(1, maxW / Math.max(1, w0));
  const c = document.createElement("canvas");
  c.width = Math.max(2, Math.round(w0 * k)); c.height = Math.max(2, Math.round(h0 * k));
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return c;
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
      try { finish(v.videoWidth ? toCanvas(v, v.videoWidth, v.videoHeight, maxW) : null); } catch { finish(null); }
    };
    v.src = url;
  });
}

/**
 * The picture of a media URL at `t` seconds (at most maxW wide), cached: the demo's procedural clips draw directly,
 * stills decode, videos seek a muted <video>. Null when it can't be read (offline, a codec the browser lacks).
 */
export function grabFrame(url: string, t: number, opts: { maxW?: number; image?: boolean } = {}): Promise<HTMLCanvasElement | null> {
  const maxW = opts.maxW ?? 320;
  const key = `${url}@${t.toFixed(2)}@${maxW}`;
  let p = frames.get(key);
  if (!p) {
    p = (async () => {
      const cus: CustomSource | undefined = customSource(url);
      if (cus) return toCanvas(cus.draw(t) as CanvasImageSource, cus.width, cus.height, maxW);
      if (opts.image || isImageUrl(url)) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = url;
        await img.decode();
        return toCanvas(img, img.naturalWidth, img.naturalHeight, maxW);
      }
      return seekVideo(url, t, maxW);
    })().catch(() => null);
    frames.set(key, p);
    if (frames.size > 48) frames.delete(frames.keys().next().value as string);
  }
  return p;
}

/** A canvas's pixels as an RGBA frame. */
export function canvasFrame(c: HTMLCanvasElement): RgbaFrame {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
  return { data: d.data, width: c.width, height: c.height };
}

// ── a frame through an effect chain ─────────────────────────────────────────

let lookEngine: Promise<Engine> | null = null;
let queue: Promise<unknown> = Promise.resolve();
const looks = new Map<string, Promise<ImageBitmap | null>>();
const srcIds = new WeakMap<HTMLCanvasElement, string>();
let srcN = 0;
let lastSrc: { canvas: HTMLCanvasElement; source: CustomSource } | null = null;

const plainEffects = (effects: Pick<EffectInstance, "type" | "params" | "enabled">[]) => effects.map((e, i) => ({
  id: `e${i}`, type: e.type, enabled: e.enabled !== false,
  params: Object.fromEntries(Object.entries(e.params).map(([k, p]) => [k, { value: (p as { value: unknown }).value }])),
}));

/**
 * `frame` drawn through `effects` (registry ids and params, as on a clip) at the frame's size, as an ImageBitmap.
 * One look at a time on a shared offscreen engine; results are cached by frame and chain.
 */
export function renderLook(frame: HTMLCanvasElement, effects: Pick<EffectInstance, "type" | "params" | "enabled">[], opts: { lutUrl?(look: string): string | undefined } = {}): Promise<ImageBitmap | null> {
  let fid = srcIds.get(frame);
  if (!fid) { fid = `f${++srcN}`; srcIds.set(frame, fid); }
  const chain = plainEffects(effects);
  const key = `${fid}|${frame.width}x${frame.height}|${JSON.stringify(chain)}`;
  let p = looks.get(key);
  if (p) return p;
  p = (queue = queue.then(async () => {
    const m = await mod();
    lookEngine ??= m.createEngine({ width: frame.width, height: frame.height });
    const eng = await lookEngine;
    if (eng.width !== frame.width || eng.height !== frame.height) eng.resize(frame.width, frame.height);
    if (lastSrc?.canvas !== frame) lastSrc = { canvas: frame, source: { kind: "canvas", width: frame.width, height: frame.height, still: true, draw: () => frame } };
    const url = `looks:${fid}`;
    const W = frame.width, H = frame.height;
    const lutUrls: Record<string, string> = {};
    for (const e of chain) if (e.type === "look") { const l = e.params.look?.value; const u = typeof l === "string" && l !== "none" ? opts.lutUrl?.(l) : undefined; if (u) lutUrls[l as string] = u; }
    const comp = {
      width: W, height: H, fps: 25, duration: 1, background: [0, 0, 0],
      tracks: [{ id: "v", kind: "video", clips: [{
        id: "c", media: { url, kind: "video", width: W, height: H, duration: 1 }, start: 0, duration: 1, in: 0, speed: 1, fit: "contain", fx: {},
        motion: { position: { value: [W / 2, H / 2] }, scale: { value: 100 }, rotation: { value: 0 }, anchor: { value: [W / 2, H / 2] }, opacity: { value: 100 }, blend: "normal" },
        effects: chain,
      }], transitions: [] }],
      ...(Object.keys(lutUrls).length ? { lutUrls } : {}),
    } as unknown as Composition;
    await eng.load(comp, { mode: "exact", sources: { [url]: lastSrc.source } });
    await eng.renderExact(0.02);
    const px = eng.readRgba();
    const rgba = new Uint8ClampedArray(px.length);
    rgba.set(px);
    return createImageBitmap(new ImageData(rgba, W, H));
  }).catch((e) => { console.warn("[looks] render", e); return null; })) as Promise<ImageBitmap | null>;
  looks.set(key, p);
  if (looks.size > 200) { const k = looks.keys().next().value as string; void looks.get(k)?.then((b) => b?.close()); looks.delete(k); }
  return p;
}

// ── colour analysis ──────────────────────────────────────────────────────────

/** An engine function by name when this build has it (typed loosely: the shapes are checked where they're used). */
const fn = <T>(m: Mod, name: string): T | null => (typeof m[name] === "function" ? (m[name] as unknown as T) : null);

export interface WbResult { temperature: number; tint: number; from: "engine" | "cpu" }

/** Auto white balance for the picture at `t` of a media URL, in the Adjust effect's units. */
export async function analyzeWb(url: string, t: number): Promise<WbResult | null> {
  // the frame is read here (any source: the demo's procedural clips too) and handed to the engine as a picture
  const c = await grabFrame(url, t, { maxW: 320 });
  if (!c) return null;
  const analyze = fn<(ref: { image: HTMLCanvasElement }) => Promise<{ wb?: { temperature?: number; tint?: number } }>>(await mod(), "analyzeColor");
  if (analyze) {
    try {
      const r = await analyze({ image: c });
      if (r?.wb && Number.isFinite(r.wb.temperature)) return { temperature: r.wb.temperature!, tint: r.wb.tint ?? 0, from: "engine" };
    } catch (e) { console.warn("[looks] analyzeColor", e); }
  }
  return { ...greyWorldWb(frameStats(canvasFrame(c), { midtones: true })), from: "cpu" };
}

/** Adjust + colour wheels (drawn everywhere), and the engine's exact Lab transfer as .cube text (`cube`, 17³) for a
 *  caller that can keep it with the edit so every window (the export too) loads it. */
export interface MatchResult { adjust?: Record<string, number>; wheels?: { lift: number[]; gamma: number[]; gain: number[] }; cube?: string; from: "engine" | "cpu" }

/** The grade that makes `source` look like `reference` (each a media URL at a time, or a picture). */
export async function matchLook(source: { url: string; t: number }, reference: { url: string; t: number } | { canvas: HTMLCanvasElement }): Promise<MatchResult | null> {
  type Match = { adjust?: Record<string, number>; wheels?: { lift: number[]; gamma: number[]; gain: number[] }; cube?: string };
  const a = await grabFrame(source.url, source.t, { maxW: 320 });
  const b = "canvas" in reference ? reference.canvas : await grabFrame(reference.url, reference.t, { maxW: 320 });
  if (!a || !b) return null;
  const match = fn<(a: unknown, b: unknown, o?: { register?: boolean; size?: number }) => Promise<Match>>(await mod(), "matchColor");
  if (match) {
    try {
      const r = await match({ image: a }, { image: b }, { register: false, size: 17 });
      if (r && (r.adjust || r.wheels)) return { adjust: r.adjust, wheels: r.wheels, ...(typeof r.cube === "string" ? { cube: r.cube } : {}), from: "engine" };
    } catch (e) { console.warn("[looks] matchColor", e); }
  }
  return { wheels: matchWheels(frameStats(canvasFrame(a)), frameStats(canvasFrame(b))), from: "cpu" };
}

/** Faces in a media URL between two source times ([] when the engine can't track, or found none). */
export async function trackFaces(url: string, from: number, to: number, opts: { fps?: number; onProgress?: (k: number) => void } = {}): Promise<{ faces: FaceSample[]; tracked: boolean }> {
  const track = fn<(u: string, a: number, b: number, o?: { fps?: number; onProgress?: (k: number) => void }) => Promise<FaceSample[]>>(await mod(), "trackFaces");
  // pictures the page draws itself (the demo) aren't files the tracker can open
  if (!track || customSource(url)) return { faces: [], tracked: false };
  try {
    const r = await track(url, from, to, { fps: opts.fps ?? 4, onProgress: opts.onProgress });
    return { faces: Array.isArray(r) ? r.filter((f) => Number.isFinite(f.t) && f.w > 0).map((f) => ({ t: f.t, x: f.x, y: f.y, w: f.w, h: f.h })) : [], tracked: true };
  } catch (e) { console.warn("[looks] trackFaces", e); return { faces: [], tracked: false }; }
}

/** The engine's GPU scope of a frame when it has them, else null (the CPU scopes take over). */
export async function engineScopes(kind: string, frame?: unknown): Promise<ImageBitmap | null> {
  const scopes = fn<(k: string, f?: unknown) => Promise<unknown>>(await mod(), "computeScopes");
  if (!scopes) return null;
  try {
    const r = await scopes(kind, frame);
    if (typeof ImageBitmap !== "undefined" && r instanceof ImageBitmap) return r;
  } catch { /* fall back to the CPU */ }
  return null;
}
