/**
 * Rundown Build (docs/EDITOR.md §16.8): places each story's graphics on its part of the timeline — the headline strap,
 * the reporter's strap, a key points board and its ticker lines. A story's range comes from the story itself (built
 * or marked before), a sequence marker named like its slug, or an even split of the sequence (snapped to the cuts on
 * V1). Everything Build places is tagged (`BUILD_TAG` in the graphic's values: "<story id>:<part>"), so building
 * again replaces it instead of doubling it. `planBuild` is the dry run the Rundown panel lists; `applyBuild` does it
 * on a draft (the caller wraps it in one undo step). Pure.
 */
import { clipEnd, ctxOf, removeClips, seqEnd, tracksOf } from "../model/ops.ts";
import { framesToSeconds, secondsToFrames } from "../model/time.ts";
import type { EditProject, Sequence, TimelineClip } from "../model/types.ts";
import { addGraphic } from "./commands.ts";
import { fillKey, valuesFromStory } from "./room/fields.ts";
import type { GfxInstance, GfxTemplate, GfxValue, Person, RundownStory } from "./types.ts";

export type BuildPart = "headline" | "reporter" | "points" | "ticker";
export const BUILD_PARTS: { part: BuildPart; label: string; hint: string }[] = [
  { part: "headline", label: "Headline strap", hint: "the story's headline and second line" },
  { part: "reporter", label: "Reporter strap", hint: "name, role and location of the story's reporter" },
  { part: "points", label: "Key points board", hint: "the story's key points, one by one" },
  { part: "ticker", label: "Ticker lines", hint: "the story's ticker lines across its whole range" },
];

/** The value key that marks a graphic as placed by Build: "<story id>:<part>". */
export const BUILD_TAG = "__rundown";
export const buildTagOf = (g: GfxInstance | undefined): string | null => {
  const v = g?.values?.[BUILD_TAG];
  return typeof v === "string" && v ? v : null;
};
const gfxOf = (c: TimelineClip): GfxInstance | undefined => (c.source.type === "graphic" ? c.source.gfx : undefined);

// ── where stories sit ────────────────────────────────────────────────────────

export type RangeMode = "auto" | "markers" | "clips" | "even";
export const RANGE_MODES: { id: RangeMode; label: string; hint: string }[] = [
  { id: "auto", label: "Automatic", hint: "a story's own range, else its marker, else a share of the sequence snapped to cuts" },
  { id: "markers", label: "Story markers", hint: "markers named like each story's slug (Marker → Add marker, then name it)" },
  { id: "clips", label: "Split at cuts", hint: "the sequence shared out in rundown order, each part ending on a cut" },
  { id: "even", label: "Split evenly", hint: "the sequence shared out in equal parts, in rundown order" },
];

export interface StoryRange { storyId: string; start: number; end: number; from: "story" | "marker" | "cuts" | "even" }

const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The marker that starts a story (named like its slug or headline). */
export function storyMarker(seq: Sequence, s: RundownStory) {
  const keys = [norm(s.slug), norm(s.headline)].filter(Boolean);
  return seq.markers.find((m) => keys.includes(norm(m.name)));
}

/** Picture clips on V1 (graphics excluded), for snapping a split to the cuts. */
function cutsOf(seq: Sequence): number[] {
  const v1 = tracksOf(seq, "video").find((t) => !t.gfxRole);
  if (!v1) return [];
  const pts = new Set<number>();
  for (const c of seq.clips) if (c.trackId === v1.id && c.source.type !== "graphic") { pts.add(c.start); pts.add(clipEnd(c)); }
  return [...pts].sort((a, b) => a - b);
}

