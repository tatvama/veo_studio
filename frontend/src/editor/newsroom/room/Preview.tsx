/**
 * A live picture of a graphic for the room's cards, the Fill in form and the playlist (docs/EDITOR.md §16.8): drawn
 * by the News Room renderer at a resting moment, animated while hovered (or `play`), zoomed onto the graphic so a
 * small strap or bug stays readable on a small card.
 */
import { clsx } from "clsx";
import { useEffect, useRef, useState } from "react";
import { previewLength, stillTime } from "../preview";
import { drawGraphic, ensureGraphicAssets } from "../render/index";
import { DESIGN } from "../templates/kit";
import type { GfxRenderInput } from "../render/contract";
import { onAssets } from "../render/images";
import type { GfxRatio, GfxTemplate } from "../types";

const RATIO_WH: Record<GfxRatio, [number, number]> = { "16:9": [16, 9], "9:16": [9, 16], "1:1": [1, 1], "4:5": [4, 5] };

/** Seconds a template is drawn over, and the moment that shows it best when still (preview.tsx's choices). */
export function previewTimes(t: GfxTemplate): { dur: number; rest: number } {
  const dur = previewLength(t);
  return { dur, rest: stillTime(t, dur) };
}

/** A crop of the frame around `b` (canvas px) with the frame's aspect, at least `min` of the frame. */
function cropAround(b: [number, number, number, number] | null, W: number, H: number, min = 0.42): [number, number, number, number] {
  if (!b || b[2] < 2 || b[3] < 2) return [0, 0, W, H];
  const pad = 0.12;
  let w = b[2] * (1 + pad * 2), h = b[3] * (1 + pad * 2);
  const a = W / H;
  if (w / h > a) h = w / a; else w = h * a;
  if (w < W * min) { w = W * min; h = H * min; }
  if (w > W) { w = W; h = H; }
  const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
  const x = Math.max(0, Math.min(W - w, cx - w / 2)), y = Math.max(0, Math.min(H - h, cy - h / 2));
  return [x, y, w, h];
}

export interface PreviewProps {
  input: GfxRenderInput | null;
  ratio?: GfxRatio;
  /** Zoom onto the graphic (cards). */
  zoom?: boolean;
  /** Keep playing (else only while hovered). */
  play?: boolean;
  /** Animate on hover (default true). */
  hover?: boolean;
  /** Show this moment when still (seconds). */
  at?: number;
  /** The clip length to animate over (seconds; default from the template). */
  dur?: number;
  className?: string;
  /** Width of the drawing in canvas pixels (the card scales it). */
  width?: number;
}

export function GfxPreview({ input, ratio = "16:9", zoom, play, hover = true, at, dur: durIn, className, width = 400 }: PreviewProps) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [over, setOver] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const animate = !!input && (play || (hover && over));
  useEffect(() => onAssets(() => setEpoch((e) => e + 1)), []);
  useEffect(() => { if (input) void ensureGraphicAssets(input).then(() => setEpoch((e) => e + 1)).catch(() => undefined); }, [input]);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const [rw, rh] = RATIO_WH[ratio];
    const W = width, H = Math.round((width * rh) / rw);
    c.width = W; c.height = H;
    const g = c.getContext("2d");
    if (!g) return;
    if (!input) { g.clearRect(0, 0, W, H); return; }
    const times = previewTimes(input.template);
    const dur = durIn ?? times.dur, rest = Math.min(dur, at ?? times.rest);
    // full frame offscreen at a design-proportional size, then the (zoomed) part onto the card
    const ds = DESIGN[ratio];
    const k = zoom ? 2 : 1;
    const FW = Math.round(W * k), FH = Math.round((FW * ds.h) / ds.w);
    const off = document.createElement("canvas");
    off.width = FW; off.height = FH;
    const og = off.getContext("2d")!;
    const paint = (t: number) => {
      og.clearRect(0, 0, FW, FH);
      let b: [number, number, number, number] | null = null;
      try { b = drawGraphic(og, { ...input, ratio }, FW, FH, t, dur); } catch (e) { console.warn("[newsroom] preview", e); }
      return b;
    };
    const restBox = paint(rest);
    const crop = zoom ? cropAround(restBox, FW, FH) : [0, 0, FW, FH] as [number, number, number, number];
    const show = () => { g.clearRect(0, 0, W, H); g.drawImage(off, crop[0], crop[1], crop[2], crop[3], 0, 0, W, H); };
    show();
    if (!animate) return;
    let raf = 0, alive = true;
    const t0 = performance.now();
    const loop = () => {
      if (!alive) return;
      paint(((performance.now() - t0) / 1000) % dur);
      show();
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [input, ratio, zoom, animate, at, durIn, width, epoch]);
  const [rw, rh] = RATIO_WH[ratio];
  return (
    <canvas ref={cv} onMouseEnter={() => setOver(true)} onMouseLeave={() => setOver(false)}
      className={clsx("block w-full rounded-md", className)}
      style={{ aspectRatio: `${rw} / ${rh}`, background: "linear-gradient(135deg, #1e293b, #0f172a 55%, #312e81)" }} />
  );
}
