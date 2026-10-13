/**
 * News Room data (docs/EDITOR.md §16.10): CSV and TSV as Excel, Google Sheets and people write them: quoted fields
 * with commas, quotes ("") and line breaks inside, CRLF / LF / CR lines, a BOM, and the separator sniffed (comma, tab,
 * semicolon, pipe). The first non-empty row is the header; blank and duplicate headers get names. Pure.
 */
import type { GfxTableRow } from "../types.ts";

export type Delimiter = "," | "\t" | ";" | "|";
const DELIMS: Delimiter[] = [",", "\t", ";", "|"];

/** Rows of fields, as written (no trimming inside quotes). */
export function parseDelimited(text: string, delim: Delimiter = sniffDelimiter(text)): string[][] {
  const s = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [], cur = "", quoted = false, wasQuoted = false;
  const endField = () => { row.push(wasQuoted ? cur : cur.trim()); cur = ""; wasQuoted = false; };
  const endRow = () => { endField(); if (row.some((f) => f !== "")) rows.push(row); row = []; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += ch;
    } else if (ch === '"' && cur.trim() === "") { quoted = true; wasQuoted = true; cur = ""; }
    else if (ch === delim) endField();
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; endRow(); }
    else cur += ch;
  }
  if (cur !== "" || row.length || wasQuoted) endRow();
  return rows;
}

/** The separator that splits the first lines most consistently (outside quotes); comma when nothing does. */
export function sniffDelimiter(text: string): Delimiter {
  const lines: string[] = [];
  let cur = "", quoted = false;
  for (const ch of text.replace(/^\uFEFF/, "").slice(0, 20_000)) {
    if (ch === '"') quoted = !quoted;
    if ((ch === "\n" || ch === "\r") && !quoted) { if (cur.trim()) lines.push(cur); cur = ""; if (lines.length >= 10) break; continue; }
    cur += quoted ? (ch === "," || ch === "\t" || ch === ";" || ch === "|" ? "" : ch) : ch;
  }
  if (cur.trim() && lines.length < 10) lines.push(cur);
  let best: Delimiter = ",", score = 0;
  for (const d of DELIMS) {
    const counts = lines.map((l) => l.split(d).length - 1);
    if (!counts.length || counts[0] === 0) continue;
    const same = counts.filter((c) => c === counts[0]).length;
    const sc = same * 10 + counts[0] + (d === "\t" ? 0.5 : 0);
    if (sc > score) { score = sc; best = d; }
  }
  return best;
}

/** Header names: trimmed, blanks → "Column 3", duplicates → "Name 2". */
export function headerNames(row: string[]): string[] {
  const seen = new Map<string, number>();
  return row.map((h, i) => {
    let name = h.replace(/\s+/g, " ").trim() || `Column ${i + 1}`;
    const k = name.toLowerCase(), n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n > 1) name = `${name} ${n}`;
    return name;
  });
}

/**
 * A plain number written in a cell ("42", "-3.5", "1,23,456", "12,345.6") → the number; anything else (a code with
 * leading zeros like "0712", a percentage, words) stays text.
 */
export function cellValue(s: string): string | number {
  const t = s.trim();
  if (t.replace(/\D/g, "").length > 15) return s;
  if (/^[-+]?(0|[1-9]\d*)(\.\d+)?$/.test(t)) return Number(t);
  // grouped: 12,345,678.9 (international) or 1,23,45,678 (Indian)
  if (/^[-+]?[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(t) || /^[-+]?[1-9]\d?(,\d{2})*,\d{3}(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ""));
  return s;
}

/** Table rows (header → value) from CSV / TSV text. Short rows get empty cells; extra cells get "Column n" names. */
export function csvRows(text: string, delim?: Delimiter): { columns: string[]; rows: GfxTableRow[] } {
  const all = parseDelimited(text, delim ?? sniffDelimiter(text));
  if (!all.length) return { columns: [], rows: [] };
  const width = Math.max(...all.map((r) => r.length));
  const columns = headerNames([...all[0], ...new Array<string>(Math.max(0, width - all[0].length)).fill("")]);
  const rows = all.slice(1).map((r) => Object.fromEntries(columns.map((c, i) => [c, cellValue(r[i] ?? "")])) as GfxTableRow);
  return { columns, rows };
}

/** Rows back to text (TSV by default: what the manual table editor shows), quoting where needed. */
export function toDelimited(columns: string[], rows: GfxTableRow[], delim: Delimiter = "\t"): string {
  const q = (v: unknown) => { const s = v === undefined || v === null ? "" : String(v); return /["\n\r]/.test(s) || s.includes(delim) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.map(q).join(delim), ...rows.map((r) => columns.map((c) => q(r[c])).join(delim))].join("\n");
}
