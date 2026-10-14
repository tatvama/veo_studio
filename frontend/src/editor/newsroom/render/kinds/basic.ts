/**
 * The core layer kinds (docs/EDITOR.md §16.3), registered on import:
 * - rect: a plate. Fill (paint or gradient), stroke, corners and angled ends that follow the look's plate style, glass
 *   (translucent with a light top edge), a gloss, and an accent stripe on any side.
 * - text: fields in "{braces}", the look's fonts (per-script face for Indic text), size, weight, colour, align, valign,
 *   tracking, capitals (on / off / as the look says), italic, outline; fits by shrinking to 60 %, wrapping to maxLines
 *   and an ellipsis; `grow` sizes plates to the text; line / word / letter animation (Indic: words, never letters).
 * - image: a field's picture (or a URL), cover / contain, circle / rounded, a border; a calm placeholder when empty.
 * - logo: the look's logo picture, or its text logo in two tones.
 * - line: a rule (solid, dashed, dotted).
 * - icon: the built-in vector set (render/icons.ts) with an optional disc or tile behind it.
 */
import type { Box, GfxImageRef, GfxLayer, Paint } from "../../types.ts";
import { clamp01, combine, easeFn, IDENTITY, partPose, partProgress, type Pose } from "../anim.ts";
import { isCore, type CoreRenderContext, type PartAnim } from "../context.ts";
import type { Ctx2D, LayerRenderContext, PropDef } from "../contract.ts";
import { drawIcon, iconList } from "../icons.ts";
import { sizeOf } from "../images.ts";
import { scriptOf } from "../../format.ts";
import { cssFont } from "../paint.ts";
import { registerLayerKind } from "../registry.ts";
import { charParts, clearWithFonts, fitCached, fitText, isIndic, measurer, wordParts, type FitResult } from "../text.ts";

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const boxOf = (l: GfxLayer, rc: LayerRenderContext): Box => (isCore(rc) ? rc.box : l.box);

const SHAPES = [{ value: "look", label: "As the look" }, { value: "flat", label: "Square" }, { value: "rounded", label: "Rounded" },
  { value: "angled", label: "Angled ends" }, { value: "pill", label: "Pill" }];
const SIDES = [{ value: "none", label: "None" }, { value: "left", label: "Left" }, { value: "right", label: "Right" }, { value: "top", label: "Top" }, { value: "bottom", label: "Bottom" }];

// ── plate shapes ─────────────────────────────────────────────────────────────

/** The plate's outline: rounded corners, or slanted ends (`off` = how far the top edge leans in, design px). */
export function platePath(g: Ctx2D, [x, y, w, h]: Box, radius: number, off: number, ends: string): void {
  g.beginPath();
  if (off > 0.5) {
    const l = ends === "right" ? 0 : off, r = ends === "left" ? 0 : off;
    g.moveTo(x + l, y); g.lineTo(x + w, y); g.lineTo(x + w - r, y + h); g.lineTo(x, y + h);
    g.closePath();
    return;
  }
  const rr = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (rr < 0.5) { g.rect(x, y, w, h); return; }
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr); g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr); g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** Radius, slant and glass of a plate after the look's plate style. */
export function plateStyle(p: Record<string, unknown>, rc: LayerRenderContext, h: number): { radius: number; off: number; glass: boolean } {
  const shape = str(p.shape, "look");
  const style = shape === "look" ? rc.look.plate : shape;
  const r0 = num(p.radius, -1);
  const radius = style === "pill" ? h / 2 : r0 >= 0 ? r0 : style === "rounded" || style === "glass" ? rc.look.radius : 0;
  const skew = num(p.skew, 14);
  const off = style === "angled" ? Math.min(h * 0.6, Math.tan((Math.abs(skew) * Math.PI) / 180) * h) : 0;
  const glass = p.glass === true || (p.glass !== false && shape === "look" && rc.look.plate === "glass");
  return { radius, off, glass };
}

const noShadow = (g: Ctx2D) => { g.shadowColor = "rgba(0,0,0,0)"; g.shadowBlur = 0; g.shadowOffsetX = 0; g.shadowOffsetY = 0; };

