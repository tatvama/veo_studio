/**
 * The Imports watch folder (docs/DESKTOP.md §4): a file dropped into <project>/Imports whose size has held steady
 * for 2 s is uploaded to POST /api/episodes/{eid}/media (multipart field `file`), renamed by the Imports template
 * (IMP_{seq:04}_{label}) and marked ingested in the mirror. Electron-free.
 */
import { existsSync, promises as fsp, watch, type FSWatcher } from "node:fs";
import { openAsBlob } from "node:fs";
import path from "node:path";
import type { Library } from "./library.ts";
import { pathKey, renderTemplate, safePart, uniquePath } from "./naming.ts";
import type { Upstream } from "./upstream.ts";

/** Extension → (kind, max MB), as backend/app/api/layers.py KINDS. */
export const IMPORT_KINDS: Record<string, [string, number]> = {
  mp4: ["video", 400], mov: ["video", 400], webm: ["video", 400], m4v: ["video", 400],
  mp3: ["audio", 80], wav: ["audio", 200], m4a: ["audio", 80], aac: ["audio", 80], ogg: ["audio", 80], flac: ["audio", 200],
  png: ["image", 25], jpg: ["image", 25], jpeg: ["image", 25], webp: ["image", 25],
};

const STABLE_MS = 2000;

interface Pending { size: number; since: number }
interface Watch { eid: number; watcher: FSWatcher | null; timer: NodeJS.Timeout | null; pending: Map<string, Pending>; busy: Set<string>;
  ingested: number; failed: string[]; ignored: Set<string> }

export interface ImportDeps {
  library: Library;
  upstream: Upstream;
  template(): string;
  log(msg: string): void;
  onChange?(pid: number): void;
}

export class ImportWatcher {
  private deps: ImportDeps;
  private watches = new Map<number, Watch>();

  constructor(deps: ImportDeps) {
    this.deps = deps;
  }

  status(pid: number): { watching: boolean; pending: number; ingested: number; failed: string[] } {
    const w = this.watches.get(pid);
    const mirror = this.deps.library.existingMirror(pid);
    const ingested = mirror ? mirror.files({ folder: "Imports" }).filter((f) => f.ingested).length : w?.ingested ?? 0;
    return { watching: Boolean(w?.watcher), pending: w ? w.pending.size + w.busy.size : 0, ingested, failed: w ? [...w.failed] : [] };
  }

  setWatching(pid: number, eid: number, on: boolean): void {
    const cur = this.watches.get(pid);
    if (cur) {
      cur.watcher?.close();
      if (cur.timer) clearInterval(cur.timer);
      this.watches.delete(pid);
    }
    if (!on) return;
    const dir = path.join(this.deps.library.folderFor(pid).path, "Imports");
    const w: Watch = { eid, watcher: null, timer: null, pending: new Map(), busy: new Set(), ingested: 0, failed: [], ignored: new Set() };
    this.watches.set(pid, w);
    void fsp.mkdir(dir, { recursive: true }).then(async () => {
      if (this.watches.get(pid) !== w) return;
      w.watcher = watch(dir, { persistent: false }, (_ev, name) => { if (name) this.seen(pid, w, String(name)); });
      w.watcher.on("error", (e) => this.deps.log(`imports watch ${pid}: ${e.message}`));
      for (const name of await fsp.readdir(dir)) this.seen(pid, w, name);
      w.timer = setInterval(() => void this.tick(pid, w, dir), 1000);
      w.timer.unref?.();
      this.deps.onChange?.(pid);
    }).catch((e) => this.deps.log(`imports ${pid}: ${(e as Error).message}`));
  }

  stopAll(): void {
    for (const pid of [...this.watches.keys()]) this.setWatching(pid, 0, false);
  }

  private known(pid: number, name: string): boolean {
    const mirror = this.deps.library.existingMirror(pid);
    if (!mirror) return false;
    const rel = `Imports/${name}`;
    return mirror.files({ folder: "Imports" }).some((f) => pathKey(f.local_path) === pathKey(rel));
  }

