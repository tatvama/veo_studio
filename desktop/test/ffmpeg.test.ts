/**
 * FFmpeg runners without FFmpeg: a Node script stands in for the binary (`spawnImpl`). The GPU frame pipe settles a
 * waiting write when FFmpeg dies, stops reading or is closed; progress blocks are read by line however the chunks
 * arrive; the stall watchdog and the hard timeout kill a run that makes no progress; `ffmpeg -i` is parsed once for
 * size, streams and frame rate.
 */
import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { test } from "node:test";
import { FfmpegError, parseMediaInfo, progressReader, runFfmpeg, spawnFfmpegPipe, type FfProgress } from "../src/main/ffmpeg.ts";

/** A fake FFmpeg: Node running `script`, with the stdio the caller asked for. */
const fake = (script: string) => (_cmd: string, _args: string[], o: SpawnOptions) => spawn(process.execPath, ["-e", script], { ...o, windowsHide: true });

const big = new Uint8Array(8 * 1024 * 1024); // far more than a pipe holds, so the write has to wait for the reader

test("progressReader: a block split over chunks is reported once, complete", () => {
  const seen: FfProgress[] = [];
  const read = progressReader((p) => seen.push(p));
  read("frame=5\nfps=0.0\nout_time_us=20");
  assert.equal(seen.length, 0);
  read("00000\nspeed=1.2x\nprog");
  assert.equal(seen.length, 0);
  read("ress=continue\nframe=6\nout_time_us=2041667\nspeed=1.3x\nprogress=end\n");
  assert.deepEqual(seen.map((p) => [p.frame, p.outTimeS, p.speed]), [[5, 2, "1.2x"], [6, 2.041667, "1.3x"]]);
});

test("pipe: a write waiting for room is rejected when ffmpeg dies, and end() reports the exit", async () => {
  // never reads stdin, exits with 3 after a moment
  const pipe = spawnFfmpegPipe("ffmpeg", [], { spawnImpl: fake("setTimeout(() => process.exit(3), 250)") });
  const t0 = Date.now();
  await assert.rejects(pipe.write(big), (e: Error) => e instanceof FfmpegError && /exited \(3\)|stopped reading frames/.test(e.message));
  assert.ok(Date.now() - t0 < 5000, "settled as soon as the child went, not by a timeout");
  await assert.rejects(pipe.write(new Uint8Array(4)), (e: Error) => e instanceof FfmpegError); // later writes fail at once
  await assert.rejects(pipe.end(), (e: Error) => e instanceof FfmpegError && /\(3\)/.test(e.message));
});

test("pipe: end() rejects a frame still waiting instead of leaving it hanging", async () => {
  // reads nothing until stdin closes, then exits cleanly
  const pipe = spawnFfmpegPipe("ffmpeg", [], { spawnImpl: fake("process.stdin.on('end', () => process.exit(0)); setTimeout(() => process.stdin.resume(), 300)") });
  const w = pipe.write(big);
  const settled = Promise.race([w.then(() => "resolved", () => "rejected"), new Promise((r) => setTimeout(() => r("hanging"), 50))]);
  assert.equal(await settled, "hanging"); // the child hasn't taken it yet
  const end = pipe.end();
  await assert.rejects(w, /closed while a frame was still waiting/);
  await end.catch(() => undefined); // the child may exit 0 or with EPIPE noise: what matters is that nothing hangs
});

test("pipe: a stalled encoder (nothing read for stallMs) fails the write and kills the child", async () => {
  const pipe = spawnFfmpegPipe("ffmpeg", [], { stallMs: 300, spawnImpl: fake("setInterval(() => {}, 1000)") }); // alive, never reads
  await assert.rejects(pipe.write(big), /took no frames for 1 minute/);
  await assert.rejects(pipe.end(), /took no frames/);
});

test("pipe: frames flow, progress on stderr is parsed by line, end() resolves on exit 0", async () => {
  const script = `
    process.stderr.write("frame=1\\nfps=0.0\\n");
    let n = 0;
    process.stdin.on("data", (d) => { n += d.length; });
    process.stdin.on("end", () => { process.stderr.write("out_time_us=1000000\\nspeed=1.5x\\nprogress=end\\n"); setTimeout(() => process.exit(n === 10 ? 0 : 7), 50); });
  `;
  const seen: FfProgress[] = [];
  const pipe = spawnFfmpegPipe("ffmpeg", [], { spawnImpl: fake(script), onProgress: (p) => seen.push(p) });
  await pipe.write(new Uint8Array(4));
  await pipe.write(new Uint8Array(6));
  await pipe.end();
  assert.deepEqual(seen.map((p) => [p.frame, p.outTimeS, p.speed]), [[1, 1, "1.5x"]]);
});

test("runFfmpeg: the stall watchdog stops a run with no progress; the hard timeout stops a long one", async () => {
  // one progress block, then silence
  await assert.rejects(runFfmpeg("ffmpeg", [], { stallMs: 300, spawnImpl: fake("process.stdout.write('frame=1\\nprogress=continue\\n'); setInterval(() => {}, 1000)") }),
    (e: Error) => e instanceof FfmpegError && /made no progress for 1 minute/.test(e.message));
  await assert.rejects(runFfmpeg("ffmpeg", [], { timeoutMs: 200, spawnImpl: fake("setInterval(() => {}, 1000)") }),
    (e: Error) => e instanceof FfmpegError && /ran for more than/.test(e.message));
  // progress keeps the watchdog quiet
  const seen: number[] = [];
  const r = await runFfmpeg("ffmpeg", [], { stallMs: 400, onProgress: (p) => seen.push(p.frame),
    spawnImpl: fake("let i = 0; const t = setInterval(() => { process.stdout.write(`frame=${++i}\\nprogress=continue\\n`); if (i === 5) { clearInterval(t); process.exit(0); } }, 150)") });
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.equal(r.stderr, "");
});

test("parseMediaInfo reads the frame rate with the size and streams (fps, else tbr)", () => {
  const out = "Input #0\n  Duration: 00:00:06.00, start: 0.000000, bitrate: 4000 kb/s\n  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 4012 kb/s, 23.98 fps, 23.98 tbr, 90k tbn\n  Stream #0:1: Audio: aac, 48000 Hz, stereo\n";
  const i = parseMediaInfo(out);
  assert.deepEqual([i.duration, i.width, i.height, i.fps, i.hasAudio, i.hasVideo], [6, 1920, 1080, 23.98, true, true]);
  assert.equal(parseMediaInfo("  Stream #0:0: Video: prores, 3840x2160, 25 tbr").fps, 25);
  assert.equal(parseMediaInfo("  Stream #0:0: Audio: pcm_s16le, 48000 Hz").fps, 0);
});
