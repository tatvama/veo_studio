/**
 * Tatvam GPU render engine (docs/ENGINE.md §4, docs/EDITOR.md §6, §10). One code base for the browser preview, the
 * desktop preview and the desktop final render:
 *   const eng = await createEngine({ canvas, width, height });
 *   await eng.load(comp, { mode: "live" | "exact" });   (again on every edit, or eng.update(comp): only changes load)
 *   eng.drawLive(t, { resolution: 0.5 })                  realtime preview from <video> elements
 *   await eng.renderExact(t)                              export: exactly the frame at t (WebCodecs)
 *   eng.readYuv420()                                      I420, BT.709 limited range
 *   eng.readYuv420p10()                                   planar 4:2:0 10-bit for Composition.output (SDR / HLG / PQ)
 * Effects come from a registry (listEffects(), registerEffect()), transitions from xfade, gl-transitions, the tv: pack
 * and registerTransition(). Import it lazily (`await import("../engine")`): it's its own chunk, gl-transitions and
 * MediaPipe others.
 *
 * Wave 3 (docs/EDITOR.md §10), engine → editor:
 *   eng.computeScopes(kind, opts?)                        "waveform" | "parade" | "vectorscope" | "histogram" of the last
 *                                                          frame → ImageBitmap (also drawn into opts.canvas)
 *   eng.renderThumbnail(id, width, kind, { source })      a transition / effect / look on the user's own frame
 *   analyzeColor(url, t)                                  { wb: { temperature, tint, gain, cast }, stats: Lab mean, std, histogram }
 *   matchColor(source, reference)                         { adjust: { saturation }, wheels, lut: { id (registered), size, lut } … }
 *   trackFaces(url, from, to, { fps })                    [{ t, x, y, w, h, cx, cy, score, faces }] (MediaPipe BlazeFace)
 *   registerLut(id, lut)                                  a LUT usable as a look id anywhere
 *   effects "input_profile", "output_transform", "hue_vs_sat", "hue_vs_hue", "luma_vs_sat", "bg_blur", "bg_replace" …
 */
import "./effects/index";
import { Renderer, type DrawOptions, type LoadOptions, type Mode, type ThumbOptions } from "./renderer";
import { WebGL2Backend } from "./gl/webgl2";
import { listEffectInfos, registerEffect as addEffect, type EffectDef, type EffectInfo } from "./effects/registry";
import { listTransitions as loadList, loadGl, registerTransition as addTransition, transitionInfos, type CustomTransition, type TransitionInfo } from "./transitions/gltransitions";
import { Scopes, type ScopeKind, type ScopeOptions } from "./scopes";
import { acquireFrame, releaseFrame, type FrameRef } from "./analysis/index";
import { LOG_CURVES } from "./colour";
import type { Composition } from "./types";

export type {
  Composition, Track, Clip, Transform, Keyframe, BlendMode, Media, ShotFx, Easing, KeyEase, TrackTransition, Motion, Param, ParamKey,
  EffectInstance, TitleSpec, ClipType,
} from "./types";
export type { TransitionInfo, TransitionParamInfo, CustomTransition } from "./transitions/gltransitions";
export type { EffectDef, EffectInfo, EffectParamDef, EffectGroup, ParamType, EffectPass, EffectApi, PassContext } from "./effects/registry";
export type { LoadOptions, Mode, DrawOptions, ThumbOptions } from "./renderer";
export type { CustomSource } from "./sources/source";
export type { ScopeKind, ScopeOptions } from "./scopes";
export type { ColorAnalysis, ColorMatch, FrameRef, LabStats, WbSuggestion, WheelsParams } from "./analysis/index";
export type { FaceBox, FaceTrack, MediaPipeStatus } from "./ml/mediapipe";
export type { TimePoint } from "./types";
export type { Lut3D } from "./cube";
export { EFFECT_GROUPS } from "./effects/registry";
export { LICENSES } from "./effects/licenses";
export { fromEpisode, dimsFor } from "./fromEpisode";
export { fromPlan, type RenderPlan } from "./fromPlan";
export { evaluate, sourceTime, sourceRate, timeMapAt } from "./timeline";
export { parseCube, lutToCube } from "./cube";
export { cubicBezier, bounceOut, elasticOut } from "./easing";
export { SCOPE_KINDS } from "./scopes";
export { PACK_GROUPS } from "./transitions/pack/types";
export { analyzeColor, matchColor, grabFrame } from "./analysis/index";
export { registerLut, unregisterLut, registeredLuts } from "./luts";
export { mediaPipeStatus, setMediaPipeOptions } from "./ml/mediapipe";

/** The camera log profiles input_profile decodes (id, label, gamut, the specification it follows). */
export const LOG_PROFILES = LOG_CURVES.map((c) => ({ id: c.id, label: c.label, gamut: c.gamut, cite: c.cite }));

