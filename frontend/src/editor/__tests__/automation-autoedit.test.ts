/**
 * Auto edit's planner (frontend/src/automation/autoedit, docs/EDITOR.md §13.3), one test per style, on analysis shaped
 * like the desktop's (silences, scenes, beats, black / frozen / blurred / clipped ranges, energy and motion curves,
 * transcripts). Pure and deterministic.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { describePlan, orderMedia, planAutoEdit, prettyName, takeQuality } from "../../automation/autoedit/planner.ts";
import { STYLES } from "../../automation/autoedit/styles.ts";
import type { MediaAnalysis, PlanMedia } from "../../automation/autoedit/types.ts";

const V = (id: string, name: string, duration: number, o: Partial<PlanMedia> = {}): PlanMedia => ({ id, name, kind: "video", duration, hasAudio: true, width: 1920, height: 1080, ...o });
const A = (id: string, a: Partial<MediaAnalysis> & { duration: number }): MediaAnalysis => ({ mediaId: id, name: id, kind: "video", hasAudio: true, width: 1920, height: 1080, ...a });
const curve = (seconds: number, f: (t: number) => number) => Array.from({ length: Math.ceil(seconds / 0.5) }, (_, i) => f(i * 0.5));
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.min(a.end, b.end) - Math.max(a.start, b.start);

test("talking head: silences and bad takes out, punch-ins on long takes, captions, voice clean-up", () => {
  const media = [V("m1", "vlog_001.mp4", 20), V("m2", "vlog_002.mp4", 0.6), V("m3", "vlog_003.mp4", 12), V("m4", "vlog_004.mp4", 15), V("m5", "vlog_005.mp4", 10), V("m6", "vlog_006.mp4", 9)];
  const analysis = [
    A("m1", { duration: 20, silences: [{ start: 3, end: 5 }, { start: 10, end: 11.5 }, { start: 18, end: 20 }], energy: curve(20, () => -20),
      transcript: [{ start: 0.2, end: 2.8, text: "Hi, welcome back to the channel" }, { start: 5.2, end: 9.8, text: "Today we walk to the lighthouse" }] }),
    A("m2", { duration: 0.6 }),
    A("m3", { duration: 12, black: [{ start: 0, end: 8 }] }),
    A("m4", { duration: 15, blurScore: 12 }),
    A("m5", { duration: 10, clipped: [{ start: 0, end: 6 }] }),
    A("m6", { duration: 9, freeze: [{ start: 2, end: 3.5 }], silences: [{ start: 6, end: 7 }], energy: curve(9, () => -22) }),
  ];
  const p = planAutoEdit(media, analysis, { style: "talking_head", folder: "Lighthouse", fps: 25 });
  assert.equal(p.name, "Auto edit · Lighthouse · Talking head / vlog");
  assert.deepEqual([p.width, p.height], [1920, 1080]);
  assert.deepEqual(p.summary.dropped.map((d) => [d.mediaId, d.reason]), [["m2", "too short (0.6 s)"], ["m3", "mostly black"], ["m4", "out of focus"],
    ["m5", "clipped (distorted) sound"]]);
  assert.deepEqual([...new Set(p.segments.map((s) => s.mediaId))], ["m1", "m6"]);
  // no kept piece runs into a silence (beyond the 0.12 s of air at each side)
  for (const s of p.segments) for (const sil of analysis.find((a) => a.mediaId === s.mediaId)!.silences ?? []) {
    assert.ok(overlaps({ start: s.in, end: s.out }, { start: sil.start + 0.12, end: sil.end - 0.12 }) <= 1e-6, `${s.mediaId} ${s.in}-${s.out} vs ${sil.start}-${sil.end}`);
  }
  // the frozen stretch of m6 is cut out
  for (const s of p.segments.filter((x) => x.mediaId === "m6")) assert.ok(overlaps({ start: s.in, end: s.out }, { start: 2, end: 3.5 }) <= 1e-6);
  assert.ok(Math.abs(p.summary.silenceRemoved - 5.66) < 0.05, `silence removed ${p.summary.silenceRemoved}` /* 1.76 + 1.26 + 1.88 in m1, 0.76 in m6 */);
  assert.ok(p.summary.badRemoved >= 1.5);
  // back to back on the timeline
  let t = 0;
  for (const s of p.segments) { assert.ok(Math.abs(s.at - t) < 1e-6); t += s.duration; }
  assert.ok(Math.abs(p.summary.length - t) < 0.01);
  // a jump cut inside one take punches in on every other piece
  const m1 = p.segments.filter((s) => s.mediaId === "m1");
  assert.equal(m1[0].scale, undefined);
  assert.equal(m1[1].scale, 112);
  assert.deepEqual(p.transitions, [], "hard cuts");
  assert.deepEqual(p.voiceFx, ["voice_enhance", "speech_level"]);
  assert.ok(p.captions.length >= 2);
  assert.equal(p.captions[0].text, "Hi, welcome back to the channel");
  assert.ok(p.captions[0].start >= 0 && p.captions[0].end <= m1[0].duration + 0.01);
  assert.match(describePlan(p), /2 of 6 clips, \d+ cuts, [\d.]+ s long/);
  assert.match(describePlan(p), /silence removed/);
  // deterministic
  assert.deepEqual(planAutoEdit(media, analysis, { style: "talking_head", folder: "Lighthouse", fps: 25 }), p);
  // a target length keeps the liveliest pieces and lands on it
  const short = planAutoEdit(media, analysis, { style: "talking_head", targetSeconds: 8 });
  assert.ok(short.summary.length <= 8.01 && short.summary.length > 6, `${short.summary.length}`);
});

