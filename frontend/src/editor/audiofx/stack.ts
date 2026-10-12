/**
 * Audio effect stacks (docs/EDITOR.md §11): the effects of a clip, of a track (`Track.effects`) or of the master
 * (`Sequence.masterEffects`) as one addressable list, and the immutable edits the AudioEffects panel, the mixer and
 * the Essential Sound panel make to them. Clip lists keep their video effects in place. Pure: no DOM.
 */
import { uid } from "../model/ids.ts";
import { addGenerated, targetTracks, tracksOf, updateClips, type Ctx } from "../model/ops.ts";
import { addKeyframe, removeKeyframe, setParam, toggleStopwatch, valueAt } from "../model/params.ts";
import { secondsToFrames } from "../model/time.ts";
import type { EffectInstance, Param, Sequence, TimelineClip } from "../model/types.ts";
import { audioFxDef, audioFxDefaults, audioFxId, audioFxType, generatorDefaults, isAudioFxType, type AudioParamValue, type GeneratorKind } from "./registry.ts";

export type FxTarget = { kind: "clip"; clipId: string } | { kind: "track"; trackId: string } | { kind: "master" };
export const targetKey = (t: FxTarget) => (t.kind === "clip" ? `clip:${t.clipId}` : t.kind === "track" ? `track:${t.trackId}` : "master");

/** A new audio effect instance with its defaults (and `values` over them). */
export function makeAudioFx(id: string, values: Record<string, AudioParamValue> = {}): EffectInstance {
  const bare = audioFxId(id) ?? id;
  const params: Record<string, Param<unknown>> = {};
  for (const [k, v] of Object.entries({ ...audioFxDefaults(bare), ...values })) params[k] = { value: v };
  return { id: uid("e"), type: audioFxType(bare), enabled: true, params };
}

/** The whole list at a target (clips: every effect, the audio ones are the stack). */
export function fxList(seq: Sequence, t: FxTarget): EffectInstance[] {
  if (t.kind === "clip") return seq.clips.find((c) => c.id === t.clipId)?.effects ?? [];
  if (t.kind === "track") return seq.tracks.find((x) => x.id === t.trackId)?.effects ?? [];
  return seq.masterEffects ?? [];
}
/** Only the audio effects of a target, in order. */
export const audioStack = (seq: Sequence, t: FxTarget) => fxList(seq, t).filter((e) => isAudioFxType(e.type));

/** Replaces a target's list. */
export function withFx(seq: Sequence, ctx: Ctx, t: FxTarget, fn: (list: EffectInstance[]) => EffectInstance[]): Sequence {
  if (t.kind === "clip") return updateClips(seq, ctx, [t.clipId], (c) => ({ ...c, effects: fn(c.effects) }));
  if (t.kind === "track") return { ...seq, tracks: seq.tracks.map((x) => (x.id === t.trackId ? { ...x, effects: fn(x.effects ?? []) } : x)) };
  return { ...seq, masterEffects: fn(seq.masterEffects ?? []) };
}

/** The frame a target's keyframes are at for the program frame (clips: clip-relative). */
export function targetFrame(seq: Sequence, t: FxTarget, programFrame: number): number {
  if (t.kind !== "clip") return programFrame;
  const c = seq.clips.find((x) => x.id === t.clipId);
  return c ? Math.max(0, Math.min(c.duration - 1, programFrame - c.start)) : 0;
}

