import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromeCompressorMakeup, Crusher, dopplerAt, Expander, fadeGain, Gate, softclip, waveTable } from "../audiofx/dsp.ts";
import { DTMF, renderGenerator } from "../audiofx/generators.ts";
import { IR_NAMES, IR_RATE, makeIr, wavFloat32 } from "../audiofx/ir.ts";
import { gatedLoudness, K48_REFERENCE, kWeighting, LoudnessMeter, matchGain, measureLoudness } from "../audiofx/loudness.ts";
import { audioFxOf, clipCacheKey, clipGainCurve, fxPlan, valuesAt } from "../audiofx/plan.ts";
import {
  AUDIO_FX, AUDIO_FX_ALIASES, AUDIO_FX_GROUPS, AUDIO_TRANSITION_DEFS, audioFxDefaults, audioFxId, CHAIN_PRESETS, GENERATORS, needsCache, resolveParams, transitionCurve,
} from "../audiofx/registry.ts";
import type { EffectInstance } from "../model/types.ts";
import { project, put, seqOf } from "./fixtures.ts";

const FS = 48000;
const sine = (f: number, amp: number, secs: number, phase = 0, fs = FS) => Float32Array.from({ length: Math.round(secs * fs) }, (_, i) => amp * Math.sin(2 * Math.PI * f * (i / fs) + phase));
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

// ── the registry against docs/EDITOR.md §11 / §11.1 ──────────────────────────────────────────────────────

/** Every backticked id in the §11 and §11.1 effect tables (the Generate row is the generators). */
function docIds(): { effects: string[]; generators: string[] } {
  const md = readFileSync(fileURLToPath(new URL("../../../../docs/EDITOR.md", import.meta.url)), "utf8");
  const sec = md.slice(md.indexOf("## 11. Audio effects"), md.indexOf("**Audio transitions**"));
  const effects: string[] = [], generators: string[] = [];
  for (const line of sec.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| Group") || line.startsWith("| ---")) continue;
    const ids = [...line.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]).filter((x) => x !== "sample_noise");
    (line.startsWith("| Generate") ? generators : effects).push(...ids);
  }
  return { effects: [...new Set(effects)], generators };
}

test("registry: every §11 / §11.1 effect id is there once, with a group and an implementation choice", () => {
  const { effects, generators } = docIds();
  assert.ok(effects.length >= 75, `the doc lists ${effects.length} ids`);
  const ids = AUDIO_FX.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const id of effects) assert.ok(audioFxId(id), `${id} is in the registry (or an alias)`);
  for (const d of AUDIO_FX) assert.ok(effects.includes(d.id), `${d.id} is in the docs`);
  assert.deepEqual(GENERATORS.map((g) => g.kind), generators);
  assert.equal(AUDIO_FX.length, 75);
  assert.equal(AUDIO_FX.filter((d) => d.preview === "realtime").length, 49);
  assert.equal(AUDIO_FX.filter((d) => d.preview === "cache").length, 26);
  for (const d of AUDIO_FX) assert.ok(AUDIO_FX_GROUPS.includes(d.group), `${d.id} group`);
});

test("registry: params have unique names and defaults inside their range / options", () => {
  for (const d of [...AUDIO_FX, ...GENERATORS.map((g) => ({ id: g.kind, params: g.params }))]) {
    const names = d.params.map((p) => p.name);
    assert.equal(new Set(names).size, names.length, `${d.id} param names`);
    for (const p of d.params) {
      if (p.type === "number") {
        assert.equal(typeof p.default, "number", `${d.id}.${p.name}`);
        assert.ok((p.min ?? -Infinity) <= (p.default as number) && (p.default as number) <= (p.max ?? Infinity), `${d.id}.${p.name} default in range`);
      } else if (p.type === "select") assert.ok(p.options?.some((o) => o.value === p.default), `${d.id}.${p.name} default is an option`);
    }
    for (const pr of (d as { presets?: { name: string; values: Record<string, unknown> }[] }).presets ?? []) {
      for (const k of Object.keys(pr.values)) assert.ok(names.includes(k), `${d.id} preset "${pr.name}" sets a real param (${k})`);
    }
  }
  for (const c of CHAIN_PRESETS) for (const e of c.effects) {
    assert.ok(audioFxId(e.id), `${c.name}: ${e.id}`);
    const names = AUDIO_FX.find((d) => d.id === e.id)!.params.map((p) => p.name);
    for (const k of Object.keys(e.values ?? {})) assert.ok(names.includes(k), `${c.name}: ${e.id}.${k}`);
  }
});

