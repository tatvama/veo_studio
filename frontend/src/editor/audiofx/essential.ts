/**
 * Essential Sound (docs/EDITOR.md §11.1): tag a clip Dialogue, Music, SFX or Ambience and get one-click controls,
 * each writing an ordinary audio effect instance (or the clip's own level keyframes), so nothing is hidden. Also the
 * maths behind "auto-duck" (level keyframes on music / ambience under dialogue) and "remix to length" (cut a music
 * clip on its beats so it ends with the sequence). Pure: no DOM.
 */
import { placeClips, type Ctx } from "../model/ops.ts";
import type { EffectInstance, Param, Sequence, TimelineClip } from "../model/types.ts";
import { audioFxId, type AudioParamValue, type SoundRole } from "./registry.ts";
import { makeAudioFx } from "./stack.ts";

export interface RoleControl {
  id: string; label: string; group: string;
  /** The effect it writes; "off" (0 or "off") removes it. */
  fx: string;
  kind: "amount" | "select";
  options?: { value: string; label: string }[];
  /** Values of the effect for a control value (amount 0..1, or the chosen option). */
  values(v: number | string): Record<string, AudioParamValue>;
  /** The control's value read back from the effect's values. */
  read(values: Record<string, unknown>): number | string;
}

const n = (x: unknown, d = 0) => (typeof x === "number" ? x : Number.isFinite(Number(x)) ? Number(x) : d);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const inv = (x: number, a: number, b: number) => Math.max(0, Math.min(1, (x - a) / (b - a)));

/** Our own clarity EQ looks (parametric EQ values). */
export const VOICE_EQ: Record<string, { label: string; values: Record<string, AudioParamValue> }> = {
  podcast: { label: "Podcast voice", values: { type1: "highpass", freq1: 80, q1: 0.707, gain2: -2, freq2: 300, gain4: 3, freq4: 3500, q4: 1.2 } },
  warm: { label: "Warm and close", values: { type1: "highpass", freq1: 60, q1: 0.707, gain2: 2, freq2: 200, gain5: -2, freq5: 7000 } },
  bright: { label: "Bright and clear", values: { type1: "highpass", freq1: 90, q1: 0.707, gain4: 2, freq4: 4000, type6: "highshelf", gain6: 3, freq6: 10000 } },
  radio: { label: "Broadcast presence", values: { type1: "highpass", freq1: 100, q1: 0.707, gain2: -3, freq2: 350, gain4: 4, freq4: 2800, q4: 1.4 } },
};

const amount = (id: string, label: string, group: string, fxId: string, values: (a: number) => Record<string, AudioParamValue>, read: (v: Record<string, unknown>) => number): RoleControl =>
  ({ id, label, group, fx: fxId, kind: "amount", values: (v) => values(n(v)), read });

