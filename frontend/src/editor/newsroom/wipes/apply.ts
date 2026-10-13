/**
 * Wipes on the timeline (docs/EDITOR.md §16.8, nr-wipes): a stinger placed on the Wipes track so its `cut` lands
 * exactly on a cut; news transitions (the engine's pack transitions, tinted with the look's colours) added at a cut on
 * the picture track; and the nearest cut to a frame. Pure: UI code calls these inside one undo step,
 * `host.apply("Add wipe", (d) => applyStinger(d, seqId, cut, id))`.
 */
import { addTransition, clipEnd, ctxOf, tracksOf } from "../../model/ops.ts";
import type { EditProject, Easing, Sequence } from "../../model/types.ts";
import { addGraphic, templateOf } from "../commands.ts";
import { parseHex } from "../render/paint.ts";
import type { ChannelLook, GfxValue } from "../types.ts";

// ── stingers ─────────────────────────────────────────────────────────────────

export interface StingerPlacement {
  /** First frame of the stinger clip, its length in frames, and how many frames of it come before the cut. */
  start: number; duration: number; pre: number;
}

/**
 * Where a stinger `seconds` long with its cut at fraction `cut` goes so the cut lands on `cutFrame`: `pre` frames
 * before it and the rest after. Near the start of the sequence a stinger too long to fit is shortened (same shape,
 * a little faster). Null when there is no room at all.
 */
export function stingerPlacement(seconds: number, cut: number, fps: number, cutFrame: number): StingerPlacement | null {
  const c = Math.min(0.95, Math.max(0.05, cut));
  let duration = Math.max(2, Math.round(Math.max(0.1, seconds) * fps));
  let pre = Math.round(c * duration);
  const at = Math.round(cutFrame);
  if (at - pre < 0) {
    if (at < 2) return null;
    duration = Math.max(2, Math.floor(at / c));
    pre = Math.round(c * duration);
    while (pre > at && duration > 2) { duration--; pre = Math.round(c * duration); }
    if (pre > at) return null;
  }
  return { start: at - pre, duration, pre };
}

/**
 * Puts a stinger on the Wipes track with its cut on `cutFrame` (one clip; the template is copied into the edit);
 * returns the clip id, or null when the template isn't a stinger or there is no room.
 */
export function applyStinger(p: EditProject, seqId: string, cutFrame: number, templateId: string, values?: Record<string, GfxValue>): string | null {
  const seq = p.sequences.find((s) => s.id === seqId);
  const t = templateOf(p, templateId);
  if (!seq || !t || t.cut === undefined) return null;
  const pl = stingerPlacement(t.seconds > 0 ? t.seconds : 1.2, t.cut, seq.fps, cutFrame);
  if (!pl) return null;
  return addGraphic(p, t, { at: pl.start, duration: pl.duration, seqId, ...(values ? { values } : {}) });
}

// ── cuts ─────────────────────────────────────────────────────────────────────

/** Picture tracks (video tracks that aren't graphics tracks), bottom first. */
export const pictureTracks = (seq: Sequence) => tracksOf(seq, "video").filter((t) => !t.gfxRole);

/** Frames where a picture clip ends and the next one starts on the same track (true cuts), sorted. */
export function cutsOf(seq: Sequence): number[] {
  const ids = new Set(pictureTracks(seq).map((t) => t.id));
  const ends = new Set<string>();
  for (const c of seq.clips) if (ids.has(c.trackId)) ends.add(`${c.trackId}|${clipEnd(c)}`);
  const out = new Set<number>();
  for (const c of seq.clips) if (ids.has(c.trackId) && c.start > 0 && ends.has(`${c.trackId}|${c.start}`)) out.add(c.start);
  return [...out].sort((a, b) => a - b);
}

/**
 * The cut nearest `frame` (ties: the earlier one). Without true cuts it falls back to where a picture clip starts or
 * ends inside the sequence; null when there is neither.
 */
export function nearestCut(seq: Sequence, frame: number): number | null {
  let pts = cutsOf(seq);
  if (!pts.length) {
    const ids = new Set(pictureTracks(seq).map((t) => t.id));
    const end = seq.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
    const s = new Set<number>();
    for (const c of seq.clips) if (ids.has(c.trackId)) { if (c.start > 0) s.add(c.start); if (clipEnd(c) < end) s.add(clipEnd(c)); }
    pts = [...s].sort((a, b) => a - b);
  }
  if (!pts.length) return null;
  return pts.reduce((b, x) => (Math.abs(x - frame) < Math.abs(b - frame) ? x : b), pts[0]);
}

// ── news transitions ─────────────────────────────────────────────────────────

/** A look colour as the engine's 0..1 RGB. */
export function rgb01(hex: string | undefined, fallback: [number, number, number] = [1, 1, 1]): [number, number, number] {
  const h = hex ? parseHex(hex) : null;
  return h ? [+(h[0] / 255).toFixed(4), +(h[1] / 255).toFixed(4), +(h[2] / 255).toFixed(4)] : fallback;
}

