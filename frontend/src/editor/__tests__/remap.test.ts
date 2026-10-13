import assert from "node:assert/strict";
import { test } from "node:test";
import { clipEnd, ctxOf, handles, razor, sourceFrameAt, trimClip, updateParam } from "../model/ops.ts";
import { clipSpan, freezeInRamp, rampPieces, rampPreset, rampSpan } from "../model/remap.ts";
import { applyRampPreset, holdFrame, insertFreeze, setRamp } from "../model/retime.ts";
import { toAudioMix, toVideoComposition } from "../model/toComposition.ts";
import { sourceTime as engineSourceTime } from "../../engine/timeline.ts";
import type { Param } from "../model/types.ts";
import { A, on, project, put, seqOf, V } from "./fixtures.ts";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const ramp = (...ks: [number, number, "linear" | "hold" | "ease_in_out"][]): Param<number> => ({ value: 100, keyframes: ks.map(([frame, value, ease]) => ({ frame, value, ease })) });

test("ramp integral: constant, straight ramps and steps are exact; it holds outside the keyframes", () => {
  near(rampSpan({ value: 50 }, 0, 10), 5);
  near(rampSpan({ value: 0 }, 0, 10), 0);
  const lin = ramp([0, 100, "linear"], [10, 50, "linear"]);
  near(rampSpan(lin, 0, 10), 7.5);                 // mean of 1 and 0.5 over 10 frames
  near(rampSpan(lin, 10, 20), 5);                  // held at 50 % after the last key
  near(rampSpan(lin, -4, 0), -0 + 4, 1e-9);        // held at 100 % before frame 0 … (positive span)
  const step = ramp([0, 100, "hold"], [5, 0, "hold"], [8, 200, "hold"]);
  near(rampSpan(step, 0, 5), 5);
  near(rampSpan(step, 5, 8), 0);
  near(rampSpan(step, 8, 10), 4);
  near(rampSpan(step, 3, 9), 2 + 0 + 2);
});

test("ramp pieces meet without a jump, freezes are their own pieces, the count is bounded", () => {
  const c = { duration: 100, timeRemap: ramp([0, 100, "linear"], [40, 25, "linear"], [60, 0, "hold"], [70, 100, "linear"]) };
  const ps = rampPieces(c);
  assert.ok(ps.length <= 12, `${ps.length} pieces`);
  assert.equal(ps[0].from, 0); assert.equal(ps[ps.length - 1].to, 100);
  let off = 0;
  for (const p of ps) {
    near(p.offset, off, 1e-6);
    off += rampSpan(c.timeRemap, p.from, p.to);  // each piece starts exactly where the source is (no drift)
    if (p !== ps[ps.length - 1]) assert.equal(ps[ps.indexOf(p) + 1].from, p.to);
  }
  near(off, clipSpan(c, 0, 100), 1e-6);
  const fr = ps.filter((p) => p.freeze);
  // the frames that crawl below 2 % into the stop and the stop itself are one held frame
  assert.equal(fr.length, 1); assert.ok(fr[0].from >= 57 && fr[0].from <= 60, `${fr[0].from}`); assert.equal(fr[0].to, 70);
});

test("trim, razor and handles use the ramp's integral", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 50, out: 149 });   // 100 frames, 50 head / 100 tail
  const v = on(s, V(s, 0).id)[0];
  s = setRamp(s, ctx, [v.id], () => ramp([0, 50, "hold"]));  // half speed throughout
  const r = on(s, V(s, 0).id)[0];
  assert.ok(r.timeRemap, "the picture has the ramp");
  assert.ok(on(s, A(s, 0).id)[0].timeRemap, "the linked sound follows");
  // half speed: the clip uses 50 source frames, the tail grows to 150 source frames = 300 timeline frames
  assert.deepEqual(handles(r, s, ctx), { head: 100, tail: 300 });
  near(sourceFrameAt(r, s, ctx, 40), 50 + 20);
  s = razor(s, ctx, 40, { ids: [r.id] });
  const [l, rt] = on(s, V(s, 0).id);
  assert.equal(l.source.type === "media" && l.source.in, 50);
  assert.equal(rt.source.type === "media" && rt.source.in, 70, "the right half starts where the left one left the source");
  s = trimClip(s, ctx, rt.id, "start", 10, { linked: false });
  const t2 = on(s, V(s, 0).id).find((c) => c.start === 50)!;
  assert.equal(t2.source.type === "media" && t2.source.in, 75);
});

