/**
 * Media for the Tatvam Editor (docs/EDITOR.md §3): what FFmpeg says about a file (duration, frame rate, size, rotation,
 * audio channels and rate), the cache files (a middle-frame thumbnail, a 10-frame filmstrip, 800 waveform peaks from
 * 8 kHz mono PCM like backend ffmpeg.peaks), proxies, .cube validation and a small concurrency limiter. Every FFmpeg
 * run is an async spawn, so big files never block the UI. Parsers and argument builders are pure
 * (test/editor.test.ts); the runners need FFmpeg.
 */
import { execFile, spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { killTree } from "./ffmpeg.ts";
import { mediaKindOf, normalizeFps } from "./editor-model.ts";

export interface ProbeInfo {
  kind: "video" | "audio" | "image";
  /** Seconds (0 for stills). */
  duration: number;
  fps: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  channels: number;
  sampleRate: number;
  rotation: number;
  /** additive (probeFile): the video stream's codec, pixel format, bit depth and colour tags */
  codec?: string; pixFmt?: string; bits?: number; matrix?: string | null; range?: "tv" | "pc" | null;
}

const CHANNEL_WORDS: Record<string, number> = { mono: 1, stereo: 2, "2.1": 3, "3.0": 3, quad: 4, "4.0": 4, "5.0": 5, "5.1": 6, "6.1": 7, "7.1": 8 };

/** Parse `ffmpeg -i file` output (the first real video stream; cover art is ignored). */
export function parseProbe(stderr: string, file: string): ProbeInfo {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  let duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  const lines = stderr.split(/\r?\n/);
  const vline = lines.find((l) => /Stream #.*Video:/.test(l) && !/attached pic/.test(l));
  const aline = lines.find((l) => /Stream #.*Audio:/.test(l));
  let width = 0;
  let height = 0;
  let fps = 0;
  if (vline) {
    const s = /,\s*(\d{1,5})x(\d{1,5})(?=[\s,\[])/.exec(vline);
    if (s) { width = Number(s[1]); height = Number(s[2]); }
    const f = /,\s*(\d+(?:\.\d+)?)\s*fps/.exec(vline) ?? /,\s*(\d+(?:\.\d+)?)\s*tbr/.exec(vline);
    if (f) fps = normalizeFps(Number(f[1]));
  }
  const rot = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(stderr) ?? /rotate\s*:\s*(-?\d+)/.exec(stderr);
  const rotation = rot ? ((Math.round(Number(rot[1])) % 360) + 360) % 360 : 0;
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  let channels = 0;
  let sampleRate = 0;
  if (aline) {
    const sr = /(\d+)\s*Hz/.exec(aline);
    if (sr) sampleRate = Number(sr[1]);
    const ch = /Hz,\s*([^,]+)/.exec(aline)?.[1]?.trim() ?? "";
    channels = CHANNEL_WORDS[ch.replace(/\(.*\)/, "").trim()] ?? (Number(/(\d+)\s*channels/.exec(ch)?.[1]) || (ch ? 2 : 0));
  }
  const byExt = mediaKindOf(file);
  const kind: ProbeInfo["kind"] = byExt === "image" ? "image" : vline ? "video" : aline ? "audio" : byExt ?? "video";
  if (kind === "image") duration = 0;
  return { kind, duration, fps: kind === "audio" ? 0 : fps || (kind === "video" ? 25 : 0), width, height, hasVideo: Boolean(vline), hasAudio: Boolean(aline),
    channels, sampleRate, rotation };
}

export function probeFile(ff: string, file: string): Promise<ProbeInfo> {
  return new Promise((resolve, reject) => {
    execFile(ff, ["-hide_banner", "-i", file], { timeout: 120_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (_err, _out, stderr) => {
      const s = String(stderr || "");
      if (!/Stream #/.test(s)) {
        reject(new Error(`${path.basename(file)} isn't a media file FFmpeg can read${/No such file/.test(s) ? " (not found)" : ""}`));
        return;
      }
      const info = parseProbe(s, file);
      if (info.hasVideo) {
        const f = parseVideoFormat(s);
        Object.assign(info, { codec: f.codec, pixFmt: f.pixFmt, bits: f.bits, matrix: f.matrix, range: f.range });
      }
      resolve(info);
    });
  });
}

/** Colour tags of a video stream from `ffmpeg -i`: "yuv420p10le(tv, bt709, progressive)" → codec, pixel format, bits, matrix, range. */
export function parseVideoFormat(stderr: string): { codec: string; pixFmt: string; bits: number; matrix: string | null; range: "tv" | "pc" | null; profile: string } {
  const line = stderr.split(/\r?\n/).find((l) => /Stream #.*Video:/.test(l) && !/attached pic/.test(l)) ?? "";
  const m = /Video:\s*([a-z0-9_]+)(?:\s*\(([^)]*)\))?/i.exec(line);
  const codec = m?.[1]?.toLowerCase() ?? "";
  const profile = m?.[2] ?? "";
  const pf = /,\s*([a-z0-9_]+)(?:\(([^)]*)\))?,\s*\d{1,5}x\d{1,5}/i.exec(line);
  const pixFmt = pf?.[1]?.toLowerCase() ?? "";
  const tags = (pf?.[2] ?? "").split(/,\s*/).map((s) => s.trim().toLowerCase());
  const range = tags.includes("tv") ? "tv" : tags.includes("pc") ? "pc" : pixFmt.startsWith("yuvj") ? "pc" : null;
  const matrix = tags.find((t) => /^(bt709|bt470bg|smpte170m|bt2020nc|bt2020c|bt601)/.test(t))?.split("/")[0] ?? null;
  const bitsM = /p(9|10|12|14|16)(le|be)?$/.exec(pixFmt) ?? /^(?:gray|yuv|yuva)\d*p?(10|12)/.exec(pixFmt);
  const bits = bitsM ? Number(bitsM[1]) : pixFmt ? 8 : 0;
  return { codec, pixFmt, bits, matrix, range, profile };
}

/**
 * Whether a clip gets an automatic proxy (project setting proxy "auto"): above 1080p on its short side, or a format
 * the editor's decoder struggles with (HEVC 10-bit and up, ProRes, DNxHD/HR, CineForm).
 */
export function needsProxy(info: Pick<ProbeInfo, "kind" | "width" | "height" | "codec" | "bits">): boolean {
  if (info.kind !== "video") return false;
  if (Math.min(info.width || 0, info.height || 0) > 1080) return true;
  const c = (info.codec ?? "").toLowerCase();
  if (/^(prores|dnxhd|dnxhr|cfhd)/.test(c)) return true;
  return c === "hevc" && (info.bits ?? 8) >= 10;
}

// ── cache files ──
export const FILMSTRIP_FRAMES = 10;
export const FILMSTRIP_H = 160;
export const THUMB_W = 320;
export const PEAK_POINTS = 800;
export const PEAK_RATE = 8000;

/** A middle-frame thumbnail, 320 px wide. */
export function thumbArgs(src: string, out: string, info: Pick<ProbeInfo, "kind" | "duration">): string[] {
  const seek = info.kind === "video" && info.duration > 0 ? ["-ss", (info.duration / 2).toFixed(3)] : [];
  return [...seek, "-i", src, "-map", "0:v:0", "-frames:v", "1", "-vf", `scale=${THUMB_W}:-2:flags=bicubic,format=yuvj420p`, "-q:v", "4", out];
}

/** Ten frames side by side (each 160 px tall), one fast keyframe seek per frame. */
export function filmstripArgs(src: string, out: string, duration: number, frames = FILMSTRIP_FRAMES, h = FILMSTRIP_H): string[] {
  const args: string[] = [];
  const f: string[] = [];
  for (let i = 0; i < frames; i++) {
    const t = (duration * (i + 0.5)) / frames;
    args.push("-ss", t.toFixed(3), "-i", src);
    f.push(`[${i}:v:0]scale=-2:${h}:flags=bicubic,setsar=1,format=yuvj420p[f${i}]`);
  }
  f.push(`${Array.from({ length: frames }, (_, i) => `[f${i}]`).join("")}hstack=inputs=${frames}[strip]`);
  return [...args, "-filter_complex", f.join(";"), "-map", "[strip]", "-frames:v", "1", "-q:v", "6", out];
}

export function peaksArgs(src: string): string[] {
  return ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", String(PEAK_RATE), "-f", "s16le", "-"];
}

/**
 * backend ffmpeg.peaks, streaming: the loudest |sample| / 32768 of each step (step = total samples / 800), rounded to
 * 3 decimals, at most 800 points. `expected` is the sample count from the probe; feed() takes s16le bytes.
 */
export class PeakMeter {
  readonly step: number;
  private cur = 0;
  private n = 0;
  private carry: number | null = null;
  readonly out: number[] = [];
  constructor(expectedSamples: number, points = PEAK_POINTS) {
    this.step = Math.max(Math.floor(expectedSamples / points), 1);
    this.points = points;
  }
  private points: number;
  feed(buf: Uint8Array): void {
    let i = 0;
    const take = (s: number) => {
      const a = Math.abs(s);
      if (a > this.cur) this.cur = a;
      if (++this.n === this.step) this.flush();
    };
    if (this.carry !== null && buf.length) {
      take((((buf[0] << 8) | this.carry) << 16) >> 16);
      this.carry = null;
      i = 1;
    }
    for (; i + 1 < buf.length; i += 2) take(((buf[i + 1] << 24) | (buf[i] << 16)) >> 16);
    if (i < buf.length) this.carry = buf[i];
  }
  private flush(): void {
    if (this.out.length < this.points) this.out.push(Math.round((this.cur / 32768) * 1000) / 1000);
    this.cur = 0;
    this.n = 0;
  }
  result(): number[] {
    if (this.n > 0) this.flush();
    return this.out.slice(0, this.points);
  }
}

export function runPeaks(ff: string, src: string, seconds: number, signal?: AbortSignal): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(ff, peaksArgs(src), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const meter = new PeakMeter(Math.max(1, Math.round(seconds * PEAK_RATE)));
    let err = "";
    child.stdout.on("data", (b: Buffer) => meter.feed(b));
    child.stderr.on("data", (b: Buffer) => { err = (err + b.toString("utf8")).slice(-4000); });
    const onAbort = () => { if (child.pid) killTree(child.pid); };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve(meter.result());
      else reject(new Error(`peaks: ffmpeg ${code}: ${err.trim().split(/\r?\n/).slice(-3).join(" ")}`));
    });
  });
}

