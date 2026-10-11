/**
 * Server calls from the main process: the session cookie (read from the gateway origin) and X-Requested-With are
 * added, JSON helpers, and a WebSocket listener on /api/ws that tells sync when the project changed.
 * No Electron imports (index.ts injects the cookie getter); Google sign-in lives in signin.ts.
 */
import { WebSocket } from "ws";

export const COOKIE = "veo_session";

export class UpstreamError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown, message?: string) {
    super(message ?? (typeof detail === "string" ? detail : `HTTP ${status}`));
    this.status = status;
    this.detail = detail;
  }
}

export interface UpstreamOptions {
  serverUrl(): string;
  /** The session cookie value (or a full `name=value` pair), if signed in. */
  cookie(): Promise<string | undefined>;
  log?(msg: string): void;
}

export type FetchInit = Omit<RequestInit, "headers"> & { headers?: Record<string, string>; timeoutMs?: number };
export type JsonInit = Omit<FetchInit, "body"> & { body?: unknown };

export class Upstream {
  readonly opts: UpstreamOptions;
  constructor(opts: UpstreamOptions) {
    this.opts = opts;
  }

  url(p: string): string {
    return new URL(p, this.opts.serverUrl()).toString();
  }

  async cookieHeader(): Promise<string | undefined> {
    const c = await this.opts.cookie();
    if (!c) return undefined;
    return c.includes("=") ? c : `${COOKIE}=${c}`;
  }

  async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const h: Record<string, string> = { "X-Requested-With": "veo-studio", Accept: "application/json", ...extra };
    const c = await this.cookieHeader();
    if (c) h.Cookie = c;
    return h;
  }

  async fetch(p: string, init: FetchInit = {}): Promise<Response> {
    const { timeoutMs, headers, ...rest } = init;
    const signal = rest.signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined);
    return fetch(this.url(p), { ...rest, signal, headers: await this.headers(headers) });
  }

  /** JSON request; throws UpstreamError with the server's `detail` on an error status. */
  async json<T = unknown>(p: string, init: JsonInit = {}): Promise<T> {
    const { body, ...rest } = init;
    const isRaw = body === undefined || typeof body === "string" || body instanceof Uint8Array || body instanceof FormData || body instanceof Blob;
    const headers = { ...(rest.headers ?? {}) };
    if (body !== undefined && !isRaw) headers["Content-Type"] = "application/json";
    const r = await this.fetch(p, { timeoutMs: 60_000, ...rest, headers, body: isRaw ? (body as RequestInit["body"]) : JSON.stringify(body) });
    const text = await r.text();
    let data: unknown = undefined;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    if (!r.ok) {
      const detail = (data as { detail?: unknown } | undefined)?.detail ?? data;
      throw new UpstreamError(r.status, detail, `${init.method ?? "GET"} ${p}: ${r.status} ${typeof detail === "string" ? detail : JSON.stringify(detail ?? "")}`.slice(0, 400));
    }
    return data as T;
  }
}

/** Server events that change what the local folder should hold. */
export function isResyncEvent(type: string): boolean {
  return type === "episode.updated" || type === "shot.updated" || type === "export.updated" || type === "project.updated" || type.startsWith("take.");
}

export interface ServerEvent { type: string; project_id?: number | null; payload?: Record<string, unknown> }

/** One WebSocket per watched project; reconnects with backoff; `onEvent` gets every event of that project. */
export class EventsClient {
  private opts: UpstreamOptions & { onEvent(pid: number, ev: ServerEvent): void };
  private sockets = new Map<number, { ws?: WebSocket; timer?: NodeJS.Timeout; tries: number; closed: boolean }>();

  constructor(opts: UpstreamOptions & { onEvent(pid: number, ev: ServerEvent): void }) {
    this.opts = opts;
  }

  watching(pid: number): boolean {
    return this.sockets.has(pid);
  }

  watch(pid: number): void {
    if (this.sockets.has(pid)) return;
    const st = { tries: 0, closed: false } as { ws?: WebSocket; timer?: NodeJS.Timeout; tries: number; closed: boolean };
    this.sockets.set(pid, st);
    void this.connect(pid, st);
  }

  unwatch(pid: number): void {
    const st = this.sockets.get(pid);
    if (!st) return;
    st.closed = true;
    if (st.timer) clearTimeout(st.timer);
    try { st.ws?.close(); } catch { /* ignore */ }
    this.sockets.delete(pid);
  }

  closeAll(): void {
    for (const pid of [...this.sockets.keys()]) this.unwatch(pid);
  }

  private async connect(pid: number, st: { ws?: WebSocket; timer?: NodeJS.Timeout; tries: number; closed: boolean }): Promise<void> {
    if (st.closed) return;
    const base = new URL(this.opts.serverUrl());
    const url = `${base.protocol === "https:" ? "wss" : "ws"}://${base.host}/api/ws?project_id=${pid}`;
    const c = await this.opts.cookie();
    const headers: Record<string, string> = {};
    if (c) headers.Cookie = c.includes("=") ? c : `${COOKIE}=${c}`;
    const ws = new WebSocket(url, { headers, handshakeTimeout: 10_000 });
    st.ws = ws;
    ws.on("open", () => { st.tries = 0; });
    ws.on("message", (data) => {
      try {
        const ev = JSON.parse(String(data)) as ServerEvent;
        if (ev && typeof ev.type === "string" && ev.type !== "presence") this.opts.onEvent(pid, ev);
      } catch { /* not JSON */ }
    });
    const retry = () => {
      if (st.closed || st.timer) return;
      st.tries++;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(st.tries, 5));
      st.timer = setTimeout(() => { st.timer = undefined; void this.connect(pid, st); }, delay);
      st.timer.unref?.();
    };
    ws.on("close", retry);
    ws.on("error", (e) => {
      this.opts.log?.(`events socket for project ${pid}: ${(e as Error).message}`);
      retry();
    });
  }
}

/** Calls `fn(key)` once things have been quiet for `ms` (per key). */
export function keyedDebounce<K>(ms: number, fn: (key: K) => void): { (key: K): void; cancel(key?: K): void } {
  const timers = new Map<K, NodeJS.Timeout>();
  const call = (key: K) => {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    const nt = setTimeout(() => { timers.delete(key); fn(key); }, ms);
    nt.unref?.();
    timers.set(key, nt);
  };
  call.cancel = (key?: K) => {
    for (const [k, t] of timers) if (key === undefined || k === key) { clearTimeout(t); timers.delete(k); }
  };
  return call;
}
