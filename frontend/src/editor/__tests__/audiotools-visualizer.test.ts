/**
 * The audio-reactive visualiser (editor/audiotools/spectrum.ts, visualizer.ts, source.ts): spectrum frames from
 * synthetic sound, band mapping, the sidecar, frame determinism (any order, preview or export range), drawing, and the
 * composition pass that turns a visualiser clip into a generated picture.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBase64, toBase64 } from "../audiotools/dsp.ts";
import { withVisualizers, type VisualizerGenerated } from "../audiotools/source.ts";
import { bandEdges, frameAt, fromByte, fromSidecar, SPECTRUM_RATE, SpectrumBuilder, spectraNeeded, spectrumKey, spectrumOf, spectrumSidecarName, toSidecar, type SpectrumData } from "../audiotools/spectrum.ts";
import { barMap, drawVisualizer, frameValues, makeVisualizerSource, rawValues, VISUALIZER_STYLES, visualizerSettings, type Ctx2D } from "../audiotools/visualizer.ts";
import { baseClip } from "../model/defaults.ts";
import { ctxOf, normalize } from "../model/ops.ts";
import { toVideoComposition } from "../model/toComposition.ts";
import { fpsExact } from "../model/time.ts";
import type { EditProject } from "../model/types.ts";
import { A, project, seqOf, V } from "./fixtures.ts";

const sine = (f: number, db: number, seconds: number, rate = SPECTRUM_RATE) =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => Math.pow(10, db / 20) * Math.sin((2 * Math.PI * f * i) / rate));

test("spectrum frames: a sine lands in its band at its level, and the level byte follows the RMS", () => {
  const x = sine(1000, -6, 2);
  const { frames, data } = spectrumOf(x, 25, 64);
  assert.equal(frames, 50);
  const e = bandEdges(64);
  const band = e.findIndex((f, i) => f <= 1000 && e[i + 1] > 1000);
  const f = data.subarray(20 * 65, 21 * 65);
  const peak = f.subarray(0, 64).reduce((m, v, i, a) => (v > a[m] ? i : m), 0);
  assert.equal(peak, band);
  assert.ok(Math.abs(fromByte(f[band]) - -6) < 0.8, `band level ${fromByte(f[band])}`);
  assert.ok(fromByte(f[5]) < -50, "far bands stay low");
  assert.ok(Math.abs(fromByte(f[64]) - -6) < 0.6, `frame level ${fromByte(f[64])}`);
  // silence reads the floor
  const z = spectrumOf(new Float32Array(SPECTRUM_RATE), 30, 32);
  assert.equal(z.frames, 30);
  assert.ok(z.data.every((v) => v === 0));
});

test("spectrum frames stream: chunks give the same bytes, at NTSC rates too", () => {
  const x = Float32Array.from({ length: SPECTRUM_RATE * 3 }, (_, i) => Math.sin(i * 0.05) * 0.3 + Math.sin(i * 0.9) * 0.1 * Math.sin(i / 4000));
  for (const fps of [25, 29.97, 23.976]) {
    const whole = spectrumOf(x, fps, 48);
    const b = new SpectrumBuilder(fps, 48);
    for (let i = 0, k = 333; i < x.length; i += k, k = (k * 5) % 7919 + 101) b.push(x.subarray(i, i + k));
    const parts = b.finish();
    assert.equal(parts.frames, Math.ceil(x.length / (SPECTRUM_RATE / fpsExact(fps))));
    assert.deepEqual(parts.data, whole.data, `fps ${fps}`);
  }
});

test("the sidecar round-trips; base64 matches Node's; names are safe", () => {
  const x = sine(300, -12, 1);
  const s = spectrumOf(x, 25, 64);
  const d: SpectrumData = { mediaId: "m_abc", fps: 25, bands: 64, fMin: 30, fMax: 16000, frames: s.frames, data: s.data };
  const j = JSON.parse(JSON.stringify(toSidecar(d, { size: 10, mtimeMs: 5 })));
  assert.deepEqual(fromSidecar(j), d);
  assert.equal(fromSidecar({ ...j, frames: j.frames + 1 }), null);
  assert.equal(fromSidecar({ ...j, format: "x" }), null);
  for (const n of [0, 1, 2, 3, 100, 1001]) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
    assert.equal(toBase64(b), Buffer.from(b).toString("base64"));
    assert.deepEqual(fromBase64(toBase64(b)), b);
  }
  assert.match(spectrumSidecarName("m/../x y", 29.97, 64), /^spectrum-[A-Za-z0-9_-]+-29\.97-64$/);
  assert.equal(spectrumKey("m1", 59.94), "m1|59.94|64");
});

test("band mapping: bars span the frequency range in order, each over the bands it covers", () => {
  const m = barMap(64, 30, 16000, 48, 40, 12000);
  assert.equal(m.spans.length, 48);
  for (let j = 1; j < 48; j++) assert.ok(m.spans[j].at > m.spans[j - 1].at && m.spans[j].i0 >= m.spans[j - 1].i0);
  assert.ok(m.spans[0].i0 <= 2 && m.spans[47].i1 >= 56);
  // more bars than bands in the range: narrow bars interpolate (i0 = i1)
  assert.ok(barMap(64, 30, 16000, 128, 40, 12000).spans.some((s) => s.i0 === s.i1));
  // the bar holding 1 kHz is the tallest for a 1 kHz sine
  const sp = spectrumOf(sine(1000, -10, 1), 25, 64);
  const d: SpectrumData = { mediaId: "m", fps: 25, bands: 64, fMin: 30, fMax: 16000, frames: sp.frames, data: sp.data };
  const set = visualizerSettings({ bars: 32, freqMin: 100, freqMax: 8000 });
  const v = rawValues(d, 10, set, barMap(64, 30, 16000, 32, 100, 8000)).bars;
  const top = v.reduce((mm, x, i, a) => (x > a[mm] ? i : mm), 0);
  const fc = (j: number) => 100 * Math.pow(80, (j + 0.5) / 32);
  assert.ok(Math.abs(Math.log2(fc(top) / 1000)) < 0.25, `bar ${top} at ${fc(top).toFixed(0)} Hz`);
  // sensitivity scales, the range clips
  assert.ok(rawValues(d, 10, { ...set, sensitivity: 2 }, barMap(64, 30, 16000, 32, 100, 8000)).bars[top] >= v[top]);
});

test("frame values are the same in any order, smoothing looks back, outside the audio is silence", () => {
  const x = Float32Array.from({ length: SPECTRUM_RATE * 2 }, (_, i) => (Math.floor(i / 6400) % 2 ? 0.5 : 0.005) * Math.sin(i * 0.2));
  const sp = spectrumOf(x, 25, 64);
  const d: SpectrumData = { mediaId: "m", fps: 25, bands: 64, fMin: 30, fMax: 16000, frames: sp.frames, data: sp.data };
  const s = visualizerSettings({ smoothing: 0.7, bars: 24 });
  const forward = Array.from({ length: sp.frames }, (_, n) => Array.from(frameValues(d, n, s).bars));
  const order = Array.from({ length: sp.frames }, (_, n) => (n * 17) % sp.frames);
  for (const n of order) assert.deepEqual(Array.from(frameValues(d, n, s).bars), forward[n]);
  // loud from frame 5 to 9, quiet 10..: with smoothing the bars fall gradually after the loud part
  const tot = (n: number) => forward[n].reduce((a, b) => a + b, 0);
  assert.ok(tot(10) < tot(9) && tot(10) > tot(13), "decays over a few frames");
  const none = visualizerSettings({ smoothing: 0, bars: 24 });
  assert.ok(frameValues(d, 11, none).bars.reduce((a, b) => a + b, 0) < tot(11));
  // frames outside the audio clip's range draw nothing
  assert.ok(frameValues(d, 7, s, (k) => k > 20).bars.every((v) => v === 0));
  assert.ok(frameValues(null, 7, s).bars.every((v) => v === 0));
  // media time → frame, robust at exact frame times
  assert.equal(frameAt(0.4, 25), 10); assert.equal(frameAt(10 / fpsExact(29.97), 29.97), 10); assert.equal(frameAt(-0.01, 25), -1);
});

/** A Canvas 2D stand-in that records every call. */
function recorder(): Ctx2D & { log: string[] } {
  const log: string[] = [];
  const rec = (name: string) => (...a: unknown[]) => { log.push(`${name}(${a.map((v) => (typeof v === "number" ? v.toFixed(2) : String(v))).join(",")})`); };
  const grad = () => ({ addColorStop: rec("stop") });
  const o: Record<string, unknown> = { log };
  for (const k of ["save", "restore", "clearRect", "fillRect", "beginPath", "moveTo", "lineTo", "quadraticCurveTo", "closePath", "fill", "stroke", "arc"]) o[k] = rec(k);
  o.createLinearGradient = (...a: unknown[]) => { rec("lin")(...a); return grad(); };
  o.createRadialGradient = (...a: unknown[]) => { rec("rad")(...a); return grad(); };
  for (const k of ["fillStyle", "strokeStyle", "lineWidth", "lineCap", "lineJoin", "shadowColor", "shadowBlur", "globalAlpha"]) {
    let v: unknown;
    Object.defineProperty(o, k, { get: () => v, set: (x) => { v = x; log.push(`${k}=${typeof x === "object" ? "gradient" : String(x)}`); } });
  }
  return o as unknown as Ctx2D & { log: string[] };
}