test("registry: ids, aliases and the legacy types", () => {
  assert.equal(audioFxId("audio:eq"), "eq3");
  assert.equal(audioFxId("audio:eq3"), "eq3");
  assert.equal(audioFxId("surround_reverb"), "reverb");
  assert.equal(audioFxId("audio:gate"), "gate");
  assert.equal(audioFxId("invert"), "invert");
  assert.equal(audioFxId("look"), null);
  assert.equal(audioFxId("audio:nonsense"), null);
  assert.ok(Object.values(AUDIO_FX_ALIASES).every((id) => audioFxId(id) === id));
});

test("param mapping: defaults fill in, numbers clamp, bad choices fall back", () => {
  assert.deepEqual(resolveParams("limiter", {}), { ceiling: -1, release: 0.05 });
  assert.deepEqual(resolveParams("limiter", { ceiling: 3, release: "0.2", junk: 1 }), { ceiling: 0, release: 0.2 });
  assert.equal(resolveParams("reverb", { preset: "garage" }).preset, "room");
  assert.equal(resolveParams("reverb", { preset: "hall" }).preset, "hall");
  assert.equal(resolveParams("gain", { gain: Number.NaN }).gain, 0);
  assert.deepEqual(audioFxDefaults("echo"), { delay: 300, feedback: 0.4, wet: 0.5 });
  assert.equal(needsCache([{ type: "audio:compressor" }, { type: "audio:denoise", enabled: false }]), false);
  assert.equal(needsCache([{ type: "audio:compressor" }, { type: "audio:denoise" }]), true);
});

test("param mapping: keyframed values at a frame, and the cache key follows the clip's sound", () => {
  const e: EffectInstance = { id: "e1", type: "audio:gain", enabled: true, params: { gain: { value: 0, keyframes: [{ frame: 0, value: -12, ease: "linear" }, { frame: 10, value: 0, ease: "linear" }] } } };
  assert.equal(valuesAt(e, "gain", 0).gain, -12);
  assert.equal(valuesAt(e, "gain", 5).gain, -6);
  assert.equal(valuesAt(e, "gain", 30).gain, 0);
  assert.deepEqual(audioFxOf([e, { ...e, id: "e2", enabled: false }, { id: "v", type: "look", enabled: true, params: {} }]).map((r) => r.key), ["e1"]);
  const p = project();
  const s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  const c = s.clips[0];
  const k1 = clipCacheKey({ ...c, effects: [e] });
  assert.equal(k1, clipCacheKey({ ...c, effects: [e] }));
  assert.notEqual(k1, clipCacheKey({ ...c, effects: [{ ...e, params: { gain: { value: -3 } } }] }));
  assert.notEqual(k1, clipCacheKey({ ...c, effects: [e], duration: c.duration - 1 }));
});

