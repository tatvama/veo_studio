/**
 * Retiming clips (editor-motion): speed ramps on clips and their linked halves (the sound follows the picture), and
 * freeze frames — a hold inserted at the playhead for N frames, the whole clip held on one frame, the last frame held.
 * A freeze is a stretch of the ramp at 0 %, so a frozen clip stays one clip. "Keep every frame" changes the clip's
 * length so it still plays all its source, rippling what follows; "keep length" leaves the timeline alone.
 * Pure Sequence → Sequence edits that end with normalize.
 */
import { clipById, clipEnd, freeBefore, normalize, rampGroup, shiftAfter, sourceFrameAt, syncTracks, trackById, type Ctx } from "./ops.ts";
import { clipSpan, durationForSpan, freezeInRamp, rampPreset, type RampPresetId } from "./remap.ts";
import type { Param, Sequence, TimelineClip } from "./types.ts";

export type RampFit = "length" | "content";

/** Changes the length of a group of clips that share a start (A/V halves) to `nd`, moving what comes after their end
 *  on their tracks and the sync-locked ones (closing is limited by the room the other tracks have). */
function rippleGroup(seq: Sequence, ids: string[], nd: number): Sequence {
  const group = seq.clips.filter((c) => ids.includes(c.id));
  if (!group.length) return seq;
  const d0 = group[0].duration, end = clipEnd(group[0]);
  let change = Math.round(nd) - d0;
  if (!change) return seq;
  const own = [...new Set(group.map((c) => c.trackId))];
  const tracks = [...new Set([...own, ...syncTracks(seq)])];
  if (change < 0) for (const t of tracks) if (!own.includes(t)) change = Math.max(change, -freeBefore(seq, t, end));
  const moved = shiftAfter({ ...seq, clips: seq.clips.filter((c) => !ids.includes(c.id)) }, tracks, end, change);
  return { ...moved, clips: [...moved.clips, ...group.map((c) => ({ ...c, duration: Math.max(1, d0 + change) }))] };
}

/** Sets (or with `make` → null removes) the speed ramp of clips and their linked halves. */
export function setRamp(seq: Sequence, ctx: Ctx, ids: Iterable<string>, make: (c: TimelineClip) => Param<number> | null, opts: { fit?: RampFit } = {}): Sequence {
  let s = seq;
  const done = new Set<string>();
  for (const id of ids) {
    if (done.has(id)) continue;
    const c = clipById(s, id);
    if (!c || trackById(s, c.trackId)?.locked || (c.source.type !== "media" && c.source.type !== "nested")) continue;
    const group = rampGroup(s, id);
    group.forEach((x) => done.add(x));
    const p = make(c);
    const span = clipSpan(c, 0, c.duration);
    s = { ...s, clips: s.clips.map((x) => {
      if (!group.includes(x.id)) return x;
      const y = { ...x };
      if (p) y.timeRemap = p; else delete y.timeRemap;
      return y;
    }) };
    if (opts.fit === "content") {
      const nd = p ? durationForSpan(p, span, c.duration) : Math.max(1, Math.round(span));
      s = rippleGroup(s, group, nd);
    }
  }
  return normalize(s, ctx);
}

/** A preset ramp on clips (centred on timeline frame `at` when it falls inside the clip). */
export function applyRampPreset(seq: Sequence, ctx: Ctx, ids: Iterable<string>, id: RampPresetId, at: number, opts: { fit?: RampFit; slow?: number; hold?: number } = {}): Sequence {
  return setRamp(seq, ctx, ids, (c) => rampPreset(id, c.duration, {
    at: at >= c.start && at < clipEnd(c) ? at - c.start : undefined, slow: opts.slow, hold: opts.hold, base: c.timeRemap,
  }), { fit: id === "freeze" ? "content" : opts.fit });
}

/** Insert Frame Hold (at timeline frame `frame`, `n` frames): the clip stops there for n frames and then plays on;
 *  what follows moves later. The linked sound pauses with it. */
export function insertFreeze(seq: Sequence, ctx: Ctx, clipId: string, frame: number, n: number): Sequence {
  const c = clipById(seq, clipId);
  if (!c || n < 1) return seq;
  const f = Math.max(0, Math.min(c.duration - 1, Math.round(frame) - c.start));
  return setRamp(seq, ctx, [clipId], (x) => freezeInRamp(x.timeRemap, f, Math.round(n)), { fit: "content" });
}

/** Holds the last frame for `n` more frames (the clip gets longer, what follows moves). */
export function freezeLastFrame(seq: Sequence, ctx: Ctx, clipId: string, n: number): Sequence {
  const c = clipById(seq, clipId);
  return c ? insertFreeze(seq, ctx, clipId, clipEnd(c) - 1, n) : seq;
}

/** Frame Hold: the whole clip shows the frame at timeline frame `frame` (only this clip, not its linked sound). */
export function holdFrame(seq: Sequence, ctx: Ctx, clipId: string, frame: number): Sequence {
  const c = clipById(seq, clipId);
  if (!c || c.source.type !== "media" || trackById(seq, c.trackId)?.locked) return seq;
  const f = Math.max(c.start, Math.min(clipEnd(c) - 1, Math.round(frame)));
  const src = Math.round(sourceFrameAt(c, seq, ctx, f) * 1000) / 1000;
  return normalize({ ...seq, clips: seq.clips.map((x) => (x.id === c.id ? { ...x, reverse: false, source: { ...c.source, in: src } as TimelineClip["source"], timeRemap: { value: 0 } } : x)) }, ctx);
}
