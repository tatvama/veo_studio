/**
 * Poster Studio document schema. A design is a stack of layers drawn bottom to top by Konva.
 * Geometry follows Konva: (x, y) is the layer's origin (its top-left before rotation), rotation is in degrees around
 * that origin, width/height are the unscaled box. The server stores this JSON as-is (see backend core/designs.py).
 */

export type LayerType = "image" | "text" | "shape" | "effect";
export type Role =
  | "background" | "character" | "product" | "photo" | "logo"
  | "title" | "tagline" | "credits" | "badge" | "cta" | "body"
  | "decor" | "effect";
export type Blend =
  | "normal" | "multiply" | "screen" | "overlay" | "soft-light" | "hard-light" | "lighten" | "darken"
  | "color-dodge" | "color-burn" | "difference" | "hue" | "saturation" | "color" | "luminosity";

export interface Shadow { color: string; blur: number; x: number; y: number; opacity: number }
export interface Stroke { color: string; width: number }
export interface GradientStop { offset: number; color: string }
/** linear: angle in degrees (0 = left→right, 90 = top→bottom). radial: from the centre outwards. */
export interface Gradient { type: "linear" | "radial"; angle: number; stops: GradientStop[] }
export type Paint = string | Gradient;

export interface LayerBase {
  id: string;
  type: LayerType;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  role?: Role;
  blend?: Blend;
  shadow?: Shadow | null;
  /** Template slot this layer fills (title, tagline, hero, …): lets "apply template" and AI briefs find it. */
  slot?: string;
  flipX?: boolean;
  flipY?: boolean;
}

export interface ImageFilters {
  brightness?: number; // -1 … 1
  contrast?: number; // -100 … 100
  saturation?: number; // -2 … 2 (Konva HSL)
  hue?: number; // -180 … 180
  luminance?: number; // -1 … 1
  blur?: number; // 0 … 40 px
  grayscale?: boolean;
  sepia?: boolean;
  invert?: boolean;
  noise?: number; // 0 … 1
  pixelate?: number; // 0 … 40
}

export interface AiInfo {
  kind: AiKind;
  prompt: string;
  style?: string;
  characterId?: number | null;
  outfit?: string;
  pose?: string;
  engine?: string;
  faceMatch?: number | null;
}

export interface Alternative { src: string; asset?: string; width: number; height: number }

export interface ImageLayer extends LayerBase {
  type: "image";
  src: string;
  /** Storage path on the server (designs/…, characters/…); `src` is rebuilt from it on load. */
  asset?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  /** cover: fill the box and crop; contain: fit inside; fill: stretch. */
  fit: "cover" | "contain" | "fill";
  /** Focus point for cover-crop, 0…1 in each axis (0.5, 0.5 = centre). */
  focusX?: number;
  focusY?: number;
  cornerRadius?: number;
  /** none, circle (ellipse to the box), or a soft fade at the bottom edge into the background. */
  mask?: "none" | "circle" | "fade-bottom" | "fade-top";
  stroke?: Stroke | null;
  filters?: ImageFilters;
  ai?: AiInfo | null;
  /** Other AI takes for this layer; pick one to swap it in. */
  alternatives?: Alternative[];
  /** An AI job is painting this layer. */
  pending?: { jobIds: number[]; kind: AiKind; message?: string } | null;
}

export interface TextBackground { color: string; padding: number; radius: number }

export interface TextLayer extends LayerBase {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  fill: Paint;
  align: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  lineHeight: number;
  letterSpacing: number;
  uppercase?: boolean;
  stroke?: Stroke | null;
  background?: TextBackground | null;
  /** Shrink the font so the text always fits its box (titles in templates). */
  autoFit?: boolean;
}

export type ShapeKind = "rect" | "ellipse" | "triangle" | "star" | "polygon" | "line" | "arrow" | "burst" | "ring";

export interface ShapeLayer extends LayerBase {
  type: "shape";
  shape: ShapeKind;
  fill: Paint | null;
  stroke?: Stroke | null;
  cornerRadius?: number;
  sides?: number; // polygon
  points?: number; // star / burst
  innerRatio?: number; // star / burst / ring
  dash?: number[];
}

export type EffectKind = "vignette" | "fade" | "grain" | "light-leak" | "glow" | "scanlines" | "frame";

export interface EffectLayer extends LayerBase {
  type: "effect";
  effect: EffectKind;
  color: string;
  intensity: number; // 0 … 1
  /** fade: which edge the colour comes from; light-leak: where the light enters. */
  angle?: number;
}

export type Layer = ImageLayer | TextLayer | ShapeLayer | EffectLayer;

export interface Background { color: string; gradient?: Gradient | null }

export interface DesignDoc {
  v: 1;
  background: Background;
  layers: Layer[];
  meta?: { palette?: string[]; brief?: string };
}

export type DesignStatus = "draft" | "approved";

/** A design as the API returns it. */
export interface Design {
  id: number;
  title: string;
  format: string;
  width: number;
  height: number;
  project_id: number | null;
  template: string;
  brand_kit_id: number | null;
  thumb_url: string;
  status: DesignStatus;
  revision: number;
  archived: boolean;
  created_by: number | null;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
  doc?: DesignDoc;
}

export type AiKind = "background" | "character" | "element" | "product" | "harmonize" | "restyle";

/** What a panel hands the canvas when something is dragged (or clicked) in. Built into a layer by doc.layerFromDrop. */
export type DropPayload =
  | { kind: "image"; src: string; asset?: string; width: number; height: number; role?: Role; name?: string }
  | { kind: "text"; preset: TextPresetKey; text?: string; fontFamily?: string }
  | { kind: "shape"; shape: ShapeKind; fill?: Paint | null; stroke?: Stroke | null; name?: string }
  | { kind: "effect"; effect: EffectKind; color?: string; intensity?: number }
  | { kind: "layers"; layers: Layer[] };

export const DND_MIME = "application/x-tatvam-poster";

export type TextPresetKey = "title" | "subtitle" | "tagline" | "body" | "credits" | "badge" | "cta" | "quote" | "devanagari"
  | "kannada" | "telugu" | "tamil";