test("transitions: acrossfade curves by type, constant power keeps the power", () => {
  assert.equal(AUDIO_TRANSITION_DEFS[0].id, "audio:constant_power");
  assert.equal(transitionCurve("audio:constant_power"), "qsin");
  assert.equal(transitionCurve("audio:constant_gain"), "tri");
  assert.equal(transitionCurve("audio:exponential"), "exp");
  assert.equal(transitionCurve("audio:whatever"), "qsin");
  for (let q = 0; q <= 1; q += 0.125) {
    const a = fadeGain("qsin", q), b = fadeGain("qsin", 1 - q);
    assert.ok(Math.abs(a * a + b * b - 1) < 1e-12, "sin² + cos² = 1");
    assert.ok(Math.abs(fadeGain("tri", q) + fadeGain("tri", 1 - q) - 1) < 1e-12, "constant gain");
  }
  assert.ok(Math.abs(fadeGain("exp", 0) - 1e-5) < 1e-9 && fadeGain("exp", 1) === 1);
  // a crossfade: the incoming clip rises with the curve, the outgoing one falls
  const plan = { duration: 4, gain: { value: 0, keys: [] }, fadeIn: 0, fadeOut: 0, xIn: { start: 0, duration: 1 }, xOut: { start: 3, duration: 1 } };
  assert.ok(Math.abs(clipGainCurve(plan, 0.5, "qsin", "qsin") - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(clipGainCurve(plan, 3.5, "tri", "tri") - 0.5) < 1e-12);
  assert.ok(Math.abs(clipGainCurve(plan, 3.5, "exp", "exp") - Math.exp(-11.512925464970227 * 0.5)) < 1e-12);
});

test("fxPlan: clip, track and master chains, generator clips and crossfade curves", () => {
  const p = project();
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "m1", 100, { in: 0, out: 99 });
  const aIds = s.tracks.filter((t) => t.kind === "audio").map((t) => t.id);
  const ac = s.clips.filter((c) => aIds.includes(c.trackId)).sort((a, b) => a.start - b.start);
  const gain: EffectInstance = { id: "g", type: "audio:gain", enabled: true, params: { gain: { value: -6 } } };
  const dn: EffectInstance = { id: "d", type: "audio:denoise", enabled: true, params: { amount: { value: 0.5 } } };
  s = {
    ...s,
    clips: [...s.clips.map((c) => (c.id === ac[0].id ? { ...c, effects: [gain, dn] } : c)),
      { ...ac[0], id: "gen", start: 300, duration: 50, source: { type: "generate", generator: "tone", params: { frequency: { value: 440 }, level: { value: -6 } } }, effects: [] }],
    tracks: s.tracks.map((t) => (t.id === aIds[0] ? { ...t, effects: [gain] } : t)),
    masterEffects: [{ id: "lim", type: "audio:limiter", enabled: true, params: {} }],
    transitions: [{ id: "x", trackId: ac[0].trackId, at: 100, duration: 10, alignment: "center", type: "audio:exponential", easing: "linear", fromClipId: ac[0].id, toClipId: ac[1].id }],
  };
  const proj = { ...p, sequences: [s] };
  const plan = fxPlan(proj, s.id);
  const c0 = plan.clips.get(ac[0].id)!;
  assert.deepEqual(c0.fx.map((r) => r.id), ["gain", "denoise"]);
  assert.equal(c0.cache, true);
  assert.equal(c0.curveOut, "exp");
  assert.equal(plan.clips.get(ac[1].id)!.curveIn, "exp");
  assert.deepEqual(plan.tracks.get(aIds[0])!.map((r) => r.id), ["gain"]);
  assert.deepEqual(plan.master.map((r) => r.id), ["limiter"]);
  assert.equal(plan.generators.length, 1);
  assert.equal(plan.generators[0].values.frequency, 440);
  assert.equal(plan.generators[0].level.value, -6);
});

// ── loudness (BS.1770-4 / EBU Tech 3341) ──────────────────────────────────────────────────────────────────

test("K-weighting at 48 kHz equals the BS.1770-4 coefficients", () => {
  const k = kWeighting(48000);
  for (let s = 0; s < 2; s++) for (const ab of ["b", "a"] as const) for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(k[s][ab][i] - K48_REFERENCE[s][ab][i]) < 1e-8, `stage ${s + 1} ${ab}${i}: ${k[s][ab][i]} vs ${K48_REFERENCE[s][ab][i]}`);
  }
  // and the filter's gain: +4 dB shelf above ~2 kHz, the RLB high-pass down at 20 Hz
  const gainAt = (f: number) => {
    let h = 1;
    for (const c of k) {
      const w = (2 * Math.PI * f) / 48000;
      const num = [c.b[0] + c.b[1] * Math.cos(-w) + c.b[2] * Math.cos(-2 * w), c.b[1] * Math.sin(-w) + c.b[2] * Math.sin(-2 * w)];
      const den = [c.a[0] + c.a[1] * Math.cos(-w) + c.a[2] * Math.cos(-2 * w), c.a[1] * Math.sin(-w) + c.a[2] * Math.sin(-2 * w)];
      h *= Math.hypot(num[0], num[1]) / Math.hypot(den[0], den[1]);
    }
    return 20 * Math.log10(h);
  };
  assert.ok(Math.abs(gainAt(10000) - 4) < 0.1, `10 kHz ${gainAt(10000)}`);
  assert.ok(gainAt(20) < -10, `20 Hz ${gainAt(20)}`);
  assert.ok(Math.abs(gainAt(997)) < 0.75);
});

