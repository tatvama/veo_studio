/**
 * The sound of a Tatvam Editor export (docs/EDITOR.md §5, §11): one FFmpeg filtergraph from a sequence's audio clips.
 * Per clip: the source in/out (input seek + atrim), asetpts, reverse (areverse), speed (the atempo chain), the clip's
 * audio effects (editor-audiofx.ts: every §11 effect id), gain (static dB, or keyframes as a piecewise expression
 * evaluated per frame), pan (balance for stereo sources, constant power for mono), fades and crossfades (afade over
 * the transition with the transition's curve, the clips extended into their handles), then adelay to the clip's place
 * in the range. Generator clips (tone, noise, DTMF) read a lavfi source instead of a file. Track volume and pan add to
 * the clip's; muted tracks are skipped and, when any audio track is soloed, only soloed tracks play.
 *
 * Then the buses: each track's clips are summed (amix normalize=0) and run through the track's effects; dialogue
 * forms the dialogue bus, music and ambience the bus that is ducked under it with sidechaincompress (the clip's role,
 * else the track's, else a guess from the track name); everything is summed, through the sequence's master effects,
 * into a 48 kHz stereo float WAV. Long sequences mix each track in batches first. Loudness (`LOUDNESS`) is measured on
 * that WAV and normalised with a true-peak limiter (`normalizeArgs`) before the final mux.
 * Pure: returns argument lists. Unit tests: test/editor-audio.test.ts.
 */
import type {
  AudioRole, DuckingOptions, EditProject, Easing, GeneratorSpec, Keyframe, LoudnessPreset, MediaItem, Param, Sequence, TimelineClip, Track, Transition,
} from "../shared/types.ts";
import { buildFx, layChain, pwlExpr, type GraphStep } from "./editor-audiofx.ts";
import { hasRamp, keyPoints, rampPieces } from "./editor-curves.ts";
import type { IrPreset } from "./editor-irs.ts";
import { atempoChain } from "./render-args.ts";
import { fpsExact, framesToSeconds } from "./editor-model.ts";

export { pwlExpr } from "./editor-audiofx.ts";

export const MIX_RATE = 48000;
/** Clips per FFmpeg run (Windows' command line is 32k characters). */
export const MIX_BATCH = 40;

const f3 = (x: number) => (Math.round(x * 1000) / 1000).toFixed(3);
const f6 = (x: number) => (Math.round(x * 1e6) / 1e6).toString();
const num = (x: number) => String(Math.round(x * 1e6) / 1e6);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const db2lin = (db: number) => Math.pow(10, db / 20);
const lin = (db: number, lo: number, hi: number) => num(clamp(db2lin(db), lo, hi));

type Step = string | GraphStep;

/** One clip's sound, resolved: everything in seconds except where named. */
export interface MixClip {
  clipId: string;
  /** the source file, or "" for a generator (`lavfi`) */
  file: string;
  /** Mono sources pan with constant power, others as a balance. */
  channels: number;
  /** Where the clip starts on the sequence (seconds) and how long it plays there. */
  start: number;
  duration: number;
  /** Source seconds at the clip's start (the source region is [in, in + duration·speed]). */
  in: number;
  speed: number;
  reverse: boolean;
  /** dB: clip gain + track volume. With keyframes: points [t (clip seconds), dB] plus the track volume. */
  gainDb: number;
  gainPoints?: [number, number, Easing][];
  /** -1..1: clip pan + track pan (clamped); points as for gain. */
  pan: number;
  panPoints?: [number, number, Easing][];
  fadeIn: number;
  fadeOut: number;
  /** afade curve names (tri, qsin, exp, …) */
  fadeInCurve: string;
  fadeOutCurve: string;
  // ── additive (wave 3) ──
  /** the track it plays on, and its role on the buses */
  trackId?: string;
  role?: AudioRole | null;
  /** the clip's audio effects as chain steps (editor-audiofx.buildFx) */
  fx?: Step[];
  /** an effect changes the length (time stretch, trim silence): the chain cuts it back to the clip */
  fxLength?: boolean;
  /** a generator clip's lavfi source (tone / noise / DTMF), instead of `file` */
  lavfi?: string;
  /**
   * a speed ramp (TimelineClip.timeRemap): the clip's constant-speed pieces, each from its own region of the one input
   * (`in` is then the lowest source second any piece needs), joined with a 4 ms crossfade; freezes are silent
   */
  pieces?: MixPiece[];
  /** a nested sequence's sound: its clips mixed (with its tracks and master) first, then this clip's effects, gain, pan and fades */
  nested?: { clips: MixClip[]; tracks: MixTrack[]; master: Step[]; ducking: DuckSpec | null; t0: number };
}

/** One constant-speed piece of a ramped clip: `at` seconds from the clip's start, `dur` timeline seconds, from source second `in`. */
export interface MixPiece { at: number; dur: number; in: number; speed: number; reverse: boolean; fadeIn: number; fadeOut: number }

/** The crossfade between the pieces of a speed ramp (seconds). */
export const RAMP_XFADE = 0.004;

/** A track that has sound in the mix: its role and its own effects (on the track's sum). */
export interface MixTrack { id: string; name: string; role: AudioRole | null; fx: Step[] }

/** Ducking of the music / ambience bus under the dialogue bus (sidechaincompress). Threshold dB, times ms. */
export interface DuckSpec { threshold: number; ratio: number; attack: number; release: number }
export const DEFAULT_DUCK: DuckSpec = { threshold: -30, ratio: 8, attack: 20, release: 350 };

export interface MixPlan {
  clips: MixClip[]; range: { start: number; end: number }; warnings: string[];
  /** additive: tracks with sound, in order; the ducking (null: off, or not both dialogue and music / ambience); master effects */
  tracks?: MixTrack[];
  ducking?: DuckSpec | null;
  master?: Step[];
}

export interface MixOptions {
  ducking?: boolean | DuckingOptions;
  /** nested sequences being mixed (the recursion guard), and the label prefix of a nested plan (unique filter labels) */
  nesting?: string[];
  uidPrefix?: string;
  /** the built-in impulse response files (default: irs/<preset>.wav) */
  irFile?(preset: IrPreset): string;
}

/**
 * An audio transition's curve (afade / acrossfade names): constant_power → qsin (the default), constant_gain → tri,
 * exponential → exp; any other afade curve by its own name ("audio:log", "esin" …).
 */
export const AFADE_CURVES = ["tri", "qsin", "esin", "hsin", "log", "ipar", "qua", "cub", "squ", "cbr", "par", "exp", "iqsin", "ihsin", "dese", "desi", "losi",
  "sinc", "isinc", "quat", "quatr", "qsin2", "hsin2", "hsin2", "nofade"];
