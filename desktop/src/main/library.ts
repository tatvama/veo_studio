/**
 * The local library (docs/DESKTOP.md §3): the root folder, one folder per project with the skeleton,
 * project.tatvam.json, moving a project, disk usage and cleaning. Also the app-wide index (userData/library.json)
 * that maps project ids to folders, so the gateway can find the local file for any /media key.
 * Electron-free: folder pickers and Explorer are called by ipc.ts.
 */
import { existsSync, mkdirSync, promises as fsp, readFileSync, statfsSync } from "node:fs";
import path from "node:path";
import { isInside } from "./paths.ts";
import type { OfflineDb, OfflineStore } from "./gateway.ts";
import { Config, writeFileAtomic } from "./config.ts";
import { Mirror } from "./mirror.ts";
import { projectFolderName } from "./naming.ts";

export const SKELETON = ["Takes", "Audio/Voice", "Audio/Music", "Audio/SFX", "Captions", "Imports", "Proxies", "Renders", "Cache",
  "Bible/Characters", "Bible/Locations", "Bible/Props", "Media", "Edits", ".tatvam"];
export const TOP_FOLDERS = ["Takes", "Audio", "Captions", "Imports", "Proxies", "Renders", "Cache", "Bible", "Media", "Edits", ".tatvam"];
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);

interface IndexEntry { folder: string; title: string; lastSync?: string }

export interface ProjectInfo { id: number; title?: string; aspect?: string; languages?: string[]; primary_language?: string }

export class Library implements OfflineStore {
  readonly config: Config;
  readonly userData: string;
  private indexFile: string;
  private index: { projects: Record<string, IndexEntry> };
  private mirrors = new Map<number, Mirror>();
  private global: Mirror | null = null;
  private log: (m: string) => void;
  appVersion = "";

  constructor(config: Config, userData: string, log: (m: string) => void = () => undefined) {
    this.config = config;
    this.userData = userData;
    this.log = log;
    this.indexFile = path.join(userData, "library.json");
    this.index = { projects: {} };
    try {
      const raw = JSON.parse(readFileSync(this.indexFile, "utf8"));
      if (raw && typeof raw.projects === "object") this.index = raw;
    } catch { /* first run */ }
  }

  root(): string {
    return this.config.get().libraryRoot;
  }

  setRoot(dir: string): void {
    mkdirSync(dir, { recursive: true });
    this.config.set({ libraryRoot: dir });
  }

  private saveIndex(): void {
    writeFileAtomic(this.indexFile, JSON.stringify(this.index, null, 2));
  }

  knownProjects(): number[] {
    return Object.keys(this.index.projects).map(Number);
  }

  title(pid: number): string | undefined {
    return this.index.projects[String(pid)]?.title;
  }

  /** Where the project's folder is (or would be): a moved folder, the indexed one, or `<root>/<title> (#id)`. */
  folderFor(pid: number, title?: string): { path: string; exists: boolean; custom: boolean } {
    const custom = this.config.get().projectFolders[String(pid)];
    const p = custom || this.index.projects[String(pid)]?.folder || path.join(this.root(), projectFolderName(title ?? this.title(pid), pid));
    return { path: p, exists: existsSync(p), custom: Boolean(custom) };
  }

  /** Create the folder skeleton and project file (idempotent). */
  ensure(project: ProjectInfo, serverUrl: string): string {
    const pid = project.id;
    const { path: dir } = this.folderFor(pid, project.title);
    for (const sub of SKELETON) mkdirSync(path.join(dir, sub), { recursive: true });
    const key = String(pid);
    this.index.projects[key] = { ...(this.index.projects[key] ?? {}), folder: dir, title: project.title ?? this.title(pid) ?? "" };
    this.saveIndex();
    this.writeProjectFile(project, serverUrl);
    return dir;
  }

