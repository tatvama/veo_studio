/**
 * News Room delivery (docs/EDITOR.md §16.11): transparent graphics (ProRes 4444, WebM VP9 with alpha, a PNG
 * sequence), the other ratio of a both-ratio edit, language versions, loops, generated sequences (batch rows, news
 * shorts, the look preview reel) and TV delivery (EBU R128 loudness, legal-range picture). Owner: nr-delivery.
 *
 * `exportGraphics` checks the options, reads the saved edit, adds the generated sequences for this export only and
 * queues a render job (RenderManager.startNews). The job (`runNewsExport`) mixes the sound (mp4 only), has the GPU
 * render window draw every frame (it applies language, ratio and graphics-only itself: newsroom/delivery/window.ts;
 * RGBA on a transparent background for alpha) and encodes it into `<edit folder>\Exports\News\`. Electron-free:
 * the tests drive it with fakes and a fake render window.
 */
import { existsSync, promises as fsp, readdirSync } from "node:fs";
import path from "node:path";
import type {
  EditProject, LoudnessPreset, NewsExportOptions, NewsExportResult, NewsGpuOptions, RenderJob, Sequence,
} from "../../shared/types.ts";
import { parseEbur128 } from "../editor-analyze.ts";
import { defaultLoudness, isLoudnessPreset, LOUDNESS, measureArgs, mixJobs, mixPlan, nextGain, normalizeArgs } from "../editor-audio.ts";
import type { IrPreset } from "../editor-irs.ts";
import { editDims, exportRange, framesToSeconds } from "../editor-model.ts";
import { pathKey, safeFileName, uniquePath } from "../naming.ts";
import { gpuFinalArgs, PRESETS } from "../render-args.ts";
import type { EditExportInput } from "../render.ts";

export type NewsCodec = NewsExportOptions["codec"];
export type NewsRatio = NonNullable<NewsExportOptions["ratio"]>;

/** The four outputs: file extension ("" = a folder of PNG frames), alpha, the encoder's name. */
export const NEWS_CODECS: Record<NewsCodec, { ext: string; alpha: boolean; encoder: string; label: string }> = {
  prores4444: { ext: "mov", alpha: true, encoder: "prores_ks 4444", label: "ProRes 4444 with alpha" },
  webm_alpha: { ext: "webm", alpha: true, encoder: "libvpx-vp9", label: "WebM VP9 with alpha" },
  png: { ext: "", alpha: true, encoder: "png", label: "PNG sequence" },
  mp4: { ext: "mp4", alpha: false, encoder: "", label: "MP4" },
};
const RATIOS: NewsRatio[] = ["16:9", "9:16", "1:1", "4:5"];
const GFX_ROLES = ["background", "layout", "board", "strap", "ticker", "bug", "wipe"];

/** What a queued news render needs besides the edit (RenderManager.startNews → runNewsExport). */
export interface NewsRenderSpec {
  codec: NewsCodec; only: "graphics" | "all";
  /** Output size, frame rate and frame count (frame i is at range.in + i / fps seconds on the sequence). */
  w: number; h: number; fps: number; frames: number;
  /** The final file, or the folder of PNG frames. */
  out: string;
  /** What the GPU window does to the edit (language, ratio, graphics only, alpha, background). */
  gpu: NewsGpuOptions;
  /** mp4: the render preset, loudness target, broadcast-safe picture. */
  preset?: string; loudness?: LoudnessPreset; legal?: boolean;
}
export type NewsRenderInput = EditExportInput & { news: NewsRenderSpec };

/** The saved edit at runtime (media URLs registered for the render window), its folder and the impulse responses. */
export interface LoadedEdit { file: string; dir: string; project: EditProject; irFile?(p: IrPreset): string }

/** What the export needs from the app (main/index.ts passes EditorManager.newsEdit and RenderManager.startNews). */
export interface NewsExportDeps {
  log(msg: string): void;
  loadEdit?(file: string): Promise<LoadedEdit>;
  startNews?(input: NewsRenderInput): string;
}

