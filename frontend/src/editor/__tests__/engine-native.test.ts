import assert from "node:assert/strict";
import { test } from "node:test";
import { paramAt } from "../../engine/keyframes.ts";
import { sourceTime } from "../../engine/timeline.ts";
import type { Clip } from "../../engine/types.ts";
import { valueAt } from "../model/params.ts";
import { clipSpan, rampPieces } from "../model/remap.ts";
import { framesToSeconds } from "../model/time.ts";
import { bakeKeys, engineParam, rampTimeMap, toVideoComposition } from "../model/toComposition.ts";
import { ctxOf } from "../model/ops.ts";
import { setRamp } from "../model/retime.ts";
import { on, project, put, seqOf, V } from "./fixtures.ts";
import type { Param, TimelineClip } from "../model/types.ts";

const FPS = 25;
const near = (a: number, b: number, eps: number, what: string) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} ≉ ${b}`);
/** What the engine used to get: the model's curve baked into straight per-frame keys. */
const baked = <T>(p: Param<T>) => ({ value: p.value, keyframes: bakeKeys(p).map((k) => ({ t: framesToSeconds(k.frame, FPS), frame: k.frame, value: k.value, ease: k.ease })) });
const num = (v: unknown, j: number) => (Array.isArray(v) ? Number(v[j]) : Number(v));

/** At every frame (and a few outside the keys) the native keys draw what the baked ones did, and what the model says. */
function same<T>(p: Param<T>, from: number, to: number, what: string) {
  const old = baked(p), now = engineParam(p, FPS);
  const n = Array.isArray(p.value) ? (p.value as unknown[]).length : 1;
  for (let f = from; f <= to; f++) {
    const t = framesToSeconds(f, FPS);
    const a = paramAt(old as never, t, FPS), b = paramAt(now as never, t, FPS), m = valueAt(p, f);
    for (let j = 0; j < n; j++) { near(num(b, j), num(a, j), 1e-3, `${what} @${f}`); near(num(b, j), num(m, j), 1e-3, `${what} model @${f}`); }
  }
}

test("native bezier, bounce, elastic and hold keys draw what the baked keys did (within 1e-3 at every frame)", () => {
  const scalar: Param<number> = { value: 0, keyframes: [
    { frame: 0, value: 10, ease: "bezier", out: [0.34, 1.56] },          // back: overshoots
    { frame: 30, value: 60, ease: "bounce", in: [0.64, 1] },
    { frame: 55, value: 20, ease: "elastic" },
    { frame: 80, value: 90, ease: "hold" },
    { frame: 95, value: 40, ease: "bezier", out: [0.333, 0] },           // easy ease into the next key's `in`
    { frame: 120, value: 70, ease: "ease_in_out", in: [0.667, 1] },
    { frame: 140, value: 5, ease: "linear" },
  ] };
  same(scalar, -5, 150, "scalar");
});

test("motion-path tangents pass through natively (one-sided ones get the model's straight third)", () => {
  const pos: Param<[number, number]> = { value: [960, 540], keyframes: [
    { frame: 0, value: [520, 760], ease: "linear", tangentOut: [120, -320] },                           // only this side
    { frame: 40, value: [1120, 360], ease: "bezier", out: [0.333, 0], tangentIn: [-260, -60], tangentOut: [260, 60] },
    { frame: 80, value: [1400, 760], ease: "bezier", in: [0.667, 1], out: [0.34, 1.56], tangentIn: [40, -300] }, // an overshooting ease on a curve
    { frame: 110, value: [600, 300], ease: "hold", in: [0.64, 1], tangentOut: [0, 50] },
    { frame: 130, value: [200, 200], ease: "linear", tangentIn: [10, 10] },
  ] };
  same(pos, -3, 140, "position");
  const ks = engineParam(pos, FPS).keyframes!;
  assert.deepEqual(ks[1].tangentIn, [-260, -60]);
  assert.deepEqual(ks[1].out, [0.333, 0]);
  assert.deepEqual(ks[0].tangentOut, [120, -320]);
  assert.deepEqual(ks[1].tangentOut, [260, 60]);
});

const clipWith = (timeRemap: Param<number>, duration: number): TimelineClip => ({
  id: "c", trackId: "v", start: 0, duration, source: { type: "media", mediaId: "m", in: 25 }, speed: 1, reverse: false, enabled: true, name: "c",
  motion: { position: { value: [960, 540] }, scale: { value: 100 }, rotation: { value: 0 }, anchor: { value: [960, 540] }, opacity: { value: 100 }, blend: "normal", uniformScale: true },
  effects: [], timeRemap,
});
const engineClip = (c: TimelineClip, extra: Partial<Clip>): Clip => ({ id: c.id, media: { url: "x.mp4", kind: "video" }, start: 0, duration: framesToSeconds(c.duration, FPS), in: 1, speed: 1, fit: "contain", fx: {}, ...extra });

test("a ramp's time map matches the model's integral at every frame, and the old constant-speed pieces where those were exact", () => {
  const curved = clipWith({ value: 100, keyframes: [{ frame: 10, value: 100, ease: "ease_in_out" }, { frame: 40, value: 25, ease: "linear" }, { frame: 70, value: 25, ease: "bezier", out: [0.4, 0] }, { frame: 90, value: 180, ease: "linear", in: [0.6, 1] }] }, 120);
  const map = rampTimeMap(curved, 1, FPS);
  const ec = engineClip(curved, { timeMap: map });
  for (let f = 0; f < 120; f++) near(sourceTime(ec, framesToSeconds(f, FPS)), 1 + clipSpan(curved, 0, f) / FPS, 1e-3, `curved @${f}`);
  // steps (hold keys): the old pieces were exact there, and the time map gives the same
  const steps = clipWith({ value: 100, keyframes: [{ frame: 0, value: 100, ease: "hold" }, { frame: 30, value: 0, ease: "hold" }, { frame: 45, value: 250, ease: "hold" }, { frame: 70, value: 50, ease: "hold" }] }, 100);
  const sc = engineClip(steps, { timeMap: rampTimeMap(steps, 1, FPS) });
  const pieces = rampPieces(steps);
  for (let f = 0; f < 100; f++) {
    const pc = pieces.find((x) => x.from <= f && f < x.to)!;
    const old = 1 + (pc.offset + (pc.freeze ? 0 : (f - pc.from) * pc.speed)) / FPS;
    near(sourceTime(sc, framesToSeconds(f, FPS)), old, 1e-3, `steps @${f}`);
  }
  // a frame hold is speed 0 on `in`
  near(sourceTime(engineClip(steps, { speed: 0, in: 2.5 }), 1.3), 2.5, 1e-9, "freeze");
});

test("an export range that starts inside a ramp keeps the ramp's source times", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 25, out: 124 });
  const v = on(s, V(s, 0).id)[0];
  s = setRamp(s, ctx, [v.id], () => ({ value: 100, keyframes: [{ frame: 0, value: 100, ease: "linear" }, { frame: 60, value: 30, ease: "linear" }] }));
  const c = on(s, V(s, 0).id)[0];
  const comp = toVideoComposition({ ...p, sequences: [s] }, s.id, { range: [20, 90] }).comp;
  const ec = comp.tracks[0].clips[0];
  for (const f of [0, 10, 40, 69]) near(sourceTime(ec, framesToSeconds(f, FPS)), 1 + clipSpan(c, 0, f + 20) / FPS, 1e-3, `range @${f}`);
});
