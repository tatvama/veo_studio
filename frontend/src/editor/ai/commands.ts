/**
 * Pure document work for the AI tools (docs/EDITOR.md §8): the sequence digest the edit assistant reads, its commands
 * as document changes (applied together as one undo step), captions as title cues, the source ranges a tool works on,
 * and the free analysis results (silences, scenes, beats, loudness) as cuts, markers and gain. Built on the editor's
 * model operations; no React and no I/O, so `node --test` runs it as written.
 */
import { defaultAudio, defaultTitle } from "../model/defaults.ts";
import { uid } from "../model/ids.ts";
import {
  addEffect, addGenerated, addMarker, addTrack, addTransition, clipAt, clipById, clipEnd, ctxOf, extract, gapAt, lift,
  moveClips, razor, removeClips, rippleDelete, seqEnd, setSpeed, sourceRate, trackById, tracksOf, updateClips, updateEffect,
  withLinked, type Ctx,
} from "../model/ops.ts";
import { fpsExact, framesToSeconds, secondsToFrames } from "../model/time.ts";
import type { EditProject, Marker, Sequence, TimelineClip, TitleSpec } from "../model/types.ts";
import type { AiCommand, AiCommandRow, Digest, Segment } from "./types.ts";

const r3 = (v: number) => Math.round(v * 1000) / 1000;
export const toSec = (frames: number, fps: number) => r3(framesToSeconds(frames, fps));
export const toFrames = (s: number, fps: number) => secondsToFrames(Math.max(0, s), fps);

const isAudioTrack = (seq: Sequence, c: TimelineClip) => trackById(seq, c.trackId)?.kind === "audio";
const unlockedIds = (seq: Sequence) => seq.tracks.filter((t) => !t.locked).map((t) => t.id);
const withSeq = (p: EditProject, seqId: string, s: Sequence): EditProject => ({ ...p, sequences: p.sequences.map((x) => (x.id === seqId ? s : x)) });
const seqOf = (p: EditProject, seqId: string) => p.sequences.find((s) => s.id === seqId);

// ── the digest ───────────────────────────────────────────────────────────────

/** The sequence as the assistant sees it: tracks, clips, markers, in/out and selection, in seconds. */
export function sequenceDigest(p: EditProject, seq: Sequence, selection: string[] = [],
  opts: { effects?: string[]; transitions?: string[] } = {}): Digest {
  const fps = seq.fps;
  const media = new Map(p.media.map((m) => [m.id, m]));
  return {
    name: seq.name.slice(0, 200), fps, width: seq.width, height: seq.height, duration: toSec(seqEnd(seq), fps), playhead: toSec(seq.playhead, fps),
    in_point: seq.inPoint !== undefined ? toSec(seq.inPoint, fps) : null,
    out_point: seq.outPoint !== undefined ? toSec(seq.outPoint + 1, fps) : null,
    tracks: seq.tracks.slice(0, 99).map((t) => ({ id: t.id, kind: t.kind, name: t.name.slice(0, 80), locked: t.locked })),
    clips: seq.clips.slice(0, 3000).map((c) => {
      const m = c.source.type === "media" ? media.get(c.source.mediaId) : undefined;
      return {
        id: c.id, track_id: c.trackId, start: toSec(c.start, fps), end: toSec(clipEnd(c), fps), name: (c.name || m?.name || "").slice(0, 200),
        kind: c.source.type, media_kind: m?.kind ?? "", has_audio: !!m && (m.kind === "audio" || m.hasAudio),
        text: c.source.type === "title" ? c.source.text.text.slice(0, 500) : "",
      };
    }),
    markers: seq.markers.slice(0, 1000).map((m) => ({ at: toSec(m.frame, fps), name: m.name.slice(0, 120) })),
    selection: selection.slice(0, 3000), effects: (opts.effects ?? []).slice(0, 500), transitions: (opts.transitions ?? []).slice(0, 500),
  };
}

