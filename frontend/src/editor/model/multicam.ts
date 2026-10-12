/**
 * Multicam (editor-motion). A multicam source is a sequence with `multicam` set: angle i on video track i (and its
 * sound on audio track i), placed so the angles are in sync. On the timeline it is a nested clip with
 * `multicam: {angle, audioAngle}`; switching angles while playing cuts that clip at the playhead and gives the new
 * piece the new angle (the cuts are ordinary edit points, so they trim, roll and undo like any other). Flatten
 * replaces each piece with the media of its angle. Pure.
 */
import { baseClip, newSequence } from "./defaults.ts";
import { uid } from "./ids.ts";
import {
  activeSequence, clipById, clipEnd, clipsFromMedia, ctxOf, normalize, placeClips, seqEnd, sourceRate, splitAt, tracksOf, trackById, trimEndBy,
  trimStartBy, type Ctx,
} from "./ops.ts";
import { secondsToFrames } from "./time.ts";
import type { EditProject, MediaItem, Sequence, TimelineClip } from "./types.ts";

export interface AngleSpec {
  mediaId: string; name?: string;
  /** Seconds: where this angle's media starts on the reference angle's clock (positive = it starts later). */
  offset: number;
  /** Source range of the angle used (source frames); default the whole media. */
  range?: { in?: number; out?: number };
}

export const isMulticamClip = (c: TimelineClip, p: Pick<EditProject, "sequences">) =>
  !!c.multicam && c.source.type === "nested" && !!p.sequences.find((s) => s.id === (c.source as { sequenceId: string }).sequenceId)?.multicam;

/**
 * Sync offsets from where the clips sit on the timeline (they're lined up by eye): the time on the reference clip's
 * media clock at which each media starts. `clips[0]` is the reference.
 */
export function offsetsFromTimeline(clips: TimelineClip[], seq: Sequence, ctx: Ctx): number[] {
  const fps = (m?: MediaItem) => (m && m.fps > 0 ? m.fps : seq.fps);
  const ref = clips[0];
  const refM = ref.source.type === "media" ? ctx.media(ref.source.mediaId) : undefined;
  const refIn = ref.source.type === "media" ? ref.source.in / fps(refM) : 0;
  return clips.map((c) => {
    const m = c.source.type === "media" ? ctx.media(c.source.mediaId) : undefined;
    const inS = c.source.type === "media" ? c.source.in / fps(m) : 0;
    return refIn - inS + (c.start - ref.start) / seq.fps;
  });
}

/** Sync offsets that line the clips' in points up (each in point is the same moment). */
export function offsetsFromInPoints(clips: TimelineClip[], seq: Sequence, ctx: Ctx): number[] {
  const fps = (m?: MediaItem) => (m && m.fps > 0 ? m.fps : seq.fps);
  const inOf = (c: TimelineClip) => (c.source.type === "media" ? c.source.in / fps(ctx.media(c.source.mediaId)) : 0);
  const r = inOf(clips[0]);
  return clips.map((c) => r - inOf(c));
}

/**
 * A new multicam source sequence from angles (each the whole media, or its range), sized like `like`. The earliest
 * angle starts at frame 0. Returns the project with the sequence added and its id.
 */