registerLayerKind({
  kind: "rect", label: "Plate", group: "Basic",
  props: [
    { key: "fill", label: "Fill", type: "paint", default: "@primary", group: "Fill" },
    { key: "gloss", label: "Gloss", type: "number", default: 0, min: 0, max: 0.6, step: 0.02, group: "Fill", hint: "A soft light-to-dark sheen" },
    { key: "glass", label: "Glass", type: "choice", default: "look", options: [{ value: "look", label: "As the look" }, { value: "on", label: "On" }, { value: "off", label: "Off" }], group: "Fill" },
    { key: "shape", label: "Shape", type: "choice", default: "look", options: SHAPES, group: "Shape" },
    { key: "radius", label: "Corner radius", type: "number", default: -1, min: -1, max: 200, step: 1, unit: "px", group: "Shape", hint: "-1 follows the look" },
    { key: "skew", label: "End angle", type: "number", default: 14, min: 0, max: 45, step: 1, unit: "°", group: "Shape" },
    { key: "ends", label: "Angled ends", type: "choice", default: "both", options: [{ value: "both", label: "Both" }, { value: "left", label: "Left" }, { value: "right", label: "Right" }], group: "Shape" },
    { key: "stroke", label: "Outline", type: "paint", default: "", group: "Outline" },
    { key: "strokeWidth", label: "Outline width", type: "number", default: 0, min: 0, max: 20, step: 0.5, unit: "px", group: "Outline" },
    { key: "stripe", label: "Accent stripe", type: "choice", default: "none", options: SIDES, group: "Stripe" },
    { key: "stripeColor", label: "Stripe colour", type: "paint", default: "@accent", group: "Stripe" },
    { key: "stripeWidth", label: "Stripe width", type: "number", default: 8, min: 1, max: 80, step: 1, unit: "px", group: "Stripe" },
  ],
  draw(g, l, rc) {
    const p = l.p;
    const b = boxOf(l, rc);
    const [x, y, w, h] = b;
    if (w <= 0 || h <= 0) return;
    const glassP = p.glass === "on" ? true : p.glass === "off" ? false : p.glass;
    const st = plateStyle({ ...p, glass: glassP === "look" ? undefined : glassP }, rc, h);
    const ends = str(p.ends, "both");
    platePath(g, b, st.radius, st.off, ends);
    const fill = rc.paint(p.fill as Paint | undefined, "@primary");
    if (fill) {
      if (st.glass) { const a = g.globalAlpha; g.globalAlpha = a * 0.8; g.fillStyle = fill; g.fill(); g.globalAlpha = a; }
      else { g.fillStyle = fill; g.fill(); }
    }
    noShadow(g);
    const gloss = num(p.gloss, 0);
    if (gloss > 0 || st.glass) {
      g.save(); g.clip();
      const k = st.glass ? Math.max(gloss, 0.16) : gloss;
      const gr = g.createLinearGradient(0, y, 0, y + h);
      gr.addColorStop(0, `rgba(255,255,255,${k})`); gr.addColorStop(0.5, "rgba(255,255,255,0)");
      gr.addColorStop(1, `rgba(0,0,0,${k * 0.7})`);
      g.fillStyle = gr; g.fillRect(x, y, w, h);
      if (st.glass) { g.fillStyle = "rgba(255,255,255,0.45)"; g.fillRect(x, y, w, Math.max(1, 1.5)); }
      g.restore();
    }
    const side = str(p.stripe, "none");
    if (side !== "none") {
      const sw = num(p.stripeWidth, 8);
      const sc = rc.paint(p.stripeColor as Paint | undefined, "@accent");
      g.save();
      platePath(g, b, st.radius, st.off, ends); g.clip();
      g.fillStyle = sc;
      if (side === "left") { g.beginPath(); g.moveTo(x, y); g.lineTo(x + st.off + sw, y); g.lineTo(x + sw, y + h); g.lineTo(x, y + h); g.closePath(); g.fill(); }
      else if (side === "right") { g.beginPath(); g.moveTo(x + w - sw, y); g.lineTo(x + w, y); g.lineTo(x + w, y + h); g.lineTo(x + w - st.off - sw, y + h); g.closePath(); g.fill(); }
      else if (side === "top") g.fillRect(x, y, w, sw);
      else g.fillRect(x, y + h - sw, w, sw);
      g.restore();
    }
    const sw = num(p.strokeWidth, 0);
    const stroke = sw > 0 ? rc.paint(p.stroke as Paint | undefined) : "";
    if (stroke) { platePath(g, b, st.radius, st.off, ends); g.strokeStyle = stroke; g.lineWidth = sw; g.stroke(); }
  },
});

