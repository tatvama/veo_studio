/**
 * What the audio tools do to the timeline (docs/EDITOR.md §15.4), as pure sequence edits (each tool runs one of these
 * as a single undo command):
 *  - Room-tone fill: the gaps between the cuts of a dialogue track get clips of a room-tone stretch of one recording,
 *    looped with short constant-power crossfades, faded in and out at the gap's edges, at the dialogue clip's level.
 *    They are normal clips marked `roomTone: true`, so "Remove room tone" can take them out again.
 *  - Breath remover: a clip's level with gain keyframes that dip under each breath, ramps inside the breath. Never a cut.
 * Pure.
 */
import { baseClip } from "../model/defaults.ts";
import { addTransition, clipEnd, normalize, removeClips, type Ctx } from "../model/ops.ts";
import { valueAt } from "../model/params.ts";
import { fpsExact, framesToSeconds } from "../model/time.ts";
import type { Keyframe, Param, Sequence, TimelineClip } from "../model/types.ts";

// ── room tone ──────────────────────────────────────────────────────────────────────────────────────────────

/** The empty stretches [from, to) between the clips of a track (not before the first or after the last); room tone ignored. */
export function trackGaps(seq: Sequence, trackId: string): [number, number][] {
  const cs = seq.clips.filter((c) => c.trackId === trackId && !c.roomTone).sort((a, b) => a.start - b.start);
  const out: [number, number][] = [];
  let end = cs.length ? clipEnd(cs[0]) : 0;
  for (let i = 1; i < cs.length; i++) {
    if (cs[i].start > end) out.push([end, cs[i].start]);
    end = Math.max(end, clipEnd(cs[i]));
  }
  return out;
}

/** Takes out the room tone a fill put on the track (every track when none is named). */
export function removeRoomTone(seq: Sequence, ctx: Ctx, trackId?: string): Sequence {
  const ids = seq.clips.filter((c) => c.roomTone && (!trackId || c.trackId === trackId)).map((c) => c.id);
  return ids.length ? removeClips(seq, ctx, ids) : seq;
}

export interface RoomToneFill {
  trackId: string; mediaId: string;
  /** The room-tone stretch, media seconds. */
  stretch: { start: number; end: number };
  /** The level (dB): the dialogue clip's own. */
  gainDb: number;
  /** Crossfade and edge-fade length in frames (default 30 ms, at least one frame). */
  fadeFrames?: number;
  name?: string;
}

/**
 * Fills every gap between the cuts of a track with the stretch, looped: each loop plays the stretch from its start
 * (plus the crossfade's lead-in), consecutive loops cross with a constant-power crossfade, and the first and last of
 * a gap fade in and out. A fill done before on the track is replaced. Returns the sequence and what was added.
 */
export function roomToneFill(seq: Sequence, ctx: Ctx, o: RoomToneFill): { seq: Sequence; clips: number; gaps: number; error?: string } {
  const m = ctx.media(o.mediaId);
  if (!m) return { seq, clips: 0, gaps: 0, error: "That media isn't in the edit" };
  const fps = seq.fps;
  const X = Math.max(1, o.fadeFrames ?? Math.round(0.03 * fpsExact(fps)));
  const pre = Math.floor(X / 2), post = X - pre;
  const lenF = Math.floor((o.stretch.end - o.stretch.start) * fpsExact(fps) + 1e-6);
  const maxPiece = lenF - pre - post;
  if (maxPiece < 2 * X + 2) return { seq, clips: 0, gaps: 0, error: "The room-tone stretch is too short" };
  let s = removeRoomTone(seq, ctx, o.trackId);
  const gaps = trackGaps(s, o.trackId);
  if (!gaps.length) return { seq: s, clips: 0, gaps: 0 };
  const mfps = m.fps > 0 ? m.fps : fps;
  const inF = Math.round((o.stretch.start + framesToSeconds(pre, fps)) * mfps);
  const made: TimelineClip[] = [];
  const cuts: number[] = [];
  for (const [g0, g1] of gaps) {
    let at = g0;
    const pieces: [number, number][] = [];
    while (at < g1) {
      const r = g1 - at;
      let L = r <= maxPiece ? r : r - maxPiece < 2 * X + 2 ? Math.ceil(r / 2) : maxPiece;
      L = Math.max(1, L);
      pieces.push([at, L]);
      at += L;
    }
    pieces.forEach(([a, L], i) => {
      const c = baseClip(s, o.trackId, a, L, { type: "media", mediaId: m.id, in: inF }, o.name ?? "Room tone");
      const edge = Math.min(X, Math.floor(L / 2));
      c.audio = { gain: { value: Math.round(o.gainDb * 100) / 100 }, pan: { value: 0 }, fadeIn: i === 0 ? edge : 0, fadeOut: i === pieces.length - 1 ? edge : 0 };
      c.roomTone = true;
      made.push(c);
      if (i > 0) cuts.push(a);
    });
  }
  s = normalize({ ...s, clips: [...s.clips, ...made] }, ctx);
  for (const at of cuts) s = addTransition(s, ctx, o.trackId, at, "audio:constant_power", X).seq;
  return { seq: s, clips: made.length, gaps: gaps.length };
}

