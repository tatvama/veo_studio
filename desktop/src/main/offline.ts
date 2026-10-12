/**
 * Offline cutting, as pure functions the gateway uses (unit tests: test/offline.test.ts):
 *  - which writes are cut edits that may be queued while the server is unreachable (docs/DESKTOP.md §2.1),
 *  - how a queued edit is applied optimistically to the cached GET responses, so the UI shows it at once,
 *  - replaying the queue in order on reconnect (a layers 409 refetches the rev and retries once),
 *  - Set-Cookie / Location rewriting for the gateway origin.
 */

export type CutWriteKind = "layers" | "shot" | "fx" | "overlays" | "reorder" | "episode";
export interface CutWrite { kind: CutWriteKind; id: number }

const CUT_WRITES: { method: string; re: RegExp; kind: CutWriteKind }[] = [
  { method: "PUT", re: /^\/api\/episodes\/(\d+)\/layers$/, kind: "layers" },
  { method: "PATCH", re: /^\/api\/shots\/(\d+)$/, kind: "shot" },
  { method: "PUT", re: /^\/api\/shots\/(\d+)\/fx$/, kind: "fx" },
  { method: "PUT", re: /^\/api\/shots\/(\d+)\/overlays$/, kind: "overlays" },
  { method: "POST", re: /^\/api\/episodes\/(\d+)\/shots\/reorder$/, kind: "reorder" },
  { method: "PATCH", re: /^\/api\/episodes\/(\d+)$/, kind: "episode" },
];

export function pathnameOf(p: string): string {
  const q = p.indexOf("?");
  return q < 0 ? p : p.slice(0, q);
}

/** The cut edit a request is, or null. */
export function matchCutWrite(method: string, url: string): CutWrite | null {
  const p = pathnameOf(url);
  for (const w of CUT_WRITES) {
    if (w.method !== method.toUpperCase()) continue;
    const m = w.re.exec(p);
    if (m) return { kind: w.kind, id: Number(m[1]) };
  }
  return null;
}

/** GETs worth caching for offline use: JSON API reads, minus health, auth flows and the event socket. */
export function isCacheableGet(url: string): boolean {
  const p = pathnameOf(url);
  if (!p.startsWith("/api/")) return false;
  return !/^\/api\/(health|ws|auth\/google|auth\/logout)/.test(p);
}

/** The project a request belongs to: from its path, else from the page that made it (Referer /p/<pid>/… or ?pid=). */
export function projectOf(url: string, referer?: string | null): number | null {
  const m = /^\/api\/projects\/(\d+)/.exec(pathnameOf(url));
  if (m) return Number(m[1]);
  if (referer) {
    try {
      const r = new URL(referer);
      const pm = /^\/p\/(\d+)/.exec(r.pathname);
      if (pm) return Number(pm[1]);
      const q = r.searchParams.get("pid");
      if (q && /^\d+$/.test(q)) return Number(q);
    } catch { /* not a URL */ }
  }
  return null;
}

type Json = unknown;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every object inside any `shots` array of a JSON document, mapped by `fn` (returns a new document). */
function mapShots(doc: Json, fn: (shot: Obj) => Obj): Json {
  if (Array.isArray(doc)) return doc.map((x) => mapShots(x, fn));
  if (!isObj(doc)) return doc;
  const out: Obj = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "shots" && Array.isArray(v)) out[k] = v.map((s) => (isObj(s) ? fn(mapShots(s, fn) as Obj) : s));
    else out[k] = mapShots(v, fn);
  }
  return out;
}

function withClipUrls(tracks: unknown): unknown {
  if (!Array.isArray(tracks)) return [];
  return tracks.map((t) => (isObj(t)
    ? { ...t, clips: Array.isArray(t.clips) ? t.clips.map((c) => (isObj(c) && !c.url && typeof c.src === "string" ? { ...c, url: `/media/${c.src}` } : c)) : [] }
    : t));
}