// ── text ─────────────────────────────────────────────────────────────────────

const ALIGN = [{ value: "left", label: "Left" }, { value: "center", label: "Centre" }, { value: "right", label: "Right" }];
const VALIGN = [{ value: "top", label: "Top" }, { value: "middle", label: "Middle" }, { value: "bottom", label: "Bottom" }];

export interface TextSetup { s: string; size: number; weight?: number; font: string; italic: boolean; tracking: number; lh: number; fontAt(size: number): string }

/** What a text layer shows and in which font (shared by draw, measure and fonts). */
export function textSetup(l: GfxLayer, rc: Pick<LayerRenderContext, "text" | "font">): TextSetup {
  const p = l.p;
  const up = p.upper;
  let s = rc.text(str(p.text, ""), up === "look");
  if (up === true || up === "on") s = s.toUpperCase();
  const size = num(p.size, 48);
  const w0 = num(p.weight, 0);
  const weight = w0 > 0 ? w0 : undefined;
  const font = str(p.font, "@body");
  const italic = p.italic === true;
  const tracking = isIndic(s) ? 0 : num(p.tracking, 0);
  const lh = num(p.lineHeight, 1.15);
  const fontAt = (sz: number) => (italic ? "italic " : "") + rc.font(font, sz, weight, s);
  return { s, size, weight, font, italic, tracking, lh, fontAt };
}

const metricCache = new Map<string, { cap: number; asc: number; desc: number }>();
clearWithFonts(() => metricCache.clear());
/** A letter whose top is the script's main line (Latin cap height, the Indic head line). */
const BODY_CHAR: Record<string, string> = { latn: "H", deva: "क", beng: "ক", guru: "ਕ", gujr: "ક", orya: "କ", taml: "க", telu: "క", knda: "ಕ", mlym: "ക" };
/** Cap (or head-line) height and the font box, per font and script. */
function metrics(g: Ctx2D, font: string, size: number, script = "latn"): { cap: number; asc: number; desc: number } {
  const key = `${font}|${script}`;
  let m = metricCache.get(key);
  if (!m) {
    g.font = font;
    const h = g.measureText(BODY_CHAR[script] ?? "H");
    const cap = h.actualBoundingBoxAscent || size * 0.7;
    m = { cap, asc: h.fontBoundingBoxAscent || size * 0.9, desc: h.fontBoundingBoxDescent || size * 0.25 };
    if (metricCache.size > 500) metricCache.clear();
    metricCache.set(key, m);
  }
  return m;
}

/** Fitted lines of a text layer in its box (cached). */
export function fitLayer(g: Ctx2D, l: GfxLayer, ts: TextSetup, w: number, h: number): FitResult {
  const p = l.p;
  const fit = str(p.fit, "shrink") as "shrink" | "wrap" | "ellipsis" | "none";
  const maxLines = num(p.maxLines, 0);
  const minScale = num(p.minScale, 0.6);
  const key = `${ts.fontAt(ts.size)}|${ts.tracking}|${w.toFixed(1)}x${h.toFixed(1)}|${fit}|${maxLines}|${minScale}|${ts.lh}|${ts.s}`;
  return fitCached(key, () => fitText(ts.s, w, h, { size: ts.size, lineHeight: ts.lh, maxLines, fit, minScale },
    (sz) => measurer(g, ts.fontAt(sz), (ts.tracking * sz) / ts.size)));
}

type Part = { text: string; line: number; x: number; w: number };

