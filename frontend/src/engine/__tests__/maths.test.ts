import assert from "node:assert/strict";
import { test } from "node:test";
import { ease } from "../easing.ts";
import { sample, transformAt } from "../keyframes.ts";
import { bakeCurves, cleanPoints, curveTable, monotone } from "../curves.ts";
import { CubeError, lookup, makeLut, parseCube } from "../cube.ts";
import { cameraAt, clipUv, coverRect, layerRect } from "../framing.ts";
import type { Clip } from "../types.ts";

const close = (a: number, b: number, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≈ ${b}`);

test("easing: ends fixed, cubic shapes, clamped", () => {
  for (const k of ["linear", "ease_in", "ease_out", "ease_in_out"]) {
    close(ease(k, 0), 0); close(ease(k, 1), 1); close(ease(k, -1), 0); close(ease(k, 2), 1);
  }
  close(ease("linear", 0.3), 0.3);
  close(ease("ease_in", 0.5), 0.125);
  close(ease("ease_out", 0.5), 0.875);
  close(ease("ease_in_out", 0.5), 0.5);
  close(ease("ease_in_out", 0.25), 0.0625);
  close(ease(undefined, 0.4), 0.4);
});

test("keyframes: held before / after, linear between, base without keyframes (layers.py sample)", () => {
  const kfs = [{ t: 1, x: 0.2 }, { t: 3, x: 0.6, scale: 0.5 }, { t: 5, x: 1 }];
  assert.equal(sample(kfs, "x", 0.5, 0), 0.2);
  close(sample(kfs, "x", 0.5, 2), 0.4);
  close(sample(kfs, "x", 0.5, 4), 0.8);
  assert.equal(sample(kfs, "x", 0.5, 9), 1);
  assert.equal(sample(kfs, "scale", 0.35, 0), 0.5);  // one keyframe: held everywhere
  assert.equal(sample(kfs, "opacity", 0.7, 2), 0.7);
  assert.equal(sample([{ t: 1, x: 0 }, { t: 1, x: 1 }], "x", 0, 1), 0);
  assert.equal(sample([{ t: 1, x: 0 }, { t: 1, x: 1 }], "x", 0, 1.5), 1);
  close(sample([{ t: 0, x: 0, easing: "ease_in" }, { t: 2, x: 1 }], "x", 0, 1), 0.125);
  const s = transformAt({ x: 0.1, scale: 0.2, keyframes: [{ t: 0, y: 0 }, { t: 2, y: 1 }] }, 1);
  assert.deepEqual(s, { x: 0.1, y: 0.5, scale: 0.2, opacity: 1, rotation: 0 });
});

test("curves: identity, through the points, monotone, flat outside, cleaned", () => {
  const id = curveTable(undefined);
  close(id[0], 0); close(id[128], 128 / 255); close(id[255], 1);
  const pts: [number, number][] = [[0, 0.1], [0.5, 0.6], [1, 0.9]];
  const f = monotone(pts);
  for (const [x, y] of pts) close(f(x), y, 1e-9);
  let prev = -1;
  for (let i = 0; i <= 100; i++) { const y = f(i / 100); assert.ok(y >= prev - 1e-12); prev = y; }
  const g = monotone([[0.2, 0.3], [0.8, 0.7]]);
  assert.equal(g(0), 0.3); assert.equal(g(1), 0.7);
  // no overshoot on a step-like curve
  const h = monotone([[0, 0], [0.4, 0], [0.6, 1], [1, 1]]);
  for (let i = 0; i <= 100; i++) { const y = h(i / 100); assert.ok(y >= 0 && y <= 1); }
  assert.equal(cleanPoints([[0.5, 2], [0.1, 0.2]])?.[1][1], 1);
  assert.equal(cleanPoints([[0.5, 0.5]]), null);
  assert.equal(cleanPoints("x"), null);
  const t = bakeCurves({ master: [[0, 0], [1, 0.5]], r: [[0, 1], [1, 1]] });
  close(t[255 * 4 + 0], 0.5); close(t[255 * 4 + 1], 0.5); close(t[0], 0.5); close(t[3], 1);
});

test(".cube: parses size, domain, comments, title; red fastest; validates", () => {
  const txt = `# made by hand
TITLE "Test"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;
  const l = parseCube(txt);
  assert.equal(l.size, 2); assert.equal(l.title, "Test");
  assert.deepEqual([...l.data.slice(3, 6)], [1, 0, 0]);
  assert.deepEqual(lookup(l, [0.25, 0.5, 0.75]).map((v) => Math.round(v * 1000) / 1000), [0.25, 0.5, 0.75]);
  assert.throws(() => parseCube("LUT_1D_SIZE 4\n0 0 0"), CubeError);
  assert.throws(() => parseCube("LUT_3D_SIZE 2\n0 0 0\n"), /Expected 8 rows/);
  assert.throws(() => parseCube("0 0 0"), /before LUT_3D_SIZE/);
  assert.throws(() => parseCube("LUT_3D_SIZE 1"), /out of range/);
  assert.throws(() => parseCube("LUT_3D_SIZE 2\n" + "0 0 x\n".repeat(8)), /isn't a number/);
  const inv = makeLut(17, (r, g, b) => [1 - r, 1 - g, 1 - b]);
  assert.deepEqual(lookup(inv, [0.2, 0.4, 1]).map((v) => Math.round(v * 1e6) / 1e6), [0.8, 0.6, 0]);
  const half = parseCube("LUT_3D_SIZE 2\nDOMAIN_MAX 2 2 2\n" + "0 0 0\n2 0 0\n0 2 0\n2 2 0\n0 0 2\n2 0 2\n0 2 2\n2 2 2\n");
  assert.deepEqual(half.domainMax, [2, 2, 2]);
});

