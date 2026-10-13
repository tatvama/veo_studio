/**
 * News Room data (docs/EDITOR.md §16.10): sources in the edit, frozen snapshots, and graphics whose fields are bound to
 * a source (`GfxInstance.bind[field] = { source, path }`). Every function edits a draft project (call them inside one
 * `host.apply`, one undo step). A binding's path says what to take:
 *   (none)          the source as a whole: its feed items or the template's mapper for lists, its rows for tables,
 *                   the first row's main value for text and numbers
 *   "Column"        that column: one list item per row, the first row's value for text / numbers
 *   "Column#3"      the third row's value of that column
 *   "@markets"      a mapper's output (items for lists, rows for tables); "@ticker:Title" names its main column
 * Pure.
 */
import type { EditProject, TimelineClip } from "../../model/types.ts";
import { ensureNewsroom } from "../commands.ts";
import { builtinTemplate } from "../templates/index.ts";
import type { DataSnapshot, DataSource, GfxField, GfxInstance, GfxListItem, GfxTableRow, GfxTemplate, GfxValue, NewsroomDoc } from "../types.ts";
import { columnsOf, findCol, MAPPERS, num, suggestMapper, type MapperId } from "./mappers.ts";

export type Binding = { source: string; path?: string };
type GClip = TimelineClip & { source: { type: "graphic"; gfx: GfxInstance } };
const isGraphic = (c: TimelineClip): c is GClip => c.source.type === "graphic";

/** A template by id: the edit's copy first, then the built-ins. */
export const templateById = (p: EditProject, id: string): GfxTemplate | undefined => p.newsroom?.templates[id] ?? builtinTemplate(id);

/** Every graphic clip in the edit (all sequences). */
export function allGraphics(p: EditProject): { seqId: string; clip: GClip }[] {
  return p.sequences.flatMap((s) => s.clips.filter(isGraphic).map((clip) => ({ seqId: s.id, clip })));
}
const findGraphic = (p: EditProject, clipId: string) => allGraphics(p).find((g) => g.clip.id === clipId)?.clip;

