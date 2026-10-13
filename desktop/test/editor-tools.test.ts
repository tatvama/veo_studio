/**
 * Local tools for the editor (docs/EDITOR.md §10): the pinned downloads and the tool manager (src/main/tools.ts),
 * whisper.cpp arguments and its JSON → words (editor-whisper.ts, including Indic text split into byte pieces), the
 * RIFE plan and arguments (editor-interpolate.ts), audio sync by cross-correlation (editor-sync.ts) and the job lanes
 * (editor-jobs.ts). No GPU, FFmpeg or network: a local HTTP server stands in for the downloads.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { etaFrom, LocalJobs } from "../src/main/editor-jobs.ts";
import { interpDiskBytes, interpName, interpPlan, isRifeFrameLine, parseVideoFormat, readMatrix, rifeArgs, rifeEncodeArgs, rifeExtractArgs } from "../src/main/editor-interpolate.ts";
import { needsProxy } from "../src/main/editor-media.ts";
import { f32, syncDecodeArgs, syncOffset } from "../src/main/editor-sync.ts";
import { checkLanguage, noGpuInLog, parseWhisperJson, parseWhisperProgress, wavArgs, whisperArgs, whisperThreads } from "../src/main/editor-whisper.ts";
import { ESRGAN } from "../src/main/aiupscale.ts";
import { downloadPinned, findFile, parseDriverVersion, parseNvidiaSmi, TOOL_IDS, ToolManager, TOOLS, versionAtLeast, WHISPER_MODELS } from "../src/main/tools.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tatvam-tools-"));
const body = Buffer.from(Array.from({ length: 100_000 }, (_, i) => (i * 7) % 251));
const sha = createHash("sha256").update(body).digest("hex");
let ranges: string[] = [];
const server = http.createServer((req, res) => {
  const range = req.headers.range;
  ranges.push(String(range ?? ""));
  if (req.url === "/file.bin") {
    const m = /^bytes=(\d+)-$/.exec(String(range ?? ""));
    if (m) {
      const from = Number(m[1]);
      res.writeHead(206, { "Content-Length": body.length - from, "Content-Range": `bytes ${from}-${body.length - 1}/${body.length}` });
      return res.end(body.subarray(from));
    }
    res.writeHead(200, { "Content-Length": body.length });
    return res.end(body);
  }
  if (req.url === "/wrong.bin") { res.writeHead(200); return res.end(Buffer.alloc(body.length, 1)); }
  res.writeHead(404); res.end();
});
let base = "";
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  rmSync(tmp, { recursive: true, force: true });
});

// ── tools.ts ──
test("the pinned files: official URLs, the sizes the user approved, SHA-256s, one per tool", () => {
  assert.deepEqual(TOOL_IDS, ["realesrgan", "rife", "whisper", "whisper-cuda", "whisper-model:base", "whisper-model:large-v3-turbo-q5"]);
  const pins = Object.fromEntries(TOOL_IDS.map((id) => [id, [TOOLS[id].pin.file, TOOLS[id].pin.size]]));
  assert.deepEqual(pins, {
    realesrgan: ["realesrgan-ncnn-vulkan-20220424-windows.zip", 45_474_481],
    rife: ["rife-ncnn-vulkan-20221029-windows.zip", 431_540_241],
    whisper: ["whisper-bin-x64.zip", 8_928_640],
    "whisper-cuda": ["whisper-bin-win-cuda-12.4.0-x64.zip", 684_913_404],
    "whisper-model:base": ["ggml-base.bin", 147_951_465],
    "whisper-model:large-v3-turbo-q5": ["ggml-large-v3-turbo-q5_0.bin", 574_041_195],
  });
  for (const id of TOOL_IDS) assert.match(TOOLS[id].pin.sha256, /^[0-9a-f]{64}$/, id);
  assert.equal(TOOLS.rife.pin.url, "https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip");
  assert.equal(TOOLS.whisper.pin.url, "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip");
  assert.equal(TOOLS["whisper-cuda"].pin.sha256, "afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a"); // GitHub's release digest
  assert.deepEqual([TOOLS["whisper-cuda"].driver, TOOLS["whisper-cuda"].dir, TOOLS["whisper-cuda"].legacy![0].dir], ["551.61", "whisper-b5454-cuda12", "whisper-b5454-cuda"]);
  assert.match(TOOLS["whisper-model:base"].pin.url, /^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/[0-9a-f]{40}\/ggml-base\.bin$/);
  assert.deepEqual({ ...TOOLS.realesrgan.pin }, { file: ESRGAN.file, url: ESRGAN.url, size: ESRGAN.size, sha256: ESRGAN.sha256 }); // the same build aiupscale had
  assert.deepEqual(WHISPER_MODELS, { base: "whisper-model:base", "large-v3-turbo-q5": "whisper-model:large-v3-turbo-q5" });
});

test("pinned download: checked size and SHA-256, resumed with a Range request, a wrong file refused", async () => {
  const dest = path.join(tmp, "dl", "file.bin");
  const pin = { file: "file.bin", url: `${base}/file.bin`, size: body.length, sha256: sha };
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(`${dest}.part`, body.subarray(0, 30_000)); // an interrupted download
  ranges = [];
  let last = 0;
  await downloadPinned(pin, dest, { onProgress: (g) => { last = g; } });
  assert.deepEqual(ranges, ["bytes=30000-"]);
  assert.equal(last, body.length);
  assert.ok(readFileSync(dest).equals(body));
  ranges = [];
  await downloadPinned(pin, dest); // already there and right: nothing fetched
  assert.deepEqual(ranges, []);
  const bad = path.join(tmp, "dl", "wrong.bin");
  await assert.rejects(downloadPinned({ ...pin, url: `${base}/wrong.bin` }, bad), /didn't match the expected file/);
  await assert.rejects(downloadPinned({ ...pin, size: 10 }, path.join(tmp, "dl", "big.bin")), /bigger than the expected file/);
});

test("the tool manager: status, installed programs and models by their markers, remove, in-use guard, install refused on a bad download", async () => {
  const ud = path.join(tmp, "ud");
  const events: string[] = [];
  const tm = new ToolManager({ userData: ud, broadcast: (t) => events.push(`${t.id}:${t.installing}:${t.error ?? ""}`), log: () => undefined, platform: "win32",
    fetchImpl: (async () => new Response(Buffer.alloc(16, 0))) as typeof fetch });
  let st = await tm.status();
  assert.deepEqual(st.map((t) => [t.id, t.installed, t.kind, t.platformSupported]), TOOL_IDS.map((id) => [id, false, id.startsWith("whisper-model") ? "model" : "program", true]));
  // a program: its exe somewhere inside the unpacked folder, and tool.json saying where
  const dir = tm.dirOf("whisper");
  mkdirSync(path.join(dir, "Release"), { recursive: true });
  writeFileSync(path.join(dir, "Release", "whisper-cli.exe"), "x");
  assert.equal(findFile(dir, "WHISPER-CLI.EXE"), path.join("Release", "whisper-cli.exe"));
  assert.equal(tm.installed("whisper"), false); // no marker yet
  writeFileSync(path.join(dir, "tool.json"), JSON.stringify({ exe: path.join("Release", "whisper-cli.exe") }));
  assert.equal(tm.pathOf("whisper"), path.join(dir, "Release", "whisper-cli.exe"));
  // a model: the file with the pinned size and its marker
  const m = path.join(tm.dirOf("whisper-model:base"), "ggml-base.bin");
  mkdirSync(path.dirname(m), { recursive: true });
  writeFileSync(m, "short");
  writeFileSync(`${m}.json`, "{}");
  assert.equal(tm.installed("whisper-model:base"), false, "a model of the wrong size isn't installed");
  st = await tm.status();
  assert.equal(st.find((t) => t.id === "whisper")!.installed, true);
  const release = tm.use("whisper");
  await assert.rejects(tm.remove("whisper"), /in use/);
  release();
  assert.equal((await tm.remove("whisper")).installed, false);
  // install: the fake download is 16 bytes of zeros, so it's refused and nothing is installed
  await assert.rejects(tm.install("whisper"), /didn't match/);
  assert.equal(tm.installed("whisper"), false);
  assert.match((await tm.statusOf("whisper")).error ?? "", /didn't match/);
  assert.ok(events.some((e) => e.startsWith("whisper:true")));
  await assert.rejects(new ToolManager({ userData: ud, broadcast: () => undefined, log: () => undefined, platform: "linux" }).install("rife"), /Windows/);
  // the CUDA 11.8 build in its old folder is reported as outdated, not installed
  const old = path.join(tm.root, "whisper-b5454-cuda", "Release");
  mkdirSync(old, { recursive: true });
  writeFileSync(path.join(old, "whisper-cli.exe"), "x");
  writeFileSync(path.join(tm.root, "whisper-b5454-cuda", "tool.json"), JSON.stringify({ exe: path.join("Release", "whisper-cli.exe") }));
  const cuda = await tm.statusOf("whisper-cuda");
  assert.deepEqual([cuda.installed, cuda.outdated, cuda.requirement], [false, true, "An NVIDIA graphics card with driver 551.61 or newer"]);
  assert.match(cuda.note, /CUDA 11\.8 build without cuBLAS/);
  assert.ok(versionAtLeast("555.97", "551.61") && versionAtLeast("551.61", "551.61") && !versionAtLeast("546.33", "551.61") && !versionAtLeast("551.6", "551.61"));
  assert.equal(parseDriverVersion("555.97\r\n"), "555.97");
  assert.equal(parseDriverVersion("No devices were found"), null);
  assert.deepEqual(parseNvidiaSmi("GPU 0: NVIDIA GeForce GTX 1660 Ti (UUID: GPU-d28a886b)\nGPU 1: NVIDIA RTX A2000 (UUID: GPU-1)\n"),
    [{ index: 0, name: "NVIDIA GeForce GTX 1660 Ti" }, { index: 1, name: "NVIDIA RTX A2000" }]);
});

// ── editor-whisper.ts ──
test("whisper: the WAV extract, the CLI arguments, progress, threads, languages", () => {
  assert.deepEqual(wavArgs("v.mp4", "a.wav", 2, 7.5), ["-ss", "2.000", "-t", "5.500", "-i", "v.mp4", "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "a.wav"]);
  assert.deepEqual(wavArgs("v.mp4", "a.wav"), ["-i", "v.mp4", "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "a.wav"]);
  assert.deepEqual(whisperArgs({ model: "m.bin", wav: "a.wav", outBase: "o", language: "kn", threads: 6, gpu: false, prompt: "Tatvam" }),
    ["-m", "m.bin", "-f", "a.wav", "-of", "o", "-ojf", "-pp", "-np", "-l", "kn", "-t", "6", "--prompt", "Tatvam", "-ng"]);
  assert.ok(whisperArgs({ model: "m", wav: "a", outBase: "o", language: "auto", threads: 4, gpu: true, translate: true }).includes("-tr"));
  assert.equal(parseWhisperProgress("whisper_print_progress_callback: progress =  40%"), 0.4);
  assert.equal(parseWhisperProgress("[00:00:01.000 --> 00:00:02.000]  hi"), null);
  assert.ok(noGpuInLog("whisper_backend_init_gpu: no GPU found"));
  assert.equal(whisperThreads(12), 6);
  assert.equal(whisperThreads(2), 2);
  assert.equal(checkLanguage("KN"), "kn");
  assert.equal(checkLanguage(undefined), "auto");
  assert.throws(() => checkLanguage("kannada language"), /isn't a language code/);
});

/** whisper.cpp's -ojf JSON as it writes it (token texts as raw bytes), read back as latin1. */
function whisperJson(segments: { from: number; to: number; text: Buffer; tokens: [Buffer, number, number, number][] }[], lang: string): string {
  const esc = (b: Buffer) => b.toString("latin1").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const segs = segments.map((s) => `{"offsets":{"from":${s.from},"to":${s.to}},"text":"${esc(s.text)}","tokens":[${s.tokens.map(([t, a, b, p]) =>
    `{"text":"${esc(t)}","offsets":{"from":${a},"to":${b}},"p":${p}}`).join(",")}]}`);
  return `{"result":{"language":"${lang}"},"transcription":[${segs.join(",")}]}`;
}

