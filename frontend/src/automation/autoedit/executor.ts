/**
 * The auto edit executor (docs/EDITOR.md §13.3): a plan → a new sequence "Auto edit · <folder> · <style>" in the
 * project, built with the editor's own pure operations (clipsFromMedia / placeClips, addTransition, addGenerated
 * titles, the moods' applyMood, the speed-ramp presets, the audio effect registry). Pure: the caller runs it inside
 * ONE store command (`exec("Assistant: auto_edit", (p) => buildAutoEdit(p, plan).project)`), so Ctrl+Z takes the whole
 * sequence back. Watch folders append to that sequence, or rebuild it in place.
 */
import { captionStyle, titleSpec } from "../../editor/ai/commands.ts";
import { coverScale } from "../../editor/ai/wave3.ts";
import { audioFxDefaults, audioFxType } from "../../editor/audiofx/registry.ts";
import { defaultTitle, newSequence } from "../../editor/model/defaults.ts";
import { uid } from "../../editor/model/ids.ts";
import { addGenerated, addTransition, clipsFromMedia, ctxOf, normalize, placeClips, seqEnd, tracksOf, type Ctx } from "../../editor/model/ops.ts";
import { applyRampPreset } from "../../editor/model/retime.ts";
import { secondsToFrames } from "../../editor/model/time.ts";
import type { EditProject, EffectInstance, MediaItem, Sequence, TimelineClip, Track } from "../../editor/model/types.ts";
import { applyMood } from "../../editor/moods/apply.ts";
import { moodById } from "../../lib/moods.ts";
import type { Plan, PlanSegment } from "./types.ts";

export interface BuildOptions {
  /** add the plan's clips at the end of this sequence (watch folder "append") */
  appendTo?: string;
  /** replace the sequence with the plan's name, keeping its id (watch folder "rebuild") */
  rebuild?: boolean;
}
export interface BuildResult { project: EditProject; sequenceId: string; clips: number; warnings: string[] }

/** Source frames of a media item for media seconds (video: its frame rate; audio: its sample rate). */
const srcFrames = (m: MediaItem, s: number) => Math.max(0, Math.round(s * (m.fps > 0 ? m.fps : 25)));

const TRACK_NAMES = { v: ["Picture", "Titles", "Captions"], a: ["Dialogue", "Dialogue 2", "Music"] };

function freshSequence(plan: Plan): Sequence {
  const s = newSequence(plan.name, { width: plan.width, height: plan.height, fps: plan.fps });
  const v = tracksOf(s, "video"), a = tracksOf(s, "audio");
  const bed = plan.beds[0]?.role;
  return { ...s, tracks: s.tracks.map((t) => {
    const i = (t.kind === "video" ? v : a).findIndex((x) => x.id === t.id);
    const name = (t.kind === "video" ? TRACK_NAMES.v : TRACK_NAMES.a)[i] ?? t.name;
    const role: Track["role"] = t.kind === "audio" ? (i < 2 ? "dialogue" : bed === "ambience" ? "ambience" : "music") : undefined;
    return { ...t, name: i === 2 && t.kind === "audio" && bed === "ambience" ? "Ambience" : name, ...(role ? { role } : {}) };
  }) };
}

const fxInstance = (id: string): EffectInstance => ({ id: uid("e"), type: audioFxType(id), enabled: true,
  params: Object.fromEntries(Object.entries(audioFxDefaults(id)).map(([k, v]) => [k, { value: v }])) });

