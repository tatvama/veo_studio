/**
 * The export side of the editor's audio effects (docs/EDITOR.md §11): every effect id → FFmpeg filters, from one
 * catalogue (`AUDIO_FX`: id, group, label, the FFmpeg filters it uses, and each parameter's name, default, range and
 * unit). The editor's WebAudio preview (frontend/src/editor/audiofx) uses the same ids and parameter names.
 *
 * Conventions: gains and thresholds in dB, frequencies in Hz, attack / release in seconds (values above 2 are read as
 * ms), delays in ms, amounts 0..1. Ids may carry the "audio:" prefix; the editor's older ids are aliases
 * ("audio:eq" = eq3, "noise_gate" = gate …). Disabled effects are skipped.
 *
 * Keyframes: a keyframed parameter of a filter that takes runtime commands is sampled every 50 ms (at most 300 points)
 * into an `asendcmd` in front of that filter (gain uses a per-frame volume expression); any other keyframed parameter
 * uses its first keyframe, with a warning. Times are seconds of the chain (clip effects: from the clip's start, plus
 * its crossfade handle; track and master effects: from the export range's start).
 *
 * Most effects are plain filters inside the clip's chain. Two need a small graph: `reverb` (asplit → afir with the
 * built-in impulse response read by amovie → amix with the dry signal) and `vinyl` (aevalsrc crackle mixed in).
 * Pure (test/editor-audio.test.ts).
 */
import type { EffectInstance, Easing, Keyframe, Param } from "../shared/types.ts";
import { ease, keyPoints as curvePoints } from "./editor-curves.ts";
import { CABINET_IRS, isIrPreset, REVERB_IRS, type IrPreset } from "./editor-irs.ts";
import { escPath } from "./render-args.ts";

const num = (x: number) => String(Math.round(x * 1e6) / 1e6);
const f6 = (x: number) => (Math.round(x * 1e6) / 1e6).toString();
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const db2lin = (db: number) => Math.pow(10, db / 20);
const lin = (db: number, lo: number, hi: number) => num(clamp(db2lin(db), lo, hi));
const r = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

// ── keyframe curves (shared with editor-audio's gain and pan) ──

/**
 * Piecewise expression of t from keyframe points (held before the first and after the last), with the editor's easings
 * (editor-curves.ts: ease_in t³, ease_out 1 − (1 − t)³, the cubic in-out; bezier / bounce / elastic arrive as straight
 * pieces from keyPoints).
 */
export function pwlExpr(pts: [number, number, Easing][], v = "t"): string {
  const n = pts.length;
  let expr = num(pts[n - 1][1]);
  for (let i = n - 2; i >= 0; i--) {
    const [t0, v0, ease] = pts[i];
    const [t1, v1] = pts[i + 1];
    const dt = t1 - t0;
    let seg: string;
    if (ease === "hold" || dt <= 0 || v0 === v1) seg = num(v0);
    else {
      const p = `(${v}-${f6(t0)})/${f6(dt)}`;
      const shaped = ease === "ease_in" ? `pow(${p},3)` : ease === "ease_out" ? `(1-pow(1-${p},3))`
        : ease === "ease_in_out" ? `if(lt(${p},0.5),4*pow(${p},3),1-pow(-2*${p}+2,3)/2)` : p;
      seg = `${num(v0)}+${num(v1 - v0)}*${shaped}`;
    }
    expr = `if(lt(${v},${f6(t1)}),${seg},${expr})`;
  }
  return `if(lt(${v},${f6(pts[0][0])}),${num(pts[0][1])},${expr})`;
}

/** The value of keyframe points at t (the same shapes as pwlExpr). */
export function pwlAt(pts: [number, number, Easing][], t: number): number {
  if (!pts.length) return 0;
  if (t < pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [t0, v0, e] = pts[i];
    const [t1, v1] = pts[i + 1];
    if (t < t1) {
      if (e === "hold" || t1 <= t0) return v0;
      return v0 + (v1 - v0) * ease(e, (t - t0) / (t1 - t0));
    }
  }
  return pts[pts.length - 1][1];
}

// ── the catalogue ──

export interface FxParam {
  name: string;
  /** number, or one of `options` */
  default: number | string;
  min?: number; max?: number;
  /** "dB", "Hz", "s", "ms", "x", "%", "st" (semitones), "" */
  unit?: string;
  options?: string[];
  label: string;
}

export interface FxDef {
  id: string;
  group: "Dynamics" | "EQ & filters" | "Clean-up" | "Time & pitch" | "Space" | "Modulation & creative" | "Utility";
  label: string;
  /** the FFmpeg filters it uses (for the docs and the effect browser) */
  ffmpeg: string;
  params: FxParam[];
  /** it changes the sound's length (the clip's chain trims it back to the clip) */
  changesLength?: boolean;
  /** needs stereo in and gives other channels out (the builder converts back) */
  build(p: Values): (string | GraphStep)[];
}

/** A step that can't be a plain filter: it gets an input and an output label and returns graph statements. */
export interface GraphStep { graph(inL: string, outL: string): string[] }

export interface Values {
  /** a number param (static value: its first keyframe when keyframed), clamped to its range */
  n(name: string): number;
  /** a choice param */
  s(name: string): string;
  /** `filter`, or `filter@<id>` with an asendcmd for the listed params that are keyframed (param → option, value map) */
  f(filter: string, cmds?: Record<string, [string, ((v: number) => string)?]>): string;
  /** keyframe points of a param in chain seconds, or null (for expressions) */
  points(name: string): [number, number, Easing][] | null;
  /** the chain's length in seconds */
  duration: number;
  /** a unique label prefix for graph steps */
  uid: string;
  irFile(preset: IrPreset): string;
  /** mark a keyframed param as handled (an expression uses it) */
  handled(name: string): void;
  /** the clip's source file (clip effects only): noise_print reads its noise range from it */
  source?: { file: string };
}

const P = (name: string, label: string, def: number, min: number, max: number, unit = ""): FxParam => ({ name, label, default: def, min, max, unit });
const C = (name: string, label: string, def: string, options: string[]): FxParam => ({ name, label, default: def, options });
const DB = (name: string, label: string, def: number, min = -24, max = 24) => P(name, label, def, min, max, "dB");
const HZ = (name: string, label: string, def: number, min: number, max: number) => P(name, label, def, min, max, "Hz");
const S = (name: string, label: string, def: number, min: number, max: number) => P(name, label, def, min, max, "s");
const MS = (name: string, label: string, def: number, min: number, max: number) => P(name, label, def, min, max, "ms");
const A = (name: string, label: string, def: number, min = 0, max = 1) => P(name, label, def, min, max);
const Q = (def: number, max = 10) => P("q", "Q", def, 0.1, max);
const ms = (s: number) => s * 1000; // the registry's attack / release are seconds; FFmpeg's are ms
const pan = (spec: string) => `pan=stereo|${spec}`;
/** Shelves (lowshelf, highshelf, tiltshelf): Q 0.7071, like the preview (FFmpeg 7.1's bass / treble aren't the RBJ shelf: not used). */
const SHELF = "t=q:w=0.7071";
const CLIP_TYPES = ["tanh", "hard", "atan", "cubic", "exp", "alg", "quintic", "sin", "erf"];
const GRAPHIC: [string, number][] = [["b31", 31], ["b62", 62], ["b125", 125], ["b250", 250], ["b500", 500], ["b1k", 1000], ["b2k", 2000], ["b4k", 4000],
  ["b8k", 8000], ["b16k", 16000]];
const BAND_TYPES = ["off", "peak", "lowshelf", "highshelf", "lowpass", "highpass", "notch", "bandpass"];
const PARAM_BAND_DEFAULTS: [string, number][] = [["lowshelf", 100], ["peak", 250], ["peak", 1000], ["peak", 3000], ["peak", 6000], ["highshelf", 10000]];
const ratioOf = (st: number) => num(r(Math.pow(2, st / 12), 6));
const nz = (x: number) => Math.abs(x) > 1e-9;

const COMPRESSOR = (t = -24, ra = 4, a = 0.01, rel = 0.25): FxParam[] => [DB("threshold", "Threshold", t, -60, 0), P("ratio", "Ratio", ra, 1, 20, ":1"),
  S("attack", "Attack", a, 0.0001, 1), S("release", "Release", rel, 0.01, 3), DB("makeup", "Make-up gain", 0, 0, 24), DB("knee", "Knee", 2.8, 0, 30)];

/** acompressor with the registry's params (detection peak, knee 10^(knee/20) clamped 1..8, no automatic make-up). */
function acompressor(p: Values, knee = true): string {
  const k = knee ? num(r(clamp(db2lin(p.n("knee")), 1, 8), 5)) : "2.82843";
  return `${p.f("acompressor", { threshold: ["threshold", (v) => lin(v, 0.000976563, 1)], ratio: ["ratio"], makeup: ["makeup", (v) => lin(v, 1, 64)] })}`
    + `=threshold=${lin(p.n("threshold"), 0.000976563, 1)}:ratio=${num(p.n("ratio"))}:attack=${num(clamp(ms(p.n("attack")), 0.01, 2000))}`
    + `:release=${num(clamp(ms(p.n("release")), 0.01, 9000))}:makeup=${lin(p.n("makeup"), 1, 64)}:knee=${k}:detection=peak`;
}

