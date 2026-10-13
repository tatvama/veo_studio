/**
 * Watch folders (docs/EDITOR.md §13.4): each one has a style, a target edit and a mode ("append to the edit" or
 * "rebuild the auto edit"). A new media file counts once its size has stayed the same for 5 s; new files that settle
 * together go in one batch. "New" means not in the target edit yet (read from the .tatvamedit), so files added while
 * the app was closed are picked up too. The batch goes to the edit (deliver: import, analyse, cut in the style, one
 * undo step) and a notification says what happened ("3 new clips added to Lighthouse auto edit"). Nothing renders or
 * spends from here. Electron-free: the file system, the clock, delivery and notifications come in as deps.
 */
import { watch as fsWatch, type FSWatcher, promises as fsp } from "node:fs";
import path from "node:path";
import type { WatchFolder } from "../shared/types.ts";
import { naturalCompare } from "./autoedit-analyze.ts";
import { EDITOR_MEDIA, extOf, mediaKind } from "./mcp/security.ts";

export const STABLE_MS = 5000;
export const TICK_MS = 1000;

export interface WatchFs {
  list(dir: string): Promise<string[]>;
  size(file: string): Promise<number | null>;
  watch?(dir: string, onChange: () => void): { close(): void } | null;
}

export const nodeFs: WatchFs = {
  async list(dir) {
    try { return (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.join(dir, e.name)); } catch { return []; }
  },
  async size(file) {
    try { const st = await fsp.stat(file); return st.isFile() ? st.size : null; } catch { return null; }
  },
  watch(dir, onChange) {
    try {
      const w: FSWatcher = fsWatch(dir, { persistent: false }, () => onChange());
      w.on("error", () => undefined);
      return w;
    } catch { return null; }
  },
};

/** Size-stability tracking, pure: a file is ready when it has had the same, non-zero size for `stableMs`. */
export class StableTracker {
  private seen = new Map<string, { size: number; since: number }>();
  readonly stableMs: number;
  constructor(stableMs = STABLE_MS) { this.stableMs = stableMs; }
  /** Records a size; returns true when the file just became ready (and forgets it). */
  observe(file: string, size: number | null, now: number): boolean {
    if (size === null) { this.seen.delete(file); return false; }
    const s = this.seen.get(file);
    if (!s || s.size !== size) { this.seen.set(file, { size, since: now }); return false; }
    if (size > 0 && now - s.since >= this.stableMs) { this.seen.delete(file); return true; }
    return false;
  }
  pending(): string[] { return [...this.seen.keys()]; }
  forget(file: string): void { this.seen.delete(file); }
}

export const isWatchMedia = (f: string) => !!mediaKind(f) && EDITOR_MEDIA.has(extOf(f)) && !/(^|[\\/])\.|\.(part|tmp|crdownload|download)$/i.test(f);

export interface AutoWatchDeps {
  watches(): WatchFolder[];
  /** media files already in the edit (absolute paths, lower case) */
  known(editPath: string): Promise<Set<string>>;
  /** puts the batch into the edit; resolves with how many clips were added, or `deferred` when the edit couldn't be opened now */
  deliver(w: WatchFolder, files: string[]): Promise<{ added: number; deferred?: boolean; edit: string }>;
  notify(title: string, body: string, editPath: string): void;
  saveWatch(id: string, patch: Partial<WatchFolder>): void;
  log(m: string): void;
  fs?: WatchFs;
  now?(): number;
  stableMs?: number;
  tickMs?: number;
}

interface Running { w: WatchFolder; tracker: StableTracker; watcher: { close(): void } | null; ready: string[]; delivering: boolean; deferred: Set<string>; retryAt: number }

/** A batch that couldn't go in (the edit wasn't open, or it failed) is tried again after this. */
export const RETRY_MS = 15_000;