export function createMulticamSequence(p: EditProject, name: string, angles: AngleSpec[], like: { width: number; height: number; fps: number },
  syncedBy: NonNullable<Sequence["multicam"]>["syncedBy"]): { project: EditProject; sequenceId: string } {
  const n = Math.max(1, angles.length);
  const ns = newSequence(name, like, { video: n, audio: n });
  ns.multicam = { angles: angles.map((a, i) => ({ name: a.name ?? `Angle ${i + 1}`, mediaId: a.mediaId })), syncedBy };
  const media = new Map(p.media.map((m) => [m.id, m]));
  const vts = tracksOf(ns, "video"), ats = tracksOf(ns, "audio");
  vts.forEach((t, i) => { if (angles[i]) t.name = angles[i].name?.slice(0, 24) ?? t.name; });
  // where each angle's used range starts on the shared clock
  const startS = angles.map((a) => {
    const m = media.get(a.mediaId);
    const f = m && m.fps > 0 ? m.fps : like.fps;
    return a.offset + (a.range?.in ?? 0) / f;
  });
  const t0 = Math.min(...startS);
  let s: Sequence = ns;
  const ctx = ctxOf(p);
  angles.forEach((a, i) => {
    const m = media.get(a.mediaId);
    if (!m) return;
    const at = Math.max(0, secondsToFrames(startS[i] - t0, like.fps));
    const cs = clipsFromMedia(s, m, at, { videoTrackId: m.kind !== "audio" ? vts[i].id : undefined, audioTrackId: ats[i].id, range: a.range ?? { in: undefined, out: undefined }, name: a.name ?? m.name });
    s = placeClips(s, ctx, cs, "overwrite");
  });
  return { project: { ...p, sequences: [...p.sequences, s] }, sequenceId: s.id };
}

/**
 * Puts a multicam clip (picture on `videoTrackId`, sound on `audioTrackId`, linked) at `at`, replacing `replace` (the
 * clips it was made from). It shows the multicam sequence from frame `in` for `duration` frames (default: all of it)
 * and starts on angle 0 for picture and sound. Only that stretch of the timeline is overwritten.
 */
export function placeMulticam(p: EditProject, seqId: string, mcId: string, at: number, videoTrackId: string | undefined, audioTrackId: string | undefined,
  replace: string[] = [], win: { in?: number; duration?: number } = {}): { project: EditProject; clipIds: string[] } {
  const seq = p.sequences.find((s) => s.id === seqId), mc = p.sequences.find((s) => s.id === mcId);
  if (!seq || !mc) return { project: p, clipIds: [] };
  const from = Math.max(0, Math.round(win.in ?? 0));
  const len = Math.max(1, Math.min(Math.round(win.duration ?? Infinity), seqEnd(mc) - from));
  const lid = videoTrackId && audioTrackId ? uid("l") : undefined;
  const made: TimelineClip[] = [];
  for (const tid of [videoTrackId, audioTrackId]) {
    if (!tid) continue;
    const c = baseClip(seq, tid, at, len, { type: "nested", sequenceId: mc.id, in: from }, mc.name, { width: mc.width, height: mc.height });
    c.multicam = { angle: 0, audioAngle: 0 };
    if (lid) c.linkId = lid;
    made.push(c);
  }
  const ctx = ctxOf(p);
  const without: Sequence = { ...seq, clips: seq.clips.filter((c) => !replace.includes(c.id)) };
  const s = placeClips(without, ctx, made, "overwrite");
  return { project: { ...p, sequences: p.sequences.map((x) => (x.id === seqId ? s : x)) }, clipIds: made.map((c) => c.id) };
}

/** Number of angles of a multicam clip (0 when it isn't one). */
export function angleCount(c: TimelineClip, ctx: Ctx): number {
  if (!c.multicam || c.source.type !== "nested") return 0;
  return ctx.sequence(c.source.sequenceId)?.multicam?.angles.length ?? 0;
}

/**
 * Switches the multicam clip under `frame` on a track to `angle` from `frame` on: the clip is cut there (unless the
 * frame is its first) and the right piece shows the new angle. `audio` switches the sound instead of the picture.
 */
export function switchAngle(seq: Sequence, ctx: Ctx, trackId: string, frame: number, angle: number, opts: { audio?: boolean } = {}): Sequence {
  const c = seq.clips.find((x) => x.trackId === trackId && x.multicam && x.start <= frame && frame < clipEnd(x));
  if (!c || trackById(seq, trackId)?.locked) return seq;
  const n = angleCount(c, ctx);
  if (angle < 0 || angle >= n) return seq;
  const key = opts.audio ? "audioAngle" : "angle";
  const cur = opts.audio ? c.multicam!.audioAngle ?? c.multicam!.angle : c.multicam!.angle;
  if (cur === angle) return seq;
  let s = seq;
  let target = c.id;
  if (frame > c.start) {
    const before = new Set(s.clips.map((x) => x.id));
    s = splitAt(s, ctx, [trackId], frame, new Set([c.id]));
    target = s.clips.find((x) => !before.has(x.id) && x.trackId === trackId && x.start === frame)?.id ?? c.id;
  }
  return normalize({ ...s, clips: s.clips.map((x) => {
    if (x.id !== target) return x;
    const y: TimelineClip = { ...x, multicam: { ...x.multicam!, [key]: angle } };
    // a cut on the picture is its own edit (the sound keeps running across it)
    if (!opts.audio && y.linkId && frame > c.start) delete y.linkId;
    return y;
  }) }, ctx);
}

