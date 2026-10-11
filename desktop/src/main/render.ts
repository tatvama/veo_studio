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
import type { DesktopSettings, RenderJob, RenderJobInput, RenderPreset, RenderState } from "../shared/types.ts";
import { writeFileAtomic } from "./config.ts";
import { downloadTo, pool } from "./download.ts";
import { probeMedia, runFfmpeg, type FfmpegInfo, type FfProgress } from "./ffmpeg.ts";
import type { Library } from "./library.ts";
import { dateToken, fitName, pathKey, safePart, uniquePath } from "./naming.ts";
import {
  PRESETS, STAB_DETECT, concatArgs, concatList, extractAudioArgs, finalArgs, finalEncoder, intermediateEncoder, mixArgs, mixAudioArgs,
  musicBedArgs, overlayArgs, presetDims, presetList, segmentArgs, stabilizeDetectArgs, stepWeights, stillArgs, xfadeArgs, type RenderPlan,
} from "./render-args.ts";
import { uploadFile } from "./upload.ts";
import type { Upstream } from "./upstream.ts";

export interface RenderDeps {
  upstream: Upstream;
  library: Library;
  ff(): FfmpegInfo | null;
  probe(): Promise<Record<string, boolean>>;
  settings(): DesktopSettings;
  jobsFile: string;
  broadcast(job: RenderJob): void;
  log(msg: string): void;
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

const nowIso = () => new Date().toISOString();
const ACTIVE: RenderState[] = ["preparing", "downloading", "rendering"];

export class RenderManager {
  private deps: RenderDeps;
  private jobs: RenderJob[] = [];
  private queue: string[] = [];
  private running: { id: string; abort: AbortController } | null = null;
  private uploads = new Map<string, AbortController>();
  private lastEmit = new Map<string, number>();

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
        localUpscale: Boolean(input.localUpscale), upload: Boolean(input.upload) },
      status: "queued", progress: 0, step: "Waiting", stepId: "queued", warnings: [], createdAt: nowIso(), upload: { state: "idle" }, uploaded: false,
    };
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
    Object.assign(job, { status: "preparing", startedAt: nowIso(), stepId: "prepare", step: "Getting the render plan", progress: 0, error: undefined });
    this.emit(job, true);
    const tmpHolder: { dir?: string } = {};
    try {
      await this.run(job, abort.signal, tmpHolder);
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
    const steps = stepWeights(plan, { music: o.music });
    const prepWeight = steps.find((x) => x.id === "prepare")!.weight;
    const local = await this.ensureLocal(job.pid, planKeys(plan), signal, job, prepWeight);
    const need = (k: string) => {
      const p = local.get(k);
      if (!p) throw new Error(`Missing media ${k}`);
      return p;
    };
    const luts: Record<string, string> = {};
    for (const [id, k] of Object.entries(plan.luts ?? {})) if (local.get(k)) luts[id] = local.get(k)!;

    job.status = "rendering";
    const t0 = Date.now();
    let doneWeight = prepWeight;
    const step = async (id: string, args: string[], seconds?: number) => {
      const st = steps.find((x) => x.id === id);
      job.stepId = id;
      job.step = st?.label ?? id;
      this.emit(job, true);
      const expected = seconds ?? st?.seconds ?? 0;
      await runFfmpeg(ff, args, {
        signal, cwd: tmp,
        onProgress: (p: FfProgress) => {
          const frac = expected > 0 ? Math.min(1, p.outTimeS / expected) : 0;
          const prog = Math.min(0.995, doneWeight + (st?.weight ?? 0) * frac);
          job.progress = Math.round(prog * 1000) / 1000;
          job.speed = p.speed;
          const el = (Date.now() - t0) / 1000;
          job.elapsed_s = Math.round(el);
          const span = prog - prepWeight;
          job.eta_s = span > 0.02 ? Math.round((el / span) * (1 - prog)) : undefined;
          this.emit(job);
        },
      });
      doneWeight += st?.weight ?? 0;
    };

    // 1. segments
    const clips: string[] = [];
    const lengths: number[] = [];
    const transitions: ([string, number] | null)[] = [];
    for (let i = 0; i < plan.segments.length; i++) {
      const seg = plan.segments[i];
      const out = path.join(tmp, `seg_${String(i).padStart(3, "0")}.mp4`);
      const extra = (seg.extra_audio ?? []).filter((a) => a.key).map((a) => ({ path: need(a.key), offset: a.offset, gain_db: a.gain_db }));
      const override = seg.audio_override ? need(seg.audio_override) : null;
      if (seg.source_kind === "still") {
        let audio = override;
        if (extra.length) {
          audio = path.join(tmp, `segaud_${i}.wav`);
          await runFfmpeg(ff, mixAudioArgs(override, extra, seg.seg_len, audio), { signal, cwd: tmp });
        }
        await step(`seg${i}`, stillArgs({ image: need(seg.source), out, seconds: seg.seg_len, w, h, fps, audio, kenburns: seg.kenburns,
          vf: seg.vf, vfPost: seg.vf_post, afFx: seg.af_fx, luts, enc: inter.args, localUpscale: o.localUpscale && !seg.upscaled }));
      } else {
        const src = need(seg.source);
        const hasAudio = seg.has_audio ?? (await probeMedia(ff, src)).hasAudio;
        let trf: string | null = null;
        if (seg.stabilize) {
          trf = path.join(tmp, `seg_${i}.trf`);
          try {
            await runFfmpeg(ff, stabilizeDetectArgs(seg, src, trf, plan.stabilize_filters?.detect ?? STAB_DETECT), { signal, cwd: tmp });
          } catch (e) {
            if (signal.aborted) throw e;
            job.warnings.push(`${seg.code}: stabilising skipped (${(e as Error).message.slice(0, 160)})`);
            trf = null;
          }
        }
        await step(`seg${i}`, segmentArgs(seg, { w, h, fps, src, out, enc: inter.args, override, extra, hasAudio, luts,
          localUpscale: o.localUpscale, trf, stabTransform: plan.stabilize_filters?.transform }));
      }
      clips.push(out);
      lengths.push(seg.seg_len);
      transitions.push(i > 0 ? seg.transition ?? null : null);
    }
    // 2. end card
    if (plan.end_card?.key) {
      const out = path.join(tmp, "seg_endcard.mp4");
      await step("endcard", stillArgs({ image: need(plan.end_card.key), out, seconds: plan.end_card.seconds, w, h, fps, kenburns: false,
        vf: plan.end_card.vf, enc: inter.args }));
      clips.push(out);
      lengths.push(plan.end_card.seconds);
      transitions.push(plan.end_card.transition ?? null);
    }
    // 3. join
    let body = path.join(tmp, "body.mp4");
    const xa = xfadeArgs(clips, lengths, transitions, body, fps, inter.args);
    if (xa) await step("join", xa);
    else {
      const list = path.join(tmp, "body_list.txt");
      await fsp.writeFile(list, concatList(clips), "utf8");
      await step("join", concatArgs(list, body));
    }
    const total = (await probeMedia(ff, body)).duration;
    // 4. sound
    let voice = path.join(tmp, "voice_mix.wav");
    await step("voice", extractAudioArgs(body, voice), total);
    const pics = (plan.layers?.pics ?? []).map((p) => ({ ...p, path: need(p.key) }));
    const sounds = await Promise.all((plan.layers?.sounds ?? []).map(async (sd) => {
      const p = need(sd.key);
      return { ...sd, path: p, has_audio: sd.has_audio ?? (await probeMedia(ff, p)).hasAudio };
    }));
    if (o.effects && pics.length) {
      const out = path.join(tmp, "body_layers.mp4");
      await step("layers", overlayArgs(body, pics, out, inter.args), total);
      body = out;
    }
    if (o.effects && sounds.length) {
      const out = path.join(tmp, "voice_layers.wav");
      const ma = mixArgs(voice, sounds, total, out);
      if (ma) {
        await step("mix", ma, total);
        voice = out;
      }
    }
    let finalAudio = voice;
    if (plan.music?.key && o.music) {
      const out = path.join(tmp, "mixed.wav");
      await step("music", musicBedArgs(need(plan.music.key), voice, out, total, plan.music.volume_db ?? -16, plan.music.duck !== false), total);
      finalAudio = out;
    }
    // 5. final
    let ass: string | null = null;
    if (plan.captions?.ass) {
      ass = path.join(tmp, "captions.ass");
      await fsp.writeFile(ass, plan.captions.ass, "utf8");
    }
    const ext = `.${preset.container}`;
    const finalTmp = path.join(tmp, `final${ext}`);
    await step("final", finalArgs({ video: body, audio: finalAudio, out: finalTmp, ass, loudnorm: plan.loudnorm, encoder: enc.args,
      container: preset.container, fps: preset.fps }), total);

    // 6. into Renders/ with the series name, SRT beside it
    const version = 1 + Math.max(0, ...this.jobs.filter((j) => j !== job && j.pid === job.pid && j.eid === job.eid && j.lang === job.lang
      && j.preset === job.preset && j.status === "done").map((j) => j.localVersion ?? 0));
    job.localVersion = version;
    const values = { project: project.title, season: ep.season, episode: ep.number, lang: job.lang, preset: job.preset, version,
      date: dateToken(), id: job.id.slice(0, 8), label: preset.label, kind: "render" };
    const tpl = s.naming;
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
