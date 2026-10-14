/**
 * The breath remover (editor/audiotools/breaths.ts, features.ts, edits.ts breathGain): precision and recall on
 * synthetic speech (tone "words", breath-shaped noise bursts between them, room noise, distractors), the streaming
 * features, and the gain keyframes it writes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectBreaths, matchRanges } from "../audiotools/breaths.ts";
import { breathGain, breathsInClip, MUTE_DB } from "../audiotools/edits.ts";
import { FeatureExtractor, featuresOf } from "../audiotools/features.ts";
import { valueAt } from "../model/params.ts";
import { syntheticSpeech } from "./audiotools-fixtures.ts";

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0;

test("breaths are found between words: precision and recall on synthetic speech", (t) => {
  let tp = 0, fp = 0, fn = 0;
  const lines: string[] = [];
  for (const [noiseDb, seeds] of [[-62, [7, 11, 23]], [-50, [7, 41]]] as const) {
    for (const seed of seeds) {
      const sp = syntheticSpeech(seed, { noiseDb });
      const r = detectBreaths(featuresOf(sp.samples, sp.rate));
      const m = matchRanges(r.breaths, sp.breaths);
      tp += m.tp; fp += m.fp; fn += m.fn;
      lines.push(`room ${noiseDb} dBFS, seed ${seed}: planted ${sp.breaths.length}, found ${r.breaths.length}, P ${m.precision.toFixed(2)} R ${m.recall.toFixed(2)}`);
      // nothing found on a distractor (click, loud burst, long fan, hum, fricative stuck to a word) or on a word
      for (const d of sp.distractors) assert.ok(!r.breaths.some((b) => overlaps(b, d) && !sp.breaths.some((x) => overlaps(b, x))), `${d.kind} at ${d.start.toFixed(2)} s taken for a breath`);
      for (const b of r.breaths) assert.ok(!sp.words.some((w) => Math.min(b.end, w.end) - Math.max(b.start, w.start) > 0.03), `breath ${b.start}–${b.end} runs into a word`);
      for (const b of r.breaths) { assert.ok(b.confidence >= 0.5 && b.confidence <= 1); assert.ok(b.rmsDb <= -24 && b.rmsDb >= -50, `level ${b.rmsDb}`); }
    }
  }
  const precision = tp / (tp + fp), recall = tp / (tp + fn);
  for (const l of lines) t.diagnostic(l);
  t.diagnostic(`overall: ${tp} hits, ${fp} false, ${fn} missed → precision ${precision.toFixed(3)}, recall ${recall.toFixed(3)}`);
  assert.ok(precision >= 0.9, `precision ${precision}`);
  assert.ok(recall >= 0.9, `recall ${recall}`);
});

test("a higher threshold finds fewer, never more", () => {
  const sp = syntheticSpeech(11);
  const f = featuresOf(sp.samples, sp.rate);
  const lo = detectBreaths(f, { threshold: 0.3 }).breaths.length, mid = detectBreaths(f, { threshold: 0.5 }).breaths.length, hi = detectBreaths(f, { threshold: 0.95 }).breaths.length;
  assert.ok(lo >= mid && mid >= hi);
});

test("features stream: any chunking gives the same numbers as the whole signal", () => {
  const sp = syntheticSpeech(5);
  const x = sp.samples.subarray(0, sp.rate * 6);
  const whole = featuresOf(x, sp.rate);
  const fx = new FeatureExtractor(sp.rate);
  for (let i = 0, k = 1; i < x.length; k = (k * 7) % 4093 + 37) { fx.push(x.subarray(i, i + k)); i += k; }
  const parts = fx.finish();
  assert.equal(parts.n, whole.n);
  for (const key of ["rms", "peak", "hf", "flat", "voiced"] as const) assert.deepEqual(parts[key], whole[key], key);
  assert.equal(whole.n, Math.ceil(x.length / (sp.rate * 0.01)));
});

test("silence and digital zeros give no breaths", () => {
  const f = featuresOf(new Float32Array(16000 * 3));
  assert.deepEqual(detectBreaths(f).breaths, []);
});

test("breath gain: the whole breath lowered, ramps outside it when the words leave room, inside when not", () => {
  // breath at clip frames 10.4–19.6 (25 fps), nothing near: low over every frame it touches (10 … 20), one-frame ramps outside
  const g = breathGain({ value: 0 }, [{ from: 10.4, to: 19.6 }], -12, 100);
  assert.deepEqual(g.keyframes!.map((k) => [k.frame, k.value]), [[9, 0], [10, -12], [20, -12], [21, 0]]);
  assert.equal(valueAt(g, 5), 0); assert.equal(valueAt(g, 10.4), -12); assert.equal(valueAt(g, 19.6), -12); assert.equal(valueAt(g, 40), 0);
  // a word 0.5 frame before it and 2 frames after: the ramp moves inside on the start side only
  const g1 = breathGain({ value: 0 }, [{ from: 10.4, to: 19.6, room: [0.5, 2] }], -12, 100);
  assert.deepEqual(g1.keyframes!.map((k) => [k.frame, k.value]), [[11, 0], [12, -12], [20, -12], [21, 0]]);
  // a keyframed level (a duck) stays the base: a key inside the breath moves down with it
  const duck = { value: 0, keyframes: [{ frame: 0, value: -3, ease: "linear" as const }, { frame: 15, value: -9, ease: "linear" as const }, { frame: 50, value: -9, ease: "linear" as const }] };
  const g2 = breathGain(duck, [{ from: 10, to: 20 }], -6, 100);
  const at = (f: number) => g2.keyframes!.find((k) => k.frame === f)!.value;
  assert.equal(at(0), -3); assert.equal(at(50), -9);
  assert.equal(at(15), -15);                       // the duck's own key, 6 dB lower
  assert.equal(at(9), valueAt(duck, 9));           // the ramp starts from the duck's value there
  assert.equal(at(10), Math.round((valueAt(duck, 10) - 6) * 100) / 100);
  // mute: an absolute floor
  const g3 = breathGain({ value: 2 }, [{ from: 30, to: 40 }], "mute", 100);
  assert.equal(valueAt(g3, 35), MUTE_DB); assert.equal(valueAt(g3, 28), 2);
  // under two frames: left alone; overlapping ranges merge into one dip; the clip's edges clamp the ramps
  assert.equal(breathGain({ value: 0 }, [{ from: 3.2, to: 4.9 }], -12, 100).keyframes, undefined);
  const g4 = breathGain({ value: 0 }, [{ from: 10, to: 20 }, { from: 18, to: 30 }], -10, 100);
  assert.equal(valueAt(g4, 20), -10); assert.equal(valueAt(g4, 25), -10);
  assert.equal(g4.keyframes!.filter((k) => k.value === 0).length, 2);
  const g5 = breathGain({ value: 0 }, [{ from: 0.2, to: 5 }, { from: 95, to: 99.6 }], -12, 100);
  assert.ok(g5.keyframes!.every((k) => k.frame >= 0 && k.frame <= 99));
  assert.equal(valueAt(g5, 3), -12); assert.equal(valueAt(g5, 97), -12);
});

test("breaths in media seconds map to clip frames through the clip's in point and speed, with the room to the words", () => {
  const speech = [{ start: 10, end: 10.9 }, { start: 11.6, end: 13 }];
  const r = breathsInClip([{ start: 11, end: 11.4 }, { start: 2, end: 2.3 }, { start: 30, end: 31 }], { duration: 250, speed: 2 }, 10, 25, speech);
  // (11 − 10) / 2 s = 0.5 s → frame 12.5; the one before the clip's in and the one after its end are dropped
  assert.equal(r.length, 1);
  assert.ok(Math.abs(r[0].from - 12.5) < 1e-9 && Math.abs(r[0].to - 17.5) < 1e-9);
  // 0.1 s to the word before and 0.2 s to the one after, at twice the speed: 1.25 and 2.5 frames
  assert.ok(Math.abs(r[0].room![0] - 1.25) < 1e-9 && Math.abs(r[0].room![1] - 2.5) < 1e-9);
  assert.deepEqual(breathsInClip([{ start: 11, end: 11.4 }], { duration: 250, speed: 1 }, 10, 25)[0].room, [Infinity, Infinity]);
});
