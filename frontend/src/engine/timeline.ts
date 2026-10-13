/**
 * What the cut shows at time t: per track what to draw, in order: clips (with their source time, fade, keyframed
 * transform or motion) and at most one transition between two clips (or one clip and nothing). Nested compositions
 * are evaluated at their own time. Pure maths, no GPU.
 *
 * Track kinds (types.ts): "main" keeps the studio cut's rule (one shot, or two while the later one's `transitionIn`
 * runs); "layer" and "video" draw every active clip, and a transition from the track's `transitions` (or a clip's
 * `transitionIn`) wherever it sits, reaching into the clips' handles.
 */
import { ease } from "./easing.ts";
import { paramAt, transformAt } from "./keyframes.ts";
import type { BlendMode, Clip, Composition, KfKey, Motion, TimePoint, Track, TransitionParam } from "./types.ts";

export interface MotionState {
  /** Composition pixels (default: the frame centre). */
  position?: [number, number];
  /** % of the fitted size. */
  scale: number;
  /** Degrees clockwise. */
  rotation: number;
  /** The picture's own pixels (default: its centre). */
  anchor?: [number, number];
  /** 0..1, fades included. */
  opacity: number;
  blend?: BlendMode;
}

export interface ClipState {
  clip: Clip; index: number;
  /** Seconds since the clip's start on the cut (outside 0..duration inside a transition's handles). */
  local: number;
  /** Seconds in the media (images: 0); nested: seconds in the nested composition. */
  sourceTime: number;
  /** Fade multiplier 0..1: the main track fades to black, other tracks fade their alpha. */
  fade: number;
  /** Layers: the keyframed transform at this instant (opacity already includes the fade). */
  transform?: Record<KfKey, number>;
  /** Clips with `motion` (opacity already includes the fade). */
  motion?: MotionState;
  /** Nested clips: the nested composition at its time. */
  nested?: FrameState;
}
export interface TransitionState {
  type: string; progress: number; raw: number; params?: Record<string, unknown>;
  /** null: the transition comes from (or goes to) nothing. */
  from: ClipState | null; to: ClipState | null;
}
export type DrawItem = { kind: "clip"; cs: ClipState } | { kind: "transition"; tr: TransitionState };
export interface TrackState {
  track: Track; index: number;
  /** Every clip drawn on this track now (the transition's two included). */
  clips: ClipState[];
  transition?: TransitionState;
  /** What to draw, bottom → top. */
  items: DrawItem[];
}
export interface FrameState { t: number; tracks: TrackState[] }

const EPS = 1e-6;
const MAX_NEST = 8;

const maps = new WeakMap<TimePoint[], TimePoint[] | null>();
/** Clip.timeMap cleaned (finite points, sorted by t, one per t, source times never going back), or null without one. */
export function timeMapOf(clip: Clip): TimePoint[] | null {
  const m = clip.timeMap;
  if (!Array.isArray(m) || !m.length) return null;
  let c = maps.get(m);
  if (c === undefined) {
    const pts = m.filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.s)).map((p) => ({ t: Number(p.t), s: Number(p.s) })).sort((a, b) => a.t - b.t);
    const out: TimePoint[] = [];
    for (const p of pts) {
      if (out.length && Math.abs(p.t - out[out.length - 1].t) < 1e-9) { out[out.length - 1] = p; continue; }
      out.push(p);
    }
    for (let i = 1; i < out.length; i++) if (out[i].s < out[i - 1].s) out[i] = { t: out[i].t, s: out[i - 1].s };
    c = out.length ? out : null;
    maps.set(m, c);
  }
  return c;
}

/** A time map at `local` seconds: linear between its points; held outside them, or with `extend` carried on along
 *  the first / last segment's slope (transition handles). */
export function timeMapAt(map: TimePoint[], local: number, extend = false): number {
  const n = map.length;
  if (n === 1) return map[0].s;
  if (local <= map[0].t) return extend ? map[0].s + (local - map[0].t) * slope(map[0], map[1]) : map[0].s;
  if (local >= map[n - 1].t) return extend ? map[n - 1].s + (local - map[n - 1].t) * slope(map[n - 2], map[n - 1]) : map[n - 1].s;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (map[mid].t <= local) lo = mid; else hi = mid; }
  const a = map[lo], b = map[hi];
  return a.s + (local - a.t) * slope(a, b);
}
const slope = (a: TimePoint, b: TimePoint) => (b.t - a.t > 1e-9 ? (b.s - a.s) / (b.t - a.t) : 0);

/** Source seconds per second of the cut at `local` (a clip's playback rate there): the time map's slope (0 on a
 *  flat segment), else the speed (0: a freeze). Always ≥ 0; `reverse` is the direction, not part of the rate. */
export function sourceRate(clip: Clip, local: number): number {
  const map = timeMapOf(clip);
  if (map) {
    if (map.length < 2) return 0;
    const n = map.length;
    if (local < map[0].t || local >= map[n - 1].t) return 0;
    let i = 0;
    while (i < n - 2 && local >= map[i + 1].t) i++;
    return Math.max(0, slope(map[i], map[i + 1]));
  }
  if (clip.speed === 0) return 0;
  return clip.speed > 0 ? clip.speed : 1;
}

