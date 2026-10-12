/**
 * The export side of the audio effects (src/main/editor-audiofx.ts, docs/EDITOR.md §11 / §11.1): every effect id's
 * filtergraph snapshotted (defaults and other values), the mappings the preview was matched against, keyframes through
 * asendcmd, aliases and warnings, and the shared impulse responses (a verbatim copy of the frontend's recipe).
 * Every snapshot was also run through FFmpeg 7.1 on this PC (scratch script, 81 variants, all clean).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AUDIO_FX, audioFxId, buildFx, echoFilter, layChain, pwlAt } from "../src/main/editor-audiofx.ts";
import { CABINET_IRS, IR_NAMES, presetWav, REVERB_IRS } from "../src/main/editor-irs.ts";
import { OVERRIDES, render, snapshots } from "./fixtures/audiofx-cases.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAP = JSON.parse(readFileSync(path.join(here, "fixtures", "audiofx-snapshots.json"), "utf8")) as Record<string, { defaults: string; values?: string }>;

test("all 75 effect ids of §11 and §11.1 are in the catalogue, each with its snapshot", () => {
  const ids = AUDIO_FX.map((d) => d.id);
  assert.equal(ids.length, 75);
  assert.equal(new Set(ids).size, 75);
  for (const id of ["gain", "compressor", "multiband", "limiter", "gate", "expander", "deesser", "auto_level", "speech_level", "tube_compressor", "loudness_maximizer",
    "mastering", "dc_offset", "eq3", "eq_graphic", "eq_param", "highpass", "lowpass", "bandpass", "notch", "dehum", "tilt", "virtual_bass", "exciter", "crystalizer",
    "denoise", "denoise_wavelet", "denoise_nl", "declick", "declip", "dialogue_enhance", "voice_enhance", "trim_silence", "noise_print", "hiss_reduction", "dereverb",
    "center_extract", "pitch_shift", "time_stretch", "chipmunk", "deep_voice", "robot", "alien", "pitch_bend", "reverb", "echo", "stereo_widen", "haas", "mono",
    "auto_pan", "doppler", "chorus", "flanger", "phaser", "tremolo", "vibrato", "distortion", "bitcrusher", "lofi", "telephone", "radio", "megaphone", "walkie_talkie",
    "underwater", "next_room", "vinyl", "guitar_amp", "invert", "silence", "channel_swap", "left_only", "right_only", "invert_polarity", "mono_to_stereo", "delay_sync"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.deepEqual(Object.keys(SNAP).sort(), [...ids].sort());
});

test("every effect's filtergraph matches its snapshot (defaults and the override values)", () => {
  const now = snapshots();
  for (const id of Object.keys(SNAP)) {
    assert.equal(now[id].defaults, SNAP[id].defaults, `${id} (defaults)`);
    assert.equal(now[id].values, SNAP[id].values, `${id} (values ${JSON.stringify(OVERRIDES[id] ?? {})})`);
  }
});

test("the mappings the WebAudio preview matches", () => {
  // shelves Q 0.7071; filters t=q:w=<q>; graphic EQ Q 1.41
  assert.equal(render("eq3", { low: 3, high: -2 }).graph, "[0:a]lowshelf=f=200:t=q:w=0.7071:g=3,highshelf=f=4000:t=q:w=0.7071:g=-2[out]");
  assert.equal(render("highpass", { frequency: 120, q: 2 }).graph, "[0:a]highpass=f=120:t=q:w=2[out]");
  assert.equal(render("eq_graphic", { b1k: -4 }).graph, "[0:a]equalizer=f=1000:t=q:w=1.41:g=-4[out]");
  // acompressor: detection peak, knee 10^(knee/20) clamped to 1..8, no automatic make-up
  assert.equal(render("compressor", { threshold: -20, ratio: 3, attack: 0.005, release: 0.15, makeup: 4, knee: 30 }).graph,
    "[0:a]acompressor=threshold=0.1:ratio=3:attack=5:release=150:makeup=1.584893:knee=8:detection=peak[out]");
  // alimiter level 0, limit 10^(ceiling/20); agate peak detection, knee 2.828, ratio
  assert.equal(render("limiter", { ceiling: -2 }).graph, "[0:a]alimiter=limit=0.794328:attack=5:release=50:level=0:latency=1[out]");
  assert.match(render("gate", { ratio: 4 }).graph, /agate=threshold=0\.003162:range=0\.01:ratio=4:attack=5:release=120:detection=peak:knee=2\.828/);
  // bitcrusher: FFmpeg's acrusher reduces the rate only on its mix side, so two passes (hold, then bits) and a dry mix
  assert.equal(render("bitcrusher", { bits: 6, samples: 8 }).graph,
    "[0:a]acrusher=bits=64:samples=8:mix=1:aa=0:dc=1:mode=lin,acrusher=bits=6:samples=1:mix=0:aa=0:dc=1:mode=lin[out]");
  assert.equal(render("bitcrusher", { mix: 0 }).graph, "[0:a]anull[out]");
  // echo: taps at k·delay, decays wet·feedback^(k−1) until −60 dB
  assert.equal(echoFilter(250, 0.5, 0.5), "aecho=in_gain=1:out_gain=1:delays=250|500|750|1000|1250|1500|1750|2000|2250:decays=0.5|0.25|0.125|0.0625|0.03125|0.015625|0.007813|0.003906|0.001953");
  assert.equal(echoFilter(100, 0, 0.4), "aecho=in_gain=1:out_gain=1:delays=100:decays=0.4");
  // reverb = dry·(1 − mix) + wet·mix, the IR through afir without normalisation, pre-delay and M/S width on the wet
  assert.equal(render("reverb", { preset: "plate", mix: 0.25, predelay: 20, width: 0.5 }).graph, [
    "[0:a]asplit=2[c0e0d][c0e0w]",
    "amovie=filename='irs/plate.wav',aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[c0e0ir]",
    "[c0e0w]adelay=delays=20:all=1[c0e0w2]",
    "[c0e0w2][c0e0ir]afir=irnorm=-1:irgain=1,extrastereo=m=0.5:c=0[c0e0wet]",
    "[c0e0d][c0e0wet]amix=inputs=2:weights='0.75 0.25':normalize=0:duration=first[c0g0]",
    "[c0g0]anull[out]"].join(";"));
  // haas: one channel delayed, the other untouched (FFmpeg's haas filter rebuilds both from the mid)
  assert.equal(render("haas", { delay: 12 }).graph, "[0:a]adelay=delays=0|12:all=0[out]");
  assert.ok(render("haas", {}).changesLength);
});

test("noise print learns from the marked source range (amovie seek), then reduces; without a source it uses chain seconds", () => {
  const g = render("noise_print", { reduction: 18, noiseStart: 4, noiseEnd: 5.5 }).graph;
  assert.ok(g.startsWith("amovie=filename='D\\:/m/src.wav':seek_point=4,atrim=0:1.5,asetpts=PTS-STARTPTS,aresample=48000,"));
  assert.match(g, /asendcmd=c='0\.000 afftdn@c0e0nr sample_noise start;1\.500 afftdn@c0e0nr sample_noise stop',afftdn@c0e0nr=nr=18:nf=-50:tn=0,atrim=start=1\.5/);
  const fx = buildFx([{ id: "n", type: "audio:noise_print", enabled: true, params: { noiseStart: { value: 1 }, noiseEnd: { value: 2 } } }],
    { uid: "t0", duration: 10, fps: 25, shift: 0, irFile: (n) => n, warn: () => undefined });
  assert.match(layChain("in", [], fx.steps, [], "out", "t0").join(";"), /\[in\]asplit=2\[t0e0a\]\[t0e0b\];\[t0e0a\]atrim=1:2,asetpts=PTS-STARTPTS\[t0e0n\]/);
});

test("keyframes: asendcmd for filters with commands, an expression for gain, the first keyframe (and a warning) otherwise", () => {
  const kf = (a: number, b: number) => ({ value: a, keyframes: [{ frame: 0, value: a, ease: "linear" as const }, { frame: 25, value: b, ease: "linear" as const }] });
  const warns: string[] = [];
  const ctx = { uid: "c1", duration: 2, fps: 25, shift: 0.5, irFile: (n: string) => n, warn: (w: string) => warns.push(w) };
  const eq = buildFx([{ id: "e", type: "audio:eq3", enabled: true, params: { low: kf(-6, 6) } }], ctx).steps;
  assert.match(String(eq[0]), /^asendcmd=c='0\.500 lowshelf@c1e0i0 g -6;0\.550 lowshelf@c1e0i0 g -5\.4;/);
  assert.match(String(eq[0]), /1\.500 lowshelf@c1e0i0 g 6'$/);
  assert.equal(eq[1], "lowshelf@c1e0i0=f=200:t=q:w=0.7071:g=-6");
  const gain = buildFx([{ id: "g", type: "audio:gain", enabled: true, params: { gain: kf(0, -12) } }], ctx).steps;
  assert.deepEqual(gain, ["volume='pow(10,(if(lt(t,0.5),0,if(lt(t,1.5),0+-12*(t-0.5)/1,-12)))/20)':eval=frame"]);
  const echo = buildFx([{ id: "x", type: "audio:echo", enabled: true, params: { delay: kf(100, 400) } }], ctx).steps;
  assert.deepEqual(echo, ["aecho=in_gain=1:out_gain=1:delays=100|200|300|400|500|600|700:decays=0.5|0.2|0.08|0.032|0.0128|0.00512|0.002048"]);
  assert.match(warns[0], /Echo: Delay keyframes aren't in the export/);
  assert.equal(pwlAt([[0, 0, "ease_in"], [1, 10, "linear"]], 0.5), 1.25); // ease_in is t³, as the editor draws it
});

test("ids: the audio: prefix, the editor's aliases, disabled and unknown effects", () => {
  assert.equal(audioFxId("audio:eq"), "eq3");
  assert.equal(audioFxId("audio:noise_gate"), "gate");
  assert.equal(audioFxId("surround_reverb"), "reverb");
  assert.equal(audioFxId("audio:pitch_bend"), "pitch_bend");
  const warns: string[] = [];
  const fx = buildFx([
    { id: "a", type: "audio:eq", enabled: true, params: { high: { value: 2 } } },
    { id: "b", type: "audio:compressor", enabled: false, params: {} },
    { id: "c", type: "audio:spectral_heal", enabled: true, params: {} },
    { id: "d", type: "pixelate", enabled: true, params: {} },
  ], { uid: "c0", duration: 1, fps: 25, shift: 0, irFile: (n) => n, warn: (w) => warns.push(w) });
  assert.deepEqual(fx.steps, ["highshelf=f=4000:t=q:w=0.7071:g=2"]);
  assert.deepEqual(warns, ["the spectral_heal effect isn't in the export yet"]);
});

test("impulse responses: a verbatim copy of the frontend recipe, deterministic float WAVs with unit energy", () => {
  const front = path.join(here, "..", "..", "frontend", "src", "editor", "audiofx", "ir.ts");
  if (existsSync(front)) assert.equal(readFileSync(path.join(here, "..", "src", "main", "audiofx-ir.ts"), "utf8"), readFileSync(front, "utf8"), "audiofx-ir.ts must stay a verbatim copy");
  assert.deepEqual(REVERB_IRS, ["room", "studio", "hall", "plate", "church", "cathedral", "stage", "bathroom", "stairwell"]);
  assert.deepEqual(CABINET_IRS, ["cab_1x12", "cab_2x12", "cab_4x12"]);
  assert.equal(IR_NAMES.length, 12);
  const a = presetWav("room");
  const b = presetWav("room");
  assert.equal(createHash("sha1").update(a).digest("hex"), createHash("sha1").update(b).digest("hex"));
  assert.equal(a.toString("ascii", 0, 4), "RIFF");
  assert.equal(a.readUInt16LE(20), 3); // IEEE float
  assert.equal(a.readUInt16LE(22), 2);
  assert.equal(a.readUInt32LE(24), 48000);
  let e = 0;
  for (let i = 44; i < a.length; i += 8) e += a.readFloatLE(i) ** 2; // left channel
  assert.ok(Math.abs(e - 1) < 1e-3, `unit energy (${e})`);
});
