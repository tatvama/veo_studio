import assert from "node:assert/strict";
import { test } from "node:test";
import { bounceOut, cubicBezier, ease, elasticOut } from "../easing.ts";
import { paramAt, segmentEase } from "../keyframes.ts";
import { evaluate, sourceRate, sourceTime, timeMapAt, timeMapOf } from "../timeline.ts";
import type { Clip, Composition, Param } from "../types.ts";

const close = (a: number, b: number, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≈ ${b}`);
const vclip = (o: Partial<Clip> = {}): Clip => ({ id: "c", media: { url: "v.mp4", kind: "video", duration: 20 }, start: 2, duration: 4, in: 1, speed: 1, fit: "cover", fx: {}, ...o });

test("Penner bounce / elastic: ends fixed, known midpoints, elastic overshoots", () => {
  for (const f of [bounceOut, elasticOut]) { close(f(0), 0); close(f(1), 1); }
  close(bounceOut(0.5), 0.765625, 1e-9);
  close(bounceOut(1 / 2.75), 1, 1e-9);
  assert.ok([...Array(100)].some((_, i) => elasticOut(i / 100) > 1.01), "elastic goes past 1");
  close(elasticOut(0.5), 1 + Math.pow(2, -5) * Math.sin((5 - 0.75) * (2 * Math.PI / 3)), 1e-12);
  close(ease("bounce", 0.5), 0.765625, 1e-9);
  close(ease("elastic", 0.2), elasticOut(0.2), 1e-12);
});

test("cubic-bezier: CSS ease / linear / overshoot", () => {
  close(cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3, 0.37), 0.37, 1e-6, "linear");
  // CSS "ease" = cubic-bezier(0.25, 0.1, 0.25, 1): at x = 0.5 it is ≈ 0.8024
  close(cubicBezier(0.25, 0.1, 0.25, 1, 0.5), 0.8024033877399112, 2e-5, "ease");
  close(cubicBezier(0.42, 0, 1, 1, 0.5), 0.3153568, 2e-5, "ease-in");
  close(cubicBezier(0.68, -0.55, 0.265, 1.55, 0), 0); close(cubicBezier(0.68, -0.55, 0.265, 1.55, 1), 1);
  assert.ok(cubicBezier(0.68, -0.55, 0.265, 1.55, 0.15) < 0, "back-in dips below 0");
  assert.ok(cubicBezier(0.68, -0.55, 0.265, 1.55, 0.85) > 1, "back-out goes past 1");
  for (let i = 0; i <= 20; i++) { const y = cubicBezier(0.1, 0.7, 0.9, 0.3, i / 20); assert.ok(Number.isFinite(y)); }
});

test("paramAt: bezier keys use out / in handles; bounce / elastic segments; hold; numbers and colours", () => {
  const p: Param<number> = { value: 0, keyframes: [{ t: 0, value: 10, ease: "bezier", out: [0.25, 0.1] }, { t: 2, value: 20, in: [0.25, 1] }] };
  close(paramAt(p, 1)!, 10 + 10 * cubicBezier(0.25, 0.1, 0.25, 1, 0.5), 1e-9);
  close(paramAt(p, 0)!, 10); close(paramAt(p, 2)!, 20); close(paramAt(p, 5)!, 20);
  // missing handles: linear
  close(paramAt({ value: 0, keyframes: [{ t: 0, value: 0, ease: "bezier" }, { t: 1, value: 1 }] }, 0.3)!, 0.3, 1e-6);
  close(paramAt({ value: 0, keyframes: [{ t: 0, value: 0, ease: "bounce" }, { t: 1, value: 100 }] }, 0.5)!, 76.5625, 1e-6);
  const el = paramAt({ value: 0, keyframes: [{ t: 0, value: 0, ease: "elastic" }, { t: 1, value: 100 }] }, 0.3)!;
  close(el, 100 * elasticOut(0.3), 1e-9);
  assert.equal(paramAt({ value: 0, keyframes: [{ t: 0, value: 3, ease: "hold" }, { t: 1, value: 9 }] }, 0.9), 3);
  // an overshooting handle overshoots the value
  const ov = paramAt({ value: 0, keyframes: [{ t: 0, value: 0, ease: "bezier", out: [0.3, 1.8] }, { t: 1, value: 10, in: [0.7, 1] }] }, 0.5)!;
  assert.ok(ov > 10, `overshoot ${ov}`);
  // frames instead of seconds
  close(paramAt({ value: 0, keyframes: [{ frame: 0, value: 0, ease: "bezier", out: [0.5, 0] }, { frame: 24, value: 1, in: [0.5, 1] }] }, 0.5, 24)!, 0.5, 1e-6);
  assert.equal(segmentEase({ value: 0, ease: "bezier", out: [0, 0] }, { value: 1, in: [1, 1] }, 0.5), cubicBezier(0, 0, 1, 1, 0.5));
});

test("paramAt: spatial tangents give a curved path (cubic Bézier through the handles), timing from the ease", () => {
  const p: Param<[number, number]> = { value: [0, 0], keyframes: [{ t: 0, value: [0, 0], tangentOut: [0, 300] }, { t: 1, value: [300, 0], tangentIn: [0, 300] }] };
  const mid = paramAt(p, 0.5)!;
  close(mid[0], 150, 1e-9);
  close(mid[1], 225, 1e-9, "bulges by ¾ of the handle");  // 3·¼·½·300·2
  const end = paramAt(p, 1)!; close(end[0], 300); close(end[1], 0);
  // no tangents: a straight line
  const lin = paramAt({ value: [0, 0], keyframes: [{ t: 0, value: [0, 0] }, { t: 1, value: [300, 0] }] }, 0.5) as number[];
  assert.deepEqual(lin, [150, 0]);
  // with an ease the position along the curve follows it
  const q: Param<[number, number]> = { value: [0, 0], keyframes: [{ t: 0, value: [0, 0], ease: "ease_in", tangentOut: [100, 0] }, { t: 1, value: [300, 0], tangentIn: [-100, 0] }] };
  const u = ease("ease_in", 0.5), w = 1 - u;
  close(paramAt(q, 0.5)![0], 3 * w * w * u * 100 + 3 * w * u * u * 200 + u * u * u * 300, 1e-9);
});

test("timeMap: cleaned, linear between points, held outside (extended in handles), rate = slope", () => {
  const c = vclip({ timeMap: [{ t: 0, s: 1 }, { t: 1, s: 3 }, { t: 2, s: 3 }, { t: 4, s: 4 }] });
  close(sourceTime(c, 0), 1); close(sourceTime(c, 0.5), 2); close(sourceTime(c, 1.5), 3, 1e-9, "freeze");
  close(sourceTime(c, 3), 3.5); close(sourceTime(c, 9), 4, 1e-9, "clamped to the clip");
  close(sourceTime(c, -0.25, true), 0.5, 1e-9, "extended back along slope 2");
  close(sourceTime(c, -1, true), 0, 1e-9, "never before 0");
  close(sourceTime(c, 5, true), 4.5);
  close(sourceRate(c, 0.5), 2); close(sourceRate(c, 1.5), 0); close(sourceRate(c, 3), 0.5); close(sourceRate(c, 4.5), 0);
  // unsorted, duplicate t, decreasing s get cleaned
  const m = timeMapOf(vclip({ timeMap: [{ t: 2, s: 5 }, { t: 0, s: 2 }, { t: 1, s: 1 }, { t: 1, s: 3 }] }))!;
  assert.deepEqual(m, [{ t: 0, s: 2 }, { t: 1, s: 3 }, { t: 2, s: 5 }]);
  assert.equal(timeMapOf(vclip({ timeMap: [{ t: 0, s: 7 }] }))![0].s, 7);
  close(sourceTime(vclip({ timeMap: [{ t: 0, s: 7 }] }), 3), 7, 1e-9, "one point: a freeze");
  close(timeMapAt([{ t: 0, s: 0 }, { t: 2, s: 1 }], 1), 0.5);
  // the media length still caps it; a time map wins over reverse and speed
  close(sourceTime(vclip({ media: { url: "v.mp4", kind: "video", duration: 2 }, timeMap: [{ t: 0, s: 0 }, { t: 4, s: 8 }] }), 3), 2 - 1e-3, 1e-9);
  close(sourceTime(vclip({ reverse: true, speed: 3, timeMap: [{ t: 0, s: 1 }, { t: 4, s: 5 }] }), 1), 2);
});

test("speed 0 freezes the frame at in (rate 0); a missing / bad speed still plays at 1", () => {
  const f = vclip({ speed: 0 });
  for (const l of [0, 1, 3.9]) close(sourceTime(f, l), 1);
  assert.equal(sourceRate(f, 1), 0);
  close(sourceTime(vclip({ speed: NaN }), 2), 3);
  close(sourceTime(vclip({ speed: undefined as unknown as number }), 2), 3);
  assert.equal(sourceRate(vclip({ speed: 2 }), 1), 2);
  // through evaluate(): the clip state carries the mapped time
  const comp: Composition = { width: 64, height: 36, fps: 24, duration: 8, tracks: [{ id: "v", kind: "video", clips: [vclip({ timeMap: [{ t: 0, s: 1 }, { t: 2, s: 2 }] })] }] };
  close(evaluate(comp, 3).tracks[0].clips[0].sourceTime, 1.5);
  // nested clips use their map for the inner time
  const inner: Composition = { width: 64, height: 36, fps: 24, duration: 10, tracks: [] };
  const n: Clip = { ...vclip({ timeMap: [{ t: 0, s: 4 }, { t: 4, s: 4 }] }), type: "nested", comp: inner, media: { url: "", kind: "image" } };
  close(sourceTime(n, 2), 4);
});

test(".cube writer: parseCube(lutToCube(lut)) gives the same table", async () => {
  const { lutToCube, makeLut, parseCube } = await import("../cube.ts");
  const lut = makeLut(5, (r, g, b) => [r * 0.9 + 0.05, g * g, Math.min(1, b + 0.1)]);
  const back = parseCube(lutToCube({ ...lut, title: "Shot match" }));
  assert.equal(back.size, 5); assert.equal(back.title, "Shot match");
  for (let i = 0; i < lut.data.length; i++) close(back.data[i], lut.data[i], 1e-6);
});

test("custom source boxes: the union of the old and new box, clipped; empty when nothing is drawn", async () => {
  const { union } = await import("../sources/source.ts");
  assert.deepEqual(union([10, 10, 20, 20], [25, 5, 10, 10], 100, 100), [10, 5, 25, 25]);
  assert.deepEqual(union(null, [-5, 90, 20, 20], 100, 100), [0, 90, 15, 10]);
  assert.equal(union(null, null, 100, 100), null);
  assert.equal(union([0, 0, 0, 5], null, 100, 100), null);
});
