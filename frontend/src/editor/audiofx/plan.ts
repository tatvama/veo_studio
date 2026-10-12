/**
 * What the preview mixer needs beyond `toAudioMix`: each clip's audio effects (with keyframes), whether it needs the
 * render cache and its cache key, the crossfade curves of its transitions, the track and master effect chains, and
 * the generator clips (tone / noise / DTMF) of a sequence. Pure: no DOM.
 */
import { valueAt } from "../model/params.ts";
import { framesToSeconds } from "../model/time.ts";
import type { EditProject, EffectInstance, Param, Sequence, TimelineClip } from "../model/types.ts";
import { audioFxDef, audioFxId, resolveParams, transitionCurve, type AudioParamValue, type GeneratorKind } from "./registry.ts";
import { fadeGain } from "./dsp.ts";

export interface FxRef { key: string; id: string; effect: EffectInstance }

/** The enabled audio effects of a list, in order. */
export function audioFxOf(list: EffectInstance[] | undefined): FxRef[] {
  const out: FxRef[] = [];
  for (const e of list ?? []) {
    if (!e || e.enabled === false) continue;
    const id = audioFxId(e.type);
    if (id) out.push({ key: e.id, id, effect: e });
  }
  return out;
}

/** An effect's values at a frame (clip frames for clip effects, sequence frames for track / master ones). */
export function valuesAt(e: EffectInstance, id: string, frame: number): Record<string, AudioParamValue> {
  const raw: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(e.params ?? {})) raw[k] = p && typeof p === "object" && "value" in p ? valueAt(p as Param<unknown>, frame) : p;
  return resolveParams(id, raw);
}

export const isCacheFx = (r: FxRef) => audioFxDef(r.id)?.preview === "cache";

/** The cache key of a clip's sound: its source, trims, speed and effects (what the desktop's render hashes). */
export function clipCacheKey(c: TimelineClip): string {
  const src = c.source.type === "media" ? `${c.source.mediaId}@${c.source.in}` : c.source.type === "generate" ? `${c.source.generator}:${JSON.stringify(c.source.params)}` : c.source.type;
  const fx = audioFxOf(c.effects).map((r) => [r.id, r.effect.params]);
  return JSON.stringify([src, c.duration, c.speed, c.reverse, c.timeRemap ?? null, fx]);
}

export interface ClipFx {
  clipId: string; trackId: string;
  /** The clip's own start on the sequence (seconds; a crossfade's handle plays before it). */
  startS: number; fps: number;
  fx: FxRef[];
  /** Some enabled effect needs the render cache. */
  cache: boolean; key: string;
  /** acrossfade / afade curves of its incoming and outgoing transitions ("tri" for plain fades). */
  curveIn: string; curveOut: string;
}
export interface GeneratorClip {
  clipId: string; trackId: string; name: string; generator: GeneratorKind;
  /** Seconds on the sequence. */
  start: number; duration: number;
  values: Record<string, AudioParamValue>;
  /** dB (keyframes in clip seconds). */
  level: { value: number; keys: { t: number; v: number; ease: string }[] };
  gain: { value: number; keys: { t: number; v: number; ease: string }[] };
  pan: { value: number; keys: { t: number; v: number; ease: string }[] };
  fadeIn: number; fadeOut: number;
  fx: FxRef[];
}
export interface FxPlan { fps: number; clips: Map<string, ClipFx>; tracks: Map<string, FxRef[]>; master: FxRef[]; generators: GeneratorClip[] }

function keyed(p: Param<number> | undefined, fps: number, d: number) {
  if (!p) return { value: d, keys: [] };
  return { value: Number(p.value ?? d), keys: (p.keyframes ?? []).map((k) => ({ t: framesToSeconds(k.frame, fps), v: Number(k.value), ease: k.ease })) };
}

