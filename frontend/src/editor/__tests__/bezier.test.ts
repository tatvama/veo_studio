import assert from "node:assert/strict";
import { test } from "node:test";
import { autoBezierHandles, bounceOut, cubicBezier, elasticOut, solveT, spatialPoint, splitBezier } from "../model/bezier.ts";
import { addKeyframe, sliceParam, valueAt } from "../model/params.ts";
import { applyEasePreset, autoBezier, copyKeys, moveKeys, pasteKeys, speedAt } from "../model/keyframes.ts";
import { bakeKeys } from "../model/toComposition.ts";
import type { Param } from "../model/types.ts";

const near = (a: number, b: number, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("cubic-bezier easing: endpoints, linear handles, symmetric easy ease, overshooting back", () => {
  for (const x of [0, 0.2, 0.5, 0.9, 1]) near(cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3, x), x);
  near(cubicBezier(0.42, 0, 0.58, 1, 0.5), 0.5);
  assert.ok(cubicBezier(0.42, 0, 0.58, 1, 0.2) < 0.2 && cubicBezier(0.42, 0, 0.58, 1, 0.8) > 0.8);
  assert.ok(Math.max(...[0.5, 0.6, 0.7, 0.8].map((x) => cubicBezier(0.34, 1.56, 0.64, 1, x))) > 1.05, "back overshoots");
  near(cubicBezier(0.34, 1.56, 0.64, 1, 0), 0); near(cubicBezier(0.34, 1.56, 0.64, 1, 1), 1);
  // the time solve inverts x(t)
  const t = solveT(0.1, 0.9, 0.3);
  const x = 3 * (1 - t) * (1 - t) * t * 0.1 + 3 * (1 - t) * t * t * 0.9 + t * t * t;
  near(x, 0.3, 1e-6);
  near(bounceOut(0), 0); near(bounceOut(1), 1); near(elasticOut(0), 0); near(elasticOut(1), 1);
  assert.ok(Math.max(...[0.1, 0.15, 0.2, 0.25].map(elasticOut)) > 1, "elastic wobbles past the target");
});

test("splitting a bezier segment keeps the curve; a razor through it looks the same", () => {
  const sp = splitBezier([0.25, 0.1], [0.25, 1], 0.4);
  // left part at its own fractions, scaled back, equals the whole curve
  for (const u of [0.1, 0.5, 0.9]) near(sp.progress * cubicBezier(sp.left.out[0], sp.left.out[1], sp.left.in[0], sp.left.in[1], u), cubicBezier(0.25, 0.1, 0.25, 1, 0.4 * u), 1e-3);
  for (const u of [0.1, 0.5, 0.9]) near(sp.progress + (1 - sp.progress) * cubicBezier(sp.right.out[0], sp.right.out[1], sp.right.in[0], sp.right.in[1], u), cubicBezier(0.25, 0.1, 0.25, 1, 0.4 + 0.6 * u), 1e-3);
  const p: Param<number> = { value: 0, keyframes: [{ frame: 0, value: 0, ease: "bezier", out: [0.6, 0] }, { frame: 50, value: 100, ease: "linear", in: [0.4, 1] }] };
  const left = sliceParam(p, 0, 20), right = sliceParam(p, 20, 50);
  for (const f of [5, 10, 19]) near(valueAt(left, f), valueAt(p, f), 0.05);
  for (const f of [0, 7, 22, 29]) near(valueAt(right, f), valueAt(p, f + 20), 0.05);
  // adding a key on the curve keeps its shape
  const q = addKeyframe(p, 25);
  for (const f of [5, 12, 30, 44]) near(valueAt(q, f), valueAt(p, f), 0.05);
});

test("motion paths: spatial tangents curve the path; slicing keeps it", () => {
  near(spatialPoint([0, 0], [0, 30], [0, 30], [90, 0], 0.5)[1], 22.5);
  near(spatialPoint([0, 0], undefined, undefined, [90, 0], 0.5)[0], 45);
  const p: Param<[number, number]> = { value: [0, 0], keyframes: [{ frame: 0, value: [0, 0], ease: "linear", tangentOut: [0, 60] }, { frame: 30, value: [90, 0], ease: "linear", tangentIn: [0, 60] }] };
  assert.ok(valueAt(p, 15)[1] > 40, "the path bows out");
  const r = sliceParam(p, 10, 30);
  for (const f of [0, 5, 12]) { const a = valueAt(r, f), b = valueAt(p, f + 10); near(a[0], b[0], 0.05); near(a[1], b[1], 0.05); }
});

test("auto-bezier is flat at the ends and at peaks, smooth through the middle", () => {
  const h = autoBezierHandles([{ frame: 0, value: 0 }, { frame: 10, value: 50 }, { frame: 20, value: 100 }, { frame: 30, value: 0 }]);
  assert.equal(h.length, 3);
  near(h[0].out[1], 0);                 // flat start
  assert.ok(h[0].in[1] < 1 && h[1].out[1] > 0, "carries speed through the middle key");
  near(h[1].in[1], 1); near(h[2].out[1], 0); // the peak at 20 is flat on both sides
  const p: Param<number> = { value: 0, keyframes: [{ frame: 0, value: 0, ease: "linear" }, { frame: 10, value: 50, ease: "linear" }, { frame: 20, value: 100, ease: "linear" }] };
  const a = autoBezier(p);
  assert.ok(a.keyframes!.every((k, i) => i === a.keyframes!.length - 1 || k.ease === "bezier"));
  assert.ok(valueAt(a, 15) > 75 && valueAt(a, 15) < 90);
});

test("keyframe edits: presets, moving several, copy and paste, the speed graph", () => {
  const p: Param<number> = { value: 0, keyframes: [{ frame: 0, value: 0, ease: "linear" }, { frame: 10, value: 10, ease: "linear" }, { frame: 20, value: 0, ease: "linear" }] };
  const b = applyEasePreset(p, [0], "back");
  assert.equal(b.keyframes![0].ease, "bezier"); assert.deepEqual(b.keyframes![1].in, [0.64, 1]);
  assert.ok(Math.max(...[5, 6, 7, 8].map((f) => valueAt(b, f))) > 10, "back overshoots its target");
  const m = moveKeys(p, [10, 20], 5, 1);
  assert.deepEqual(m.keyframes!.map((k) => [k.frame, k.value]), [[0, 0], [15, 11], [25, 1]]);
  const clip = copyKeys(p, [10, 20]);
  assert.deepEqual(clip.map((k) => k.frame), [0, 10]);
  const pasted = pasteKeys({ value: 3 }, clip, 30);
  assert.deepEqual(pasted.keyframes!.map((k) => [k.frame, k.value]), [[30, 10], [40, 0]]);
  near(speedAt(p, 5), 1); near(speedAt(p, 15), -1);
});

test("the engine gets bezier, bounce and elastic baked into straight per-frame keys", () => {
  const p: Param<number> = { value: 0, keyframes: [{ frame: 0, value: 0, ease: "bounce" }, { frame: 10, value: 100, ease: "hold" }, { frame: 14, value: 50, ease: "linear" }] };
  const ks = bakeKeys(p);
  assert.equal(ks.length, 12);
  assert.ok(ks.every((k) => k.ease === "linear" || k.ease === "hold"));
  for (const k of ks) near(k.value as number, valueAt(p, k.frame) as number, 1e-9);
});
