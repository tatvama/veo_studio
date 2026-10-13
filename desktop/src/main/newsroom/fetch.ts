/**
 * News Room data (docs/EDITOR.md §16.9): a web address for a data source (RSS, JSON, a published sheet's CSV) and a
 * local text file. Owner: nr-data.
 *
 * Web: http / https only, no user name or password in the address. The host is resolved and loopback, private,
 * link-local, multicast and other special addresses (IPv4 and IPv6) are refused, for the first request and after every
 * redirect (at most 5); the socket connects to the address that was checked, so a second DNS answer can't swap it.
 * 20 s in all, at most 10 MB (streamed and stopped past it; the size counts after decompression), no cookies or
 * credentials, User-Agent "Tatvam-Studio". Files: an open dialog (CSV, TSV, JSON, XML / RSS, TXT) or a data file's
 * path, at most 10 MB, UTF-8 (BOM stripped) or UTF-16 with a BOM.
 */
import dns from "node:dns";
import { promises as fsp } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import type { OpenDialogOptions } from "electron";
import zlib from "node:zlib";
import type { NewsFetchResult } from "../../shared/types.ts";
import type { NewsroomDeps } from "./ipc.ts";

export const FETCH_LIMITS = { bytes: 10 * 1024 * 1024, ms: 20_000, redirects: 5 } as const;
export const DATA_EXTENSIONS = ["csv", "tsv", "json", "xml", "rss", "atom", "txt"] as const;
const UA = "Tatvam-Studio";

// ── addresses ────────────────────────────────────────────────────────────────

/** True for an IPv4 address that isn't a public internet address (or isn't an IPv4 address at all). */
export function ipv4Blocked(ip: string): boolean {
  const p = ip.split(".").map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return true;
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127                       // this network, private, loopback
    || (a === 100 && b >= 64 && b <= 127)                       // carrier-grade NAT
    || (a === 169 && b === 254)                                 // link-local
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) // private
    || (a === 192 && b === 0 && (c === 0 || c === 2))           // IETF protocol assignments, TEST-NET-1
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    || a >= 224;                                                // multicast, reserved, broadcast
}

/** The 8 groups of an IPv6 address (with an embedded IPv4 tail or a zone), or null. */
export function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  let tail: number[] = [];
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const q = v4[1].split(".").map(Number);
    if (q.some((n) => n > 255)) return null;
    tail = [(q[0] << 8) | q[1], (q[2] << 8) | q[3]];
    s = s.slice(0, s.length - v4[1].length);
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (x: string) => (x ? x.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)) : []);
  const head = part(halves[0]), back = halves.length === 2 ? part(halves[1]) : [];
  let g: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - back.length - tail.length;
    if (fill < 1) return null;
    g = [...head, ...new Array<number>(fill).fill(0), ...back, ...tail];
  } else g = [...head, ...tail];
  return g.length === 8 && g.every((n) => Number.isInteger(n)) ? g : null;
}

/** True for an IPv6 address that isn't a public internet address: ::, ::1, IPv4-mapped / compatible / NAT64 / 6to4
 *  forms of a blocked IPv4 address, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 2001:db8::/32, Teredo, discard. */
export function ipv6Blocked(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true;
  const v4of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 6).every((n) => n === 0)) return g[6] === 0 && g[7] <= 1 ? true : ipv4Blocked(v4of(g[6], g[7])); // ::, ::1, ::a.b.c.d
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return ipv4Blocked(v4of(g[6], g[7]));               // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return ipv4Blocked(v4of(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return ipv4Blocked(v4of(g[1], g[2]));                                                       // 6to4
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00) return true;
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return true;                                              // documentation, Teredo
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;                                      // discard
  return false;
}

/** True when an address (v4 or v6) must not be fetched from. */
export function isBlockedAddress(ip: string): boolean {
  const v = net.isIP(ip.replace(/^\[|\]$/g, "").split("%")[0]);
  return v === 4 ? ipv4Blocked(ip) : v === 6 ? ipv6Blocked(ip) : true;
}

const PRIVATE_MSG = "This address points to this computer or a private network, so it can't be used";

/** Checks a web address before anything is sent: http / https, no credentials, not a local name or blocked address
 *  (`allow` lets an address through: tests only). */
export function checkUrl(raw: string, allow?: (ip: string) => boolean): { url: URL } | { error: string } {
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { return { error: "That isn't a web address. It should start with https://" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "Only web addresses (http or https) can be used" };
  if (u.username || u.password) return { error: "Addresses with a user name or password can't be used" };
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host) return { error: "That web address has no site name" };
  if (host === "localhost" || host.endsWith(".localhost")) return { error: PRIVATE_MSG };
  if (net.isIP(host) && isBlockedAddress(host) && !allow?.(host)) return { error: PRIVATE_MSG };
  return { url: u };
}

