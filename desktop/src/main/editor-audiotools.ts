/**
 * Local analysis for the editor's audio tools (docs/EDITOR.md §15.4), the bridge's `editor.audioAnalysis`:
 *  - breaths: 16 kHz mono PCM from FFmpeg (a fast seek, then atrim to the clip's range) → the per-10 ms features in
 *    Node (level, the share at 1–6 kHz, spectral flatness, harmonicity from an FFT) → the breath rules, with FFmpeg's
 *    silencedetect marking the stretches where nothing can be speech;
 *  - roomtone: the 10 ms levels of the whole recording, silencedetect at a threshold set from them, then the quietest
 *    1–3 s stretch without speech that isn't digital silence;
 *  - spectrum: 32 kHz mono → the visualiser's frames, cached in the sidecar `<edit>/.tatvam/spectrum-<media>-<fps>-
 *    <bands>.json`, which is tied to the media file's size and time (a relink or a re-render makes it again).
 * The analysis itself is the frontend's pure code (frontend/src/editor/audiotools), so the page's own fallback gives
 * the same numbers. `attachSpectra` puts the frames an export's visualisers need on its project: the hidden render
 * window draws from those, so the export matches the preview. Unit tests: test/editor-audiotools.test.ts.
 */
import { promises as fsp } from "node:fs";
import type { AudioAnalysisKind, AudioAnalysisOptions, AudioAnalysisResult, EditProject, MediaItem, SpectrumSidecarJson } from "../shared/types.ts";
import { detectBreaths } from "../../../frontend/src/editor/audiotools/breaths.ts";
import { FEATURE_RATE, FeatureExtractor } from "../../../frontend/src/editor/audiotools/features.ts";
import { findRoomTone, quietThreshold } from "../../../frontend/src/editor/audiotools/roomtone.ts";
import {
  fromSidecar, SPECTRUM_BANDS, SPECTRUM_FMAX, SPECTRUM_FMIN, SPECTRUM_RATE, SpectrumBuilder, spectraNeeded, spectrumSidecarName, toSidecar,
} from "../../../frontend/src/editor/audiotools/spectrum.ts";
import { parseSilence, silenceArgs } from "./editor-analyze.ts";
import { EditorError, FPS_LIST } from "./editor-model.ts";
import type { EditorManager, MediaTools } from "./editor.ts";

export const AUDIO_ANALYSIS_KINDS: AudioAnalysisKind[] = ["breaths", "roomtone", "spectrum"];
/** Under this (dBFS) for 120 ms nothing counts as speech in the breath analysis. */
export const BREATH_QUIET_DB = -40;

const r6 = (x: number) => String(Math.round(x * 1e6) / 1e6);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The part of the file to decode: a fast seek a second before `inS`, then atrim to the exact sample. */
function rangeArgs(src: string, inS?: number, outS?: number): { input: string[]; trim: string | null } {
  if (inS === undefined && outS === undefined) return { input: ["-i", src], trim: null };
  const a = Math.max(0, inS ?? 0);
  const pre = Math.max(0, a - 1);
  const t = [`start=${r6(a - pre)}`, ...(outS !== undefined && outS > a ? [`duration=${r6(outS - a)}`] : [])].join(":");
  return { input: [...(pre > 0 ? ["-ss", r6(pre)] : []), "-i", src], trim: `atrim=${t},asetpts=PTS-STARTPTS` };
}

/** Mono 32-bit float PCM at `rate` on stdout, of [inS, outS) of the file (media seconds). */
export function pcmArgs(src: string, rate: number, inS?: number, outS?: number): string[] {
  const r = rangeArgs(src, inS, outS);
  return [...r.input, "-vn", ...(r.trim ? ["-af", r.trim] : []), "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"];
}

/** silencedetect over [inS, outS) (times from the range's start). */
export function quietArgs(src: string, noiseDb: number, minS: number, inS?: number, outS?: number): string[] {
  if (inS === undefined && outS === undefined) return silenceArgs(src, noiseDb, Math.round(minS * 1000));
  const r = rangeArgs(src, inS, outS);
  return [...r.input, "-vn", "-af", `${r.trim},silencedetect=noise=${noiseDb}dB:d=${minS.toFixed(3)}`, "-f", "null", "-"];
}

/** Turns FFmpeg's stdout chunks (any sizes) into float samples. */
export function f32Reader(onSamples: (x: Float32Array) => void): (b: Buffer) => void {
  let rest: Buffer | null = null;
  return (chunk: Buffer) => {
    const buf = rest ? Buffer.concat([rest, chunk]) : chunk;
    const n = buf.length >> 2;
    if (n) {
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = buf.readFloatLE(i * 4);
      onSamples(x);
    }
    rest = buf.length & 3 ? Buffer.from(buf.subarray(n * 4)) : null;
  };
}

