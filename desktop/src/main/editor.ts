/**
 * The Tatvam Editor's main-process side (docs/EDITOR.md §1, §5, §8): edit projects in `<library>\Edits\<Name>\`
 * (`<Name>.tatvamedit`, `Media\`, `Cache\`, `Renders\`), recent edits (userData/editor-recent.json), atomic saves with
 * `.bak.1..10` rotated at most once a minute, media import (probe, copy, thumbnail, filmstrip, peaks), the registry
 * of files the gateway serves at /__media/<id>/<name>, relink, proxies, LUT and shader import, a studio episode as a
 * sequence, the export (RenderManager.startEdit), local analysis, and media to / from the studio for the AI tools.
 *
 * Only edit files that were created, opened through the dialog, listed (library or recents) or handed over by a
 * tatvam:// link may be read or written, and only files of those edits (or files imported into them) are served.
 * Electron-free: dialogs come in through `EditorDialogs`, FFmpeg through `MediaTools` (tests pass fakes).
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, openAsBlob, promises as fsp, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AnalyzeKind, AnalyzeOptions, AnalyzeResult, EditBackupResult, EditBackupStatus, EditBatchItem, EditExportOptions, EditListEntry, EditorJob, EditPreset,
  EditProject, EditVersion, InterpolateOptions, LocalTranscript, LutEntry, MediaItem, ShaderEntry, TimelineClip, TranscribeOptions,
} from "../shared/types.ts";
import { isLoudnessPreset, previewJob } from "./editor-audio.ts";
import { attachSpectra } from "./editor-audiotools.ts"; // audio-tools2 (additive)
import { interpDiskBytes, interpName, interpPlan, isRifeFrameLine, readMatrix, rifeArgs, rifeEncodeArgs, rifeExtractArgs, RIFE_MODELS, isV4 } from "./editor-interpolate.ts";
import { IR_LABELS, IR_NAMES, IR_PRESETS, irSeconds, isIrPreset, presetWav, type IrPreset } from "./editor-irs.ts";
import { etaFrom, LocalJobs, runProc, type ProcRunner } from "./editor-jobs.ts";
import { LUT_EXTS, scanLutFolder, sidecarName, threeDlToCube } from "./editor-luts.ts";
import { f32, SYNC_MAX_OFFSET_S, SYNC_RATE, SYNC_WINDOW_S, syncDecodeArgs, syncOffset } from "./editor-sync.ts";
import { checkLanguage, noGpuInLog, parseWhisperJson, parseWhisperProgress, wavArgs, whisperArgs, whisperThreads } from "./editor-whisper.ts";
import { pickGpu } from "./aiupscale.ts";
import { finalEncoder, type PresetDef } from "./render-args.ts";
import { WHISPER_MODELS, type ToolManager } from "./tools.ts";
import { writeFileAtomic } from "./config.ts";
import { downloadTo, pool } from "./download.ts";
import {
  beatsArgs, BEAT_RATE, detectBeats, loudnessArgs, parseEbur128, parseScenes, parseSilence, scenesArgs, silenceArgs,
} from "./editor-analyze.ts";
import { dimsFor, episodePlan, episodeSequence, type StudioEpisode, type StudioLayers } from "./editor-episode.ts";
import {
  filmstripArgs, Limiter, needsProxy, parseCubeHeader, probeFile, proxyShortSide, readText, runFfmpegLines, runPeaks, thumbArgs, type ProbeInfo,
} from "./editor-media.ts";
import {
  BACKUP_EVERY_MS, bakName, EDIT_EXT, EditorError, exportRange, framesToSeconds, isInside, isServable, MAX_BACKUPS, MEDIA_FILTERS, mediaIdOfUrl,
  mediaKindOf, newProject, safeEditName, sequenceEnd, toDisk, toRuntime, uid, validatePreset, validateProject, VIDEO_EXTS, AUDIO_EXTS, IMAGE_EXTS,
} from "./editor-model.ts";
import { runFfmpeg, type FfmpegInfo } from "./ffmpeg.ts";
import { PRESETS } from "./render-args.ts";
import { mimeOf } from "./gateway.ts";
import { pathKey, safeFileName, safePart, uniquePath } from "./naming.ts";
import { proxyArgs } from "./proxies.ts";
import type { RenderManager } from "./render.ts";
import { UpstreamError, type Upstream } from "./upstream.ts";

export interface EditorDialogs {
  /** A native open dialog; [] when cancelled. */
  openFiles(opts: { title: string; filters: { name: string; extensions: string[] }[]; multi?: boolean; defaultPath?: string }): Promise<string[]>;
  /** additive: a native folder picker; null when cancelled */
  openFolder?(opts: { title: string; defaultPath?: string }): Promise<string | null>;
}

/** What the editor needs from FFmpeg (the default runs the found FFmpeg; tests pass a fake). */
export interface MediaTools {
  probe(file: string): Promise<ProbeInfo>;
  /** Run FFmpeg (args without the binary); rejects on failure. */
  run(args: string[], opts?: { signal?: AbortSignal }): Promise<void>;
  /** Run FFmpeg with every stderr line (and, optionally, stdout bytes) passed on. */
  lines(args: string[], onLine: (l: string) => void, opts?: { signal?: AbortSignal; stdout?: (b: Buffer) => void }): Promise<void>;
  peaks(file: string, seconds: number): Promise<number[]>;
}

export interface EditorDeps {
  libraryRoot(): string;
  userData: string;
  upstream: Upstream;
  /** The synced studio copy of a storage key (Library.resolveKeyOriginal), so an episode import can copy instead of download. */
  localKey?(key: string): string | null;
  ff(): FfmpegInfo | null;
  /** The hardware encoder probe (NVENC proxies). */
  probeHw(): Promise<Record<string, boolean>>;
  dialogs: EditorDialogs;
  renders?: RenderManager;
  tools?: MediaTools;
  log(msg: string): void;
  // ── wave 3 (all optional: tests and older callers leave them out) ──
  /** The local tools (RIFE, whisper.cpp, models). */
  localTools?: ToolManager;
  /** Runs RIFE / whisper (tests pass a fake). */
  proc?: ProcRunner;
  /** Local tool job progress (bridge editor.onJob). */
  onJob?(j: EditorJob): void;
  /** A media item changed in the background: an automatic proxy (bridge editor.onMediaUpdate). */
  onMediaUpdate?(u: { path: string; item: MediaItem }): void;
  /** settings.editorBackups */
  backupSettings?(): { auto: boolean; minutes: number };
  /** whether the app holds a studio session */
  signedIn?(): Promise<boolean>;
  /** the encoder preference (settings.encoder.prefer) */
  prefer?(): "auto" | "nvenc" | "qsv" | "amf" | "software";
  /** the user's LUT folders (settings.lutFolders) */
  lutFolders?(): string[];
  setLutFolders?(list: string[]): void;
}

interface Recent { path: string; opened: string }

const MAX_RECENTS = 20;
/** The impulse responses' recipe in the audio preview cache key (a changed preset renders afresh). */
const IR_SIG = createHash("sha1").update(JSON.stringify(IR_PRESETS)).digest("hex").slice(0, 12);
/** The slow-motion clip's encoder: H.264 at a high constant quality on the fastest hardware (the editor decodes it everywhere). */
const RIFE_ENCODE: PresetDef = { id: "rife", label: "Slow motion", w: 1920, h: 1080, orientation: "project", codec: "h264", container: "mp4", tenBit: false,
  cq: 16, note: "" };
const SHADER_MAX = 256 * 1024;
const LUT_MAX = 64 * 1024 * 1024;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-/ ()]*$/;
const nowIso = () => new Date().toISOString();

async function retry<T>(fn: () => T | Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 4 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
}

export class EditorManager {
  private deps: EditorDeps;
  private recentsFile: string;
  private uploadsFile: string;
  private shadersDir: string;
  /** pathKeys of edit folders and files that may be read and written this session. */
  private dirs = new Set<string>();
  private files = new Set<string>();
  /** /__media ids → absolute files, and back. */
  private reg = new Map<string, string>();
  private byFile = new Map<string, string>();
  /** Media of each open edit as last seen (runtime form), so tools work on items not saved yet. */
  private known = new Map<string, Map<string, MediaItem>>();
  /** Proxies made this session ({media id: file}): kept on save even when the page's copy hasn't caught up. */
  private proxies = new Map<string, string>();
  private writes = new Map<string, Promise<unknown>>();
  private limiter = new Limiter(3);
  /** automatic proxies, one at a time in the background */
  private proxyLimiter = new Limiter(1);
  private proxyQueued = new Set<string>();
  readonly jobs: LocalJobs;
  /** open edits (pathKey → last activity, ms) for automatic backups; their last backup */
  private active = new Map<string, { file: string; at: number }>();
  private backups = new Map<string, { lastAt?: number; lastError?: string; hash?: string }>();
  private backupTimer: NodeJS.Timeout | null = null;
  private irsReady: Promise<string> | null = null;

  constructor(deps: EditorDeps) {
    this.deps = deps;
    this.recentsFile = path.join(deps.userData, "editor-recent.json");
    this.uploadsFile = path.join(deps.userData, "editor-uploads.json");
    this.shadersDir = path.join(deps.userData, "shaders");
    this.jobs = new LocalJobs({ broadcast: (j) => deps.onJob?.(j), log: deps.log });
  }

  editsRoot(): string {
    return path.join(this.deps.libraryRoot(), "Edits");
  }

  // ── the allow-list and the media registry ──
  /** An edit file handed over by a tatvam://editor link or the menu: it may be opened. */
  allowEditFile(file: string): void {
    if (path.isAbsolute(file) && file.toLowerCase().endsWith(EDIT_EXT)) this.files.add(pathKey(path.resolve(file)));
  }

  private allowDir(dir: string): void {
    this.dirs.add(pathKey(path.resolve(dir)));
  }