export const CONTROLS: Record<string, RoleControl> = {
  noise: amount("noise", "Reduce noise", "Repair", "denoise", (a) => ({ amount: round(a) }), (v) => n(v.amount)),
  rumble: amount("rumble", "Reduce rumble", "Repair", "highpass", (a) => ({ frequency: Math.round(lerp(50, 150, a)), q: 0.707 }), (v) => inv(n(v.frequency, 80), 50, 150)),
  hum: { id: "hum", label: "De-hum", group: "Repair", fx: "dehum", kind: "select", options: [{ value: "off", label: "Off" }, { value: "50", label: "50 Hz" }, { value: "60", label: "60 Hz" }],
    values: (v) => ({ frequency: Number(v) || 50, harmonics: 4 }), read: (v) => String(n(v.frequency, 50)) },
  deess: amount("deess", "Reduce sibilance", "Repair", "deesser", (a) => ({ intensity: round(a), max: 0.5, frequency: 0.5 }), (v) => n(v.intensity)),
  dereverb: amount("dereverb", "Reduce reverb", "Repair", "dereverb", (a) => ({ amount: round(a) }), (v) => n(v.amount)),
  dynamics: amount("dynamics", "Dynamics", "Clarity", "compressor",
    (a) => ({ threshold: round(lerp(-12, -30, a), 1), ratio: round(lerp(1.5, 5, a), 1), attack: 0.005, release: 0.15, makeup: round(lerp(1, 8, a), 1), knee: 6 }), (v) => inv(n(v.ratio, 1.5), 1.5, 5)),
  eq: { id: "eq", label: "EQ", group: "Clarity", fx: "eq_param", kind: "select", options: [{ value: "off", label: "Off" }, ...Object.entries(VOICE_EQ).map(([value, x]) => ({ value, label: x.label }))],
    values: (v) => VOICE_EQ[String(v)]?.values ?? {}, read: (v) => Object.entries(VOICE_EQ).find(([, x]) => Object.entries(x.values).every(([k, y]) => v[k] === y))?.[0] ?? "podcast" },
  enhance: amount("enhance", "Enhance speech", "Clarity", "voice_enhance", (a) => ({ amount: round(a) }), (v) => n(v.amount)),
  reverb: { id: "reverb", label: "Reverb", group: "Creative", fx: "reverb", kind: "select",
    options: [{ value: "off", label: "Off" }, { value: "room", label: "Room" }, { value: "studio", label: "Studio" }, { value: "hall", label: "Concert hall" }, { value: "church", label: "Church" }, { value: "stage", label: "Stage" }],
    values: (v) => ({ preset: String(v), mix: 0.2 }), read: (v) => String(v.preset ?? "room") },
  reverbAmount: amount("reverbAmount", "Reverb amount", "Creative", "reverb", (a) => ({ mix: round(a) }), (v) => n(v.mix, 0.2)),
  width: amount("width", "Stereo width", "Ambience", "stereo_widen", (a) => ({ delay: 20, feedback: round(0.4 * a), crossfeed: round(0.3 * a), drymix: 0.8 }), (v) => inv(n(v.crossfeed), 0, 0.3)),
};

/** The controls each role shows, by group (the loudness, duck and remix actions sit beside them). */
export const ROLE_CONTROLS: Record<SoundRole, string[]> = {
  dialogue: ["noise", "rumble", "hum", "deess", "dereverb", "dynamics", "eq", "enhance", "reverb", "reverbAmount"],
  music: [],
  sfx: ["reverb", "reverbAmount"],
  ambience: ["width"],
};
/** The default loudness target per role (integrated LUFS). */
export const ROLE_LOUDNESS: Record<SoundRole, number> = { dialogue: -16, music: -20, sfx: -18, ambience: -26 };

const sameFx = (e: EffectInstance, fxId: string) => audioFxId(e.type) === fxId;

/** A control's current value on a clip's effects (0 / "off" when its effect isn't there or is off). */
export function readControl(effects: EffectInstance[], key: string): number | string {
  const c = CONTROLS[key];
  const e = effects.find((x) => sameFx(x, c.fx));
  if (!e || !e.enabled) return c.kind === "select" ? "off" : 0;
  return c.read(Object.fromEntries(Object.entries(e.params).map(([k, p]) => [k, p.value])));
}

/** Sets a control: updates (or adds) its effect; 0 / "off" removes it. Two controls may share one effect (reverb). */
export function setControl(effects: EffectInstance[], key: string, v: number | string): EffectInstance[] {
  const c = CONTROLS[key];
  const i = effects.findIndex((x) => sameFx(x, c.fx));
  const off = c.kind === "select" ? v === "off" : !(n(v) > 0);
  if (off) {
    // the amount of a shared effect going to 0 leaves it, at 0
    if (key === "reverbAmount" && i >= 0) return effects.map((e, k) => (k === i ? { ...e, params: { ...e.params, mix: { value: 0 } } } : e));
    return i >= 0 ? effects.filter((_, k) => k !== i) : effects;
  }
  const values = c.values(v);
  if (i < 0) return [...effects, makeAudioFx(c.fx, values)];
  return effects.map((e, k) => (k === i ? { ...e, enabled: true, params: { ...e.params, ...Object.fromEntries(Object.entries(values).map(([p, x]) => [p, { value: x }])) } } : e));
}

// ── auto-duck ───────────────────────────────────────────────────────────────────────────────────────────

/** Frame intervals [start, end) of a set of clips, merged where they touch or overlap (with `gap` frames of slack). */
export function mergeIntervals(list: [number, number][], gap = 0): [number, number][] {
  const s = [...list].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}

/**
 * Level keyframes (clip frames) for a clip ducked by `amountDb` under the dialogue intervals (sequence frames), with
 * `fade` frames of ramp on each side. The clip's own level stays the base; its old keyframes are replaced.
 */