// ── titles ───────────────────────────────────────────────────────────────────

const TITLE_BOX: Record<"top" | "center" | "lower_third" | "bottom", [number, number, number, number]> = {
  top: [0.08, 0.05, 0.84, 0.14], center: [0.1, 0.38, 0.8, 0.24], lower_third: [0.06, 0.68, 0.7, 0.14], bottom: [0.08, 0.8, 0.84, 0.13],
};

export function titleSpec(text: string, seq: Sequence, position: keyof typeof TITLE_BOX = "lower_third", size = 0): TitleSpec {
  return { ...defaultTitle(text), size: size > 0 ? size : Math.round(seq.height * (position === "center" ? 0.08 : 0.055)),
    box: TITLE_BOX[position], align: position === "lower_third" ? "left" : "center" };
}

/** The style captions get: smaller text near the bottom on a soft box, no animation. */
export function captionStyle(seq: Sequence): Partial<TitleSpec> {
  return { size: Math.round(seq.height * 0.045), weight: 600, box: [0.06, 0.8, 0.88, 0.13], align: "center",
    background: { color: "#000000a0", padding: 12, radius: 8 }, animIn: "none", animOut: "none" };
}

/** The top-most unlocked video track free over [a, b), else a new one on top. */
export function freeVideoTrack(seq: Sequence, a: number, b: number): { seq: Sequence; trackId: string } {
  for (const t of tracksOf(seq, "video").filter((x) => !x.locked).reverse()) {
    if (!seq.clips.some((c) => c.trackId === t.id && c.start < b && a < clipEnd(c))) return { seq, trackId: t.id };
  }
  return addTrack(seq, "video");
}

// ── the assistant's commands ─────────────────────────────────────────────────

