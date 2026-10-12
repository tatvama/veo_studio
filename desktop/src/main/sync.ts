/**
 * Project sync (docs/DESKTOP.md §2.3, §3): manifest → downloads (3 at a time, resumable `.part`, checked sizes)
 * → series names (two-phase rename plan) → files no longer listed parked in Cache/_unlinked → Edits/ EDL + FCPXML.
 * Progress is broadcast to every window; server events re-sync (debounced 3 s) while a sync is active.
 * Electron-free: `desiredPaths` is pure and unit-tested (test/sync.test.ts).
 */
import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import type { PullScope, SyncStatus } from "../shared/types.ts";
import { downloadTo, pool } from "./download.ts";
import type { Library } from "./library.ts";
import type { FileRow, Mirror } from "./mirror.ts";
import {
  DEFAULT_TEMPLATES, dateToken, dedupe, fitName, pathKey, planRenames, safePart, templateKeyForFolder, uniquePath, type RenamePlan,
} from "./naming.ts";
import { EventsClient, isResyncEvent, keyedDebounce, type Upstream } from "./upstream.ts";

export interface ManifestSeries { season?: number; episode?: number; scene?: number | null; shot?: number | null; cut?: number | null;
  take?: number | null; version?: number | null; code?: string | null }
export interface ManifestItem {
  key: string; url: string; folder: string; kind: string; role?: string;
  episode_id?: number | null; scene_id?: number | null; shot_id?: number | null; take_id?: number | null; id?: number | null;
  language?: string | null; series?: ManifestSeries; approved?: boolean; selected?: boolean; duration_s?: number | null;
  updated_at?: string | null; ext?: string; label?: string; preset?: string | null; size?: number | null;
}
export interface ManifestShot { id: number; code: string; order: number; cut_index: number | null; include: boolean; scene_id?: number | null;
  scene_order?: number | null; status?: string; duration_s?: number }
export interface ManifestEpisode { id: number; number: number; season: number; title: string; cut_version?: number | null;
  scenes?: { id: number; order: number; title: string }[]; shots: ManifestShot[] }
export interface Manifest {
  project: { id: number; title: string; aspect?: string; languages?: string[]; primary_language?: string };
  generated_at?: string;
  episodes: ManifestEpisode[];
  items: ManifestItem[];
}

const INCOMING = "Cache/.incoming";

function extOf(item: ManifestItem): string {
  const e = (item.ext || path.extname(item.key).slice(1) || "bin").replace(/^\./, "").toLowerCase();
  return `.${e}`;
}

function sortKey(it: ManifestItem): (number | string)[] {
  const s = it.series ?? {};
  return [s.season ?? 0, s.episode ?? 0, s.cut ?? 9999, s.shot ?? 9999, it.kind, it.language ?? "", s.take ?? s.version ?? 0, it.key];
}
function cmp(a: (number | string)[], b: (number | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return typeof a[i] === "number" && typeof b[i] === "number" ? (a[i] as number) - (b[i] as number) : String(a[i]).localeCompare(String(b[i]));
  }
  return 0;
}

/**
 * The relative path (with "/") every manifest item should have in the project folder, from the naming templates.
 * `{seq}` counts within each folder in cut order. Imports keep the name they got when they were ingested.
 */
export function desiredPaths(manifest: Manifest, templates: Record<string, string>, opts: { folderAbs: string; existing?: Map<string, string>; maxPath?: number }):
  { key: string; path: string; folder: string }[] {
  const byFolder = new Map<string, ManifestItem[]>();
  for (const it of manifest.items) {
    const list = byFolder.get(it.folder) ?? [];
    list.push(it);
    byFolder.set(it.folder, list);
  }
  const out: { key: string; path: string; folder: string }[] = [];
  for (const [folder, items] of byFolder) {
    const sorted = [...items].sort((a, b) => cmp(sortKey(a), sortKey(b)));
    sorted.forEach((it, i) => {
      const keep = opts.existing?.get(it.key);
      if (keep && keep.startsWith("Imports/")) {
        out.push({ key: it.key, path: keep, folder });
        return;
      }
      const tplKey = templateKeyForFolder(folder);
      const tpl = templates[tplKey] || DEFAULT_TEMPLATES[tplKey] || "{label}";
      const s = it.series ?? {};
      const ext = extOf(it);
      // layer media are labelled with their file name: drop its extension so it isn't doubled
      const rawLabel = it.label || path.basename(it.key, path.extname(it.key));
      const label = rawLabel.toLowerCase().endsWith(ext) ? rawLabel.slice(0, -ext.length) : rawLabel;
      const values = {
        project: manifest.project.title, season: s.season, episode: s.episode, scene: s.scene, shot: s.shot, cut: s.cut, code: s.code,
        kind: it.kind, lang: it.language ?? "", take: s.take, version: s.version ?? s.take, preset: it.preset ?? "",
        date: dateToken(it.updated_at), seq: i + 1, id: it.take_id ?? it.id ?? "", label,
      };
      const dirAbs = path.join(opts.folderAbs, ...folder.split("/"));
      const name = fitName(tpl, values, dirAbs, ext, opts.maxPath);
      out.push({ key: it.key, path: `${folder}/${name}${ext}`, folder });
    });
  }
  return dedupe(out);
}