test("ramp presets; keep every frame changes the length and ripples, freeze inserts a hold", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "m2", 100, { in: 0, out: 49 });
  const [a] = on(s, V(s, 0).id);
  const burst = rampPreset("slowmo_burst", 100, { at: 50 });
  assert.ok(burst.keyframes!.length >= 4 && Math.min(...burst.keyframes!.map((k) => k.value)) === 30);
  // keep length: nothing moves
  const kl = applyRampPreset(s, ctx, [a.id], "slowmo_burst", 50, { fit: "length" });
  assert.deepEqual(on(kl, V(kl, 0).id).map((c) => [c.start, c.duration]), [[0, 100], [100, 50]]);
  // keep every frame: the slow part makes the clip longer and the next clip (and its sound) moves later
  const kc = applyRampPreset(s, ctx, [a.id], "slowmo_burst", 50, { fit: "content" });
  const [a2, b2] = on(kc, V(kc, 0).id);
  assert.ok(a2.duration > 120, `${a2.duration}`);
  near(clipSpan(a2, 0, a2.duration), 100, 1);
  assert.equal(b2.start, clipEnd(a2));
  assert.equal(on(kc, A(kc, 0).id)[1].start, clipEnd(a2));
  // freeze at frame 30 for 25 frames
  const fz = insertFreeze(s, ctx, a.id, 30, 25);
  const [a3, b3] = on(fz, V(fz, 0).id);
  assert.equal(a3.duration, 125); assert.equal(b3.start, 125);
  near(sourceFrameAt(a3, fz, ctx, 29), 29); near(sourceFrameAt(a3, fz, ctx, 40), 30); near(sourceFrameAt(a3, fz, ctx, 60), 35);
  const f2 = freezeInRamp(undefined, 10, 5);
  near(rampSpan(f2, 0, 20), 15);
});

test("the engine gets one clip with a time map (a frame hold is speed 0); the mix plays pieces and is silent while frozen", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 25, out: 124 });
  const v = on(s, V(s, 0).id)[0];
  s = setRamp(s, ctx, [v.id], () => ramp([0, 100, "hold"], [50, 0, "hold"], [60, 200, "hold"]));
  p.sequences = [s];
  const comp = toVideoComposition(p, s.id).comp;
  const cs = comp.tracks[0].clips;
  assert.deepEqual(cs.map((c) => c.id), [v.id], "one clip, one decoder");
  const c = cs[0], map = c.timeMap!;
  near(c.start, 0); near(c.duration, 4);
  // 1 s of source at 1× (from 1 s), a 0.4 s freeze on 3 s, then 2× on from 3 s
  for (const [t, src] of [[0, 1], [1, 2], [2, 3], [2.2, 3], [2.4, 3], [3, 4.2], [4, 6.2]]) near(engineSourceTime(c, t), src, 1e-9);
  assert.ok(map.length >= 100 && map.every((q, i) => !i || q.s >= map[i - 1].s), "a point a frame, never going back");
  // a frame hold: speed 0 on its frame
  const h = holdFrame(s, ctx, v.id, 30);
  const hc = toVideoComposition({ ...p, sequences: [h] }, h.id).comp.tracks[0].clips[0];
  assert.equal(hc.speed, 0); assert.equal(hc.timeMap, undefined); near(hc.in, 1 + 30 / 25);
  const mix = toAudioMix(p, s.id);
  const pieces = mix.clips.filter((c) => c.clipId.startsWith(on(s, A(s, 0).id)[0].id));
  assert.deepEqual(pieces.map((c) => [Math.round(c.start * 100) / 100, Math.round(c.rate * 100) / 100]), [[0, 1], [2.4, 2]]);
  near(pieces[1].in, 3);
});

test("speed ramp keyframes edit on both halves; hold frame freezes one clip on the frame at the playhead", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 10, out: 109 });
  const v = on(s, V(s, 0).id)[0];
  s = setRamp(s, ctx, [v.id], () => ({ value: 100 }));
  s = updateParam(s, ctx, v.id, "timeRemap", () => ({ value: 50 }));
  assert.equal(on(s, A(s, 0).id)[0].timeRemap?.value, 50);
  const h = holdFrame(s, ctx, v.id, 30);
  const hv = on(h, V(h, 0).id)[0];
  assert.equal(hv.source.type === "media" && hv.source.in, 10 + 15);
  assert.equal(hv.timeRemap?.value, 0);
  assert.equal(on(h, A(h, 0).id)[0].timeRemap?.value, 50, "the sound keeps playing");
});
