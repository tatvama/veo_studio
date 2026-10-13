/** The AI tools' document work (editor/ai/commands.ts, analysis.ts): digest, assistant commands, captions, ranges. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readBeats, readCuts, readLoudness, readSilences } from "../ai/analysis.ts";
import {
  addGain, addSequenceMarkers, applyCommand, applyCommands, brollSlot, captionCues, cutRanges, muteSound, normaliseGain, partFrames,
  phrases, sequenceDigest, silenceCuts, soundParts, splitClipAt, videoParts,
} from "../ai/commands.ts";
import type { AiCommandRow } from "../ai/types.ts";
import { seqEnd, tracksOf } from "../model/ops.ts";
import type { EditProject, Sequence } from "../model/types.ts";
import { A, media, on, project, put, seqOf, spans, V } from "./fixtures.ts";

/** m1 (10 s) at 0 and m2 (10 s) at 250 on V1/A1, 25 fps: a 20 s sequence. */
function two(): { p: EditProject; s: Sequence } {
  const p = project();
  let s = put(p, seqOf(p), "m1", 0);
  s = put(p, s, "m2", 250);
  p.sequences = [s];
  return { p, s };
}
const sid = (p: EditProject) => p.sequences[0].id;
const S = (p: EditProject) => p.sequences[0];
const row = (c: object, i = 1): AiCommandRow => ({ id: `cmd_${i}`, summary: "", paid: false, ...c }) as AiCommandRow;

test("digest: seconds, tracks, clips with sound, selection", () => {
  const { p, s } = two();
  const v1 = on(s, V(s, 0).id)[0];
  const d = sequenceDigest(p, s, [v1.id], { transitions: ["fade"] });
  assert.equal(d.duration, 20);
  assert.equal(d.fps, 25);
  assert.equal(d.tracks.length, 6);
  assert.equal(d.clips.length, 4);
  const c = d.clips.find((x) => x.id === v1.id)!;
  assert.deepEqual([c.start, c.end, c.kind, c.media_kind, c.has_audio], [0, 10, "media", "video", true]);
  assert.deepEqual(d.selection, [v1.id]);
  assert.deepEqual(d.transitions, ["fade"]);
  assert.equal(d.in_point, null);
});

test("assistant: trim, markers, ripple remove, split", () => {
  const { p } = two();
  let r = applyCommand(p, sid(p), { op: "trim_to_duration", seconds: 12 });
  assert.equal(r.error, undefined);
  assert.equal(seqEnd(S(r.project)), 300);
  assert.equal(applyCommand(p, sid(p), { op: "trim_to_duration", seconds: 30 }).error, "the sequence is already that short");
  r = applyCommand(p, sid(p), { op: "add_markers", markers: [{ at: 2, name: "Hook", color: "#22d3ee", comment: "" }, { at: 4, name: "", color: "", comment: "x" }] });
  assert.deepEqual(S(r.project).markers.map((m) => [m.frame, m.name, m.color]), [[50, "Hook", "#22d3ee"], [100, "Marker", "#fbbf24"]]);
  r = applyCommand(p, sid(p), { op: "remove_range", start: 2, end: 4, ripple: true, track_ids: [] });
  const s2 = S(r.project);
  assert.equal(seqEnd(s2), 450);
  assert.deepEqual(spans(s2, V(s2, 0).id), [[0, 50], [50, 200], [200, 450]]);
  assert.deepEqual(spans(s2, A(s2, 0).id), [[0, 50], [50, 200], [200, 450]]);  // the sound stays in sync
  r = applyCommand(p, sid(p), { op: "remove_range", start: 2, end: 4, ripple: false, track_ids: [V(S(p), 0).id] });
  assert.deepEqual(spans(S(r.project), V(S(p), 0).id), [[0, 50], [100, 250], [250, 500]]);
  assert.deepEqual(spans(S(r.project), A(S(p), 0).id), [[0, 250], [250, 500]]);
  r = applyCommand(p, sid(p), { op: "split_at", at: 5, track_ids: [] });
  assert.deepEqual(spans(S(r.project), V(S(p), 0).id), [[0, 125], [125, 250], [250, 500]]);
});

