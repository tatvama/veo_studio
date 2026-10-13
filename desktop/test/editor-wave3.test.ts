/**
 * The editor bridge's wave 3 (src/main/editor.ts): RIFE slow motion and local Whisper as jobs (fake RIFE / whisper /
 * FFmpeg runners), audio sync, automatic proxies, versions and restore, studio backups (now and automatic), sidecars,
 * LUT folders (.3dl → .cube), the audio preview cache, impulse responses and batch export. No GPU, FFmpeg or network.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { EditorJob, MediaItem } from "../src/shared/types.ts";
import { EditorManager, type MediaTools } from "../src/main/editor.ts";
import type { ProbeInfo } from "../src/main/editor-media.ts";
import { threeDlToCube, sidecarName } from "../src/main/editor-luts.ts";
import type { ProcRunner } from "../src/main/editor-jobs.ts";
import type { ToolManager } from "../src/main/tools.ts";
import { Upstream } from "../src/main/upstream.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tatvam-wave3-"));
const lib = path.join(tmp, "lib");
const userData = path.join(tmp, "ud");
const outside = path.join(tmp, "outside");
const lutDir = path.join(tmp, "my-luts");
for (const d of [lib, userData, outside, path.join(lutDir, "film")]) mkdirSync(d, { recursive: true });

// ── fakes ──
const ran: string[][] = [];
const probeOf: Record<string, Partial<ProbeInfo>> = {
  "4k": { width: 3840, height: 2160, codec: "hevc", bits: 10 },
  small: { width: 640, height: 360, codec: "h264", bits: 8 },
  vid: { width: 1920, height: 1080, fps: 24, duration: 4, codec: "h264", bits: 8 },
};
const signal = (n: number, delay: number) => { // noise bursts, the same pattern shifted by `delay` samples
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  const base = Float32Array.from({ length: n + 8000 }, (_, i) => ((i >> 9) % 3 ? 0.5 : 0.02) * rnd());
  return Float32Array.from({ length: n }, (_, i) => base[i - delay + 4000] ?? 0);
};
const tools: MediaTools = {
  async probe(file) {
    const named = Object.entries(probeOf).find(([k]) => path.basename(file).includes(k))?.[1] ?? {};
    const e = path.extname(file).toLowerCase();
    const base: ProbeInfo = e === ".wav"
      ? { kind: "audio", duration: 20, fps: 0, width: 0, height: 0, hasVideo: false, hasAudio: true, channels: 2, sampleRate: 48000, rotation: 0 }
      : { kind: "video", duration: 4, fps: 24, width: 1920, height: 1080, hasVideo: true, hasAudio: true, channels: 2, sampleRate: 48000, rotation: 0 };
    return { ...base, ...named };
  },
  async run(args) {
    ran.push(args);
    const out = args[args.length - 1];
    if (out.endsWith("%08d.png")) { // the RIFE extract: 4 s at 24 fps
      for (let i = 1; i <= 96; i++) writeFileSync(path.join(path.dirname(out), `${String(i).padStart(8, "0")}.png`), "png");
      return;
    }
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, "media");
  },
  async lines(args, _onLine, o) {
    ran.push(args);
    if (args.includes("f32le") && o?.stdout) {
      const s = signal(8000 * 10, args[1].includes("late") ? 2468 : 0);
      o.stdout(Buffer.from(s.buffer));
    }
  },
  async peaks() { return [0.2, 0.4]; },
};
const procs: { exe: string; args: string[] }[] = [];
const proc: ProcRunner = async (exe, args, o) => {
  procs.push({ exe, args });
  if (exe.endsWith("rife-ncnn-vulkan.exe")) {
    const out = args[args.indexOf("-o") + 1];
    const n = Number(args[args.indexOf("-n") + 1]);
    for (let i = 1; i <= n; i++) {
      if (o.signal?.aborted) throw new Error("cancelled");
      writeFileSync(path.join(out, `${String(i).padStart(8, "0")}.jpg`), "jpg");
      o.onLine?.(`in/1.png in/2.png 0.5 -> out/${i}.jpg done`);
    }
    if (process.env.SLOW_RIFE) {
      await new Promise<void>((res, rej) => { const t = setTimeout(res, 2000); o.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("cancelled")); }); });
    }
    return;
  }
  if (exe.endsWith("whisper-cli.exe")) {
    o.onLine?.("whisper_print_progress_callback: progress =  50%");
    const outBase = args[args.indexOf("-of") + 1];
    writeFileSync(`${outBase}.json`, JSON.stringify({ result: { language: "hi" }, transcription: [
      { offsets: { from: 0, to: 1500 }, text: " नमस्ते दुनिया", tokens: [{ text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 1 },
        { text: " नमस्ते", offsets: { from: 100, to: 700 }, p: 0.9 }, { text: " दुनिया", offsets: { from: 800, to: 1400 }, p: 0.8 }] }] }), "utf8");
    o.onLine?.("whisper_print_progress_callback: progress = 100%");
  }
};
const toolDir = path.join(tmp, "tools");
const exeOf: Record<string, string> = {
  rife: path.join(toolDir, "rife", "rife-ncnn-vulkan.exe"), whisper: path.join(toolDir, "cpu", "whisper-cli.exe"), "whisper-cuda": path.join(toolDir, "cuda", "whisper-cli.exe"),
  "whisper-model:base": path.join(toolDir, "m", "ggml-base.bin"),
};
const inUse: string[] = [];
const localTools = {
  pathOf: (id: string) => exeOf[id] ?? null,
  use: (id: string) => { inUse.push(id); return () => { inUse.splice(inUse.indexOf(id), 1); }; },
  vulkanGpus: async () => [{ index: 0, name: "NVIDIA GeForce GTX 1660 Ti" }, { index: 1, name: "Intel(R) UHD Graphics 630" }],
  nvidiaGpus: async () => [{ index: 0, name: "NVIDIA GeForce GTX 1660 Ti" }],
  cudaMissing: () => [],
  cudaDirs: () => [],
  cudaReady: async () => ({ ok: false, reason: "The NVIDIA driver is 546.33: CUDA 12.4 needs 551.61 or newer (update it from nvidia.com)", driver: "546.33" }),
} as unknown as ToolManager;

const backups: { url: string; ct: string; body: string }[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method === "POST" && /^\/api\/edits\/\d+\/backups$/.test(req.url ?? "")) {
      backups.push({ url: req.url!, ct: String(req.headers["content-type"]), body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(201, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id: backups.length, created_at: "2026-10-13T00:00:00Z" }));
    }
    res.writeHead(404); res.end();
  });
});
let serverUrl = "";
const jobs: EditorJob[] = [];
const updates: { path: string; item: MediaItem }[] = [];
let lutFolders: string[] = [];
const starts: unknown[] = [];
const renders = { startEdit: (input: unknown) => { starts.push(input); return `job-${starts.length}`; } };
const ed = new EditorManager({
  libraryRoot: () => lib, userData, upstream: new Upstream({ serverUrl: () => serverUrl, cookie: async () => "veo_session=x" }), ff: () => null,
  probeHw: async () => ({ h264_nvenc: true }), tools, log: () => undefined, proc, localTools, renders: renders as never,
  onJob: (j) => jobs.push(j), onMediaUpdate: (u) => updates.push(u), backupSettings: () => ({ auto: true, minutes: 10 }), signedIn: async () => true,
  lutFolders: () => lutFolders, setLutFolders: (l) => { lutFolders = l; },
  dialogs: { openFiles: async () => [], openFolder: async () => lutDir },
});

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  ed.stopAll();
  await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  rmSync(tmp, { recursive: true, force: true });
});

const media = (name: string) => { const p = path.join(outside, name); writeFileSync(p, "x"); return p; };
let file = "";

test("automatic proxies: with proxy 'auto', files over 1080p (or HEVC 10-bit) get a 1080p proxy in the background", async () => {
  const r = await ed.create("Wave3", { width: 1920, height: 1080, fps: 24 });
  file = r.path;
  r.project.settings.proxy = "auto";
  await ed.save(file, r.project);
  const items = await ed.importMedia(file, [media("clip_4k.mp4"), media("small.mp4")]);
  assert.deepEqual(items.map((i) => [i.codec, i.bitDepth]), [["hevc", 10], ["h264", 8]]);
  for (let i = 0; i < 50 && !updates.length; i++) await new Promise((res) => setTimeout(res, 10));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].item.id, items[0].id);
  assert.match(updates[0].item.proxyUrl ?? "", /^\/__media\/[0-9a-f]{32}\/proxy_1080\.mp4$/);
  const px = ran.find((a) => a.at(-1)!.includes("proxy_1080"))!;
  assert.ok(px.some((a) => a.includes("min(1080,")) && px.includes("h264_nvenc"));
});

test("RIFE slow motion: frames out, RIFE on the dedicated card (-n frames), the clip back in Media\\ as a new item; a job with speed", async () => {
  const [vid] = await ed.importMedia(file, [media("vid_take.mp4")]);
  jobs.length = 0;
  const item = await ed.interpolate(file, vid.id, { factor: 4 });
  assert.equal(item.name, "vid_take x4 96fps.mp4");
  assert.ok(isInside(path.join(path.dirname(file), "Media"), item.path));
  const rife = procs.find((p) => p.exe === exeOf.rife)!;
  assert.deepEqual([rife.args[rife.args.indexOf("-n") + 1], rife.args[rife.args.indexOf("-g") + 1], rife.args[rife.args.indexOf("-m") + 1]],
    ["384", "0", path.join(toolDir, "rife", "rife-v4.6")]);
  const enc = ran.find((a) => a.includes("-framerate") && a.includes("96"))!;
  assert.ok(enc.includes("h264_nvenc") && enc.includes("-an") === false && enc[enc.indexOf("-frames:v") + 1] === "384");
  const done = jobs.filter((j) => j.status === "done").pop()!;
  assert.deepEqual([done.kind, done.framesDone, done.frames, done.device, done.resultMediaId], ["interpolate", 384, 384, "NVIDIA GeForce GTX 1660 Ti", item.id]);
  assert.ok((done.speed ?? 0) > 0);
  assert.deepEqual(inUse, [], "the tool is released");
  assert.equal(existsSync(path.join(path.dirname(file), "Cache", `rife-${done.id.slice(0, 8)}`)), false, "frames cleaned up");
  await assert.rejects(ed.interpolate(file, vid.id, { factor: 4, model: "rife-v2.4" }), /only doubles/);
  // cancelled while it runs
  process.env.SLOW_RIFE = "1";
  const p = ed.interpolate(file, vid.id, { factor: 2, jobId: "slow-job-1" });
  for (let i = 0; i < 100 && !jobs.some((j) => j.id === "slow-job-1" && j.status === "processing"); i++) await new Promise((r) => setTimeout(r, 5));
  ed.cancelJob("slow-job-1");
  await assert.rejects(p, /cancelled/);
  delete process.env.SLOW_RIFE;
  assert.equal(ed.jobList().find((j) => j.id === "slow-job-1")!.status, "cancelled");
});

test("local Whisper: the WAV of [in, out), whisper-cli, words in media time; CUDA asked but the driver is too old → the CPU build, with a note", async () => {
  const [wav] = await ed.importMedia(file, [media("speech.wav")]);
  const r = await ed.transcribeLocal(file, wav.id, { language: "auto", model: "base", cuda: true, in: 5, out: 12 });
  assert.equal(r.language, "hi");
  assert.equal(r.device, "cpu");
  assert.match(r.warnings![0], /driver is 546\.33: CUDA 12\.4 needs 551\.61 or newer.*so it ran on the processor/);
  assert.deepEqual(r.segments[0].words.map((w) => [w.text, w.start, w.end]), [["नमस्ते", 5.1, 5.7], ["दुनिया", 5.8, 6.4]]);
  assert.equal(r.duration, 7);
  const w = procs.filter((p) => p.exe.endsWith("whisper-cli.exe")).pop()!;
  assert.equal(w.exe, exeOf.whisper);
  assert.ok(w.args.includes("-ng") && w.args.includes("-ojf"));
  const wavArgs = ran.find((a) => a.includes("16000"))!;
  assert.deepEqual(wavArgs.slice(0, 4), ["-ss", "5.000", "-t", "7.000"]);
  await assert.rejects(ed.transcribeLocal(file, wav.id, { language: "auto", model: "large-v3-turbo-q5" }), /Install the Whisper large-v3-turbo-q5 model/);
  await assert.rejects(ed.transcribeLocal(file, wav.id, { language: "kannada!", model: "base" }), /isn't a language code/);
});

test("audio sync: the offset (seconds on the other clip's clock where this one starts) from two decoded tracks", async () => {
  const [a, b] = await ed.importMedia(file, [media("ref.wav"), media("late.wav")]);
  const r = await ed.analyze(file, a.id, "sync", { against: b.id });
  assert.equal(r.kind, "sync");
  assert.ok(r.kind === "sync" && Math.abs(r.offset - 2468 / 8000) < 1e-3, JSON.stringify(r));
  await assert.rejects(ed.analyze(file, a.id, "sync", {}), /needs the other clip/);
  // loudness of a clip's range only ("Match loudness")
  await ed.analyze(file, a.id, "loudness", { in: 3, out: 7.5 });
  assert.equal(ran.at(-1)![ran.at(-1)!.indexOf("-af") + 1], "atrim=start=1:duration=4.5,asetpts=PTS-STARTPTS,ebur128=peak=true");
  await assert.rejects(ed.analyze(file, a.id, "loudness", { in: 5, out: 2 }), /out point must be after/);
});

test("versions: the .bak list with times, sizes and a summary; restore keeps the current file as a backup first", async () => {
  const cur = JSON.parse(readFileSync(file, "utf8"));
  const old = { ...cur, name: "Old cut", sequences: cur.sequences.map((s: { clips: unknown[] }) => ({ ...s, clips: [] })) };
  writeFileSync(`${file}.bak.1`, JSON.stringify({ ...cur, name: "Newer" }));
  writeFileSync(`${file}.bak.2`, JSON.stringify(old));
  utimesSync(`${file}.bak.2`, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  writeFileSync(`${file}.bak.3`, "not json");
  const v = await ed.versions(file);
  assert.deepEqual(v.map((x) => [x.file, x.summary.name, x.summary.sequences, x.summary.clips]), [
    [`${path.basename(file)}.bak.1`, "Newer", 1, 0], [`${path.basename(file)}.bak.2`, "Old cut", 1, 0]]);
  assert.match(v[0].id, /^[0-9a-f]{16}$/);
  assert.ok(v[0].size > 100 && v[0].time > v[1].time);
  const r = await ed.restoreVersion(file, v[1].id);
  assert.equal(r.project.name, "Old cut");
  assert.equal(r.backup, `${path.basename(file)}.bak.1`);
  assert.equal(JSON.parse(readFileSync(`${file}.bak.1`, "utf8")).name, cur.name, "the current file became .bak.1");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).name, "Old cut");
  await assert.rejects(ed.restoreVersion(file, "0000000000000000"), /isn't there any more/);
});

test("studio backups: now (multipart 'file' = the .tatvamedit JSON) and automatically when the edit changed", async () => {
  await assert.rejects(ed.backupNow(file), /no studio project yet/);
  const r = await ed.backupNow(file, 7);
  assert.equal(backups[0].url, "/api/edits/7/backups");
  assert.match(backups[0].ct, /^multipart\/form-data/);
  assert.match(backups[0].body, /name="file"; filename="Wave3\.tatvamedit"[\s\S]*"format":"tatvam-edit"/);
  assert.deepEqual(r.backup, { id: 1, created_at: "2026-10-13T00:00:00Z" });
  // automatic: the edit has a studio project, changed since the last backup, and the interval has passed
  const p = (await ed.open(file))!.project;
  p.studioProjectId = 9;
  await ed.save(file, p);
  assert.equal(await ed.autoBackupTick(Date.now()), 0, "the last backup is under 10 minutes old");
  assert.equal(await ed.autoBackupTick(Date.now() + 11 * 60_000), 1);
  assert.equal(backups.at(-1)!.url, "/api/edits/9/backups");
  assert.equal(await ed.autoBackupTick(Date.now() + 25 * 60_000), 0, "nothing changed since");
  const st = await ed.backupStatus(file);
  assert.deepEqual([st.auto, st.minutes, st.signedIn, st.studioProjectId, Boolean(st.lastAt)], [true, 10, true, 9, true]);
  await ed.close(file);
  p.name = "Changed";
  await ed.save(file, p);
  await ed.close(file);
  assert.equal(await ed.autoBackupTick(Date.now() + 60 * 60_000), 0, "a closed edit isn't backed up");
});

test("sidecars: JSON next to the edit in .tatvam\\, safe names only", async () => {
  assert.equal(await ed.readSidecar(file, "transcript"), null);
  assert.deepEqual(await ed.writeSidecar(file, "transcript", { words: [1, 2] }), { bytes: 15 });
  assert.deepEqual(await ed.readSidecar(file, "transcript"), { words: [1, 2] });
  assert.ok(existsSync(path.join(path.dirname(file), ".tatvam", "transcript.json")));
  for (const bad of ["../x", "a/b", "", ".hidden", "x".repeat(65)]) await assert.rejects(ed.writeSidecar(file, bad, {}), /sidecar name/);
  assert.equal(sidecarName("comments.json"), "comments");
});

test("LUT folders: only folders the user adds; .cube and .3dl listed; a .3dl imported as .cube with red changing fastest", async () => {
  writeFileSync(path.join(lutDir, "warm.cube"), `TITLE "Warm"\nLUT_3D_SIZE 2\n${"0 0 0\n".repeat(8)}`);
  // 2×2×2 .3dl, 10-bit, blue fastest: the value encodes (r, g, b)
  const rows: string[] = [];
  for (let r = 0; r < 2; r++) for (let g = 0; g < 2; g++) for (let b = 0; b < 2; b++) rows.push(`${r * 1023} ${g * 1023} ${b * 1023}`);
  writeFileSync(path.join(lutDir, "film", "kodak.3dl"), `0 1023\n${rows.join("\n")}\n`);
  writeFileSync(path.join(lutDir, "notes.txt"), "x");
  const added = await ed.addLutFolder();
  assert.deepEqual(added!.files.map((f) => f.relPath), ["film/kodak.3dl", "warm.cube"]);
  assert.deepEqual(lutFolders, [lutDir]);
  assert.equal((await ed.lutFolders()).length, 1);
  const lut = await ed.importLutFile(file, path.join(lutDir, "film", "kodak.3dl"));
  assert.equal(lut.name, "kodak");
  assert.match(lut.url ?? "", /^\/__media\/[0-9a-f]{32}\/kodak\.cube$/);
  const cube = readFileSync(lut.path!, "utf8").split("\n");
  assert.deepEqual(cube.slice(1, 6), ["LUT_3D_SIZE 2", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0", "0.000000 0.000000 0.000000", "1.000000 0.000000 0.000000"]);
  await assert.rejects(ed.importLutFile(file, media("stray.cube")), /isn't in one of your LUT folders/);
  await ed.removeLutFolder(lutDir);
  assert.deepEqual(lutFolders, []);
  assert.throws(() => threeDlToCube("0 1023\n1 2 3\n"), /isn't a cube/);
});

test("writeLut: a page-made .cube into LUTs\, served by /__media, the same content reused, a unique name otherwise", async () => {
  const cube = (v: string) => `LUT_3D_SIZE 2
${`${v} ${v} ${v}
`.repeat(8)}`;
  const a = await ed.writeLut(file, "Warm mood", cube("0.5"));
  assert.equal(path.basename(a.file), "Warm mood.cube");
  assert.ok(isInside(path.join(path.dirname(file), "LUTs"), a.file));
  assert.equal(a.url, `/__media/${a.mediaId}/Warm%20mood.cube`);
  assert.equal(ed.resolve(a.mediaId), a.file);
  const again = await ed.writeLut(file, "Other name", cube("0.5"));
  assert.deepEqual([again.file, again.mediaId], [a.file, a.mediaId], "same content: no new file");
  const other = await ed.writeLut(file, "Warm mood", cube("0.25"));
  assert.equal(path.basename(other.file), "Warm mood_2.cube");
  await assert.rejects(ed.writeLut(file, "bad", "not a lut"), /isn't a 3D \.cube LUT/);
  await assert.rejects(ed.writeLut(file, "big", "x".repeat(8 * 1024 * 1024 + 1)), /at most 8 MB/);
});

test("the audio preview: one clip through the export graph into Cache\\audio\\<hash>.wav, cached; the page's copy of the clip wins", async () => {
  const p = (await ed.open(file))!.project;
  const [wav] = await ed.importMedia(file, [media("voice.wav")]);
  p.media.push(wav);
  const seq = p.sequences[0];
  const a1 = seq.tracks.find((t) => t.kind === "audio")!;
  const clip = { id: "pc", trackId: a1.id, start: 0, duration: 48, source: { type: "media" as const, mediaId: wav.id, in: 0 }, speed: 1, reverse: false, enabled: true,
    name: "voice", motion: {} as never, effects: [{ id: "r", type: "audio:reverb", enabled: true, params: { preset: { value: "hall" }, mix: { value: 0.4 } } }] };
  seq.clips.push(clip as never);
  await ed.save(file, p);
  const before = ran.length;
  const r1 = await ed.renderAudioPreview(file, seq.id, "pc");
  assert.equal(r1.cached, false);
  assert.equal(r1.duration, 2);
  assert.match(r1.url, /^\/__media\/[0-9a-f]{32}\/[0-9a-f]{24}\.wav$/);
  const run = ran[before];
  assert.match(run[run.indexOf("-filter_complex") + 1], /amovie=filename='.*irs\/hall\.wav'/);
  assert.equal((await ed.renderAudioPreview(file, seq.id, "pc")).cached, true);
  const changed = await ed.renderAudioPreview(file, seq.id, "pc", { ...clip, effects: [] } as never);
  assert.equal(changed.cached, false);
  assert.notEqual(changed.url, r1.url);
  await assert.rejects(ed.renderAudioPreview(file, seq.id, "nope"), /isn't in the sequence/);
});

test("impulse responses: written once to userData\\irs and listed with their gateway URLs", async () => {
  const irs = await ed.impulseResponses();
  assert.equal(irs.length, 12);
  assert.deepEqual(irs[0], { id: "room", label: "Room", url: "/__media/irs/room.wav", seconds: irs[0].seconds });
  assert.ok(existsSync(path.join(userData, "irs", "cab_4x12.wav")));
  assert.equal(await ed.impulseFile("hall.wav"), path.join(userData, "irs", "hall.wav"));
  assert.equal(await ed.impulseFile("../settings.json"), null);
  assert.equal(await ed.impulseFile("nope.wav"), null);
});

test("batch export: every item checked first, one RenderJob each with its own sequence, name, range and loudness", async () => {
  const p = (await ed.open(file))!.project;
  const seq = p.sequences[0];
  const second = { ...structuredClone(seq), id: "s_vertical", name: "Vertical", width: 1080, height: 1920 };
  p.sequences.push(second);
  await ed.save(file, p);
  starts.length = 0;
  await assert.rejects(ed.exportBatch(file, seq.id, [{ preset: "yt4k" }, { preset: "nope" }]), /Export 2: unknown preset nope/);
  assert.equal(starts.length, 0, "nothing queued when one item is wrong");
  const ids = await ed.exportBatch(file, seq.id, [{ preset: "yt4k", name: "Master" }, { preset: "social4k", sequenceId: "s_vertical", name: "Shorts", range: "all" },
    { preset: "broadcast1080" }]);
  assert.deepEqual(ids, ["job-1", "job-2", "job-3"]);
  const inputs = starts as { sequenceId: string; preset: string; name?: string; loudness?: string; irFile: (n: string) => string }[];
  assert.deepEqual(inputs.map((i) => [i.sequenceId, i.preset, i.name]), [[seq.id, "yt4k", "Master"], ["s_vertical", "social4k", "Shorts"], [seq.id, "broadcast1080", undefined]]);
  assert.equal(inputs[0].irFile("hall"), path.join(userData, "irs", "hall.wav"));
  assert.equal(await ed.export(file, seq.id, { preset: "review1080", range: "all", loudness: "apple" }), "job-4");
  assert.equal((starts[3] as { loudness: string }).loudness, "apple");
});

function isInside(dir: string, f: string): boolean {
  return path.resolve(f).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep);
}