test("loudness: EBU 3341 stereo 1 kHz sines at −23 and −33 dBFS read −23.0 / −33.0 LUFS", () => {
  for (const dbfs of [-23, -33]) {
    const x = sine(1000, Math.pow(10, dbfs / 20), 20);
    const r = measureLoudness([x, x], FS);
    assert.ok(Math.abs(r.lufs - dbfs) <= 0.1, `${dbfs}: ${r.lufs.toFixed(2)} LUFS`);
  }
});

test("loudness: 0 dBFS 997 Hz in one channel reads −3.01 LUFS; silence is gated out", () => {
  const x = sine(997, 1, 10);
  const z = new Float32Array(x.length);
  const m = new LoudnessMeter(FS, 2);
  m.push([x, z], x.length);
  assert.ok(Math.abs(m.integrated() + 3.01) < 0.1, `${m.integrated()}`);
  assert.ok(Math.abs(m.momentary() + 3.01) < 0.1, `${m.momentary()}`);
  assert.ok(Math.abs(m.shortTerm() + 3.01) < 0.1, `${m.shortTerm()}`);
  // 10 s of tone then 10 s of near-silence: the integrated loudness stays the tone's
  const quiet = new Float32Array(x.length).fill(1e-6);
  const m2 = new LoudnessMeter(FS, 2);
  m2.push([x, z], x.length); m2.push([quiet, quiet], quiet.length);
  assert.ok(Math.abs(m2.integrated() + 3.01) < 0.15, `${m2.integrated()}`);
  // relative gate: a −40 LUFS stretch next to a −20 one is dropped (more than 10 LU below)
  const blocks = [...Array(50).fill(Math.pow(10, (-20 + 0.691) / 10)), ...Array(50).fill(Math.pow(10, (-40 + 0.691) / 10))];
  assert.ok(Math.abs(gatedLoudness(blocks) + 20) < 1e-9);
});

test("true peak catches the inter-sample peak a sample peak misses; correlation reads phase", () => {
  const x = sine(12000, 1, 1, Math.PI / 4);            // samples at ±0.707, the wave reaches ±1
  const r = measureLoudness([x, x], FS);
  assert.ok(Math.abs(r.samplePeak + 3.01) < 0.05, `sample peak ${r.samplePeak}`);
  assert.ok(r.truePeak > -0.6 && r.truePeak < 0.6, `true peak ${r.truePeak}`);
  const y = sine(440, 0.5, 1);
  const neg = y.map((v) => -v);
  const a = new LoudnessMeter(FS, 2); a.push([y, y], y.length);
  const b = new LoudnessMeter(FS, 2); b.push([y, neg], y.length);
  assert.ok(a.correlation() > 0.99 && b.correlation() < -0.99);
  assert.equal(matchGain(-20.04, -14), 6);
  assert.equal(matchGain(null, -14), 0);
  assert.equal(matchGain(-80, -14), 30);
});

// ── impulse responses ───────────────────────────────────────────────────────────────────────────────────

test("impulse responses: deterministic, unit energy per channel, the WAV the desktop writes", () => {
  for (const name of IR_NAMES) {
    const a = makeIr(name), b = makeIr(name);
    assert.equal(a.length, 2);
    assert.deepEqual(a[0], b[0]);
    assert.deepEqual(a[1], b[1]);
    for (const ch of a) {
      const e = ch.reduce((s, v) => s + v * v, 0);
      assert.ok(Math.abs(e - 1) < 1e-4, `${name} energy ${e}`);
    }
  }
  const wav = wavFloat32(makeIr("room"));
  const v = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(v.getUint16(20, true), 3);               // IEEE float
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), IR_RATE);
  // the recipe must not drift: the desktop's copy writes the same bytes
  let h = 0x811c9dc5;
  for (let i = 0; i < wav.length; i++) { h ^= wav[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  assert.equal(h >>> 0, ROOM_WAV_FNV, `room.wav fnv ${h >>> 0}`);
});
const ROOM_WAV_FNV = 891275199;

