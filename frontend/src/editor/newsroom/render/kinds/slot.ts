/**
 * Screen layout kinds (docs/EDITOR.md §16.3, §16.6). Owner: nr-layouts. Registered on import:
 * - slot: a video box. See-through (`hole`: cleared with destination-out on this graphic's own canvas, so the pictures
 *   on the tracks below show), with a frame (line / thick / glow / rounded), an inner shadow, a name tag (plate, bar,
 *   tab or minimal; two lines) and a small LIVE / location tag. It moves itself (in / out / layout morph) by the same
 *   pose as its picture (layouts/geometry.ts slotPose), so the hole and the picture never drift apart.
 * - backdrop: a studio plate for layouts: a gradient in the look's colours, soft light, a fine code-drawn texture,
 *   broadcast swooshes and a vignette.
 * - progress: story-style progress segments ("2 / 5") filled from two number fields.
 */
import { isEmpty } from "../layout.ts";
import { clamp01 } from "../anim.ts";
import { sameBox, slotPose, slotProps, type SlotProps } from "../../layouts/geometry.ts";
import type { Box, Paint } from "../../types.ts";
import type { Ctx2D, LayerRenderContext } from "../contract.ts";
import { drawIcon } from "../icons.ts";
import { cssFont } from "../paint.ts";
import { registerLayerKind } from "../registry.ts";
import { ellipsize, measurer } from "../text.ts";

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const noShadow = (g: Ctx2D) => { g.shadowColor = "rgba(0,0,0,0)"; g.shadowBlur = 0; g.shadowOffsetX = 0; g.shadowOffsetY = 0; };
const outCubic = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);

/** A rounded rectangle path (radius clamped to the box). */
export function roundRect(g: Ctx2D, [x, y, w, h]: Box, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  if (rr < 0.5) { g.rect(x, y, w, h); return; }
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr); g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr); g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

const CORNERS = [{ value: "tl", label: "Top left" }, { value: "tr", label: "Top right" }, { value: "bl", label: "Bottom left" }, { value: "br", label: "Bottom right" }];

// ── text helpers ─────────────────────────────────────────────────────────────

const capCache = new Map<string, number>();
/** Distance from the vertical centre of a line to its baseline (Latin caps sit centred; Indic by its ascent). */
function baselineOff(g: Ctx2D, font: string, size: number, s: string): number {
  const indic = /[ऀ-෿]/.test(s);
  const k = `${font}|${indic}`;
  let v = capCache.get(k);
  if (v === undefined) {
    g.font = font;
    const m = g.measureText(indic ? "क" : "H");
    v = indic ? ((m.fontBoundingBoxAscent || size * 0.9) - (m.fontBoundingBoxDescent || size * 0.3)) / 2 : (m.actualBoundingBoxAscent || size * 0.7) / 2;
    if (capCache.size > 400) capCache.clear();
    capCache.set(k, v);
  }
  return v;
}

/** One line of text fitted to maxW (shrinks to 70 %, then "…"); returns its font, size and width. */
function fitLine(g: Ctx2D, rc: LayerRenderContext, s: string, font: string, size: number, weight: number, maxW: number) {
  let sz = size;
  let f = rc.font(font, sz, weight, s);
  let m = measurer(g, f);
  let w = m(s);
  if (w > maxW && maxW > 0) {
    sz = Math.max(size * 0.7, Math.floor(size * (maxW / w) * 4) / 4);
    f = rc.font(font, sz, weight, s);
    m = measurer(g, f);
    w = m(s);
  }
  const text = w > maxW && maxW > 0 ? ellipsize(s, maxW, m) : s;
  return { text, font: f, size: sz, width: Math.min(w, maxW > 0 ? maxW : w) };
}

function putText(g: Ctx2D, t: { text: string; font: string; size: number }, x: number, cy: number, color: string | CanvasGradient, align: "left" | "right" = "left") {
  g.font = t.font;
  g.textAlign = align;
  g.textBaseline = "alphabetic";
  g.fillStyle = color;
  g.fillText(t.text, x, cy + baselineOff(g, t.font, t.size, t.text));
}

// ── slot ─────────────────────────────────────────────────────────────────────