export interface NewsTransition {
  id: string; label: string;
  /** The engine transition ("tv:<pack id>"). */
  type: string;
  seconds: number; easing: Easing;
  /** Params tinted by the look (only for transitions with colour params). */
  params?(look: ChannelLook): Record<string, unknown>;
}

const edgeGlow = (c: keyof ChannelLook["colors"], edge = 0.035) => (l: ChannelLook) => ({ edge, edge_color: rgb01(l.colors[c]), softness: 0.02 });

/** News-style transitions: pushes, doors, flips, flashes and wipes in the channel's colours. */
export const NEWS_TRANSITIONS: NewsTransition[] = [
  { id: "news.push_left", label: "Push left", type: "tv:slide_left", seconds: 0.5, easing: "ease_in_out" },
  { id: "news.push_up", label: "Push up", type: "tv:slide_up", seconds: 0.5, easing: "ease_in_out" },
  { id: "news.whip", label: "Whip pan", type: "tv:whip_right", seconds: 0.4, easing: "ease_in_out" },
  { id: "news.split_doors", label: "Split doors", type: "tv:doors_open", seconds: 0.7, easing: "ease_in_out" },
  { id: "news.flip", label: "3D flip", type: "tv:flip", seconds: 0.7, easing: "ease_in_out" },
  { id: "news.cube", label: "Cube turn", type: "tv:cube_left", seconds: 0.8, easing: "ease_in_out" },
  { id: "news.zoom", label: "Zoom through", type: "tv:zoom_in", seconds: 0.5, easing: "ease_in_out" },
  { id: "news.camera_flash", label: "Camera flash", type: "tv:flash", seconds: 0.45, easing: "linear", params: () => ({ color: [1, 1, 1] }) },
  { id: "news.colour_dip", label: "Dip to channel colour", type: "tv:flash", seconds: 0.7, easing: "linear",
    params: (l) => ({ color: rgb01(l.colors.primary), bloom: 0.35, hold: 0.7, soften: 0.3 }) },
  { id: "news.light_sweep", label: "Light sweep", type: "tv:lens_flare", seconds: 0.8, easing: "ease_in_out", params: (l) => ({ color: rgb01(l.colors.accent), intensity: 1.1 }) },
  { id: "news.light_leak", label: "Channel light leak", type: "tv:light_leak_warm", seconds: 0.9, easing: "ease_in_out",
    params: (l) => ({ color1: rgb01(l.colors.primary), color2: rgb01(l.colors.accent), intensity: 1.1 }) },
  { id: "news.edge_wipe", label: "Edge wipe", type: "tv:matte_linear", seconds: 0.6, easing: "ease_in_out", params: edgeGlow("accent") },
  { id: "news.diagonal_wipe", label: "Diagonal wipe", type: "tv:matte_diagonal", seconds: 0.6, easing: "ease_in_out", params: edgeGlow("primary") },
  { id: "news.barn_doors", label: "Barn doors", type: "tv:matte_barn_doors", seconds: 0.6, easing: "ease_in_out", params: edgeGlow("accent") },
  { id: "news.iris", label: "Iris", type: "tv:matte_iris_circle", seconds: 0.6, easing: "ease_in_out", params: edgeGlow("accent", 0.03) },
  { id: "news.stripes", label: "Stripes", type: "tv:matte_stripes_diagonal", seconds: 0.7, easing: "ease_in_out", params: edgeGlow("primary", 0.02) },
];
export const newsTransition = (id: string) => NEWS_TRANSITIONS.find((t) => t.id === id);

/**
 * Adds a news transition at the cut on the picture track (the lowest track with a real cut there, else one with a clip
 * edge there); returns the transition id, or null when nothing is cut there.
 */
export function applyNewsTransition(p: EditProject, seqId: string, cutFrame: number, presetId: string, look: ChannelLook): string | null {
  const preset = newsTransition(presetId);
  const seq = p.sequences.find((s) => s.id === seqId);
  if (!preset || !seq) return null;
  const at = Math.round(cutFrame);
  const pics = pictureTracks(seq).filter((t) => !t.locked);
  const on = (id: string, f: (c: Sequence["clips"][number]) => boolean) => seq.clips.some((c) => c.trackId === id && f(c));
  const track = pics.find((t) => on(t.id, (c) => clipEnd(c) === at) && on(t.id, (c) => c.start === at))
    ?? pics.find((t) => on(t.id, (c) => c.start === at || clipEnd(c) === at));
  if (!track) return null;
  const frames = Math.max(2, Math.round(preset.seconds * seq.fps));
  const r = addTransition(seq, ctxOf(p), track.id, at, preset.type, frames, preset.params ? { params: preset.params(look) } : {});
  if (!r.id) return null;
  const next = { ...r.seq, transitions: r.seq.transitions.map((t) => (t.id === r.id ? { ...t, easing: preset.easing } : t)) };
  p.sequences = p.sequences.map((s) => (s.id === seq.id ? next : s));
  return r.id;
}