test("montage: cuts on the music's beats, the liveliest parts, ramps, transitions on the beat and a mood", () => {
  const media = [V("c1", "b_roll_01.mp4", 12, { hasAudio: false }), V("c2", "b_roll_02.mp4", 10, { hasAudio: false }),
    { id: "mu", name: "song.mp3", kind: "audio" as const, duration: 16, hasAudio: true, width: 0, height: 0 }];
  const beats = Array.from({ length: 31 }, (_, i) => 0.5 * (i + 1)).filter((b) => b < 16);
  const analysis = [
    A("c1", { duration: 12, hasAudio: false, motion: curve(12, (t) => (t >= 6 && t < 10 ? 0.4 : 0.02)) }),
    A("c2", { duration: 10, hasAudio: false, motion: curve(10, (t) => (t < 3 ? 0.3 : 0.01)) }),
    { ...A("mu", { duration: 16, kind: "audio" }), beats, bpm: 120 },
  ];
  const p = planAutoEdit(media, analysis, { style: "montage", music: "mu", folder: "Trip" });
  assert.equal(p.summary.length, 16, "as long as the music");
  // every cut lands on a beat, about 2 s apart (4 beats at 120 BPM)
  for (const s of p.segments.slice(1)) assert.ok(beats.some((b) => Math.abs(b - s.at) < 1e-6), `cut at ${s.at}`);
  assert.ok(p.segments.every((s) => Math.abs(s.duration - 2) < 1e-6), p.segments.map((s) => s.duration).join(","));
  assert.ok(p.segments.every((s) => !s.sound), "the music carries the sound");
  // the first shot of c1 is its liveliest part (6–10 s)
  const firstC1 = p.segments.find((s) => s.mediaId === "c1")!;
  assert.ok(firstC1.in >= 6 && firstC1.out <= 10, `${firstC1.in}-${firstC1.out}`);
  assert.equal(p.segments[3].ramp, "slowmo_burst", "a speed ramp every 4th shot");
  assert.ok(p.transitions.length >= 1 && p.transitions.every((t) => t.duration <= 0.5));
  assert.ok(p.transitions.every((t) => beats.some((b) => Math.abs(b - t.at) < 1e-6)), "transitions on the beats");
  assert.equal(p.mood, "action");
  assert.deepEqual(p.beds.map((b) => [b.mediaId, b.role, b.duration]), [["mu", "music", 16]]);
  // no music: a cut every 2 s and a note; AI music is proposed, never run
  const ai = planAutoEdit(media.slice(0, 2), analysis, { style: "montage", music: "ai", targetSeconds: 10 });
  assert.equal(ai.summary.length, 10);
  assert.match(ai.proposals[0], /AI music for 10 s .*approval/);
  assert.ok(ai.summary.notes.some((n) => /a cut every 2 s/.test(n)));
});