  private allowMedia(file: string): void {
    if (path.isAbsolute(file) && isServable(file)) this.files.add(pathKey(path.resolve(file)));
  }

  /** The edit file as an absolute path, if it may be used; throws otherwise. */
  private editFile(file: unknown): { file: string; dir: string } {
    if (typeof file !== "string" || !path.isAbsolute(file)) throw new EditorError("An edit is named by the full path of its .tatvamedit file");
    const abs = path.resolve(file);
    if (!abs.toLowerCase().endsWith(EDIT_EXT)) throw new EditorError("Edits are .tatvamedit files");
    const dir = path.dirname(abs);
    const ok = this.files.has(pathKey(abs)) || this.dirs.has(pathKey(dir)) || isInside(this.editsRoot(), abs)
      || this.recents().some((r) => pathKey(path.resolve(r.path)) === pathKey(abs));
    if (!ok) throw new EditorError("That edit wasn't opened in Tatvam: open it with File → Open edit…");
    return { file: abs, dir };
  }

  /** Register a file for the gateway; the same file keeps its id for the session. */
  register(file: string): string {
    const abs = path.resolve(file);
    const k = pathKey(abs);
    let id = this.byFile.get(k);
    if (!id) {
      id = randomUUID().replace(/-/g, "");
      this.byFile.set(k, id);
      this.reg.set(id, abs);
    }
    return `/__media/${id}/${encodeURIComponent(path.basename(abs))}`;
  }

  /** The file behind a /__media id (the gateway's resolveEditorMedia). */
  resolve(id: string): string | null {
    return this.reg.get(id) ?? null;
  }

  private resolveUrl = (url: string): string | null => {
    const id = mediaIdOfUrl(url);
    return id ? this.reg.get(id) ?? null : null;
  };

  private runtime(project: EditProject, dir: string): EditProject {
    const p = toRuntime(project, dir, { exists: (f) => existsSync(f), register: (f) => this.register(f) });
    this.remember(dir, p.media);
    return p;
  }

  private remember(dir: string, items: MediaItem[]): void {
    const k = pathKey(path.resolve(dir));
    let m = this.known.get(k);
    if (!m) { m = new Map(); this.known.set(k, m); }
    for (const it of items) {
      m.set(it.id, it);
      if (!it.path.startsWith("studio:")) this.allowMedia(path.isAbsolute(it.path) ? it.path : path.join(dir, it.path));
      if (it.proxyPath) this.allowMedia(path.isAbsolute(it.proxyPath) ? it.proxyPath : path.join(dir, it.proxyPath));
    }
  }

  // ── recents ──
  private recents(): Recent[] {
    try {
      const r = JSON.parse(readFileSync(this.recentsFile, "utf8"));
      return Array.isArray(r) ? r.filter((x): x is Recent => typeof x?.path === "string") : [];
    } catch {
      return [];
    }
  }

  private touchRecent(file: string): void {
    const k = pathKey(file);
    const list = [{ path: file, opened: nowIso() }, ...this.recents().filter((r) => pathKey(path.resolve(r.path)) !== k)].slice(0, MAX_RECENTS);
    try { writeFileAtomic(this.recentsFile, JSON.stringify(list, null, 2)); } catch (e) { this.deps.log(`editor-recent.json: ${(e as Error).message}`); }
  }