/**
 * The subject's box over a video between `from` and `to` seconds, sampled at `fps` (default 4):
 * `[{ t, x, y, w, h, cx, cy, score, faces, source }]`, fractions of the frame, x / y the top-left. `source` "face" is a
 * BlazeFace detection (score ≥ 0.7), "person" the head of the main person from the selfie segmenter (wide shots,
 * small faces). Times with neither are left out. Loads MediaPipe on first use.
 */
export async function trackFaces(url: string, from: number, to: number, opts: { fps?: number; signal?: AbortSignal; onProgress?: (k: number) => void } = {}) {
  const m = await import("./ml/mediapipe");
  return m.trackFaces(url, from, to, opts);
}

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
  /** renderThumbnail(id, width, kind, { source, params, progress }). */
  thumbnails: true,
  customEffects: true,
  customTransitions: true,
  /** Wave 3: the tv: transition pack (luma mattes, light, motion, glitch & retro, 3D). */
  transitionPack: true,
  /** Effects that see the previous frame (temporal denoise, deflicker). */
  temporalEffects: true,
  /** Composition.output + readYuv420p10(). */
  hdrOutput: true,
  /** computeScopes(). */
  scopes: true,
  /** analyzeColor(), matchColor(), registerLut(). */
  colorAnalysis: true,
  /** bg_blur, bg_replace, trackFaces() (MediaPipe, loaded on first use). */
  mediapipe: true,
  /** Clip.timeMap (speed ramps: local → source seconds) and speed 0 (freeze frames), in exact and live modes. */
  timeMap: true, freezeFrames: true,
  /** ParamKey ease "bezier" (out / in handles), "bounce", "elastic"; spatial tangentOut / tangentIn on [x, y]. */
  bezierKeys: true, spatialTangents: true,
  /** CustomSource.version(t) / bounds(t): no re-upload while static, only the changed box otherwise. */
  customSourceBounds: true,
  /** A look id "url:<url>" loads that .cube in any window (matchColor's `cube` text, saved). */
  lutByUrl: true,
} as const;

/** Every effect: the built-ins (107 in eleven groups) and the registered ones, with their parameters. */
export const listEffects = (): EffectInfo[] => listEffectInfos();
/** Every transition: 58 xfade ids, the gl-transitions ("gl:<name>"), the pack ("tv:<name>"), then the registered ones. */
export const listTransitions = (): Promise<TransitionInfo[]> => loadList();
/** Adds (or replaces) an effect: GLSL `vec4 effect(vec2 uv)` (one pass or several) with declared parameters. */
export const registerEffect = (def: EffectDef): void => addEffect({ ...def, custom: def.custom ?? true });
/** Adds (or replaces) a transition in gl-transitions' GLSL format. */
export const registerTransition = (t: CustomTransition): void => addTransition(t);

/** A picture for computeScopes(): an engine (its last frame), an image or canvas, ImageData or RGBA bytes. */
export type ScopeFrame = Engine | TexImageSource | ImageData | { data: Uint8Array | Uint8ClampedArray; width: number; height: number };

let lastEngine: Engine | null = null;
let scopeGl: { backend: WebGL2Backend; scopes: Scopes; tex: import("./gl/backend").Texture } | null = null;

/**
 * A GPU scope ("waveform", "parade", "vectorscope", "histogram") of a picture, or of the last frame the most recent
 * engine drew when `frame` is left out, as an ImageBitmap (also drawn into opts.canvas). Pictures that aren't an
 * engine's frame go through a small shared offscreen context.
 */
export async function computeScopes(kind: ScopeKind, frame?: ScopeFrame | null, opts: ScopeOptions = {}): Promise<ImageBitmap> {
  const f = frame ?? lastEngine;
  if (!f) throw new Error("Nothing drawn yet");
  if (typeof (f as Engine).computeScopes === "function" && (f as Engine).renderer) return (f as Engine).computeScopes(kind, opts);
  if (!scopeGl) {
    const backend = new WebGL2Backend(typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(2, 2) : document.createElement("canvas"));
    scopeGl = { backend, scopes: new Scopes(backend), tex: backend.createTexture() };
  }
  const { backend, scopes, tex } = scopeGl;
  const pic = f as { data?: Uint8Array | Uint8ClampedArray; width: number; height: number };
  if (pic.data && !(f instanceof ImageData)) backend.uploadData(tex, pic.width, pic.height, new Uint8Array(pic.data.buffer, pic.data.byteOffset, pic.data.byteLength), "rgba8");
  else backend.upload(tex, f as TexImageSource, pic.width, pic.height);
  const s = scopes.render(kind, tex, opts);
  const rgba = new Uint8ClampedArray(s.data.length);
  rgba.set(s.data);
  const img = new ImageData(rgba, s.w, s.h);
  if (opts.canvas) {
    if (opts.canvas.width !== s.w) opts.canvas.width = s.w;
    if (opts.canvas.height !== s.h) opts.canvas.height = s.h;
    (opts.canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)?.putImageData(img, 0, 0);
  }
  return createImageBitmap(img);
}