/** One command on the project's sequence → the new project, or why it can't apply. */
export function applyCommand(p: EditProject, seqId: string, cmd: AiCommand): { project: EditProject; error?: string } {
  const seq = seqOf(p, seqId);
  if (!seq) return { project: p, error: "the sequence is gone" };
  const ctx: Ctx = ctxOf(p);
  const fps = seq.fps;
  const unlocked = unlockedIds(seq);
  const pick = (ids: string[]) => (ids.length ? ids.filter((id) => unlocked.includes(id)) : unlocked);
  const fail = (error: string) => ({ project: p, error });
  let s = seq;
  switch (cmd.op) {
    case "trim_to_duration": {
      const f = toFrames(cmd.seconds, fps), end = seqEnd(s);
      if (f >= end) return fail("the sequence is already that short");
      s = lift(s, ctx, f, end, unlocked);
      if (s.outPoint !== undefined && s.outPoint >= f) s = { ...s, outPoint: f - 1 };
      break;
    }
    case "add_markers": {
      let markers = s.markers;
      for (const m of cmd.markers) {
        markers = addMarker(markers, toFrames(m.at, fps), { name: m.name || "Marker", color: m.color || "#fbbf24", ...(m.comment ? { comment: m.comment } : {}) });
      }
      s = { ...s, markers };
      break;
    }
    case "remove_range": {
      const a = toFrames(cmd.start, fps), b = toFrames(cmd.end, fps);
      if (b <= a) return fail("the range is empty");
      s = cmd.ripple ? extract(s, ctx, a, b, pick(cmd.track_ids)) : lift(s, ctx, a, b, pick(cmd.track_ids));
      break;
    }
    case "split_at":
      s = razor(s, ctx, toFrames(cmd.at, fps), { trackIds: pick(cmd.track_ids) });
      break;
    case "move_clip": {
      const c = clipById(s, cmd.clip_id);
      if (!c) return fail("that clip is gone");
      const src = trackById(s, c.trackId)!;
      let dv = 0, da = 0;
      if (cmd.track_id) {
        const dest = trackById(s, cmd.track_id);
        if (!dest || dest.kind !== src.kind) return fail("that track can't take the clip");
        if (src.kind === "video") dv = dest.index - src.index; else da = dest.index - src.index;
      }
      const moved = moveClips(s, ctx, withLinked(s, [c.id]), toFrames(cmd.to, fps) - c.start, { video: dv, audio: da });
      if (moved === s) return fail("the clip can't move there");
      s = moved;
      break;
    }
    case "delete_clip": {
      if (!clipById(s, cmd.clip_id)) return fail("that clip is gone");
      const ids = withLinked(s, [cmd.clip_id]);
      s = cmd.ripple ? rippleDelete(s, ctx, ids) : removeClips(s, ctx, ids);
      break;
    }
    case "set_speed":
      if (!clipById(s, cmd.clip_id)) return fail("that clip is gone");
      s = setSpeed(s, ctx, withLinked(s, [cmd.clip_id]), cmd.speed);
      break;
    case "set_volume": {
      if (!clipById(s, cmd.clip_id)) return fail("that clip is gone");
      const ids = withLinked(s, [cmd.clip_id]).filter((id) => isAudioTrack(s, clipById(s, id)!));
      if (!ids.length) return fail("that clip has no sound on an audio track");
      s = updateClips(s, ctx, ids, (c) => ({ ...c, audio: { ...(c.audio ?? defaultAudio()), gain: { value: cmd.gain_db } } }));
      break;
    }
    case "add_title": {
      const a = toFrames(cmd.at, fps), d = Math.max(1, toFrames(cmd.duration, fps));
      const t = freeVideoTrack(s, a, a + d);
      s = addGenerated(t.seq, ctx, t.trackId, a, d, { type: "title", text: titleSpec(cmd.text, s, cmd.position, cmd.size) }, cmd.text.slice(0, 40)).seq;
      break;
    }
    case "add_transition": {
      const c = clipById(s, cmd.clip_id);
      if (!c) return fail("that clip is gone");
      const audio = isAudioTrack(s, c);
      const r = addTransition(s, ctx, c.trackId, cmd.edge === "in" ? c.start : clipEnd(c), audio ? "audio:constant_power" : cmd.type,
        Math.max(1, toFrames(cmd.duration, fps)), { side: cmd.edge === "in" ? "to" : "from" });
      if (!r.id) return fail("there is no room for a transition there");
      s = r.seq;
      break;
    }
    case "set_effect": {
      const c = clipById(s, cmd.clip_id);
      if (!c) return fail("that clip is gone");
      const params = Object.fromEntries(Object.entries(cmd.params ?? {}).map(([k, v]) => [k, { value: v as unknown }]));
      const have = c.effects.find((e) => e.type === cmd.effect);
      s = have
        ? updateEffect(s, ctx, c.id, have.id, (e) => ({ ...e, enabled: true, params: { ...e.params, ...params } }))
        : addEffect(s, ctx, [c.id], () => ({ id: uid("e"), type: cmd.effect, enabled: true, params }));
      break;
    }
    case "add_music":
    case "add_captions":
      return fail("this one runs a paid AI tool");
  }
  return { project: withSeq(p, seqId, s) };
}

/** The picked document commands, in order, on one project (paid ones are left to their tools). */
export function applyCommands(p: EditProject, seqId: string, rows: AiCommandRow[]): { project: EditProject; applied: string[]; skipped: { id: string; reason: string }[] } {
  let project = p;
  const applied: string[] = [], skipped: { id: string; reason: string }[] = [];
  for (const row of rows) {
    if (row.paid) continue;
    const out = applyCommand(project, seqId, row);
    if (out.error) skipped.push({ id: row.id, reason: out.error });
    else { project = out.project; applied.push(row.id); }
  }
  return { project, applied, skipped };
}

// ── what a tool works on ─────────────────────────────────────────────────────

