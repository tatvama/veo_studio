/**
 * The News Room renderer (docs/EDITOR.md §16.3): draws a graphic (template + values + look) into a W×H Canvas2D at t
 * seconds of a clip `dur` long. It picks the design for the frame (or makes one by pins), maps design px to the canvas,
 * fits plates to their text (`p.grow`), lifts straps above tickers, and for every layer applies its in / out / loop
 * animation (render/anim.ts) as a transform, opacity, reveal, blur, glow or light sweep before its kind draws it.
 * Everything is a pure function of t, so the same frame always draws the same picture. `graphicFrameKey` is static
 * between animations, so the engine uploads a still graphic once; `bounds` limits the upload to what changed.
 */
import { fmtClock, fmtDate, fmtNumber, zonedTimeToMs } from "../format.ts";
import type { AnimDir, Box, GfxField, GfxImageRef, GfxLayer, GfxListItem, GfxRatio, GfxTemplate, GfxValue } from "../types.ts";
import { clamp01, combine, easeFn, IDENTITY, isPartStep, loopPose, poseOf, stepProgress, type Pose } from "./anim.ts";
import type { CoreRenderContext } from "./context.ts";
import type { Ctx2D, DirtyRect, GfxRenderInput, LayerRenderContext } from "./contract.ts";
import { assetEpoch, bumpAssets, imageFor, loadImage } from "./images.ts";
import "./kinds/index.ts";
import { designFor as designForRatio, designSpace, movingAt, partSpan, planOf, ratioOf as ratioOfWH, segmentAt, type LayerPlan, type Plan } from "./layout.ts";
import { cssFont, paintFor } from "./paint.ts";
import { layerKind } from "./registry.ts";

export type { GfxRenderInput, DirtyRect } from "./contract.ts";

/** The nearest ratio for a W×H frame. */
export function ratioOf(W: number, H: number): GfxRatio { return ratioOfWH(W, H); }
/** The design for a ratio: its own, else one made automatically from the nearest design (by the layers' pins). */
export function designFor(t: GfxTemplate, ratio: GfxRatio): ReturnType<typeof designForRatio> { return designForRatio(t, ratio); }

// ── plans (cached per input and frame size) ──────────────────────────────────

const plans = new WeakMap<GfxRenderInput, Map<string, Plan>>();
function planFor(input: GfxRenderInput, W: number, H: number, dur: number): Plan {
  let m = plans.get(input);
  if (!m) { m = new Map(); plans.set(input, m); }
  const k = `${W}x${H}|${dur}`;
  let p = m.get(k);
  if (!p) { p = planOf(input, W, H, dur); if (m.size > 8) m.clear(); m.set(k, p); }
  return p;
}

/** The air-time clock at the clip's start (epoch ms): the input's, else 1 Jan 2026 19:00 in the look's zone. */
export const clockBase = (input: GfxRenderInput) => input.clockAt ?? zonedTimeToMs("2026-01-01T19:00", input.look.clock.zone);

// ── text values ──────────────────────────────────────────────────────────────

/** A field value as text (numbers in the field's format, lists joined). */
export function valueText(v: GfxValue | undefined, field: GfxField | undefined, look: GfxRenderInput["look"]): string {
  if (v === null || v === undefined || typeof v === "boolean") return "";
  if (typeof v === "number") return fmtNumber(v, look, field?.format);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return (v as unknown[]).map((x) => (typeof x === "string" ? x : typeof x === "object" && x && "text" in x ? (x as GfxListItem).text : "")).filter(Boolean).join(" · ");
  return "";
}

/** "{field}" tokens filled in ("{$time}", "{$time:s}", "{$date}" are the air-time clock). */
export function fillText(s: string, values: Record<string, GfxValue>, fields: Map<string, GfxField>, look: GfxRenderInput["look"], clock: number): string {
  if (!s.includes("{")) return s;
  return s.replace(/\{([^{}]+)\}/g, (all, id: string) => {
    const k = id.trim();
    if (k === "$time") return fmtClock(clock, look);
    if (k === "$time:s") return fmtClock(clock, look, true);
    if (k === "$date") return fmtDate(clock, look);
    if (!(k in values) && !fields.has(k)) return all;
    return valueText(values[k], fields.get(k), look);
  });
}

