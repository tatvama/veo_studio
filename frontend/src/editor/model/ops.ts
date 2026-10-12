/**
 * Pure document operations (docs/EDITOR.md §3), Premiere semantics: overwrite by default, insert pushes the
 * targeted and sync-locked tracks, ripple closes gaps, roll / slip / slide / rate stretch respect the media's handles
 * and the neighbours. Every function returns a new Sequence (or EditProject) and never mutates its input; each ends
 * with `normalize`, which keeps clips sorted, drops empty ones and re-resolves and clamps the transitions.
 */
import { baseClip, mediaSpan, newSequence, newTrack } from "./defaults.ts";
import { uid } from "./ids.ts";
import { mapParams, shiftParam, sliceParam, scaleParam, valueAt, withParam } from "./params.ts";
import { convertFrames, fpsExact } from "./time.ts";
import type {
  ClipSource, EditProject, EffectInstance, Marker, MediaItem, Param, Sequence, TimelineClip, Track, Transition,
} from "./types.ts";

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
const R3 = (v: number) => Math.round(v * 1000) / 1000;

// ── lookups ──────────────────────────────────────────────────────────────────

export interface Ctx { media(id: string): MediaItem | undefined; sequence(id: string): Sequence | undefined }

export function ctxOf(p: Pick<EditProject, "media" | "sequences">): Ctx {
  const m = new Map(p.media.map((x) => [x.id, x]));
  const s = new Map(p.sequences.map((x) => [x.id, x]));
  return { media: (id) => m.get(id), sequence: (id) => s.get(id) };
}
export const emptyCtx: Ctx = { media: () => undefined, sequence: () => undefined };

export const clipEnd = (c: { start: number; duration: number }) => c.start + c.duration;
export const byStart = (a: TimelineClip, b: TimelineClip) => a.start - b.start || a.id.localeCompare(b.id);
export const trackById = (seq: Sequence, id: string) => seq.tracks.find((t) => t.id === id);
export const tracksOf = (seq: Sequence, kind: Track["kind"]) => seq.tracks.filter((t) => t.kind === kind).sort((a, b) => a.index - b.index);
export const onTrack = (seq: Sequence, trackId: string) => seq.clips.filter((c) => c.trackId === trackId).sort(byStart);
export const clipById = (seq: Sequence, id: string) => seq.clips.find((c) => c.id === id);
export const seqEnd = (seq: Sequence) => seq.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
export const kindOf = (seq: Sequence, c: TimelineClip) => trackById(seq, c.trackId)?.kind ?? "video";
const isLocked = (seq: Sequence, trackId: string) => !!trackById(seq, trackId)?.locked;

/** The clip on a track covering `frame` (start ≤ frame < end). */
export const clipAt = (seq: Sequence, trackId: string, frame: number) =>
  seq.clips.find((c) => c.trackId === trackId && c.start <= frame && frame < clipEnd(c));

/** Source frames per timeline frame (speed and the media's own rate). */
export function sourceRate(c: TimelineClip, seq: Sequence, ctx: Ctx): number {
  const sp = c.speed > 0 ? c.speed : 1;
  if (c.source.type === "media") {
    const m = ctx.media(c.source.mediaId);
    const f = m && m.fps > 0 ? m.fps : seq.fps;
    return sp * (fpsExact(f) / fpsExact(seq.fps));
  }
  if (c.source.type === "nested") {
    const ns = ctx.sequence(c.source.sequenceId);
    return sp * (ns ? fpsExact(ns.fps) / fpsExact(seq.fps) : 1);
  }
  return sp;
}

/** Unused source before the clip's first frame (head) and after its last (tail), in timeline frames. */
export function handles(c: TimelineClip, seq: Sequence, ctx: Ctx): { head: number; tail: number } {
  let total = Infinity;
  if (c.source.type === "media") {
    const m = ctx.media(c.source.mediaId);
    if (m && m.kind !== "image" && m.duration > 0) total = m.duration;
  } else if (c.source.type === "nested") {
    const ns = ctx.sequence(c.source.sequenceId);
    if (ns) total = seqEnd(ns);
  }
  if (!Number.isFinite(total) || (c.source.type !== "media" && c.source.type !== "nested")) return { head: Infinity, tail: Infinity };
  const r = sourceRate(c, seq, ctx);
  const inF = c.source.in;
  const used = c.duration * r;
  const srcHead = Math.max(0, inF), srcTail = Math.max(0, total - (inF + used));
  const a = Math.floor((c.reverse ? srcTail : srcHead) / r + 1e-6), b = Math.floor((c.reverse ? srcHead : srcTail) / r + 1e-6);
  return { head: Math.max(0, a), tail: Math.max(0, b) };
}

const hasIn = (s: ClipSource): s is Extract<ClipSource, { in: number }> => s.type === "media" || s.type === "nested";

/** Moves the clip's start edge by d (d > 0 shortens it), keeping the source under the rest of the clip in place. */
export function trimStartBy(c: TimelineClip, d: number, r: number): TimelineClip {
  const source = hasIn(c.source) && !c.reverse ? { ...c.source, in: R3(c.source.in + d * r) } : c.source;
  return mapParams({ ...c, start: c.start + d, duration: c.duration - d, source }, (p) => shiftParam(p, -d));
}
/** Moves the clip's end edge by d (d > 0 lengthens it). */
export function trimEndBy(c: TimelineClip, d: number, r: number): TimelineClip {
  const source = hasIn(c.source) && c.reverse ? { ...c.source, in: R3(c.source.in - d * r) } : c.source;
  return { ...c, duration: c.duration + d, source };
}

/** Splits a clip `k` frames after its start into two (the right half gets a new id; keyframes keep their look). */
export function splitClip(c: TimelineClip, k: number, r: number, rightLink?: string): [TimelineClip, TimelineClip] {
  const D = c.duration;
  let lsrc = c.source, rsrc = c.source;
  if (hasIn(c.source)) {
    if (c.reverse) lsrc = { ...c.source, in: R3(c.source.in + (D - k) * r) };
    else rsrc = { ...c.source, in: R3(c.source.in + k * r) };
  }
  let left: TimelineClip = mapParams({ ...c, duration: k, source: lsrc }, (p) => sliceParam(p, 0, k));
  let right: TimelineClip = mapParams({ ...c, id: uid("c"), start: c.start + k, duration: D - k, source: rsrc }, (p) => sliceParam(p, k, D));
  if (c.audio) {
    left = { ...left, audio: { ...left.audio!, fadeOut: 0 } };
    right = { ...right, audio: { ...right.audio!, fadeIn: 0 } };
  }
  if (c.linkId) right = { ...right, linkId: rightLink };
  if (!right.linkId) delete right.linkId;
  return [left, right];
}

// ── normalising ──────────────────────────────────────────────────────────────

/** [first, end) frames a transition covers on its track. */
export function transitionRange(tr: Pick<Transition, "at" | "duration" | "alignment">): [number, number] {
  if (tr.alignment === "start") return [tr.at, tr.at + tr.duration];
  if (tr.alignment === "end") return [tr.at - tr.duration, tr.at];
  const a = tr.at - Math.floor(tr.duration / 2);
  return [a, a + tr.duration];
}

/**
 * The longest a transition can be. At a cut it uses the outgoing clip's tail and the incoming clip's head handles
 * (centre: half each side); when the media has no handles there it falls back to the clips' own lengths, which the
 * engine shows as repeated (frozen) frames. At a clip's edge (a fade from or to nothing) it is the clip's length.
 */
export function maxTransition(seq: Sequence, ctx: Ctx, alignment: Transition["alignment"], from?: TimelineClip, to?: TimelineClip): number {
  if (from && to) {
    const ft = handles(from, seq, ctx).tail, th = handles(to, seq, ctx).head;
    const dl = alignment === "center" ? 2 * Math.min(from.duration, to.duration) : alignment === "start" ? to.duration : from.duration;
    const hl = Math.min(dl, alignment === "center" ? 2 * Math.min(ft, th) : alignment === "start" ? ft : th);
    return hl >= 2 ? hl : dl;
  }
  if (to) return to.duration;
  if (from) return from.duration;
  return 0;
}

/** True when the transition needs more media than the clips have (frames repeat). */
export function transitionRepeats(seq: Sequence, ctx: Ctx, tr: Transition): boolean {
  const from = tr.fromClipId ? clipById(seq, tr.fromClipId) : undefined, to = tr.toClipId ? clipById(seq, tr.toClipId) : undefined;
  if (!from || !to) return false;
  const ft = handles(from, seq, ctx).tail, th = handles(to, seq, ctx).head;
  const need = tr.alignment === "center" ? [Math.ceil(tr.duration / 2), Math.floor(tr.duration / 2)] : tr.alignment === "start" ? [tr.duration, 0] : [0, tr.duration];
  return need[0] > ft || need[1] > th;
}

