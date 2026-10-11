/**
 * 1080p proxies (docs/DESKTOP.md §4): for local video files whose short side is above 1080 (or every video when
 * asked), a short-side-1080 H.264 copy in Proxies/ named like the source, on NVENC when the probe says it works.
 * The gateway serves them instead of the originals in proxy mode. Electron-free.
 */
import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import type { ProxyStatus } from "../shared/types.ts";
import { probeMedia, runFfmpeg, type FfmpegInfo } from "./ffmpeg.ts";
import type { Library } from "./library.ts";

const VIDEO = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);

/** The proxy encode: short side 1080 (never upscaled), NVENC H.264 when available, else x264 veryfast. */
export function proxyArgs(src: string, out: string, nvenc: boolean): string[] {
  const vf = "scale='if(gt(iw,ih),-2,min(1080,iw))':'if(gt(iw,ih),min(1080,ih),-2)',format=yuv420p";
  const v = nvenc ? ["-c:v", "h264_nvenc", "-preset", "p2", "-rc", "vbr", "-cq", "26", "-b:v", "0"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "24"];
  return ["-i", src, "-map", "0:v:0", "-map", "0:a?", "-vf", vf, ...v, "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-movflags", "+faststart", out];
}

export interface ProxyDeps {
  library: Library;
  ff(): FfmpegInfo | null;
  probe(): Promise<Record<string, boolean>>;
  broadcast(s: ProxyStatus): void;
  log(msg: string): void;
}

export class ProxyManager {
  private deps: ProxyDeps;
  private runs = new Map<number, { status: ProxyStatus; abort: AbortController }>();
  private last = new Map<number, ProxyStatus>();

  constructor(deps: ProxyDeps) {
    this.deps = deps;
  }

  status(pid: number): ProxyStatus {
    return structuredClone(this.runs.get(pid)?.status ?? this.last.get(pid) ?? { pid, running: false, total: 0, done: 0, current: "", errors: [] });
  }

  stop(pid: number): void {
    this.runs.get(pid)?.abort.abort();
  }

  stopAll(): void {
    for (const r of this.runs.values()) r.abort.abort();
  }

  /** Make the missing proxies for a project (`all` = every video, not only those above 1080). */
  async start(pid: number, opts: { all?: boolean } = {}): Promise<void> {
    if (this.runs.has(pid)) return;
    const ffi = this.deps.ff();
    if (!ffi) throw new Error("FFmpeg wasn't found");
    const mirror = this.deps.library.existingMirror(pid);
    if (!mirror) throw new Error("Sync this project first: there are no local files yet");
    const status: ProxyStatus = { pid, running: true, total: 0, done: 0, current: "", errors: [] };
    const abort = new AbortController();
    this.runs.set(pid, { status, abort });
    const folder = this.deps.library.folderFor(pid).path;
    try {
      const nvenc = Boolean((await this.deps.probe()).h264_nvenc);
      const todo = mirror.files({ state: "ready" }).filter((f) => VIDEO.has(path.extname(f.local_path).toLowerCase())
        && !f.local_path.startsWith("Cache/") && !f.local_path.startsWith("Proxies/") && !f.local_path.startsWith("Renders/")
        && !(f.proxy_path && existsSync(path.join(folder, f.proxy_path))));
      status.total = todo.length;
      this.deps.broadcast(structuredClone(status));
      for (const f of todo) {
        if (abort.signal.aborted) break;
        const src = path.join(folder, f.local_path);
        status.current = f.name;
        this.deps.broadcast(structuredClone(status));
        try {
          const info = await probeMedia(ffi.path, src);
          if (!opts.all && Math.min(info.width, info.height) <= 1080) { status.done++; continue; }
          const rel = `Proxies/${path.basename(f.local_path, path.extname(f.local_path))}.mp4`;
          const out = path.join(folder, rel);
          const part = `${out}.part.mp4`;
          await fsp.mkdir(path.dirname(out), { recursive: true });
          await runFfmpeg(ffi.path, proxyArgs(src, part, nvenc), { signal: abort.signal });
          await fsp.rm(out, { force: true });
          await fsp.rename(part, out);
          mirror.setFile(f.key, { proxy_path: rel });
        } catch (e) {
          if (abort.signal.aborted) break;
          status.errors.push(`${f.name}: ${(e as Error).message.slice(0, 200)}`);
        }
        status.done++;
        this.deps.broadcast(structuredClone(status));
      }
    } finally {
      status.running = false;
      status.current = "";
      this.runs.delete(pid);
      this.last.set(pid, structuredClone(status));
      this.deps.broadcast(structuredClone(status));
    }
  }
}
