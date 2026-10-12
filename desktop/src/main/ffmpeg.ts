/**
 * FFmpeg on this PC: find it, list and test-encode the hardware encoders, run it with progress and cancel,
 * read media info, and the machine check against the RTX 3060 / 32 GB / NVMe baseline (docs/DESKTOP.md §4).
 * Electron-free (index.ts passes the GPU info and displays in).
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MachineReport } from "../shared/types.ts";
import { writeFileAtomic } from "./config.ts";
import { diskInfo } from "./library.ts";

export class FfmpegError extends Error {
  code: number | null;
  tail: string;
  constructor(message: string, code: number | null, tail: string) {
    super(message);
    this.code = code;
    this.tail = tail;
  }
}

export interface FfmpegInfo { path: string; source: string; version: string; major: number }

export function ffmpegVersion(exe: string): { version: string; major: number } {
  try {
    const r = spawnSync(exe, ["-hide_banner", "-version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    const m = /ffmpeg version (n?)(\S+)/.exec(r.stdout || "");
    const version = m ? m[2] : "";
    const major = Number(/^(\d+)/.exec(version)?.[1] ?? 0);
    return { version: version || "unknown", major };
  } catch {
    return { version: "", major: 0 };
  }
}

function devFallbacks(appPath: string): string[] {
  // the backend's imageio-ffmpeg copy (FFmpeg 7.1 with NVENC) in this checkout or a parent checkout (worktrees)
  const out: string[] = [];
  let dir = path.resolve(appPath);
  for (let i = 0; i < 8; i++) {
    const bin = path.join(dir, "backend", ".venv", "Lib", "site-packages", "imageio_ffmpeg", "binaries");
    if (existsSync(bin)) {
      for (const f of readdirSync(bin)) if (/^ffmpeg.*\.exe$/i.test(f) || /^ffmpeg-linux|^ffmpeg-macos/i.test(f)) out.push(path.join(bin, f));
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

function onPath(): string | null {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  for (const d of (process.env.PATH || "").split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, exe);
    if (existsSync(p)) return p;
  }
  return null;
}

function ffmpegStatic(appPath: string): string | null {
  try {
    const req = createRequire(path.join(appPath, "package.json"));
    const p = req("ffmpeg-static") as string | null;
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Find FFmpeg: the path in Settings → the bundled resources/ffmpeg.exe → ffmpeg-static → the system one → the
 * backend's imageio copy (dev). Builds older than FFmpeg 7 (ffmpeg-static ships 6.1, without vidstab and the newer
 * xfade transitions the server uses) are only taken when nothing newer is found.
 */
export function locateFfmpeg(opts: { configured?: string; resourcesPath?: string; appPath: string; packaged: boolean }): FfmpegInfo | null {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const cands: { path: string | null | undefined; source: string; strict: boolean }[] = [
    { path: opts.configured, source: "settings", strict: true },
    { path: process.env.TATVAM_FFMPEG, source: "env", strict: true },
    { path: opts.resourcesPath ? path.join(opts.resourcesPath, exe) : null, source: "bundled", strict: true },
    { path: ffmpegStatic(opts.appPath), source: "ffmpeg-static", strict: false },
    { path: onPath(), source: "system", strict: false },
    ...(opts.packaged ? [] : devFallbacks(opts.appPath).map((p) => ({ path: p, source: "backend-imageio", strict: false }))),
  ];
  let fallback: FfmpegInfo | null = null;
  for (const c of cands) {
    if (!c.path || !existsSync(c.path)) continue;
    const v = ffmpegVersion(c.path);
    if (!v.version) continue;
    const info = { path: c.path, source: c.source, ...v };
    if (c.strict || v.major >= 7) return info;
    fallback ??= info;
  }
  return fallback;
}

