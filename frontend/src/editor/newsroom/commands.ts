/**
 * News Room edits on a draft project (docs/EDITOR.md §16.5). They change the draft in place, so UI code calls them
 * inside one undo step: `host.apply("Add name strap", (d) => addGraphic(d, …))`.
 *
 * Graphics tracks are video tracks with `gfxRole`, made on first use, named, above the picture tracks in this order
 * bottom → top: Layout, Boards, Straps, Ticker, Bug, Wipes; the Background track goes below V1. A graphic's template
 * (and its look) is copied into `newsroom`, so the edit opens and exports the same anywhere.
 */
import { baseClip } from "../model/defaults.ts";
import { addTrack, clipEnd, ctxOf, placeClips, seqEnd, tracksOf } from "../model/ops.ts";
import { secondsToFrames } from "../model/time.ts";
import type { EditProject, Sequence, TimelineClip } from "../model/types.ts";
import { DEFAULT_LOOK_ID, resolveLook } from "./looks.ts";
import { builtinTemplate } from "./templates/index.ts";
import { defaults } from "./templates/kit.ts";
import type { GfxInstance, GfxRole, GfxTemplate, GfxValue, NewsroomDoc, NewsroomSettings } from "./types.ts";

export type GraphicClip = TimelineClip & { source: { type: "graphic"; gfx: GfxInstance } };

/** Graphics tracks bottom → top (Background is below the pictures). */
export const GFX_ROLE_ORDER: GfxRole[] = ["layout", "board", "strap", "ticker", "bug", "wipe"];
export const GFX_TRACK_NAMES: Record<GfxRole, string> = {
  background: "Background", layout: "Layout", board: "Boards", strap: "Straps", ticker: "Ticker", bug: "Bug", wipe: "Wipes",
};
export const DEFAULT_SETTINGS: NewsroomSettings = { safeGuides: true, collision: true, readSpeed: 3, tickerSpeed: "normal", aiLabel: true };

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
export const isGraphic = (c: TimelineClip): c is GraphicClip => c.source.type === "graphic";

/** A fresh News Room document (the edit's look copied in). */
export function newNewsroom(ratio: NewsroomDoc["ratio"] = "16:9"): NewsroomDoc {
  return { version: 1, look: DEFAULT_LOOK_ID, looks: {}, templates: {}, ratio, rundown: [], people: [], places: [], sources: [], data: {}, settings: { ...DEFAULT_SETTINGS } };
}

/** The edit's News Room document, created with defaults when missing. */
export function ensureNewsroom(p: EditProject): NewsroomDoc {
  if (!p.newsroom) {
    const s = p.sequences.find((x) => x.id === p.activeSequenceId) ?? p.sequences[0];
    p.newsroom = newNewsroom(s && s.height > s.width ? "9:16" : "16:9");
  }
  const nr = p.newsroom;
  nr.looks ??= {}; nr.templates ??= {}; nr.rundown ??= []; nr.people ??= []; nr.places ??= []; nr.sources ??= []; nr.data ??= {};
  nr.settings = { ...DEFAULT_SETTINGS, ...(nr.settings ?? {}) };
  nr.look ||= DEFAULT_LOOK_ID;
  if (!nr.looks[nr.look]) { const l = resolveLook(p, nr.look); nr.looks[l.id] = clone(l); nr.look = l.id; }
  return nr;
}

const seqOf = (p: EditProject, seqId?: string): Sequence => {
  const s = p.sequences.find((x) => x.id === (seqId ?? p.activeSequenceId)) ?? p.sequences[0];
  if (!s) throw new Error("The edit has no sequence");
  return s;
};
const putSeq = (p: EditProject, s: Sequence) => { p.sequences = p.sequences.map((x) => (x.id === s.id ? s : x)); };

/** The graphics track for a role (created above the video tracks in role order when missing); returns its id. */
export function ensureGfxTrack(p: EditProject, seqId: string, role: GfxRole): string {
  const seq = seqOf(p, seqId);
  const have = tracksOf(seq, "video").find((t) => t.gfxRole === role);
  if (have) return have.id;
  const vids = tracksOf(seq, "video");
  let index: number;
  if (role === "background") index = 0;
  else {
    const rank = GFX_ROLE_ORDER.indexOf(role);
    const above = vids.find((t) => t.gfxRole && t.gfxRole !== "background" && GFX_ROLE_ORDER.indexOf(t.gfxRole) > rank);
    index = above ? above.index : vids.length;
  }
  const r = addTrack(seq, "video", index);
  const tracks = r.seq.tracks.map((t) => (t.id === r.trackId ? { ...t, name: GFX_TRACK_NAMES[role], gfxRole: role } : t));
  putSeq(p, { ...r.seq, tracks: numberPictureTracks(tracks) });
  return r.trackId;
}