// ── pure helpers ─────────────────────────────────────────────────────────────

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** The frame of another ratio with the same short side (1920×1080 → 9:16 = 1080×1920, 1:1 = 1080×1080, 4:5 = 1080×1350). */
export function ratioDims(w: number, h: number, ratio?: NewsRatio | null): { w: number; h: number } {
  if (!ratio) return { w: even(w), h: even(h) };
  const [a, b] = ratio.split(":").map(Number);
  const short = Math.min(w, h);
  return a >= b ? { w: even((short * a) / b), h: even(short) } : { w: even(short), h: even((short * b) / a) };
}

/** "9:16" → "9x16" (file names). */
export const ratioTag = (r: string) => r.replace(":", "x");

/** The mp4 preset when none is asked for: by the output's short side (≤ 1080 review quality, 1440 2K, 2160 4K). */
export function defaultNewsPreset(w: number, h: number): string {
  const short = Math.min(w, h);
  return short > 1440 ? "yt4k_h264" : short > 1080 ? "yt2k" : "review1080";
}

/**
 * The output path: `outPath` when it names a file of the right kind, else `<folder>\<name>.<ext>` (a folder for PNG)
 * in `outPath` or `<edit folder>\Exports\News`, made unique against `taken` (`a.mov`, `a_2.mov` …).
 */
export function newsOutPath(o: { editDir: string; outPath?: string; name: string; codec: NewsCodec }, taken: Set<string>): string {
  const ext = NEWS_CODECS[o.codec].ext;
  if (o.outPath && ext && path.extname(o.outPath).toLowerCase() === `.${ext}`) return o.outPath;
  const dir = o.outPath || path.join(o.editDir, "Exports", "News");
  const stem = safeFileName(o.name.replace(/\s+/g, " ").trim(), "News").slice(0, 120).replace(/[.\s]+$/, "") || "News";
  return uniquePath(path.join(dir, ext ? `${stem}.${ext}` : stem), taken);
}

/**
 * FFmpeg for RGBA8 frames on stdin (straight alpha, rows top first) into an alpha format. RGB → Y'CbCr with the
 * BT.709 matrix in limited range (what the YUV exports use), tagged BT.709. PNG frames stay RGBA:
 * `<folder>\<name>_00000.png` …
 */
