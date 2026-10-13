/**
 * Room-tone fill (editor/audiotools/roomtone.ts, edits.ts): finding the quietest stretch without speech that isn't
 * digital silence on synthetic audio, and filling a jump-cut dialogue track's gaps with looped, crossfaded clips that
 * can be taken out again.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { featuresOf } from "../audiotools/features.ts";
import { removeRoomTone, roomToneFill, trackGaps } from "../audiotools/edits.ts";
import { findRoomTone, quietThreshold, silenceSegments } from "../audiotools/roomtone.ts";
import { baseClip } from "../model/defaults.ts";
import { clipEnd, ctxOf, normalize } from "../model/ops.ts";
import { toAudioMix } from "../model/toComposition.ts";
import type { EditProject, Sequence } from "../model/types.ts";
import { A, project, seqOf } from "./fixtures.ts";
import { addAt, noiseBed, RATE, word } from "./audiotools-fixtures.ts";

/** 20 s: words, a −52 dBFS room everywhere, one 3.4 s pause where the room is quieter (−58), one of digital silence, one with a click. */
function recording() {
  const x = new Float32Array(RATE * 20);
  addAt(x, noiseBed(20, -52, 3), 0);
  const quiet = { start: 6.2, end: 9.6 };
  for (let i = Math.round(quiet.start * RATE); i < quiet.end * RATE; i++) x[i] *= 0.5;          // −58 dBFS there
  for (let i = Math.round(12.5 * RATE); i < 14.8 * RATE; i++) x[i] = 0;                          // digital silence
  addAt(x, noiseBed(0.004, -6, 9), 17.3);                                                      // a click in a pause
  const words: [number, number][] = [[0.3, 1.1], [1.25, 2.0], [2.2, 3.4], [3.5, 6.0], [9.8, 11.0], [11.1, 12.3], [15.0, 16.8], [18.6, 19.6]];
  words.forEach(([a, b], i) => addAt(x, word(b - a, 120 + 15 * i, -19, 50 + i), a));
  return { x, quiet, words };
}

test("the quietest stretch without speech that isn't digital silence", () => {
  const { x, quiet, words } = recording();
  const f = featuresOf(x, RATE, { spectral: false });
  const thr = quietThreshold(f.rms);
  assert.ok(thr > -52 && thr < -25, `threshold ${thr}`);
  const sil = silenceSegments(f.rms, f.hopS, thr, 0.5);
  // the pauses are found, none of them over a word
  for (const s of sil) for (const [a, b] of words) assert.ok(s.end <= a + 0.05 || s.start >= b - 0.05, `quiet ${s.start}–${s.end} over a word`);
  const rt = findRoomTone(f.rms, f.hopS, sil)!;
  assert.ok(rt, "a stretch");
  assert.ok(rt.start >= quiet.start && rt.end <= quiet.end, `${rt.start}–${rt.end} is in the quiet pause`);
  assert.ok(rt.end - rt.start >= 2.9 && rt.end - rt.start <= 3.01, "the longest stretch that fits (3 s)");
  assert.ok(Math.abs(rt.rmsDb - -58) < 1.5, `level ${rt.rmsDb}`);
  // without the quiet pause: the click's pause loses to the clean one; digital silence never wins
  const sil2 = sil.filter((s) => s.end <= quiet.start || s.start >= quiet.end);
  const rt2 = findRoomTone(f.rms, f.hopS, sil2)!;
  assert.ok(rt2 && !(rt2.start < 14.8 && rt2.end > 12.5), `not the digital silence: ${rt2.start}–${rt2.end}`);
  assert.ok(!(rt2.start <= 17.3 && rt2.end >= 17.31), "not across the click");
  // only digital silence: nothing
  assert.equal(findRoomTone(f.rms, f.hopS, [{ start: 12.5, end: 14.8 }]), null);
  // a pause shorter than the minimum: its best part, marked short (or nothing when the fallback is off)
  const sh = findRoomTone(f.rms, f.hopS, [{ start: 6.2, end: 7.0 }])!;
  assert.ok(sh.short && sh.end - sh.start >= 0.5 && sh.end - sh.start < 1 && sh.start >= 6.2 && sh.end <= 7.0, JSON.stringify(sh));
  assert.equal(findRoomTone(f.rms, f.hopS, [{ start: 6.2, end: 7.0 }], { fallbackS: 0 }), null);
  assert.equal(findRoomTone(f.rms, f.hopS, [{ start: 6.2, end: 6.6 }]), null);
  assert.equal(rt.short, undefined);
});

/** A dialogue track cut into pieces with gaps between them (a jump-cut interview), music on A2. */
function jumpCut(): { p: EditProject; s: Sequence; tid: string } {
  const p = project();
  const s0 = seqOf(p);
  const tid = A(s0, 0).id;
  const mk = (at: number, len: number, inF: number) => {
    const c = baseClip(s0, tid, at, len, { type: "media", mediaId: "m1", in: inF }, "Interview");
    c.audio = { gain: { value: -2.5 }, pan: { value: 0 }, fadeIn: 0, fadeOut: 0 };
    return c;
  };
  const clips = [mk(0, 50, 0), mk(60, 40, 70), mk(100, 30, 120), mk(150, 25, 160), baseClip(s0, A(s0, 1).id, 0, 200, { type: "media", mediaId: "music", in: 0 }, "Music")];
  const s = normalize({ ...s0, clips }, ctxOf(p));
  p.sequences = [s];
  return { p, s, tid };
}