function frameWidth(sp: SlotProps): number {
  if (sp.frameWidth > 0) return sp.frameWidth;
  return sp.frame === "thick" ? 10 : sp.frame === "none" ? 0 : 3;
}
const radiusOf = (sp: SlotProps, win: Box) => (sp.frame === "rounded" ? Math.max(sp.radius, Math.min(28, win[2] / 6, win[3] / 6)) : sp.radius);

/** The frame around the window, drawn on (dash) and faded in by `k`. */
function drawFrame(g: Ctx2D, sp: SlotProps, win: Box, r: number, k: number, rc: LayerRenderContext) {
  const fw = frameWidth(sp);
  if (fw <= 0 || k <= 0.001) return;
  const [x, y, w, h] = win;
  const o = fw / 2;
  const fr: Box = [x - o, y - o, w + fw, h + fw];
  const paint = rc.paint(sp.frameColor as Paint, "@light");
  g.save();
  g.lineWidth = fw;
  g.strokeStyle = paint;
  g.lineJoin = "round";
  if (k < 1) {
    const per = 2 * (fr[2] + fr[3]);
    g.setLineDash([per * outCubic(k), per]);
    g.globalAlpha *= clamp01(k * 2);
  }
  if (sp.frame === "glow") {
    g.shadowColor = typeof paint === "string" ? paint : rc.look.colors.accent;
    g.shadowBlur = 22 * rc.scale;
    roundRect(g, fr, r + o); g.stroke();
    g.shadowBlur = 8 * rc.scale;
  }
  roundRect(g, fr, r + o); g.stroke();
  g.restore();
}

/** An inner shadow along the window's edges (into the picture). */
function drawInner(g: Ctx2D, win: Box, r: number, amount: number, rc: LayerRenderContext) {
  if (amount <= 0.01 || win[2] < 8 || win[3] < 8) return;
  const [x, y, w, h] = win;
  const blur = Math.max(8, Math.min(w, h) * 0.06);
  g.save();
  roundRect(g, win, r); g.clip();
  g.beginPath();
  g.rect(x - blur * 4, y - blur * 4, w + blur * 8, h + blur * 8);
  // the window, counter-clockwise: the ring around it is filled, its shadow falls inside
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.moveTo(x + rr, y);
  g.arcTo(x, y, x, y + h, rr); g.arcTo(x, y + h, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x + w, y, rr); g.arcTo(x + w, y, x, y, rr);
  g.closePath();
  g.shadowColor = `rgba(0,0,0,${(0.85 * clamp01(amount)).toFixed(3)})`;
  g.shadowBlur = blur * rc.scale;
  g.fillStyle = "#000";
  g.fill("evenodd");
  g.restore();
}

