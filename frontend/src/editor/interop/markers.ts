/**
 * Sequence markers as Premiere's marker export lays them out (Marker Name, Description, In, Out, Duration, Marker
 * Type; timecodes at the sequence rate, drop-frame at 29.97 / 59.94), and YouTube chapters ("0:00 Intro" lines)
 * (docs/EDITOR.md §12). The CSV is written comma-separated (UTF-8; the desktop adds a BOM for Excel); reading takes
 * commas or tabs (Premiere's own file is tab-separated UTF-16, which the desktop decodes first). Pure.
 */
import type { Marker, Sequence } from "../model/types.ts";
import { clock, framesToSeconds, MARKER_COLORS, parseTimecode, toTimecode } from "./common.ts";

export const MARKER_COLUMNS = ["Marker Name", "Description", "In", "Out", "Duration", "Marker Type"] as const;

const q = (s: string) => (/[",\r\n\t]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s);

export function toMarkersCsv(seq: Sequence, opts: { delimiter?: "," | "\t" } = {}): string {
  const d = opts.delimiter ?? ",";
  const tc = (f: number) => toTimecode(Math.max(0, Math.round(f)), seq.fps);
  const rows = [MARKER_COLUMNS.join(d)];
  for (const m of [...seq.markers].sort((a, b) => a.frame - b.frame)) {
    const type = m.kind === "chapter" ? "Chapter" : "Comment";
    rows.push([q(m.name), q(m.comment ?? ""), tc(m.frame), tc(m.frame + m.duration), tc(m.duration), type].join(d));
  }
  return rows.join("\r\n") + "\r\n";
}

/** Splits CSV / TSV text into rows (quotes, doubled quotes and newlines inside quotes). */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const d = delimiter ?? (first.split("\t").length > first.split(",").length ? "\t" : ",");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === "\"") { if (src[i + 1] === "\"") { cell += "\""; i++; } else inQ = false; }
      else cell += c;
    } else if (c === "\"" && cell === "") inQ = true;
    else if (c === d) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

/** "HH:MM:SS:FF", "HH:MM:SS;FF", "HH:MM:SS.mmm" or seconds → frames. */
function timeOf(s: string, fps: number): number | null {
  const v = s.trim();
  if (!v) return null;
  const tc = parseTimecode(v, fps);
  if (tc !== null && !/\.\d{3}$/.test(v)) return tc;
  const ms = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d+))?$/.exec(v);
  if (ms) {
    const sec = (Number(ms[1] ?? 0) * 3600) + Number(ms[2]) * 60 + Number(ms[3]) + (ms[4] ? Number(`0.${ms[4]}`) : 0);
    return Math.round(sec * (fps > 0 ? fps : 25));
  }
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * fps) : null;
}

export interface MarkerRow { frame: number; duration: number; name: string; comment?: string; kind?: Marker["kind"]; color: string }

/** Markers from a marker CSV at the sequence's rate (unknown columns are ignored). */
export function fromMarkersCsv(text: string, fps: number): { markers: MarkerRow[]; warnings: string[] } {
  const rows = parseDelimited(text);
  const warnings: string[] = [];
  if (!rows.length) return { markers: [], warnings: ["The file has no rows"] };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iName = col("marker name", "name", "title"), iDesc = col("description", "comment", "comments", "notes");
  const iIn = col("in", "start", "timecode", "time"), iOut = col("out", "end"), iDur = col("duration"), iType = col("marker type", "type");
  if (iIn < 0) return { markers: [], warnings: ["The CSV has no In column (Premiere's layout: Marker Name, Description, In, Out, Duration, Marker Type)"] };
  const markers: MarkerRow[] = [];
  let bad = 0;
  for (const r of rows.slice(1)) {
    const a = timeOf(r[iIn] ?? "", fps);
    if (a === null) { bad++; continue; }
    let dur = 0;
    const b = iOut >= 0 ? timeOf(r[iOut] ?? "", fps) : null;
    if (b !== null && b > a) dur = b - a;
    else if (iDur >= 0) dur = Math.max(0, timeOf(r[iDur] ?? "", fps) ?? 0);
    const type = (iType >= 0 ? r[iType] ?? "" : "").trim().toLowerCase();
    const m: MarkerRow = { frame: Math.max(0, a), duration: dur, name: (iName >= 0 ? r[iName] ?? "" : "").trim(), color: type === "chapter" ? MARKER_COLORS[1] : MARKER_COLORS[0] };
    const desc = iDesc >= 0 ? (r[iDesc] ?? "").trim() : "";
    if (desc) m.comment = desc;
    if (type === "chapter") m.kind = "chapter";
    else if (type === "comment") m.kind = "comment";
    markers.push(m);
  }
  if (bad) warnings.push(`${bad} row${bad === 1 ? " has" : "s have"} no time it can read; skipped`);
  return { markers, warnings };
}

/**
 * YouTube chapters: "0:00 Intro" lines. Chapter markers when the sequence has some, else every marker. YouTube wants
 * the first at 0:00, at least three, each 10 seconds or longer: the warnings say what's off (a 0:00 line is added).
 */
export function toYoutubeChapters(seq: Sequence): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const all = [...seq.markers].sort((a, b) => a.frame - b.frame);
  const chapters = all.some((m) => m.kind === "chapter") ? all.filter((m) => m.kind === "chapter") : all;
  const list = chapters.map((m) => ({ t: framesToSeconds(m.frame, seq.fps), name: (m.name || m.comment || "Chapter").replace(/[\r\n]+/g, " ").trim() }));
  if (!list.length || Math.floor(list[0].t) > 0) { list.unshift({ t: 0, name: "Intro" }); warnings.push("YouTube chapters start at 0:00: an \"Intro\" chapter was added"); }
  const dedup = list.filter((c, i) => i === 0 || Math.floor(c.t) !== Math.floor(list[i - 1].t));
  if (dedup.length < 3) warnings.push("YouTube shows chapters only when there are at least three");
  const end = framesToSeconds(seq.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0), seq.fps);
  const short = dedup.filter((c, i) => (i + 1 < dedup.length ? dedup[i + 1].t : end) - c.t < 10);
  if (short.length) warnings.push(`YouTube wants chapters of 10 seconds or more: ${short.map((c) => `"${c.name}"`).slice(0, 4).join(", ")} ${short.length === 1 ? "is" : "are"} shorter`);
  return { text: dedup.map((c) => `${clock(c.t)} ${c.name}`).join("\n") + "\n", warnings };
}
