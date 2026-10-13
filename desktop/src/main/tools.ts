/**
 * Local tools installed on demand (docs/EDITOR.md §10, desktop-tools): the pinned official builds of Real-ESRGAN
 * (aiupscale.ts), RIFE (slow motion), whisper.cpp (CPU and CUDA) and two whisper models. Each file is downloaded once
 * into userData/tools/_download (resumable: a `.part` continues with a Range request), checked against its pinned size
 * and SHA-256, and then unpacked with Windows' tar.exe (zips) or moved into place (models). A `tool.json` marker next to
 * the program (or `<model>.json` next to a model) says it is installed. Nothing runs from an unchecked file.
 *
 * Pinned files (sizes from the releases, SHA-256 computed after the first download and cross-checked with GitHub's
 * asset digests and Hugging Face's LFS hashes where they publish one):
 *   realesrgan  realesrgan-ncnn-vulkan-20220424-windows.zip  45,474,481   abc02804…802d  (BSD-3, xinntao/Real-ESRGAN v0.2.5.0)
 *   rife        rife-ncnn-vulkan-20221029-windows.zip        431,540,241  d8e4d772…a606  (MIT, nihui/rife-ncnn-vulkan 20221029)
 *   whisper     whisper-bin-x64.zip                          8,928,640    6ba69e34…6ccb  (MIT, ggml-org/whisper.cpp b5454)
 *   whisper-cuda whisper-bin-win-cuda-12.4.0-x64.zip         684,913,404  afef0b88…957a  (MIT, ggml-org/whisper.cpp b5454; ships cuBLAS 12,
 *               needs an NVIDIA driver ≥ 551.61. The 11.8 zip it replaced lacks cuBLAS: an installed copy reads "outdated")
 *   models      ggml-base.bin 147,951,465 60ed5bc3…2efe; ggml-large-v3-turbo-q5_0.bin 574,041,195 39422170…a7e2
 *               (MIT, huggingface.co/ggerganov/whisper.cpp at commit 5359861c)
 * Electron-free: the GPU probes spawn the tools themselves; tests use the pure helpers and a local HTTP server.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, promises as fsp, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ToolId, ToolStatus } from "../shared/types.ts";
import { writeFileAtomic } from "./config.ts";
import { parseGpus, pickGpu } from "./aiupscale.ts";

export interface PinnedFile { file: string; url: string; size: number; sha256: string }

export interface ToolDef {
  id: ToolId;
  label: string;
  version: string;
  license: string;
  note: string;
  kind: "program" | "model";
  /** Folder under userData/tools (models share one folder). */
  dir: string;
  pin: PinnedFile;
  /** Programs: the executable's file name, found anywhere in the unpacked folder. */
  exe?: string;
  /** Vulkan tools list their devices; whisper-cuda looks for an NVIDIA card. */
  gpu?: "vulkan" | "nvidia";
  /** whisper-cuda: the NVIDIA driver it needs, and the runtime DLLs that must sit next to the program (or on PATH) */
  driver?: string;
  dlls?: string[];
  /** earlier builds of this tool (their folders): reported as outdated, removed when the new one is installed */
  legacy?: { dir: string; label: string }[];
}

/** The CUDA 12 runtime ggml-cuda.dll loads (the 12.4 zip ships them next to whisper-cli.exe). */
export const CUDA_DLLS = ["cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll"];

const HF = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1";
const WHISPER = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454";

