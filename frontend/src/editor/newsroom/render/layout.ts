/**
 * Design space and layout of a graphic (docs/EDITOR.md §16.3), pure: which design a W×H frame uses, a design made
 * automatically for a ratio (or an odd frame) from the nearest one by the layers' pins, overrides, field values,
 * `when`, the collision lift above tickers, every layer's timing, and the frame key's moving / static spans.
 */
import { DESIGN } from "../templates/kit.ts";
import type { Box, ChannelLook, GfxDesign, GfxField, GfxLayer, GfxRatio, GfxTemplate, GfxValue } from "../types.ts";
import { layerTiming, loopMoving, isPartStep, inStep, type LayerTiming } from "./anim.ts";
import type { GfxRenderInput } from "./contract.ts";

/** The nearest ratio for a W×H frame. */
export function ratioOf(W: number, H: number): GfxRatio {
  const a = W / H;
  return a > 1.3 ? "16:9" : a < 0.7 ? "9:16" : a < 0.9 ? "4:5" : "1:1";
}

/** The design a ratio is made from when the template has none for it. */
const SOURCE_ORDER: Record<GfxRatio, GfxRatio[]> = {
  "16:9": ["16:9", "1:1", "4:5", "9:16"], "9:16": ["9:16", "4:5", "1:1", "16:9"],
  "1:1": ["1:1", "16:9", "4:5", "9:16"], "4:5": ["4:5", "9:16", "1:1", "16:9"],
};
export function sourceRatio(t: Pick<GfxTemplate, "designs">, ratio: GfxRatio): GfxRatio | null {
  return SOURCE_ORDER[ratio].find((r) => t.designs[r]?.layers) ?? null;
}

// ── automatic designs by pins ────────────────────────────────────────────────

type Pin = NonNullable<GfxLayer["pin"]>;
const near = (a: Box, b: Box, tol: number) =>
  a[0] < b[0] + b[2] + tol && b[0] < a[0] + a[2] + tol && a[1] < b[1] + b[3] + tol && b[1] < a[1] + a[3] + tol;
const union = (bs: Box[]): Box => {
  const x0 = Math.min(...bs.map((b) => b[0])), y0 = Math.min(...bs.map((b) => b[1]));
  const x1 = Math.max(...bs.map((b) => b[0] + b[2])), y1 = Math.max(...bs.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
};
/** A pin guessed from where a box sits in a sw × sh design. */
export function guessPin(b: Box, sw: number, sh: number): Required<Pin> {
  const cx = (b[0] + b[2] / 2) / sw, cy = (b[1] + b[3] / 2) / sh;
  return {
    x: b[2] >= sw * 0.8 ? "stretch" : cx < 0.45 ? "left" : cx > 0.55 ? "right" : "center",
    y: b[3] >= sh * 0.8 ? "stretch" : cy < 0.4 ? "top" : cy > 0.6 ? "bottom" : "center",
  };
}
function place(a: number, len: number, src: number, dst: number, pin: string): [number, number] {
  switch (pin) {
    case "right": case "bottom": return [dst - (src - a), len];
    case "center": return [((a + len / 2) / src) * dst - len / 2, len];
    case "stretch": return [a, len + (dst - src)];
    default: return [a, len];
  }
}

/**
 * Re-lays a design from sw × sh into vw × vh keeping sizes: layers that touch form groups that move together (a
 * strap's plate, stripe and text), each group pinned by its own `pin`s or where it sits; full-frame layers stretch.
 */
export function relayout(layers: GfxLayer[], sw: number, sh: number, vw: number, vh: number): GfxLayer[] {
  const n = layers.length;
  const full = layers.map((l) => l.box[2] >= sw * 0.9 && l.box[3] >= sh * 0.9);
  const parent = layers.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (full[i] || full[j] || layers[i].pin || layers[j].pin) continue;
    if (near(layers[i].box, layers[j].box, 6)) parent[find(i)] = find(j);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); }
  const out = layers.map((l) => ({ ...l, box: [...l.box] as Box }));
  for (const idx of groups.values()) {
    const ub = union(idx.map((i) => layers[i].box));
    const pin = { ...guessPin(ub, sw, sh), ...(idx.length === 1 ? layers[idx[0]].pin ?? {} : {}) };
    if (idx.length === 1 && full[idx[0]]) { pin.x = "stretch"; pin.y = "stretch"; }
    const [gx, gw] = place(ub[0], ub[2], sw, vw, pin.x);
    const [gy, gh] = place(ub[1], ub[3], sh, vh, pin.y);
    for (const i of idx) {
      const b = layers[i].box;
      const fx = (b[0] - ub[0]) / (ub[2] || 1), fy = (b[1] - ub[1]) / (ub[3] || 1);
      // inside a stretched group: wide members stretch, the rest keep to their side
      let x = gx + (b[0] - ub[0]), w = b[2];
      if (pin.x === "stretch" && gw !== ub[2]) {
        if (b[2] >= ub[2] * 0.6) w = b[2] + (gw - ub[2]);
        else if (fx + b[2] / ub[2] / 2 > 0.5) x = gx + gw - (ub[0] + ub[2] - b[0]);
      }
      let y = gy + (b[1] - ub[1]), h = b[3];
      if (pin.y === "stretch" && gh !== ub[3]) {
        if (b[3] >= ub[3] * 0.6) h = b[3] + (gh - ub[3]);
        else if (fy + b[3] / ub[3] / 2 > 0.5) y = gy + gh - (ub[1] + ub[3] - b[1]);
      }
      out[i].box = [x, y, Math.max(1, w), Math.max(1, h)];
    }
  }
  return out;
}