// ── sample-level DSP (the FFmpeg ports) ─────────────────────────────────────────────────────────────────

test("asoftclip curves and Chromium's compressor make-up", () => {
  assert.equal(softclip("hard", 3), 1);
  assert.ok(Math.abs(softclip("tanh", 0.5) - Math.tanh(0.5)) < 1e-12);
  assert.ok(Math.abs(softclip("atan", 1e6) - 1) < 1e-5);
  assert.equal(softclip("cubic", 2), 1);
  assert.ok(Math.abs(softclip("erf", 0.5) - 0.5204998778) < 1e-6);
  assert.ok(Math.abs(20 * Math.log10(chromeCompressorMakeup(-24, 30, 1))) < 0.3, "ratio 1: (almost) no make-up");
  const mk = chromeCompressorMakeup(-24, 0, 4);
  // with a hard knee, 0 dBFS comes out at −24 + 24/4 = −18 dB: make-up (1/0.126)^0.6 ≈ +10.8 dB
  assert.ok(Math.abs(20 * Math.log10(mk) - 10.8) < 0.1, `${20 * Math.log10(mk)}`);
});

test("acrusher port: 1/(2^bits − 1) steps, hold every Nth sample like FFmpeg 7.1", () => {
  const c = new Crusher();
  c.set({ bits: 3, samples: 1, mix: 1 });
  const x = sine(50, 0.9, 0.1);
  const o = new Float32Array(x.length);
  c.process([x], [o], x.length);
  assert.equal(new Set([...o].map((v) => v.toFixed(4))).size, 13);
  const h = new Crusher();
  h.set({ bits: 64, samples: 8, mix: 1 });
  const s = sine(1000, 0.125, 0.01);
  const so = new Float32Array(s.length);
  h.process([s], [so], s.length);
  assert.deepEqual([...so.slice(0, 7)], [0, 0, 0, 0, 0, 0, 0]);
  for (let i = 7; i < 15; i++) assert.ok(Math.abs(so[i] - s[7]) < 1e-6);
  assert.ok(Math.abs(so[15] - s[15]) < 1e-6);
});

test("gate and expander: loud passes, quiet goes down to the range", () => {
  const g = new Gate(FS);
  g.set({ threshold: -40, range: -30, attack: 0.005, release: 0.05, ratio: 10 });
  const loud = sine(440, 0.5, 0.5), quiet = sine(440, 0.001, 0.5);
  const o1 = new Float32Array(loud.length), o2 = new Float32Array(quiet.length);
  g.process([loud], [o1], loud.length);
  g.process([quiet], [o2], quiet.length);
  const tail = (a: Float32Array) => rms(a.subarray(a.length / 2));
  assert.ok(Math.abs(20 * Math.log10(tail(o1) / tail(loud))) < 0.2, "loud: unity");
  assert.ok(Math.abs(20 * Math.log10(tail(o2) / tail(quiet)) + 30) < 0.5, `quiet: ${20 * Math.log10(tail(o2) / tail(quiet))}`);
  const e = new Expander(FS);
  e.set({ threshold: -40, ratio: 2, attack: 0.001, release: 0.05 });
  assert.equal(e.gainDb(-30), 0);
  assert.equal(e.gainDb(-50), -10);
  assert.equal(e.gainDb(-200), -50);
});

test("FFmpeg's wave tables and the doppler path", () => {
  const tri = waveTable("tri", 8, 0, 1, 0, false);
  assert.deepEqual([...tri], [0.5, 0.75, 1, 0.75, 0.5, 0.25, 0, 0.25]);
  const sn = waveTable("sin", 4, 0, 10, 0, true);
  assert.deepEqual([...sn], [5, 10, 5, 0]);
  const p = { path: "pass_lr", speed: 20, distance: 3, center: 0.5 };
  const mid = dopplerAt(p, 5, 10);
  assert.ok(Math.abs(mid.pan) < 1e-9 && mid.gain === 1 && Math.abs(mid.rate - 1) < 1e-3 && mid.delay === 0);
  const before = dopplerAt(p, 1, 10), after = dopplerAt(p, 9, 10);
  assert.ok(before.rate > 1.05 && after.rate < 0.95, "higher coming, lower going");
  assert.ok(before.pan < -0.9 && after.pan > 0.9);
  assert.ok(dopplerAt({ ...p, path: "approach" }, 2, 10).rate > 1 && dopplerAt({ ...p, path: "recede" }, 8, 10).rate < 1);
});

