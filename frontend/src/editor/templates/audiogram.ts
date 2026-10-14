/**
 * The podcast audiograms' sound (docs/EDITOR.md §15.3–15.4): a social audiogram template makes a new sequence
 * (sequences.ts socialSequence) whose visualiser draws an audio clip's spectrum, so the new sequence needs that sound
 * on its own A1. Where it comes from, best first:
 *   1. the audio clip selected in the sequence it's made from (a copy, from the clip's own in point);
 *   2. that sequence's dialogue mix, as a nested clip: its dialogue tracks (a role of "dialogue" on the track or its
 *      clips, or a track named like one; else A1, the dialogue track by convention) copied into a "Dialogue mix"
 *      sequence, from the in mark or the playhead;
 *   3. else the user picks a media item with sound (the Templates panel asks).
 * `withAudiogramAudio` puts it on A1 for the template's length and points every visualiser clip at it (a nested
 * clip: the visualiser follows the dialogue clip inside, audiotools/source.ts). One command's worth, pure.
 */
import { guessRole } from "../audiofx/essential.ts";
import { baseClip, mediaSpan, newSequence } from "../model/defaults.ts";
import { uid } from "../model/ids.ts";
import { clipEnd, ctxOf, normalize, seqEnd, tracksOf } from "../model/ops.ts";
import type { ClipSource, EditProject, Sequence, TimelineClip, Track } from "../model/types.ts";

export type AudiogramSource =
  | { kind: "clip"; clipId: string }
  | { kind: "dialogue"; from: number }
  | { kind: "media"; mediaId: string };
export interface AudiogramChoice { source: AudiogramSource; label: string }

const isAudioMedia = (s: Sequence, c: TimelineClip) => c.source.type === "media" && s.tracks.find((t) => t.id === c.trackId)?.kind === "audio";

/** The dialogue tracks of a sequence (see the module note); [] when it has no sound. */
export function dialogueTracks(s: Sequence): Track[] {
  const audio = tracksOf(s, "audio").filter((t) => s.clips.some((c) => c.trackId === t.id && c.source.type === "media" && c.enabled));
  const tagged = audio.filter((t) => t.role === "dialogue" || s.clips.some((c) => c.trackId === t.id && c.role === "dialogue") || (!t.role && guessRole(t.name) === "dialogue"));
  if (tagged.length) return tagged;
  const a1 = audio.find((t) => t.index === 0);
  return a1 && !a1.role ? [a1] : [];
}

/**
 * Where an audiogram made from sequence `s` can take its sound, best first (the selected audio clip, the dialogue
 * mix from `at`, then the project's media with sound). The first one is what an insert uses unless the user picks.
 */
export function audiogramChoices(p: EditProject, s: Sequence, selection: readonly string[], at: number): AudiogramChoice[] {
  const out: AudiogramChoice[] = [];
  const sel = s.clips.find((c) => selection.includes(c.id) && isAudioMedia(s, c));
  if (sel) out.push({ source: { kind: "clip", clipId: sel.id }, label: `The selected clip “${sel.name}”` });
  const dt = dialogueTracks(s);
  if (dt.length) out.push({ source: { kind: "dialogue", from: Math.max(0, Math.min(at, seqEnd(s) - 1)) }, label: `“${s.name}” dialogue (${dt.map((t) => `A${t.index + 1}`).join(", ")}), nested` });
  for (const m of p.media) if (!m.missing && (m.kind === "audio" || (m.kind === "video" && m.hasAudio))) out.push({ source: { kind: "media", mediaId: m.id }, label: m.name });
  return out;
}

/** The media a source plays first (the visualiser's frames are asked for it ahead of time), or null. */
export function audiogramMedia(p: EditProject, fromSeqId: string, src: AudiogramSource): { mediaId: string; offset: number; name: string } | null {
  const from = p.sequences.find((x) => x.id === fromSeqId);
  if (src.kind === "media") { const m = p.media.find((x) => x.id === src.mediaId); return m ? { mediaId: m.id, offset: 0, name: m.name } : null; }
  if (!from) return null;
  const c = src.kind === "clip" ? from.clips.find((x) => x.id === src.clipId)
    : from.clips.filter((x) => dialogueTracks(from).some((t) => t.id === x.trackId) && x.source.type === "media" && clipEnd(x) > src.from).sort((a, b) => a.start - b.start)[0];
  if (!c || c.source.type !== "media") return null;
  const mediaId = c.source.mediaId;
  const m = p.media.find((x) => x.id === mediaId);
  return m ? { mediaId: m.id, offset: 0, name: m.name } : null;
}

