/**
 * The audio tools' desktop analysis (src/main/editor-audiotools.ts): FFmpeg arguments, PCM reassembly, breaths and
 * room tone through a fake FFmpeg that streams synthetic sound (and answers silencedetect from it), the spectrum
 * sidecar cache, the frames an export carries, and the IPC checks. Portable: temp files under os.tmpdir().
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  attachSpectra, audioAnalysisOptions, AudioToolsManager, f32Reader, pcmArgs, quietArgs, registerAudioToolsIpc, spectrumFor,
} from "../src/main/editor-audiotools.ts";
import type { MediaTools } from "../src/main/editor.ts";
import type { EditProject, MediaItem } from "../src/shared/types.ts";
import { matchRanges } from "../../frontend/src/editor/audiotools/breaths.ts";
import { featuresOf } from "../../frontend/src/editor/audiotools/features.ts";
import { silenceSegments } from "../../frontend/src/editor/audiotools/roomtone.ts";
import { fromSidecar, spectrumKey, spectrumOf } from "../../frontend/src/editor/audiotools/spectrum.ts";
import { syntheticSpeech } from "../../frontend/src/editor/__tests__/audiotools-fixtures.ts";

test("FFmpeg arguments: mono float PCM of a range, silencedetect over the same range", () => {
  assert.deepEqual(pcmArgs("a.wav", 16000), ["-i", "a.wav", "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]);
  assert.deepEqual(pcmArgs("a.mp4", 16000, 12.5, 20.25), ["-ss", "11.5", "-i", "a.mp4", "-vn", "-af", "atrim=start=1:duration=7.75,asetpts=PTS-STARTPTS",
    "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]);
  assert.deepEqual(quietArgs("a.mp4", -40, 0.12, 0.5, 3), ["-i", "a.mp4", "-vn", "-af", "atrim=start=0.5:duration=2.5,asetpts=PTS-STARTPTS,silencedetect=noise=-40dB:d=0.120", "-f", "null", "-"]);
  assert.deepEqual(quietArgs("a.wav", -48.5, 0.5), ["-i", "a.wav", "-vn", "-af", "silencedetect=noise=-48.5dB:d=0.500", "-f", "null", "-"]);
});

test("PCM chunks of any size become the same samples", () => {
  const x = Float32Array.from({ length: 1001 }, (_, i) => Math.sin(i) * 0.5);
  const bytes = Buffer.from(x.buffer);
  const got: number[] = [];
  const read = f32Reader((s) => got.push(...s));
  for (let i = 0, k = 1; i < bytes.length; i += k, k = (k % 13) + 1) read(bytes.subarray(i, i + k));
  assert.deepEqual(Float32Array.from(got), x);
});

/** A fake FFmpeg over a signal: f32le output streams it (resampled by picking, the tests use its own rate); silencedetect is answered from its levels. */
function fakeTools(samples: Float32Array, rate: number, calls: string[][] = []): MediaTools {
  return {
    probe: async () => { throw new Error("no probe"); },
    run: async () => undefined,
    peaks: async () => [],
    lines: async (args, onLine, o) => {
      calls.push(args);
      const af = args[args.indexOf("-af") + 1] ?? "";
      const ss = args.includes("-ss") ? Number(args[args.indexOf("-ss") + 1]) : 0;
      const st = /atrim=start=([\d.]+)(?::duration=([\d.]+))?/.exec(af);
      const a = ss + (st ? Number(st[1]) : 0), b = st?.[2] ? a + Number(st[2]) : samples.length / rate;
      const part = samples.subarray(Math.round(a * rate), Math.min(samples.length, Math.round(b * rate)));
      if (args.includes("f32le")) {
        const buf = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
        for (let i = 0, k = 4093; i < buf.length; i += k, k = k === 4093 ? 777 : 4093) o?.stdout?.(Buffer.from(buf.subarray(i, i + k)));
        return;
      }
      const sd = /silencedetect=noise=(-?[\d.]+)dB:d=([\d.]+)/.exec(af);
      if (sd) {
        const f = featuresOf(part, rate, { spectral: false });
        for (const s of silenceSegments(f.rms, f.hopS, Number(sd[1]), Number(sd[2]))) {
          onLine(`[silencedetect @ 0] silence_start: ${s.start}`);
          onLine(`[silencedetect @ 0] silence_end: ${s.end} | silence_duration: ${(s.end - s.start).toFixed(3)}`);
        }
      }
    },
  };
}

