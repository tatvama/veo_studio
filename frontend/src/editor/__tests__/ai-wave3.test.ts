/** The wave 3 AI tools' document work (editor/ai/wave3.ts): transcript, highlights as 9:16 sequences, bin search,
 *  scenes for moods, mood markers, backups. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backupDoc, captionTrackId, coverScale, cuesToSegments, findInBin, highlightRange, highlightSequence, moodMarkers, restoredProject,
  scenesFromEpisode, scenesFromTimeline, shortsFrom, textBetween, transcriptOf,
} from "../ai/wave3.ts";
import { addSequenceMarkers, titleSpec } from "../ai/commands.ts";
import { addGenerated, addMarker, addTrack, ctxOf, seqEnd, tracksOf } from "../model/ops.ts";
import type { EditProject, Sequence } from "../model/types.ts";
import { A, project, put, seqOf, spans, V } from "./fixtures.ts";

/** m1 (10 s) at 0 and m2 (10 s) at 250 on V1/A1, 25 fps: a 20 s 1920×1080 sequence. */
function two(): { p: EditProject; s: Sequence } {
  const p = project();
  let s = put(p, seqOf(p), "m1", 0);
  s = put(p, s, "m2", 250);
  p.sequences = [s];
  return { p, s };
}

/** A caption track with three lines (frames), like the Captions tool makes. */
function withCaptions(p: EditProject, s: Sequence, name = "Captions (en)"): Sequence {
  const r = addTrack(s, "video");
  let sq = { ...r.seq, tracks: r.seq.tracks.map((t) => (t.id === r.trackId ? { ...t, name } : t)) };
  for (const [a, b, text] of [[25, 75, "We drove to the temple"], [100, 150, "The market was loud"], [300, 350, "Everything changed"]] as const) {
    sq = addGenerated(sq, ctxOf(p), r.trackId, a, b - a, { type: "title", text: titleSpec(text, sq) }, text).seq;
  }
  return sq;
}

test("transcript: the caption track's lines in seconds, else the last captions", () => {
  const { p, s } = two();
  assert.equal(captionTrackId(s), null);
  assert.deepEqual(transcriptOf(s), []);
  assert.deepEqual(transcriptOf(s, [{ start: 50, end: 100, text: " hello " }, { start: 0, end: 25, text: "first" }, { start: 5, end: 5, text: "empty" }]),
    [{ start: 0, end: 1, text: "first" }, { start: 2, end: 4, text: "hello" }]);
  const c = withCaptions(p, s);
  const second = withCaptions(p, c, "Captions (hi)");  // a translation on a later track: the first one is read
  assert.equal(captionTrackId(second), captionTrackId(c));
  const t = transcriptOf(second);
  assert.deepEqual(t.map((x) => [x.start, x.end, x.text]), [[1, 3, "We drove to the temple"], [4, 6, "The market was loud"], [12, 14, "Everything changed"]]);
  assert.equal(textBetween(t, 90, 200, 25), "The market was loud");
  assert.deepEqual(cuesToSegments([{ start: 0, end: 10, text: "" }], 25), []);
});

test("highlights: a 9:16 sequence of the range, pictures filling the frame, fresh ids, the hook on top", () => {
  const { p, s } = two();
  const before = JSON.stringify(s);
  const h = highlightSequence(p, s, [200, 300], { name: "Short 1", hook: "Watch this" });
  assert.equal(JSON.stringify(s), before);  // the source is untouched
  assert.deepEqual([h.width, h.height, h.fps, seqEnd(h)], [1080, 1920, 25, 100]);
  assert.notEqual(h.id, s.id);
  const v1 = V(h, 0), a1 = A(h, 0);
  assert.deepEqual(spans(h, v1.id), [[0, 50], [50, 100]]);
  assert.deepEqual(spans(h, a1.id), [[0, 50], [50, 100]]);
  const vids = h.clips.filter((c) => c.trackId === v1.id);
  assert.ok(vids.every((c) => c.motion.scale.value === 316 && c.motion.position.value[0] === 540 && c.motion.position.value[1] === 960));
  const ids = new Set([...s.clips.map((c) => c.id), ...s.tracks.map((t) => t.id)]);
  assert.ok(h.clips.every((c) => !ids.has(c.id) && !ids.has(c.trackId)));
  const links = h.clips.filter((c) => c.linkId).map((c) => c.linkId);
  assert.equal(new Set(links).size * 2, links.length);  // each A/V pair still shares one link
  assert.ok(!s.clips.some((c) => links.includes(c.linkId)));
  const hook = tracksOf(h, "video").find((t) => t.name === "Hook")!;
  const title = h.clips.find((c) => c.trackId === hook.id)!;
  assert.equal(title.source.type, "title");
  assert.equal(title.duration, 75);  // 3 s
  assert.ok(title.source.type === "title" && title.source.text.text === "Watch this" && title.source.text.box[1] >= 0.1);
  assert.equal(h.inPoint, undefined);
  // markers inside the range come along, shifted
  const m = { ...s, markers: addMarker(addMarker(s.markers, 220, { name: "in" }), 400, { name: "out" }) };
  assert.deepEqual(highlightSequence(p, m, [200, 300], { name: "x" }).markers.map((x) => [x.frame, x.name]), [[20, "in"]]);
});