/** How much smaller sizes get when a design moves to a frame of another shape (√ of the fit, so text stays big). */
export const autoScale = (sw: number, sh: number, tw: number, th: number) => Math.min(1, Math.sqrt(Math.min(tw / sw, th / sh)));

/** Size-like props scaled when a design is rebuilt in another design space (Make vertical). */
const SIZE_KEYS = ["size", "radius", "strokeWidth", "outlineWidth", "tracking", "stripeWidth", "width", "pad", "gap", "borderWidth", "lineWidth", "rowHeight", "itemGap", "skew"];

/** A design for a ratio in that ratio's own design space: its own, else one made from the nearest by pins. */
export function designFor(t: GfxTemplate, ratio: GfxRatio): GfxDesign {
  const own = t.designs[ratio];
  if (own) return own;
  const src = sourceRatio(t, ratio);
  if (!src) return { layers: [] };
  const S = DESIGN[src], T = DESIGN[ratio];
  const k = autoScale(S.w, S.h, T.w, T.h);
  const lay = relayout(t.designs[src]!.layers, S.w, S.h, T.w / k, T.h / k);
  return {
    layers: lay.map((l) => {
      const p = { ...l.p };
      for (const key of SIZE_KEYS) if (typeof p[key] === "number" && key !== "skew") p[key] = (p[key] as number) * k;
      const g = p.grow as { pad?: number; min?: number; max?: number } | undefined;
      if (g && typeof g === "object") p.grow = { ...g, ...(g.pad ? { pad: g.pad * k } : {}), ...(g.min ? { min: g.min * k } : {}), ...(g.max ? { max: g.max * k } : {}) };
      return { ...l, box: l.box.map((v) => v * k) as Box, p };
    }),
  };
}

/** The design to draw in a W×H frame: layers and the design space they're in (an automatic one keeps sizes). */
export function designSpace(t: GfxTemplate, W: number, H: number, ratio?: GfxRatio): { ratio: GfxRatio; layers: GfxLayer[]; w: number; h: number; auto: boolean } {
  const r = ratio ?? ratioOf(W, H);
  const own = t.designs[r];
  const D = DESIGN[r];
  const aspect = W / H;
  if (own && Math.abs(aspect / (D.w / D.h) - 1) < 0.02) return { ratio: r, layers: own.layers, w: D.w, h: D.h, auto: false };
  const src = own ? r : sourceRatio(t, r);
  if (!src) return { ratio: r, layers: [], w: D.w, h: D.h, auto: true };
  const S = DESIGN[src];
  // the frame in standard design px (1080 on the short side), then sizes kept by working in a larger space
  const tw = aspect >= 1 ? 1080 * aspect : 1080, th = aspect >= 1 ? 1080 : 1080 / aspect;
  const k = autoScale(S.w, S.h, tw, th);
  const vw = tw / k, vh = th / k;
  return { ratio: r, layers: relayout(t.designs[src]!.layers, S.w, S.h, vw, vh), w: vw, h: vh, auto: true };
}

// ── values ───────────────────────────────────────────────────────────────────

/** Field values with defaults filled in. */
export function valuesOf(t: GfxTemplate, v: Record<string, GfxValue>): Record<string, GfxValue> {
  const out: Record<string, GfxValue> = {};
  for (const f of t.fields) out[f.id] = f.default;
  for (const [k, x] of Object.entries(v ?? {})) if (x !== undefined) out[k] = x;
  return out;
}