/** Picture tracks keep their V1, V2 … names counted without the graphics tracks (Background sits below V1). */
export function numberPictureTracks<T extends { kind: string; index: number; name: string; gfxRole?: GfxRole }>(tracks: T[]): T[] {
  let n = 0;
  const names = new Map<T, string>();
  for (const t of [...tracks].filter((x) => x.kind === "video").sort((a, b) => a.index - b.index)) {
    if (t.gfxRole) continue;
    n++;
    if (/^V\d+$/.test(t.name)) names.set(t, `V${n}`);
  }
  return tracks.map((t) => (names.has(t) && names.get(t) !== t.name ? { ...t, name: names.get(t)! } : t));
}

/** Copies a template (built-in or the library's) into the edit, so it opens and exports the same anywhere. A newer
 *  copy of one of the user's templates (by `modified`) replaces the edit's. */
export function useTemplate(p: EditProject, t: GfxTemplate): void {
  const nr = ensureNewsroom(p);
  const have = nr.templates[t.id];
  if (!have || (t.source !== "builtin" && (t.modified ?? "") > (have.modified ?? ""))) nr.templates[t.id] = clone(t);
}

/** The template of a graphic clip or id in this edit (its copy first, then the built-ins). */
export function templateOf(p: EditProject, idOrClip: string | TimelineClip): GfxTemplate | undefined {
  const id = typeof idOrClip === "string" ? idOrClip : idOrClip.source.type === "graphic" ? idOrClip.source.gfx.template : "";
  return id ? p.newsroom?.templates?.[id] ?? builtinTemplate(id) : undefined;
}

export interface AddGraphicOptions {
  /** Sequence frame. */ at: number;
  /** Frames; default from the template's hold (auto / fill / until-next / its seconds). */ duration?: number;
  values?: Record<string, GfxValue>; trackId?: string; look?: string;
  /** Default: the active sequence. */ seqId?: string;
}

/** Words in a graphic's text fields (for reading time). */
export function wordsIn(t: GfxTemplate, values: Record<string, GfxValue>): number {
  let n = 0;
  const count = (s: string) => { n += s.split(/\s+/).filter(Boolean).length; };
  for (const f of t.fields) {
    const v = values[f.id] ?? f.default;
    if (f.type === "text" || f.type === "longtext") { if (typeof v === "string") count(v); }
    else if (f.type === "list" && Array.isArray(v)) for (const x of v as unknown[]) count(typeof x === "string" ? x : (x as { text?: string })?.text ?? "");
  }
  return n;
}

/** Seconds a graphic should hold to be read (its fields' words at `readSpeed` words/s, 4..12 s), or the template's length. */
export function autoHold(t: GfxTemplate, values: Record<string, GfxValue>, readSpeed = 3): number {
  const words = wordsIn(t, values);
  if (!words) return t.seconds > 0 ? t.seconds : 6;
  const s = words / Math.max(0.5, readSpeed) + (t.timing?.in ?? 0.6) + (t.timing?.out ?? 0.4) + 1;
  return Math.max(4, Math.min(12, Math.round(s * 10) / 10));
}

/** Frames a new graphic lasts at `at` on a track, by its template's hold. */
export function holdFrames(p: EditProject, seq: Sequence, t: GfxTemplate, trackId: string, at: number, values: Record<string, GfxValue>): number {
  const fps = seq.fps;
  const hold = t.hold ?? (t.seconds > 0 ? "fixed" : "fill");
  const fill = () => { const end = seqEnd(seq); return end - at >= fps ? end - at : secondsToFrames(t.seconds > 0 ? t.seconds : 60, fps); };
  if (hold === "fill") return fill();
  if (hold === "until-next") {
    const next = seq.clips.filter((c) => c.trackId === trackId && isGraphic(c) && c.start > at).sort((a, b) => a.start - b.start)[0];
    return next ? next.start - at : fill();
  }
  if (hold === "auto") return secondsToFrames(autoHold(t, values, p.newsroom?.settings?.readSpeed ?? 3), fps);
  return t.seconds > 0 ? secondsToFrames(t.seconds, fps) : fill();
}

/** Adds a graphic clip (on its role's track, overwriting what's there in that range); returns the clip id. */
export function addGraphic(p: EditProject, template: GfxTemplate | string, o: AddGraphicOptions): string {
  const t = typeof template === "string" ? templateOf(p, template) : template;
  if (!t) throw new Error(`No graphic template ${String(template)}`);
  useTemplate(p, t);
  if (o.look) applyLookCopy(p, o.look);
  let seq = seqOf(p, o.seqId);
  const trackId = o.trackId ?? ensureGfxTrack(p, seq.id, t.role);
  seq = seqOf(p, seq.id);
  const at = Math.max(0, Math.round(o.at));
  const values = { ...defaults(t), ...(o.values ?? {}) };
  const dur = Math.max(1, Math.round(o.duration ?? holdFrames(p, seq, t, trackId, at, values)));
  const gfx: GfxInstance = { template: t.id, values, ...(o.look ? { look: o.look } : {}) };
  const clip = baseClip(seq, trackId, at, dur, { type: "graphic", gfx }, t.name);
  putSeq(p, placeClips(seq, ctxOf(p), [clip], "overwrite"));
  return clip.id;
}