const limiter = (ceiling: number, releaseS: number, name = "alimiter") =>
  `${name}=limit=${lin(ceiling, 0.0625, 1)}:attack=5:release=${num(clamp(ms(releaseS), 1, 8000))}:level=0:latency=1`;

/** The impulse response as a graph source (48 kHz stereo float). */
const irSource = (file: string, label: string) =>
  `amovie=filename='${escPath(file)}',aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[${label}]`;

/** reverb = dry·(1 − mix) + wet·mix; the wet is afir with the built-in IR (irnorm=-1:irgain=1), pre-delay (adelay) and M/S width (extrastereo). */
function reverbStep(p: Values, preset: string, mix: number, width: number, predelay: number): GraphStep {
  const u = p.uid;
  return {
    graph: (inL, outL) => {
      const st = [`[${inL}]asplit=2[${u}d][${u}w]`, irSource(p.irFile(preset), `${u}ir`)];
      let w = `${u}w`;
      if (predelay > 0) { st.push(`[${u}w]adelay=delays=${num(r(predelay, 3))}:all=1[${u}w2]`); w = `${u}w2`; }
      const widen = nz(width - 1) ? `,extrastereo=m=${num(width)}:c=0` : "";
      st.push(`[${w}][${u}ir]afir=irnorm=-1:irgain=1${widen}[${u}wet]`,
        `[${u}d][${u}wet]amix=inputs=2:weights='${num(r(1 - mix, 4))} ${num(r(mix, 4))}':normalize=0:duration=first[${outL}]`);
      return st;
    },
  };
}

/** A sound mixed in under the chain (radio / walkie-talkie static): anoisesrc at `levelDb`. */
function staticStep(p: Values, levelDb: number, colour = "pink"): GraphStep | null {
  if (levelDb <= -90) return null;
  const u = p.uid;
  return {
    graph: (inL, outL) => [
      `anoisesrc=color=${colour}:amplitude=${lin(levelDb, 0, 1)}:r=48000:d=${num(r(Math.max(0.05, p.duration) + 0.1, 3))}:seed=7,`
        + `aformat=sample_fmts=fltp:channel_layouts=stereo[${u}nz]`,
      `[${inL}][${u}nz]amix=inputs=2:normalize=0:duration=first[${outL}]`],
  };
}

/**
 * Learn the noise from the source's [noiseStart, noiseEnd) (source seconds; read with amovie, so it may lie outside the
 * clip's trim), played into afftdn ahead of the clip with sample_noise start / stop (asendcmd), then cut off again.
 * Track and master effects have no source: their noise range is in seconds of the chain.
 */
function noisePrintStep(p: Values): GraphStep {
  const u = p.uid;
  const reduction = p.n("reduction");
  const floor = p.n("floor");
  const a = Math.max(0, p.n("noiseStart"));
  const b = Math.max(a + 0.05, p.n("noiseEnd") > a ? p.n("noiseEnd") : a + 0.5);
  const len = r(b - a, 3);
  const dn = `afftdn@${u}nr`;
  return {
    graph: (inL, outL) => {
      const st: string[] = [];
      let noise: string;
      if (p.source) {
        st.push(`amovie=filename='${escPath(p.source.file)}':seek_point=${f6(a)},atrim=0:${f6(len)},asetpts=PTS-STARTPTS,aresample=48000,`
          + `aformat=sample_fmts=fltp:channel_layouts=stereo[${u}n]`);
        st.push(`[${inL}]anull[${u}b]`);
        noise = `${u}n`;
      } else {
        st.push(`[${inL}]asplit=2[${u}a][${u}b]`, `[${u}a]atrim=${f6(a)}:${f6(b)},asetpts=PTS-STARTPTS[${u}n]`);
        noise = `${u}n`;
      }
      st.push(`[${noise}][${u}b]concat=n=2:v=0:a=1[${u}c]`,
        `[${u}c]asendcmd=c='0.000 ${dn} sample_noise start;${len.toFixed(3)} ${dn} sample_noise stop',`
          + `${dn}=nr=${num(clamp(reduction, 0.01, 97))}:nf=${num(floor)}:tn=0,atrim=start=${f6(len)},asetpts=PTS-STARTPTS[${outL}]`);
      return st;
    },
  };
}

/** Hiss: only the highs above `frequency` (an 8th-order crossover) go through afftdn. */
function hissStep(p: Values): GraphStep {
  const u = p.uid;
  return {
    graph: (inL, outL) => [
      `[${inL}]acrossover=split=${num(p.n("frequency"))}:order=8th[${u}lo][${u}hi]`,
      `[${u}hi]afftdn=nr=${num(clamp(p.n("reduction"), 0.01, 97))}:nf=-50:tn=1[${u}hd]`,
      `[${u}lo][${u}hd]amix=inputs=2:normalize=0:duration=first[${outL}]`],
  };
}

/** A guitar cabinet: its impulse response, fully wet. */
function cabinetStep(p: Values, cab: string): GraphStep {
  const u = p.uid;
  return { graph: (inL, outL) => [irSource(p.irFile(cab), `${u}cab`), `[${inL}][${u}cab]afir=irnorm=-1:irgain=1[${outL}]`] };
}

/** The doppler path of the preview (frontend audiofx/dsp.ts dopplerAt): position at chain time t. */
export function dopplerAt(path: string, speed: number, distance: number, center: number, t: number, duration: number): { x: number; y: number; rate: number } {
  const tc = clamp(center, 0, 1) * duration;
  const d0 = Math.max(0.1, distance);
  const v = Math.max(0, speed);
  const pos = (u: number): [number, number] => {
    if (path === "approach") return [0, d0 + v * Math.max(0, tc - u)];
    if (path === "recede") return [0, d0 + v * Math.max(0, u - tc)];
    const x = v * (u - tc);
    return [path === "pass_rl" ? -x : x, d0];
  };
  const dist = (u: number) => Math.hypot(...pos(u));
  const [x, y] = pos(t);
  const vr = (dist(t + 1e-3) - dist(t - 1e-3)) / 2e-3;
  return { x, y, rate: 343 / (343 + vr) };
}

/**
 * Doppler: the pitch (343 / (343 + radial speed), sampled into rubberband through asendcmd), the level (closest
 * distance / distance) and the pan (x / distance, equal power on the mono sum) as expressions of t.
 */
function dopplerSteps(p: Values): string[] {
  const path = p.s("path");
  const v = Math.max(0, p.n("speed"));
  const d0 = Math.max(0.1, p.n("distance"));
  const dur = Math.max(0.05, p.duration);
  const tc = f6(clamp(p.n("center"), 0, 1) * dur);
  let x: string;
  let y: string;
  if (path === "approach") { x = "0"; y = `(${num(d0)}+${num(v)}*max(0,${tc}-t))`; }
  else if (path === "recede") { x = "0"; y = `(${num(d0)}+${num(v)}*max(0,t-${tc}))`; }
  else { x = `(${path === "pass_rl" ? "-" : ""}${num(v)}*(t-${tc}))`; y = num(d0); }
  const rr = `sqrt(${x}*${x}+${y}*${y})`;
  const g = `min(1,${num(d0)}/${rr})`;
  const pn = `max(-1,min(1,${x}/${rr}))`;
  const L = `${g}*cos((${pn}+1)*PI/4)*sqrt(2)`;
  const R = `${g}*sin((${pn}+1)*PI/4)*sqrt(2)`;
  const name = `rubberband@${p.uid}dp`;
  const cmds: string[] = [];
  const step = Math.max(0.05, dur / 300);
  let last = "";
  for (let t = 0; t <= dur + 1e-9; t += step) {
    const ratio = num(r(dopplerAt(path, v, d0, p.n("center"), t, dur).rate, 5));
    if (ratio !== last) cmds.push(`${t.toFixed(3)} ${name} pitch ${ratio}`);
    last = ratio;
  }
  const first = cmds.length ? cmds[0].split(" ").at(-1)! : "1";
  return [`asendcmd=c='${cmds.join(";")}'`, `${name}=pitch=${first}:formant=shifted`, pan("c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1"),
    `aeval=exprs='val(0)*${L}|val(1)*${R}':c=stereo`];
}

/** FFmpeg 7.1's vibrato starts with a few NaN samples: zeroed before they reach amix or loudnorm (the chains are stereo there). */
const VIBRATO_GUARD = "aeval=exprs='if(isnan(val(0))+isinf(val(0)),0,val(0))|if(isnan(val(1))+isinf(val(1)),0,val(1))'";
const vibrato = (f: number, d: number) => [`vibrato=f=${num(f)}:d=${num(d)}`, VIBRATO_GUARD];

