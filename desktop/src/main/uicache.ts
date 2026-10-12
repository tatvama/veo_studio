/**
 * Screens from the server, with an offline copy (docs/DESKTOP.md §4.3).
 *
 * In `uiSource: "auto"` the gateway serves the UI from, in this order: the server's build (when it's reachable, allowed
 * and compatible), the last good copy of that server's build saved on this PC, then the copy inside the app. Every build
 * is served from disk (`<userData>/ui-cache/<server-hash>/<build>/`), so an index.html and its assets always come from
 * the same build.
 *
 *  - The server's `GET /api/ui/manifest` lists every file with its size and sha256. A new build is built in a temporary
 *    folder (files it already has are copied, the rest downloaded, every sha256 checked) and renamed into place; the
 *    active pointer (state.json) is then swapped atomically. The last 2 builds per server are kept.
 *  - Only ever from `serverUrl`'s own origin, and only over HTTPS or from loopback / private-network addresses.
 *  - A build that needs a newer desktop app (`requires_desktop`) isn't fetched.
 *  - Checks: at start, every 10 minutes, and when the connection comes back.
 *
 * No Electron imports: tests drive it against a fake server (test/uicache.test.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, promises as fsp, readFileSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UiSource, UiStatus } from "../shared/types.ts";
import { writeFileAtomic } from "./config.ts";

export interface UiManifestFile { path: string; size: number; sha256: string }
export interface UiManifest { build: string; version: string; built_at: string; requires_desktop: string; files: UiManifestFile[] }

/** What a saved build folder records about itself (written last, so a folder without it is incomplete). */
interface BuildRecord { manifest: UiManifest; installedAt: string; stats: Record<string, [number, number]> }
interface ServerState { server: string; active: string | null; builds: { build: string; installedAt: string; lastActive: string }[] }

export const BUILD_FILE = ".tatvam-build.json";
export const KEEP_BUILDS = 2;
export const CHECK_INTERVAL_MS = 10 * 60 * 1000;

const HEX = /^[0-9a-f]+$/;

// ── pure helpers ─────────────────────────────────────────────────────────────

/** -1 / 0 / 1 for dotted versions ("3.0.0" < "3.10.1"); extra text after a number is ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || "0").split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b || "0").split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function ipv4Private(ip: string): "loopback" | "private" | null {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  if (p[0] === 127) return "loopback";
  if (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)) return "private";
  return null;
}

/**
 * May screens be fetched from this server? HTTPS anywhere; plain HTTP only from loopback (127/8, ::1, localhost) or a
 * private network (10/8, 172.16/12, 192.168/16, fc00::/7, *.local).
 */
