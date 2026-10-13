/**
 * The News Room room's reads (docs/EDITOR.md §16.8): the edit's News Room document, the selected graphic, the
 * templates the room offers (built-ins, the edit's own, the user's library) and a graphic's render input.
 */
import { useEffect, useState } from "react";
import type { EditProject, MediaItem, Sequence, TimelineClip } from "../../model/types";
import { useEditor, useSequence } from "../../store";
import { templateOf, type GraphicClip } from "../commands";
import { useSelectedGraphic, useTemplateOf } from "../hooks";
import { listTemplates, loadTemplate, onLibraryChange } from "../library";
import { resolveLook } from "../looks";
import type { GfxRenderInput } from "../render/contract";
import { renderInputFor } from "../resolve";
import { defaults } from "../templates/kit";
import { builtinTemplate, builtinTemplates } from "../templates/index";
import type { GfxRatio, GfxTemplate, GfxValue, NewsroomDoc } from "../types";

export const isGraphic = (c: TimelineClip | undefined): c is GraphicClip => c?.source.type === "graphic";

/** A template by id: the edit's copy, else a built-in. */
export function tplById(p: EditProject, id: string): GfxTemplate | undefined {
  let t: GfxTemplate | undefined;
  try { t = templateOf(p, id); } catch { t = undefined; }
  return t ?? p.newsroom?.templates?.[id] ?? builtinTemplate(id);
}

/** The edit's News Room document (undefined until the edit has graphics or was made a news edit). */
export const useNewsroomDoc = (): NewsroomDoc | undefined => useEditor((s) => s.h.present.newsroom);

export interface Selected { clip: GraphicClip; seq: Sequence; template: GfxTemplate | undefined }
/** The graphic being worked on: the selected graphic clip, else the topmost one under the playhead (hooks.ts). */
export function useSelectedGfx(): Selected | null {
  const clip = useSelectedGraphic();
  const seq = useSequence();
  const template = useTemplateOf(clip);
  return clip && seq ? { clip, seq, template: template ?? undefined } : null;
}

// ── the user's template library ──────────────────────────────────────────────

let libCache: GfxTemplate[] | null = null;
let libP: Promise<GfxTemplate[]> | null = null;
const libSubs = new Set<(l: GfxTemplate[]) => void>();
async function readLibrary(): Promise<GfxTemplate[]> {
  const list = await listTemplates().catch(() => []);
  const out: GfxTemplate[] = [];
  for (const e of list) { const t = await loadTemplate(e.id).catch(() => null); if (t) out.push(t); }
  return out;
}
function refreshLibrary() {
  libP = readLibrary().then((l) => { libCache = l; libSubs.forEach((f) => f(l)); return l; });
  return libP;
}
let libWatch: (() => void) | null = null;
/** The user's saved templates ("My templates"), kept up to date. */
export function useLibraryTemplates(): GfxTemplate[] {
  const [l, setL] = useState<GfxTemplate[]>(libCache ?? []);
  useEffect(() => {
    libSubs.add(setL);
    if (!libP) void refreshLibrary();
    libWatch ??= onLibraryChange(() => void refreshLibrary());
    return () => { libSubs.delete(setL); };
  }, []);
  return l;
}

/** Every template the room offers: built-ins, then the edit's own (Designer copies), then the library's. */
export function allTemplates(p: EditProject, library: GfxTemplate[] = libCache ?? []): GfxTemplate[] {
  const out = [...builtinTemplates()];
  const seen = new Set(out.map((t) => t.id));
  for (const t of [...Object.values(p.newsroom?.templates ?? {}), ...library]) if (!seen.has(t.id)) { seen.add(t.id); out.push(t); }
  return out;
}

// ── drawing input ────────────────────────────────────────────────────────────

/** What the renderer needs for a template with values (a card, the playlist), in the edit's look. */
export function inputOf(p: EditProject, t: GfxTemplate, o: { values?: Record<string, GfxValue>; look?: string; ratio?: GfxRatio; fps?: number; urlFor?: (m: MediaItem) => string | undefined } = {}): GfxRenderInput {
  const values = { ...defaults(t), ...(o.values ?? {}) };
  const look = resolveLook(p, o.look);
  const images: Record<string, string> = {};
  if (o.urlFor) {
    const want = new Set<string>();
    for (const v of Object.values(values)) if (v && typeof v === "object" && !Array.isArray(v) && "mediaId" in v) want.add(v.mediaId);
    if (look.logo?.mediaId) want.add(look.logo.mediaId);
    for (const id of want) { const m = p.media.find((x) => x.id === id); const u = m ? o.urlFor(m) : undefined; if (u) images[id] = u; }
  }
  const nr = p.newsroom;
  const clockAt = nr?.airTime ? Date.parse(nr.airTime) : undefined;
  return { template: t, values, look, images, seed: 7, fps: o.fps ?? 25, ...(o.ratio ? { ratio: o.ratio } : {}), ...(clockAt && Number.isFinite(clockAt) ? { clockAt } : {}) };
}

/** A graphic clip's render input (nr-core's resolve, else built here). */
export function clipInput(p: EditProject, seq: Sequence, clip: GraphicClip, urlFor: (m: MediaItem) => string | undefined, lang?: string): GfxRenderInput | null {
  let r: GfxRenderInput | null = null;
  try { r = renderInputFor(p, seq, clip, { urlFor, lang }); } catch { r = null; }
  if (r) return r;
  const t = tplById(p, clip.source.gfx.template);
  if (!t) return null;
  const g = clip.source.gfx;
  const values = lang && g.langs?.[lang] ? { ...g.values, ...Object.fromEntries(Object.entries(g.langs[lang]).filter(([, v]) => v !== "" && v !== null && v !== undefined)) } : g.values;
  return { ...inputOf(p, t, { values, look: g.look, fps: seq.fps, urlFor }), ...(g.overrides ? { overrides: g.overrides } : {}), seed: g.seed ?? 7 };
}