  private seen(pid: number, w: Watch, name: string): void {
    if (name.startsWith(".") || /\.(part|tmp|crdownload|download)$/i.test(name) || w.busy.has(name) || w.ignored.has(name)) return;
    if (!w.pending.has(name)) w.pending.set(name, { size: -1, since: Date.now() });
  }

  private async tick(pid: number, w: Watch, dir: string): Promise<void> {
    for (const [name, p] of [...w.pending]) {
      const abs = path.join(dir, name);
      let size: number;
      try {
        const st = await fsp.stat(abs);
        if (!st.isFile()) { w.pending.delete(name); continue; }
        size = st.size;
      } catch {
        w.pending.delete(name); // gone again
        continue;
      }
      if (size !== p.size) {
        w.pending.set(name, { size, since: Date.now() });
        continue;
      }
      if (size === 0 || Date.now() - p.since < STABLE_MS) continue;
      w.pending.delete(name);
      if (this.known(pid, name)) { w.ignored.add(name); continue; }
      const ext = path.extname(name).slice(1).toLowerCase();
      const kind = IMPORT_KINDS[ext];
      if (!kind) {
        w.ignored.add(name);
        w.failed.push(`${name}: not a video, sound or picture the timeline can use`);
        continue;
      }
      if (size > kind[1] * 1024 * 1024) {
        w.ignored.add(name);
        w.failed.push(`${name}: too large (max ${kind[1]} MB for ${kind[0]})`);
        continue;
      }
      w.busy.add(name);
      this.ingest(pid, w, dir, name, size)
        .catch((e) => { w.failed.push(`${name}: ${(e as Error).message}`); w.ignored.add(name); })
        .finally(() => { w.busy.delete(name); this.deps.onChange?.(pid); });
    }
  }

  private async ingest(pid: number, w: Watch, dir: string, name: string, size: number): Promise<void> {
    const abs = path.join(dir, name);
    // 1. the series name first (the next IMP_ number, then the Imports template): the server files media whose name
    //    starts with IMP_ under Imports in the manifest, so the next sync leaves it where it is
    let seq = 0;
    for (const n of await fsp.readdir(dir)) {
      const m = /^IMP_(\d+)/i.exec(n);
      if (m) seq = Math.max(seq, Number(m[1]));
    }
    const ext = path.extname(name);
    const label = safePart(path.basename(name, ext)).slice(0, 60) || "import";
    const kind = IMPORT_KINDS[ext.slice(1).toLowerCase()]?.[0] ?? "";
    let base = renderTemplate(this.deps.template() || "IMP_{seq:04}_{label}", { seq: seq + 1, label, kind, id: "" });
    if (!/^IMP_/i.test(base)) base = `IMP_${base}`;
    const taken = new Set((await fsp.readdir(dir)).map((n) => pathKey(path.join(dir, n))));
    let target = uniquePath(path.join(dir, `${base}${ext.toLowerCase()}`), taken);
    w.ignored.add(path.basename(target));
    try {
      await fsp.rename(abs, target);
    } catch {
      target = abs; // still locked by whatever copied it in: keep its name, upload it under the IMP_ name anyway
    }
    // 2. upload
    const form = new FormData();
    form.append("file", await openAsBlob(target), `${base}${ext.toLowerCase()}`);
    const item = await this.deps.upstream.json<{ src: string; kind: string; name: string; duration: number }>(
      `/api/episodes/${w.eid}/media`, { method: "POST", body: form, timeoutMs: 15 * 60_000 });
    const mirror = this.deps.library.mirror(pid);
    const rel = `Imports/${path.basename(target)}`;
    mirror.upsertFile({ key: item.src, project_id: pid, episode_id: w.eid, local_path: rel, name: path.basename(target), folder: "Imports",
      kind: item.kind, role: "import", size, state: "ready", ingested: 1, synced_at: new Date().toISOString(), item: JSON.stringify(item) });
    w.ingested++;
    this.deps.log(`imported ${name} as ${item.src}`);
    if (!existsSync(target)) this.deps.log(`imports: ${target} vanished after upload`);
  }
}