export function crossfadeCurve(type: string): string {
  const t = String(type ?? "").replace(/^audio:/i, "").toLowerCase();
  if (t === "constant_gain" || t === "linear" || t === "gain") return "tri";
  if (t === "exponential") return "exp";
  if (t === "constant_power" || t === "power" || t === "") return "qsin";
  return AFADE_CURVES.includes(t) ? t : /gain|linear|tri/.test(t) ? "tri" : "qsin";
}

function points<T extends number>(p: Param<T> | undefined, fps: number, shiftS: number): [number, number, Easing][] | undefined {
  const k = (p?.keyframes ?? []).filter((x): x is Keyframe<T> => Number.isFinite(x?.frame) && Number.isFinite(Number(x?.value)));
  if (k.length < 2) return undefined;
  // frames → seconds with the exact NTSC rational (framesToSeconds(f, fps) = f · den / num)
  const perFrame = framesToSeconds(1, fps);
  return keyPoints(k as unknown as Keyframe<number>[], 1 / perFrame, shiftS);
}

/** The value of a keyframed param where it has a single keyframe (or none): that keyframe, else the plain value. */
function staticOf(p: Param<number> | undefined, dflt: number): number {
  const k = p?.keyframes ?? [];
  if (k.length === 1 && Number.isFinite(Number(k[0].value))) return Number(k[0].value);
  return Number.isFinite(Number(p?.value)) ? Number(p!.value) : dflt;
}

const ROLES: AudioRole[] = ["dialogue", "music", "sfx", "ambience"];
const isRole = (v: unknown): v is AudioRole => typeof v === "string" && (ROLES as string[]).includes(v);

/** A track's role on the buses: `role`, else a guess from its name (Music / Dialogue / VO / SFX / Ambience …), else none. */
export function trackRole(t: Pick<Track, "name"> & { role?: unknown }): AudioRole | null {
  if (isRole(t.role)) return t.role;
  const n = String(t.name ?? "");
  if (/\b(music|bgm|score|songs?|soundtrack)\b/i.test(n)) return "music";
  if (/\b(dialog(ue)?s?|voice(over)?s?|vo|narrat\w*|speech|dub\w*|interviews?)\b/i.test(n)) return "dialogue";
  if (/\b(ambien\w*|amb|room ?tone|atmos?)\b/i.test(n)) return "ambience";
  if (/\b(sfx|fx|foley|effects?)\b/i.test(n)) return "sfx";
  return null;
}

// ── generator clips (§11.1: tone, noise, DTMF; params as the frontend registry's GENERATORS) ──
const DTMF: Record<string, [number, number]> = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477], A: [697, 1633], 4: [770, 1209], 5: [770, 1336], 6: [770, 1477], B: [770, 1633],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477], C: [852, 1633], "*": [941, 1209], 0: [941, 1336], "#": [941, 1477], D: [941, 1633],
};
const NOISE_COLOURS = ["white", "pink", "brown", "blue", "violet", "velvet"];

/**
 * A generator clip's lavfi source, `seconds` long, 48 kHz stereo (types.ts GeneratorSpec):
 *  - tone: aevalsrc (sine, square, sawtooth, triangle; a log or linear sweep from `frequency` to `sweepTo` when it is set)
 *  - noise: anoisesrc (color, amplitude = level, density for velvet, seed)
 *  - dtmf: aevalsrc, the two tones of each digit for `tone` ms, then `gap` ms of silence
 */
