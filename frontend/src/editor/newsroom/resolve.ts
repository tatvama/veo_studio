/**
 * A graphic clip → what the renderer draws (docs/EDITOR.md §16.3): the template (the edit's copy, else the built-in),
 * the look, the values (defaults, the clip's values, data bound from frozen snapshots, a language version), picture
 * URLs, the air-time clock, overrides, a seed, the frame rate and the boxes of tickers on screen (collision rules).
 * Pure: the composition (model/toComposition.ts), thumbnails and the Fill in preview use it.
 */
import { framesToSeconds } from "../model/time.ts";
import type { EditProject, MediaItem, Sequence, TimelineClip } from "../model/types.ts";
import { templateOf } from "./commands.ts";
import { zonedTimeToMs } from "./format.ts";
import { resolveLook } from "./looks.ts";
import type { GfxRenderInput } from "./render/contract.ts";
import { contentBox, designSpace, valuesOf } from "./render/layout.ts";
import { layoutOverrides } from "./slots.ts";
import type { DataSnapshot, GfxField, GfxListItem, GfxRatio, GfxTableRow, GfxValue } from "./types.ts";

export interface ResolveOptions {
  urlFor?(m: MediaItem): string | undefined;
  /** A language version ("hi"): the graphic's `langs[lang]` values win. */
  lang?: string;
  /** Draw this ratio's design (the both-ratio companion); default: from the frame size. */
  ratio?: GfxRatio;
  /** The frame the graphic is drawn into (default: the sequence's), for the collision boxes. */
  width?: number; height?: number;
}

/** The default air time when the edit has none: fixed, so exports repeat on any day. */
export const DEFAULT_AIR_TIME = "2026-01-01T19:00";

/** A stable number from a string (a clip's seed). */
export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** A value from a frozen data snapshot for a field: `path` is "items", "rows", "rows.2.price" or a column of row 0. */
export function boundValue(snap: DataSnapshot | undefined, field: GfxField | undefined, path?: string): GfxValue | undefined {
  if (!snap || snap.error && !snap.rows?.length && !snap.items?.length) return undefined;
  const rows = snap.rows ?? [];
  const items = snap.items ?? rows.map((r) => ({ text: String(Object.values(r)[0] ?? "") }));
  const type = field?.type ?? "text";
  const firstCol = (r?: GfxTableRow) => (r ? Object.values(r)[0] : undefined);
  let v: unknown;
  if (!path) v = type === "list" ? items : type === "table" ? rows : firstCol(rows[0]) ?? items[0]?.text;
  else if (type === "list" && !path.includes(".") && path !== "rows" && path !== "items") {
    // a column of every row as a list
    v = rows.map((r) => ({ text: String(r[path] ?? "") }));
  } else {
    const seg = path.split(".");
    let cur: unknown = seg[0] === "rows" || seg[0] === "items" ? (seg.shift() === "rows" ? rows : items) : rows[0];
    for (const k of seg) cur = cur == null ? undefined : Array.isArray(cur) && /^\d+$/.test(k) ? cur[Number(k)] : (cur as Record<string, unknown>)[k];
    v = cur;
  }
  if (v === undefined || v === null) return undefined;
  if (type === "list" && Array.isArray(v)) return (v as unknown[]).map((x) => (typeof x === "object" && x && "text" in (x as object) ? x as GfxListItem : { text: String(typeof x === "object" && x ? firstCol(x as GfxTableRow) ?? "" : x) }));
  if (type === "number") { const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.+-]/g, "")); return Number.isFinite(n) ? n : undefined; }
  if (type === "table") return Array.isArray(v) ? v as GfxTableRow[] : undefined;
  if (typeof v === "object") return Array.isArray(v) ? (v as unknown[]).map(String).join(" · ") : undefined;
  return typeof v === "string" ? v : String(v);
}

/** Every mediaId in a value (pictures in fields, tables and lists). */
function mediaIdsIn(v: unknown, out: Set<string>): void {
  if (!v || typeof v !== "object") return;
  if (Array.isArray(v)) { v.forEach((x) => mediaIdsIn(x, out)); return; }
  const o = v as Record<string, unknown>;
  if (typeof o.mediaId === "string") out.add(o.mediaId);
  for (const x of Object.values(o)) if (x && typeof x === "object") mediaIdsIn(x, out);
}

/** Roles whose graphics keep clear of tickers. */
const AVOIDS = new Set(["strap", "board"]);

export function renderInputFor(p: EditProject, seq: Sequence, clip: TimelineClip, o: ResolveOptions = {}): GfxRenderInput | null {
  if (clip.source.type !== "graphic") return null;
  const gfx = clip.source.gfx;
  const template = templateOf(p, gfx.template);
  if (!template) return null;
  const look = resolveLook(p, gfx.look);
  const nr = p.newsroom;
  const fields = new Map(template.fields.map((f) => [f.id, f]));
  const values: Record<string, GfxValue> = valuesOf(template, gfx.values ?? {});
  for (const [id, b] of Object.entries(gfx.bind ?? {})) {
    const v = boundValue(nr?.data?.[b.source], fields.get(id), b.path);
    if (v !== undefined) values[id] = v;
  }
  if (o.lang && gfx.langs?.[o.lang]) Object.assign(values, gfx.langs[o.lang]);
  // pictures: every mediaId the values or the look use → URLs
  const ids = new Set<string>();
  mediaIdsIn(values, ids);
  if (look.logo?.mediaId) ids.add(look.logo.mediaId);
  for (const d of Object.values(template.designs)) for (const l of d?.layers ?? []) if (typeof l.p.src === "string" && !/^(data:|blob:|https?:|\/)/.test(l.p.src)) ids.add(l.p.src);
  const images: Record<string, string> = {};
  for (const id of ids) {
    const m = p.media.find((x) => x.id === id);
    const u = m ? (o.urlFor ? o.urlFor(m) : m.url) : undefined;
    if (u) images[id] = u;
  }
  const air = zonedTimeToMs(nr?.airTime || DEFAULT_AIR_TIME, look.clock.zone);
  const input: GfxRenderInput = {
    template, values, look, images, clockAt: air + framesToSeconds(clip.start, seq.fps) * 1000,
    seed: gfx.seed ?? seedOf(clip.id), fps: seq.fps,
  };
  // a layout's own overrides plus its morph (boxes glide between layouts: slots.ts); others: their own overrides
  const ov = layoutOverrides(p, seq, clip);
  if (ov && Object.keys(ov).length) input.overrides = ov;
  if (o.ratio) input.ratio = o.ratio;
  // collision rules: tickers on screen at this graphic's start
  if (nr?.settings?.collision !== false && AVOIDS.has(template.role)) {
    const W = o.width ?? seq.width, H = o.height ?? seq.height;
    const hidden = new Set(seq.tracks.filter((t) => t.hidden).map((t) => t.id));
    const avoid: NonNullable<GfxRenderInput["avoid"]> = [];
    for (const c of seq.clips) {
      if (c.id === clip.id || c.source.type !== "graphic" || !c.enabled || hidden.has(c.trackId)) continue;
      if (!(c.start <= clip.start && clip.start < c.start + c.duration)) continue;
      const t2 = templateOf(p, c.source.gfx.template);
      if (!t2 || t2.role !== "ticker") continue;
      if (c.source.gfx.ratios && o.ratio && !c.source.gfx.ratios.includes(o.ratio)) continue;
      const ds = designSpace(t2, W, H, o.ratio);
      const box = contentBox(ds.layers, ds.w, ds.h);
      if (box) avoid.push({ role: "ticker", box });
    }
    if (avoid.length) input.avoid = avoid;
  }
  return input;
}
