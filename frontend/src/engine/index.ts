/**
 * Tatvam GPU render engine (docs/ENGINE.md §4, docs/EDITOR.md §6). One code base for the browser preview, the desktop
 * preview and the desktop final render:
 *   const eng = await createEngine({ canvas, width, height });
 *   await eng.load(comp, { mode: "live" | "exact" });   (again on every edit, or eng.update(comp): only changes load)
 *   eng.drawLive(t, { resolution: 0.5 })                  realtime preview from <video> elements
 *   await eng.renderExact(t)                              export: exactly the frame at t (WebCodecs)
 *   eng.readYuv420()                                      I420, BT.709 limited range
 * Effects come from a registry (listEffects(), registerEffect()), transitions from xfade, gl-transitions and
 * registerTransition(). Import it lazily (`await import("../engine")`): it's its own chunk, gl-transitions another.
 */
import "./effects/index";
import { Renderer, type DrawOptions, type LoadOptions, type Mode } from "./renderer";
import { WebGL2Backend } from "./gl/webgl2";
import { listEffectInfos, registerEffect as addEffect, type EffectDef, type EffectInfo } from "./effects/registry";
import { listTransitions as loadList, loadGl, registerTransition as addTransition, transitionInfos, type CustomTransition, type TransitionInfo } from "./transitions/gltransitions";
import type { Composition } from "./types";

export type {
  Composition, Track, Clip, Transform, Keyframe, BlendMode, Media, ShotFx, Easing, KeyEase, TrackTransition, Motion, Param, ParamKey,
  EffectInstance, TitleSpec, ClipType,
} from "./types";
export type { TransitionInfo, TransitionParamInfo, CustomTransition } from "./transitions/gltransitions";
export type { EffectDef, EffectInfo, EffectParamDef, EffectGroup, ParamType, EffectPass, EffectApi, PassContext } from "./effects/registry";
export type { LoadOptions, Mode, DrawOptions } from "./renderer";
export type { CustomSource } from "./sources/source";
export { EFFECT_GROUPS } from "./effects/registry";
export { LICENSES } from "./effects/licenses";
export { fromEpisode, dimsFor } from "./fromEpisode";
export { fromPlan, type RenderPlan } from "./fromPlan";
export { evaluate } from "./timeline";
export { parseCube } from "./cube";

/**
 * What this engine build draws (the editor picks its Composition shape from it, docs/EDITOR.md §6):
 * videoTracks: "video" tracks with motion, effects chains, track transitions, titles, mattes, adjustment and nested
 * clips (toVideoComposition's shape). Every other flag names one part of that, or of the API.
 */
export const FEATURES = {
  videoTracks: true,
  /** Track.transitions at cuts and clip edges (alignment, handles), on any track. */
  trackTransitions: true,
  /** Clip.motion: position / scale / rotation / anchor / opacity keyframes, blend modes, on any track. */
  motion: true,
  /** listEffects() with params and groups; Clip.effects with keyframed params; registerEffect(). */
  effectRegistry: true,
  keyframedEffects: true,
  /** Clip types: "title" (TitleSpec, drawn by the engine), "color", "adjustment", "nested" (Clip.comp). */
  titles: true, colorMattes: true, adjustmentClips: true, nested: true,
  /** load() again (or update()) reloads only what changed; custom sources stay while their object does. */
  incrementalLoad: true,
  /** Composition.lutUrls for preset looks and "lut:<id>". */
  lutUrls: true,
  /** Preset looks made of FFmpeg filters run as those filters (Composition.nativeLooks). */
  nativeLooks: true,
  /** drawLive(t, { resolution: 0.5 | 0.25 }). */
  playbackResolution: true,
  /** A lost WebGL context comes back by itself (textures re-created on the next frame). */
  contextRestore: true,
  /** renderThumbnail(id, width). */
  thumbnails: true,
  customEffects: true,
  customTransitions: true,
} as const;

