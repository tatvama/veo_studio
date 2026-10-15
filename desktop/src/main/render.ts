/**
 * Local 4K renders (docs/DESKTOP.md §2.4, §4.1): fetch the server's render plan for the preset's size, make every
 * key local, then run the server's pipeline step by step with hardware encoders (command builders in
 * render-args.ts). Progress (step weights + FFmpeg -progress), ETA, cancel, a persisted job list (userData/renders.json),
 * output named by the Renders template into Renders/, the SRT beside it, and the optional upload. Electron-free.
 */
import { randomUUID } from "node:crypto";
import { existsSync, promises as fsp, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DesktopSettings, DuckingOptions, EditProject, GpuRenderJob, LoudnessPreset, NewsGpuOptions, RenderJob, RenderJobInput, RenderPreset, RenderState,
} from "../shared/types.ts";
import { writeFileAtomic } from "./config.ts";
import { downloadTo, pool } from "./download.ts";
import { defaultLoudness, LOUDNESS, measureArgs, mixJobs, mixPlan, nextGain, normalizeArgs } from "./editor-audio.ts";
import { parseEbur128 } from "./editor-analyze.ts";
import type { IrPreset } from "./editor-irs.ts";
import { editDims, framesToSeconds, renderName } from "./editor-model.ts";
import { DEFAULT_STALL_MS, probeMedia, runFfmpeg, spawnFfmpegPipe, type FfmpegInfo, type FfProgress } from "./ffmpeg.ts";
import { gpuGate } from "./gpu-gate.ts";
import type { Library } from "./library.ts";
import { runNewsExport, type NewsRenderInput, type NewsRenderSpec } from "./newsroom/export.ts";
import { dateToken, fitName, pathKey, safePart, uniquePath } from "./naming.ts";
import {
  PRESETS, STAB_DETECT, concatArgs, concatList, draftDims, extractAudioArgs, finalArgs, finalEncoder, gpuFinalArgs, hwDecodeArgs, intermediateEncoder,
  mixArgs, mixAudioArgs,
  musicBedArgs, overlayArgs, presetDims, presetList, segmentArgs, stabilizeDetectArgs, stepWeights, stillArgs, xfadeArgs, type PlanSegment, type RenderPlan,
} from "./render-args.ts";
import { uploadFile } from "./upload.ts";
import type { Upstream } from "./upstream.ts";

/** Headroom under a loudness preset's true-peak ceiling before AAC: the encode overshoots most on sharp transients. */
export const AAC_TP_MARGIN_DB = 1;

/** A render step that reports no progress for this long is killed and the job fails (a stalled encoder or graphics driver). */
export const RENDER_STALL_MS = DEFAULT_STALL_MS;

export interface RenderDeps {
  upstream: Upstream;
  library: Library;
  ff(): FfmpegInfo | null;
  probe(): Promise<Record<string, boolean>>;
  settings(): DesktopSettings;
  jobsFile: string;
  broadcast(job: RenderJob): void;
  log(msg: string): void;
  /** A hidden window on the gateway (`urlPath`) for the GPU engine; `onClosed` fires if it goes away. */
  openRenderWindow?(urlPath: string, onClosed: () => void): { close(): void };
}

interface AssembleCtx {
  ff: string; tmp: string; signal: AbortSignal; fps: number; inter: string[]; localUpscale: boolean; effects: boolean; music: boolean;
  luts: Record<string, string>; need(key: string): string;
  /** decode the source clips on the graphics card (hwDecodeArgs); `on` turns false for the rest of the job after a failure */
  hwaccel: { args: string[]; on: boolean };
}

/** `signal` (optional) overrides the band's: the segments that run side by side stop together when one fails. */
interface Band { step(id: string, args: string[], seconds?: number, signal?: AbortSignal): Promise<void> }

/** What the GPU engine draws: a studio render plan, or a Tatvam Editor sequence (docs/EDITOR.md §5). */
export type GpuSource =
  | { kind: "plan"; plan: RenderPlan }
  | { kind: "composition"; project: EditProject; sequenceId: string; range: { in: number; out: number };
      /** additive (News Room delivery): language, ratio, graphics only, alpha for the window */ news?: NewsGpuOptions };

interface GpuSession {
  src: GpuSource; w: number; h: number; fps: number; frames: number; next: number; bits: 8 | 10;
  frame(i: number, bytes: Uint8Array): Promise<void>; done(): void; fail(msg: string): void;
}

/** An edit export (EditorManager.export): the runtime project (media URLs registered), the sequence and its range. */
export interface EditExportInput {
  editPath: string; editDir: string; project: EditProject; sequenceId: string; range: { in: number; out: number };
  preset: string; upload: boolean; source?: { pid: number; eid: number; lang: string } | null;
  /** the loudness target (default: by preset), music ducking (default on), the output's base name (default: the sequence's) */
  loudness?: LoudnessPreset; ducking?: boolean | DuckingOptions; name?: string;
  /** the built-in impulse responses (reverb, guitar cabinet) */
  irFile?(preset: IrPreset): string;
  /** additive (News Room delivery, newsroom/export.ts): a news render (RenderManager.startNews) */
  news?: NewsRenderSpec;
}

/** Every storage key the plan refers to (the plan lists them in `keys`; this also covers older plans). */
export function planKeys(plan: RenderPlan): string[] {
  const out = new Set<string>(plan.keys ?? []);
  for (const s of plan.segments) {
    out.add(s.source);
    if (s.audio_override) out.add(s.audio_override);
    for (const a of s.extra_audio ?? []) out.add(a.key);
  }
  if (plan.end_card?.key) out.add(plan.end_card.key);
  for (const p of plan.layers?.pics ?? []) out.add(p.key);
  for (const p of plan.layers?.sounds ?? []) out.add(p.key);
  if (plan.music?.key) out.add(plan.music.key);
  for (const k of Object.values(plan.luts ?? {})) out.add(k);
  out.delete("");
  return [...out];
}

