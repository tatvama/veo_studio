/**
 * Screen layout commands (docs/EDITOR.md §16.6) on a draft project: put a clip in a layout's box, take it out, change
 * its framing, or bring a media item from the bin straight into a box. Pure: UI code calls them inside one
 * `host.apply(label, (d) => …)` / `exec` (one undo step).
 */
import { mediaSpan } from "../../model/defaults.ts";
import { addTrack, clearRange, clipEnd, clipsFromMedia, ctxOf, placeClips, tracksOf } from "../../model/ops.ts";
import type { EditProject, Sequence, TimelineClip, Track } from "../../model/types.ts";
import { boxesOf as templateBoxes, isLayout, layoutClips, templateById, type BoxInfo } from "../slots.ts";
import type { GfxRatio, GfxTemplate, SlotBinding } from "../types.ts";

export { templateBoxes as boxesOf };
export type { BoxInfo };

const seqOf = (p: EditProject, id: string): Sequence => {
  const s = p.sequences.find((x) => x.id === id);
  if (!s) throw new Error(`No sequence ${id}`);
  return s;
};
const setSeq = (p: EditProject, s: Sequence) => { p.sequences = p.sequences.map((x) => (x.id === s.id ? s : x)); };
const overlaps = (c: { start: number; duration: number }, a: number, b: number) => c.start < b && clipEnd(c) > a;

/** A picture clip (video / image / nested / matte on a video track that isn't a graphics track). */
export function isPictureClip(s: Sequence, c: TimelineClip): boolean {
  const t = s.tracks.find((x) => x.id === c.trackId);
  return !!t && t.kind === "video" && !t.gfxRole && c.source.type !== "graphic" && c.source.type !== "title" && c.source.type !== "adjustment" && c.source.type !== "generate";
}

/** The layout clip (a graphic with video boxes) and its template, or null. */
export function layoutOf(p: EditProject, s: Sequence, layoutClipId: string): { clip: TimelineClip; template: GfxTemplate } | null {
  const c = s.clips.find((x) => x.id === layoutClipId);
  if (!c || c.source.type !== "graphic") return null;
  const t = templateById(p, c.source.gfx.template);
  return t && isLayout(t) ? { clip: c, template: t } : null;
}

/** Layout graphics that overlap a clip in time (top track first). */
export function layoutsOver(p: EditProject, s: Sequence, c: Pick<TimelineClip, "start" | "duration">) {
  return layoutClips(p, s).filter((l) => overlaps(l.clip, c.start, clipEnd(c)));
}

/** Picture clips under a layout (on lower video tracks) that overlap it, bottom track first. */
export function clipsUnder(p: EditProject, s: Sequence, layoutClipId: string): TimelineClip[] {
  const lo = layoutOf(p, s, layoutClipId);
  if (!lo) return [];
  const idx = new Map(tracksOf(s, "video").map((t) => [t.id, t.index]));
  const top = idx.get(lo.clip.trackId) ?? Infinity;
  return s.clips.filter((c) => isPictureClip(s, c) && (idx.get(c.trackId) ?? Infinity) < top && overlaps(c, lo.clip.start, clipEnd(lo.clip)))
    .sort((a, b) => (idx.get(a.trackId)! - idx.get(b.trackId)!) || a.start - b.start);
}

/** The boxes of a layout clip in a sequence's ratio. */
export function boxesOfClip(p: EditProject, s: Sequence, layoutClipId: string, ratio?: GfxRatio): BoxInfo[] {
  const lo = layoutOf(p, s, layoutClipId);
  if (!lo) return [];
  return templateBoxes(lo.template, ratio ?? ratioOfSeq(s));
}

/** Puts a clip in box `index` of the layout on screen (keeping its framing if it had one). */
export function assignSlot(p: EditProject, seqId: string, clipId: string, index: number): void {
  const s = seqOf(p, seqId);
  setSeq(p, { ...s, clips: s.clips.map((c) => (c.id === clipId ? { ...c, slot: { ...(c.slot ?? {}), index: Math.max(0, Math.round(index)) } } : c)) });
}

/** Takes a clip out of its box (it shows with its own motion again). */
export function clearSlot(p: EditProject, seqId: string, clipId: string): void {
  const s = seqOf(p, seqId);
  setSeq(p, { ...s, clips: s.clips.map((c) => { if (c.id !== clipId || !c.slot) return c; const { slot: _drop, ...rest } = c; void _drop; return rest; }) });
}

/** Changes how a clip fills its box: fit, zoom (1 = just filling), offset (-0.5..0.5 of the picture). */
export function setSlotFraming(p: EditProject, seqId: string, clipId: string, patch: Partial<Omit<SlotBinding, "index">>): void {
  const s = seqOf(p, seqId);
  setSeq(p, { ...s, clips: s.clips.map((c) => {
    if (c.id !== clipId || !c.slot) return c;
    const slot: SlotBinding = { ...c.slot, ...patch };
    if (slot.zoom !== undefined) slot.zoom = Math.max(1, Math.min(8, slot.zoom));
    if (slot.offset) slot.offset = [Math.max(-0.5, Math.min(0.5, slot.offset[0])), Math.max(-0.5, Math.min(0.5, slot.offset[1]))];
    return { ...c, slot };
  }) });
}