export interface SyncDeps {
  library: Library;
  upstream: Upstream;
  templates(): Record<string, string>;
  serverUrl(): string;
  autoSync(): boolean;
  broadcast(s: SyncStatus): void;
  /** Writes Edits/ for an episode after a sync (ipc wires edl). */
  writeEdits?(pid: number, eid: number): Promise<unknown>;
  log(msg: string): void;
}

interface Run { status: SyncStatus; abort: AbortController; promise: Promise<void>; again: boolean; opts: { scope: PullScope; episodeId?: number } }

export class SyncManager {
  private deps: SyncDeps;
  private runs = new Map<number, Run>();
  private statuses = new Map<number, SyncStatus>();
  private active = new Map<number, { scope: PullScope; episodeId?: number }>();
  private events: EventsClient;
  private resync: ReturnType<typeof keyedDebounce<number>>;
  private lastEmit = new Map<number, number>();

  constructor(deps: SyncDeps) {
    this.deps = deps;
    this.resync = keyedDebounce<number>(3000, (pid) => {
      const a = this.active.get(pid);
      if (a) void this.start(pid, a).catch((e) => this.deps.log(`re-sync ${pid}: ${(e as Error).message}`));
    });
    this.events = new EventsClient({
      serverUrl: deps.serverUrl, cookie: () => deps.upstream.opts.cookie(), log: deps.log,
      onEvent: (pid, ev) => {
        if (this.active.has(pid) && deps.autoSync() && isResyncEvent(ev.type)) this.resync(pid);
      },
    });
  }

  status(pid: number): SyncStatus {
    return this.statuses.get(pid) ?? { pid, phase: "idle", active: this.active.has(pid), scope: this.active.get(pid)?.scope ?? "approved",
      total: 0, done: 0, bytes: 0, bytesTotal: 0, current: "", errors: [], renamed: 0, unlinked: 0,
      folder: this.deps.library.folderFor(pid).path };
  }

  private emit(s: SyncStatus, force = false): void {
    this.statuses.set(s.pid, { ...s, errors: [...s.errors] });
    const now = Date.now();
    if (!force && now - (this.lastEmit.get(s.pid) ?? 0) < 200) return;
    this.lastEmit.set(s.pid, now);
    this.deps.broadcast({ ...s, errors: [...s.errors] });
  }

  /** Start (or queue another pass of) a sync. Resolves when this pass is done. */
  async start(pid: number, opts: { scope?: PullScope; episodeId?: number } = {}): Promise<void> {
    const o = { scope: opts.scope ?? this.active.get(pid)?.scope ?? "approved", episodeId: opts.episodeId };
    this.active.set(pid, o);
    this.events.watch(pid);
    const cur = this.runs.get(pid);
    if (cur) {
      cur.again = true;
      cur.opts = o;
      return cur.promise;
    }
    const abort = new AbortController();
    const status: SyncStatus = { pid, phase: "manifest", active: true, scope: o.scope, episodeId: o.episodeId, total: 0, done: 0, bytes: 0,
      bytesTotal: 0, current: "Asking the server what this project needs", errors: [], renamed: 0, unlinked: 0, startedAt: new Date().toISOString() };
    const run: Run = { status, abort, again: false, opts: o, promise: Promise.resolve() };
    run.promise = (async () => {
      try {
        do {
          run.again = false;
          Object.assign(status, { phase: "manifest", total: 0, done: 0, bytes: 0, bytesTotal: 0, errors: [], renamed: 0, unlinked: 0,
            startedAt: new Date().toISOString(), finishedAt: undefined, scope: run.opts.scope, episodeId: run.opts.episodeId });
          await this.pass(pid, run.opts, status, abort.signal);
        } while (run.again && !abort.signal.aborted);
      } catch (e) {
        if (abort.signal.aborted) {
          status.phase = "stopped";
        } else {
          status.phase = "error";
          status.errors.push(String((e as Error).message || e));
          this.deps.log(`sync ${pid} failed: ${(e as Error).stack || e}`);
        }
      } finally {
        status.finishedAt = new Date().toISOString();
        status.current = "";
        status.active = this.active.has(pid);
        this.runs.delete(pid);
        this.emit(status, true);
      }
    })();
    this.runs.set(pid, run);
    return run.promise;
  }

