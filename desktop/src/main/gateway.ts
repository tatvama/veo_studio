/**
 * The local gateway (docs/DESKTOP.md §1): an HTTP server on 127.0.0.1 that
 *  - serves the bundled UI with an SPA fallback,
 *  - forwards /api, /media, /mcp and /.well-known to the studio server (streaming both ways, Range kept,
 *    Set-Cookie made to stick on 127.0.0.1, redirects to the server pointed back at the gateway),
 *  - forwards the /api/ws WebSocket upgrade,
 *  - serves /media/<key> from the local project folder when that file is there (a proxy file in proxy mode),
 *  - keeps working offline: cached GETs answer, cut edits are queued and applied optimistically, replayed on reconnect.
 * No Electron imports: tests start it against a fake upstream (test/gateway.test.ts).
 */
import { createReadStream, promises as fsp, type Stats } from "node:fs";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import type { OfflineStatus } from "../shared/types.ts";
import type { CacheRow, QueueRow } from "./mirror.ts";
import {
  applyOptimistic, isCacheableGet, isNetworkError, matchCutWrite, pathnameOf, projectOf, replayQueue, rewriteLocation,
  rewriteSetCookie, type SendResult,
} from "./offline.ts";

/** The part of a Mirror the gateway needs for one project's (or the app-wide) offline data. */
export interface OfflineDb {
  cacheGet(p: string): CacheRow | undefined;
  cachePut(p: string, body: string, etag?: string): void;
  cacheEntries(prefix?: string): CacheRow[];
  enqueue(w: { method: string; path: string; body: string }): number;
  queued(): QueueRow[];
  queueCount(): number;
  dequeue(id: number): void;
  queueFailed(id: number, error: string): void;
}

export interface OfflineStore {
  /** The store for a project (its mirror when it has a folder), or the app-wide one for null. */
  forProject(pid: number | null): OfflineDb;
  /** Every store that may hold queued writes. */
  all(): OfflineDb[];
}

export interface GatewayDeps {
  upstream(): string;
  /** Folder of the built UI; null forwards the UI to the server too. */
  uiDir(): string | null;
  uiSource(): "bundled" | "server";
  /** Absolute path of a local copy of a storage key (proxy-aware), or null. */
  resolveMedia?(key: string): string | null;
  store: OfflineStore;
  /** The session cookie header to replay queued writes with (defaults to the last one the UI sent). */
  getCookie?(): Promise<string | undefined>;
  onStatus?(s: OfflineStatus): void;
  log?(msg: string): void;
  healthIntervalMs?: number;
  connectTimeoutMs?: number;
}

const UPSTREAM_PREFIXES = ["/api/", "/media/", "/mcp", "/.well-known/"];
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade"]);
const MAX_CACHE_BODY = 5 * 1024 * 1024;
const MAX_WRITE_BODY = 10 * 1024 * 1024;
const COOKIE = "veo_session";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
  ".map": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".avif": "image/avif", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".srt": "text/plain; charset=utf-8", ".vtt": "text/vtt; charset=utf-8", ".ass": "text/plain; charset=utf-8", ".cube": "text/plain",
  ".xml": "application/xml", ".fcpxml": "application/xml", ".edl": "text/plain; charset=utf-8", ".pdf": "application/pdf",
};

export function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** Parse one `Range: bytes=…` header against a size. null = no (usable) range, "invalid" = 416. */
export function parseRange(h: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === "" && m[2] === "")) return h.includes(",") ? null : "invalid"; // multi-range: send it all
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length, "Cache-Control": "no-store", ...extra });
  res.end(data);
}

function readBody(req: IncomingMessage, limit = MAX_WRITE_BODY): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function decodeBody(buf: Buffer, encoding: string | undefined): string {
  const enc = (encoding || "").toLowerCase();
  if (enc === "gzip") return zlib.gunzipSync(buf).toString("utf8");
  if (enc === "br") return zlib.brotliDecompressSync(buf).toString("utf8");
  if (enc === "deflate") return zlib.inflateSync(buf).toString("utf8");
  return buf.toString("utf8");
}

