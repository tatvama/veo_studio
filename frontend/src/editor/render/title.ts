/**
 * Title clips drawn with Canvas2D (the browser shapes Indic scripts with HarfBuzz): wrapped text in its box with
 * outline, shadow and a background, animated in and out. Used by the engine (as a custom source) and the Text panel.
 */
import type { TitleSpec } from "../model/types";

const ANIM_S = 0.5;
const easeOut = (x: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
const easeBack = (x: number) => { const c = 1.70158, t = Math.max(0, Math.min(1, x)) - 1; return 1 + (c + 1) * t * t * t + c * t * t; };

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const next = line + w;
      if (line && g.measureText(next.trimEnd()).width > maxW && w.trim()) { out.push(line.trimEnd()); line = w.trimStart(); }
      else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

const font = (s: TitleSpec, scale: number) => `${s.weight} ${Math.max(1, Math.round(s.size * scale))}px "${s.font}", "Inter Variable", system-ui, sans-serif`;

/** Starts loading the title's font (the canvas falls back until it's there). */
export function ensureFont(s: TitleSpec): Promise<unknown> {
  try { return document.fonts.load(font(s, 1)); } catch { return Promise.resolve(); }
}

/**
 * Draws the title onto a W×H canvas at `t` seconds into a clip `dur` seconds long (transparent outside the text).
 * `scale` = canvas height / sequence height, for previews drawn smaller than the sequence.
 */
export function drawTitle(g: CanvasRenderingContext2D, s: TitleSpec, W: number, H: number, t: number, dur: number, scale = 1) {
  g.clearRect(0, 0, W, H);
  const anim = Math.min(ANIM_S, dur / 3);
  const inP = s.animIn && s.animIn !== "none" && anim > 0 ? Math.min(1, t / (s.animIn === "typewriter" ? Math.max(anim, Math.min(dur * 0.4, 0.04 * s.text.length)) : anim)) : 1;
  const outP = s.animOut && s.animOut !== "none" && anim > 0 ? Math.min(1, Math.max(0, (dur - t) / anim)) : 1;
  let alpha = 1, dy = 0, k = 1, text = s.text;
  if (s.animIn === "fade") alpha *= easeOut(inP);
  if (s.animIn === "slide_up") { alpha *= easeOut(inP); dy += (1 - easeOut(inP)) * H * 0.06; }
  if (s.animIn === "pop") { alpha *= Math.min(1, inP * 3); k = 0.6 + 0.4 * easeBack(inP); }
  if (s.animIn === "typewriter") text = s.text.slice(0, Math.round(s.text.length * inP));
  if (s.animOut === "fade") alpha *= easeOut(outP);
  if (s.animOut === "slide_down") { alpha *= easeOut(outP); dy += (1 - easeOut(outP)) * H * 0.06; }
  if (alpha <= 0.001) return;
  const [bx, by, bw, bh] = s.box;
  const box = { x: bx * W, y: by * H, w: Math.max(1, bw * W), h: Math.max(1, bh * H) };
  g.save();
  g.globalAlpha = alpha;
  g.font = font(s, scale);
  g.textBaseline = "alphabetic";
  const lines = wrap(g, text, box.w);
  const size = s.size * scale;
  const lh = size * 1.18;
  const widths = lines.map((l) => g.measureText(l).width);
  const blockH = lines.length * lh;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2 + dy;
  g.translate(cx, cy); g.scale(k, k); g.translate(-cx, -cy);
  const top = cy - blockH / 2;
  const xOf = (w: number) => (s.align === "left" ? box.x : s.align === "right" ? box.x + box.w - w : box.x + (box.w - w) / 2);
  if (s.background) {
    const pad = s.background.padding * scale;
    const maxW = Math.max(0, ...widths);
    const x0 = s.align === "left" ? box.x : s.align === "right" ? box.x + box.w - maxW : box.x + (box.w - maxW) / 2;
    g.fillStyle = s.background.color;
    g.beginPath();
    const r = s.background.radius * scale;
    const rx = x0 - pad, ry = top - pad, rw = maxW + pad * 2, rh = blockH + pad * 2;
    if (typeof g.roundRect === "function") g.roundRect(rx, ry, rw, rh, r); else g.rect(rx, ry, rw, rh);
    g.fill();
  }
  lines.forEach((line, i) => {
    const x = xOf(widths[i]);
    const y = top + i * lh + size * 0.92;
    if (s.outline && s.outline.width > 0) {
      g.lineJoin = "round";
      g.lineWidth = s.outline.width * 2 * scale;
      g.strokeStyle = s.outline.color;
      g.strokeText(line, x, y);
    }
    if (s.shadow) {
      g.shadowColor = s.shadow.color; g.shadowBlur = s.shadow.blur * scale;
      g.shadowOffsetX = s.shadow.x * scale; g.shadowOffsetY = s.shadow.y * scale;
    }
    g.fillStyle = s.color;
    g.fillText(line, x, y);
    g.shadowColor = "transparent";
  });
  g.restore();
}