// ── generators ──────────────────────────────────────────────────────────────────────────────────────────

test("generators: tone level, DTMF frequencies, noise levels like anoisesrc", () => {
  const t = renderGenerator("tone", { frequency: 1000, wave: "sine" }, FS, 1);
  assert.ok(Math.abs(rms(t) - Math.SQRT1_2) < 1e-3);
  const sq = renderGenerator("tone", { frequency: 100, wave: "square" }, FS, 1);
  assert.ok(Math.abs(rms(sq) - 1) < 1e-3);
  const sw = renderGenerator("tone", { frequency: 100, sweepTo: 1000, sweep: "log" }, FS, 1);
  assert.ok(Math.abs(rms(sw) - Math.SQRT1_2) < 0.01);
  // Goertzel power of the first digit's tones
  const d = renderGenerator("dtmf", { digits: "1", tone: 200, gap: 50 }, FS, 0.25);
  const power = (f: number) => { let re = 0, im = 0; for (let i = 0; i < 9600; i++) { re += d[i] * Math.cos((2 * Math.PI * f * i) / FS); im += d[i] * Math.sin((2 * Math.PI * f * i) / FS); } return Math.hypot(re, im); };
  const [lo, hi] = DTMF["1"];
  assert.ok(power(lo) > 10 * power(770) && power(hi) > 10 * power(1336));
  const w = renderGenerator("noise", { color: "white" }, FS, 2);
  assert.ok(Math.abs(rms(w) - 1 / Math.sqrt(3)) < 0.01);
  const pk = renderGenerator("noise", { color: "pink" }, FS, 4);
  assert.ok(Math.abs(rms(pk) - 0.1975) < 0.02, `pink ${rms(pk)} (anoisesrc: 0.1975)`);
  const vel = renderGenerator("noise", { color: "velvet", density: 0.002 }, FS, 4);
  assert.ok(Math.abs(rms(vel) - Math.sqrt(0.002)) < 0.005, `velvet ${rms(vel)}`);
});

// ── Essential Sound and stacks ──────────────────────────────────────────────────────────────────────────

test("essential sound: controls write ordinary effects, off removes them", async () => {
  const { setControl, readControl } = await import("../audiofx/essential.ts");
  let fxs: EffectInstance[] = [];
  fxs = setControl(fxs, "noise", 0.6);
  assert.deepEqual(fxs.map((e) => e.type), ["audio:denoise"]);
  assert.equal(readControl(fxs, "noise"), 0.6);
  fxs = setControl(fxs, "hum", "60");
  assert.equal(fxs[1].type, "audio:dehum");
  assert.equal(fxs[1].params.frequency.value, 60);
  fxs = setControl(fxs, "noise", 0.3);
  assert.equal(fxs.length, 2);
  assert.equal(fxs[0].params.amount.value, 0.3);
  fxs = setControl(fxs, "reverb", "hall");
  fxs = setControl(fxs, "reverbAmount", 0.4);
  const rv = fxs.filter((e) => e.type === "audio:reverb");
  assert.equal(rv.length, 1);
  assert.equal(rv[0].params.preset.value, "hall");
  assert.equal(rv[0].params.mix.value, 0.4);
  fxs = setControl(fxs, "noise", 0);
  fxs = setControl(fxs, "hum", "off");
  assert.deepEqual(fxs.map((e) => e.type), ["audio:reverb"]);
});