test("assistant: move, delete, speed, volume, title, transition, effect", () => {
  const { p, s } = two();
  const [v1, v2] = on(s, V(s, 0).id), [a1] = on(s, A(s, 0).id);
  let r = applyCommand(p, sid(p), { op: "move_clip", clip_id: v2.id, to: 12, track_id: V(s, 1).id });
  let x = S(r.project);
  assert.deepEqual(spans(x, V(x, 1).id), [[300, 550]]);  // the picture to V2 at 12 s …
  assert.deepEqual(spans(x, A(x, 0).id), [[0, 250], [300, 550]]);  // … its sound moves in time with it on A1
  assert.ok(applyCommand(p, sid(p), { op: "move_clip", clip_id: v1.id, to: 0, track_id: A(s, 1).id }).error);
  r = applyCommand(p, sid(p), { op: "delete_clip", clip_id: v1.id, ripple: true });
  x = S(r.project);
  assert.deepEqual(spans(x, V(x, 0).id), [[0, 250]]);
  assert.deepEqual(spans(x, A(x, 0).id), [[0, 250]]);
  r = applyCommand(p, sid(p), { op: "set_speed", clip_id: v2.id, speed: 2 });
  x = S(r.project);
  assert.deepEqual(on(x, V(x, 0).id).map((c) => [c.duration, c.speed]), [[250, 1], [125, 2]]);
  r = applyCommand(p, sid(p), { op: "set_volume", clip_id: v1.id, gain_db: -6 });
  assert.equal(on(S(r.project), A(s, 0).id)[0].audio!.gain.value, -6);  // the sound half of the picture clip
  r = applyCommand(p, sid(p), { op: "add_title", text: "Chapter one", at: 2, duration: 3, position: "top", size: 0 });
  x = S(r.project);
  const title = x.clips.find((c) => c.source.type === "title")!;
  assert.deepEqual([title.start, title.duration, title.trackId], [50, 75, V(x, 2).id]);  // the top free video track
  assert.equal(title.source.type === "title" && title.source.text.text, "Chapter one");
  r = applyCommand(p, sid(p), { op: "add_transition", clip_id: v2.id, edge: "in", type: "dissolve", duration: 1 });
  x = S(r.project);
  assert.equal(x.transitions.length, 1);
  assert.deepEqual([x.transitions[0].at, x.transitions[0].type, x.transitions[0].fromClipId, x.transitions[0].toClipId], [250, "dissolve", v1.id, v2.id]);
  r = applyCommand(p, sid(p), { op: "add_transition", clip_id: a1.id, edge: "out", type: "fade", duration: 0.5 });
  assert.equal(S(r.project).transitions[0].type, "audio:constant_power");
  r = applyCommand(p, sid(p), { op: "set_effect", clip_id: v1.id, effect: "vignette", params: { amount: 0.4 } });
  const fx = on(S(r.project), V(s, 0).id)[0].effects;
  assert.deepEqual([fx.length, fx[0].type, fx[0].params.amount.value], [1, "vignette", 0.4]);
  r = applyCommand(r.project, sid(p), { op: "set_effect", clip_id: v1.id, effect: "vignette", params: { amount: 0.8 } });
  assert.equal(on(S(r.project), V(s, 0).id)[0].effects[0].params.amount.value, 0.8);  // updated, not added twice
});