export function alphaArgs(codec: Exclude<NewsCodec, "mp4">, o: { w: number; h: number; fps: number; frames: number; out: string }): string[] {
  const input = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${o.w}x${o.h}`, "-framerate", String(o.fps), "-i", "pipe:0"];
  const n = ["-frames:v", String(o.frames)];
  if (codec === "png") {
    return [...input, "-an", "-c:v", "png", "-pix_fmt", "rgba", ...n, "-start_number", "0", "-f", "image2",
      path.join(o.out, `${path.basename(o.out)}_%05d.png`)];
  }
  const tags = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
  const yuv = (fmt: string) => `scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=${fmt},`
    + "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";
  if (codec === "prores4444") {
    return [...input, "-an", "-vf", yuv("yuva444p10le"), "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
      "-alpha_bits", "16", "-vendor", "apl0", ...tags, ...n, o.out];
  }
  // VP9 keeps the alpha plane as a second stream FFmpeg and browsers read back (alpha_mode); no alt-ref frames with it
  return [...input, "-an", "-vf", yuv("yuva420p"), "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "30",
    "-deadline", "good", "-cpu-used", "2", "-row-mt", "1", "-auto-alt-ref", "0", ...tags, ...n, o.out];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (msg: string): never => { throw new Error(msg); };

/** A generated sequence from the page, checked like a saved one (ids, tracks, clips, size, frame rate). */
export function checkSequence(v: unknown, i: number): Sequence {
  const what = `Generated sequence ${i + 1}`;
  if (!isObj(v) || typeof v.id !== "string" || !v.id || v.id.length > 100) return fail(`${what} has no id`);
  if (!Array.isArray(v.tracks) || !Array.isArray(v.clips)) return fail(`${what} is broken`);
  if (v.clips.length > 20_000 || v.tracks.length > 200) return fail(`${what} is too big`);
  if (!(Number(v.width) > 0) || !(Number(v.height) > 0) || !(Number(v.fps) > 0)) return fail(`${what} has no size or frame rate`);
  const s = v as unknown as Sequence;
  s.name = typeof s.name === "string" && s.name ? s.name : "News export";
  if (!Array.isArray(s.transitions)) s.transitions = [];
  if (!Array.isArray(s.markers)) s.markers = [];
  if (typeof s.playhead !== "number") s.playhead = 0;
  s.sampleRate = 48000;
  return s;
}

/** The options with defaults, or an error in plain words. */
export function checkNewsOptions(o: unknown): NewsExportOptions {
  if (!isObj(o)) return fail("Nothing to export");
  const x = o as unknown as NewsExportOptions;
  if (typeof x.editPath !== "string" || !path.isAbsolute(x.editPath)) fail("Save the edit first: the export reads the saved edit");
  if (typeof x.sequenceId !== "string" || !x.sequenceId || x.sequenceId.length > 100) fail("Pick a sequence to export");
  if (!Object.prototype.hasOwnProperty.call(NEWS_CODECS, x.codec)) fail(`Unknown format ${String(x.codec)}`);
  const only = x.only === "graphics" ? "graphics" : x.only === "all" || x.only === undefined ? "all" : fail(`"only" must be graphics or all`);
  if (x.ratio !== undefined && !RATIOS.includes(x.ratio)) fail(`Unknown ratio ${String(x.ratio)}`);
  if (x.lang !== undefined && (typeof x.lang !== "string" || !/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(x.lang))) fail("A language is a code like hi or kn");
  if (x.range !== undefined) {
    const r = x.range;
    if (!isObj(r) || !Number.isInteger(r.in) || !Number.isInteger(r.out) || r.in < 0 || r.out <= r.in) fail("The export range is empty");
  }
  if (x.name !== undefined && (typeof x.name !== "string" || x.name.length > 200)) fail("The name is too long");
  if (x.outPath !== undefined && (typeof x.outPath !== "string" || !path.isAbsolute(x.outPath))) fail("The output must be a full path");
  const list = (v: unknown, name: string, max: number) => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length > max || v.some((s) => typeof s !== "string" || !s || s.length > 100)) return fail(`${name} must be a list of names`);
    return v as string[];
  };
  const roles = list(x.roles, "roles", 20);
  if (roles?.some((r) => !GFX_ROLES.includes(r))) fail(`Unknown graphics role in ${roles.join(", ")}`);
  const clipIds = list(x.clipIds, "clipIds", 2000);
  if (x.preset !== undefined && !PRESETS.some((p) => p.id === x.preset)) fail(`Unknown preset ${String(x.preset)}`);
  if (x.loudness !== undefined && !isLoudnessPreset(x.loudness)) fail(`Unknown loudness target ${String(x.loudness)}`);
  if (x.background !== undefined && (typeof x.background !== "string" || !/^#[0-9a-f]{6}$/i.test(x.background))) fail("The background must be a colour like #000000");
  if (x.sequences !== undefined && (!Array.isArray(x.sequences) || x.sequences.length > 60)) fail("At most 60 generated sequences in one export");
  if (x.templates !== undefined) {
    if (!isObj(x.templates) || Object.keys(x.templates).length > 500) fail("Too many templates");
    for (const [id, t] of Object.entries(x.templates)) if (!isObj(t) || t.id !== id || !isObj(t.designs)) fail(`Template ${id} is broken`);
  }
  return {
    editPath: x.editPath, sequenceId: x.sequenceId, codec: x.codec, only,
    ...(x.range ? { range: { in: x.range.in, out: x.range.out } } : {}),
    ...(x.ratio ? { ratio: x.ratio } : {}), ...(x.lang ? { lang: x.lang } : {}),
    ...(x.outPath ? { outPath: x.outPath } : {}), ...(x.name?.trim() ? { name: x.name.trim() } : {}),
    ...(roles?.length ? { roles } : {}), ...(clipIds?.length ? { clipIds } : {}),
    ...(x.preset ? { preset: x.preset } : {}), ...(x.loudness ? { loudness: x.loudness } : {}),
    ...(x.legal ? { legal: true } : {}), ...(x.background ? { background: x.background.toLowerCase() } : {}),
    ...(x.sequences?.length ? { sequences: x.sequences } : {}), ...(x.templates ? { templates: x.templates } : {}),
  };
}

/** The saved edit plus the generated sequences (replacing ones with the same id) and templates, for one export. */
export function withGenerated(p: EditProject, sequences: unknown[] = [], templates?: Record<string, unknown>): EditProject {
  const extra = sequences.map(checkSequence);
  const ids = new Set(extra.map((s) => s.id));
  if (ids.size !== extra.length) fail("Two generated sequences have the same id");
  const media = new Set(p.media.map((m) => m.id));
  for (const s of extra) {
    for (const c of s.clips as unknown as { source?: { type?: string; mediaId?: string } }[]) {
      if (c?.source?.type === "media" && !media.has(String(c.source.mediaId))) fail(`${s.name} uses media that isn't in the saved edit: save first`);
    }
  }
  const out: EditProject & { newsroom?: { templates?: Record<string, unknown> } } = { ...p, sequences: [...p.sequences.filter((s) => !ids.has(s.id)), ...extra] };
  if (templates && Object.keys(templates).length) {
    const nr = (p as { newsroom?: Record<string, unknown> }).newsroom;
    if (!isObj(nr)) fail("This edit has no News Room yet: add a graphic and save first");
    out.newsroom = { ...nr, templates: { ...(isObj(nr!.templates) ? nr!.templates : {}), ...templates } };
  }
  return out;
}

