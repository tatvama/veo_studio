/**
 * A podcast audiogram brings its sound into the new sequence (templates/audiogram.ts): the selected audio clip, else
 * the sequence's dialogue mix as a nested clip, else a media item the user picks — on the new sequence's A1, with the
 * visualiser pointed at it (and drawing that sound: audiotools/source.ts visualizerGenerated), in the same command.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeVisualizerSource, VISUALIZER_STYLES } from "../audiotools/index.ts";
import { visualizerGenerated } from "../audiotools/source.ts";
import { clipEnd, seqEnd, tracksOf } from "../model/ops.ts";
import { framesToSeconds } from "../model/time.ts";
import { toAudioMix } from "../model/toComposition.ts";
import type { EditProject, Sequence, TimelineClip } from "../model/types.ts";
import { audiogramChoices, audiogramMedia, dialogueTracks, withAudiogramAudio, type AudiogramSource } from "../templates/audiogram.ts";
import { setVisualiserProvider, STATIC_WAVEFORM, visualiserProviderFrom } from "../templates/packs/social.ts";
import { seqTemplate, socialSequence } from "../templates/sequences.ts";
import { A, project, put, seqOf } from "./fixtures.ts";

const TPL = seqTemplate("audiogram.square")!;
const audioOf = (s: Sequence) => s.clips.filter((c) => tracksOf(s, "audio").some((t) => t.id === c.trackId));
const vizOf = (s: Sequence) => s.clips.filter((c) => c.source.type === "visualizer");

/** The Templates panel's insert: the template built with the chosen sound for its visualiser, then the sound on A1. */
function insert(p: EditProject, from: Sequence, src: AudiogramSource | null, provider = true) {
  const pick = src ? audiogramMedia(p, from.id, src) : null;
  setVisualiserProvider(provider ? visualiserProviderFrom(makeVisualizerSource as never, VISUALIZER_STYLES, () => pick) : null);
  try {
    const r = socialSequence(p, from.id, TPL, {});
    const a = src ? withAudiogramAudio(r.project, r.sequenceId, from.id, src, { makeVisualiser: makeVisualizerSource as never }) : { project: r.project, audioClipId: null };
    return { project: a.project, seq: a.project.sequences.find((x) => x.id === r.sequenceId)!, audioClipId: a.audioClipId };
  } finally { setVisualiserProvider(null); }
}

function edit(): { p: EditProject; s: Sequence; talk: TimelineClip } {
  const p = project();
  const s = put(p, seqOf(p), "m1", 50, { in: 25, out: 224 });
  p.sequences = [s];
  return { p, s, talk: audioOf(s)[0] };
}

test("the selected audio clip: a copy on the new sequence's A1 from 0, and the visualiser draws it", () => {
  const { p, s, talk } = edit();
  const ch = audiogramChoices(p, s, [talk.id], 0);
  assert.deepEqual(ch[0].source, { kind: "clip", clipId: talk.id });
  const r = insert(p, s, ch[0].source);
  const a1 = tracksOf(r.seq, "audio")[0];
  const sound = r.seq.clips.find((c) => c.id === r.audioClipId)!;
  assert.equal(sound.trackId, a1.id);
  assert.deepEqual([sound.start, sound.duration, sound.source], [0, Math.min(talk.duration, seqEnd(r.seq)), talk.source]);
  assert.equal(sound.linkId, undefined, "not linked to the old picture");
  const viz = vizOf(r.seq);
  assert.equal(viz.length, 1);
  assert.equal((viz[0].source as { audioClipId?: string }).audioClipId, r.audioClipId);
  assert.equal((viz[0].source as { mediaId?: string }).mediaId, undefined);
  const g = visualizerGenerated(r.project, r.seq, viz[0], r.seq.width, r.seq.height);
  assert.equal(g.mediaId, "m1");
  assert.ok(Math.abs(g.offset - framesToSeconds(25, 25)) < 1e-9, "from the clip's own in point");
  // and the new sequence plays it
  const mix = toAudioMix(r.project, r.seq.id);
  assert.equal(mix.clips.length, 1);
  assert.equal(mix.clips[0].start, 0);
});