/** The parts a text step animates: lines, words, or letters (Indic text: words). */
function splitParts(lines: string[], by: string, measure: (s: string) => number, lineX: (i: number, w: number) => number): Part[] {
  const out: Part[] = [];
  lines.forEach((line, li) => {
    const lw = measure(line);
    const x0 = lineX(li, lw);
    if (by === "line") { out.push({ text: line, line: li, x: x0, w: lw }); return; }
    const ps = by === "char" ? charParts(line) : wordParts(line);
    let acc = "";
    for (const t of ps) {
      const x = x0 + measure(acc);
      out.push({ text: t, line: li, x, w: measure(t) });
      acc += t;
    }
  });
  return out;
}

function partPoseAt(a: PartAnim | undefined, i: number, n: number, box: Box, rc: LayerRenderContext): Pose {
  if (!a) return IDENTITY;
  const pr = partProgress(a.step, a.local, a.dur, i, n, rc.fps);
  const e = a.step.kind === "typewriter" ? pr : a.leaving ? 1 - easeFn(a.step.ease, rc.look.motion, true)(pr) : easeFn(a.step.ease, rc.look.motion)(pr);
  return partPose(a.step, a.leaving && a.step.kind === "typewriter" ? (pr >= 1 ? 0 : 1) : e, box, a.leaving);
}