/** Where every story sits (in rundown order). `length` overrides the sequence length (an empty sequence). */
export function storyRanges(seq: Sequence, stories: RundownStory[], mode: RangeMode = "auto", length?: number): StoryRange[] {
  const L = Math.max(1, length ?? seqEnd(seq));
  const n = stories.length;
  if (!n) return [];
  const cuts = mode !== "even" ? cutsOf(seq) : [];
  const snap = cuts.length > 2;
  // the even split, its inner boundaries snapped to the nearest cut (kept increasing)
  const bounds: number[] = [0];
  for (let k = 1; k < n; k++) {
    const raw = Math.round((k * L) / n);
    let b = raw;
    if (snap) {
      const near = cuts.reduce((best, c) => (Math.abs(c - raw) < Math.abs(best - raw) ? c : best), cuts[0]);
      if (near > bounds[k - 1] && near < L && Math.abs(near - raw) <= L / n / 2) b = near;
    }
    bounds.push(Math.max(bounds[k - 1] + 1, b));
  }
  bounds.push(Math.max(bounds[n - 1] + 1, L));
  const split = (i: number): StoryRange => ({ storyId: stories[i].id, start: bounds[i], end: bounds[i + 1], from: snap ? "cuts" : "even" });
  if (mode === "even" || mode === "clips") return stories.map((_, i) => split(i));

  // story markers in time order: one runs to the next story's marker (or its own length, or the end)
  const marks = stories.map((s) => storyMarker(seq, s));
  const starts = marks.filter(Boolean).map((m) => m!.frame).sort((a, b) => a - b);
  return stories.map((s, i) => {
    if (mode === "auto" && s.start !== undefined && s.end !== undefined && s.end > s.start) return { storyId: s.id, start: s.start, end: s.end, from: "story" };
    const m = marks[i];
    if (m) {
      const next = starts.find((f) => f > m.frame);
      const end = m.duration > 0 ? m.frame + m.duration : next ?? Math.max(L, m.frame + 1);
      return { storyId: s.id, start: m.frame, end: Math.max(m.frame + 1, end), from: "marker" };
    }
    return split(i);
  });
}

// ── what goes where ──────────────────────────────────────────────────────────

/** Seconds a graphic needs to be read: its words at `readSpeed` words / s plus its in and out, within [min, max]
 *  (a "fixed" template keeps its own length). */
export function holdSeconds(t: GfxTemplate, values: Record<string, GfxValue>, readSpeed = 3, min = 4, max = 12): number {
  if (t.hold === "fixed" && t.seconds > 0) return t.seconds;
  let words = 0;
  const count = (s: string) => { words += s.split(/\s+/).filter(Boolean).length; };
  for (const f of t.fields) {
    const v = values[f.id] ?? f.default;
    if (typeof v === "string" && (f.type === "text" || f.type === "longtext")) count(v);
    else if (Array.isArray(v)) for (const x of v as unknown[]) {
      if (typeof x === "string") count(x);
      else if (x && typeof x === "object" && "text" in x) count(String((x as { text: unknown }).text ?? ""));
    }
  }
  const s = words / Math.max(0.5, readSpeed) + (t.timing?.in ?? 0.6) + (t.timing?.out ?? 0.4) + 1;
  return Math.min(max, Math.max(min, Math.round(s * 10) / 10));
}

export interface BuildOptions {
  /** Default: the active sequence. */
  seqId?: string;
  /** Which parts to place (default: all). */
  parts?: Partial<Record<BuildPart, boolean>>;
  /** The template for each part (the Rundown panel's choices, defaults from room/pick.ts). */
  templates: Partial<Record<BuildPart, GfxTemplate>>;
  ranges?: RangeMode;
  /** Build only these stories (default: all; then graphics of deleted stories are removed too). */
  only?: string[];
  readSpeed?: number;
  /** For stories that name their own templates (`story.graphics`). */
  templateById?(id: string): GfxTemplate | undefined;
  /** Sequence length to share out when the sequence is empty (frames). */
  length?: number;
  lang?: string;
}

export interface BuildItem {
  storyId: string; slug: string; part: BuildPart; template: GfxTemplate;
  /** Sequence frames. */ at: number; duration: number;
  values: Record<string, GfxValue>;
}
export interface BuildPlan {
  seqId: string;
  items: BuildItem[];
  /** Graphics an earlier Build placed (replaced). */
  remove: string[];
  ranges: StoryRange[];
  /** Plain-English notes for the dry run ("PUNE RAINS: too short for a reporter strap"). */
  notes: string[];
}

/** Which part a story's own template fills. */
function partOf(t: GfxTemplate): BuildPart | null {
  if (t.role === "ticker") return "ticker";
  if (t.role === "board") return "points";
  if (t.role === "strap") return t.fields.some((f) => fillKey(f)?.startsWith("person")) ? "reporter" : "headline";
  return null;
}