/** The name tag: plate, bar, tab or minimal, in a corner of the window; builds with `k`. */
function drawLabel(g: Ctx2D, sp: SlotProps, win: Box, k: number, rc: LayerRenderContext) {
  const name = rc.text(sp.label, true).trim(), sub = rc.text(sp.sub, false).trim();
  if ((!name && !sub) || k <= 0.001) return;
  const [x, y, w, h] = win;
  if (w < 40 || h < 30) return;
  const size = sp.labelSize > 0 ? sp.labelSize : Math.max(20, Math.min(40, Math.min(w * 0.05, h * 0.075)));
  const subSize = size * 0.66;
  const pos = sp.labelPos;
  const right = pos === "br" || pos === "tr";
  const top = pos === "tl" || pos === "tr" || pos === "top";
  const fill = rc.paint(sp.labelFill as Paint, "@primary"), ink = rc.paint(sp.labelColor as Paint, "@textOnPrimary");
  const accent = rc.paint("@accent");
  const plateIn = outCubic(clamp01(k * 1.5)), textIn = clamp01((k - 0.35) / 0.65);
  const a0 = g.globalAlpha;
  g.save();
  noShadow(g);
  if (sp.labelStyle === "bar") {
    // a band across the bottom (or top) of the box: an accent block, the name, the second line under it
    const pad = size * 0.38, nlh = size * 1.08, slh = sub ? subSize * 1.3 : 0;
    const bh = pad * 2 + nlh + slh + (top ? 0 : size * 0.35);
    const by = top ? y : y + h - bh;
    const ty0 = top ? by + pad : by + bh - pad - nlh - slh;
    g.save();
    g.beginPath(); g.rect(x, by, w * plateIn, bh); g.clip();
    const gr = g.createLinearGradient(0, by, 0, by + bh);
    const mid = rc.paint("@dark/80"), end = rc.paint("@dark/95");
    gr.addColorStop(top ? 1 : 0, "rgba(0,0,0,0)");
    gr.addColorStop(top ? 0.6 : 0.4, typeof mid === "string" ? mid : "rgba(0,0,0,0.8)");
    gr.addColorStop(top ? 0 : 1, typeof end === "string" ? end : "rgba(0,0,0,0.95)");
    g.fillStyle = gr; g.fillRect(x, by, w, bh);
    const bw = Math.max(5, size * 0.16);
    g.fillStyle = accent; g.fillRect(x, ty0 - pad * 0.35, bw, nlh + slh + pad * 0.7);
    g.restore();
    g.globalAlpha = a0 * textIn;
    const tx = x + bw + size * 0.45, maxW = w - (tx - x) - size * 0.5;
    if (name) putText(g, fitLine(g, rc, name, "@headline", size, 700, maxW), tx, ty0 + nlh / 2, rc.paint("@light"));
    if (sub) putText(g, fitLine(g, rc, sub, "@body", subSize, 500, maxW), tx, ty0 + nlh + slh / 2, rc.paint("@light/80"));
    g.restore();
    return;
  }
  if (sp.labelStyle === "minimal") {
    const m = size * 0.5;
    g.globalAlpha = a0 * textIn;
    g.shadowColor = "rgba(0,0,0,0.75)"; g.shadowBlur = 10 * rc.scale; g.shadowOffsetY = 2 * rc.scale;
    const maxW = w - m * 2;
    const nameY = top ? y + m + size * 0.6 : y + h - m - (sub ? subSize * 1.3 : 0) - size * 0.6;
    const ax = right ? x + w - m : x + m;
    if (name) putText(g, fitLine(g, rc, name, "@headline", size, 700, maxW), ax, nameY, rc.paint("@light"), right ? "right" : "left");
    if (sub) putText(g, fitLine(g, rc, sub, "@body", subSize, 500, maxW), ax, nameY + size * 0.6 + subSize * 0.75, rc.paint("@light/85"), right ? "right" : "left");
    g.restore();
    return;
  }
  // plate (inside the box) or tab (sitting on its edge, outside)
  const tab = sp.labelStyle === "tab";
  const m = tab ? 0 : size * 0.42;
  const padX = size * 0.5, ph = size * 1.42, sph = subSize * 1.55;
  const maxW = w - m * 2 - padX * 2 - 8;
  const nm = name ? fitLine(g, rc, name, "@headline", size, 700, maxW) : null;
  const sb = sub ? fitLine(g, rc, sub, "@body", subSize, 500, maxW) : null;
  const pw = (nm ? nm.width : 0) + padX * 2 + 8;
  const sw = (sb ? sb.width : 0) + padX * 2;
  const total = (nm ? ph : 0) + (sb ? sph : 0);
  // where the stack sits: a plate inside the box's corner, a tab on top of the box (or under it)
  let sy: number;
  if (tab) sy = top ? y - total : y + h;
  else sy = top ? y + m : y + h - m - total;
  const ax = right ? x + w - m : x + m;
  const rowX = (rw: number) => (right ? ax - rw : ax);
  let cy = sy;
  const drawRow = (rw: number, rh: number, bg: string | CanvasGradient, stripe: boolean, t: ReturnType<typeof fitLine> | null, color: string | CanvasGradient, delay: number) => {
    const kin = outCubic(clamp01((k - delay) * 1.6));
    const rx = rowX(rw);
    g.save();
    g.beginPath(); g.rect(right ? rx + rw * (1 - kin) : rx, cy, rw * kin, rh); g.clip();
    g.fillStyle = bg; g.fillRect(rx, cy, rw, rh);
    if (stripe) { g.fillStyle = accent; g.fillRect(right ? rx + rw - 8 : rx, cy, 8, rh); }
    if (t) {
      g.globalAlpha = a0 * clamp01((k - delay - 0.25) / 0.5);
      putText(g, t, right ? rx + rw - padX - (stripe ? 8 : 0) : rx + padX + (stripe ? 8 : 0), cy + rh / 2, color, right ? "right" : "left");
    }
    g.restore();
    cy += rh;
  };
  if (nm) drawRow(pw, ph, fill, true, nm, ink, 0);
  if (sb) drawRow(sw, sph, rc.paint("@dark/88"), false, sb, rc.paint("@light/90"), 0.12);
  g.restore();
}

