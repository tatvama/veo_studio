/**
 * Smart guides: while a selection is dragged or resized, its edges and centre snap to the page edges and centre and to
 * other layers' edges and centres, and to equal spacing between neighbours. All values are in design pixels.
 */
import { boundsOf, type Box } from "../doc";
import type { Layer } from "../types";

export interface Line { v: number; from: number; to: number; page?: boolean }
export interface SnapTargets { xs: Line[]; ys: Line[]; boxes: Box[]; page: Box }
export interface Guide { axis: "x" | "y"; pos: number; from: number; to: number }
/** Equal-spacing hint: segments of the same length along an axis, drawn at `at` across. */
export interface GapHint { axis: "x" | "y"; size: number; segments: { a: number; b: number; at: number }[] }
export interface SnapResult { dx: number; dy: number; guides: Guide[]; gaps: GapHint[] }

export function buildTargets(layers: Layer[], exclude: Set<string>, W: number, H: number): SnapTargets {
  const page = { x: 0, y: 0, width: W, height: H };
  const xs: Line[] = [
    { v: 0, from: 0, to: H, page: true }, { v: W / 2, from: 0, to: H, page: true }, { v: W, from: 0, to: H, page: true },
  ];
  const ys: Line[] = [
    { v: 0, from: 0, to: W, page: true }, { v: H / 2, from: 0, to: W, page: true }, { v: H, from: 0, to: W, page: true },
  ];
  const boxes: Box[] = [];
  for (const l of layers) {
    if (exclude.has(l.id) || !l.visible || l.type === "effect") continue;
    const b = boundsOf(l);
    // full-page layers add nothing the page itself doesn't
    if (b.width >= W * 0.98 && b.height >= H * 0.98) continue;
    boxes.push(b);
    for (const v of [b.x, b.x + b.width / 2, b.x + b.width]) xs.push({ v, from: b.y, to: b.y + b.height });
    for (const v of [b.y, b.y + b.height / 2, b.y + b.height]) ys.push({ v, from: b.x, to: b.x + b.width });
  }
  return { xs, ys, boxes, page };
}

/** Nearest target to any of `edges` within `thr`: the offset to apply (or null). */
function nearest(edges: number[], lines: Line[], thr: number): number | null {
  let best: number | null = null;
  for (const e of edges) for (const t of lines) {
    const d = t.v - e;
    if (Math.abs(d) <= thr && (best === null || Math.abs(d) < Math.abs(best))) best = d;
  }
  return best;
}

function guidesFor(axis: "x" | "y", box: Box, lines: Line[]): Guide[] {
  const edges = axis === "x" ? [box.x, box.x + box.width / 2, box.x + box.width] : [box.y, box.y + box.height / 2, box.y + box.height];
  const lo = axis === "x" ? box.y : box.x, hi = axis === "x" ? box.y + box.height : box.x + box.width;
  const out = new Map<number, Guide>();
  for (const e of edges) for (const t of lines) {
    if (Math.abs(t.v - e) > 0.5) continue;
    const key = Math.round(t.v * 2);
    const g = out.get(key);
    const from = Math.min(lo, t.from), to = Math.max(hi, t.to);
    if (g) { g.from = Math.min(g.from, from); g.to = Math.max(g.to, to); } else out.set(key, { axis, pos: t.v, from, to });
  }
  return [...out.values()];
}