function fixTransitions(seq: Sequence, ctx: Ctx): Transition[] {
  const byId = new Map(seq.clips.map((c) => [c.id, c]));
  const out: Transition[] = [];
  const seen = new Set<string>();
  for (const tr0 of seq.transitions) {
    if (!trackById(seq, tr0.trackId)) continue;
    let tr = tr0;
    let from = tr.fromClipId ? byId.get(tr.fromClipId) : undefined;
    let to = tr.toClipId ? byId.get(tr.toClipId) : undefined;
    if (from && from.trackId !== tr.trackId) from = undefined;
    if (to && to.trackId !== tr.trackId) to = undefined;
    if (tr.fromClipId && tr.toClipId) {
      if (!from || !to || clipEnd(from) !== to.start) continue;
      tr = { ...tr, at: to.start };
    } else if (tr.toClipId) {
      if (!to) continue;
      tr = { ...tr, at: to.start, alignment: "start" };
    } else if (tr.fromClipId) {
      if (!from) continue;
      tr = { ...tr, at: clipEnd(from), alignment: "end" };
    } else {
      from = seq.clips.find((c) => c.trackId === tr.trackId && clipEnd(c) === tr.at);
      to = seq.clips.find((c) => c.trackId === tr.trackId && c.start === tr.at);
      if (!from && !to) continue;
      tr = { ...tr, fromClipId: from?.id, toClipId: to?.id, alignment: from && to ? tr.alignment : to ? "start" : "end" };
      if (!tr.fromClipId) delete tr.fromClipId;
      if (!tr.toClipId) delete tr.toClipId;
    }
    const max = maxTransition(seq, ctx, tr.alignment, from, to);
    const d = Math.min(Math.round(tr.duration), max);
    if (d < 1) continue;
    const key = `${tr.fromClipId ?? ""}|${tr.toClipId ?? ""}`;
    if (seen.has(key)) { const i = out.findIndex((x) => `${x.fromClipId ?? ""}|${x.toClipId ?? ""}` === key); out.splice(i, 1); }
    seen.add(key);
    out.push(d === tr.duration ? tr : { ...tr, duration: d });
  }
  return out;
}

/** Sorted, whole-frame clips with no empty ones, fades inside their clips, transitions re-resolved and clamped. */
export function normalize(seq: Sequence, ctx: Ctx): Sequence {
  const order = new Map(seq.tracks.map((t) => [t.id, (t.kind === "video" ? 0 : 1000) + t.index]));
  const clips = seq.clips
    .filter((c) => order.has(c.trackId) && c.duration >= 1)
    .map((c) => {
      let x = c;
      if (!Number.isInteger(x.start) || !Number.isInteger(x.duration)) x = { ...x, start: Math.round(x.start), duration: Math.max(1, Math.round(x.duration)) };
      if (x.audio && (x.audio.fadeIn > x.duration || x.audio.fadeOut > x.duration)) {
        x = { ...x, audio: { ...x.audio, fadeIn: Math.min(x.audio.fadeIn, x.duration), fadeOut: Math.min(x.audio.fadeOut, x.duration) } };
      }
      return x;
    })
    .sort((a, b) => (order.get(a.trackId)! - order.get(b.trackId)!) || byStart(a, b));
  const s2 = { ...seq, clips };
  return { ...s2, transitions: fixTransitions(s2, ctx) };
}

// ── range primitives ─────────────────────────────────────────────────────────

/**
 * Overwrite: empties [from, to) on a track. Clips inside go, clips across an edge are trimmed, a clip spanning the
 * whole range is split around it. `links` maps an old link id to the one its right halves share (so the right halves
 * of a split A/V pair stay linked), `except` keeps those clips untouched.
 */
export function clearRange(seq: Sequence, ctx: Ctx, trackId: string, from: number, to: number,
  opts: { links?: Map<string, string>; except?: Set<string> } = {}): Sequence {
  if (to <= from) return seq;
  const links = opts.links ?? new Map<string, string>();
  const out: TimelineClip[] = [];
  const moved = new Map<string, string>();  // original id → right piece id (transitions at its end follow)
  for (const c of seq.clips) {
    if (c.trackId !== trackId || opts.except?.has(c.id)) { out.push(c); continue; }
    const s = c.start, e = clipEnd(c);
    if (e <= from || s >= to) { out.push(c); continue; }
    const r = sourceRate(c, seq, ctx);
    if (s >= from && e <= to) continue;
    if (s < from && e > to) {
      const rl = c.linkId ? links.get(c.linkId) ?? (links.set(c.linkId, uid("l")), links.get(c.linkId)!) : undefined;
      const [left, rest] = splitClip(c, from - s, r, rl);
      const right = trimStartBy(rest, to - from, r);
      out.push(left, right);
      moved.set(c.id, right.id);
    } else if (s < from) out.push(trimEndBy(c, -(e - from), r));
    else out.push(trimStartBy(c, to - s, r));
  }
  const transitions = seq.transitions.map((t) => (t.fromClipId && moved.has(t.fromClipId) ? { ...t, fromClipId: moved.get(t.fromClipId) } : t));
  return { ...seq, clips: out, transitions };
}

/** Splits every clip on the tracks that spans `at` (linked right halves stay linked to each other). */
export function splitAt(seq: Sequence, ctx: Ctx, trackIds: Iterable<string>, at: number, only?: Set<string>): Sequence {
  const set = new Set(trackIds);
  const links = new Map<string, string>();
  const moved = new Map<string, string>();
  const clips: TimelineClip[] = [];
  for (const c of seq.clips) {
    if (!set.has(c.trackId) || (only && !only.has(c.id)) || !(c.start < at && at < clipEnd(c)) || isLocked(seq, c.trackId)) { clips.push(c); continue; }
    const rl = c.linkId ? links.get(c.linkId) ?? (links.set(c.linkId, uid("l")), links.get(c.linkId)!) : undefined;
    const [l, r] = splitClip(c, at - c.start, sourceRate(c, seq, ctx), rl);
    clips.push(l, r);
    moved.set(c.id, r.id);
  }
  const transitions = seq.transitions.map((t) => (t.fromClipId && moved.has(t.fromClipId) ? { ...t, fromClipId: moved.get(t.fromClipId) } : t));
  return { ...seq, clips, transitions };
}

/** Shifts the clips that start at or after `at` on the tracks by `delta`. */
export function shiftAfter(seq: Sequence, trackIds: Iterable<string>, at: number, delta: number): Sequence {
  if (!delta) return seq;
  const set = new Set(trackIds);
  return { ...seq, clips: seq.clips.map((c) => (set.has(c.trackId) && c.start >= at ? { ...c, start: c.start + delta } : c)) };
}

/** Empty frames right before `at` on a track (0 when a clip spans it). */
export function freeBefore(seq: Sequence, trackId: string, at: number, except?: Set<string>): number {
  let lastEnd = 0;
  for (const c of seq.clips) {
    if (c.trackId !== trackId || except?.has(c.id)) continue;
    const e = clipEnd(c);
    if (c.start < at && e > at) return 0;
    if (e <= at && e > lastEnd) lastEnd = e;
  }
  return at - lastEnd;
}

/** Tracks a ripple / insert also moves: unlocked and sync-locked. */
export const syncTracks = (seq: Sequence) => seq.tracks.filter((t) => t.syncLock && !t.locked).map((t) => t.id);

/**
 * Closes (delta < 0) or opens (delta > 0) time at `at` on the tracks. Closing is limited so nothing overlaps on the
 * `limitTracks`; returns the sequence and the delta used.
 */
export function rippleShift(seq: Sequence, trackIds: string[], at: number, delta: number, limitTracks: string[] = trackIds): { seq: Sequence; delta: number } {
  let d = delta;
  if (d < 0) for (const t of limitTracks) d = Math.max(d, -freeBefore(seq, t, at));
  return { seq: shiftAfter(seq, trackIds, at, d), delta: d };
}

// ── targets ──────────────────────────────────────────────────────────────────

/** The targeted (else first) unlocked video and audio tracks. */
export function targetTracks(seq: Sequence): { video?: Track; audio?: Track } {
  const pick = (kind: Track["kind"]) => {
    const ts = tracksOf(seq, kind).filter((t) => !t.locked);
    return ts.find((t) => t.targeted) ?? ts[0];
  };
  return { video: pick("video"), audio: pick("audio") };
}
export const targetedTrackIds = (seq: Sequence) => {
  const ids = seq.tracks.filter((t) => t.targeted && !t.locked).map((t) => t.id);
  return ids.length ? ids : seq.tracks.filter((t) => !t.locked).map((t) => t.id);
};

