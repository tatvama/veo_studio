/**
 * Snapping (S): cut points, markers, the playhead and the in / out points within N pixels; beat markers (Marker.kind
 * "beat", from the AI panel's beat detection) and audio transients (onsets found in the media's waveform peaks) as
 * their own kinds. Pure.
 */
import { clipEnd, sourceRate, type Ctx } from "./ops.ts";
import { frameForSpan } from "./remap.ts";
import type { Marker, MediaItem, Sequence } from "./types.ts";

export type SnapKind = "cut" | "marker" | "beat" | "transient" | "playhead" | "in" | "out" | "transition";

/** A beat marker: Marker.kind "beat", or one the beat detection named "Beat" before markers had kinds. */
export const isBeatMarker = (m: Marker) => m.kind === "beat" || /^beat/i.test(m.name);
export interface SnapPoint { frame: number; kind: SnapKind }
export const SNAP_PX = 8;

/** Every place a drag can snap to, without the dragged clips' own edges. */
export function snapPoints(seq: Sequence, opts: { playhead?: number; exclude?: Iterable<string>; tracks?: Iterable<string>; beats?: boolean; transients?: Iterable<number> } = {}): SnapPoint[] {
  const ex = new Set(opts.exclude ?? []);
  const tr = opts.tracks ? new Set(opts.tracks) : null;
  const pts: SnapPoint[] = [{ frame: 0, kind: "cut" }];
  for (const c of seq.clips) {
    if (ex.has(c.id) || (tr && !tr.has(c.trackId))) continue;
    pts.push({ frame: c.start, kind: "cut" }, { frame: clipEnd(c), kind: "cut" });
  }
  for (const m of seq.markers) {
    const beat = isBeatMarker(m);
    if (beat && opts.beats === false) continue;
    pts.push({ frame: m.frame, kind: beat ? "beat" : "marker" });
    if (m.duration > 0) pts.push({ frame: m.frame + m.duration, kind: beat ? "beat" : "marker" });
  }
  if (opts.transients) for (const f of opts.transients) pts.push({ frame: f, kind: "transient" });
  if (opts.playhead !== undefined) pts.push({ frame: opts.playhead, kind: "playhead" });
  if (seq.inPoint !== undefined) pts.push({ frame: seq.inPoint, kind: "in" });
  if (seq.outPoint !== undefined) pts.push({ frame: seq.outPoint + 1, kind: "out" });
  // de-duplicate, keeping the most specific kind (playhead > marker > beat > in/out > cut > transient)
  const rank: Record<SnapKind, number> = { playhead: 6, marker: 5, beat: 4, in: 3, out: 3, transition: 2, cut: 1, transient: 0 };
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

// ── audio transients ─────────────────────────────────────────────────────────

const onsetCache = new WeakMap<ArrayLike<number>, number[]>();

/**
 * Onsets in a waveform envelope (MediaItem.peaks: 0..1 values evenly spread over the media): where the level jumps
 * well above its recent average. Returns positions as fractions 0..1 of the media, at least `minGap` (fraction) apart.
 */
export function onsets(peaks: ArrayLike<number>, opts: { window?: number; threshold?: number; minGap?: number } = {}): number[] {
  const n = peaks.length;
  if (n < 4) return [];
  const w = Math.max(2, opts.window ?? Math.round(n / 200) + 3);
  const th = opts.threshold ?? 0.12;
  const gap = opts.minGap ?? 0.004;
  const out: number[] = [];
  let sum = 0;
  const flux: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const avg = i ? sum / Math.min(i, w) : 0;
    flux[i] = Math.max(0, peaks[i] - avg);
    sum += peaks[i];
    if (i >= w) sum -= peaks[i - w];
  }
  let last = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    const f = flux[i];
    if (f < th || f < flux[i - 1] || f < flux[i + 1]) continue;
    const x = i / n;
    if (x - last < gap) continue;
    out.push(x); last = x;
  }
  return out;
}

/** Timeline frames of the audio transients under the sequence's audio clips (from their media's peaks). */
export function audioTransients(seq: Sequence, ctx: Ctx, opts: { tracks?: Iterable<string>; exclude?: Iterable<string> } = {}): number[] {
  const tr = opts.tracks ? new Set(opts.tracks) : null;
  const ex = new Set(opts.exclude ?? []);
  const out = new Set<number>();
  const audio = new Set(seq.tracks.filter((t) => t.kind === "audio").map((t) => t.id));
  for (const c of seq.clips) {
    if (!audio.has(c.trackId) || ex.has(c.id) || (tr && !tr.has(c.trackId)) || c.source.type !== "media") continue;
    const m: MediaItem | undefined = ctx.media(c.source.mediaId);
    if (!m?.peaks?.length || !(m.duration > 0)) continue;
    let list = onsetCache.get(m.peaks);
    if (!list) { list = onsets(m.peaks); onsetCache.set(m.peaks, list); }
    const r = sourceRate(c, seq, ctx);
    for (const x of list) {
      const src = x * m.duration;
      const rel = c.reverse ? c.source.in + c.duration * r - src : src - c.source.in;
      if (rel < 0) continue;
      const f = Math.round(c.start + frameForSpan(c, rel / r));
      if (f >= c.start && f < clipEnd(c)) out.add(f);
    }
  }
  return [...out].sort((a, b) => a - b);
}
