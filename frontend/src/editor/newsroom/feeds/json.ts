/**
 * News Room data (docs/EDITOR.md §16.10): JSON sources. A root path picks the rows inside the answer
 * ("data.items[0].list", "$.results", "items.0", `["key with spaces"]`, "[-1]" = the last); the rows are the objects
 * there with nested objects flattened ("price.value") and short lists joined. Pure.
 */
import type { GfxTableRow } from "../types.ts";

/** "data.items[0].list" → ["data", "items", 0, "list"]. */
export function parsePath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /\[\s*(-?\d+)\s*\]|\[\s*"((?:[^"\\]|\\.)*)"\s*\]|\[\s*'((?:[^'\\]|\\.)*)'\s*\]|([^.[\]]+)/g;
  for (const m of path.trim().replace(/^\$\.?/, "").matchAll(re)) {
    if (m[1] !== undefined) out.push(Number(m[1]));
    else if (m[2] !== undefined) out.push(m[2].replace(/\\(.)/g, "$1"));
    else if (m[3] !== undefined) out.push(m[3].replace(/\\(.)/g, "$1"));
    else if (m[4] !== undefined && m[4].trim()) out.push(/^\d+$/.test(m[4].trim()) ? Number(m[4].trim()) : m[4].trim());
  }
  return out;
}

/** The value at a path (undefined when it isn't there). Numbers index arrays (negative from the end). */
export function getPath(v: unknown, path?: string): unknown {
  let cur = v;
  for (const k of path ? parsePath(path) : []) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur) && typeof k === "number") cur = cur[k < 0 ? cur.length + k : k];
    else cur = (cur as Record<string, unknown>)[String(k)];
  }
  return cur;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** One flat row: nested objects as "a.b" (3 levels), lists of plain values joined with ", ", the rest as JSON text. */
export function flatRow(o: Record<string, unknown>, prefix = "", depth = 0, out: GfxTableRow = {}): GfxTableRow {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) out[key] = "";
    else if (typeof v === "number") out[key] = Number.isFinite(v) ? v : String(v);
    else if (typeof v === "string") out[key] = v;
    else if (typeof v === "boolean") out[key] = v ? "yes" : "no";
    else if (isObj(v) && depth < 3) flatRow(v, key, depth + 1, out);
    else if (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) out[key] = v.map((x) => String(x ?? "")).join(", ");
    else out[key] = JSON.stringify(v);
  }
  return out;
}

/**
 * Rows from a JSON value: a list of objects (one row each), a list of plain values ({ value }), an object whose values
 * are all objects (a "key" column plus each object), or one object (one row).
 */
export function jsonRows(v: unknown): { columns: string[]; rows: GfxTableRow[] } {
  let rows: GfxTableRow[];
  if (Array.isArray(v)) rows = v.map((x) => (isObj(x) ? flatRow(x) : Array.isArray(x) ? Object.fromEntries(x.map((y, i) => [`Column ${i + 1}`, typeof y === "number" ? y : String(y ?? "")])) : { value: typeof x === "number" ? x : String(x ?? "") }));
  else if (isObj(v)) {
    const vals = Object.values(v);
    rows = vals.length && vals.every(isObj) ? Object.entries(v).map(([k, x]) => ({ key: k, ...flatRow(x as Record<string, unknown>) })) : [flatRow(v)];
  } else rows = v === undefined ? [] : [{ value: typeof v === "number" ? v : String(v ?? "") }];
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
  return { columns, rows };
}

/** Paths to the lists of objects inside a JSON answer (breadth first, at most `max`): root suggestions for the panel. */
export function findLists(v: unknown, max = 8): string[] {
  const out: string[] = [];
  const queue: [unknown, string, number][] = [[v, "", 0]];
  while (queue.length && out.length < max) {
    const [x, p, d] = queue.shift()!;
    if (Array.isArray(x)) {
      if (x.length && x.some(isObj)) out.push(p);
      if (d < 4 && x.length && isObj(x[0])) for (const [k, y] of Object.entries(x[0])) if (y && typeof y === "object") queue.push([y, `${p}[0].${k}`.replace(/^\./, ""), d + 1]);
    } else if (isObj(x) && d < 4) {
      for (const [k, y] of Object.entries(x)) if (y && typeof y === "object") queue.push([y, /^[A-Za-z_$][\w$]*$/.test(k) ? (p ? `${p}.${k}` : k) : `${p}["${k.replace(/"/g, '\\"')}"]`, d + 1]);
    }
  }
  return out;
}