/** Equal-gap candidates along one axis: the offset that makes the box's gap match a neighbouring gap. */
function gapSnap(axis: "x" | "y", box: Box, boxes: Box[], thr: number): { d: number; hint: GapHint } | null {
  const P = (b: Box) => (axis === "x" ? b.x : b.y), S = (b: Box) => (axis === "x" ? b.width : b.height);
  const Q = (b: Box) => (axis === "x" ? b.y : b.x), T = (b: Box) => (axis === "x" ? b.height : b.width);
  const overlaps = (b: Box) => Q(b) < Q(box) + T(box) && Q(b) + T(b) > Q(box);
  const row = boxes.filter(overlaps);
  const before = row.filter((b) => P(b) + S(b) <= P(box) + thr).sort((a, b) => P(b) + S(b) - (P(a) + S(a)));
  const after = row.filter((b) => P(b) >= P(box) + S(box) - thr).sort((a, b) => P(a) - P(b));
  const across = (a: Box, b: Box) => {
    const lo = Math.max(Q(a), Q(b)), hi = Math.min(Q(a) + T(a), Q(b) + T(b));
    return lo < hi ? (lo + hi) / 2 : (Q(a) + T(a) / 2 + Q(b) + T(b) / 2) / 2;
  };
  const cands: { d: number; hint: GapHint }[] = [];
  const L = before[0], R = after[0];
  if (L && R) {
    const target = (P(L) + S(L) + P(R) - S(box)) / 2;
    const d = target - P(box);
    const gap = P(R) - (P(L) + S(L) + S(box)) ;
    if (gap / 2 > 0) {
      const moved = { ...box, [axis]: P(box) + d } as Box;
      cands.push({ d, hint: { axis, size: gap / 2, segments: [
        { a: P(L) + S(L), b: P(moved), at: across(L, moved) }, { a: P(moved) + S(moved), b: P(R), at: across(moved, R) }] } });
    }
  }
  if (L && before[1]) {
    const LL = before[1];
    const g0 = P(L) - (P(LL) + S(LL));
    if (g0 > 0) {
      const d = P(L) + S(L) + g0 - P(box);
      const moved = { ...box, [axis]: P(box) + d } as Box;
      cands.push({ d, hint: { axis, size: g0, segments: [
        { a: P(LL) + S(LL), b: P(L), at: across(LL, L) }, { a: P(L) + S(L), b: P(moved), at: across(L, moved) }] } });
    }
  }
  if (R && after[1]) {
    const RR = after[1];
    const g0 = P(RR) - (P(R) + S(R));
    if (g0 > 0) {
      const d = P(R) - g0 - S(box) - P(box);
      const moved = { ...box, [axis]: P(box) + d } as Box;
      cands.push({ d, hint: { axis, size: g0, segments: [
        { a: P(moved) + S(moved), b: P(R), at: across(moved, R) }, { a: P(R) + S(R), b: P(RR), at: across(R, RR) }] } });
    }
  }
  let best: { d: number; hint: GapHint } | null = null;
  for (const c of cands) if (Math.abs(c.d) <= thr && (!best || Math.abs(c.d) < Math.abs(best.d))) best = c;
  return best;
}

/** Snap a moving box. `thr` is the snap distance in design pixels (about 6 screen pixels). */
export function snapMove(box: Box, t: SnapTargets, thr: number, axes: { x: boolean; y: boolean } = { x: true, y: true }): SnapResult {
  let dx = 0, dy = 0;
  const gaps: GapHint[] = [];
  if (axes.x) {
    const e = nearest([box.x, box.x + box.width / 2, box.x + box.width], t.xs, thr);
    const g = gapSnap("x", box, t.boxes, thr);
    if (e !== null && (!g || Math.abs(e) <= Math.abs(g.d))) dx = e;
    else if (g) { dx = g.d; gaps.push(g.hint); }
  }
  if (axes.y) {
    const e = nearest([box.y, box.y + box.height / 2, box.y + box.height], t.ys, thr);
    const g = gapSnap("y", box, t.boxes, thr);
    if (e !== null && (!g || Math.abs(e) <= Math.abs(g.d))) dy = e;
    else if (g) { dy = g.d; gaps.push(g.hint); }
  }
  const moved = { x: box.x + dx, y: box.y + dy, width: box.width, height: box.height };
  const guides = [...(axes.x ? guidesFor("x", moved, t.xs) : []), ...(axes.y ? guidesFor("y", moved, t.ys) : [])];
  return { dx, dy, guides, gaps };
}

/** Snap one coordinate (a resize handle) on one axis. */
export function snapValue(v: number, axis: "x" | "y", t: SnapTargets, thr: number): number {
  const d = nearest([v], axis === "x" ? t.xs : t.ys, thr);
  return d === null ? v : v + d;
}

export function guidesForBox(box: Box, t: SnapTargets, axes: { x: boolean; y: boolean }): Guide[] {
  return [...(axes.x ? guidesFor("x", box, t.xs) : []), ...(axes.y ? guidesFor("y", box, t.ys) : [])];
}
