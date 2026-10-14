/**
 * News Room data (docs/EDITOR.md §16.10): a source's text → a `DataSnapshot` (rows, items, the time, or a plain error)
 * that is frozen into the edit so every export repeats exactly. The text is read as its kind says (CSV / TSV, JSON at a
 * root path, RSS / Atom), and recognised anyway when it is clearly another kind; a web page instead of data (a sheet
 * that isn't published) gets a plain explanation. Pure.
 */
import type { DataSnapshot, DataSource, GfxListItem, GfxTableRow } from "../types.ts";
import { csvRows } from "./csv.ts";
import { parseFeed } from "./feed.ts";
import { findLists, getPath, jsonRows } from "./json.ts";
import { columnsOf } from "./mappers.ts";

export type ParsedKind = "csv" | "json" | "rss";

/** What text is, by its first characters ("[" is JSON only when it reads as JSON). */
export function detectKind(text: string): ParsedKind | "html" {
  const t = text.replace(/^\uFEFF/, "").trimStart().slice(0, 600).toLowerCase();
  if (/^<!doctype html|^<html[\s>]|^<head[\s>]/.test(t) || (/<body[\s>]/.test(t) && !/<rss|<feed|<rdf:rdf/.test(t))) return "html";
  if (t.startsWith("<")) return "rss";
  if (t.startsWith("{")) return "json";
  if (t.startsWith("[")) { try { JSON.parse(text.replace(/^\uFEFF/, "")); return "json"; } catch { return "csv"; } }
  return "csv";
}

export interface Parsed { kind: ParsedKind; columns: string[]; rows: GfxTableRow[]; items?: GfxListItem[]; title?: string }

/** Parses a source's text; throws an Error with a plain message when it can't. */
export function parseSourceText(source: Pick<DataSource, "kind" | "root">, text: string): Parsed {
  if (!text.trim()) throw new Error("The source is empty");
  const kind = detectKind(text);
  if (kind === "html") {
    throw new Error(source.kind === "sheet" || text.slice(0, 3000).includes("docs.google.com")
      ? "This gave a web page, not data. In Google Sheets use File → Share → Publish to web, choose CSV, and paste that link."
      : "This gave a web page, not data. Use the address of the CSV, JSON or RSS file itself.");
  }
  if (kind === "rss") {
    const feed = parseFeed(text);
    if (!feed) throw new Error("This isn't an RSS or Atom feed");
    const rows = feed.items.map((i) => ({ title: i.title, link: i.link ?? "", date: i.date ?? "", summary: i.summary ?? "", category: i.category ?? "", image: i.image ?? "" }));
    const items = feed.items.filter((i) => i.title).map((i) => ({ text: i.title, ...(i.category ? { tag: i.category } : {}) }));
    return { kind, columns: ["title", "link", "date", "summary", "category", "image"], rows, items, ...(feed.title ? { title: feed.title } : {}) };
  }
  if (kind === "json") {
    let v: unknown;
    try { v = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (e) { throw new Error(`This JSON can't be read: ${(e as Error).message}`); }
    let at = source.root ? getPath(v, source.root) : v;
    if (source.root && at === undefined) throw new Error(`Nothing was found at "${source.root}" in this JSON`);
    if (!source.root && !Array.isArray(v)) { const first = findLists(v, 1)[0]; if (first !== undefined) at = getPath(v, first); }
    const { columns, rows } = jsonRows(at);
    return { kind, columns, rows };
  }
  const { columns, rows } = csvRows(text);
  return { kind, columns, rows };
}

/** A source's text → its snapshot at `at` (ISO). Parse problems become `error` with no rows. */
export function snapshotFrom(source: DataSource, text: string, at: string = new Date().toISOString()): DataSnapshot {
  try {
    const p = parseSourceText(source, text);
    return { source: source.id, at, rows: p.rows, ...(p.items ? { items: p.items } : {}), ...(p.rows.length ? {} : { error: "No rows were found" }) };
  } catch (e) {
    return { source: source.id, at, rows: [], error: (e as Error).message || String(e) };
  }
}

/** A snapshot for a failed refresh: the last good rows stay (exports keep repeating them) with the error beside them. */
export function failedSnapshot(source: DataSource, error: string, prev?: DataSnapshot, at: string = new Date().toISOString()): DataSnapshot {
  return prev && prev.rows.length ? { ...prev, error } : { source: source.id, at, rows: [], error };
}

/** The columns of a snapshot (in first-seen order). */
export const snapshotColumns = (s: DataSnapshot | undefined) => (s ? columnsOf(s.rows) : []);

/** "as of 19:42" today, "as of 12 Oct, 19:42" another day (in `zone`, default the computer's). */
export function asOf(at: string, now: number = Date.now(), zone?: string): string {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return "";
  const day = (x: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  if (day(d) === day(new Date(now))) return `as of ${time}`;
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short" }).format(d);
  return `as of ${date}, ${time}`;
}

/** Hours since a snapshot was taken. */
export const ageHours = (s: Pick<DataSnapshot, "at">, now: number = Date.now()) => (now - new Date(s.at).getTime()) / 3_600_000;