/** The LIVE / location / plain tag in a corner of the window. */
function drawTag(g: Ctx2D, sp: SlotProps, win: Box, k: number, rc: LayerRenderContext) {
  if (!sp.tag || k <= 0.001) return;
  if (sp.tagOn && isEmpty(rc.value(sp.tagOn))) return;
  const s = rc.text(sp.tag, sp.tagStyle === "live").trim();
  if (!s) return;
  const [x, y, w, h] = win;
  if (w < 60 || h < 40) return;
  const size = Math.max(22, Math.min(30, Math.min(w, h) * 0.055));
  const th = size * 1.55, padX = size * 0.55, m = size * 0.6;
  const live = sp.tagStyle === "live", loc = sp.tagStyle === "location";
  const iconW = live ? size * 0.55 + size * 0.4 : loc ? size * 1.05 : 0;
  const t = fitLine(g, rc, live ? s.toUpperCase() : s, "@headline", size, 700, w - m * 2 - padX * 2 - iconW);
  const tw = t.width + padX * 2 + iconW;
  const right = sp.tagPos === "tr" || sp.tagPos === "br", top = sp.tagPos === "tl" || sp.tagPos === "tr";
  const tx = right ? x + w - m - tw : x + m, ty = top ? y + m : y + h - m - th;
  const e = outCubic(clamp01(k * 1.4));
  g.save();
  noShadow(g);
  g.globalAlpha *= clamp01(k * 2);
  g.translate(0, (1 - e) * (top ? -10 : 10));
  roundRect(g, [tx, ty, tw, th], live ? 3 : Math.min(rc.look.radius, th / 2));
  g.fillStyle = rc.paint(live ? "@live" : loc ? "@dark/85" : "@primary");
  g.fill();
  let cx = tx + padX;
  if (live) {
    g.fillStyle = "#FFFFFF";
    g.beginPath(); g.arc(cx + size * 0.27, ty + th / 2, size * 0.24, 0, Math.PI * 2); g.fill();
    cx += size * 0.55 + size * 0.4;
  } else if (loc) {
    drawIcon(g, "pin", cx - size * 0.15, ty + (th - size * 1.05) / 2, size * 1.05, size * 1.05, rc.paint("@accent"));
    cx += size * 1.05;
  }
  putText(g, t, cx, ty + th / 2, live ? "#FFFFFF" : rc.paint(loc ? "@light" : "@textOnPrimary"));
  g.restore();
}

