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
import { randomUUID } from "node:crypto";
import { existsSync, openAsBlob, promises as fsp, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type {
  AnalyzeKind, AnalyzeOptions, AnalyzeResult, EditListEntry, EditPreset, EditProject, LutEntry, MediaItem, ShaderEntry,
} from "../shared/types.ts";
import { writeFileAtomic } from "./config.ts";
import { downloadTo, pool } from "./download.ts";
import {
  beatsArgs, BEAT_RATE, detectBeats, loudnessArgs, parseEbur128, parseScenes, parseSilence, scenesArgs, silenceArgs,
} from "./editor-analyze.ts";
import { dimsFor, episodePlan, episodeSequence, type StudioEpisode, type StudioLayers } from "./editor-episode.ts";
import {
  filmstripArgs, Limiter, parseCubeHeader, probeFile, proxyShortSide, readText, runFfmpegLines, runPeaks, thumbArgs, type ProbeInfo,
} from "./editor-media.ts";
import {
  BACKUP_EVERY_MS, bakName, EDIT_EXT, EditorError, exportRange, isInside, isServable, MAX_BACKUPS, MEDIA_FILTERS, mediaIdOfUrl,
  mediaKindOf, newProject, safeEditName, toDisk, toRuntime, uid, validatePreset, validateProject, VIDEO_EXTS, AUDIO_EXTS, IMAGE_EXTS,
} from "./editor-model.ts";
import { runFfmpeg, type FfmpegInfo } from "./ffmpeg.ts";
import { mimeOf } from "./gateway.ts";
import { pathKey, safeFileName, safePart, uniquePath } from "./naming.ts";
import { proxyArgs } from "./proxies.ts";
import type { RenderManager } from "./render.ts";
import { UpstreamError, type Upstream } from "./upstream.ts";

export interface EditorDialogs {
  /** A native open dialog; [] when cancelled. */
  openFiles(opts: { title: string; filters: { name: string; extensions: string[] }[]; multi?: boolean; defaultPath?: string }): Promise<string[]>;
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
}

interface Recent { path: string; opened: string }

const MAX_RECENTS = 20;
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

  constructor(deps: EditorDeps) {
    this.deps = deps;
    this.recentsFile = path.join(deps.userData, "editor-recent.json");
    this.uploadsFile = path.join(deps.userData, "editor-uploads.json");
    this.shadersDir = path.join(deps.userData, "shaders");
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
  private async writeProject(file: string, disk: EditProject): Promise<void> {
    const k = pathKey(file);
    const prev = this.writes.get(k) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      await this.rotateBackups(file);
      await retry(() => writeFileAtomic(file, JSON.stringify(disk)));
    });
    this.writes.set(k, run);
    try { await run; } finally { if (this.writes.get(k) === run) this.writes.delete(k); }
  }

  private async rotateBackups(file: string): Promise<void> {
    if (!existsSync(file)) return;
    const b1 = bakName(file, 1);
    let last = 0;
    try { last = (await fsp.stat(b1)).mtimeMs; } catch { last = 0; }
    if (Date.now() - last < BACKUP_EVERY_MS) return;
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
    return { path: target.file, project: this.runtime(project, target.dir) };
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
    if (existsSync(thumb)) item.thumb = this.register(thumb); else delete item.thumb;
    if (existsSync(strip)) item.filmstrip = this.register(strip); else delete item.filmstrip;
    if (peaks) item.peaks = peaks; else delete item.peaks;
    if (o.studioKey) item.studioKey = o.studioKey;
    delete item.proxyPath;
    delete item.proxyUrl;
    this.remember(dir, [item]);
    return item;
  }

  private async copyMediaSetting(file: string): Promise<boolean> {
    try { return (await this.readProject(file)).settings.copyMedia; } catch { return false; }
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
    const copy = await this.copyMediaSetting(abs);
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

  async proxy(file: string, mediaId: string): Promise<MediaItem> {
    const { file: abs, dir } = this.editFile(file);
    const it = await this.item(file, dir, mediaId);
    if (it.kind !== "video") throw new EditorError("Only video clips get proxies");
    const src = await this.existingFile(it);
    const short = proxyShortSide(it.width || 1920, it.height || 1080);
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
  async export(file: string, sequenceId: string, opts: { preset: string; range: "all" | "inout"; upload?: boolean }): Promise<string> {
    const { file: abs, dir } = this.editFile(file);
    if (!this.deps.renders) throw new EditorError("Exports aren't available here");
    const project = this.runtime(await this.readProject(abs), dir);
    const seq = project.sequences.find((s) => s.id === sequenceId);
    if (!seq) throw new EditorError("That sequence isn't in the saved edit: save first");
    const range = exportRange(seq, opts?.range === "inout" ? "inout" : "all");
    return this.deps.renders.startEdit({ editPath: abs, editDir: dir, project, sequenceId, range, preset: String(opts?.preset ?? ""),
      upload: Boolean(opts?.upload), source: seq.source ?? null });
  }

  // ── local analysis (docs/EDITOR.md §8) ──
  async analyze(file: string, mediaId: string, kind: AnalyzeKind, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
    const { dir } = this.editFile(file);
    const it = await this.item(file, dir, mediaId);
    const src = await this.existingFile(it);
    const tools = this.tools();
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
      await tools.lines(loudnessArgs(src), (l) => { if (!/\bt:\s*[\d.]+\s+TARGET/.test(l)) collect(l); });
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
}