test("auto-duck: level keyframes under the dialogue, merged, inside the clip", async () => {
  const { duckKeyframes, mergeIntervals } = await import("../audiofx/essential.ts");
  assert.deepEqual(mergeIntervals([[10, 20], [18, 30], [50, 60]]), [[10, 30], [50, 60]]);
  const p = duckKeyframes({ start: 100, duration: 300 }, -3, [[150, 200], [205, 250]], 12, 10);
  // the two lines 5 frames apart merge (gap < 2 fades): one dip from 50 to 150 (clip frames)
  assert.deepEqual(p.keyframes!.map((k) => [k.frame, k.value]), [[40, -3], [50, -15], [150, -15], [160, -3]]);
  const edge = duckKeyframes({ start: 0, duration: 100 }, 0, [[-50, 30]], 10, 5);
  assert.deepEqual(edge.keyframes!.map((k) => [k.frame, k.value]), [[0, -10], [30, -10], [35, 0]]);
  assert.deepEqual(duckKeyframes({ start: 0, duration: 100 }, 0, [], 10, 5), { value: 0 });
});

test("remix to length: cut on bar lines, end on the music's end, within a beat of the target", async () => {
  const { remixPlan } = await import("../audiofx/essential.ts");
  const beats = Array.from({ length: 240 }, (_, i) => i * 0.5);      // 120 BPM, 2 minutes
  for (const target of [45, 60, 90.3, 150, 200]) {
    const ps = remixPlan(beats, 0, 120, target);
    const total = ps.reduce((s, x) => s + (x.to - x.from), 0);
    assert.ok(Math.abs(total - target) <= 0.5, `${target}: ${total}`);
    assert.equal(ps[ps.length - 1].to, 120, "ends on the music's end");
    for (const x of ps.slice(1)) assert.ok(Math.abs((x.from / 0.5) - Math.round(x.from / 0.5)) < 1e-9, "cuts land on beats");
  }
  assert.deepEqual(remixPlan(beats, 0, 120, 119.9), [{ from: 0.1, to: 120 }].map((x) => ({ ...x, from: 120 - 119.9 })));
  assert.deepEqual(remixPlan([], 10, 70, 30), [{ from: 40, to: 70 }]);
});

test("stacks: clip, track and master lists; moves keep video effects in place; generator clips", async () => {
  const { addGeneratorClip, audioStack, fx, makeAudioFx, withFx } = await import("../audiofx/stack.ts");
  const { ctxOf } = await import("../model/ops.ts");
  const p = project();
  const s0 = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  const ctx = ctxOf({ ...p, sequences: [s0] });
  const a = s0.clips.find((c) => s0.tracks.find((t) => t.id === c.trackId)?.kind === "audio")!;
  const look: EffectInstance = { id: "v", type: "look", enabled: true, params: {} };
  const g = makeAudioFx("gain", { gain: -6 }), e = makeAudioFx("echo");
  let s = withFx(s0, ctx, { kind: "clip", clipId: a.id }, () => [g, look, e]);
  s = withFx(s, ctx, { kind: "clip", clipId: a.id }, (l) => fx.move(l, e.id, -1));
  assert.deepEqual(s.clips.find((c) => c.id === a.id)!.effects.map((x) => x.type), ["audio:echo", "look", "audio:gain"]);
  assert.deepEqual(audioStack(s, { kind: "clip", clipId: a.id }).map((x) => x.type), ["audio:echo", "audio:gain"]);
  s = withFx(s, ctx, { kind: "track", trackId: a.trackId }, (l) => fx.add(l, makeAudioFx("compressor")));
  s = withFx(s, ctx, { kind: "master" }, (l) => fx.add(l, makeAudioFx("limiter")));
  assert.equal(s.tracks.find((t) => t.id === a.trackId)!.effects![0].type, "audio:compressor");
  assert.equal(s.masterEffects![0].params.ceiling.value, -1);
  s = withFx(s, ctx, { kind: "master" }, (l) => fx.stopwatch(l, s.masterEffects![0].id, "ceiling", 25));
  assert.equal(s.masterEffects![0].params.ceiling.keyframes!.length, 1);
  const r = addGeneratorClip(s, ctx, "tone", 200, a.trackId, 2, { frequency: 440 });
  const gc = r.seq.clips.find((c) => c.id === r.clipId)!;
  assert.equal(gc.source.type, "generate");
  assert.equal(gc.duration, 50);
  assert.ok(gc.audio, "generator clips get clip audio (level, pan, fades)");
  assert.equal((gc.source as { params: Record<string, { value: unknown }> }).params.frequency.value, 440);
});
