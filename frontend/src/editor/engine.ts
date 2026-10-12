/**
 * The editor's one door to the GPU engine (frontend/src/engine, docs/ENGINE.md §4). Everything the editor uses goes
 * through here: createEngine → load(comp, {mode: "live", sources}) → drawLive(t, {playing, rate}), resize, dispose,
 * warnings, and the catalogue (listTransitions / listEffects). The engine is its own lazily loaded chunk.
 *
 * Titles and colour mattes are drawn here (Canvas2D) and handed to the engine as custom sources; procedural demo media
 * comes in the same way.
 */
import type { CustomSource, Engine, TransitionInfo } from "../engine";
import type { EditProject } from "./model/types";
import { toComposition, toVideoComposition, type CompositionOptions, type CompositionResult, type GeneratedSource } from "./model/toComposition";
import { drawTitle, ensureFont } from "./render/title";

type EngineModule = typeof import("../engine");
let modP: Promise<EngineModule> | null = null;
/** True once the engine draws the editor's generic "video" tracks (docs/EDITOR.md §6): it exports FEATURES.videoTracks. */
let generic = false;
/** The engine module (loads once). */
export const engineModule = () => (modP ??= import("../engine").then((m) => {
  generic = (m as unknown as { FEATURES?: { videoTracks?: boolean } }).FEATURES?.videoTracks === true;
  return m;
}));

/**
 * The composition for a sequence, in the form this engine build draws best: generic editor tracks when it has them,
 * else V1 as the main track with motion and V2+ as layers (toComposition's mapping, with warnings for the rest).
 */
export function buildComposition(project: EditProject, sequenceId: string, opts: CompositionOptions = {}): CompositionResult {
  return generic ? toVideoComposition(project, sequenceId, opts) : toComposition(project, sequenceId, opts);
}
export const usesGenericTracks = () => generic;

export type { TransitionInfo };
/** What the engine declares about a parameter (engine/effects/registry.ts EffectParamDef), once listEffects() has it. */
export interface EngineParam { name: string; label?: string; type: string; default: unknown; min?: number; max?: number; step?: number; unit?: string; options?: { value: string | number; label: string }[]; description?: string }
export interface EngineEffect { id: string; label: string; gpuOnly: boolean; keys?: string[]; group?: string; params?: EngineParam[]; description?: string }

let transitionsP: Promise<TransitionInfo[]> | null = null;
/** Every transition the engine draws (58 xfade + the gl-transitions), loaded once. */
export const listTransitions = () => (transitionsP ??= engineModule().then((m) => m.listTransitions()).catch(() => [] as TransitionInfo[]));
/** The effects the engine draws. */
export const listEffects = (): Promise<EngineEffect[]> => engineModule().then((m) => m.listEffects()).catch(() => []);

// ── generated pictures ───────────────────────────────────────────────────────

const genCache = new Map<string, { key: string; src: CustomSource }>();

function makeGenerated(g: GeneratedSource): CustomSource {
  const c = document.createElement("canvas");
  c.width = g.width; c.height = g.height;
  const ctx = c.getContext("2d")!;
  if (g.kind === "color") {
    ctx.fillStyle = g.color; ctx.fillRect(0, 0, g.width, g.height);
    return { kind: "canvas", width: g.width, height: g.height, still: true, draw: () => c };
  }
  void ensureFont(g.spec);
  let last = NaN;
  return {
    kind: "canvas", width: g.width, height: g.height,
    draw(t: number) {
      // static between its animations: draw once
      const anim = g.spec.animIn === "typewriter" ? g.duration : 0.5;
      const key = t < anim || t > g.duration - 0.5 ? t : -1;
      if (key !== last) { last = key; drawTitle(ctx, g.spec, g.width, g.height, t, g.duration); }
      return c;
    },
  };
}

/** Custom sources for a composition's titles and mattes (reused while their spec doesn't change). */
export function generatedSources(gen: Record<string, GeneratedSource>): Record<string, CustomSource> {
  const out: Record<string, CustomSource> = {};
  for (const [url, g] of Object.entries(gen)) {
    const key = JSON.stringify(g);
    let hit = genCache.get(url);
    if (!hit || hit.key !== key) { hit = { key, src: makeGenerated(g) }; genCache.set(url, hit); }
    out[url] = hit.src;
  }
  if (genCache.size > 400) for (const k of [...genCache.keys()].slice(0, 100)) genCache.delete(k);
  return out;
}

// ── the preview engine ───────────────────────────────────────────────────────

export interface PreviewEngine {
  readonly canvas: HTMLCanvasElement;
  /** Loads a composition (a newer call supersedes one still loading). */
  load(r: CompositionResult, extra?: Record<string, CustomSource>): Promise<void>;
  draw(t: number, opts?: { playing?: boolean; rate?: number }): void;
  resize(w: number, h: number): void;
  warnings(): string[];
  lastMs(): number;
  dispose(): void;
}

export async function createPreview(canvas: HTMLCanvasElement, width: number, height: number): Promise<PreviewEngine> {
  const m = await engineModule();
  const eng: Engine = await m.createEngine({ canvas, width, height });
  let token = 0;
  let loaded = false;
  let disposed = false;
  let lastKey = "";
  return {
    canvas,
    async load(r, extra) {
      const key = JSON.stringify(r.comp);
      if (key === lastKey && loaded) return;
      const my = ++token;
      const sources = { ...generatedSources(r.generated), ...(extra ?? {}) };
      // only the custom sources this composition uses
      const used: Record<string, CustomSource> = {};
      for (const tk of r.comp.tracks) for (const c of tk.clips) if (sources[c.media.url]) used[c.media.url] = sources[c.media.url];
      await eng.load(r.comp, { mode: "live", sources: used }).catch((e) => console.warn("[editor] engine load", e));
      if (my !== token || disposed) return;
      lastKey = key;
      loaded = true;
    },
    draw(t, o) { if (loaded && !disposed) { try { eng.drawLive(t, { playing: o?.playing, rate: o?.rate }); } catch (e) { console.warn("[editor] draw", e); } } },
    resize(w, h) { if (!disposed && (eng.width !== Math.round(w) || eng.height !== Math.round(h))) eng.resize(w, h); },
    warnings: () => eng.warnings,
    lastMs: () => eng.stats.lastMs,
    dispose() { disposed = true; try { eng.dispose(); } catch { /* lost context */ } },
  };
}