export class AutoWatcher {
  private running = new Map<string, Running>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private fs: WatchFs;
  private deps: AutoWatchDeps;
  constructor(deps: AutoWatchDeps) { this.deps = deps; this.fs = deps.fs ?? nodeFs; }

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  /** Starts, stops and restarts watchers to match the settings. */
  sync(): void {
    const want = new Map(this.deps.watches().filter((w) => w.on).map((w) => [w.id, w]));
    for (const [id, r] of this.running) {
      const w = want.get(id);
      if (!w || w.folder !== r.w.folder || w.editPath !== r.w.editPath) { r.watcher?.close(); this.running.delete(id); }
      else r.w = w;
    }
    for (const [id, w] of want) {
      if (this.running.has(id)) continue;
      const r: Running = { w, tracker: new StableTracker(this.deps.stableMs ?? STABLE_MS), watcher: null, ready: [], delivering: false, deferred: new Set(), retryAt: 0 };
      r.watcher = this.fs.watch?.(w.folder, () => undefined) ?? null; // the tick looks every second anyway; the watcher keeps it prompt on network drives
      this.running.set(id, r);
    }
    if (this.running.size && !this.timer) {
      this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? TICK_MS);
      this.timer.unref?.();
    } else if (!this.running.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  stopAll(): void {
    for (const r of this.running.values()) r.watcher?.close();
    this.running.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): { id: string; pending: number; deferred: number }[] {
    return [...this.running.values()].map((r) => ({ id: r.w.id, pending: r.tracker.pending().length + r.ready.length, deferred: r.deferred.size }));
  }

  /** One pass: stat every new file of every watch, collect the ones that settled, deliver a batch per watch. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const r of [...this.running.values()]) {
        const known = await this.deps.known(r.w.editPath).catch(() => new Set<string>());
        const files = (await this.fs.list(r.w.folder)).filter(isWatchMedia).sort(naturalCompare);
        const now = this.now();
        for (const f of files) {
          const k = path.resolve(f).toLowerCase();
          if (known.has(k) || r.ready.includes(f)) { r.tracker.forget(f); continue; }
          if (r.deferred.has(f)) continue;
          if (r.tracker.observe(f, await this.fs.size(f), now)) r.ready.push(f);
        }
        // a batch when nothing else is still settling (files copied together arrive together)
        const settling = r.tracker.pending().some((f) => !known.has(path.resolve(f).toLowerCase()));
        if (r.deferred.size && !r.delivering && now >= r.retryAt) { r.ready.push(...[...r.deferred].filter((f) => !r.ready.includes(f))); r.deferred.clear(); }
        if (r.ready.length && !settling && !r.delivering) void this.deliver(r);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async deliver(r: Running): Promise<void> {
    const batch = r.ready.splice(0).sort(naturalCompare);
    r.delivering = true;
    try {
      const res = await this.deps.deliver(r.w, batch);
      if (res.deferred) {
        for (const f of batch) r.deferred.add(f);
        r.retryAt = this.now() + RETRY_MS;
        return;
      }
      const name = path.basename(r.w.editPath, ".tatvamedit");
      this.deps.saveWatch(r.w.id, { lastRun: new Date(this.now()).toISOString(), lastCount: res.added, lastError: undefined });
      if (res.added > 0) {
        const verb = r.w.mode === "rebuild" ? "the auto edit was rebuilt" : `added to ${name} auto edit`;
        this.deps.notify(r.w.mode === "rebuild" ? `${name}: auto edit rebuilt` : `${res.added} new clip${res.added === 1 ? "" : "s"} added`,
          r.w.mode === "rebuild" ? `${res.added} new clip${res.added === 1 ? "" : "s"} from ${path.basename(r.w.folder)}: ${verb}` : `${res.added} new clip${res.added === 1 ? "" : "s"} ${verb}`, res.edit);
      }
    } catch (e) {
      const msg = (e as Error).message;
      this.deps.log(`watch ${r.w.folder}: ${msg}`);
      this.deps.saveWatch(r.w.id, { lastError: msg.slice(0, 300), lastRun: new Date(this.now()).toISOString() });
      for (const f of batch) r.deferred.add(f); // try again a little later
      r.retryAt = this.now() + 2 * RETRY_MS;
    } finally {
      r.delivering = false;
    }
  }
}