// ── text ─────────────────────────────────────────────────────────────────────

/** Bytes → text: a BOM wins (UTF-8, UTF-16 LE / BE), then the charset (header or XML declaration), else UTF-8. */
export function decodeText(buf: Uint8Array, charset?: string): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder("utf-8").decode(buf.subarray(3));
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  let cs = (charset ?? "").trim().toLowerCase();
  if (!cs) {
    const head = new TextDecoder("latin1").decode(buf.subarray(0, 200));
    cs = head.match(/^<\?xml[^>]*encoding=["']([\w.:-]+)["']/i)?.[1].toLowerCase() ?? "";
  }
  try { return new TextDecoder(cs || "utf-8").decode(buf); } catch { return new TextDecoder("utf-8").decode(buf); }
}
const charsetOf = (type: string) => type.match(/charset=["']?([\w.:-]+)/i)?.[1];

// ── web ──────────────────────────────────────────────────────────────────────

export interface FetchOptions {
  /** Resolves a host name (default: the system resolver, every address). */
  resolve?(host: string): Promise<{ address: string; family: number }[]>;
  /** Lets a blocked address through (tests with a local server only). */
  allowAddress?(ip: string): boolean;
  timeoutMs?: number; maxBytes?: number; maxRedirects?: number;
}

class FetchError extends Error { code: string; constructor(msg: string, code = "") { super(msg); this.code = code; } }

const sysResolve = (host: string) => new Promise<{ address: string; family: number }[]>((ok, no) =>
  dns.lookup(host, { all: true, verbatim: true }, (e, a) => (e ? no(e) : ok(a as dns.LookupAddress[]))));

/** A socket lookup that only hands out checked addresses (also used for every redirect). */
function checkedLookup(o: FetchOptions): net.LookupFunction {
  const allowed = (ip: string) => !isBlockedAddress(ip) || !!o.allowAddress?.(ip);
  return ((host: string, opts: dns.LookupOptions, cb: (e: Error | null, a: string | dns.LookupAddress[], f?: number) => void) => {
    (o.resolve ?? sysResolve)(host).then((list) => {
      if (!list.length) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      if (list.some((a) => !allowed(a.address))) throw new FetchError(PRIVATE_MSG, "EPRIVATE");
      if (opts.all) cb(null, list.map((a) => ({ address: a.address, family: a.family })));
      else cb(null, list[0].address, list[0].family);
    }).catch((e: Error) => cb(e, "", 4));
  }) as net.LookupFunction;
}

interface Hop { status: number; type: string; location?: string; body?: Buffer }

function request(u: URL, o: FetchOptions, deadline: number, maxBytes: number): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && isBlockedAddress(host) && !o.allowAddress?.(host)) { reject(new FetchError(PRIVATE_MSG, "EPRIVATE")); return; }
    const mod = u.protocol === "https:" ? https : http;
    let done = false;
    const fail = (e: Error) => { if (!done) { done = true; clearTimeout(timer); req.destroy(); reject(e); } };
    const req = mod.request(u, {
      method: "GET", agent: false, lookup: checkedLookup(o),
      headers: {
        "User-Agent": UA, "Accept-Encoding": "gzip, deflate, br",
        Accept: "text/csv, application/json, application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain;q=0.9, */*;q=0.5",
      },
    }, (res) => {
      const status = res.statusCode ?? 0, type = String(res.headers["content-type"] ?? "");
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); done = true; clearTimeout(timer); req.destroy();
        resolve({ status, type, location: res.headers.location });
        return;
      }
      const declared = Number(res.headers["content-length"]);
      const enc = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
      if (!enc && declared > maxBytes) { fail(new FetchError(`The data is larger than ${maxBytes / 1048576} MB`, "ETOOBIG")); return; }
      let body: Readable = res;
      if (enc === "gzip" || enc === "x-gzip") body = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") body = res.pipe(zlib.createInflate());
      else if (enc === "br") body = res.pipe(zlib.createBrotliDecompress());
      const chunks: Buffer[] = [];
      let n = 0;
      body.on("data", (c: Buffer) => {
        n += c.length;
        if (n > maxBytes) { body.destroy(); res.destroy(); fail(new FetchError(`The data is larger than ${maxBytes / 1048576} MB`, "ETOOBIG")); return; }
        chunks.push(c);
      });
      body.on("error", (e) => fail(e));
      res.on("error", (e) => fail(e));
      body.on("end", () => { if (!done) { done = true; clearTimeout(timer); resolve({ status, type, body: Buffer.concat(chunks) }); } });
    });
    const timer = setTimeout(() => fail(new FetchError(`The web address took longer than ${Math.round((o.timeoutMs ?? FETCH_LIMITS.ms) / 1000)} seconds to answer`, "ETIMEDOUT")),
      Math.max(1, deadline - Date.now()));
    req.on("error", (e) => fail(e));
    req.end();
  });
}

