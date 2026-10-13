/**
 * Stinger geometry (docs/EDITOR.md §16, nr-wipes): what a "panels" layer draws at a moment, as polygons in the layer's
 * box. Panels travel in from one side (0 = not in yet), cover the frame around the cut (1) and leave (2), with
 * staggers, easing, overshoot and shaped edges (slant, chevron, round, wave, torn paper, brush). The renderer kind,
 * the Wipe Designer's coverage check and the tests all use these functions, so what is checked is exactly what is
 * drawn. Pure: no canvas, no randomness (seeded hashes only).
 */

export type Pt = [number, number];
export type PanelLayout = "stack" | "bars" | "slices" | "split" | "blades" | "flip" | "circles" | "tiles";
export type PanelEdge = "straight" | "slant" | "chevron" | "round" | "wave" | "torn" | "brush";
export type PanelOrder = "forward" | "reverse" | "center" | "edges" | "random";
export type PanelEase = "smooth" | "sharp" | "expo" | "back" | "elastic";
export type PanelExit = "continue" | "back" | "fade";

export const PANEL_LAYOUTS: { value: PanelLayout; label: string }[] = [
  { value: "stack", label: "Stacked panels" }, { value: "bars", label: "Bars" }, { value: "slices", label: "Slices (both ways)" },
  { value: "split", label: "Split doors" }, { value: "blades", label: "Blades" }, { value: "flip", label: "3D flip" },
  { value: "circles", label: "Circles" }, { value: "tiles", label: "Tiles" },
];
export const PANEL_EDGES: { value: PanelEdge; label: string }[] = [
  { value: "straight", label: "Straight" }, { value: "slant", label: "Slant" }, { value: "chevron", label: "Chevron" },
  { value: "round", label: "Round" }, { value: "wave", label: "Wave" }, { value: "torn", label: "Torn paper" }, { value: "brush", label: "Brush" },
];
export const PANEL_ORDERS: { value: PanelOrder; label: string }[] = [
  { value: "forward", label: "In order" }, { value: "reverse", label: "Reverse" }, { value: "center", label: "From the middle" },
  { value: "edges", label: "From the edges" }, { value: "random", label: "Random" },
];
export const PANEL_EASES: { value: PanelEase; label: string }[] = [
  { value: "smooth", label: "Smooth" }, { value: "sharp", label: "Sharp" }, { value: "expo", label: "Fast stop" },
  { value: "back", label: "Overshoot" }, { value: "elastic", label: "Spring" },
];
export const PANEL_EXITS: { value: PanelExit; label: string }[] = [
  { value: "continue", label: "Carry on" }, { value: "back", label: "Go back" }, { value: "fade", label: "Fade" },
];

/** The motion part of a "panels" layer's `p`: what the geometry needs. */
export interface PanelMotion {
  layout: PanelLayout; edge: PanelEdge;
  /** Panels, bars, rings or tile columns. */
  count: number;
  /** Travel direction in degrees (0 = left → right, 90 = top → bottom). */
  angle: number;
  /** Edge shape depth, 0..1 of the panel's width. */
  depth: number;
  order: PanelOrder;
  /** Seconds between panels. */
  stagger: number;
  /** Fraction of the length where the cut sits (the middle of the hold). */
  cut: number;
  /** Seconds fully covered around the cut (at least MIN_HOLD). */
  hold: number;
  ease: PanelEase; overshoot: number; exit: PanelExit;
  seed: number;
  /** Circles / tiles: the centre (fractions of the box). */
  cx: number; cy: number;
}

export const PANEL_MOTION_DEFAULTS: PanelMotion = {
  layout: "stack", edge: "straight", count: 3, angle: 0, depth: 0.3, order: "forward", stagger: 0.06, cut: 0.5, hold: 0.16,
  ease: "smooth", overshoot: 0.4, exit: "continue", seed: 1, cx: 0.5, cy: 0.5,
};

/** Seconds the frame stays fully covered at least: the cut frame and its neighbours at 24 fps and up. */
export const MIN_HOLD = 0.125;
/** Overlap between neighbouring panels and past the frame edge (design px), so no seam ever shows. */
export const PAD = 3;