export function duckKeyframes(clip: Pick<TimelineClip, "start" | "duration">, base: number, dialogue: [number, number][], amountDb: number, fade: number): Param<number> {
  const keys: { frame: number; value: number; ease: "linear" }[] = [];
  const lo = base - Math.abs(amountDb);
  const ivs = mergeIntervals(dialogue.map(([a, b]) => [a - clip.start, b - clip.start] as [number, number]), fade * 2)
    .filter(([a, b]) => b > -fade && a < clip.duration + fade);
  for (const [a, b] of ivs) {
    const pts: [number, number][] = [[a - fade, base], [a, lo], [b, lo], [b + fade, base]];
    for (const [f, v] of pts) {
      const fr = Math.round(f);
      if (fr < 0 || fr > clip.duration - 1) continue;
      if (!keys.some((k) => k.frame === fr)) keys.push({ frame: fr, value: v, ease: "linear" });
    }
    // ducked at the very start / end when the dialogue runs over the clip's edge
    if (a <= 0 && !keys.some((k) => k.frame === 0)) keys.push({ frame: 0, value: lo, ease: "linear" });
    if (b >= clip.duration && !keys.some((k) => k.frame === clip.duration - 1)) keys.push({ frame: clip.duration - 1, value: lo, ease: "linear" });
  }
  keys.sort((x, y) => x.frame - y.frame);
  return keys.length ? { value: base, keyframes: keys } : { value: base };
}

/** The dialogue a clip ducks under: clips tagged dialogue (or on a dialogue track), not the clip itself. */
export function dialogueIntervals(seq: Sequence, exceptId?: string): [number, number][] {
  const tr = new Map(seq.tracks.map((t) => [t.id, t]));
  return seq.clips.filter((c) => c.id !== exceptId && c.enabled && tr.get(c.trackId)?.kind === "audio" && (c.role ?? tr.get(c.trackId)?.role ?? guessRole(tr.get(c.trackId)?.name)) === "dialogue")
    .map((c) => [c.start, c.start + c.duration] as [number, number]);
}

/** A track's role from its name (as the export guesses it). */
export function guessRole(name = ""): SoundRole | undefined {
  if (/music|bgm|score/i.test(name)) return "music";
  if (/dialog|voice|\bvo\b|narrat|dub/i.test(name)) return "dialogue";
  if (/ambien|\bamb\b|room tone/i.test(name)) return "ambience";
  if (/sfx|\bfx\b|foley/i.test(name)) return "sfx";
  return undefined;
}

// ── remix to length ─────────────────────────────────────────────────────────────────────────────────────

export interface RemixPiece { from: number; to: number }
/**
 * Pieces of a music source [srcIn, srcEnd) (seconds) that, played one after the other, last `target` seconds and end
 * on the music's own ending, cut on beats: keep the intro up to a bar line, jump forward (shorter) or back (longer)
 * by whole bars, play out to the end. A target within half a beat of the length (or no beats) gives the source as is,
 * trimmed at its start. Jumps prefer bar lines (every 4th beat) in the middle half of the piece.
 */