const mediaSeconds = (m: MediaItem) => m.seconds ?? (m.fps > 0 ? m.duration / m.fps : 0);

/** Decodes a range of a file to mono floats, sample chunks to `onSamples`. */
async function decode(lines: MediaTools["lines"], src: string, rate: number, onSamples: (x: Float32Array) => void, inS?: number, outS?: number): Promise<void> {
  const read = f32Reader(onSamples);
  await lines(pcmArgs(src, rate, inS, outS), () => undefined, { stdout: read });
}

export async function breathsOf(lines: MediaTools["lines"], src: string, opts: AudioAnalysisOptions, duration: number): Promise<AudioAnalysisResult> {
  const fx = new FeatureExtractor(FEATURE_RATE);
  await decode(lines, src, FEATURE_RATE, (x) => fx.push(x), opts.in, opts.out);
  const f = fx.finish();
  const quietLines: string[] = [];
  await lines(quietArgs(src, BREATH_QUIET_DB, 0.12, opts.in, opts.out), (l) => { if (l.includes("silence_")) quietLines.push(l); });
  const quiet = parseSilence(quietLines, f.n * f.hopS);
  const r = detectBreaths(f, { threshold: opts.threshold, quiet });
  const off = opts.in ?? 0;
  return {
    kind: "breaths", breaths: r.breaths.map((b) => ({ ...b, start: r3(b.start + off), end: r3(b.end + off) })),
    speech: r.speech.map((s) => ({ start: r3(s.start + off), end: r3(s.end + off) })), noiseFloorDb: r.noiseFloorDb, duration,
  };
}

export async function roomToneOf(lines: MediaTools["lines"], src: string, opts: AudioAnalysisOptions, duration: number): Promise<AudioAnalysisResult> {
  const fx = new FeatureExtractor(FEATURE_RATE, { spectral: false });
  await decode(lines, src, FEATURE_RATE, (x) => fx.push(x), opts.in, opts.out);
  const f = fx.finish();
  const thr = quietThreshold(f.rms);
  const sl: string[] = [];
  await lines(quietArgs(src, thr, 0.5, opts.in, opts.out), (l) => { if (l.includes("silence_")) sl.push(l); });
  const silences = parseSilence(sl, f.n * f.hopS);
  const st = findRoomTone(f.rms, f.hopS, silences, { minS: opts.minS, maxS: opts.maxS });
  const off = opts.in ?? 0;
  return { kind: "roomtone", stretch: st ? { ...st, start: r3(st.start + off), end: r3(st.end + off) } : null, thresholdDb: thr, silences: silences.length, duration };
}

/**
 * A media's spectrum frames at a frame rate and band count: the sidecar when it was made from this very file, else
 * computed (and the sidecar written; one too big to store is still returned).
 */
export async function spectrumFor(o: {
  src: string; mediaId: string; fps: number; bands: number; lines: MediaTools["lines"];
  read(name: string): Promise<unknown>; write(name: string, json: unknown): Promise<unknown>; log?(msg: string): void;
}): Promise<{ name: string; cached: boolean; spectrum: SpectrumSidecarJson }> {
  const name = spectrumSidecarName(o.mediaId, o.fps, o.bands);
  const st = await fsp.stat(o.src);
  const source = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
  const old = (await o.read(name).catch(() => null)) as Partial<SpectrumSidecarJson> | null;
  if (old && fromSidecar(old) && old.mediaId === o.mediaId && old.fps === o.fps && old.bands === o.bands && old.source?.size === source.size
    && old.source?.mtimeMs === source.mtimeMs) return { name, cached: true, spectrum: old as SpectrumSidecarJson };
  const b = new SpectrumBuilder(o.fps, o.bands);
  await decode(o.lines, o.src, SPECTRUM_RATE, (x) => b.push(x));
  const { frames, data } = b.finish();
  const spectrum = toSidecar({ mediaId: o.mediaId, fps: o.fps, bands: o.bands, fMin: SPECTRUM_FMIN, fMax: SPECTRUM_FMAX, frames, data }, source) as SpectrumSidecarJson;
  await o.write(name, spectrum).catch((e) => o.log?.(`spectrum sidecar ${name}: ${(e as Error).message}`));
  return { name, cached: false, spectrum };
}

/**
 * The frames every visualiser of an export needs, put on its (runtime) project as `spectra` (key → sidecar JSON), from
 * the sidecars or computed now. The render window's buildComposition reads them; the project isn't saved with them.
 */
