/**
 * The sound of a Tatvam Editor export (docs/EDITOR.md §5): one FFmpeg filtergraph from a sequence's audio clips.
 * Per clip: the source in/out (input seek + atrim), asetpts, reverse (areverse), speed (the atempo chain), gain (static
 * dB, or keyframes as a piecewise expression evaluated per frame), pan (balance for stereo sources, constant power for
 * mono), fades and crossfades (afade over the transition, the clips extended into their handles), then adelay to the
 * clip's place in the range. Track volume and pan add to the clip's; muted tracks are skipped and, when any audio track
 * is soloed, only soloed tracks play. Everything is summed with amix normalize=0 into a 48 kHz stereo float WAV
 * (the final mux runs loudnorm, like the render path). Long sequences mix in batches, then the batches are summed.
 * Pure: returns argument lists. Unit tests: test/editor-audio.test.ts.
 */
import type { EditProject, Easing, Keyframe, MediaItem, Param, Sequence, TimelineClip, Track, Transition } from "../shared/types.ts";
import { atempoChain } from "./render-args.ts";
import { fpsExact, framesToSeconds } from "./editor-model.ts";

export const MIX_RATE = 48000;
/** Clips per FFmpeg run (Windows' command line is 32k characters). */
export const MIX_BATCH = 40;

const f3 = (x: number) => (Math.round(x * 1000) / 1000).toFixed(3);
const f6 = (x: number) => (Math.round(x * 1e6) / 1e6).toString();
const num = (x: number) => String(Math.round(x * 1e6) / 1e6);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** One clip's sound, resolved: everything in seconds except where named. */
export interface MixClip {
  clipId: string;
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
  fadeInCurve: "tri" | "qsin";
  fadeOutCurve: "tri" | "qsin";
}

export interface MixPlan { clips: MixClip[]; range: { start: number; end: number }; warnings: string[] }

const crossfadeCurve = (type: string): "tri" | "qsin" => (/gain|linear|tri/i.test(type) ? "tri" : "qsin");

function points<T extends number>(p: Param<T> | undefined, fps: number, shiftS: number): [number, number, Easing][] | undefined {
  const k = (p?.keyframes ?? []).filter((x): x is Keyframe<T> => Number.isFinite(x?.frame) && Number.isFinite(Number(x?.value)));
  if (k.length < 2) return undefined;
  return [...k].sort((a, b) => a.frame - b.frame).map((x) => [framesToSeconds(x.frame, fps) + shiftS, Number(x.value), x.ease ?? "linear"]);
}

/** The value of a keyframed param where it has a single keyframe (or none): that keyframe, else the plain value. */
function staticOf(p: Param<number> | undefined, dflt: number): number {
  const k = p?.keyframes ?? [];
  if (k.length === 1 && Number.isFinite(Number(k[0].value))) return Number(k[0].value);
  return Number.isFinite(Number(p?.value)) ? Number(p!.value) : dflt;
}

/**
 * The audible clips of a sequence (pure): audio-track clips with media that has sound, plus video-track clips that
 * carry `audio` settings and have no linked audio-track half. Crossfades on audio tracks extend both clips into their
 * handles and fade them over the transition; an edge transition fades that clip.
 */