const clip = (over: Partial<Clip> = {}): Clip => ({ id: "c", media: { url: "", kind: "video" }, start: 0, duration: 4, in: 0, speed: 1, fit: "cover", fx: {}, ...over });

test("cover crop like ffmpeg.fit_filter, with and without the face aim", () => {
  // 16:9 source into 9:16: cover scales by height, shows 0.316 of the width
  const r = coverRect(1920, 1080, 1080, 1920);
  close(r.fh, 1); close(r.fw, (1080 / 1920) * (1080 / 1920), 1e-9);
  close(r.x0, (1 - r.fw) / 2);
  // aim: x = max(0, min(iw - ow, iw·cx - ow/2)) in source fractions
  close(coverRect(1920, 1080, 1080, 1920, [0.8, 0.5]).x0, 0.8 - r.fw / 2);
  close(coverRect(1920, 1080, 1080, 1920, [0.99, 0.5]).x0, 1 - r.fw);
  close(coverRect(1920, 1080, 1080, 1920, [0, 0.5]).x0, 0);
  // same aspect: the whole picture
  assert.deepEqual(coverRect(3840, 2160, 1920, 1080), { x0: 0, y0: 0, fw: 1, fh: 1 });
});

test("camera: zoompan maths of fx.move_filter and the still push-in", () => {
  const fps = 24;
  const zi = clip({ move: { kind: "zoom_in", amount: 0.2 }, duration: 2 });
  const n = 48;
  close(cameraAt(zi, 0, fps).z, 1);
  close(cameraAt(zi, 1, fps).z, 1 + 0.2 * (24 / n));
  close(cameraAt(zi, 5, fps).z, 1.2);
  const c = cameraAt(zi, 1, fps);
  close(c.ox, 0.5 - 0.5 / c.z);  // iw/2 - iw/zoom/2
  const zo = cameraAt(clip({ move: { kind: "zoom_out", amount: 0.2 }, duration: 2 }), 0, fps);
  close(zo.z, 1.2);
  const pl = clip({ move: { kind: "pan_left", amount: 0.25 }, duration: 2 });
  close(cameraAt(pl, 0, fps).ox, 1 - 1 / 1.25);  // (iw - iw/zoom)·(1 - p)
  close(cameraAt(pl, 2, fps).ox, 0);
  close(cameraAt(pl, 1, fps).oy, 0.5 - 0.5 / 1.25);
  const pd = clip({ move: { kind: "pan_down", amount: 0.25 }, duration: 2 });
  close(cameraAt(pd, 1, fps).oy, (1 - 1 / 1.25) * 0.5);
  const kb = clip({ kenburns: true, media: { url: "", kind: "image" } });
  close(cameraAt(kb, 1, fps).z, 1 + 0.0009 * 24);
  close(cameraAt(kb, 60, fps).z, 1.12);
  close(cameraAt(clip(), 1, fps).z, 1);
});

