/**
 * The local MCP server's gatekeeping (docs/EDITOR.md §13.1), pure so the tests cover every rule:
 * - the Host header must be the loopback address and port (DNS rebinding);
 * - a request with a browser Origin (or Fetch Metadata) header is refused, and CORS is never answered;
 * - a bearer token on every request;
 * - a rate limit per token;
 * - folders: the library root and the listed folders, others only after the in-app prompt;
 * - exports only into the library's export folders (an edit's Renders folder inside the library);
 * - only media and interchange file types are read.
 */
import path from "node:path";

export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"] as const;

/** Host header → allowed? Only `127.0.0.1:<port>` / `localhost:<port>` (the port must match). */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const m = /^([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(host.trim());
  if (!m) return false;
  const name = m[1].toLowerCase();
  return Number(m[2]) === port && (LOOPBACK_HOSTS as readonly string[]).includes(name);
}

type Headers = Record<string, string | string[] | undefined>;
const header = (h: Headers, k: string): string | undefined => {
  const v = h[k] ?? h[k.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * A browser made this request: it carries an Origin (any value, "null" too) or Sec-Fetch-Site. A web page reaching
 * 127.0.0.1 always sends at least one of them (fetch and form posts an Origin, every request Sec-Fetch-Site). MCP apps
 * send neither (Node's fetch adds only Sec-Fetch-Mode, which isn't checked for that reason).
 */
export function fromBrowser(h: Headers): string | null {
  if (header(h, "origin") !== undefined) return "Origin";
  if (header(h, "sec-fetch-site") !== undefined) return "Sec-Fetch-Site";
  return null;
}

/** "Bearer tvd_…" → the token, else null. */
export function bearerOf(authorization: string | undefined): string | null {
  const m = /^Bearer\s+(tvd_[A-Za-z0-9_-]{20,100})\s*$/.exec(authorization ?? "");
  return m ? m[1] : null;
}

/** The first check of every request: what to answer instead of serving it, or null to go on. */
export function gate(req: { method?: string; url?: string; headers: Headers }, port: number): { status: number; message: string } | null {
  const url = req.url ?? "";
  const p = url.split("?")[0];
  if (!hostAllowed(header(req.headers, "host"), port)) return { status: 421, message: "This server only answers on its loopback address" };
  const b = fromBrowser(req.headers);
  if (b) return { status: 403, message: `Requests from web pages are refused (${b} header)` };
  if (req.method === "OPTIONS") return { status: 405, message: "No CORS here" };
  if (p !== "/mcp") return { status: 404, message: "Not found: the MCP endpoint is /mcp" };
  if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) return { status: 405, message: "Method not allowed" };
  return null;
}

/** A sliding-window rate limit per key: at most `limit` events in `windowMs`. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  readonly limit: number;
  readonly windowMs: number;
  constructor(limit: number, windowMs: number) { this.limit = limit; this.windowMs = windowMs; }
  /** true = allowed (and counted) */
  take(key: string, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) { this.hits.set(key, list); return false; }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
  /** seconds until the next event is allowed */
  retryAfter(key: string, now = Date.now()): number {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length < this.limit) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000));
  }
}

// ── folders and files ──

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();

/** `child` is `dir` or inside it (case-insensitive, as Windows). */
export function inside(dir: string, child: string): boolean {
  const d = norm(dir);
  const c = norm(child);
  return c === d || c.startsWith(`${d}${path.sep}`) || c.startsWith(`${d}/`);
}

export const MEDIA_TYPES = {
  video: ["mp4", "mov", "mkv", "webm", "m4v", "avi", "mxf", "mts", "m2ts"],
  audio: ["wav", "mp3", "aac", "m4a", "flac", "ogg", "opus", "aif", "aiff"],
  image: ["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff", "heic"],
} as const;
/** Exchange formats an assistant may read: timelines, captions, LUTs, edits. */
export const INTERCHANGE_TYPES = ["tatvamedit", "xml", "fcpxml", "edl", "otio", "csv", "srt", "vtt", "cube", "3dl"] as const;
/** What the editor can import as media today (editor-model.ts' lists). */
export const EDITOR_MEDIA = new Set(["mp4", "mov", "mkv", "webm", "m4v", "avi", "wav", "mp3", "aac", "m4a", "flac", "ogg", "png", "jpg", "jpeg", "webp", "gif", "tif", "tiff"]);

export const extOf = (f: string) => path.extname(f).slice(1).toLowerCase();
export function mediaKind(f: string): "video" | "audio" | "image" | null {
  const e = extOf(f);
  for (const k of ["video", "audio", "image"] as const) if ((MEDIA_TYPES[k] as readonly string[]).includes(e)) return k;
  return null;
}
/** Only media and interchange files are read for an assistant. */
export const readableType = (f: string) => mediaKind(f) !== null || (INTERCHANGE_TYPES as readonly string[]).includes(extOf(f));

export type FolderDecision = "allowed" | "ask" | "refused";

/**
 * The operating system's own folders, never open to an assistant. Windows (what the app ships for): Windows, Program
 * Files (both) and ProgramData. Elsewhere (the tests run on Linux too) the system directories of a Unix.
 */
export function systemFolders(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): string[] {
  if (platform === "win32") {
    return [env.SystemRoot || "C:\\Windows", env.ProgramFiles || "C:\\Program Files", env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      env.ProgramData || "C:\\ProgramData"];
  }
  return ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/proc", "/sbin", "/sys", "/usr", "/System", "/Library", "/private/etc"];
}

/**
 * May an assistant use this path? The library root, the listed folders and the session's "Allow once" folders are
 * allowed; system folders are refused outright; anything else asks the user.
 */
export function folderDecision(target: string, roots: { library: string; folders: string[]; session: string[] }): FolderDecision {
  if (!path.isAbsolute(target)) return "refused";
  const t = path.resolve(target);
  if (/[\0]/.test(t) || /^\\\\[?.]\\/.test(t)) return "refused"; // device and \\?\ paths
  if (systemFolders().some((s) => inside(s, t))) return "refused";
  for (const r of [roots.library, ...roots.folders, ...roots.session]) if (r && inside(r, t)) return "allowed";
  return "ask";
}

/** The folder a prompt asks about: the path itself when it is a folder, else its parent. */
export const promptFolder = (p: string, isDir: boolean) => (isDir ? path.resolve(p) : path.dirname(path.resolve(p)));

/**
 * Exports by an assistant go only into the library's export folders: the edit's own Renders folder, and the edit must
 * live in the library (an edit opened from elsewhere is exported from the app by the user).
 */
export function exportDirAllowed(editPath: string, libraryRoot: string): { ok: boolean; dir: string; reason?: string } {
  const dir = path.join(path.dirname(path.resolve(editPath)), "Renders");
  if (!libraryRoot || !inside(libraryRoot, dir)) {
    return { ok: false, dir, reason: `That edit isn't in the library (${libraryRoot}): assistants export only into the library's Renders folders` };
  }
  return { ok: true, dir };
}

/** An output name from an assistant: a plain name, never a path. */
export function safeOutputName(name: unknown): string | undefined {
  if (typeof name !== "string" || !name.trim()) return undefined;
  const s = name.trim();
  if (/[\\/:*?"<>|\0]/.test(s) || s.includes("..")) throw new Error("The export name must be a plain name, not a path");
  return s.slice(0, 100);
}