/** The clip in box `index` under a layout at its start (the one bound to it that covers the most of the layout). */
export function clipInBox(p: EditProject, s: Sequence, layoutClipId: string, index: number): TimelineClip | null {
  const lo = layoutOf(p, s, layoutClipId);
  if (!lo) return null;
  const a = lo.clip.start, b = clipEnd(lo.clip);
  const cover = (c: TimelineClip) => Math.min(b, clipEnd(c)) - Math.max(a, c.start);
  return clipsUnder(p, s, layoutClipId).filter((c) => c.slot?.index === index).sort((x, y) => cover(y) - cover(x))[0] ?? null;
}

const area = (b: readonly number[]) => b[2] * b[3];
const overlap = (a: readonly number[], b: readonly number[]) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));

/** Track indexes (exclusive) a box's picture must sit between so overlapping boxes stack right. */
function stackRange(p: EditProject, s: Sequence, layoutClipId: string, t: GfxTemplate, index: number, top: number): { lo: number; hi: number } {
  const boxes = templateBoxes(t, ratioOfSeq(s));
  const mine = boxes.find((b) => b.index === index);
  const idx = new Map(s.tracks.map((x) => [x.id, x.index]));
  let lo = -1, hi = top;
  if (!mine) return { lo, hi };
  for (const o of boxes) {
    if (o.index === index || overlap(mine.frac, o.frac) <= 0) continue;
    const oc = clipInBox(p, s, layoutClipId, o.index);
    if (!oc) continue;
    const ti = idx.get(oc.trackId) ?? 0;
    if (area(o.frac) > area(mine.frac)) lo = Math.max(lo, ti); else hi = Math.min(hi, ti);
  }
  return { lo, hi };
}

const ratioOfSeq = (s: Sequence): GfxRatio => { const a = s.width / s.height; return a > 1.3 ? "16:9" : a < 0.7 ? "9:16" : a < 0.9 ? "4:5" : "1:1"; };

/**
 * Adds a media item (video or image) as a clip in box `index` of a layout: on a picture track below the layout,
 * spanning the layout's length (a shorter video as long as it lasts), bound to the box, with its sound linked on a
 * free audio track. A clip already in that box there is replaced over the range. Returns the new clip's id.
 */
export function placeInSlot(p: EditProject, seqId: string, mediaId: string, layoutClipId: string, index: number): string {
  let s = seqOf(p, seqId);
  const m = p.media.find((x) => x.id === mediaId);
  if (!m || m.kind === "audio") throw new Error("Pick a video or a picture");
  const lo = layoutOf(p, s, layoutClipId);
  if (!lo) throw new Error("That isn't a screen layout");
  const ctx = ctxOf(p);
  const a = lo.clip.start, b = clipEnd(lo.clip);
  const dur = m.kind === "image" ? b - a : Math.max(1, Math.min(b - a, mediaSpan(m, s.fps).frames));
  const layoutTrack = s.tracks.find((t) => t.id === lo.clip.trackId)!;
  const free = (t: Track) => !s.clips.some((c) => c.trackId === t.id && overlaps(c, a, a + dur));
  // the box's clip already there: replace it on its track; else the lowest free picture track below the layout that
  // keeps overlapping boxes in order (an inset above the big box it sits on, a big box under the insets on it)
  const have = clipInBox(p, s, layoutClipId, index);
  const { lo: lowest, hi: highest } = stackRange(p, s, layoutClipId, lo.template, index, layoutTrack.index);
  const below = tracksOf(s, "video").filter((t) => !t.gfxRole && !t.locked && t.index < layoutTrack.index);
  let vt = have ? s.tracks.find((t) => t.id === have.trackId) : below.find((t) => t.index > lowest && t.index < highest && free(t));
  if (!vt) {
    const top = Math.max(lowest + 1, below.length ? Math.min(below[below.length - 1].index + 1, highest) : Math.max(0, layoutTrack.index));
    const r = addTrack(s, "video", top);
    s = r.seq;
    vt = s.tracks.find((t) => t.id === r.trackId)!;
  }
  // the replaced clip's sound goes with it over the range
  if (have?.linkId) for (const c of s.clips.filter((x) => x.linkId === have.linkId && x.id !== have.id)) s = clearRange(s, ctx, c.trackId, a, a + dur);
  let at: Track | undefined;
  if (m.hasAudio && m.kind === "video") {
    at = tracksOf(s, "audio").find((t) => !t.locked && !s.clips.some((c) => c.trackId === t.id && overlaps(c, a, a + dur)));
    if (!at) { const r = addTrack(s, "audio"); s = r.seq; at = s.tracks.find((t) => t.id === r.trackId); }
  }
  const made = clipsFromMedia(s, m, a, { videoTrackId: vt.id, audioTrackId: at?.id, video: true, audio: !!at, duration: dur });
  const pic = made.find((c) => c.trackId === vt!.id);
  if (!pic) throw new Error("Couldn't place that media");
  pic.slot = { index: Math.max(0, Math.round(index)) };
  s = placeClips(s, ctx, made, "overwrite");
  setSeq(p, s);
  return pic.id;
}
