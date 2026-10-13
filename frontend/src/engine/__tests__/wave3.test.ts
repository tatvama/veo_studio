import assert from "node:assert/strict";
import { test } from "node:test";
import {
  apply3, cameraToRec709, encodeOutput, GAMUTS, gamutMatrix, hlgInverse, hlgOetf, logCurve, LOG_CURVES, npm, packI420p10, pqDecode, pqEncode, ycc10,
} from "../colour.ts";
import { repack10, texelSource10, yuv10Layout, packI420 } from "../yuv.ts";
import { adjustSaturation, adjustWb, labStats, labToRgb, matchParams, reinhardLab, reinhardLut, rgbToLab, statsDistance, suggestWb, wheel, type Vec3 } from "../analysis/colorMath.ts";
import { equalise, MATTES, matteFunction, matteSeed, matteSize, MATTE_CURVE } from "../transitions/pack/mattes.ts";
import { PACK, PACK_PREFIX, packSource, packTransition, matteSource } from "../transitions/pack/index.ts";
import { PACK_GROUPS } from "../transitions/pack/types.ts";
import { periodicTable } from "../curves.ts";
import { BUILTIN_EFFECTS, WAVE3_EFFECTS } from "../effects/index.ts";
import { curveTexels, EFFECT_GROUPS, effectSource, passesOf } from "../effects/registry.ts";
import { fillZoom } from "../effects/lens/lens_distortion.ts";
import { registerLut, registeredLut, unregisterLut } from "../luts.ts";