/** A graphic clip by id (any sequence). */
export function findGraphic(p: EditProject, clipId: string): { seq: Sequence; clip: GraphicClip } | null {
  for (const s of p.sequences) { const c = s.clips.find((x) => x.id === clipId); if (c && isGraphic(c)) return { seq: s, clip: c }; }
  return null;
}
function updateGraphic(p: EditProject, clipId: string, fn: (c: GraphicClip, seq: Sequence) => TimelineClip): void {
  const hit = findGraphic(p, clipId);
  if (!hit) return;
  putSeq(p, { ...hit.seq, clips: hit.seq.clips.map((c) => (c.id === clipId ? fn(c as GraphicClip, hit.seq) : c)) });
}

/** Sets some of a graphic's values (undefined removes one, so the template's default shows). */
export function setGraphicValues(p: EditProject, clipId: string, values: Record<string, GfxValue>): void {
  updateGraphic(p, clipId, (c) => {
    const v = { ...c.source.gfx.values };
    for (const [k, x] of Object.entries(values)) { if (x === undefined) delete v[k]; else v[k] = x; }
    return { ...c, source: { type: "graphic", gfx: { ...c.source.gfx, values: v } } };
  });
}

/** Swaps a graphic's template, keeping the values whose field ids match (and overrides of layers it still has). */
export function replaceGraphicTemplate(p: EditProject, clipId: string, templateId: string): void {
  const t = templateOf(p, templateId);
  const hit = findGraphic(p, clipId);
  if (!t || !hit) return;
  useTemplate(p, t);
  const ids = new Set(t.fields.map((f) => f.id));
  const layerIds = new Set(Object.values(t.designs).flatMap((d) => d?.layers.map((l) => l.id) ?? []));
  const old = hit.clip.source.gfx;
  const values: Record<string, GfxValue> = { ...defaults(t) };
  for (const [k, v] of Object.entries(old.values)) if (ids.has(k)) values[k] = v;
  const gfx: GfxInstance = { ...old, template: t.id, values };
  if (old.overrides) {
    const ov = Object.fromEntries(Object.entries(old.overrides).filter(([k]) => layerIds.has(k)));
    if (Object.keys(ov).length) gfx.overrides = ov; else delete gfx.overrides;
  }
  if (old.bind) { const b = Object.fromEntries(Object.entries(old.bind).filter(([k]) => ids.has(k))); if (Object.keys(b).length) gfx.bind = b; else delete gfx.bind; }
  const track = hit.seq.tracks.find((x) => x.id === hit.clip.trackId);
  let trackId = hit.clip.trackId;
  if (track?.gfxRole && track.gfxRole !== t.role) trackId = ensureGfxTrack(p, hit.seq.id, t.role);
  const seq = seqOf(p, hit.seq.id);
  const moved: TimelineClip = { ...hit.clip, trackId, name: t.name, source: { type: "graphic", gfx } };
  if (trackId === hit.clip.trackId) putSeq(p, { ...seq, clips: seq.clips.map((c) => (c.id === clipId ? moved : c)) });
  else putSeq(p, placeClips({ ...seq, clips: seq.clips.filter((c) => c.id !== clipId) }, ctxOf(p), [moved], "overwrite"));
}

function applyLookCopy(p: EditProject, lookId: string): string {
  const nr = ensureNewsroom(p);
  const l = resolveLook(p, lookId);
  if (!nr.looks[l.id]) nr.looks[l.id] = clone(l);
  return l.id;
}

/** Makes a look the edit's look (copied in); every graphic without its own look follows. */
export function applyLook(p: EditProject, lookId: string): void {
  const id = applyLookCopy(p, lookId);
  ensureNewsroom(p).look = id;
}

/** Graphic clips of a sequence (optionally on tracks of one role), by start. */
export function graphicClips(seq: Sequence, role?: GfxRole): GraphicClip[] {
  const roles = new Map(seq.tracks.map((t) => [t.id, t.gfxRole]));
  return seq.clips.filter((c): c is GraphicClip => isGraphic(c) && (!role || roles.get(c.trackId) === role)).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/** The graphic clips on screen at a frame, bottom track first. */
export function graphicsAt(seq: Sequence, frame: number): GraphicClip[] {
  const order = new Map(tracksOf(seq, "video").map((t) => [t.id, t.index]));
  const hidden = new Set(seq.tracks.filter((t) => t.hidden).map((t) => t.id));
  return seq.clips.filter((c): c is GraphicClip => isGraphic(c) && c.enabled && !hidden.has(c.trackId) && c.start <= frame && frame < clipEnd(c))
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0));
}
