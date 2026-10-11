/**
 * AI upscale on this PC's graphics card (docs/DESKTOP.md §2.6, "On this PC"). Real-ESRGAN (ncnn + Vulkan, so it runs on
 * NVIDIA, AMD and Intel cards) upscales a shot's video frame by frame, FFmpeg puts the frames back together with the
 * original sound on the hardware encoder, and the clip is uploaded as that video's upscale take: renders (with "Use AI
 * upscales") and every other desktop then use it, exactly like a cloud upscale. Free: no AI service is called.
 *
 * The engine is installed on demand: the pinned v0.2.5.0 Windows build from github.com/xinntao/Real-ESRGAN (BSD-3),
 * checked against its size and SHA-256 before it is unpacked. Measured on a GTX 1660 Ti: the video model does about
 * 1.3 frames a second from 1080p to 4K (a 6 s shot in about 2 minutes); x4plus about 20 s a frame.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, openAsBlob, promises as fsp, readFileSync } from "node:fs";
import path from "node:path";
import type { LocalUpscaleEstimate, UpscaleJob, UpscaleModel, UpscaleState, UpscaleTool } from "../shared/types.ts";
import { writeFileAtomic } from "./config.ts";
import { downloadTo } from "./download.ts";
import { killTree, probeMedia, runFfmpeg, type FfmpegInfo } from "./ffmpeg.ts";
import type { Library } from "./library.ts";
import { safePart } from "./naming.ts";
import { finalEncoder, type PresetDef } from "./render-args.ts";
import { UpstreamError, type Upstream } from "./upstream.ts";

/** The pinned engine build (verified before use). */
export const ESRGAN = {
  version: "0.2.5.0",
  file: "realesrgan-ncnn-vulkan-20220424-windows.zip",
  url: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip",
  size: 45_474_481,
  sha256: "abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d",
  exe: "realesrgan-ncnn-vulkan.exe",
} as const;

export const MODELS: Record<UpscaleModel, { name: string; scales: number[]; label: string }> = {
  fast: { name: "realesr-animevideov3", scales: [2, 3, 4], label: "Fast (Real-ESRGAN video model)" },
  best: { name: "realesrgan-x4plus", scales: [4], label: "Best detail (Real-ESRGAN x4plus, slow)" },
};

/** Output megapixels a second per model on a GTX 1660 Ti (measured 11 Oct 2026); replaced by this PC's own numbers. */
const START_MPPS: Record<UpscaleModel, number> = { fast: 11.1, best: 1.65 };

// ── pure helpers (unit-tested) ──

/** The smallest scale the model offers that reaches the target short side (else its largest). */
export function chooseScale(model: UpscaleModel, srcW: number, srcH: number, targetShort: number): number {
  const short = Math.max(1, Math.min(srcW, srcH));
  const scales = MODELS[model].scales;
  return scales.find((s) => short * s >= targetShort) ?? scales[scales.length - 1];
}

/** Even output size with the source's shape and the target short side. */
export function outputDims(srcW: number, srcH: number, targetShort: number): [number, number] {
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  if (srcW <= srcH) return [even(targetShort), even((targetShort * srcH) / srcW)];
  return [even((targetShort * srcW) / srcH), even(targetShort)];
}

/** Vulkan devices from Real-ESRGAN's verbose output: lines like `[0 NVIDIA GeForce GTX 1660 Ti]  queueC=2[8] …`. */
export function parseGpus(text: string): { index: number; name: string }[] {
  const seen = new Map<number, string>();
  for (const m of text.matchAll(/^\[(\d+) ([^\]]+)\]/gm)) if (!seen.has(Number(m[1]))) seen.set(Number(m[1]), m[2].trim());
  return [...seen].map(([index, name]) => ({ index, name }));
}

/** The dedicated card when there is one (NVIDIA, AMD, Intel Arc), not the built-in graphics or a software device. */
export function pickGpu(gpus: { index: number; name: string }[]): { index: number; name: string } | null {
  const soft = /microsoft basic|llvmpipe|swiftshader/i;
  const dedicated = gpus.find((g) => /nvidia|geforce|rtx|quadro|radeon rx|amd radeon(?! graphics)|intel.*arc/i.test(g.name));
  return dedicated ?? gpus.find((g) => !soft.test(g.name)) ?? gpus[0] ?? null;
}