// ── queueing ─────────────────────────────────────────────────────────────────

/** Output paths handed out this session (a batch queues many before any file exists). */
const reserved = new Set<string>();

/** Checks the options, reads the saved edit and queues the render; resolves with the job id and where it will write. */
export async function exportGraphics(d: NewsExportDeps, raw: NewsExportOptions): Promise<NewsExportResult | null> {
  const o = checkNewsOptions(raw);
  if (!d.loadEdit || !d.startNews) throw new Error("News exports need the desktop app's render engine");
  const edit = await d.loadEdit(o.editPath);
  const project = withGenerated(edit.project, o.sequences, o.templates);
  const seq = project.sequences.find((s) => s.id === o.sequenceId);
  if (!seq) throw new Error("That sequence isn't in the saved edit: save first");
  const range = o.range ?? exportRange(seq, "all");
  const base = ratioDims(seq.width, seq.height, o.ratio);
  const mp4 = o.codec === "mp4";
  const preset = mp4 ? PRESETS.find((p) => p.id === (o.preset ?? defaultNewsPreset(base.w, base.h)))! : null;
  const size = preset ? editDims(preset, base.w, base.h) : base;
  const fps = preset?.fps ?? seq.fps;
  const seconds = framesToSeconds(range.out - range.in, seq.fps);
  const frames = Math.max(1, Math.round(seconds * fps));
  const name = o.name ?? `${seq.name}${o.ratio ? `_${ratioTag(o.ratio)}` : ""}${o.lang ? `_${o.lang}` : ""}`;
  const dir = o.outPath && !(NEWS_CODECS[o.codec].ext && path.extname(o.outPath).toLowerCase() === `.${NEWS_CODECS[o.codec].ext}`)
    ? o.outPath : path.join(edit.dir, "Exports", "News");
  const taken = new Set(reserved);
  try { for (const n of readdirSync(dir)) taken.add(pathKey(path.join(dir, n))); } catch { /* not made yet */ }
  const out = newsOutPath({ editDir: edit.dir, outPath: o.outPath, name, codec: o.codec }, taken);
  reserved.add(pathKey(out));
  const gpu: NewsGpuOptions = {
    ...(NEWS_CODECS[o.codec].alpha ? { alpha: true } : {}), only: o.only,
    ...(o.roles ? { roles: o.roles } : {}), ...(o.clipIds ? { clipIds: o.clipIds } : {}),
    ...(o.ratio ? { ratio: o.ratio } : {}), ...(o.lang ? { lang: o.lang } : {}),
    ...(mp4 && o.only === "graphics" ? { background: o.background ?? "#000000" } : {}),
  };
  const jobId = d.startNews({
    editPath: edit.file, editDir: edit.dir, project, sequenceId: seq.id, range, preset: preset?.id ?? o.codec, upload: false, name,
    ...(o.loudness ? { loudness: o.loudness } : {}), ...(edit.irFile ? { irFile: edit.irFile } : {}),
    news: { codec: o.codec, only: o.only, w: size.w, h: size.h, fps, frames, out, gpu,
      ...(preset ? { preset: preset.id } : {}), ...(o.loudness ? { loudness: o.loudness } : {}), ...(o.legal ? { legal: true } : {}) },
  });
  d.log(`news export ${jobId}: ${o.codec} ${size.w}×${size.h} ${frames} frames → ${out}`);
  return { path: out, frames, seconds: Math.round(seconds * 1000) / 1000, jobId, w: size.w, h: size.h, fps };
}