export function mixPlan(project: EditProject, seq: Sequence, range: { in: number; out: number }, resolve?: (m: MediaItem) => string | null): MixPlan {
  const fps = seq.fps;
  const warnings: string[] = [];
  const media = new Map(project.media.map((m) => [m.id, m]));
  const tracks = new Map(seq.tracks.map((t) => [t.id, t]));
  const audioTracks = seq.tracks.filter((t) => t.kind === "audio");
  const solo = audioTracks.some((t) => t.solo);
  const audible = (t: Track | undefined) => Boolean(t) && !t!.muted && (!solo || (t!.kind === "audio" && t!.solo));
  const linkedAudio = new Set(seq.clips.filter((c) => c.linkId && tracks.get(c.trackId)?.kind === "audio").map((c) => c.linkId));

  // per clip: timeline extension (frames) for crossfades, and transition fades (frames + curve)
  type Ext = { head: number; tail: number; fadeIn?: [number, "tri" | "qsin"]; fadeOut?: [number, "tri" | "qsin"] };
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
    if (c.enabled === false || c.source.type !== "media") {
      if (c.enabled !== false && c.source.type === "nested" && tracks.get(c.trackId)?.kind === "audio") warnings.push(`${c.name}: a nested sequence's sound isn't mixed yet`);
      continue;
    }
    const t = tracks.get(c.trackId);
    if (!t) continue;
    if (t.kind === "video" && (!c.audio || (c.linkId && linkedAudio.has(c.linkId)))) continue;
    if (!audible(t)) continue;
    const m = media.get(c.source.mediaId);
    if (!m || m.kind === "image" || !m.hasAudio) continue;
    const file = resolve ? resolve(m) : m.path;
    if (!file || m.missing || m.offline) {
      warnings.push(`${c.name}: its media is missing, so it is silent in the export`);
      continue;
    }
    const e = ext.get(c.id) ?? { head: 0, tail: 0 };
    const speed = clamp(Number(c.speed) || 1, 0.1, 16);
    const srcFps = m.fps > 0 ? m.fps : fps;
    // a head extension needs source before the in point (reversed clips can't extend backwards): clamp to what exists
    let head = c.reverse ? 0 : e.head;
    const inS = c.source.in / fpsExact(srcFps);
    const headS = Math.min(framesToSeconds(head, fps), inS / speed);
    head = Math.round(headS * fpsExact(fps));
    const tail = c.reverse ? 0 : e.tail;
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
    out.push({
      clipId: c.id, file, channels: m.audioChannels ?? 2,
      start: framesToSeconds(startF, fps), duration: framesToSeconds(durF, fps),
      in: Math.max(0, inS - headS * speed), speed, reverse: Boolean(c.reverse),
      gainDb: staticOf(a?.gain, 0) + trackVol,
      gainPoints: gp?.map(([s, v, ez]) => [s, v + trackVol, ez]),
      pan: clamp(staticOf(a?.pan, 0) + trackPan, -1, 1),
      panPoints: pp?.map(([s, v, ez]) => [s, clamp(v + trackPan, -1, 1), ez]),
      fadeIn: framesToSeconds(Math.min(fadeIn, durF), fps), fadeOut: framesToSeconds(Math.min(fadeOut, durF), fps),
      fadeInCurve: e.fadeIn && e.fadeIn[0] >= (Number(a?.fadeIn) || 0) ? e.fadeIn[1] : "tri",
      fadeOutCurve: e.fadeOut && e.fadeOut[0] >= (Number(a?.fadeOut) || 0) ? e.fadeOut[1] : "tri",
    });
  }
  out.sort((x, y) => x.start - y.start || x.clipId.localeCompare(y.clipId));
  return { clips: out, range: { start: framesToSeconds(range.in, fps), end: framesToSeconds(range.out, fps) }, warnings };
}

/** Piecewise expression of t from keyframe points (held before the first and after the last). */
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
      const shaped = ease === "ease_in" ? `pow(${p},2)` : ease === "ease_out" ? `(1-pow(1-${p},2))` : ease === "ease_in_out" ? `(${p}*${p}*(3-2*${p}))` : p;
      seg = `${num(v0)}+${num(v1 - v0)}*${shaped}`;
    }
    expr = `if(lt(${v},${f6(t1)}),${seg},${expr})`;
  }
  return `if(lt(${v},${f6(pts[0][0])}),${num(pts[0][1])},${expr})`;
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