const fieldMaps = new WeakMap<GfxTemplate, Map<string, GfxField>>();
const fieldsOf = (t: GfxTemplate) => { let m = fieldMaps.get(t); if (!m) { m = new Map(t.fields.map((f) => [f.id, f])); fieldMaps.set(t, m); } return m; };

/** Deterministic 0..1 noise. */
export function hash01(seed: number, i: number): number {
  let h = (Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i | 0, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ── the layer context ────────────────────────────────────────────────────────

function makeContext(g: Ctx2D, input: GfxRenderInput, plan: Plan, t: number, dur: number, scale: number): CoreRenderContext {
  const look = input.look;
  const fields = fieldsOf(input.template);
  const clock = clockBase(input) + t * 1000;
  const urlOf = (ref: GfxImageRef | string | undefined | null): string | undefined => {
    if (!ref) return undefined;
    if (typeof ref === "string") return /^(data:|blob:|https?:|\/|gen:)/.test(ref) ? ref : input.images[ref];
    return ref.mediaId ? input.images[ref.mediaId] : undefined;
  };
  const rc: CoreRenderContext = {
    t, dur, phase: { in: 1, out: 1 }, shown: 0, look, ratio: plan.ratio, designW: plan.w, designH: plan.h, scale,
    seed: input.seed ?? 0, fps: input.fps || 25, clock, box: [0, 0, 0, 0], pixel: scale,
    value: (id) => plan.values[id] ?? null,
    text: (s, upper) => { const x = fillText(s ?? "", plan.values, fields, look, clock); return upper && look.upper ? x.toUpperCase() : x; },
    paint: (p, fb) => paintFor(g, p, look, rc.box, fb),
    font: (name, size, weight, sample) => cssFont(name, look, size, weight, sample),
    image: (ref) => imageFor(urlOf(ref)),
    logo: () => imageFor(look.logo?.image || (look.logo?.mediaId ? input.images[look.logo.mediaId] : undefined)),
    number: (n, f) => fmtNumber(n, look, f),
    rand: (i) => hash01(input.seed ?? 0, i),
    ease: (x, kind) => easeFn(kind, look.motion)(clamp01(x)),
  };
  return rc;
}

// ── plate growth (p.grow) ────────────────────────────────────────────────────

interface Grow { layers: string[]; pad?: number; min?: number; max?: number }
const grown = new WeakMap<Plan, { epoch: number; boxes: Map<string, Box> }>();

/** Boxes after text-driven plate growth: each plate listed in a text layer's `p.grow` fits that text's width. */
function boxesOf(g: Ctx2D, plan: Plan, rc: CoreRenderContext): Map<string, Box> {
  const hit = grown.get(plan);
  if (hit && hit.epoch === assetEpoch()) return hit.boxes;
  const boxes = new Map<string, Box>(plan.layers.map((p) => [p.layer.id, p.layer.box]));
  const want = new Map<string, Box>();
  for (const { layer } of plan.layers) {
    const gr = layer.p.grow as Grow | undefined;
    const kind = layerKind(layer.kind);
    if (!gr || !Array.isArray(gr.layers) || !kind?.measure) continue;
    rc.box = layer.box;
    const tw = kind.measure(g, layer, rc);
    const align = (layer.p.align as string) ?? "left";
    const pad = gr.pad ?? 24;
    for (const id of gr.layers) {
      const b = boxes.get(id);
      if (!b) continue;
      const [tx, , tbw] = layer.box;
      let x0: number, x1: number;
      if (align === "right") { x1 = b[0] + b[2]; x0 = Math.min(x1, tx + tbw - tw - pad); x0 = Math.min(x0, x1 - (gr.min ?? 0)); if (gr.max) x0 = Math.max(x0, x1 - gr.max); }
      else if (align === "center") { const cx = b[0] + b[2] / 2; let w = tw + pad * 2; w = Math.max(gr.min ?? 0, gr.max ? Math.min(gr.max, w) : w); x0 = cx - w / 2; x1 = cx + w / 2; }
      else { x0 = b[0]; x1 = Math.max(x0, tx + tw + pad); x1 = Math.max(x1, x0 + (gr.min ?? 0)); if (gr.max) x1 = Math.min(x1, x0 + gr.max); }
      // the text may use the room it made (it shrinks only when the plate hit its max)
      const tb = want.get(layer.id) ?? layer.box;
      if (align === "right") { const nx = Math.min(tb[0], x0 + pad); want.set(layer.id, [nx, tb[1], tb[0] + tb[2] - nx, tb[3]]); }
      else if (align === "center") { const half = Math.max(tb[2], x1 - x0 - pad * 2) / 2; const c = tb[0] + tb[2] / 2; want.set(layer.id, [c - half, tb[1], half * 2, tb[3]]); }
      else want.set(layer.id, [tb[0], tb[1], Math.max(tb[2], x1 - pad - tb[0]), tb[3]]);
      const prev = want.get(id);
      const nb: Box = [x0, b[1], x1 - x0, b[3]];
      // two texts on one plate: the wider wins
      want.set(id, prev ? [Math.min(prev[0], nb[0]), b[1], Math.max(prev[0] + prev[2], nb[0] + nb[2]) - Math.min(prev[0], nb[0]), b[3]] : nb);
    }
  }
  for (const [id, b] of want) boxes.set(id, b);
  grown.set(plan, { epoch: assetEpoch(), boxes });
  return boxes;
}

// ── per-layer state ──────────────────────────────────────────────────────────

/** Kinds that resize their box for grow / unfold (the rest are revealed through a clip). */
const RESIZES = new Set(["rect", "line"]);

interface LayerState {
  plan: LayerPlan; layer: GfxLayer; pose: Pose;
  /** The box drawn (after growth and resizing), and the visible rectangle on screen (for `clip` and bounds). */
  box: Box; rect: Box;
  phase: { in: number; out: number }; shown: number;
  parts?: CoreRenderContext["parts"];
}

/**
 * A layer's pose at t: its in step (eased by the look), out step, and loop; null when it isn't on screen. Kinds that
 * own their animation (and text animated part by part) get no in / out transform, only phases.
 */
export function layerState(p: LayerPlan, box: Box, t: number, look: GfxRenderInput["look"], fps: number): LayerState | null {
  const { layer, timing } = p;
  const kind = layerKind(layer.kind);
  const outEnd = timing.out ? timing.out.start + timing.out.dur + partSpan(p, "out") : Infinity;
  if (t > outEnd + 1e-9) return null;
  const owns = !!kind?.ownsAnim;
  const textParts = layer.kind === "text";
  const pin = stepProgress(timing.in, t), pout = timing.out ? stepProgress(timing.out, t) : 0;
  const phase = { in: pin, out: 1 - pout };
  let pose: Pose = IDENTITY;
  let parts: LayerState["parts"];
  const inDir = (timing.in?.step.dir ?? (timing.in ? undefined : undefined)) as AnimDir | undefined;
  if (timing.in && !owns) {
    if (textParts && isPartStep(timing.in.step)) parts = { in: { step: timing.in.step, local: t - timing.in.start, dur: timing.in.dur, leaving: false } };
    else pose = poseOf(timing.in.step, easeFn(timing.in.step.ease, look.motion)(pin), box, false);
  }
  if (timing.out && !owns && t >= timing.out.start) {
    if (textParts && isPartStep(timing.out.step)) parts = { ...parts, out: { step: timing.out.step, local: t - timing.out.start, dur: timing.out.dur, leaving: true } };
    else pose = combine(pose, poseOf(timing.out.step, 1 - easeFn(timing.out.step.ease, look.motion, true)(pout), box, true, inDir));
  }
  const loop = layer.anim?.loop;
  if (loop && t >= timing.shownAt) pose = combine(pose, loopPose(loop, t - timing.shownAt, fps));
  if (pose.alpha <= 0.001 && !parts) return null;
  // the drawn box (grow / unfold resize plates) and where it lands on screen
  let b = box;
  if (pose.size) {
    const { w, h, ax, ay } = pose.size;
    const nw = box[2] * w, nh = box[3] * h;
    const sized: Box = [box[0] + (box[2] - nw) * ax, box[1] + (box[3] - nh) * ay, nw, nh];
    if (RESIZES.has(layer.kind)) b = sized;
    else {
      // others: reveal the same part instead of squashing them
      const rv: [number, number, number, number] = [(sized[0] - box[0]) / box[2], (sized[1] - box[1]) / box[3], (sized[0] + nw - box[0]) / box[2], (sized[1] + nh - box[1]) / box[3]];
      pose = { ...pose, reveal: pose.reveal ? [Math.max(pose.reveal[0], rv[0]), Math.max(pose.reveal[1], rv[1]), Math.min(pose.reveal[2], rv[2]), Math.min(pose.reveal[3], rv[3])] : rv };
    }
  }
  const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
  let rw = b[2] * Math.abs(pose.sx), rh = b[3] * Math.abs(pose.sy);
  let rx = cx - rw / 2 + pose.dx, ry = cy - rh / 2 + pose.dy;
  if (pose.reveal) {
    const [a0, b0, a1, b1] = pose.reveal;
    rx += rw * a0; ry += rh * b0; rw *= Math.max(0, a1 - a0); rh *= Math.max(0, b1 - b0);
  }
  return { plan: p, layer, pose, box: b, rect: [rx, ry, rw, rh], phase, shown: Math.max(0, t - timing.shownAt), parts };
}

// ── drawing ──────────────────────────────────────────────────────────────────

const BLEND: Record<string, GlobalCompositeOperation> = { normal: "source-over", screen: "screen", multiply: "multiply", add: "lighter", overlay: "overlay" };

let scratch: { c: OffscreenCanvas | HTMLCanvasElement; g: Ctx2D } | null = null;
function scratchOf(W: number, H: number): { c: OffscreenCanvas | HTMLCanvasElement; g: Ctx2D } | null {
  if (!scratch) {
    const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(W, H) : typeof document !== "undefined" ? document.createElement("canvas") : null;
    const g = c?.getContext("2d") as Ctx2D | null | undefined;
    if (!c || !g) return null;
    scratch = { c, g };
  }
  if (scratch.c.width !== W || scratch.c.height !== H) { scratch.c.width = W; scratch.c.height = H; }
  return scratch;
}

/** Draws one layer (its transform, clips, filters, shadow, then the kind). */
function drawLayer(g: Ctx2D, s: LayerState, rc: CoreRenderContext, base: DOMMatrix2DInit, clipRect: Box | null, withAlpha: boolean): void {
  const { layer, pose } = s;
  const kind = layerKind(layer.kind);
  if (!kind) return;
  const b = s.box;
  g.save();
  g.setTransform(base.a!, base.b!, base.c!, base.d!, base.e!, base.f!);
  if (withAlpha) {
    const a = (layer.opacity ?? 1) * pose.alpha;
    if (a < 1) g.globalAlpha = Math.max(0, a);
    const bl = layer.blend && BLEND[layer.blend];
    if (bl && bl !== "source-over") g.globalCompositeOperation = bl;
  }
  if (clipRect) { g.beginPath(); g.rect(clipRect[0], clipRect[1], clipRect[2], clipRect[3]); g.clip(); }
  const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
  if (pose.reveal) {
    const [a0, b0, a1, b1] = pose.reveal;
    // reveal along one axis; the other gets room for descenders, outlines and shadows
    const horiz = a0 > 0 || a1 < 1, vert = b0 > 0 || b1 < 1;
    const mx = vert && !horiz ? b[2] * 0.5 + 40 : 0, my = horiz && !vert ? b[3] * 0.5 + 40 : 0;
    const x0 = cx + pose.dx + (b[0] + b[2] * a0 - cx) * pose.sx - mx, x1 = cx + pose.dx + (b[0] + b[2] * a1 - cx) * pose.sx + mx;
    const y0 = cy + pose.dy + (b[1] + b[3] * b0 - cy) * pose.sy - my, y1 = cy + pose.dy + (b[1] + b[3] * b1 - cy) * pose.sy + my;
    g.beginPath(); g.rect(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)); g.clip();
  }
  const rot = (layer.rotation ?? 0) + pose.rot;
  if (pose.dx || pose.dy) g.translate(pose.dx, pose.dy);
  if (rot || pose.sx !== 1 || pose.sy !== 1) {
    g.translate(cx, cy);
    if (rot) g.rotate((rot * Math.PI) / 180);
    if (pose.sx !== 1 || pose.sy !== 1) g.scale(pose.sx, pose.sy);
    g.translate(-cx, -cy);
  }
  const filters: string[] = [];
  if (pose.blur > 0.05) filters.push(`blur(${(pose.blur * rc.scale).toFixed(2)}px)`);
  if (Math.abs(pose.bright - 1) > 0.01) filters.push(`brightness(${pose.bright.toFixed(3)})`);
  if (filters.length && "filter" in g) g.filter = filters.join(" ");
  rc.box = b;
  if (pose.glow > 0.2) {
    const gc = rc.paint((layer.p.glowColor ?? layer.p.fill ?? layer.p.color ?? "@accent") as string, "@accent");
    g.shadowColor = typeof gc === "string" ? gc : input0(rc);
    g.shadowBlur = pose.glow * rc.scale;
  } else if (layer.shadow) {
    const sc = rc.paint(layer.shadow.color, "rgba(0,0,0,0.5)");
    g.shadowColor = typeof sc === "string" ? sc : "rgba(0,0,0,0.5)";
    g.shadowBlur = layer.shadow.blur * rc.scale;
    g.shadowOffsetX = layer.shadow.x * rc.scale; g.shadowOffsetY = layer.shadow.y * rc.scale;
  }
  const drawn = b === layer.box ? layer : { ...layer, box: b };
  try { kind.draw(g, drawn, rc); } catch (e) { if (!warned.has(layer.kind)) { warned.add(layer.kind); console.warn(`[newsroom] ${layer.kind} layer failed`, e); } }
  g.restore();
}
const warned = new Set<string>();
const input0 = (rc: CoreRenderContext) => rc.look.colors.accent;

/** A light band across the layer's pixels (sweep / shine): drawn on the layer alone in a scratch canvas. */
function sweepBand(g: Ctx2D, rect: Box, at: number, base: DOMMatrix2DInit): void {
  const [x, y, w, h] = rect;
  const band = Math.max(40, Math.min(220, w * 0.18));
  const skew = h * 0.45;
  const cx = x - band - skew + (w + band * 2 + skew * 2) * at;
  g.save();
  g.setTransform(base.a!, base.b!, base.c!, base.d!, base.e!, base.f!);
  g.globalCompositeOperation = "source-atop";
  const gr = g.createLinearGradient(cx - band, 0, cx + band, 0);
  gr.addColorStop(0, "rgba(255,255,255,0)"); gr.addColorStop(0.5, "rgba(255,255,255,0.55)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.beginPath();
  g.moveTo(cx - band + skew, y - 4); g.lineTo(cx + band + skew, y - 4); g.lineTo(cx + band - skew, y + h + 4); g.lineTo(cx - band - skew, y + h + 4);
  g.closePath(); g.fill();
  g.restore();
}

/** Canvas rectangle a layer may touch (posed box, rotation, shadow, blur, glow), unclipped. */
function layerBounds(s: LayerState, rc: CoreRenderContext): Box {
  const [x, y, w, h] = s.rect;
  const l = s.layer;
  const rot = (((l.rotation ?? 0) + s.pose.rot) * Math.PI) / 180;
  let bw = w, bh = h;
  if (rot) { const c = Math.abs(Math.cos(rot)), sn = Math.abs(Math.sin(rot)); bw = w * c + h * sn; bh = w * sn + h * c; }
  const m = 6 + Math.max(w, h) * 0.08 + s.pose.blur * 2 + s.pose.glow * 1.5 + (l.shadow ? l.shadow.blur * 1.5 + Math.max(Math.abs(l.shadow.x), Math.abs(l.shadow.y)) : 0);
  const cx = x + w / 2, cy = y + h / 2;
  void rc;
  return [cx - bw / 2 - m, cy - bh / 2 - m, bw + 2 * m, bh + 2 * m];
}

/**
 * Draws the graphic at t (seconds into a clip `dur` long) into a W×H canvas, clearing it first; returns the canvas
 * rectangle that holds pixels (for partial uploads), null = nothing drawn.
 */
export function drawGraphic(g: Ctx2D, input: GfxRenderInput, W: number, H: number, t: number, dur: number): DirtyRect {
  watchFonts();
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  g.restore();
  if (!input?.template || !(W > 0 && H > 0)) return null;
  const d = Math.max(1e-3, dur || 0);
  const tt = Math.max(0, Math.min(d, t));
  const plan = planFor(input, W, H, d);
  if (!plan.layers.length) return null;
  const scale = Math.min(W / plan.w, H / plan.h);
  const ox = (W - plan.w * scale) / 2, oy = (H - plan.h * scale) / 2 - plan.lift * scale;
  const base: DOMMatrix2DInit = { a: scale, b: 0, c: 0, d: scale, e: ox, f: oy };
  const fps = input.fps || 25;
  const rc = makeContext(g, input, plan, tt, d, scale);
  const boxes = boxesOf(g, plan, rc);
  // pass 1: where everything is this frame
  const states = new Map<string, LayerState>();
  const list: LayerState[] = [];
  for (const p of plan.layers) {
    const s = layerState(p, boxes.get(p.layer.id) ?? p.layer.box, tt, input.look, fps);
    if (s) { states.set(p.layer.id, s); list.push(s); }
  }
  // pass 2: draw in order
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const s of list) {
    let clipRect: Box | null = null;
    if (s.layer.clip) {
      const target = states.get(s.layer.clip);
      if (!target) continue;  // what it's confined to isn't on screen
      clipRect = target.rect;
      if (clipRect[2] <= 0.5 || clipRect[3] <= 0.5) continue;
    }
    if (s.rect[2] <= 0 || s.rect[3] <= 0) continue;
    rc.phase = s.phase; rc.shown = s.shown; rc.parts = s.parts;
    if (s.pose.sweep !== null) {
      const sc = scratchOf(W, H);
      if (sc) {
        sc.g.setTransform(1, 0, 0, 1, 0, 0);
        sc.g.clearRect(0, 0, W, H);
        drawLayer(sc.g, s, rc, base, clipRect, false);
        sweepBand(sc.g, s.rect, s.pose.sweep, base);
        g.save();
        const a = (s.layer.opacity ?? 1) * s.pose.alpha;
        if (a < 1) g.globalAlpha = Math.max(0, a);
        const bl = s.layer.blend && BLEND[s.layer.blend];
        if (bl) g.globalCompositeOperation = bl;
        g.drawImage(sc.c as CanvasImageSource, 0, 0);
        g.restore();
      } else drawLayer(g, s, rc, base, clipRect, true);
    } else drawLayer(g, s, rc, base, clipRect, true);
    let [x, y, w, h] = layerBounds(s, rc);
    if (clipRect) { const x1 = Math.min(x + w, clipRect[0] + clipRect[2]), y1 = Math.min(y + h, clipRect[1] + clipRect[3]); x = Math.max(x, clipRect[0]); y = Math.max(y, clipRect[1]); w = x1 - x; h = y1 - y; }
    if (w <= 0 || h <= 0) continue;
    bx0 = Math.min(bx0, x * scale + ox); by0 = Math.min(by0, y * scale + oy);
    bx1 = Math.max(bx1, (x + w) * scale + ox); by1 = Math.max(by1, (y + h) * scale + oy);
  }
  if (!(bx1 > bx0)) return null;
  const x0 = Math.max(0, Math.floor(bx0)), y0 = Math.max(0, Math.floor(by0));
  const x1 = Math.min(W, Math.ceil(bx1)), y1 = Math.min(H, Math.ceil(by1));
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

let watching = false;
/** Fonts the page loads by itself (first use of a face) also count as a late asset. */
function watchFonts(): void {
  if (watching || typeof document === "undefined" || !document.fonts) return;
  watching = true;
  document.fonts.addEventListener("loadingdone", () => bumpAssets());
}

// ── frame keys ───────────────────────────────────────────────────────────────

/** Kinds that change by themselves while shown (crawls, clocks, counters) per layer, asked once per plan. */
const animCache = new WeakMap<Plan, Map<string, boolean>>();
function animatesFn(plan: Plan, dur: number): (l: GfxLayer) => boolean {
  let m = animCache.get(plan);
  if (!m) { m = new Map(); animCache.set(plan, m); }
  const mm = m;
  const value = (id: string) => plan.values[id] ?? null;
  return (l) => {
    let v = mm.get(l.id);
    if (v === undefined) { const k = layerKind(l.kind); v = !!k?.animates?.(l, { value, dur }); mm.set(l.id, v); }
    return v;
  };
}

/**
 * The same key → the same picture. Static between animations (a still graphic is drawn and uploaded once); while
 * anything moves the key is the frame number; clocks add their minute (or second); a late font or picture changes it.
 */
export function graphicFrameKey(input: GfxRenderInput, W: number, H: number, t: number, dur: number): string {
  const d = Math.max(1e-3, dur || 0);
  const tt = Math.max(0, Math.min(d, t));
  const plan = planFor(input, W, H, d);
  const fps = input.fps || 25;
  const moving = movingAt(plan, tt, fps, animatesFn(plan, d));
  let key = `${W}x${H}|${assetEpoch()}|${moving ? `f${Math.round(tt * fps)}` : `s${segmentAt(plan, tt)}`}`;
  const unit = plan.layers.reduce((u, p) => (p.clockUnit && (!u || p.clockUnit < u) ? p.clockUnit : u), 0);
  if (unit && !moving) key += `|c${Math.floor((clockBase(input) + tt * 1000) / unit)}`;
  return key;
}

// ── assets ───────────────────────────────────────────────────────────────────

/** Every string the graphic may draw (for font loading: the right script subsets). */
function sampleText(input: GfxRenderInput): string {
  const out: string[] = ["Aa0123456789:₹%+-"];
  const add = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => (typeof x === "object" && x ? Object.values(x).forEach(add) : add(x)));
  };
  for (const f of input.template.fields) add(f.default);
  Object.values(input.values ?? {}).forEach(add);
  for (const d of Object.values(input.template.designs)) for (const l of d?.layers ?? []) if (typeof l.p.text === "string") out.push(l.p.text.replace(/\{[^}]*\}/g, ""));
  if (input.look.logo?.text) out.push(input.look.logo.text);
  const s = out.join(" ");
  // one of each character is enough
  return [...new Set([...s])].join("").slice(0, 600);
}

