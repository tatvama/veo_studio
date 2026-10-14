/**
 * The News Room renderer's contract (docs/EDITOR.md §16.3). The core (render/index.ts) draws a template's layers into
 * a W×H Canvas2D at time t: it resolves the look, fields and overrides, maps design pixels to the canvas, applies each
 * layer's in / out / loop animation as a transform, opacity and mask, and asks the layer's kind to draw its content.
 * Kinds register themselves (render/kinds/*.ts → `registerLayerKind`). Pure types.
 */
import type { Box, ChannelLook, FontName, GfxImageRef, GfxLayer, GfxRatio, GfxTemplate, GfxValue, NumberFormat, Paint } from "../types.ts";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Everything one graphic needs to draw (also what the composition hands the engine as a generated source). */
export interface GfxRenderInput {
  template: GfxTemplate;
  values: Record<string, GfxValue>;
  look: ChannelLook;
  /** mediaId → URL of every image the graphic uses (photos, the look's logo), resolved by the composition. */
  images: Record<string, string>;
  /** Epoch ms the clocks show at the clip's first frame (air time + where the clip starts); unset = 19:00 today. */
  clockAt?: number;
  overrides?: Record<string, Partial<GfxLayer>>;
  seed: number;
  /** Frame rate of the sequence (stagger and blink timing snap to frames for exact exports). */
  fps: number;
  /** The design to use; default: from W / H (nearest of the template's designs). */
  ratio?: GfxRatio;
  /** Other graphics on screen that this one must keep clear of (collision rules): their boxes as frame fractions. */
  avoid?: { role: string; box: [number, number, number, number] }[];
}

/** What a kind gets while drawing. The context is already in design pixels (0..designW × 0..designH). */
export interface LayerRenderContext {
  /** Seconds into the clip, and its length. */
  t: number; dur: number;
  /** The layer's own phases: in 0 → 1 while it comes in, out 1 → 0 while it leaves (1 / 1 = fully shown). Kinds that
   *  build by themselves (a list item by item, a counting number) use these; the core already applies the layer's
   *  in / out transform for kinds that don't (`ownsAnim` false). */
  phase: { in: number; out: number };
  /** Seconds since the layer finished coming in (loops, crawls), ≥ 0. */
  shown: number;
  look: ChannelLook; ratio: GfxRatio;
  designW: number; designH: number;
  /** Canvas pixels per design pixel. */
  scale: number;
  seed: number; fps: number;
  /** Epoch ms the clock shows at this frame. */
  clock: number;
  /** A field's value (after language, data binding and defaults). */
  value(id: string): GfxValue;
  /** Text with "{field}" tokens filled in (and the look's capitals when `upper`). */
  text(s: string, upper?: boolean): string;
  paint(p: Paint | undefined, fallback?: string): string | CanvasGradient;
  /** A CSS font string for a font name ("@headline" …), size (design px), weight; picks the script's font for `sample`. */
  font(name: FontName | undefined, size: number, weight?: number, sample?: string): string;
  /** A decoded image (null while it loads: the export waits for `ensureGraphicAssets`). */
  image(ref: GfxImageRef | string | undefined | null): CanvasImageSource | null;
  /** The look's logo as an image, or null (then draw the look's text logo). */
  logo(): CanvasImageSource | null;
  number(n: number, f?: NumberFormat): string;
  /** Deterministic 0..1 noise for this graphic. */
  rand(i: number): number;
  /** Easing by the look's motion style. */
  ease(x: number, kind?: string): number;
}

export type PropType =
  | "paint" | "font" | "number" | "text" | "longtext" | "bool" | "choice" | "field" | "layer" | "icon" | "image" | "box";

/** One property of a layer kind, for the Designer's inspector and defaults. `key` is a key of `GfxLayer.p`. */
export interface PropDef {
  key: string; label: string; type: PropType; default: unknown;
  min?: number; max?: number; step?: number; unit?: string;
  options?: { value: string; label: string }[];
  group?: string; hint?: string;
}

export interface LayerKindDef {
  kind: string; label: string;
  group: "Basic" | "Text" | "Data" | "Video" | "Motion";
  props: PropDef[];
  /** Draws the layer's content inside `layer.box` (design px). */
  draw(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext): void;
  /** True when the picture changes over time while shown (crawl, clock, count, procedural motion) → redrawn every
   *  frame; otherwise only while animating in / out / looping. */
  animates?(layer: GfxLayer, rc: Pick<LayerRenderContext, "value" | "dur">): boolean;
  /** The kind handles its own in / out (lists build per item, numbers count, tickers wipe on): the core then applies
   *  no transform for `anim.in` / `anim.out`, only passes `phase`. */
  ownsAnim?: boolean;
  /** Width the content needs (for text-driven plate growth); design px. */
  measure?(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext): number;
  /** Fonts it will use (the export loads them first). */
  fonts?(layer: GfxLayer, rc: Pick<LayerRenderContext, "look" | "value" | "text">): string[];
  /** Images it will use (mediaIds or URLs). */
  images?(layer: GfxLayer, rc: Pick<LayerRenderContext, "look" | "value">): string[];
}

/** A rectangle in canvas pixels (what changed this frame), or null when nothing is drawn. */
export type DirtyRect = [number, number, number, number] | null;

export type { Box };
