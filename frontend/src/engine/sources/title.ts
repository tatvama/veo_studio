/**
 * Title clips (EDITOR.md §2 TitleSpec) drawn with Canvas2D — the browser shapes Indic and other complex scripts with
 * HarfBuzz — into a frame-sized canvas: wrapped text in its box, outline, shadow, a background plate, animated in
 * (fade, slide up, typewriter, pop) and out (fade, slide down). The raster is redrawn only while it animates, and
 * again when a GPU reset brought its canvas back blank (canvasLoss.ts). Colour mattes are a tiny canvas of one colour.
 */
import type { TitleSpec } from "../types";
import type { Frame, FrameSource } from "./source";
import { watchCanvas } from "./canvasLoss.ts";

const ANIM_S = 0.5;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
const easeBack = (x: number) => { const c = 1.70158, t = clamp01(x) - 1; return 1 + (c + 1) * t * t * t + c * t * t; };

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const canvas = (w: number, h: number): HTMLCanvasElement | OffscreenCanvas => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
};

function wrap(g: Ctx2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const w of para.split(/(\s+)/)) {
      const next = line + w;
      if (line && w.trim() && g.measureText(next.trimEnd()).width > maxW) { out.push(line.trimEnd()); line = w.trimStart(); } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** The animation state at `t` seconds into a clip `dur` long: 0..1 in / out, typed characters. */
export function titleState(s: TitleSpec, t: number, dur: number) {
  const anim = Math.min(ANIM_S, dur / 3);
  const typeT = Math.max(anim, Math.min(dur * 0.4, 0.04 * s.text.length));
  const pin = s.animIn && s.animIn !== "none" && anim > 0 ? clamp01(t / (s.animIn === "typewriter" ? typeT : anim)) : 1;
  const pout = s.animOut && s.animOut !== "none" && anim > 0 ? clamp01((dur - t) / anim) : 1;
  return { pin, pout, chars: s.animIn === "typewriter" ? Math.round(s.text.length * pin) : s.text.length, static: pin >= 1 && pout >= 1 };
}

/** Draws the title onto a W×H context at `t`. `scale` = canvas height / composition height. */
export function drawTitle(g: Ctx2D, s: TitleSpec, W: number, H: number, t: number, dur: number, scale: number) {
  g.clearRect(0, 0, W, H);
  const st = titleState(s, t, dur);
  let alpha = 1, dy = 0, zoom = 1;
  if (s.animIn === "fade") alpha *= easeOut(st.pin);
  if (s.animIn === "slide_up") { alpha *= easeOut(st.pin); dy += (1 - easeOut(st.pin)) * H * 0.06; }
  if (s.animIn === "pop") { zoom *= 0.6 + 0.4 * easeBack(st.pin); alpha *= clamp01(st.pin * 3); }
  if (s.animOut === "fade") alpha *= easeOut(st.pout);
  if (s.animOut === "slide_down") { alpha *= easeOut(st.pout); dy += (1 - easeOut(st.pout)) * H * 0.06; }
  if (alpha <= 0.001) return;
  const [bx, by, bw, bh] = s.box;
  const size = Math.max(1, s.size * scale);
  g.save();
  g.globalAlpha = alpha;
  g.font = `${s.weight} ${Math.round(size)}px "${s.font}", "Inter Variable", system-ui, sans-serif`;
  g.textBaseline = "middle";
  g.textAlign = s.align;
  const text = s.text.slice(0, st.chars);
  const lines = wrap(g, text, Math.max(1, bw * W));
  const lh = size * 1.25;
  const cx = s.align === "left" ? bx * W : s.align === "right" ? (bx + bw) * W : (bx + bw / 2) * W;
  const cy = (by + bh / 2) * H + dy;
  const y0 = cy - ((lines.length - 1) * lh) / 2;
  if (zoom !== 1) { g.translate((bx + bw / 2) * W, cy); g.scale(zoom, zoom); g.translate(-(bx + bw / 2) * W, -cy); }
  if (s.background) {
    const pad = s.background.padding * scale;
    const widths = lines.map((l) => g.measureText(l).width);
    const tw = Math.max(1, ...widths);
    const left = s.align === "left" ? cx : s.align === "right" ? cx - tw : cx - tw / 2;
    const r = s.background.radius * scale, x = left - pad, y = y0 - lh / 2 - pad, w = tw + pad * 2, h = lines.length * lh + pad * 2;
    g.fillStyle = s.background.color;
    g.beginPath();
    g.roundRect(x, y, w, h, r);
    g.fill();
  }
  if (s.shadow) { g.shadowColor = s.shadow.color; g.shadowBlur = s.shadow.blur * scale; g.shadowOffsetX = s.shadow.x * scale; g.shadowOffsetY = s.shadow.y * scale; }
  lines.forEach((l, i) => {
    const y = y0 + i * lh;
    if (s.outline && s.outline.width > 0) {
      g.lineJoin = "round";
      g.lineWidth = s.outline.width * 2 * scale;
      g.strokeStyle = s.outline.color;
      g.strokeText(l, cx, y);
      g.shadowColor = "transparent";
    }
    g.fillStyle = s.color;
    g.fillText(l, cx, y);
  });
  g.restore();
}

/** A title as a frame source: `live(t)` (t = seconds into the clip) redraws only while the title animates. */
export class TitleSource implements FrameSource {
  readonly kind = "canvas" as const;
  readonly ready: Promise<void>;
  private spec: TitleSpec;
  private dur: number;
  private cv: HTMLCanvasElement | OffscreenCanvas | null = null;
  private g: Ctx2D | null = null;
  private w = 0; private h = 0; private scale = 1;
  private key = "";
  private version = 0;
  /** Times the canvas came back blank after a GPU reset (part of the key: it is drawn again). */
  private restores: () => number = () => 0;
  constructor(spec: TitleSpec, dur: number) {
    this.spec = spec;
    this.dur = dur;
    const fonts = (globalThis as { document?: Document }).document?.fonts;
    this.ready = fonts ? fonts.load(`${spec.weight} ${Math.round(spec.size)}px "${spec.font}"`).then(() => undefined, () => undefined) : Promise.resolve();
  }
  /** The raster size (the render size) and the composition-to-render scale. */
  size(w: number, h: number, scale: number) {
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (w !== this.w || h !== this.h || scale !== this.scale) { this.w = w; this.h = h; this.scale = scale; this.cv = null; this.key = ""; }
  }
  private frame(t: number): Frame | null {
    if (!this.w) return null;
    if (!this.cv) { this.cv = canvas(this.w, this.h); this.g = this.cv.getContext("2d") as Ctx2D; this.restores = watchCanvas(this.cv); }
    const st = titleState(this.spec, t, this.dur);
    const key = `${st.static ? "static" : `${st.pin.toFixed(4)}:${st.pout.toFixed(4)}:${st.chars}`}|${this.restores()}`;
    if (key !== this.key) { this.key = key; drawTitle(this.g!, this.spec, this.w, this.h, t, this.dur, this.scale); this.version++; }
    return { image: this.cv as TexImageSource, width: this.w, height: this.h, version: this.version };
  }
  live(t: number): Frame | null { return this.frame(t); }
  async exact(t: number): Promise<Frame | null> { await this.ready; return this.frame(t); }
  idle(): void {}
  dispose(): void { this.cv = null; this.g = null; }
}

/** A colour matte: one colour (alpha allowed: "#RRGGBBAA"), painted again (a new version) after a GPU reset. */
export class MatteSource implements FrameSource {
  readonly kind = "canvas" as const;
  readonly ready = Promise.resolve();
  private cv: HTMLCanvasElement | OffscreenCanvas;
  private version = 1;
  constructor(color: string) {
    this.cv = canvas(4, 4);
    const paint = () => {
      const g = this.cv.getContext("2d") as Ctx2D;
      g.clearRect(0, 0, 4, 4);
      g.fillStyle = color;
      g.fillRect(0, 0, 4, 4);
    };
    paint();
    watchCanvas(this.cv, () => { paint(); this.version++; });
  }
  live(): Frame { return { image: this.cv as TexImageSource, width: 4, height: 4, version: this.version }; }
  async exact(): Promise<Frame> { return this.live(); }
  idle(): void {}
  dispose(): void {}
}
