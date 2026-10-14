/**
 * News Room data (docs/EDITOR.md §16.10): reading a source's text. In Tatvam Desktop web addresses are fetched by the
 * main process (no CORS; private addresses refused; 10 MB, 20 s) and local files are read again from their path. In
 * the browser, `fetch` works where the site allows it (CORS) and local files are picked again with a file input
 * (`pickTextFile`). Browser only (not imported by the Node tests).
 */
import { newsroomBridge } from "../../../lib/desktop";
import type { DataSource } from "../types";
import { isSheetUrl, sheetCsvUrl } from "./sheet";

const MAX = 10 * 1024 * 1024;
/** Electron prefixes errors from the main process; show only the message. */
export const plainError = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");

/** The address actually read for a source (Google Sheet links become their CSV address). */
export function readUrl(s: Pick<DataSource, "kind" | "url">): string | undefined {
  if (!s.url) return undefined;
  return s.kind === "sheet" || isSheetUrl(s.url) ? sheetCsvUrl(s.url)?.url ?? s.url : s.url;
}

/** True when a source can be refreshed here (manual tables and browser-picked files can't). */
export function canRefresh(s: DataSource): boolean {
  if (s.kind === "manual") return false;
  if (s.url) return true;
  return !!s.path && !!newsroomBridge();
}

/** A source's current text; throws an Error with a plain message. */
export async function loadSourceText(s: DataSource): Promise<string> {
  const bridge = newsroomBridge();
  const url = readUrl(s);
  if (url) {
    if (bridge) {
      const r = await bridge.fetchText(url);
      if (!r.ok) throw new Error(r.error || `The site answered with an error (${r.status})`);
      return r.text;
    }
    return browserFetch(url);
  }
  if (s.path) {
    if (!bridge) throw new Error("This file was picked in the browser. Choose it again to refresh it.");
    try {
      const r = await bridge.readTextFile(s.path);
      if (!r) throw new Error("The file couldn't be read");
      return r.text;
    } catch (e) { throw new Error(plainError(e)); }
  }
  throw new Error("This source has no web address or file");
}

async function browserFetch(url: string): Promise<string> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("That isn't a web address. It should start with https://"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only web addresses (http or https) can be used");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(u, { credentials: "omit", redirect: "follow", referrerPolicy: "no-referrer", signal: ac.signal, cache: "no-store" });
    if (!res.ok) throw new Error(res.status === 404 ? "Nothing was found at that web address (404)" : `The site answered with an error (${res.status})`);
    if (Number(res.headers.get("content-length")) > MAX) throw new Error("The data is larger than 10 MB");
    const reader = res.body?.getReader();
    if (!reader) return await res.text();
    const parts: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > MAX) { void reader.cancel(); throw new Error("The data is larger than 10 MB"); }
      parts.push(value);
    }
    const all = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return decodeBytes(all, res.headers.get("content-type") ?? "");
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("The web address took longer than 20 seconds to answer");
    if (e instanceof TypeError) throw new Error("This site doesn't let the browser read it. Use Tatvam Desktop, or download the file and add it as a file.");
    throw e;
  } finally { clearTimeout(timer); }
}

/** Bytes → text: a BOM (UTF-8, UTF-16 LE / BE) wins, then the charset, else UTF-8. */
export function decodeBytes(b: Uint8Array, type = ""): string {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8").decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  const cs = type.match(/charset=["']?([\w.:-]+)/i)?.[1];
  try { return new TextDecoder(cs || "utf-8").decode(b); } catch { return new TextDecoder("utf-8").decode(b); }
}

/** Picks a local data file: the desktop's open dialog, else a browser file input. null = cancelled. */
export async function pickTextFile(): Promise<{ name: string; text: string; path?: string } | null> {
  const bridge = newsroomBridge();
  if (bridge) {
    try { return await bridge.readTextFile(); } catch (e) { throw new Error(plainError(e)); }
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.tsv,.json,.xml,.rss,.atom,.txt,text/csv,application/json,application/xml,text/plain";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) { resolve(null); return; }
      if (f.size > MAX) { reject(new Error(`${f.name} is larger than 10 MB`)); return; }
      resolve({ name: f.name, text: decodeBytes(new Uint8Array(await f.arrayBuffer())) });
    };
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}