export function fxPlan(project: EditProject, seqId: string): FxPlan {
  const seq = project.sequences.find((s) => s.id === seqId) as Sequence | undefined;
  const plan: FxPlan = { fps: seq?.fps ?? 25, clips: new Map(), tracks: new Map(), master: [], generators: [] };
  if (!seq) return plan;
  const fps = seq.fps;
  const audioTracks = new Map(seq.tracks.filter((t) => t.kind === "audio").map((t) => [t.id, t]));
  const curves = new Map<string, { in?: string; out?: string }>();
  for (const x of seq.transitions) {
    if (!audioTracks.has(x.trackId) || !x.type.startsWith("audio:")) continue;
    const c = transitionCurve(x.type);
    const to = x.toClipId ?? seq.clips.find((k) => k.trackId === x.trackId && k.start === x.at)?.id;
    const from = x.fromClipId ?? seq.clips.find((k) => k.trackId === x.trackId && k.start + k.duration === x.at)?.id;
    if (to) curves.set(to, { ...curves.get(to), in: c });
    if (from) curves.set(from, { ...curves.get(from), out: c });
  }
  for (const t of seq.tracks) plan.tracks.set(t.id, audioFxOf(t.effects));
  plan.master = audioFxOf(seq.masterEffects);
  for (const c of seq.clips) {
    if (!c.enabled) continue;
    const fx = audioFxOf(c.effects);
    const cv = curves.get(c.id) ?? {};
    if (c.source.type === "generate") {
      if (!audioTracks.has(c.trackId)) continue;
      const vals: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(c.source.params ?? {})) vals[k] = p && typeof p === "object" && "value" in p ? (p.keyframes?.length ? p.keyframes[0].value : p.value) : p;
      const a = c.audio;
      plan.generators.push({
        clipId: c.id, trackId: c.trackId, name: c.name, generator: c.source.generator,
        start: framesToSeconds(c.start, fps), duration: framesToSeconds(c.duration, fps),
        values: vals as Record<string, AudioParamValue>, level: keyed(c.source.params?.level as Param<number> | undefined, fps, Number(vals.level ?? -18)),
        gain: keyed(a?.gain, fps, 0), pan: keyed(a?.pan, fps, 0),
        fadeIn: framesToSeconds(a?.fadeIn ?? 0, fps), fadeOut: framesToSeconds(a?.fadeOut ?? 0, fps), fx,
      });
      if (fx.length) plan.clips.set(c.id, { clipId: c.id, trackId: c.trackId, startS: framesToSeconds(c.start, fps), fps, fx, cache: fx.some(isCacheFx), key: clipCacheKey(c), curveIn: "tri", curveOut: "tri" });
      continue;
    }
    if (!fx.length && !cv.in && !cv.out) continue;
    plan.clips.set(c.id, {
      clipId: c.id, trackId: c.trackId, startS: framesToSeconds(c.start, fps), fps, fx,
      cache: fx.some(isCacheFx), key: clipCacheKey(c), curveIn: cv.in ?? "tri", curveOut: cv.out ?? "tri",
    });
  }
  return plan;
}

export interface GainPlan {
  duration: number;
  gain: { value: number; keys: { t: number; v: number; ease: string }[] };
  fadeIn: number; fadeOut: number;
  xIn?: { start: number; duration: number }; xOut?: { start: number; duration: number };
}
/** Clip keyframe values at t (the mix plan's sampleKeys, eased like the model). */
export function sampleAt(p: { value: number; keys: { t: number; v: number; ease: string }[] }, t: number): number {
  const ks = p.keys;
  if (!ks.length) return p.value;
  if (t <= ks[0].t) return ks[0].v;
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1], b = ks[i];
    if (t < b.t) {
      if (a.ease === "hold" || b.t <= a.t) return a.v;
      const x = (t - a.t) / (b.t - a.t);
      const e = a.ease === "ease_in" ? x * x * x : a.ease === "ease_out" ? 1 - (1 - x) ** 3 : a.ease === "ease_in_out" ? (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2) : x;
      return a.v + (b.v - a.v) * e;
    }
  }
  return ks[ks.length - 1].v;
}

/**
 * Linear gain of a clip at t seconds into it: level keyframes, fades and crossfades with the transitions' own curves
 * (acrossfade: a fade-in follows curve(q), a fade-out curve(1 − q)); `curveIn` / `curveOut` also shape edge fades.
 */
export function clipGainCurve(p: GainPlan, t: number, curveIn = "qsin", curveOut = "qsin", edgeIn = "tri", edgeOut = "tri"): number {
  let g = Math.pow(10, sampleAt(p.gain, t) / 20);
  if (p.fadeIn > 0 && t < p.fadeIn) g *= fadeGain(edgeIn, t / p.fadeIn);
  if (p.fadeOut > 0 && t > p.duration - p.fadeOut) g *= fadeGain(edgeOut, (p.duration - t) / p.fadeOut);
  if (p.xIn && t < p.xIn.start + p.xIn.duration) g *= fadeGain(curveIn, (t - p.xIn.start) / p.xIn.duration);
  if (p.xOut && t > p.xOut.start) g *= fadeGain(curveOut, 1 - (t - p.xOut.start) / p.xOut.duration);
  return g;
}