/** The plan's picture and sound clips for one segment, placed. */
function placeSegment(seq: Sequence, ctx: Ctx, plan: Plan, s: PlanSegment, m: MediaItem, o: { offset: number; v: Track; a: Track }): { seq: Sequence; videoId?: string } {
  const F = (sec: number) => secondsToFrames(sec, seq.fps);
  const start = o.offset + F(s.at), end = o.offset + F(s.at + s.duration);
  const dur = Math.max(1, end - start);
  const range = m.kind === "image" ? undefined : { in: srcFrames(m, s.in), out: Math.max(srcFrames(m, s.in), srcFrames(m, s.out) - 1) };
  const clips = clipsFromMedia(seq, m, start, { videoTrackId: m.kind === "audio" ? undefined : o.v.id, audioTrackId: o.a.id, video: m.kind !== "audio",
    audio: s.sound && m.hasAudio, range, duration: dur, name: m.name });
  const fill = s.cover || !!s.kenBurns ? coverScale({ width: m.width, height: m.height }, seq) : 100;
  const out: TimelineClip[] = clips.map((c) => {
    let x: TimelineClip = { ...c, speed: s.speed > 0 ? s.speed : 1 };
    if (x.trackId === o.v.id) {
      const base = fill * ((s.scale ?? 100) / 100);
      x = { ...x, motion: { ...x.motion, scale: { value: Math.round(base * 10) / 10 } } };
      if (s.kenBurns) {
        const k = s.kenBurns, W = seq.width, H = seq.height, last = Math.max(1, dur - 1);
        x = { ...x, motion: { ...x.motion,
          scale: { value: fill * (k.from.scale / 100), keyframes: [{ frame: 0, value: fill * (k.from.scale / 100), ease: "linear" }, { frame: last, value: fill * (k.to.scale / 100), ease: "linear" }] },
          position: { value: [W / 2 + k.from.x * W, H / 2 + k.from.y * H], keyframes: [{ frame: 0, value: [W / 2 + k.from.x * W, H / 2 + k.from.y * H], ease: "linear" },
            { frame: last, value: [W / 2 + k.to.x * W, H / 2 + k.to.y * H], ease: "linear" }] } } };
      }
    } else {
      // the clip's own sound: dialogue, cleaned up, with J / L cuts (the sound leads in, or runs on, by up to the media's handles)
      if (x.source.type === "media") {
        const ratio = ((m.fps > 0 ? m.fps : seq.fps) / seq.fps) * x.speed; // source frames per timeline frame
        const lead = s.soundLead ? Math.min(F(s.soundLead), Math.floor(x.source.in / ratio), x.start) : 0;
        if (lead > 0) x = { ...x, start: x.start - lead, duration: x.duration + lead, source: { ...x.source, in: Math.max(0, x.source.in - Math.round(lead * ratio)) } };
        const room = m.duration > 0 && x.source.type === "media" ? Math.floor((m.duration - x.source.in) / ratio) - x.duration : 0;
        const tail = s.soundTail ? Math.max(0, Math.min(F(s.soundTail), room)) : 0;
        if (tail > 0) x = { ...x, duration: x.duration + tail };
      }
      if (plan.dialogue) x.role = "dialogue";
      if (plan.voiceFx.length) x = { ...x, effects: [...x.effects, ...plan.voiceFx.map(fxInstance)] };
    }
    return x;
  });
  let next = placeClips(seq, ctx, out, "overwrite");
  const v = out.find((c) => c.trackId === o.v.id);
  if (v && s.ramp) next = applyRampPreset(next, ctx, [v.id], s.ramp, v.start + Math.floor(v.duration / 2), { fit: "length" });
  return { seq: next, videoId: v?.id };
}

