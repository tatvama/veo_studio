/**
 * The News Room room (docs/EDITOR.md §16.8): filling a template's blanks from the people library, places and rundown
 * stories, plus the small conversions the Fill in form needs (lines ↔ list items, character hints, values by
 * language). A field says where its value usually comes from with `fill` ("person.name", "person.role",
 * "person.photo", "place", "story.headline" …); templates without `fill` are matched by field id instead. Pure.
 */
import type { GfxField, GfxImageRef, GfxInstance, GfxListItem, GfxTemplate, GfxValue, Person, Place, RundownStory } from "../types.ts";

export type FillSource = "person" | "place" | "story";

/** Which picker a field gets (by its `fill`, else by its id). */
export function fillSource(f: GfxField): FillSource | null {
  const fill = (f.fill ?? "").toLowerCase();
  if (fill.startsWith("person")) return "person";
  if (fill.startsWith("place") || fill === "location") return "place";
  if (fill.startsWith("story")) return "story";
  return null;
}

/** What a field holds, from its `fill` or (without one) its id: "person.name", "place", "story.headline" … */
export function fillKey(f: GfxField): string | null {
  if (f.fill) return f.fill.toLowerCase();
  const id = f.id.toLowerCase().replace(/[\s-]+/g, "_");
  const by: [RegExp, string][] = [
    [/^(name|person|person_name|guest|anchor|reporter_name|speaker)$/, "person.name"],
    [/^(role|title_role|designation|position|job)$/, "person.role"],
    [/^(photo|picture|portrait|face|headshot|image)$/, "person.photo"],
    [/^(location|place|city|dateline|from)$/, "place"],
    [/^(headline|head|title|line1|line_1|main)$/, "story.headline"],
    [/^(strap|sub|subtitle|subhead|line2|line_2|second)$/, "story.strap"],
    [/^(slug|tag|story)$/, "story.slug"],
    [/^(points|bullets|key_points|keypoints)$/, "story.points"],
    [/^(items|lines|ticker|headlines)$/, "story.ticker"],
  ];
  for (const [re, k] of by) if (re.test(id)) return k;
  return null;
}

// ── value conversions ────────────────────────────────────────────────────────

export const lines = (s: string): string[] => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
export const toItems = (ls: string[]): GfxListItem[] => ls.map((text) => ({ text }));
export const itemsText = (v: GfxValue): string =>
  Array.isArray(v) ? (v as unknown[]).map((x) => (typeof x === "string" ? x : (x as GfxListItem)?.text ?? "")).join("\n") : typeof v === "string" ? v : "";

/** A plain value (text or lines) in the shape a field wants. */
export function coerce(f: GfxField, v: string | string[] | GfxImageRef | null | undefined): GfxValue | undefined {
  if (v === undefined) return undefined;
  if (f.type === "image") return v === null ? null : typeof v === "object" && !Array.isArray(v) ? v : undefined;
  if (v === null || (typeof v === "object" && !Array.isArray(v))) return undefined;
  const ls = Array.isArray(v) ? v.filter((x) => x.trim()) : lines(v);
  switch (f.type) {
    case "list": return toItems(f.maxItems ? ls.slice(0, Math.max(1, f.maxItems)) : ls);
    case "longtext": return ls.join("\n");
    case "text": case "choice": case "datetime": return Array.isArray(v) ? v.join(" · ") : v;
    default: return undefined;
  }
}

// ── people, places, stories ──────────────────────────────────────────────────

const nameIn = (names: Record<string, string> | undefined, base: string, lang?: string) => (lang && names?.[lang]?.trim() ? names[lang] : base);

/** A person's value for one blank ("person.name" …), in a language when the person has one. */
export function personValue(key: string, p: Person, lang?: string): string | GfxImageRef | null | undefined {
  switch (key) {
    case "person.name": return nameIn(p.names, p.name, lang);
    case "person.role": return p.role;
    case "person.photo": return p.photo ?? null;
    case "person.location": case "place": return p.location ?? undefined;
    case "person.kind": return p.kind ?? undefined;
    default: return undefined;
  }
}

/** Values for every blank of a template a person fills (name, role, photo and location together). */
export function valuesFromPerson(t: GfxTemplate, p: Person, lang?: string): Record<string, GfxValue> {
  const out: Record<string, GfxValue> = {};
  for (const f of t.fields) {
    const k = fillKey(f);
    if (!k || !(k.startsWith("person") || k === "place")) continue;
    const v = coerce(f, personValue(k === "person" ? "person.name" : k, p, lang));
    if (v !== undefined) out[f.id] = v;
  }
  return out;
}