/** Serve a file with ETag / Last-Modified / Range (206) support. */
export async function serveFile(req: IncomingMessage, res: ServerResponse, file: string, opts: { cacheControl?: string; stat?: Stats } = {}): Promise<void> {
  const st = opts.stat ?? (await fsp.stat(file));
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const lastModified = new Date(st.mtimeMs).toUTCString();
  const base: Record<string, string | number> = {
    "Content-Type": mimeOf(file), "Accept-Ranges": "bytes", ETag: etag, "Last-Modified": lastModified,
    "Cache-Control": opts.cacheControl ?? "private, max-age=0, must-revalidate", "X-Content-Type-Options": "nosniff",
  };
  const inm = req.headers["if-none-match"];
  const ims = req.headers["if-modified-since"];
  if ((inm && inm.split(",").map((s) => s.trim()).includes(etag)) || (!inm && ims && Date.parse(ims) >= Math.floor(st.mtimeMs / 1000) * 1000)) {
    res.writeHead(304, base);
    res.end();
    return;
  }
  let range = parseRange(req.headers.range, st.size);
  const ifRange = req.headers["if-range"];
  if (range && ifRange && ifRange !== etag && ifRange !== lastModified) range = null; // changed since: send it all
  if (range === "invalid") {
    res.writeHead(416, { ...base, "Content-Range": `bytes */${st.size}` });
    res.end();
    return;
  }
  const head = req.method === "HEAD";
  if (range) {
    res.writeHead(206, { ...base, "Content-Range": `bytes ${range.start}-${range.end}/${st.size}`, "Content-Length": range.end - range.start + 1 });
    if (head) { res.end(); return; }
    createReadStream(file, { start: range.start, end: range.end }).on("error", () => res.destroy()).pipe(res);
    return;
  }
  res.writeHead(200, { ...base, "Content-Length": st.size });
  if (head) { res.end(); return; }
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

export class Gateway {
  readonly deps: GatewayDeps;
  readonly server: http.Server;
  port = 0;
  online = true;
  lastError: string | undefined;
  private lastCookie: string | undefined;
  private healthTimer: NodeJS.Timeout | null = null;
  private replaying: Promise<void> | null = null;
  private sockets = new Set<Socket>();

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.log(`gateway error ${req.method} ${req.url}: ${(e as Error).stack || e}`);
        if (!res.headersSent) sendJson(res, (e as { status?: number }).status ?? 500, { detail: String((e as Error).message || e) });
        else res.destroy();
      });
    });
    this.server.on("upgrade", (req, socket, head) => this.upgrade(req, socket as Socket, head));
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Listen on 127.0.0.1, trying `preferred` and then the next ports. Returns the port in use. */
  async listen(preferred: number, tries = 20): Promise<number> {
    for (let i = 0; i < tries; i++) {
      const port = preferred + i;
      const ok = await new Promise<boolean>((resolve, reject) => {
        const onErr = (e: NodeJS.ErrnoException) => {
          this.server.off("listening", onOk);
          if (e.code === "EADDRINUSE" || e.code === "EACCES") resolve(false);
          else reject(e);
        };
        const onOk = () => {
          this.server.off("error", onErr);
          resolve(true);
        };
        this.server.once("error", onErr);
        this.server.once("listening", onOk);
        this.server.listen(port, "127.0.0.1");
      });
      if (ok) {
        this.port = (this.server.address() as { port: number }).port;
        return this.port;
      }
    }
    throw new Error(`No free port from ${preferred} to ${preferred + tries - 1}`);
  }

  async close(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  status(): OfflineStatus {
    let queued = 0;
    for (const db of this.deps.store.all()) {
      try { queued += db.queueCount(); } catch { /* closed */ }
    }
    return { online: this.online, queued, ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  /** Try to send the queued writes now (checks the server first). */
  async flush(): Promise<void> {
    if (await this.checkHealth()) {
      this.setOnline(true);
      await this.replay();
    }
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }

  private emit(): void {
    this.deps.onStatus?.(this.status());
  }

  private gatewayOrigin(): string {
    return this.url;
  }

  private setOnline(on: boolean, err?: unknown): void {
    if (!on && err) this.lastError = String((err as Error).message || err);
    if (on === this.online) return;
    this.online = on;
    this.log(on ? "server reachable again" : `server unreachable: ${this.lastError}`);
    if (!on && !this.healthTimer) {
      this.healthTimer = setInterval(() => {
        this.checkHealth().then((ok) => {
          if (ok) {
            this.setOnline(true);
            void this.replay();
          }
        }, () => undefined);
      }, this.deps.healthIntervalMs ?? 5000);
      this.healthTimer.unref?.();
    }
    if (on && this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.emit();
  }

  private checkHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      let up: URL;
      try { up = new URL("/api/health/live", this.deps.upstream()); } catch { resolve(false); return; }
      const mod = up.protocol === "https:" ? https : http;
      const r = mod.get(up, { timeout: 4000 }, (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 500);
      });
      r.on("timeout", () => r.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
      r.on("error", () => resolve(false));
    });
  }

  private async replay(): Promise<void> {
    if (this.replaying) return this.replaying;
    this.replaying = (async () => {
      try {
        for (const db of this.deps.store.all()) {
          const rows = db.queued();
          if (!rows.length) continue;
          const cookie = (await this.deps.getCookie?.()) ?? this.lastCookie;
          const out = await replayQueue(rows, {
            send: (method, p, body) => this.send(method, p, body, cookie),
            layersRev: async (eid) => {
              const r = await this.send("GET", `/api/episodes/${eid}/layers`, "", cookie);
              return Number((r.json as { rev?: number } | undefined)?.rev ?? 0);
            },
            done: (id) => db.dequeue(id),
            failed: (id, error, drop) => {
              this.log(`queued write ${id} failed${drop ? " (dropped)" : ""}: ${error}`);
              if (drop) db.dequeue(id);
              else db.queueFailed(id, error);
            },
          });
          if (out.lastError) this.lastError = out.lastError;
          if (out.stoppedOffline) {
            this.setOnline(false, out.lastError);
            break;
          }
          this.log(`replayed ${out.sent} queued edit(s), dropped ${out.dropped}`);
        }
      } finally {
        this.replaying = null;
        this.emit();
      }
    })();
    return this.replaying;
  }

  /** One request to the server from the gateway itself (queue replay). */
  private send(method: string, p: string, body: string, cookie?: string): Promise<SendResult> {
    return new Promise((resolve, reject) => {
      const up = new URL(p, this.deps.upstream());
      const mod = up.protocol === "https:" ? https : http;
      const data = body ? Buffer.from(body) : undefined;
      const headers: Record<string, string | number> = { "X-Requested-With": "veo-studio", Accept: "application/json" };
      if (cookie) headers.Cookie = cookie.includes("=") ? cookie : `${COOKIE}=${cookie}`;
      if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = data.length; }
      const r = mod.request(up, { method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolve({ status: res.statusCode ?? 0, json, text: text.slice(0, 500) });
        });
        res.on("error", reject);
      });
      this.connectTimeout(r);
      r.on("error", reject);
      r.end(data);
    });
  }

  private connectTimeout(r: http.ClientRequest): void {
    const ms = this.deps.connectTimeoutMs ?? 8000;
    r.on("socket", (s: Socket) => {
      if (!s.connecting) return;
      const t = setTimeout(() => r.destroy(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })), ms);
      s.once("connect", () => clearTimeout(t));
      s.once("close", () => clearTimeout(t));
    });
  }

  private hostOk(req: IncomingMessage): boolean {
    const host = (req.headers.host || "").toLowerCase();
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || "/";
    const pathname = pathnameOf(url);
    if (!this.hostOk(req)) { // DNS-rebinding guard: only pages on this very origin get answers
      sendJson(res, 421, { detail: "Wrong host" });
      return;
    }
    if (req.headers.cookie) {
      const v = cookieValue(req.headers.cookie, COOKIE);
      if (v) this.lastCookie = `${COOKIE}=${v}`;
    }
    if (pathname.startsWith("/__desktop/")) { // reserved; native powers go over IPC, never over HTTP
      sendJson(res, 404, { detail: "Not found" });
      return;
    }
    if (UPSTREAM_PREFIXES.some((p) => pathname.startsWith(p) || pathname === p.replace(/\/$/, ""))) {
      if (pathname.startsWith("/media/") && (req.method === "GET" || req.method === "HEAD") && (await this.serveLocalMedia(req, res, pathname))) return;
      await this.forward(req, res);
      return;
    }
    const dir = this.deps.uiSource() === "bundled" ? this.deps.uiDir() : null;
    if (!dir) {
      await this.forward(req, res);
      return;
    }
    await this.serveStatic(req, res, dir, pathname);
  }

  private async serveLocalMedia(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (!this.deps.resolveMedia) return false;
    let key: string;
    try { key = decodeURIComponent(pathname.slice("/media/".length)); } catch { return false; }
    const file = this.deps.resolveMedia(key);
    if (!file) return false;
    // Local copies are only for this app's own pages: the request must carry the session the app holds.
    const sent = cookieValue(req.headers.cookie, COOKIE);
    const held = cookieValue((await this.deps.getCookie?.()) ?? this.lastCookie, COOKIE);
    if (!sent || !held || sent !== held) return false;
    let st: Stats;
    try {
      st = await fsp.stat(file);
      if (!st.isFile()) return false;
    } catch {
      return false;
    }
    await serveFile(req, res, file, { stat: st, cacheControl: "private, max-age=0, must-revalidate" });
    return true;
  }

  private async serveStatic(req: IncomingMessage, res: ServerResponse, dir: string, pathname: string): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { detail: "Method not allowed" });
      return;
    }
    let rel: string;
    try { rel = decodeURIComponent(pathname); } catch { rel = pathname; }
    const root = path.resolve(dir);
    const file = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
      sendJson(res, 403, { detail: "Forbidden" });
      return;
    }
    let st: Stats | null = null;
    try { st = await fsp.stat(file); } catch { st = null; }
    if (st?.isFile()) {
      const immutable = rel.replace(/^\/+/, "").startsWith("assets/");
      await serveFile(req, res, file, { stat: st, cacheControl: immutable ? "public, max-age=31536000, immutable" : "no-cache" });
      return;
    }
    const last = rel.split("/").pop() || "";
    if (last.includes(".") && !last.endsWith(".html")) {
      sendJson(res, 404, { detail: "Not found" });
      return;
    }
    const index = path.join(root, "index.html");
    try {
      await serveFile(req, res, index, { cacheControl: "no-cache" });
    } catch {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Tatvam Studio</h1><p>The UI isn't built. Build frontend/ or set uiSource to \"server\".</p>");
    }
  }

  private upstreamHeaders(req: IncomingMessage, up: URL): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    const gw = this.gatewayOrigin();
    for (const [k, v] of Object.entries(req.headers as IncomingHttpHeaders)) {
      if (v === undefined || HOP.has(k)) continue;
      out[k] = v;
    }
    out.host = up.host;
    if (typeof out.origin === "string" && out.origin === gw) out.origin = up.origin;
    if (typeof out.referer === "string" && out.referer.startsWith(gw)) out.referer = up.origin + out.referer.slice(gw.length);
    return out;
  }

  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || "/";
    const method = (req.method || "GET").toUpperCase();
    const cut = matchCutWrite(method, url);
    const isApi = pathnameOf(url).startsWith("/api/");
    let body: Buffer | undefined;
    if (cut) body = await readBody(req); // small JSON: buffered so it can be queued if the server is gone
    if (!this.online && isApi) {
      await this.offlineAnswer(req, res, body);
      return;
    }
    let up: URL;
    try { up = new URL(url, this.deps.upstream()); } catch {
      sendJson(res, 502, { detail: "The server address in Settings isn't valid" });
      return;
    }
    const cacheable = method === "GET" && isApi && isCacheableGet(url);
    const headers = this.upstreamHeaders(req, up);
    if (body) {
      headers["content-length"] = String(body.length);
      delete headers["transfer-encoding"];
    }
    const mod = up.protocol === "https:" ? https : http;
    await new Promise<void>((resolve) => {
      const preq = mod.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, method, path: url, headers }, (pres) => {
        if (!this.online) this.setOnline(true);
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(pres.headers)) {
          if (v === undefined || HOP.has(k)) continue;
          if (k === "set-cookie") outHeaders[k] = (Array.isArray(v) ? v : [v]).map(rewriteSetCookie);
          else if (k === "location" && typeof v === "string") outHeaders[k] = rewriteLocation(v, up.origin, this.gatewayOrigin());
          else outHeaders[k] = v;
        }
        res.writeHead(pres.statusCode ?? 502, pres.statusMessage, outHeaders);
        const ctype = String(pres.headers["content-type"] || "");
        const keep = cacheable && pres.statusCode === 200 && ctype.includes("json");
        const chunks: Buffer[] = [];
        let size = 0;
        if (keep) {
          pres.on("data", (c: Buffer) => {
            size += c.length;
            if (size <= MAX_CACHE_BODY) chunks.push(c);
          });
        }
        pres.on("end", () => {
          if (keep && size <= MAX_CACHE_BODY) {
            try {
              const text = decodeBody(Buffer.concat(chunks), pres.headers["content-encoding"] as string | undefined);
              JSON.parse(text);
              this.deps.store.forProject(projectOf(url, req.headers.referer)).cachePut(url, text, String(pres.headers.etag || ""));
            } catch (e) {
              this.log(`not cached ${url}: ${(e as Error).message}`);
            }
          }
          resolve();
        });
        pres.on("error", () => { res.destroy(); resolve(); });
        pres.pipe(res);
      });
      this.connectTimeout(preq);
      res.on("close", () => {
        if (!res.writableFinished) preq.destroy();
      });
      preq.on("error", (e) => {
        if (res.headersSent) {
          res.destroy();
          resolve();
          return;
        }
        if (isNetworkError(e)) {
          this.setOnline(false, e);
          if (isApi && (method === "GET" || method === "HEAD" || cut)) {
            this.offlineAnswer(req, res, body).then(resolve, resolve);
            return;
          }
          sendJson(res, 503, { detail: "The studio server can't be reached", offline: true }, { "X-Tatvam-Offline": "1" });
        } else {
          sendJson(res, 502, { detail: `Gateway error: ${(e as Error).message}` });
        }
        resolve();
      });
      if (body) preq.end(body);
      else req.pipe(preq);
    });
  }

  /** Answer an /api request while the server is unreachable. */
  private async offlineAnswer(req: IncomingMessage, res: ServerResponse, body?: Buffer): Promise<void> {
    const url = req.url || "/";
    const method = (req.method || "GET").toUpperCase();
    const pid = projectOf(url, req.headers.referer);
    const off = { "X-Tatvam-Offline": "1" };
    if (method === "GET" || method === "HEAD") {
      const hit = this.deps.store.forProject(pid).cacheGet(url) ?? (pid !== null ? this.deps.store.forProject(null).cacheGet(url) : undefined);
      if (hit) {
        const data = Buffer.from(hit.body);
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": data.length, "Cache-Control": "no-store", ...off });
        res.end(method === "HEAD" ? undefined : data);
        return;
      }
      sendJson(res, 503, { detail: "You're offline, and this wasn't opened while online", offline: true }, off);
      return;
    }
    const cut = matchCutWrite(method, url);
    if (!cut) {
      sendJson(res, 503, { detail: "You're offline: this needs the studio server", offline: true }, off);
      return;
    }
    const raw = (body ?? (await readBody(req))).toString("utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(raw || "{}"); } catch {
      sendJson(res, 400, { detail: "Invalid JSON" });
      return;
    }
    const db = this.deps.store.forProject(pid);
    db.enqueue({ method, path: url, body: raw });
    const entries = db.cacheEntries("/api/").map((r) => ({ path: r.path, body: JSON.parse(r.body) as unknown }));
    const opt = applyOptimistic(entries, method, url, parsed);
    for (const u of opt.updated) db.cachePut(u.path, JSON.stringify(u.body));
    this.emit();
    sendJson(res, 202, { ...opt.result, queued: true, offline: true }, off);
  }

  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const pathname = pathnameOf(req.url || "/");
    if (!this.hostOk(req) || !pathname.startsWith("/api/ws")) {
      socket.destroy();
      return;
    }
    let up: URL;
    try { up = new URL(req.url || "/", this.deps.upstream()); } catch { socket.destroy(); return; }
    const headers = this.upstreamHeaders(req, up);
    headers.connection = "Upgrade";
    headers.upgrade = String(req.headers.upgrade || "websocket");
    const mod = up.protocol === "https:" ? https : http;
    const preq = mod.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, method: "GET", path: req.url, headers });
    this.connectTimeout(preq);
    socket.on("error", () => preq.destroy());
    preq.on("upgrade", (pres, psocket, phead) => {
      const lines = [`HTTP/1.1 ${pres.statusCode ?? 101} ${pres.statusMessage || "Switching Protocols"}`];
      for (let i = 0; i < pres.rawHeaders.length; i += 2) {
        const k = pres.rawHeaders[i];
        const v = pres.rawHeaders[i + 1];
        lines.push(`${k}: ${k.toLowerCase() === "set-cookie" ? rewriteSetCookie(v) : v}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (phead?.length) socket.write(phead);
      if (head?.length) psocket.write(head);
      psocket.on("error", () => socket.destroy());
      socket.on("error", () => psocket.destroy());
      psocket.on("close", () => socket.destroy());
      socket.on("close", () => psocket.destroy());
      psocket.pipe(socket);
      socket.pipe(psocket);
    });
    preq.on("response", (pres) => { // the server refused the upgrade
      socket.end(`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      pres.resume();
    });
    preq.on("error", (e) => {
      if (isNetworkError(e)) this.setOnline(false, e);
      socket.destroy();
    });
    preq.end();
  }
}