/** A clip's part between timeline frames: where it plays and which seconds of its media that is. */
export interface SourcePart {
  clipId: string; mediaId: string; trackId: string; name: string;
  /** Timeline frames [tlStart, tlEnd). */
  tlStart: number; tlEnd: number;
  /** Seconds in the media. */
  srcStart: number; srcEnd: number;
  speed: number;
}

export function partOf(seq: Sequence, ctx: Ctx, c: TimelineClip, a = c.start, b = clipEnd(c)): SourcePart | null {
  if (c.source.type !== "media" || c.reverse) return null;
  const m = ctx.media(c.source.mediaId);
  if (!m) return null;
  const x = Math.max(a, c.start), y = Math.min(b, clipEnd(c));
  if (y <= x) return null;
  const r = sourceRate(c, seq, ctx);
  const mf = m.kind === "image" ? 1 : fpsExact(m.fps > 0 ? m.fps : seq.fps);
  const src = (f: number) => (m.kind === "image" ? 0 : r3((c.source.type === "media" ? c.source.in + (f - c.start) * r : 0) / mf));
  return { clipId: c.id, mediaId: m.id, trackId: c.trackId, name: c.name || m.name, tlStart: x, tlEnd: y, srcStart: src(x), srcEnd: src(y),
    speed: c.speed > 0 ? c.speed : 1 };
}

/** The clips with sound among `clipIds` (or under the range), one per linked A/V pair (the audio half when there is one). */
export function soundParts(p: EditProject, seq: Sequence, opts: { clipIds?: string[]; range?: [number, number] }): SourcePart[] {
  const ctx = ctxOf(p);
  const [a, b] = opts.range ?? [0, Infinity];
  const want = opts.clipIds?.length ? new Set(withLinked(seq, opts.clipIds)) : null;
  const sound = seq.clips.filter((c) => {
    if (!c.enabled || c.source.type !== "media" || c.reverse) return false;
    const m = ctx.media(c.source.mediaId);
    if (!m || !(m.kind === "audio" || m.hasAudio)) return false;
    if (want) return want.has(c.id);
    const t = trackById(seq, c.trackId);
    return !!t && !t.muted && c.start < b && a < clipEnd(c);
  });
  const groups = new Map<string, TimelineClip>();
  for (const c of sound) {
    const k = c.linkId ?? c.id, have = groups.get(k);
    if (!have || (!isAudioTrack(seq, have) && isAudioTrack(seq, c))) groups.set(k, c);
  }
  return [...groups.values()].map((c) => partOf(seq, ctx, c, a, b)).filter((x): x is SourcePart => !!x).sort((x, y) => x.tlStart - y.tlStart);
}

/** Video clips among `clipIds` (picture tools: extend, edit with words, upscale). */
export function videoParts(p: EditProject, seq: Sequence, clipIds: string[]): SourcePart[] {
  const ctx = ctxOf(p);
  return seq.clips.filter((c) => clipIds.includes(c.id) && !isAudioTrack(seq, c) && c.source.type === "media" && ctx.media(c.source.mediaId)?.kind === "video")
    .map((c) => partOf(seq, ctx, c)).filter((x): x is SourcePart => !!x);
}

/** Seconds of a result (counted from part.srcStart) → a timeline frame inside the part. */
export function partFrame(part: SourcePart, t: number, fps: number): number {
  const f = part.tlStart + Math.round((Math.max(0, t) / part.speed) * fpsExact(fps));
  return Math.max(part.tlStart, Math.min(part.tlEnd, f));
}

// ── captions ─────────────────────────────────────────────────────────────────

export type CaptionStyle = "lines" | "phrases";
export interface Cue { start: number; end: number; text: string }

