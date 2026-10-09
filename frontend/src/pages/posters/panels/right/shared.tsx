/** Bits shared by the right panel's sections: the layer patch hook, friendly names, layer glyphs. */
import {
  Aperture, ArrowRight, Blend, Circle, CircleDot, Frame, Hexagon, Image as ImageIcon, Minus, Rows3, Sparkle, Sparkles, Square, Star, Sun, Triangle,
  Type, Waves, type LucideIcon,
} from "lucide-react";
import { useCallback } from "react";
import { cn } from "../../../../lib/cn";
import { useEditor } from "../../store";
import type { Blend as BlendMode, EffectKind, Layer, Role, ShapeKind } from "../../types";

type T = (s: string) => string;

const NO_PALETTE: string[] = [];

/** Patch one layer; `key` makes repeated edits of the same field one undo step (`${id}:${key}`). */
export function useLayerPatch(id: string) {
  const patchLayer = useEditor((s) => s.patchLayer);
  return useCallback((p: Partial<Layer>, key?: string) => patchLayer(id, p, key ? `${id}:${key}` : undefined), [id, patchLayer]);
}

/** The document's palette (from its template, brand kit or AI plan). */
export const usePalette = () => useEditor((s) => s.doc.meta?.palette ?? NO_PALETTE);

/** Design size, for sensible defaults (shadow blur, stroke width…). */
export const useShortSide = () => useEditor((s) => Math.min(s.width, s.height));

export function blendGroups(t: T): { label: string; options: { value: BlendMode; label: string }[] }[] {
  return [
    { label: t("Normal"), options: [{ value: "normal", label: t("Normal") }] },
    { label: t("Darken"), options: [{ value: "darken", label: t("Darken") }, { value: "multiply", label: t("Multiply") }, { value: "color-burn", label: t("Colour burn") }] },
    { label: t("Lighten"), options: [{ value: "lighten", label: t("Lighten") }, { value: "screen", label: t("Screen") }, { value: "color-dodge", label: t("Colour dodge") }] },
    { label: t("Contrast"), options: [{ value: "overlay", label: t("Overlay") }, { value: "soft-light", label: t("Soft light") }, { value: "hard-light", label: t("Hard light") }] },
    { label: t("Inversion"), options: [{ value: "difference", label: t("Difference") }] },
    { label: t("Component"), options: [{ value: "hue", label: t("Hue") }, { value: "saturation", label: t("Saturation") }, { value: "color", label: t("Colour") }, { value: "luminosity", label: t("Luminosity") }] },
  ];
}

export function roleLabels(t: T): Record<Role, string> {
  return {
    background: t("Background"), character: t("Character"), product: t("Product"), photo: t("Photo"), logo: t("Logo"), title: t("Title"),
    tagline: t("Tagline"), credits: t("Credits"), badge: t("Badge"), cta: t("Button"), body: t("Body"), decor: t("Decor"), effect: t("Effect"),
  };
}

export function typeLabel(t: T, l: Layer): string {
  if (l.type === "text") return t("Text");
  if (l.type === "image") return t("Image");
  if (l.type === "shape") return shapeLabels(t)[l.shape];
  return effectLabels(t)[l.effect];
}

export function shapeLabels(t: T): Record<ShapeKind, string> {
  return {
    rect: t("Rectangle"), ellipse: t("Ellipse"), triangle: t("Triangle"), star: t("Star"), polygon: t("Polygon"), line: t("Line"), arrow: t("Arrow"),
    burst: t("Burst"), ring: t("Ring"),
  };
}

export function effectLabels(t: T): Record<EffectKind, string> {
  return {
    vignette: t("Vignette"), fade: t("Fade to colour"), grain: t("Film grain"), "light-leak": t("Light leak"), glow: t("Glow"), scanlines: t("Scanlines"),
    frame: t("Frame"),
  };
}

export const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin", 200: "Extra light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra bold", 900: "Black",
};

const SHAPE_ICON: Record<ShapeKind, LucideIcon> = {
  rect: Square, ellipse: Circle, triangle: Triangle, star: Star, polygon: Hexagon, line: Minus, arrow: ArrowRight, burst: Sparkle, ring: CircleDot,
};
const EFFECT_ICON: Record<EffectKind, LucideIcon> = {
  vignette: Aperture, fade: Blend, grain: Waves, "light-leak": Sun, glow: Sparkles, scanlines: Rows3, frame: Frame,
};

export function layerIcon(l: Layer): LucideIcon {
  if (l.type === "text") return Type;
  if (l.type === "image") return ImageIcon;
  if (l.type === "shape") return SHAPE_ICON[l.shape] ?? Square;
  return EFFECT_ICON[l.effect] ?? Sparkles;
}

/** Icon for a layer, tinted by type (AI images use the AI colour). */
export function LayerGlyph({ layer, className }: { layer: Layer; className?: string }) {
  const Icon = layerIcon(layer);
  const tone = layer.type === "image" && layer.ai ? "text-ai" : layer.type === "text" ? "text-accent-ink" : layer.type === "effect" ? "text-money" : "text-mute";
  return <Icon className={cn("size-3.5", tone, className)} />;
}

/**
 * Rotate a layer about its centre (Konva rotates about the origin, the box's top-left): returns the new origin so the
 * box turns in place, the way every design tool behaves.
 */
export function rotateAboutCentre(l: Pick<Layer, "x" | "y" | "width" | "height" | "rotation">, deg: number): { x: number; y: number; rotation: number } {
  const rad = (a: number) => (a * Math.PI) / 180;
  const hw = l.width / 2, hh = l.height / 2;
  const r0 = rad(l.rotation || 0), r1 = rad(deg);
  const cx = l.x + hw * Math.cos(r0) - hh * Math.sin(r0);
  const cy = l.y + hw * Math.sin(r0) + hh * Math.cos(r0);
  return { rotation: deg, x: Math.round((cx - (hw * Math.cos(r1) - hh * Math.sin(r1))) * 100) / 100, y: Math.round((cy - (hw * Math.sin(r1) + hh * Math.cos(r1))) * 100) / 100 };
}

/** Natural size of an image URL (for logos and uploads). */
export function imageSize(src: string, timeout = 6000): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = window.setTimeout(() => reject(new Error("timeout")), timeout);
    img.onload = () => { window.clearTimeout(timer); resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 }); };
    img.onerror = () => { window.clearTimeout(timer); reject(new Error("load failed")); };
    img.src = src;
  });
}
