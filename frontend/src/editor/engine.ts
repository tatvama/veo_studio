/**
 * The editor's one door to the GPU engine (frontend/src/engine, docs/ENGINE.md §4). Everything the editor uses goes
 * through here: createEngine → load(comp, {mode: "live", sources}) once, then update(comp) on every edit (the engine
 * loads only what changed and keeps a custom source while its object for a URL stays the same) → drawLive(t, {playing,
 * rate, resolution}), resize, dispose, warnings; the catalogue (listTransitions / listEffects with declared params)
 * and registerEffect / registerTransition for custom shaders. The engine is its own lazily loaded chunk; the panels'
 * thumbnails are preview/render.ts's shared engine.
 *
 * With FEATURES.videoTracks the engine draws titles and mattes itself; without it they're drawn here (Canvas2D) and
 * handed over as custom sources. The demo's procedural media always comes in as custom sources.
 */
import type { Composition, CustomSource, EffectInfo, EffectParamDef, Engine, TransitionInfo } from "../engine";
import type { EditProject } from "./model/types";
import { toComposition, toVideoComposition, type CompositionOptions, type CompositionResult, type GeneratedSource } from "./model/toComposition";
import { isExtendedTitle } from "./render/title";
import { generatedPicture } from "./render/generated";
import { onCanvasRestored } from "../engine/sources/canvasLoss";
import { isVisualizerGenerated, makeVisualizerCanvas, withVisualizers } from "./audiotools/source"; // audio-tools2: the visualiser (additive)

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
  // audio-tools2: visualiser clips become generated pictures too (audiotools/source.ts)
  return generic ? withVisualizers(project, sequenceId, withExtendedTitles(toVideoComposition(project, sequenceId, opts))) : toComposition(project, sequenceId, opts);
}

/**
 * Additive (editor-looks): titles with a template look, karaoke words or a shape are drawn by render/title.ts (the
 * engine's own title source draws the plain ones): they go in as generated pictures (custom sources), with motion,
 * effects and transitions kept. The same in the preview and the export (RenderJob uses buildComposition too).
 */
function withExtendedTitles(r: CompositionResult): CompositionResult {
  const walk = (comp: Composition, path: string) => {
    for (const t of comp.tracks) {
      for (let i = 0; i < t.clips.length; i++) {
        const c = t.clips[i];
        if (c.comp) walk(c.comp, `${path}${c.id}/`);
        if (c.type !== "title" || !c.title || !isExtendedTitle(c.title as never)) continue;
        const url = `gen:xtitle:${path}${c.id}`;
        r.generated[url] = { kind: "title", spec: c.title as never, width: comp.width, height: comp.height, duration: c.duration };
        const { title: _t, ...rest } = c;
        void _t;
        t.clips[i] = { ...rest, type: "media", media: { url, kind: "video", width: comp.width, height: comp.height, duration: c.duration } };
      }
    }
  };
  walk(r.comp, "");
  return r;
}
export const usesGenericTracks = () => generic;

export type { TransitionInfo };
/** An effect as the engine's registry declares it (id, label, group, params, gpuOnly, custom, keys, author …). */
export type EngineEffect = EffectInfo;
export type EngineParam = EffectParamDef;

let transitionsP: Promise<TransitionInfo[]> | null = null;
/** Every transition the engine draws (58 xfade, the gl-transitions, then registered custom ones), cached. */
export const listTransitions = () => (transitionsP ??= engineModule().then((m) => m.listTransitions()).catch(() => [] as TransitionInfo[]));
/** The effects the engine draws (the built-in registry plus custom ones). */
export const listEffects = (): Promise<EngineEffect[]> => engineModule().then((m) => m.listEffects()).catch(() => []);
/** The registry's group order. */
export const effectGroups = (): Promise<readonly string[]> => engineModule().then((m) => m.EFFECT_GROUPS as readonly string[]).catch(() => []);

// ── catalogue changes (custom shaders) ───────────────────────────────────────

