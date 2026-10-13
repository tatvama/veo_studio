/**
 * The News Room room (docs/EDITOR.md §16.8): spreadsheets in. CSV and TSV (Excel's "Save as CSV", Google Sheets'
 * download, a paste from a spreadsheet) → rows; a rundown's columns found by their header names; stories from rows or
 * from pasted lines; table blanks from a paste. Pure.
 */
import type { GfxField, GfxTableRow, Person, RundownStory } from "../types.ts";

/** The delimiter a text most likely uses (tab, semicolon — European Excel — or comma). */
export function sniffDelimiter(text: string): string {
  const head = text.split(/\r?\n/).slice(0, 5).join("\n");
  const count = (c: string) => head.split(c).length - 1;
  const tab = count("\t"), semi = count(";"), comma = count(",");
  if (tab && tab >= comma && tab >= semi) return "\t";
  if (semi > comma) return ";";
  return ",";
}

/** Rows of a CSV / TSV text: quoted fields ("a, b", doubled quotes), CRLF, a byte-order mark; empty rows dropped. */
export function parseCsv(text: string, delimiter = sniffDelimiter(text)): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
      continue;
    }
    if (c === '"' && cell.trim() === "") { q = true; cell = ""; continue; }
    if (c === delimiter) { row.push(cell); cell = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
      continue;
    }
    cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ""));
}

// ── rundown columns ──────────────────────────────────────────────────────────

export type StoryColumn = "slug" | "headline" | "strap" | "reporter" | "location" | "points" | "ticker" | "notes" | "status";
export const STORY_COLUMNS: { key: StoryColumn; label: string; names: string[] }[] = [
  { key: "slug", label: "Slug", names: ["slug", "story", "story slug", "id", "item", "segment"] },
  { key: "headline", label: "Headline", names: ["headline", "title", "head", "heading", "headline 1", "line 1", "main"] },
  { key: "strap", label: "Second line", names: ["strap", "strapline", "sub", "subhead", "sub headline", "second line", "line 2", "subtitle"] },
  { key: "reporter", label: "Reporter", names: ["reporter", "correspondent", "byline", "by", "journalist", "anchor"] },
  { key: "location", label: "Location", names: ["location", "place", "dateline", "city", "from"] },
  { key: "points", label: "Key points", names: ["points", "key points", "bullets", "highlights", "keypoints"] },
  { key: "ticker", label: "Ticker lines", names: ["ticker", "ticker lines", "crawl", "scroll", "ticker text", "tickers"] },
  { key: "notes", label: "Notes", names: ["notes", "note", "remarks", "comment", "comments"] },
  { key: "status", label: "Status", names: ["status", "state", "done"] },
];

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Column index per story field from a header row (exact names first, then a name inside the header); -1 = none. */
export function mapColumns(headers: string[]): Record<StoryColumn, number> {
  const hs = headers.map(key);
  const out = {} as Record<StoryColumn, number>;
  const used = new Set<number>();
  for (const c of STORY_COLUMNS) {
    let i = hs.findIndex((h, j) => !used.has(j) && c.names.includes(h));
    if (i < 0) i = hs.findIndex((h, j) => !used.has(j) && h !== "" && c.names.some((n) => n.length > 2 && (h.startsWith(`${n} `) || h.endsWith(` ${n}`))));
    out[c.key] = i;
    if (i >= 0) used.add(i);
  }
  return out;
}

/** Without headers: slug, headline, second line, reporter … in that order. */
export const positional = (n: number) => Object.fromEntries(STORY_COLUMNS.map((c, i) => [c.key, i < n ? i : -1])) as Record<StoryColumn, number>;

/** True when a first row looks like headers (at least one cell is exactly a known column name). */
export function looksLikeHeader(row: string[]): boolean {
  return row.some((h) => STORY_COLUMNS.some((c) => c.names.includes(key(h))));
}

/** A cell with several lines: new lines, "|", "•" or ";" between them. */
export function splitCell(s: string): string[] {
  const parts = /\n/.test(s) ? s.split(/\r?\n/) : /[|•]/.test(s) ? s.split(/[|•]/) : s.includes(";") ? s.split(";") : [s];
  return parts.map((x) => x.replace(/^[\s\-–*·]+/, "").trim()).filter(Boolean);
}

/** A short slug from a headline: its first words in capitals. */
export function slugOf(headline: string, words = 2): string {
  const w = headline.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((x) => x.length > 1 || /\p{N}/u.test(x));
  return w.slice(0, words).join(" ").toUpperCase() || "STORY";
}

const STATUS: Record<string, RundownStory["status"]> = { draft: "draft", ready: "ready", done: "done", yes: "done", x: "done", "✓": "done", aired: "done" };

export interface ImportResult {
  stories: RundownStory[];
  /** Reporters not in the people library yet (added with the stories). */
  people: Person[];
  mapping: Record<StoryColumn, number>;
  headers: string[];
}

