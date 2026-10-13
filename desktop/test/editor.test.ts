/**
 * The Tatvam Editor's desktop side (docs/EDITOR.md §1, §2, §5, §8) without Electron or FFmpeg: project files, saves and
 * backups, the allow-list, import with fake media tools, the /__media registry served by the gateway with Range, LUT and
 * shader import, the studio uploads (fake server), an episode import end to end, and the pure helpers.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { EditProject, MediaItem } from "../src/shared/types.ts";
import { EditorManager, type MediaTools } from "../src/main/editor.ts";
import { PeakMeter, parseCubeHeader, parseProbe, filmstripArgs, thumbArgs, type ProbeInfo } from "../src/main/editor-media.ts";
import {
  editDims, editorDeepLink, exportRange, normalizeFps, renderName, safeEditName, secondsToFrames, toDisk, toRuntime, validatePreset, validateProject,
} from "../src/main/editor-model.ts";
import { Gateway, type OfflineStore } from "../src/main/gateway.ts";
import { Mirror } from "../src/main/mirror.ts";
import { gpuJob } from "../src/main/render.ts";
import { Upstream } from "../src/main/upstream.ts";
import { EPISODE, LAYERS, PROJECT } from "./fixtures/episode.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tatvam-editor-"));
const lib = path.join(tmp, "Tatvam Projects");
const userData = path.join(tmp, "userData");
const outside = path.join(tmp, "elsewhere");
mkdirSync(outside, { recursive: true });
mkdirSync(userData, { recursive: true });

// ── fake media tools: probe by extension / name, "encode" by writing the output file ──
const probes: Record<string, Partial<ProbeInfo>> = {};
const ran: string[][] = [];
const tools: MediaTools = {
  async probe(file) {
    const e = path.extname(file).toLowerCase();
    const named = Object.entries(probes).find(([k]) => path.basename(file).includes(k))?.[1] ?? {};
    const base: ProbeInfo = e === ".png" || e === ".jpg"
      ? { kind: "image", duration: 0, fps: 0, width: 1280, height: 720, hasVideo: true, hasAudio: false, channels: 0, sampleRate: 0, rotation: 0 }
      : e === ".wav" || e === ".mp3"
        ? { kind: "audio", duration: 2.5, fps: 0, width: 0, height: 0, hasVideo: false, hasAudio: true, channels: 1, sampleRate: 48000, rotation: 0 }
        : { kind: "video", duration: 4, fps: 24, width: 640, height: 360, hasVideo: true, hasAudio: true, channels: 2, sampleRate: 48000, rotation: 0 };
    return { ...base, ...named };
  },
  async run(args) {
    ran.push(args);
    writeFileSync(args[args.length - 1], "fake-image");
  },
  async lines(args, onLine) {
    ran.push(args);
    if (args.some((a) => a.startsWith("silencedetect"))) {
      for (const l of ["[silencedetect @ 0x1] silence_start: 0.5", "[silencedetect @ 0x1] silence_end: 1.25 | silence_duration: 0.75",
        "[silencedetect @ 0x1] silence_start: 2.1"]) onLine(l);
    }
  },
  async peaks() { return [0.1, 0.5, 0.25]; },
};

// ── a fake studio server: projects, episodes, layers, media and the edit asset upload ──
const uploads: { ct: string; body: string }[] = [];
const fetched: string[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const u = req.url ?? "";
    const json = (v: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
    if (req.headers.cookie !== "veo_session=tok123") return json({ detail: "Not signed in" }, 401);
    if (u === "/api/edits/7/assets" && req.method === "POST") {
      uploads.push({ ct: String(req.headers["content-type"]), body: Buffer.concat(chunks).toString("latin1") });
      return json({ key: "projects/7/edit_assets/abc123.wav", url: "/media/projects/7/edit_assets/abc123.wav", kind: "audio", duration: 2.5 });
    }
    if (u === "/api/projects/1") return json(PROJECT);
    if (u === "/api/episodes/3?lang=kn") return json(EPISODE);
    if (u === "/api/episodes/3/layers") return json(LAYERS);
    if (u.startsWith("/media/")) {
      fetched.push(decodeURIComponent(u));
      const body = Buffer.from(`media:${u}`);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
      return res.end(body);
    }
    json({ detail: "nope" }, 404);
  });
});
let serverUrl = "";

const dialogAnswers: string[][] = [];
const dialogCalls: { title: string; multi?: boolean }[] = [];
const upstream = new Upstream({ serverUrl: () => serverUrl, cookie: async () => "veo_session=tok123" });
const ed = new EditorManager({
  libraryRoot: () => lib, userData, upstream, ff: () => null, probeHw: async () => ({}), tools, log: () => undefined,
  dialogs: { openFiles: async (o) => { dialogCalls.push({ title: o.title, multi: o.multi }); return dialogAnswers.shift() ?? []; } },
});

const mem = new Mirror(":memory:");
const store: OfflineStore = { forProject: () => mem, all: () => [mem] };
const gw = new Gateway({ upstream: () => serverUrl, uiDir: () => null, uiSource: () => "bundled", resolveEditorMedia: (id) => ed.resolve(id), store,
  getCookie: async () => "veo_session=tok123" });

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await gw.listen(0);
});
after(async () => {
  await gw.close();
  await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  mem.close();
  rmSync(tmp, { recursive: true, force: true });
});

const media = (dir: string, name: string, bytes = 1000) => {
  const p = path.join(dir, name);
  writeFileSync(p, Buffer.from(Array.from({ length: bytes }, (_, i) => i % 256)));
  return p;
};

let editPath = "";
let editDir = "";

test("create: the folder skeleton, a valid project with V1–V3 / A1–A3, no overwrite, checked presets and names", async () => {
  await assert.rejects(ed.create("Bad", { width: 1921, height: 1080, fps: 24 }), /even whole numbers/);
  await assert.rejects(ed.create("Bad", { width: 1920, height: 1080, fps: 23 }), /frame rate/);
  await assert.rejects(ed.create("  ", { width: 1920, height: 1080, fps: 24 }), /name/);
  const r = await ed.create("My Edit: v1", { width: 1920, height: 1080, fps: 25 });
  editPath = r.path;
  editDir = path.dirname(r.path);
  assert.equal(editDir, path.join(lib, "Edits", "My-Edit-v1"));
  assert.equal(path.basename(r.path), "My-Edit-v1.tatvamedit");
  for (const sub of ["Media", "Cache", "Renders"]) assert.ok(existsSync(path.join(editDir, sub)));
  assert.equal(r.project.name, "My Edit: v1");
  const seq = r.project.sequences[0];
  assert.deepEqual(seq.tracks.map((t) => t.name), ["V1", "V2", "V3", "A1", "A2", "A3"]);
  assert.deepEqual([seq.width, seq.height, seq.fps, seq.sampleRate], [1920, 1080, 25, 48000]);
  assert.equal(r.project.activeSequenceId, seq.id);
  const disk = validateProject(JSON.parse(readFileSync(r.path, "utf8")));
  assert.equal(disk.id, r.project.id);
  await assert.rejects(ed.create("My Edit: v1", { width: 1920, height: 1080, fps: 25 }), /already exists/);
  const list = await ed.list();
  assert.equal(list[0].path, r.path);
  assert.equal(list[0].recent, true);
});

test("open: validation, the allow-list, the dialog", async () => {
  const stray = path.join(outside, "stray.tatvamedit");
  writeFileSync(stray, readFileSync(editPath));
  await assert.rejects(ed.open(stray), /wasn't opened in Tatvam/);
  await assert.rejects(ed.open(path.join(outside, "notes.txt")), /\.tatvamedit/);
  dialogAnswers.push([stray]);
  const viaDialog = await ed.open();
  assert.equal(viaDialog?.path, stray);
  assert.equal((await ed.open(stray))?.path, stray); // allowed from now on
  dialogAnswers.push([]);
  assert.equal(await ed.open(), null);
  const bad = path.join(lib, "Edits", "Broken", "Broken.tatvamedit");
  mkdirSync(path.dirname(bad), { recursive: true });
  writeFileSync(bad, JSON.stringify({ format: "tatvam-edit", version: 2, id: "x", sequences: [{}] }));
  await assert.rejects(ed.open(bad), /newer Tatvam/);
  writeFileSync(bad, "{ not json");
  await assert.rejects(ed.open(bad), /can't be read/);
  writeFileSync(bad, JSON.stringify({ format: "something-else" }));
  await assert.rejects(ed.open(bad), /isn't a Tatvam edit/);
  rmSync(path.dirname(bad), { recursive: true, force: true });
  assert.throws(() => validateProject({ format: "tatvam-edit", version: 1, id: "p", sequences: [] }), /no sequences/);
});

test("save: atomic, disk form, .bak rotated at most once a minute and kept to ten", async () => {
  const { project } = (await ed.open(editPath))!;
  project.name = "Renamed";
  const r1 = await ed.save(editPath, project);
  assert.ok(Date.parse(r1.modified) > 0);
  assert.equal(JSON.parse(readFileSync(editPath, "utf8")).name, "Renamed");
  assert.ok(existsSync(`${editPath}.bak.1`));
  assert.equal(JSON.parse(readFileSync(`${editPath}.bak.1`, "utf8")).name, "My Edit: v1"); // the version before
  await ed.save(editPath, { ...project, name: "Again" });
  assert.ok(!existsSync(`${editPath}.bak.2`), "a second save within a minute doesn't rotate");
  const old = new Date(Date.now() - 5 * 60_000);
  for (let i = 0; i < 12; i++) {
    utimesSync(`${editPath}.bak.1`, old, old);
    await ed.save(editPath, { ...project, name: `Round ${i}` });
  }
  const baks = readdirSync(editDir).filter((n) => /\.bak\.\d+$/.test(n)).sort();
  assert.equal(baks.length, 10);
  assert.ok(!existsSync(`${editPath}.bak.11`));
  assert.equal(JSON.parse(readFileSync(`${editPath}.bak.1`, "utf8")).name, "Round 10");
  assert.ok(!readdirSync(editDir).some((n) => n.endsWith(".tmp")));
  await assert.rejects(ed.save(path.join(tmp, "other", "x.tatvamedit"), project), /wasn't opened/);
  await assert.rejects(ed.save(editPath, { ...project, format: "nope" } as unknown as EditProject), /isn't a Tatvam edit/);
});

let video: MediaItem;
let audio: MediaItem;
let image: MediaItem;

test("importMedia: probe, copy into Media, thumbnail / filmstrip / peaks in Cache, runtime URLs; dialog when no files", async () => {
  const { project } = (await ed.open(editPath))!;
  await ed.save(editPath, { ...project, settings: { ...project.settings, copyMedia: true } });
  const v = media(outside, "clip.mp4", 5000);
  const a = media(outside, "voice.wav");
  const i = media(outside, "still.png");
  ran.length = 0;
  const items = await ed.importMedia(editPath, [v, a, i, path.join(outside, "notes.txt")]);
  assert.deepEqual(items.map((x) => x.name), ["clip.mp4", "voice.wav", "still.png"]);
  [video, audio, image] = items;
  assert.equal(video.path, path.join(editDir, "Media", "clip.mp4"));
  assert.ok(existsSync(video.path));
  assert.match(video.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual([video.kind, video.duration, video.fps, video.width, video.height, video.hasAudio, video.audioChannels], ["video", 96, 24, 640, 360, true, 2]);
  assert.match(video.url!, /^\/__media\/[0-9a-f]{32}\/clip\.mp4$/);
  assert.match(video.thumb!, /^\/__media\/[0-9a-f]{32}\/thumb\.jpg$/);
  assert.match(video.filmstrip!, /\/filmstrip\.jpg$/);
  assert.deepEqual(video.peaks, [0.1, 0.5, 0.25]);
  assert.ok(existsSync(path.join(editDir, "Cache", video.id, "peaks.json")));
  assert.deepEqual([audio.kind, audio.fps, audio.duration, audio.audioChannels, audio.thumb], ["audio", 48000, 120000, 1, undefined]);
  assert.deepEqual([image.kind, image.duration, image.fps, image.hasAudio, image.peaks], ["image", 0, 0, false, undefined]);
  assert.ok(image.thumb && !image.filmstrip);
  const thumbRun = ran.find((r) => r[r.length - 1].endsWith(path.join(video.id, "thumb.jpg")))!;
  assert.deepEqual(thumbRun.slice(0, 2), ["-ss", "2.000"]);
  dialogAnswers.push([a]);
  const picked = await ed.importMedia(editPath);
  assert.equal(picked.length, 1);
  assert.equal(dialogCalls.at(-1)?.multi, true);
  assert.equal(path.basename(picked[0].path), "voice_2.wav", "a second copy gets a new name");
  await assert.rejects(ed.importMedia(editPath, [path.join(outside, "missing.mp4")]), /not found/);
});

test("the /__media registry through the gateway: session cookie, Range, ETag, 304, HEAD, unknown ids", async () => {
  const url = await ed.mediaUrl(editPath, video.path);
  assert.equal(url, video.url, "a file keeps its URL for the session");
  const base = gw.url;
  const r = await fetch(base + url, { headers: { Cookie: "veo_session=tok123", Range: "bytes=100-109" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 100-109/5000");
  assert.equal(r.headers.get("content-type"), "video/mp4");
  assert.equal(r.headers.get("accept-ranges"), "bytes");
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
  const etag = r.headers.get("etag")!;
  assert.ok(etag);
  assert.equal((await fetch(base + url, { headers: { Cookie: "veo_session=tok123", "If-None-Match": etag } })).status, 304);
  const head = await fetch(base + url, { method: "HEAD", headers: { Cookie: "veo_session=tok123" } });
  assert.equal(head.headers.get("content-length"), "5000");
  assert.equal((await fetch(base + url)).status, 403, "no session, no file");
  assert.equal((await fetch(base + url, { headers: { Cookie: "veo_session=other" } })).status, 403);
  assert.equal((await fetch(`${base}/__media/${"0".repeat(32)}/x.mp4`, { headers: { Cookie: "veo_session=tok123" } })).status, 404);
  assert.equal((await fetch(base + url, { method: "POST", headers: { Cookie: "veo_session=tok123" } })).status, 405);
  const wav = await fetch(base + audio.url!, { headers: { Cookie: "veo_session=tok123", Range: "bytes=-10" } });
  assert.equal(wav.status, 206);
  assert.equal(wav.headers.get("content-type"), "audio/wav");
  await wav.arrayBuffer();
  // only files of the edit (or imported into it) are registered
  await assert.rejects(ed.mediaUrl(editPath, media(outside, "secret.mp4")), /isn't part of this edit/);
  await assert.rejects(ed.mediaUrl(editPath, path.join(outside, "notes.txt")), /isn't a media file/);
  writeFileSync(path.join(editDir, "Cache", "inside.json"), "{}");
  assert.match(await ed.mediaUrl(editPath, path.join(editDir, "Cache", "inside.json")), /inside\.json$/);
});

test("disk ↔ runtime: relative paths and cache files on disk, URLs and missing flags at runtime", async () => {
  const { project } = (await ed.open(editPath))!;
  project.media.push(video, audio, image);
  await ed.save(editPath, project);
  const disk = JSON.parse(readFileSync(editPath, "utf8")) as EditProject;
  const dv = disk.media.find((m) => m.id === video.id)!;
  assert.equal(dv.path, "Media/clip.mp4");
  assert.equal(dv.thumb, `Cache/${video.id}/thumb.jpg`);
  assert.equal(dv.url, undefined);
  assert.equal(dv.missing, undefined);
  rmSync(path.join(editDir, "Media", "still.png"));
  const again = (await ed.open(editPath))!.project;
  const rv = again.media.find((m) => m.id === video.id)!;
  assert.equal(rv.path, video.path);
  assert.equal(rv.missing, false);
  assert.match(rv.thumb!, /^\/__media\//);
  const ri = again.media.find((m) => m.id === image.id)!;
  assert.equal(ri.missing, true);
  assert.equal(ri.url, undefined);
  // pure round trip with an outside file and a studio item
  const p = structuredClone(again);
  p.media.push({ ...audio, id: "ext", path: path.join(outside, "voice.wav"), url: "/__media/abc/x" }, { ...audio, id: "st", path: "studio:projects/1/a.wav" });
  const d = toDisk(p, editDir, () => null);
  assert.equal(d.media.find((m) => m.id === "ext")!.path, path.join(outside, "voice.wav"));
  assert.equal(d.media.find((m) => m.id === "st")!.path, "studio:projects/1/a.wav");
  const rt = toRuntime(d, editDir, { exists: () => true, register: (f) => `/__media/id/${path.basename(f)}` });
  assert.equal(rt.media.find((m) => m.id === "st")!.missing, true);
});

test("relink keeps the id and marks; proxy needs a video", async () => {
  const keepMarker = { id: "k1", frame: 3, duration: 0, name: "here", color: "#fff" };
  const { project } = (await ed.open(editPath))!;
  project.media = project.media.map((m) => (m.id === image.id ? { ...m, markers: [keepMarker], comment: "logo" } : m));
  await ed.save(editPath, project);
  const replacement = media(outside, "still2.png");
  dialogAnswers.push([replacement]);
  const re = await ed.relink(editPath, image.id);
  assert.equal(re?.id, image.id);
  assert.equal(re?.path, replacement);
  assert.deepEqual(re?.markers, [keepMarker]);
  assert.equal(re?.comment, "logo");
  assert.equal(re?.missing, false);
  dialogAnswers.push([]);
  assert.equal(await ed.relink(editPath, image.id), null);
  await assert.rejects(ed.proxy(editPath, audio.id), /Only video/);
  const px = await ed.proxy(editPath, video.id);
  assert.equal(px.proxyPath, path.join(editDir, "Cache", video.id, "proxy_540.mp4"));
  assert.match(px.proxyUrl!, /proxy_540\.mp4$/);
  assert.match(ran.at(-1)!.join(" "), /min\(540,ih\)/);
  // the saved file notes the proxy, and a page save that hasn't caught up keeps it
  const before = (await ed.open(editPath))!.project;
  before.media = before.media.map((m) => ({ ...m, proxyPath: undefined }));
  await ed.save(editPath, before);
  assert.equal(JSON.parse(readFileSync(editPath, "utf8")).media.find((m: MediaItem) => m.id === video.id).proxyPath, `Cache/${video.id}/proxy_540.mp4`);
});

test("LUTs (.cube header checked) and custom shaders", async () => {
  const cube = path.join(outside, "teal.cube");
  const rows = Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`).join("\n");
  writeFileSync(cube, `# made by hand\nTITLE "Teal & Orange"\nLUT_3D_SIZE 2\n${rows}\n`);
  dialogAnswers.push([cube]);
  const lut = await ed.importLut(editPath);
  assert.equal(lut?.name, "Teal & Orange");
  assert.ok(lut?.path && existsSync(lut.path) && lut.path.startsWith(path.join(editDir, "Cache", "luts")));
  assert.match(lut!.url!, /^\/__media\//);
  writeFileSync(cube, "LUT_3D_SIZE 3\n0 0 0\n");
  dialogAnswers.push([cube]);
  await assert.rejects(ed.importLut(editPath), /needs 27/);
  assert.throws(() => parseCubeHeader("LUT_1D_SIZE 16\n"), /Only 3D/);
  const glsl = path.join(outside, "My Wipe.glsl");
  writeFileSync(glsl, "// name: My wipe\nvec4 transition(vec2 uv) { return mix(getFromColor(uv), getToColor(uv), step(uv.x, progress)); }\n");
  dialogAnswers.push([glsl]);
  assert.deepEqual(await ed.importShader(editPath, "transition"), { id: "my-wipe", name: "My wipe" });
  dialogAnswers.push([glsl]);
  assert.deepEqual(await ed.importShader(editPath, "transition"), { id: "my-wipe-2", name: "My wipe" });
  const notTr = path.join(outside, "fx.glsl");
  writeFileSync(notTr, "vec4 effect(vec4 c, vec2 uv) { return c; }");
  dialogAnswers.push([notTr]);
  await assert.rejects(ed.importShader(editPath, "transition"), /gl-transitions/);
  dialogAnswers.push([notTr]);
  assert.deepEqual(await ed.importShader(editPath, "effect"), { id: "fx", name: "fx" });
  const list = await ed.shaders();
  assert.deepEqual(list.map((s) => `${s.kind}/${s.id}/${s.name}`), ["transition/my-wipe/My wipe", "transition/my-wipe-2/My wipe", "effect/fx/fx"]);
  assert.match(list[0].glsl, /vec4 transition/);
});

test("analyze runs on the item's file (silence parsed, an open silence ends at the end)", async () => {
  const r = await ed.analyze(editPath, audio.id, "silence", { noiseDb: -40, minMs: 300 });
  assert.deepEqual(r, { kind: "silence", segments: [{ start: 0.5, end: 1.25 }, { start: 2.1, end: 2.5 }], duration: 2.5 });
  assert.ok(ran.at(-1)!.includes("silencedetect=noise=-40dB:d=0.300"));
  await assert.rejects(ed.analyze(editPath, audio.id, "scenes"), /needs a video/);
  await assert.rejects(ed.analyze(editPath, "nope", "loudness"), /isn't in this edit/);
});

test("uploadAsset: multipart to /api/edits/{pid}/assets with the session, cached by size and mtime; importStudioAsset downloads into Media", async () => {
  const r = await ed.uploadAsset(editPath, audio.id, 7);
  assert.deepEqual(r, { key: "projects/7/edit_assets/abc123.wav", url: "/media/projects/7/edit_assets/abc123.wav", duration: 2.5 });
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].ct, /^multipart\/form-data; boundary=/);
  assert.match(uploads[0].body, /name="file"; filename="voice.wav"/);
  assert.match(uploads[0].body, /Content-Type: audio\/wav/);
  assert.deepEqual(await ed.uploadAsset(editPath, audio.id, 7), r);
  assert.equal(uploads.length, 1, "the same file isn't uploaded twice");
  await assert.rejects(ed.uploadAsset(editPath, audio.id, 0), /whole number/);
  const it = await ed.importStudioAsset(editPath, "projects/7/edit_assets/abc123.wav", "Dub (kn).wav");
  assert.equal(it.studioKey, "projects/7/edit_assets/abc123.wav");
  assert.equal(it.path, path.join(editDir, "Media", "Dub (kn).wav"));
  assert.equal(readFileSync(it.path, "utf8"), "media:/media/projects/7/edit_assets/abc123.wav");
  assert.equal(it.kind, "audio");
  await assert.rejects(ed.importStudioAsset(editPath, "../../etc/passwd"), /storage key/);
});

test("importEpisode: fetches the cut, downloads its media into Media\\<episode>, adds a bin and the sequence, saves", async () => {
  probes._lipsync_ = { duration: 4 };
  probes._video_ = { duration: 6 };
  probes._voice_ = { duration: 2.5 };
  probes._narration_ = { duration: 2 };
  probes._sfx = { duration: 2 };
  probes.music_ = { duration: 4, channels: 2 };
  fetched.length = 0;
  const r = await ed.importEpisode(1, 3, editPath);
  const seq = r.project.sequences.find((s) => s.id === r.sequenceId)!;
  assert.equal(r.project.activeSequenceId, seq.id);
  assert.equal(seq.name, "S01E02 The river");
  assert.deepEqual([seq.width, seq.height, seq.fps], [1920, 1080, 24]);
  assert.deepEqual(seq.source, { pid: 1, eid: 3, lang: "kn" });
  assert.ok(fetched.includes("/media/projects/1/shots/41/lipsync/l41.mp4"));
  assert.equal(fetched.filter((f) => f.includes("music")).length, 1);
  const bin = r.project.bins.at(-1)!;
  assert.equal(bin.name, "S01E02 The river");
  const fresh = r.project.media.filter((m) => m.binId === bin.id);
  assert.equal(fresh.length, 9);
  assert.ok(fresh.every((m) => m.studioKey && m.path.startsWith(path.join(editDir, "Media", "S01E02 The-river"))));
  const disk = JSON.parse(readFileSync(editPath, "utf8")) as EditProject;
  assert.ok(disk.sequences.some((s) => s.id === seq.id));
  assert.ok(disk.media.filter((m) => m.studioKey).every((m) => m.path.startsWith("Media/S01E02 The-river/")));
  // a second import reuses the media it already has
  fetched.length = 0;
  const again = await ed.importEpisode(1, 3, editPath);
  assert.equal(fetched.length, 0);
  assert.equal(again.project.media.length, r.project.media.length);
  assert.equal(again.project.sequences.length, r.project.sequences.length + 1);
});

// ── pure helpers ──
test("parseProbe: video with rotation, cover art, mono wav, png", () => {
  const vid = parseProbe(`Input #0, mov,mp4, from 'a.mov':
  Duration: 00:00:10.50, start: 0.000000, bitrate: 15000 kb/s
  Stream #0:0[0x1](eng): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 15000 kb/s, 29.97 fps, 29.97 tbr, 600 tbn (default)
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 192 kb/s (default)`, "a.mov");
  assert.deepEqual(vid, { kind: "video", duration: 10.5, fps: 29.97, width: 1080, height: 1920, hasVideo: true, hasAudio: true, channels: 2, sampleRate: 44100, rotation: 270 });
  const mp3 = parseProbe(`Input #0, mp3, from 'song.mp3':
  Duration: 00:03:05.12, start: 0.025057, bitrate: 320 kb/s
  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 320 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 500x500 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)`, "song.mp3");
  assert.deepEqual([mp3.kind, mp3.duration, mp3.hasVideo, mp3.channels, mp3.fps], ["audio", 185.12, false, 2, 0]);
  const wav = parseProbe(`  Duration: 00:00:02.50, bitrate: 768 kb/s
  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 48000 Hz, 1 channels, s16, 768 kb/s`, "v.wav");
  assert.deepEqual([wav.kind, wav.channels, wav.sampleRate], ["audio", 1, 48000]);
  const png = parseProbe(`  Duration: N/A, bitrate: N/A
  Stream #0:0: Video: png, rgba(pc), 1280x720, 25 fps, 25 tbr, 25 tbn`, "still.png");
  assert.deepEqual([png.kind, png.duration, png.width, png.height], ["image", 0, 1280, 720]);
  const film = parseProbe(`  Duration: 00:00:01.00, start: 0.000000
  Stream #0:0: Video: h264 (High), yuv420p(progressive), 3840x2160 [SAR 1:1 DAR 16:9], 23.98 fps, 23.98 tbr, 24k tbn`, "x.mp4");
  assert.equal(film.fps, 23.976);
  assert.equal(normalizeFps(59.94), 59.94);
  assert.equal(normalizeFps(12.5), 12.5);
});

test("PeakMeter matches backend ffmpeg.peaks (max |s|/32768 per step, 3 decimals), across odd chunk splits", () => {
  const samples = Int16Array.from({ length: 1000 }, (_, i) => (i % 100 === 50 ? -16384 : (i % 7) * 10));
  const bytes = new Uint8Array(samples.buffer);
  const m = new PeakMeter(1000, 10);
  m.feed(bytes.subarray(0, 333));
  m.feed(bytes.subarray(333, 1001));
  m.feed(bytes.subarray(1001));
  assert.deepEqual(m.result(), Array(10).fill(0.5));
  const q = new PeakMeter(10, 800);
  q.feed(new Uint8Array(Int16Array.from([32767, -32768, 0]).buffer));
  assert.deepEqual(q.result(), [1, 1, 0]);
});

test("argument builders for thumbs and filmstrips", () => {
  assert.deepEqual(thumbArgs("a.mp4", "t.jpg", { kind: "video", duration: 10 }), ["-ss", "5.000", "-i", "a.mp4", "-map", "0:v:0", "-frames:v", "1", "-vf",
    "scale=320:-2:flags=bicubic,format=yuvj420p", "-q:v", "4", "t.jpg"]);
  const f = filmstripArgs("a.mp4", "f.jpg", 10, 3, 160);
  assert.deepEqual(f.slice(0, 9), ["-ss", "1.667", "-i", "a.mp4", "-ss", "5.000", "-i", "a.mp4", "-ss"]);
  assert.equal(f[f.indexOf("-filter_complex") + 1], "[0:v:0]scale=-2:160:flags=bicubic,setsar=1,format=yuvj420p[f0];[1:v:0]scale=-2:160:flags=bicubic,setsar=1,format=yuvj420p[f1];"
    + "[2:v:0]scale=-2:160:flags=bicubic,setsar=1,format=yuvj420p[f2];[f0][f1][f2]hstack=inputs=3[strip]");
});

test("model helpers: names, presets, ranges, export sizes, render names, deep links, the GPU job union", () => {
  assert.equal(safeEditName(" Kaali — rough cut? "), "Kaali-—-rough-cut");
  assert.equal(safeEditName("con"), "_con");
  assert.deepEqual(validatePreset({ width: 1080, height: 1920, fps: 29.97 }), { width: 1080, height: 1920, fps: 29.97 });
  const seq = { clips: [{ start: 10, duration: 50, enabled: true }, { start: 0, duration: 20, enabled: false }], inPoint: 12, outPoint: 30 } as never;
  assert.deepEqual(exportRange(seq, "all"), { in: 0, out: 60 });
  assert.deepEqual(exportRange(seq, "inout"), { in: 12, out: 31 });
  assert.throws(() => exportRange({ clips: [] } as never, "all"), /empty/);
  assert.deepEqual(editDims({ w: 3840, h: 2160, orientation: "project" }, 1920, 1080), { w: 3840, h: 2160 });
  assert.deepEqual(editDims({ w: 3840, h: 2160, orientation: "project" }, 1080, 1920), { w: 2160, h: 3840 });
  assert.deepEqual(editDims({ w: 2560, h: 1440, orientation: "project" }, 1440, 1080), { w: 1920, h: 1440 });
  assert.deepEqual(editDims({ w: 1440, h: 2560, orientation: "vertical" }, 1920, 1080), { w: 1440, h: 2560 });
  assert.equal(renderName("Sequence 01", "mp4", ["Sequence-01_v001.mp4", "Sequence-01_v007.mov", "other_v009.mp4"]), "Sequence-01_v008.mp4");
  assert.equal(renderName("S01E02 The river", ".mov", []), "S01E02-The-river_v001.mov");
  assert.equal(secondsToFrames(1, 29.97), 30);
  // deep links: a full path of this OS to a .tatvamedit opens it; anything else opens the editor home
  const native = path.join(os.tmpdir(), "Edits", "A", "A.tatvamedit");
  assert.deepEqual(editorDeepLink(`tatvam://editor?path=${encodeURIComponent(native)}`),
    { urlPath: `/editor/edit?path=${encodeURIComponent(native)}`, file: native });
  assert.deepEqual(editorDeepLink("tatvam://editor"), { urlPath: "/editor" });
  assert.deepEqual(editorDeepLink(`tatvam://editor?path=${encodeURIComponent(path.join("Edits", "A", "A.tatvamedit"))}`), { urlPath: "/editor" }, "a relative path");
  assert.deepEqual(editorDeepLink(`tatvam://editor?path=${encodeURIComponent(path.join(os.tmpdir(), "evil.exe"))}`), { urlPath: "/editor" }, "not an edit");
  assert.deepEqual(editorDeepLink("tatvam://editor?path=C%3A%5Cevil.exe"), { urlPath: "/editor" });
  assert.equal(editorDeepLink("tatvam://open?project=1"), null);
  const size = { w: 1920, h: 1080, fps: 24, frames: 48 };
  assert.deepEqual(gpuJob({ kind: "plan", plan: { episode_id: 3 } as never }, size), { kind: "plan", plan: { episode_id: 3 }, ...size });
  const project = { id: "p" } as unknown as EditProject;
  const job = gpuJob({ kind: "composition", project, sequenceId: "s1", range: { in: 10, out: 58 } }, size);
  assert.deepEqual(job, { kind: "composition", project, sequenceId: "s1", range: { in: 10, out: 58 }, ...size });
});

test("deep links with Windows paths: a drive-letter path to an edit opens it", { skip: process.platform !== "win32" && "Windows paths" }, () => {
  assert.deepEqual(editorDeepLink("tatvam://editor?path=D%3A%5CEdits%5CA%5CA.tatvamedit"),
    { urlPath: `/editor/edit?path=${encodeURIComponent("D:\\Edits\\A\\A.tatvamedit")}`, file: "D:\\Edits\\A\\A.tatvamedit" });
  assert.deepEqual(editorDeepLink("tatvam://editor?path=Edits%5CA%5CA.tatvamedit"), { urlPath: "/editor" }, "a relative path");
});