test("clip uv: cover then camera then flips", () => {
  const u = clipUv(clip({ fx: { flip_h: true } }), 1920, 1080, 1920, 1080, 0, 24);
  close(u.sx, -1); close(u.ox, 1); close(u.sy, 1); close(u.oy, 0);
  const z = clipUv(clip({ move: { kind: "zoom_in", amount: 0.5 }, duration: 1 }), 1920, 1080, 1920, 1080, 10, 24);
  close(z.sx, 1 / 1.5); close(z.ox, 0.5 - 0.5 / 1.5);
  // output (0.5, 0.5) always maps to the crop centre without a pan
  const v = clipUv(clip({ center: [0.7, 0.5] }), 1920, 1080, 1080, 1920, 0, 24);
  const r = coverRect(1920, 1080, 1080, 1920, [0.7, 0.5]);
  close(0.5 * v.sx + v.ox, r.x0 + r.fw / 2);
  // contain: the picture sits in the middle, letterboxed
  const c = clipUv(clip({ fit: "contain" }), 1080, 1920, 1920, 1080, 0, 24);
  close(0.5 * c.sx + c.ox, 0.5); assert.ok(0 * c.sx + c.ox < 0);
});

test("layer rect: centre, even width from scale, height from aspect, degrees → radians", () => {
  const r = layerRect({ x: 0.25, y: 0.75, scale: 0.35, opacity: 1, rotation: 90 }, 1920, 1080, 9 / 16);
  assert.equal(r.cx, 480); assert.equal(r.cy, 810); assert.equal(r.w, 672); close(r.h, 378); close(r.rot, Math.PI / 2);
});

test("frand: FFmpeg xfade's float32 noise", async () => {
  const { frand, frandRows } = await import("../frand.ts");
  assert.equal(frand(0, 0), 0);
  for (let i = 0; i < 50; i++) { const v = frand(i, 3 * i); assert.ok(v >= 0 && v < 1); }
  const rows = frandRows(8);
  assert.equal(rows.length, 16); assert.equal(rows[3], frand(0, 3)); assert.equal(rows[8 + 3], frand(3, 0));
  // correctly rounded sinf, which matches FFmpeg 7.1's dissolve bit for bit (fract quantised to 1/256 at this size)
  assert.equal(frand(1, 0), 241 / 256); assert.equal(frand(2, 0), 22 / 256); assert.equal(frand(3, 0), 151 / 256);
});

test("adjust params: fx.py adjust_filters numbers, eq's integer path", async () => {
  const { adjustParams, eqInt, fxPlan, gblurNu, gblurWeights } = await import("../effects/params.ts");
  const a = adjustParams({ exposure: 0.6, contrast: 0.5, saturation: -0.3, gamma: 0.2, temperature: 0.4, tint: -0.2, vibrance: 0.5, hue: 0.25,
    sharpen: 0.4, blur: 0.5, vignette: 0.5, grain: 0.55 });
  assert.deepEqual(a.eq, { brightness: 0.15, contrast: 1.3, gamma: 1.1, saturation: 0.7, luma: true, chroma: true });
  assert.deepEqual(a.cb, [0.06, 0.03, -0.06]);
  assert.equal(a.vibrance, 0.3); assert.equal(a.hue, 45); assert.equal(a.sharpen, 0.6); assert.equal(a.blur, 4); assert.equal(a.vignette, 0.7); assert.equal(a.grain, 22);
  assert.deepEqual(adjustParams({ saturation: 0.5 }).eq, { brightness: 0, contrast: 1, gamma: 1, saturation: 1.5, luma: false, chroma: true });
  // measured with FFmpeg 7.1: contrast 1.3 maps Y 93 to 81, brightness 0.1 maps 93 to 118, saturation 1.5 / 0.5 map U 147 to 155, V 112 to 119
  const run = ([k, off]: [number, number], v: number) => Math.floor((v * k) / 4096) + off;
  assert.equal(run(eqInt(1.3, 0), 93), 81); assert.equal(run(eqInt(1, 0.1), 93), 118); assert.equal(run(eqInt(1.5, 0), 147), 155); assert.equal(run(eqInt(0.5, 0), 112), 119);
  assert.equal(run(eqInt(1, -0.15), 93), 51); assert.equal(run(eqInt(1, 0.15), 93), 130); assert.equal(run(eqInt(1, -0.15), 181), 139);
  assert.ok(Math.abs(gblurNu(1) - 0.2679) < 1e-3);
  const w = gblurWeights(8);
  assert.ok(Math.abs(w[0] + 2 * w.slice(1).reduce((s, x) => s + x, 0) - 1) < 1e-9);
  const p = fxPlan({ adjust: { blur: 0.2 }, glow: { amount: 0.5, threshold: 0.7, radius: 0.3 } }, false);
  assert.ok(p.neighbourhood && p.glow && !p.point);
  assert.ok(!fxPlan({}, false).any);
});