/** Every effect: the built-ins (67 in eight groups) and the registered ones, with their parameters. */
export const listEffects = (): EffectInfo[] => listEffectInfos();
/** Every transition: 58 xfade ids, then the gl-transitions ("gl:<name>"), then the registered ones. */
export const listTransitions = (): Promise<TransitionInfo[]> => loadList();
/** Adds (or replaces) an effect: GLSL `vec4 effect(vec2 uv)` (one pass or several) with declared parameters. */
export const registerEffect = (def: EffectDef): void => addEffect({ ...def, custom: def.custom ?? true });
/** Adds (or replaces) a transition in gl-transitions' GLSL format. */
export const registerTransition = (t: CustomTransition): void => addTransition(t);

export interface EngineOptions { canvas?: HTMLCanvasElement | OffscreenCanvas; width: number; height: number; backend?: "webgl2" }

export interface Engine {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly width: number;
  readonly height: number;
  /** Half-float render targets (else 8-bit). */
  readonly floatTargets: boolean;
  /** Messages about what couldn't be drawn as asked (missing LUT, unknown transition or effect, a source that failed). */
  readonly warnings: string[];
  readonly stats: { uploads: number; passes: number; lastMs: number; restores: number; resolution: number };
  /** Takes a composition; call it again on every edit (only what changed is loaded). A new mode starts over. */
  load(comp: Composition, opts?: LoadOptions): Promise<void>;
  /** load() with the last options. */
  update(comp: Composition, opts?: LoadOptions): Promise<void>;
  /** Realtime preview. `playing` (else guessed from how t moves) lets the videos run on their own; `resolution`
   *  draws at 1, ½ or ¼ of the output size. */
  drawLive(t: number, opts?: DrawOptions): void;
  renderExact(t: number): Promise<void>;
  /** The last frame as I420 (w·h·1.5 bytes, BT.709 limited range). The buffer is reused: copy it to keep it. */
  readYuv420(): Uint8Array;
  /** The last frame as RGBA8, rows top first. */
  readRgba(): Uint8Array;
  resize(w: number, h: number): void;
  dispose(): void;
  listTransitions(): TransitionInfo[];
  listEffects(): EffectInfo[];
  /** A transition half-way, or an effect with its defaults, on two sample pictures (width × width·9/16). */
  renderThumbnail(id: string, width?: number, kind?: "transition" | "effect"): Promise<ImageBitmap>;
  /** The renderer underneath (the lab page and tests). */
  readonly renderer: Renderer;
}

export async function createEngine(opts: EngineOptions): Promise<Engine> {
  if (opts.backend && opts.backend !== "webgl2") throw new Error(`Backend ${opts.backend} isn't available`);
  const canvas = opts.canvas ?? (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(opts.width, opts.height) : document.createElement("canvas"));
  canvas.width = opts.width;
  canvas.height = opts.height;
  const backend = new WebGL2Backend(canvas);
  const r = new Renderer(backend);
  r.w = opts.width; r.h = opts.height;
  await loadGl().catch(() => undefined);
  return {
    canvas, renderer: r,
    get floatTargets() { return backend.floatTargets; },
    get width() { return r.w; },
    get height() { return r.h; },
    get warnings() { return [...r.warnings]; },
    get stats() { return r.stats; },
    load: (comp, o) => r.load(comp, o),
    update: (comp, o) => r.update(comp, o),
    drawLive: (t, o) => r.drawLive(t, o),
    renderExact: (t) => r.renderExact(t),
    readYuv420: () => r.readYuv420(),
    readRgba: () => r.readRgba(),
    resize: (w, h) => r.resize(w, h),
    dispose: () => r.dispose(),
    listTransitions: () => transitionInfos(),
    listEffects,
    async renderThumbnail(id, width = 160, kind) {
      const w = Math.max(16, Math.round(width)), h = Math.max(9, Math.round((w * 9) / 16));
      const k = kind ?? (listEffectInfos().some((e) => e.id === id) && !transitionInfos().some((t) => t.id === id) ? "effect" : "transition");
      const px = await r.thumbnail(k, id, w, h);
      const rgba = new Uint8ClampedArray(px.data.length);
      rgba.set(px.data);
      return createImageBitmap(new ImageData(rgba, w, h));
    },
  };
}