const num = (v: unknown, d: number, lo: number, hi: number) => { const n = typeof v === "number" && Number.isFinite(v) ? v : d; return n < lo ? lo : n > hi ? hi : n; };
const pick = <T extends string>(v: unknown, list: { value: T }[], d: T): T => (list.some((x) => x.value === v) ? (v as T) : d);

/** Reads (and clamps) the motion fields of a layer's `p`. */
export function motionOf(p: Record<string, unknown>): PanelMotion {
  const d = PANEL_MOTION_DEFAULTS;
  return {
    layout: pick(p.layout, PANEL_LAYOUTS, d.layout), edge: pick(p.edge, PANEL_EDGES, d.edge),
    count: Math.round(num(p.count, d.count, 1, 16)), angle: num(p.angle, d.angle, -360, 360), depth: num(p.depth, d.depth, 0, 1),
    order: pick(p.order, PANEL_ORDERS, d.order), stagger: num(p.stagger, d.stagger, 0, 0.5), cut: num(p.cut, d.cut, 0.1, 0.9),
    hold: Math.max(MIN_HOLD, num(p.hold, d.hold, 0, 3)), ease: pick(p.ease, PANEL_EASES, d.ease), overshoot: num(p.overshoot, d.overshoot, 0, 1),
    exit: pick(p.exit, PANEL_EXITS, d.exit), seed: Math.round(num(p.seed, d.seed, 0, 1e9)), cx: num(p.cx, d.cx, -0.5, 1.5), cy: num(p.cy, d.cy, -0.5, 1.5),
  };
}

// ── hashes and noise ─────────────────────────────────────────────────────────

/** Deterministic 0..1 from integers (no Math.random anywhere). */
export function hash01(a: number, b = 0, c = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35) ^ Math.imul((c | 0) + 0x165667b1, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** Value noise with straight segments (jagged), period `per` cells when given. */
function vnoise(x: number, seed: number, salt: number, per = 0): number {
  const i = Math.floor(x), f = x - i;
  const a = per ? ((i % per) + per) % per : i, b = per ? (((i + 1) % per) + per) % per : i + 1;
  return hash01(a, seed, salt) * (1 - f) + hash01(b, seed, salt) * f;
}
/** Value noise with smooth steps. */
function snoise(x: number, seed: number, salt: number, per = 0): number {
  const i = Math.floor(x), f = x - i, s = f * f * (3 - 2 * f);
  const a = per ? ((i % per) + per) % per : i, b = per ? (((i + 1) % per) + per) % per : i + 1;
  return hash01(a, seed, salt) * (1 - s) + hash01(b, seed, salt) * s;
}

// ── easing ───────────────────────────────────────────────────────────────────

const c01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

/** A CSS-style cubic-bezier(x1, y1, x2, y2) ease: exactly 0 at 0 and 1 at 1 (y may overshoot in between). */
export function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const bx = (t: number) => ((1 - 3 * x2 + 3 * x1) * t + (3 * x2 - 6 * x1)) * t * t + 3 * x1 * t;
  const by = (t: number) => ((1 - 3 * y2 + 3 * y1) * t + (3 * y2 - 6 * y1)) * t * t + 3 * y1 * t;
  const dx = (t: number) => (3 * (1 - 3 * x2 + 3 * x1) * t + 2 * (3 * x2 - 6 * x1)) * t + 3 * x1;
  return (x0) => {
    const x = c01(x0);
    if (x === 0 || x === 1) return x;
    let t = x;
    for (let i = 0; i < 8; i++) { const d = dx(t); if (Math.abs(d) < 1e-6) break; const nt = t - (bx(t) - x) / d; if (nt < 0 || nt > 1) break; t = nt; }
    // a few bisection steps keep it exact where Newton strays
    let lo = 0, hi = 1;
    for (let i = 0; i < 30 && Math.abs(bx(t) - x) > 1e-7; i++) { t = (lo + hi) / 2; if (bx(t) < x) lo = t; else hi = t; }
    return by(t);
  };
}

/**
 * How panels arrive (0 → 1 exactly; back / elastic overshoot by `overshoot`): they speed up from off screen and settle
 * into place, so the sweep is seen crossing the frame.
 */
