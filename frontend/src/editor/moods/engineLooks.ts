/**
 * The looks tools' side of the GPU engine (docs/EDITOR.md §10 shared interfaces), through editor/engine.ts's module:
 * - frames of the user's own media at a time (grabFrame: the demo's procedural sources, stills, or a <video> seek; a
 *   frame that fails or comes back blank is never kept, it is read again after a backoff: preview/frames.ts),
 * - analyzeColor / matchColor / trackFaces / computeScopes when engine-pack's build has them, else the CPU fallbacks in
 *   moods/scopes.ts (grey-world white balance, a mean / spread match as colour wheels) or nothing (reframe centres).
 * Everything is feature-detected, so the panels work with this engine build and get better with the next.
 */
import { customSource } from "../demoSources";
import { engineModule } from "../engine";
import { userFrame } from "../preview/frames";
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

/**
 * The picture of a media URL at `t` seconds (at most maxW wide): the demo's procedural clips draw directly, stills
 * decode, videos seek a muted <video>. Null when it can't be read (offline, a codec the browser lacks, a seek that never
 * lands) or comes back blank (a video read before its first picture): those are never cached, the next request tries
 * again after a backoff (1 s, 3 s, 9 s, then every 30 s). The same grabber as the preview cards' (preview/frames.ts).
 */
export function grabFrame(url: string, t: number, opts: { maxW?: number; image?: boolean } = {}): Promise<HTMLCanvasElement | null> {
  return userFrame(url, t, { maxW: opts.maxW ?? 320, image: opts.image });
}

/** A canvas's pixels as an RGBA frame. */
export function canvasFrame(c: HTMLCanvasElement): RgbaFrame {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
  return { data: d.data, width: c.width, height: c.height };
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