/** True when a value counts as empty (`when`). */
export function isEmpty(v: GfxValue | undefined): boolean {
  if (v === null || v === undefined || v === false || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return !(v as { mediaId?: string }).mediaId;
  if (typeof v === "string") return !v.trim();
  return false;
}

/** A layer's `when`: "{field}" shows it when the field has a value, "!{field}" when it's empty. */
export function shownBy(when: string | undefined, values: Record<string, GfxValue>): boolean {
  if (!when) return true;
  const w = when.trim();
  // "{field}=value" / "{field}!=value": a choice or text compared as text (case-insensitive)
  const cmp = /^\{?([^}=!]+)\}?\s*(!?=)\s*(.*)$/.exec(w);
  if (cmp) {
    const v = values[cmp[1].trim()];
    const same = String(typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : "").trim().toLowerCase() === cmp[3].trim().toLowerCase();
    return cmp[2] === "=" ? same : !same;
  }
  const neg = w.startsWith("!");
  const id = w.replace(/^!/, "").replace(/^\{|\}$/g, "").trim();
  if (!id) return true;
  const empty = isEmpty(values[id]);
  return neg ? empty : !empty;
}

/** Layers with this graphic's overrides merged in (by layer id; `p` merges key by key). */
/** A graphic's own changes by layer id, then the ones for one ratio only ("<layerId>@<ratio>": positions, sizes,
 *  shown in one ratio) when `ratio` is given. */
export function applyOverrides(layers: GfxLayer[], ov?: Record<string, Partial<GfxLayer>>, ratio?: GfxRatio): GfxLayer[] {
  if (!ov || !Object.keys(ov).length) return layers;
  const one = (l: GfxLayer, o?: Partial<GfxLayer>): GfxLayer => (o ? { ...l, ...o, p: { ...l.p, ...(o.p ?? {}) } } : l);
  return layers.map((l) => one(one(l, ov[l.id]), ratio ? ov[`${l.id}@${ratio}`] : undefined));
}

// ── collisions ───────────────────────────────────────────────────────────────

/** Union of the boxes a design draws in (frame fractions), leaving out full-frame layers; null when empty. */
export function contentBox(layers: GfxLayer[], w: number, h: number): [number, number, number, number] | null {
  const bs = layers.filter((l) => !l.hidden && !(l.box[2] >= w * 0.9 && l.box[3] >= h * 0.9)).map((l) => l.box);
  if (!bs.length) return null;
  const u = union(bs);
  return [u[0] / w, u[1] / h, u[2] / w, u[3] / h];
}

/** Roles that keep clear of tickers (they lift above a ticker's or breaking bar's top edge). */
const LIFTS = new Set(["strap", "board"]);
/** Design px a strap / board moves up to stay above the tickers on screen (0 = no clash). */
export function liftFor(role: string, layers: GfxLayer[], w: number, h: number, avoid: GfxRenderInput["avoid"]): number {
  if (!LIFTS.has(role) || !avoid?.length) return 0;
  // full-screen boards are designed around the tickers; lifting them would push their title off the top
  if (layers.some((l) => !l.hidden && l.box[2] >= w * 0.9 && l.box[3] >= h * 0.9)) return 0;
  const cb = contentBox(layers, w, h);
  if (!cb) return 0;
  const gap = 14 / h;
  let lift = 0;
  for (const a of avoid) {
    if (a.role !== "ticker") continue;
    const [ax, ay, aw] = a.box;
    const overlapX = cb[0] < ax + aw && ax < cb[0] + cb[2];
    const bottom = cb[1] + cb[3];
    if (overlapX && bottom > ay - gap && cb[1] < ay + a.box[3]) lift = Math.max(lift, bottom - (ay - gap));
  }
  return lift * h;
}

// ── the plan: everything about a graphic that doesn't need a canvas ─────────

export interface LayerPlan { layer: GfxLayer; timing: LayerTiming; parts: number; clockUnit: 0 | 1000 | 60000 }
export interface Plan {
  ratio: GfxRatio; w: number; h: number;
  layers: LayerPlan[];
  values: Record<string, GfxValue>;
  look: ChannelLook;
  lift: number;
  /** Times where something starts or stops moving (sorted). */
  events: number[];
}

/** Text a layer shows, roughly (for counting parts and clock tokens; the renderer formats it properly). */
function roughText(l: GfxLayer, values: Record<string, GfxValue>): string {
  const s = typeof l.p.text === "string" ? l.p.text : "";
  return s.replace(/\{([^}]+)\}/g, (_, id: string) => { const v = values[id]; return typeof v === "string" || typeof v === "number" ? String(v) : ""; });
}

/**
 * The logo bug follows the look's bug settings: designed in the top right, its layers are mirrored to the look's corner,
 * scaled about that corner and faded by its opacity. Other templates are unchanged.
 */