export function remixPlan(beats: number[], srcIn: number, srcEnd: number, target: number): RemixPiece[] {
  const len = srcEnd - srcIn;
  const bs = beats.filter((b) => b >= srcIn - 1e-6 && b <= srcEnd + 1e-6).sort((a, b) => a - b);
  const beat = bs.length > 1 ? (bs[bs.length - 1] - bs[0]) / (bs.length - 1) : 0;
  if (target <= 0) return [];
  if (!beat || Math.abs(len - target) < beat / 2) return [{ from: Math.max(srcIn, srcEnd - target), to: srcEnd }];
  // bar lines (every 4th beat from the first), strictly inside the music
  const inner = (b: number) => b > srcIn + 1e-6 && b < srcEnd - 1e-6;
  const bars = bs.filter((b, i) => i % 4 === 0 && inner(b));
  const cands = bars.length >= 2 ? bars : bs.filter(inner);
  const keep = 4 * beat;                                   // the intro and the ending keep at least a bar
  const mid0 = srcIn + len * 0.25, mid1 = srcIn + len * 0.75;
  let best: { pieces: RemixPiece[]; trim: number } | null = null, bestScore = Infinity;
  const consider = (pieces: RemixPiece[], introEnd: number, cutA: number, cutB: number, extraPenalty = 0) => {
    const total = pieces.reduce((s, p) => s + (p.to - p.from), 0);
    const over = total - target;
    const cap = Math.max(0, introEnd - srcIn - keep);      // what can come off the intro's start
    const trim = over > 0 ? Math.min(over, cap) : 0;
    const resid = over > 0 ? over - trim : -over;
    // keep as much of the song's start as possible: trimming it costs half its length
    const penalty = (introEnd - srcIn < keep ? 2 * beat : 0) + (srcEnd - cutB < keep ? 2 * beat : 0) + (cutA < mid0 || cutB > mid1 ? 0.25 * beat : 0) + trim * 0.5 + extraPenalty;
    if (resid + penalty < bestScore) { bestScore = resid + penalty; best = { pieces, trim }; }
  };
  if (target < len) {
    // drop [a, b): the intro to a, then b to the end
    for (const a of cands) for (const b of cands) if (b > a) consider([{ from: srcIn, to: a }, { from: b, to: srcEnd }], a, a, b);
  } else {
    // repeat a section [a, b): the intro to b, back to a (as often as needed), then on to the end
    for (const a of cands) for (const b of cands) {
      if (b <= a + beat * 3.5) continue;
      const loop = b - a, times = Math.max(1, Math.round((target - len) / loop));
      consider([{ from: srcIn, to: b }, ...Array.from({ length: times - 1 }, () => ({ from: a, to: b })), { from: a, to: srcEnd }], b, a, b, times * 1e-3);
    }
  }
  if (!best) return [{ from: Math.max(srcIn, srcEnd - target), to: srcEnd }];
  const { pieces, trim } = best as { pieces: RemixPiece[]; trim: number };
  if (trim > 0) pieces[0] = { ...pieces[0], from: pieces[0].from + trim };
  return pieces.filter((p) => p.to - p.from > 1e-3);
}

/**
 * A music clip replaced by the remix pieces (source seconds), laid end to end from `endAt` backwards (so the last one
 * ends there: the sequence's end), with short constant-power crossfades at the cuts. Pure; the clip's other settings
 * (level, effects, role) carry over to each piece, and its level keyframes are dropped.
 */
export function remixClips(seq: Sequence, ctx: Ctx, clipId: string, pieces: RemixPiece[], mediaFps: number, endAt: number, fadeFrames = 4): Sequence {
  const c = seq.clips.find((x) => x.id === clipId);
  if (!c || c.source.type !== "media" || !pieces.length) return seq;
  const fps = seq.fps;
  const lens = pieces.map((p) => Math.max(1, Math.round((p.to - p.from) * fps)));
  const total = lens.reduce((s, x) => s + x, 0);
  let at = Math.max(0, endAt - total);
  const mediaId = c.source.mediaId;
  const made: TimelineClip[] = pieces.map((p, i) => {
    const x: TimelineClip = {
      ...c, id: i === 0 ? c.id : `${c.id}_r${i}`, start: at, duration: lens[i], speed: 1, reverse: false,
      source: { type: "media", mediaId, in: Math.round(p.from * mediaFps) },
      audio: c.audio ? { ...c.audio, gain: { value: c.audio.gain.value }, fadeIn: i === 0 ? c.audio.fadeIn : 0, fadeOut: i === pieces.length - 1 ? c.audio.fadeOut : 0 } : undefined,
    };
    delete x.linkId;
    at += lens[i];
    return x;
  });
  const cuts = made.slice(1).map((m, i) => ({
    id: `${c.id}_x${i + 1}`, trackId: c.trackId, at: m.start, duration: fadeFrames, alignment: "center" as const, type: "audio:constant_power", easing: "linear" as const,
    fromClipId: made[i].id, toClipId: m.id,
  }));
  const keepTr = seq.transitions.filter((t) => t.fromClipId !== c.id && t.toClipId !== c.id);
  // the pieces overwrite whatever else is on the track where they land
  const placed = placeClips({ ...seq, clips: seq.clips.filter((x) => x.id !== c.id), transitions: keepTr }, ctx, made, "overwrite");
  return { ...placed, transitions: [...placed.transitions, ...cuts] };
}
