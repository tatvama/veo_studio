/**
 * Snapping (S): cut points, markers, the playhead and the in / out points within N pixels. Pure.
 */
import { clipEnd } from "./ops.ts";
import type { Sequence } from "./types.ts";

export type SnapKind = "cut" | "marker" | "playhead" | "in" | "out" | "transition";
export interface SnapPoint { frame: number; kind: SnapKind }
export const SNAP_PX = 8;

/** Every place a drag can snap to, without the dragged clips' own edges. */
export function snapPoints(seq: Sequence, opts: { playhead?: number; exclude?: Iterable<string>; tracks?: Iterable<string> } = {}): SnapPoint[] {
  const ex = new Set(opts.exclude ?? []);
  const tr = opts.tracks ? new Set(opts.tracks) : null;
  const pts: SnapPoint[] = [{ frame: 0, kind: "cut" }];
  for (const c of seq.clips) {
    if (ex.has(c.id) || (tr && !tr.has(c.trackId))) continue;
    pts.push({ frame: c.start, kind: "cut" }, { frame: clipEnd(c), kind: "cut" });
  }
  for (const m of seq.markers) {
    pts.push({ frame: m.frame, kind: "marker" });
    if (m.duration > 0) pts.push({ frame: m.frame + m.duration, kind: "marker" });
  }
  if (opts.playhead !== undefined) pts.push({ frame: opts.playhead, kind: "playhead" });
  if (seq.inPoint !== undefined) pts.push({ frame: seq.inPoint, kind: "in" });
  if (seq.outPoint !== undefined) pts.push({ frame: seq.outPoint + 1, kind: "out" });
  // de-duplicate, keeping the most specific kind (playhead > marker > in/out > cut)
  const rank: Record<SnapKind, number> = { playhead: 4, marker: 3, in: 2, out: 2, transition: 1, cut: 0 };
  const by = new Map<number, SnapPoint>();
  for (const p of pts) { const o = by.get(p.frame); if (!o || rank[p.kind] > rank[o.kind]) by.set(p.frame, p); }
  return [...by.values()].sort((a, b) => a.frame - b.frame);
}

/** The nearest point to `frame` within `px` pixels at `pxPerFrame`, or null. Binary search on sorted points. */
export function snapFrame(frame: number, points: SnapPoint[], pxPerFrame: number, px = SNAP_PX): SnapPoint | null {
  if (!points.length || !(pxPerFrame > 0)) return null;
  const lim = px / pxPerFrame;
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid].frame < frame) lo = mid + 1; else hi = mid; }
  let best: SnapPoint | null = null, bd = Infinity;
  for (const i of [lo - 1, lo, lo + 1]) {
    const p = points[i];
    if (!p) continue;
    const d = Math.abs(p.frame - frame);
    if (d <= lim && d < bd) { best = p; bd = d; }
  }
  return best;
}

/**
 * Snaps a dragged block [start, start + length): whichever edge lands closer to a point wins. Returns the corrected
 * start and the point it snapped to (for the snap line).
 */
export function snapBlock(start: number, length: number, points: SnapPoint[], pxPerFrame: number, px = SNAP_PX): { start: number; at: SnapPoint | null } {
  const a = snapFrame(start, points, pxPerFrame, px);
  const b = length > 0 ? snapFrame(start + length, points, pxPerFrame, px) : null;
  const da = a ? Math.abs(a.frame - start) : Infinity, db = b ? Math.abs(b.frame - (start + length)) : Infinity;
  if (a && da <= db) return { start: a.frame, at: a };
  if (b) return { start: b.frame - length, at: b };
  return { start, at: null };
}
