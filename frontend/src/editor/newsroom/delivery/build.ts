/**
 * Building blocks for the sequences News delivery generates (batch rows, news shorts, loops, the look preview reel):
 * an empty sequence, graphics tracks in the News Room's order (docs/EDITOR.md §16.5: Background under V1; Layout,
 * Boards, Straps, Ticker, Bug, Wipes above the pictures), graphic / colour / title / picture clips, a range of a
 * sequence cut out and moved, and the templates an edit can use. Self-contained (it doesn't need nr-core's commands),
 * so a plan can be made and tested on its own. Pure.
 */
import { baseClip, defaultTitle, newSequence, newTrack } from "../../model/defaults.ts";
import { uid } from "../../model/ids.ts";
import { clipEnd, clipsFromMedia, ctxOf, splitAt, transitionRange } from "../../model/ops.ts";
import type { EditProject, MediaItem, Sequence, TimelineClip, TitleSpec, Track } from "../../model/types.ts";
import { builtinTemplate } from "../templates/index.ts";
import type { GfxInstance, GfxRole, GfxTemplate } from "../types.ts";

/** Graphics roles bottom → top above the pictures (Background goes under V1). */
export const ROLE_ORDER: GfxRole[] = ["layout", "board", "strap", "ticker", "bug", "wipe"];
export const ROLE_NAME: Record<GfxRole, string> = {
  background: "Background", layout: "Layout", board: "Boards", strap: "Straps", ticker: "Ticker", bug: "Bug", wipe: "Wipes",
};

/** A sequence with one picture track (V1) and one sound track (A1). */
export function blankSequence(name: string, size: { width: number; height: number; fps: number }): Sequence {
  const s = newSequence(name, size, { video: 1, audio: 1 });
  return { ...s, tracks: s.tracks.map((t) => (t.kind === "video" ? { ...t, name: "V1" } : t)) };
}

const reindexVideo = (tracks: Track[], order: Track[]) => {
  const pos = new Map(order.map((t, i) => [t.id, i]));
  return tracks.map((t) => (t.kind === "video" ? { ...t, index: pos.get(t.id)! } : t));
};

/** The track for a graphics role: the sequence's own, else a new one in the News Room's place. */
export function gfxTrack(seq: Sequence, role: GfxRole): { seq: Sequence; trackId: string } {
  const have = seq.tracks.find((t) => t.kind === "video" && t.gfxRole === role);
  if (have) return { seq, trackId: have.id };
  const video = seq.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index);
  const t: Track = { ...newTrack("video", 0, { targeted: false, syncLock: false }), name: ROLE_NAME[role], gfxRole: role };
  let at: number;
  if (role === "background") at = 0;
  else {
    // above every picture track and every graphics track of a lower role, below the higher ones
    const rank = ROLE_ORDER.indexOf(role);
    const higher = video.findIndex((v) => v.gfxRole && v.gfxRole !== "background" && ROLE_ORDER.indexOf(v.gfxRole) > rank);
    at = higher < 0 ? video.length : higher;
  }
  const order = [...video.slice(0, at), t, ...video.slice(at)];
  return { seq: { ...seq, tracks: reindexVideo([...seq.tracks, t], order) }, trackId: t.id };
}

/** A new video track on top (captions, title cards). */
export function topTrack(seq: Sequence, name: string): { seq: Sequence; trackId: string } {
  const video = seq.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index);
  const t: Track = { ...newTrack("video", video.length, { targeted: false, syncLock: false }), name };
  return { seq: { ...seq, tracks: [...seq.tracks, t] }, trackId: t.id };
}

/** Adds a clip (the caller has made room; generated sequences never overlap on a track). */
const withClip = (seq: Sequence, c: TimelineClip): Sequence => ({ ...seq, clips: [...seq.clips, c] });

/** A graphic on its role's track (made when missing); returns the clip id. */
export function placeGraphic(seq: Sequence, t: Pick<GfxTemplate, "id" | "name" | "role">, at: number, frames: number,
  gfx: Omit<GfxInstance, "template">, name = t.name): { seq: Sequence; clipId: string } {
  const r = gfxTrack(seq, t.role);
  const c = baseClip(r.seq, r.trackId, at, Math.max(1, Math.round(frames)), { type: "graphic", gfx: { template: t.id, ...gfx } }, name);
  return { seq: withClip(r.seq, c), clipId: c.id };
}

