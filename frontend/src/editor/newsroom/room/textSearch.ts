/**
 * Find and replace across every graphic's words (docs/EDITOR.md §16.8): text blanks, list items (and their tags),
 * table cells and every language version, in all sequences or one. Values whose key starts with "_" are hidden tags
 * (the rundown Build's "__rundown", the automatic tools' "_auto") and are never touched. Pure: `replaceInGraphics` edits a draft (one undo step by
 * the caller).
 */
import type { EditProject, TimelineClip } from "../../model/types.ts";
import type { GfxListItem, GfxValue } from "../types.ts";

export interface FindOptions { matchCase?: boolean; wholeWord?: boolean; /** Only this sequence (default: all). */ seqId?: string }
export interface FindHit {
  seqId: string; clipId: string; clipName: string; start: number;
  /** The blank's id, and the language ("" = the main values). */
  field: string; lang: string;
  /** The text around the first match, and how many matches the value has. */
  excerpt: string; count: number;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function matcher(query: string, o: FindOptions = {}): RegExp | null {
  if (!query) return null;
  const body = esc(query);
  return new RegExp(o.wholeWord ? `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])` : body, `gu${o.matchCase ? "" : "i"}`);
}

/** Every string inside a value (text, lines, list items and tags, table cells). */
function strings(v: GfxValue): string[] {
  if (typeof v === "string") return [v];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v as unknown[]) {
    if (typeof x === "string") out.push(x);
    else if (x && typeof x === "object") {
      const it = x as Record<string, unknown>;
      if ("text" in it) { if (typeof it.text === "string") out.push(it.text); if (typeof it.tag === "string") out.push(it.tag); }
      else for (const c of Object.values(it)) if (typeof c === "string") out.push(c);
    }
  }
  return out;
}

/** The value with every match replaced (the same object when nothing matched). */
function replaceValue(v: GfxValue, re: RegExp, to: string): { v: GfxValue; n: number } {
  let n = 0;
  const rep = (s: string) => s.replace(re, () => { n++; return to; });
  if (typeof v === "string") { const r = rep(v); return { v: n ? r : v, n }; }
  if (!Array.isArray(v)) return { v, n: 0 };
  const out = (v as unknown[]).map((x) => {
    if (typeof x === "string") return rep(x);
    if (x && typeof x === "object") {
      const it = { ...(x as Record<string, unknown>) };
      if ("text" in it) { if (typeof it.text === "string") it.text = rep(it.text); if (typeof it.tag === "string") it.tag = rep(it.tag); }
      else for (const [k, c] of Object.entries(it)) if (typeof c === "string") it[k] = rep(c);
      return it;
    }
    return x;
  });
  return { v: n ? (out as GfxListItem[]) : v, n };
}

const graphicClips = (p: EditProject, seqId?: string) =>
  p.sequences.filter((s) => !seqId || s.id === seqId).flatMap((s) => s.clips.filter((c) => c.source.type === "graphic").map((c) => ({ s, c })));

function excerpt(s: string, re: RegExp): string {
  re.lastIndex = 0;
  const m = re.exec(s);
  if (!m) return s.slice(0, 60);
  const a = Math.max(0, m.index - 24), b = Math.min(s.length, m.index + m[0].length + 24);
  return `${a > 0 ? "…" : ""}${s.slice(a, b)}${b < s.length ? "…" : ""}`.replace(/\s+/g, " ");
}

/** Every blank with a match. */
export function findInGraphics(p: EditProject, query: string, o: FindOptions = {}): FindHit[] {
  const re = matcher(query, o);
  if (!re) return [];
  const hits: FindHit[] = [];
  for (const { s, c } of graphicClips(p, o.seqId)) {
    if (c.source.type !== "graphic") continue;
    const g = c.source.gfx;
    const sets: [string, Record<string, GfxValue>][] = [["", g.values], ...Object.entries(g.langs ?? {})];
    for (const [lang, vals] of sets) {
      for (const [field, v] of Object.entries(vals ?? {})) {
        if (field.startsWith("_")) continue;
        let count = 0, first = "";
        for (const str of strings(v)) { const n = str.match(re)?.length ?? 0; if (n && !first) first = str; count += n; }
        if (count) hits.push({ seqId: s.id, clipId: c.id, clipName: c.name, start: c.start, field, lang, excerpt: excerpt(first, re), count });
      }
    }
  }
  return hits;
}

/** Replaces every match on a draft; returns how many were replaced. `only` limits it to some clips. */
export function replaceInGraphics(p: EditProject, query: string, to: string, o: FindOptions = {}, only?: Set<string>): number {
  const re = matcher(query, o);
  if (!re) return 0;
  let total = 0;
  for (const s of p.sequences) {
    if (o.seqId && s.id !== o.seqId) continue;
    s.clips = s.clips.map((c: TimelineClip) => {
      if (c.source.type !== "graphic" || (only && !only.has(c.id))) return c;
      const g = c.source.gfx;
      let changed = false;
      const fix = (vals: Record<string, GfxValue>) => {
        const out: Record<string, GfxValue> = {};
        for (const [k, v] of Object.entries(vals)) {
          if (k.startsWith("_")) { out[k] = v; continue; }
          const r = replaceValue(v, re, to);
          out[k] = r.v; total += r.n; if (r.n) changed = true;
        }
        return out;
      };
      const values = fix(g.values ?? {});
      const langs = g.langs ? Object.fromEntries(Object.entries(g.langs).map(([l, v]) => [l, fix(v ?? {})])) : undefined;
      return changed ? { ...c, source: { type: "graphic" as const, gfx: { ...g, values, ...(langs ? { langs } : {}) } } } : c;
    });
  }
  return total;
}