/** Short phrases (up to 3 words, ~20 characters) from each line's word timings; lines without words stay whole. */
export function phrases(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    if (!s.words?.length) { out.push(s); continue; }
    let cur: { start: number; end: number; words: string[] } | null = null;
    for (const w of s.words) {
      if (cur && (cur.words.length >= 3 || (cur.words.join(" ") + " " + w.text).length > 20)) {
        out.push({ start: cur.start, end: cur.end, text: cur.words.join(" ") });
        cur = null;
      }
      if (!cur) cur = { start: w.start, end: w.end, words: [] };
      cur.words.push(w.text);
      cur.end = w.end;
    }
    if (cur) out.push({ start: cur.start, end: cur.end, text: cur.words.join(" ") });
  }
  return out;
}

/** Caption cues on the timeline (frames) for a transcript of `part` (its times count from part.srcStart). */
export function captionCues(segments: Segment[], part: SourcePart, fps: number, style: CaptionStyle = "lines"): Cue[] {
  const units = style === "phrases" ? phrases(segments) : segments;
  const minLen = Math.max(1, Math.round(fpsExact(fps) * 0.3));
  const cues: Cue[] = [];
  for (const u of units) {
    const text = u.text.trim();
    if (!text) continue;
    const start = partFrame(part, u.start, fps);
    let end = Math.max(partFrame(part, u.end, fps), Math.min(start + minLen, part.tlEnd));
    if (end <= start) continue;
    const prev = cues[cues.length - 1];
    if (prev && prev.end > start) prev.end = Math.max(prev.start + 1, start);
    end = Math.min(end, part.tlEnd);
    cues.push({ start, end, text });
  }
  return cues.filter((c) => c.end > c.start);
}

// ── sound ────────────────────────────────────────────────────────────────────

/** The audio halves of clips (themselves when on an audio track). */
export function soundClipIds(seq: Sequence, clipIds: string[]): string[] {
  return withLinked(seq, clipIds).filter((id) => { const c = clipById(seq, id); return !!c && isAudioTrack(seq, c); });
}

/** Mutes (disables) the sound of clips, keeping them on the timeline (a dub or a cleaned voice replaces it). */
export function muteSound(p: EditProject, seqId: string, clipIds: string[]): { project: EditProject; muted: number } {
  const seq = seqOf(p, seqId);
  if (!seq) return { project: p, muted: 0 };
  const ids = soundClipIds(seq, clipIds);
  if (!ids.length) return { project: p, muted: 0 };
  return { project: withSeq(p, seqId, updateClips(seq, ctxOf(p), ids, (c) => ({ ...c, enabled: false }))), muted: ids.length };
}

/** Clip gain change (dB) on the audio halves of clips. */
export function addGain(p: EditProject, seqId: string, clipIds: string[], db: number): EditProject {
  const seq = seqOf(p, seqId);
  if (!seq) return p;
  const ids = soundClipIds(seq, clipIds);
  return withSeq(p, seqId, updateClips(seq, ctxOf(p), ids, (c) => {
    const a = c.audio ?? defaultAudio();
    const g = Math.round(((a.gain.value ?? 0) + db) * 10) / 10;
    return { ...c, audio: { ...a, gain: a.gain.keyframes?.length ? { ...a.gain, value: g, keyframes: a.gain.keyframes.map((k) => ({ ...k, value: k.value + db })) } : { value: g } } };
  }));
}

/** The gain that brings a measured loudness to `target` LUFS without pushing the peak over `ceiling` dBFS. */
export function normaliseGain(lufs: number, peak: number, target = -14, ceiling = -1): number {
  if (!Number.isFinite(lufs)) return 0;
  let g = target - lufs;
  if (Number.isFinite(peak) && peak + g > ceiling) g = ceiling - peak;
  return Math.round(Math.max(-40, Math.min(24, g)) * 10) / 10;
}

// ── analysis results → edits ─────────────────────────────────────────────────

/** Sorted, merged [a, b) frame ranges. */
export function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}

/**
 * Silences (seconds in the media) inside a part → timeline ranges to cut: each keeps `padMs` of quiet on both sides,
 * and only pauses still at least `minMs` long are cut.
 */