  writeProjectFile(project: ProjectInfo, serverUrl: string, extra: Record<string, unknown> = {}): void {
    const dir = this.folderFor(project.id).path;
    const file = path.join(dir, "project.tatvam.json");
    let cur: Record<string, unknown> = {};
    try { cur = JSON.parse(readFileSync(file, "utf8")); } catch { cur = {}; }
    const s = this.config.get();
    const doc = {
      format: "tatvam-project", formatVersion: 1, ...cur,
      project: { ...((cur.project as object) ?? {}), ...project },
      server: serverUrl, naming: s.naming, pullScope: s.pullScope, app: this.appVersion || undefined,
      updatedAt: new Date().toISOString(), ...extra,
    };
    writeFileAtomic(file, JSON.stringify(doc, null, 2));
  }

  markSynced(pid: number, when = new Date().toISOString()): void {
    const key = String(pid);
    if (this.index.projects[key]) {
      this.index.projects[key].lastSync = when;
      this.saveIndex();
    }
  }

  /** The project's mirror (creates the folder skeleton's .tatvam on first use). */
  mirror(pid: number): Mirror {
    let m = this.mirrors.get(pid);
    if (!m) {
      const dir = this.folderFor(pid).path;
      m = new Mirror(path.join(dir, ".tatvam", "mirror.sqlite"));
      this.mirrors.set(pid, m);
    }
    return m;
  }

  /** The mirror only when the project already has a folder. */
  existingMirror(pid: number): Mirror | null {
    if (this.mirrors.has(pid)) return this.mirrors.get(pid)!;
    const f = this.folderFor(pid);
    if (!f.exists || !existsSync(path.join(f.path, ".tatvam"))) return null;
    return this.mirror(pid);
  }

  closeMirror(pid: number): void {
    this.mirrors.get(pid)?.close();
    this.mirrors.delete(pid);
  }

  closeAll(): void {
    for (const pid of [...this.mirrors.keys()]) this.closeMirror(pid);
    this.global?.close();
    this.global = null;
  }

  // ── OfflineStore for the gateway ──
  globalStore(): Mirror {
    if (!this.global) this.global = new Mirror(path.join(this.userData, "offline.sqlite"));
    return this.global;
  }
  forProject(pid: number | null): OfflineDb {
    if (pid !== null) {
      const m = this.existingMirror(pid);
      if (m) return m;
    }
    return this.globalStore();
  }
  all(): OfflineDb[] {
    return [this.globalStore(), ...this.mirrors.values()];
  }

  /** Absolute path of the local file for a storage key, or null. In proxy mode a video's proxy wins. */
  resolveKey(key: string): string | null {
    return this.resolve(key, this.config.get().proxyMode);
  }

  /** The original local file (never a proxy): renders and uploads use this. */
  resolveKeyOriginal(key: string): string | null {
    return this.resolve(key, false);
  }

  private resolve(key: string, proxyMode: boolean): string | null {
    const m = /^projects\/(\d+)\//.exec(key);
    const pids = m ? [Number(m[1])] : [...this.mirrors.keys()];
    for (const pid of pids) {
      const mirror = this.existingMirror(pid);
      const row = mirror?.file(key);
      if (!row || row.state !== "ready" || !row.local_path) continue;
      const dir = this.folderFor(pid).path;
      if (proxyMode && row.proxy_path && VIDEO_EXT.has(path.extname(row.local_path).toLowerCase())) {
        const proxy = path.join(dir, row.proxy_path);
        if (existsSync(proxy)) return proxy;
      }
      return path.join(dir, row.local_path);
    }
    return null;
  }

  /** Absolute path of a mirror-relative path. */
  abs(pid: number, rel: string): string {
    return path.join(this.folderFor(pid).path, rel);
  }