registerLayerKind({
  kind: "text", label: "Text", group: "Text",
  props: [
    { key: "text", label: "Text", type: "longtext", default: "{text}", group: "Text", hint: "Use {field} for a blank" },
    { key: "font", label: "Font", type: "font", default: "@body", group: "Font" },
    { key: "size", label: "Size", type: "number", default: 48, min: 8, max: 400, step: 1, unit: "px", group: "Font" },
    { key: "weight", label: "Weight", type: "number", default: 0, min: 0, max: 900, step: 100, group: "Font", hint: "0 follows the look" },
    { key: "italic", label: "Italic", type: "bool", default: false, group: "Font" },
    { key: "color", label: "Colour", type: "paint", default: "@text", group: "Font" },
    { key: "align", label: "Align", type: "choice", default: "left", options: ALIGN, group: "Layout" },
    { key: "valign", label: "Vertical align", type: "choice", default: "middle", options: VALIGN, group: "Layout" },
    { key: "padX", label: "Side padding", type: "number", default: 0, min: 0, max: 200, step: 1, unit: "px", group: "Layout" },
    { key: "tracking", label: "Letter spacing", type: "number", default: 0, min: -10, max: 40, step: 0.5, unit: "px", group: "Layout", hint: "Not applied to Indic scripts" },
    { key: "lineHeight", label: "Line height", type: "number", default: 1.15, min: 0.8, max: 2, step: 0.05, group: "Layout" },
    { key: "upper", label: "Capitals", type: "choice", default: "off", options: [{ value: "look", label: "As the look" }, { value: "on", label: "On" }, { value: "off", label: "Off" }], group: "Text" },
    { key: "fit", label: "When it doesn't fit", type: "choice", default: "shrink", options: [{ value: "shrink", label: "Shrink, wrap, then …" }, { value: "wrap", label: "Wrap, then …" }, { value: "ellipsis", label: "One line with …" }, { value: "none", label: "Let it overflow" }], group: "Fit" },
    { key: "maxLines", label: "Max lines", type: "number", default: 0, min: 0, max: 12, step: 1, group: "Fit", hint: "0 = as many as fit" },
    { key: "minScale", label: "Smallest size", type: "number", default: 0.6, min: 0.3, max: 1, step: 0.05, group: "Fit" },
    { key: "outline", label: "Outline", type: "paint", default: "", group: "Outline" },
    { key: "outlineWidth", label: "Outline width", type: "number", default: 0, min: 0, max: 20, step: 0.5, unit: "px", group: "Outline" },
    { key: "grow", label: "Fit plates to this text", type: "layer", default: null, group: "Plates", hint: "{ layers: [ids], pad, min, max }" },
  ],
  measure(g, l, rc) {
    const ts = textSetup(l, rc);
    if (!ts.s) return 0;
    const m = measurer(g, ts.fontAt(ts.size), ts.tracking);
    return ts.s.split(/\r?\n/).reduce((a, x) => Math.max(a, m(x)), 0);
  },
  fonts(l, rc) {
    const ts = textSetup(l, { text: rc.text, font: (n, s, w, sample) => cssFont(n, rc.look, s, w, sample) });
    return [ts.fontAt(ts.size)];
  },
  draw(g, l, rc) {
    const p = l.p;
    const ts = textSetup(l, rc);
    if (!ts.s.trim()) return;
    const [bx, by, bw, bh] = boxOf(l, rc);
    const padX = num(p.padX, 0);
    const w = Math.max(1, bw - padX * 2);
    const r = fitLayer(g, l, ts, w, bh);
    const font = ts.fontAt(r.size);
    const track = (ts.tracking * r.size) / ts.size;
    const indic = isIndic(ts.s);
    const m = metrics(g, font, r.size, indic ? scriptOf(ts.s) : "latn");
    const lh = r.size * ts.lh;
    const total = r.lines.length * lh;
    const valign = str(p.valign, "middle");
    const top = valign === "top" ? by : valign === "bottom" ? by + bh - total : by + (bh - total) / 2;
    // the letters' main body is centred on the line (Indic: between the head line and the baseline, a touch low for
    // the vowel signs above)
    const baseOf = (i: number) => top + i * lh + lh / 2 + m.cap / 2 + (indic ? r.size * 0.06 : 0);
    const align = str(p.align, "left");
    const meas = measurer(g, font, track);
    const lineX = (_i: number, lw: number) => (align === "center" ? bx + bw / 2 - lw / 2 : align === "right" ? bx + bw - padX - lw : bx + padX);
    g.font = font;
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
    if (track && "letterSpacing" in g) (g as { letterSpacing: string }).letterSpacing = `${track}px`;
    const fill = rc.paint(p.color as Paint | undefined, "@text");
    const ow = num(p.outlineWidth, 0);
    const outline = ow > 0 ? rc.paint(p.outline as Paint | undefined) : "";
    const put = (s: string, x: number, y: number) => {
      if (outline) { g.lineJoin = "round"; g.strokeStyle = outline; g.lineWidth = ow * 2; g.strokeText(s, x, y); noShadow(g); }
      g.fillStyle = fill; g.fillText(s, x, y);
    };
    const parts = isCore(rc) ? rc.parts : undefined;
    if (!parts?.in && !parts?.out) {
      r.lines.forEach((line, i) => put(line, lineX(i, meas(line)), baseOf(i)));
      return;
    }
    // part by part (stagger / typewriter): Indic text never per letter
    const step = parts.in?.step ?? parts.out!.step;
    let by0 = step.by ?? (step.kind === "typewriter" ? "char" : "word");
    if (by0 === "all" || by0 === "item") by0 = "word";
    const list = splitParts(r.lines, by0, meas, lineX);
    const n = list.length;
    const a0 = g.globalAlpha;
    list.forEach((pt, i) => {
      const pb: Box = [pt.x, top + pt.line * lh, pt.w, lh];
      const pose = combine(partPoseAt(parts.in, i, n, pb, rc), partPoseAt(parts.out, i, n, pb, rc));
      if (pose.alpha <= 0.001) return;
      const cx = pt.x + pt.w / 2, cy = pb[1] + lh / 2;
      g.save();
      g.globalAlpha = a0 * clamp01(pose.alpha);
      if (pose.reveal) { g.beginPath(); g.rect(pt.x + pt.w * pose.reveal[0] + pose.dx, pb[1] - lh * 0.3, pt.w * (pose.reveal[2] - pose.reveal[0]), lh * 1.6); g.clip(); }
      g.translate(cx + pose.dx, cy + pose.dy);
      if (pose.rot) g.rotate((pose.rot * Math.PI) / 180);
      if (pose.sx !== 1 || pose.sy !== 1) g.scale(pose.sx, pose.sy);
      g.translate(-cx, -cy);
      if (pose.blur > 0.05 && "filter" in g) g.filter = `blur(${(pose.blur * rc.scale).toFixed(2)}px)`;
      put(pt.text, pt.x, baseOf(pt.line));
      g.restore();
    });
  },
});