test("documentary: scene order, long pauses trimmed, J/L cuts, an ambience bed and lower thirds", () => {
  const media = [V("d1", "Asha_interview.mp4", 20), V("d2", "Harbour_wide.mp4", 12), { id: "rt", name: "room tone.wav", kind: "audio" as const, duration: 60, hasAudio: true, width: 0, height: 0 }];
  const analysis = [
    A("d1", { duration: 20, scenes: [10], silences: [{ start: 4, end: 6 }, { start: 14, end: 14.6 }], energy: curve(20, () => -18) }),
    A("d2", { duration: 12, scenes: [6], silences: [{ start: 0, end: 1.5 }], energy: curve(12, () => -30) }),
    { ...A("rt", { duration: 60, kind: "audio" }) },
  ];
  const p = planAutoEdit(media, analysis, { style: "documentary", folder: "Harbour" });
  assert.deepEqual([...new Set(p.segments.map((s) => s.mediaId))], ["d1", "d2"], "scene order");
  assert.ok(p.segments.filter((s) => s.mediaId === "d1").every((s) => overlaps({ start: s.in, end: s.out }, { start: 4.3, end: 5.7 }) <= 1e-6), "the 2 s pause is trimmed");
  assert.ok(p.segments.some((s) => s.mediaId === "d1" && s.in < 14.6 && s.out > 14), "a short pause stays (it's breathing room)");
  assert.ok(p.segments.some((s) => s.soundLead || s.soundTail), "a J or L cut where the clip changes (d2's trimmed pause is the handle)");
  const noHandles = planAutoEdit(media, [analysis[0], A("d2", { duration: 12 }), analysis[2]], { style: "documentary" });
  assert.ok(noHandles.segments.every((s) => !s.soundLead && !s.soundTail), "no J/L cut without media to lead in or run on");
  assert.deepEqual(p.titles.map((t) => [t.text, t.kind, t.position]), [["Asha interview", "lower_third", "lower_third"], ["Harbour wide", "lower_third", "lower_third"]]);
  assert.deepEqual(p.beds.map((b) => [b.mediaId, b.role, b.gainDb]), [["rt", "ambience", -20]]);
  assert.ok(p.transitions.length === 1 && p.transitions[0].type === "fade", "a dissolve where the clip changes");
  assert.equal(p.mood, "documentary");
});

test("highlights: 9:16, the best moments by speech, loudness and motion, a hook, short captions", () => {
  const media = [V("h1", "stream_part1.mp4", 60), V("h2", "stream_part2.mp4", 40)];
  const analysis = [
    A("h1", { duration: 60, silences: [{ start: 0, end: 20 }], energy: curve(60, (t) => (t >= 30 && t < 40 ? -8 : -35)), motion: curve(60, (t) => (t >= 30 && t < 40 ? 0.3 : 0.02)),
      transcript: [{ start: 30.5, end: 34, text: "And that is how we won the final round today" }] }),
    A("h2", { duration: 40, energy: curve(40, (t) => (t >= 10 && t < 20 ? -10 : -40)), motion: curve(40, () => 0.05) }),
  ];
  const p = planAutoEdit(media, analysis, { style: "highlights", targetSeconds: 15 });
  assert.deepEqual([p.width, p.height], [1080, 1920]);
  assert.ok(p.summary.length <= 15.01 && p.summary.length >= 14, `${p.summary.length}`);
  assert.ok(p.segments.every((s) => s.cover), "fills the vertical frame");
  // the loud, lively stretches win; the silent first 20 s never shows
  assert.ok(p.segments.every((s) => s.mediaId !== "h1" || s.in >= 20));
  assert.ok(p.segments.some((s) => s.mediaId === "h1" && s.in >= 30 && s.out <= 40.01));
  assert.ok(p.segments.some((s) => s.mediaId === "h2" && s.in >= 9.5 && s.out <= 20.5));
  // in story order
  assert.equal(p.segments[0].mediaId, "h1");
  assert.equal(p.titles[0].kind, "hook");
  assert.equal(p.titles[0].text, "And that is how we won the final round today");
  assert.ok(p.captions.length >= 3 && p.captions.every((c) => c.text.split(" ").length <= 4), "phrases of up to four words");
  assert.ok(planAutoEdit(media, analysis, { style: "highlights", targetSeconds: 300 }).summary.length <= 60.01, "a Short stays under a minute");
  assert.equal(planAutoEdit(media, analysis, { style: "highlights", title: "Final round!" }).titles[0].text, "Final round!");
});

