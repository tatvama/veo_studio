/**
 * Spreadsheet rows for the batch export (docs/EDITOR.md §16.11): CSV as Excel and Google Sheets save it (RFC 4180:
 * quoted fields with commas, quotes and line breaks; "" for a quote), or tab-separated text pasted from a sheet.
 * The first non-empty row is the header. Pure.
 */

export interface Table { columns: string[]; rows: Record<string, string>[] }

/** Comma, semicolon (European Excel) or tab: whichever splits the header line into the most columns. */
export function guessDelimiter(text: string): "," | ";" | "\t" {
  const first = text.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  const count = (d: string) => first.split(d).length;
  return (["\t", ";", ","] as const).reduce((best, d) => (count(d) > count(best) ? d : best), "," as "," | ";" | "\t");
}

/** Every record as a list of cells. */
export function parseRecords(text: string, delimiter = guessDelimiter(text)): string[][] {
  const s = text.replace(/^﻿/, "");
  const out: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, i = 0;
  const endCell = () => { row.push(cell); cell = ""; };
  const endRow = () => { endCell(); if (row.some((c) => c.trim())) out.push(row); row = []; };
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell.trim() === "") { quoted = true; cell = ""; i++; continue; }
    if (ch === delimiter) { endCell(); i++; continue; }
    if (ch === "\r" || ch === "\n") { endRow(); i += ch === "\r" && s[i + 1] === "\n" ? 2 : 1; continue; }
    cell += ch; i++;
  }
  if (cell || row.length) endRow();
  return out;
}

/** Header + rows keyed by column name (blank or repeated headers get "Column 3", "Name 2"). */
export function parseTable(text: string, delimiter?: "," | ";" | "\t"): Table {
  const recs = parseRecords(text, delimiter);
  if (!recs.length) return { columns: [], rows: [] };
  const seen = new Map<string, number>();
  const columns = recs[0].map((h, i) => {
    let name = h.trim() || `Column ${i + 1}`;
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    if (n > 1) name = `${name} ${n}`;
    return name;
  });
  const rows = recs.slice(1).map((r) => Object.fromEntries(columns.map((c, i) => [c, (r[i] ?? "").trim()])));
  return { columns, rows };
}