// ── making clips ─────────────────────────────────────────────────────────────

export interface SourceRange { in?: number; out?: number }

/**
 * The clips a media item puts on the timeline at `at`: a picture clip on the video track and a sound clip on the
 * audio track, linked when both are made. `video` / `audio` false leaves that half out (video-only / audio-only drags).
 */
export function clipsFromMedia(seq: Sequence, m: MediaItem, at: number, opts: {
  videoTrackId?: string; audioTrackId?: string; video?: boolean; audio?: boolean; range?: SourceRange; duration?: number; name?: string;
} = {}): TimelineClip[] {
  const span = mediaSpan(m, seq.fps, opts.range?.in ?? m.inPoint, opts.range?.out ?? m.outPoint);
  const dur = Math.max(1, Math.round(opts.duration ?? span.frames));
  const out: TimelineClip[] = [];
  const name = opts.name ?? m.name;
  const pic = { width: m.width, height: m.height };
  const wantV = (opts.video ?? true) && m.kind !== "audio" && !!opts.videoTrackId;
  const wantA = (opts.audio ?? true) && (m.kind === "audio" || m.hasAudio) && !!opts.audioTrackId;
  const link = wantV && wantA ? uid("l") : undefined;
  if (wantV) {
    const c = baseClip(seq, opts.videoTrackId!, at, dur, { type: "media", mediaId: m.id, in: span.in }, name, pic);
    if (link) c.linkId = link;
    out.push(c);
  }
  if (wantA) {
    const c = baseClip(seq, opts.audioTrackId!, at, dur, { type: "media", mediaId: m.id, in: span.in }, name, pic);
    if (link) c.linkId = link;
    out.push(c);
  }
  return out;
}

/** Puts clips on the timeline: overwrite clears their ranges first; insert opens their length at the earliest start
 *  on the destination and sync-locked tracks. */
export function placeClips(seq: Sequence, ctx: Ctx, clips: TimelineClip[], mode: "overwrite" | "insert"): Sequence {
  const ok = clips.filter((c) => !isLocked(seq, c.trackId));
  if (!ok.length) return seq;
  let s = seq;
  if (mode === "insert") {
    const at = Math.min(...ok.map((c) => c.start));
    const len = Math.max(...ok.map(clipEnd)) - at;
    const tracks = [...new Set([...ok.map((c) => c.trackId), ...syncTracks(seq)])];
    s = splitAt(s, ctx, tracks, at);
    s = shiftAfter(s, tracks, at, len);
  }
  const links = new Map<string, string>();
  for (const c of ok) s = clearRange(s, ctx, c.trackId, c.start, clipEnd(c), { links });
  return normalize({ ...s, clips: [...s.clips, ...ok] }, ctx);
}

/** Insert (",") or overwrite (".") a media item at `at` on the targeted tracks. */
export function editMedia(seq: Sequence, ctx: Ctx, m: MediaItem, at: number, mode: "overwrite" | "insert",
  opts: { video?: boolean; audio?: boolean; range?: SourceRange; videoTrackId?: string; audioTrackId?: string } = {}): Sequence {
  const tg = targetTracks(seq);
  const clips = clipsFromMedia(seq, m, at, { ...opts, videoTrackId: opts.videoTrackId ?? tg.video?.id, audioTrackId: opts.audioTrackId ?? tg.audio?.id });
  return placeClips(seq, ctx, clips, mode);
}

/** A title, colour matte or adjustment clip. */
export function addGenerated(seq: Sequence, ctx: Ctx, trackId: string, start: number, duration: number, source: ClipSource, name: string,
  mode: "overwrite" | "insert" = "overwrite"): { seq: Sequence; clipId: string } {
  const c = baseClip(seq, trackId, start, duration, source, name);
  return { seq: placeClips(seq, ctx, [c], mode), clipId: c.id };
}

// ── selection helpers ────────────────────────────────────────────────────────

/** The ids plus every clip linked to them. */
export function withLinked(seq: Sequence, ids: Iterable<string>): string[] {
  const set = new Set(ids);
  const links = new Set(seq.clips.filter((c) => set.has(c.id) && c.linkId).map((c) => c.linkId!));
  for (const c of seq.clips) if (c.linkId && links.has(c.linkId)) set.add(c.id);
  return [...set];
}

/** Track select forward / backward: clips at or after (before) `frame`, on one track or all. */
export function trackSelect(seq: Sequence, frame: number, dir: 1 | -1, trackId?: string): string[] {
  return seq.clips.filter((c) => (!trackId || c.trackId === trackId) && !isLocked(seq, c.trackId)
    && (dir > 0 ? clipEnd(c) > frame : c.start < frame)).map((c) => c.id);
}

/** Every clip start and end on the tracks (all when omitted), sorted, with 0. */
export function editPoints(seq: Sequence, trackIds?: string[]): number[] {
  const set = trackIds ? new Set(trackIds) : null;
  const pts = new Set<number>([0]);
  for (const c of seq.clips) if (!set || set.has(c.trackId)) { pts.add(c.start); pts.add(clipEnd(c)); }
  return [...pts].sort((a, b) => a - b);
}
export const nextEdit = (seq: Sequence, frame: number, trackIds?: string[]) => editPoints(seq, trackIds).find((p) => p > frame) ?? null;
export const prevEdit = (seq: Sequence, frame: number, trackIds?: string[]) => [...editPoints(seq, trackIds)].reverse().find((p) => p < frame) ?? null;

// ── removing ─────────────────────────────────────────────────────────────────

export function removeClips(seq: Sequence, ctx: Ctx, ids: Iterable<string>): Sequence {
  const set = new Set(ids);
  return normalize({ ...seq, clips: seq.clips.filter((c) => !set.has(c.id) || isLocked(seq, c.trackId)) }, ctx);
}

/**
 * Ripple delete: removes the clips and closes each gap on their tracks and the sync-locked ones, by as much as every
 * one of those tracks has room for (a clip in the way on another track limits it, like Premiere).
 */
export function rippleDelete(seq: Sequence, ctx: Ctx, ids: Iterable<string>): Sequence {
  const set = new Set(ids);
  const victims = seq.clips.filter((c) => set.has(c.id) && !isLocked(seq, c.trackId)).sort((a, b) => b.start - a.start);
  let s = seq;
  // group overlapping victims (linked A/V pairs) so each range ripples once
  const groups: TimelineClip[][] = [];
  for (const c of victims) {
    const g = groups.find((x) => x.some((y) => y.start < clipEnd(c) && c.start < clipEnd(y)));
    if (g) g.push(c); else groups.push([c]);
  }
  groups.sort((a, b) => Math.max(...b.map((c) => c.start)) - Math.max(...a.map((c) => c.start)));
  for (const g of groups) {
    const ids2 = new Set(g.map((c) => c.id));
    s = { ...s, clips: s.clips.filter((c) => !ids2.has(c.id)) };
    const start = Math.min(...g.map((c) => c.start)), end = Math.max(...g.map(clipEnd));
    const own = [...new Set(g.map((c) => c.trackId))];
    const tracks = [...new Set([...own, ...syncTracks(s)])];
    let d = end - start;
    for (const t of tracks) if (!own.includes(t)) d = Math.min(d, freeBefore(s, t, end));
    for (const t of own) d = Math.min(d, freeBefore(s, t, end));
    s = shiftAfter(s, tracks, end, -d);
  }
  return normalize(s, ctx);
}

/** The gap on a track that contains `frame`: [prev clip end, next clip start), or null inside a clip. */
export function gapAt(seq: Sequence, trackId: string, frame: number): [number, number] | null {
  if (clipAt(seq, trackId, frame)) return null;
  const cs = onTrack(seq, trackId);
  const prev = cs.filter((c) => clipEnd(c) <= frame).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  const next = cs.find((c) => c.start > frame);
  if (!next) return null;
  return [prev, next.start];
}

/** Ripple delete of a gap (right-click on empty track space). */
export function rippleDeleteGap(seq: Sequence, ctx: Ctx, trackId: string, frame: number): Sequence {
  const g = gapAt(seq, trackId, frame);
  if (!g) return seq;
  const [a, b] = g;
  const tracks = [...new Set([trackId, ...syncTracks(seq)])];
  let d = b - a;
  for (const t of tracks) if (t !== trackId) d = Math.min(d, freeBefore(seq, t, b));
  return normalize(shiftAfter(seq, tracks, b, -d), ctx);
}