test("drawing: every style draws, the same frame twice is the same picture, bounds hold the drawing", () => {
  assert.deepEqual(VISUALIZER_STYLES.map((x) => x.id), ["bars", "mirror", "line", "circle", "particles", "fill"]);
  const v = { bars: Float32Array.from({ length: 32 }, (_, i) => (i % 5) / 5), level: 0.6 };
  for (const st of VISUALIZER_STYLES) {
    const s = visualizerSettings({ style: st.id, bars: 32, glow: 0.5 });
    const a = recorder(), b = recorder();
    const box = drawVisualizer(a, 1920, 1080, v, s, 2.5);
    drawVisualizer(b, 1920, 1080, v, s, 2.5);
    assert.ok(a.log.length > 10, st.id);
    assert.deepEqual(a.log, b.log, `${st.id} is deterministic`);
    assert.equal(a.log[0], "clearRect(0.00,0.00,1920.00,1080.00)");
    assert.ok(box[2] > 0 && box[3] > 0 && box[0] >= s.box[0] * 1920 - 200 && box[0] + box[2] <= (s.box[0] + s.box[2]) * 1920 + 200);
  }
  // particles move with time; bars don't
  const p = visualizerSettings({ style: "particles" }), r1 = recorder(), r2 = recorder();
  drawVisualizer(r1, 640, 360, v, p, 1); drawVisualizer(r2, 640, 360, v, p, 1.04);
  assert.notDeepEqual(r1.log, r2.log);
  const bg = recorder();
  assert.deepEqual(drawVisualizer(bg, 640, 360, v, visualizerSettings({ background: "#000" }), 0), [0, 0, 640, 360]);
});

