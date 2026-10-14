/**
 * The engine's input (docs/ENGINE.md §3, docs/EDITOR.md §6). A Composition is plain data: fromEpisode (studio
 * preview), fromPlan (desktop render) and the editor's toComposition make one, the renderer draws it. Times are
 * seconds on the cut.
 *
 * Two kinds of track coexist:
 * - "main" / "layer" (the studio cut): the main track fills the frame (cover) and blends shots with `transitionIn`;
 *   layers are placed by `transform` (centre, width fraction).
 * - "video" (the editor): any number of tracks, bottom → top. Every clip is placed by `motion` (Premiere-style:
 *   position and anchor in pixels, scale in % of the fitted size), carries an ordered `effects` chain with keyframed
 *   parameters, and the track's `transitions` sit at cuts or clip edges. Clips can be media, titles, colour mattes,
 *   adjustment clips (effects on everything below) or nested compositions.
 * `motion`, `effects` and the new clip types work on every kind of track.
 */
import type { Easing, FxMask, MoveKind, ShotFx, TransitionParam } from "../lib/fx";

export type { AdjustKey, ChromaKey, Curves, Easing, FxMask, Glow, MoveKind, Rgb, ShotFx, TransitionParam, Wheels } from "../lib/fx";

export type BlendMode = "normal" | "add" | "multiply" | "screen" | "overlay" | "lighten" | "darken";
export const BLEND_MODES: BlendMode[] = ["normal", "add", "multiply", "screen", "overlay", "lighten", "darken"];

/** Keyframe easing; "hold" keeps the value until the next keyframe. "bezier" takes the segment's curve from the start
 *  key's `out` and the end key's `in` handles (CSS cubic-bezier); "bounce" / "elastic" are Penner's easeOut curves. */
export type KeyEase = Easing | "hold" | "bezier" | "bounce" | "elastic";

export interface Composition {
  width: number; height: number; fps: number; duration: number;
  /** Drawn bottom → top (with "main" / "layer" tracks, tracks[0] is the main track). */
  tracks: Track[];
  background?: [number, number, number];
  /** Draw on transparency instead of `background` (alpha exports of graphics: docs/EDITOR.md §16.11). */
  transparent?: boolean;
  /** look id ("cinematic", "lut:<id>") → .cube URL; the renderer loads them on `load()`. */
  lutUrls?: Record<string, string>;
  /** Pixel-sized effects (sharpen, blur, glow radius) are multiplied by this: a preview drawn smaller than the export
   *  passes previewHeight / exportHeight so it looks like the export. Default 1. */
  pixelScale?: number;
  /** What a builder couldn't map (shown by the lab page; the desktop render logs them). */
  warnings?: string[];
  /** How stills become YUV: "bt601" (default) gives the very values FFmpeg's untagged encode does. */
  stillsMatrix?: "bt601" | "bt709";
  /** Run look LUTs, colorbalance and vibrance on the RGB FFmpeg sees for untagged video and stills (BT.601). Default on. */
  ffmpegRgb?: boolean;
  /** Preset looks made of eq / colorbalance / vibrance / hue / colorchannelmixer / negate run as those FFmpeg filters
   *  (closer to the server render than their .cube); false uses the LUTs from `lutUrls`. Default on. */
  nativeLooks?: boolean;
  /** The delivery signal for readYuv420p10() (default SDR BT.709). HLG / PQ map the working space's 1.0 to 203 cd/m²
   *  (BT.2408) and keep half-float highlights above it; bt2020 also switches the Y'CbCr matrix. The canvas, readRgba
   *  and the 8-bit readYuv420() stay SDR BT.709. */
  output?: { transfer: "sdr" | "hlg" | "pq"; primaries: "bt709" | "bt2020" };
}

export interface Track {
  id: string;
  /** "main" / "layer": the studio cut; "video": an editor track (see the file comment). */
  kind: "main" | "layer" | "video";
  hidden?: boolean;
  /** 0..1, multiplies every clip's opacity. */
  opacity?: number;
  /** Default blend of the track's clips (a clip's motion.blend wins). */
  blend?: BlendMode;
  clips: Clip[];
  /** Transitions at cuts between two clips of this track, or at one clip's edge (fade from / to nothing). */
  transitions?: TrackTransition[];
}

export interface TrackTransition {
  id?: string;
  /** xfade id, "gl:<name>" or a registered custom id. */
  type: string;
  /** Seconds on the cut: the cut (from's end = to's start), or the edge of the one clip. */
  at: number;
  duration: number;
  /** Where it sits around `at`: centred, starting at the cut, or ending at it (default centre). */
  alignment?: "center" | "start" | "end";
  /** Explicit start (seconds), overriding `at` + `alignment`. */
  start?: number;
  /** Clip ids: the outgoing and incoming clip; one may be missing at an edge (it transitions from / to transparent). */
  from?: string; to?: string;
  params?: Record<string, TransitionParam>;
  easing?: KeyEase;
}

export interface Media { url: string; kind: "video" | "image"; width?: number; height?: number; duration?: number }