export async function attachSpectra(project: EditProject, o: {
  lines: MediaTools["lines"]; read(name: string): Promise<unknown>; write(name: string, json: unknown): Promise<unknown>; log(msg: string): void;
}): Promise<number> {
  const need = spectraNeeded(project as unknown as Parameters<typeof spectraNeeded>[0]);
  if (!need.length) return 0;
  const out: Record<string, SpectrumSidecarJson> = {};
  for (const n of need) {
    const m = project.media.find((x) => x.id === n.mediaId);
    if (!m || m.path.startsWith("studio:") || (!m.hasAudio && m.kind !== "audio")) continue;
    try { out[n.key] = (await spectrumFor({ src: m.path, mediaId: n.mediaId, fps: n.fps, bands: n.bands, lines: o.lines, read: o.read, write: o.write, log: o.log })).spectrum; }
    catch (e) { o.log(`visualiser frames for ${m.name}: ${(e as Error).message}`); }
  }
  (project as EditProject & { spectra?: Record<string, SpectrumSidecarJson> }).spectra = out;
  return Object.keys(out).length;
}

/** What this module needs of the editor manager (tests pass a fake). */
export type AudioToolsEditor = Pick<EditorManager, "mediaFile" | "readSidecar" | "writeSidecar">;

export class AudioToolsManager {
  private deps: { editor: AudioToolsEditor; log(msg: string): void };
  constructor(deps: { editor: AudioToolsEditor; log(msg: string): void }) { this.deps = deps; }

  async analyze(file: string, mediaId: string, kind: AudioAnalysisKind, opts: AudioAnalysisOptions = {}): Promise<AudioAnalysisResult> {
    if (!AUDIO_ANALYSIS_KINDS.includes(kind)) throw new EditorError(`Unknown analysis ${String(kind)}`);
    const { item, src, tools } = await this.deps.editor.mediaFile(file, mediaId);
    if (!item.hasAudio && item.kind !== "audio") throw new EditorError(`${item.name} has no sound`);
    if (opts.in !== undefined && opts.out !== undefined && !(opts.out > opts.in)) throw new EditorError("The out point must be after the in point");
    const duration = mediaSeconds(item);
    if (kind === "breaths") return breathsOf(tools.lines, src, opts, duration);
    if (kind === "roomtone") return roomToneOf(tools.lines, src, opts, duration);
    const fps = opts.fps ?? 25, bands = opts.bands ?? SPECTRUM_BANDS;
    const r = await spectrumFor({ src, mediaId: item.id, fps, bands, lines: tools.lines, read: (n) => this.deps.editor.readSidecar(file, n),
      write: (n, j) => this.deps.editor.writeSidecar(file, n, j), log: this.deps.log });
    return { kind: "spectrum", ...r };
  }
}

/** The options a page may pass, checked (unknown keys dropped, numbers in range). */
export function audioAnalysisOptions(v: unknown): AudioAnalysisOptions {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const n = (x: unknown, a: number, b: number) => (typeof x === "number" && Number.isFinite(x) && x >= a && x <= b ? x : undefined);
  const out: AudioAnalysisOptions = {};
  const put = <K extends keyof AudioAnalysisOptions>(k: K, x: AudioAnalysisOptions[K] | undefined) => { if (x !== undefined) out[k] = x; };
  put("in", n(o.in, 0, 1e7)); put("out", n(o.out, 0, 1e7));
  put("threshold", n(o.threshold, 0, 1));
  put("minS", n(o.minS, 0.25, 10)); put("maxS", n(o.maxS, 0.25, 20));
  put("fps", typeof o.fps === "number" ? FPS_LIST.find((f) => Math.abs(f - (o.fps as number)) < 0.01) : undefined);
  put("bands", typeof o.bands === "number" && Number.isInteger(o.bands) && o.bands >= 8 && o.bands <= 128 ? o.bands : undefined);
  return out;
}

/** IPC: the editor.audioAnalysis bridge; only pages on the gateway origin may call (like every editor handler). */
export function registerAudioToolsIpc(ipc: { handle(channel: string, listener: (event: { senderFrame?: { url?: string } | null }, ...args: unknown[]) => unknown): void },
  isAllowed: (url: string) => boolean, mgr: Pick<AudioToolsManager, "analyze">, channel: string): void {
  ipc.handle(channel, async (e, file, mediaId, kind, opts) => {
    if (!isAllowed(e.senderFrame?.url ?? "")) throw new Error("Not allowed from this page");
    if (typeof file !== "string" || !file || file.length > 4096) throw new Error("path must be text");
    if (typeof mediaId !== "string" || !mediaId || mediaId.length > 200) throw new Error("mediaId must be text");
    if (!AUDIO_ANALYSIS_KINDS.includes(kind as AudioAnalysisKind)) throw new Error("Unknown analysis");
    return mgr.analyze(file, mediaId, kind as AudioAnalysisKind, audioAnalysisOptions(opts));
  });
}