test("whisper JSON → segments and words: special tokens dropped, punctuation kept on the word, times in media seconds", () => {
  const B = (s: string) => Buffer.from(s, "utf8");
  const json = whisperJson([{ from: 0, to: 2100, text: B(" Hello, world."), tokens: [[B("[_BEG_]"), 0, 0, 1], [B(" Hel"), 100, 300, 0.9], [B("lo"), 300, 500, 0.8],
    [B(","), 500, 520, 0.99], [B(" world"), 600, 1000, 0.95], [B("."), 1000, 1010, 0.99], [B("[_TT_105]"), 2100, 2100, 1]] }], "en");
  const r = parseWhisperJson(json, 10);
  assert.equal(r.language, "en");
  assert.deepEqual(r.segments, [{ start: 10, end: 12.1, text: "Hello, world.", words: [
    { start: 10.1, end: 10.52, text: "Hello,", p: 0.8 }, { start: 10.6, end: 11.01, text: "world.", p: 0.95 }] }]);
});

test("whisper JSON with Indic text split mid-character: the bytes of a word are joined before decoding", () => {
  const word = Buffer.from(" ಕನ್ನಡ", "utf8"); // Kannada, 3 bytes a letter
  const word2 = Buffer.from(" ಭಾಷೆ", "utf8");
  // split at byte boundaries that cut letters in half, as the byte-level BPE does
  const json = whisperJson([{ from: 0, to: 3000, text: Buffer.concat([word, word2]), tokens: [
    [word.subarray(0, 5), 0, 400, 0.7], [word.subarray(5, 11), 400, 800, 0.6], [word.subarray(11), 800, 1200, 0.9],
    [word2.subarray(0, 3), 1300, 1700, 0.8], [word2.subarray(3), 1700, 2500, 0.9]] }], "kn");
  const r = parseWhisperJson(json, 0);
  assert.equal(r.language, "kn");
  assert.equal(r.segments[0].text, "ಕನ್ನಡ ಭಾಷೆ");
  assert.deepEqual(r.segments[0].words.map((w) => [w.text, w.start, w.end]), [["ಕನ್ನಡ", 0, 1.2], ["ಭಾಷೆ", 1.3, 2.5]]);
});