export function listEncoders(ff: string): Set<string> {
  const r = spawnSync(ff, ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  const out = new Set<string>();
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    const m = /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

export const HW_PROBES: Record<string, string[]> = {
  h264_nvenc: ["-c:v", "h264_nvenc", "-preset", "p4"],
  hevc_nvenc: ["-c:v", "hevc_nvenc", "-preset", "p4"],
  hevc_nvenc_10bit: ["-c:v", "hevc_nvenc", "-preset", "p4", "-profile:v", "main10", "-pix_fmt", "p010le"],
  av1_nvenc: ["-c:v", "av1_nvenc", "-preset", "p4"],
  h264_qsv: ["-c:v", "h264_qsv"],
  hevc_qsv: ["-c:v", "hevc_qsv"],
  hevc_qsv_10bit: ["-c:v", "hevc_qsv", "-profile:v", "main10", "-pix_fmt", "p010le"],
  h264_amf: ["-c:v", "h264_amf"],
  hevc_amf: ["-c:v", "hevc_amf"],
};

function testEncode(ff: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(ff, ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24", "-t", "0.5",
      ...args, "-f", "null", "-"], { timeout: 25_000, windowsHide: true }, (err) => resolve(!err));
  });
}

/** Test-encode half a second on each hardware encoder this build has; cached per FFmpeg binary in `cacheFile`. */
export async function probeHardware(ff: string, cacheFile?: string, force = false): Promise<Record<string, boolean>> {
  let stamp = "";
  try { stamp = `${ff}|${statSync(ff).size}|${statSync(ff).mtimeMs}`; } catch { stamp = ff; }
  if (cacheFile && !force) {
    try {
      const c = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (c.stamp === stamp && c.result) return c.result as Record<string, boolean>;
    } catch { /* no cache */ }
  }
  const have = listEncoders(ff);
  const result: Record<string, boolean> = {};
  for (const [name, args] of Object.entries(HW_PROBES)) {
    const enc = args[1];
    result[name] = have.has(enc) ? await testEncode(ff, args) : false;
  }
  for (const sw of ["libx264", "libx265", "prores_ks", "libsvtav1"]) result[sw] = have.has(sw);
  if (cacheFile) writeFileAtomic(cacheFile, JSON.stringify({ stamp, result, at: new Date().toISOString() }, null, 2));
  return result;
}

export interface FfProgress { outTimeS: number; speed: string; fps: number; frame: number }

/** Kill a process and its children (Windows needs taskkill /T for FFmpeg's helper threads to stop at once). */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
  } else {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
}

/** Parse FFmpeg's `-progress` key=value lines (out_time_ms is in microseconds, despite the name). */
export function parseProgress(block: string): Partial<FfProgress> & { end?: boolean } {
  const kv: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const out: Partial<FfProgress> & { end?: boolean } = {};
  const us = kv.out_time_us ?? kv.out_time_ms;
  if (us && /^\d+$/.test(us)) out.outTimeS = Number(us) / 1e6;
  if (kv.speed) out.speed = kv.speed;
  if (kv.fps) out.fps = Number(kv.fps) || 0;
  if (kv.frame) out.frame = Number(kv.frame) || 0;
  if (kv.progress === "end") out.end = true;
  return out;
}

export interface RunOptions {
  onProgress?(p: FfProgress): void;
  signal?: AbortSignal;
  cwd?: string;
  timeoutMs?: number;
  log?(line: string): void;
}

/** Run FFmpeg (args without the binary) with `-progress pipe:1`. Rejects with the stderr tail on failure. */
export function runFfmpeg(ff: string, args: string[], opts: RunOptions = {}): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new FfmpegError("cancelled", null, ""));
      return;
    }
    const full = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", ...args];
    const child = spawn(ff, full, { cwd: opts.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let buf = "";
    const cur: FfProgress = { outTimeS: 0, speed: "", fps: 0, frame: 0 };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("progress=")) >= 0) {
        const nl = buf.indexOf("\n", i);
        if (nl < 0) break;
        const p = parseProgress(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        Object.assign(cur, Object.fromEntries(Object.entries(p).filter(([k]) => k !== "end")));
        opts.onProgress?.({ ...cur });
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    let killed = false;
    const onAbort = () => {
      killed = true;
      if (child.pid) killTree(child.pid);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = opts.timeoutMs ? setTimeout(onAbort, opts.timeoutMs) : null;
    child.on("error", (e) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      reject(new FfmpegError(`ffmpeg could not start: ${e.message}`, null, ""));
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      if (code === 0 && !killed) {
        resolve({ stderr });
        return;
      }
      const tail = stderr.trim().split(/\r?\n/).slice(-15).join("\n");
      reject(new FfmpegError(killed ? "cancelled" : `ffmpeg failed (${code}): ${tail}`, code, tail));
    });
  });
}