/** The first text blank, when a template has no blank the story fills (so the headline always shows). */
function ensureText(t: GfxTemplate, values: Record<string, GfxValue>, text: string) {
  if (t.fields.some((f) => values[f.id] !== undefined && (f.type === "text" || f.type === "longtext"))) return;
  const f = t.fields.find((x) => x.type === "text" || x.type === "longtext");
  if (f) values[f.id] = text;
}
function ensureList(t: GfxTemplate, values: Record<string, GfxValue>, ls: string[]) {
  const f = t.fields.find((x) => x.type === "list");
  if (f && values[f.id] === undefined) values[f.id] = ls.map((text) => ({ text }));
  else if (!f) { const lt = t.fields.find((x) => x.type === "longtext"); if (lt && values[lt.id] === undefined) values[lt.id] = ls.join("\n"); }
}

/** The dry run: every graphic Build would place, and the earlier ones it replaces. */
export function planBuild(p: EditProject, o: BuildOptions): BuildPlan {
  const seqId = o.seqId ?? p.activeSequenceId;
  const seq = p.sequences.find((s) => s.id === seqId);
  const nr = p.newsroom;
  const plan: BuildPlan = { seqId, items: [], remove: [], ranges: [], notes: [] };
  if (!seq || !nr) { plan.notes.push("This edit has no rundown yet."); return plan; }
  const all = nr.rundown;
  const scope = o.only ? all.filter((s) => o.only!.includes(s.id)) : all;
  const people: Person[] = nr.people ?? [];
  const on = (k: BuildPart) => o.parts?.[k] !== false;
  const F = (sec: number) => secondsToFrames(sec, seq.fps);
  const S = (fr: number) => framesToSeconds(fr, seq.fps);
  const L = seqEnd(seq) || o.length || F(30 * Math.max(1, all.length));
  // ranges are worked out for the whole rundown (so a story keeps its share when only some are built)
  const ranges = storyRanges(seq, all, o.ranges ?? "auto", L);
  const scoped = new Set(scope.map((s) => s.id));
  plan.ranges = ranges.filter((r) => scoped.has(r.storyId));

  // earlier builds: this scope's, plus (building everything) graphics of stories no longer in the rundown
  const ids = new Set(all.map((s) => s.id));
  for (const c of seq.clips) {
    const tag = buildTagOf(gfxOf(c));
    if (!tag) continue;
    const sid = tag.split(":")[0];
    if (scoped.has(sid) || (!o.only && !ids.has(sid))) plan.remove.push(c.id);
  }

  for (const s of scope) {
    const r = ranges.find((x) => x.storyId === s.id)!;
    const name = s.slug || s.headline || "Story";
    if (r.end - r.start < F(2)) { plan.notes.push(`${name}: its part of the timeline is too short (under 2 s), nothing placed.`); continue; }
    const tpl: Partial<Record<BuildPart, GfxTemplate>> = { ...o.templates };
    for (const id of s.graphics ?? []) {
      const t = o.templateById?.(id);
      const part = t ? partOf(t) : null;
      if (t && part) tpl[part] = t;
    }
    const tag = (part: BuildPart, v: Record<string, GfxValue>) => ({ ...v, [BUILD_TAG]: `${s.id}:${part}` });
    // straps and the board share the story: none takes more than its share while the others need room (at least 3 s)
    const reporterOk = !!s.reporter && people.some((x) => x.id === s.reporter);
    const n = [on("headline") && tpl.headline && s.headline.trim(), on("reporter") && tpl.reporter && reporterOk, on("points") && tpl.points && s.points?.length].filter(Boolean).length;
    const cap = n > 1 ? Math.max(F(3), Math.floor((r.end - r.start - F(0.5) * (n + 1)) / n)) : r.end - r.start;
    const add = (part: BuildPart, t: GfxTemplate, at: number, dur: number, values: Record<string, GfxValue>) =>
      plan.items.push({ storyId: s.id, slug: name, part, template: t, at, duration: dur, values: tag(part, values) });
    let strapEnd = r.start;

    // the headline strap, half a second in
    if (on("headline") && tpl.headline && s.headline.trim()) {
      const t = tpl.headline;
      const values = valuesFromStory(t, s, people, o.lang);
      ensureText(t, values, s.headline);
      const at = r.start + F(0.5);
      const dur = Math.min(F(holdSeconds(t, values, o.readSpeed)), cap, r.end - at);
      if (dur >= F(2)) { add("headline", t, at, dur, values); strapEnd = at + dur; }
    } else if (on("headline") && !tpl.headline) plan.notes.push(`${name}: no headline strap template chosen.`);

    // the reporter, a second after the headline
    const reporter = s.reporter ? people.find((x) => x.id === s.reporter) : undefined;
    if (on("reporter") && s.reporter && !reporter) plan.notes.push(`${name}: the reporter isn't in People any more.`);
    if (on("reporter") && tpl.reporter && reporter) {
      const t = tpl.reporter;
      const values = valuesFromStory(t, s, people, o.lang);
      ensureText(t, values, reporter.name);
      const at = strapEnd + F(strapEnd > r.start ? 1 : 0.5);
      const dur = Math.min(F(holdSeconds(t, values, o.readSpeed)), cap, r.end - at);
      if (dur >= F(3)) { add("reporter", t, at, dur, values); strapEnd = at + dur; }
      else plan.notes.push(`${name}: no room left for the reporter strap (${S(r.end - r.start).toFixed(0)} s story).`);
    }

    // the key points, after the straps
    if (on("points") && tpl.points && s.points?.length) {
      const t = tpl.points;
      const values = valuesFromStory(t, s, people, o.lang);
      ensureList(t, values, s.points);
      ensureText(t, values, s.headline);
      const at = strapEnd + F(0.5);
      const dur = Math.min(F(holdSeconds(t, values, o.readSpeed, 5, 15)), r.end - at);
      if (dur >= F(3)) add("points", t, at, dur, values);
      else plan.notes.push(`${name}: no room left for the key points board.`);
    }

    // the ticker lines, across the story
    if (on("ticker") && tpl.ticker && s.ticker?.length) {
      const t = tpl.ticker;
      const values = valuesFromStory(t, s, people, o.lang);
      ensureList(t, values, s.ticker);
      add("ticker", t, r.start, r.end - r.start, values);
    }
  }
  if (!plan.items.length && !plan.notes.length) plan.notes.push(scope.length ? "Nothing to place: add headlines, a reporter, key points or ticker lines to the stories." : "The rundown is empty.");
  return plan;
}