/** The render window's job (shared GpuRenderJob): the source with the output size and frame count (and `bits: 10` for 10-bit encoders). */
export function gpuJob(src: GpuSource, size: { w: number; h: number; fps: number; frames: number; bits?: 8 | 10 }): GpuRenderJob {
  const { bits, ...rest } = size;
  const b = bits === 10 ? { bits: 10 as const } : {};
  if (src.kind === "plan") return { kind: "plan", plan: src.plan, ...rest, ...b };
  return { kind: "composition", project: src.project, sequenceId: src.sequenceId, range: { ...src.range }, ...rest, ...b, ...(src.news ? { news: src.news } : {}) };
}

/** An encoder that keeps 10 bits (HEVC main10, ProRes, x265 10-bit): the GPU frames are then asked for in 10 bits. */
export const isTenBitEncoder = (args: string[]) => args.some((a) => /^(p010le|yuv420p10le|yuv422p10le|yuv444p10le)$/.test(a));

/** Bytes of one frame: 8-bit I420 is W·H·1.5, 10-bit (yuv420p10le, 16-bit samples) twice that. */
export const frameBytes = (w: number, h: number, bits: 8 | 10) => Math.round(w * h * 1.5) * (bits === 10 ? 2 : 1);

const nowIso = () => new Date().toISOString();
const ACTIVE: RenderState[] = ["preparing", "downloading", "rendering"];

export class RenderManager {
  private deps: RenderDeps;
  private jobs: RenderJob[] = [];
  private queue: string[] = [];
  private running: { id: string; abort: AbortController } | null = null;
  private uploads = new Map<string, AbortController>();
  private lastEmit = new Map<string, number>();
  private gpuSessions = new Map<string, GpuSession>();
  private editJobs = new Map<string, EditExportInput>();

  constructor(deps: RenderDeps) {
    this.deps = deps;
    try {
      const raw = JSON.parse(readFileSync(deps.jobsFile, "utf8"));
      if (Array.isArray(raw)) this.jobs = raw as RenderJob[];
    } catch { /* first run */ }
    for (const j of this.jobs) { // a render can't survive the app closing; an upload resumes from where the server got to
      if (ACTIVE.includes(j.status) || j.status === "queued") Object.assign(j, { status: "failed", error: "Interrupted: the app closed during the render" });
      if (j.status === "uploading") Object.assign(j, { status: "done", error: "The upload was interrupted: upload again to resume it", progress: 1 });
      if (j.upload?.state === "uploading") j.upload.state = "failed";
    }
  }

  private save(): void {
    try { writeFileAtomic(this.deps.jobsFile, JSON.stringify(this.jobs.slice(-200), null, 2)); } catch (e) { this.deps.log(`renders.json: ${(e as Error).message}`); }
  }

  private emit(job: RenderJob, force = false): void {
    const now = Date.now();
    if (!force && now - (this.lastEmit.get(job.id) ?? 0) < 250) return;
    this.lastEmit.set(job.id, now);
    this.deps.broadcast(structuredClone(job));
    if (force) this.save();
  }

  async presets(): Promise<RenderPreset[]> {
    const s = this.deps.settings();
    return presetList(await this.deps.probe(), s.encoder.prefer, s.encoder.hevc10bit);
  }

  list(): RenderJob[] {
    return structuredClone([...this.jobs].reverse());
  }

  get(id: string): RenderJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  /** Absolute paths of renders that reached the Render Center (safe to clean). */
  uploadedOutputs(pid: number): string[] {
    return this.jobs.filter((j) => j.pid === pid && j.uploaded && j.output).map((j) => j.output!);
  }

  start(input: RenderJobInput): string {
    if (!PRESETS.some((p) => p.id === input.preset)) throw new Error(`Unknown preset ${input.preset}`);
    const job: RenderJob = {
      id: randomUUID(), pid: input.pid, eid: input.eid, lang: input.lang, preset: input.preset,
      options: { effects: input.effects !== false, captions: input.captions !== false, music: input.music !== false, upscaled: input.upscaled !== false,
        localUpscale: Boolean(input.localUpscale), upload: Boolean(input.upload),
        engine: input.engine === "gpu" || input.engine === "ffmpeg" ? input.engine : "auto" },
      status: "queued", progress: 0, step: "Waiting", stepId: "queued", warnings: [], createdAt: nowIso(), upload: { state: "idle" }, uploaded: false,
    };
    this.jobs.push(job);
    this.queue.push(job.id);
    this.emit(job, true);
    void this.next();
    return job.id;
  }

  /** Queue a Tatvam Editor sequence export (GPU picture, FFmpeg sound); returns the job id. */
  startEdit(input: EditExportInput): string {
    if (!PRESETS.some((p) => p.id === input.preset)) throw new Error(`Unknown preset ${input.preset}`);
    const seq = input.project.sequences.find((s) => s.id === input.sequenceId);
    if (!seq) throw new Error("No such sequence");
    if (!(input.range.out > input.range.in)) throw new Error("The export range is empty");
    const src = input.source ?? null;
    const job: RenderJob = {
      id: randomUUID(), pid: src?.pid ?? 0, eid: src?.eid ?? 0, lang: src?.lang ?? "", preset: input.preset, kind: "edit",
      editPath: input.editPath, sequenceId: seq.id, sequenceName: seq.name,
      options: { effects: true, captions: false, music: true, upscaled: false, localUpscale: false, upload: Boolean(input.upload && src?.eid), engine: "gpu" },
      status: "queued", progress: 0, step: "Waiting", stepId: "queued", warnings: [], createdAt: nowIso(), upload: { state: "idle" }, uploaded: false,
    };
    this.editJobs.set(job.id, input);
    this.jobs.push(job);
    this.queue.push(job.id);
    this.emit(job, true);
    void this.next();
    return job.id;
  }

  cancel(id: string): void {
    const job = this.get(id);
    if (!job) return;
    if (this.running?.id === id) this.running.abort.abort();
    else if (job.status === "queued") {
      this.queue = this.queue.filter((q) => q !== id);
      Object.assign(job, { status: "cancelled", finishedAt: nowIso(), step: "Cancelled" });
      this.emit(job, true);
    }
    this.uploads.get(id)?.abort();
  }

  cancelAll(): void {
    for (const id of [...this.queue]) this.cancel(id);
    if (this.running) this.running.abort.abort();
    for (const a of this.uploads.values()) a.abort();
  }