/** In/out range of the sequence ([in, out + 1)), or null when neither is set. */
export function markedRange(seq: Sequence): [number, number] | null {
  if (seq.inPoint === undefined && seq.outPoint === undefined) return null;
  const a = seq.inPoint ?? 0;
  const b = (seq.outPoint ?? Math.max(seqEnd(seq) - 1, a)) + 1;
  return b > a ? [a, b] : null;
}

/** Lift (";"): empties the range on the targeted tracks, leaving a gap. */
export function lift(seq: Sequence, ctx: Ctx, from: number, to: number, trackIds = targetedTrackIds(seq)): Sequence {
  let s = seq;
  const links = new Map<string, string>();
  for (const t of trackIds) if (!isLocked(seq, t)) s = clearRange(s, ctx, t, from, to, { links });
  return normalize(s, ctx);
}

/** Extract ("'"): removes the range from the targeted and sync-locked tracks and closes the gap. */
export function extract(seq: Sequence, ctx: Ctx, from: number, to: number, trackIds = targetedTrackIds(seq)): Sequence {
  const tracks = [...new Set([...trackIds.filter((t) => !isLocked(seq, t)), ...syncTracks(seq)])];
  let s = seq;
  const links = new Map<string, string>();
  for (const t of tracks) s = clearRange(s, ctx, t, from, to, { links });
  return normalize(shiftAfter(s, tracks, to, -(to - from)), ctx);
}

/**
 * Q / W: ripple-trims the previous (Q) or next (W) edit on the targeted tracks to `frame`: the time between them goes
 * and the rest of the sequence closes up.
 */
export function rippleTrimToPlayhead(seq: Sequence, ctx: Ctx, frame: number, side: "prev" | "next"): Sequence {
  const tracks = targetedTrackIds(seq);
  const edit = side === "prev" ? prevEdit(seq, frame + 1, tracks) : nextEdit(seq, frame - 1, tracks);
  if (edit === null || edit === frame) return seq;
  const [a, b] = side === "prev" ? [edit, frame] : [frame, edit];
  if (b <= a) return seq;
  return extract(seq, ctx, a, b, tracks);
}

// ── razor ────────────────────────────────────────────────────────────────────

/** Razor / Add Edit at `frame`: splits the clips on the tracks (or only `ids` and their linked halves). */
export function razor(seq: Sequence, ctx: Ctx, frame: number, opts: { trackIds?: string[]; ids?: string[]; linked?: boolean } = {}): Sequence {
  const only = opts.ids ? new Set(opts.linked === false ? opts.ids : withLinked(seq, opts.ids)) : undefined;
  const tracks = opts.trackIds ?? seq.tracks.map((t) => t.id);
  return normalize(splitAt(seq, ctx, tracks, frame, only), ctx);
}

// ── moving ───────────────────────────────────────────────────────────────────

export interface MoveOpts { mode?: "overwrite" | "insert"; duplicate?: boolean }

/**
 * Moves (or Alt-duplicates) clips by `frames` and by `tracks.video` / `tracks.audio` track steps. Overwrite (the
 * default) replaces what is under them; insert (Ctrl) pushes the destination and sync-locked tracks along. The move
 * is clamped so nothing goes before frame 0 or off the tracks; nothing moves onto a locked track.
 */
export function moveClips(seq: Sequence, ctx: Ctx, ids: Iterable<string>, frames: number, tracks: { video: number; audio: number } = { video: 0, audio: 0 },
  opts: MoveOpts = {}): Sequence {
  const set = new Set(ids);
  const moving = seq.clips.filter((c) => set.has(c.id) && !isLocked(seq, c.trackId));
  if (!moving.length) return seq;
  const vts = tracksOf(seq, "video"), ats = tracksOf(seq, "audio");
  const idx = (c: TimelineClip) => { const t = trackById(seq, c.trackId)!; return { kind: t.kind, i: t.index }; };
  // clamp the track steps and the time shift so every clip lands somewhere
  let dv = tracks.video, da = tracks.audio;
  for (const c of moving) {
    const { kind, i } = idx(c);
    const n = kind === "video" ? vts.length : ats.length;
    if (kind === "video") dv = Math.max(-i, Math.min(n - 1 - i, dv)); else da = Math.max(-i, Math.min(n - 1 - i, da));
  }
  const minStart = Math.min(...moving.map((c) => c.start));
  const df = Math.max(-minStart, Math.round(frames));
  const dest = (c: TimelineClip) => {
    const { kind, i } = idx(c);
    return kind === "video" ? vts[i + dv] : ats[i + da];
  };
  if (moving.some((c) => dest(c)?.locked || !dest(c))) return seq;
  if (!df && !dv && !da && !opts.duplicate) return seq;
  const linkMap = new Map<string, string>();
  const idMap = new Map<string, string>();
  const placed = moving.map((c) => {
    const nc: TimelineClip = { ...c, start: c.start + df, trackId: dest(c)!.id };
    if (opts.duplicate) {
      nc.id = uid("c");
      idMap.set(c.id, nc.id);
      if (c.linkId) nc.linkId = linkMap.get(c.linkId) ?? (linkMap.set(c.linkId, uid("l")), linkMap.get(c.linkId)!);
      nc.effects = c.effects.map((e) => ({ ...e }));
    }
    return nc;
  });
  let s: Sequence = opts.duplicate ? seq : { ...seq, clips: seq.clips.filter((c) => !moving.includes(c)) };
  if (opts.duplicate) {
    const copies = seq.transitions.filter((t) => t.fromClipId && t.toClipId && idMap.has(t.fromClipId) && idMap.has(t.toClipId))
      .map((t) => ({ ...t, id: uid("t"), fromClipId: idMap.get(t.fromClipId!), toClipId: idMap.get(t.toClipId!), trackId: placed.find((p) => p.id === idMap.get(t.toClipId!))!.trackId }));
    s = { ...s, transitions: [...s.transitions, ...copies] };
  } else {
    // transitions between two moved clips follow them to their new track
    const destOf = new Map(placed.map((p) => [p.id, p.trackId]));
    s = { ...s, transitions: s.transitions.map((t) => (t.toClipId && destOf.has(t.toClipId) ? { ...t, trackId: destOf.get(t.toClipId)! } : t.fromClipId && destOf.has(t.fromClipId) ? { ...t, trackId: destOf.get(t.fromClipId)! } : t)) };
  }
  if (opts.mode === "insert") {
    const at = Math.min(...placed.map((c) => c.start));
    const len = Math.max(...placed.map(clipEnd)) - at;
    const ts = [...new Set([...placed.map((c) => c.trackId), ...syncTracks(s)])];
    s = shiftAfter(splitAt(s, ctx, ts, at), ts, at, len);
  } else {
    const links = new Map<string, string>();
    for (const c of placed) s = clearRange(s, ctx, c.trackId, c.start, clipEnd(c), { links });
  }
  return normalize({ ...s, clips: [...s.clips, ...placed] }, ctx);
}

/** Destination track of each clip for a move by `tracks` steps (null when one would leave the tracks or land on a lock). */
function destTracks(seq: Sequence, moving: TimelineClip[], tracks: { video: number; audio: number }): Map<string, Track> | null {
  const vts = tracksOf(seq, "video"), ats = tracksOf(seq, "audio");
  let dv = tracks.video, da = tracks.audio;
  for (const c of moving) {
    const t = trackById(seq, c.trackId)!;
    const n = t.kind === "video" ? vts.length : ats.length;
    if (t.kind === "video") dv = Math.max(-t.index, Math.min(n - 1 - t.index, dv)); else da = Math.max(-t.index, Math.min(n - 1 - t.index, da));
  }
  const out = new Map<string, Track>();
  for (const c of moving) {
    const t = trackById(seq, c.trackId)!;
    const d = t.kind === "video" ? vts[t.index + dv] : ats[t.index + da];
    if (!d || d.locked) return null;
    out.set(c.id, d);
  }
  return out;
}

/** Rearrange (Ctrl+Alt drag): extracts the clips (closing their gap) and inserts them at `frame`. */
export function rearrange(seq: Sequence, ctx: Ctx, ids: Iterable<string>, frame: number, tracks: { video: number; audio: number } = { video: 0, audio: 0 }): Sequence {
  const set = new Set(ids);
  const moving = seq.clips.filter((c) => set.has(c.id) && !isLocked(seq, c.trackId));
  if (!moving.length) return seq;
  const dest = destTracks(seq, moving, tracks);
  if (!dest) return seq;
  const a = Math.min(...moving.map((c) => c.start)), b = Math.max(...moving.map(clipEnd));
  let to = Math.max(0, Math.round(frame));
  if (to >= b) to -= b - a; else if (to > a) to = a;
  const keep = seq.transitions.filter((t) => t.fromClipId && t.toClipId && set.has(t.fromClipId) && set.has(t.toClipId));
  const without = rippleDelete(seq, ctx, moving.map((c) => c.id));
  const placed = moving.map((c) => ({ ...c, start: c.start - a + to, trackId: dest.get(c.id)!.id }));
  const s = placeClips(without, ctx, placed, "insert");
  return normalize({ ...s, transitions: [...s.transitions, ...keep.map((t) => ({ ...t, trackId: placed.find((p) => p.id === t.toClipId)!.trackId }))] }, ctx);
}

