import assert from "node:assert/strict";
import { test } from "node:test";
import { fitBox, formatById, formatSize, reframeMotion, reframeSequence, safeAreaIssues, SAFE_AREAS, smoothAim, type FaceSample } from "../templates/formats.ts";
import { cutRanges, findFillers, placeWords, wordRanges, wordsFromSegments, type Transcript } from "../panels/TranscriptOps.ts";
import { matchWheels, frameStats, greyWorldWb, scopeImage } from "../moods/scopes.ts";
import { addGenerated, ctxOf, seqEnd } from "../model/ops.ts";
import { defaultTitle } from "../model/defaults.ts";
import { A, project, put, seqOf, V } from "./fixtures.ts";

const clip = { picW: 1920, picH: 1080, srcIn: 0, speed: 1, frames: 250, fps: 25 };

test("reframe without faces: the picture fills the frame, centred", () => {
  const r = reframeMotion([], clip, 1080, 1920);
  assert.equal(r.position.keyframes, undefined);
  assert.deepEqual(r.position.value, [540, 960]);
  // 16:9 into 9:16: cover is 1920/1080 × the fitted size
  assert.ok(Math.abs(r.scale - (1920 / 1080) * (1920 / 1080) * 100) < 0.1, String(r.scale));
});

test("reframe follows a moving face with smooth, clamped keyframes", () => {
  // a face walking from the left third to the right third over 10 s, with jitter
  const faces: FaceSample[] = Array.from({ length: 101 }, (_, i) => ({ t: i / 10, x: 0.25 + 0.4 * (i / 100) + (i % 2 ? 0.01 : -0.01), y: 0.3, w: 0.1, h: 0.2 }));
  const r = reframeMotion(faces, clip, 1080, 1920);
  const ks = r.position.keyframes!;
  assert.ok(ks.length >= 2 && ks.length < 30, String(ks.length));
  for (let i = 1; i < ks.length; i++) {
    assert.ok(ks[i].frame > ks[i - 1].frame);
    assert.ok(ks[i].value[0] <= ks[i - 1].value[0] + 0.5, "the picture slides left as the face goes right");
  }
  // the displayed picture is 3413 px wide: its edges never show
  const dw = 1920 * (1920 / 1080);
  for (const k of ks) assert.ok(k.value[0] >= 1080 - dw / 2 - 0.5 && k.value[0] <= dw / 2 + 0.5);
  // the dead zone swallows jitter: a still face with noise gives no motion
  const still = smoothAim(Array.from({ length: 50 }, (_, i) => ({ t: i / 10, x: 0.45 + (i % 2 ? 0.02 : -0.02), y: 0.3, w: 0.1, h: 0.1 })));
  assert.ok(still.every((p) => Math.abs(p.x - still[0].x) < 1e-9));
});

test("formats, safe areas and the reframed copy", () => {
  assert.deepEqual(formatSize({ width: 1920, height: 1080 }, formatById("9:16")!), { width: 1080, height: 1920 });
  assert.deepEqual(formatSize({ width: 3840, height: 2160 }, formatById("4:5")!), { width: 2160, height: 2700 });
  const safe = SAFE_AREAS["9:16"];
  const b = fitBox([0, 0.85, 1, 0.12], safe);
  assert.ok(b[0] >= safe.left && b[1] + b[3] <= 1 - safe.bottom + 1e-9 && b[0] + b[2] <= 1 - safe.right + 1e-9);
  const p = project();
  let s = seqOf(p);
  s = put(p, s, "m1", 0, { in: 0, out: 99 });
  s = addGenerated(s, ctxOf(p), V(s, 1).id, 0, 50, { type: "title", text: { ...defaultTitle("Lower"), box: [0.05, 0.85, 0.6, 0.1] } }, "Lower").seq;
  const p2 = { ...p, sequences: [s] };
  assert.equal(safeAreaIssues(s, formatById("9:16")!).length, 1);
  const vid = s.clips.find((c) => c.trackId === V(s, 0).id)!;
  const r = reframeSequence(p2, s.id, formatById("9:16")!, { [vid.id]: [{ t: 0, x: 0.6, y: 0.2, w: 0.1, h: 0.2 }] }, { fitTitles: true });
  assert.deepEqual([r.sequence.width, r.sequence.height], [1080, 1920]);
  assert.equal(r.reframed, 1);
  assert.equal(r.titlesMoved, 1);
  assert.equal(safeAreaIssues(r.sequence, formatById("9:16")!).length, 0);
  assert.equal(r.sequence.clips.length, s.clips.length);
  assert.ok(r.sequence.clips.every((c) => !s.clips.some((x) => x.id === c.id)), "fresh ids");
  const links = r.sequence.clips.filter((c) => c.linkId).map((c) => c.linkId);
  assert.equal(new Set(links).size, 1);   // the A/V pair stays linked
});