export interface MediaInfo { duration: number; width: number; height: number; hasAudio: boolean; hasVideo: boolean }

/** Duration, size and streams from `ffmpeg -i` (the same parsing the server does). */
export function parseMediaInfo(stderr: string): MediaInfo {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const v = /Stream #.*Video:.*?(\d{2,5})x(\d{2,5})/.exec(stderr);
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    width: v ? Number(v[1]) : 0,
    height: v ? Number(v[2]) : 0,
    hasAudio: /Stream #.*Audio:/.test(stderr),
    hasVideo: /Stream #.*Video:/.test(stderr),
  };
}

export function probeMedia(ff: string, file: string): Promise<MediaInfo> {
  return new Promise((resolve) => {
    execFile(ff, ["-hide_banner", "-i", file], { timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_err, _out, stderr) => {
      resolve(parseMediaInfo(String(stderr || "")));
    });
  });
}

// ── machine check ──────────────────────────────────────────────────────────

export interface MachineDeps {
  ffmpeg: FfmpegInfo | null;
  encoders: Record<string, boolean>;
  libraryRoot: string;
  gpuInfo?: unknown;
  displays: { id: number; label: string; width: number; height: number; scaleFactor: number; primary: boolean }[];
}

type Rating = "good" | "ok" | "below";

function run(cmd: string, args: string[], timeout = 8000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, encoding: "utf8" }, (err, out) => resolve(err ? "" : String(out || "")));
  });
}

/** GPU names from Electron's complete GPU info (device strings on Windows). */
export function gpuNamesFromInfo(info: unknown): string[] {
  const out: string[] = [];
  const devs = (info as { gpuDevice?: { deviceString?: string; active?: boolean }[] } | undefined)?.gpuDevice ?? [];
  for (const d of devs) if (d?.deviceString) out.push(d.deviceString);
  const r = (info as { auxAttributes?: { glRenderer?: string } } | undefined)?.auxAttributes?.glRenderer;
  if (!out.length && r) out.push(r.replace(/^ANGLE \((.*)\)$/, "$1"));
  return [...new Set(out)];
}

function vendorOf(name: string): string {
  return /nvidia|geforce|rtx|gtx|quadro/i.test(name) ? "NVIDIA" : /intel|arc|iris|uhd/i.test(name) ? "Intel" : /amd|radeon/i.test(name) ? "AMD" : "";
}

/** How a GPU compares with the RTX 3060 baseline. */
export function rateGpu(name: string, vramMb?: number): { verdict: Rating; note: string } {
  const rtx = /RTX\s*(?:A)?(\d{2})(\d{2})/i.exec(name);
  if (rtx) {
    const gen = Number(rtx[1]);
    const tier = Number(rtx[2]);
    if (gen >= 40) return { verdict: "good", note: "At or above the RTX 3060 baseline, with AV1 encoding" };
    if (gen >= 30 && tier >= 60) return { verdict: "good", note: "At or above the RTX 3060 baseline" };
    return { verdict: "ok", note: "NVENC handles H.264 and HEVC (10-bit too); slower than the RTX 3060 baseline, no AV1" };
  }
  if (/GTX\s*16\d\d/i.test(name)) {
    const mem = vramMb ? `${Math.round(vramMb / 1024)} GB` : "less";
    return { verdict: "ok", note: `Turing NVENC encodes H.264 and HEVC (10-bit too) in hardware, but not AV1, and ${mem} of video memory against the baseline's 12 GB makes 4K effects slower` };
  }
  if (/GTX|Quadro|NVIDIA/i.test(name)) return { verdict: "below", note: "An older NVIDIA card: hardware encoding may be limited" };
  if (/Arc|Iris|UHD|Intel/i.test(name)) return { verdict: "ok", note: "Intel Quick Sync encodes in hardware; GPU effects are slower than the baseline" };
  if (/Radeon|AMD/i.test(name)) return { verdict: "ok", note: "AMD AMF encodes in hardware; GPU effects may be slower than the baseline" };
  return { verdict: "below", note: "No known hardware encoder: renders use the CPU" };
}