export function easeIn(kind: PanelEase, overshoot: number): (x: number) => number {
  switch (kind) {
    case "sharp": return bezier(0.7, 0, 0.1, 1);
    case "expo": return bezier(0.85, 0, 0.04, 1);
    case "back": return bezier(0.55, 0, 0.25, 1.15 + 0.75 * overshoot);
    case "elastic": {
      const b = bezier(0.6, 0, 0.25, 1), a = 0.25 + 0.55 * overshoot;
      return (x) => { const t = c01(x); return b(t) + a * Math.sin(5 * Math.PI * t) * t * t * (1 - t); };
    }
    default: return bezier(0.5, 0, 0.12, 1);
  }
}
/** How panels leave (1 → 2): they ease off and accelerate away (never back into the frame first). */
export function easeOut(kind: PanelEase): (x: number) => number {
  switch (kind) {
    case "sharp": return bezier(0.9, 0, 0.3, 1);
    case "expo": return bezier(0.95, 0, 0.15, 1);
    case "back": case "elastic": return bezier(0.7, 0, 0.35, 1);
    default: return bezier(0.88, 0, 0.5, 1);
  }
}
const qmaxCache = new Map<string, number>();
/** The highest value the arrival ease reaches (1 without overshoot). */
export function easePeak(kind: PanelEase, overshoot: number): number {
  const key = `${kind}:${overshoot}`;
  let v = qmaxCache.get(key);
  if (v === undefined) {
    const f = easeIn(kind, overshoot);
    v = 1;
    for (let i = 0; i <= 400; i++) v = Math.max(v, f(i / 400));
    qmaxCache.set(key, v);
  }
  return v;
}

// ── timing ───────────────────────────────────────────────────────────────────

export interface StingerClock {
  T: number;
  /** When the last panel lands (the hold starts) and when the first leaves (the hold ends), seconds. */
  inEnd: number; outStart: number;
  /** The cut (seconds). */
  cut: number;
  /** Stagger spread and each panel's travel time, in and out. */
  stIn: number; stOut: number; mIn: number; mOut: number;
}

/** The clock of a stinger `T` seconds long: the hold sits centred on the cut. */
export function stingerClock(m: PanelMotion, T: number): StingerClock {
  const L = Math.max(0.2, T);
  const cut = m.cut * L;
  const hold = Math.min(Math.max(m.hold, MIN_HOLD), L * 0.7);
  const inEnd = Math.max(0.04, cut - hold / 2), outStart = Math.min(L - 0.04, cut + hold / 2);
  const steps = Math.max(0, m.count - 1);
  const stIn = Math.min(m.stagger * steps, inEnd * 0.6), stOut = Math.min(m.stagger * steps, (L - outStart) * 0.6);
  return { T: L, inEnd, outStart, cut, stIn, stOut, mIn: Math.max(1e-3, inEnd - stIn), mOut: Math.max(1e-3, L - outStart - stOut) };
}

/** A panel's travel at t: 0 → 1 while it arrives (rank 0 first), 1 through the hold, 1 → 2 while it leaves. */
export function travelAt(ck: StingerClock, rankIn: number, rankOut: number, t: number, ein: (x: number) => number, eout: (x: number) => number): number {
  if (t < ck.outStart) return ein((t - rankIn * ck.stIn) / ck.mIn);
  return 1 + eout((t - ck.outStart - rankOut * ck.stOut) / ck.mOut);
}

/** Ranks 0..1 per index (who moves first) for an order. */
export function ranks(n: number, order: PanelOrder, seed: number): number[] {
  if (n <= 1) return [0];
  const mid = (n - 1) / 2;
  const base = Array.from({ length: n }, (_, i) => i / (n - 1));
  switch (order) {
    case "reverse": return base.map((r) => 1 - r);
    case "center": return base.map((_, i) => Math.abs(i - mid) / mid);
    case "edges": return base.map((_, i) => 1 - Math.abs(i - mid) / mid);
    case "random": {
      const idx = base.map((_, i) => i).sort((a, b) => hash01(a, seed, 77) - hash01(b, seed, 77) || a - b);
      const r = new Array<number>(n);
      idx.forEach((i, k) => { r[i] = k / (n - 1); });
      return r;
    }
    default: return base;
  }
}

// ── edges ────────────────────────────────────────────────────────────────────