/** The filter chain of one clip (input label → output label), relative to the range start `t0` (seconds). */
export function clipChain(c: MixClip, input: string, label: string, t0: number): string {
  const src = c.duration * c.speed;
  const f: string[] = ["aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo", `atrim=0:${f6(src)}`, "asetpts=PTS-STARTPTS"];
  if (c.reverse) f.push(`apad=whole_dur=${f6(src)}`, "areverse");
  if (Math.abs(c.speed - 1) > 1e-4) f.push(atempoChain(c.speed));
  if (c.gainPoints) f.push(`volume='pow(10,(${pwlExpr(c.gainPoints)})/20)':eval=frame`);
  else if (Math.abs(c.gainDb) > 1e-6) f.push(`volume=${num(c.gainDb)}dB`);
  const mono = c.channels === 1;
  if (c.panPoints) {
    const [l, r] = panExprs(c.panPoints, mono);
    f.push(`aeval=exprs='val(0)*${l}|val(1)*${r}':c=stereo`);
  } else if (Math.abs(c.pan) > 1e-6 || mono) {
    const [l, r] = panGains(c.pan, mono);
    if (Math.abs(l - 1) > 1e-6 || Math.abs(r - 1) > 1e-6) f.push(`pan=stereo|c0=${num(l)}*c0|c1=${num(r)}*c1`);
  }
  if (c.fadeIn > 0) f.push(`afade=t=in:st=0:d=${f3(c.fadeIn)}:curve=${c.fadeInCurve}`);
  if (c.fadeOut > 0) f.push(`afade=t=out:st=${f3(Math.max(0, c.duration - c.fadeOut))}:d=${f3(c.fadeOut)}:curve=${c.fadeOutCurve}`);
  const rel = c.start - t0;
  if (rel < 0) f.push(`atrim=start=${f6(-rel)}`, "asetpts=PTS-STARTPTS");
  const delay = Math.round(Math.max(0, rel) * MIX_RATE);
  if (delay > 0) f.push(`adelay=${delay}S|${delay}S`);
  return `[${input}]${f.join(",")}[${label}]`;
}

/** Input options of one clip: seek to its source region (with a little margin for reversed / stretched sources). */
export function clipInput(c: MixClip): string[] {
  return ["-ss", f6(c.in), "-t", f6(c.duration * c.speed + 0.05), "-i", c.file];
}

/**
 * The FFmpeg runs that make the mix WAV: one when the clips fit in a batch, else one per batch (into `part(i)`) and a
 * final sum. `loudnorm` (optional) is appended to the last run.
 */
export function mixJobs(plan: MixPlan, out: string, opts: { part?: (i: number) => string; loudnorm?: string | null } = {}): string[][] {
  const total = Math.max(0.001, plan.range.end - plan.range.start);
  const tail = (graphOut: string) => (opts.loudnorm ? `${graphOut},${opts.loudnorm},aresample=48000` : graphOut);
  const enc = ["-ac", "2", "-ar", String(MIX_RATE), "-c:a", "pcm_f32le", "-t", f3(total)];
  const one = (clips: MixClip[], file: string, last: boolean): string[] => {
    if (!clips.length) {
      const g = last && opts.loudnorm ? ["-af", `${opts.loudnorm},aresample=48000`] : [];
      return ["-f", "lavfi", "-i", `anullsrc=r=${MIX_RATE}:cl=stereo`, ...g, ...enc, file];
    }
    const args: string[] = [];
    const g: string[] = [];
    clips.forEach((c, i) => {
      args.push(...clipInput(c));
      g.push(clipChain(c, `${i}:a`, `c${i}`, plan.range.start));
    });
    const labels = clips.map((_, i) => `[c${i}]`).join("");
    const sum = clips.length > 1 ? `${labels}amix=inputs=${clips.length}:normalize=0:duration=longest:dropout_transition=0,apad` : `${labels}apad`;
    g.push(`${last ? tail(sum) : sum}[mix]`);
    return [...args, "-filter_complex", g.join(";"), "-map", "[mix]", ...enc, file];
  };
  if (plan.clips.length <= MIX_BATCH) return [one(plan.clips, out, true)];
  const part = opts.part ?? ((i: number) => out.replace(/(\.\w+)?$/, `_part${i}.wav`));
  const jobs: string[][] = [];
  const parts: string[] = [];
  for (let i = 0; i * MIX_BATCH < plan.clips.length; i++) {
    const file = part(i);
    parts.push(file);
    jobs.push(one(plan.clips.slice(i * MIX_BATCH, (i + 1) * MIX_BATCH), file, false));
  }
  const args: string[] = [];
  parts.forEach((p) => args.push("-i", p));
  const sum = `${parts.map((_, i) => `[${i}:a]`).join("")}amix=inputs=${parts.length}:normalize=0:duration=longest:dropout_transition=0,apad`;
  jobs.push([...args, "-filter_complex", `${tail(sum)}[mix]`, "-map", "[mix]", ...enc, out]);
  return jobs;
}