// ── image ────────────────────────────────────────────────────────────────────

registerLayerKind({
  kind: "image", label: "Picture", group: "Basic",
  props: [
    { key: "field", label: "Picture field", type: "field", default: "photo", group: "Picture" },
    { key: "fit", label: "Fit", type: "choice", default: "cover", options: [{ value: "cover", label: "Fill the box" }, { value: "contain", label: "Whole picture" }], group: "Picture" },
    { key: "shape", label: "Shape", type: "choice", default: "rect", options: [{ value: "rect", label: "Square corners" }, { value: "rounded", label: "Rounded" }, { value: "circle", label: "Circle" }], group: "Shape" },
    { key: "radius", label: "Corner radius", type: "number", default: -1, min: -1, max: 200, step: 1, unit: "px", group: "Shape", hint: "-1 follows the look" },
    { key: "border", label: "Border", type: "paint", default: "", group: "Border" },
    { key: "borderWidth", label: "Border width", type: "number", default: 0, min: 0, max: 30, step: 0.5, unit: "px", group: "Border" },
    { key: "bg", label: "Placeholder", type: "paint", default: "@dark/70", group: "Picture", hint: "Shown while there's no picture" },
    { key: "focusX", label: "Aim across", type: "number", default: 0.5, min: 0, max: 1, step: 0.01, group: "Picture" },
    { key: "focusY", label: "Aim down", type: "number", default: 0.35, min: 0, max: 1, step: 0.01, group: "Picture" },
  ],
  images(l, rc) {
    const v = l.p.src ?? rc.value(str(l.p.field, "photo"));
    if (typeof v === "string" && v) return [v];
    const ref = v as GfxImageRef | null;
    return ref && typeof ref === "object" && !Array.isArray(ref) && ref.mediaId ? [ref.mediaId] : [];
  },
  draw(g, l, rc) {
    const p = l.p;
    const b = boxOf(l, rc);
    const [x, y, w, h] = b;
    const v = (p.src as string | undefined) ?? rc.value(str(p.field, "photo"));
    const ref = typeof v === "string" || (v && typeof v === "object" && !Array.isArray(v)) ? (v as GfxImageRef | string) : null;
    const img = ref ? rc.image(ref) : null;
    const shape = str(p.shape, "rect");
    const r0 = num(p.radius, -1);
    const radius = shape === "circle" ? Math.min(w, h) / 2 : shape === "rounded" ? (r0 >= 0 ? r0 : Math.max(8, rc.look.radius)) : r0 > 0 ? r0 : 0;
    const path = () => {
      if (shape === "circle") { g.beginPath(); g.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2); }
      else platePath(g, b, radius, 0, "both");
    };
    path();
    if (!img) {
      g.fillStyle = rc.paint(p.bg as Paint | undefined, "@dark/70"); g.fill();
      noShadow(g);
      const s = Math.min(w, h) * 0.6;
      g.save(); path(); g.clip();
      drawIcon(g, "user", x + (w - s) / 2, y + h - s * 0.98, s, s, rc.paint("@light/30") as string);
      g.restore();
    } else {
      g.save();
      g.fillStyle = "#000"; g.fill();
      noShadow(g);
      path(); g.clip();
      const { w: iw0, h: ih0 } = sizeOf(img);
      const crop = typeof ref === "object" && ref?.crop ? ref.crop : null;
      const sx0 = crop ? crop[0] * iw0 : 0, sy0 = crop ? crop[1] * ih0 : 0;
      const iw = crop ? crop[2] * iw0 : iw0, ih = crop ? crop[3] * ih0 : ih0;
      const cover = str(p.fit, "cover") !== "contain";
      const k = cover ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
      const dw = iw * k, dh = ih * k;
      const fx = num(p.focusX, 0.5), fy = num(p.focusY, 0.35);
      const dx = x + (w - dw) * (cover ? fx : 0.5), dy = y + (h - dh) * (cover ? fy : 0.5);
      g.drawImage(img, sx0, sy0, iw, ih, dx, dy, dw, dh);
      g.restore();
    }
    const bw = num(p.borderWidth, 0);
    const border = bw > 0 ? rc.paint(p.border as Paint | undefined) : "";
    if (border) { path(); g.strokeStyle = border; g.lineWidth = bw; g.stroke(); }
  },
});