/** Source seconds for a clip at `local` seconds into it: in + local·speed, or backwards from in + span·speed when
 *  reversed; clamped to the trimmed part (a hold freezes its last frame) and to the media's length. With `handles`
 *  (inside a transition) it may run past the trim, into the media around it. A time map (Clip.timeMap) wins over
 *  in / speed / reverse; speed 0 freezes the frame at `in`. */
export function sourceTime(clip: Clip, local: number, handles = false): number {
  if (clip.type === "title" || clip.type === "color" || clip.type === "adjustment") return local;
  if (clip.media.kind === "image" && clip.type !== "nested") return 0;
  const span = Math.max(clip.duration - (clip.hold ?? 0), 0);
  const l = handles ? local : Math.min(Math.max(local, 0), span);
  const len = clip.type === "nested" ? clip.comp?.duration : clip.media.duration;
  const map = timeMapOf(clip);
  if (map || clip.speed === 0) {
    let s = map ? timeMapAt(map, l, handles) : clip.in;
    if (len && len > 0) s = Math.min(s, Math.max(len - 1e-3, 0));
    return Math.max(s, 0);
  }
  const speed = clip.speed > 0 ? clip.speed : 1;
  let s = clip.reverse ? clip.in + (span - l) * speed : clip.in + l * speed;
  if (!handles) {
    const end = clip.in + span * speed - 1e-3;  // the last frame, not the first one after the trim
    s = Math.min(Math.max(s, clip.in), Math.max(end, clip.in));
  }
  if (len && len > 0) s = Math.min(s, Math.max(len - 1e-3, 0));
  return Math.max(s, 0);
}

/** The fade multiplier: linear in over fade_in seconds from the start, out over fade_out seconds to the end. */
export function fadeAt(clip: Clip, local: number): number {
  const fi = clip.fx?.fade_in ?? 0, fo = clip.fx?.fade_out ?? 0;
  const l = Math.min(Math.max(local, 0), clip.duration);
  let f = 1;
  if (fi > 0) f *= Math.min(Math.max(l / fi, 0), 1);
  if (fo > 0) f *= Math.min(Math.max((clip.duration - l) / fo, 0), 1);
  return f;
}

/** Motion at `local` seconds (keyframes in seconds or frames at `fps`). */
export function motionAt(m: Motion, local: number, fps: number): MotionState {
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const pair = (v: unknown): [number, number] | undefined => (Array.isArray(v) && v.length >= 2 ? [num(v[0], 0), num(v[1], 0)] : undefined);
  return {
    position: pair(paramAt(m.position, local, fps)), anchor: pair(paramAt(m.anchor, local, fps)),
    scale: num(paramAt(m.scale, local, fps), 100), rotation: num(paramAt(m.rotation, local, fps), 0),
    opacity: Math.min(Math.max(num(paramAt(m.opacity, local, fps), 100) / 100, 0), 1), blend: m.blend,
  };
}

function stateOf(clip: Clip, index: number, t: number, kind: Track["kind"], fps: number, depth: number, handles = false): ClipState {
  const local = t - clip.start;
  const st: ClipState = { clip, index, local, sourceTime: sourceTime(clip, local, handles), fade: fadeAt(clip, local) };
  if (clip.motion) {
    st.motion = motionAt(clip.motion, local, fps);
    if (kind !== "main") st.motion.opacity *= st.fade;
  } else if (kind === "layer" || clip.transform) {
    const tr = transformAt(clip.transform, local);
    tr.opacity = Math.min(Math.max(tr.opacity, 0), 1) * (kind === "main" ? 1 : st.fade);
    st.transform = tr;
  }
  if (clip.type === "nested" && clip.comp && depth < MAX_NEST) st.nested = evaluateAt(clip.comp, st.sourceTime, depth + 1);
  return st;
}

const active = (c: Clip, t: number) => t >= c.start - EPS && t < c.start + c.duration - EPS;

interface Range { x0: number; x1: number; type: string; from: number; to: number; params?: Record<string, TransitionParam>; easing?: string }

/** A track's transitions as time ranges with clip indices (-1 = nothing on that side). */
export function trackTransitions(track: Track): Range[] {
  const out: Range[] = [];
  const idx = new Map(track.clips.map((c, i) => [c.id, i]));
  for (const tr of track.transitions ?? []) {
    const d = Math.max(tr.duration, 0);
    if (!(d > 0)) continue;
    const x0 = typeof tr.start === "number" ? tr.start : tr.alignment === "start" ? tr.at : tr.alignment === "end" ? tr.at - d : tr.at - d / 2;
    const from = tr.from ? idx.get(tr.from) ?? -1 : -1, to = tr.to ? idx.get(tr.to) ?? -1 : -1;
    if (from < 0 && to < 0) continue;
    out.push({ x0, x1: x0 + d, type: tr.type, from, to, params: tr.params, easing: tr.easing });
  }
  // a clip's transitionIn blends it over the clip before it on the track (they already overlap)
  const order = track.clips.map((_, i) => i).sort((a, b) => track.clips[a].start - track.clips[b].start);
  order.forEach((i, k) => {
    const c = track.clips[i], tr = c.transitionIn;
    if (!tr || !(tr.duration > 0) || k === 0) return;
    out.push({ x0: c.start, x1: c.start + tr.duration, type: tr.type, from: order[k - 1], to: i, params: tr.params, easing: tr.easing });
  });
  return out;
}