  // ── files ──
  private async readProject(file: string): Promise<EditProject> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fsp.readFile(file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new EditorError(`${path.basename(file)} wasn't found`);
      throw new EditorError(`${path.basename(file)} can't be read: ${(e as Error).message}`);
    }
    return validateProject(raw);
  }

  /** Rotate `<file>.bak.1..10` (at most once a minute), then write atomically. One write per file at a time. */
  private async writeProject(file: string, disk: EditProject, forceBackup = false): Promise<void> {
    const k = pathKey(file);
    const prev = this.writes.get(k) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      await this.rotateBackups(file, forceBackup);
      await retry(() => writeFileAtomic(file, JSON.stringify(disk)));
    });
    this.writes.set(k, run);
    try { await run; } finally { if (this.writes.get(k) === run) this.writes.delete(k); }
  }

  private async rotateBackups(file: string, force = false): Promise<void> {
    if (!existsSync(file)) return;
    const b1 = bakName(file, 1);
    let last = 0;
    try { last = (await fsp.stat(b1)).mtimeMs; } catch { last = 0; }
    if (!force && Date.now() - last < BACKUP_EVERY_MS) return;
    for (let n = MAX_BACKUPS - 1; n >= 1; n--) {
      const from = bakName(file, n);
      if (existsSync(from)) await retry(() => fsp.rename(from, bakName(file, n + 1)));
    }
    await retry(() => fsp.copyFile(file, b1));
    const t = new Date();
    await fsp.utimes(b1, t, t); // copyFile keeps the old mtime on Windows: the age of a backup is when it was made
  }

  // ── list / create / open / save ──
  async list(): Promise<EditListEntry[]> {
    const seen = new Set<string>();
    const out: EditListEntry[] = [];
    const add = async (file: string, recent: boolean) => {
      const k = pathKey(path.resolve(file));
      if (seen.has(k) || !existsSync(file)) return;
      seen.add(k);
      try {
        const p = JSON.parse(await fsp.readFile(file, "utf8")) as Partial<EditProject>;
        if (p.format !== "tatvam-edit") return;
        const dir = path.dirname(file);
        const t = (p.media ?? []).find((m) => m.thumb && !m.thumb.startsWith("/__media/"))?.thumb;
        const tf = t ? (path.isAbsolute(t) ? t : path.join(dir, t)) : "";
        out.push({ path: path.resolve(file), name: p.name || path.basename(file, EDIT_EXT), modified: p.modified || statSync(file).mtime.toISOString(),
          ...(tf && existsSync(tf) && isInside(dir, tf) ? { thumb: this.register(tf) } : {}), recent });
      } catch (e) {
        this.deps.log(`editor list ${file}: ${(e as Error).message}`);
      }
    };
    for (const r of this.recents()) await add(r.path, true);
    const root = this.editsRoot();
    let dirs: string[] = [];
    try { dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { dirs = []; }
    const lib: EditListEntry[] = [];
    const before = out.length;
    for (const d of dirs) {
      let names: string[] = [];
      try { names = await fsp.readdir(path.join(root, d)); } catch { continue; }
      for (const n of names) if (n.toLowerCase().endsWith(EDIT_EXT)) await add(path.join(root, d, n), false);
    }
    lib.push(...out.splice(before).sort((a, b) => b.modified.localeCompare(a.modified)));
    return [...out, ...lib];
  }

  async create(name: string, preset: EditPreset): Promise<{ path: string; project: EditProject }> {
    const pr = validatePreset(preset);
    const safe = safeEditName(name);
    const dir = path.join(this.editsRoot(), safe);
    const file = path.join(dir, `${safe}${EDIT_EXT}`);
    if (existsSync(dir) && (await fsp.readdir(dir)).length) throw new EditorError(`An edit called "${safe}" already exists in ${this.editsRoot()}`);
    for (const sub of ["Media", "Cache", "Renders"]) await fsp.mkdir(path.join(dir, sub), { recursive: true });
    const project = newProject(String(name).trim() || safe, pr);
    await this.writeProject(file, project);
    this.allowDir(dir);
    this.files.add(pathKey(file));
    this.touchRecent(file);
    this.touch(file);
    return { path: file, project: this.runtime(project, dir) };
  }

  async open(file?: string): Promise<{ path: string; project: EditProject } | null> {
    let target: { file: string; dir: string };
    if (!file) {
      const picked = await this.deps.dialogs.openFiles({ title: "Open edit", filters: [{ name: "Tatvam edits", extensions: ["tatvamedit"] }],
        defaultPath: existsSync(this.editsRoot()) ? this.editsRoot() : undefined });
      if (!picked[0]) return null;
      this.allowEditFile(picked[0]);
      target = this.editFile(picked[0]);
    } else {
      target = this.editFile(file);
    }
    const project = await this.readProject(target.file);
    this.allowDir(target.dir);
    this.touchRecent(target.file);
    this.touch(target.file);
    const runtime = this.runtime(project, target.dir);
    if (project.settings.proxy !== "off") this.queueProxies(target.file, target.dir, runtime.media, project.settings.proxy);
    return { path: target.file, project: runtime };
  }

  async save(file: string, project: EditProject): Promise<{ modified: string }> {
    const { file: abs, dir } = this.editFile(file);
    if (!existsSync(abs) && !this.dirs.has(pathKey(dir))) throw new EditorError("That edit isn't open");
    const p = validateProject(structuredClone(project));
    for (const m of p.media) { // a proxy made since the page last loaded this item
      const px = this.proxies.get(m.id);
      if (!m.proxyPath && px && existsSync(px)) m.proxyPath = px;
    }
    const disk = toDisk(p, dir, this.resolveUrl);
    disk.modified = nowIso();
    await this.writeProject(abs, disk);
    this.allowDir(dir);
    this.remember(dir, p.media.filter((m) => !m.path.startsWith("studio:") && path.isAbsolute(m.path) && mediaKindOf(m.path)));
    this.touch(abs);
    return { modified: disk.modified };
  }

  // ── media ──
  private tools(): MediaTools {
    if (this.deps.tools) return this.deps.tools;
    const ffi = this.deps.ff();
    if (!ffi) throw new EditorError("FFmpeg wasn't found: set its path in File → Studio server…");
    const ff = ffi.path;
    return {
      probe: (f) => probeFile(ff, f),
      run: async (args, o) => { await runFfmpeg(ff, args, { signal: o?.signal }); },
      lines: (args, onLine, o) => runFfmpegLines(ff, args, onLine, o),
      peaks: (f, s) => runPeaks(ff, f, s),
    };
  }

  /** Probe a file, copy it into Media\ when asked, make its cache files, and return the runtime item. */
  private async ingest(dir: string, src: string, o: { copy: boolean; id?: string; name?: string; studioKey?: string; keep?: Partial<MediaItem> }): Promise<MediaItem> {
    const tools = this.tools();
    const id = o.id ?? randomUUID();
    const info = await this.limiter.run(() => tools.probe(src));
    let file = src;
    const mediaDir = path.join(dir, "Media");
    if (o.copy && !isInside(mediaDir, src)) {
      await fsp.mkdir(mediaDir, { recursive: true });
      const taken = new Set((await fsp.readdir(mediaDir)).map((n) => pathKey(path.join(mediaDir, n))));
      file = uniquePath(path.join(mediaDir, path.basename(src)), taken);
      await retry(() => fsp.copyFile(src, file));
    }
    const cache = path.join(dir, "Cache", id);
    await fsp.mkdir(cache, { recursive: true });
    const picture = info.hasVideo && info.kind !== "audio";
    const thumb = path.join(cache, "thumb.jpg");
    const strip = path.join(cache, "filmstrip.jpg");
    let peaks: number[] | undefined;
    const tasks: Promise<unknown>[] = [];
    const soft = (what: string, p: Promise<unknown>) => p.catch((e) => this.deps.log(`editor ${what} ${path.basename(src)}: ${(e as Error).message}`));
    if (picture) tasks.push(soft("thumbnail", this.limiter.run(() => tools.run(thumbArgs(file, thumb, info)))));
    if (picture && info.kind === "video" && info.duration > 0.2) tasks.push(soft("filmstrip", this.limiter.run(() => tools.run(filmstripArgs(file, strip, info.duration)))));
    if (info.hasAudio && info.duration > 0) {
      tasks.push(soft("peaks", this.limiter.run(async () => {
        peaks = await tools.peaks(file, info.duration);
        await fsp.writeFile(path.join(cache, "peaks.json"), JSON.stringify(peaks));
      })));
    }
    await Promise.all(tasks);
    const sr = info.sampleRate || 48000;
    const item: MediaItem = {
      id, binId: null, name: o.name ?? path.basename(src), kind: info.kind, path: file, markers: [],
      ...(o.keep ?? {}),
      duration: info.kind === "image" ? 0 : info.kind === "audio" ? Math.round(info.duration * sr) : Math.round(info.duration * info.fps),
      fps: info.kind === "audio" ? sr : info.kind === "image" ? 0 : info.fps,
      width: info.width, height: info.height, hasAudio: info.hasAudio, seconds: Math.round(info.duration * 1000) / 1000,
      url: this.register(file), missing: false,
    };
    if (info.channels) item.audioChannels = info.channels;
    if (info.sampleRate) item.sampleRate = info.sampleRate;
    if (info.codec) item.codec = info.codec;
    if (info.bits) item.bitDepth = info.bits;
    if (existsSync(thumb)) item.thumb = this.register(thumb); else delete item.thumb;
    if (existsSync(strip)) item.filmstrip = this.register(strip); else delete item.filmstrip;
    if (peaks) item.peaks = peaks; else delete item.peaks;
    if (o.studioKey) item.studioKey = o.studioKey;
    delete item.proxyPath;
    delete item.proxyUrl;
    this.remember(dir, [item]);
    return item;
  }


  async importMedia(file: string, files?: string[]): Promise<MediaItem[]> {
    const { file: abs, dir } = this.editFile(file);
    let list = Array.isArray(files) ? files.filter((f) => typeof f === "string" && f) : [];
    if (!list.length) list = await this.deps.dialogs.openFiles({ title: "Import media", filters: MEDIA_FILTERS, multi: true });
    if (!list.length) return [];
    const bad: string[] = [];
    const good: string[] = [];
    for (const f of list) {
      const p = path.resolve(f);
      if (!path.isAbsolute(f)) bad.push(`${f}: not a full path`);
      else if (!mediaKindOf(p)) bad.push(`${path.basename(p)}: not a video, audio or image file the editor imports`);
      else {
        try {
          if (!(await fsp.stat(p)).isFile()) bad.push(`${path.basename(p)}: not a file`);
          else good.push(p);
        } catch { bad.push(`${path.basename(p)}: not found`); }
      }
    }
    let settings: EditProject["settings"] | null = null;
    try { settings = (await this.readProject(abs)).settings; } catch { settings = null; }
    const copy = Boolean(settings?.copyMedia);
    const items: (MediaItem | null)[] = good.map(() => null);
    await pool(good, 3, async (p, i) => {
      try {
        items[i] = await this.ingest(dir, p, { copy });
      } catch (e) {
        bad.push(`${path.basename(p)}: ${(e as Error).message}`);
      }
    });
    const done = items.filter((x): x is MediaItem => x !== null);
    if (bad.length) this.deps.log(`editor import: ${bad.join("; ")}`);
    if (!done.length && bad.length) throw new EditorError(bad.slice(0, 5).join("\n"));
    if (settings && settings.proxy !== "off") this.queueProxies(abs, dir, done, settings.proxy);
    return done;
  }

  async mediaUrl(file: string, media: string): Promise<string> {
    const { dir } = this.editFile(file);
    if (typeof media !== "string" || !path.isAbsolute(media)) throw new EditorError("A media file is named by its full path");
    const abs = path.resolve(media);
    if (!isServable(abs)) throw new EditorError(`${path.basename(abs)} isn't a media file`);
    if (!isInside(dir, abs) && !this.files.has(pathKey(abs))) throw new EditorError(`${path.basename(abs)} isn't part of this edit: import it first`);
    if (!existsSync(abs)) throw new EditorError(`${path.basename(abs)} wasn't found`);
    return this.register(abs);
  }

  /** A media item of an edit: as last seen this session, else from the saved file. */
  private async item(file: string, dir: string, mediaId: string): Promise<MediaItem> {
    const m = this.known.get(pathKey(dir))?.get(String(mediaId));
    if (m) return m;
    const p = this.runtime(await this.readProject(file), dir);
    const it = p.media.find((x) => x.id === mediaId);
    if (!it) throw new EditorError("That media item isn't in this edit");
    return it;
  }

  private async existingFile(it: MediaItem): Promise<string> {
    if (it.path.startsWith("studio:") || !existsSync(it.path)) throw new EditorError(`${it.name} is missing: relink it first`);
    return it.path;
  }

  /** The folder of an edit opened in Tatvam (the same allow-list check as every editor call; throws otherwise). */
  editDir(file: string): string {
    return this.editFile(file).dir;
  }

  /** Imports a file that already sits inside the edit folder (no copy into Media\): probe, peaks, gateway registry. */
  ingestInPlace(dir: string, src: string, name: string): Promise<MediaItem> {
    return this.ingest(dir, src, { copy: false, name });
  }

  /** additive (audio-tools2, editor-audiotools.ts): an edit's media item, its file on this PC and FFmpeg to read it. */
  async mediaFile(file: string, mediaId: string): Promise<{ item: MediaItem; src: string; dir: string; tools: MediaTools }> {
    const { dir } = this.editFile(file);
    const item = await this.item(file, dir, mediaId);
    return { item, src: await this.existingFile(item), dir, tools: this.tools() };
  }

  async relink(file: string, mediaId: string): Promise<MediaItem | null> {
    const { dir } = this.editFile(file);
    const it = await this.item(file, dir, mediaId);
    const exts = it.kind === "video" ? VIDEO_EXTS : it.kind === "audio" ? AUDIO_EXTS : IMAGE_EXTS;
    const prev = it.path.startsWith("studio:") ? "" : path.dirname(it.path);
    const picked = await this.deps.dialogs.openFiles({ title: `Relink ${it.name}`, filters: [{ name: it.kind[0].toUpperCase() + it.kind.slice(1), extensions: exts }, MEDIA_FILTERS[0]],
      defaultPath: prev && existsSync(prev) ? prev : undefined });
    if (!picked[0]) return null;
    const src = path.resolve(picked[0]);
    if (!mediaKindOf(src)) throw new EditorError(`${path.basename(src)} isn't a media file the editor imports`);
    const { binId, markers, inPoint, outPoint, colorLabel, comment, studioKey } = it;
    const keep: Partial<MediaItem> = { binId, markers, inPoint, outPoint, colorLabel, comment };
    for (const k of Object.keys(keep) as (keyof MediaItem)[]) if (keep[k] === undefined) delete keep[k];
    this.proxies.delete(it.id);
    return this.ingest(dir, src, { copy: false, id: it.id, name: it.name, studioKey, keep });
  }

  async proxy(file: string, mediaId: string, shortSide?: number): Promise<MediaItem> {
    const { file: abs, dir } = this.editFile(file);
    const it = await this.item(file, dir, mediaId);
    if (it.kind !== "video") throw new EditorError("Only video clips get proxies");
    const src = await this.existingFile(it);
    const short = shortSide ?? proxyShortSide(it.width || 1920, it.height || 1080);
    const cache = path.join(dir, "Cache", it.id);
    await fsp.mkdir(cache, { recursive: true });
    const out = path.join(cache, `proxy_${short}.mp4`);
    const part = `${out}.part.mp4`;
    const nvenc = Boolean((await this.deps.probeHw().catch(() => ({} as Record<string, boolean>))).h264_nvenc);
    await this.tools().run(proxyArgs(src, part, nvenc, short));
    await fsp.rm(out, { force: true });
    await retry(() => fsp.rename(part, out));
    this.proxies.set(it.id, out);
    const updated: MediaItem = { ...it, proxyPath: out, proxyUrl: this.register(out) };
    this.remember(dir, [updated]);
    try { // the saved file gets it too (the page's next save keeps it: see save())
      const p = await this.readProject(abs);
      const m = p.media.find((x) => x.id === it.id);
      if (m) {
        m.proxyPath = path.relative(dir, out).split(path.sep).join("/");
        await this.writeProject(abs, p);
      }
    } catch (e) {
      this.deps.log(`editor proxy: couldn't note it in ${path.basename(abs)}: ${(e as Error).message}`);
    }
    return updated;
  }

  // ── LUTs and shaders ──
  async importLut(file: string): Promise<LutEntry | null> {
    const { dir } = this.editFile(file);
    const picked = await this.deps.dialogs.openFiles({ title: "Import a LUT", filters: [{ name: "Cube LUTs", extensions: ["cube"] }] });
    if (!picked[0]) return null;
    const src = path.resolve(picked[0]);
    let info;
    try {
      info = parseCubeHeader(await readText(src, LUT_MAX));
    } catch (e) {
      throw new EditorError(`${path.basename(src)}: ${(e as Error).message}`);
    }
    const id = uid("lut");
    const dest = path.join(dir, "Cache", "luts", `${id}.cube`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
    const name = info.title || path.basename(src, path.extname(src));
    return { id, name, path: dest, url: this.register(dest), size: info.size };
  }

  private shaderIndex(): Record<string, string> {
    try { return JSON.parse(readFileSync(path.join(this.shadersDir, "index.json"), "utf8")) as Record<string, string>; } catch { return {}; }
  }

  async importShader(file: string, kind: "transition" | "effect"): Promise<{ id: string; name: string } | null> {
    this.editFile(file);
    if (kind !== "transition" && kind !== "effect") throw new EditorError("A custom shader is a transition or an effect");
    const picked = await this.deps.dialogs.openFiles({ title: kind === "transition" ? "Import a transition (gl-transitions GLSL)" : "Import an effect (GLSL)",
      filters: [{ name: "GLSL", extensions: ["glsl", "frag", "fs"] }] });
    if (!picked[0]) return null;
    const src = path.resolve(picked[0]);
    let glsl: string;
    try { glsl = await readText(src, SHADER_MAX); } catch (e) { throw new EditorError((e as Error).message); }
    if (kind === "transition" && !/\bvec4\s+transition\s*\(/.test(glsl)) {
      throw new EditorError(`${path.basename(src)} isn't a gl-transitions shader: it needs a "vec4 transition(vec2 uv)" function`);
    }
    if (kind === "effect" && !/\b(?:vec[234]|void|float)\s+\w+\s*\([^)]*\)\s*\{/.test(glsl)) {
      throw new EditorError(`${path.basename(src)} has no GLSL function`);
    }
    const dir = path.join(this.shadersDir, kind);
    await fsp.mkdir(dir, { recursive: true });
    const base = (safePart(path.basename(src, path.extname(src))).toLowerCase().replace(/[^a-z0-9_-]/g, "-") || kind).slice(0, 60);
    let id = base;
    for (let n = 2; existsSync(path.join(dir, `${id}.glsl`)); n++) id = `${base}-${n}`;
    await fsp.writeFile(path.join(dir, `${id}.glsl`), glsl, "utf8");
    const named = /^\s*\/\/\s*name\s*:\s*(.+)$/im.exec(glsl)?.[1]?.trim();
    const name = (named || path.basename(src, path.extname(src))).slice(0, 80);
    const index = this.shaderIndex();
    index[`${kind}/${id}`] = name;
    writeFileAtomic(path.join(this.shadersDir, "index.json"), JSON.stringify(index, null, 2));
    return { id, name };
  }

  async shaders(): Promise<ShaderEntry[]> {
    const index = this.shaderIndex();
    const out: ShaderEntry[] = [];
    for (const kind of ["transition", "effect"] as const) {
      let names: string[] = [];
      try { names = await fsp.readdir(path.join(this.shadersDir, kind)); } catch { continue; }
      for (const id of names.filter((x) => x.endsWith(".glsl")).map((x) => x.slice(0, -5)).sort()) {
        const n = `${id}.glsl`;
        try {
          out.push({ id, kind, name: index[`${kind}/${id}`] ?? id, glsl: await fsp.readFile(path.join(this.shadersDir, kind, n), "utf8") });
        } catch { /* vanished */ }
      }
    }
    return out;
  }

  // ── a studio episode as a sequence ──
  async importEpisode(pid: number, eid: number, file: string): Promise<{ sequenceId: string; project: EditProject; warnings: string[] }> {
    const { file: abs, dir } = this.editFile(file);
    const up = this.deps.upstream;
    const proj = await up.json<{ id: number; title: string; aspect?: string; primary_language?: string }>(`/api/projects/${pid}`, { timeoutMs: 30_000 });
    const lang = proj.primary_language || "en";
    const ep = await up.json<StudioEpisode>(`/api/episodes/${eid}?lang=${encodeURIComponent(lang)}`, { timeoutMs: 60_000 });
    if (Number(ep.project_id) !== Number(pid)) throw new EditorError("That episode belongs to another project");
    let layers: StudioLayers | null = null;
    try { layers = await up.json<StudioLayers>(`/api/episodes/${eid}/layers`, { timeoutMs: 30_000 }); } catch (e) {
      if (!(e instanceof UpstreamError && e.status === 404)) throw e;
    }
    const dims = dimsFor(proj.aspect);
    const opts = { lang, primaryLanguage: lang, fps: 24, width: dims.width, height: dims.height, project: proj.title };
    const plan = episodePlan(ep, layers, opts);
    const project = this.runtime(await this.readProject(abs), dir);
    const label = `S${String(ep.season ?? 1).padStart(2, "0")}E${String(ep.number).padStart(2, "0")}`;
    const mediaDir = path.join(dir, "Media", safeFileName(`${label} ${safePart(ep.title || "")}`.trim(), label).slice(0, 80));
    await fsp.mkdir(mediaDir, { recursive: true });
    const byKey = new Map<string, MediaItem>();
    const fresh: MediaItem[] = [];
    const warnings: string[] = [];
    const taken = new Set<string>();
    await pool(plan.needs, 3, async (n) => {
      const have = project.media.find((m) => m.studioKey === n.key && !m.missing);
      if (have) { byKey.set(n.key, have); return; }
      try {
        const dest = uniquePath(path.join(mediaDir, safeFileName(n.name)), taken);
        taken.add(pathKey(dest));
        const local = this.deps.localKey?.(n.key);
        if (!existsSync(dest)) {
          if (local && existsSync(local)) await retry(() => fsp.copyFile(local, dest));
          else await downloadTo(up, `/media/${n.key.split("/").map(encodeURIComponent).join("/")}`, dest);
        }
        const it = await this.ingest(dir, dest, { copy: false, name: n.name, studioKey: n.key });
        byKey.set(n.key, it);
        fresh.push(it);
      } catch (e) {
        warnings.push(`${n.name}: ${(e as Error).message}`);
      }
    });
    const built = episodeSequence(ep, layers, plan, opts, (k) => byKey.get(k));
    for (const it of fresh) it.binId = built.bin.id;
    project.media.push(...fresh.sort((a, b) => a.name.localeCompare(b.name)));
    if (fresh.length) project.bins.push(built.bin);
    project.sequences.push(built.sequence);
    project.activeSequenceId = built.sequence.id;
    const disk = toDisk(project, dir, this.resolveUrl);
    disk.modified = nowIso();
    project.modified = disk.modified;
    await this.writeProject(abs, disk);
    return { sequenceId: built.sequence.id, project, warnings: [...warnings, ...built.warnings] };
  }

  // ── export ──
  async export(file: string, sequenceId: string, opts: EditExportOptions): Promise<string> {
    return (await this.exportBatch(file, sequenceId, [{ ...opts, sequenceId }]))[0];
  }

  /** Several exports queued in one go (one RenderJob each, in order); every item is checked before any is queued. */
  async exportBatch(file: string, sequenceId: string, items: EditBatchItem[]): Promise<string[]> {
    const { file: abs, dir } = this.editFile(file);
    if (!this.deps.renders) throw new EditorError("Exports aren't available here");
    if (!Array.isArray(items) || !items.length) throw new EditorError("Nothing to export");
    if (items.length > 24) throw new EditorError("At most 24 exports in one batch");
    const project = this.runtime(await this.readProject(abs), dir);
    // audio-tools2: the visualisers' spectrum frames go with the job (the render window draws from them, as the preview does)
    await attachSpectra(project, { lines: (a, l, o) => this.tools().lines(a, l, o), read: (n) => this.readSidecar(abs, n), write: (n, j) => this.writeSidecar(abs, n, j),
      log: (m) => this.deps.log(m) });
    const irDir = await this.ensureIrs();
    const planned = items.map((o, i) => {
      const seq = project.sequences.find((s) => s.id === (o?.sequenceId || sequenceId));
      if (!seq) throw new EditorError(`Export ${i + 1}: that sequence isn't in the saved edit: save first`);
      const preset = String(o?.preset ?? "");
      if (!PRESETS.some((p) => p.id === preset)) throw new EditorError(`Export ${i + 1}: unknown preset ${preset}`);
      if (o?.loudness !== undefined && !isLoudnessPreset(o.loudness)) throw new EditorError(`Export ${i + 1}: unknown loudness target ${String(o.loudness)}`);
      const range = exportRange(seq, o?.range === "inout" ? "inout" : "all");
      const name = typeof o?.name === "string" && o.name.trim() ? o.name.trim().slice(0, 100) : undefined;
      return { seq, preset, range, name, o };
    });
    return planned.map(({ seq, preset, range, name, o }) => this.deps.renders!.startEdit({ editPath: abs, editDir: dir, project, sequenceId: seq.id, range,
      preset, upload: Boolean(o?.upload), source: seq.source ?? null, loudness: o?.loudness, ducking: o?.ducking, name,
      irFile: (p: IrPreset) => path.join(irDir, `${p}.wav`) }));
  }

  /**
   * additive (News Room delivery, newsroom/export.ts): the saved edit at runtime (media registered for the render
   * window), its folder and the built-in impulse responses, for a news export.
   */
  async newsEdit(file: string): Promise<{ file: string; dir: string; project: EditProject; irFile(p: IrPreset): string }> {
    const { file: abs, dir } = this.editFile(file);
    const project = this.runtime(await this.readProject(abs), dir);
    const irDir = await this.ensureIrs();
    return { file: abs, dir, project, irFile: (p: IrPreset) => path.join(irDir, `${p}.wav`) };
  }

  // ── local analysis (docs/EDITOR.md §8) ──
  async analyze(file: string, mediaId: string, kind: AnalyzeKind, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
    const { dir } = this.editFile(file);
    const it = await this.item(file, dir, mediaId);
    const src = await this.existingFile(it);
    const tools = this.tools();
    if (kind === "sync") {
      if (typeof opts.against !== "string" || !opts.against) throw new EditorError("Sync needs the other clip (against)");
      if (opts.against === mediaId) throw new EditorError("Pick another clip to sync with");
      const other = await this.item(file, dir, opts.against);
      const src2 = await this.existingFile(other);
      if (!it.hasAudio || !other.hasAudio) throw new EditorError(`${!it.hasAudio ? it.name : other.name} has no sound to sync by`);
      const maxOffset = Number.isFinite(Number(opts.maxOffset)) ? Math.min(SYNC_MAX_OFFSET_S, Math.max(1, Number(opts.maxOffset))) : SYNC_MAX_OFFSET_S;
      const window = Math.min(SYNC_WINDOW_S + maxOffset, Math.max(SYNC_WINDOW_S, maxOffset * 2));
      const decode = async (f: string) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const cap = window * SYNC_RATE * 4;
        await tools.lines(syncDecodeArgs(f, window), () => undefined, { stdout: (b) => { if (size < cap) { chunks.push(b); size += b.length; } } });
        return f32(Buffer.concat(chunks).subarray(0, cap));
      };
      const [a, b] = await Promise.all([decode(src), decode(src2)]);
      try {
        return { kind, ...syncOffset(a, b, SYNC_RATE, maxOffset), against: other.id };
      } catch (e) {
        throw new EditorError((e as Error).message);
      }
    }
    const duration = it.seconds ?? (it.fps > 0 ? it.duration / it.fps : 0);
    const lines: string[] = [];
    const collect = (l: string) => { lines.push(l); };
    if (kind === "silence") {
      if (!it.hasAudio) throw new EditorError(`${it.name} has no sound`);
      const noise = Number.isFinite(Number(opts.noiseDb)) ? Math.min(0, Math.max(-90, Number(opts.noiseDb))) : -35;
      const minMs = Number.isFinite(Number(opts.minMs)) ? Math.min(60_000, Math.max(50, Number(opts.minMs))) : 400;
      await tools.lines(silenceArgs(src, noise, minMs), (l) => { if (l.includes("silence_")) collect(l); });
      return { kind, segments: parseSilence(lines, duration), duration };
    }
    if (kind === "scenes") {
      if (it.kind !== "video") throw new EditorError("Scene detection needs a video clip");
      const th = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold) : 0.3;
      await tools.lines(scenesArgs(src, th), (l) => { if (l.includes("Parsed_showinfo")) collect(l); });
      return { kind, cuts: parseScenes(lines), duration };
    }
    if (kind === "beats") {
      if (!it.hasAudio) throw new EditorError(`${it.name} has no sound`);
      const maxBytes = 20 * 60 * BEAT_RATE * 4;
      const chunks: Buffer[] = [];
      let size = 0;
      await tools.lines(beatsArgs(src), () => undefined, { stdout: (b) => { if (size < maxBytes) { chunks.push(b); size += b.length; } } });
      const buf = Buffer.concat(chunks).subarray(0, Math.min(size, maxBytes) - (Math.min(size, maxBytes) % 4));
      const samples = new Float32Array(buf.length / 4);
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readFloatLE(i * 4);
      const r = detectBeats(samples, BEAT_RATE);
      return { kind, beats: r.beats, bpm: r.bpm, duration };
    }
    if (kind === "loudness") {
      if (!it.hasAudio) throw new EditorError(`${it.name} has no sound`);
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
      const inS = n(opts.in);
      const outS = n(opts.out);
      if (inS !== undefined && outS !== undefined && !(outS > inS)) throw new EditorError("The out point must be after the in point");
      await tools.lines(loudnessArgs(src, inS, outS), (l) => { if (!/\bt:\s*[\d.]+\s+TARGET/.test(l)) collect(l); });
      return { kind, ...parseEbur128(lines) };
    }
    throw new EditorError(`Unknown analysis ${String(kind)}`);
  }

  // ── media to and from the studio for the AI tools (docs/EDITOR.md §8) ──
  async uploadAsset(file: string, mediaId: string, projectId: number): Promise<{ key: string; url: string; duration: number }> {
    const { dir } = this.editFile(file);
    const pid = Number(projectId);
    if (!Number.isInteger(pid) || pid <= 0) throw new EditorError("The studio project id must be a whole number");
    const it = await this.item(file, dir, mediaId);
    const src = await this.existingFile(it);
    const st = await fsp.stat(src);
    const cacheKey = `${pid}|${pathKey(src)}|${st.size}|${Math.floor(st.mtimeMs)}`;
    let cache: Record<string, { key: string; url: string; duration: number }> = {};
    try { cache = JSON.parse(readFileSync(this.uploadsFile, "utf8")); } catch { cache = {}; }
    if (cache[cacheKey]?.key) return cache[cacheKey];
    const form = new FormData();
    form.append("file", await openAsBlob(src, { type: mimeOf(src) }), path.basename(src));
    const r = await this.deps.upstream.fetch(`/api/edits/${pid}/assets`, { method: "POST", body: form });
    const text = await r.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { detail: text.slice(0, 300) }; }
    if (!r.ok) throw new UpstreamError(r.status, body.detail ?? body, `Upload to the studio failed: HTTP ${r.status} ${typeof body.detail === "string" ? body.detail : ""}`.trim());
    const key = String(body.key ?? "");
    if (!key) throw new EditorError("The studio didn't say where it stored the file");
    const res = { key, url: String(body.url ?? `/media/${key}`), duration: Number(body.duration ?? body.duration_s ?? it.seconds ?? 0) || 0 };
    cache[cacheKey] = res;
    const entries = Object.entries(cache);
    if (entries.length > 2000) cache = Object.fromEntries(entries.slice(-2000));
    try { writeFileAtomic(this.uploadsFile, JSON.stringify(cache)); } catch (e) { this.deps.log(`editor-uploads.json: ${(e as Error).message}`); }
    return res;
  }

  async importStudioAsset(file: string, key: string, name?: string): Promise<MediaItem> {
    const { dir } = this.editFile(file);
    const k = String(key ?? "").replace(/^\/?media\//, "");
    if (!KEY_RE.test(k) || k.includes("..") || k.length > 500) throw new EditorError("That isn't a studio storage key");
    const base = path.basename(k);
    const ext = path.extname(base);
    let fname = safeFileName(String(name || base).trim() || base);
    if (ext && !fname.toLowerCase().endsWith(ext.toLowerCase())) fname += ext;
    if (!mediaKindOf(fname)) throw new EditorError(`${fname} isn't a video, audio or image file`);
    const mediaDir = path.join(dir, "Media");
    await fsp.mkdir(mediaDir, { recursive: true });
    const taken = new Set((await fsp.readdir(mediaDir)).map((n) => pathKey(path.join(mediaDir, n))));
    const dest = uniquePath(path.join(mediaDir, fname), taken);
    await downloadTo(this.deps.upstream, `/media/${k.split("/").map(encodeURIComponent).join("/")}`, dest);
    return this.ingest(dir, dest, { copy: false, name: path.basename(dest), studioKey: k });
  }

  // ── automatic proxies (project setting proxy "auto" / "always") ──
  private queueProxies(file: string, dir: string, items: MediaItem[], mode: "auto" | "always"): void {
    for (const it of items) {
      if (it.kind !== "video" || it.missing || it.path.startsWith("studio:")) continue;
      if (it.proxyPath && existsSync(it.proxyPath)) continue;
      const want = mode === "always" || needsProxy({ kind: "video", width: it.width, height: it.height, codec: it.codec, bits: it.bitDepth });
      if (!want) continue;
      const k = `${pathKey(file)}|${it.id}`;
      if (this.proxyQueued.has(k)) continue;
      this.proxyQueued.add(k);
      void this.proxyLimiter.run(async () => {
        try {
          const updated = await this.proxy(file, it.id, 1080);
          this.deps.onMediaUpdate?.({ path: file, item: updated });
        } catch (e) {
          this.deps.log(`editor auto proxy ${it.name}: ${(e as Error).message}`);
        } finally {
          this.proxyQueued.delete(k);
        }
      });
    }
  }

  // ── RIFE slow motion (docs/EDITOR.md §10) ──
  private runner(): ProcRunner { return this.deps.proc ?? runProc; }

  private speedFile(): string { return path.join(this.deps.userData, "rife-speed.json"); }

  /** Output megapixels a second RIFE managed here (a running average), or a GTX 1660 Ti-class starting guess. */
  private rifeMpps(): number {
    try { const v = Number(JSON.parse(readFileSync(this.speedFile(), "utf8")).mpps); return v > 0 ? v : 20; } catch { return 20; }
  }

  private learnRife(frames: number, w: number, h: number, secs: number): void {
    if (secs <= 0 || frames < 8) return;
    const mpps = (frames * w * h) / 1e6 / secs;
    const prev = this.rifeMpps();
    const exists = existsSync(this.speedFile());
    try { writeFileAtomic(this.speedFile(), JSON.stringify({ mpps: Math.round((exists ? prev * 0.6 + mpps * 0.4 : mpps) * 100) / 100 })); } catch { /* not important */ }
  }

  async interpolate(file: string, mediaId: string, opts: InterpolateOptions = {}): Promise<MediaItem> {
    const { dir } = this.editFile(file);
    const it = await this.item(file, dir, mediaId);
    if (it.kind !== "video") throw new EditorError("Slow motion needs a video clip");
    const src = await this.existingFile(it);
    const lt = this.deps.localTools;
    const exe = lt?.pathOf("rife");
    if (!lt || !exe) throw new EditorError("Install RIFE first (Tools → RIFE slow motion)");
    const model = opts.model ?? "rife-v4.6";
    if (!RIFE_MODELS.includes(model)) throw new EditorError(`Unknown RIFE model ${String(model)}`);
    const seconds = it.seconds ?? (it.fps > 0 ? it.duration / it.fps : 0);
    const inS = Math.max(0, Number(opts.in) || 0);
    const outS = opts.out !== undefined && Number(opts.out) > inS ? Math.min(Number(opts.out), seconds || Number(opts.out)) : seconds || undefined;
    if (outS !== undefined && !(outS > inS)) throw new EditorError("The in point is after the out point");
    const est = Math.max(2, Math.round(((outS ?? inS + 1) - inS) * (it.fps || 24)));
    try { interpPlan(it.fps || 24, est, opts); } catch (e) { throw new EditorError((e as Error).message); } // check the options before queueing
    const tools = this.tools();
    const run = this.runner();
    const { result } = this.jobs.run({ kind: "interpolate", editPath: file, mediaId, name: it.name, id: opts.jobId }, "gpu", async (job, c) => {
      const release = lt.use("rife");
      const work = path.join(dir, "Cache", `rife-${job.id.slice(0, 8)}`);
      const inDir = path.join(work, "in");
      const outDir = path.join(work, "out");
      try {
        // 1. room for the frames
        const need = interpDiskBytes(it.width || 1920, it.height || 1080, est, Math.round(est * (opts.factor ?? 2)));
        await fsp.mkdir(inDir, { recursive: true });
        await fsp.mkdir(outDir, { recursive: true });
        try {
          const st = await fsp.statfs(work);
          const free = Number(st.bavail) * Number(st.bsize);
          if (free < need) throw new EditorError(`Slow motion needs about ${Math.ceil(need / 1e9)} GB free on that drive (${Math.floor(free / 1e9)} GB left)`);
        } catch (e) { if (e instanceof EditorError) throw e; }
        // 2. frames out (RGB from the clip's own matrix)
        c.update({ status: "extracting", step: "Reading frames", progress: 0.02 }, true);
        const mx = readMatrix(await this.formatOf(src), it.height || 1080);
        await tools.run(rifeExtractArgs(src, inDir, { in: inS, out: outS, matrix: mx.matrix, range: mx.range }), { signal: c.signal });
        if (c.signal.aborted) throw new Error("cancelled");
        const inFrames = (await fsp.readdir(inDir)).filter((n) => n.endsWith(".png")).length;
        if (inFrames < 2) throw new EditorError("The clip has fewer than two frames there");
        const plan = interpPlan(it.fps || 24, inFrames, opts);
        // 3. RIFE on the dedicated card
        const gpu = pickGpu(await lt.vulkanGpus("rife"));
        const w = it.width || 1920;
        const h = it.height || 1080;
        const guess = Math.round((plan.outFrames * w * h) / 1e6 / this.rifeMpps());
        c.update({ status: "processing", step: `Making ${plan.outFrames} frames on the graphics card`, progress: 0.06, frames: plan.outFrames, framesDone: 0,
          device: gpu?.name ?? "Vulkan", eta_s: guess }, true);
        const t1 = Date.now();
        let done = 0;
        await run(exe, rifeArgs({ inDir, outDir, modelDir: path.join(path.dirname(exe), plan.model), outFrames: plan.outFrames, gpu: gpu?.index ?? 0,
          uhd: Math.min(w, h) > 1080, v4: isV4(plan.model) }), {
          cwd: path.dirname(exe), signal: c.signal,
          onLine: (l) => {
            if (!isRifeFrameLine(l)) return;
            done++;
            const secs = (Date.now() - t1) / 1000;
            c.update({ framesDone: done, speed: secs > 0 ? Math.round((done / secs) * 100) / 100 : undefined, eta_s: etaFrom(secs, done, plan.outFrames),
              progress: Math.round((0.06 + 0.84 * (done / plan.outFrames)) * 1000) / 1000, step: `Frame ${done} of ${plan.outFrames}` });
          },
        });
        if (c.signal.aborted) throw new Error("cancelled");
        const made = (await fsp.readdir(outDir)).filter((n) => n.endsWith(".jpg")).length;
        if (made !== plan.outFrames) throw new EditorError(`RIFE made ${made} of ${plan.outFrames} frames`);
        const rifeSecs = (Date.now() - t1) / 1000;
        this.learnRife(plan.outFrames, w, h, rifeSecs);
        c.update({ framesDone: made, speed: Math.round((made / Math.max(rifeSecs, 0.001)) * 100) / 100 }, true);
        // 4. back into a clip (H.264 on the hardware encoder, BT.709), the sound stretched or dropped
        c.update({ status: "encoding", step: "Encoding the new clip", progress: 0.91, eta_s: undefined }, true);
        const probe = await this.deps.probeHw().catch(() => ({} as Record<string, boolean>));
        const enc = finalEncoder(RIFE_ENCODE, probe, this.deps.prefer?.() ?? "auto", false)!;
        const mediaDir = path.join(dir, "Media");
        await fsp.mkdir(mediaDir, { recursive: true });
        const taken = new Set((await fsp.readdir(mediaDir)).map((n) => pathKey(path.join(mediaDir, n))));
        const outFile = uniquePath(path.join(mediaDir, safeFileName(interpName(it.name, plan), "slowmo.mp4")), taken);
        const [fn, fd] = plan.fpsArg.split("/").map(Number);
        const part = `${outFile}.part.mp4`;
        await tools.run(rifeEncodeArgs({ framesDir: outDir, fpsArg: plan.fpsArg, fps: fn / (fd || 1), frames: plan.outFrames, source: src, in: inS, out: outS,
          stretch: plan.stretch, audio: opts.dropAudio ? "drop" : "stretch", hasAudio: it.hasAudio, outFile: part, enc: enc.args, w, h }), { signal: c.signal });
        await retry(() => fsp.rename(part, outFile));
        // 5. into the edit
        c.update({ status: "importing", step: "Adding it to the project", progress: 0.97 }, true);
        const item = await this.ingest(dir, outFile, { copy: false, name: path.basename(outFile), keep: { binId: it.binId } });
        c.update({ resultMediaId: item.id }, true);
        return item;
      } finally {
        release();
        await fsp.rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      }
    });
    return result;
  }

  /** The video stream's colour tags (for the RGB extract). */
  private async formatOf(src: string): Promise<{ matrix: string | null; range: "tv" | "pc" | null }> {
    try {
      const info = await this.tools().probe(src);
      return { matrix: info.matrix ?? null, range: info.range ?? null };
    } catch {
      return { matrix: null, range: null };
    }
  }

  // ── local Whisper (docs/EDITOR.md §10) ──
  async transcribeLocal(file: string, mediaId: string, opts: TranscribeOptions): Promise<LocalTranscript> {
    const { dir } = this.editFile(file);
    const it = await this.item(file, dir, mediaId);
    if (!it.hasAudio) throw new EditorError(`${it.name} has no sound`);
    const src = await this.existingFile(it);
    const lt = this.deps.localTools;
    if (!lt) throw new EditorError("Local transcription isn't available here");
    let language: string;
    try { language = checkLanguage(opts?.language); } catch (e) { throw new EditorError((e as Error).message); }
    const modelName = opts?.model === "large-v3-turbo-q5" ? "large-v3-turbo-q5" : opts?.model === "base" ? "base" : null;
    if (!modelName) throw new EditorError("The model is base or large-v3-turbo-q5");
    const model = lt.pathOf(WHISPER_MODELS[modelName]);
    if (!model) throw new EditorError(`Install the Whisper ${modelName} model first (Tools)`);
    const cpuExe = lt.pathOf("whisper");
    const cudaExe = lt.pathOf("whisper-cuda");
    const warnings: string[] = [];
    let useCuda = false;
    if (opts?.cuda !== false) {
      // CUDA when the 12.4 build is installed, an NVIDIA card is there with driver ≥ 551.61 and the runtime DLLs are found
      const ready = await lt.cudaReady();
      if (ready.ok) useCuda = true;
      else if (opts?.cuda === true || cudaExe) warnings.push(`${ready.reason ?? "CUDA isn't available"}, so it ran on the processor`);
    }
    const exe = useCuda ? cudaExe! : cpuExe;
    if (!exe) throw new EditorError("Install whisper.cpp first (Tools)");
    const seconds = it.seconds ?? (it.fps > 0 ? it.duration / it.fps : 0);
    const inS = Math.max(0, Number(opts?.in) || 0);
    const outS = opts?.out !== undefined && Number(opts.out) > inS ? Math.min(Number(opts.out), seconds || Number(opts.out)) : undefined;
    const length = (outS ?? seconds) - inS;
    if (!(length > 0.05)) throw new EditorError("There's no sound in that range");
    const tools = this.tools();
    const run = this.runner();
    const lane = exe === cudaExe && useCuda ? "gpu" : "cpu";
    const { result } = this.jobs.run({ kind: "transcribe", editPath: file, mediaId, name: it.name, id: opts?.jobId }, lane, async (job, c) => {
      const toolId = exe === cudaExe ? "whisper-cuda" : "whisper";
      const release = lt.use(toolId);
      const releaseModel = lt.use(WHISPER_MODELS[modelName]);
      const work = await fsp.mkdtemp(path.join(os.tmpdir(), "tatvam-whisper-"));
      try {
        c.update({ status: "extracting", step: "Reading the sound", progress: 0.02, device: useCuda ? "CUDA" : "CPU" }, true);
        const wav = path.join(work, "audio.wav");
        await tools.run(wavArgs(src, wav, inS, outS), { signal: c.signal });
        c.update({ status: "processing", step: `Transcribing on the ${useCuda ? "graphics card" : "processor"}`, progress: 0.05 }, true);
        const t1 = Date.now();
        let log = "";
        const env = { ...process.env };
        if (useCuda) env.PATH = [...lt.cudaDirs(), env.PATH ?? ""].join(path.delimiter);
        await run(exe, whisperArgs({ model, wav, outBase: path.join(work, "out"), language, threads: whisperThreads(os.cpus().length), gpu: useCuda,
          translate: Boolean(opts?.translate), prompt: typeof opts?.prompt === "string" ? opts.prompt : undefined }), {
          cwd: path.dirname(exe), signal: c.signal, env,
          onLine: (l) => {
            if (log.length < 20000) log += `${l}\n`;
            const p = parseWhisperProgress(l);
            if (p === null) return;
            const secs = (Date.now() - t1) / 1000;
            c.update({ progress: Math.round((0.05 + 0.92 * p) * 1000) / 1000, step: `Transcribing: ${Math.round(p * 100)}%`,
              speed: secs > 0 && p > 0 ? Math.round(((p * length) / secs) * 10) / 10 : undefined, eta_s: p > 0.02 ? Math.round((secs / p) * (1 - p)) : undefined });
          },
        });
        if (c.signal.aborted) throw new Error("cancelled");
        const procSecs = (Date.now() - t1) / 1000;
        const device: "cuda" | "cpu" = useCuda && !noGpuInLog(log) ? "cuda" : "cpu";
        if (useCuda && device === "cpu") warnings.push("The CUDA build couldn't use the graphics card, so it ran on the processor");
        const json = await fsp.readFile(path.join(work, "out.json"), "latin1");
        const parsed = parseWhisperJson(json, inS);
        c.update({ device: device === "cuda" ? "CUDA" : "CPU", speed: Math.round((length / Math.max(procSecs, 0.001)) * 10) / 10 }, true);
        return { language: parsed.language || (language === "auto" ? "" : language), segments: parsed.segments, model: modelName, device,
          seconds: Math.round(procSecs * 100) / 100, duration: Math.round(length * 1000) / 1000, rtf: Math.round((procSecs / length) * 1000) / 1000,
          ...(warnings.length ? { warnings } : {}) };
      } finally {
        release();
        releaseModel();
        await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    });
    return result;
  }

  jobList(): EditorJob[] { return this.jobs.list(); }

  cancelJob(id: string): void { this.jobs.cancel(String(id)); }

  // ── versions and backups (docs/EDITOR.md §10) ──
  private static summary(p: EditProject): EditVersion["summary"] {
    const seq = p.sequences.find((s) => s.id === p.activeSequenceId) ?? p.sequences[0];
    return { name: p.name, modified: p.modified, sequences: p.sequences.length, clips: p.sequences.reduce((n, s) => n + s.clips.length, 0),
      media: p.media.length, duration: seq ? Math.round(framesToSeconds(sequenceEnd(seq), seq.fps) * 100) / 100 : 0 };
  }

  async versions(file: string): Promise<EditVersion[]> {
    const { file: abs } = this.editFile(file);
    const out: EditVersion[] = [];
    for (let n = 1; n <= MAX_BACKUPS; n++) {
      const b = bakName(abs, n);
      let buf: Buffer;
      let st: import("node:fs").Stats;
      try { [buf, st] = await Promise.all([fsp.readFile(b), fsp.stat(b)]); } catch { continue; }
      let summary: EditVersion["summary"];
      try { summary = EditorManager.summary(validateProject(JSON.parse(buf.toString("utf8")))); } catch { continue; }
      out.push({ id: createHash("sha1").update(buf).digest("hex").slice(0, 16), file: path.basename(b), time: st.mtime.toISOString(), size: st.size, summary });
    }
    return out.sort((a, b) => b.time.localeCompare(a.time));
  }

  async restoreVersion(file: string, id: string): Promise<{ path: string; project: EditProject; backup: string }> {
    const { file: abs, dir } = this.editFile(file);
    const want = String(id ?? "");
    let content: string | null = null;
    for (let n = 1; n <= MAX_BACKUPS && content === null; n++) {
      try {
        const buf = await fsp.readFile(bakName(abs, n));
        if (createHash("sha1").update(buf).digest("hex").slice(0, 16) === want) content = buf.toString("utf8");
      } catch { /* not there */ }
    }
    if (content === null) throw new EditorError("That version isn't there any more: open the list again");
    const project = validateProject(JSON.parse(content));
    project.modified = nowIso();
    await this.writeProject(abs, project, true); // the current file becomes .bak.1 first, whatever its age
    this.touch(abs);
    return { path: abs, project: this.runtime(project, dir), backup: path.basename(bakName(abs, 1)) };
  }

  async backupNow(file: string, projectId?: number): Promise<EditBackupResult> {
    const { file: abs } = this.editFile(file);
    const buf = await fsp.readFile(abs);
    let pid = Number(projectId);
    if (projectId === undefined || projectId === null) {
      try { pid = Number(validateProject(JSON.parse(buf.toString("utf8"))).studioProjectId); } catch { pid = NaN; }
      if (!(pid > 0)) throw new EditorError("This edit has no studio project yet: it gets one on the first AI use");
    }
    if (!Number.isInteger(pid) || pid <= 0) throw new EditorError("The studio project id must be a whole number");
    const form = new FormData();
    form.append("file", new Blob([buf], { type: "application/json" }), path.basename(abs));
    const k = pathKey(abs);
    const rec = this.backups.get(k) ?? {};
    try {
      const r = await this.deps.upstream.fetch(`/api/edits/${pid}/backups`, { method: "POST", body: form, timeoutMs: 120_000 });
      const text = await r.text();
      let body: unknown = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { detail: text.slice(0, 300) }; }
      if (!r.ok) {
        const detail = (body as { detail?: unknown }).detail;
        throw new UpstreamError(r.status, detail ?? body, `Backup to the studio failed: HTTP ${r.status} ${typeof detail === "string" ? detail : ""}`.trim());
      }
      this.backups.set(k, { lastAt: Date.now(), hash: createHash("sha1").update(buf).digest("hex") });
      return { uploadedAt: nowIso(), bytes: buf.length, backup: body };
    } catch (e) {
      this.backups.set(k, { ...rec, lastError: (e as Error).message.slice(0, 300) });
      throw e;
    }
  }

  private touch(file: string): void {
    this.active.set(pathKey(path.resolve(file)), { file: path.resolve(file), at: Date.now() });
  }

  async close(file: string): Promise<void> {
    const { file: abs } = this.editFile(file);
    this.active.delete(pathKey(abs));
  }

  async backupStatus(file: string): Promise<EditBackupStatus> {
    const { file: abs } = this.editFile(file);
    const s = this.deps.backupSettings?.() ?? { auto: false, minutes: 10 };
    let sp: number | null = null;
    try { sp = (await this.readProject(abs)).studioProjectId ?? null; } catch { sp = null; }
    const rec = this.backups.get(pathKey(abs)) ?? {};
    const st: EditBackupStatus = { auto: s.auto, minutes: s.minutes, signedIn: Boolean(await this.deps.signedIn?.().catch(() => false)), studioProjectId: sp };
    if (rec.lastAt) st.lastAt = new Date(rec.lastAt).toISOString();
    if (rec.lastError) st.lastError = rec.lastError;
    if (s.auto && sp) st.nextAt = new Date((rec.lastAt ?? Date.now()) + s.minutes * 60_000).toISOString();
    return st;
  }

  /** One pass of the automatic backups: open edits (active in the last 30 minutes) that changed since their last backup. */
  async autoBackupTick(now = Date.now()): Promise<number> {
    const s = this.deps.backupSettings?.();
    if (!s?.auto) return 0;
    if (!(await this.deps.signedIn?.().catch(() => false))) return 0;
    let n = 0;
    for (const [k, a] of [...this.active]) {
      if (now - a.at > 30 * 60_000) { this.active.delete(k); continue; }
      const rec = this.backups.get(k) ?? {};
      if (rec.lastAt && now - rec.lastAt < s.minutes * 60_000) continue;
      try {
        const buf = await fsp.readFile(a.file);
        const hash = createHash("sha1").update(buf).digest("hex");
        if (hash === rec.hash) continue;
        const p = validateProject(JSON.parse(buf.toString("utf8")));
        if (!p.studioProjectId) continue;
        await this.backupNow(a.file, p.studioProjectId);
        n++;
      } catch (e) {
        this.deps.log(`editor auto backup ${path.basename(a.file)}: ${(e as Error).message}`);
      }
    }
    return n;
  }

  /** Check for automatic backups every minute (index.ts starts it; the timer doesn't keep the app alive). */
  startAutoBackups(): void {
    if (this.backupTimer) return;
    this.backupTimer = setInterval(() => void this.autoBackupTick(), 60_000);
    this.backupTimer.unref?.();
  }

  stopAll(): void {
    if (this.backupTimer) clearInterval(this.backupTimer);
    this.backupTimer = null;
    this.jobs.cancelAll();
  }

  // ── built-in impulse responses and the audio preview cache (docs/EDITOR.md §11) ──
  /** userData/irs with every built-in impulse response written (once a session: the recipe is deterministic). */
  ensureIrs(): Promise<string> {
    this.irsReady ??= (async () => {
      const dir = path.join(this.deps.userData, "irs");
      await fsp.mkdir(dir, { recursive: true });
      for (const name of IR_NAMES) {
        const f = path.join(dir, `${name}.wav`);
        const wav = presetWav(name);
        let same = false;
        try { same = (await fsp.readFile(f)).equals(wav); } catch { same = false; }
        if (!same) await fsp.writeFile(f, wav);
      }
      return dir;
    })().catch((e) => { this.irsReady = null; throw e; });
    return this.irsReady;
  }

  /** The gateway's /__media/irs/<name>.wav. */
  async impulseFile(name: string): Promise<string | null> {
    const m = /^([a-z0-9_]+)\.wav$/.exec(String(name ?? ""));
    if (!m || !isIrPreset(m[1])) return null;
    return path.join(await this.ensureIrs(), `${m[1]}.wav`);
  }

  async impulseResponses(): Promise<{ id: string; label: string; url: string; seconds: number }[]> {
    await this.ensureIrs();
    return IR_NAMES.map((id) => ({ id, label: IR_LABELS[id] ?? id, url: `/__media/irs/${id}.wav`, seconds: irSeconds(id) }));
  }

  async renderAudioPreview(file: string, sequenceId: string, clipId: string, clip?: TimelineClip): Promise<{ url: string; duration: number; cached: boolean;
    warnings: string[] }> {
    const { file: abs, dir } = this.editFile(file);
    const project = this.runtime(await this.readProject(abs), dir);
    const seq = project.sequences.find((s) => s.id === sequenceId);
    if (!seq) throw new EditorError("That sequence isn't in the saved edit");
    if (clip !== undefined) {
      if (!clip || typeof clip !== "object" || clip.id !== clipId || !clip.source || !Array.isArray(clip.effects)) throw new EditorError("The clip doesn't match");
      seq.clips = [...seq.clips.filter((x) => x.id !== clipId), structuredClone(clip)];
    }
    const known = this.known.get(pathKey(dir));
    for (const m of known?.values() ?? []) if (!project.media.some((x) => x.id === m.id)) project.media.push(m); // imported, not saved yet
    const irDir = await this.ensureIrs();
    const cacheDir = path.join(dir, "Cache", "audio");
    await fsp.mkdir(cacheDir, { recursive: true });
    let job;
    try {
      job = previewJob(project, seq, clipId, "", { irFile: (p) => path.join(irDir, `${p}.wav`) });
    } catch (e) {
      throw new EditorError((e as Error).message);
    }
    let stamp = "";
    if (job.file) {
      try { const st = await fsp.stat(job.file); stamp = `${st.size}|${Math.floor(st.mtimeMs)}`; } catch { throw new EditorError("The clip's media is missing"); }
    }
    // the cache name: the first 24 hex digits of a sha256 of everything the preview depends on
    const hash = createHash("sha256").update(`${job.key}|${stamp}|${IR_SIG}`).digest("hex").slice(0, 24);
    const out = path.join(cacheDir, `${hash}.wav`);
    let cached = existsSync(out);
    if (!cached) {
      const part = `${out}.part.wav`;
      const args = [...job.args.slice(0, -1), part];
      await this.tools().run(args);
      await retry(() => fsp.rename(part, out));
      cached = false;
    }
    this.allowMedia(out);
    return { url: this.register(out), duration: job.duration, cached, warnings: job.warnings };
  }

  // ── LUT folders and sidecars (docs/EDITOR.md §10, editor-looks) ──
  private lutFolderList(): string[] {
    return (this.deps.lutFolders?.() ?? []).filter((d) => typeof d === "string" && path.isAbsolute(d));
  }

  /** A folder picker; the folder is remembered (settings.lutFolders). Null when cancelled. */
  async addLutFolder(): Promise<{ path: string; files: { name: string; relPath: string; size: number }[] } | null> {
    if (!this.deps.dialogs.openFolder || !this.deps.setLutFolders) throw new EditorError("LUT folders aren't available here");
    const dir = await this.deps.dialogs.openFolder({ title: "Add a LUT folder" });
    if (!dir) return null;
    const abs = path.resolve(dir);
    const list = this.lutFolderList();
    if (!list.some((d) => pathKey(d) === pathKey(abs))) this.deps.setLutFolders([...list, abs].slice(-50));
    return { path: abs, files: await scanLutFolder(abs) };
  }

  async lutFolders(): Promise<{ path: string; files: { name: string; relPath: string; size: number }[] }[]> {
    return Promise.all(this.lutFolderList().map(async (d) => ({ path: d, files: await scanLutFolder(d) })));
  }

  async removeLutFolder(dir: string): Promise<void> {
    if (!this.deps.setLutFolders) return;
    const k = pathKey(path.resolve(String(dir ?? "")));
    this.deps.setLutFolders(this.lutFolderList().filter((d) => pathKey(d) !== k));
  }

  /**
   * Copy a .cube or .3dl from one of the user's LUT folders into the edit's LUTs\ folder (.3dl converted to .cube),
   * checked as a 3D LUT; returns it with a gateway URL the export window can load.
   */
  async importLutFile(file: string, lut: string): Promise<LutEntry> {
    const { dir } = this.editFile(file);
    if (typeof lut !== "string" || !path.isAbsolute(lut)) throw new EditorError("A LUT is named by its full path");
    const src = path.resolve(lut);
    if (!this.lutFolderList().some((d) => isInside(d, src))) throw new EditorError("That LUT isn't in one of your LUT folders: add its folder first");
    const ext = path.extname(src).toLowerCase();
    if (!LUT_EXTS.includes(ext)) throw new EditorError("LUTs are .cube or .3dl files");
    let text: string;
    try { text = await readText(src, LUT_MAX); } catch (e) { throw new EditorError(`${path.basename(src)}: ${(e as Error).message}`); }
    const base = path.basename(src, path.extname(src));
    if (ext === ".3dl") {
      try { text = threeDlToCube(text, base).cube; } catch (e) { throw new EditorError(`${path.basename(src)}: ${(e as Error).message}`); }
    }
    let info;
    try { info = parseCubeHeader(text); } catch (e) { throw new EditorError(`${path.basename(src)}: ${(e as Error).message}`); }
    const lutsDir = path.join(dir, "LUTs");
    await fsp.mkdir(lutsDir, { recursive: true });
    const taken = new Set((await fsp.readdir(lutsDir)).map((n) => pathKey(path.join(lutsDir, n))));
    const want = path.join(lutsDir, `${safeFileName(base, "lut")}.cube`);
    let dest = want;
    try { if ((await fsp.readFile(want, "utf8")) !== text) dest = uniquePath(want, taken); } catch { dest = want; }
    if (dest !== want || !existsSync(dest)) await fsp.writeFile(dest, text, "utf8");
    this.allowMedia(dest);
    return { id: uid("lut"), name: info.title || base, path: dest, url: this.register(dest), size: info.size };
  }

  /**
   * A .cube the page made (editor-looks: moods, shot match) into the edit's LUTs\ folder, served at /__media/<id>/<name>
   * to every window (the export one too). Safe, unique file name; checked as a 3D LUT; at most 8 MB; the same content
   * already there is reused, not written again.
   */
  async writeLut(file: string, name: string, cubeText: string): Promise<{ mediaId: string; url: string; file: string }> {
    const { dir } = this.editFile(file);
    if (typeof cubeText !== "string" || !cubeText) throw new EditorError("No LUT text");
    if (Buffer.byteLength(cubeText) > 8 * 1024 * 1024) throw new EditorError("A LUT is at most 8 MB");
    try { parseCubeHeader(cubeText); } catch (e) { throw new EditorError(`That isn't a 3D .cube LUT: ${(e as Error).message}`); }
    const lutsDir = path.join(dir, "LUTs");
    await fsp.mkdir(lutsDir, { recursive: true });
    const names = await fsp.readdir(lutsDir);
    const base = safeFileName(String(name ?? "").replace(/\.cube$/i, "").trim().slice(0, 80) || "lut", "lut");
    let dest: string | null = null;
    // the same content already there (any name): reuse it. One handle per file for the size check and the read.
    const bytes = Buffer.byteLength(cubeText);
    for (const n of names.filter((x) => x.toLowerCase().endsWith(".cube"))) {
      const f = path.join(lutsDir, n);
      const fh = await fsp.open(f, "r").catch(() => null); // vanished
      if (!fh) continue;
      try {
        if ((await fh.stat()).size === bytes && (await fh.readFile("utf8")) === cubeText) dest = f;
      } catch { /* unreadable: not a match */ } finally {
        await fh.close();
      }
      if (dest) break;
    }
    if (!dest) {
      dest = uniquePath(path.join(lutsDir, `${base}.cube`), new Set(names.map((n) => pathKey(path.join(lutsDir, n)))));
      await retry(() => writeFileAtomic(dest!, cubeText));
    }
    this.allowMedia(dest);
    const url = this.register(dest);
    return { mediaId: mediaIdOfUrl(url)!, url, file: dest };
  }

  private sidecarFile(file: string, name: string): string {
    const { dir } = this.editFile(file);
    let n: string;
    try { n = sidecarName(name); } catch (e) { throw new EditorError((e as Error).message); }
    return path.join(dir, ".tatvam", `${n}.json`);
  }

  /** <edit folder>/.tatvam/<name>.json, parsed; null when there is none. */
  async readSidecar(file: string, name: string): Promise<unknown> {
    const f = this.sidecarFile(file, name);
    try { return JSON.parse(await fsp.readFile(f, "utf8")); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new EditorError(`${path.basename(f)} can't be read: ${(e as Error).message}`);
    }
  }

  async writeSidecar(file: string, name: string, json: unknown): Promise<{ bytes: number }> {
    const f = this.sidecarFile(file, name);
    const text = JSON.stringify(json ?? null);
    if (text.length > 20 * 1024 * 1024) throw new EditorError("A sidecar is at most 20 MB");
    await retry(() => writeFileAtomic(f, text));
    return { bytes: Buffer.byteLength(text) };
  }
}