/** The cuts of a multicam track as [frame, angle] pairs (the timeline's angle labels, tests). */
export const angleCuts = (seq: Sequence, trackId: string) => seq.clips.filter((c) => c.trackId === trackId && c.multicam).sort((a, b) => a.start - b.start)
  .map((c) => [c.start, c.multicam!.angle] as [number, number]);

/**
 * Flatten: every multicam clip (all, or `ids`) becomes the clips of its angle's track in the multicam sequence for its
 * window, trimmed to it, at the same place on the same track. The multicam clip's motion and effects carry over.
 */
export function flattenMulticam(p: EditProject, seqId: string, ids?: string[]): EditProject {
  const seq = p.sequences.find((s) => s.id === seqId) ?? activeSequence(p);
  if (!seq) return p;
  const ctx = ctxOf(p);
  const out: TimelineClip[] = [];
  const gone = new Set<string>();
  const links = new Map<string, string>();
  for (const c of seq.clips) {
    if (!c.multicam || c.source.type !== "nested" || (ids && !ids.includes(c.id))) continue;
    const mc = ctx.sequence(c.source.sequenceId);
    if (!mc?.multicam) continue;
    const kind = trackById(seq, c.trackId)?.kind ?? "video";
    const angle = kind === "audio" ? c.multicam.audioAngle ?? c.multicam.angle : c.multicam.angle;
    const track = tracksOf(mc, kind)[angle];
    if (!track) continue;
    gone.add(c.id);
    const a = Math.round(c.source.in), b = a + c.duration;
    for (const x0 of mc.clips) {
      if (x0.trackId !== track.id || clipEnd(x0) <= a || x0.start >= b) continue;
      const r = sourceRate(x0, mc, ctx);
      let x = x0;
      if (x.start < a) x = trimStartBy(x, a - x.start, r, mc.fps);
      if (clipEnd(x) > b) x = trimEndBy(x, b - clipEnd(x), r);
      const y: TimelineClip = { ...x, id: uid("c"), trackId: c.trackId, start: c.start + (x.start - a), effects: [...x.effects, ...c.effects.map((e) => ({ ...e, id: uid("e") }))] };
      if (!motionDefault(c, seq)) y.motion = c.motion;
      if (c.audio && kind === "audio") y.audio = c.audio;
      delete y.connectedTo; delete y.connectOffset;
      if (x0.linkId) y.linkId = links.get(`${x0.linkId}@${c.start}`) ?? (links.set(`${x0.linkId}@${c.start}`, uid("l")), links.get(`${x0.linkId}@${c.start}`)!); else delete y.linkId;
      out.push(y);
    }
  }
  if (!gone.size) return p;
  const s = normalize({ ...seq, clips: [...seq.clips.filter((c) => !gone.has(c.id)), ...out] }, ctx);
  return { ...p, sequences: p.sequences.map((x) => (x.id === seq.id ? s : x)) };
}

function motionDefault(c: TimelineClip, seq: Sequence): boolean {
  const m = c.motion;
  return !m.position.keyframes?.length && Math.abs(m.position.value[0] - seq.width / 2) < 0.5 && Math.abs(m.position.value[1] - seq.height / 2) < 0.5
    && !m.scale.keyframes?.length && m.scale.value === 100 && !m.rotation.keyframes?.length && m.rotation.value === 0 && !m.opacity.keyframes?.length && m.opacity.value === 100;
}