// ── logo ─────────────────────────────────────────────────────────────────────

registerLayerKind({
  kind: "logo", label: "Channel logo", group: "Basic",
  props: [
    { key: "align", label: "Align", type: "choice", default: "center", options: ALIGN, group: "Logo" },
    { key: "color", label: "Text logo colour", type: "paint", default: "@textOnPrimary", group: "Text logo" },
    { key: "color2", label: "Second word colour", type: "paint", default: "@accent", group: "Text logo" },
    { key: "font", label: "Text logo font", type: "font", default: "@headline", group: "Text logo" },
    { key: "weight", label: "Weight", type: "number", default: 800, min: 100, max: 900, step: 100, group: "Text logo" },
    { key: "plate", label: "Plate", type: "paint", default: "", group: "Plate" },
    { key: "pad", label: "Padding", type: "number", default: 0, min: 0, max: 80, step: 1, unit: "px", group: "Plate" },
  ],
  images(_l, rc) { const lg = rc.look.logo; return lg?.image ? [lg.image] : lg?.mediaId ? [lg.mediaId] : []; },
  fonts(l, rc) { return [cssFont(str(l.p.font, "@headline"), rc.look, 48, num(l.p.weight, 800), rc.look.logo?.text ?? "")]; },
  draw(g, l, rc) {
    const p = l.p;
    const b = boxOf(l, rc);
    const pad = num(p.pad, 0);
    const plate = rc.paint(p.plate as Paint | undefined);
    if (plate) {
      const st = plateStyle(p, rc, b[3]);
      platePath(g, b, st.radius, st.off, "both"); g.fillStyle = plate; g.fill(); noShadow(g);
    }
    const [x, y, w, h] = [b[0] + pad, b[1] + pad, b[2] - pad * 2, b[3] - pad * 2];
    if (w <= 0 || h <= 0) return;
    const align = str(p.align, "center");
    const img = rc.logo();
    if (img) {
      const { w: iw, h: ih } = sizeOf(img);
      const k = Math.min(w / iw, h / ih);
      const dw = iw * k, dh = ih * k;
      const dx = align === "left" ? x : align === "right" ? x + w - dw : x + (w - dw) / 2;
      g.drawImage(img, dx, y + (h - dh) / 2, dw, dh);
      return;
    }
    const text = (rc.look.logo?.text || "NEWS").trim();
    const words = text.split(/\s+/);
    const first = words[0], rest = words.slice(1).join(" ");
    const weight = num(p.weight, 800);
    const name = str(p.font, "@headline");
    let size = h * 0.72;
    const mAt = (sz: number) => measurer(g, rc.font(name, sz, weight, text), 0);
    const full = mAt(size)(rest ? `${first} ${rest}` : first);
    if (full > w) size = Math.max(6, size * (w / full));
    const font = rc.font(name, size, weight, text);
    const m = mAt(size);
    const gap = rest ? m(" ") : 0;
    const w1 = m(first), w2 = rest ? m(rest) : 0;
    const tw = w1 + gap + w2;
    const x0 = align === "left" ? x : align === "right" ? x + w - tw : x + (w - tw) / 2;
    const mt = metrics(g, font, size, isIndic(text) ? scriptOf(text) : "latn");
    const base = y + h / 2 + mt.cap / 2;
    g.font = font; g.textAlign = "left"; g.textBaseline = "alphabetic";
    g.fillStyle = rc.paint(p.color as Paint | undefined, "@textOnPrimary");
    g.fillText(first, x0, base);
    if (rest) { noShadow(g); g.fillStyle = rc.paint(p.color2 as Paint | undefined, "@accent"); g.fillText(rest, x0 + w1 + gap, base); }
  },
});

// ── line ─────────────────────────────────────────────────────────────────────