export function fpsOf(ffmpegInfo: string): number {
  const m = /,\s*(\d+(?:\.\d+)?)\s*fps/.exec(ffmpegInfo);
  return m ? Number(m[1]) : 24;
}

export function extractArgs(input: string, dir: string): string[] {
  return ["-i", input, "-map", "0:v:0", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", path.join(dir, "%06d.png")];
}

export function esrganArgs(o: { inDir: string; outDir: string; model: UpscaleModel; scale: number; gpu: number }): string[] {
  return ["-i", o.inDir, "-o", o.outDir, "-n", MODELS[o.model].name, "-s", String(o.scale), "-g", String(o.gpu), "-f", "jpg", "-j", "1:2:2"];
}

/**
 * Real-ESRGAN writes JPEG frames: full-range BT.601. Converted (and tagged) to limited-range BT.709 like the AI clips, so
 * an upscaled shot cuts in with the same brightness and colour (kept as JPEG it rendered about 4 levels brighter).
 */
export const FRAMES_TO_VIDEO = "in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709";
export const BT709_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

/** Frames back into a clip at the exact target size with the original sound (if any), on the given encoder. */
export function encodeArgs(o: { framesDir: string; fps: number; source: string; out: string; w: number; h: number; enc: string[] }): string[] {
  return ["-framerate", String(o.fps), "-i", path.join(o.framesDir, "%06d.jpg"), "-i", o.source, "-map", "0:v:0", "-map", "1:a:0?",
    "-vf", `scale=${o.w}:${o.h}:flags=lanczos:${FRAMES_TO_VIDEO},format=yuv420p`, ...o.enc, ...BT709_TAGS,
    "-c:a", "copy", "-shortest", "-movflags", "+faststart", o.out];
}

/** The clip's encoder: HEVC at a high constant quality on the fastest hardware this PC has. */
export const UPSCALE_ENCODE: PresetDef = { id: "upscale", label: "Upscale", w: 3840, h: 2160, orientation: "project", codec: "hevc",
  container: "mp4", tenBit: false, cq: 17, note: "" };

/** Minutes for `frames` frames of `out` size at `mpps` output megapixels a second, plus a little for extract and encode. */
export function minutesFor(frames: number, out: [number, number], mpps: number): number {
  const mp = (out[0] * out[1]) / 1e6;
  return Math.round(((frames * mp) / Math.max(mpps, 0.01) / 60) * 1.12 * 10) / 10;
}

// ── the manager ──

export interface UpscalerDeps {
  library: Library;
  upstream: Upstream;
  ff(): FfmpegInfo | null;
  probe(): Promise<Record<string, boolean>>;
  /** userData: the engine lives in tools/, the measured speeds in upscale-speed.json. */
  userData: string;
  machine: string;
  prefer(): "auto" | "nvenc" | "qsv" | "amf" | "software";
  broadcast(j: UpscaleJob): void;
  broadcastTool(t: UpscaleTool): void;
  log(msg: string): void;
}

interface EstimateItem { shot_id: number; code: string; take_id: number; from: [number, number]; to: [number, number]; seconds: number; key: string; url: string }

const nowIso = () => new Date().toISOString();

export class LocalUpscaler {
  private deps: UpscalerDeps;
  private jobs: UpscaleJob[] = [];
  private queue: string[] = [];
  private running: { id: string; abort: AbortController } | null = null;
  private keys = new Map<string, { key: string; url: string }>();
  private installing: Promise<UpscaleTool> | null = null;
  private toolState: Partial<UpscaleTool> = {};
  private gpus: { index: number; name: string }[] | null = null;
  private lastEmit = new Map<string, number>();

  constructor(deps: UpscalerDeps) {
    this.deps = deps;
  }

  private get dir(): string { return path.join(this.deps.userData, "tools", `realesrgan-${ESRGAN.version}`); }
  private get exe(): string { return path.join(this.dir, ESRGAN.exe); }
  private get speedFile(): string { return path.join(this.deps.userData, "upscale-speed.json"); }

  installed(): boolean {
    return process.platform === "win32" && existsSync(this.exe) && existsSync(path.join(this.dir, "tool.json"));
  }

  async tool(): Promise<UpscaleTool> {
    const installed = this.installed();
    if (installed && this.gpus === null) this.gpus = await this.listGpus().catch(() => []);
    return { installed, version: ESRGAN.version, sizeBytes: ESRGAN.size, platformSupported: process.platform === "win32",
      gpus: this.gpus ?? undefined, gpu: this.gpus ? pickGpu(this.gpus) : undefined, ...this.toolState };
  }

  /** Download the pinned build, check it, unpack it into userData/tools. */
  install(): Promise<UpscaleTool> {
    if (this.installed()) return this.tool();
    if (process.platform !== "win32") return Promise.reject(new Error("Local AI upscale runs on Windows for now"));
    this.installing ??= this.doInstall().finally(() => { this.installing = null; });
    return this.installing;
  }

  private async doInstall(): Promise<UpscaleTool> {
    const setState = async (patch: Partial<UpscaleTool>) => {
      this.toolState = { ...this.toolState, ...patch };
      this.deps.broadcastTool(await this.tool());
    };
    const dl = path.join(this.deps.userData, "tools", "_download");
    const zip = path.join(dl, ESRGAN.file);
    try {
      await setState({ installing: true, progress: 0, error: undefined });
      await fsp.mkdir(dl, { recursive: true });
      const r = await fetch(ESRGAN.url, { redirect: "follow" });
      if (!r.ok || !r.body) throw new Error(`Download failed: HTTP ${r.status}`);
      const hash = createHash("sha256");
      const out = createWriteStream(zip);
      let got = 0;
      let last = 0;
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        got += chunk.byteLength;
        if (!out.write(chunk)) await new Promise<void>((res) => out.once("drain", () => res()));
        if (got - last > 1_000_000) { last = got; void setState({ progress: Math.min(0.95, got / ESRGAN.size) }); }
      }
      await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
      const sum = hash.digest("hex");
      if (got !== ESRGAN.size || sum !== ESRGAN.sha256) throw new Error("The download didn't match the expected file, so it wasn't installed");
      await fsp.rm(this.dir, { recursive: true, force: true });
      await fsp.mkdir(this.dir, { recursive: true });
      const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
      await new Promise<void>((res, rej) => {
        const p = spawn(tar, ["-xf", zip, "-C", this.dir], { windowsHide: true, stdio: "ignore" });
        p.on("error", rej);
        p.on("close", (code) => (code === 0 ? res() : rej(new Error(`Unpacking failed (${code})`))));
      });
      if (!existsSync(this.exe)) throw new Error("The upscaler wasn't in the download");
      writeFileAtomic(path.join(this.dir, "tool.json"), JSON.stringify({ version: ESRGAN.version, sha256: sum, installedAt: nowIso() }));
      this.gpus = null;
      this.deps.log(`Real-ESRGAN ${ESRGAN.version} installed in ${this.dir}`);
      await setState({ installing: false, progress: 1 });
    } catch (e) {
      await setState({ installing: false, error: (e as Error).message });
      throw e;
    } finally {
      await fsp.rm(dl, { recursive: true, force: true }).catch(() => undefined);
    }
    return this.tool();
  }

  /** Vulkan devices, from a verbose run on a tiny image. */
  private async listGpus(): Promise<{ index: number; name: string }[]> {
    const ff = this.deps.ff();
    if (!ff) return [];
    const tmp = path.join(this.deps.userData, "tools", "_probe");
    await fsp.mkdir(tmp, { recursive: true });
    const img = path.join(tmp, "probe.png");
    await runFfmpeg(ff.path, ["-f", "lavfi", "-i", "color=c=black:s=16x16", "-frames:v", "1", img]);
    const text = await new Promise<string>((res) => {
      let buf = "";
      const p = spawn(this.exe, ["-i", img, "-o", path.join(tmp, "out.png"), "-n", MODELS.fast.name, "-s", "2", "-v"],
        { cwd: this.dir, windowsHide: true });
      p.stdout.on("data", (d) => { buf += String(d); });
      p.stderr.on("data", (d) => { buf += String(d); });
      p.on("error", () => res(buf));
      p.on("close", () => res(buf));
    });
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return parseGpus(text);
  }

  private speeds(): Record<UpscaleModel, number> {
    try { return { ...START_MPPS, ...JSON.parse(readFileSync(this.speedFile, "utf8")) }; } catch { return { ...START_MPPS }; }
  }

  private measured(model: UpscaleModel): boolean {
    try { return typeof JSON.parse(readFileSync(this.speedFile, "utf8"))[model] === "number"; } catch { return false; }
  }

  private async serverEstimate(eid: number, targetH: number, shotIds?: number[]): Promise<{ items: EstimateItem[]; skipped: LocalUpscaleEstimate["skipped"] }> {
    return this.deps.upstream.json(`/api/episodes/${eid}/upscale/estimate`, { method: "POST", body: { target_h: targetH, shot_ids: shotIds ?? null } });
  }

  async estimate(o: { pid: number; eid: number; targetH: number; model: UpscaleModel; shotIds?: number[] }): Promise<LocalUpscaleEstimate> {
    const est = await this.serverEstimate(o.eid, o.targetH, o.shotIds);
    const mpps = this.speeds()[o.model];
    const items = est.items.map((i) => {
      const frames = Math.round(i.seconds * 24);
      const scale = chooseScale(o.model, i.from[0], i.from[1], o.targetH);
      const mid: [number, number] = [i.from[0] * scale, i.from[1] * scale];
      return { shotId: i.shot_id, code: i.code, takeId: i.take_id, from: i.from, to: outputDims(i.from[0], i.from[1], o.targetH),
        seconds: i.seconds, frames, scale, minutes: minutesFor(frames, mid, mpps) };
    });
    return { items, skipped: est.skipped, totalMinutes: Math.round(items.reduce((a, i) => a + i.minutes, 0) * 10) / 10,
      measured: this.measured(o.model) };
  }

  async start(o: { pid: number; eid: number; targetH: number; model: UpscaleModel; shotIds?: number[] }): Promise<string[]> {
    if (!this.installed()) throw new Error("Install the local upscaler first");
    const model: UpscaleModel = o.model === "best" ? "best" : "fast";
    const est = await this.serverEstimate(o.eid, o.targetH, o.shotIds);
    const busy = new Set(this.jobs.filter((j) => ["queued", "preparing", "extracting", "upscaling", "encoding", "uploading"].includes(j.status))
      .map((j) => j.takeId));
    const ids: string[] = [];
    for (const i of est.items) {
      if (busy.has(i.take_id)) continue;
      const job: UpscaleJob = { id: randomUUID(), pid: o.pid, eid: o.eid, shotId: i.shot_id, code: i.code, takeId: i.take_id, model,
        from: i.from, to: outputDims(i.from[0], i.from[1], o.targetH), scale: chooseScale(model, i.from[0], i.from[1], o.targetH),
        status: "queued", progress: 0, step: "Waiting", createdAt: nowIso() };
      this.keys.set(job.id, { key: i.key, url: i.url });
      this.jobs.push(job);
      this.queue.push(job.id);
      ids.push(job.id);
      this.emit(job, true);
    }
    void this.pump();
    return ids;
  }

  list(): UpscaleJob[] {
    return structuredClone([...this.jobs].reverse().slice(0, 100));
  }

  cancel(id: string): void {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return;
    if (this.running?.id === id) this.running.abort.abort();
    else if (j.status === "queued") {
      this.queue = this.queue.filter((q) => q !== id);
      Object.assign(j, { status: "cancelled", step: "Cancelled", finishedAt: nowIso() });
      this.emit(j, true);
    }
  }

  stopAll(): void {
    for (const id of [...this.queue]) this.cancel(id);
    this.running?.abort.abort();
  }

  private emit(j: UpscaleJob, force = false): void {
    const now = Date.now();
    if (!force && now - (this.lastEmit.get(j.id) ?? 0) < 400) return;
    this.lastEmit.set(j.id, now);
    this.deps.broadcast(structuredClone(j));
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const id = this.queue.shift();
    if (!id) return;
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return void this.pump();
    const abort = new AbortController();
    this.running = { id, abort };
    const t0 = Date.now();
    try {
      await this.run(job, abort.signal, t0);
      Object.assign(job, { status: "done" as UpscaleState, progress: 1, step: "Uploaded: renders with “Use AI upscales” use it", eta_s: 0 });
    } catch (e) {
      const cancelled = abort.signal.aborted;
      Object.assign(job, { status: (cancelled ? "cancelled" : "failed") as UpscaleState, step: cancelled ? "Cancelled" : "Failed",
        error: cancelled ? undefined : (e as Error).message });
      if (!cancelled) this.deps.log(`upscale ${job.code}: ${(e as Error).message}`);
    } finally {
      job.elapsed_s = Math.round((Date.now() - t0) / 1000);
      job.finishedAt = nowIso();
      this.emit(job, true);
      this.running = null;
      void this.pump();
    }
  }

  private async run(job: UpscaleJob, signal: AbortSignal, t0: number): Promise<void> {
    const ffi = this.deps.ff();
    if (!ffi) throw new Error("FFmpeg wasn't found: set it in File → Studio server…");
    const lib = this.deps.library;
    const folder = lib.folderFor(job.pid).path;
    const src = this.keys.get(job.id);
    if (!src) throw new Error("The clip to upscale is unknown: estimate again");
    const step = (status: UpscaleState, text: string, progress?: number) => {
      Object.assign(job, { status, step: text, ...(progress !== undefined ? { progress } : {}) });
      this.emit(job, true);
    };

    // 1. the clip on disk: the synced copy, else a download into Cache/
    step("preparing", "Getting the clip", 0.01);
    let input = lib.resolveKeyOriginal(src.key);
    if (!input || !existsSync(input)) {
      input = path.join(folder, "Cache", "upscale-src", safePart(src.key.replace(/\//g, "_")).slice(-150));
      if (!existsSync(input)) await downloadTo(this.deps.upstream, `/media/${src.key.split("/").map(encodeURIComponent).join("/")}`, input, { signal });
    }
    const info = await probeMedia(ffi.path, input);
    const fps = await new Promise<number>((res) => {
      const p = spawn(ffi.path, ["-hide_banner", "-i", input!], { windowsHide: true });
      let buf = "";
      p.stderr.on("data", (d) => { buf += String(d); });
      p.on("close", () => res(fpsOf(buf)));
      p.on("error", () => res(24));
    });
    if (!info.width || !info.height) throw new Error("Couldn't read the clip");

    const work = path.join(folder, "Cache", `upscale-${job.id.slice(0, 8)}`);
    const inDir = path.join(work, "in");
    const outDir = path.join(work, "out");
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(inDir, { recursive: true });
    await fsp.mkdir(outDir, { recursive: true });
    try {
      // 2. frames out
      step("extracting", "Reading frames", 0.03);
      await runFfmpeg(ffi.path, extractArgs(input, inDir), { signal });
      const frames = (await fsp.readdir(inDir)).filter((n) => n.endsWith(".png")).length;
      if (!frames) throw new Error("The clip has no frames");
      job.frames = frames;

      // 3. Real-ESRGAN on the graphics card
      if (this.gpus === null) this.gpus = await this.listGpus().catch(() => []);
      const gpu = pickGpu(this.gpus)?.index ?? 0;
      step("upscaling", `Upscaling ${frames} frames on the graphics card`, 0.05);
      const tUp = Date.now();
      await new Promise<void>((resolve, reject) => {
        const p = spawn(this.exe, esrganArgs({ inDir, outDir, model: job.model, scale: job.scale, gpu }), { cwd: this.dir, windowsHide: true });
        let err = "";
        p.stderr.on("data", (d) => { err = (err + String(d)).slice(-4000); });
        const tick = setInterval(() => {
          void fsp.readdir(outDir).then((names) => {
            const done = names.filter((n) => n.endsWith(".jpg")).length;
            const secs = (Date.now() - tUp) / 1000;
            job.framesDone = done;
            job.fps = done && secs ? Math.round((done / secs) * 100) / 100 : undefined;
            job.eta_s = job.fps ? Math.round((frames - done) / job.fps + 10) : undefined;
            job.progress = Math.round((0.05 + 0.85 * (done / frames)) * 1000) / 1000;
            job.step = `Upscaling frame ${done} of ${frames}`;
            job.elapsed_s = Math.round((Date.now() - t0) / 1000);
            this.emit(job);
          }).catch(() => undefined);
        }, 800);
        const onAbort = () => { if (p.pid) killTree(p.pid); };
        signal.addEventListener("abort", onAbort, { once: true });
        p.on("error", (e) => { clearInterval(tick); reject(e); });
        p.on("close", (code) => {
          clearInterval(tick);
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) reject(new Error("cancelled"));
          else if (code !== 0) reject(new Error(`Real-ESRGAN stopped (${code}): ${err.trim().split(/\r?\n/).slice(-3).join(" ")}`));
          else resolve();
        });
      });
      const upscaled = (await fsp.readdir(outDir)).filter((n) => n.endsWith(".jpg")).length;
      if (upscaled !== frames) throw new Error(`Real-ESRGAN made ${upscaled} of ${frames} frames`);
      this.learnSpeed(job.model, frames, [info.width * job.scale, info.height * job.scale], (Date.now() - tUp) / 1000);

      // 4. back into a clip, original sound, hardware encoder
      step("encoding", "Encoding the upscaled clip", 0.91);
      const enc = finalEncoder(UPSCALE_ENCODE, await this.deps.probe(), this.deps.prefer(), false);
      const out = path.join(work, `${safePart(job.code) || "shot"}_upscaled.mp4`);
      await runFfmpeg(ffi.path, encodeArgs({ framesDir: outDir, fps, source: input, out, w: job.to[0], h: job.to[1], enc: enc!.args }), { signal });

      // 5. to the server as the video's upscale take, and into the folder so the next sync needn't download it
      step("uploading", "Uploading to the studio", 0.95);
      const form = new FormData();
      form.append("file", await openAsBlob(out, { type: "video/mp4" }), path.basename(out));
      form.append("model", job.model);
      form.append("machine", this.deps.machine);
      form.append("seconds", String(Math.round((Date.now() - t0) / 1000)));
      const r = await this.deps.upstream.fetch(`/api/takes/${job.takeId}/upscales`, { method: "POST", body: form, signal });
      const body = await r.json().catch(() => ({})) as { id?: number; path?: string; detail?: unknown };
      if (!r.ok) throw new UpstreamError(r.status, body.detail ?? body, `upload: HTTP ${r.status}`);
      job.uploadedTakeId = body.id;
      if (body.path) {
        const rel = path.join("Takes", path.basename(out)).replace(/\\/g, "/");
        await fsp.mkdir(path.join(folder, "Takes"), { recursive: true });
        await fsp.rename(out, path.join(folder, rel)).catch(() => fsp.copyFile(out, path.join(folder, rel)));
        const st = await fsp.stat(path.join(folder, rel));
        lib.mirror(job.pid).upsertFile({ key: body.path, project_id: job.pid, episode_id: job.eid, shot_id: job.shotId, local_path: rel,
          name: path.basename(rel), folder: "Takes", kind: "upscale", role: "take", size: st.size, state: "ready", synced_at: nowIso() });
      }
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Keep a running average of what this card manages (output megapixels a second). */
  private learnSpeed(model: UpscaleModel, frames: number, out: [number, number], secs: number): void {
    if (secs <= 0 || frames < 8) return;
    const mpps = (frames * out[0] * out[1]) / 1e6 / secs;
    let saved: Record<string, number> = {};
    try { saved = JSON.parse(readFileSync(this.speedFile, "utf8")); } catch { /* first time */ }
    const prev = typeof saved[model] === "number" ? saved[model] : undefined;
    saved[model] = Math.round((prev ? prev * 0.6 + mpps * 0.4 : mpps) * 100) / 100;
    try { writeFileAtomic(this.speedFile, JSON.stringify(saved)); } catch (e) { this.deps.log(`upscale-speed.json: ${(e as Error).message}`); }
  }
}