const EDGE_SEGS: Record<PanelEdge, number> = { straight: 1, slant: 1, chevron: 2, round: 24, wave: 48, torn: 72, brush: 220 };
const EDGE_GAIN: Record<PanelEdge, number> = { straight: 0, slant: 1, chevron: 0.6, round: 0.45, wave: 0.2, torn: 0.16, brush: 0.22 };

/**
 * An edge's offsets along its length (segs + 1 samples, s = 0..1), in px across the travel direction, for an edge
 * `width` px long. `periodic` makes the first and last sample meet (circles).
 */
export function edgeProfile(edge: PanelEdge, width: number, depth: number, seed: number, salt: number, periodic = false): number[] {
  const n = periodic ? Math.max(EDGE_SEGS[edge], 72) : EDGE_SEGS[edge];
  const k = depth * EDGE_GAIN[edge] * Math.min(width, 2200);
  const out = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) {
    const s = j / n;
    let v = 0;
    switch (edge) {
      case "slant": v = periodic ? 0 : k * (s - 0.5); break;
      case "chevron": v = periodic ? k * 0.5 * Math.abs(Math.cos(s * Math.PI * 3)) : k * (0.5 - Math.abs(s - 0.5)); break;
      case "round": v = periodic ? k * 0.3 * Math.cos(s * Math.PI * 4) : k * Math.sqrt(Math.max(0, 1 - (2 * s - 1) ** 2)) - k / 2; break;
      case "wave": { const cyc = periodic ? 7 : 2 + (hash01(seed, salt, 3) > 0.5 ? 1 : 0); v = (k / 2) * Math.sin(2 * Math.PI * s * cyc + (periodic ? 0 : hash01(seed, salt, 5) * 6.283)); break; }
      case "torn": {
        const P = periodic ? 1 : 0;
        v = k * (0.55 * vnoise(s * 9, seed, salt, P * 9) + 0.3 * vnoise(s * 23, seed, salt + 11, P * 23) + 0.15 * vnoise(s * 61, seed, salt + 23, P * 61)) - k / 2;
        break;
      }
      case "brush": {
        const P = periodic ? 1 : 0;
        // a soft body with dry-brush fingers pointing the way it travels
        const body = snoise(s * 2.5, seed, salt, P * 2) * 0.7 + snoise(s * 9, seed, salt + 7, P * 9) * 0.3;
        const finger = Math.pow(vnoise(s * 95, seed, salt + 31, P * 95), 4);
        v = k * (0.6 * body + 0.4 * finger) - k / 2;
        break;
      }
      default: v = 0;
    }
    out[j] = v;
  }
  if (periodic) out[n] = out[0];
  return out;
}

const minOf = (a: number[]) => a.reduce((m, x) => (x < m ? x : m), Infinity);
const maxOf = (a: number[]) => a.reduce((m, x) => (x > m ? x : m), -Infinity);

// ── shapes ───────────────────────────────────────────────────────────────────

export interface PanelShape {
  /** Which colour (an index into the layer's colours, cycling). */
  color: number;
  /** Outline in box px; `holes` are cut out (even-odd). */
  pts: Pt[]; holes?: Pt[][];
  /** The leading / trailing edge lines (for edge lines and shadows). */
  lead?: Pt[]; trail?: Pt[];
  /** 0..1 darkening (3D flips). */
  shade?: number;
  /** 0..1 (fade exits); coverage counts only opaque shapes. */
  alpha: number;
  /** The panel's travel axis in box px: from its trailing edge to its leading edge (gradients). */
  axis?: [Pt, Pt];
  /** 0..1: how far it is through its move (0 or 1 = still); trails draw only while moving. */
  moving: boolean;
}