/** A copy of `from` with only its dialogue tracks' sound (no picture), for the audiogram's nested dialogue mix. */
function dialogueMix(from: Sequence): Sequence {
  const keep = dialogueTracks(from);
  const ids = new Set(keep.map((t) => t.id));
  const base = newSequence(`${from.name} · Dialogue mix`, from, { video: 1, audio: keep.length });
  const audio = tracksOf(base, "audio");
  const map = new Map(keep.map((t, i) => [t.id, audio[i].id]));
  const tracks = base.tracks.map((t) => {
    const src = keep.find((k) => map.get(k.id) === t.id);
    return src ? { ...t, name: src.name, volume: src.volume, pan: src.pan, role: "dialogue" as const, ...(src.effects ? { effects: structuredClone(src.effects) } : {}) } : t;
  });
  const clipIds = new Map<string, string>();
  const clips = from.clips.filter((c) => ids.has(c.trackId) && c.source.type === "media").map((c) => {
    const id = uid("c");
    clipIds.set(c.id, id);
    const { linkId: _l, ...rest } = structuredClone(c);
    void _l;
    return { ...rest, id, trackId: map.get(c.trackId)! };
  });
  const transitions = from.transitions.filter((x) => ids.has(x.trackId)).map((x) => ({ ...structuredClone(x), id: uid("t"), trackId: map.get(x.trackId)!,
    ...(x.fromClipId ? { fromClipId: clipIds.get(x.fromClipId) } : {}), ...(x.toClipId ? { toClipId: clipIds.get(x.toClipId) } : {}) }))
    .filter((x) => (!("fromClipId" in x) || x.fromClipId) && (!("toClipId" in x) || x.toClipId));
  return { ...base, tracks, clips, transitions };
}

/**
 * Puts the audiogram's sound on A1 of the new sequence `seqId` (from 0, as long as the template, never past the
 * sound's end) and points its visualiser clips at it. A static waveform (a build without the visualiser) stays as it
 * is unless `makeVisualiser` (audiotools makeVisualizerSource) is given, then it becomes a visualiser in its box.
 * Returns the project (with the dialogue mix sequence when it made one) and the A1 clip's id (null: nothing to place).
 */
export function withAudiogramAudio(p: EditProject, seqId: string, fromSeqId: string, src: AudiogramSource,
  opts: { makeVisualiser?: (o: Record<string, unknown>) => ClipSource } = {}): { project: EditProject; audioClipId: string | null } {
  const s0 = p.sequences.find((x) => x.id === seqId);
  const from = p.sequences.find((x) => x.id === fromSeqId);
  if (!s0) return { project: p, audioClipId: null };
  const len = Math.max(1, seqEnd(s0));
  let a1 = tracksOf(s0, "audio")[0];
  let s = s0;
  if (!a1) {
    const t: Track = { id: uid("a"), kind: "audio", name: "A1", index: 0, locked: false, hidden: false, muted: false, solo: false, targeted: true, syncLock: true, height: 56, volume: 0, pan: 0 };
    s = { ...s, tracks: [...s.tracks, t] };
    a1 = t;
  }
  let extra: Sequence | null = null;
  let clip: TimelineClip | null = null;
  if (src.kind === "clip" && from) {
    const c = from.clips.find((x) => x.id === src.clipId);
    if (c && isAudioMedia(from, c)) {
      const { linkId: _l, ...rest } = structuredClone(c);
      void _l;
      clip = { ...rest, id: uid("c"), trackId: a1.id, start: 0, duration: Math.min(c.duration, len) };
    }
  } else if (src.kind === "dialogue" && from && dialogueTracks(from).length) {
    extra = dialogueMix(from);
    const from0 = Math.max(0, Math.min(src.from, seqEnd(extra) - 1));
    const dur = Math.max(1, Math.min(len, seqEnd(extra) - from0));
    clip = baseClip(s, a1.id, 0, dur, { type: "nested", sequenceId: extra.id, in: from0 }, extra.name);
  } else if (src.kind === "media") {
    const m = p.media.find((x) => x.id === src.mediaId);
    if (m) {
      const sp = mediaSpan(m, s.fps);
      clip = baseClip(s, a1.id, 0, Math.min(sp.frames, len), { type: "media", mediaId: m.id, in: sp.in }, m.name);
    }
  }
  if (!clip) return { project: p, audioClipId: null };
  const id = clip.id;
  // the visualisers follow the new A1 clip (its in point, trims and speed: audiotools/source.ts)
  const clips = s.clips.filter((c) => c.trackId !== a1.id).map((c) => {
    if (c.source.type === "visualizer") {
      const { mediaId: _m, offset: _o, ...v } = c.source;
      void _m; void _o;
      return { ...c, source: { ...v, audioClipId: id } };
    }
    if (opts.makeVisualiser && c.source.type === "title" && c.name === "Waveform (static)") {
      const t = c.source.text;
      return { ...c, name: "Visualiser", effects: [], source: opts.makeVisualiser({ audioClipId: id, style: s.width >= s.height ? "mirror" : "line", colors: [t.color, t.color], gradient: true, glow: 0.4, box: t.box }) };
    }
    return c;
  });
  s = { ...s, clips: [...clips, clip] };
  const sequences = [...p.sequences.map((x) => (x.id === seqId ? s : x)), ...(extra ? [extra] : [])];
  const p2: EditProject = { ...p, sequences };
  const ctx = ctxOf(p2);
  return { project: { ...p2, sequences: p2.sequences.map((x) => (x.id === seqId || x.id === extra?.id ? normalize(x, ctx) : x)) }, audioClipId: id };
}