const catalogSubs = new Set<() => void>();
/** Called when the catalogue changes (a custom shader was registered). */
export function onCatalog(cb: () => void) { catalogSubs.add(cb); return () => { catalogSubs.delete(cb); }; }
function catalogChanged() { transitionsP = null; catalogSubs.forEach((f) => f()); }

export interface ShaderEntry { id: string; name: string; kind: "transition" | "effect"; glsl: string }
const RESERVED = new Set(["progress", "ratio", "from", "to", "uInput", "uOriginal", "uResolution", "uTime", "uFrame", "uScale"]);

/** Uniforms a shader declares ("uniform float amount; // = 0.5", gl-transitions style) → its parameters. */
export function shaderParams(glsl: string): { name: string; type: string; default: unknown }[] {
  const out: { name: string; type: string; default: unknown }[] = [];
  const re = /uniform\s+(float|int|bool|vec2|vec3|vec4)\s+(\w+)\s*;[ \t]*(?:\/\/\s*=\s*([^\n]+))?/g;
  for (let m = re.exec(glsl); m; m = re.exec(glsl)) {
    const [, type, name, raw] = m;
    if (RESERVED.has(name) || out.some((p) => p.name === name)) continue;
    const nums = (raw ?? "").match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? [];
    const n = type === "vec2" ? 2 : type === "vec3" ? 3 : type === "vec4" ? 4 : 1;
    let def: unknown;
    if (type === "bool") def = /true/i.test(raw ?? "");
    else if (n === 1) def = nums[0] ?? 0;
    else def = Array.from({ length: n }, (_, i) => nums[i] ?? nums[0] ?? (n >= 3 ? 1 : 0));
    out.push({ name, type, default: def });
  }
  return out;
}

/** Registers custom shaders with the engine (imported ones, and all of this PC's on project open). Ids get "custom:". */
export async function registerShaders(list: ShaderEntry[]): Promise<{ ok: string[]; failed: { name: string; error: string }[] }> {
  const m = await engineModule();
  const ok: string[] = [], failed: { name: string; error: string }[] = [];
  for (const s of list) {
    const id = `custom:${s.id}`;
    const ps = shaderParams(s.glsl);
    try {
      if (s.kind === "transition") {
        m.registerTransition({ id, label: s.name, glsl: s.glsl, group: "Custom", params: ps.map((p) => ({ name: p.name, type: p.type, default: p.default as never })) });
      } else {
        const type = (t: string) => (t === "vec3" ? "rgb" : t === "vec4" ? "rgba" : t);
        m.registerEffect({ id, label: s.name, group: "Stylize", custom: true, glsl: s.glsl,
          params: ps.map((p) => ({ name: p.name, label: p.name.replace(/[_-]+/g, " "), type: type(p.type) as EffectParamDef["type"], default: p.default,
            ...(p.type === "float" ? { min: 0, max: 1, step: 0.01 } : {}) })) });
      }
      ok.push(id);
    } catch (e) { failed.push({ name: s.name, error: (e as Error).message }); }
  }
  if (ok.length) catalogChanged();
  return { ok, failed };
}

/**
 * Registers every custom shader of this PC (bridge.editor.shaders()). The editor calls it when an edit opens; a
 * window that renders an edit (the desktop's hidden GPU render page) must call it before building the composition.
 */
export async function registerDesktopShaders(): Promise<{ ok: string[]; failed: { name: string; error: string }[] }> {
  const b = (globalThis as { tatvamDesktop?: { editor?: { shaders?: () => Promise<ShaderEntry[]> } } }).tatvamDesktop?.editor;
  if (!b?.shaders) return { ok: [], failed: [] };
  const list = await b.shaders().catch(() => [] as ShaderEntry[]);
  return list.length ? registerShaders(list) : { ok: [], failed: [] };
}

// ── generated pictures (titles drawn here, mattes, visualisers) ──────────────

const genCache = new Map<string, { key: string; src: CustomSource }>();