export const ENCODER_LABELS: Record<string, string> = {
  h264_nvenc: "NVIDIA H.264", hevc_nvenc: "NVIDIA HEVC", hevc_nvenc_10bit: "NVIDIA HEVC 10-bit", av1_nvenc: "NVIDIA AV1",
  h264_qsv: "Intel H.264", hevc_qsv: "Intel HEVC", hevc_qsv_10bit: "Intel HEVC 10-bit", h264_amf: "AMD H.264", hevc_amf: "AMD HEVC",
  libx264: "x264 (CPU)", libx265: "x265 (CPU)", prores_ks: "ProRes (CPU)", libsvtav1: "SVT-AV1 (CPU)",
};

/** The probe as the machine-check list. */
export function encoderList(probe: Record<string, boolean>): NonNullable<MachineReport["encoders"]> {
  return Object.entries(probe).map(([id, ok]) => {
    const hardware = /_(nvenc|qsv|amf)/.test(id);
    let note: string | undefined;
    if (!ok && id === "av1_nvenc") note = "Needs an RTX 40-series card or newer";
    else if (!ok && hardware) note = "Not available on this PC";
    return { id, label: ENCODER_LABELS[id] ?? id, hardware, ok, ...(note ? { note } : {}) };
  });
}

const rank: Record<Rating | "unknown", number> = { good: 2, ok: 1, below: 0, unknown: 1 };

interface Item { label: string; value: string; baseline: string; rating: Rating | "unknown"; note?: string }