export interface CacheDoc { path: string; body: Json }
export interface OptimisticResult {
  /** Cache entries that changed (write them back). */
  updated: CacheDoc[];
  /** What the queued write answers with, besides {queued: true, offline: true}. */
  result: Obj;
}

/** Apply a queued cut edit to the cached GET responses. */
export function applyOptimistic(entries: CacheDoc[], method: string, url: string, body: Json): OptimisticResult {
  const w = matchCutWrite(method, url);
  const updated: CacheDoc[] = [];
  let result: Obj = {};
  if (!w || !isObj(body)) return { updated, result };
  const b = body;

  if (w.kind === "layers") {
    const target = `/api/episodes/${w.id}/layers`;
    const rev = Number(b.rev ?? 0) + 1;
    let found = false;
    for (const e of entries) {
      if (pathnameOf(e.path) !== target) continue;
      const cur = isObj(e.body) ? e.body : {};
      const next = { ...cur, video: withClipUrls(b.video), audio: withClipUrls(b.audio),
        holds: b.holds === undefined || b.holds === null ? (cur.holds ?? {}) : b.holds, rev };
      updated.push({ path: e.path, body: next });
      if (!found) result = next;
      found = true;
    }
    if (!found) result = { rev, video: withClipUrls(b.video), audio: withClipUrls(b.audio), holds: b.holds ?? {}, media: [] };
    return { updated, result };
  }

  if (w.kind === "shot" || w.kind === "fx" || w.kind === "overlays") {
    const patch: Obj = w.kind === "shot" ? b : w.kind === "fx" ? { fx: b.fx ?? {} } : { overlays: b.overlays ?? [] };
    const merge = (s: Obj): Obj => (Number(s.id) === w.id ? { ...s, ...patch } : s);
    for (const e of entries) {
      const p = pathnameOf(e.path);
      if (p === `/api/shots/${w.id}` && isObj(e.body) && Number(e.body.id) === w.id) {
        const next = { ...e.body, ...patch };
        updated.push({ path: e.path, body: next });
        if (!Object.keys(result).length) result = next;
        continue;
      }
      if (!p.startsWith("/api/episodes/") && !p.startsWith("/api/projects/")) continue;
      const before = JSON.stringify(e.body);
      const hit: { shot?: Obj } = {};
      const next = mapShots(e.body, (s) => {
        const m = merge(s);
        if (m !== s && !hit.shot) hit.shot = m;
        return m;
      });
      if (JSON.stringify(next) !== before) {
        updated.push({ path: e.path, body: next });
        if (hit.shot && !Object.keys(result).length) result = hit.shot;
      }
    }
    return { updated, result };
  }

  if (w.kind === "reorder") {
    const ids = Array.isArray(b.shot_ids) ? b.shot_ids.map(Number) : [];
    const pos = new Map(ids.map((id, i) => [id, i + 1]));
    for (const e of entries) {
      if (pathnameOf(e.path) !== `/api/episodes/${w.id}` || !isObj(e.body) || !Array.isArray(e.body.shots)) continue;
      const shots = (e.body.shots as Obj[]).map((s): Obj => {
        const o = pos.get(Number(s.id));
        return { ...s, order: o ?? 5000 + Number(s.order ?? 0) };
      });
      shots.sort((a, c) => Number(Boolean(c.include)) - Number(Boolean(a.include)) || Number(a.order) - Number(c.order) || Number(a.id) - Number(c.id));
      updated.push({ path: e.path, body: { ...e.body, shots } });
    }
    return { updated, result: { ok: true } };
  }

  // episode settings (and other episode fields): a shallow merge, settings merged one level deeper like the server
  for (const e of entries) {
    if (pathnameOf(e.path) !== `/api/episodes/${w.id}` || !isObj(e.body)) continue;
    const next: Obj = { ...e.body };
    for (const [k, v] of Object.entries(b)) {
      if (k === "settings" && isObj(v)) next.settings = { ...(isObj(next.settings) ? next.settings : {}), ...v };
      else next[k] = v;
    }
    updated.push({ path: e.path, body: next });
    if (!Object.keys(result).length) result = next;
  }
  return { updated, result };
}