// ── editor-interpolate.ts ──
test("RIFE plan: 24 → 96 fps, 4× slow motion, a frame-rate conversion, NTSC rates, the old models only double", () => {
  assert.deepEqual(interpPlan(24, 120, { factor: 4 }), { model: "rife-v4.6", inFrames: 120, outFrames: 480, fpsArg: "96", fps: 96, stretch: 1, factor: 4 });
  assert.deepEqual(interpPlan(24, 48, { factor: 4, fps: 24 }), { model: "rife-v4.6", inFrames: 48, outFrames: 192, fpsArg: "24", fps: 24, stretch: 4, factor: 4 });
  const conv = interpPlan(24, 100, { fps: 60 });
  assert.deepEqual([conv.outFrames, conv.fpsArg, conv.stretch, conv.factor], [250, "60", 1, 2.5]);
  const ntsc = interpPlan(23.976, 100, { factor: 2 });
  assert.deepEqual([ntsc.fpsArg, ntsc.fps, ntsc.outFrames], ["48000/1001", 47.952, 200]);
  assert.deepEqual([interpPlan(30, 10, {}).factor, interpPlan(30, 10, {}).fpsArg], [2, "60"]);
  assert.throws(() => interpPlan(24, 100, { factor: 4, model: "rife-v2.4" }), /only doubles/);
  assert.equal(interpPlan(24, 100, { factor: 2, model: "rife-anime" }).outFrames, 200);
  assert.throws(() => interpPlan(24, 100, { fps: 24 }), /above the clip's 24 fps/);
  assert.throws(() => interpPlan(24, 100, { factor: 3 as 2 }), /2, 4 or 8/);
  assert.throws(() => interpPlan(24, 1, { factor: 2 }), /two frames/);
});

test("RIFE arguments: the RGB extract with the clip's matrix, RIFE on the GPU, the encode back with the sound stretched", () => {
  const fmt = parseVideoFormat("  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160, 24 fps");
  assert.deepEqual(fmt, { codec: "hevc", pixFmt: "yuv420p10le", bits: 10, matrix: "bt2020nc", range: "tv", profile: "Main 10" });
  assert.deepEqual(parseVideoFormat("Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080, 25 fps"),
    { codec: "h264", pixFmt: "yuv420p", bits: 8, matrix: null, range: null, profile: "High" });
  assert.deepEqual(parseVideoFormat("Stream #0:0: Video: prores (HQ) (apch / 0x68637061), yuv422p10le(bt709, progressive), 3840x2160"),
    { codec: "prores", pixFmt: "yuv422p10le", bits: 10, matrix: "bt709", range: null, profile: "HQ" });
  assert.deepEqual(readMatrix({ matrix: null, range: null }, 1080), { matrix: "bt709", range: "tv" });
  assert.deepEqual(readMatrix({ matrix: "smpte170m", range: "pc" }, 480), { matrix: "bt601", range: "pc" });
  assert.deepEqual(rifeExtractArgs("in.mp4", "f", { in: 1.5, out: 3, matrix: "bt709", range: "tv" }), ["-ss", "1.500", "-t", "1.500", "-i", "in.mp4", "-map", "0:v:0",
    "-fps_mode", "passthrough", "-an", "-sn", "-vf", "scale=in_color_matrix=bt709:in_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,format=rgb24",
    "-start_number", "1", path.join("f", "%08d.png")]);
  assert.deepEqual(rifeArgs({ inDir: "i", outDir: "o", modelDir: "R/rife-v4.6", outFrames: 480, gpu: 0, uhd: false, v4: true }),
    ["-i", "i", "-o", "o", "-m", "R/rife-v4.6", "-g", "0", "-j", "1:2:2", "-f", "%08d.jpg", "-v", "-n", "480"]);
  assert.ok(rifeArgs({ inDir: "i", outDir: "o", modelDir: "m", outFrames: 10, gpu: 1, uhd: true, v4: false }).includes("-u"));
  assert.ok(isRifeFrameLine("in/00000001.png in/00000002.png 0.250000 -> out/00000002.jpg done"));
  assert.ok(!isRifeFrameLine("[0 NVIDIA GeForce GTX 1660 Ti]  queueC=2[8]"));
  const enc = rifeEncodeArgs({ framesDir: "o", fpsArg: "24", fps: 24, frames: 192, source: "in.mp4", in: 0, out: 2, stretch: 4, audio: "stretch", hasAudio: true,
    outFile: "slow.mp4", enc: ["-c:v", "h264_nvenc"], w: 1920, h: 1080 });
  assert.deepEqual(enc.slice(0, 10), ["-framerate", "24", "-start_number", "1", "-i", path.join("o", "%08d.jpg"), "-t", "2.000", "-i", "in.mp4"]);
  assert.ok(enc.includes("scale=1920:1080:flags=lanczos:in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p,"
    + "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"));
  assert.equal(enc[enc.indexOf("-af") + 1], "aresample=48000,atempo=0.5,atempo=0.5000,apad");
  assert.deepEqual(enc.slice(-5), ["-frames:v", "192", "-movflags", "+faststart", "slow.mp4"]);
  assert.equal(enc[enc.indexOf("-g") + 1], "24");
  const dropped = rifeEncodeArgs({ framesDir: "o", fpsArg: "96", fps: 96, frames: 480, source: "in.mp4", in: 0, stretch: 1, audio: "drop", hasAudio: true,
    outFile: "x.mp4", enc: [], w: 1920, h: 1080 });
  assert.ok(dropped.includes("-an") && !dropped.includes("in.mp4"));
  assert.equal(interpName("Shot 3.mp4", interpPlan(24, 48, { factor: 4, fps: 24 })), "Shot 3 slowmo x4 24fps.mp4");
  assert.equal(interpName("A.mov", interpPlan(23.976, 48, { factor: 2 })), "A x2 47.95fps.mp4");
  assert.ok(interpDiskBytes(1920, 1080, 240, 960) > 1.5e9);
});

test("automatic proxies: above 1080p, HEVC 10-bit, ProRes / DNx / CineForm", () => {
  assert.ok(needsProxy({ kind: "video", width: 3840, height: 2160, codec: "h264", bits: 8 }));
  assert.ok(needsProxy({ kind: "video", width: 1440, height: 2560, codec: "h264", bits: 8 })); // vertical 1440p
  assert.ok(!needsProxy({ kind: "video", width: 1080, height: 1920, codec: "h264", bits: 8 }));
  assert.ok(needsProxy({ kind: "video", width: 1920, height: 1080, codec: "hevc", bits: 10 }));
  assert.ok(!needsProxy({ kind: "video", width: 1920, height: 1080, codec: "hevc", bits: 8 }));
  assert.ok(needsProxy({ kind: "video", width: 1920, height: 1080, codec: "prores" }));
  assert.ok(!needsProxy({ kind: "audio", width: 0, height: 0 }));
});

// ── editor-sync.ts ──
test("sync: a known offset found to the sample (positive and negative), noise and level don't matter, silence is refused", () => {
  const rate = 8000;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  // 20 s of "speech": noise bursts of random lengths with quiet gaps (no period, so one clear peak)
  const src = new Float32Array(rate * 20);
  let loud = true;
  for (let i = 0, next = 0; i < src.length; i++) {
    if (i >= next) { loud = !loud; next = i + 400 + Math.floor(((rnd() + 1) / 2) * 3000); }
    src[i] = (loud ? 0.6 : 0.03) * rnd();
  }
  const shifted = (n: number, gain: number, noise: number) => Float32Array.from({ length: src.length }, (_, i) => gain * (src[i - n] ?? 0) + noise * rnd());
  const late = syncOffset(src, shifted(9876, 0.5, 0.05), rate); // the same sound 1.2345 s later in the other clip
  assert.equal(late.offset, 1.2345);
  assert.ok(late.confidence > 0.8 && late.margin > 0.5, JSON.stringify(late));
  const early = syncOffset(shifted(4000, 1, 0), src, rate); // here the other clip is the earlier one
  assert.equal(early.offset, -0.5);
  assert.throws(() => syncOffset(new Float32Array(rate * 2), new Float32Array(rate * 2), rate), /no sound in common/);
  assert.throws(() => syncOffset(new Float32Array(100), src, rate), /quarter of a second/);
  assert.deepEqual(syncDecodeArgs("a.mp4"), ["-i", "a.mp4", "-vn", "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-t", "120", "-f", "f32le", "-"]);
  const b = Buffer.alloc(10);
  b.writeFloatLE(0.5, 0);
  b.writeFloatLE(-1, 4);
  assert.deepEqual([...f32(b)], [0.5, -1]);
});

// ── editor-jobs.ts ──
test("jobs: one at a time per lane, lanes in parallel, cancel while queued or running, progress events, ETA", async () => {
  const seen: string[] = [];
  const jobs = new LocalJobs({ broadcast: (j) => seen.push(`${j.name}:${j.status}`), log: () => undefined });
  const order: string[] = [];
  const gate: { open?: () => void } = {};
  const a = jobs.run({ kind: "interpolate", editPath: "e", mediaId: "m", name: "A", id: "job-aaaa" }, "gpu", async (_j, c) => {
    order.push("A start");
    await new Promise<void>((r) => { gate.open = r; });
    c.update({ progress: 0.5, step: "half" }, true);
    order.push("A end");
    return 1;
  });
  const b = jobs.run({ kind: "interpolate", editPath: "e", mediaId: "m", name: "B" }, "gpu", async () => { order.push("B"); return 2; });
  const c = jobs.run({ kind: "transcribe", editPath: "e", mediaId: "m", name: "C" }, "cpu", async () => { order.push("C"); return 3; });
  assert.equal(await c.result, 3); // the CPU lane doesn't wait for the GPU one
  assert.equal(a.job.id, "job-aaaa");
  jobs.cancel(b.job.id); // queued behind A
  gate.open!();
  assert.equal(await a.result, 1);
  await assert.rejects(b.result, /cancelled/);
  assert.deepEqual(order, ["A start", "C", "A end"]);
  assert.equal(jobs.get(b.job.id)!.status, "cancelled");
  const d = jobs.run({ kind: "transcribe", editPath: "e", mediaId: "m", name: "D" }, "cpu", (_j, ctl) => new Promise((_, rej) => {
    ctl.signal.addEventListener("abort", () => rej(new Error("killed")));
  }));
  await new Promise((r) => setTimeout(r, 5));
  jobs.cancel(d.job.id);
  await assert.rejects(d.result, /cancelled/);
  const e = jobs.run({ kind: "transcribe", editPath: "e", mediaId: "m", name: "E" }, "cpu", async () => { throw new Error("whisper stopped (1)"); });
  await assert.rejects(e.result, /whisper stopped/);
  assert.equal(jobs.get(e.job.id)!.error, "whisper stopped (1)");
  assert.deepEqual(jobs.list().map((j) => [j.name, j.status]), [["E", "failed"], ["D", "cancelled"], ["C", "done"], ["B", "cancelled"], ["A", "done"]]);
  assert.ok(seen.includes("A:processing") === false && seen.includes("A:done") && seen.includes("A:preparing"));
  assert.equal(etaFrom(10, 25, 100), 30);
  assert.equal(etaFrom(10, 0, 100), undefined);
});