/** A value that may change over the clip: `t` (seconds from the clip's start) or `frame` (at the composition's fps).
 *  `ease` shapes the segment from this key to the next. With ease "bezier": `out` (this key) and `in` (the next key)
 *  are the cubic-bezier handles in normalised time / value, exactly CSS cubic-bezier(out[0], out[1], in[0], in[1])
 *  between the two keys (defaults: linear). Spatial values ([x, y] …): `tangentOut` (this key) and `tangentIn` (the
 *  next key) are handle offsets from each key's value, so the path is the cubic Bézier value₀, value₀ + tangentOut,
 *  value₁ + tangentIn, value₁ (a cubic Hermite with tangents 3·tangentOut and −3·tangentIn); the timing along it still
 *  comes from the ease. */
export interface ParamKey<T = unknown> {
  t?: number; frame?: number; value: T; ease?: KeyEase;
  out?: [number, number]; in?: [number, number];
  tangentOut?: number[]; tangentIn?: number[];
}
export interface Param<T = unknown> { value: T; keyframes?: ParamKey<T>[] }

/** Premiere-style motion: position and anchor in pixels (composition pixels / the picture's own pixels), scale in % of
 *  the picture fitted to the frame (`fit`), rotation in degrees clockwise, opacity in % (0..100). */
export interface Motion {
  position?: Param<[number, number]>;
  scale?: Param<number>;
  rotation?: Param<number>;
  anchor?: Param<[number, number]>;
  opacity?: Param<number>;
  blend?: BlendMode;
}

/** One effect of a clip's chain: `type` is a registry id (listEffects()); a param is a Param or a plain value. */
export interface EffectInstance {
  id?: string; type: string; enabled?: boolean;
  params?: Record<string, Param | unknown>;
  /** Confines this effect to a shape (the clip's picture coordinates, 0..1). */
  mask?: FxMask;
}

/** A title (EDITOR.md §2): size in composition pixels, box = x, y, w, h as fractions of the frame. */
export interface TitleSpec {
  text: string; font: string; size: number; color: string; weight: number; align: "left" | "center" | "right";
  outline?: { color: string; width: number };
  shadow?: { color: string; blur: number; x: number; y: number };
  background?: { color: string; padding: number; radius: number };
  box: [number, number, number, number];
  animIn?: "none" | "fade" | "slide_up" | "typewriter" | "pop";
  animOut?: "none" | "fade" | "slide_down";
}

export type ClipType = "media" | "title" | "color" | "adjustment" | "nested";

export interface Clip {
  id: string;
  /** Default "media". */
  type?: ClipType;
  /** Media clips (others: `{ url: "", kind: "image" }`). */
  media: Media;
  /** Seconds on the cut where the clip starts (a transition overlaps the clip before it). */
  start: number;
  /** Seconds on the cut (after speed), including any `hold`. */
  duration: number;
  /** Source seconds at the clip's start (trim); nested: seconds into the nested composition. */
  in: number;
  /** 0.25..4; reverse plays from in + duration·speed backwards. 0 freezes the frame at `in` (a freeze frame). */
  speed: number;
  /** Speed ramps: local seconds (from the clip's start) → source seconds (in the media, absolute), piecewise linear
   *  through the points, non-decreasing (a flat segment is a freeze). Wins over in / speed / reverse; held before the
   *  first point and after the last (transition handles extend the end segments). */
  timeMap?: TimePoint[];
  reverse?: boolean;
  /** How the picture fits the frame ("fill" stretches): the main track crops (cover), motion scales from it. */
  fit: "cover" | "contain" | "fill";
  /** Crop aim for cover (0..1, face-aware reframe). */
  center?: [number, number];
  /** Ken Burns, as fx.move. */
  move?: { kind: MoveKind; amount: number };
  /** Stills: the default slow push-in (zoompan z = min(zoom + 0.0009, 1.12) per frame). */
  kenburns?: boolean;
  /** Layers: centre x, y (0..1), scale (width fraction), rotation (degrees clockwise), opacity, keyframes. */
  transform?: Transform;
  /** Editor placement (wins over `transform`). */
  motion?: Motion;
  /** §2: look, adjust, wheels, curves, chroma, mask, glow, flips, fades (main track: to black; elsewhere: alpha).
   *  Drawn first, exactly as the FFmpeg render does; then `effects`. */
  fx: ShotFx;
  /** Registry effects, in order, after `fx`. */
  effects?: EffectInstance[];
  transitionIn?: { type: string; duration: number; params?: Record<string, TransitionParam>; easing?: Easing };
  /** Seconds at the end that freeze the last frame (the timeline's "hold" trim mode; preview only). */
  hold?: number;
  /** Shot code or layer name, for logs and the lab page. */
  label?: string;
  title?: TitleSpec;
  /** Colour matte: "#RRGGBB" (or "#RRGGBBAA"). */
  color?: string;
  /** Nested composition, drawn into a texture (its time = in + (t − start)·speed). */
  comp?: Composition;
}

/** One point of Clip.timeMap: `t` local seconds, `s` source seconds. */
export interface TimePoint { t: number; s: number }

export interface Transform { x: number; y: number; scale: number; rotation: number; opacity: number; keyframes?: Keyframe[] }

/** `t` = seconds from the clip's start; linear between keyframes, held before the first and after the last.
 *  `easing` shapes the segment from this keyframe to the next (default linear). */
export interface Keyframe { t: number; x?: number; y?: number; scale?: number; opacity?: number; rotation?: number; easing?: Easing }
export type KfKey = "x" | "y" | "scale" | "opacity" | "rotation";