/**
 * Stories from spreadsheet rows. The first row is the header when it names columns (else the columns are taken as
 * slug, headline, strap … in that order). Reporters are matched to people by name, or added.
 */
export function storiesFromRows(rows: string[][], people: Person[], makeId: (prefix: string) => string,
  opts: { mapping?: Record<StoryColumn, number>; header?: boolean } = {}): ImportResult {
  if (!rows.length) return { stories: [], people: [], mapping: opts.mapping ?? mapColumns([]), headers: [] };
  const header = opts.header ?? looksLikeHeader(rows[0]);
  const headers = header ? rows[0] : rows[0].map((_, i) => `Column ${i + 1}`);
  const m = opts.mapping ?? (header ? mapColumns(rows[0]) : positional(rows[0].length));
  const body = header ? rows.slice(1) : rows;
  const added: Person[] = [];
  const cell = (r: string[], k: StoryColumn) => (m[k] >= 0 ? r[m[k]] ?? "" : "");
  const reporterId = (name: string): string | undefined => {
    const n = name.trim();
    if (!n) return undefined;
    const low = n.toLowerCase();
    const have = [...people, ...added].find((p) => p.name.toLowerCase() === low || Object.values(p.names ?? {}).some((x) => x.toLowerCase() === low));
    if (have) return have.id;
    const p: Person = { id: makeId("pp"), name: n, role: "Reporter", kind: "reporter" };
    added.push(p);
    return p.id;
  };
  const stories: RundownStory[] = [];
  for (const r of body) {
    const headline = cell(r, "headline");
    const slug = cell(r, "slug") || (headline ? slugOf(headline) : "");
    if (!headline && !slug) continue;
    const st: RundownStory = { id: makeId("st"), slug, headline: headline || slug, status: STATUS[cell(r, "status").toLowerCase()] ?? "draft" };
    const strap = cell(r, "strap"); if (strap) st.strap = strap;
    const rep = reporterId(cell(r, "reporter")); if (rep) st.reporter = rep;
    const loc = cell(r, "location"); if (loc) st.location = loc;
    const pts = splitCell(cell(r, "points")); if (pts.length) st.points = pts;
    const tk = splitCell(cell(r, "ticker")); if (tk.length) st.ticker = tk;
    const notes = cell(r, "notes"); if (notes) st.notes = notes;
    stories.push(st);
  }
  return { stories, people: added, mapping: m, headers };
}

/**
 * Stories from pasted lines, one per line. "SLUG | Headline | second line" (or tab-separated, as a spreadsheet
 * paste) fills those; a plain line is the headline and its slug is made from it. Bullets and numbers are dropped.
 */
export function storiesFromLines(text: string, makeId: (prefix: string) => string): RundownStory[] {
  const out: RundownStory[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-–*•·]|\d+[.)])\s*/, "").trim();
    if (!line) continue;
    const parts = (line.includes("\t") ? line.split("\t") : line.includes("|") ? line.split("|") : [line]).map((x) => x.trim());
    let slug = "", headline = "", strap = "";
    if (parts.length >= 2) [slug, headline, strap = ""] = parts;
    else headline = parts[0];
    if (!headline) { headline = slug; slug = ""; }
    if (!headline) continue;
    const st: RundownStory = { id: makeId("st"), slug: slug || slugOf(headline), headline, status: "draft" };
    if (strap) st.strap = strap;
    out.push(st);
  }
  return out;
}

// ── table blanks ─────────────────────────────────────────────────────────────

/** "₹1,23,456.50" / "12.5%" / "-3" → a number; null when it isn't one. */
export function parseNumber(s: string): number | null {
  const t = s.replace(/[₹$€£,\s%+]/g, "").replace(/^\((.*)\)$/, "-$1").replace(/[−–]/g, "-");
  if (!t || !/^-?\d*\.?\d+(e-?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Rows for a table blank from a paste (TSV from a spreadsheet, or CSV). A first row that names the columns (by label
 * or id) is skipped; number columns become numbers.
 */
export function tableFromText(text: string, f: Pick<GfxField, "columns">): GfxTableRow[] {
  const cols = f.columns ?? [];
  const rows = parseCsv(text, sniffDelimiter(text));
  if (!rows.length || !cols.length) return [];
  const names = new Set(cols.flatMap((c) => [key(c.label), key(c.id)]));
  const body = rows[0].some((x) => names.has(key(x))) ? rows.slice(1) : rows;
  return body.map((r) => Object.fromEntries(cols.map((c, i) => {
    const raw = r[i] ?? "";
    if (c.type === "number") { const n = parseNumber(raw); return [c.id, n ?? raw]; }
    return [c.id, raw];
  })));
}

/** A table as tab-separated text (for copy). */
export const tableToText = (rows: GfxTableRow[], f: Pick<GfxField, "columns">): string =>
  [(f.columns ?? []).map((c) => c.label).join("\t"), ...rows.map((r) => (f.columns ?? []).map((c) => String(r[c.id] ?? "")).join("\t"))].join("\n");