  async stop(pid: number): Promise<void> {
    this.active.delete(pid);
    this.events.unwatch(pid);
    this.resync.cancel(pid);
    const r = this.runs.get(pid);
    if (r) {
      r.again = false;
      r.abort.abort();
      await r.promise.catch(() => undefined);
    }
    this.emit({ ...this.status(pid), active: false, phase: r ? "stopped" : this.status(pid).phase }, true);
  }

  stopAll(): void {
    for (const pid of [...this.active.keys()]) void this.stop(pid);
    this.events.closeAll();
  }

  /** Rename plan for the current templates against the last manifest, without running it. */
  preview(pid: number): { from: string; to: string }[] {
    const mirror = this.deps.library.existingMirror(pid);
    if (!mirror) return [];
    const manifest = this.lastManifest(mirror);
    if (!manifest) return [];
    const { current, fixed } = this.names(pid, mirror, manifest);
    const to = new Map(fixed.map((f) => [f.key, f.path]));
    return current.map((c) => ({ from: c.path, to: to.get(c.key) ?? c.path }));
  }

  lastManifest(mirror: Mirror): Manifest | null {
    try { return JSON.parse(mirror.getMeta("manifest") || "null") as Manifest | null; } catch { return null; }
  }

  private renamePlan(pid: number, mirror: Mirror, manifest: Manifest): RenamePlan {
    const { current, others, fixed } = this.names(pid, mirror, manifest);
    return planRenames([...current, ...others.map((p, i) => ({ key: `__other_${i}`, path: p }))], fixed);
  }

  /** Each ready file's path now and the series name it should have (deduped against the files that stay put). */
  private names(pid: number, mirror: Mirror, manifest: Manifest) {
    const rows = new Map(mirror.files({ state: "ready" }).map((r) => [r.key, r]));
    const existing = new Map([...rows].map(([k, r]) => [k, r.local_path]));
    const folderAbs = this.deps.library.folderFor(pid).path;
    const desired = desiredPaths(manifest, this.deps.templates(), { folderAbs, existing })
      .filter((d) => rows.has(d.key));
    const current = desired.map((d) => ({ key: d.key, path: rows.get(d.key)!.local_path }));
    // names held by other ready files that stay where they are count as taken
    const others = [...rows.values()].filter((r) => !desired.some((d) => d.key === r.key)).map((r) => r.local_path);
    const fixed = dedupe(desired, others);
    return { current, others, fixed };
  }