/** aecho taps at k·delay with decays wet·feedback^(k−1) until below −60 dB (at most 64), in_gain = out_gain = 1. */
export function echoFilter(delayMs: number, feedback: number, wet: number): string {
  const d: string[] = [];
  const g: string[] = [];
  let level = wet;
  for (let k = 1; k <= 64 && level >= 0.001 && k * delayMs <= 90000; k++) {
    d.push(num(r(k * delayMs, 3)));
    g.push(num(r(level, 6)));
    if (feedback <= 0) break;
    level *= feedback;
  }
  return d.length ? `aecho=in_gain=1:out_gain=1:delays=${d.join("|")}:decays=${g.join("|")}` : "anull";
}

/**
 * FFmpeg's acrusher reduces the sample rate only on its `mix` side (sample = mix·SR(x) + (1 − mix)·x) and keeps
 * (1 − mix) of the bit-reduced value, so one instance can't do both: a sample-and-hold pass (bits 64, mix 1), then the
 * bits. Its anti-aliasing divides by `aa`, and at aa 0 (hard steps) a sample is NaN whenever roundf's float rounding of
 * x·(2^bits − 1) lands past the half step: 0.13947239518165588 at 11 bits, most double input at 64 bits (after aeval).
 * NaN in amix or loudnorm silences the whole mix. So the hold pass uses aa 1 (mix 1 throws its bit side away) and aeval
 * rounds the bits: round(x·c) / c with c = 2^bits − 1, which is acrusher's lin / dc 1 / aa 0 value wherever that isn't NaN.
 */
function crusher(bits: number, samples: number): string[] {
  const out: string[] = [];
  const s = Math.round(samples);
  if (s > 1) out.push(`acrusher=bits=64:samples=${s}:mix=1:aa=1:dc=1:mode=lin`);
  const c = num(Math.pow(2, bits) - 1);
  out.push(`aeval=exprs='round(val(ch)*${c})/${c}':c=same`);
  return out;
}

const invert = (ch: string) => pan(ch === "left" ? "c0=-1*c0|c1=c1" : ch === "right" ? "c0=c0|c1=-1*c1" : "c0=-1*c0|c1=-1*c1");