test("makeVisualizerSource: defaults, clamping, needs a sound", () => {
  const s = makeVisualizerSource({ audioClipId: "c1", style: "circle", glow: 5, bars: 1000, colors: ["#fff"] });
  assert.equal(s.type, "visualizer"); assert.equal(s.style, "circle"); assert.equal(s.glow, 1); assert.equal(s.bars, 128); assert.deepEqual(s.colors, ["#fff"]);
  assert.equal(s.audioClipId, "c1"); assert.equal(s.mediaId, undefined);
  assert.throws(() => makeVisualizerSource({}));
  assert.equal(visualizerSettings({ style: "nope" as never }).style, "bars");
  const r = visualizerSettings({ freqMin: 5000, freqMax: 4000 });
  assert.ok(r.freqMax >= r.freqMin * 1.5);
});

/** An edit with a 25 fps sequence: music on A1 from frame 50 (source in 2 s), a visualiser following it on V2. */
function edit(speed = 1): EditProject {
  const p = project();
  const s0 = seqOf(p);
  const music = { ...baseClip(s0, A(s0, 0).id, 50, 200, { type: "media", mediaId: "music", in: 50 }, "Music"), speed };
  const viz = baseClip(s0, V(s0, 1).id, 75, 100, makeVisualizerSource({ audioClipId: music.id, style: "bars" }), "Audio visualiser");
  const s = normalize({ ...s0, clips: [music, viz] }, ctxOf(p));
  p.sequences = [s];
  return p;
}