test("slideshow: stills with Ken Burns, timed to the music's beats, crossfades", () => {
  const media: PlanMedia[] = [1, 2, 3, 4, 5].map((i) => ({ id: `p${i}`, name: `IMG_000${i}.jpg`, kind: "image", duration: 0, hasAudio: false, width: 4032, height: 3024 }));
  media.push({ id: "mu", name: "piano.wav", kind: "audio", duration: 21, hasAudio: true, width: 0, height: 0 });
  const beats = Array.from({ length: 30 }, (_, i) => 0.75 * (i + 1));
  const p = planAutoEdit(media, [{ ...A("mu", { duration: 21, kind: "audio" }), beats, bpm: 80 }], { style: "slideshow", music: "mu" });
  assert.equal(p.segments.length, 5);
  for (const s of p.segments) {
    assert.ok(s.kenBurns, "a Ken Burns move");
    assert.ok(Math.abs(s.duration / 0.75 - Math.round(s.duration / 0.75)) < 1e-6, `whole beats: ${s.duration}`);
  }
  assert.notDeepEqual(p.segments[0].kenBurns, p.segments[1].kenBurns, "push in, then pull out");
  assert.equal(p.transitions.length, 4);
  assert.ok(p.transitions.every((t) => t.type === "fade" && t.duration <= 0.8));
  assert.equal(p.beds[0].role, "music");
  assert.ok(p.beds[0].duration <= p.summary.length + 1e-6);
  assert.equal(planAutoEdit(media.slice(0, 5), [], { style: "slideshow", targetSeconds: 10 }).segments[0].duration, 2, "a target splits evenly");
});

test("order: series names, date taken, timecode, content; bad takes; names for lower thirds", () => {
  const ms = [V("a", "Clip_10.mp4", 5), V("b", "clip_2.mp4", 5), V("c", "Clip_1.mp4", 5)];
  assert.deepEqual(orderMedia(ms, {}).map((m) => m.id), ["c", "b", "a"]);
  const by = { a: A("a", { duration: 5, created: "2026-10-01T09:00:00Z", transcript: [{ start: 0, end: 1, text: "Hello and welcome" }] }),
    b: A("b", { duration: 5, created: "2026-10-01T08:00:00Z", transcript: [{ start: 0, end: 1, text: "Thanks for watching, bye" }] }),
    c: A("c", { duration: 5, created: "2026-10-01T10:00:00Z", timecode: "00:00:01:00" }) };
  assert.deepEqual(orderMedia(ms, by, "date").map((m) => m.id), ["b", "a", "c"]);
  assert.deepEqual(orderMedia(ms, by, "content").map((m) => m.id), ["a", "c", "b"]);
  assert.equal(orderMedia(ms, by, "timecode")[0].id, "c");
  assert.equal(takeQuality(V("x", "x", 10), A("x", { duration: 10, clipped: [{ start: 0, end: 2 }] }), true).bad.length, 1, "a little clipping is cut out, not the take");
  assert.equal(takeQuality(V("x", "x", 10), A("x", { duration: 10, clipped: [{ start: 0, end: 5 }] }), false).drop, undefined, "clipping doesn't matter under music");
  assert.equal(prettyName("IMG_0042_harbour-walk.mp4"), "harbour walk");
  assert.equal(STYLES.length, 5);
});