registerLayerKind({
  kind: "slot", label: "Video box", group: "Video", ownsAnim: true,
  props: [
    { key: "index", label: "Box number", type: "number", default: 0, min: 0, max: 11, step: 1, group: "Box", hint: "0 is the main picture" },
    { key: "hole", label: "See-through", type: "bool", default: true, group: "Box", hint: "The pictures on the tracks below show through" },
    { key: "fill", label: "Fill when not see-through", type: "paint", default: "@dark", group: "Box" },
    { key: "radius", label: "Corner radius", type: "number", default: 0, min: 0, max: 600, step: 1, unit: "px", group: "Box" },
    { key: "inner", label: "Inner shadow", type: "number", default: 0.35, min: 0, max: 1, step: 0.05, group: "Box" },
    { key: "frame", label: "Frame", type: "choice", default: "line", group: "Frame", options: [
      { value: "none", label: "None" }, { value: "line", label: "Line" }, { value: "thick", label: "Thick" }, { value: "glow", label: "Glow" }, { value: "rounded", label: "Rounded" }] },
    { key: "frameColor", label: "Frame colour", type: "paint", default: "@light/85", group: "Frame" },
    { key: "frameWidth", label: "Frame width", type: "number", default: 0, min: 0, max: 40, step: 0.5, unit: "px", group: "Frame", hint: "0 follows the frame style" },
    { key: "label", label: "Name", type: "text", default: "", group: "Name tag", hint: "Use {field} for a blank" },
    { key: "sub", label: "Second line", type: "text", default: "", group: "Name tag" },
    { key: "labelStyle", label: "Tag style", type: "choice", default: "plate", group: "Name tag", options: [
      { value: "plate", label: "Plate" }, { value: "bar", label: "Bar across the box" }, { value: "tab", label: "Tab on the edge" }, { value: "minimal", label: "Text only" }] },
    { key: "labelPos", label: "Position", type: "choice", default: "bl", options: CORNERS, group: "Name tag" },
    { key: "labelSize", label: "Size", type: "number", default: 0, min: 0, max: 120, step: 1, unit: "px", group: "Name tag", hint: "0 = by the box size" },
    { key: "labelFill", label: "Plate colour", type: "paint", default: "@primary", group: "Name tag" },
    { key: "labelColor", label: "Text colour", type: "paint", default: "@textOnPrimary", group: "Name tag" },
    { key: "tag", label: "Corner tag", type: "text", default: "", group: "Corner tag", hint: "LIVE, or {place}" },
    { key: "tagStyle", label: "Tag look", type: "choice", default: "live", group: "Corner tag", options: [
      { value: "live", label: "LIVE (red with a dot)" }, { value: "location", label: "Location (pin)" }, { value: "plain", label: "Plain" }] },
    { key: "tagPos", label: "Tag position", type: "choice", default: "tl", options: CORNERS, group: "Corner tag" },
    { key: "tagOn", label: "Show the tag when", type: "field", default: "", group: "Corner tag", hint: "A toggle or text field; empty = always" },
  ],
  draw(g, layer, rc) {
    const sp = slotProps(layer);
    const pose = slotPose(layer, rc.phase.in, 1 - rc.phase.out, rc.ratio, { w: rc.designW, h: rc.designH }, rc.look.motion);
    const win = pose.win;
    if (!(win[2] > 0.5 && win[3] > 0.5)) return;
    const r = radiusOf(sp, win);
    // the layer's drop shadow (if any) belongs to the frame, not the hole
    const sh = { c: g.shadowColor, b: g.shadowBlur, x: g.shadowOffsetX, y: g.shadowOffsetY };
    noShadow(g);
    g.save();
    if (sp.hole) {
      g.globalCompositeOperation = "destination-out";
      g.globalAlpha *= pose.alpha;
      roundRect(g, win, r);
      g.fillStyle = "#000";
      g.fill();
    } else {
      g.globalAlpha *= pose.alpha;
      roundRect(g, win, r);
      g.fillStyle = rc.paint(sp.fill as Paint, "@dark");
      g.fill();
    }
    g.restore();
    if (sp.hole && sp.inner > 0) { g.save(); g.globalAlpha *= pose.alpha; drawInner(g, win, r, sp.inner, rc); g.restore(); }
    g.save();
    g.shadowColor = sh.c; g.shadowBlur = sh.b; g.shadowOffsetX = sh.x; g.shadowOffsetY = sh.y;
    // leaving: frame, tag and name fade whole (no un-building)
    const k = pose.leaving ? 1 : pose.deco;
    if (pose.leaving) g.globalAlpha *= pose.deco;
    drawFrame(g, sp, win, r, k, rc);
    g.restore();
    g.save();
    if (pose.leaving) g.globalAlpha *= pose.deco;
    // name tags sit on the whole box; while a reveal opens it they show only through the opening
    const box = pose.box;
    if (!sameBox(win, box)) {
      const c: Box = sp.labelStyle === "tab" ? [win[0], box[1] - 400, win[2], box[3] + 800] : win;
      g.beginPath(); g.rect(c[0], c[1], c[2], c[3]); g.clip();
    }
    if (!pose.leaving || pose.deco > 0.001) { drawLabel(g, sp, box, k, rc); drawTag(g, sp, box, k, rc); }
    g.restore();
  },
  fonts(layer, rc) {
    const sp = slotProps(layer);
    const name = rc.text(sp.label, true), sub = rc.text(sp.sub), tag = rc.text(sp.tag, true);
    const out: string[] = [];
    if (name.trim()) out.push(cssFont("@headline", rc.look, 40, 700, name));
    if (tag.trim()) out.push(cssFont("@headline", rc.look, 24, 700, tag));
    if (sub.trim()) out.push(cssFont("@body", rc.look, 28, 500, sub));
    return out;
  },
});