export function silenceCuts(part: SourcePart, silences: { start: number; end: number }[], fps: number, padMs = 120, minMs = 300): [number, number][] {
  const pad = padMs / 1000;
  const out: [number, number][] = [];
  for (const s of silences) {
    const a = Math.max(s.start, part.srcStart) + (s.start > part.srcStart + 0.01 ? pad : 0);
    const b = Math.min(s.end, part.srcEnd) - (s.end < part.srcEnd - 0.01 ? pad : 0);
    if ((b - a) * 1000 < minMs) continue;
    const fa = partFrame(part, a - part.srcStart, fps), fb = partFrame(part, b - part.srcStart, fps);
    if (fb > fa) out.push([fa, fb]);
  }
  return mergeRanges(out);
}

/** Cuts the ranges out and closes the gaps (on the tracks, else every unlocked track: everything stays in sync). */
export function cutRanges(p: EditProject, seqId: string, ranges: [number, number][], trackIds?: string[]): EditProject {
  const seq = seqOf(p, seqId);
  if (!seq || !ranges.length) return p;
  const ctx = ctxOf(p);
  let s = seq;
  for (const [a, b] of mergeRanges(ranges).reverse()) s = extract(s, ctx, a, b, trackIds?.length ? trackIds : unlockedIds(seq));
  return withSeq(p, seqId, s);
}

/** Times (seconds in the media) → timeline frames strictly inside the part. */
export function partFrames(part: SourcePart, times: number[], fps: number): number[] {
  const out = new Set<number>();
  for (const t of times) {
    if (t <= part.srcStart || t >= part.srcEnd) continue;
    const f = partFrame(part, t - part.srcStart, fps);
    if (f > part.tlStart && f < part.tlEnd) out.add(f);
  }
  return [...out].sort((a, b) => a - b);
}

/** Splits a clip (and its linked halves) at the frames. */
export function splitClipAt(p: EditProject, seqId: string, clipId: string, frames: number[]): EditProject {
  const seq = seqOf(p, seqId);
  if (!seq || !clipById(seq, clipId)) return p;
  const ctx = ctxOf(p);
  let s = seq;
  for (const f of [...frames].sort((a, b) => b - a)) s = razor(s, ctx, f, { ids: [clipId] });  // the left piece keeps the id
  return withSeq(p, seqId, s);
}

/** Markers at frames (`{n}` in the name counts them); `kind` tells snapping what they are (beat, scene …). */
export function addSequenceMarkers(p: EditProject, seqId: string, frames: number[], name: string, color: string, kind?: Marker["kind"]): EditProject {
  const seq = seqOf(p, seqId);
  if (!seq) return p;
  let markers = seq.markers;
  frames.forEach((f, i) => { markers = addMarker(markers, f, { name: name.includes("{n}") ? name.replace("{n}", String(i + 1)) : name, color, ...(kind ? { kind } : {}) }); });
  return withSeq(p, seqId, { ...seq, markers });
}

// ── where a result goes ──────────────────────────────────────────────────────

/** Where generated B-roll goes: the gap at `frame` on the first unlocked video track that's empty there (or from
 *  `frame` on, `fallback` frames long, past its last clip); with every video track busy, a new track on top. */
export function brollSlot(seq: Sequence, frame: number, fallback: number): { trackId: string | null; start: number; end: number } {
  for (const t of tracksOf(seq, "video").filter((x) => !x.locked)) {
    if (clipAt(seq, t.id, frame)) continue;
    const g = gapAt(seq, t.id, frame);
    return g ? { trackId: t.id, start: g[0], end: g[1] } : { trackId: t.id, start: frame, end: frame + fallback };
  }
  return { trackId: null, start: frame, end: frame + fallback };
}

/** True when [a, b) is empty on the track. */
export const trackFree = (seq: Sequence, trackId: string, a: number, b: number) =>
  !seq.clips.some((c) => c.trackId === trackId && c.start < b && a < clipEnd(c));