  private async pass(pid: number, opts: { scope: PullScope; episodeId?: number }, status: SyncStatus, signal: AbortSignal): Promise<void> {
    const { library, upstream } = this.deps;
    this.emit(status, true);
    const q = new URLSearchParams({ scope: opts.scope });
    if (opts.episodeId) q.set("episode_id", String(opts.episodeId));
    const manifest = await upstream.json<Manifest>(`/api/projects/${pid}/desktop/manifest?${q}`, { signal });
    const folderAbs = library.ensure(manifest.project, this.deps.serverUrl());
    status.folder = folderAbs;
    const mirror = library.mirror(pid);
    mirror.upsertProject(manifest.project);
    for (const e of manifest.episodes) mirror.upsertEpisode(pid, e as never);
    mirror.setMeta("manifest", JSON.stringify(manifest));

    // 1. downloads (into Cache/.incoming, so a new file never lands on a name another file still holds)
    const want = manifest.items;
    const todo: ManifestItem[] = [];
    for (const it of want) {
      const row = mirror.file(it.key);
      const abs = row?.local_path ? path.join(folderAbs, row.local_path) : "";
      let ok = false;
      if (row && row.state === "ready" && abs && existsSync(abs)) {
        try { ok = (await fsp.stat(abs)).size === row.size; } catch { ok = false; }
      }
      if (ok) {
        mirror.setFile(it.key, { item: JSON.stringify(it), episode_id: it.episode_id ?? null, shot_id: it.shot_id ?? null, folder: it.folder });
      } else {
        todo.push(it);
      }
    }
    status.phase = "downloading";
    status.total = todo.length;
    status.bytesTotal = todo.reduce((s, it) => s + (it.size ?? 0), 0);
    this.emit(status, true);
    await pool(todo, 3, async (it) => {
      if (signal.aborted) return;
      const rel = `${INCOMING}/${safePart(it.key.replace(/\//g, "_")).slice(-120)}${extOf(it)}`;
      status.current = it.label || it.key;
      mirror.upsertFile({ key: it.key, project_id: pid, episode_id: it.episode_id ?? null, shot_id: it.shot_id ?? null, folder: it.folder,
        kind: it.kind, role: it.role ?? "", state: "downloading", item: JSON.stringify(it) });
      let counted = Boolean(it.size);
      try {
        const res = await downloadTo(upstream, it.url || `/media/${it.key}`, path.join(folderAbs, rel), {
          signal,
          onBytes: (d, _received, total) => {
            if (!counted && total) { status.bytesTotal += total; counted = true; }
            status.bytes += d;
            this.emit(status);
          },
        });
        mirror.setFile(it.key, { local_path: rel, name: path.basename(rel), size: res.size, etag: res.etag, state: "ready", synced_at: new Date().toISOString() });
      } catch (e) {
        if (signal.aborted) return;
        mirror.setFile(it.key, { state: "failed" });
        status.errors.push(`${it.label || it.key}: ${(e as Error).message}`);
      } finally {
        status.done++;
        this.emit(status);
      }
    }, signal);
    if (signal.aborted) throw new Error("stopped");

    // 2. files no longer listed (for the episodes this manifest covers) go to Cache/_unlinked
    status.phase = "cleaning";
    status.current = "Tidying files that left the cut";
    this.emit(status, true);
    const listed = new Set(want.map((i) => i.key));
    const episodes = new Set(manifest.episodes.map((e) => e.id));
    for (const row of mirror.files({ state: "ready" })) {
      if (listed.has(row.key) || row.folder === "Cache" || row.folder === "Imports" || row.role === "cache") continue;
      const covered = row.episode_id !== null ? episodes.has(row.episode_id) : !opts.episodeId;
      if (!covered) continue;
      status.unlinked = (status.unlinked ?? 0) + ((await this.unlink(folderAbs, mirror, row)) ? 1 : 0);
    }

    // 3. series names: one two-phase plan for the files already here and the new arrivals
    status.phase = "renaming";
    status.current = "Putting files in cut order";
    this.emit(status, true);
    const plan = this.renamePlan(pid, mirror, manifest);
    status.renamed = await this.applyPlan(folderAbs, mirror, plan, status);
    for (const b of plan.blocked) status.errors.push(`Can't rename ${b.from}: ${b.to} is taken`);

    // 4. Edits/
    if (this.deps.writeEdits) {
      status.current = "Writing the EDL and FCPXML";
      this.emit(status, true);
      for (const e of manifest.episodes) {
        try { await this.deps.writeEdits(pid, e.id); } catch (err) { this.deps.log(`EDL for episode ${e.id}: ${(err as Error).message}`); }
      }
    }
    const when = new Date().toISOString();
    mirror.setMeta("lastSync", when);
    library.markSynced(pid, when);
    library.writeProjectFile(manifest.project, this.deps.serverUrl(), { lastSync: when, scope: opts.scope });
    status.inFolder = mirror.files({ state: "ready" }).length;
    status.phase = status.errors.length ? "error" : "done";
  }

  private async unlink(folderAbs: string, mirror: Mirror, row: FileRow): Promise<boolean> {
    const from = path.join(folderAbs, row.local_path);
    if (!existsSync(from)) {
      mirror.setFile(row.key, { state: "unlinked" });
      return false;
    }
    const taken = new Set<string>();
    let rel = `Cache/_unlinked/${path.basename(row.local_path)}`;
    while (existsSync(path.join(folderAbs, rel))) { taken.add(pathKey(rel)); rel = uniquePath(rel, taken); }
    await fsp.mkdir(path.join(folderAbs, "Cache", "_unlinked"), { recursive: true });
    await fsp.rename(from, path.join(folderAbs, rel));
    mirror.setFile(row.key, { state: "unlinked", local_path: rel, name: path.basename(rel), proxy_path: "" });
    return true;
  }

  private async applyPlan(folderAbs: string, mirror: Mirror, plan: RenamePlan, status: SyncStatus): Promise<number> {
    let renamed = 0;
    for (const st of plan.steps) {
      const from = path.join(folderAbs, st.from);
      const to = path.join(folderAbs, st.to);
      try {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        if (existsSync(to) && pathKey(from) !== pathKey(to)) throw new Error(`${st.to} exists`);
        await fsp.rename(from, to);
        if (st.phase === 2 && !st.key.startsWith("__other_")) {
          mirror.setFile(st.key, { local_path: st.to, name: path.basename(st.to) });
          const m = plan.moves.find((x) => x.key === st.key);
          if (m && !m.from.startsWith(INCOMING)) renamed++;
        } else if (st.phase === 1) {
          mirror.setFile(st.key, { local_path: st.to });
        }
      } catch (e) {
        status.errors.push(`Rename ${st.from} → ${st.to}: ${(e as Error).message}`);
      }
    }
    return renamed;
  }
}