/** CSS font strings and image URLs the graphic needs. */
export function graphicAssets(input: GfxRenderInput): { fonts: string[]; images: string[] } {
  const look = input.look;
  const fonts = new Set<string>();
  const sample = sampleText(input);
  const addFont = (name: string, weight?: number) => {
    fonts.add(cssFont(name, look, 48, weight));
    if (sample) fonts.add(cssFont(name, look, 48, weight, sample));
  };
  for (const n of ["@headline", "@body", "@numbers"]) addFont(n);
  for (const s of Object.values(look.fonts.scripts ?? {})) if (s) fonts.add(`${s.weight} 48px "${s.family}"`);
  const fields = fieldsOf(input.template);
  const value = (id: string) => valuesOfInput(input)[id] ?? null;
  const text = (s: string) => fillText(s, valuesOfInput(input), fields, look, clockBase(input));
  const images = new Set<string>(Object.values(input.images ?? {}).filter(Boolean));
  if (look.logo?.image) images.add(look.logo.image);
  for (const d of Object.values(input.template.designs)) {
    for (const l of d?.layers ?? []) {
      const k = layerKind(l.kind);
      if (typeof l.p.font === "string" || typeof l.p.weight === "number") addFont((l.p.font as string) ?? "@body", l.p.weight as number | undefined);
      for (const f of k?.fonts?.({ ...l, p: { ...l.p, ...(input.overrides?.[l.id]?.p ?? {}) } }, { look, value, text }) ?? []) fonts.add(f);
      for (const im of k?.images?.(l, { look, value }) ?? []) { const u = input.images?.[im] ?? (/^(data:|blob:|https?:|\/)/.test(im) ? im : ""); if (u) images.add(u); }
    }
  }
  return { fonts: [...fonts], images: [...images] };
}
const valuesOfInput = (input: GfxRenderInput) => {
  const out: Record<string, GfxValue> = {};
  for (const f of input.template.fields) out[f.id] = f.default;
  return Object.assign(out, input.values ?? {});
};

const loadedFonts = new Set<string>();
/** Loads every font and decodes every image (the export calls it before the first frame; at most ~8 s). */
export async function ensureGraphicAssets(input: GfxRenderInput): Promise<void> {
  if (!input?.template) return;
  const { fonts, images } = graphicAssets(input);
  const sample = sampleText(input);
  const doc = typeof document !== "undefined" ? document : null;
  const jobs: Promise<unknown>[] = [];
  let fresh = false;
  for (const f of fonts) {
    const k = `${f}|${sample}`;
    if (!doc?.fonts || loadedFonts.has(k)) continue;
    fresh = true;
    jobs.push(doc.fonts.load(f, sample).then(() => loadedFonts.add(k)).catch(() => undefined));
  }
  for (const u of images) jobs.push(loadImage(u));
  if (!jobs.length) return;
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 8000))]);
  if (fresh) bumpAssets();
}

export { designSpace };