// ── backdrop ─────────────────────────────────────────────────────────────────

const TEXTURES = [
  { value: "none", label: "None" }, { value: "diagonal", label: "Fine diagonal lines" }, { value: "lines", label: "Scan lines" },
  { value: "grid", label: "Grid" }, { value: "dots", label: "Dots" }, { value: "rays", label: "Light rays" }, { value: "mesh", label: "Wire mesh" },
];

/** A radial light at (cx, cy) design px, `r` radius. */
function light(g: Ctx2D, cx: number, cy: number, r: number, color: string | CanvasGradient, box: Box) {
  if (typeof color !== "string" || !color || r <= 0) return;
  const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  gr.addColorStop(0, color);
  gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr;
  g.fillRect(box[0], box[1], box[2], box[3]);
}

function texture(g: Ctx2D, kind: string, [x, y, w, h]: Box, color: string | CanvasGradient, k: number, rc: LayerRenderContext) {
  if (kind === "none" || !color) return;
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.strokeStyle = color; g.fillStyle = color;
  const lw = Math.max(1 / Math.max(0.1, rc.scale), 1);
  g.lineWidth = lw;
  if (kind === "diagonal") {
    const step = 22 * k;
    g.beginPath();
    for (let d = -h; d < w; d += step) { g.moveTo(x + d, y + h); g.lineTo(x + d + h, y); }
    g.stroke();
  } else if (kind === "lines") {
    const step = 6 * k;
    for (let yy = y; yy < y + h; yy += step) g.fillRect(x, yy, w, lw);
  } else if (kind === "grid" || kind === "mesh") {
    const step = (kind === "grid" ? 64 : 36) * k;
    g.beginPath();
    for (let xx = x + ((w / 2) % step); xx < x + w; xx += step) { g.moveTo(xx, y); g.lineTo(xx, y + h); }
    for (let yy = y + ((h / 2) % step); yy < y + h; yy += step) { g.moveTo(x, yy); g.lineTo(x + w, yy); }
    if (kind === "mesh") for (let d = -h; d < w; d += step * 2) { g.moveTo(x + d, y + h); g.lineTo(x + d + h, y); }
    g.stroke();
  } else if (kind === "dots") {
    const step = 18 * k, r = 1.6 * k;
    for (let yy = y + step / 2; yy < y + h; yy += step) {
      for (let xx = x + step / 2 + ((Math.round((yy - y) / step) % 2) * step) / 2; xx < x + w; xx += step) { g.beginPath(); g.arc(xx, yy, r, 0, Math.PI * 2); g.fill(); }
    }
  } else if (kind === "rays") {
    const cx = x + w * 0.5, cy = y - h * 0.35, n = 18;
    for (let i = 0; i < n; i++) {
      if (i % 2) continue;
      const a0 = Math.PI * (0.18 + (0.64 * i) / n), a1 = Math.PI * (0.18 + (0.64 * (i + 1)) / n);
      g.beginPath(); g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a0) * h * 3, cy + Math.sin(a0) * h * 3); g.lineTo(cx + Math.cos(a1) * h * 3, cy + Math.sin(a1) * h * 3);
      g.closePath(); g.fill();
    }
  }
  g.restore();
}

/** The channel's swoosh along an edge: a soft band fading out to the right, a fainter crossing band and an accent
 *  hairline. Sized by the short side, so vertical frames get the same calm sweep. */