// ── the render job ───────────────────────────────────────────────────────────

/** What RenderManager lends the job: FFmpeg, progress bands, the GPU window's frames, the preset encoders. */
export interface NewsRunCtx {
  tmp: string; signal: AbortSignal;
  meter: {
    set(prog: number, extra?: Partial<RenderJob>): void;
    band(from: number, to: number, weights: { id: string; label: string; weight: number; seconds: number }[], label?: string): { step(id: string, args: string[], seconds?: number): Promise<void> };
  };
  /** One FFmpeg run in the job's temp folder (measurements). */
  run(args: string[]): Promise<{ stderr: string }>;
  /** The final encoder for a preset on this PC, or null. */
  encoder(presetId: string): { name: string; args: string[] } | null;
  /** The GPU window draws every frame; each is piped into `pipeArgs(bits)` (RGBA8 when `rgba`). */
  frames(o: { from: number; rgba: boolean; pipeArgs(bits: 8 | 10): string[]; encoder: string[]; container: "mp4" | "mov" }): Promise<void>;
  emit(force?: boolean): void;
}

/** Moves the finished file (or PNG folder) into place. */
async function moveInto(src: string, dst: string): Promise<void> {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  if (existsSync(dst)) await fsp.rm(dst, { recursive: true, force: true });
  await fsp.rename(src, dst).catch(async () => {
    await fsp.cp(src, dst, { recursive: true });
    await fsp.rm(src, { recursive: true, force: true });
  });
}

/** The mix for an mp4 (silence for graphics only), normalised to the loudness target like an edit export. */
async function newsSound(job: RenderJob, input: NewsRenderInput, seq: Sequence, c: NewsRunCtx): Promise<{ wav: string; loudnorm: string }> {
  const n = input.news;
  const seconds = framesToSeconds(input.range.out - input.range.in, seq.fps);
  const full = mixPlan(input.project, seq, input.range, undefined, { ducking: input.ducking, irFile: input.irFile });
  // graphics carry no sound of their own
  const plan = n.only === "graphics" ? { ...full, clips: [], warnings: [] } : full;
  job.warnings.push(...plan.warnings);
  const raw = path.join(c.tmp, "mix.wav");
  const runs = mixJobs(plan, raw, { part: (i) => path.join(c.tmp, `mix_part${i}.wav`) });
  const loud: LoudnessPreset = n.only === "graphics" ? "off" : n.loudness ?? defaultLoudness(n.preset ?? "");
  const passes = loud === "off" ? 0 : 2;
  const band = c.meter.band(0.01, 0.1, [...runs.map((_, i) => ({ id: `mix${i}`, label: runs.length > 1 ? `Sound mix ${i + 1} of ${runs.length}` : "Sound mix",
    weight: 1, seconds })), ...Array.from({ length: passes }, (_, i) => ({ id: `loud${i}`, label: "Loudness", weight: 0.5, seconds }))], "Mixing the sound");
  for (let i = 0; i < runs.length; i++) await band.step(`mix${i}`, runs[i], seconds);
  if (n.only === "graphics") return { wav: raw, loudnorm: "anull" };
  let mix = raw;
  if (loud !== "off") {
    const target = LOUDNESS[loud];
    const measure = async (f: string) => {
      job.step = "Mixing the sound · Measuring the loudness";
      c.emit();
      return parseEbur128((await c.run(measureArgs(f))).stderr.split(/\r?\n/)).lufs;
    };
    let gain = 0;
    let measured = await measure(raw);
    for (let pass = 0; pass < passes; pass++) {
      const g = nextGain(gain, measured, target.lufs);
      if (g === null) break;
      gain = g;
      const out = path.join(c.tmp, `mix_loud${pass}.wav`);
      await band.step(`loud${pass}`, normalizeArgs(raw, out, gain, target.truePeak - 0.5), seconds);
      mix = out;
      measured = await measure(out);
    }
    job.loudness = { preset: loud, target: target.lufs, measured: measured ?? undefined, gainDb: Math.round(gain * 100) / 100 };
  }
  return { wav: mix, loudnorm: loud === "off" ? "loudnorm=I=-14:TP=-1.5:LRA=11" : "anull" };
}