/** Values for the place blanks of a template. */
export function valuesFromPlace(t: GfxTemplate, pl: Place, lang?: string): Record<string, GfxValue> {
  const out: Record<string, GfxValue> = {};
  for (const f of t.fields) {
    const k = fillKey(f);
    if (k !== "place" && k !== "person.location" && k !== "place.name") continue;
    const v = coerce(f, nameIn(pl.names, pl.name, lang));
    if (v !== undefined) out[f.id] = v;
  }
  return out;
}

/** A story's value for one blank ("story.headline" …). */
export function storyValue(key: string, s: RundownStory): string | string[] | undefined {
  switch (key) {
    case "story.headline": case "story": return s.headline;
    case "story.strap": return s.strap ?? "";
    case "story.slug": return s.slug;
    case "story.points": return s.points ?? [];
    case "story.ticker": return s.ticker ?? [];
    case "story.location": case "place": return s.location ?? undefined;
    case "story.notes": return s.notes ?? "";
    default: return undefined;
  }
}

/**
 * Values for a template from a rundown story: its own blanks ("story.*"), the location, and the reporter's name,
 * role and photo (people library) when the template has person blanks.
 */
export function valuesFromStory(t: GfxTemplate, s: RundownStory, people: Person[] = [], lang?: string): Record<string, GfxValue> {
  const out: Record<string, GfxValue> = {};
  const reporter = s.reporter ? people.find((p) => p.id === s.reporter) : undefined;
  for (const f of t.fields) {
    const k = fillKey(f);
    if (!k) continue;
    let v: GfxValue | undefined;
    if (k.startsWith("story") || (k === "place" && s.location)) v = coerce(f, storyValue(k, s));
    else if (k.startsWith("person") && reporter) v = coerce(f, personValue(k, reporter, lang));
    if (k === "place" && v === undefined && reporter?.location) v = coerce(f, reporter.location);
    if (v !== undefined) out[f.id] = v;
  }
  return out;
}

// ── the form ─────────────────────────────────────────────────────────────────

/** "23 / 40" and whether it's over the soft limit (text), or "3 / 5 lines" (longtext, lists). */
export function lengthHint(f: GfxField, v: GfxValue): { text: string; over: boolean } | null {
  if (f.type === "text" && f.maxLength) {
    const n = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(typeof v === "string" ? v : "")].length;
    return { text: `${n} / ${f.maxLength}`, over: n > f.maxLength };
  }
  const max = f.maxItems ?? (f.type === "longtext" ? f.maxLength : undefined);
  if ((f.type === "longtext" || f.type === "list") && max) {
    const n = f.type === "list" ? (Array.isArray(v) ? v.length : 0) : lines(typeof v === "string" ? v : "").length;
    return { text: `${n} / ${max} lines`, over: n > max };
  }
  return null;
}

/** The value a graphic shows for a field in a language: that language's own value, else the main one, else the
 *  template's default. */
export function valueIn(g: GfxInstance, f: GfxField, lang?: string): GfxValue {
  const own = lang ? g.langs?.[lang]?.[f.id] : undefined;
  if (own !== undefined && own !== null && own !== "") return own;
  return g.values[f.id] ?? f.default;
}

/** Groups fields by `group` (in order of first appearance; ungrouped first). */
export function groupFields(fields: GfxField[]): { group: string | null; fields: GfxField[] }[] {
  const out: { group: string | null; fields: GfxField[] }[] = [];
  for (const f of fields) {
    const g = f.group ?? null;
    const have = out.find((x) => x.group === g);
    if (have) have.fields.push(f); else out.push({ group: g, fields: [f] });
  }
  return out.sort((a, b) => (a.group === null ? -1 : b.group === null ? 1 : 0));
}

/** Words a graphic shows (its text blanks), for a name on the timeline and the playlist. */
export function graphicLabel(t: GfxTemplate | undefined, values: Record<string, GfxValue>, max = 40): string {
  if (!t) return "Graphic";
  for (const f of t.fields) {
    if (f.type !== "text" && f.type !== "longtext") continue;
    const v = values[f.id] ?? f.default;
    if (typeof v === "string" && v.trim()) { const s = v.trim().split(/\r?\n/)[0]; return s.length > max ? `${s.slice(0, max - 1)}…` : s; }
  }
  return t.name;
}