test("the composition pass: a visualiser clip becomes a generated picture that follows its audio clip", () => {
  const p = edit();
  const s = p.sequences[0];
  const viz = s.clips.find((c) => c.source.type === "visualizer")!;
  const r = withVisualizers(p, s.id, toVideoComposition(p, s.id));
  const ec = r.comp.tracks.flatMap((t) => t.clips).find((c) => c.id === viz.id)!;
  assert.match(ec.media.url, /^gen:viz:/);
  const g = r.generated[ec.media.url] as unknown as VisualizerGenerated;
  assert.equal(g.kind, "visualizer"); assert.equal(g.key, spectrumKey("music", 25, 64)); assert.equal(g.width, 1920);
  // music source in = 50 frames of the 25 fps media = 2 s; the visualiser starts 1 s into the music clip → 3 s
  assert.ok(Math.abs(g.offset - 3) < 1e-9 && g.rate === 1 && Math.abs(g.lo - 2) < 1e-9 && Math.abs(g.hi - 10) < 1e-9);
  // at twice the speed the audio runs twice as fast
  const p2 = edit(2), s2 = p2.sequences[0];
  const r2 = withVisualizers(p2, s2.id, toVideoComposition(p2, s2.id));
  const g2 = Object.values(r2.generated)[0] as unknown as VisualizerGenerated;
  assert.equal(g2.rate, 2); assert.ok(Math.abs(g2.offset - 4) < 1e-9);
  assert.deepEqual(spectraNeeded(p), [{ mediaId: "music", fps: 25, bands: 64, key: "music|25|64" }]);
});

test("preview and an export range show the same spectrum frame at the same sequence frame", () => {
  const p = edit();
  const s = p.sequences[0];
  const viz = s.clips.find((c) => c.source.type === "visualizer")!;
  const full = withVisualizers(p, s.id, toVideoComposition(p, s.id));
  const part = withVisualizers(p, s.id, toVideoComposition(p, s.id, { range: [110, 160] }));
  const pick = (r: typeof full) => {
    const c = r.comp.tracks.flatMap((t) => t.clips).find((x) => x.id === viz.id)!;
    return { c, g: r.generated[c.media.url] as unknown as VisualizerGenerated };
  };
  const a = pick(full), b = pick(part);
  for (const f of [110, 123, 137, 159]) {
    // the source time the engine asks the picture for: in + (t − start) · speed (engine/timeline.ts sourceTime)
    const tA = a.c.in + (f / 25 - a.c.start) * a.c.speed, tB = b.c.in + ((f - 110) / 25 - b.c.start) * b.c.speed;
    assert.equal(frameAt(a.g.offset + tA * a.g.rate, 25), frameAt(b.g.offset + tB * b.g.rate, 25), `frame ${f}`);
  }
});

test("frames an export carries on its project are used", () => {
  const p = edit();
  const s = p.sequences[0];
  const sp = spectrumOf(sine(500, -20, 1), 25, 64);
  const d: SpectrumData = { mediaId: "music", fps: 25, bands: 64, fMin: 30, fMax: 16000, frames: sp.frames, data: sp.data };
  const withFrames = { ...p, spectra: { [spectrumKey("music", 25)]: toSidecar(d) } } as unknown as EditProject;
  withVisualizers(withFrames, s.id, toVideoComposition(withFrames, s.id));
  // the cache now has them (cachedSpectrum is what the custom source draws from)
  return import("../audiotools/source.ts").then((m) => { assert.deepEqual(m.cachedSpectrum(spectrumKey("music", 25)), d); });
});