/** Splits a binding path: mapper, column and 0-based row. */
export function parseBindPath(path?: string): { mapper?: MapperId; column?: string; row?: number } {
  const s = (path ?? "").trim();
  if (!s) return {};
  if (s.startsWith("@")) {
    const [m, col] = s.slice(1).split(":");
    return { ...(m in MAPPERS ? { mapper: m as MapperId } : {}), ...(col ? { column: col } : {}) };
  }
  const m = s.match(/^(.*)#(\d+)$/);
  return m ? { column: m[1], row: Math.max(0, Number(m[2]) - 1) } : { column: s };
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** Rows shaped to a table field's columns (matched by id or label), numbers read for number columns. */
export function projectRows(rows: GfxTableRow[], f: Pick<GfxField, "columns">): GfxTableRow[] {
  if (!f.columns?.length) return rows;
  const have = columnsOf(rows);
  const map = f.columns.map((c) => ({ c, from: findCol(have, [c.id, c.label]) }));
  return rows.map((r) => Object.fromEntries(map.map(({ c, from }) => {
    const v = from ? r[from] : "";
    return [c.id, c.type === "number" ? num(v) ?? "" : str(v)];
  })) as GfxTableRow);
}

/** A field's value from a snapshot (undefined: nothing usable, keep the current value). */
export function valueFor(field: GfxField, b: Binding, snap: DataSnapshot | undefined, t?: GfxTemplate): GfxValue | undefined {
  if (!snap || (!snap.rows.length && !snap.items?.length)) return undefined;
  const { mapper, column, row } = parseBindPath(b.path);
  const rows = snap.rows;
  const cap = <T>(xs: T[]) => (field.maxItems ? xs.slice(0, field.maxItems) : xs);
  // items / rows for a whole-source or mapper binding
  const mapped = () => {
    const m = mapper ?? (t ? suggestMapper(t) : null);
    if (m) return MAPPERS[m].map(rows, column ? { column } : {});
    if (snap.items?.length) return { items: snap.items, rows };
    return MAPPERS.ticker.map(rows);
  };
  const whole = mapper !== undefined || column === undefined;
  switch (field.type) {
    case "list": {
      if (whole) { const m = mapper || !snap.items?.length ? mapped() : { items: snap.items, rows }; return cap(m.items.map((i) => ({ ...i }))); }
      const col = findCol(columnsOf(rows), [column!]) ?? column!;
      const items: GfxListItem[] = (row !== undefined ? rows.slice(row, row + 1) : rows).map((r) => ({ text: str(r[col]).trim() })).filter((i) => i.text);
      return cap(items);
    }
    case "table": {
      if (whole && mapper) return cap(projectRows(mapped().rows, field));
      if (whole) {
        const m = t ? suggestMapper(t) : null;
        return cap(projectRows(m && m !== "ticker" ? MAPPERS[m].map(rows).rows : rows, field));
      }
      return cap(projectRows(row !== undefined ? rows.slice(row, row + 1) : rows, field));
    }
    case "longtext": {
      if (whole) return mapped().items.map((i) => i.text).slice(0, field.maxItems ?? 1e9).join("\n");
      const col = findCol(columnsOf(rows), [column!]) ?? column!;
      if (row !== undefined) return str(rows[row]?.[col]);
      return rows.map((r) => str(r[col]).trim()).filter(Boolean).slice(0, field.maxItems ?? 1e9).join("\n");
    }
    case "number": {
      if (whole) { const it = mapped().items[row ?? 0]; return it?.value ?? num(it?.text); }
      const col = findCol(columnsOf(rows), [column!]) ?? column!;
      return num(rows[row ?? 0]?.[col]);
    }
    case "text": case "choice": case "datetime": case "color": {
      if (whole) { const it = mapped().items[row ?? 0]; return it ? it.text : undefined; }
      const col = findCol(columnsOf(rows), [column!]) ?? column!;
      const v = rows[row ?? 0]?.[col];
      return v === undefined ? undefined : str(v);
    }
    case "toggle": {
      if (whole) return undefined;
      const col = findCol(columnsOf(rows), [column!]) ?? column!;
      return /^(y|yes|true|1|on)$/i.test(str(rows[row ?? 0]?.[col]).trim());
    }
    default: return undefined;
  }
}

/** Values a graphic's bindings give now (from the frozen snapshots). */
export function boundValues(p: EditProject, gfx: GfxInstance): Record<string, GfxValue> {
  const t = templateById(p, gfx.template);
  const out: Record<string, GfxValue> = {};
  if (!t || !gfx.bind) return out;
  for (const [fid, b] of Object.entries(gfx.bind)) {
    const f = t.fields.find((x) => x.id === fid);
    if (!f) continue;
    const v = valueFor(f, b, p.newsroom?.data[b.source], t);
    if (v !== undefined) out[fid] = v;
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Fills a graphic's bound fields from the snapshots; true when a value changed. */
export function applyBindings(p: EditProject, clipId: string): boolean {
  const c = findGraphic(p, clipId);
  if (!c?.source.gfx.bind) return false;
  const vals = boundValues(p, c.source.gfx);
  const changed = Object.entries(vals).filter(([k, v]) => !same(c.source.gfx.values[k], v));
  if (!changed.length) return false;
  c.source.gfx.values = { ...c.source.gfx.values, ...Object.fromEntries(changed) };
  return true;
}

/** Graphics bound to a source: clip ids and their bound field ids. */
export function graphicsUsing(p: EditProject, sourceId: string): { seqId: string; clipId: string; name: string; fields: string[] }[] {
  return allGraphics(p).flatMap(({ seqId, clip }) => {
    const fields = Object.entries(clip.source.gfx.bind ?? {}).filter(([, b]) => b.source === sourceId).map(([f]) => f);
    return fields.length ? [{ seqId, clipId: clip.id, name: clip.name, fields }] : [];
  });
}

/**
 * Freezes a snapshot into the edit and updates every graphic bound to the source; returns how many changed. A failed
 * refresh (an error and no rows) keeps the last good rows, with the error beside them.
 */
export function refreshSource(p: EditProject, sourceId: string, snap: DataSnapshot): number {
  const nr = p.newsroom ?? ensureNewsroom(p);
  const prev = nr.data[sourceId];
  nr.data[sourceId] = snap.error && !snap.rows.length && prev?.rows.length ? { ...prev, error: snap.error } : { ...snap, source: sourceId };
  let n = 0;
  for (const g of graphicsUsing(p, sourceId)) if (applyBindings(p, g.clipId)) n++;
  return n;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "source";

/** Adds a source (an id is made from its name); returns the id. */
export function addSource(p: EditProject, s: Omit<DataSource, "id"> & { id?: string }): string {
  const nr: NewsroomDoc = p.newsroom ?? ensureNewsroom(p);
  let id = s.id ?? `src.${slug(s.name)}`;
  for (let i = 2; !s.id && nr.sources.some((x) => x.id === id); i++) id = `src.${slug(s.name)}_${i}`;
  nr.sources.push({ ...s, id });
  return id;
}

/** Changes a source's settings (a new address or root drops nothing: refresh to read it again). */
export function updateSource(p: EditProject, id: string, patch: Partial<Omit<DataSource, "id">>): void {
  const s = p.newsroom?.sources.find((x) => x.id === id);
  if (s) Object.assign(s, patch);
}

/** Removes a source and its snapshot; graphics bound to it keep their last values and lose the binding. */
export function removeSource(p: EditProject, id: string): void {
  const nr = p.newsroom;
  if (!nr) return;
  nr.sources = nr.sources.filter((x) => x.id !== id);
  delete nr.data[id];
  for (const { clip } of allGraphics(p)) {
    const b = clip.source.gfx.bind;
    if (!b) continue;
    for (const [f, x] of Object.entries(b)) if (x.source === id) delete b[f];
    if (!Object.keys(b).length) delete clip.source.gfx.bind;
  }
}

/** Binds a graphic's field to a source (null unbinds it; the value stays) and fills it now. */
export function bindField(p: EditProject, clipId: string, fieldId: string, b: Binding | null): void {
  const c = findGraphic(p, clipId);
  if (!c) return;
  const gfx = c.source.gfx;
  if (b) gfx.bind = { ...(gfx.bind ?? {}), [fieldId]: b.path ? { source: b.source, path: b.path } : { source: b.source } };
  else if (gfx.bind) { delete gfx.bind[fieldId]; if (!Object.keys(gfx.bind).length) delete gfx.bind; }
  if (b) applyBindings(p, clipId);
}

/** Fields of a template that data can fill, the best first (lists and tables, then numbers, then text). */
export function bindableFields(t: GfxTemplate): GfxField[] {
  const rank: Partial<Record<GfxField["type"], number>> = { list: 0, table: 1, number: 2, longtext: 3, text: 4 };
  return t.fields.filter((f) => rank[f.type] !== undefined).sort((a, b) => rank[a.type]! - rank[b.type]!);
}

/** A first binding for each bindable field of a template, from a snapshot (what "Use in graphic" proposes). */
export function suggestBindings(t: GfxTemplate, sourceId: string, snap: DataSnapshot | undefined): Record<string, Binding> {
  const out: Record<string, Binding> = {};
  const cols = snap ? columnsOf(snap.rows) : [];
  const m = suggestMapper(t);
  for (const f of bindableFields(t)) {
    if (f.type === "list" || f.type === "table") { out[f.id] = { source: sourceId, ...(m ? { path: `@${m}` } : {}) }; continue; }
    const col = findCol(cols, [f.id, f.label, ...(f.fill ? [f.fill.split(".").pop()!] : [])]);
    if (col) { out[f.id] = { source: sourceId, path: col }; continue; }
    // "team1" / "score2": that column, that row
    const n = f.id.match(/^(.*?)_?(\d+)$/);
    const base = n ? findCol(cols, [n[1]]) : undefined;
    if (n && base) out[f.id] = { source: sourceId, path: Number(n[2]) > 1 ? `${base}#${n[2]}` : base };
  }
  return out;
}