/** A colour matte on a track. */
export function placeColor(seq: Sequence, trackId: string, at: number, frames: number, color: string, name = "Colour"): Sequence {
  return withClip(seq, baseClip(seq, trackId, at, Math.max(1, Math.round(frames)), { type: "color", color }, name));
}

/** A title on a track. */
export function placeTitle(seq: Sequence, trackId: string, at: number, frames: number, spec: Partial<TitleSpec> & { text: string }): Sequence {
  const text: TitleSpec = { ...defaultTitle(spec.text), ...spec };
  return withClip(seq, baseClip(seq, trackId, at, Math.max(1, Math.round(frames)), { type: "title", text }, spec.text.slice(0, 40) || "Title"));
}

/** A media item's picture on V1 (and its sound on A1 when it has some), from source frame `inFrame`. */
export function placeMedia(seq: Sequence, m: MediaItem, at: number, frames: number, inFrame = 0): Sequence {
  const v = seq.tracks.filter((t) => t.kind === "video" && !t.gfxRole).sort((a, b) => a.index - b.index)[0];
  const a = seq.tracks.filter((t) => t.kind === "audio").sort((x, y) => x.index - y.index)[0];
  const clips = clipsFromMedia(seq, m, at, { videoTrackId: v?.id, audioTrackId: a?.id, duration: Math.max(1, Math.round(frames)), range: { in: inFrame } });
  return { ...seq, clips: [...seq.clips, ...clips] };
}

/**
 * The part [from, to) of a sequence (clips cut at the edges, transitions inside it), moved to start at `at`, in a new
 * sequence with the same tracks (`name`, a new id). Markers are left out.
 */
export function sliceSequence(p: Pick<EditProject, "media" | "sequences">, seq: Sequence, from: number, to: number, at: number, name: string): Sequence {
  const ctx = ctxOf(p);
  const ids = seq.tracks.map((t) => t.id);
  let s = splitAt(seq, ctx, ids, from);
  s = splitAt(s, ctx, ids, to);
  const d = at - from;
  const clips = s.clips.filter((c) => c.start >= from && clipEnd(c) <= to).map((c) => ({ ...c, start: c.start + d }));
  const kept = new Set(clips.map((c) => c.id));
  const transitions = s.transitions.filter((tr) => {
    const [a, b] = transitionRange(tr);
    return a >= from && b <= to && (!tr.fromClipId || kept.has(tr.fromClipId)) && (!tr.toClipId || kept.has(tr.toClipId));
  }).map((tr) => ({ ...tr, at: tr.at + d }));
  return { ...s, id: uid("s"), name, clips, transitions, markers: [], inPoint: undefined, outPoint: undefined, playhead: 0 };
}

/** A template by id: the edit's copy first, then the built-ins. */
export function findTemplate(p: Pick<EditProject, "newsroom">, id: string): GfxTemplate | undefined {
  return p.newsroom?.templates?.[id] ?? builtinTemplate(id);
}

/** Every template the edit can use: its own copies, then the built-ins not copied (by category order of the list). */
export function availableTemplates(p: Pick<EditProject, "newsroom">, builtins: GfxTemplate[]): GfxTemplate[] {
  const own = Object.values(p.newsroom?.templates ?? {});
  const ids = new Set(own.map((t) => t.id));
  return [...own, ...builtins.filter((t) => !ids.has(t.id))];
}

/** Graphic clips of a sequence (optionally only those on one role's track), by start. */
export function graphicsOf(seq: Sequence, role?: GfxRole): (TimelineClip & { source: { type: "graphic"; gfx: GfxInstance } })[] {
  const roles = new Map(seq.tracks.filter((t) => t.gfxRole).map((t) => [t.id, t.gfxRole!]));
  return seq.clips.filter((c): c is TimelineClip & { source: { type: "graphic"; gfx: GfxInstance } } =>
    c.source.type === "graphic" && (!role || roles.get(c.trackId) === role)).sort((a, b) => a.start - b.start);
}
