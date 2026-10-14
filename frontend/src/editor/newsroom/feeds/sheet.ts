/**
 * News Room data (docs/EDITOR.md §16.10): Google Sheet links → an address that answers CSV. A sheet published to the web
 * (File → Share → Publish to web) is read at its `pub?output=csv` address; a sheet shared with "anyone with the link"
 * at its `export?format=csv` address. The tab (gid) is kept. Pure.
 */

export interface SheetLink {
  /** The CSV (or TSV) address. */ url: string;
  /** published = "Publish to web"; shared = a normal sheet link (needs "anyone with the link can view"). */
  kind: "published" | "shared";
  gid?: string;
}

/** True for a docs.google.com spreadsheet address. */
export const isSheetUrl = (raw: string) => /^https?:\/\/docs\.google\.com\/spreadsheets\//i.test(raw.trim());

/** A Google Sheet link (edit, view, published, export) → its CSV address; null when it isn't one. */
export function sheetCsvUrl(raw: string): SheetLink | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (!/^(docs\.google\.com)$/i.test(u.hostname) || !/^https?:$/.test(u.protocol)) return null;
  const gid = u.searchParams.get("gid") ?? u.hash.match(/gid=(\d+)/)?.[1] ?? undefined;
  const path = u.pathname.replace(/\/u\/\d+(?=\/)/, "");
  const pub = path.match(/^\/spreadsheets\/d\/e\/([\w-]+)/);
  if (pub) {
    const out = u.searchParams.get("output");
    if (/\/pub$/.test(path) && (out === "csv" || out === "tsv")) return { url: `https://docs.google.com${path}?${u.searchParams.toString()}`, kind: "published", ...(gid ? { gid } : {}) };
    const q = new URLSearchParams();
    if (gid) { q.set("gid", gid); q.set("single", "true"); }
    q.set("output", "csv");
    return { url: `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?${q.toString()}`, kind: "published", ...(gid ? { gid } : {}) };
  }
  const id = path.match(/^\/spreadsheets\/d\/([\w-]{10,})/)?.[1];
  if (!id) return null;
  if (/\/export$/.test(path) && /^(csv|tsv)$/.test(u.searchParams.get("format") ?? "")) return { url: `https://docs.google.com/spreadsheets/d/${id}/export?${u.searchParams.toString()}`, kind: "shared", ...(gid ? { gid } : {}) };
  if (/\/gviz\/tq$/.test(path) && /out:csv/.test(u.searchParams.get("tqx") ?? "")) return { url: `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?${u.searchParams.toString()}`, kind: "shared", ...(gid ? { gid } : {}) };
  return { url: `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}`, kind: "shared", ...(gid ? { gid } : {}) };
}