export function generatorSource(g: GeneratorSpec, seconds: number, warn: (msg: string) => void = () => undefined, fps = 25): string {
  const raw = (name: string): unknown => {
    const p = g.params?.[name];
    if (p && typeof p === "object") {
      const k = Array.isArray((p as Param<unknown>).keyframes) ? (p as Param<unknown>).keyframes! : [];
      if (k.length > 1 && name !== "level") warn(`${g.generator} ${name} keyframes aren't in the export: the first one is used`);
      return k.length ? k[0].value : (p as Param<unknown>).value;
    }
    return p;
  };
  const v = (name: string, d: number) => { const r0 = raw(name); const x = Number(r0); return r0 !== undefined && r0 !== null && r0 !== "" && Number.isFinite(x) ? x : d; };
  const s = (name: string, d: string) => { const r0 = raw(name); return typeof r0 === "string" && r0 ? r0 : d; };
  // level keyframes (dB, clip frames) as a gain expression of t
  const lp = g.params?.level;
  const lk = lp && typeof lp === "object" ? points(lp as Param<number>, fps, 0) : undefined;
  const levelExpr = (dflt: number) => (lk ? `pow(10,(${pwlExpr(lk.map(([t, x, e]) => [t, clamp(x, -90, 0), e]))})/20)` : num(Math.round(db2lin(clamp(v("level", dflt), -90, 0)) * 1e6) / 1e6));
  const d = num(Math.max(0.01, Math.round(seconds * 1000) / 1000));
  if (g.generator === "noise") {
    const c = s("color", "pink");
    const colour = NOISE_COLOURS.includes(c) ? c : "pink";
    const density = colour === "velvet" ? `:density=${num(clamp(v("density", 0.05), 0.001, 1))}` : "";
    const src = `anoisesrc=color=${colour}:amplitude=${lk ? 1 : lin(clamp(v("level", -24), -90, 0), 0, 1)}:r=48000:d=${d}:seed=${Math.max(0, Math.round(v("seed", 1)))}${density}`;
    return lk ? `${src},volume='${levelExpr(-24)}':eval=frame` : src;
  }
  if (g.generator === "dtmf") {
    const digits = s("digits", "0123456789*#").toUpperCase().replace(/[^0-9*#ABCD]/g, "").slice(0, 32) || "0";
    const tone = clamp(v("tone", 100), 20, 2000) / 1000;
    const gap = clamp(v("gap", 60), 0, 2000) / 1000;
    const a = `0.5*${levelExpr(-12)}`;
    const terms = [...digits].map((ch, i) => {
      const [lo, hi] = DTMF[ch];
      const t0 = i * (tone + gap);
      return `between(t,${f6(t0)},${f6(t0 + tone)})*(sin(2*PI*${lo}*t)+sin(2*PI*${hi}*t))`;
    });
    const e = `${a}*(${terms.join("+")})`;
    return `aevalsrc=exprs='${e}|${e}':s=48000:d=${d}`;
  }
  const wave = s("wave", "sine");
  const f = clamp(v("frequency", 1000), 1, 23000);
  const f1 = clamp(v("sweepTo", 0), 0, 23000);
  const a = levelExpr(-18);
  const T = Math.max(0.01, seconds);
  // the phase, in cycles: steady f·t; a log sweep f·T/k·(e^(k·t/T) − 1) with k = ln(f1/f); a linear one f·t + (f1 − f)·t²/2T
  let ph: string;
  if (f1 > 0 && Math.abs(f1 - f) > 1e-6 && s("sweep", "log") !== "linear") {
    const k = Math.log(f1 / f);
    ph = `(${num(f)}*${f6(T)}/${f6(k)}*(exp(t/${f6(T)}*${f6(k)})-1))`;
  } else if (f1 > 0 && Math.abs(f1 - f) > 1e-6) ph = `(${num(f)}*t+${f6((f1 - f) / (2 * T))}*t*t)`;
  else ph = `(${num(f)}*t)`;
  let e: string;
  if (wave === "square") e = `${a}*if(lt(mod(${ph},1),0.5),1,-1)`;
  else if (wave === "sawtooth") e = `${a}*(2*mod(${ph},1)-1)`;
  else if (wave === "triangle") e = `${a}*(4*abs(mod(${ph},1)-0.5)-1)`;
  else e = `${a}*sin(2*PI*${ph})`;
  return `aevalsrc=exprs='${e}|${e}':s=48000:d=${d}`;
}

/**
 * The audible clips of a sequence (pure): audio-track clips with media that has sound (or a generator), plus
 * video-track clips that carry `audio` settings and have no linked audio-track half. Crossfades on audio tracks extend
 * both clips into their handles and fade them over the transition with its curve; an edge transition fades that clip.
 */
export function mixPlan(project: EditProject, seq: Sequence, range: { in: number; out: number }, resolve?: (m: MediaItem) => string | null,
  opts: MixOptions = {}): MixPlan {
  const fps = seq.fps;
  const warnings: string[] = [];
  const irFile = opts.irFile ?? ((p: IrPreset) => `irs/${p}.wav`);
  const media = new Map(project.media.map((m) => [m.id, m]));
  const tracks = new Map(seq.tracks.map((t) => [t.id, t]));
  const audioTracks = seq.tracks.filter((t) => t.kind === "audio");
  const solo = audioTracks.some((t) => t.solo);
  const audible = (t: Track | undefined) => Boolean(t) && !t!.muted && (!solo || (t!.kind === "audio" && t!.solo));
  const linkedAudio = new Set(seq.clips.filter((c) => c.linkId && tracks.get(c.trackId)?.kind === "audio").map((c) => c.linkId));

  // per clip: timeline extension (frames) for crossfades, and transition fades (frames + curve)
  type Ext = { head: number; tail: number; fadeIn?: [number, string]; fadeOut?: [number, string] };
  const ext = new Map<string, Ext>();
  const getExt = (id: string) => { let e = ext.get(id); if (!e) { e = { head: 0, tail: 0 }; ext.set(id, e); } return e; };
  for (const tr of seq.transitions as Transition[]) {
    const t = tracks.get(tr.trackId);
    if (t?.kind !== "audio" || !(tr.duration > 0)) continue;
    const onTrack = seq.clips.filter((c) => c.trackId === tr.trackId && c.enabled !== false);
    const from = (tr.fromClipId && onTrack.find((c) => c.id === tr.fromClipId)) || onTrack.find((c) => c.start + c.duration === tr.at);
    const to = (tr.toClipId && onTrack.find((c) => c.id === tr.toClipId)) || onTrack.find((c) => c.start === tr.at);
    const d = Math.round(tr.duration);
    const a0 = tr.alignment === "start" ? tr.at : tr.alignment === "end" ? tr.at - d : tr.at - Math.floor(d / 2);
    const a1 = a0 + d;
    const curve = crossfadeCurve(tr.type);
    if (from && to) {
      const fe = getExt(from.id);
      fe.tail = Math.max(fe.tail, a1 - (from.start + from.duration));
      fe.fadeOut = [d, curve];
      const te = getExt(to.id);
      te.head = Math.max(te.head, to.start - a0);
      te.fadeIn = [d, curve];
    } else if (from) {
      getExt(from.id).fadeOut = [Math.min(d, from.duration), curve];
    } else if (to) {
      getExt(to.id).fadeIn = [Math.min(d, to.duration), curve];
    }
  }

  const out: MixClip[] = [];
  for (const c of seq.clips as TimelineClip[]) {
    const gen = c.source.type === "generate" ? (c.source as GeneratorSpec & { type: "generate" }) : null;
    const nest = c.source.type === "nested" ? (c.source as { sequenceId: string; in: number }) : null;
    if (c.enabled === false || (c.source.type !== "media" && !gen && !nest)) continue;
    const t = tracks.get(c.trackId);
    if (!t) continue;
    if (gen && t.kind !== "audio") continue;
    if (nest) {
      if (t.kind === "video" && (!c.audio || (c.linkId && linkedAudio.has(c.linkId)))) continue;
      if (!audible(t)) continue;
      const nc = nestedClip(project, seq, c, t, nest, range, resolve, { ...opts, irFile }, warnings, out.length);
      if (nc) out.push(nc);
      continue;
    }
    if (t.kind === "video" && (!c.audio || (c.linkId && linkedAudio.has(c.linkId)))) continue;
    if (!audible(t)) continue;
    let file = "";
    let channels = 2;
    let srcFps = fps;
    let inS = 0;
    if (!gen) {
      const m = media.get((c.source as { mediaId: string }).mediaId);
      if (!m || m.kind === "image" || !m.hasAudio) continue;
      const f = resolve ? resolve(m) : m.path;
      if (!f || m.missing || m.offline) {
        warnings.push(`${c.name}: its media is missing, so it is silent in the export`);
        continue;
      }
      file = f;
      channels = m.audioChannels ?? 2;
      srcFps = m.fps > 0 ? m.fps : fps;
      inS = (c.source as { in: number }).in / fpsExact(srcFps);
    }
    const ramped = !gen && hasRamp(c);
    const e = ext.get(c.id) ?? { head: 0, tail: 0 };
    const speed = gen ? 1 : clamp(Number(c.speed) || 1, 0.1, 16);
    const reverse = !gen && Boolean(c.reverse);
    // a head extension needs source before the in point (reversed clips can't extend backwards): clamp to what exists
    // (a ramped clip plays its own frames only: the transition still fades it)
    let head = reverse || ramped ? 0 : e.head;
    const headS = gen ? framesToSeconds(head, fps) : Math.min(framesToSeconds(head, fps), inS / speed);
    head = Math.round(headS * fpsExact(fps));
    const tail = reverse || ramped ? 0 : e.tail;
    const startF = c.start - head;
    const durF = c.duration + head + tail;
    const endF = startF + durF;
    if (endF <= range.in || startF >= range.out || durF <= 0) continue;
    const shift = framesToSeconds(head, fps);
    const a = c.audio;
    const trackVol = Number(t.volume) || 0;
    const trackPan = Number(t.pan) || 0;
    const gp = points(a?.gain, fps, shift);
    const pp = points(a?.pan, fps, shift);
    const fadeIn = Math.max(e.fadeIn?.[0] ?? 0, Number(a?.fadeIn) || 0);
    const fadeOut = Math.max(e.fadeOut?.[0] ?? 0, Number(a?.fadeOut) || 0);
    const duration = framesToSeconds(durF, fps);
    const fx = buildFx(c.effects ?? [], { uid: `${opts.uidPrefix ?? ""}x${out.length}`, duration, fps, shift, irFile, warn: (w) => warnings.push(`${c.name}: ${w}`),
      ...(file ? { source: { file } } : {}) });
    const mc: MixClip = {
      clipId: c.id, file, channels,
      start: framesToSeconds(startF, fps), duration,
      in: Math.max(0, inS - headS * speed), speed, reverse,
      gainDb: staticOf(a?.gain, 0) + trackVol,
      gainPoints: gp?.map(([s, v, ez]) => [s, v + trackVol, ez]),
      pan: clamp(staticOf(a?.pan, 0) + trackPan, -1, 1),
      panPoints: pp?.map(([s, v, ez]) => [s, clamp(v + trackPan, -1, 1), ez]),
      fadeIn: framesToSeconds(Math.min(fadeIn, durF), fps), fadeOut: framesToSeconds(Math.min(fadeOut, durF), fps),
      fadeInCurve: e.fadeIn && e.fadeIn[0] >= (Number(a?.fadeIn) || 0) ? e.fadeIn[1] : "tri",
      fadeOutCurve: e.fadeOut && e.fadeOut[0] >= (Number(a?.fadeOut) || 0) ? e.fadeOut[1] : "tri",
      trackId: t.id, role: isRole((c as { role?: unknown }).role) ? (c as { role: AudioRole }).role : trackRole(t), fx: fx.steps, fxLength: fx.changesLength,
    };
    if (gen) mc.lavfi = generatorSource(gen, duration, (w) => warnings.push(`${c.name}: ${w}`), fps);
    if (ramped) {
      const pieces = rampMixPieces(c, inS, speed, reverse, fps);
      if (!pieces.length) continue; // frozen throughout: silent
      mc.pieces = pieces;
      mc.in = Math.min(...pieces.map((x) => x.in));
    }
    out.push(mc);
  }
  out.sort((x, y) => x.start - y.start || x.clipId.localeCompare(y.clipId));
  const rs = framesToSeconds(range.in, fps);
  const used = new Set(out.map((c) => c.trackId));
  const order = [...seq.tracks].sort((x, y) => (x.kind === y.kind ? x.index - y.index : x.kind === "audio" ? -1 : 1));
  const mixTracks: MixTrack[] = order.filter((t) => used.has(t.id)).map((t, i) => ({ id: t.id, name: t.name, role: trackRole(t),
    fx: buildFx(t.effects ?? [], { uid: `${opts.uidPrefix ?? ""}t${i}`, duration: framesToSeconds(range.out - range.in, fps), fps, shift: -rs, irFile,
      warn: (w) => warnings.push(`${t.name}: ${w}`) }).steps }));
  const master = buildFx(seq.masterEffects ?? [], { uid: `${opts.uidPrefix ?? ""}m`, duration: framesToSeconds(range.out - range.in, fps), fps, shift: -rs, irFile,
    warn: (w) => warnings.push(`Master: ${w}`) }).steps;
  const roles = new Set(out.map((c) => c.role));
  const d = opts.ducking;
  const ducking = d === false || !roles.has("dialogue") || !(roles.has("music") || roles.has("ambience")) ? null : { ...DEFAULT_DUCK, ...duckOpts(d) };
  return { clips: out, range: { start: rs, end: framesToSeconds(range.out, fps) }, warnings, tracks: mixTracks, ducking, master };
}

/**
 * A ramped clip's pieces for the mix (editor-curves.rampPieces, the same pieces the engine draws): piece k plays
 * clip frames [from, to) at the clip's speed × its average ramp speed, from the source second the ramp has reached
 * there. Neighbouring pieces overlap by RAMP_XFADE with linear fades, so the joins don't click. Reversed clips read
 * the source backwards (each piece is reversed). Freezes are left out (silent).
 */
export function rampMixPieces(c: Pick<TimelineClip, "timeRemap" | "duration">, inS: number, speed: number, reverse: boolean, fps: number): MixPiece[] {
  const F = fpsExact(fps);
  const ps = rampPieces(c);
  const last = ps[ps.length - 1];
  const total = (speed * (last.offset + last.speed * (last.to - last.from))) / F; // source seconds the whole clip uses
  const X = RAMP_XFADE;
  const out: MixPiece[] = [];
  ps.forEach((pc, k) => {
    if (pc.freeze) return;
    const v = speed * pc.speed;
    const prev = ps[k - 1];
    const next = ps[k + 1];
    const e0 = prev && !prev.freeze ? X / 2 : 0;
    const e1 = next && !next.freeze ? X / 2 : 0;
    const dur = (pc.to - pc.from) / F;
    const s0 = (speed * pc.offset) / F; // source seconds used before the piece
    const lo = reverse ? inS + total - s0 - (dur + e1) * v : inS + s0 - e0 * v;
    const len = (dur + e0 + e1) * v;
    const start = Math.max(0, lo);
    out.push({ at: Math.max(0, pc.from / F - e0), dur: dur + e0 + e1 - (start - lo) / v, in: start, speed: v, reverse, fadeIn: e0 > 0 ? X : 0, fadeOut: e1 > 0 ? X : 0 });
    if (len <= 0) out.pop();
  });
  return out;
}

/**
 * A nested clip's sound: the nested sequence mixed over the clip's window (its own tracks, effects, master and
 * ducking), then the clip's effects, gain, pan and fades on top. A multicam clip hears only its audio angle (audio
 * track `audioAngle`, else `angle`, of the multicam sequence). Speed and reverse don't apply to nested sound (a warning).
 */
function nestedClip(project: EditProject, seq: Sequence, c: TimelineClip, t: Track, nest: { sequenceId: string; in: number }, range: { in: number; out: number },
  resolve: ((m: MediaItem) => string | null) | undefined, opts: MixOptions, warnings: string[], index: number): MixClip | null {
  const fps = seq.fps;
  const sub = project.sequences.find((x) => x.id === nest.sequenceId);
  const chain = [...(opts.nesting ?? []), seq.id];
  if (!sub) { warnings.push(`${c.name}: its nested sequence is missing`); return null; }
  if (chain.includes(sub.id) || chain.length > 6) { warnings.push(`${c.name}: the nested sequence contains itself, so its sound is left out`); return null; }
  const startF = c.start;
  const endF = c.start + c.duration;
  if (endF <= range.in || startF >= range.out || c.duration <= 0) return null;
  if (Math.abs((Number(c.speed) || 1) - 1) > 1e-4 || c.reverse) warnings.push(`${c.name}: the speed / reverse of a nested sequence isn't applied to its sound`);
  let nseq = sub;
  if (c.multicam && sub.multicam) {
    const angle = Math.max(0, Math.round(c.multicam.audioAngle ?? c.multicam.angle));
    const at = sub.tracks.filter((x) => x.kind === "audio").sort((a, b) => a.index - b.index)[angle];
    nseq = { ...sub, tracks: at ? [{ ...at, muted: false, solo: false }] : [], clips: at ? sub.clips.filter((x) => x.trackId === at.id) : [], transitions: [] };
    if (!at) warnings.push(`${c.name}: the multicam sequence has no audio for angle ${angle + 1}`);
  }
  const nIn = Math.max(0, Math.round(nest.in));
  const nDur = Math.max(1, Math.round((c.duration * nseq.fps) / fps));
  const plan = mixPlan(project, nseq, { in: nIn, out: nIn + nDur }, resolve, { ...opts, nesting: chain, uidPrefix: `${opts.uidPrefix ?? ""}n${index}_` });
  warnings.push(...plan.warnings.map((w) => `${c.name} › ${w}`));
  if (!plan.clips.length) return null;
  const a = c.audio;
  const trackVol = Number(t.volume) || 0;
  const trackPan = Number(t.pan) || 0;
  const gp = points(a?.gain, fps, 0);
  const pp = points(a?.pan, fps, 0);
  const duration = framesToSeconds(c.duration, fps);
  const fx = buildFx(c.effects ?? [], { uid: `${opts.uidPrefix ?? ""}x${index}`, duration, fps, shift: 0, irFile: opts.irFile ?? ((p) => `irs/${p}.wav`),
    warn: (w) => warnings.push(`${c.name}: ${w}`) });
  return {
    clipId: c.id, file: "", channels: 2, start: framesToSeconds(startF, fps), duration, in: 0, speed: 1, reverse: false,
    gainDb: staticOf(a?.gain, 0) + trackVol, gainPoints: gp?.map(([s0, v, ez]) => [s0, v + trackVol, ez]),
    pan: clamp(staticOf(a?.pan, 0) + trackPan, -1, 1), panPoints: pp?.map(([s0, v, ez]) => [s0, clamp(v + trackPan, -1, 1), ez]),
    fadeIn: framesToSeconds(Math.min(Number(a?.fadeIn) || 0, c.duration), fps), fadeOut: framesToSeconds(Math.min(Number(a?.fadeOut) || 0, c.duration), fps),
    fadeInCurve: "tri", fadeOutCurve: "tri", trackId: t.id, role: isRole((c as { role?: unknown }).role) ? (c as { role: AudioRole }).role : trackRole(t),
    fx: fx.steps, fxLength: fx.changesLength,
    nested: { clips: plan.clips, tracks: plan.tracks ?? [], master: plan.master ?? [], ducking: plan.ducking ?? null, t0: plan.range.start },
  };
}

function duckOpts(d: boolean | DuckingOptions | undefined): Partial<DuckSpec> {
  if (!d || typeof d !== "object") return {};
  const o: Partial<DuckSpec> = {};
  if (Number.isFinite(d.threshold)) o.threshold = clamp(Number(d.threshold), -60, 0);
  if (Number.isFinite(d.ratio)) o.ratio = clamp(Number(d.ratio), 1, 20);
  if (Number.isFinite(d.attack)) o.attack = clamp(Number(d.attack), 0.01, 2000);
  if (Number.isFinite(d.release)) o.release = clamp(Number(d.release), 0.01, 9000);
  return o;
}

/** Left/right gains for a pan position: balance for stereo, constant power (unity at the centre) for mono sources. */
export function panGains(p: number, mono: boolean): [number, number] {
  if (mono) {
    const th = ((clamp(p, -1, 1) + 1) * Math.PI) / 4;
    return [Math.cos(th) * Math.SQRT2, Math.sin(th) * Math.SQRT2];
  }
  return [p > 0 ? 1 - p : 1, p < 0 ? 1 + p : 1];
}

function panExprs(pts: [number, number, Easing][], mono: boolean): [string, string] {
  const P = `(${pwlExpr(pts)})`;
  if (mono) return [`cos((${P}+1)*PI/4)*sqrt(2)`, `sin((${P}+1)*PI/4)*sqrt(2)`];
  return [`if(gt(${P},0),1-${P},1)`, `if(lt(${P},0),1+${P},1)`];
}

/**
 * The filter chain of one clip (input label → output label), relative to the range start `t0` (seconds). One chain
 * `[in]…[out]`, or several statements joined by ";" when an effect needs a small graph (reverb, vinyl …).
 */
export function clipChain(c: MixClip, input: string | string[], label: string, t0: number): string {
  if (c.pieces?.length) {
    const ins = Array.isArray(input) ? input : [input];
    return [...piecesGraph(c, ins, label), ...layChain(`${label}r`, [], c.fx ?? [], postChain(c, t0), label, label)].join(";");
  }
  if (Array.isArray(input)) input = input[0];
  const src = c.duration * c.speed;
  const head: string[] = ["aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo", `atrim=0:${f6(src)}`, "asetpts=PTS-STARTPTS"];
  if (c.reverse) head.push(`apad=whole_dur=${f6(src)}`, "areverse");
  if (Math.abs(c.speed - 1) > 1e-4) head.push(atempoChain(c.speed));
  return layChain(input, head, c.fx ?? [], postChain(c, t0), label, label).join(";");
}

/**
 * A ramped clip's pieces, each from its own input (seeked to the piece: one shared input split and trimmed can stall
 * FFmpeg's scheduler next to other inputs), re-timed / reversed, faded at the joins and placed, summed into `<label>r`.
 */
function piecesGraph(c: MixClip, inputs: string[], label: string): string[] {
  const ps = c.pieces!;
  const st: string[] = [];
  const outs = ps.map((_, k) => `${label}q${k}`);
  ps.forEach((p, k) => {
    const len = p.dur * p.speed;
    const f = ["aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo", `atrim=0:${f6(len)}`, "asetpts=PTS-STARTPTS"];
    if (p.reverse) f.push(`apad=whole_dur=${f6(len)}`, "areverse");
    if (Math.abs(p.speed - 1) > 1e-4) f.push(atempoChain(p.speed));
    if (p.fadeIn > 0) f.push(`afade=t=in:st=0:d=${f6(p.fadeIn)}:curve=tri`);
    if (p.fadeOut > 0) f.push(`afade=t=out:st=${f6(Math.max(0, p.dur - p.fadeOut))}:d=${f6(p.fadeOut)}:curve=tri`);
    const delay = Math.round(p.at * MIX_RATE);
    if (delay > 0) f.push(`adelay=${delay}S|${delay}S`);
    st.push(`[${inputs[k] ?? inputs[0]}]${f.join(",")}[${outs[k]}]`);
  });
  const sum = ps.length > 1 ? `${outs.map((x) => `[${x}]`).join("")}amix=inputs=${ps.length}:${AMIX}` : `[${outs[0]}]anull`;
  st.push(`${sum},apad=whole_dur=${f6(c.duration)},atrim=0:${f6(c.duration)}[${label}r]`);
  return st;
}

/** After the clip's effects: the length kept, gain, pan, fades, and the place in the range. */
function postChain(c: MixClip, t0: number): string[] {
  const tail: string[] = [];
  if (c.fxLength) tail.push(`apad=whole_dur=${f6(c.duration)}`, `atrim=0:${f6(c.duration)}`);
  if (c.gainPoints) tail.push(`volume='pow(10,(${pwlExpr(c.gainPoints)})/20)':eval=frame`);
  else if (Math.abs(c.gainDb) > 1e-6) tail.push(`volume=${num(c.gainDb)}dB`);
  const mono = c.channels === 1;
  if (c.panPoints) {
    const [l, r] = panExprs(c.panPoints, mono);
    tail.push(`aeval=exprs='val(0)*${l}|val(1)*${r}':c=stereo`);
  } else if (Math.abs(c.pan) > 1e-6 || mono) {
    const [l, r] = panGains(c.pan, mono);
    if (Math.abs(l - 1) > 1e-6 || Math.abs(r - 1) > 1e-6) tail.push(`pan=stereo|c0=${num(l)}*c0|c1=${num(r)}*c1`);
  }
  if (c.fadeIn > 0) tail.push(`afade=t=in:st=0:d=${f3(c.fadeIn)}:curve=${c.fadeInCurve}`);
  if (c.fadeOut > 0) tail.push(`afade=t=out:st=${f3(Math.max(0, c.duration - c.fadeOut))}:d=${f3(c.fadeOut)}:curve=${c.fadeOutCurve}`);
  const rel = c.start - t0;
  if (rel < 0) tail.push(`atrim=start=${f6(-rel)}`, "asetpts=PTS-STARTPTS");
  const delay = Math.round(Math.max(0, rel) * MIX_RATE);
  if (delay > 0) tail.push(`adelay=${delay}S|${delay}S`);
  return tail;
}

/** Input options of one clip: seek to its source region (with a little margin for reversed / stretched sources). */
export function clipInput(c: MixClip): string[] {
  return clipInputs(c).flat();
}

/** One argument list per input: a ramped clip has one per piece (each seeked to its own source region). */
export function clipInputs(c: MixClip): string[][] {
  if (c.lavfi) return [["-f", "lavfi", "-i", c.lavfi]];
  if (c.pieces?.length) return c.pieces.map((p) => ["-ss", f6(p.in), "-t", f6(p.dur * p.speed + 0.05), "-i", c.file]);
  return [["-ss", f6(c.in), "-t", f6(c.duration * c.speed + 0.05), "-i", c.file]];
}

/** How many inputs a clip needs (a ramped clip: one per piece; a nested clip: all of its own clips'). */
export const inputCount = (c: MixClip): number => (c.nested ? c.nested.clips.reduce((n, x) => n + inputCount(x), 0) : c.pieces?.length || 1);

/**
 * One clip as inputs and statements: a plain clip is its input and chain; a nested clip mixes its own clips first
 * (inputs appended to `args`), sums them through its buses into `<label>sum`, then runs its own chain on that.
 */
export function unitGraph(c: MixClip, label: string, t0: number, args: string[], g: string[]): void {
  if (!c.nested) {
    const labels = clipInputs(c).map((a) => {
      const idx = args.filter((x) => x === "-i").length;
      args.push(...a);
      return `${idx}:a`;
    });
    g.push(clipChain(c, labels.length > 1 ? labels : labels[0], label, t0));
    return;
  }
  const n = c.nested;
  const units = n.clips.map((x, j) => {
    const l = `${label}n${j}`;
    unitGraph(x, l, n.t0, args, g);
    return { label: l, trackId: x.trackId, role: x.role };
  });
  const sum = busGraph(units, n.tracks, n.ducking, g, n.master, `${label}_`);
  g.push(`${sum},atrim=0:${f6(c.duration)}[${label}sum]`);
  g.push(...layChain(`${label}sum`, [], c.fx ?? [], postChain(c, t0), label, label));
}


const AMIX = "normalize=0:duration=longest:dropout_transition=0";
const DUCKED: (AudioRole | null | undefined)[] = ["music", "ambience"];

/**
 * The buses (pure): `units` are labels already in the graph (clip chains or summed parts), each on a track with a
 * role. Per track (and role): the sum and the track's effects; the dialogue bus, and the music + ambience bus ducked
 * under it; the master sum through the master effects, with apad. Returns the master expression (to be followed by
 * `[label]` or more filters) and appends the other statements to `g`.
 */
export function busGraph(units: { label: string; trackId?: string; role?: AudioRole | null }[], tracks: MixTrack[], ducking: DuckSpec | null, g: string[],
  master: Step[] = [], prefix = ""): string {
  const outs: { label: string; role: AudioRole | null }[] = [];
  const known = new Map(tracks.map((t) => [t.id, t]));
  const order: MixTrack[] = [...tracks];
  for (const u of units) {
    const id = u.trackId ?? "";
    if (!known.has(id)) { const t: MixTrack = { id, name: id, role: u.role ?? null, fx: [] }; known.set(id, t); order.push(t); }
  }
  order.forEach((t, ti) => {
    const mine = units.filter((u) => (u.trackId ?? "") === t.id);
    const roles = [...new Set(mine.map((u) => u.role ?? null))];
    roles.forEach((role, ri) => {
      const ls = mine.filter((u) => (u.role ?? null) === role).map((u) => `[${u.label}]`);
      const name = roles.length > 1 ? `${prefix}t${ti}r${ri}` : `${prefix}t${ti}`;
      if (ls.length === 1 && !t.fx.length) { outs.push({ label: ls[0], role }); return; }
      const simple = t.fx.every((s) => typeof s === "string");
      if (ls.length > 1 && simple) {
        g.push(`${[`${ls.join("")}amix=inputs=${ls.length}:${AMIX}`, ...(t.fx as string[])].join(",")}[${name}]`);
      } else {
        let from = ls[0].slice(1, -1);
        if (ls.length > 1) { from = `${name}s`; g.push(`${ls.join("")}amix=inputs=${ls.length}:${AMIX}[${from}]`); }
        g.push(...layChain(from, [], t.fx, [], name, name));
      }
      outs.push({ label: `[${name}]`, role });
    });
  });
  let mixIn = outs.map((o) => o.label);
  if (ducking) {
    const dlg = outs.filter((o) => o.role === "dialogue").map((o) => o.label);
    const mus = outs.filter((o) => DUCKED.includes(o.role)).map((o) => o.label);
    if (dlg.length && mus.length) {
      const bus = (ls: string[], name: string) => {
        if (ls.length === 1) return ls[0];
        g.push(`${ls.join("")}amix=inputs=${ls.length}:${AMIX}[${name}]`);
        return `[${name}]`;
      };
      const d = bus(dlg, `${prefix}bdlg`);
      const m = bus(mus, `${prefix}bmus`);
      g.push(`${d}asplit=2[${prefix}bdlgo][${prefix}bdlgsc]`);
      g.push(`${m}[${prefix}bdlgsc]sidechaincompress=threshold=${lin(ducking.threshold, 0.000976563, 1)}:ratio=${num(ducking.ratio)}`
        + `:attack=${num(ducking.attack)}:release=${num(ducking.release)}:makeup=1[${prefix}bmusd]`);
      const rest = outs.filter((o) => o.role !== "dialogue" && !DUCKED.includes(o.role)).map((o) => o.label);
      mixIn = [`[${prefix}bdlgo]`, `[${prefix}bmusd]`, ...rest];
    }
  }
  const sum = mixIn.length > 1 ? `${mixIn.join("")}amix=inputs=${mixIn.length}:${AMIX}` : "";
  if (!master.length) return sum ? `${sum},apad` : `${mixIn[0]}apad`;
  if (master.every((s) => typeof s === "string")) return sum ? `${[sum, ...(master as string[])].join(",")},apad` : `${mixIn[0]}${master.join(",")},apad`;
  let from = mixIn[0].slice(1, -1);
  if (sum) { from = `${prefix}msum`; g.push(`${sum}[${from}]`); }
  g.push(...layChain(from, [], master, ["apad"], `${prefix}mfx`, `${prefix}mfx`));
  return `[${prefix}mfx]anull`;
}

/**
 * The FFmpeg runs that make the mix WAV: one when the clips fit in a batch, else each track's clips summed in batches
 * (into `part(i)`) and a final run with the buses. `loudnorm` (optional) is appended to the last run.
 */
export function mixJobs(plan: MixPlan, out: string, opts: { part?: (i: number) => string; loudnorm?: string | null } = {}): string[][] {
  const total = Math.max(0.001, plan.range.end - plan.range.start);
  const tail = (graphOut: string) => (opts.loudnorm ? `${graphOut},${opts.loudnorm},aresample=48000` : graphOut);
  const enc = ["-ac", "2", "-ar", String(MIX_RATE), "-c:a", "pcm_f32le", "-t", f3(total)];
  const tracks = plan.tracks ?? [];
  if (!plan.clips.length) {
    const g = opts.loudnorm ? ["-af", `${opts.loudnorm},aresample=48000`] : [];
    return [["-f", "lavfi", "-i", `anullsrc=r=${MIX_RATE}:cl=stereo`, ...g, ...enc, out]];
  }
  if (plan.clips.reduce((n, c) => n + inputCount(c), 0) <= MIX_BATCH) {
    const args: string[] = [];
    const g: string[] = [];
    plan.clips.forEach((c, i) => unitGraph(c, `c${i}`, plan.range.start, args, g));
    const master = busGraph(plan.clips.map((c, i) => ({ label: `c${i}`, trackId: c.trackId, role: c.role })), tracks, plan.ducking ?? null, g, plan.master);
    g.push(`${tail(master)}[mix]`);
    return [[...args, "-filter_complex", g.join(";"), "-map", "[mix]", ...enc, out]];
  }
  // long sequences: each track's (and role's) clips in batches → parts, then the buses over the parts
  const part = opts.part ?? ((i: number) => out.replace(/(\.\w+)?$/, `_part${i}.wav`));
  const jobs: string[][] = [];
  const parts: { file: string; trackId?: string; role?: AudioRole | null }[] = [];
  const groups = new Map<string, MixClip[]>();
  for (const c of plan.clips) {
    const k = `${c.trackId ?? ""}|${c.role ?? ""}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(c);
  }
  for (const clips of groups.values()) {
    for (let i = 0; i * MIX_BATCH < clips.length; i++) {
      const batch = clips.slice(i * MIX_BATCH, (i + 1) * MIX_BATCH);
      const file = part(parts.length);
      parts.push({ file, trackId: batch[0].trackId, role: batch[0].role });
      const args: string[] = [];
      const g: string[] = [];
      batch.forEach((c, j) => unitGraph(c, `c${j}`, plan.range.start, args, g));
      const labels = batch.map((_, j) => `[c${j}]`).join("");
      g.push(`${batch.length > 1 ? `${labels}amix=inputs=${batch.length}:${AMIX},apad` : `${labels}apad`}[mix]`);
      jobs.push([...args, "-filter_complex", g.join(";"), "-map", "[mix]", ...enc, file]);
    }
  }
  const args: string[] = [];
  parts.forEach((p) => args.push("-i", p.file));
  const g: string[] = [];
  const master = busGraph(parts.map((p, i) => ({ label: `${i}:a`, trackId: p.trackId, role: p.role })), tracks, plan.ducking ?? null, g, plan.master);
  g.push(`${tail(master)}[mix]`);
  jobs.push([...args, "-filter_complex", g.join(";"), "-map", "[mix]", ...enc, out]);
  return jobs;
}

// ── one track as a stem (editor-interop's "Send to Audition") ──

/**
 * The FFmpeg runs that render ONE track's clips to a 48 kHz stereo float WAV covering the whole sequence from frame 0
 * to its end: trims, speed, gain and pan keyframes, fades, crossfades, and the clip and track effects (unless
 * `effects` is false). Track mute / solo, the master effects, ducking and loudness are left out.
 */
export function stemJobs(project: EditProject, seq: Sequence, trackId: string, out: string,
  opts: { effects?: boolean; irFile?(preset: IrPreset): string; resolve?: (m: MediaItem) => string | null; part?: (i: number) => string } = {}): string[][] {
  const track = seq.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error("That track isn't in the sequence");
  const end = seq.clips.reduce((m, c) => (c.enabled === false ? m : Math.max(m, c.start + c.duration)), 0);
  if (end <= 0) throw new Error("The sequence is empty");
  const fx = opts.effects !== false;
  const t: Track = { ...track, muted: false, solo: false, ...(fx ? {} : { effects: [] }) };
  const clips = seq.clips.filter((c) => c.trackId === trackId).map((c) => (fx ? c : { ...c, effects: [] }));
  const one: Sequence = { ...seq, tracks: [t], clips, transitions: seq.transitions.filter((x) => x.trackId === trackId), masterEffects: [] };
  const plan = mixPlan(project, one, { in: 0, out: end }, opts.resolve, { ducking: false, irFile: opts.irFile });
  plan.master = [];
  return mixJobs(plan, out, { part: opts.part });
}

// ── one clip's sound for the editor's preview (editor.renderAudioPreview) ──

/**
 * The run that renders one clip's sound with its trims, speed and audio effects through the export's own chain (no
 * gain, pan, fades, track or master: the preview applies those itself), from the clip's start, into a 48 kHz stereo
 * float WAV. `key` is everything the result depends on (the caller adds the source file's size and time and hashes it).
 */
export function previewJob(project: EditProject, seq: Sequence, clipId: string, out: string, opts: MixOptions & { resolve?: (m: MediaItem) => string | null } = {}):
  { args: string[]; duration: number; warnings: string[]; key: string; file: string } {
  const c = seq.clips.find((x) => x.id === clipId);
  if (!c) throw new Error("That clip isn't in the sequence");
  if (c.source.type !== "media" && c.source.type !== "generate") throw new Error("Only clips with sound have an audio preview");
  const track: Track = { id: "pv", kind: "audio", name: "Preview", index: 0, locked: false, hidden: false, muted: false, solo: false, targeted: false,
    syncLock: false, height: 48, volume: 0, pan: 0 };
  const clip: TimelineClip = { ...c, trackId: "pv", enabled: true, audio: c.audio ? { gain: { value: 0 }, pan: { value: 0 }, fadeIn: 0, fadeOut: 0 } : undefined };
  const one: Sequence = { ...seq, tracks: [track], clips: [clip], transitions: [], masterEffects: [] };
  const plan = mixPlan(project, one, { in: c.start, out: c.start + c.duration }, opts.resolve, { ...opts, ducking: false });
  const mc = plan.clips[0];
  if (!mc) throw new Error(plan.warnings[0] ?? "That clip has no sound");
  const ins: string[] = [];
  const gs: string[] = [];
  unitGraph(mc, "out", mc.start, ins, gs);
  const g = gs.join(";");
  const args = [...ins, "-filter_complex", g, "-map", "[out]", "-ac", "2", "-ar", String(MIX_RATE), "-c:a", "pcm_f32le", "-t", f3(mc.duration), out];
  const key = JSON.stringify({ v: 1, file: mc.file, lavfi: mc.lavfi ?? "", in: mc.in, duration: mc.duration, speed: mc.speed, reverse: mc.reverse, graph: g });
  return { args, duration: Math.round(mc.duration * 1000) / 1000, warnings: plan.warnings, key, file: mc.file };
}

// ── loudness (export option) ──
export interface LoudnessTarget { label: string; lufs: number; truePeak: number }
export const LOUDNESS: Record<Exclude<LoudnessPreset, "off">, LoudnessTarget> = {
  youtube: { label: "YouTube (−14 LUFS)", lufs: -14, truePeak: -1 },
  instagram: { label: "Instagram / Reels (−14 LUFS)", lufs: -14, truePeak: -1 },
  spotify: { label: "Spotify (−14 LUFS)", lufs: -14, truePeak: -1 },
  apple: { label: "Apple Music / Podcasts (−16 LUFS)", lufs: -16, truePeak: -1 },
  ebu_r128: { label: "Broadcast EBU R128 (−23 LUFS)", lufs: -23, truePeak: -1 },
  ott: { label: "OTT / streaming platforms (−24 LUFS)", lufs: -24, truePeak: -2 },
};
export const isLoudnessPreset = (v: unknown): v is LoudnessPreset => v === "off" || (typeof v === "string" && Object.prototype.hasOwnProperty.call(LOUDNESS, v));
/** The default target of an export preset: EBU R128 for broadcast, else YouTube's −14. */
export const defaultLoudness = (preset: string): LoudnessPreset => (preset === "broadcast1080" ? "ebu_r128" : "youtube");

/** ebur128 over a WAV (the summary is parsed with editor-analyze.parseEbur128). */
export function measureArgs(wav: string): string[] {
  return ["-nostats", "-i", wav, "-af", "ebur128=peak=true", "-f", "null", "-"];
}

/**
 * Gain to the target, then a true-peak limiter (4× oversampled, so inter-sample peaks are caught) at the target's
 * ceiling, back to 48 kHz float. Peaks the gain pushes over the ceiling are limited instead of turning the whole mix
 * down, so the integrated loudness lands on the target (a second pass corrects what the limiter took).
 */
export function normalizeArgs(wav: string, out: string, gainDb: number, truePeak: number): string[] {
  const g = clamp(gainDb, -60, 40);
  return ["-i", wav, "-af", `volume=${num(Math.round(g * 100) / 100)}dB,aresample=192000,alimiter=limit=${lin(truePeak, 0.0625, 1)}:attack=1:release=60`
    + ":level=0:latency=1,aresample=48000", "-ac", "2", "-ar", String(MIX_RATE), "-c:a", "pcm_f32le", out];
}

/** The next gain (dB) towards `target` from a measured loudness, or null when it's close enough (±0.3 LU) or silent. */
export function nextGain(gainDb: number, measured: number | null, target: number): number | null {
  if (measured === null || !Number.isFinite(measured) || measured <= -69) return null; // ebur128 says −70 for silence
  const err = target - measured;
  return Math.abs(err) <= 0.3 ? null : Math.round((gainDb + err) * 100) / 100;
}