export const TOOLS: Record<ToolId, ToolDef> = {
  realesrgan: {
    id: "realesrgan", label: "Real-ESRGAN (AI upscale)", version: "0.2.5.0", license: "BSD-3-Clause", kind: "program", dir: "realesrgan-0.2.5.0",
    note: "Upscales clips to 2K or 4K on the graphics card (Vulkan).", exe: "realesrgan-ncnn-vulkan.exe", gpu: "vulkan",
    pin: { file: "realesrgan-ncnn-vulkan-20220424-windows.zip", size: 45_474_481, sha256: "abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d",
      url: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip" },
  },
  rife: {
    id: "rife", label: "RIFE (slow motion)", version: "20221029", license: "MIT", kind: "program", dir: "rife-20221029",
    note: "Makes the in-between frames for smooth slow motion and frame-rate changes, on the graphics card (Vulkan).",
    exe: "rife-ncnn-vulkan.exe", gpu: "vulkan",
    pin: { file: "rife-ncnn-vulkan-20221029-windows.zip", size: 431_540_241, sha256: "d8e4d772d26cd8006ef0ad0bc82eb191b53c68677d1ae2f42506d74cbbbea606",
      url: "https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip" },
  },
  whisper: {
    id: "whisper", label: "whisper.cpp (speech to text, CPU)", version: "b5454", license: "MIT", kind: "program", dir: "whisper-b5454-cpu",
    note: "Transcribes speech with word timings on this PC's processor.", exe: "whisper-cli.exe",
    pin: { file: "whisper-bin-x64.zip", size: 8_928_640, sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb", url: `${WHISPER}/whisper-bin-x64.zip` },
  },
  "whisper-cuda": {
    id: "whisper-cuda", label: "whisper.cpp for NVIDIA (CUDA 12.4)", version: "b5454-cuda12.4", license: "MIT", kind: "program", dir: "whisper-b5454-cuda12",
    note: "The same transcription on an NVIDIA graphics card (driver 551.61 or newer), many times faster.", exe: "whisper-cli.exe", gpu: "nvidia",
    driver: "551.61", dlls: CUDA_DLLS, legacy: [{ dir: "whisper-b5454-cuda", label: "CUDA 11.8 build without cuBLAS" }],
    pin: { file: "whisper-bin-win-cuda-12.4.0-x64.zip", size: 684_913_404, sha256: "afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a",
      url: `${WHISPER}/whisper-bin-win-cuda-12.4.0-x64.zip` },
  },
  "whisper-model:base": {
    id: "whisper-model:base", label: "Whisper model: base (fast)", version: "ggml-base", license: "MIT", kind: "model", dir: "whisper-models",
    note: "Small and quick; fine for clear English, rough for Indic languages.",
    pin: { file: "ggml-base.bin", size: 147_951_465, sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe", url: `${HF}/ggml-base.bin` },
  },
  "whisper-model:large-v3-turbo-q5": {
    id: "whisper-model:large-v3-turbo-q5", label: "Whisper model: large-v3-turbo (best)", version: "ggml-large-v3-turbo-q5_0", license: "MIT", kind: "model",
    dir: "whisper-models", note: "The accurate one for Hindi, Kannada, Telugu, Tamil and English (quantised, 548 MB).",
    pin: { file: "ggml-large-v3-turbo-q5_0.bin", size: 574_041_195, sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
      url: `${HF}/ggml-large-v3-turbo-q5_0.bin` },
  },
};

export const TOOL_IDS = Object.keys(TOOLS) as ToolId[];
export const isToolId = (v: unknown): v is ToolId => typeof v === "string" && (TOOL_IDS as string[]).includes(v);

/** The model tool of a whisper model name. */
export const WHISPER_MODELS: Record<"base" | "large-v3-turbo-q5", ToolId> = { base: "whisper-model:base", "large-v3-turbo-q5": "whisper-model:large-v3-turbo-q5" };

// ── pure helpers (unit-tested) ──

/** The first file called `name` (case-insensitive) under `dir`, breadth first, as a path relative to `dir`. */
export function findFile(dir: string, name: string, maxDepth = 4): string | null {
  const want = name.toLowerCase();
  let level: string[] = [""];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      let entries: { name: string; isDirectory(): boolean }[] = [];
      try { entries = readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { continue; }
      for (const e of entries) if (!e.isDirectory() && e.name.toLowerCase() === want) return path.join(rel, e.name);
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith("_")) next.push(path.join(rel, e.name));
    }
    level = next;
  }
  return null;
}

/** "555.97" ≥ "551.61"? (dotted numbers, compared part by part) */
export function versionAtLeast(have: string, need: string): boolean {
  const a = have.split(".").map((x) => Number(x) || 0);
  const b = need.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** The driver from `nvidia-smi --query-gpu=driver_version --format=csv,noheader` (the first card's), or null. */
export function parseDriverVersion(text: string): string | null {
  const m = /^\s*(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(text);
  return m ? m[1] : null;
}

/** NVIDIA cards from `nvidia-smi -L`: "GPU 0: NVIDIA GeForce GTX 1660 Ti (UUID: GPU-…)". */
export function parseNvidiaSmi(text: string): { index: number; name: string }[] {
  const out: { index: number; name: string }[] = [];
  for (const m of text.matchAll(/^GPU (\d+):\s*(.+?)\s*(?:\(UUID:[^)]*\))?\s*$/gm)) out.push({ index: Number(m[1]), name: m[2].trim() });
  return out;
}

/** A 16×16 black PNG: the probe image for the Vulkan tools' device list (no FFmpeg needed). */
export const PROBE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNkYPjPQApgIkn1qIahqgEAKsoBHzxgXXkAAAAASUVORK5CYII=", "base64");

/** Stream a file through SHA-256. */
export function sha256File(file: string, onBytes?: (n: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(file);
    s.on("data", (b) => { h.update(b as Buffer); onBytes?.((b as Buffer).length); });
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/**
 * Download a pinned file to `dest` (resumes `dest.part`), capped at the pinned size; only a file whose size and SHA-256
 * match becomes `dest`. A complete `dest` that already matches is used as it is.
 */
export async function downloadPinned(pin: PinnedFile, dest: string, o: { signal?: AbortSignal; onProgress?(got: number): void; fetchImpl?: typeof fetch } = {}): Promise<void> {
  const doFetch = o.fetchImpl ?? fetch;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (existsSync(dest)) {
    if (statSync(dest).size === pin.size && (await sha256File(dest)) === pin.sha256) return;
    await fsp.rm(dest, { force: true });
  }
  const part = `${dest}.part`;
  let have = existsSync(part) ? statSync(part).size : 0;
  if (have > pin.size) { await fsp.rm(part, { force: true }); have = 0; }
  const hash = createHash("sha256");
  if (have > 0) await new Promise<void>((res, rej) => { // the bytes already there count towards the hash
    const s = createReadStream(part, { end: have - 1 });
    s.on("data", (b) => hash.update(b as Buffer));
    s.on("error", rej);
    s.on("end", () => res());
  });
  let got = have;
  if (have < pin.size) {
    const r = await doFetch(pin.url, { redirect: "follow", signal: o.signal, headers: have ? { Range: `bytes=${have}-` } : {} });
    if (!r.ok || !r.body) throw new Error(`Download failed: HTTP ${r.status}`);
    if (have && r.status !== 206) { // the server ignored the range: start again
      await fsp.rm(part, { force: true });
      return downloadPinned(pin, dest, o);
    }
    // network bytes go only to `<dest>.part`, capped at the pinned size; it becomes `dest` only after the size and SHA-256 match
    const out = createWriteStream(part, { flags: have ? "a" : "w" });
    try {
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        got += chunk.byteLength;
        if (got > pin.size) throw new Error("The download is bigger than the expected file, so it was stopped");
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((res) => out.once("drain", () => res()));
        o.onProgress?.(got);
      }
    } finally {
      await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    }
  }
  const sum = hash.digest("hex");
  if (got !== pin.size || sum !== pin.sha256) {
    await fsp.rm(part, { force: true });
    throw new Error(`The download of ${pin.file} didn't match the expected file (${got} bytes), so it wasn't installed`);
  }
  await fsp.rename(part, dest);
}

/** Unpack a checked zip with Windows' own tar.exe. */
export function unzip(zip: string, dir: string): Promise<void> {
  const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return new Promise<void>((res, rej) => {
    const p = spawn(tar, ["-xf", zip, "-C", dir], { windowsHide: true, stdio: "ignore" });
    p.on("error", rej);
    p.on("close", (code) => (code === 0 ? res() : rej(new Error(`Unpacking failed (${code})`))));
  });
}

/** Run a program and collect its output (device probes). */
function capture(exe: string, args: string[], cwd: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    let p;
    try { p = spawn(exe, args, { cwd, windowsHide: true }); } catch { resolve(""); return; }
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, timeoutMs);
    p.stdout?.on("data", (d) => { buf += String(d); });
    p.stderr?.on("data", (d) => { buf += String(d); });
    p.on("error", () => { clearTimeout(t); resolve(buf); });
    p.on("close", () => { clearTimeout(t); resolve(buf); });
  });
}

// ── the manager ──

export interface ToolDeps {
  userData: string;
  broadcast(t: ToolStatus): void;
  log(msg: string): void;
  /** Called after a tool was installed or removed (aiupscale refreshes its own status). */
  onChange?(id: ToolId): void;
  fetchImpl?: typeof fetch;
  /** Test hook: pretend to be on this platform. */
  platform?: NodeJS.Platform;
}

interface State { installing: boolean; progress: number; error?: string }

export class ToolManager {
  private deps: ToolDeps;
  private state = new Map<ToolId, State>();
  private running = new Map<ToolId, Promise<ToolStatus>>();
  private gpus = new Map<ToolId, { index: number; name: string }[]>();
  private nvidia: { index: number; name: string }[] | null = null;
  private driver: string | null | undefined = undefined;
  private busy = new Map<ToolId, number>();

  constructor(deps: ToolDeps) {
    this.deps = deps;
  }

  get root(): string { return path.join(this.deps.userData, "tools"); }
  private get platform(): NodeJS.Platform { return this.deps.platform ?? process.platform; }
  supported(): boolean { return this.platform === "win32"; }

  dirOf(id: ToolId): string { return path.join(this.root, TOOLS[id].dir); }

  /** The installed program (absolute path) or model file, else null. */
  pathOf(id: ToolId): string | null {
    const def = TOOLS[id];
    const dir = this.dirOf(id);
    if (def.kind === "model") {
      const f = path.join(dir, def.pin.file);
      try {
        if (statSync(f).size === def.pin.size && existsSync(`${f}.json`)) return f;
      } catch { /* not there */ }
      return null;
    }
    try {
      const marker = JSON.parse(readFileSync(path.join(dir, "tool.json"), "utf8")) as { exe?: string };
      const rel = marker.exe ?? def.exe!;
      const exe = path.join(dir, rel);
      return existsSync(exe) ? exe : null;
    } catch {
      return null;
    }
  }

  installed(id: ToolId): boolean { return this.supported() && this.pathOf(id) !== null; }

  /** Folders where the CUDA build finds its CUDA 12 runtime: its own (the 12.4 zip ships it), CUDA_PATH_V12_4 / CUDA_PATH bin, then PATH. */
  cudaDirs(): string[] {
    const exe = this.pathOf("whisper-cuda");
    const dirs = [exe ? path.dirname(exe) : "", process.env.CUDA_PATH_V12_4 ? path.join(process.env.CUDA_PATH_V12_4, "bin") : "",
      process.env.CUDA_PATH ? path.join(process.env.CUDA_PATH, "bin") : "", ...(process.env.PATH ?? "").split(path.delimiter)];
    return [...new Set(dirs.filter(Boolean))];
  }

  /** CUDA runtime DLLs ggml-cuda.dll loads that aren't in any of cudaDirs(). */
  cudaMissing(): string[] {
    const dirs = this.cudaDirs();
    return (TOOLS["whisper-cuda"].dlls ?? []).filter((dll) => !dirs.some((d) => existsSync(path.join(d, dll))));
  }

  /** The NVIDIA driver version (nvidia-smi), cached; null without an NVIDIA card. */
  async nvidiaDriver(): Promise<string | null> {
    if (this.driver !== undefined) return this.driver;
    const exe = this.smi();
    this.driver = exe ? parseDriverVersion(await capture(exe, ["--query-gpu=driver_version", "--format=csv,noheader"], path.dirname(exe), 15_000)) : null;
    return this.driver;
  }

  /** Whether transcription can run on CUDA here, or why not (no card, an old driver, not installed, missing runtime). */
  async cudaReady(): Promise<{ ok: boolean; reason?: string; driver: string | null }> {
    const need = TOOLS["whisper-cuda"].driver ?? "0";
    if (!(await this.nvidiaGpus()).length) return { ok: false, reason: "No NVIDIA graphics card was found", driver: null };
    const driver = await this.nvidiaDriver();
    if (!driver || !versionAtLeast(driver, need)) {
      return { ok: false, reason: `The NVIDIA driver is ${driver ?? "unknown"}: CUDA 12.4 needs ${need} or newer (update it from nvidia.com)`, driver };
    }
    if (!this.pathOf("whisper-cuda")) {
      return { ok: false, reason: this.legacyInstalled("whisper-cuda") ? "The installed CUDA build is the old 11.8 one: install the CUDA 12.4 build"
        : "whisper.cpp for NVIDIA isn't installed", driver };
    }
    const missing = this.cudaMissing();
    if (missing.length) return { ok: false, reason: `The CUDA build is missing ${missing.join(", ")}`, driver };
    return { ok: true, driver };
  }

  /** An earlier build of the tool is still in its old folder. */
  legacyInstalled(id: ToolId): boolean {
    return (TOOLS[id].legacy ?? []).some((l) => existsSync(path.join(this.root, l.dir, "tool.json")));
  }

  private smi(): string | null {
    if (!this.supported()) return null;
    const cands = [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "nvidia-smi.exe"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe")];
    return cands.find((c) => existsSync(c)) ?? null;
  }

  /** Mark a tool in use while a job runs (remove waits for it to be free); returns the release function. */
  use(id: ToolId): () => void {
    this.busy.set(id, (this.busy.get(id) ?? 0) + 1);
    let done = false;
    return () => { if (!done) { done = true; this.busy.set(id, Math.max(0, (this.busy.get(id) ?? 1) - 1)); } };
  }

  async statusOf(id: ToolId): Promise<ToolStatus> {
    const def = TOOLS[id];
    const st = this.state.get(id) ?? { installing: false, progress: 0 };
    const installed = this.installed(id);
    const s: ToolStatus = { id, label: def.label, installed, version: def.version, sizeBytes: def.pin.size, installing: st.installing,
      progress: installed ? 1 : st.progress, platformSupported: this.supported(), kind: def.kind, license: def.license, note: def.note };
    if (st.error) s.error = st.error;
    if (def.gpu === "vulkan" && installed) s.gpu = pickGpu(await this.vulkanGpus(id));
    if (def.gpu === "nvidia") s.gpu = (await this.nvidiaGpus())[0] ?? null;
    if (def.driver) {
      s.requirement = `An NVIDIA graphics card with driver ${def.driver} or newer`;
      s.driver = s.gpu ? await this.nvidiaDriver() : null;
    }
    if (id === "whisper-cuda" && installed) {
      const missing = this.cudaMissing();
      if (missing.length) s.missing = missing;
      s.ready = (await this.cudaReady()).ok;
    }
    if (!installed && this.legacyInstalled(id)) {
      s.outdated = true;
      s.note = `${def.note} An older build (${(def.legacy ?? []).map((l) => l.label).join(", ")}) is installed: install this one to replace it.`;
    }
    return s;
  }

  async status(): Promise<ToolStatus[]> {
    return Promise.all(TOOL_IDS.map((id) => this.statusOf(id)));
  }

  /** The installing / progress / error part (aiupscale shows it on its own tool card). */
  progressOf(id: ToolId): State {
    return { ...(this.state.get(id) ?? { installing: false, progress: this.installed(id) ? 1 : 0 }) };
  }

  /** Vulkan devices a tool sees (cached; [] when it isn't installed or the probe fails). */
  async vulkanGpus(id: ToolId): Promise<{ index: number; name: string }[]> {
    const cached = this.gpus.get(id);
    if (cached) return cached;
    const exe = this.pathOf(id);
    if (!exe || TOOLS[id].gpu !== "vulkan") return [];
    const tmp = path.join(this.root, `_probe-${id}`);
    await fsp.mkdir(tmp, { recursive: true });
    const a = path.join(tmp, "a.png");
    const b = path.join(tmp, "b.png");
    await fsp.writeFile(a, PROBE_PNG);
    await fsp.writeFile(b, PROBE_PNG);
    const args = id === "rife" ? ["-0", a, "-1", b, "-o", path.join(tmp, "out.png"), "-v"]
      : ["-i", a, "-o", path.join(tmp, "out.png"), "-n", "realesr-animevideov3", "-s", "2", "-v"];
    const text = await capture(exe, args, path.dirname(exe));
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    const list = parseGpus(text);
    if (list.length) this.gpus.set(id, list);
    return list;
  }

  /** NVIDIA cards (nvidia-smi), cached. */
  async nvidiaGpus(): Promise<{ index: number; name: string }[]> {
    if (this.nvidia) return this.nvidia;
    const exe = this.smi();
    this.nvidia = exe ? parseNvidiaSmi(await capture(exe, ["-L"], path.dirname(exe), 15_000)) : [];
    return this.nvidia;
  }

  install(id: ToolId): Promise<ToolStatus> {
    if (!isToolId(id)) return Promise.reject(new Error("Unknown tool"));
    if (!this.supported()) return Promise.reject(new Error(`${TOOLS[id].label} runs on Windows for now`));
    if (this.installed(id)) return this.statusOf(id);
    let p = this.running.get(id);
    if (!p) {
      p = this.doInstall(id).finally(() => { this.running.delete(id); });
      this.running.set(id, p);
    }
    return p;
  }

  private async setState(id: ToolId, patch: Partial<State>): Promise<void> {
    this.state.set(id, { ...(this.state.get(id) ?? { installing: false, progress: 0 }), ...patch });
    this.deps.broadcast(await this.statusOf(id));
  }

  private async doInstall(id: ToolId): Promise<ToolStatus> {
    const def = TOOLS[id];
    const dl = path.join(this.root, "_download");
    const file = path.join(dl, def.pin.file);
    const dir = this.dirOf(id);
    let last = 0;
    try {
      await this.setState(id, { installing: true, progress: 0, error: undefined });
      await downloadPinned(def.pin, file, {
        fetchImpl: this.deps.fetchImpl,
        onProgress: (got) => {
          if (got - last < 2_000_000) return;
          last = got;
          void this.setState(id, { progress: Math.min(0.95, (got / def.pin.size) * 0.95) });
        },
      });
      await this.setState(id, { progress: 0.96 });
      if (def.kind === "model") {
        await fsp.mkdir(dir, { recursive: true });
        const target = path.join(dir, def.pin.file);
        await fsp.rm(target, { force: true });
        await fsp.rename(file, target).catch(async () => { await fsp.copyFile(file, target); await fsp.rm(file, { force: true }); });
        writeFileAtomic(`${target}.json`, JSON.stringify({ id, version: def.version, sha256: def.pin.sha256, installedAt: new Date().toISOString() }));
      } else {
        const staging = `${dir}.unpack`;
        await fsp.rm(staging, { recursive: true, force: true });
        await fsp.mkdir(staging, { recursive: true });
        await unzip(file, staging);
        const rel = findFile(staging, def.exe!);
        if (!rel) throw new Error(`${def.exe} wasn't in the download`);
        await fsp.rm(dir, { recursive: true, force: true });
        await fsp.rename(staging, dir);
        writeFileAtomic(path.join(dir, "tool.json"), JSON.stringify({ id, version: def.version, sha256: def.pin.sha256, exe: rel,
          installedAt: new Date().toISOString() }));
        await fsp.rm(file, { force: true });
      }
      for (const l of def.legacy ?? []) { // the build this one replaces
        await fsp.rm(path.join(this.root, l.dir), { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      }
      this.gpus.delete(id);
      this.deps.log(`${def.label} ${def.version} installed in ${dir}`);
      await this.setState(id, { installing: false, progress: 1 });
      this.deps.onChange?.(id);
    } catch (e) {
      await this.setState(id, { installing: false, progress: 0, error: (e as Error).message });
      throw e;
    }
    return this.statusOf(id);
  }

  async remove(id: ToolId): Promise<ToolStatus> {
    if (!isToolId(id)) throw new Error("Unknown tool");
    if (this.running.has(id)) throw new Error(`${TOOLS[id].label} is being installed`);
    if ((this.busy.get(id) ?? 0) > 0) throw new Error(`${TOOLS[id].label} is in use: wait for its job to finish or cancel it`);
    const def = TOOLS[id];
    if (def.kind === "model") {
      const f = path.join(this.dirOf(id), def.pin.file);
      await fsp.rm(f, { force: true });
      await fsp.rm(`${f}.json`, { force: true });
    } else {
      await fsp.rm(this.dirOf(id), { recursive: true, force: true, maxRetries: 3 });
    }
    this.gpus.delete(id);
    this.state.delete(id);
    this.deps.log(`${def.label} removed`);
    const s = await this.statusOf(id);
    this.deps.broadcast(s);
    this.deps.onChange?.(id);
    return s;
  }
}
