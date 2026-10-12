import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, motionAt, trackTransitions, walk } from "../timeline.ts";
import { fittedSize, motionRect } from "../framing.ts";
import { isAnimated, lerpValue, paramAt } from "../keyframes.ts";
import { BUILTIN_EFFECTS } from "../effects/index.ts";
import { EFFECT_GROUPS, effectSource, getEffect, glslType, listEffectInfos, paramUniforms, paramValues, passesOf, registerEffect } from "../effects/registry.ts";
import { isNativeLook, lookGlsl, NATIVE_LOOKS } from "../effects/looks.ts";
import { squareToQuad } from "../effects/transform/perspective.ts";
import { inv3 } from "../yuv.ts";
import type { Clip, Composition, Track } from "../types.ts";

const close = (a: number, b: number, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≈ ${b}`);
const clip = (id: string, start: number, duration: number, over: Partial<Clip> = {}): Clip =>
  ({ id, media: { url: `${id}.mp4`, kind: "video", width: 1920, height: 1080, duration: 60 }, start, duration, in: 10, speed: 1, fit: "contain", fx: {}, ...over });
const comp = (tracks: Track[]): Composition => ({ width: 1920, height: 1080, fps: 24, duration: 20, tracks });

test("params: keyframes in seconds or frames, eased, held, colours and arrays lerp", () => {
  const p = { value: 0, keyframes: [{ t: 1, value: 10 }, { t: 3, value: 30, ease: "hold" as const }, { t: 5, value: 50 }] };
  assert.equal(paramAt(p, 0), 10);
  assert.equal(paramAt(p, 2), 20);
  assert.equal(paramAt(p, 4), 30);
  assert.equal(paramAt(p, 9), 50);
  assert.equal(paramAt({ value: 7 }, 3), 7);
  assert.equal(paramAt(5, 3), 5);
  close(paramAt({ value: 0, keyframes: [{ frame: 0, value: 0 }, { frame: 48, value: 2 }] }, 1, 24) as number, 1);
  assert.deepEqual(lerpValue([0, 10], [10, 30], 0.5), [5, 20]);
  assert.equal(lerpValue("#000000", "#ffffff", 0.5), "#808080");
  assert.ok(isAnimated(p) && !isAnimated({ value: 1 }));
});

test("motion: Premiere's position / anchor / scale / rotation, % opacity", () => {
  const m = motionAt({ position: { value: [960, 540] }, scale: { value: 50 }, opacity: { value: 0, keyframes: [{ t: 0, value: 0 }, { t: 2, value: 100 }] } }, 1, 24);
  assert.equal(m.scale, 50);
  close(m.opacity, 0.5);
  // a 1280×720 picture contained in 1920×1080 fills it at 100 %
  assert.deepEqual(fittedSize(1280, 720, 1920, 1080, "contain"), [1920, 1080]);
  const r = motionRect({ scale: 50, rotation: 0, opacity: 1 }, 1280, 720, 1920, 1080, "contain");
  assert.deepEqual([r.cx, r.cy, r.w, r.h], [960, 540, 960, 540]);
  // the anchor at the picture's top-left corner, placed at the frame centre: the picture hangs right / down of it
  const a = motionRect({ scale: 100, rotation: 0, opacity: 1, position: [960, 540], anchor: [0, 0] }, 1280, 720, 1920, 1080, "contain");
  assert.deepEqual([a.cx, a.cy], [1920, 1080]);
  // turned 90° clockwise about that anchor: the centre swings down-left
  const t = motionRect({ scale: 100, rotation: 90, opacity: 1, position: [960, 540], anchor: [0, 0] }, 1280, 720, 1920, 1080, "contain");
  close(t.cx, 960 - 540); close(t.cy, 540 + 960);
  // a half-size render: positions scale with `unit`
  const h = motionRect({ scale: 100, rotation: 0, opacity: 1, position: [480, 270] }, 1920, 1080, 960, 540, "contain", 0.5);
  assert.deepEqual([h.cx, h.cy, h.w, h.h], [240, 135, 960, 540]);
});

test("track transitions: alignment, explicit start, edges, handles", () => {
  const a = clip("a", 0, 4), b = clip("b", 4, 4);
  const tk = (alignment?: "center" | "start" | "end"): Track => ({ id: "v1", kind: "video", clips: [a, b], transitions: [{ type: "fade", at: 4, duration: 1, alignment, from: "a", to: "b" }] });
  assert.deepEqual(trackTransitions(tk()).map((r) => [r.x0, r.x1]), [[3.5, 4.5]]);
  assert.deepEqual(trackTransitions(tk("start")).map((r) => [r.x0, r.x1]), [[4, 5]]);
  assert.deepEqual(trackTransitions(tk("end")).map((r) => [r.x0, r.x1]), [[3, 4]]);
  // centred: both clips run into their handles (a past its end, b before its start)
  const fs = evaluate(comp([tk()]), 4.25);
  const tr = fs.tracks[0].transition!;
  close(tr.progress, 0.75);
  close(tr.from!.sourceTime, 10 + 4.25);   // a's tail handle
  close(tr.to!.sourceTime, 10 + 0.25);
  close(evaluate(comp([tk()]), 3.75).tracks[0].transition!.to!.sourceTime, 10 - 0.25);  // b's head handle
  assert.deepEqual(fs.tracks[0].items.map((i) => i.kind), ["transition"]);
  // an edge: b fades from nothing at its start
  const edge: Track = { id: "v2", kind: "video", clips: [b], transitions: [{ type: "fade", at: 4, duration: 1, alignment: "start", to: "b" }] };
  const e = evaluate(comp([edge]), 4.5).tracks[0].transition!;
  assert.equal(e.from, null);
  assert.equal(e.to!.clip.id, "b");
  close(e.progress, 0.5);
  // outside the transition: the plain clip
  assert.deepEqual(evaluate(comp([tk()]), 6).tracks[0].items.map((i) => (i.kind === "clip" ? i.cs.clip.id : "t")), ["b"]);
});

test("generic tracks: motion keyframes, fades as alpha, hidden tracks, nested comps at their own time", () => {
  const inner = comp([{ id: "n1", kind: "video", clips: [clip("x", 0, 10, { in: 0 })] }]);
  const nest = clip("nest", 2, 4, { type: "nested", comp: inner, in: 3, media: { url: "", kind: "image" } });
  const moving = clip("m", 0, 8, { motion: { position: { value: [0, 0], keyframes: [{ t: 0, value: [0, 0] }, { t: 2, value: [100, 200] }] } }, fx: { fade_in: 2 } });
  const c = comp([{ id: "v1", kind: "video", clips: [moving] }, { id: "v2", kind: "video", clips: [nest] }, { id: "v3", kind: "video", hidden: true, clips: [clip("h", 0, 8)] }]);
  const fs = evaluate(c, 1);
  assert.equal(fs.tracks.length, 2);
  const m = fs.tracks[0].clips[0].motion!;
  assert.deepEqual(m.position, [50, 100]);
  close(m.opacity, 0.5);   // fade in: alpha on a video track
  const fs3 = evaluate(c, 3);
  const n = fs3.tracks[1].clips[0];
  close(n.sourceTime, 4);  // in 3 + 1 s
  assert.equal(n.nested!.tracks[0].clips[0].clip.id, "x");
  close(n.nested!.tracks[0].clips[0].sourceTime, 4);
  const seen: string[] = [];
  walk(fs3, (cs, path) => seen.push(path + cs.clip.id));
  assert.deepEqual(seen, ["m", "nest", "nest/x"]);
});

test("effect registry: 67 built-ins in eight groups, valid params, GLSL wrapped with its uniforms", () => {
  const infos = listEffectInfos();
  assert.ok(infos.length >= 67, `${infos.length}`);
  assert.equal(new Set(BUILTIN_EFFECTS.map((d) => d.id)).size, BUILTIN_EFFECTS.length);
  for (const g of EFFECT_GROUPS) assert.ok(infos.some((e) => e.group === g), g);
  // the editor's legacy ids map onto built-ins
  for (const id of ["look", "adjust", "wheels", "curves", "chroma", "mask", "glow", "flip", "move"]) assert.ok(getEffect(id), id);
  for (const d of BUILTIN_EFFECTS) {
    assert.ok(d.render || passesOf(d).length, d.id);
    for (const p of d.params) assert.ok(p.label && p.default !== undefined, `${d.id}.${p.name}`);
    for (const pass of passesOf(d)) {
      const src = effectSource(d, pass.glsl);
      assert.match(src, /vec4 effect\(vec2 uv\)/, d.id);
      for (const p of d.params) if (glslType(p.type)) assert.match(src, new RegExp(`uniform\\s+\\w+\\s+${p.name}\\b`), `${d.id}: ${p.name} declared`);
    }
    if (d.license === "MIT") assert.ok(d.author && d.source, `${d.id} credits its source`);
  }
});

test("effect params: defaults, keyframes, enum / colour / vec uniforms; custom registration", () => {
  const def = getEffect("glitch")!;
  const v = paramValues(def, { type: "glitch", params: { offset: { value: 0, keyframes: [{ t: 0, value: 0 }, { t: 2, value: 200 }] }, fillMode: 2 } }, 1, 24);
  assert.equal(v.offset, 100);
  assert.equal(v.slices, 8);
  const u = paramUniforms(def, v);
  assert.equal(u.fillMode, 2);
  assert.equal(paramUniforms(def, { ...v, fillMode: "4" }).fillMode, 4);
  assert.deepEqual(u.red, [-6, 0]);
  const look = getEffect("look")!;
  assert.equal(paramUniforms(look, paramValues(look, { type: "look", params: { look: "teal_orange" } }, 0, 24)).look, 2);
  const ov = getEffect("color_overlay")!;
  const cu = paramUniforms(ov, paramValues(ov, { type: "color_overlay", params: { color: "#ff0000" } }, 0, 24));
  assert.deepEqual(cu.color, [1, 0, 0]);
  registerEffect({ id: "test.invert", label: "Invert", group: "Colour", params: [{ name: "amount", label: "Amount", type: "float", default: 1 }],
    glsl: "vec4 effect(vec2 uv) { vec4 c = getColor(uv); return vec4(mix(c.rgb, 1.0 - c.rgb, amount), c.a); }", custom: true });
  assert.ok(listEffectInfos().find((e) => e.id === "test.invert")?.custom);
  assert.throws(() => registerEffect({ id: "bad id!", label: "x", group: "Colour", params: [], glsl: "" }));
});

test("native looks: the server's eq / colorbalance / vibrance / hue / mixer / negate presets as GLSL", () => {
  for (const id of ["cinematic", "teal_orange", "warm", "golden_hour", "cool", "moonlight", "vivid", "bleach_bypass", "noir", "black_white", "sepia", "negative"]) {
    assert.ok(isNativeLook(id), id);
    const g = lookGlsl(NATIVE_LOOKS[id]);
    assert.match(g, /^vec3 nativeLook\(vec3 c\) \{/);
  }
  for (const id of ["pastel", "vintage", "faded_film", "cross_process", "high_contrast", "matte", "lut:abc"]) assert.ok(!isNativeLook(id), id);
  assert.match(lookGlsl(NATIVE_LOOKS.teal_orange), /nlCb\(c, vec3\(-0\.12, -0\.02, 0\.14\), vec3\(0\.0, 0\.0, 0\.0\), vec3\(0\.12, 0\.02, -0\.12\)\);\n {2}c = nlEq\(c, vec4\(0\.0, 1\.1, 1\.0, 1\.08\)/);
});

test("perspective: the square → quad homography and its inverse", () => {
  const q = [0.1, 0.05, 0.9, 0.0, 1.0, 1.0, 0.0, 0.9];
  const m = squareToQuad(q);  // column-major
  const ap = (M: number[], x: number, y: number) => { const w = M[2] * x + M[5] * y + M[8]; return [(M[0] * x + M[3] * y + M[6]) / w, (M[1] * x + M[4] * y + M[7]) / w]; };
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([x, y], i) => { const p = ap(m, x, y); close(p[0], q[2 * i], 1e-9); close(p[1], q[2 * i + 1], 1e-9); });
  const inv = inv3(m);
  const back = ap(inv, ...(ap(m, 0.3, 0.6) as [number, number]));
  close(back[0], 0.3, 1e-9); close(back[1], 0.6, 1e-9);
});