const item = (over: Partial<MediaItem> = {}): MediaItem => ({ id: "m_voice", binId: null, name: "voice.wav", kind: "audio", path: "", duration: 60 * 48000, fps: 48000,
  width: 0, height: 0, hasAudio: true, markers: [], seconds: 60, ...over });

test("breaths through the desktop path: found in the clip's range, in media seconds", async () => {
  const sp = syntheticSpeech(11);
  const calls: string[][] = [];
  const mgr = new AudioToolsManager({ log: () => undefined, editor: {
    mediaFile: async () => ({ item: item(), src: "voice.wav", dir: os.tmpdir(), tools: fakeTools(sp.samples, sp.rate, calls) }),
    readSidecar: async () => null, writeSidecar: async () => ({ bytes: 0 }),
  } as never });
  const all = await mgr.analyze("x.tatvamedit", "m_voice", "breaths");
  assert.ok(all.kind === "breaths");
  if (all.kind !== "breaths") return;
  const m = matchRanges(all.breaths, sp.breaths);
  assert.ok(m.precision >= 0.9 && m.recall >= 0.9, JSON.stringify(m));
  assert.ok(calls.some((c) => c.includes("f32le")) && calls.some((c) => c.join(" ").includes("silencedetect")), "PCM and silencedetect");
  // a range: the same breaths, still in media seconds
  const part = await mgr.analyze("x.tatvamedit", "m_voice", "breaths", { in: 20, out: 45 });
  if (part.kind !== "breaths") throw new Error("kind");
  const want = sp.breaths.filter((b) => b.start >= 20.05 && b.end <= 44.95);
  const pm = matchRanges(part.breaths, want);
  assert.ok(pm.recall >= 0.9 && pm.precision >= 0.9, JSON.stringify(pm));
  assert.ok(part.breaths.every((b) => b.start >= 20 && b.end <= 45));
  await assert.rejects(mgr.analyze("x.tatvamedit", "m_voice", "breaths", { in: 5, out: 4 }), /out point/);
});

test("room tone through the desktop path", async () => {
  const rate = 16000;
  const x = new Float32Array(rate * 12);
  let seed = 3;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < x.length; i++) x[i] = rnd() * 0.01;                    // room ≈ −51 dBFS
  for (let i = 4 * rate; i < 8 * rate; i++) x[i] *= 0.4;                      // quieter pause 4–8 s
  for (const [a, b] of [[0.2, 3.8], [8.2, 11.8]]) for (let i = a * rate; i < b * rate; i++) x[Math.round(i)] += 0.2 * Math.sin(i * 0.06) * Math.sin(i * 0.0007);
  const mgr = new AudioToolsManager({ log: () => undefined, editor: {
    mediaFile: async () => ({ item: item({ seconds: 12 }), src: "voice.wav", dir: os.tmpdir(), tools: fakeTools(x, rate) }),
    readSidecar: async () => null, writeSidecar: async () => ({ bytes: 0 }),
  } as never });
  const r = await mgr.analyze("x.tatvamedit", "m_voice", "roomtone");
  if (r.kind !== "roomtone") throw new Error("kind");
  assert.ok(r.stretch && r.stretch.start >= 4 && r.stretch.end <= 8 && r.stretch.end - r.stretch.start >= 2.9, JSON.stringify(r));
  assert.ok(r.silences >= 1 && r.thresholdDb < -25);
});

