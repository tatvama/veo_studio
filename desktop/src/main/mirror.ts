/**
 * The SQLite mirror of a project (`<project folder>/.tatvam/mirror.sqlite`, node:sqlite): what the server said
 * (projects, episodes, shots), which local file holds which storage key, the offline write queue and the API cache.
 * The same class also backs the app-wide offline store in userData (for pages that aren't tied to a synced project).
 * File paths are stored relative to the project folder (with "/"), so moving the folder needs no rewrite.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type FileState = "pending" | "downloading" | "ready" | "failed" | "unlinked";

export interface FileRow {
  key: string;
  project_id: number;
  episode_id: number | null;
  shot_id: number | null;
  local_path: string;
  name: string;
  folder: string;
  kind: string;
  role: string;
  size: number;
  etag: string;
  state: FileState;
  synced_at: string;
  uploaded: number;
  ingested: number;
  proxy_path: string;
  /** The manifest item as JSON (for re-naming and the EDL). */
  item: string;
}

export interface QueueRow { id: number; method: string; path: string; body: string; created_at: string; tries: number; last_error: string }
export interface CacheRow { path: string; body: string; etag: string; saved_at: string }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, title TEXT, aspect TEXT, data TEXT, synced_at TEXT);
CREATE TABLE IF NOT EXISTS episodes (id INTEGER PRIMARY KEY, project_id INTEGER, number INTEGER, season INTEGER,
  title TEXT, cut_version INTEGER, data TEXT, synced_at TEXT);
CREATE TABLE IF NOT EXISTS shots (id INTEGER PRIMARY KEY, episode_id INTEGER, code TEXT, ord INTEGER, cut_index INTEGER,
  include INTEGER, scene_id INTEGER, scene_order INTEGER, status TEXT, duration_s REAL, data TEXT);
CREATE TABLE IF NOT EXISTS files (key TEXT PRIMARY KEY, project_id INTEGER, episode_id INTEGER, shot_id INTEGER,
  local_path TEXT, name TEXT, folder TEXT, kind TEXT DEFAULT '', role TEXT DEFAULT '', size INTEGER DEFAULT 0,
  etag TEXT DEFAULT '', state TEXT DEFAULT 'pending', synced_at TEXT DEFAULT '', uploaded INTEGER DEFAULT 0,
  ingested INTEGER DEFAULT 0, proxy_path TEXT DEFAULT '', item TEXT DEFAULT '{}');
CREATE INDEX IF NOT EXISTS files_state ON files(state);
CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT, method TEXT, path TEXT, body TEXT,
  created_at TEXT, tries INTEGER DEFAULT 0, last_error TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS api_cache (path TEXT PRIMARY KEY, body TEXT, etag TEXT DEFAULT '', saved_at TEXT);