/** Swaps two clips of the same kind: each goes to the other's track and start (overwriting what's under it). */
export function swapClips(seq: Sequence, ctx: Ctx, aId: string, bId: string): Sequence {
  const a = clipById(seq, aId), b = clipById(seq, bId);
  if (!a || !b || kindOf(seq, a) !== kindOf(seq, b) || isLocked(seq, a.trackId) || isLocked(seq, b.trackId)) return seq;
  const na = { ...a, trackId: b.trackId, start: b.start }, nb = { ...b, trackId: a.trackId, start: a.start };
  let s: Sequence = { ...seq, clips: seq.clips.filter((c) => c.id !== aId && c.id !== bId) };
  const links = new Map<string, string>();
  s = clearRange(s, ctx, na.trackId, na.start, clipEnd(na), { links });
  s = clearRange(s, ctx, nb.trackId, nb.start, clipEnd(nb), { links });
  return normalize({ ...s, clips: [...s.clips, na, nb] }, ctx);
}

// ── trimming ─────────────────────────────────────────────────────────────────

const neighbours = (seq: Sequence, c: TimelineClip, ignore?: Set<string>) => {
  const cs = seq.clips.filter((x) => x.trackId === c.trackId && x.id !== c.id && !ignore?.has(x.id));
  const prevEnd = cs.filter((x) => clipEnd(x) <= c.start).reduce((m, x) => Math.max(m, clipEnd(x)), 0);
  const nextStart = cs.filter((x) => x.start >= clipEnd(c)).reduce((m, x) => Math.min(m, x.start), Infinity);
  return { prevEnd, nextStart };
};

/** The clip and its linked halves that share the edge. */
function edgeGroup(seq: Sequence, c: TimelineClip, edge: "start" | "end", linked: boolean): TimelineClip[] {
  if (!linked || !c.linkId) return [c];
  return seq.clips.filter((x) => x.id === c.id || (x.linkId === c.linkId && !isLocked(seq, x.trackId)
    && (edge === "start" ? x.start === c.start : clipEnd(x) === clipEnd(c))));
}

/**
 * Selection-tool trim (`ripple` false) or ripple trim (B, `ripple` true) of one edge by `delta` frames (positive =
 * to the right). A plain trim stops at the neighbouring clip; a ripple trim moves everything after the edit on the
 * clip's tracks and the sync-locked tracks instead. Both stop at the media's handles and at a one-frame clip.
 */
export function trimClip(seq: Sequence, ctx: Ctx, id: string, edge: "start" | "end", delta: number, opts: { ripple?: boolean; linked?: boolean } = {}): Sequence {
  const c0 = clipById(seq, id);
  if (!c0 || isLocked(seq, c0.trackId) || !delta) return seq;
  const group = edgeGroup(seq, c0, edge, opts.linked ?? true);
  let d = Math.round(delta);
  const ids = new Set(group.map((c) => c.id));
  for (const c of group) {
    const h = handles(c, seq, ctx);
    const nb = neighbours(seq, c, ids);
    if (edge === "start") {
      d = Math.min(d, c.duration - 1);
      d = Math.max(d, -h.head);
      if (!opts.ripple) d = Math.max(d, nb.prevEnd - c.start);
    } else {
      d = Math.max(d, -(c.duration - 1));
      d = Math.min(d, h.tail);
      if (!opts.ripple) d = Math.min(d, nb.nextStart - clipEnd(c));
    }
  }
  if (!d) return seq;
  if (!opts.ripple) {
    return normalize({ ...seq, clips: seq.clips.map((c) => (ids.has(c.id) ? (edge === "start" ? trimStartBy(c, d, sourceRate(c, seq, ctx)) : trimEndBy(c, d, sourceRate(c, seq, ctx))) : c)) }, ctx);
  }
  // ripple: the clip keeps its start; what comes after its (old) end on its tracks and the sync-locked tracks moves
  // by the change in length. Shrinking is limited by the room the other tracks have.
  const own = [...new Set(group.map((c) => c.trackId))];
  const tracks = [...new Set([...own, ...syncTracks(seq)])];
  const pivot = clipEnd(c0);
  let change = edge === "start" ? -d : d;
  if (change < 0) for (const t of tracks) if (!own.includes(t)) change = Math.max(change, -freeBefore(seq, t, pivot));
  d = edge === "start" ? -change : change;
  if (!d) return seq;
  const pivots = new Map(group.map((c) => [c.trackId, clipEnd(c)]));
  const s: Sequence = { ...seq, clips: seq.clips.map((c) => {
    if (ids.has(c.id)) {
      const r = sourceRate(c, seq, ctx);
      if (edge === "end") return trimEndBy(c, d, r);
      return { ...trimStartBy(c, d, r), start: c.start };
    }
    if (!tracks.includes(c.trackId) || c.start < (pivots.get(c.trackId) ?? pivot)) return c;
    return { ...c, start: c.start + change };
  }) };
  return normalize(s, ctx);
}

/** Rolling edit (N): moves the cut between a clip and the one right after it by `delta`. */
export function rollEdit(seq: Sequence, ctx: Ctx, leftId: string, rightId: string, delta: number, opts: { linked?: boolean } = {}): Sequence {
  const L = clipById(seq, leftId), R = clipById(seq, rightId);
  if (!L || !R || clipEnd(L) !== R.start || L.trackId !== R.trackId || isLocked(seq, L.trackId)) return seq;
  const lefts = edgeGroup(seq, L, "end", opts.linked ?? true);
  const pairs: [TimelineClip, TimelineClip][] = [];
  for (const l of lefts) {
    const r = seq.clips.find((x) => x.trackId === l.trackId && x.start === clipEnd(l));
    if (r) pairs.push([l, r]);
  }
  let d = Math.round(delta);
  for (const [l, r] of pairs) {
    d = Math.min(d, handles(l, seq, ctx).tail, r.duration - 1);
    d = Math.max(d, -handles(r, seq, ctx).head, -(l.duration - 1));
  }
  if (!d) return seq;
  const ls = new Set(pairs.map((p) => p[0].id)), rs = new Set(pairs.map((p) => p[1].id));
  return normalize({ ...seq, clips: seq.clips.map((c) => (ls.has(c.id) ? trimEndBy(c, d, sourceRate(c, seq, ctx)) : rs.has(c.id) ? trimStartBy(c, d, sourceRate(c, seq, ctx)) : c)) }, ctx);
}

/** Slip (Y): shows earlier (negative) or later (positive) source frames in the same place, within the handles. */
export function slipClip(seq: Sequence, ctx: Ctx, id: string, delta: number, opts: { linked?: boolean } = {}): Sequence {
  const c0 = clipById(seq, id);
  if (!c0 || isLocked(seq, c0.trackId) || !hasIn(c0.source)) return seq;
  const group = (opts.linked ?? true) && c0.linkId ? seq.clips.filter((x) => x.linkId === c0.linkId && x.start === c0.start && hasIn(x.source)) : [c0];
  let d = Math.round(delta);
  for (const c of group) {
    const h = handles(c, seq, ctx);
    d = c.reverse ? Math.max(-h.tail, Math.min(h.head, d)) : Math.max(-h.head, Math.min(h.tail, d));
  }
  if (!d) return seq;
  const ids = new Set(group.map((c) => c.id));
  return normalize({ ...seq, clips: seq.clips.map((c) => {
    if (!ids.has(c.id) || !hasIn(c.source)) return c;
    return { ...c, source: { ...c.source, in: R3(c.source.in + d * sourceRate(c, seq, ctx)) } };
  }) }, ctx);
}

/**
 * Slide (U): moves the clip between its neighbours; the one before gets longer (or shorter) at its end and the one
 * after at its start, so the sequence length stays the same. Without a neighbour the gap takes up the change.
 */
