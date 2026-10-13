/**
 * GraphicPreview (docs/EDITOR.md §16.8): one graphic drawn live by the News Room renderer on a small canvas, for the
 * Graphics library, the Designer and the Wipe Designer. Still at a good frame (just after it has come in) until it
 * plays: "hover" plays while the pointer is over it, "always" while it's on screen, "never" stays on `t`. Playing loops
 * the template's length with requestAnimationFrame; idle it costs nothing (redrawn only when its props change or a
 * font or picture arrives).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { builtinLook, DEFAULT_LOOK_ID } from "./looks";
import { drawGraphic, ensureGraphicAssets } from "./render";
import type { GfxRenderInput } from "./render/contract";
import { onAssets } from "./render/images";
import { defaults } from "./templates/kit";
import type { ChannelLook, GfxLayer, GfxRatio, GfxTemplate, GfxValue } from "./types";

export interface GraphicPreviewProps {
  template: GfxTemplate;
  values?: Record<string, GfxValue>;
  look?: ChannelLook;
  /** Default 16:9. */
  ratio?: GfxRatio;
  /** CSS width in px (the height follows the ratio). */
  width: number;
  /** Seconds to show while still (default: just after the graphic has come in). */
  t?: number;
  /** Default "hover". */
  play?: "hover" | "always" | "never";
  className?: string;
  /** mediaId → URL for pictures in the values or the look's logo. */
  images?: Record<string, string>;
  overrides?: Record<string, Partial<GfxLayer>>;
  seed?: number;
  /** Length it plays for (default: the template's, or 6 s / 10 s for ones that fill or loop). */
  seconds?: number;
  /** A backdrop behind the graphic (css background); default a soft studio gradient. */
  backdrop?: string;
  onClick?: () => void;
}

const ASPECT: Record<GfxRatio, number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 0.8 };
export const PREVIEW_BACKDROP = "radial-gradient(120% 90% at 30% 25%, #3a4a63 0%, #1d2638 45%, #0c111c 100%)";

/** The length a template previews for. */
export const previewLength = (t: GfxTemplate, seconds?: number) => seconds ?? (t.seconds > 0 ? t.seconds : t.loop ? 10 : 6);
/** A good still frame: just after it has come in (stingers: where they cover the frame). */
export function stillTime(t: GfxTemplate, len: number): number {
  if (t.cut !== undefined) return t.cut * len;
  return Math.min(len * 0.5, (t.timing?.in ?? 0.6) + 0.9);
}

export function GraphicPreview(props: GraphicPreviewProps) {
  const { template, values, look, ratio = "16:9", width, t, play = "hover", className, images, overrides, seed, seconds, backdrop, onClick } = props;
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState(false);
  const [visible, setVisible] = useState(play !== "always");
  const [, setTick] = useState(0);
  const lk = look ?? builtinLook(DEFAULT_LOOK_ID)!;
  const input = useMemo<GfxRenderInput>(() => ({
    template, values: { ...defaults(template), ...(values ?? {}) }, look: lk, images: images ?? {}, seed: seed ?? 1, fps: 30, ratio,
    ...(overrides ? { overrides } : {}),
  }), [template, values, lk, images, seed, ratio, overrides]);
  const len = previewLength(template, seconds);
  const still = t ?? stillTime(template, len);
  const height = Math.round(width / ASPECT[ratio]);
  const dpr = typeof devicePixelRatio === "number" ? Math.min(2, devicePixelRatio) : 1;
  const W = Math.max(2, Math.round(width * dpr)), H = Math.max(2, Math.round(height * dpr));
  const playing = play === "always" ? visible : play === "hover" ? hover : false;

  useEffect(() => { void ensureGraphicAssets(input).then(() => setTick((x) => x + 1)); }, [input]);
  useEffect(() => onAssets(() => setTick((x) => x + 1)), []);
  // "always": only while on screen
  useEffect(() => {
    if (play !== "always" || typeof IntersectionObserver === "undefined" || !ref.current) return;
    const io = new IntersectionObserver((es) => setVisible(es.some((e) => e.isIntersecting)));
    io.observe(ref.current);
    return () => io.disconnect();
  }, [play]);

  // still
  useEffect(() => {
    if (playing) return;
    const g = ref.current?.getContext("2d");
    if (g) drawGraphic(g, input, W, H, still, len);
  });
  // playing
  useEffect(() => {
    if (!playing) return;
    const g = ref.current?.getContext("2d");
    if (!g) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const s = ((now - t0) / 1000) % len;
      drawGraphic(g, input, W, H, s, len);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, input, W, H, len]);

  return (
    <canvas ref={ref} width={W} height={H} className={className} onClick={onClick}
      onMouseEnter={play === "hover" ? () => setHover(true) : undefined} onMouseLeave={play === "hover" ? () => setHover(false) : undefined}
      style={{ width, height, display: "block", background: backdrop ?? PREVIEW_BACKDROP, borderRadius: 4 }} />
  );
}

export default GraphicPreview;