export interface EngineOptions { canvas?: HTMLCanvasElement | OffscreenCanvas; width: number; height: number; backend?: "webgl2" }

/** renderThumbnail's options: `source` shows the user's own frame (a URL at t, or a picture). */
export interface ThumbnailOptions extends Omit<ThumbOptions, "source"> { source?: FrameRef }

export interface Engine {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly width: number;
  readonly height: number;
  /** Half-float render targets (else 8-bit). */
  readonly floatTargets: boolean;
  /** Messages about what couldn't be drawn as asked (missing LUT, unknown transition or effect, a source that failed). */
  readonly warnings: string[];
  /** uploads: texture uploads (subUploads of them only a changed part, CustomSource.bounds). */
  readonly stats: { uploads: number; passes: number; lastMs: number; restores: number; resolution: number; subUploads: number };
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
  /** The last frame as planar 4:2:0 10-bit codes in 16-bit words (w·h·1.5 of them, limited range), encoded for
   *  Composition.output (SDR / HLG / PQ; BT.709 or BT.2020 matrix): FFmpeg's yuv420p10le. Reused buffer. */
  readYuv420p10(): Uint16Array;
  /** The last frame as RGBA8, rows top first. */
  readRgba(): Uint8Array;
  resize(w: number, h: number): void;
  dispose(): void;
  listTransitions(): TransitionInfo[];
  listEffects(): EffectInfo[];
  /** A transition half-way, an effect (defaults, or opts.params) or a look ("look": id = a look id, "lut:…",
   *  "match:…") on the sample pictures, or on the user's frame (opts.source), width × width·9/16. */
  renderThumbnail(id: string, width?: number, kind?: "transition" | "effect" | "look", opts?: ThumbnailOptions): Promise<ImageBitmap>;
  /** A scope of the last frame drawn (GPU), also drawn into opts.canvas. */
  computeScopes(kind: ScopeKind, opts?: ScopeOptions): Promise<ImageBitmap>;
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
  const scopes = new Scopes(backend);
  await loadGl().catch(() => undefined);
  const bitmap = (data: Uint8Array, w: number, h: number) => { const rgba = new Uint8ClampedArray(data.length); rgba.set(data); return new ImageData(rgba, w, h); };
  const eng: Engine = {
    canvas, renderer: r,
    get floatTargets() { return backend.floatTargets; },
    get width() { return r.w; },
    get height() { return r.h; },
    get warnings() { return [...r.warnings]; },
    get stats() { return r.stats; },
    load: (comp, o) => r.load(comp, o),
    update: (comp, o) => r.update(comp, o),
    drawLive: (t, o) => { lastEngine = eng; r.drawLive(t, o); },
    renderExact: (t) => { lastEngine = eng; return r.renderExact(t); },
    readYuv420: () => r.readYuv420(),
    readYuv420p10: () => r.readYuv420p10(),
    readRgba: () => r.readRgba(),
    resize: (w, h) => r.resize(w, h),
    dispose: () => { if (lastEngine === eng) lastEngine = null; r.dispose(); },
    listTransitions: () => transitionInfos(),
    listEffects,
    async renderThumbnail(id, width = 160, kind, o = {}) {
      const w = Math.max(16, Math.round(width)), h = Math.max(9, Math.round((w * 9) / 16));
      const k = kind ?? (listEffectInfos().some((e) => e.id === id) && !transitionInfos().some((t) => t.id === id) ? "effect" : "transition");
      let source: ThumbOptions["source"];
      // a frame grabbed from a URL is held in the analysis cache while the thumbnail draws; one made here from
      // ImageData is closed afterwards (the caller's own picture is left alone)
      let own: ImageBitmap | null = null, held: (() => void) | null = null;
      if (o.source) {
        const s = o.source;
        if ("url" in s) { const t = s.t ?? 0, mw = Math.max(w * 2, 320); source = await acquireFrame(s.url, t, mw); held = () => releaseFrame(s.url, t, mw); }
        else if (s.image instanceof ImageData) { own = await createImageBitmap(s.image); source = own; }
        else source = s.image;
      }
      let px: Awaited<ReturnType<typeof r.thumbnail>>;
      try { px = await r.thumbnail(k, id, w, h, { ...o, source }); } finally { own?.close(); held?.(); }
      return createImageBitmap(bitmap(px.data, w, h));
    },
    async computeScopes(kind, o = {}) {
      if (!r.frame) throw new Error("Nothing drawn yet");
      if (backend.lost) throw new Error("The graphics card reset (WebGL context lost)");
      const s = scopes.render(kind, r.frame, o);
      const img = bitmap(s.data, s.w, s.h);
      if (o.canvas) {
        if (o.canvas.width !== s.w) o.canvas.width = s.w;
        if (o.canvas.height !== s.h) o.canvas.height = s.h;
        (o.canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)?.putImageData(img, 0, 0);
      }
      return createImageBitmap(img);
    },
  };
  return eng;
}