/** Run FFmpeg with every stderr line passed to `onLine` (analysis output can be long; nothing is dropped). */
export function runFfmpegLines(ff: string, args: string[], onLine: (line: string) => void, opts: { signal?: AbortSignal; stdout?: (b: Buffer) => void } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ff, ["-hide_banner", "-nostdin", ...args], { windowsHide: true, stdio: ["ignore", opts.stdout ? "pipe" : "ignore", "pipe"] });
    let buf = "";
    const tail: string[] = [];
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.search(/\r?\n|\r/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + (buf[i] === "\r" && buf[i + 1] === "\n" ? 2 : 1));
        onLine(line);
        tail.push(line);
        if (tail.length > 12) tail.shift();
      }
    });
    if (opts.stdout) child.stdout!.on("data", opts.stdout);
    const onAbort = () => { if (child.pid) killTree(child.pid); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (buf) onLine(buf);
      if (opts.signal?.aborted) reject(new Error("cancelled"));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${tail.slice(-4).join(" ").slice(0, 600)}`));
    });
  });
}

/** A small semaphore: at most `n` tasks at once. */
export class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];
  private n: number;
  constructor(n: number) { this.n = Math.max(1, n); }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** The editor's proxy: short side 1080 for sources above 1080, else 540 (proxies.ts encoder choice). */
export function proxyShortSide(w: number, h: number): number {
  return Math.min(w, h) > 1080 ? 1080 : 540;
}

// ── .cube LUTs ──
export interface CubeInfo { size: number; title: string; domainMin: number[]; domainMax: number[] }

/** Check a .cube 3D LUT: LUT_3D_SIZE 2..256, size³ rows of three numbers. Throws with a plain message. */
export function parseCubeHeader(text: string): CubeInfo {
  let size = 0;
  let title = "";
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  let rows = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Z_0-9]+)\s+(.*)$/.exec(line);
    if (m && /^[A-Z]/.test(m[1])) {
      const key = m[1];
      if (key === "TITLE") title = m[2].replace(/^"|"$/g, "").trim();
      else if (key === "LUT_3D_SIZE") size = Number(m[2]);
      else if (key === "LUT_1D_SIZE") throw new Error("Only 3D LUTs (.cube with LUT_3D_SIZE) are supported");
      else if (key === "DOMAIN_MIN") domainMin = m[2].trim().split(/\s+/).map(Number);
      else if (key === "DOMAIN_MAX") domainMax = m[2].trim().split(/\s+/).map(Number);
      continue;
    }
    const v = line.split(/\s+/).map(Number);
    if (v.length !== 3 || v.some((x) => !Number.isFinite(x))) throw new Error(`Not a LUT row: "${line.slice(0, 40)}"`);
    rows++;
  }
  if (!Number.isInteger(size) || size < 2 || size > 256) throw new Error("A .cube LUT needs LUT_3D_SIZE between 2 and 256");
  if (rows !== size ** 3) throw new Error(`The LUT has ${rows} rows; LUT_3D_SIZE ${size} needs ${size ** 3}`);
  return { size, title, domainMin, domainMax };
}

/** Bytes → text for small text files (shaders, LUTs): refuses binary. */
export async function readText(file: string, maxBytes: number): Promise<string> {
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error("Not a file");
  if (st.size > maxBytes) throw new Error(`${path.basename(file)} is too big (${Math.round(st.size / 1024)} KB, at most ${Math.round(maxBytes / 1024)} KB)`);
  const buf = await fsp.readFile(file);
  if (buf.includes(0)) throw new Error(`${path.basename(file)} isn't a text file`);
  return buf.toString("utf8").replace(/^﻿/, "");
}