function evalTrack(track: Track, ti: number, t: number, fps: number, depth: number): TrackState {
  const kind = track.kind;
  const on: number[] = [];
  track.clips.forEach((c, i) => { if (active(c, t)) on.push(i); });
  if (kind === "main") {
    if (!on.length) return { track, index: ti, clips: [], items: [] };
    // the main track shows one clip, or two while the later one's transition runs
    const cur = on[on.length - 1];
    const c = track.clips[cur];
    const tr = c.transitionIn;
    const prev = on.length > 1 ? on[on.length - 2] : -1;
    if (tr && tr.duration > 0 && prev >= 0 && t < c.start + tr.duration) {
      const from = stateOf(track.clips[prev], prev, t, kind, fps, depth), to = stateOf(c, cur, t, kind, fps, depth);
      const raw = Math.min(Math.max((t - c.start) / tr.duration, 0), 1);
      const ts: TransitionState = { type: tr.type, raw, progress: ease(tr.easing, raw), params: tr.params, from, to };
      return { track, index: ti, clips: [from, to], transition: ts, items: [{ kind: "transition", tr: ts }] };
    }
    const cs = stateOf(c, cur, t, kind, fps, depth);
    return { track, index: ti, clips: [cs], items: [{ kind: "clip", cs }] };
  }
  // layer / video: every active clip; one transition (the first whose range holds t) draws its two clips
  const r = trackTransitions(track).find((x) => t >= x.x0 - EPS && t < x.x1 - EPS);
  let trs: TransitionState | undefined;
  const skip = new Set<number>();
  if (r) {
    const side = (i: number) => (i >= 0 ? stateOf(track.clips[i], i, t, kind, fps, depth, true) : null);
    const raw = Math.min(Math.max((t - r.x0) / (r.x1 - r.x0), 0), 1);
    trs = { type: r.type, raw, progress: ease(r.easing === "hold" ? "linear" : r.easing, raw), params: r.params, from: side(r.from), to: side(r.to) };
    skip.add(r.from); skip.add(r.to);
  }
  const clips = on.filter((i) => !skip.has(i)).map((i) => stateOf(track.clips[i], i, t, kind, fps, depth));
  const items: DrawItem[] = clips.map((cs) => ({ kind: "clip" as const, cs }));
  if (trs) {
    const at = Math.min(...[trs.from, trs.to].filter((x): x is ClipState => !!x).map((x) => x.clip.start));
    const k = items.findIndex((it) => it.kind === "clip" && it.cs.clip.start > at);
    items.splice(k < 0 ? items.length : k, 0, { kind: "transition", tr: trs });
  }
  items.sort((a, b) => startOf(a) - startOf(b));
  const all = [...clips, ...(trs ? [trs.from, trs.to].filter((x): x is ClipState => !!x) : [])];
  return { track, index: ti, clips: all, transition: trs, items };
}
const startOf = (it: DrawItem) => (it.kind === "clip" ? it.cs.clip.start
  : Math.min(...[it.tr.from, it.tr.to].filter((x): x is ClipState => !!x).map((x) => x.clip.start)));

function evaluateAt(comp: Composition, t: number, depth: number): FrameState {
  const tracks: TrackState[] = [];
  comp.tracks.forEach((track, ti) => { if (!track.hidden) tracks.push(evalTrack(track, ti, t, comp.fps || 24, depth)); });
  return { t, tracks };
}

export function evaluate(comp: Composition, t: number): FrameState { return evaluateAt(comp, t, 0); }

/** Every clip state of a frame, nested ones included, with the path of nested clip ids leading to it. */
export function walk(fs: FrameState, fn: (cs: ClipState, path: string) => void, path = ""): void {
  for (const ts of fs.tracks) for (const cs of ts.clips) {
    fn(cs, path);
    if (cs.nested) walk(cs.nested, fn, `${path}${cs.clip.id}/`);
  }
}

/** The cut's length: the end of the last clip on any track. */
export const compDuration = (tracks: Track[]) =>
  tracks.reduce((m, tk) => tk.clips.reduce((mm, c) => Math.max(mm, c.start + c.duration), m), 0);

/** Media a composition uses (nested ones included), de-duplicated (url → kind), for preloading. */
export function mediaOf(comp: Composition, out = new Map<string, Clip["media"]>(), depth = 0): Map<string, Clip["media"]> {
  for (const tk of comp.tracks) for (const c of tk.clips) {
    if (c.media.url && !out.has(c.media.url) && (c.type ?? "media") === "media") out.set(c.media.url, c.media);
    if (c.comp && depth < MAX_NEST) mediaOf(c.comp, out, depth + 1);
  }
  return out;
}