function plainError(e: unknown): string {
  const err = e as Error & { code?: string };
  if (err instanceof FetchError) return err.message;
  const code = err?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Couldn't find that web address. Check the spelling and the internet connection.";
  if (code === "ECONNREFUSED") return "The site refused the connection";
  if (code === "ECONNRESET") return "The connection was cut off. Try again.";
  if (/certificate|SSL|TLS/i.test(err?.message ?? "") || code.startsWith("CERT_") || code.startsWith("ERR_TLS")) return "The site's security certificate isn't valid";
  return `Couldn't load it: ${err?.message ?? String(e)}`;
}

/** GETs a web address (see the module header). Never throws: a refusal or failure comes back as `error`. */
export async function fetchText(url: string, o: FetchOptions = {}): Promise<NewsFetchResult> {
  const first = checkUrl(url, o.allowAddress);
  if ("error" in first) return { ok: false, status: 0, type: "", text: "", finalUrl: String(url), error: first.error };
  const maxBytes = o.maxBytes ?? FETCH_LIMITS.bytes, maxHops = o.maxRedirects ?? FETCH_LIMITS.redirects;
  const deadline = Date.now() + (o.timeoutMs ?? FETCH_LIMITS.ms);
  let u = first.url;
  try {
    for (let hop = 0; ; hop++) {
      const r = await request(u, o, deadline, maxBytes);
      if (r.location !== undefined) {
        if (hop >= maxHops) throw new FetchError("The address redirected too many times", "EREDIRECT");
        let next: string;
        try { next = new URL(r.location, u).toString(); } catch { throw new FetchError("The site redirected to an address that isn't valid"); }
        const c = checkUrl(next, o.allowAddress);
        if ("error" in c) throw new FetchError(c.error, "EPRIVATE");
        u = c.url;
        continue;
      }
      const ok = r.status >= 200 && r.status < 300;
      return {
        ok, status: r.status, type: r.type, text: decodeText(r.body ?? Buffer.alloc(0), charsetOf(r.type)), finalUrl: u.toString(),
        ...(ok ? {} : { error: r.status === 404 ? "Nothing was found at that web address (404)" : r.status === 401 || r.status === 403
          ? `The site didn't allow it (${r.status}). A Google Sheet must be published to the web or shared with anyone who has the link.`
          : `The site answered with an error (${r.status})` }),
      };
    }
  } catch (e) {
    return { ok: false, status: 0, type: "", text: "", finalUrl: u.toString(), error: plainError(e) };
  }
}

// ── local files ──────────────────────────────────────────────────────────────

/** True when a path names a data file this reads (by extension). */
export const isDataFile = (p: string) => (DATA_EXTENSIONS as readonly string[]).includes(path.extname(p).slice(1).toLowerCase());

async function pickFile(d: NewsroomDeps): Promise<string | null> {
  const { dialog } = await import("electron");
  const opts: OpenDialogOptions = {
    title: "Choose a data file", properties: ["openFile"],
    filters: [{ name: "Data files (CSV, TSV, JSON, RSS, XML, TXT)", extensions: [...DATA_EXTENSIONS] }, { name: "All files", extensions: ["*"] }],
  };
  const parent = d.parent();
  const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

/**
 * Reads a local data file as text. No path: an open dialog (null = cancelled; the person may pick any file). A path
 * (a source's saved file, refreshed): it must be absolute and a data file (CSV, TSV, JSON, XML, RSS, Atom, TXT).
 * At most 10 MB. `o.pick` replaces the dialog (tests).
 */
export async function readTextFile(d: NewsroomDeps, p?: string, o: { pick?(): Promise<string | null>; maxBytes?: number } = {}): Promise<{ path: string; name: string; text: string } | null> {
  const max = o.maxBytes ?? FETCH_LIMITS.bytes;
  let file = p;
  if (!file) {
    file = (await (o.pick ? o.pick() : pickFile(d))) ?? undefined;
    if (!file) return null;
  } else if (!path.isAbsolute(file) || !isDataFile(file)) throw new Error("Only CSV, TSV, JSON, XML, RSS or TXT files can be read");
  let st;
  try { st = await fsp.stat(file); } catch { throw new Error(`The file ${path.basename(file)} wasn't found. It may have been moved or renamed.`); }
  if (!st.isFile()) throw new Error(`${path.basename(file)} isn't a file`);
  if (st.size > max) throw new Error(`${path.basename(file)} is larger than ${max / 1048576} MB`);
  const buf = await fsp.readFile(file);
  if (buf.length > max) throw new Error(`${path.basename(file)} is larger than ${max / 1048576} MB`);
  d.log?.(`newsroom: read ${path.basename(file)} (${buf.length} bytes)`);
  return { path: file, name: path.basename(file), text: decodeText(buf) };
}