test("assistant: applyCommands runs in order, skips paid and broken ones", () => {
  const { p, s } = two();
  const v1 = on(s, V(s, 0).id)[0];
  const out = applyCommands(p, sid(p), [
    row({ op: "add_markers", markers: [{ at: 1, name: "A", color: "#22d3ee", comment: "" }] }, 1),
    row({ op: "delete_clip", clip_id: v1.id, ripple: false }, 2),
    row({ op: "set_speed", clip_id: v1.id, speed: 2 }, 3),  // gone after the delete
    { ...row({ op: "add_music", prompt: "x", start: 0, end: 5, volume_db: -18 }, 4), paid: true },
  ]);
  assert.deepEqual(out.applied, ["cmd_1", "cmd_2"]);
  assert.deepEqual(out.skipped, [{ id: "cmd_3", reason: "that clip is gone" }]);
  assert.equal(S(out.project).markers.length, 1);
  assert.equal(S(p).markers.length, 0);  // the input is untouched (one undo step is the caller's)
});

test("sound parts: one per A/V pair, trims and speed in media seconds; audio counts in samples", () => {
  const p = project();
  let s = put(p, seqOf(p), "m1", 100, { in: 50, out: 149 });  // source 2 s .. 6 s at timeline 4 s
  p.media.push(media("vo", { kind: "audio", fps: 48000, duration: 48000 * 60, width: 0, height: 0 }));
  s = put(p, s, "vo", 300, undefined, 0, 1, true);
  p.sequences = [s];
  const parts = soundParts(p, s, { range: [0, seqEnd(s)] });
  assert.equal(parts.length, 2);
  assert.deepEqual([parts[0].trackId, parts[0].srcStart, parts[0].srcEnd, parts[0].tlStart, parts[0].tlEnd], [A(s, 0).id, 2, 6, 100, 200]);
  const vo = parts[1];
  assert.equal(vo.srcStart, 0);
  assert.equal(vo.srcEnd, 60);  // 60 s of samples
  assert.deepEqual(soundParts(p, s, { clipIds: [on(s, V(s, 0).id)[0].id] }).map((x) => x.trackId), [A(s, 0).id]);
  assert.equal(soundParts(p, s, { range: [0, 50] }).length, 0);
  assert.equal(videoParts(p, s, s.clips.map((c) => c.id)).length, 1);
});

test("captions: cues on the timeline, speed, no overlap; phrases from word timings", () => {
  const part = { clipId: "c", mediaId: "m", trackId: "t", name: "x", tlStart: 100, tlEnd: 200, srcStart: 2, srcEnd: 6, speed: 2 };
  const cues = captionCues([{ start: 0, end: 1, text: "Hello there" }, { start: 0.8, end: 2, text: "General Kenobi" }, { start: 3.9, end: 9, text: "end" }], part, 25);
  assert.deepEqual(cues, [{ start: 100, end: 110, text: "Hello there" }, { start: 110, end: 125, text: "General Kenobi" }, { start: 149, end: 200, text: "end" }]);
  const ph = phrases([{ start: 0, end: 2, text: "one two three four", words: [
    { start: 0, end: 0.4, text: "one" }, { start: 0.5, end: 0.9, text: "two" }, { start: 1, end: 1.4, text: "three" }, { start: 1.5, end: 2, text: "four" }] }]);
  assert.deepEqual(ph, [{ start: 0, end: 1.4, text: "one two three" }, { start: 1.5, end: 2, text: "four" }]);
});

test("silences: padded cuts inside the clip, then ripple out on every track", () => {
  const { p, s } = two();
  const part = soundParts(p, s, { clipIds: [on(s, V(s, 0).id)[0].id] })[0];
  const cuts = silenceCuts(part, readSilences({ kind: "silence", segments: [{ start: 3, end: 4 }, { start: 5, end: 5.2 }, { start: 9.5, end: 12 }], duration: 10 }), 25, 120, 300);
  assert.deepEqual(cuts, [[78, 97], [240, 250]]);  // 3.12–3.88 s; the short one stays; the tail runs to the clip's end
  const out = cutRanges(p, sid(p), cuts);
  const x = S(out);
  assert.equal(seqEnd(x), 500 - 19 - 10);
  assert.deepEqual(spans(x, V(x, 0).id), spans(x, A(x, 0).id));
});