test("no selection: the dialogue tracks as a nested Dialogue mix from the playhead; the visualiser follows the clip inside", () => {
  const { p, s, talk } = edit();
  // a music bed on A2 must stay out of the dialogue mix
  const withMusic = put(p, s, "music", 0, undefined, 0, 1);
  const music = withMusic.clips.find((c) => c.trackId === A(withMusic, 1).id)!;
  const seq: Sequence = { ...withMusic, clips: withMusic.clips.filter((c) => !(c.source.type === "media" && c.source.mediaId === "music" && c.trackId !== A(withMusic, 1).id)),
    tracks: withMusic.tracks.map((t) => (t.id === A(withMusic, 0).id ? { ...t, role: "dialogue" as const } : t.id === A(withMusic, 1).id ? { ...t, role: "music" as const } : t)) };
  p.sequences = [seq];
  assert.deepEqual(dialogueTracks(seq).map((t) => t.id), [A(seq, 0).id]);
  const ch = audiogramChoices(p, seq, [], 75);
  assert.deepEqual(ch[0].source, { kind: "dialogue", from: 75 });
  const r = insert(p, seq, ch[0].source);
  const mixSeq = r.project.sequences.find((x) => x.name === `${seq.name} · Dialogue mix`)!;
  assert.ok(mixSeq, "a Dialogue mix sequence");
  assert.equal(tracksOf(mixSeq, "audio").length, 1);
  assert.ok(mixSeq.clips.every((c) => c.source.type === "media" && c.source.mediaId === "m1"), "only the dialogue, no music");
  assert.ok(!mixSeq.clips.some((c) => c.id === music.id));
  const sound = r.seq.clips.find((c) => c.id === r.audioClipId)!;
  assert.deepEqual([sound.source.type, (sound.source as { sequenceId: string }).sequenceId, (sound.source as { in: number }).in, sound.start], ["nested", mixSeq.id, 75, 0]);
  const viz = vizOf(r.seq)[0];
  assert.equal((viz.source as { audioClipId?: string }).audioClipId, sound.id);
  const g = visualizerGenerated(r.project, r.seq, viz, r.seq.width, r.seq.height);
  // the inner clip starts at 50 (source in 25): at the nested frame 75 the media is at 25 + 25 frames = 2 s
  assert.equal(g.mediaId, "m1");
  assert.ok(Math.abs(g.offset - 2) < 1e-9, `offset ${g.offset}`);
  assert.ok(Math.abs(g.lo - 2) < 1e-9 && Math.abs(g.hi - framesToSeconds(25 + Math.min(clipEnd(talk), 75 + sound.duration) - 50, 25)) < 1e-9, `${g.lo}–${g.hi}`);
  const mix = toAudioMix(r.project, r.seq.id);
  assert.ok(mix.clips.length >= 1 && mix.clips.every((c) => /m1/.test(c.url)), "the new sequence plays the dialogue");
});

test("no audio in the sequence: the user's pick (media), and a static waveform becomes a visualiser", () => {
  const p = project();
  const s = seqOf(p);
  const ch = audiogramChoices(p, s, [], 0);
  assert.ok(ch.length >= 2 && ch.every((c) => c.source.kind === "media"), "only media to pick from");
  assert.ok(ch.some((c) => c.source.kind === "media" && c.source.mediaId === "music"));
  // the build without the visualiser had drawn the static waveform
  const r0 = insert(p, s, null, false);
  assert.ok(r0.seq.clips.some((c) => c.name === STATIC_WAVEFORM));
  assert.equal(audioOf(r0.seq).length, 0, "before the fix: no sound in the new sequence");
  const r = insert(p, s, { kind: "media", mediaId: "music" }, false);
  const sound = r.seq.clips.find((c) => c.id === r.audioClipId)!;
  assert.deepEqual([sound.source.type, (sound.source as { mediaId: string }).mediaId, sound.start], ["media", "music", 0]);
  assert.equal(sound.duration, Math.min(1500, seqEnd(r.seq)), "as long as the template (the music is longer)");
  assert.ok(!r.seq.clips.some((c) => c.name === STATIC_WAVEFORM));
  const viz = vizOf(r.seq);
  assert.equal(viz.length, 1);
  assert.equal((viz[0].source as { audioClipId?: string }).audioClipId, sound.id);
  assert.equal(visualizerGenerated(r.project, r.seq, viz[0], r.seq.width, r.seq.height).mediaId, "music");
});

test("a source that isn't there places nothing", () => {
  const { p, s } = edit();
  const r = socialSequence(p, s.id, TPL, {});
  const a = withAudiogramAudio(r.project, r.sequenceId, s.id, { kind: "clip", clipId: "c_missing" });
  assert.equal(a.audioClipId, null);
  assert.equal(a.project, r.project);
});