/** A queued news render (RenderManager runs it in its queue, after the exports before it). */
export async function runNewsExport(job: RenderJob, input: NewsRenderInput, c: NewsRunCtx): Promise<void> {
  const n = input.news;
  const seq = input.project.sequences.find((x) => x.id === input.sequenceId);
  if (!seq) throw new Error("The sequence isn't in the edit any more");
  const spec = NEWS_CODECS[n.codec];
  Object.assign(job, { w: n.w, h: n.h, fps: n.fps, codec: n.codec, engineUsed: "gpu" as const });
  job.status = "rendering";
  // the name is free again once the file is there (or the export didn't make it)
  try { await renderNews(job, input, c, seq, spec); } finally { reserved.delete(pathKey(n.out)); }
  job.output = n.out;
  job.duration_s = Math.round((n.frames / n.fps) * 100) / 100;
}

async function renderNews(job: RenderJob, input: NewsRenderInput, c: NewsRunCtx, seq: Sequence, spec: (typeof NEWS_CODECS)[NewsCodec]): Promise<void> {
  const n = input.news;
  if (n.codec === "mp4") {
    const preset = PRESETS.find((p) => p.id === n.preset);
    if (!preset) throw new Error(`Unknown preset ${n.preset}`);
    const enc = c.encoder(preset.id);
    if (!enc) throw new Error(`${preset.label} can't be encoded on this PC`);
    job.encoder = enc.name;
    const sound = await newsSound(job, input, seq, c);
    const finalTmp = path.join(c.tmp, `final.${preset.container}`);
    await c.frames({ from: 0.1, rgba: false, encoder: enc.args, container: preset.container,
      pipeArgs: (bits) => gpuFinalArgs({ w: n.w, h: n.h, fps: n.fps, frames: n.frames, audio: sound.wav, out: finalTmp, loudnorm: sound.loudnorm,
        encoder: enc.args, container: preset.container, bits, audioBitrate: preset.audioBitrate, legal: n.legal }) });
    await moveInto(finalTmp, n.out);
  } else {
    job.encoder = spec.encoder;
    // a PNG folder is named like the output, so its frames are too
    const tmpOut = n.codec === "png" ? path.join(c.tmp, path.basename(n.out)) : path.join(c.tmp, `final.${spec.ext}`);
    if (n.codec === "png") await fsp.mkdir(tmpOut, { recursive: true });
    await c.frames({ from: 0.02, rgba: true, encoder: [], container: "mov",
      pipeArgs: () => alphaArgs(n.codec as Exclude<NewsCodec, "mp4">, { w: n.w, h: n.h, fps: n.fps, frames: n.frames, out: tmpOut }) });
    await moveInto(tmpOut, n.out);
  }
}