// ── list edits ──────────────────────────────────────────────────────────────────────────────────────────
export const fx = {
  /** Adds at the end of the audio effects (or before `before`). */
  add(list: EffectInstance[], e: EffectInstance, before?: string): EffectInstance[] {
    const i = before ? list.findIndex((x) => x.id === before) : -1;
    return i < 0 ? [...list, e] : [...list.slice(0, i), e, ...list.slice(i)];
  },
  remove: (list: EffectInstance[], id: string) => list.filter((e) => e.id !== id),
  toggle: (list: EffectInstance[], id: string, on?: boolean) => list.map((e) => (e.id === id ? { ...e, enabled: on ?? !e.enabled } : e)),
  /** Moves an effect one place among the audio effects (other effects keep their slots). */
  move(list: EffectInstance[], id: string, dir: -1 | 1): EffectInstance[] {
    const slots = list.map((e, i) => (isAudioFxType(e.type) ? i : -1)).filter((i) => i >= 0);
    const at = slots.findIndex((i) => list[i].id === id), to = at + dir;
    if (at < 0 || to < 0 || to >= slots.length) return list;
    const out = [...list];
    [out[slots[at]], out[slots[to]]] = [out[slots[to]], out[slots[at]]];
    return out;
  },
  /** Moves an effect to position `index` of the audio effects (drag to reorder). */
  moveTo(list: EffectInstance[], id: string, index: number): EffectInstance[] {
    const audio = list.filter((e) => isAudioFxType(e.type));
    const e = audio.find((x) => x.id === id);
    if (!e) return list;
    const rest = audio.filter((x) => x.id !== id);
    rest.splice(Math.max(0, Math.min(rest.length, index)), 0, e);
    let k = 0;
    return list.map((x) => (isAudioFxType(x.type) ? rest[k++] : x));
  },
  param(list: EffectInstance[], effectId: string, name: string, f: (p: Param<unknown>) => Param<unknown>): EffectInstance[] {
    return list.map((e) => {
      if (e.id !== effectId) return e;
      const def = audioFxDef(e.type)?.params.find((p) => p.name === name);
      const cur = e.params[name] ?? { value: def?.default ?? 0 };
      return { ...e, params: { ...e.params, [name]: f(cur) } };
    });
  },
  /** Sets a value: with the stopwatch on it keys `frame`, else the static value. */
  set: (list: EffectInstance[], effectId: string, name: string, v: unknown, frame: number) => fx.param(list, effectId, name, (p) => setParam(p, v, frame)),
  stopwatch: (list: EffectInstance[], effectId: string, name: string, frame: number) => fx.param(list, effectId, name, (p) => toggleStopwatch(p, frame)),
  keyframe: (list: EffectInstance[], effectId: string, name: string, frame: number, on: boolean) =>
    fx.param(list, effectId, name, (p) => (on ? addKeyframe(p, frame, valueAt(p, frame)) : removeKeyframe(p, frame))),
  /** A preset's values (static; keyframed params keep their keyframes only when the preset doesn't set them). */
  preset(list: EffectInstance[], effectId: string, values: Record<string, AudioParamValue>): EffectInstance[] {
    return list.map((e) => (e.id === effectId ? { ...e, params: { ...e.params, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }])) } } : e));
  },
  reset: (list: EffectInstance[], effectId: string) => list.map((e) => (e.id === effectId ? { ...makeAudioFx(e.type), id: e.id, enabled: e.enabled } : e)),
};

// ── generator clips ─────────────────────────────────────────────────────────────────────────────────────
export const GENERATOR_NAMES: Record<GeneratorKind, string> = { tone: "Tone", noise: "Noise", dtmf: "DTMF tones" };

/** A generator clip of `seconds` at `at` on an audio track (the targeted one, or the first). */
export function addGeneratorClip(seq: Sequence, ctx: Ctx, kind: GeneratorKind, at: number, trackId?: string, seconds = 5,
  values: Record<string, AudioParamValue> = {}): { seq: Sequence; clipId: string | null } {
  const tid = trackId && seq.tracks.find((t) => t.id === trackId && t.kind === "audio" && !t.locked) ? trackId : targetTracks(seq).audio?.id ?? tracksOf(seq, "audio")[0]?.id;
  if (!tid) return { seq, clipId: null };
  const params: Record<string, Param<unknown>> = {};
  for (const [k, v] of Object.entries({ ...generatorDefaults(kind), ...values })) params[k] = { value: v };
  const r = addGenerated(seq, ctx, tid, Math.max(0, Math.round(at)), Math.max(1, secondsToFrames(seconds, seq.fps)), { type: "generate", generator: kind, params }, GENERATOR_NAMES[kind]);
  return { seq: r.seq, clipId: r.clipId };
}

/** True for a clip whose sound the audio effects work on (media or a generator). */
export const hasSound = (c: TimelineClip | undefined) => !!c && (c.source.type === "media" || c.source.type === "generate");