`;

const FILE_COLS: (keyof FileRow)[] = ["key", "project_id", "episode_id", "shot_id", "local_path", "name", "folder", "kind", "role",
  "size", "etag", "state", "synced_at", "uploaded", "ingested", "proxy_path", "item"];

type SqlValue = string | number | null;

export class Mirror {
  readonly dbFile: string;
  private db: DatabaseSync;

  constructor(file: string) {
    this.dbFile = file;
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;");
    this.db.exec(SCHEMA);
    if (!this.getMeta("schema")) this.setMeta("schema", "1");
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }

  // ── meta ──
  getMeta(k: string): string | undefined {
    const r = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined;
    return r?.v;
  }
  setMeta(k: string, v: string): void {
    this.db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  // ── what the server said ──
  upsertProject(p: { id: number; title?: string; aspect?: string; [k: string]: unknown }): void {
    this.db.prepare(`INSERT INTO projects(id, title, aspect, data, synced_at) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, aspect = excluded.aspect, data = excluded.data, synced_at = excluded.synced_at`)
      .run(p.id, p.title ?? "", p.aspect ?? "", JSON.stringify(p), new Date().toISOString());
  }
  project(id: number): { id: number; title: string; aspect: string; data: Record<string, unknown> } | undefined {
    const r = this.db.prepare("SELECT id, title, aspect, data FROM projects WHERE id = ?").get(id) as
      { id: number; title: string; aspect: string; data: string } | undefined;
    return r ? { ...r, data: JSON.parse(r.data || "{}") } : undefined;
  }
  upsertEpisode(projectId: number, e: { id: number; number?: number; season?: number; title?: string; cut_version?: number | null;
    shots?: Array<Record<string, unknown>>; [k: string]: unknown }): void {
    const now = new Date().toISOString();
    const { shots, ...rest } = e;
    this.db.prepare(`INSERT INTO episodes(id, project_id, number, season, title, cut_version, data, synced_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, number = excluded.number, season = excluded.season,
      title = excluded.title, cut_version = excluded.cut_version, data = excluded.data, synced_at = excluded.synced_at`)
      .run(e.id, projectId, e.number ?? 0, e.season ?? 1, e.title ?? "", e.cut_version ?? null, JSON.stringify(rest), now);
    if (shots) {
      this.db.prepare("DELETE FROM shots WHERE episode_id = ?").run(e.id);
      const ins = this.db.prepare(`INSERT OR REPLACE INTO shots(id, episode_id, code, ord, cut_index, include, scene_id, scene_order,
        status, duration_s, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const s of shots) {
        ins.run(Number(s.id), e.id, String(s.code ?? ""), Number(s.order ?? 0), s.cut_index == null ? null : Number(s.cut_index),
          s.include ? 1 : 0, s.scene_id == null ? null : Number(s.scene_id), s.scene_order == null ? null : Number(s.scene_order),
          String(s.status ?? ""), Number(s.duration_s ?? 0), JSON.stringify(s));
      }
    }
  }
  episodes(projectId: number): Array<{ id: number; number: number; season: number; title: string; cut_version: number | null }> {
    return this.db.prepare("SELECT id, number, season, title, cut_version FROM episodes WHERE project_id = ? ORDER BY season, number")
      .all(projectId) as never;
  }

  // ── files ──
  file(key: string): FileRow | undefined {
    return this.db.prepare("SELECT * FROM files WHERE key = ?").get(key) as FileRow | undefined;
  }
  files(where: { state?: FileState; folder?: string; episodeId?: number } = {}): FileRow[] {
    const cond: string[] = [];
    const args: SqlValue[] = [];
    if (where.state) { cond.push("state = ?"); args.push(where.state); }
    if (where.folder) { cond.push("folder = ?"); args.push(where.folder); }
    if (where.episodeId !== undefined) { cond.push("episode_id = ?"); args.push(where.episodeId); }
    const sql = `SELECT * FROM files${cond.length ? ` WHERE ${cond.join(" AND ")}` : ""} ORDER BY local_path`;
    return this.db.prepare(sql).all(...args) as unknown as FileRow[];
  }
  upsertFile(row: Partial<FileRow> & { key: string }): void {
    const cur = this.file(row.key);
    const merged: FileRow = {
      project_id: 0, episode_id: null, shot_id: null, local_path: "", name: "", folder: "", kind: "", role: "",
      size: 0, etag: "", state: "pending", synced_at: "", uploaded: 0, ingested: 0, proxy_path: "", item: "{}",
      ...(cur ?? {}), ...row, key: row.key,
    };
    const vals = FILE_COLS.map((c) => merged[c] as SqlValue);
    this.db.prepare(`INSERT OR REPLACE INTO files(${FILE_COLS.join(", ")}) VALUES(${FILE_COLS.map(() => "?").join(", ")})`).run(...vals);
  }
  setFile(key: string, patch: Partial<FileRow>): void {
    const keys = Object.keys(patch).filter((k) => k !== "key" && FILE_COLS.includes(k as keyof FileRow));
    if (!keys.length) return;
    this.db.prepare(`UPDATE files SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE key = ?`)
      .run(...keys.map((k) => (patch as Record<string, SqlValue>)[k]), key);
  }
  deleteFile(key: string): void {
    this.db.prepare("DELETE FROM files WHERE key = ?").run(key);
  }
  /** Runs `fn` in one transaction (many file updates after a rename plan). */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ── offline write queue ──
  enqueue(w: { method: string; path: string; body: string; created_at?: string }): number {
    const r = this.db.prepare("INSERT INTO queue(method, path, body, created_at) VALUES(?, ?, ?, ?)")
      .run(w.method, w.path, w.body, w.created_at ?? new Date().toISOString());
    return Number(r.lastInsertRowid);
  }
  queued(): QueueRow[] {
    return this.db.prepare("SELECT * FROM queue ORDER BY created_at, id").all() as unknown as QueueRow[];
  }
  queueCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM queue").get() as { n: number }).n);
  }
  dequeue(id: number): void {
    this.db.prepare("DELETE FROM queue WHERE id = ?").run(id);
  }
  queueFailed(id: number, error: string): void {
    this.db.prepare("UPDATE queue SET tries = tries + 1, last_error = ? WHERE id = ?").run(error.slice(0, 500), id);
  }

  // ── API cache (successful JSON GETs, path + query) ──
  cacheGet(p: string): CacheRow | undefined {
    return this.db.prepare("SELECT * FROM api_cache WHERE path = ?").get(p) as CacheRow | undefined;
  }
  cachePut(p: string, body: string, etag = ""): void {
    this.db.prepare(`INSERT INTO api_cache(path, body, etag, saved_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET body = excluded.body, etag = excluded.etag, saved_at = excluded.saved_at`)
      .run(p, body, etag, new Date().toISOString());
  }
  cacheEntries(prefix = ""): CacheRow[] {
    return this.db.prepare("SELECT * FROM api_cache WHERE substr(path, 1, ?) = ?").all(prefix.length, prefix) as unknown as CacheRow[];
  }
}