export async function machineCheck(deps: MachineDeps): Promise<MachineReport> {
  const notes: string[] = [];
  const items: Item[] = [];
  const gpus: NonNullable<MachineReport["gpus"]> = [];
  const smi = await run("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"]);
  for (const line of smi.split(/\r?\n/).filter(Boolean)) {
    const [name, mem, driver] = line.split(",").map((x) => x.trim());
    gpus.push({ name, vendor: "NVIDIA", vramBytes: Number(mem) ? Number(mem) * 1024 * 1024 : undefined, driver });
  }
  for (const n of gpuNamesFromInfo(deps.gpuInfo)) {
    if (!gpus.some((g) => g.name.toLowerCase() === n.toLowerCase())) gpus.push({ name: n, vendor: vendorOf(n) || undefined });
  }
  const main = gpus.find((g) => /nvidia/i.test(g.vendor ?? "")) ?? gpus[0];
  const vramMb = main?.vramBytes ? main.vramBytes / 1024 / 1024 : undefined;
  if (main) {
    const r = rateGpu(main.name, vramMb);
    items.push({ label: "Graphics card", value: `${main.name}${vramMb ? ` (${Math.round(vramMb / 1024)} GB)` : ""}`, baseline: "RTX 3060, 12 GB", rating: r.verdict, note: r.note });
  } else {
    items.push({ label: "Graphics card", value: "Not detected", baseline: "RTX 3060, 12 GB", rating: "unknown" });
  }
  const e = deps.encoders;
  const hevcHw = Boolean(e.hevc_nvenc || e.hevc_qsv || e.hevc_amf);
  const h264Hw = Boolean(e.h264_nvenc || e.h264_qsv || e.h264_amf);
  const hwList = Object.entries(e).filter(([k, v]) => v && /_(nvenc|qsv|amf)/.test(k)).map(([k]) => ENCODER_LABELS[k] ?? k);
  items.push({
    label: "Hardware encoding", value: hwList.length ? hwList.join(", ") : "none", baseline: "H.264, HEVC 10-bit and AV1 on the GPU",
    rating: hevcHw ? "good" : h264Hw ? "ok" : "below",
    note: hevcHw ? (e.av1_nvenc ? "4K HEVC and AV1 encode on the GPU" : "4K HEVC encodes on the GPU; AV1 isn't available here, so the AV1 preset is hidden")
      : h264Hw ? "Only H.264 encodes on the GPU; HEVC uses the CPU (slower)" : "Every render encodes on the CPU (much slower)",
  });
  const cpus = os.cpus();
  const threads = os.availableParallelism?.() ?? cpus.length;
  const cpuName = cpus[0]?.model.trim() ?? "unknown";
  items.push({ label: "Processor", value: `${cpuName} (${threads} threads)`, baseline: "12 threads", rating: threads >= 12 ? "good" : threads >= 8 ? "ok" : "below" });
  const ramBytes = os.totalmem();
  const ramGb = Math.round((ramBytes / 1024 ** 3) * 10) / 10;
  items.push({ label: "Memory", value: `${ramGb} GB`, baseline: "32 GB", rating: ramGb >= 31 ? "good" : ramGb >= 15 ? "ok" : "below",
    note: ramGb >= 31 ? undefined : "Long 4K timelines may page to disk with less than 32 GB" });
  const root = existsSync(deps.libraryRoot) ? deps.libraryRoot : path.parse(path.resolve(deps.libraryRoot)).root || os.homedir();
  const disk = diskInfo(root);
  let bus: string | undefined;
  if (process.platform === "win32") {
    const letter = /^([A-Za-z]):/.exec(path.resolve(root))?.[1];
    if (letter) {
      bus = (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Partition -DriveLetter ${letter} | Get-Disk | Select-Object -First 1 -ExpandProperty BusType)`], 10_000)).trim() || undefined;
    }
  }
  const freeGb = disk.freeBytes / 1024 ** 3;
  const busRating: Rating | "unknown" = !bus ? "unknown" : /nvme/i.test(bus) ? "good" : /sata|raid|sas/i.test(bus) ? "ok" : "below";
  let diskRating: Rating | "unknown" = busRating === "unknown" ? (freeGb >= 200 ? "good" : "ok") : busRating;
  if (diskRating === "good" && freeGb < 200) diskRating = "ok";
  if (freeGb < 50) diskRating = "below";
  items.push({ label: "Library disk", value: `${bus ? `${bus}, ` : ""}${freeGb.toFixed(0)} GB free`, baseline: "NVMe SSD, 200 GB free", rating: diskRating,
    note: freeGb < 50 ? "Under 50 GB free: a 4K project with proxies and masters needs much more"
      : bus && !/nvme/i.test(bus) ? "The baseline is an NVMe SSD" : freeGb < 200 ? "Less than 200 GB free for 4K masters and proxies" : undefined });
  const big = deps.displays.filter((d) => Math.max(d.width * d.scaleFactor, d.height * d.scaleFactor) >= 3840).length;
  items.push({ label: "Displays", value: `${deps.displays.length}${big ? ` (${big} at 4K)` : ""}`, baseline: "2 screens", rating: deps.displays.length >= 2 ? "good" : "ok",
    note: deps.displays.length < 2 ? "A second screen lets the program monitor run full screen" : undefined });
  if (!deps.ffmpeg) notes.push("FFmpeg wasn't found: set its path in Settings.");
  else if (deps.ffmpeg.major < 7) notes.push(`FFmpeg ${deps.ffmpeg.version} is older than the server's 7.1: some transitions and stabilising may not render.`);
  for (const i of items) if (i.note && i.rating !== "good") notes.push(`${i.label}: ${i.note}.`);
  const key = items.filter((i) => ["Graphics card", "Hardware encoding", "Memory", "Library disk"].includes(i.label));
  const worst = key.reduce((m, i) => Math.min(m, rank[i.rating]), 2);
  const verdict: MachineReport["verdict"] = worst >= 2 ? "ok" : worst >= 1 ? "warn" : "bad";
  const summary = verdict === "ok" ? "This PC meets the finishing-room baseline."
    : verdict === "warn" ? "This PC can finish in 4K, but parts of it are below the baseline, so renders take longer."
      : "This PC is below the baseline: 4K renders will be slow, so cut with proxies and render overnight.";
  return {
    hostname: os.hostname(), os: `${os.type()} ${os.release()} (${os.arch()})`, cpu: cpuName, cores: threads, ramBytes, gpus,
    encoders: encoderList(e), nvenc: Boolean(e.h264_nvenc || e.hevc_nvenc),
    ffmpeg: deps.ffmpeg ? { path: deps.ffmpeg.path, version: deps.ffmpeg.version, source: deps.ffmpeg.source } : undefined,
    disk: { path: root, freeBytes: disk.freeBytes, totalBytes: disk.totalBytes, kind: bus },
    displays: deps.displays,
    baseline: { label: "NVIDIA RTX 3060 (12 GB), 32 GB RAM, NVMe SSD", items: items.map((i) => ({ label: i.label, value: i.value, baseline: i.baseline, ok: i.rating === "good" })) },
    verdict, notes, checkedAt: new Date().toISOString(), summary,
  };
}
