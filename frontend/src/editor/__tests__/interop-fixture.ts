/**
 * The interchange tests' edit (docs/EDITOR.md §12): 25 fps 1080p, two video tracks and two audio tracks used, a cross
 * dissolve, a wipe (no FCP equivalent), an audio crossfade, a 2× clip, a still with opacity, a title, a nested
 * sequence, a music bed with level keyframes, pan, a fade-in, an effect and a role, sequence and media markers, a muted
 * track. Media: a 25 fps clip, a 50 fps clip, a 48 kHz WAV with a Devanagari name and a still.
 */
import { defaultTitle, newSequence } from "../model/defaults.ts";
import { seedIds } from "../model/ids.ts";
import { addGenerated, addMarker, addTransition, ctxOf, setSpeed, tracksOf, updateParam, updateTrack } from "../model/ops.ts";
import { addKeyframe } from "../model/params.ts";
import type { EditProject, Sequence, TimelineClip } from "../model/types.ts";
import { media, project, put } from "./fixtures.ts";

export const T = (s: Sequence, kind: "video" | "audio", i: number) => tracksOf(s, kind)[i];
export const clipsOn = (s: Sequence, kind: "video" | "audio", i: number): TimelineClip[] =>
  s.clips.filter((c) => c.trackId === T(s, kind, i).id).sort((a, b) => a.start - b.start);

export function richProject(): EditProject {
  const p = project();
  p.media = [
    media("m1", { name: "Shot one.mp4", path: "D:\\Footage\\Shot one.mp4", markers: [{ id: "mk1", frame: 30, duration: 0, name: "Good take", color: "#34d399" }] }),
    media("m2", { name: "Shot two.mov", path: "D:\\Footage\\Shot two.mov", fps: 50, duration: 500 }),
    media("music", { name: "Score मूल.wav", path: "D:\\Audio\\Score मूल.wav", kind: "audio", hasAudio: true, width: 0, height: 0, fps: 48000, duration: 60 * 48000, audioChannels: 2 }),
    media("still", { name: "Logo.png", path: "D:\\Art\\Logo.png", kind: "image", hasAudio: false, duration: 0, fps: 0, width: 1000, height: 1000 }),
  ];
  const ctx = () => ctxOf(p);
  let s = p.sequences[0];
  s = put(p, s, "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "m2", 100, { in: 100, out: 299 }); // 50 fps media: 200 source frames = 100 sequence frames
  s = put(p, s, "m1", 200, { in: 100, out: 199 });
  const third = s.clips.filter((c) => c.start === 200).map((c) => c.id);
  s = setSpeed(s, ctx(), third, 2);
  s = addTransition(s, ctx(), T(s, "video", 0).id, 100, "fade", 20).seq;
  s = addTransition(s, ctx(), T(s, "video", 0).id, 200, "wipeleft", 10).seq;
  s = addTransition(s, ctx(), T(s, "audio", 0).id, 100, "audio:constant_power", 10).seq;
  // V2: a still at half opacity, a title
  s = put(p, s, "still", 20, undefined, 1, 0, false);
  const still = clipsOn(s, "video", 1)[0];
  s = updateParam(s, ctx(), still.id, "motion.opacity", () => ({ value: 50 }));
  s = addGenerated(s, ctx(), T(s, "video", 1).id, 120, 50, { type: "title", text: { ...defaultTitle("Hello Tatvam") } }, "Hello Tatvam").seq;
  // A2: the music bed (1 s in), level keyframes, pan, a fade-in, an effect and a role
  s = put(p, s, "music", 0, { in: 48000, out: 48000 + 10 * 48000 - 1 }, 0, 1, true);
  const bed = clipsOn(s, "audio", 1)[0];
  s = updateParam(s, ctx(), bed.id, "audio.gain", (pp) => addKeyframe(addKeyframe(pp, 0, 0), 100, -6));
  s = updateParam(s, ctx(), bed.id, "audio.pan", () => ({ value: 0.3 }));
  s = {
    ...s, clips: s.clips.map((c) => (c.id === bed.id ? {
      ...c, duration: 250, audio: { ...c.audio!, fadeIn: 25 }, role: "music",
      effects: [{ id: "e_comp", type: "audio:compressor", enabled: true, params: { threshold: { value: -20 }, ratio: { value: 3 } } }],
    } as TimelineClip : c)),
  };
  // an effect and a colour label on the 50 fps clip
  s = { ...s, clips: s.clips.map((c) => (c.source.type === "media" && c.source.mediaId === "m2" && T(s, "video", 0).id === c.trackId
    ? { ...c, colorLabel: "mango", effects: [{ id: "e_adj", type: "adjust", enabled: true, params: { exposure: { value: 0.5 } } }] } : c)) };
  // markers
  s = { ...s, markers: addMarker(addMarker(s.markers, 10, { name: "Intro", color: "#fbbf24", comment: "Start here" }), 150, { name: "Chorus", duration: 25, kind: "chapter" }) };
  s = updateTrack(s, T(s, "audio", 2).id, { muted: true });
  // a nested sequence (m1 for 2 s) on V2
  const inner = newSequence("Inner", { width: 1920, height: 1080, fps: 25 }, { video: 1, audio: 1 });
  p.sequences = [s, inner];
  let ns = put(p, inner, "m1", 0, { in: 50, out: 99 }, 0, 0, false);
  p.sequences = [s, ns];
  s = addGenerated(s, ctxOf(p), T(s, "video", 1).id, 180, 50, { type: "nested", sequenceId: ns.id, in: 0 }, "Inner").seq;
  s = updateTrack(s, T(s, "video", 1).id, { locked: true });
  p.sequences = [s, ns];
  p.activeSequenceId = s.id;
  return p;
}

/** A clip as the tests compare it across formats. */
export function clipList(p: EditProject, seqId = p.activeSequenceId) {
  const s = p.sequences.find((x) => x.id === seqId)!;
  const name = (c: TimelineClip) => (c.source.type === "media" ? p.media.find((m) => m.id === (c.source as { mediaId: string }).mediaId)?.name : c.source.type);
  return s.clips.map((c) => {
    const t = s.tracks.find((x) => x.id === c.trackId)!;
    const m = c.source.type === "media" ? p.media.find((x) => x.id === (c.source as { mediaId: string }).mediaId) : undefined;
    const srcSec = c.source.type === "media" && m ? (m.kind === "image" ? 0 : c.source.in / (m.fps || 25)) : c.source.type === "nested" ? c.source.in / 25 : 0;
    return { track: `${t.kind === "video" ? "V" : "A"}${t.index + 1}`, start: c.start, duration: c.duration, what: name(c), in: Math.round(srcSec * 1000) / 1000,
      speed: Math.round(c.speed * 1000) / 1000, reverse: c.reverse, enabled: c.enabled };
  }).sort((a, b) => a.track.localeCompare(b.track) || a.start - b.start);
}

export function reset() { seedIds(7); }