registerLayerKind({
  kind: "line", label: "Line", group: "Basic",
  props: [
    { key: "color", label: "Colour", type: "paint", default: "@accent" },
    { key: "width", label: "Thickness", type: "number", default: 3, min: 0.5, max: 40, step: 0.5, unit: "px" },
    { key: "dir", label: "Direction", type: "choice", default: "auto", options: [{ value: "auto", label: "Along the box" }, { value: "h", label: "Across" }, { value: "v", label: "Down" }, { value: "diag", label: "Diagonal" }] },
    { key: "dash", label: "Style", type: "choice", default: "solid", options: [{ value: "solid", label: "Solid" }, { value: "dash", label: "Dashed" }, { value: "dot", label: "Dotted" }] },
  ],
  draw(g, l, rc) {
    const p = l.p;
    const [x, y, w, h] = boxOf(l, rc);
    const lw = num(p.width, 3);
    const dir0 = str(p.dir, "auto");
    const dir = dir0 === "auto" ? (w >= h ? "h" : "v") : dir0;
    g.strokeStyle = rc.paint(p.color as Paint | undefined, "@accent");
    g.lineWidth = lw;
    const dash = str(p.dash, "solid");
    if (dash !== "solid") { g.setLineDash(dash === "dot" ? [0.01, lw * 2.2] : [lw * 4, lw * 2.5]); g.lineCap = dash === "dot" ? "round" : "butt"; }
    g.beginPath();
    if (dir === "h") { g.moveTo(x, y + h / 2); g.lineTo(x + w, y + h / 2); }
    else if (dir === "v") { g.moveTo(x + w / 2, y); g.lineTo(x + w / 2, y + h); }
    else { g.moveTo(x, y + h); g.lineTo(x + w, y); }
    g.stroke();
    g.setLineDash([]);
  },
});

// ── icon ─────────────────────────────────────────────────────────────────────

registerLayerKind({
  kind: "icon", label: "Icon", group: "Basic",
  props: [
    { key: "icon", label: "Icon", type: "icon", default: "live", options: iconList().map(([value, d]) => ({ value, label: d.label })) },
    { key: "color", label: "Colour", type: "paint", default: "@textOnPrimary" },
    { key: "color2", label: "Second colour", type: "paint", default: "@accent" },
    { key: "weight", label: "Line weight", type: "number", default: 1, min: 0.5, max: 2.5, step: 0.1 },
    { key: "bg", label: "Behind it", type: "paint", default: "", group: "Backing" },
    { key: "bgShape", label: "Backing shape", type: "choice", default: "circle", options: [{ value: "circle", label: "Circle" }, { value: "rounded", label: "Rounded square" }, { value: "square", label: "Square" }], group: "Backing" },
    { key: "pad", label: "Padding", type: "number", default: 0.18, min: 0, max: 0.45, step: 0.01, group: "Backing", hint: "Share of the box around the icon when it has a backing" },
  ],
  draw(g, l, rc) {
    const p = l.p;
    const [x, y, w, h] = boxOf(l, rc);
    const name = rc.text(str(p.icon, "live"));
    const bg = rc.paint(p.bg as Paint | undefined);
    let ix = x, iy = y, iw = w, ih = h;
    if (bg) {
      const s = Math.min(w, h);
      const sh = str(p.bgShape, "circle");
      g.beginPath();
      if (sh === "circle") g.arc(x + w / 2, y + h / 2, s / 2, 0, Math.PI * 2);
      else platePath(g, [x + (w - s) / 2, y + (h - s) / 2, s, s], sh === "rounded" ? s * 0.22 : 0, 0, "both");
      g.fillStyle = bg; g.fill(); noShadow(g);
      const pad = s * num(p.pad, 0.18);
      ix = x + (w - s) / 2 + pad; iy = y + (h - s) / 2 + pad; iw = ih = s - pad * 2;
    }
    drawIcon(g, name, ix, iy, iw, ih, rc.paint(p.color as Paint | undefined, "@textOnPrimary"), rc.paint(p.color2 as Paint | undefined, "@accent"), num(p.weight, 1));
  },
});

export const BASIC_KINDS = ["rect", "text", "image", "logo", "line", "icon"] as const;
export type { PropDef, CoreRenderContext };