interface Frame { W: number; H: number; Lu: number; Lv: number; ca: number; sa: number }
function frameOf(W: number, H: number, angle: number): Frame {
  const a = (angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const r = (x: number) => (Math.abs(x) < 1e-9 ? 0 : x);
  return { W, H, ca: r(ca), sa: r(sa), Lu: Math.abs(W * r(ca)) + Math.abs(H * r(sa)), Lv: Math.abs(W * r(sa)) + Math.abs(H * r(ca)) };
}
/** (u along the travel, v across it; origin at the box centre) → box px. */
const toBox = (f: Frame, u: number, v: number): Pt => [f.W / 2 + u * f.ca - v * f.sa, f.H / 2 + u * f.sa + v * f.ca];

/**
 * A panel travelling along +u that must cover u ∈ [a, b] × v ∈ [va, vb] at q = 1, with its leading / trailing edges
 * shaped by `eL` / `eT`. q = 0: wholly before a; q = 2: wholly past b. `peak` = the ease's overshoot (the tail is
 * lengthened so an overshoot never opens a gap behind it).
 */
function lanePanel(q: number, a: number, b: number, va: number, vb: number, eL: number[], eT: number[], peak: number): { lead: [number, number][]; trail: [number, number][]; lu: number; tu: number } {
  const minL = minOf(eL), maxL = maxOf(eL), minT = minOf(eT), maxT = maxOf(eT);
  const D0 = b - a + 2 * PAD + Math.max(maxL - minL, maxT - minT);
  const D = D0 / Math.max(0.35, 2 - peak);
  const ext = (peak - 1) * D;
  const lead = b + PAD - minL + (q - 1) * D;
  const trail = a - PAD - maxT - ext + (q - 1) * D;
  const nl = eL.length - 1, nt = eT.length - 1;
  const L: [number, number][] = eL.map((e, j) => [lead + e, va + ((vb - va) * j) / nl]);
  const Tr: [number, number][] = eT.map((e, j) => [trail + e, va + ((vb - va) * j) / nt]);
  return { lead: L, trail: Tr, lu: lead, tu: trail };
}

/** Circle-ish polygon around (x, y): radius r(θ) per sample (periodic profile). */
function ring(x: number, y: number, radius: (j: number, n: number) => number, n: number): Pt[] {
  const pts: Pt[] = [];
  for (let j = 0; j < n; j++) { const th = (j / n) * Math.PI * 2, r = Math.max(0, radius(j, n)); pts.push([x + Math.cos(th) * r, y + Math.sin(th) * r]); }
  return pts;
}

/** Every shape of a panels layer (box W×H, a clip T seconds long) at t seconds, bottom first. */
export function panelShapes(m: PanelMotion, W: number, H: number, T: number, t: number): PanelShape[] {
  const ck = stingerClock(m, T);
  const ein = easeIn(m.ease, m.overshoot), eout = easeOut(m.ease);
  const peak = easePeak(m.ease, m.overshoot);
  const n = Math.max(1, m.count);
  const out: PanelShape[] = [];
  const f = frameOf(W, H, m.angle);
  const exit: PanelExit = m.layout === "split" ? "back" : m.exit;
  // q: arriving 0 → 1 (an overshoot passes 1 and settles), leaving 1 → 2
  const leaving = t >= ck.outStart;
  const geo = (q: number) => (!leaving ? q : exit === "back" ? 2 - q : exit === "fade" ? 1 : q);
  const alpha = (q: number) => (leaving && exit === "fade" ? c01(2 - q) : 1);
  const gone = (q: number) => (!leaving ? q <= 0 : q >= 2);
  const moving = (q: number) => (!leaving ? q > 0 && Math.abs(q - 1) > 1e-4 : q > 1 + 1e-4 && q < 2);

  const lane = (color: number, q: number, a: number, b: number, va: number, vb: number, eL: number[], eT: number[], mirror: boolean) => {
    if (gone(q)) return;
    const P = lanePanel(geo(q), a, b, va, vb, eL, eT, peak);
    const s = mirror ? -1 : 1;
    const lead = P.lead.map(([u, v]) => toBox(f, s * u, v)), trail = P.trail.map(([u, v]) => toBox(f, s * u, v));
    const vm = (va + vb) / 2;
    out.push({ color, pts: [...lead, ...[...trail].reverse()], lead, trail, alpha: alpha(q), axis: [toBox(f, s * P.tu, vm), toBox(f, s * P.lu, vm)], moving: moving(q) });
  };

  switch (m.layout) {
    case "stack": case "split": {
      const rk = ranks(n, "forward", m.seed);
      const span = f.Lv + 2 * PAD;
      for (let i = 0; i < n; i++) {
        const q = travelAt(ck, rk[i], 1 - rk[i], t, ein, eout);
        const eL = edgeProfile(m.edge, span, m.depth, m.seed, i * 2 + 1);
        const eT = m.edge === "torn" || m.edge === "brush" ? edgeProfile(m.edge, span, m.depth, m.seed, i * 2 + 2) : eL;
        if (m.layout === "stack") lane(i, q, -f.Lu / 2, f.Lu / 2, -span / 2, span / 2, eL, eT, false);
        else {
          lane(i, q, -f.Lu / 2, 0, -span / 2, span / 2, eL, eT, false);
          lane(i, q, -f.Lu / 2, 0, -span / 2, span / 2, eL.map((x) => -x), eT, true);
        }
      }
      break;
    }
    case "bars": case "slices": {
      const rk = ranks(n, m.order, m.seed);
      const w = f.Lv / n;
      for (let i = 0; i < n; i++) {
        const q = travelAt(ck, rk[i], rk[i], t, ein, eout);
        const va = -f.Lv / 2 + i * w - PAD - (i === 0 ? PAD : 0), vb = -f.Lv / 2 + (i + 1) * w + PAD + (i === n - 1 ? PAD : 0);
        const eL = edgeProfile(m.edge, w, m.depth, m.seed, i * 2 + 1);
        const eT = m.edge === "torn" || m.edge === "brush" ? edgeProfile(m.edge, w, m.depth, m.seed, i * 2 + 2) : eL;
        const mirror = m.layout === "slices" && i % 2 === 1;
        lane(i, q, -f.Lu / 2, f.Lu / 2, va, vb, mirror ? eL.map((x) => -x) : eL, mirror ? eT.map((x) => -x) : eT, mirror);
      }
      break;
    }
    case "blades": case "flip": {
      const rk = ranks(n, m.order, m.seed);
      const w = f.Lv / n;
      const ua = f.Lu / 2 + PAD;
      for (let i = 0; i < n; i++) {
        const q = travelAt(ck, rk[i], rk[i], t, ein, eout);
        if (gone(q)) continue;
        const va = -f.Lv / 2 + i * w - PAD - (i === 0 ? PAD : 0), vb = -f.Lv / 2 + (i + 1) * w + PAD + (i === n - 1 ? PAD : 0);
        const c = (va + vb) / 2, hw = (vb - va) / 2;
        let pts: Pt[];
        let shade = 0;
        if (m.layout === "blades") {
          // a blade opens from its centre line, then closes towards its far side (carry on) or its centre (go back)
          let lo: number, hi: number;
          if (!leaving || exit === "fade") { const h = hw * (leaving ? 1 : q); lo = c - h; hi = c + h; }
          else if (exit === "back") { const h = hw * (2 - q); lo = c - h; hi = c + h; }
          else { lo = va + (vb - va) * (q - 1); hi = vb; }
          pts = [toBox(f, -ua, lo), toBox(f, ua, lo), toBox(f, ua, hi), toBox(f, -ua, hi)];
        } else {
          // a card turning about its centre line: edge-on (90°) → flat → on past (carry on) or back
          const th = (1 - geo(q)) * (Math.PI / 2);
          const h = hw * Math.max(0, Math.cos(th));
          const sn = Math.sin(th);
          const near = ua * (1 + 0.1 * Math.abs(sn)), far = ua * (1 - 0.1 * Math.abs(sn));
          const top = sn >= 0 ? far : near, bot = sn >= 0 ? near : far;
          pts = [toBox(f, -top, c - h), toBox(f, top, c - h), toBox(f, bot, c + h), toBox(f, -bot, c + h)];
          shade = Math.min(1, Math.abs(sn)) * 0.65;
        }
        out.push({ color: i, pts, alpha: alpha(q), shade, axis: [toBox(f, 0, c - hw), toBox(f, 0, c + hw)], moving: moving(q) });
      }
      break;
    }
    case "circles": {
      const rk = ranks(n, "forward", m.seed);
      const cx = m.cx * W, cy = m.cy * H;
      const far = Math.max(Math.hypot(cx, cy), Math.hypot(W - cx, cy), Math.hypot(cx, H - cy), Math.hypot(W - cx, H - cy));
      for (let i = 0; i < n; i++) {
        const q = travelAt(ck, rk[i], 1 - rk[i], t, ein, eout);
        if (gone(q)) continue;
        const g = geo(q);
        const e = edgeProfile(m.edge, Math.PI * far, m.depth, m.seed, i * 2 + 1, true);
        const segs = e.length - 1;
        const R = (far + PAD - minOf(e)) / Math.cos(Math.PI / segs) + PAD;
        const pts = ring(cx, cy, (j) => g * (R + e[j]), segs);
        let holes: Pt[][] | undefined;
        if (leaving && exit === "continue") {
          const e2 = edgeProfile(m.edge, Math.PI * far, m.depth, m.seed, i * 2 + 2, true);
          const R2 = (R + maxOf(e) - minOf(e2) + PAD) / Math.cos(Math.PI / segs) + PAD;
          holes = [ring(cx, cy, (j) => (q - 1) * (R2 + e2[j]), segs)];
        }
        out.push({ color: i, pts, holes, lead: [...pts, pts[0]], alpha: alpha(q), axis: [[cx, cy], [cx + R * g, cy]], moving: moving(q) });
      }
      break;
    }
    case "tiles": {
      const cols = Math.max(2, n);
      const c = f.Lu / cols;
      const rows = Math.max(1, Math.ceil(f.Lv / c - 1e-9));
      const midJ = (cols - 1) / 2, midK = (rows - 1) / 2;
      const ox = (m.cx - 0.5) * cols, oy = (m.cy - 0.5) * rows;
      const maxD = Math.hypot(midJ + Math.abs(ox), midK + Math.abs(oy)) || 1;
      const lin = (j: number, k: number) => (j + k * 0.35) / (cols - 1 + (rows - 1) * 0.35);
      const shape = m.edge === "chevron" || m.edge === "slant" ? "diamond" : m.edge === "round" || m.edge === "wave" ? "circle" : "square";
      for (let k = 0; k < rows; k++) {
        for (let j = 0; j < cols; j++) {
          const d = Math.hypot(j - midJ - ox, k - midK - oy) / maxD;
          const r = c01(m.order === "reverse" ? 1 - lin(j, k) : m.order === "center" ? d : m.order === "edges" ? 1 - d : m.order === "random" ? hash01(j, k, m.seed) : lin(j, k));
          const q = travelAt(ck, r, r, t, ein, eout);
          if (gone(q)) continue;
          const s = !leaving ? q : exit === "fade" ? 1 : 2 - q;
          if (s <= 0) continue;
          const u0 = -f.Lu / 2 + c * (j + 0.5), v0 = -(rows * c) / 2 + c * (k + 0.5);
          let pts: Pt[];
          if (shape === "square") { const h = s * (c / 2 + PAD); pts = [toBox(f, u0 - h, v0 - h), toBox(f, u0 + h, v0 - h), toBox(f, u0 + h, v0 + h), toBox(f, u0 - h, v0 + h)]; }
          else if (shape === "diamond") { const h = s * (c + PAD * 2); pts = [toBox(f, u0 - h, v0), toBox(f, u0, v0 - h), toBox(f, u0 + h, v0), toBox(f, u0, v0 + h)]; }
          else { const segs = 24, rr = (s * (c * Math.SQRT1_2 + PAD)) / Math.cos(Math.PI / segs); const [bx, by] = toBox(f, u0, v0); pts = ring(bx, by, () => rr, segs); }
          out.push({ color: j + k, pts, alpha: alpha(q), moving: moving(q) });
        }
      }
      break;
    }
  }
  return out;
}

// ── coverage ─────────────────────────────────────────────────────────────────

/** Even-odd point in polygon. */
export function inPoly(x: number, y: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

type Span = [number, number];
/** The spans of a polygon on the line `c` (rows: y = c, along x; columns: x = c, along y), even-odd. */
function polySpans(pts: Pt[], c: number, cols: boolean): Span[] {
  const xs: number[] = [];
  const a = cols ? 1 : 0, b = cols ? 0 : 1;  // b = the axis the line is fixed on
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const pi = pts[i], pj = pts[j];
    if ((pi[b] > c) !== (pj[b] > c)) xs.push(pi[a] + ((pj[a] - pi[a]) * (c - pi[b])) / (pj[b] - pi[b]));
  }
  xs.sort((p, q) => p - q);
  const out: Span[] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}
function subtract(spans: Span[], cut: Span[]): Span[] {
  let cur = spans;
  for (const [c0, c1] of cut) {
    const next: Span[] = [];
    for (const [s0, s1] of cur) {
      if (c1 <= s0 || c0 >= s1) { next.push([s0, s1]); continue; }
      if (c0 > s0) next.push([s0, c0]);
      if (c1 < s1) next.push([c1, s1]);
    }
    cur = next;
  }
  return cur;
}
/** The parts of [0, L] no span covers. */
function uncovered(spans: Span[], L: number): Span[] {
  const s = spans.filter(([a, b]) => b > 0 && a < L).sort((p, q) => p[0] - q[0]);
  const out: Span[] = [];
  let x = 0;
  for (const [a, b] of s) { if (a > x) out.push([x, a]); if (b > x) x = b; if (x >= L) break; }
  if (x < L) out.push([x, L]);
  return out.filter(([a, b]) => b - a > 1e-6);
}

/** A shape for the coverage check: outline, holes, opacity, and the rectangle it is drawn clipped to (x0, y0, x1, y1). */
export interface CoverShape { pts: Pt[]; holes?: Pt[][]; alpha: number; clip?: [number, number, number, number] }

export interface Coverage {
  /** 0..1 of the frame covered by opaque shapes (measured along every scan line). */
  covered: number;
  /** A few uncovered points (box px), for "why". */
  gaps: Pt[];
  /** Where the gaps are, in words ("the top-left corner"). */
  where: string[];
}

/**
 * How much of a W×H frame the opaque shapes cover: exact along scan lines every `step` px, both across and down (so a
 * seam in either direction is found), plus the frame's edges.
 */
export function coverageOf(shapes: CoverShape[], W: number, H: number, step = 12): Coverage {
  const opaque = shapes.filter((s) => s.alpha >= 0.999 && s.pts.length >= 3).map((s) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of s.pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const k = s.clip;
    if (k) { x0 = Math.max(x0, k[0]); y0 = Math.max(y0, k[1]); x1 = Math.min(x1, k[2]); y1 = Math.min(y1, k[3]); }
    return { s, lo: [x0, y0], hi: [x1, y1] };
  }).filter((o) => o.hi[0] > o.lo[0] && o.hi[1] > o.lo[1]);
  let len = 0, miss = 0;
  const gaps: Pt[] = [];
  const zones = new Set<string>();
  const note = (x: number, y: number) => {
    if (gaps.length < 24) gaps.push([x, y]);
    const h = x < W / 3 ? "left" : x > (2 * W) / 3 ? "right" : "";
    const v = y < H / 3 ? "top" : y > (2 * H) / 3 ? "bottom" : "";
    zones.add(v && h ? `the ${v}-${h} corner` : v || h ? `the ${v || h} edge` : "the middle");
  };
  for (const cols of [false, true]) {
    const L = cols ? H : W, M = cols ? W : H, b = cols ? 0 : 1;
    const lines: number[] = [];
    for (let c = 0.25; c < M; c += step) lines.push(c);
    lines.push(M - 0.25);
    for (const c of lines) {
      const spans: Span[] = [];
      for (const o of opaque) {
        if (c < o.lo[b] || c > o.hi[b]) continue;
        let sp = polySpans(o.s.pts, c, cols);
        for (const h of o.s.holes ?? []) sp = subtract(sp, polySpans(h, c, cols));
        // drawn clipped to the layer's box
        if (o.s.clip) { const a0 = o.s.clip[cols ? 1 : 0], a1 = o.s.clip[cols ? 3 : 2]; sp = sp.map(([p, q]) => [Math.max(p, a0), Math.min(q, a1)] as Span).filter(([p, q]) => q > p); }
        spans.push(...sp);
      }
      len += L;
      for (const [a, z] of uncovered(spans, L)) {
        miss += z - a;
        const m = (a + z) / 2;
        if (cols) note(c, m); else note(m, c);
      }
    }
  }
  return { covered: len ? Math.max(0, 1 - miss / len) : 0, gaps, where: [...zones] };
}