test("scenes, beats and markers: frames strictly inside the part", () => {
  const { p, s } = two();
  const v2 = on(s, V(s, 0).id)[1];
  const part = videoParts(p, s, [v2.id])[0];
  const frames = partFrames(part, readCuts({ kind: "scenes", cuts: [0, 2, 4.5, 10], duration: 10 }), 25);
  assert.deepEqual(frames, [300, 363]);  // 4.5 s = 112.5 frames, rounded
  const split = S(splitClipAt(p, sid(p), v2.id, frames));
  assert.deepEqual(spans(split, V(split, 0).id), [[0, 250], [250, 300], [300, 363], [363, 500]]);
  assert.deepEqual(spans(split, A(split, 0).id), [[0, 250], [250, 300], [300, 363], [363, 500]]);  // the linked sound too
  const marked = S(addSequenceMarkers(p, sid(p), partFrames(part, readBeats([0.5, 1, 1.5]), 25), "Beat {n}", "#fbbf24"));
  assert.deepEqual(marked.markers.map((m) => [m.frame, m.name]), [[263, "Beat 1"], [275, "Beat 2"], [288, "Beat 3"]]);
});

test("loudness and gain", () => {
  assert.equal(normaliseGain(-20, -8), 6);
  assert.equal(normaliseGain(-20, -6), 5);  // +6 would put the peak at 0 dBTP
  assert.equal(normaliseGain(-10, -2), -4);
  assert.equal(normaliseGain(-30, -4), 3);  // the peak limits it to -1 dBTP
  assert.equal(normaliseGain(-20, Number.NaN), 6);
  assert.deepEqual(readLoudness({ kind: "loudness", lufs: -18.2, lra: 5, truePeak: -3.1 }), { lufs: -18.2, peak: -3.1, lra: 5 });
  assert.equal(readLoudness({ kind: "loudness", lufs: null, lra: null, truePeak: null }), null);
  const { p, s } = two();
  const v1 = on(s, V(s, 0).id)[0];
  const g = addGain(addGain(p, sid(p), [v1.id], 3), sid(p), [v1.id], 1.5);
  assert.equal(on(S(g), A(s, 0).id)[0].audio!.gain.value, 4.5);
  assert.equal(on(S(g), V(s, 0).id)[0].audio, undefined);  // only the sound half
  const m = muteSound(p, sid(p), [v1.id]);
  assert.equal(m.muted, 1);
  assert.deepEqual(on(S(m.project), A(s, 0).id).map((c) => c.enabled), [false, true]);
});

test("B-roll slot: the gap at the playhead, else after the last clip, else a new track", () => {
  const { p, s } = two();
  const gap = { ...s, clips: s.clips.filter((c) => !(c.start === 250)) };  // nothing after 10 s
  assert.deepEqual(brollSlot(gap, 300, 125), { trackId: V(s, 0).id, start: 300, end: 425 });
  const withGap = put(p, gap, "m2", 400);
  assert.deepEqual(brollSlot(withGap, 300, 125), { trackId: V(s, 0).id, start: 250, end: 400 });
  assert.equal(brollSlot(s, 100, 125).trackId, V(s, 1).id);  // V1 busy at 4 s: the empty V2
  const full = { ...s, tracks: s.tracks.map((t) => (tracksOf(s, "video").slice(1).some((v) => v.id === t.id) ? { ...t, locked: true } : t)) };
  assert.deepEqual(brollSlot(full, 100, 125), { trackId: null, start: 100, end: 225 });
});

test("analysis readers take the bridge's shapes and a few others", () => {
  assert.deepEqual(readSilences([[1, 2], { start: 3, end: 2 }, { from: 4, to: 5 }]), [{ start: 1, end: 2 }, { start: 4, end: 5 }]);
  assert.deepEqual(readCuts({ scenes: [{ time: 2 }, 1, "3"] }), [1, 2, 3]);
  assert.deepEqual(readBeats({ kind: "beats", beats: [0.5, 0.5, 1], bpm: 120, duration: 2 }), [0.5, 1]);
  assert.deepEqual(readSilences(null), []);
});