export function slideClip(seq: Sequence, ctx: Ctx, id: string, delta: number, opts: { linked?: boolean } = {}): Sequence {
  const c0 = clipById(seq, id);
  if (!c0 || isLocked(seq, c0.trackId)) return seq;
  const group = (opts.linked ?? true) && c0.linkId ? seq.clips.filter((x) => x.linkId === c0.linkId && x.start === c0.start && !isLocked(seq, x.trackId)) : [c0];
  let d = Math.round(delta);
  const plan: { c: TimelineClip; prev?: TimelineClip; next?: TimelineClip }[] = [];
  for (const c of group) {
    const prev = seq.clips.find((x) => x.trackId === c.trackId && clipEnd(x) === c.start);
    const next = seq.clips.find((x) => x.trackId === c.trackId && x.start === clipEnd(c));
    const nb = neighbours(seq, c);
    if (prev) d = Math.max(d, -(prev.duration - 1)); else d = Math.max(d, nb.prevEnd - c.start);
    if (prev) d = Math.min(d, handles(prev, seq, ctx).tail);
    if (next) d = Math.min(d, next.duration - 1); else d = Math.min(d, nb.nextStart - clipEnd(c));
    if (next) d = Math.max(d, -handles(next, seq, ctx).head);
    plan.push({ c, prev, next });
  }
  d = Math.max(d, -Math.min(...group.map((c) => c.start)));
  if (!d) return seq;
  const map = new Map<string, TimelineClip>();
  for (const { c, prev, next } of plan) {
    map.set(c.id, { ...c, start: c.start + d });
    if (prev) map.set(prev.id, trimEndBy(prev, d, sourceRate(prev, seq, ctx)));
    if (next) map.set(next.id, trimStartBy(next, d, sourceRate(next, seq, ctx)));
  }
  return normalize({ ...seq, clips: seq.clips.map((c) => map.get(c.id) ?? c) }, ctx);
}

/**
 * Rate stretch (R): drags an edge to change the clip's length while it keeps the same source frames, so its speed
 * changes (MIN_SPEED..MAX_SPEED). Stops at the neighbours.
 */
export function rateStretch(seq: Sequence, ctx: Ctx, id: string, edge: "start" | "end", delta: number, opts: { linked?: boolean } = {}): Sequence {
  const c0 = clipById(seq, id);
  if (!c0 || isLocked(seq, c0.trackId)) return seq;
  const group = edgeGroup(seq, c0, edge, opts.linked ?? true);
  const ids = new Set(group.map((c) => c.id));
  let d = Math.round(delta);
  for (const c of group) {
    const nb = neighbours(seq, c, ids);
    const span = c.duration * c.speed;
    const minD = Math.ceil(span / MAX_SPEED - 1e-9), maxD = Math.floor(span / MIN_SPEED + 1e-9);
    if (edge === "end") {
      d = Math.min(d, nb.nextStart - clipEnd(c), maxD - c.duration);
      d = Math.max(d, minD - c.duration, 1 - c.duration);
    } else {
      d = Math.max(d, nb.prevEnd - c.start, c.duration - maxD);
      d = Math.min(d, c.duration - minD, c.duration - 1);
    }
  }
  if (!d) return seq;
  return normalize({ ...seq, clips: seq.clips.map((c) => {
    if (!ids.has(c.id)) return c;
    const nd = edge === "end" ? c.duration + d : c.duration - d;
    const speed = R3((c.duration * c.speed) / nd);
    const k = nd / c.duration;
    const x = mapParams({ ...c, duration: nd, speed, start: edge === "end" ? c.start : c.start + d }, (p) => scaleParam(p, k));
    return x;
  }) }, ctx);
}

/** Speed / Duration: sets speed (and reverse); `ripple` moves what follows, otherwise the clip stops at its neighbour. */
export function setSpeed(seq: Sequence, ctx: Ctx, ids: Iterable<string>, speed: number, opts: { reverse?: boolean; ripple?: boolean } = {}): Sequence {
  const sp = Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed));
  let s = seq;
  const list = seq.clips.filter((c) => new Set(ids).has(c.id) && !isLocked(seq, c.trackId)).sort((a, b) => b.start - a.start);
  for (const c0 of list) {
    const c = clipById(s, c0.id)!;
    let nd = Math.max(1, Math.round((c.duration * c.speed) / sp));
    const change = nd - c.duration;
    if (opts.ripple) {
      const tracks = [...new Set([c.trackId, ...syncTracks(s)])];
      s = shiftAfter(s, tracks, clipEnd(c), change);
    } else {
      nd = Math.min(nd, neighbours(s, c).nextStart - c.start);
    }
    const k = nd / c.duration;
    s = { ...s, clips: s.clips.map((x) => (x.id === c.id ? mapParams({ ...x, duration: nd, speed: sp, reverse: opts.reverse ?? x.reverse }, (p) => scaleParam(p, k)) : x)) };
  }
  return normalize(s, ctx);
}

// ── clip properties ──────────────────────────────────────────────────────────

export function updateClips(seq: Sequence, ctx: Ctx, ids: Iterable<string>, fn: (c: TimelineClip) => TimelineClip): Sequence {
  const set = new Set(ids);
  return normalize({ ...seq, clips: seq.clips.map((c) => (set.has(c.id) ? fn(c) : c)) }, ctx);
}

export const setEnabled = (seq: Sequence, ctx: Ctx, ids: string[], on?: boolean) => {
  const all = seq.clips.filter((c) => ids.includes(c.id)).every((c) => c.enabled);
  return updateClips(seq, ctx, ids, (c) => ({ ...c, enabled: on ?? !all }));
};

export function unlink(seq: Sequence, ctx: Ctx, ids: string[]): Sequence {
  return updateClips(seq, ctx, withLinked(seq, ids), (c) => { const x = { ...c }; delete x.linkId; return x; });
}
/** Links (or groups, Ctrl+G) the clips so they select and move together. */
export function link(seq: Sequence, ctx: Ctx, ids: string[]): Sequence {
  if (ids.length < 2) return seq;
  const l = uid("l");
  return updateClips(seq, ctx, ids, (c) => ({ ...c, linkId: l }));
}

/** Updates one animatable parameter of a clip (see params.ts paths). */
export function updateParam(seq: Sequence, ctx: Ctx, clipId: string, path: string, fn: (p: Param<unknown>) => Param<unknown>): Sequence {
  return updateClips(seq, ctx, [clipId], (c) => withParam(c, path, fn));
}

export function addEffect(seq: Sequence, ctx: Ctx, ids: string[], make: () => EffectInstance): Sequence {
  return updateClips(seq, ctx, ids, (c) => ({ ...c, effects: [...c.effects, make()] }));
}
export function removeEffect(seq: Sequence, ctx: Ctx, clipId: string, effectId: string): Sequence {
  return updateClips(seq, ctx, [clipId], (c) => ({ ...c, effects: c.effects.filter((e) => e.id !== effectId) }));
}
export function moveEffect(seq: Sequence, ctx: Ctx, clipId: string, effectId: string, dir: -1 | 1): Sequence {
  return updateClips(seq, ctx, [clipId], (c) => {
    const i = c.effects.findIndex((e) => e.id === effectId), j = i + dir;
    if (i < 0 || j < 0 || j >= c.effects.length) return c;
    const fx = [...c.effects];
    [fx[i], fx[j]] = [fx[j], fx[i]];
    return { ...c, effects: fx };
  });
}
export function updateEffect(seq: Sequence, ctx: Ctx, clipId: string, effectId: string, fn: (e: EffectInstance) => EffectInstance): Sequence {
  return updateClips(seq, ctx, [clipId], (c) => ({ ...c, effects: c.effects.map((e) => (e.id === effectId ? fn(e) : e)) }));
}

/** Paste Attributes (Ctrl+Alt+V): motion, opacity, effects and audio levels of `from` onto the clips. */
export function pasteAttributes(seq: Sequence, ctx: Ctx, from: TimelineClip, ids: string[],
  what: { motion?: boolean; opacity?: boolean; effects?: boolean; audio?: boolean } = { motion: true, opacity: true, effects: true, audio: true }): Sequence {
  return updateClips(seq, ctx, ids, (c) => {
    let x = c;
    if (what.motion) x = { ...x, motion: { ...x.motion, position: from.motion.position, scale: from.motion.scale, rotation: from.motion.rotation, anchor: from.motion.anchor, uniformScale: from.motion.uniformScale } };
    if (what.opacity) x = { ...x, motion: { ...x.motion, opacity: from.motion.opacity, blend: from.motion.blend } };
    if (what.effects) x = { ...x, effects: [...x.effects, ...from.effects.map((e) => ({ ...e, id: uid("e") }))] };
    if (what.audio && from.audio && x.audio) x = { ...x, audio: { ...from.audio } };
    return x;
  });
}

// ── tracks ───────────────────────────────────────────────────────────────────