// ── replay ──────────────────────────────────────────────────────────────────

export interface QueuedWrite { id: number; method: string; path: string; body: string; tries: number }
export interface SendResult { status: number; json?: unknown; text?: string }
export interface ReplayIO {
  send(method: string, path: string, body: string): Promise<SendResult>;
  /** The server's current layers rev for an episode (for a 409 retry). */
  layersRev(eid: number): Promise<number>;
  done(id: number): void;
  failed(id: number, error: string, drop: boolean): void;
}
export interface ReplayOutcome { sent: number; dropped: number; stoppedOffline: boolean; lastError?: string }

export function isNetworkError(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string }; name?: string } | null;
  const code = err?.code ?? err?.cause?.code ?? "";
  return ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "EPIPE",
    "ECONNABORTED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "GATEWAY_TIMEOUT"].includes(code)
    || err?.name === "TimeoutError";
}

const MAX_TRIES = 5;

/**
 * Send queued writes in order. Network errors stop the replay (still offline). 2xx → done. A layers 409 refetches
 * the rev and retries once with the queued document. Other 4xx can never succeed (e.g. 423 checked out by someone
 * else): they are dropped with the error kept. 5xx is retried later, up to 5 tries.
 */
export async function replayQueue(rows: QueuedWrite[], io: ReplayIO): Promise<ReplayOutcome> {
  const out: ReplayOutcome = { sent: 0, dropped: 0, stoppedOffline: false };
  for (const row of rows) {
    let r: SendResult;
    try {
      r = await io.send(row.method, row.path, row.body);
      if (r.status === 409) {
        const w = matchCutWrite(row.method, row.path);
        if (w?.kind === "layers") {
          const rev = await io.layersRev(w.id);
          const doc = { ...(JSON.parse(row.body || "{}") as Obj), rev };
          r = await io.send(row.method, row.path, JSON.stringify(doc));
        }
      }
    } catch (e) {
      if (isNetworkError(e)) {
        out.stoppedOffline = true;
        out.lastError = String((e as Error).message || e);
        return out;
      }
      r = { status: 0, text: String((e as Error).message || e) };
    }
    if (r.status >= 200 && r.status < 300) {
      io.done(row.id);
      out.sent++;
      continue;
    }
    const detail = isObj(r.json) && r.json.detail ? String(r.json.detail) : (r.text || `HTTP ${r.status}`);
    const msg = `${row.method} ${pathnameOf(row.path)}: ${detail}`.slice(0, 400);
    out.lastError = msg;
    const retryable = r.status === 0 || r.status >= 500;
    const drop = !retryable || row.tries + 1 >= MAX_TRIES;
    io.failed(row.id, msg, drop);
    if (drop) {
      out.dropped++;
      continue;
    }
    return out; // keep the order: a retryable failure blocks the rest until next time
  }
  return out;
}

// ── header rewriting ───────────────────────────────────────────────────────

/** A server cookie made to stick on http://127.0.0.1: drop `Domain=` and `Secure`, keep HttpOnly / SameSite / Path. */
export function rewriteSetCookie(v: string): string {
  const parts = v.split(";").map((s) => s.trim()).filter(Boolean);
  const kept = parts.filter((p, i) => i === 0 || !/^(domain\s*=|secure$)/i.test(p));
  // SameSite=None requires Secure, so a cookie that loses Secure gets Lax instead of being rejected
  return kept.map((p, i) => (i > 0 && /^samesite\s*=\s*none$/i.test(p) ? "SameSite=Lax" : p)).join("; ");
}

/** A redirect to the server's own origin points back at the gateway, so the window never leaves it. */
export function rewriteLocation(loc: string, upstreamOrigin: string, gatewayOrigin: string): string {
  try {
    const u = new URL(loc, upstreamOrigin);
    const up = new URL(upstreamOrigin);
    if (u.origin === up.origin) return gatewayOrigin + u.pathname + u.search + u.hash;
  } catch { /* leave as is */ }
  return loc;
}