test("spectrum frames: computed once, then read from the sidecar until the file changes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-audiotools-"));
  try {
    const src = path.join(dir, "music.wav");
    writeFileSync(src, "not really a wav");
    const rate = 32000;
    const x = Float32Array.from({ length: rate * 2 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate));
    const store = new Map<string, unknown>();
    const calls: string[][] = [];
    const o = { src, mediaId: "m_music", fps: 25, bands: 64, lines: fakeTools(x, rate, calls).lines,
      read: async (n: string) => store.get(n) ?? null, write: async (n: string, j: unknown) => { store.set(n, JSON.parse(JSON.stringify(j))); } };
    const a = await spectrumFor(o);
    assert.equal(a.cached, false); assert.equal(a.name, "spectrum-m_music-25-64");
    const d = fromSidecar(a.spectrum)!;
    assert.equal(d.frames, 50);
    assert.deepEqual(d.data, spectrumOf(x, 25, 64).data, "the same frames as the pure code");
    const b = await spectrumFor(o);
    assert.equal(b.cached, true); assert.equal(calls.length, 1);
    // the file changed: made again
    utimesSync(src, new Date(), new Date(Date.now() + 5000));
    assert.equal((await spectrumFor(o)).cached, false);
    assert.equal(calls.length, 2);
    // an export's project gets the frames its visualisers need
    const project = {
      media: [{ ...item({ id: "m_music", path: src }) }, { ...item({ id: "m_quiet", path: src, hasAudio: false, kind: "video" }) }],
      sequences: [{ id: "s1", fps: 25, clips: [
        { id: "a1", trackId: "A1", source: { type: "media", mediaId: "m_music", in: 0 } },
        { id: "v1", trackId: "V2", source: { type: "visualizer", audioClipId: "a1", style: "bars", colors: [] } },
        { id: "v2", trackId: "V3", source: { type: "visualizer", mediaId: "m_quiet", style: "bars", colors: [] } },
      ] }],
    } as unknown as EditProject;
    const n = await attachSpectra(project, { lines: o.lines, read: o.read, write: o.write, log: () => undefined });
    assert.equal(n, 1);
    const spectra = (project as unknown as { spectra: Record<string, unknown> }).spectra;
    assert.deepEqual(Object.keys(spectra), [spectrumKey("m_music", 25, 64)]);
    assert.equal(calls.length, 2, "read from the sidecar");
    // nothing to attach without visualisers
    assert.equal(await attachSpectra({ media: [], sequences: [{ fps: 25, clips: [] }] } as unknown as EditProject, { ...o, log: () => undefined }), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("IPC: only the gateway's pages, known kinds, options checked", async () => {
  const seen: unknown[][] = [];
  let handler: ((e: { senderFrame?: { url?: string } | null }, ...a: unknown[]) => unknown) | null = null;
  registerAudioToolsIpc({ handle: (_c, l) => { handler = l; } }, (u) => u.startsWith("http://127.0.0.1:1234/"),
    { analyze: async (...a: unknown[]) => { seen.push(a); return { kind: "breaths" } as never; } }, "tatvam:editor.audioAnalysis");
  const h = handler!;
  await assert.rejects(async () => h({ senderFrame: { url: "https://evil.example/" } }, "e.tatvamedit", "m1", "breaths"), /Not allowed/);
  await assert.rejects(async () => h({ senderFrame: { url: "http://127.0.0.1:1234/editor" } }, "e.tatvamedit", "m1", "format_c"), /Unknown/);
  await h({ senderFrame: { url: "http://127.0.0.1:1234/editor" } }, "e.tatvamedit", "m1", "spectrum", { fps: 29.97, bands: 64, junk: 1, in: -5, threshold: 3 });
  assert.deepEqual(seen[0], ["e.tatvamedit", "m1", "spectrum", { fps: 29.97, bands: 64 }]);
  assert.deepEqual(audioAnalysisOptions({ fps: 31, bands: 7.5, in: 2, out: 9, minS: 1, maxS: 3, threshold: 0.6 }), { in: 2, out: 9, threshold: 0.6, minS: 1, maxS: 3 });
});