test("room-tone fill: every gap between cuts gets looped, crossfaded room tone at the dialogue's level", () => {
  const { p, s, tid } = jumpCut();
  const ctx = ctxOf(p);
  assert.deepEqual(trackGaps(s, tid), [[50, 60], [130, 150]]);
  // a 1.4 s stretch (35 frames at 25 fps): the 20-frame gap needs one loop, the 10-frame one too
  const r = roomToneFill(s, ctx, { trackId: tid, mediaId: "m1", stretch: { start: 3, end: 4.4 }, gainDb: -2.5 });
  assert.equal(r.gaps, 2);
  const tone = r.seq.clips.filter((c) => c.roomTone);
  assert.equal(tone.length, 2);
  for (const c of tone) {
    assert.equal(c.trackId, tid); assert.equal(c.audio!.gain.value, -2.5); assert.equal(c.name, "Room tone");
    assert.equal(c.source.type === "media" && c.source.mediaId, "m1");
    assert.ok(c.audio!.fadeIn >= 1 && c.audio!.fadeOut >= 1, "faded in and out at the gap's edges");
  }
  assert.deepEqual(tone.map((c) => [c.start, clipEnd(c)]), [[50, 60], [130, 150]]);
  // nothing else moved, nothing overlaps
  assert.deepEqual(r.seq.clips.filter((c) => !c.roomTone).map((c) => [c.id, c.start, c.duration]), s.clips.map((c) => [c.id, c.start, c.duration]));
  // a long gap loops: 3 s of gap from a 1.4 s stretch → 3 loops joined by constant-power crossfades
  const s2 = normalize({ ...s, clips: s.clips.map((c) => (c.start === 150 ? { ...c, start: 205 } : c)) }, ctx);
  const r2 = roomToneFill(s2, ctx, { trackId: tid, mediaId: "m1", stretch: { start: 3, end: 4.4 }, gainDb: -2.5 });
  const loops = r2.seq.clips.filter((c) => c.roomTone && c.start >= 130).sort((a, b) => a.start - b.start);
  assert.ok(loops.length >= 3, `${loops.length} loops`);
  assert.equal(loops[0].start, 130); assert.equal(clipEnd(loops[loops.length - 1]), 205);
  for (let i = 1; i < loops.length; i++) assert.equal(loops[i].start, clipEnd(loops[i - 1]));
  const xf = r2.seq.transitions.filter((t) => t.trackId === tid && t.type === "audio:constant_power");
  assert.equal(xf.length, loops.length - 1);
  for (const t of xf) assert.ok(t.duration >= 1 && t.duration <= 2, "about 30 ms (one frame at 25 fps)");
  // each loop with its crossfade handle (a centred one-frame crossfade plays one frame of the outgoing loop's tail)
  // stays inside the stretch: frames 75 … 110 of m1 (25 fps)
  for (const c of loops) {
    const inF = (c.source as { in: number }).in;
    assert.ok(inF >= 75 - 1e-9 && inF + c.duration + 1 <= 110 + 1e-9, `loop source ${inF}+${c.duration}`);
  }
  // the mix plays them with crossfades
  const mix = toAudioMix({ ...p, sequences: [r2.seq] }, r2.seq.id);
  const planned = mix.clips.filter((c) => loops.some((l) => l.id === c.clipId));
  assert.equal(planned.length, loops.length);
  assert.ok(planned.slice(1).every((c) => c.xIn) && planned.slice(0, -1).every((c) => c.xOut));
  // a second fill replaces the first; Remove room tone takes them all out (and their crossfades)
  const again = roomToneFill(r2.seq, ctx, { trackId: tid, mediaId: "m1", stretch: { start: 3, end: 4.4 }, gainDb: 0 });
  assert.equal(again.seq.clips.filter((c) => c.roomTone).length, r2.seq.clips.filter((c) => c.roomTone).length);
  assert.ok(again.seq.clips.filter((c) => c.roomTone).every((c) => c.audio!.gain.value === 0));
  const cleared = removeRoomTone(again.seq, ctx, tid);
  assert.equal(cleared.clips.filter((c) => c.roomTone).length, 0);
  assert.equal(cleared.transitions.filter((t) => t.trackId === tid).length, 0);
  assert.deepEqual(cleared.clips.map((c) => c.id).sort(), s2.clips.map((c) => c.id).sort());
});

test("room-tone fill refuses a stretch too short to loop, and a track without gaps is left as it is", () => {
  const { p, s, tid } = jumpCut();
  const ctx = ctxOf(p);
  assert.match(roomToneFill(s, ctx, { trackId: tid, mediaId: "m1", stretch: { start: 3, end: 3.1 }, gainDb: 0 }).error ?? "", /too short/);
  const solid = normalize({ ...s, clips: s.clips.filter((c) => c.trackId !== tid || c.start === 0) }, ctx);
  const r = roomToneFill(solid, ctx, { trackId: tid, mediaId: "m1", stretch: { start: 3, end: 4.4 }, gainDb: 0 });
  assert.equal(r.gaps, 0);
  assert.equal(r.seq.clips.length, solid.clips.length);
});