export const AUDIO_FX: FxDef[] = [
  // ── Dynamics ──
  { id: "gain", group: "Dynamics", label: "Gain", ffmpeg: "volume", params: [DB("gain", "Gain", 0, -48, 24)],
    build: (p) => {
      const pts = p.points("gain");
      if (pts) { p.handled("gain"); return [`volume='pow(10,(${pwlExpr(pts)})/20)':eval=frame`]; }
      const g = p.n("gain");
      return nz(g) ? [`volume=${num(g)}dB`] : [];
    } },
  { id: "compressor", group: "Dynamics", label: "Compressor", ffmpeg: "acompressor", params: COMPRESSOR(), build: (p) => [acompressor(p)] },
  { id: "multiband", group: "Dynamics", label: "Multiband compressor", ffmpeg: "mcompand",
    params: [HZ("lowCross", "Low crossover", 250, 40, 1000), HZ("highCross", "High crossover", 3000, 1000, 12000), DB("threshold", "Threshold", -24, -60, 0),
      P("ratio", "Ratio", 3, 1, 20, ":1"), S("attack", "Attack", 0.01, 0.001, 1), S("release", "Release", 0.2, 0.01, 3), DB("lowGain", "Low gain", 0, -12, 12),
      DB("midGain", "Mid gain", 0, -12, 12), DB("highGain", "High gain", 0, -12, 12)],
    build: (p) => {
      const a = num(p.n("attack"));
      const d = num(p.n("release"));
      const th = p.n("threshold");
      const out0 = num(r(th * (1 - 1 / p.n("ratio"))));
      const lo = p.n("lowCross");
      const hi = Math.max(lo + 50, p.n("highCross"));
      const band = (xover: number, gain: number) => `${a},${d} 6 -90/-90,${num(th)}/${num(th)},0/${out0} ${num(xover)} 0 0 ${num(gain)}`;
      return [`mcompand=args='${band(lo, p.n("lowGain"))} | ${band(hi, p.n("midGain"))} | ${band(22000, p.n("highGain"))}'`];
    } },
  { id: "limiter", group: "Dynamics", label: "Limiter", ffmpeg: "alimiter", params: [DB("ceiling", "Ceiling", -1, -24, 0), S("release", "Release", 0.05, 0.001, 1)],
    build: (p) => [limiter(p.n("ceiling"), p.n("release"), p.f("alimiter", { ceiling: ["limit", (v) => lin(v, 0.0625, 1)] }))] },
  { id: "gate", group: "Dynamics", label: "Noise gate", ffmpeg: "agate",
    params: [DB("threshold", "Threshold", -50, -90, 0), DB("range", "Range", -40, -90, 0), S("attack", "Attack", 0.005, 0.0001, 0.5), S("release", "Release", 0.12, 0.005, 2),
      P("ratio", "Ratio", 10, 1, 50, ":1")],
    build: (p) => [`${p.f("agate", { threshold: ["threshold", (v) => lin(v, 0, 1)], range: ["range", (v) => lin(v, 0, 1)] })}=threshold=${lin(p.n("threshold"), 0, 1)}`
      + `:range=${lin(p.n("range"), 0, 1)}:ratio=${num(p.n("ratio"))}:attack=${num(clamp(ms(p.n("attack")), 0.01, 9000))}`
      + `:release=${num(clamp(ms(p.n("release")), 0.01, 9000))}:detection=peak:knee=2.828`] },
  { id: "expander", group: "Dynamics", label: "Expander", ffmpeg: "compand",
    params: [DB("threshold", "Threshold", -40, -90, 0), P("ratio", "Ratio", 2, 1, 10, ":1"), S("attack", "Attack", 0.01, 0.001, 1), S("release", "Release", 0.1, 0.01, 3)],
    build: (p) => {
      const th = p.n("threshold");
      const low = Math.max(-200, th + (-90 - th) * p.n("ratio"));
      return [`compand=attacks=${num(p.n("attack"))}:decays=${num(p.n("release"))}:points=-90/${num(r(low))}|${num(th)}/${num(th)}|0/0:volume=-90`];
    } },
  { id: "deesser", group: "Dynamics", label: "De-esser", ffmpeg: "deesser", params: [A("intensity", "Intensity", 0.5), A("max", "Max reduction", 0.5), A("frequency", "Frequency", 0.5)],
    build: (p) => [`deesser=i=${num(p.n("intensity"))}:m=${num(p.n("max"))}:f=${num(p.n("frequency"))}:s=o`] },
  { id: "auto_level", group: "Dynamics", label: "Auto level", ffmpeg: "dynaudnorm",
    params: [MS("frame", "Frame", 500, 10, 8000), P("window", "Window", 31, 3, 301, "frames"), A("peak", "Peak", 0.95), P("maxGain", "Max gain", 10, 1, 100, "×")],
    build: (p) => {
      const w = Math.round(p.n("window"));
      return [`dynaudnorm=f=${Math.round(p.n("frame"))}:g=${w % 2 ? w : w + 1}:p=${num(p.n("peak"))}:m=${num(p.n("maxGain"))}`];
    } },
  { id: "speech_level", group: "Dynamics", label: "Speech level", ffmpeg: "speechnorm",
    params: [A("peak", "Peak", 0.95), P("expansion", "Expansion", 2, 1, 50, "×"), P("compression", "Compression", 2, 1, 50, "×"), A("threshold", "Threshold", 0)],
    build: (p) => [`${p.f("speechnorm", { peak: ["p"], expansion: ["e"], compression: ["c"], threshold: ["t"] })}=p=${num(p.n("peak"))}:e=${num(p.n("expansion"))}`
      + `:c=${num(p.n("compression"))}:t=${num(p.n("threshold"))}`] },
  { id: "tube_compressor", group: "Dynamics", label: "Tube compressor", ffmpeg: "acompressor, asoftclip (tanh)",
    params: [...COMPRESSOR(-18, 3, 0.01, 0.2).filter((x) => x.name !== "knee"), DB("drive", "Drive", 6, 0, 24)],
    build: (p) => [acompressor(p, false), `volume=${num(p.n("drive"))}dB`, "asoftclip=type=tanh", `volume=${num(-p.n("drive"))}dB`] },
  { id: "loudness_maximizer", group: "Dynamics", label: "Loudness maximizer", ffmpeg: "volume, alimiter",
    params: [DB("boost", "Boost", 6, 0, 24), DB("ceiling", "Ceiling", -1, -12, 0), S("release", "Release", 0.05, 0.001, 1)],
    build: (p) => [`${p.f("volume", { boost: ["volume", (v) => `${num(v)}dB`] })}=${num(p.n("boost"))}dB`, limiter(p.n("ceiling"), p.n("release"))] },
  { id: "mastering", group: "Dynamics", label: "Mastering", ffmpeg: "lowshelf, equalizer, highshelf, aexciter, extrastereo, volume, alimiter",
    params: [DB("low", "Low (100 Hz shelf)", 0, -12, 12), DB("mid", "Mid (1 kHz)", 0, -12, 12), DB("high", "High (8 kHz shelf)", 0, -12, 12), A("excite", "Exciter", 0),
      A("width", "Width", 0), DB("boost", "Boost", 0, 0, 18), DB("ceiling", "Ceiling", -1, -12, 0)],
    build: (p) => {
      const out: string[] = [];
      if (nz(p.n("low"))) out.push(`lowshelf=f=100:${SHELF}:g=${num(p.n("low"))}`);
      if (nz(p.n("mid"))) out.push(`equalizer=f=1000:t=q:w=1:g=${num(p.n("mid"))}`);
      if (nz(p.n("high"))) out.push(`highshelf=f=8000:${SHELF}:g=${num(p.n("high"))}`);
      if (p.n("excite") > 0) out.push(`aexciter=amount=${num(r(p.n("excite") * 4, 4))}:drive=8.5:blend=0:freq=7500`);
      if (p.n("width") > 0) out.push(`extrastereo=m=${num(r(1 + p.n("width"), 4))}:c=0`);
      if (nz(p.n("boost"))) out.push(`volume=${num(p.n("boost"))}dB`);
      out.push(limiter(p.n("ceiling"), 0.05));
      return out;
    } },
  { id: "dc_offset", group: "Dynamics", label: "DC offset removal", ffmpeg: "highpass", params: [HZ("frequency", "High-pass", 5, 1, 40)],
    build: (p) => [`highpass=f=${num(p.n("frequency"))}:t=q:w=0.7071`] },

  // ── EQ & filters ──
  { id: "eq3", group: "EQ & filters", label: "EQ (3-band)", ffmpeg: "lowshelf, equalizer, highshelf",
    params: [DB("low", "Low", 0), DB("mid", "Mid", 0), DB("high", "High", 0), HZ("lowFreq", "Low frequency", 200, 20, 1000), HZ("midFreq", "Mid frequency", 1000, 200, 8000),
      HZ("highFreq", "High frequency", 4000, 1000, 16000), P("midQ", "Mid Q", 0.8, 0.1, 10)],
    build: (p) => {
      const out: string[] = [];
      const kf = (x: string) => p.points(x) !== null;
      if (nz(p.n("low")) || kf("low")) out.push(`${p.f("lowshelf", { low: ["g"], lowFreq: ["f"] })}=f=${num(p.n("lowFreq"))}:${SHELF}:g=${num(p.n("low"))}`);
      if (nz(p.n("mid")) || kf("mid")) out.push(`${p.f("equalizer", { mid: ["g"], midFreq: ["f"], midQ: ["w"] })}=f=${num(p.n("midFreq"))}:t=q:w=${num(p.n("midQ"))}:g=${num(p.n("mid"))}`);
      if (nz(p.n("high")) || kf("high")) out.push(`${p.f("highshelf", { high: ["g"], highFreq: ["f"] })}=f=${num(p.n("highFreq"))}:${SHELF}:g=${num(p.n("high"))}`);
      return out;
    } },
  { id: "eq_graphic", group: "EQ & filters", label: "Graphic EQ (10-band)", ffmpeg: "equalizer ×10 (Q 1.41)",
    params: GRAPHIC.map(([k, f]) => DB(k, f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`, 0, -12, 12)),
    build: (p) => GRAPHIC.filter(([k]) => nz(p.n(k)) || p.points(k) !== null).map(([k, f]) => `${p.f("equalizer", { [k]: ["g"] })}=f=${f}:t=q:w=1.41:g=${num(p.n(k))}`) },
  { id: "eq_param", group: "EQ & filters", label: "Parametric EQ (6-band)", ffmpeg: "equalizer, lowshelf, highshelf, lowpass, highpass, bandreject, bandpass",
    params: PARAM_BAND_DEFAULTS.flatMap(([type, f], i) => [C(`type${i + 1}`, `Band ${i + 1} type`, type, BAND_TYPES), HZ(`freq${i + 1}`, `Band ${i + 1} frequency`, f, 20, 20000),
      DB(`gain${i + 1}`, `Band ${i + 1} gain`, 0), P(`q${i + 1}`, `Band ${i + 1} Q`, 1, 0.1, 30)]),
    build: (p) => {
      const out: string[] = [];
      for (let i = 1; i <= 6; i++) {
        const t = p.s(`type${i}`);
        const f = num(p.n(`freq${i}`));
        const g = num(p.n(`gain${i}`));
        const q = num(p.n(`q${i}`));
        const gainOn = nz(p.n(`gain${i}`)) || p.points(`gain${i}`) !== null;
        const cm = (filter: string, gain: boolean, qcmd: boolean) =>
          p.f(filter, { [`freq${i}`]: ["f"], ...(qcmd ? { [`q${i}`]: ["w"] } : {}), ...(gain ? { [`gain${i}`]: ["g"] } : {}) });
        if (t === "peak" && gainOn) out.push(`${cm("equalizer", true, true)}=f=${f}:t=q:w=${q}:g=${g}`);
        else if ((t === "lowshelf" || t === "highshelf") && gainOn) out.push(`${cm(t, true, false)}=f=${f}:${SHELF}:g=${g}`);
        else if (t === "lowpass" || t === "highpass") out.push(`${cm(t, false, true)}=f=${f}:t=q:w=${q}`);
        else if (t === "notch") out.push(`${cm("bandreject", false, true)}=f=${f}:t=q:w=${q}`);
        else if (t === "bandpass") out.push(`${cm("bandpass", false, true)}=f=${f}:t=q:w=${q}`);
      }
      return out;
    } },
  { id: "highpass", group: "EQ & filters", label: "High-pass", ffmpeg: "highpass", params: [HZ("frequency", "Frequency", 80, 10, 2000), Q(0.707)],
    build: (p) => [`${p.f("highpass", { frequency: ["f"], q: ["w"] })}=f=${num(p.n("frequency"))}:t=q:w=${num(p.n("q"))}`] },
  { id: "lowpass", group: "EQ & filters", label: "Low-pass", ffmpeg: "lowpass", params: [HZ("frequency", "Frequency", 12000, 200, 20000), Q(0.707)],
    build: (p) => [`${p.f("lowpass", { frequency: ["f"], q: ["w"] })}=f=${num(p.n("frequency"))}:t=q:w=${num(p.n("q"))}`] },
  { id: "bandpass", group: "EQ & filters", label: "Band-pass", ffmpeg: "bandpass", params: [HZ("frequency", "Frequency", 1000, 50, 15000), Q(0.707)],
    build: (p) => [`${p.f("bandpass", { frequency: ["f"], q: ["w"] })}=f=${num(p.n("frequency"))}:t=q:w=${num(p.n("q"))}`] },
  { id: "notch", group: "EQ & filters", label: "Notch", ffmpeg: "bandreject", params: [HZ("frequency", "Frequency", 1000, 20, 20000), Q(10, 100)],
    build: (p) => [`${p.f("bandreject", { frequency: ["f"], q: ["w"] })}=f=${num(p.n("frequency"))}:t=q:w=${num(p.n("q"))}`] },
  { id: "dehum", group: "EQ & filters", label: "De-hum", ffmpeg: "bandreject at the mains frequency and its harmonics",
    params: [P("frequency", "Mains", 50, 40, 70, "Hz"), P("harmonics", "Harmonics", 4, 1, 8), Q(30, 100)],
    build: (p) => {
      const out: string[] = [];
      for (let k = 1; k <= Math.round(p.n("harmonics")); k++) {
        const f = p.n("frequency") * k;
        if (f < 20000) out.push(`bandreject=f=${num(r(f, 3))}:t=q:w=${num(p.n("q"))}`);
      }
      return out;
    } },
  // "Tilt +6" = highs +3 dB, lows −3 dB; FFmpeg's tiltshelf g raises the lows and lowers the highs, so g = −gain / 2
  { id: "tilt", group: "EQ & filters", label: "Tilt EQ", ffmpeg: "tiltshelf (g = −tilt / 2)", params: [DB("gain", "Tilt", 0, -12, 12), HZ("frequency", "Pivot", 1000, 100, 10000)],
    build: (p) => [`${p.f("tiltshelf", { gain: ["g", (v) => num(-v / 2)], frequency: ["f"] })}=f=${num(p.n("frequency"))}:${SHELF}:g=${num(-p.n("gain") / 2)}`] },
  { id: "virtual_bass", group: "EQ & filters", label: "Virtual bass", ffmpeg: "virtualbass", params: [HZ("cutoff", "Cutoff", 250, 100, 500), P("strength", "Strength", 3, 0.5, 3)],
    // virtualbass gives 2.1: the LFE goes back into both sides
    build: (p) => [`virtualbass=cutoff=${num(p.n("cutoff"))}:strength=${num(p.n("strength"))}`, pan("c0=FL+0.7071*LFE|c1=FR+0.7071*LFE")] },
  { id: "exciter", group: "EQ & filters", label: "Exciter", ffmpeg: "aexciter",
    params: [P("amount", "Amount", 1, 0, 64), P("drive", "Drive", 8.5, 0.1, 10), P("blend", "Blend", 0, -10, 10), HZ("frequency", "Frequency", 7500, 2000, 12000),
      HZ("ceiling", "Ceiling", 9999, 9999, 20000)],
    build: (p) => [`${p.f("aexciter", { amount: ["amount"], drive: ["drive"], blend: ["blend"] })}=amount=${num(p.n("amount"))}:drive=${num(p.n("drive"))}`
      + `:blend=${num(p.n("blend"))}:freq=${num(p.n("frequency"))}:ceil=${num(p.n("ceiling"))}`] },
  { id: "crystalizer", group: "EQ & filters", label: "Crystalizer", ffmpeg: "crystalizer", params: [P("intensity", "Intensity", 2, -10, 10)],
    build: (p) => [`${p.f("crystalizer", { intensity: ["i"] })}=i=${num(p.n("intensity"))}`] },

  // ── Clean-up ──
  { id: "denoise", group: "Clean-up", label: "Noise reduction", ffmpeg: "afftdn (nr 3..30 dB)", params: [A("amount", "Amount", 0.5)],
    build: (p) => [`${p.f("afftdn", { amount: ["nr", (v) => num(r(3 + 27 * clamp(v, 0, 1), 1))] })}=nr=${num(r(3 + 27 * p.n("amount"), 1))}:nf=-45:tn=1`] },
  { id: "denoise_wavelet", group: "Clean-up", label: "Wavelet denoise", ffmpeg: "afwtdn", params: [DB("noise", "Noise level", -45, -90, -10), P("percent", "Amount", 85, 0, 100, "%")],
    build: (p) => [`${p.f("afwtdn", { percent: ["percent"] })}=sigma=${lin(p.n("noise"), 0, 1)}:percent=${num(p.n("percent"))}`] },
  { id: "denoise_nl", group: "Clean-up", label: "Non-local means denoise", ffmpeg: "anlmdn",
    params: [P("strength", "Strength", 0.001, 0.00001, 10), MS("patch", "Patch", 2, 1, 100), MS("research", "Research", 6, 2, 300)],
    build: (p) => [`${p.f("anlmdn", { strength: ["s"] })}=s=${num(p.n("strength"))}:p=${num(p.n("patch"))}ms:r=${num(p.n("research"))}ms`] },
  { id: "declick", group: "Clean-up", label: "De-click", ffmpeg: "adeclick",
    params: [MS("window", "Window", 55, 10, 100), P("overlap", "Overlap", 75, 50, 95, "%"), P("threshold", "Threshold", 2, 1, 100), P("burst", "Burst fusion", 2, 0, 10)],
    build: (p) => [`adeclick=w=${num(p.n("window"))}:o=${num(p.n("overlap"))}:t=${num(p.n("threshold"))}:b=${num(p.n("burst"))}`] },
  { id: "declip", group: "Clean-up", label: "De-clip", ffmpeg: "adeclip",
    params: [MS("window", "Window", 55, 10, 100), P("overlap", "Overlap", 75, 50, 95, "%"), P("threshold", "Threshold", 10, 1, 100)],
    build: (p) => [`adeclip=w=${num(p.n("window"))}:o=${num(p.n("overlap"))}:t=${num(p.n("threshold"))}`] },
  { id: "dialogue_enhance", group: "Clean-up", label: "Dialogue enhance", ffmpeg: "dialoguenhance",
    params: [A("original", "Original", 1), A("enhance", "Enhance", 1, 0, 3), P("voice", "Voice detection", 2, 2, 32)],
    // dialoguenhance gives 3.0: the centre goes back into both sides
    build: (p) => [`${p.f("dialoguenhance", { original: ["original"], enhance: ["enhance"], voice: ["voice"] })}=original=${num(p.n("original"))}`
      + `:enhance=${num(p.n("enhance"))}:voice=${num(p.n("voice"))}`, pan("c0=FL+0.7071*FC|c1=FR+0.7071*FC")] },
  { id: "voice_enhance", group: "Clean-up", label: "Voice enhance", ffmpeg: "highpass, equalizer, deesser", params: [A("amount", "Amount", 0.5)],
    build: (p) => {
      const a = p.n("amount");
      return ["highpass=f=80:t=q:w=0.7071", `equalizer=f=300:t=q:w=1:g=${num(r(-4 * a, 1))}`, `equalizer=f=3000:t=q:w=0.9:g=${num(r(5 * a, 1))}`,
        `deesser=i=${num(r(0.2 + 0.5 * a, 2))}:m=0.5:f=0.5:s=o`];
    } },
  { id: "trim_silence", group: "Clean-up", label: "Trim silence (edges)", ffmpeg: "silenceremove (start, then reversed for the end)", changesLength: true,
    params: [DB("threshold", "Threshold", -50, -90, -10), S("keep", "Keep", 0.1, 0, 2)],
    build: (p) => {
      const sr = `silenceremove=start_periods=1:start_duration=0:start_threshold=${num(p.n("threshold"))}dB:start_silence=${num(p.n("keep"))}`;
      return [sr, "areverse", sr, "areverse"];
    } },
  { id: "noise_print", group: "Clean-up", label: "Noise print reduction", ffmpeg: "afftdn sample_noise (asendcmd) on the marked source range, then reduction",
    params: [DB("reduction", "Reduction", 12, 0, 60), DB("floor", "Noise floor", -50, -80, -20), P("noiseStart", "Noise from", 0, 0, 86400, "s"),
      P("noiseEnd", "Noise to", 0, 0, 86400, "s")],
    build: (p) => [noisePrintStep(p)] },
  { id: "hiss_reduction", group: "Clean-up", label: "Hiss reduction", ffmpeg: "acrossover, afftdn on the highs", params: [DB("reduction", "Reduction", 12, 0, 40),
    HZ("frequency", "Above", 4000, 1000, 12000)], build: (p) => [hissStep(p)] },
  { id: "dereverb", group: "Clean-up", label: "De-reverb (basic)", ffmpeg: "afftdn, agate on the tail", params: [A("amount", "Amount", 0.5)],
    build: (p) => {
      const a = p.n("amount");
      return [`afftdn=nr=${num(r(4 + 16 * a, 1))}:nf=-35:tn=1`,
        `agate=threshold=${lin(-30 - 10 * (1 - a), 0, 1)}:range=${lin(-6 - 18 * a, 0, 1)}:ratio=4:attack=2:release=${num(r(150 - 100 * a, 1))}:detection=peak:knee=2.828`];
    } },
  { id: "center_extract", group: "Clean-up", label: "Centre channel extract", ffmpeg: "stereotools (mid / side levels)",
    params: [C("mode", "Centre", "remove", ["remove", "keep"]), A("amount", "Amount", 1)],
    build: (p) => {
      const low = num(Math.max(0.015625, r(1 - p.n("amount"), 6)));
      return [p.s("mode") === "keep" ? `stereotools=mlev=1:slev=${low}` : `stereotools=mlev=${low}:slev=1`];
    } },

  // ── Time & pitch ──
  { id: "pitch_shift", group: "Time & pitch", label: "Pitch shift", ffmpeg: "rubberband (formants kept)",
    params: [P("semitones", "Semitones", 0, -12, 12, "st"), P("cents", "Cents", 0, -100, 100, "ct")],
    build: (p) => [`${p.f("rubberband", { semitones: ["pitch", (v) => ratioOf(v + p.n("cents") / 100)] })}=pitch=${ratioOf(p.n("semitones") + p.n("cents") / 100)}`
      + ":formant=preserved:pitchq=quality"] },
  { id: "time_stretch", group: "Time & pitch", label: "Time stretch", ffmpeg: "rubberband tempo", changesLength: true, params: [P("tempo", "Tempo", 1, 0.5, 2, "×")],
    build: (p) => [`${p.f("rubberband", { tempo: ["tempo"] })}=tempo=${num(p.n("tempo"))}`] },
  { id: "chipmunk", group: "Time & pitch", label: "Chipmunk", ffmpeg: "rubberband (formants shifted)", params: [P("semitones", "Semitones", 7, 3, 12, "st")],
    build: (p) => [`rubberband=pitch=${ratioOf(p.n("semitones"))}:formant=shifted`] },
  { id: "deep_voice", group: "Time & pitch", label: "Deep voice", ffmpeg: "rubberband (formants shifted)", params: [P("semitones", "Semitones", -5, -12, -2, "st")],
    build: (p) => [`rubberband=pitch=${ratioOf(p.n("semitones"))}:formant=shifted`] },
  { id: "robot", group: "Time & pitch", label: "Robot", ffmpeg: "afreqshift + aecho (comb)", params: [A("amount", "Amount", 1)],
    build: (p) => {
      const a = p.n("amount");
      return a <= 0 ? [] : [`afreqshift=shift=${num(r(-60 * a, 3))}`, `aecho=in_gain=1:out_gain=${num(r(1 / (1 + 0.6 * a), 4))}:delays=8|16:decays=${num(r(0.6 * a, 4))}|${num(r(0.36 * a, 4))}`];
    } },
  { id: "alien", group: "Time & pitch", label: "Alien", ffmpeg: "afreqshift, vibrato, aphaser", params: [A("amount", "Amount", 1)],
    build: (p) => {
      const a = p.n("amount");
      return a <= 0 ? [] : [`afreqshift=shift=${num(r(180 * a, 3))}`, ...vibrato(6, r(0.35 * a, 4)), `aphaser=type=s:speed=1.5:decay=${num(r(0.6 * a, 4))}`];
    } },
  { id: "pitch_bend", group: "Time & pitch", label: "Pitch bend", ffmpeg: "rubberband pitch, keyframed through asendcmd", params: [P("semitones", "Semitones", 0, -24, 24, "st")],
    build: (p) => [`${p.f("rubberband", { semitones: ["pitch", ratioOf] })}=pitch=${ratioOf(p.n("semitones"))}:formant=preserved`] },

  // ── Space ──
  { id: "reverb", group: "Space", label: "Reverb", ffmpeg: "afir (built-in impulse responses), adelay, extrastereo, amix",
    params: [C("preset", "Space", "room", REVERB_IRS), A("mix", "Mix", 0.3), A("width", "Width", 1, 0, 2), MS("predelay", "Pre-delay", 0, 0, 200)],
    build: (p) => [reverbStep(p, p.s("preset"), p.n("mix"), p.n("width"), p.n("predelay"))] },
  { id: "echo", group: "Space", label: "Echo", ffmpeg: "aecho (taps at k·delay)",
    params: [MS("delay", "Delay", 300, 5, 2000), A("feedback", "Feedback", 0.4, 0, 0.95), A("wet", "Echo level", 0.5)],
    build: (p) => [echoFilter(p.n("delay"), p.n("feedback"), p.n("wet"))] },
  { id: "stereo_widen", group: "Space", label: "Stereo widener", ffmpeg: "stereowiden",
    params: [MS("delay", "Delay", 20, 1, 100), A("feedback", "Feedback", 0.3, 0, 0.9), A("crossfeed", "Crossfeed", 0.3, 0, 0.8), A("drymix", "Dry", 0.8)],
    build: (p) => [`${p.f("stereowiden", { feedback: ["feedback"], crossfeed: ["crossfeed"], drymix: ["drymix"] })}=delay=${num(p.n("delay"))}`
      + `:feedback=${num(p.n("feedback"))}:crossfeed=${num(p.n("crossfeed"))}:drymix=${num(p.n("drymix"))}`] },
  // FFmpeg's haas filter isn't a plain delay (it rebuilds both sides from the mid signal): delay one channel instead
  { id: "haas", group: "Space", label: "Haas widener", ffmpeg: "adelay on one channel", changesLength: true,
    params: [MS("delay", "Delay", 15, 1, 40), C("channel", "Delayed side", "right", ["left", "right"])],
    build: (p) => {
      const d = num(p.n("delay"));
      return [`adelay=delays=${p.s("channel") === "left" ? `${d}|0` : `0|${d}`}:all=0`];
    } },
  { id: "mono", group: "Space", label: "Mono", ffmpeg: "extrastereo (side × (1 − amount))", params: [A("amount", "Amount", 1)],
    build: (p) => [`${p.f("extrastereo", { amount: ["m", (v) => num(r(1 - v, 6))] })}=m=${num(r(1 - p.n("amount"), 6))}:c=0`] },
  { id: "auto_pan", group: "Space", label: "Auto pan", ffmpeg: "apulsator", params: [P("rate", "Rate", 2, 0.01, 20, "Hz"), A("depth", "Depth", 1)],
    build: (p) => [`apulsator=hz=${num(p.n("rate"))}:amount=${num(p.n("depth"))}`] },
  { id: "doppler", group: "Space", label: "Doppler", ffmpeg: "rubberband pitch (asendcmd), aeval level and pan",
    params: [C("path", "Path", "pass_lr", ["pass_lr", "pass_rl", "approach", "recede"]), P("speed", "Speed", 20, 1, 100, "m/s"), P("distance", "Closest distance", 3, 0.5, 50, "m"),
      A("center", "Closest at", 0.5)],
    build: (p) => dopplerSteps(p) },

  // ── Modulation & creative ──
  // FFmpeg 7.1's chorus treats `delays` as its buffer size only (it sounds like a flanger): a sine flanger without
  // feedback is the one-voice chorus the preview plays (in + mix · in(t − delay − depth·(1 + sin)/2))
  { id: "chorus", group: "Modulation & creative", label: "Chorus", ffmpeg: "flanger (sine, no feedback), volume",
    params: [MS("delay", "Delay", 25, 5, 50), MS("depth", "Depth", 2, 0.1, 10), P("rate", "Rate", 0.5, 0.05, 5, "Hz"), A("mix", "Mix", 0.5)],
    build: (p) => [`flanger=delay=${num(p.n("delay"))}:depth=${num(p.n("depth"))}:regen=0:width=${num(r(p.n("mix") * 100, 4))}:speed=${num(p.n("rate"))}`
      + ":shape=sinusoidal:phase=25:interp=linear", `volume=${num(r(1 + p.n("mix"), 6))}`] },
  { id: "flanger", group: "Modulation & creative", label: "Flanger", ffmpeg: "flanger",
    params: [MS("delay", "Delay", 0, 0, 30), MS("depth", "Depth", 2, 0, 10), P("regen", "Feedback", 0, -95, 95, "%"), P("width", "Mix", 71, 0, 100, "%"),
      P("speed", "Rate", 0.5, 0.1, 10, "Hz")],
    build: (p) => [`flanger=delay=${num(p.n("delay"))}:depth=${num(p.n("depth"))}:regen=${num(p.n("regen"))}:width=${num(p.n("width"))}:speed=${num(p.n("speed"))}`] },
  { id: "phaser", group: "Modulation & creative", label: "Phaser", ffmpeg: "aphaser",
    params: [A("inGain", "Input", 0.4), A("outGain", "Output", 0.74), MS("delay", "Delay", 3, 0.1, 5), A("decay", "Decay", 0.4, 0, 0.99), P("speed", "Rate", 0.5, 0.1, 2, "Hz"),
      C("type", "Wave", "t", ["t", "s"])],
    build: (p) => [`aphaser=in_gain=${num(p.n("inGain"))}:out_gain=${num(p.n("outGain"))}:delay=${num(p.n("delay"))}:decay=${num(p.n("decay"))}:speed=${num(p.n("speed"))}`
      + `:type=${p.s("type")}`] },
  { id: "tremolo", group: "Modulation & creative", label: "Tremolo", ffmpeg: "tremolo", params: [P("rate", "Rate", 5, 0.1, 20, "Hz"), A("depth", "Depth", 0.5)],
    build: (p) => [`tremolo=f=${num(p.n("rate"))}:d=${num(p.n("depth"))}`] },
  { id: "vibrato", group: "Modulation & creative", label: "Vibrato", ffmpeg: "vibrato", params: [P("rate", "Rate", 5, 0.1, 20, "Hz"), A("depth", "Depth", 0.5)],
    build: (p) => vibrato(p.n("rate"), p.n("depth")) },
  { id: "distortion", group: "Modulation & creative", label: "Distortion", ffmpeg: "volume, asoftclip, volume",
    params: [C("type", "Type", "tanh", CLIP_TYPES), DB("drive", "Drive", 12, 0, 48), DB("output", "Output", 0, -24, 12)],
    build: (p) => [`volume=${num(p.n("drive"))}dB`, `asoftclip=type=${p.s("type")}`, `volume=${num(p.n("output"))}dB`] },
  { id: "bitcrusher", group: "Modulation & creative", label: "Bitcrusher", ffmpeg: "acrusher (sample-and-hold), aeval (bits), asplit + amix for the dry mix",
    params: [P("bits", "Bits", 8, 1, 16), P("samples", "Downsample", 1, 1, 64, "×"), A("mix", "Mix", 1)],
    build: (p) => {
      const mix = p.n("mix");
      const wet = crusher(p.n("bits"), p.n("samples"));
      if (mix >= 1 - 1e-9) return wet;
      if (mix <= 1e-9) return [];
      const u = p.uid;
      return [{ graph: (inL, outL) => [`[${inL}]asplit=2[${u}d][${u}w]`, `[${u}w]${wet.join(",")}[${u}c]`,
        `[${u}d][${u}c]amix=inputs=2:weights='${num(r(1 - mix, 6))} ${num(r(mix, 6))}':normalize=0:duration=first[${outL}]`] }];
    } },
  { id: "lofi", group: "Modulation & creative", label: "Lo-fi", ffmpeg: "acrusher (sample-and-hold), aeval (bits), lowpass",
    params: [P("bits", "Bits", 10, 4, 16), P("samples", "Downsample", 3, 1, 16, "×"), HZ("cutoff", "Tone", 5000, 1000, 12000)],
    build: (p) => [...crusher(p.n("bits"), p.n("samples")), `lowpass=f=${num(p.n("cutoff"))}:t=q:w=0.707`] },
  { id: "telephone", group: "Modulation & creative", label: "Telephone", ffmpeg: "highpass, lowpass (24 dB/oct)", params: [HZ("low", "Low cut", 300, 100, 1000), HZ("high", "High cut", 3400, 2000, 8000)],
    build: (p) => [`highpass=f=${num(p.n("low"))}:t=q:w=0.707`, `highpass=f=${num(p.n("low"))}:t=q:w=0.707`, `lowpass=f=${num(p.n("high"))}:t=q:w=0.707`,
      `lowpass=f=${num(p.n("high"))}:t=q:w=0.707`] },
  { id: "radio", group: "Modulation & creative", label: "Old radio", ffmpeg: "highpass, lowpass, asoftclip, anoisesrc static",
    params: [HZ("low", "Low cut", 200, 50, 1000), HZ("high", "High cut", 5000, 2000, 10000), DB("drive", "Drive", 6, 0, 30), DB("noise", "Static", -50, -90, -20)],
    build: (p) => {
      const out: (string | GraphStep)[] = [`highpass=f=${num(p.n("low"))}:t=q:w=0.707`, `lowpass=f=${num(p.n("high"))}:t=q:w=0.707`, `volume=${num(p.n("drive"))}dB`,
        "asoftclip=type=atan", `volume=${num(-p.n("drive") / 2)}dB`];
      const st = staticStep(p, p.n("noise"));
      if (st) out.push(st);
      return out;
    } },
  { id: "megaphone", group: "Modulation & creative", label: "Megaphone", ffmpeg: "highpass, lowpass, asoftclip (hard)",
    params: [HZ("low", "Low cut", 500, 100, 1500), HZ("high", "High cut", 3500, 1500, 8000), DB("drive", "Drive", 12, 0, 36)],
    build: (p) => [`highpass=f=${num(p.n("low"))}:t=q:w=0.707`, `lowpass=f=${num(p.n("high"))}:t=q:w=0.707`, "equalizer=f=1800:t=q:w=1:g=6", `volume=${num(p.n("drive"))}dB`,
      "asoftclip=type=hard", `volume=${num(-p.n("drive") / 2)}dB`] },
  { id: "walkie_talkie", group: "Modulation & creative", label: "Walkie-talkie", ffmpeg: "highpass, lowpass, asoftclip (hard), anoisesrc static",
    params: [HZ("low", "Low cut", 400, 100, 1500), HZ("high", "High cut", 2800, 1500, 8000), DB("drive", "Drive", 18, 0, 36), DB("noise", "Static", -40, -90, -20)],
    build: (p) => {
      const out: (string | GraphStep)[] = [`highpass=f=${num(p.n("low"))}:t=q:w=0.707`, `highpass=f=${num(p.n("low"))}:t=q:w=0.707`, `lowpass=f=${num(p.n("high"))}:t=q:w=0.707`,
        `lowpass=f=${num(p.n("high"))}:t=q:w=0.707`, `volume=${num(p.n("drive"))}dB`, "asoftclip=type=hard", `volume=${num(-p.n("drive") / 2)}dB`];
      const st = staticStep(p, p.n("noise"), "white");
      if (st) out.push(st);
      return out;
    } },
  { id: "underwater", group: "Modulation & creative", label: "Underwater", ffmpeg: "lowpass, vibrato", params: [HZ("cutoff", "Muffle", 600, 100, 2000), A("wobble", "Wobble", 0.3)],
    build: (p) => {
      const out = [`lowpass=f=${num(p.n("cutoff"))}:t=q:w=0.707`, `lowpass=f=${num(p.n("cutoff"))}:t=q:w=0.707`];
      if (p.n("wobble") > 0) out.push(...vibrato(1.2, r(p.n("wobble") * 0.5, 4)));
      return out;
    } },
  { id: "next_room", group: "Modulation & creative", label: "Next room", ffmpeg: "lowpass, the room impulse response, volume",
    params: [HZ("cutoff", "Wall", 400, 100, 2000), A("room", "Room", 0.35), DB("level", "Level", -6, -24, 0)],
    build: (p) => {
      const out: (string | GraphStep)[] = [`lowpass=f=${num(p.n("cutoff"))}:t=q:w=0.707`, `lowpass=f=${num(p.n("cutoff"))}:t=q:w=0.707`];
      if (p.n("room") > 0) out.push(reverbStep(p, "room", p.n("room"), 1, 0));
      out.push(`volume=${num(p.n("level"))}dB`);
      return out;
    } },
  { id: "vinyl", group: "Modulation & creative", label: "Vinyl", ffmpeg: "vibrato (wow), aevalsrc (crackle)", params: [A("crackle", "Crackle", 0.5), A("wow", "Wow", 0.3)],
    build: (p) => {
      const out: (string | GraphStep)[] = [];
      if (p.n("wow") > 0) out.push(...vibrato(0.55, r(0.02 + 0.12 * p.n("wow"), 4)));
      const crackle = p.n("crackle");
      if (crackle > 0) {
        const u = p.uid;
        const prob = num(r(0.0004 * crackle, 7));
        const amp = num(r(0.5 * crackle, 4));
        const dur = num(r(Math.max(0.05, p.duration) + 0.1, 3));
        out.push({ graph: (inL, outL) => [
          `aevalsrc=exprs='if(lt(random(0),${prob}),(random(1)-0.5)*${amp},0)|if(lt(random(2),${prob}),(random(3)-0.5)*${amp},0)':s=48000:d=${dur}`
            + `,highpass=f=900:t=q:w=0.707,aformat=sample_fmts=fltp:channel_layouts=stereo[${u}cr]`,
          `[${inL}][${u}cr]amix=inputs=2:normalize=0:duration=first[${outL}]`] });
      }
      return out;
    } },
  { id: "guitar_amp", group: "Modulation & creative", label: "Guitar amp", ffmpeg: "lowshelf / equalizer / highshelf, asoftclip, afir (cabinet impulse response)",
    params: [DB("drive", "Drive", 24, 0, 48), C("type", "Character", "tanh", CLIP_TYPES), DB("bass", "Bass", 0, -12, 12), DB("mid", "Mid", 0, -12, 12), DB("treble", "Treble", 0, -12, 12),
      C("cabinet", "Cabinet", "cab_4x12", [...CABINET_IRS, "none"]), DB("level", "Level", -12, -36, 6)],
    build: (p) => {
      const out: (string | GraphStep)[] = [`volume=${num(p.n("drive"))}dB`, `asoftclip=type=${p.s("type")}`];
      if (nz(p.n("bass"))) out.push(`lowshelf=f=120:${SHELF}:g=${num(p.n("bass"))}`);
      if (nz(p.n("mid"))) out.push(`equalizer=f=800:t=q:w=0.8:g=${num(p.n("mid"))}`);
      if (nz(p.n("treble"))) out.push(`highshelf=f=3200:${SHELF}:g=${num(p.n("treble"))}`);
      if (p.s("cabinet") !== "none") out.push(cabinetStep(p, p.s("cabinet")));
      out.push(`volume=${num(p.n("level"))}dB`);
      return out;
    } },
  { id: "invert", group: "Modulation & creative", label: "Invert", ffmpeg: "pan (= invert_polarity)", params: [C("channel", "Channels", "both", ["both", "left", "right"])],
    build: (p) => [invert(p.s("channel"))] },
  { id: "silence", group: "Modulation & creative", label: "Silence", ffmpeg: "volume=0", params: [], build: () => ["volume=0"] },

  // ── Utility ──
  { id: "channel_swap", group: "Utility", label: "Swap channels", ffmpeg: "pan", params: [], build: () => [pan("c0=c1|c1=c0")] },
  { id: "left_only", group: "Utility", label: "Left channel only", ffmpeg: "pan", params: [], build: () => [pan("c0=c0|c1=c0")] },
  { id: "right_only", group: "Utility", label: "Right channel only", ffmpeg: "pan", params: [], build: () => [pan("c0=c1|c1=c1")] },
  { id: "invert_polarity", group: "Utility", label: "Invert polarity", ffmpeg: "pan", params: [C("channel", "Channels", "both", ["both", "left", "right"])],
    build: (p) => [invert(p.s("channel"))] },
  { id: "mono_to_stereo", group: "Utility", label: "Mono to stereo", ffmpeg: "mono sum, adelay, amerge, pan (M ± width · delayed M)",
    params: [MS("delay", "Delay", 12, 1, 40), A("width", "Width", 0.5)],
    build: (p) => {
      const u = p.uid;
      const w = num(p.n("width"));
      return [{ graph: (inL, outL) => [`[${inL}]pan=mono|c0=0.5*c0+0.5*c1,asplit=2[${u}m][${u}md]`,
        `[${u}md]adelay=delays=${num(p.n("delay"))}:all=1[${u}dl]`,
        `[${u}m][${u}dl]amerge=inputs=2,pan=stereo|c0=c0+${w}*c1|c1=c0-${w}*c1[${outL}]`] }];
    } },
  { id: "delay_sync", group: "Utility", label: "Delay (sync)", ffmpeg: "adelay (ms)", changesLength: true, params: [MS("delay", "Delay", 0, 0, 500)],
    build: (p) => (p.n("delay") > 0 ? [`adelay=delays=${num(p.n("delay"))}:all=1`] : []) },
];

export const FX_BY_ID = new Map(AUDIO_FX.map((d) => [d.id, d]));

/** Filters that take runtime commands in FFmpeg 7.1 (asendcmd can drive their keyframes). */
export const CMD_FILTERS = new Set(["acompressor", "acrusher", "aexciter", "afftdn", "afir", "afreqshift", "afwtdn", "agate", "alimiter", "anlmdn", "asoftclip",
  "bandpass", "bandreject", "bass", "compensationdelay", "crystalizer", "dialoguenhance", "dynaudnorm", "equalizer", "extrastereo", "highpass", "highshelf",
  "lowpass", "lowshelf", "rubberband", "speechnorm", "stereowiden", "tiltshelf", "treble", "virtualbass", "volume"]);

const ALIASES: Record<string, string> = { eq: "eq3", "3band": "eq3", eq3band: "eq3", noise_gate: "gate", noisegate: "gate", noise_reduction: "denoise",
  noise_removal: "denoise", voice: "voice_enhance", comp: "compressor", volume: "gain", de_esser: "deesser", reverse_polarity: "invert_polarity",
  graphic_eq: "eq_graphic", parametric_eq: "eq_param", surround_reverb: "reverb", mute: "silence" };

/** The effect's id without the "audio:" prefix, with the aliases applied. */
export function audioFxId(type: string): string {
  const t = String(type ?? "").replace(/^audio:/i, "");
  return ALIASES[t.toLowerCase()] ?? (FX_BY_ID.has(t) ? t : t.toLowerCase());
}

export interface FxCtx {
  /** unique prefix for filter instances and labels in this graph */
  uid: string;
  /** chain seconds */
  duration: number;
  /** keyframe frame → chain seconds: frame / fps + shift */
  fps: number;
  shift: number;
  irFile(preset: IrPreset): string;
  warn(msg: string): void;
  /** clip effects: the source file (noise_print's noise range is in its seconds) */
  source?: { file: string };
}

/** What a list of effects becomes: steps for the chain (plain filters and graph steps), and whether the length changes. */
export interface FxChain { steps: (string | GraphStep)[]; changesLength: boolean }

const KF_STEP = 0.05;
const KF_MAX = 300;

function keyPoints(p: Param<unknown> | undefined, ctx: FxCtx): [number, number, Easing][] | null {
  const k = (Array.isArray(p?.keyframes) ? p!.keyframes : []).filter((x): x is Keyframe<unknown> => Number.isFinite(x?.frame) && Number.isFinite(Number(x?.value)));
  if (k.length < 2) return null;
  return curvePoints(k as Keyframe<number>[], ctx.fps, ctx.shift);
}

/** Effects (clip, track or master) → chain steps. Unknown "audio:" effects and unhandled keyframes warn. */
export function buildFx(effects: EffectInstance[], ctx: FxCtx): FxChain {
  const steps: (string | GraphStep)[] = [];
  let changesLength = false;
  effects.forEach((e, ei) => {
    if (!e || e.enabled === false) return;
    const id = audioFxId(e.type);
    const def = FX_BY_ID.get(id);
    if (!def) {
      if (/^audio:/i.test(String(e.type))) ctx.warn(`the ${String(e.type).replace(/^audio:/i, "")} effect isn't in the export yet`);
      return;
    }
    const spec = new Map(def.params.map((x) => [x.name, x]));
    const raw = (name: string): unknown => {
      const prm = e.params?.[name] as Param<unknown> | undefined;
      if (!prm) return spec.get(name)?.default;
      const k = Array.isArray(prm.keyframes) ? prm.keyframes : [];
      return k.length ? k[0].value : prm.value;
    };
    const clampP = (name: string, v: number) => {
      const s = spec.get(name);
      return s && s.min !== undefined && s.max !== undefined ? clamp(v, s.min, s.max) : v;
    };
    const handled = new Set<string>();
    const cmds: string[] = [];
    let inst = 0;
    const uid = `${ctx.uid}e${ei}`;
    const values: Values = {
      n: (name) => {
        const d = Number(spec.get(name)?.default ?? 0);
        const v = Number(raw(name));
        return clampP(name, Number.isFinite(v) ? v : d);
      },
      s: (name) => {
        const s = spec.get(name);
        const v = String(raw(name) ?? s?.default ?? "");
        return s?.options && !s.options.includes(v) ? String(s.default) : v;
      },
      points: (name) => {
        const pts = keyPoints(e.params?.[name] as Param<unknown> | undefined, ctx);
        return pts ? pts.map(([t, v, ez]) => [t, clampP(name, v), ez]) : null;
      },
      f: (filter, map = {}) => {
        const live = Object.entries(map).filter(([pn]) => keyPoints(e.params?.[pn] as Param<unknown> | undefined, ctx));
        if (!live.length || !CMD_FILTERS.has(filter)) return filter;
        const name = `${filter}@${uid}i${inst++}`;
        for (const [pn, [opt, fmt]] of live) {
          handled.add(pn);
          const pts = values.points(pn)!;
          const t0 = Math.max(0, pts[0][0]);
          const t1 = Math.min(Math.max(t0, pts[pts.length - 1][0]), Math.max(t0, ctx.duration));
          const step = Math.max(KF_STEP, (t1 - t0) / KF_MAX);
          let last = "";
          for (let t = t0; t <= t1 + 1e-9; t += step) {
            const v = fmt ? fmt(pwlAt(pts, t)) : num(r(pwlAt(pts, t), 4));
            if (v !== last) cmds.push(`${t.toFixed(3)} ${name} ${opt} ${v}`);
            last = v;
          }
          const end = fmt ? fmt(pwlAt(pts, t1)) : num(r(pwlAt(pts, t1), 4));
          if (end !== last) cmds.push(`${t1.toFixed(3)} ${name} ${opt} ${end}`);
        }
        return name;
      },
      handled: (name) => { handled.add(name); },
      duration: ctx.duration,
      uid,
      irFile: (preset) => ctx.irFile(isIrPreset(preset) ? preset : "room"),
      ...(ctx.source ? { source: ctx.source } : {}),
    };
    const out = def.build(values);
    for (const [name] of spec) {
      if (!handled.has(name) && keyPoints(e.params?.[name] as Param<unknown> | undefined, ctx)) {
        ctx.warn(`${def.label}: ${spec.get(name)?.label ?? name} keyframes aren't in the export, so its first keyframe is used`);
      }
    }
    if (cmds.length) steps.push(`asendcmd=c='${cmds.join(";")}'`);
    steps.push(...out);
    if (def.changesLength && out.length) changesLength = true;
  });
  return { steps, changesLength };
}

/**
 * Graph statements: `[inL]` → `head` filters → the effect steps → `tail` filters → `[outL]`. Without graph steps this
 * is one chain, `[in]a,b,c[out]` (or `[in]anull[out]` when there is nothing to do).
 */
export function layChain(inL: string, head: string[], steps: (string | GraphStep)[], tail: string[], outL: string, uid: string): string[] {
  const out: string[] = [];
  let cur = inL;
  let buf = [...head];
  let k = 0;
  for (const st of steps) {
    if (typeof st === "string") { buf.push(st); continue; }
    let from = cur;
    if (buf.length) {
      from = `${uid}s${k}`;
      out.push(`[${cur}]${buf.join(",")}[${from}]`);
      buf = [];
    }
    const to = `${uid}g${k}`;
    out.push(...st.graph(from, to));
    cur = to;
    k++;
  }
  buf.push(...tail);
  out.push(`[${cur}]${buf.length ? buf.join(",") : "anull"}[${outL}]`);
  return out;
}

/** The parameters of an effect id, for the docs and the effect browser (null when the id isn't known). */
export function fxParams(id: string): FxParam[] | null {
  return FX_BY_ID.get(audioFxId(id))?.params.map((x) => ({ ...x })) ?? null;
}