// ── breaths ────────────────────────────────────────────────────────────────────────────────────────────────

/** "Mute": the level a muted breath gets (the preview treats −96 dB as silence). */
export const MUTE_DB = -96;

/** A breath in clip frames (fractional), and how many frames before and after it are free of speech (default: any). */
export interface BreathSpan { from: number; to: number; room?: [number, number] }

/**
 * A clip's level with each breath lowered by `amountDb` (or muted: MUTE_DB) over the whole breath, with ramps of
 * `rampFrames` just outside it where the speech around it leaves room (`room`), else just inside it, so the words
 * keep their level. Keyframes are whole frames: the low part covers every frame the breath touches. The clip's own
 * level and keyframes stay the base (keyframes inside a breath move down with it). A breath under two frames is left
 * alone; overlapping ones merge.
 */
export function breathGain(gain: Param<number>, ranges: BreathSpan[], amountDb: number | "mute", duration: number, rampFrames = 1): Param<number> {
  const regions: { a: number; a1: number; b1: number; b: number }[] = [];
  const last = duration - 1;
  for (const r of [...ranges].sort((x, y) => x.from - y.from)) {
    if (r.to - r.from < 2 - 1e-6) continue;
    const ramp = Math.max(1, rampFrames);
    const [before, after] = r.room ?? [Infinity, Infinity];
    // the start: low from the frame the breath begins in, the ramp before it if that stays clear of speech
    let a1 = Math.max(0, Math.floor(r.from + 1e-6)), a = a1 - ramp;
    if (a < 0 || r.from - a > before + 1e-6) { a = Math.max(0, Math.ceil(r.from - 1e-6)); a1 = a + ramp; }
    let b1 = Math.min(last, Math.ceil(r.to - 1e-6)), b = b1 + ramp;
    if (b > last || b - r.to > after + 1e-6) { b = Math.min(last, Math.floor(r.to + 1e-6)); b1 = b - ramp; }
    if (b1 < a1) { a1 = b1 = Math.round((a + b) / 2); }
    if (b - a < 2) continue;
    const prev = regions[regions.length - 1];
    if (prev && a <= prev.b) { prev.b1 = Math.max(prev.b1, b1); prev.b = Math.max(prev.b, b); continue; }
    regions.push({ a, a1, b1, b });
  }
  if (!regions.length) return gain;
  const low = (f: number) => regions.some((g) => f >= g.a1 && f <= g.b1);
  const frames = new Set<number>((gain.keyframes ?? []).map((k) => k.frame));
  for (const g of regions) { frames.add(g.a); frames.add(g.a1); frames.add(g.b1); frames.add(g.b); }
  const own = new Map((gain.keyframes ?? []).map((k) => [k.frame, k]));
  const keys: Keyframe<number>[] = [...frames].sort((x, y) => x - y).map((f) => {
    const base = valueAt(gain, f);
    const v = low(f) ? (amountDb === "mute" ? MUTE_DB : base - Math.abs(amountDb)) : base;
    const k = own.get(f);
    return k ? { ...k, value: Math.round(v * 100) / 100 } : { frame: f, value: Math.round(v * 100) / 100, ease: "linear" };
  });
  return { ...gain, keyframes: keys };
}

/**
 * Breath ranges (media seconds) → clip frames for a clip whose source starts at `inS` media seconds, with the room
 * to the speech before and after each (from the analysis' `speech`; none: any).
 */
export function breathsInClip(breaths: { start: number; end: number }[], clip: { duration: number; speed: number }, inS: number, fps: number,
  speech: { start: number; end: number }[] = []): BreathSpan[] {
  const sp = clip.speed > 0 ? clip.speed : 1;
  const f1 = framesToSeconds(1, fps);
  const fr = (t: number) => (t - inS) / sp / f1;
  return breaths.map((b) => {
    const prev = Math.max(-Infinity, ...speech.filter((x) => x.end <= b.start + 1e-6).map((x) => x.end));
    const next = Math.min(Infinity, ...speech.filter((x) => x.start >= b.end - 1e-6).map((x) => x.start));
    return { from: fr(b.start), to: fr(b.end), room: [Number.isFinite(prev) ? (b.start - prev) / sp / f1 : Infinity, Number.isFinite(next) ? (next - b.end) / sp / f1 : Infinity] as [number, number] };
  }).filter((r) => r.to > 0 && r.from < clip.duration);
}