function bands(g: Ctx2D, where: string, [x, y, w, h]: Box, c1: string | CanvasGradient, c2: string | CanvasGradient) {
  if (where === "none" || typeof c1 !== "string" || typeof c2 !== "string") return;
  const u = Math.min(w, h);
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  const fade = (c: string, x0: number, x1: number) => {
    const gr = g.createLinearGradient(x0, 0, x1, 0);
    gr.addColorStop(0, c); gr.addColorStop(0.55, c); gr.addColorStop(1, "rgba(0,0,0,0)");
    return gr;
  };
  const sweep = (bottom: boolean) => {
    const yb = bottom ? y + h : y, d = bottom ? -1 : 1;
    const rise = u * 0.16, run = w * 0.85;
    g.fillStyle = fade(c1, x, x + run);
    g.beginPath();
    g.moveTo(x, yb); g.lineTo(x, yb + d * rise); g.lineTo(x + run, yb + d * u * 0.02); g.lineTo(x + run, yb);
    g.closePath(); g.fill();
    g.globalAlpha *= 0.6;
    g.fillStyle = fade(c1, x + w, x + w * 0.35);
    g.beginPath();
    g.moveTo(x + w * 0.35, yb); g.lineTo(x + w, yb + d * u * 0.13); g.lineTo(x + w, yb + d * u * 0.06); g.lineTo(x + w * 0.55, yb);
    g.closePath(); g.fill();
    g.globalAlpha /= 0.6;
    const gr = g.createLinearGradient(x + w * 0.25, 0, x + w, 0);
    gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(0.45, c2); gr.addColorStop(1, c2);
    g.strokeStyle = gr;
    g.lineWidth = Math.max(2, u * 0.0035);
    g.beginPath(); g.moveTo(x + w * 0.25, yb); g.lineTo(x + w, yb + d * u * 0.155); g.stroke();
  };
  if (where === "lower" || where === "both") sweep(true);
  if (where === "upper" || where === "both") sweep(false);
  if (where === "corner") {
    const gr = g.createLinearGradient(x + w, y + h, x + w - u * 0.5, y + h - u * 0.5);
    gr.addColorStop(0, c1); gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.beginPath(); g.moveTo(x + w, y + h); g.lineTo(x + w - u * 0.7, y + h); g.lineTo(x + w, y + h - u * 0.7); g.closePath(); g.fill();
    g.strokeStyle = c2; g.lineWidth = Math.max(2, u * 0.0035);
    g.beginPath(); g.moveTo(x + w - u * 0.78, y + h); g.lineTo(x + w, y + h - u * 0.78); g.stroke();
  }
  g.restore();
}