/** Builds (or extends, or rebuilds) the auto edit sequence from a plan. */
export function buildAutoEdit(project: EditProject, plan: Plan, o: BuildOptions = {}): BuildResult {
  const warnings: string[] = [];
  const target = o.appendTo ? project.sequences.find((s) => s.id === o.appendTo) : o.rebuild ? project.sequences.find((s) => s.name === plan.name) : undefined;
  let seq: Sequence;
  let offset = 0;
  if (target && o.appendTo) { seq = target; offset = seqEnd(target); }
  else { seq = freshSequence(plan); if (target && o.rebuild) seq = { ...seq, id: target.id }; }
  const ctx = ctxOf({ media: project.media, sequences: [...project.sequences.filter((s) => s.id !== seq.id), seq] });
  const vt = tracksOf(seq, "video"), at = tracksOf(seq, "audio");
  const [V1, V2, V3] = [vt[0], vt[1] ?? vt[0], vt[2] ?? vt[vt.length - 1]];
  const [A1, A2, A3] = [at[0], at[1] ?? at[0], at[2] ?? at[at.length - 1]];
  let placed = 0;
  let dialogueTrack = A1;
  let prevMedia = "";
  for (const s of plan.segments) {
    const m = project.media.find((x) => x.id === s.mediaId);
    if (!m) { warnings.push(`Media ${s.mediaId} isn't in the edit`); continue; }
    // J / L cuts overlap the neighbour's sound: each new clip's sound goes on the other dialogue track
    if (plan.style === "documentary" && s.mediaId !== prevMedia && prevMedia) dialogueTrack = dialogueTrack.id === A1.id ? A2 : A1;
    prevMedia = s.mediaId;
    const r = placeSegment(seq, ctx, plan, s, m, { offset, v: V1, a: dialogueTrack });
    seq = r.seq;
    placed++;
  }
  const F = (sec: number) => secondsToFrames(sec, seq.fps);
  for (const t of plan.transitions) {
    const r = addTransition(seq, ctx, t.track === "audio" ? A1.id : V1.id, offset + F(t.at), t.type, Math.max(1, F(t.duration)));
    if (r.id) seq = r.seq; else warnings.push(`No room for a transition at ${t.at} s`);
  }
  for (const t of plan.titles) {
    const spec = titleSpec(t.text, seq, t.position, t.kind === "hook" ? Math.round(seq.height * (seq.height > seq.width ? 0.05 : 0.075)) : 0);
    seq = addGenerated(seq, ctx, V2.id, offset + F(t.at), Math.max(1, F(t.duration)), { type: "title", text: { ...spec, animIn: "fade", animOut: "fade" } },
      t.kind === "hook" ? `Hook: ${t.text.slice(0, 30)}` : t.text.slice(0, 40)).seq;
  }
  if (plan.captions.length) {
    const style = captionStyle(seq);
    for (const c of plan.captions) {
      const a = offset + F(c.start), b = Math.max(a + 1, offset + F(c.end));
      seq = addGenerated(seq, ctx, V3.id, a, b - a, { type: "title", text: { ...defaultTitle(c.text), ...style, text: c.text } }, c.text.slice(0, 40) || "Caption").seq;
    }
    seq = { ...seq, tracks: seq.tracks.map((t) => (t.id === V3.id ? { ...t, name: "Captions" } : t)) };
  }
  for (const b of plan.beds) {
    const m = project.media.find((x) => x.id === b.mediaId);
    if (!m) { warnings.push(`The ${b.role} isn't in the edit`); continue; }
    const start = offset + F(b.at), dur = Math.max(1, F(b.duration));
    const clips = clipsFromMedia(seq, m, start, { audioTrackId: A3.id, video: false, audio: true, range: { in: srcFrames(m, b.in) }, duration: dur, name: m.name })
      .map((c) => ({ ...c, role: b.role, audio: { ...(c.audio ?? { gain: { value: 0 }, pan: { value: 0 }, fadeIn: 0, fadeOut: 0 }), gain: { value: b.gainDb }, fadeIn: F(b.fadeIn), fadeOut: F(b.fadeOut) } }));
    seq = placeClips(seq, ctx, clips, "overwrite");
  }
  const mood = plan.mood ? moodById(plan.mood) : undefined;
  if (plan.mood && !mood) warnings.push(`Unknown mood ${plan.mood}`);
  if (mood) {
    const ids = seq.clips.filter((c) => c.trackId === V1.id && c.start >= offset).map((c) => c.id);
    seq = applyMood(seq, ctx, mood, { kind: "clips", ids }, { intensity: 1, transitions: false, titles: false }).seq;
  }
  seq = normalize({ ...seq, markers: [...seq.markers, ...plan.markers.map((mk) => ({ id: uid("mk"), frame: offset + F(mk.at), duration: 0, name: mk.name, color: "#22d3ee" }))] }, ctx);
  const has = project.sequences.some((s) => s.id === seq.id);
  const next: EditProject = { ...project, sequences: has ? project.sequences.map((s) => (s.id === seq.id ? seq : s)) : [...project.sequences, seq], activeSequenceId: seq.id };
  return { project: next, sequenceId: seq.id, clips: placed, warnings };
}