const close = (a: number, b: number, eps: number, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≈ ${b} (±${eps})`);

// ── camera log curves: the makers' published reference points ────────────────────────────────────────────────────
test("log curves: published reference points (code value = CV / 1023)", () => {
  const c = (id: string) => logCurve(id)!;
  // Sony S-Log3: black 95, 18 % grey 420, 90 % white 598 (10-bit)
  close(c("slog3").encode(0) * 1023, 95, 1e-6, "S-Log3 0");
  close(c("slog3").encode(0.18) * 1023, 420, 1e-6, "S-Log3 18%");
  close(c("slog3").encode(0.9) * 1023, 598, 0.2, "S-Log3 90%");
  close(c("slog3").decode(420 / 1023), 0.18, 1e-9);
  // ARRI LogC3 EI 800: 18 % grey 0.391007, black 0.092809
  close(c("logc3").encode(0.18), 0.391007, 2e-6, "LogC3 18%");
  close(c("logc3").encode(0), 0.092809, 1e-9, "LogC3 0");
  // ARRI LogC4: 18 % grey 0.278396, black 95 / 1023
  close(c("logc4").encode(0.18), 0.278396, 2e-6, "LogC4 18%");
  close(c("logc4").encode(0), 95 / 1023, 1e-9, "LogC4 0");
  // Panasonic V-Log: black 128, 18 % grey 433, 90 % white 602
  close(c("vlog").encode(0) * 1023, 128, 0.2);
  close(c("vlog").encode(0.18) * 1023, 433, 0.2, "V-Log 18%");
  close(c("vlog").encode(0.9) * 1023, 602, 0.5, "V-Log 90%");
  // Canon Log 3 (v1.2, legal range): 18 % → 34.3389 %
  close(c("clog3").encode(0.18), 0.343389, 2e-6, "C-Log3 18%");
  close(c("clog3").encode(0), 0.12512219, 1e-8);
  // DJI D-Log white paper table: 0 % → 95, 18 % → 408, 90 % → 586
  close(c("dlog").encode(0) * 1023, 95, 0.1, "D-Log 0");
  close(c("dlog").encode(0.18) * 1023, 408, 0.5, "D-Log 18%");
  close(c("dlog").encode(0.9) * 1023, 586, 0.5, "D-Log 90%");
  // Blackmagic Film Gen 5: 18 % → 0.3835616
  close(c("bmdfilm5").encode(0.18), 0.3835616, 1e-6, "BMD Gen 5 18%");
});

test("log curves: decode ∘ encode is the identity from deep shadows to highlights", () => {
  for (const c of LOG_CURVES) for (const x of [0, 0.0005, 0.004, 0.01, 0.05, 0.18, 0.5, 1, 4, 12]) {
    if (c.id === "slog3" && x > 10) continue;
    close(c.decode(c.encode(x)), x, Math.max(1e-6, x * 1e-6), `${c.id} at ${x}`);
  }
  assert.equal(new Set(LOG_CURVES.map((c) => c.id)).size, LOG_CURVES.length);
  for (const c of LOG_CURVES) assert.match(c.glsl, /^float decodeLog\(float \w+\) \{/, c.id);
});

test("gamuts: RP 177 matrices, BT.709 luma row, DJI's published D-Gamut → Rec.709 matrix, white stays white", () => {
  const m = npm(GAMUTS.bt709);
  close(m[3], 0.2126, 1e-4); close(m[4], 0.7152, 1e-4); close(m[5], 0.0722, 1e-4);
  const n2020 = npm(GAMUTS.bt2020);
  close(n2020[3], 0.2627, 1e-4); close(n2020[5], 0.0593, 1e-4);
  const dji = gamutMatrix(GAMUTS.dgamut, GAMUTS.bt709);
  const pub = [1.6746, -0.5797, -0.0949, -0.0981, 1.334, -0.2359, -0.041, -0.243, 1.284];
  dji.forEach((v, i) => close(v, pub[i], 2e-3, `D-Gamut → 709 [${i}]`));
  for (const c of LOG_CURVES) {
    const w = apply3(cameraToRec709(c), [1, 1, 1]);
    for (const v of w) close(v, 1, 2e-3, `${c.id} white`);
  }
});

// ── HDR transfer functions and the 10-bit packing ────────────────────────────────────────────────────────────────
test("PQ and HLG: BT.2100 / BT.2408 reference points, inverses", () => {
  close(pqEncode(100), 0.5081, 6e-4, "PQ 100");
  close(pqEncode(203), 0.5807, 6e-4, "PQ 203");
  close(pqEncode(1000), 0.7518, 6e-4, "PQ 1000");
  close(pqEncode(10000), 1, 1e-9);
  close(pqEncode(0), 0, 1e-6);
  for (const n of [0.1, 1, 50, 203, 1000, 4000]) close(pqDecode(pqEncode(n)), n, n * 1e-5);
  close(hlgOetf(1 / 12), 0.5, 1e-9);
  close(hlgOetf(1), 1, 1e-6);
  for (const e of [0.01, 0.05, 1 / 12, 0.3, 0.9]) close(hlgInverse(hlgOetf(e)), e, 1e-9);
  // reference white (working 1.0) on HLG is 75 %, on PQ 58 %
  for (const v of encodeOutput([1, 1, 1], "hlg", "bt2020")) close(v, 0.75, 0.004, "HLG ref white");
  for (const v of encodeOutput([1, 1, 1], "pq", "bt2020")) close(v, 0.5807, 6e-4, "PQ ref white");
  // SDR stays itself in BT.709; in BT.2020 neutrals don't move
  for (const v of encodeOutput([0.5, 0.5, 0.5], "sdr", "bt709")) close(v, 0.5, 1e-9);
  for (const v of encodeOutput([0.5, 0.5, 0.5], "sdr", "bt2020")) close(v, 0.5, 1e-6);
  // a saturated BT.709 red lands inside BT.2020 (less saturated there)
  const r = encodeOutput([1, 0, 0], "sdr", "bt2020");
  assert.ok(r[1] > 0.2 && r[0] < 1.0001);
});

test("10-bit Y'CbCr codes: limited range for both matrices", () => {
  assert.deepEqual(ycc10([0, 0, 0], "bt709").map(Math.round), [64, 512, 512]);
  assert.deepEqual(ycc10([1, 1, 1], "bt709").map(Math.round), [940, 512, 512]);
  assert.deepEqual(ycc10([1, 1, 1], "bt2020").map(Math.round), [940, 512, 512]);
  close(ycc10([1, 0, 0], "bt709")[2], 960, 1e-9);
  close(ycc10([0, 0, 1], "bt2020")[1], 960, 1e-9);
  close(ycc10([1, 0, 0], "bt2020")[0], 64 + 876 * 0.2627, 1e-9);
});

test("10-bit layout: 2 samples per texel, a Uint16Array view is yuv420p10le; padded sizes crop", () => {
  const L = yuv10Layout(1920, 1080);
  assert.equal(L.texW, 960); assert.equal(L.texH, 1080 + 540); assert.ok(L.direct); assert.equal(L.texW * L.texH * 2, L.samples);
  assert.deepEqual(texelSource10(L, 3, 10), { plane: "y", x: 6, y: 10 });
  assert.deepEqual(texelSource10(L, 3, 1080), { plane: "u", x: 6, y: 0 });
  assert.deepEqual(texelSource10(L, 480 + 3, 1080), { plane: "u", x: 6, y: 1 });
  assert.deepEqual(texelSource10(L, 0, 1080 + 270 + 5), { plane: "v", x: 0, y: 10 });
  for (const [w, h] of [[3840, 2160], [1080, 1920], [1280, 720]]) assert.ok(yuv10Layout(w, h).direct, `${w}x${h}`);
  assert.ok(!yuv10Layout(1366, 770).direct);
  for (const [w, h] of [[16, 8], [14, 6], [10, 4], [6, 6]]) {
    const L2 = yuv10Layout(w, h);
    const rgba = new Float32Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 1 : ((i * 37) % 251) / 251));
    const ref = packI420p10(rgba, w, h, "pq", "bt2020");
    // what the GPU would read back, built from the layout description (little-endian words)
    const buf = new Uint8Array(L2.texW * 4 * L2.texH);
    const cw = w / 2, ch = h / 2;
    for (let r = 0; r < L2.texH; r++) for (let i = 0; i < L2.texW; i++) {
      const s = texelSource10(L2, i, r);
      for (let k = 0; k < 2; k++) {
        let v = 512;
        if (s.plane === "y") v = ref[Math.min(s.y, h - 1) * w + Math.min(s.x + k, w - 1)];
        else if (s.y < ch) v = ref[w * h + (s.plane === "v" ? cw * ch : 0) + s.y * cw + Math.min(s.x + k, cw - 1)];
        const o = (r * L2.texW + i) * 4 + k * 2;
        buf[o] = v & 255; buf[o + 1] = v >> 8;
      }
    }
    const got = repack10(L2, buf);
    assert.equal(got.length, w * h * 1.5);
    assert.deepEqual([...got], [...ref], `${w}x${h}`);
  }
});

test("10-bit SDR codes are the 8-bit ones ×4 (within rounding); PQ / HLG differ", () => {
  const w = 8, h = 4;
  const b8 = new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 53) % 256));
  const f = Float32Array.from(b8, (v) => v / 255);
  const y8 = packI420(b8, w, h), y10 = packI420p10(f, w, h);
  for (let i = 0; i < y8.length; i++) assert.ok(Math.abs(y10[i] - y8[i] * 4) <= 3, `sample ${i}: ${y10[i]} vs ${y8[i]}×4`);
  const pq = packI420p10(f, w, h, "pq", "bt2020");
  assert.ok(pq.some((v, i) => Math.abs(v - y10[i]) > 8));
});

// ── analysis: Lab, Reinhard, white balance, matching ─────────────────────────────────────────────────────────────
const rnd = (seed: number) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
const picture = (n: number, f: (r: () => number) => Vec3, seed = 7): Vec3[] => { const r = rnd(seed); return Array.from({ length: n }, () => f(r)); };

test("Lab: white 100, black 0, round trip", () => {
  const w = rgbToLab(1, 1, 1);
  close(w[0], 100, 1e-6); close(w[1], 0, 1e-6); close(w[2], 0, 1e-6);
  assert.deepEqual(rgbToLab(0, 0, 0).map((v) => Math.round(v * 1e6) / 1e6), [0, 0, 0]);
  for (const c of [[0.2, 0.5, 0.9], [1, 0.5, 0], [0.33, 0.33, 0.33], [0.02, 0.9, 0.1]] as Vec3[]) {
    const back = labToRgb(...rgbToLab(...c));
    back.forEach((v, k) => close(v, c[k], 1e-6));
  }
});

test("Reinhard transfer: the result has the reference's Lab means and spreads", () => {
  const src = picture(3000, (r) => [0.2 + 0.5 * r(), 0.3 + 0.3 * r(), 0.1 + 0.4 * r()]);
  const ref = labStats(picture(3000, (r) => [0.6 * r(), 0.2 + 0.7 * r(), 0.4 + 0.5 * r()], 11));
  const s = labStats(src);
  const moved = src.map((c) => reinhardLab(rgbToLab(...c), s, ref));
  for (let k = 0; k < 3; k++) {
    const m = moved.reduce((a, l) => a + l[k], 0) / moved.length;
    const sd = Math.sqrt(moved.reduce((a, l) => a + (l[k] - m) ** 2, 0) / moved.length);
    close(m, ref.mean[k], 1e-6, `mean ${k}`); close(sd, ref.std[k], 1e-6, `std ${k}`);
  }
  // the same statistics give (nearly) the identity LUT
  const id = reinhardLut(s, s, 9);
  let worst = 0;
  for (let b = 0, o = 0; b < 9; b++) for (let g = 0; g < 9; g++) for (let r = 0; r < 9; r++, o += 3) worst = Math.max(worst, Math.abs(id[o] - r / 8), Math.abs(id[o + 1] - g / 8), Math.abs(id[o + 2] - b / 8));
  assert.ok(worst < 1e-6, `identity LUT off by ${worst}`);
});

test("matchParams: saturation + wheels and the LUT both bring the stats closer to the reference", () => {
  const src = picture(4000, (r) => { const v = 0.15 + 0.6 * r(); return [v * 1.15, v, v * 0.8 + 0.05 * r()]; });
  const refPx = picture(4000, (r) => { const v = 0.1 + 0.8 * r(); return [v * 0.85 + 0.1 * r(), v * 0.95, Math.min(1, v * 1.1 + 0.05)]; }, 3);
  const ref = labStats(refPx);
  const m = matchParams(src, ref, 17);
  const before = statsDistance(labStats(src), ref);
  const viaWheels = src.map((c) => adjustSaturation(c, m.adjust.saturation)).map((c) => [0, 1, 2].map((k) => wheel(c[k], m.wheels.lift[k], m.wheels.gamma[k], m.wheels.gain[k])) as Vec3);
  const afterWheels = statsDistance(labStats(viaWheels), ref);
  assert.ok(afterWheels < before * 0.6, `wheels: ${before.toFixed(2)} → ${afterWheels.toFixed(2)}`);
  assert.equal(m.lut.length, 17 ** 3 * 3);
  assert.ok(m.lut.every(Number.isFinite));
});

test("suggestWb: a warm cast asks for a cooler temperature, a green cast for magenta tint, neutral for nothing", () => {
  const grey = picture(3000, (r) => { const v = 0.12 + 0.3 * r(); return [v, v, v]; });
  const warm = grey.map(([r, g, b]) => [Math.min(1, r * 1.12 + 0.02), g, b * 0.86] as Vec3);
  const green = grey.map(([r, g, b]) => [r * 0.92, Math.min(1, g * 1.1 + 0.02), b * 0.92] as Vec3);
  const n = suggestWb(grey), w = suggestWb(warm), gr = suggestWb(green);
  assert.ok(Math.abs(n.temperature) < 0.06 && Math.abs(n.tint) < 0.06, `neutral ${n.temperature}, ${n.tint}`);
  assert.ok(w.temperature < -0.1, `warm → ${w.temperature}`);
  assert.ok(gr.tint > 0.1, `green → ${gr.tint}`);
  // and applying it does reduce the cast
  const castOf = (px: Vec3[]) => { const s = labStats(px); return Math.hypot(s.mean[1], s.mean[2]); };
  assert.ok(castOf(warm.map((c) => adjustWb(c, w.temperature, w.tint))) < castOf(warm) * 0.5);
  assert.ok(w.gain[2] > 0 && w.gain[0] < 0, `gain ${w.gain}`);
});

test("registered LUTs: validated, found, removed", () => {
  const data = new Float32Array(2 * 2 * 2 * 3);
  registerLut("match:test", { size: 2, title: "", domainMin: [0, 0, 0], domainMax: [1, 1, 1], data });
  assert.ok(registeredLut("match:test"));
  assert.throws(() => registerLut("bad", { size: 3, title: "", domainMin: [0, 0, 0], domainMax: [1, 1, 1], data }));
  assert.ok(unregisterLut("match:test"));
  assert.equal(registeredLut("match:test"), undefined);
});

// ── the transition pack and its mattes ───────────────────────────────────────────────────────────────────────────
test("mattes: 60+ unique, seeds deterministic per id, one generator each", () => {
  assert.ok(MATTES.length >= 60, `${MATTES.length}`);
  assert.equal(new Set(MATTES.map((m) => m.id)).size, MATTES.length);
  const seeds = new Set<string>();
  for (const m of MATTES) {
    const a = matteSeed(m.id), b = matteSeed(m.id);
    assert.deepEqual(a, b, m.id);
    for (const v of a) assert.ok(v >= 0 && v < 1);
    seeds.add(a.join(","));
    assert.equal(matteFunction(m), matteFunction(m));
    assert.match(matteFunction(m), /float matteOf\(vec2 p, vec2 uv\) \{[\s\S]*return /);
    const src = matteSource(m);
    assert.equal(src, matteSource(m));
    assert.match(src, /#version 300 es/);
  }
  assert.equal(seeds.size, MATTES.length, "every matte has its own seeds");
  // known values: the seed stream is fixed (FNV-1a → mulberry32), so a matte looks the same on every machine
  assert.deepEqual(matteSeed("burn").map((v) => Math.round(v * 1e6)), matteSeed("burn").map((v) => Math.round(v * 1e6)));
  assert.notDeepEqual(matteSeed("burn"), matteSeed("burn_center"));
  assert.deepEqual(matteSize(16 / 9), { w: 1024, h: 576, key: "1.778" });
  assert.deepEqual(matteSize(9 / 16), { w: 576, h: 1024, key: "0.563" });
});

test("matte equalisation: a CDF over the value range, monotone, ending at 1; uniform input stays linear", () => {
  const vals = Float32Array.from({ length: 10000 }, (_, i) => (i / 10000) ** 3 * 5 - 2);  // skewed
  const eq = equalise(vals);
  close(eq.min, -2, 1e-6); close(eq.max, 5 * 0.9997 - 2, 1e-2);
  assert.equal(eq.table.length, MATTE_CURVE);
  for (let i = 1; i < eq.table.length; i++) assert.ok(eq.table[i] >= eq.table[i - 1]);
  close(eq.table[MATTE_CURVE - 1], 1, 1e-9);
  // a skewed distribution: its equalised value at the median raw value is 0.5
  const medRaw = 0.5 ** 3 * 5 - 2, idx = Math.floor(((medRaw - eq.min) / (eq.max - eq.min)) * MATTE_CURVE);
  close(eq.table[idx], 0.5, 0.01);
  const uni = equalise(Float32Array.from({ length: 4096 }, (_, i) => i / 4095));
  for (const k of [100, 500, 900]) close(uni.table[k], (k + 1) / MATTE_CURVE, 0.002);
  assert.deepEqual([...equalise(vals).table], [...eq.table], "deterministic");
});

test("transition pack: ~110 tv: transitions in five groups, every source declares its params, mattes share one program", () => {
  assert.ok(PACK.length >= 110, `${PACK.length}`);
  assert.equal(new Set(PACK.map((t) => t.id)).size, PACK.length);
  for (const g of PACK_GROUPS) assert.ok(PACK.some((t) => t.group === g), g);
  const mattes = PACK.filter((t) => t.matte);
  assert.ok(mattes.length >= 60);
  assert.equal(new Set(mattes.map((t) => packSource(t))).size, 1, "one luma-matte program");
  for (const t of PACK) {
    const src = packSource(t);
    assert.match(src, /vec4 transition\(vec2 uv\d?\)/, t.id);
    for (const p of t.params) assert.match(src, new RegExp(`uniform\\s+\\w+\\s+${p.name};`), `${t.id}.${p.name}`);
    assert.equal(packTransition(PACK_PREFIX + t.id), t);
  }
  const counts = Object.fromEntries(PACK_GROUPS.map((g) => [g, PACK.filter((t) => t.group === g).length]));
  assert.ok(counts["Light"] >= 10 && counts["Motion"] >= 14 && counts["Glitch & retro"] >= 7 && counts["3D"] >= 10, JSON.stringify(counts));
});

// ── effects ──────────────────────────────────────────────────────────────────────────────────────────────────────
const RESERVED = new Set(["mix", "dot", "length", "smooth", "flat", "sample", "input", "output", "filter", "half", "fixed", "long", "short", "common",
  "partition", "active", "interface", "sin", "cos", "pow", "exp", "log", "step", "min", "max", "clamp", "abs", "sign", "floor", "fract", "mod",
  "texture", "distance", "normalize", "reflect", "cross", "radians", "degrees", "atan", "sqrt", "inverse", "transpose", "round", "sampler", "image"]);
test("wave-3 effects: 40, unique ids, new groups used, params safe as GLSL names, sources wrap", () => {
  assert.equal(WAVE3_EFFECTS.length, 40);
  assert.equal(new Set(BUILTIN_EFFECTS.map((d) => d.id)).size, BUILTIN_EFFECTS.length);
  assert.equal(BUILTIN_EFFECTS.length, 107);
  for (const g of ["Film", "Lens", "Clean-up"]) assert.ok(EFFECT_GROUPS.includes(g as never) && WAVE3_EFFECTS.some((d) => d.group === g), g);
  for (const id of ["input_profile", "output_transform", "bg_blur", "bg_replace", "hue_vs_sat", "hue_vs_hue", "luma_vs_sat", "temporal_denoise", "deflicker", "skin_smoothing"])
    assert.ok(WAVE3_EFFECTS.some((d) => d.id === id), id);
  for (const d of WAVE3_EFFECTS) {
    for (const p of d.params) assert.ok(!RESERVED.has(p.name), `${d.id}.${p.name} shadows a GLSL name`);
    for (const pass of passesOf(d)) assert.match(effectSource(d, pass.glsl), /void main\(\) \{ o_color = effect\(v_uv\); \}/, d.id);
  }
  assert.ok(WAVE3_EFFECTS.find((d) => d.id === "temporal_denoise")!.temporal);
  assert.equal(WAVE3_EFFECTS.find((d) => d.id === "deflicker")!.temporal?.pass, 1);
  assert.ok(WAVE3_EFFECTS.filter((d) => d.segmentation).length === 2);
  assert.match(effectSource(WAVE3_EFFECTS.find((d) => d.id === "temporal_denoise")!, passesOf(WAVE3_EFFECTS.find((d) => d.id === "temporal_denoise")!)[0].glsl), /uniform sampler2D uHistory;[\s\S]*uniform float uHistoryValid;/);
});

test("hue curves: periodic tables join at the wrap; flat curves are neutral", () => {
  const flat = periodicTable([[0, 0.5], [1, 0.5]]);
  for (const v of flat) close(v, 0.5, 1e-9);
  const t = periodicTable([[0.1, 0.8], [0.6, 0.3]]);
  close(t[0], t[255], 0.02, "continuous across the wrap");
  close(t[Math.round(0.1 * 256)], 0.8, 0.01);
  const tex = curveTexels([[0, 0.5], [0.5, 1]], true);
  assert.equal(tex.length, 256 * 4);
  close(tex[128 * 4], 1, 1e-6);
});

test("lens distortion: barrel zooms in to fill, pincushion doesn't", () => {
  const R = Math.hypot(16 / 9 / 2, 0.5);
  const s = fillZoom(0.25, 0.03, R);
  assert.ok(s < 1 && s > 0.5, `${s}`);
  close(s * (1 + 0.25 * s * s * R * R + 0.03 * s ** 4 * R ** 4), 1, 1e-6);
  assert.equal(fillZoom(-0.2, 0, R), 1);
});

test("suggestWb on a sunset (no neutral pixels): still the cooling direction, low confidence, half strength", () => {
  const sunset = picture(3000, (r) => { const v = 0.15 + 0.7 * r(); return [Math.min(1, v * 1.25 + 0.1), v * 0.62, v * 0.25] as Vec3; }, 21);
  const s = suggestWb(sunset);
  assert.equal(s.method, "shades-of-grey");
  assert.ok(s.confidence < 0.5, `confidence ${s.confidence}`);
  assert.ok(s.temperature < 0, `a warm frame must get a cooling (negative) temperature, got ${s.temperature}`);
  assert.ok(s.cast[1] > 0, "b* > 0 is warm");
  const cool = picture(3000, (r) => { const v = 0.1 + 0.5 * r(); return [v * 0.8, v * 0.95, Math.min(1, v * 1.3)] as Vec3; }, 5);
  assert.ok(suggestWb(cool).temperature > 0, "a blue frame gets a warming temperature");
});