export function placeBug(t: Pick<GfxTemplate, "role" | "kind">, layers: GfxLayer[], look: Pick<ChannelLook, "bug">, w: number, h: number): GfxLayer[] {
  if (t.role !== "bug" || t.kind !== "logo" || !look.bug) return layers;
  const { corner, scale = 1, opacity = 1 } = look.bug;
  const left = corner === "tl" || corner === "bl", bottom = corner === "bl" || corner === "br";
  if (!left && !bottom && scale === 1 && opacity === 1) return layers;
  return layers.map((l) => {
    let [x, y, bw, bh] = l.box;
    if (left) x = w - x - bw;
    if (bottom) y = h - y - bh;
    const nw = bw * scale, nh = bh * scale;
    // scale about the box's outer corner (the one towards the frame corner)
    const nx = left ? x : x + bw - nw, ny = bottom ? y + bh - nh : y;
    const p = left && l.p.align === "right" ? { ...l.p, align: "left" } : l.p;
    return { ...l, box: [nx, ny, nw, nh] as Box, p, opacity: (l.opacity ?? 1) * opacity };
  });
}

export function planOf(input: GfxRenderInput, W: number, H: number, dur: number, fields?: GfxField[]): Plan {
  void fields;
  const t = input.template;
  const ds = designSpace(t, W, H, input.ratio);
  const values = valuesOf(t, input.values);
  const layers = placeBug(t, applyOverrides(ds.layers, input.overrides, ds.ratio), input.look, ds.w, ds.h).filter((l) => !l.hidden && shownBy(l.when, values));
  const plans: LayerPlan[] = layers.map((layer) => {
    const timing = layerTiming(t, layer, dur);
    const txt = layer.kind === "text" ? roughText(layer, values) : "";
    const st = layer.anim?.in ?? layer.anim?.out;
    const by = st?.by ?? (st?.kind === "typewriter" ? "char" : "word");
    const parts = isPartStep(st) && txt ? (by === "line" ? 6 : by === "char" ? [...txt].length : txt.split(/\s+/).length) : 1;
    const raw = typeof layer.p.text === "string" ? layer.p.text : "";
    const clockUnit = /\{\$time:s\}/.test(raw) ? 1000 : /\{\$(time|date)\}/.test(raw) ? 60000 : 0;
    return { layer, timing, parts, clockUnit };
  });
  const events = new Set<number>([0]);
  for (const p of plans) {
    for (const s of [p.timing.in, p.timing.out]) if (s) { events.add(s.start); events.add(s.start + s.dur * (p.parts > 1 ? 2.5 : 1) + 0.2); }
    if (p.layer.anim?.loop) events.add(p.timing.shownAt + (p.layer.anim.loop.delay ?? 0));
  }
  return {
    ratio: ds.ratio, w: ds.w, h: ds.h, layers: plans, values, look: input.look,
    lift: liftFor(t.role, layers, ds.w, ds.h, input.avoid), events: [...events].sort((a, b) => a - b),
  };
}

/** The extra span of a part step (stagger): its parts start up to this long after the step's own length. */
export function partSpan(p: LayerPlan, which: "in" | "out"): number {
  const s = p.timing[which];
  if (!s || p.parts <= 1 || !isPartStep(s.step)) return 0;
  const st = s.step.stagger ?? Math.min(0.12, Math.max(0.02, (s.dur * 0.5) / (p.parts - 1)));
  return st * (p.parts - 1) + Math.max(0.15, s.dur - st * (p.parts - 1)) - s.dur;
}

/**
 * Whether the picture changes at t: a layer moving in or out, a loop moving, or a kind that animates by itself
 * (`animates(layer)` from the kind registry, passed in).
 */
export function movingAt(plan: Plan, t: number, fps: number, animates: (l: GfxLayer) => boolean): boolean {
  for (const p of plan.layers) {
    const { timing } = p;
    if (t > timing.leaveAt + (timing.out?.dur ?? 0) + partSpan(p, "out") + 1e-6) continue;  // gone
    if (inStep(timing.in && { ...timing.in, dur: timing.in.dur + partSpan(p, "in") }, t)) return true;
    if (inStep(timing.out && { ...timing.out, dur: timing.out.dur + partSpan(p, "out") }, t)) return true;
    if (t >= timing.shownAt && p.layer.anim?.loop && loopMoving(p.layer.anim.loop, t - timing.shownAt, fps)) return true;
    if (t >= (timing.in?.start ?? 0) && animates(p.layer)) return true;
  }
  return false;
}

/** The static span t is in (between two event times). */
export function segmentAt(plan: Plan, t: number): number {
  let i = 0;
  while (i < plan.events.length && plan.events[i] <= t) i++;
  return i;
}