registerLayerKind({
  kind: "backdrop", label: "Studio backdrop", group: "Video",
  props: [
    { key: "fill", label: "Fill", type: "paint", default: { gradient: ["@secondary", "@dark"], angle: 90 }, group: "Fill" },
    { key: "glow", label: "Light", type: "paint", default: "@primary/45", group: "Light" },
    { key: "glowX", label: "Light across", type: "number", default: 0.8, min: 0, max: 1, step: 0.01, group: "Light" },
    { key: "glowY", label: "Light down", type: "number", default: 0.15, min: 0, max: 1, step: 0.01, group: "Light" },
    { key: "glowSize", label: "Light size", type: "number", default: 0.85, min: 0, max: 2, step: 0.05, group: "Light" },
    { key: "glow2", label: "Second light", type: "paint", default: "@accent/10", group: "Light" },
    { key: "glow2X", label: "Second across", type: "number", default: 0.08, min: 0, max: 1, step: 0.01, group: "Light" },
    { key: "glow2Y", label: "Second down", type: "number", default: 0.95, min: 0, max: 1, step: 0.01, group: "Light" },
    { key: "texture", label: "Texture", type: "choice", default: "diagonal", options: TEXTURES, group: "Texture" },
    { key: "textureColor", label: "Texture colour", type: "paint", default: "@light/5", group: "Texture" },
    { key: "textureScale", label: "Texture scale", type: "number", default: 1, min: 0.3, max: 4, step: 0.1, group: "Texture" },
    { key: "bands", label: "Sweeps", type: "choice", default: "lower", group: "Sweeps", options: [
      { value: "none", label: "None" }, { value: "lower", label: "Along the bottom" }, { value: "upper", label: "Along the top" }, { value: "both", label: "Top and bottom" }, { value: "corner", label: "Corner" }] },
    { key: "bandColor", label: "Sweep colour", type: "paint", default: "@primary/24", group: "Sweeps" },
    { key: "band2Color", label: "Accent line", type: "paint", default: "@accent/70", group: "Sweeps" },
    { key: "vignette", label: "Vignette", type: "number", default: 0.45, min: 0, max: 1, step: 0.05, group: "Fill" },
    { key: "drift", label: "Moving light", type: "bool", default: false, group: "Light", hint: "The light drifts slowly (redrawn every frame)" },
  ],
  animates: (l) => l.p.drift === true,
  draw(g, layer, rc) {
    const p = layer.p;
    const b = layer.box;
    const [x, y, w, h] = b;
    if (w <= 0 || h <= 0) return;
    noShadow(g);
    g.fillStyle = rc.paint((p.fill ?? { gradient: ["@secondary", "@dark"], angle: 90 }) as Paint, "@dark");
    g.fillRect(x, y, w, h);
    const big = Math.max(w, h);
    const drift = p.drift === true ? Math.sin((rc.t / 14) * Math.PI * 2) * 0.06 : 0;
    light(g, x + w * (num(p.glowX, 0.8) + drift), y + h * num(p.glowY, 0.15), big * num(p.glowSize, 0.85) * 0.7, rc.paint((p.glow ?? "@primary/45") as Paint), b);
    light(g, x + w * (num(p.glow2X, 0.08) - drift), y + h * num(p.glow2Y, 0.95), big * 0.55, rc.paint((p.glow2 ?? "@accent/10") as Paint), b);
    texture(g, str(p.texture, "diagonal"), b, rc.paint((p.textureColor ?? "@light/5") as Paint), num(p.textureScale, 1), rc);
    bands(g, str(p.bands, "lower"), b, rc.paint((p.bandColor ?? "@primary/24") as Paint), rc.paint((p.band2Color ?? "@accent/70") as Paint));
    const v = num(p.vignette, 0.45);
    if (v > 0.01) {
      const gr = g.createRadialGradient(x + w / 2, y + h / 2, Math.min(w, h) * 0.35, x + w / 2, y + h / 2, big * 0.75);
      gr.addColorStop(0, "rgba(0,0,0,0)");
      gr.addColorStop(1, `rgba(0,0,0,${(0.75 * v).toFixed(3)})`);
      g.fillStyle = gr;
      g.fillRect(x, y, w, h);
    }
  },
});

// ── progress segments ────────────────────────────────────────────────────────

registerLayerKind({
  kind: "progress", label: "Story progress", group: "Data",
  props: [
    { key: "at", label: "Story number", type: "field", default: "n", group: "Progress" },
    { key: "of", label: "Number of stories", type: "field", default: "total", group: "Progress" },
    { key: "fill", label: "Done", type: "paint", default: "@light", group: "Progress" },
    { key: "rest", label: "To come", type: "paint", default: "@light/30", group: "Progress" },
    { key: "gap", label: "Gap", type: "number", default: 10, min: 0, max: 60, step: 1, unit: "px", group: "Progress" },
  ],
  ownsAnim: true,
  draw(g, layer, rc) {
    const p = layer.p;
    const [x, y, w, h] = layer.box;
    const n = Math.max(1, Math.min(30, Math.round(Number(rc.value(str(p.of, "total"))) || 5)));
    const at = Math.max(0, Math.min(n, Math.round(Number(rc.value(str(p.at, "n"))) || 1)));
    const gap = num(p.gap, 10);
    const sw = (w - gap * (n - 1)) / n;
    if (sw <= 1) return;
    noShadow(g);
    const kin = clamp01(rc.phase.in), kout = rc.phase.out;
    g.globalAlpha *= clamp01(kout * 1.5);
    for (let i = 0; i < n; i++) {
      const sx = x + i * (sw + gap);
      roundRect(g, [sx, y, sw, h], h / 2);
      g.fillStyle = rc.paint((p.rest ?? "@light/30") as Paint);
      g.fill();
      // done segments fill in one after another; the current one fills as the card comes in
      const done = i < at - 1 ? 1 : i === at - 1 ? outCubic(clamp01((kin - 0.3) / 0.7)) : 0;
      if (done > 0) { roundRect(g, [sx, y, sw * done, h], h / 2); g.fillStyle = rc.paint((p.fill ?? "@light") as Paint); g.fill(); }
    }
  },
});

