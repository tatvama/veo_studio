/**
 * Ticker items as lines of text, for the item editor's "Paste lines" (tickers/ItemsEditor.tsx): one item per line,
 * "!" at the start makes it a priority item, and columns split by a tab (pasted from a spreadsheet) or " | " give
 * the tag, value and change when the list uses them ("Sports | India beat Malaysia", "SENSEX | 81,523.16 | +412.30").
 * Also which detail columns a list uses, moving an item, and the loop length in words. Pure.
 */
import type { GfxListItem, GfxValue } from "../types.ts";
import { estimateLoop } from "./math.ts";

/** The detail columns a list shows besides its text. */
export interface ItemColumns { tag: boolean; value: boolean; delta: boolean; icon: boolean; color: boolean }
export const NO_COLUMNS: ItemColumns = { tag: false, value: false, delta: false, icon: false, color: false };

const asItems = (v: GfxValue | undefined): GfxListItem[] =>
  Array.isArray(v) ? (v as unknown[]).map((x) => (typeof x === "string" ? { text: x } : (x as GfxListItem))).filter((x) => x && typeof x === "object") : [];

/** The columns a list uses: any detail set in its items or in the field's sample items. */
export function columnsFor(value: GfxValue | undefined, fallback?: GfxValue): ItemColumns {
  const all = [...asItems(value), ...asItems(fallback)];
  const has = (k: keyof GfxListItem) => all.some((i) => i[k] !== undefined && i[k] !== null && i[k] !== "");
  return { tag: has("tag"), value: has("value"), delta: has("delta"), icon: has("icon"), color: has("color") };
}

/** "₹73,450" → 73450, "+412.30" → 412.3, "−0.06" → -0.06, "1,23,456.7" → 123456.7, "34°C" → 34; undefined if not a number. */
export function parseNumberLoose(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const t = s.trim().replace(/[−–]/g, "-").replace(/[₹$€£,\s%°]|[CF]$/g, "");
  if (!t || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Lines of text → items (empty lines dropped). Columns are read in the order tag, text, value, change. */
export function parseLines(text: string, cols: ItemColumns): GfxListItem[] {
  const out: GfxListItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const flash = line.startsWith("!");
    if (flash) line = line.slice(1).trim();
    const parts = line.includes("\t") ? line.split("\t").map((x) => x.trim()) : line.split(/\s+\|\s+/).map((x) => x.trim());
    const it: GfxListItem = { text: "" };
    let i = 0;
    if (cols.tag && parts.length > 1 && !(cols.value && parts.length === 2 && parseNumberLoose(parts[1]) !== undefined)) it.tag = parts[i++];
    it.text = parts[i++] ?? "";
    const v = parseNumberLoose(parts[i]);
    if (v !== undefined) { it.value = v; i++; }
    const d = parseNumberLoose(parts[i]);
    if (d !== undefined) { it.delta = d; i++; }
    // anything left over stays part of the text (a " | " in a headline)
    if (i < parts.length) it.text = [it.text, ...parts.slice(i)].filter(Boolean).join(" | ");
    if (flash) it.flash = true;
    if (it.text || it.value !== undefined) out.push(it);
  }
  return out;
}

/** Items → lines in the same form parseLines reads (for editing them as text). */
export function itemsToLines(items: GfxListItem[], cols: ItemColumns): string {
  return items.map((it) => {
    const parts = [...(cols.tag && it.tag ? [it.tag] : []), it.text];
    if (it.value !== undefined) parts.push(String(it.value));
    if (it.delta !== undefined) parts.push(it.delta > 0 ? `+${it.delta}` : String(it.delta));
    return `${it.flash ? "!" : ""}${parts.join(" | ")}`;
  }).join("\n");
}

/** A copy of the list with one item moved from `from` to `to` (an index in the new list). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x);
  return out;
}

/** "about 45 s" / "about 1 min 12 s" for one pass of a crawl at the 16:9 defaults. */
export function loopText(items: GfxListItem[]): string {
  const s = Math.round(estimateLoop(items));
  if (!items.length) return "";
  if (s < 60) return `about ${Math.max(1, s)} s`;
  const m = Math.floor(s / 60), r = s % 60;
  return `about ${m} min${r ? ` ${r} s` : ""}`;
}