const reindex = (tracks: Track[]): Track[] => {
  const out: Track[] = [];
  for (const kind of ["video", "audio"] as const) {
    tracks.filter((t) => t.kind === kind).sort((a, b) => a.index - b.index).forEach((t, i) => {
      const auto = new RegExp(`^${kind === "video" ? "V" : "A"}\\d+$`).test(t.name);
      out.push({ ...t, index: i, name: auto ? `${kind === "video" ? "V" : "A"}${i + 1}` : t.name });
    });
  }
  return out;
};

/** Adds a track of `kind` at `index` (default: on top of its kind). */
export function addTrack(seq: Sequence, kind: Track["kind"], index?: number): { seq: Sequence; trackId: string } {
  const n = tracksOf(seq, kind).length;
  const at = Math.max(0, Math.min(n, index ?? n));
  const t = newTrack(kind, at, { targeted: false });
  const shifted = seq.tracks.map((x) => (x.kind === kind && x.index >= at ? { ...x, index: x.index + 1 } : x));
  return { seq: { ...seq, tracks: reindex([...shifted, { ...t, index: at }]) }, trackId: t.id };
}

/** Deletes a track and its clips (the last video or audio track stays). */
export function removeTrack(seq: Sequence, ctx: Ctx, trackId: string): Sequence {
  const t = trackById(seq, trackId);
  if (!t || tracksOf(seq, t.kind).length <= 1) return seq;
  return normalize({ ...seq, tracks: reindex(seq.tracks.filter((x) => x.id !== trackId)), clips: seq.clips.filter((c) => c.trackId !== trackId) }, ctx);
}

export function updateTrack(seq: Sequence, trackId: string, patch: Partial<Omit<Track, "id" | "kind" | "index">>): Sequence {
  return { ...seq, tracks: seq.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) };
}

export function toggleSolo(seq: Sequence, trackId: string): Sequence {
  return { ...seq, tracks: seq.tracks.map((t) => (t.id === trackId ? { ...t, solo: !t.solo } : t)) };
}

// ── markers and in / out ─────────────────────────────────────────────────────

export function addMarker(list: Marker[], frame: number, patch: Partial<Marker> = {}): Marker[] {
  const f = Math.max(0, Math.round(frame));
  if (list.some((m) => m.frame === f && !patch.name)) return list;
  return [...list, { id: uid("m"), frame: f, duration: 0, name: "", color: "#22d3ee", ...patch }].sort((a, b) => a.frame - b.frame);
}
export const updateMarker = (list: Marker[], id: string, patch: Partial<Marker>) => list.map((m) => (m.id === id ? { ...m, ...patch } : m)).sort((a, b) => a.frame - b.frame);
export const removeMarker = (list: Marker[], id: string) => list.filter((m) => m.id !== id);
export const nextMarker = (list: Marker[], frame: number) => list.find((m) => m.frame > frame) ?? null;
export const prevMarker = (list: Marker[], frame: number) => [...list].reverse().find((m) => m.frame < frame) ?? null;

export function setInOut(seq: Sequence, patch: { inPoint?: number | null; outPoint?: number | null }): Sequence {
  const s = { ...seq };
  if (patch.inPoint !== undefined) { if (patch.inPoint === null) delete s.inPoint; else s.inPoint = Math.max(0, Math.round(patch.inPoint)); }
  if (patch.outPoint !== undefined) { if (patch.outPoint === null) delete s.outPoint; else s.outPoint = Math.max(0, Math.round(patch.outPoint)); }
  if (s.inPoint !== undefined && s.outPoint !== undefined && s.outPoint < s.inPoint) {
    if (patch.inPoint !== undefined && patch.inPoint !== null) delete s.outPoint; else delete s.inPoint;
  }
  return s;
}

/** Mark Clip (X): in / out around the clip under `frame` on the targeted tracks (top video first). */
export function markClip(seq: Sequence, frame: number, ids?: string[]): Sequence {
  let c: TimelineClip | undefined;
  if (ids?.length) {
    const cs = seq.clips.filter((x) => ids.includes(x.id));
    if (cs.length) return setInOut(seq, { inPoint: Math.min(...cs.map((x) => x.start)), outPoint: Math.max(...cs.map(clipEnd)) - 1 });
  }
  const ts = targetedTrackIds(seq).map((id) => trackById(seq, id)!).sort((a, b) => (a.kind === b.kind ? (a.kind === "video" ? b.index - a.index : a.index - b.index) : a.kind === "video" ? -1 : 1));
  for (const t of ts) { c = clipAt(seq, t.id, frame); if (c) break; }
  if (!c) return seq;
  return setInOut(seq, { inPoint: c.start, outPoint: clipEnd(c) - 1 });
}

// ── transitions ──────────────────────────────────────────────────────────────

export const AUDIO_TRANSITIONS = [
  { id: "audio:constant_power", label: "Constant power" },
  { id: "audio:constant_gain", label: "Constant gain" },
] as const;
export const isAudioTransition = (type: string) => type.startsWith("audio:");

/** Adds (or replaces) a transition at the cut / clip edge at `at` on a track, clamped to what the clips allow. */
export function addTransition(seq: Sequence, ctx: Ctx, trackId: string, at: number, type: string, duration: number,
  opts: { alignment?: Transition["alignment"]; side?: "from" | "to"; params?: Record<string, unknown> } = {}): { seq: Sequence; id: string | null } {
  if (isLocked(seq, trackId)) return { seq, id: null };
  let from = seq.clips.find((c) => c.trackId === trackId && clipEnd(c) === at);
  let to = seq.clips.find((c) => c.trackId === trackId && c.start === at);
  if (from && to) { /* a cut */ } else if (opts.side === "from") to = undefined; else if (opts.side === "to") from = undefined;
  if (!from && !to) return { seq, id: null };
  const alignment = from && to ? opts.alignment ?? "center" : to ? "start" : "end";
  const max = maxTransition(seq, ctx, alignment, from, to);
  const d = Math.max(1, Math.min(Math.round(duration), max));
  if (max < 1) return { seq, id: null };
  const tr: Transition = { id: uid("t"), trackId, at, duration: d, alignment, type, easing: "linear" };
  if (from) tr.fromClipId = from.id;
  if (to) tr.toClipId = to.id;
  if (opts.params) tr.params = opts.params;
  const others = seq.transitions.filter((t) => !(t.trackId === trackId && (t.fromClipId ?? "") === (tr.fromClipId ?? "") && (t.toClipId ?? "") === (tr.toClipId ?? "")));
  return { seq: normalize({ ...seq, transitions: [...others, tr] }, ctx), id: tr.id };
}

export function updateTransition(seq: Sequence, ctx: Ctx, id: string, patch: Partial<Omit<Transition, "id" | "trackId">>): Sequence {
  return normalize({ ...seq, transitions: seq.transitions.map((t) => (t.id === id ? { ...t, ...patch, duration: Math.max(1, Math.round(patch.duration ?? t.duration)) } : t)) }, ctx);
}
export const removeTransitions = (seq: Sequence, ids: Iterable<string>): Sequence => {
  const set = new Set(ids);
  return { ...seq, transitions: seq.transitions.filter((t) => !set.has(t.id)) };
};

/**
 * Ctrl+D / Ctrl+Shift+D: the default transition on both edges of the selected clips of that kind, or at the edit
 * point nearest `frame` on the targeted tracks of that kind.
 */
export function applyDefaultTransition(seq: Sequence, ctx: Ctx, kind: Track["kind"], type: string, duration: number, frame: number, ids: string[] = []): Sequence {
  let s = seq;
  const sel = seq.clips.filter((c) => ids.includes(c.id) && kindOf(seq, c) === kind);
  if (sel.length) {
    for (const c of sel) {
      s = addTransition(s, ctx, c.trackId, c.start, type, duration, { side: "to" }).seq;
      s = addTransition(s, ctx, c.trackId, clipEnd(c), type, duration, { side: "from" }).seq;
    }
    return s;
  }
  for (const id of targetedTrackIds(seq)) {
    const t = trackById(seq, id)!;
    if (t.kind !== kind) continue;
    const pts = editPoints(seq, [id]).filter((p) => p > 0);
    if (!pts.length) continue;
    const at = pts.reduce((b, p) => (Math.abs(p - frame) < Math.abs(b - frame) ? p : b), pts[0]);
    s = addTransition(s, ctx, id, at, type, duration).seq;
  }
  return s;
}

// ── copy / paste ─────────────────────────────────────────────────────────────

export interface Clipboard { clips: (TimelineClip & { kind: Track["kind"]; trackIndex: number })[]; transitions: Transition[]; span: number }