  private async next(): Promise<void> {
    if (this.running) return;
    const id = this.queue.shift();
    if (!id) return;
    const job = this.get(id);
    if (!job) return void this.next();
    const abort = new AbortController();
    this.running = { id, abort };
    Object.assign(job, { status: "preparing", startedAt: nowIso(), stepId: "prepare", step: job.kind === "edit" ? "Preparing the export" : "Getting the render plan",
      progress: 0, error: undefined });
    this.emit(job, true);
    const tmpHolder: { dir?: string } = {};
    try {
      if (job.kind === "edit") await this.runEdit(job, abort.signal, tmpHolder);
      else await this.run(job, abort.signal, tmpHolder);
      job.elapsed_s = Math.round((Date.now() - Date.parse(job.startedAt!)) / 1000);
      Object.assign(job, { status: "done", progress: 1, stepId: "done", step: "Done", eta_s: 0, finishedAt: nowIso() });
      this.deps.log(`render ${job.id} done in ${job.elapsed_s}s with ${job.encoder}: ${job.output}`);
    } catch (e) {
      const cancelled = abort.signal.aborted;
      Object.assign(job, { status: cancelled ? "cancelled" : "failed", error: cancelled ? undefined : String((e as Error).message || e).slice(0, 2000),
        step: cancelled ? "Cancelled" : "Failed", eta_s: undefined, finishedAt: nowIso() });
      if (!cancelled) this.deps.log(`render ${job.id} failed: ${(e as Error).stack || e}`);
    } finally {
      if (tmpHolder.dir && !process.env.TATVAM_KEEP_RENDER_TMP) await fsp.rm(tmpHolder.dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      this.editJobs.delete(job.id);
      this.running = null;
      this.emit(job, true);
    }
    if (job.status === "done" && job.options.upload) void this.upload(job.id).catch(() => undefined);
    void this.next();
  }

  private async projectInfo(pid: number): Promise<{ id: number; title: string; aspect: string }> {
    try {
      const p = await this.deps.upstream.json<{ id: number; title: string; aspect: string }>(`/api/projects/${pid}`, { timeoutMs: 20_000 });
      return { id: pid, title: p.title, aspect: p.aspect || "16:9" };
    } catch (e) {
      const m = this.deps.library.existingMirror(pid)?.project(pid);
      if (m) return { id: pid, title: m.title, aspect: m.aspect || "16:9" };
      throw e;
    }
  }

  private async episodeInfo(pid: number, eid: number): Promise<{ number: number; season: number }> {
    try {
      const e = await this.deps.upstream.json<{ number: number; season?: number }>(`/api/episodes/${eid}`, { timeoutMs: 20_000 });
      return { number: e.number, season: e.season ?? 1 };
    } catch {
      const e = this.deps.library.existingMirror(pid)?.episodes(pid).find((x) => x.id === eid);
      return { number: e?.number ?? 0, season: e?.season ?? 1 };
    }
  }

  /** Local files for every key: the synced copy, else a download into Cache/plan/. */
  private async ensureLocal(pid: number, keys: string[], signal: AbortSignal, job: RenderJob, weight: number): Promise<Map<string, string>> {
    const lib = this.deps.library;
    const folder = lib.folderFor(pid).path;
    const mirror = lib.mirror(pid);
    const out = new Map<string, string>();
    const missing: string[] = [];
    for (const k of keys) {
      const p = lib.resolveKeyOriginal(k);
      if (p && existsSync(p)) out.set(k, p);
      else missing.push(k);
    }
    if (!missing.length) return out;
    job.status = "downloading";
    let done = 0;
    await pool(missing, 3, async (k) => {
      const rel = `Cache/plan/${safePart(k.replace(/\//g, "_")).slice(-150)}`;
      const abs = path.join(folder, rel);
      job.step = `Downloading media ${done + 1} of ${missing.length}`;
      this.emit(job);
      const res = await downloadTo(this.deps.upstream, `/media/${k.split("/").map(encodeURIComponent).join("/")}`, abs, { signal });
      mirror.upsertFile({ key: k, project_id: pid, local_path: rel, name: path.basename(rel), folder: "Cache", role: "cache", size: res.size,
        etag: res.etag, state: "ready", synced_at: nowIso() });
      out.set(k, abs);
      done++;
      job.progress = Math.round((weight * done) / missing.length * 1000) / 1000;
      this.emit(job);
    }, signal);
    return out;
  }

  private async run(job: RenderJob, signal: AbortSignal, tmpHolder: { dir?: string }): Promise<void> {
    const ffi = this.deps.ff();
    if (!ffi) throw new Error("FFmpeg wasn't found: set its path in Settings");
    const ff = ffi.path;
    const probe = await this.deps.probe();
    const s = this.deps.settings();
    const preset = PRESETS.find((p) => p.id === job.preset)!;
    const project = await this.projectInfo(job.pid);
    const ep = await this.episodeInfo(job.pid, job.eid);
    const { w, h } = presetDims(preset, project.aspect);
    const fps = preset.fps ?? 24;
    const enc = finalEncoder(preset, probe, s.encoder.prefer, s.encoder.hevc10bit);
    if (!enc) throw new Error(`${preset.label} can't be encoded on this PC`);
    const inter = intermediateEncoder(probe, s.encoder.prefer, s.encoder.intermediateCq);
    const hw = { args: hwDecodeArgs(probe, s.encoder.hwDecode !== false), on: true };
    Object.assign(job, { w, h, fps, encoder: enc.name, codec: preset.codec });
    const o = job.options;
    const q = new URLSearchParams({ lang: job.lang, w: String(w), h: String(h), fps: String(fps), effects: o.effects ? "1" : "0",
      captions: o.captions ? "1" : "0", music: o.music ? "1" : "0", upscaled: o.upscaled ? "1" : "0" });
    const plan = await this.deps.upstream.json<RenderPlan>(`/api/episodes/${job.eid}/render-plan?${q}`, { signal, timeoutMs: 300_000 });
    if (!plan.segments?.length) throw new Error("This episode has no shots to render");
    job.warnings = plan.warnings ?? [];
    job.cutVersion = plan.cut_version ?? undefined;
    job.fingerprint = plan.fingerprint;
    const folder = this.deps.library.ensure({ id: job.pid, title: project.title, aspect: project.aspect }, this.deps.upstream.opts.serverUrl());
    const tmp = path.join(folder, "Cache", `render-${job.id.slice(0, 8)}`);
    tmpHolder.dir = tmp;
    await fsp.mkdir(tmp, { recursive: true });
    const gpu = o.engine === "gpu" || (o.engine !== "ffmpeg" && (plan.gpu_only?.length ?? 0) > 0);
    job.engineUsed = gpu ? "gpu" : "ffmpeg";
    const steps = stepWeights(plan, { music: o.music });
    const prepWeight = gpu ? 0.04 : steps.find((x) => x.id === "prepare")!.weight;
    const local = await this.ensureLocal(job.pid, planKeys(plan), signal, job, prepWeight);
    const ctxFor = (m: Map<string, string>, p: RenderPlan): AssembleCtx => {
      const luts: Record<string, string> = {};
      for (const [id, k] of Object.entries(p.luts ?? {})) if (m.get(k)) luts[id] = m.get(k)!;
      return { ff, tmp, signal, fps, inter: inter.args, localUpscale: o.localUpscale, effects: o.effects, music: o.music, luts, hwaccel: hw,
        need: (k: string) => {
          const v = m.get(k);
          if (!v) throw new Error(`Missing media ${k}`);
          return v;
        } };
    };

    job.status = "rendering";
    const meter = this.meter(job, Date.now(), prepWeight, { ff, tmp, signal });
    let ass: string | null = null;
    if (plan.captions?.ass) {
      ass = path.join(tmp, "captions.ass");
      // the studio's caption text (not a download): a fixed name in this job's own temp folder, read only by libass
      await fsp.writeFile(ass, plan.captions.ass, "utf8");
    }
    const finalTmp = path.join(tmp, `final.${preset.container}`);

    if (!gpu) {
      // the server's pipeline at full size, every step on this PC's encoders
      const band = meter.band(prepWeight, 1, steps.filter((x) => x.id !== "prepare"));
      const a = await this.assemble(job, plan, w, h, ctxFor(local, plan), band, true);
      await band.step("final", finalArgs({ video: a.body, audio: a.finalAudio, out: finalTmp, ass, loudnorm: plan.loudnorm, encoder: enc.args,
        container: preset.container, fps: preset.fps, audioBitrate: preset.audioBitrate }), a.total);
    } else {
      // 1. the sound: the same pipeline at draft size (crossfades, voice, layers, music with ducking); its picture is thrown away
      const draft = draftDims(w, h);
      const dq = new URLSearchParams(q);
      dq.set("w", String(draft.w));
      dq.set("h", String(draft.h));
      const small = await this.deps.upstream.json<RenderPlan>(`/api/episodes/${job.eid}/render-plan?${dq}`, { signal, timeoutMs: 300_000 });
      const extra = await this.ensureLocal(job.pid, planKeys(small).filter((k) => !local.has(k)), signal, job, prepWeight);
      const smallLocal = new Map([...local, ...extra]);
      const soundTo = prepWeight + 0.14;
      const soundBand = meter.band(prepWeight, soundTo, stepWeights(small, { music: o.music }).filter((x) => x.id !== "prepare"), "Mixing the sound");
      const sound = await this.assemble(job, small, draft.w, draft.h, ctxFor(smallLocal, small), soundBand, false);
      // 2. the picture: every frame drawn by the GPU engine in a hidden window and encoded as it arrives
      // the FFmpeg timeline's real length (segments round up to whole frames), so the GPU render has exactly the
      // frames the server's render would
      const frames = Math.max(1, Math.round((sound.total || plan.duration_s || 0) * fps));
      await this.gpuFrames(job, { kind: "plan", plan }, { w, h, fps, frames, audio: sound.finalAudio, ass, out: finalTmp, encoder: enc.args,
        container: preset.container, ff, tmp, signal, meter, from: soundTo, loudnorm: plan.loudnorm, audioBitrate: preset.audioBitrate });
    }
    await this.finish(job, { project, ep, preset, folder, finalTmp, plan, ff });
  }

  /** Overall progress and ETA for a job, split into bands (prepare, sound, frames …) that FFmpeg steps fill. */
  private meter(job: RenderJob, t0: number, prepWeight: number, run: { ff: string; tmp: string; signal: AbortSignal }) {
    const set = (prog: number, extra: Partial<RenderJob> = {}) => {
      job.progress = Math.round(Math.min(0.995, prog) * 1000) / 1000;
      const el = (Date.now() - t0) / 1000;
      job.elapsed_s = Math.round(el);
      const span = job.progress - prepWeight;
      job.eta_s = span > 0.02 ? Math.round((el / span) * (1 - job.progress)) : undefined;
      Object.assign(job, extra);
      this.emit(job);
    };
    const band = (from: number, to: number, weights: { id: string; label: string; weight: number; seconds: number }[], label?: string): Band => {
      const sum = weights.reduce((a, x) => a + x.weight, 0) || 1;
      // each step's fraction done: steps may run side by side (the segments), so the band's progress is their weighted sum
      const fractions = new Map<string, number>();
      const progress = () => {
        let p = from;
        for (const [id, frac] of fractions) p += ((weights.find((x) => x.id === id)?.weight ?? 0) / sum) * (to - from) * frac;
        return p;
      };
      return {
        step: async (id, args, seconds, signal = run.signal) => {
          const st = weights.find((x) => x.id === id);
          job.stepId = id;
          job.step = label ? `${label} · ${st?.label ?? id}` : st?.label ?? id;
          this.emit(job, true);
          const expected = seconds ?? st?.seconds ?? 0;
          fractions.set(id, 0);
          // one GPU slot per FFmpeg step: renders, proxies and the local tools share the card's few encode sessions
          await gpuGate.run(() => runFfmpeg(run.ff, args, {
            signal, cwd: run.tmp, stallMs: RENDER_STALL_MS,
            onProgress: (pr: FfProgress) => {
              job.speed = pr.speed;
              fractions.set(id, expected > 0 ? Math.min(1, pr.outTimeS / expected) : 0);
              set(progress());
            },
          }), signal);
          fractions.set(id, 1);
          set(progress());
        },
      };
    };
    return { set, band };
  }

  /** Segments → end card → join → sound mix (and picture layers when `pictures`): the server's assembler, step by step. */
  private async assemble(job: RenderJob, plan: RenderPlan, w: number, h: number, c: AssembleCtx, band: Band, pictures: boolean):
    Promise<{ body: string; finalAudio: string; total: number }> {
    const { ff, tmp, signal, fps, need } = c;
    const tag = pictures ? "" : "snd_";
    // 1. segments: independent of each other, so they run side by side, as many at once as the GPU gate has slots (each
    //    step takes one), and land in the plan's order; one failure stops the others
    const clips = plan.segments.map((_, i) => path.join(tmp, `${tag}seg_${String(i).padStart(3, "0")}.mp4`));
    const lengths = plan.segments.map((s) => s.seg_len);
    const transitions: ([string, number] | null)[] = plan.segments.map((s, i) => (i > 0 ? s.transition ?? null : null));
    const together = new AbortController();
    const onAbort = () => together.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await pool(plan.segments.map((seg, i) => ({ seg, i })), Math.max(1, gpuGate.slots), async ({ seg, i }) => {
        try {
          await this.segment(job, plan, seg, i, clips[i], w, h, c, band, pictures, together.signal);
        } catch (e) {
          together.abort(); // the siblings stop too; the first error is the job's
          throw e;
        }
      }, together.signal);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    // 2. end card
    if (plan.end_card?.key) {
      const out = path.join(tmp, `${tag}seg_endcard.mp4`);
      await band.step("endcard", stillArgs({ image: need(plan.end_card.key), out, seconds: plan.end_card.seconds, w, h, fps, kenburns: false,
        vf: plan.end_card.vf, enc: c.inter }));
      clips.push(out);
      lengths.push(plan.end_card.seconds);
      transitions.push(plan.end_card.transition ?? null);
    }
    // 3. join
    let body = path.join(tmp, `${tag}body.mp4`);
    const xa = xfadeArgs(clips, lengths, transitions, body, fps, c.inter);
    if (xa) await band.step("join", xa);
    else {
      const list = path.join(tmp, `${tag}body_list.txt`);
      await fsp.writeFile(list, concatList(clips), "utf8");
      await band.step("join", concatArgs(list, body));
    }
    const total = (await probeMedia(ff, body)).duration;
    // 4. sound
    let voice = path.join(tmp, `${tag}voice_mix.wav`);
    await band.step("voice", extractAudioArgs(body, voice), total);
    const pics = (plan.layers?.pics ?? []).map((p) => ({ ...p, path: need(p.key) }));
    const sounds = await Promise.all((plan.layers?.sounds ?? []).map(async (sd) => {
      const p = need(sd.key);
      return { ...sd, path: p, has_audio: sd.has_audio ?? (await probeMedia(ff, p)).hasAudio };
    }));
    if (pictures && c.effects && pics.length) {
      const out = path.join(tmp, "body_layers.mp4");
      await band.step("layers", overlayArgs(body, pics, out, c.inter), total);
      body = out;
    }
    if (c.effects && sounds.length) {
      const out = path.join(tmp, `${tag}voice_layers.wav`);
      const ma = mixArgs(voice, sounds, total, out);
      if (ma) {
        await band.step("mix", ma, total);
        voice = out;
      }
    }
    let finalAudio = voice;
    if (plan.music?.key && c.music) {
      const out = path.join(tmp, `${tag}mixed.wav`);
      await band.step("music", musicBedArgs(need(plan.music.key), voice, out, total, plan.music.volume_db ?? -16, plan.music.duck !== false), total);
      finalAudio = out;
    }
    return { body, finalAudio, total };
  }

  /** One segment of the plan (a still, or a trimmed and scaled clip with its sound graph) into `out`. */
  private async segment(job: RenderJob, plan: RenderPlan, seg: PlanSegment, i: number, out: string, w: number, h: number, c: AssembleCtx, band: Band,
    pictures: boolean, signal: AbortSignal): Promise<void> {
    const { ff, tmp, fps, need, luts } = c;
    const tag = pictures ? "" : "snd_";
    const extra = (seg.extra_audio ?? []).filter((a) => a.key).map((a) => ({ path: need(a.key), offset: a.offset, gain_db: a.gain_db }));
    const override = seg.audio_override ? need(seg.audio_override) : null;
    if (seg.source_kind === "still") {
      let audio = override;
      if (extra.length) {
        audio = path.join(tmp, `${tag}segaud_${i}.wav`);
        await runFfmpeg(ff, mixAudioArgs(override, extra, seg.seg_len, audio), { signal, cwd: tmp });
      }
      await band.step(`seg${i}`, stillArgs({ image: need(seg.source), out, seconds: seg.seg_len, w, h, fps, audio, kenburns: seg.kenburns,
        vf: seg.vf, vfPost: seg.vf_post, afFx: seg.af_fx, luts, enc: c.inter, localUpscale: c.localUpscale && !seg.upscaled }), undefined, signal);
      return;
    }
    const src = need(seg.source);
    const hasAudio = seg.has_audio ?? (await probeMedia(ff, src)).hasAudio;
    let trf: string | null = null;
    if (seg.stabilize && pictures) { // the sound-only pass doesn't need the picture stabilised
      trf = path.join(tmp, `seg_${i}.trf`);
      try {
        await runFfmpeg(ff, stabilizeDetectArgs(seg, src, trf, plan.stabilize_filters?.detect ?? STAB_DETECT), { signal, cwd: tmp });
      } catch (e) {
        if (signal.aborted) throw e;
        job.warnings.push(`${seg.code}: stabilising skipped (${(e as Error).message.slice(0, 160)})`);
        trf = null;
      }
    }
    const s2 = pictures || !seg.stabilize ? seg : { ...seg, stabilize: false };
    const encode = (hwaccel: string[]) => band.step(`seg${i}`, segmentArgs(s2, { w, h, fps, src, out, enc: c.inter, override, extra, hasAudio, luts,
      localUpscale: c.localUpscale, trf, stabTransform: plan.stabilize_filters?.transform, hwaccel }), undefined, signal);
    // decode on the graphics card when the probe found one; the first failure turns it off for the rest of this job
    if (c.hwaccel.on && c.hwaccel.args.length) {
      try {
        await encode(c.hwaccel.args);
        return;
      } catch (e) {
        if (signal.aborted) throw e;
        if (c.hwaccel.on) {
          c.hwaccel.on = false;
          job.warnings.push(`Hardware decoding failed on ${seg.code}, so this render decodes on the processor (${(e as Error).message.slice(0, 160)})`);
        }
      }
    }
    await encode([]);
  }

  /**
   * The GPU path's picture (docs/ENGINE.md §5): FFmpeg waits on stdin with the preset's encoder, a hidden window runs the
   * engine over the full-size plan and hands over every frame (engine.frame), and each frame is written as it arrives.
   */
  private async gpuFrames(job: RenderJob, src: GpuSource, o: { w: number; h: number; fps: number; frames: number; audio: string;
    ass: string | null; out: string; encoder: string[]; container: "mp4" | "mov"; ff: string; tmp: string; signal: AbortSignal;
    meter: { set(prog: number, extra?: Partial<RenderJob>): void }; from: number; loudnorm?: string; audioBitrate?: string;
    /** additive (News Room delivery): RGBA8 frames (W·H·4 bytes) and the caller's own FFmpeg command for the frames */
    rgba?: boolean; pipeArgs?(bits: 8 | 10): string[] }): Promise<void> {
    const open = this.deps.openRenderWindow;
    if (!open) throw new Error("The GPU engine needs the desktop app's render window");
    // FFmpeg starts on the first frame: its size says 8-bit I420 or 10-bit yuv420p10le (whatever the job asked for)
    let pipe: ReturnType<typeof spawnFfmpegPipe> | null = null;
    let inBits: 8 | 10 = 8;
    const want: 8 | 10 = isTenBitEncoder(o.encoder) ? 10 : 8;
    const sizes = o.rgba ? { 8: o.w * o.h * 4, 10: o.w * o.h * 4 } : { 8: frameBytes(o.w, o.h, 8), 10: frameBytes(o.w, o.h, 10) };
    let win: { close(): void } | null = null;
    const t0 = Date.now();
    // the engine's window and its encoder hold one GPU slot for the whole frame pass
    const releaseGpu = await gpuGate.acquire(o.signal);
    try {
      await new Promise<void>((resolve, reject) => {
        const session: GpuSession = {
          src, w: o.w, h: o.h, fps: o.fps, frames: o.frames, next: 0, bits: o.rgba ? 8 : want,
          frame: async (i, bytes) => {
            if (i !== session.next) throw new Error(`frame ${i} arrived, ${session.next} expected`);
            if (!pipe) {
              if (bytes.byteLength !== sizes[8] && bytes.byteLength !== sizes[10]) {
                throw new Error(`frame ${i} has ${bytes.byteLength} bytes, ${sizes[want]} expected (${want}-bit ${o.w}×${o.h})`);
              }
              inBits = bytes.byteLength === sizes[10] && !o.rgba ? 10 : 8;
              pipe = spawnFfmpegPipe(o.ff, o.pipeArgs ? o.pipeArgs(inBits) : gpuFinalArgs({ w: o.w, h: o.h, fps: o.fps, frames: o.frames, audio: o.audio, out: o.out, ass: o.ass,
                loudnorm: o.loudnorm, encoder: o.encoder, container: o.container, bits: inBits, audioBitrate: o.audioBitrate }), { signal: o.signal, cwd: o.tmp });
              job.warnings = job.warnings.filter((w) => !w.startsWith("The GPU engine sent 8-bit"));
              if (want === 10 && inBits === 8 && !o.rgba) job.warnings.push("The GPU engine sent 8-bit frames: the 10-bit file has 8-bit picture detail");
            }
            if (bytes.byteLength !== sizes[inBits]) throw new Error(`frame ${i} has ${bytes.byteLength} bytes, ${sizes[inBits]} expected`);
            await pipe.write(bytes);
            session.next++;
            const secs = Math.max((Date.now() - t0) / 1000, 0.001);
            o.meter.set(o.from + (0.98 - o.from) * (session.next / o.frames), {
              stepId: "gpu", step: `GPU frame ${session.next} of ${o.frames}`, speed: `${(session.next / o.fps / secs).toFixed(2)}x`,
            });
          },
          done: () => (session.next === o.frames ? resolve() : reject(new Error(`the engine stopped at frame ${session.next} of ${o.frames}`))),
          fail: (msg) => reject(new Error(`GPU engine: ${msg}`)),
        };
        this.gpuSessions.set(job.id, session);
        job.stepId = "gpu";
        job.step = "Starting the GPU engine";
        this.emit(job, true);
        o.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        win = open(`/desktop/render-job?id=${encodeURIComponent(job.id)}`, () => {
          if (this.gpuSessions.has(job.id)) reject(new Error("The GPU render window closed before the render finished"));
        });
      });
      job.step = "Finishing the file";
      this.emit(job, true);
      this.gpuSessions.delete(job.id);
      if (!pipe) throw new Error("The GPU engine sent no frames");
      await (pipe as ReturnType<typeof spawnFfmpegPipe>).end();
    } catch (e) {
      (pipe as ReturnType<typeof spawnFfmpegPipe> | null)?.kill();
      throw e;
    } finally {
      releaseGpu();
      this.gpuSessions.delete(job.id);
      try { (win as { close(): void } | null)?.close(); } catch { /* already closed */ }
    }
  }

  /** What the render window needs: the full-size plan or the edit's project and sequence, the size and the frame count. */
  engineJob(id: string): GpuRenderJob {
    const s = this.gpuSessions.get(id);
    if (!s) throw new Error("No GPU render is waiting for this window");
    return gpuJob(s.src, { w: s.w, h: s.h, fps: s.fps, frames: s.frames, bits: s.bits });
  }

  async engineFrame(id: string, index: number, bytes: Uint8Array): Promise<void> {
    const s = this.gpuSessions.get(id);
    if (!s) throw new Error("No GPU render is running for this window");
    await s.frame(index, bytes);
  }

  engineDone(id: string): void { this.gpuSessions.get(id)?.done(); }

  engineFail(id: string, message: string): void { this.gpuSessions.get(id)?.fail(String(message || "failed").slice(0, 1000)); }

  /**
   * A Tatvam Editor export (docs/EDITOR.md §5): the sequence's sound mixed by FFmpeg (editor-audio.ts) into a WAV, then
   * every frame drawn by the GPU engine from the project and muxed with the preset's encoder (loudnorm in the mux),
   * into the edit's Renders folder as `<Sequence name>_v###.<ext>`.
   */
  private async runEdit(job: RenderJob, signal: AbortSignal, tmpHolder: { dir?: string }): Promise<void> {
    const input = this.editJobs.get(job.id);
    if (!input) throw new Error("The edit isn't loaded any more: export again");
    if (input.news) return this.runNews(job, input as NewsRenderInput, signal, tmpHolder); // additive (News Room delivery)
    const ffi = this.deps.ff();
    if (!ffi) throw new Error("FFmpeg wasn't found: set its path in Settings");
    const ff = ffi.path;
    const probe = await this.deps.probe();
    const s = this.deps.settings();
    const preset = PRESETS.find((p) => p.id === job.preset)!;
    const seq = input.project.sequences.find((x) => x.id === input.sequenceId);
    if (!seq) throw new Error("The sequence isn't in the edit any more");
    const { w, h } = editDims(preset, seq.width, seq.height);
    const fps = preset.fps ?? seq.fps;
    const enc = finalEncoder(preset, probe, s.encoder.prefer, s.encoder.hevc10bit);
    if (!enc) throw new Error(`${preset.label} can't be encoded on this PC`);
    Object.assign(job, { w, h, fps, encoder: enc.name, codec: preset.codec, engineUsed: "gpu" });
    const tmp = path.join(input.editDir, "Cache", `export-${job.id.slice(0, 8)}`);
    tmpHolder.dir = tmp;
    await fsp.mkdir(tmp, { recursive: true });
    job.status = "rendering";
    const meter = this.meter(job, Date.now(), 0.01, { ff, tmp, signal });
    // 1. the sound
    const seconds = framesToSeconds(input.range.out - input.range.in, seq.fps);
    const plan = mixPlan(input.project, seq, input.range, undefined, { ducking: input.ducking, irFile: input.irFile });
    job.warnings.push(...plan.warnings);
    const raw = path.join(tmp, "mix.wav");
    const runs = mixJobs(plan, raw, { part: (i) => path.join(tmp, `mix_part${i}.wav`) });
    const loud = input.loudness ?? defaultLoudness(job.preset);
    const passes = loud === "off" ? 0 : 2;
    const band = meter.band(0.01, 0.1, [...runs.map((_, i) => ({ id: `mix${i}`, label: runs.length > 1 ? `Sound mix ${i + 1} of ${runs.length}` : "Sound mix",
      weight: 1, seconds })), ...Array.from({ length: passes }, (_, i) => ({ id: `loud${i}`, label: "Loudness", weight: 0.5, seconds }))], "Mixing the sound");
    for (let i = 0; i < runs.length; i++) await band.step(`mix${i}`, runs[i], seconds);
    // loudness: measure, gain to the target with a true-peak limiter, measure again and correct once
    let mix = raw;
    if (loud !== "off") {
      const target = LOUDNESS[loud];
      const measure = async (f: string) => {
        job.step = "Mixing the sound · Measuring the loudness";
        this.emit(job);
        const r = await runFfmpeg(ff, measureArgs(f), { signal, cwd: tmp });
        return parseEbur128(r.stderr.split(/\r?\n/)).lufs;
      };
      let gain = 0;
      let measured = await measure(raw);
      for (let pass = 0; pass < passes; pass++) {
        const g = nextGain(gain, measured, target.lufs);
        if (g === null) break;
        gain = g;
        const out = path.join(tmp, `mix_loud${pass}.wav`);
        // 1 dB under the ceiling: the AAC encode adds to the true peak, up to about 1 dB on sharp hits (SFX, drums)
        await band.step(`loud${pass}`, normalizeArgs(raw, out, gain, target.truePeak - AAC_TP_MARGIN_DB), seconds);
        mix = out;
        measured = await measure(out);
      }
      job.loudness = { preset: loud, target: target.lufs, measured: measured ?? undefined, gainDb: Math.round(gain * 100) / 100 };
    }
    // 2. the picture, drawn by the GPU engine
    const frames = Math.max(1, Math.round(seconds * fps));
    const finalTmp = path.join(tmp, `final.${preset.container}`);
    await this.gpuFrames(job, { kind: "composition", project: input.project, sequenceId: seq.id, range: input.range },
      { w, h, fps, frames, audio: mix, ass: null, out: finalTmp, encoder: enc.args, container: preset.container, ff, tmp, signal, meter, from: 0.1,
        loudnorm: loud === "off" ? "loudnorm=I=-14:TP=-1.5:LRA=11" : "anull", audioBitrate: preset.audioBitrate });
    // 3. into Renders
    const rendersDir = path.join(input.editDir, "Renders");
    await fsp.mkdir(rendersDir, { recursive: true });
    const name = renderName(input.name || seq.name, preset.container, await fsp.readdir(rendersDir));
    const outPath = path.join(rendersDir, name);
    await fsp.rename(finalTmp, outPath).catch(async () => {
      await fsp.copyFile(finalTmp, outPath);
      await fsp.rm(finalTmp, { force: true });
    });
    job.output = outPath;
    job.localVersion = Number(/_v(\d+)\.[^.]+$/.exec(name)?.[1] ?? 1);
    job.duration_s = Math.round((await probeMedia(ff, outPath)).duration * 100) / 100;
  }

  // ── News Room delivery (docs/EDITOR.md §16.11; newsroom/export.ts, owner nr-delivery) ──

  /** Queue a News Room export (exportGraphics): an edit job whose picture, sound and file newsroom/export.ts makes. */
  startNews(input: NewsRenderInput): string {
    const seq = input.project.sequences.find((s) => s.id === input.sequenceId);
    if (!seq) throw new Error("No such sequence");
    if (!(input.range.out > input.range.in)) throw new Error("The export range is empty");
    const job: RenderJob = {
      id: randomUUID(), pid: 0, eid: 0, lang: input.news.gpu.lang ?? "", preset: input.preset, kind: "edit",
      editPath: input.editPath, sequenceId: seq.id, sequenceName: seq.name,
      options: { effects: true, captions: false, music: true, upscaled: false, localUpscale: false, upload: false, engine: "gpu" },
      status: "queued", progress: 0, step: "Waiting", stepId: "queued", warnings: [], createdAt: nowIso(), upload: { state: "idle" }, uploaded: false,
    };
    this.editJobs.set(job.id, input);
    this.jobs.push(job);
    this.queue.push(job.id);
    this.emit(job, true);
    void this.next();
    return job.id;
  }

  private async runNews(job: RenderJob, input: NewsRenderInput, signal: AbortSignal, tmpHolder: { dir?: string }): Promise<void> {
    const ffi = this.deps.ff();
    if (!ffi) throw new Error("FFmpeg wasn't found: set its path in Settings");
    const ff = ffi.path;
    const probe = await this.deps.probe();
    const s = this.deps.settings();
    const tmp = path.join(input.editDir, "Cache", `news-${job.id.slice(0, 8)}`);
    tmpHolder.dir = tmp;
    await fsp.mkdir(tmp, { recursive: true });
    const n = input.news;
    const meter = this.meter(job, Date.now(), 0.01, { ff, tmp, signal });
    await runNewsExport(job, input, {
      tmp, signal, meter,
      run: (args) => runFfmpeg(ff, args, { signal, cwd: tmp }),
      encoder: (id) => {
        const p = PRESETS.find((x) => x.id === id);
        return p ? finalEncoder(p, probe, s.encoder.prefer, s.encoder.hevc10bit) : null;
      },
      frames: (o) => this.gpuFrames(job, { kind: "composition", project: input.project, sequenceId: input.sequenceId, range: input.range, news: n.gpu },
        { w: n.w, h: n.h, fps: n.fps, frames: n.frames, audio: "", ass: null, out: n.out, encoder: o.encoder, container: o.container, ff, tmp, signal, meter,
          from: o.from, rgba: o.rgba, pipeArgs: o.pipeArgs }),
      emit: (force) => this.emit(job, force),
    });
  }

  /** Into Renders/ with the series name, the SRT beside it. */
  private async finish(job: RenderJob, c: { project: { title: string }; ep: { number: number; season: number }; preset: (typeof PRESETS)[number];
    folder: string; finalTmp: string; plan: RenderPlan; ff: string }): Promise<void> {
    const { project, ep, preset, folder, finalTmp, plan, ff } = c;
    const ext = `.${preset.container}`;
    const version = 1 + Math.max(0, ...this.jobs.filter((j) => j !== job && j.pid === job.pid && j.eid === job.eid && j.lang === job.lang
      && j.preset === job.preset && j.status === "done").map((j) => j.localVersion ?? 0));
    job.localVersion = version;
    const values = { project: project.title, season: ep.season, episode: ep.number, lang: job.lang, preset: job.preset, version,
      date: dateToken(), id: job.id.slice(0, 8), label: preset.label, kind: "render" };
    const tpl = this.deps.settings().naming;
    const rendersDir = path.join(folder, "Renders");
    await fsp.mkdir(rendersDir, { recursive: true });
    const taken = new Set((await fsp.readdir(rendersDir)).map((n) => pathKey(path.join(rendersDir, n))));
    const outPath = uniquePath(path.join(rendersDir, fitName(tpl.Renders, values, rendersDir, ext) + ext), taken);
    await fsp.rename(finalTmp, outPath).catch(async () => {
      await fsp.copyFile(finalTmp, outPath);
      await fsp.rm(finalTmp, { force: true });
    });
    job.output = outPath;
    if (plan.captions?.srt) {
      const srtPath = uniquePath(path.join(rendersDir, fitName(tpl.Captions, values, rendersDir, ".srt") + ".srt"), taken);
      await fsp.writeFile(srtPath, plan.captions.srt, "utf8");
      job.srt = srtPath;
    }
    job.duration_s = Math.round((await probeMedia(ff, outPath)).duration * 100) / 100;
  }

  /** Upload a finished render to the Render Center (resumes a started upload). */
  async upload(id: string): Promise<void> {
    const job = this.get(id);
    if (!job) throw new Error("No such render");
    if (!job.output || !existsSync(job.output) || !["done", "uploading"].includes(job.status)) throw new Error("Only a finished render can be uploaded");
    if (job.kind === "edit" && !job.eid) throw new Error("Only an edit imported from a studio episode can go to that episode's Render Center");
    if (this.uploads.has(id) || job.uploaded) return;
    const abort = new AbortController();
    this.uploads.set(id, abort);
    Object.assign(job, { status: "uploading", progress: 0, step: "Uploading to the Render Center", error: undefined });
    job.upload = { ...job.upload, state: "uploading", error: undefined };
    this.emit(job, true);
    try {
      const size = (await fsp.stat(job.output)).size;
      const srt = job.srt && existsSync(job.srt) ? await fsp.readFile(job.srt, "utf8") : undefined;
      const res = await uploadFile(this.deps.upstream, {
        eid: job.eid, file: job.output, srt, uploadId: job.upload.uploadId, signal: abort.signal,
        meta: { filename: path.basename(job.output), size, language: job.lang, preset: job.preset, w: job.w ?? 0, h: job.h ?? 0, fps: job.fps ?? 24,
          codec: job.codec ?? "", encoder: job.encoder ?? "", cut_version: job.cutVersion ?? null, duration_s: job.duration_s ?? 0,
          machine: os.hostname(), fingerprint: job.fingerprint ?? "" },
        onInit: (uid) => { job.upload.uploadId = uid; this.emit(job, true); },
        onProgress: (p) => {
          job.upload = { ...job.upload, uploadId: p.uploadId, received: p.received, size: p.size };
          job.progress = Math.round((p.received / Math.max(p.size, 1)) * 1000) / 1000;
          this.emit(job);
        },
      });
      const exp = res.export as { id?: number; version?: number };
      Object.assign(job, { status: "done", progress: 1, step: "Uploaded", uploaded: true, export_id: Number(exp.id) || undefined,
        version: typeof exp.version === "number" ? exp.version : undefined });
      job.upload = { ...job.upload, state: "done" };
    } catch (e) {
      const msg = String((e as Error).message || e).slice(0, 500);
      Object.assign(job, { status: "done", progress: 1, step: "Upload failed", error: abort.signal.aborted ? "Upload stopped" : `Upload failed: ${msg}` });
      job.upload = { ...job.upload, state: "failed", error: msg };
      throw e;
    } finally {
      this.uploads.delete(id);
      this.emit(job, true);
    }
  }
}