export interface BuildDeps { addGraphic: typeof addGraphic }

/**
 * Does a plan on a draft project (the caller wraps it in one undo step): removes the earlier Build's graphics, places
 * the new ones on their tracks and remembers each built story's range. Returns the new clip ids.
 */
export function applyBuild(p: EditProject, plan: BuildPlan, deps: BuildDeps = { addGraphic }): string[] {
  const i = p.sequences.findIndex((s) => s.id === plan.seqId);
  if (i < 0) return [];
  if (plan.remove.length) p.sequences[i] = removeClips(p.sequences[i], ctxOf(p), plan.remove);
  const made: string[] = [];
  for (const it of plan.items) {
    const id = deps.addGraphic(p, it.template, { at: it.at, duration: it.duration, values: it.values, seqId: plan.seqId });
    if (!id) continue;
    made.push(id);
    // keep the tag even if the command only kept the template's own blanks
    const c = p.sequences.find((s) => s.id === plan.seqId)?.clips.find((x) => x.id === id);
    if (c?.source.type === "graphic" && !buildTagOf(c.source.gfx)) c.source = { ...c.source, gfx: { ...c.source.gfx, values: { ...c.source.gfx.values, [BUILD_TAG]: it.values[BUILD_TAG] } } };
  }
  const nr = p.newsroom;
  if (nr) {
    const built = new Set(plan.items.map((x) => x.storyId));
    nr.rundown = nr.rundown.map((s) => {
      const r = plan.ranges.find((x) => x.storyId === s.id);
      return r && built.has(s.id) ? { ...s, start: r.start, end: r.end } : s;
    });
  }
  return made;
}

/** Graphics an earlier Build placed (all, or one story's). */
export function builtClips(seq: Sequence, storyId?: string): TimelineClip[] {
  return seq.clips.filter((c) => { const t = buildTagOf(gfxOf(c)); return !!t && (!storyId || t.startsWith(`${storyId}:`)); });
}
