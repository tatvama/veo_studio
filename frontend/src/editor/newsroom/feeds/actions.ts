/**
 * News Room data in the editor (docs/EDITOR.md §16.10): adding a source (a web address, a file, a typed or pasted
 * table), refreshing one or all (each one undo step that freezes the snapshot into the edit and updates the graphics
 * bound to it), and binding a graphic's fields. Messages are plain and calm. Browser only.
 */
import { toast } from "sonner";
import type { EditorHost } from "../../model/types";
import type { DataSource } from "../types";
import { addSource, bindField, refreshSource, suggestBindings, templateById, type Binding } from "./bind";
import { canRefresh, loadSourceText, plainError } from "./load";
import { isSheetUrl } from "./sheet";
import { detectKind, failedSnapshot, parseSourceText, snapshotFrom } from "./snapshot";
import { findLists } from "./json";

type Draft = Omit<DataSource, "id">;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A name for a web address: its file name or site ("example.com"). */
export function nameForUrl(url: string): string {
  try {
    const u = new URL(url);
    if (isSheetUrl(url)) return "Google Sheet";
    const file = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "").replace(/\.(csv|tsv|json|xml|rss|atom|txt)$/i, "");
    return file && file.length < 40 && !/^(feed|rss|index|export|pub)$/i.test(file) ? file : u.hostname.replace(/^www\./, "");
  } catch { return "Web data"; }
}

const kindOf = (text: string, url?: string): DataSource["kind"] => {
  if (url && isSheetUrl(url)) return "sheet";
  const k = detectKind(text);
  return k === "html" ? "csv" : k;
};

/** Reads a web address and adds it as a source (one undo step); returns the source id, or null on failure. */
export async function addWebSource(host: EditorHost, url: string, name?: string): Promise<string | null> {
  const draft: Draft = { name: name?.trim() || nameForUrl(url), kind: isSheetUrl(url) ? "sheet" : "csv", url: url.trim() };
  let text: string;
  try { text = await loadSourceText({ id: "new", ...draft }); } catch (e) { toast.error(plainError(e)); return null; }
  try { parseSourceText({ kind: draft.kind }, text); } catch (e) { toast.error(plainError(e)); return null; }
  const kind = kindOf(text, url);
  let root: string | undefined;
  if (kind === "json") { try { const v = JSON.parse(text.replace(/^\uFEFF/, "")); if (!Array.isArray(v)) root = findLists(v, 1)[0] || undefined; } catch { /* checked above */ } }
  return addWithText(host, { ...draft, kind, ...(root ? { root } : {}) }, text, `Add ${draft.name}`);
}

/** Adds a local file (picked) as a source. */
export async function addFileSource(host: EditorHost, f: { name: string; text: string; path?: string }): Promise<string | null> {
  const kind = kindOf(f.text);
  const name = f.name.replace(/\.(csv|tsv|json|xml|rss|atom|txt)$/i, "");
  try { parseSourceText({ kind }, f.text); } catch (e) { toast.error(plainError(e)); return null; }
  let root: string | undefined;
  if (kind === "json") { try { const v = JSON.parse(f.text.replace(/^\uFEFF/, "")); if (!Array.isArray(v)) root = findLists(v, 1)[0] || undefined; } catch { /* checked */ } }
  return addWithText(host, { name, kind, ...(f.path ? { path: f.path } : {}), ...(root ? { root } : {}) }, f.text, `Add ${name}`);
}

/** Adds a typed or pasted table (CSV, TSV or JSON text) as a manual source. */
export function addTableSource(host: EditorHost, name: string, text: string): string | null {
  try { parseSourceText({ kind: "manual" }, text); } catch (e) { toast.error(plainError(e)); return null; }
  return addWithText(host, { name: name.trim() || "Table", kind: "manual" }, text, `Add ${name.trim() || "table"}`);
}

function addWithText(host: EditorHost, s: Draft, text: string, label: string): string | null {
  let id = "";
  host.apply(label, (d) => {
    id = addSource(d, s);
    const src = d.newsroom!.sources.find((x) => x.id === id)!;
    refreshSource(d, id, snapshotFrom(src, text));
  });
  const snap = host.project().newsroom?.data[id];
  if (snap?.error) toast.warning(`${s.name}: ${snap.error}`);
  else toast.success(`Added ${s.name}: ${plural(snap?.rows.length ?? 0, "row")}`);
  return id || null;
}

/** Replaces a manual table's rows from text (one undo step). */
export function saveTable(host: EditorHost, sourceId: string, text: string): boolean {
  const src = host.project().newsroom?.sources.find((s) => s.id === sourceId);
  if (!src) return false;
  const snap = snapshotFrom(src, text);
  if (snap.error) { toast.error(snap.error); return false; }
  let n = 0;
  host.apply(`Edit ${src.name}`, (d) => { n = refreshSource(d, sourceId, snap); });
  toast.success(`Saved ${src.name}${n ? `: ${plural(n, "graphic")} updated` : ""}`);
  return true;
}

/** Reads a source again and freezes what it says now (a failure is kept beside the last good rows). */
export async function refreshSources(host: EditorHost, ids: string[]): Promise<void> {
  const nr = host.project().newsroom;
  const list = (nr?.sources ?? []).filter((s) => ids.includes(s.id) && canRefresh(s));
  if (!list.length) { toast.message(ids.length === 1 ? "This source can't be read again here. Edit it, or choose the file again." : "Nothing to refresh"); return; }
  const at = new Date().toISOString();
  const got = await Promise.all(list.map(async (s) => {
    try { return { s, snap: snapshotFrom(s, await loadSourceText(s), at) }; }
    catch (e) { return { s, snap: failedSnapshot(s, plainError(e), host.project().newsroom?.data[s.id], at) }; }
  }));
  let updated = 0;
  host.apply(list.length === 1 ? `Refresh ${list[0].name}` : "Refresh all data", (d) => { for (const g of got) updated += refreshSource(d, g.s.id, g.snap); });
  const bad = got.filter((g) => g.snap.error);
  if (bad.length) toast.error(bad.map((g) => `${g.s.name}: ${g.snap.error}`).join("\n"));
  else toast.success(`Refreshed ${list.length === 1 ? list[0].name : plural(list.length, "source")}${updated ? `: ${plural(updated, "graphic")} updated` : ""}`);
}

/** Links (or unlinks) one field of a graphic to a source (one undo step). */
export function linkField(host: EditorHost, clipId: string, fieldId: string, b: Binding | null, label: string): void {
  host.apply(b ? `Link ${label}` : `Unlink ${label}`, (d) => bindField(d, clipId, fieldId, b));
}

/** Links every field of a graphic the source suggests (one undo step); returns how many. */
export function linkSuggested(host: EditorHost, clipId: string, templateId: string, sourceId: string): number {
  const p = host.project();
  const t = templateById(p, templateId);
  if (!t) return 0;
  const sug = suggestBindings(t, sourceId, p.newsroom?.data[sourceId]);
  const n = Object.keys(sug).length;
  if (n) host.apply("Link graphic to data", (d) => { for (const [f, b] of Object.entries(sug)) bindField(d, clipId, f, b); });
  return n;
}