  /**
   * Move the project folder. When `dest` is empty (or new) it becomes the project folder; otherwise the folder is
   * moved inside it. Falls back to copy + delete across drives. Paths in the mirror are relative, so they stay valid.
   */
  async move(pid: number, dest: string): Promise<string> {
    const cur = this.folderFor(pid);
    let target = dest;
    if (existsSync(dest) && (await fsp.readdir(dest)).length > 0) target = path.join(dest, path.basename(cur.path));
    if (path.resolve(target).toLowerCase() === path.resolve(cur.path).toLowerCase()) return cur.path;
    if (existsSync(target) && (await fsp.readdir(target)).length > 0) throw new Error(`${target} already exists and isn't empty`);
    this.closeMirror(pid);
    if (cur.exists) {
      mkdirSync(path.dirname(target), { recursive: true });
      if (existsSync(target)) await fsp.rmdir(target);
      await moveDir(cur.path, target);
    } else {
      mkdirSync(target, { recursive: true });
    }
    const custom = path.resolve(path.dirname(target)).toLowerCase() !== path.resolve(this.root()).toLowerCase();
    const folders = { ...this.config.get().projectFolders };
    if (custom) folders[String(pid)] = target;
    else delete folders[String(pid)];
    this.config.set({ projectFolders: folders });
    const key = String(pid);
    this.index.projects[key] = { ...(this.index.projects[key] ?? { title: "" }), folder: target };
    this.saveIndex();
    this.log(`moved project ${pid} to ${target}`);
    return target;
  }

  async usage(pid: number): Promise<{ folders: Record<string, { files: number; bytes: number }>; freeBytes: number }> {
    const dir = this.folderFor(pid).path;
    const folders: Record<string, { files: number; bytes: number }> = {};
    for (const top of TOP_FOLDERS) folders[top] = await dirUsage(path.join(dir, top));
    return { folders, freeBytes: freeBytes(existsSync(dir) ? dir : this.root()) };
  }

  /** Remove throw-away files. Renders go only when they have uploaded (`uploadedRenders` = absolute paths). */
  async clean(pid: number, what: ("cache" | "proxies" | "renders")[], uploadedRenders: string[] = []): Promise<{ removedBytes: number }> {
    const dir = this.folderFor(pid).path;
    let removed = 0;
    const mirror = this.existingMirror(pid);
    if (what.includes("cache")) {
      removed += (await dirUsage(path.join(dir, "Cache"))).bytes;
      await emptyDir(path.join(dir, "Cache"));
      if (mirror) for (const f of mirror.files()) if (f.local_path.startsWith("Cache/")) mirror.deleteFile(f.key);
    }
    if (what.includes("proxies")) {
      removed += (await dirUsage(path.join(dir, "Proxies"))).bytes;
      await emptyDir(path.join(dir, "Proxies"));
      if (mirror) for (const f of mirror.files()) if (f.proxy_path) mirror.setFile(f.key, { proxy_path: "" });
    }
    if (what.includes("renders")) {
      for (const f of uploadedRenders) {
        if (!isInside(path.join(dir, "Renders"), f)) continue; // only renders of this project's Renders folder are ever removed
        try {
          removed += (await fsp.stat(f)).size;
          await fsp.rm(f, { force: true });
        } catch { /* already gone */ }
      }
    }
    return { removedBytes: removed };
  }
}

export function freeBytes(dir: string): number {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return 0;
  }
}

export function diskInfo(dir: string): { freeBytes: number; totalBytes: number } {
  try {
    const s = statfsSync(dir);
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return { freeBytes: 0, totalBytes: 0 };
  }
}

export async function dirUsage(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (d: string) => {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        files++;
        try { bytes += (await fsp.stat(p)).size; } catch { /* vanished */ }
      }
    }
  };
  await walk(dir);
  return { files, bytes };
}

async function emptyDir(dir: string): Promise<void> {
  let entries: string[] = [];
  try { entries = await fsp.readdir(dir); } catch { return; }
  for (const e of entries) await fsp.rm(path.join(dir, e), { recursive: true, force: true, maxRetries: 3 });
}

/** fs.rename with retries (Windows file locks), then copy + delete across drives. */
export async function moveDir(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EXDEV") break;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && i < 4) {
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        continue;
      }
      throw new Error(code === "EPERM" || code === "EBUSY" ? `${from} is in use: close players and Explorer windows showing it, then try again` : String((e as Error).message));
    }
  }
  await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false });
  await fsp.rm(from, { recursive: true, force: true, maxRetries: 3 });
}