/** Titles and mattes: render/generated.ts (drawn again after a GPU reset); visualisers: audiotools/source.ts. */
function makeGenerated(g: GeneratedSource): CustomSource {
  if (isVisualizerGenerated(g)) return makeVisualizerCanvas(g); // audio-tools2
  return generatedPicture(g);
}

/**
 * Called once after a GPU reset (the browser brought the 2D canvases back blank, or the engine's WebGL context came
 * back): the generated pictures draw again on the next frame, so a monitor should draw now (engine/sources/canvasLoss.ts).
 */
export const onPicturesRestored = (cb: () => void) => onCanvasRestored(cb);

/** Custom sources for a composition's titles and mattes: the same object for a URL while its content is the same
 *  (so update() keeps them). */
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

/** Every media URL a composition uses, nested compositions included. */
function urlsOf(comp: Composition, out = new Set<string>()): Set<string> {
  for (const t of comp.tracks) for (const c of t.clips) { if (c.media?.url) out.add(c.media.url); if (c.comp) urlsOf(c.comp, out); }
  return out;
}

// ── the preview engine ───────────────────────────────────────────────────────

export interface PreviewEngine {
  readonly canvas: HTMLCanvasElement;
  /** Loads a composition: the first time in full, then only what changed (a newer call supersedes one in flight). */
  load(r: CompositionResult, extra?: Record<string, CustomSource>): Promise<void>;
  /** `resolution`: 1, 0.5 or 0.25 of the output (playback resolution). */
  draw(t: number, opts?: { playing?: boolean; rate?: number; resolution?: number }): void;
  resize(w: number, h: number): void;
  warnings(): string[];
  lastMs(): number;
  dispose(): void;
  /** Additive (editor-looks, Scopes): the last frame drawn as RGBA (rows top first) at its render size. */
  readFrame(): { data: Uint8Array; width: number; height: number } | null;
}

export async function createPreview(canvas: HTMLCanvasElement, width: number, height: number): Promise<PreviewEngine> {
  const m = await engineModule();
  const eng: Engine = await m.createEngine({ canvas, width, height });
  let token = 0;
  let loaded = false;
  let disposed = false;
  let lastKey = "";
  let chain: Promise<void> = Promise.resolve();
  return {
    canvas,
    load(r, extra) {
      // the generated pictures too: a template title's spec lives there, not in the composition (an edit of its text
      // changes nothing else, and the monitor would keep the old words)
      const key = `${JSON.stringify(r.comp)}\n${JSON.stringify(r.generated)}`;
      const my = ++token;
      chain = chain.then(async () => {
        if (my !== token || disposed || (key === lastKey && loaded)) return;
        const sources = { ...generatedSources(r.generated), ...(extra ?? {}) };
        const used: Record<string, CustomSource> = {};
        for (const u of urlsOf(r.comp)) if (sources[u]) used[u] = sources[u];
        const opts = { mode: "live" as const, sources: used };
        await (loaded ? eng.update(r.comp, opts) : eng.load(r.comp, opts)).catch((e) => console.warn("[editor] engine load", e));
        if (disposed) return;
        lastKey = key;
        loaded = true;
      });
      return chain;
    },
    draw(t, o) {
      if (!loaded || disposed) return;
      try { eng.drawLive(t, { playing: o?.playing, rate: o?.rate, resolution: o?.resolution }); } catch (e) { console.warn("[editor] draw", e); }
    },
    resize(w, h) { if (!disposed && (eng.width !== Math.round(w) || eng.height !== Math.round(h))) eng.resize(w, h); },
    warnings: () => eng.warnings,
    lastMs: () => eng.stats.lastMs,
    dispose() { disposed = true; try { eng.dispose(); } catch { /* lost context */ } },
    readFrame() {
      if (!loaded || disposed) return null;
      try {
        const res = eng.stats.resolution || 1;
        const width = Math.max(2, Math.round(eng.width * res)), height = Math.max(2, Math.round(eng.height * res));
        const data = eng.readRgba();
        return data.length === width * height * 4 ? { data, width, height } : null;
      } catch { return null; }
    },
  };
}