test("highlights: picture-in-picture keeps its size; ranges outside the sequence are skipped", () => {
  const { p, s } = two();
  const pip = { ...s, clips: s.clips.map((c) => (c.trackId === V(s, 0).id && c.start === 0 ? { ...c, motion: { ...c.motion, scale: { value: 40 } } } : c)) };
  const h = highlightSequence(p, pip, [0, 100], { name: "x" });
  assert.equal(h.clips.find((c) => c.trackId === V(h, 0).id)!.motion.scale.value, 40);
  assert.equal(coverScale({ width: 1920, height: 1080 }, { width: 1080, height: 1920 }), 316);
  assert.equal(coverScale({ width: 1080, height: 1920 }, { width: 1080, height: 1920 }), 100);
  assert.equal(coverScale({ width: 0, height: 0 }, { width: 1080, height: 1920 }), 100);
  const picks = [{ start: 2, end: 8, title: "One", hook: "", why: "" }, { start: 30, end: 40, title: "Past the end", hook: "", why: "" }];
  assert.deepEqual(highlightRange(picks[0], s), [50, 200]);
  assert.equal(highlightRange(picks[1], s), null);
  const made = shortsFrom(p, s, picks);
  assert.equal(made.length, 1);
  assert.equal(made[0].name, `${s.name} · Short 1: One`);
  assert.ok(tracksOf(made[0], "video").some((t) => t.name === "Hook"));  // the title stands in for a missing hook
});

test("B-roll: media in the bin that shares the idea's words", () => {
  const p = project();
  p.media[0].name = "Temple at dawn.mp4";
  p.media[1].name = "Market crowd.mov";
  p.media[1].comment = "busy vegetable market";
  const hits = findInBin(p, "Cinematic cutaway of a busy market, slow push in");
  assert.deepEqual(hits.map((h) => h.item.id), ["m2"]);
  assert.deepEqual(findInBin(p, "temples at dawn").map((h) => h.item.id), ["m1"]);
  assert.deepEqual(findInBin(p, "the of a"), []);
  assert.ok(!findInBin(p, "music").some((h) => h.item.kind === "audio"));
});

test("moods: scenes from markers, V1 clips or a studio episode, and mood markers", () => {
  const { p, s } = two();
  const byClips = scenesFromTimeline(s);
  assert.deepEqual(byClips.map((x) => [x.start, x.end]), [[0, 250], [250, 500]]);
  const marked = { ...s, markers: addMarker(addMarker(s.markers, 100, { name: "Arrival", comment: "slow" }), 300, { name: "Market" }) };
  const sc = scenesFromTimeline(withCaptions(p, marked), transcriptOf(withCaptions(p, marked)));
  assert.deepEqual(sc.map((x) => [x.title, x.start, x.end]), [["Opening", 0, 100], ["Arrival", 100, 300], ["Market", 300, 500]]);
  assert.equal(sc[1].summary, "slow · The market was loud");
  const named = { ...s, clips: s.clips.map((c) => ({ ...c, name: c.start === 0 ? "E01S01" : "E01S02" })) };
  const ep = scenesFromEpisode(named, [{ id: 7, title: "Two", emotion: "tense", summary: "", shot_codes: ["E01S02"] },
    { id: 3, title: "One", emotion: "joyful", summary: "", shot_codes: ["E01S01"] }, { id: 9, title: "Cut", emotion: "", summary: "", shot_codes: ["ZZ"] }]);
  assert.deepEqual(ep.map((x) => [x.id, x.start, x.end, x.emotion]), [["3", 0, 250, "joyful"], ["7", 250, 500, "tense"]]);
  p.sequences = [marked];
  const once = moodMarkers(p, marked.id, sc, [{ scene_id: sc[1].id, mood: "Tense", why: "conflict" }]);
  const twice = moodMarkers(once, marked.id, sc, [{ scene_id: sc[1].id, mood: "Calm", why: "" }, { scene_id: "nope", mood: "x", why: "" }]);
  const at100 = twice.sequences[0].markers.filter((m) => m.frame === 100);
  assert.deepEqual(at100.map((m) => m.name).sort(), ["Arrival", "Mood: Calm"]);  // the earlier mood marker is replaced
  assert.equal(once.sequences[0].markers.find((m) => m.name === "Mood: Tense")!.comment, "conflict");
  assert.equal(once.sequences[0].markers.find((m) => m.name === "Mood: Tense")!.kind, "scene");  // snapping knows what it is
  const beats = addSequenceMarkers(p, marked.id, [10, 20], "Beat", "#fbbf24", "beat").sequences[0].markers.filter((m) => m.name === "Beat");
  assert.deepEqual(beats.map((m) => [m.frame, m.kind]), [[10, "beat"], [20, "beat"]]);
  assert.equal(addSequenceMarkers(p, marked.id, [30], "Plain", "#fff").sequences[0].markers.find((m) => m.name === "Plain")!.kind, undefined);
});

test("backups: runtime links stay out; a restore keeps the open edit's id, studio project and links", () => {
  const p = project();
  p.studioProjectId = 42;
  p.media[0].proxyUrl = "/__media/x/proxy.mp4";
  const doc = backupDoc(p);
  assert.ok(doc.media.every((m) => m.url === undefined && m.proxyUrl === undefined));
  assert.equal(p.media[0].url, "/__media/m1");  // the open edit is untouched
  const old = structuredClone(doc);
  old.id = "p_other";
  old.studioProjectId = undefined;
  old.name = "Older";
  old.media = old.media.filter((m) => m.id !== "m2");
  old.media.push({ ...old.media[0], id: "m9", path: "C:/m/new.mp4" });
  old.activeSequenceId = "gone";
  const r = restoredProject(p, old);
  assert.deepEqual([r.id, r.studioProjectId, r.name, r.activeSequenceId], [p.id, 42, "Older", old.sequences[0].id]);
  assert.equal(r.media.find((m) => m.id === "m1")!.url, "/__media/m1");
  assert.equal(r.media.find((m) => m.id === "m9")!.url, undefined);
  assert.equal(r.media.some((m) => m.id === "m2"), false);
});