test("transcript words map through trims and speed; deleting words ripples linked A/V", () => {
  const p = project();
  let s = seqOf(p);
  // m1 from source frame 50 (2 s in) at the start of the timeline
  s = put(p, s, "m1", 0, { in: 50, out: 249 });
  const tr: Transcript = { mediaId: "m1", source: "whisper", words: wordsFromSegments([{ start: 2, end: 4, text: "", words: [
    { start: 2.0, end: 2.4, text: "so" }, { start: 2.4, end: 2.8, text: "um" }, { start: 2.8, end: 3.4, text: "hello" }, { start: 3.4, end: 4, text: "world" }] }]) };
  const ctx = ctxOf({ ...p, sequences: [s] });
  const words = placeWords(s, ctx, { m1: tr });
  assert.deepEqual(words.map((w) => [w.text, w.from, w.to]), [["so", 0, 10], ["um", 10, 20], ["hello", 20, 35], ["world", 35, 50]]);
  assert.equal(words[0].trackId, A(s, 0).id);   // the sound clip carries the transcript, its video half is skipped
  assert.deepEqual(findFillers(words), [words[1].key]);
  const ranges = wordRanges(words, [words[1].key, words[2].key]);
  assert.deepEqual(ranges.map((r) => [r.from, r.to]), [[10, 35]]);
  const before = seqEnd(s);
  const cut = cutRanges(s, ctx, ranges);
  assert.equal(seqEnd(cut), before - 25);
  const v = cut.clips.filter((c) => c.trackId === V(cut, 0).id), a = cut.clips.filter((c) => c.trackId === A(cut, 0).id);
  assert.deepEqual(v.map((c) => [c.start, c.duration]), a.map((c) => [c.start, c.duration]));
  assert.deepEqual(v.map((c) => [c.start, c.duration]), [[0, 10], [10, 165]]);
  // the words map again after the cut: "world" now follows "so"
  const again = placeWords(cut, ctxOf({ ...p, sequences: [cut] }), { m1: tr });
  assert.deepEqual(again.map((w) => w.text), ["so", "world"]);
  assert.deepEqual([again[1].from, again[1].to], [10, 25]);
});

test("scopes and colour statistics", () => {
  const W = 64, H = 36;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[i * 4] = 180; data[i * 4 + 1] = 120; data[i * 4 + 2] = 90; data[i * 4 + 3] = 255; }
  const f = { data, width: W, height: H };
  for (const k of ["waveform", "parade", "vectorscope", "histogram"] as const) {
    const img = scopeImage(k, f, 128, 64, 1);
    assert.equal(img.length, 128 * 64 * 4);
    assert.ok(img.some((v, i) => i % 4 === 3 && v > 0), k);
  }
  const st = frameStats(f, { step: 1 });
  const wb = greyWorldWb(st);
  assert.ok(wb.temperature < 0, "a warm cast is cooled");
  const ref = frameStats({ data: data.map((v, i) => (i % 4 === 3 ? 255 : 128)), width: W, height: H }, { step: 1 });
  const m = matchWheels(st, ref);
  assert.ok(m.gain[0] < 0 && m.gain[2] > 0, JSON.stringify(m));
});