export function copyClips(seq: Sequence, ids: string[]): Clipboard | null {
  const cs = seq.clips.filter((c) => ids.includes(c.id));
  if (!cs.length) return null;
  const a = Math.min(...cs.map((c) => c.start)), b = Math.max(...cs.map(clipEnd));
  const set = new Set(cs.map((c) => c.id));
  return {
    clips: cs.map((c) => { const t = trackById(seq, c.trackId)!; return { ...c, start: c.start - a, kind: t.kind, trackIndex: t.index }; }),
    transitions: seq.transitions.filter((t) => (!t.fromClipId || set.has(t.fromClipId)) && (!t.toClipId || set.has(t.toClipId))),
    span: b - a,
  };
}

/**
 * Paste (Ctrl+V overwrite, Ctrl+Shift+V insert) at `frame`: the lowest copied track of each kind lands on the targeted
 * track of that kind and the others keep their distance above it (tracks are added when needed).
 */
export function pasteClips(seq: Sequence, ctx: Ctx, cb: Clipboard, frame: number, mode: "overwrite" | "insert"): { seq: Sequence; ids: string[] } {
  let s = seq;
  const tg = targetTracks(s);
  const base = { video: tg.video?.index ?? 0, audio: tg.audio?.index ?? 0 };
  const minI = {
    video: Math.min(...cb.clips.filter((c) => c.kind === "video").map((c) => c.trackIndex), Infinity),
    audio: Math.min(...cb.clips.filter((c) => c.kind === "audio").map((c) => c.trackIndex), Infinity),
  };
  const idMap = new Map<string, string>(), linkMap = new Map<string, string>();
  const placed: TimelineClip[] = [];
  for (const c of cb.clips) {
    const want = base[c.kind] + (c.trackIndex - minI[c.kind]);
    while (tracksOf(s, c.kind).length <= want) s = addTrack(s, c.kind).seq;
    const track = tracksOf(s, c.kind)[want];
    const { kind: _k, trackIndex: _i, ...clip } = c;
    const nc: TimelineClip = { ...clip, id: uid("c"), trackId: track.id, start: frame + c.start, effects: c.effects.map((e) => ({ ...e, id: uid("e") })) };
    if (c.linkId) nc.linkId = linkMap.get(c.linkId) ?? (linkMap.set(c.linkId, uid("l")), linkMap.get(c.linkId)!);
    idMap.set(c.id, nc.id);
    placed.push(nc);
  }
  s = placeClips(s, ctx, placed, mode);
  const trs = cb.transitions.map((t) => {
    const to = t.toClipId ? placed.find((p) => p.id === idMap.get(t.toClipId!)) : undefined;
    const from = t.fromClipId ? placed.find((p) => p.id === idMap.get(t.fromClipId!)) : undefined;
    const tr: Transition = { ...t, id: uid("t"), trackId: (to ?? from)!.trackId };
    if (t.fromClipId) tr.fromClipId = idMap.get(t.fromClipId); else delete tr.fromClipId;
    if (t.toClipId) tr.toClipId = idMap.get(t.toClipId); else delete tr.toClipId;
    return tr;
  });
  s = normalize({ ...s, transitions: [...s.transitions, ...trs] }, ctx);
  return { seq: s, ids: placed.map((p) => p.id) };
}

// ── project level ────────────────────────────────────────────────────────────

export function updateSequence(p: EditProject, seqId: string, fn: (s: Sequence, ctx: Ctx) => Sequence): EditProject {
  const ctx = ctxOf(p);
  let changed = false;
  const sequences = p.sequences.map((s) => {
    if (s.id !== seqId) return s;
    const n = fn(s, ctx);
    if (n !== s) changed = true;
    return n;
  });
  return changed ? { ...p, sequences } : p;
}
export const activeSequence = (p: EditProject) => p.sequences.find((s) => s.id === p.activeSequenceId) ?? p.sequences[0];
export const updateMedia = (p: EditProject, id: string, fn: (m: MediaItem) => MediaItem): EditProject =>
  ({ ...p, media: p.media.map((m) => (m.id === id ? fn(m) : m)) });

/** Nest (Ctrl+Shift+N): the clips move into a new sequence, replaced by one nested clip (plus a linked audio one). */
export function nestClips(p: EditProject, seqId: string, ids: string[], name = "Nested Sequence"): { project: EditProject; sequenceId: string | null } {
  const seq = p.sequences.find((s) => s.id === seqId);
  if (!seq) return { project: p, sequenceId: null };
  const ctx = ctxOf(p);
  const chosen = seq.clips.filter((c) => ids.includes(c.id) && !isLocked(seq, c.trackId));
  if (!chosen.length) return { project: p, sequenceId: null };
  const a = Math.min(...chosen.map((c) => c.start)), b = Math.max(...chosen.map(clipEnd));
  const vts = tracksOf(seq, "video"), ats = tracksOf(seq, "audio");
  const ns = newSequence(name, seq, { video: vts.length, audio: ats.length });
  const nv = tracksOf(ns, "video"), na = tracksOf(ns, "audio");
  const mapT = new Map<string, string>([...vts.map((t, i) => [t.id, nv[i].id] as const), ...ats.map((t, i) => [t.id, na[i].id] as const)]);
  const set = new Set(chosen.map((c) => c.id));
  ns.clips = chosen.map((c) => ({ ...c, start: c.start - a, trackId: mapT.get(c.trackId)! }));
  ns.transitions = seq.transitions.filter((t) => (!t.fromClipId || set.has(t.fromClipId)) && (!t.toClipId || set.has(t.toClipId)) && (t.fromClipId || t.toClipId))
    .map((t) => ({ ...t, trackId: mapT.get(t.trackId)!, at: t.at - a }));
  const nested = normalize(ns, ctx);
  let s: Sequence = { ...seq, clips: seq.clips.filter((c) => !set.has(c.id)) };
  const vChosen = chosen.filter((c) => kindOf(seq, c) === "video"), aChosen = chosen.filter((c) => kindOf(seq, c) === "audio");
  const lid = vChosen.length && aChosen.length ? uid("l") : undefined;
  const made: TimelineClip[] = [];
  const pick = (cs: TimelineClip[]) => cs.map((c) => trackById(seq, c.trackId)!).sort((x, y) => x.index - y.index)[0];
  if (vChosen.length) {
    const c = baseClip(seq, pick(vChosen).id, a, b - a, { type: "nested", sequenceId: nested.id, in: 0 }, name, { width: nested.width, height: nested.height });
    if (lid) c.linkId = lid;
    made.push(c);
  }
  if (aChosen.length) {
    const c = baseClip(seq, pick(aChosen).id, a, b - a, { type: "nested", sequenceId: nested.id, in: 0 }, name, { width: nested.width, height: nested.height });
    if (lid) c.linkId = lid;
    made.push(c);
  }
  const p2 = { ...p, sequences: [...p.sequences, nested] };
  s = placeClips(s, ctxOf(p2), made, "overwrite");
  return { project: { ...p2, sequences: p2.sequences.map((x) => (x.id === seqId ? s : x)) }, sequenceId: nested.id };
}

/** A new sequence that matches a clip's size and rate, with the clip on it (Project → New Sequence From Clip). */
export function sequenceFromMedia(p: EditProject, m: MediaItem): { project: EditProject; sequenceId: string } {
  const fps = m.fps > 0 && m.kind === "video" ? m.fps : activeSequence(p)?.fps ?? 25;
  const seq0 = newSequence(m.name, { width: m.width || 1920, height: m.height || 1080, fps });
  const ctx = ctxOf(p);
  const seq = editMedia(seq0, ctx, m, 0, "overwrite", { range: { in: undefined, out: undefined } });
  return { project: { ...p, sequences: [...p.sequences, seq], activeSequenceId: seq.id }, sequenceId: seq.id };
}

/** Parameter value at a timeline frame (clip-relative conversion). */
export const paramAtFrame = <T>(c: TimelineClip, p: Param<T>, frame: number) => valueAt(p, frame - c.start);

/** Source frame shown at a timeline frame. */
export function sourceFrameAt(c: TimelineClip, seq: Sequence, ctx: Ctx, frame: number): number {
  if (!hasIn(c.source)) return 0;
  const r = sourceRate(c, seq, ctx);
  const k = Math.max(0, Math.min(c.duration - 1, frame - c.start));
  return c.reverse ? c.source.in + (c.duration - 1 - k) * r : c.source.in + k * r;
}

/** Media frames → sequence frames for a media item (for the source monitor's range). */
export const mediaToSeqFrames = (m: MediaItem, frames: number, seqFps: number) => Math.round(convertFrames(frames, m.fps > 0 ? m.fps : seqFps, seqFps));