export function originRule(serverUrl: string): { ok: boolean; origin?: string; reason?: string } {
  let u: URL;
  try { u = new URL(serverUrl); } catch { return { ok: false, reason: "The server address isn't valid" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "Only http and https servers can serve screens" };
  const origin = u.origin;
  if (u.protocol === "https:") return { ok: true, origin };
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return { ok: true, origin };
  if (host.endsWith(".local")) return { ok: true, origin };
  if (net.isIPv4(host) && ipv4Private(host)) return { ok: true, origin };
  if (net.isIPv6(host)) {
    if (host === "::1") return { ok: true, origin };
    const first = Number.parseInt(host.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return { ok: true, origin }; // fc00::/7
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
    if (mapped && ipv4Private(mapped)) return { ok: true, origin };
  }
  return { ok: false, origin, reason: `${u.host} is a public address over plain http: screens are only fetched over https, or from this PC or a local network` };
}

/** Folder name for a server: the first 12 hex characters of the sha256 of its origin. */
export function serverKey(serverUrl: string): string {
  let origin = serverUrl;
  try { origin = new URL(serverUrl).origin; } catch { /* hash what we got */ }
  return createHash("sha256").update(origin).digest("hex").slice(0, 12);
}

/** A manifest path that stays inside the build folder: relative, forward slashes, no `..`, no drive letters. */
export function safeRelPath(p: unknown): p is string {
  if (typeof p !== "string" || !p || p.length > 400) return false;
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0") || /^[a-zA-Z]:/.test(p)) return false;
  const parts = p.split("/");
  return parts.every((s) => s && s !== "." && s !== ".." && !/[<>:"|?*]/.test(s)) && !parts.some((s) => s.toLowerCase() === BUILD_FILE);
}

/** The manifest's shape, or an error saying what's wrong. */
export function validateManifest(m: unknown): UiManifest {
  const o = m as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("The manifest isn't an object");
  if (typeof o.build !== "string" || o.build.length < 8 || o.build.length > 64 || !HEX.test(o.build)) throw new Error("The manifest has no valid build id");
  if (!Array.isArray(o.files) || !o.files.length || o.files.length > 20_000) throw new Error("The manifest lists no files");
  const seen = new Set<string>();
  const files: UiManifestFile[] = [];
  let total = 0;
  for (const f of o.files as Record<string, unknown>[]) {
    if (!f || !safeRelPath(f.path)) throw new Error(`Unsafe path in the manifest: ${String(f?.path).slice(0, 80)}`);
    if (typeof f.size !== "number" || !Number.isInteger(f.size) || f.size < 0) throw new Error(`Bad size for ${f.path}`);
    if (typeof f.sha256 !== "string" || f.sha256.length !== 64 || !HEX.test(f.sha256)) throw new Error(`Bad sha256 for ${f.path}`);
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw new Error(`${f.path} is listed twice`);
    seen.add(key);
    total += f.size;
    files.push({ path: f.path, size: f.size, sha256: f.sha256 });
  }
  if (total > 2 * 1024 ** 3) throw new Error("The build is larger than 2 GB");
  const index = files.find((f) => f.path === "index.html");
  if (!index) throw new Error("The manifest has no index.html");
  if (!index.sha256.startsWith(o.build)) throw new Error("The build id isn't the hash of index.html");
  return {
    build: o.build, files,
    version: typeof o.version === "string" ? o.version : "",
    built_at: typeof o.built_at === "string" ? o.built_at : "",
    requires_desktop: typeof o.requires_desktop === "string" ? o.requires_desktop : "0.0.0",
  };
}

/** Which screens new windows get. `envUiDir` (TATVAM_UI_DIR) is a developer override that wins over "auto". */
export function chooseServing(o: { setting: UiSource; envUiDir?: boolean; originOk: boolean; cached: boolean; bundled: boolean }):
  "cache" | "bundled" | "remote" {
  if (o.setting === "server") return "remote";
  if (o.setting === "bundled" || o.envUiDir) return o.bundled ? "bundled" : "remote";
  if (o.originOk && o.cached) return "cache";
  return o.bundled ? "bundled" : "remote";
}

/** rename, retried briefly when Windows holds the file (EPERM / EBUSY / EACCES from a scanner or a reader). */
export async function renameRetry(from: string, to: string, tries = 6): Promise<void> {
  for (let i = 0; ; i++) {
    try { await fsp.rename(from, to); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (i >= tries - 1 || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw e;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("error", reject).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex")));
  });
}

const shortDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

/** "Server build 3f2a9c, 12 Oct", "Offline copy of server build 3f2a9c", "Built into the app 3.1.0", "From the server". */
export function uiLabel(s: { serving: UiStatus["serving"]; build?: string; builtAt?: string; online: boolean; appVersion: string }): string {
  if (s.serving === "cache" && s.build) {
    const b = s.build.slice(0, 6);
    if (!s.online) return `Offline copy of server build ${b}`;
    const d = s.builtAt ? shortDate(s.builtAt) : "";
    return `Server build ${b}${d ? `, ${d}` : ""}`;
  }
  if (s.serving === "bundled") return `Built into the app ${s.appVersion}`;
  if (s.serving === "remote") return "From the server (no offline copy)";
  return "No screens";
}

// ── the cache ────────────────────────────────────────────────────────────────

export interface UiCacheDeps {
  /** <userData>/ui-cache */
  root: string;
  appVersion: string;
  serverUrl(): string;
  setting(): UiSource;
  /** The UI built into the app (resources/web, TATVAM_UI_DIR or ../frontend/dist), or null. */
  bundledDir(): string | null;
  /** TATVAM_UI_DIR is set: serve it whatever the setting (developer override). */
  envOverride?: boolean;
  fetchImpl?: typeof fetch;
  onStatus?(s: UiStatus): void;
  log?(msg: string): void;
  now?(): Date;
  timeoutMs?: number;
}

export class UiCache {
  private deps: UiCacheDeps;
  private key = "";
  private state: ServerState = { server: "", active: null, builds: [] };
  private records = new Map<string, BuildRecord>();
  private online = true;
  private checking: Promise<UiStatus> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastCheck: string | undefined;
  private lastError: string | undefined;
  private notice: string | undefined;
  private serverBuild: string | undefined;
  private bundledBuild: string | undefined;
  private progress: { done: number; total: number } | undefined;
  private lastEmitted = "";

  constructor(deps: UiCacheDeps) {
    this.deps = deps;
  }

  private log(m: string): void { this.deps.log?.(`ui-cache: ${m}`); }
  private now(): Date { return this.deps.now?.() ?? new Date(); }
  private dir(): string { return path.join(this.deps.root, this.key); }
  private buildDir(build: string): string { return path.join(this.dir(), build); }
  private stateFile(): string { return path.join(this.dir(), "state.json"); }

  /** Load the saved state for the current server and fully verify its active build (drops it if it's damaged). */
  async init(): Promise<void> {
    this.loadServer();
    const b = this.deps.bundledDir();
    try { this.bundledBuild = b && existsSync(path.join(b, "index.html")) ? (await sha256File(path.join(b, "index.html"))).slice(0, 12) : undefined; } catch { this.bundledBuild = undefined; }
    if (this.state.active) {
      const bad = await this.verify(this.state.active, true);
      if (bad.length) {
        this.log(`active build ${this.state.active} is damaged (${bad.slice(0, 3).join(", ")}): not served until it's fetched again`);
        this.lastError = `The offline copy was damaged (${bad.length} file${bad.length === 1 ? "" : "s"}); it's fetched again when the server answers`;
        await this.fallBack(this.state.active);
      }
    }
    this.emit();
  }

  /** Switch to the folder of the server now in the settings (after a change of server address). */
  private loadServer(): void {
    const key = serverKey(this.deps.serverUrl());
    if (key === this.key) return;
    this.key = key;
    this.records.clear();
    this.serverBuild = undefined;
    this.lastError = undefined;
    this.notice = undefined;
    let st: ServerState = { server: this.deps.serverUrl(), active: null, builds: [] };
    try {
      const raw = JSON.parse(readFileSync(this.stateFile(), "utf8")) as Partial<ServerState>;
      st = { server: String(raw.server ?? st.server), active: typeof raw.active === "string" ? raw.active : null,
        builds: Array.isArray(raw.builds) ? raw.builds.filter((b) => b && typeof b.build === "string" && HEX.test(b.build)) : [] };
    } catch { /* first time for this server */ }
    for (const b of st.builds) {
      const rec = this.readRecord(b.build);
      if (rec) this.records.set(b.build, rec);
    }
    st.builds = st.builds.filter((b) => this.records.has(b.build));
    if (st.active && !this.records.has(st.active)) st.active = st.builds[0]?.build ?? null;
    this.state = st;
  }

  private readRecord(build: string): BuildRecord | null {
    try {
      const rec = JSON.parse(readFileSync(path.join(this.buildDir(build), BUILD_FILE), "utf8")) as BuildRecord;
      validateManifest(rec.manifest);
      return rec.manifest.build === build ? rec : null;
    } catch {
      return null;
    }
  }

  private saveState(): void {
    writeFileAtomic(this.stateFile(), JSON.stringify(this.state, null, 2));
  }

  /**
   * Files of a saved build that don't match its manifest. Quick: size and modification time against what was recorded
   * at install (a changed file is then hashed); full: every sha256.
   */
  async verify(build: string, full = false): Promise<string[]> {
    const rec = this.records.get(build) ?? this.readRecord(build);
    if (!rec) return ["(no build record)"];
    const dir = this.buildDir(build);
    const bad: string[] = [];
    for (const f of rec.manifest.files) {
      const p = path.join(dir, ...f.path.split("/"));
      let st: { size: number; mtimeMs: number };
      try { st = statSync(p); } catch { bad.push(f.path); continue; }
      if (st.size !== f.size) { bad.push(f.path); continue; }
      const seen = rec.stats[f.path];
      if (!full && seen && seen[0] === st.size && Math.abs(seen[1] - st.mtimeMs) < 1) continue;
      try {
        if ((await sha256File(p)) !== f.sha256) bad.push(f.path);
        else rec.stats[f.path] = [st.size, st.mtimeMs];
      } catch { bad.push(f.path); }
    }
    return bad;
  }

  /** The active build is unusable: use the previous intact one, else none (the copy inside the app). */
  private async fallBack(broken: string): Promise<void> {
    for (const b of this.state.builds) {
      if (b.build === broken) continue;
      if (!(await this.verify(b.build, true)).length) {
        this.state.active = b.build;
        this.saveState();
        this.log(`using the previous build ${b.build}`);
        return;
      }
    }
    this.state.active = null;
    this.saveState();
  }

  private cachedOk(): boolean {
    return Boolean(this.state.active && this.records.has(this.state.active));
  }

  /** Folders the gateway serves the UI from in "auto" (newest first; older builds still answer for open windows' assets). */
  dirs(): string[] | null {
    this.loadServer();
    const s = this.status();
    const bundled = this.deps.bundledDir();
    if (s.serving === "remote") return null;
    if (s.serving === "bundled") return bundled ? [bundled] : null;
    const out: string[] = [];
    if (this.state.active) out.push(this.buildDir(this.state.active));
    for (const b of this.state.builds) if (b.build !== this.state.active) out.push(this.buildDir(b.build));
    if (bundled) out.push(bundled);
    return out;
  }

  status(): UiStatus {
    this.loadServer();
    const setting = this.deps.setting();
    const rule = originRule(this.deps.serverUrl());
    const bundled = Boolean(this.deps.bundledDir());
    const serving = chooseServing({ setting, envUiDir: this.deps.envOverride, originOk: rule.ok, cached: this.cachedOk(), bundled });
    const rec = serving === "cache" && this.state.active ? this.records.get(this.state.active) : undefined;
    const online = this.online;
    // the copy inside the app is named by the same hash, so a server build identical to it is no "new" build
    const build = rec ? rec.manifest.build : serving === "bundled" ? (this.bundledBuild ?? `bundled-${this.deps.appVersion}`) : undefined;
    return {
      source: setting, serving, build, online, checking: Boolean(this.checking),
      label: uiLabel({ serving, build: rec?.manifest.build, builtAt: rec?.manifest.built_at, online, appVersion: this.deps.appVersion }),
      ...(rec ? { builtAt: rec.manifest.built_at, version: rec.manifest.version } : serving === "bundled" ? { version: this.deps.appVersion } : {}),
      ...(this.serverBuild ? { serverBuild: this.serverBuild } : {}),
      ...(this.lastCheck ? { lastCheck: this.lastCheck } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.notice ? { notice: this.notice } : {}),
      originOk: rule.ok, ...(rule.reason ? { originReason: rule.reason } : {}),
      ...(this.deps.envOverride && setting === "auto" ? { notice: "TATVAM_UI_DIR is set: the app serves that folder" } : {}),
      ...(this.progress ? { progress: { ...this.progress } } : {}),
      kept: this.state.builds.map((b) => b.build),
    };
  }

  private emit(): void {
    const s = this.status();
    const sig = JSON.stringify({ ...s, checking: undefined, progress: s.progress ? Math.floor((s.progress.done / Math.max(1, s.progress.total)) * 20) : undefined });
    if (sig === this.lastEmitted) return;
    this.lastEmitted = sig;
    this.deps.onStatus?.(s);
  }

  /** The gateway's view of the connection; coming back online triggers a check. */
  setOnline(on: boolean): void {
    const was = this.online;
    this.online = on;
    if (on && !was) void this.check("reconnect");
    else this.emit();
  }

  start(intervalMs = CHECK_INTERVAL_MS): void {
    this.stop();
    this.timer = setInterval(() => void this.check("timer"), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ask the server for its build and fetch it when it's new (no-op unless the setting is "auto"). */
  check(reason = "manual"): Promise<UiStatus> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      try {
        this.loadServer();
        if (this.deps.setting() !== "auto" || this.deps.envOverride) return this.status();
        this.emit();
        await this.run(reason);
      } catch (e) {
        this.lastError = String((e as Error).message || e);
        this.log(`check (${reason}) failed: ${this.lastError}`);
      } finally {
        this.lastCheck = this.now().toISOString();
        this.checking = null;
        this.progress = undefined;
        this.emit();
      }
      return this.status();
    })();
    return this.checking;
  }

  private fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  private async run(reason: string): Promise<void> {
    const rule = originRule(this.deps.serverUrl());
    if (!rule.ok || !rule.origin) {
      this.lastError = rule.reason;
      return;
    }
    const origin = rule.origin;
    let r: Response;
    try {
      r = await this.fetchImpl()(`${origin}/api/ui/manifest`, { redirect: "error", headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 8000) });
    } catch (e) {
      this.online = false; // the server can't be reached: keep serving what we have
      const err = e as Error & { cause?: { code?: string } };
      throw new Error(err.name === "TimeoutError" ? "The server didn't answer in time" : `The server can't be reached${err.cause?.code ? ` (${err.cause.code})` : ""}`);
    }
    this.online = true;
    if (r.status === 404) {
      this.lastError = "This server doesn't publish its screens (no /api/ui/manifest): using the copy here";
      return;
    }
    if (!r.ok) throw new Error(`The server answered ${r.status} for its screens' manifest`);
    let manifest: UiManifest;
    try { manifest = validateManifest(await r.json()); } catch (e) { throw new Error(`The screens' manifest was rejected: ${(e as Error).message}`); }
    this.serverBuild = manifest.build;
    this.notice = undefined;
    if (compareVersions(manifest.requires_desktop, this.deps.appVersion) > 0) {
      this.notice = `Update Tatvam Desktop to get the newest screens (they need ${manifest.requires_desktop}, this app is ${this.deps.appVersion})`;
      this.lastError = undefined;
      return;
    }
    if (this.state.active === manifest.build && this.records.has(manifest.build)) {
      const bad = await this.verify(manifest.build);
      if (!bad.length) { this.lastError = undefined; return; }
      this.log(`build ${manifest.build}: ${bad.length} damaged file(s), fetching them again (${reason})`);
      await this.repair(origin, manifest.build, bad);
      this.lastError = undefined;
      return;
    }
    if (this.records.has(manifest.build) && !(await this.verify(manifest.build, true)).length) {
      await this.activate(manifest.build);
      this.lastError = undefined;
      return;
    }
    await this.install(origin, manifest);
    await this.activate(manifest.build);
    this.lastError = undefined;
  }

  /** A file of the new build: copied from a saved build (or the app's own copy) with the same hash, else downloaded. */
  private async localCopy(f: UiManifestFile): Promise<string | null> {
    for (const [build, rec] of this.records) {
      const hit = rec.manifest.files.find((x) => x.sha256 === f.sha256 && x.size === f.size);
      if (!hit) continue;
      const p = path.join(this.buildDir(build), ...hit.path.split("/"));
      try { if (statSync(p).size === f.size && (await sha256File(p)) === f.sha256) return p; } catch { /* gone */ }
    }
    const b = this.deps.bundledDir();
    if (b) {
      const p = path.join(b, ...f.path.split("/"));
      try { if (statSync(p).size === f.size && (await sha256File(p)) === f.sha256) return p; } catch { /* not there */ }
    }
    return null;
  }

  private async download(origin: string, f: UiManifestFile, dest: string): Promise<void> {
    const url = `${origin}/${f.path.split("/").map(encodeURIComponent).join("/")}`;
    const r = await this.fetchImpl()(url, { redirect: "error", signal: AbortSignal.timeout(Math.max(30_000, (this.deps.timeoutMs ?? 8000) * 4)) });
    if (!r.ok || !r.body) throw new Error(`${f.path}: the server answered ${r.status}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    const h = createHash("sha256");
    let n = 0;
    const body = Readable.fromWeb(r.body as never);
    body.on("data", (c: Buffer) => { h.update(c); n += c.length; if (n > f.size) body.destroy(new Error(`${f.path} doesn't match the manifest (larger than ${f.size} bytes): rejected`)); });
    await pipeline(body, createWriteStream(part));
    const sum = h.digest("hex");
    if (n !== f.size || sum !== f.sha256) {
      await fsp.rm(part, { force: true });
      throw new Error(`${f.path} doesn't match the manifest (sha256 ${sum.slice(0, 12)}…, expected ${f.sha256.slice(0, 12)}…): rejected`);
    }
    await renameRetry(part, dest);
  }

  private async fetchFile(origin: string, f: UiManifestFile, dest: string): Promise<"copied" | "downloaded"> {
    const local = await this.localCopy(f);
    if (local) {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(local, `${dest}.part`);
      if ((await sha256File(`${dest}.part`)) === f.sha256) {
        await renameRetry(`${dest}.part`, dest);
        return "copied";
      }
      await fsp.rm(`${dest}.part`, { force: true });
    }
    await this.download(origin, f, dest);
    return "downloaded";
  }

  private async pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
    let i = 0;
    let failed: unknown = null;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length && !failed) {
        const x = items[i++];
        try { await fn(x); } catch (e) { failed = failed ?? e; }
      }
    }));
    if (failed) throw failed;
  }

  /** Build the new folder under a temporary name, check every file, then rename it into place. */
  private async install(origin: string, manifest: UiManifest): Promise<void> {
    await fsp.mkdir(this.dir(), { recursive: true });
    const tmp = path.join(this.dir(), `.tmp-${manifest.build}-${process.pid}-${randomBytes(3).toString("hex")}`);
    const total = manifest.files.reduce((a, f) => a + f.size, 0);
    this.progress = { done: 0, total };
    let copied = 0, downloaded = 0;
    try {
      await this.pool(manifest.files, 4, async (f) => {
        const how = await this.fetchFile(origin, f, path.join(tmp, ...f.path.split("/")));
        if (how === "copied") copied++; else downloaded++;
        this.progress = { done: (this.progress?.done ?? 0) + f.size, total };
        this.emit();
      });
      const stats: BuildRecord["stats"] = {};
      for (const f of manifest.files) {
        const st = statSync(path.join(tmp, ...f.path.split("/")));
        stats[f.path] = [st.size, st.mtimeMs];
      }
      const rec: BuildRecord = { manifest, installedAt: this.now().toISOString(), stats };
      await fsp.writeFile(path.join(tmp, BUILD_FILE), JSON.stringify(rec), "utf8");
      const final = this.buildDir(manifest.build);
      if (existsSync(final)) await fsp.rm(final, { recursive: true, force: true }); // an incomplete leftover (no record)
      await renameRetry(tmp, final);
      this.records.set(manifest.build, rec);
      this.log(`installed build ${manifest.build} (${downloaded} downloaded, ${copied} copied)`);
    } catch (e) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
  }

  /** Fetch damaged files of a saved build again, each written next to it and renamed over it. */
  private async repair(origin: string, build: string, bad: string[]): Promise<void> {
    const rec = this.records.get(build);
    if (!rec) return;
    const dir = this.buildDir(build);
    const files = rec.manifest.files.filter((f) => bad.includes(f.path));
    await this.pool(files, 4, async (f) => {
      const dest = path.join(dir, ...f.path.split("/"));
      await this.download(origin, f, dest);
      const st = statSync(dest);
      rec.stats[f.path] = [st.size, st.mtimeMs];
    });
    await fsp.writeFile(path.join(dir, BUILD_FILE), JSON.stringify(rec), "utf8");
    this.log(`repaired ${files.length} file(s) of build ${build}`);
  }

  /** Point new windows at a build (atomic state write) and drop builds beyond the last KEEP_BUILDS. */
  private async activate(build: string): Promise<void> {
    const t = this.now().toISOString();
    const prev = this.state.builds.find((b) => b.build === build);
    const entry = { build, installedAt: prev?.installedAt ?? this.records.get(build)?.installedAt ?? t, lastActive: t };
    this.state = { server: this.deps.serverUrl(), active: build, builds: [entry, ...this.state.builds.filter((b) => b.build !== build)] };
    const drop = this.state.builds.slice(KEEP_BUILDS);
    this.state.builds = this.state.builds.slice(0, KEEP_BUILDS);
    this.saveState();
    for (const d of drop) {
      this.records.delete(d.build);
      // a window may still read a file of it: a failed removal is retried by the next swap's clean-up, never fatal
      await fsp.rm(this.buildDir(d.build), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        .catch((e) => this.log(`couldn't remove ${d.build}: ${(e as Error).message}`));
    }
    this.log(`active build is now ${build}`);
  }

  /** Bytes used by the saved builds of every server (Settings → Storage). */
  async usage(): Promise<number> {
    const walk = async (d: string): Promise<number> => {
      let n = 0;
      let ents: import("node:fs").Dirent[] = [];
      try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return 0; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) n += await walk(p);
        else { try { n += (await fsp.stat(p)).size; } catch { /* gone */ } }
      }
      return n;
    };
    return walk(this.deps.root);
  }

  /** Remove every saved build except the active one of the current server. */
  async clear(): Promise<number> {
    const before = await this.usage();
    let ents: import("node:fs").Dirent[] = [];
    try { ents = await fsp.readdir(this.deps.root, { withFileTypes: true }); } catch { return 0; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name !== this.key) { await fsp.rm(path.join(this.deps.root, e.name), { recursive: true, force: true }).catch(() => undefined); continue; }
      for (const b of await fsp.readdir(this.dir()).catch(() => [] as string[])) {
        if (b === "state.json" || b === this.state.active) continue;
        await fsp.rm(path.join(this.dir(), b), { recursive: true, force: true }).catch(() => undefined);
        this.records.delete(b);
      }
      this.state.builds = this.state.builds.filter((x) => x.build === this.state.active);
      this.saveState();
    }
    this.emit();
    return Math.max(0, before - (await this.usage()));
  }
}
