/**
 * The News Room room's actions (docs/EDITOR.md §16.8): add a graphic at the playhead (or a wipe at the nearest cut),
 * the quick keys, firing a playlist key, the playlist itself and making an edit a news edit. Each is one undo step
 * through the editor host; a new graphic is selected and the Fill in panel comes forward, ready to type into.
 */
import { toast } from "sonner";
import { makeHost } from "../../host";
import { secondsToFrames } from "../../model/time";
import type { EditorHost } from "../../model/types";
import { program } from "../../playback/transport";
import { project, select, seq } from "../../store";
import { addGraphic, ensureNewsroom, useTemplate as copyTemplateIn } from "../commands";
import { resolveLook } from "../looks";
import { applyNewsTransition, applyStinger, nearestCut, newsTransition } from "../wipes/apply";
import { showNewsPanel } from "../events";
import type { GfxTemplate, GfxValue } from "../types";
import { graphicLabel } from "./fields";
import { allTemplates, tplById } from "./hooks";
import { pickTemplate, WANT, type Want } from "./pick";
import { addEntry, entryOn } from "./playlist";

let hostP: EditorHost | null = null;
export const host = () => (hostP ??= makeHost());
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const isWipe = (t: GfxTemplate) => t.role === "wipe" || t.category === "Stingers";

/** Makes the edit a news edit (its News Room document with defaults). */
export function makeNewsEdit(label = "Make this a news edit") {
  try { host().apply(label, (d) => { ensureNewsroom(d); }); return true; } catch (e) { toast.error(`Couldn't start the News Room: ${msg(e)}`); return false; }
}

/** Adds a graphic at a frame (default: the playhead) on its track; wipes go to the nearest cut instead. */
export function addTemplateAt(t: GfxTemplate, at?: number, o: { values?: Record<string, GfxValue>; label?: string; fill?: boolean } = {}): string | null {
  if (isWipe(t) && at === undefined) return addWipeAtCut(t);
  const frame = Math.max(0, Math.round(at ?? program.frame));
  let id = "";
  try {
    host().apply(o.label ?? `Add ${t.name}`, (d) => { id = addGraphic(d, t, { at: frame, seqId: d.activeSequenceId, ...(o.values ? { values: structuredClone(o.values) } : {}) }); });
  } catch (e) { toast.error(`Couldn't add ${t.name}: ${msg(e)}`); return null; }
  if (!id) return null;
  select([id], "set", { linked: false });
  if (o.fill !== false && t.fields.length) showNewsPanel("nr-fill");
  return id;
}

/** A stinger over the cut nearest a frame (default: the playhead), its fully covered moment on the cut. */
export function addWipeAtCut(t: GfxTemplate, near = program.frame): string | null {
  const s = seq();
  // on the nearest cut; with no cut at all, on the frame itself
  const cut = nearestCut(s, near) ?? Math.max(0, Math.round(near));
  let id: string | null = null;
  try {
    host().apply(`Add wipe ${t.name}`, (d) => {
      copyTemplateIn(d, t);
      id = applyStinger(d, d.activeSequenceId, cut, t.id);
      if (id === null && t.cut === undefined) {
        // a template without a cut point: centred on the cut
        const len = Math.max(2, secondsToFrames(t.seconds > 0 ? t.seconds : 1.2, s.fps));
        id = addGraphic(d, t, { at: Math.max(0, cut - Math.round(len / 2)), duration: len, seqId: d.activeSequenceId });
      }
    });
  } catch (e) { toast.error(`Couldn't add the wipe: ${msg(e)}`); return null; }
  if (id) select([id], "set", { linked: false }); else toast.message("No room for that wipe at the nearest cut");
  return id;
}

/** A news transition (pushes, flashes, wipes in the look's colours) on the cut nearest a frame. */
export function addNewsTransitionAtCut(presetId: string, near = program.frame): boolean {
  const s = seq();
  const cut = nearestCut(s, near);
  const preset = newsTransition(presetId);
  if (cut === null || !preset) { toast.message("A transition goes on a cut: put two clips next to each other first"); return false; }
  let id: string | null = null;
  try { host().apply(`Transition ${preset.label}`, (d) => { id = applyNewsTransition(d, d.activeSequenceId, cut, presetId, resolveLook(d)); }); }
  catch (e) { toast.error(`Couldn't add the transition: ${msg(e)}`); return false; }
  if (!id) toast.message("There's no cut on the picture tracks there");
  return !!id;
}

// ── quick keys ───────────────────────────────────────────────────────────────

export type QuickKind = "strap" | "ticker" | "breaking" | "layout" | "wipe";
const QUICK: Record<QuickKind, { want: Want; what: string }> = {
  strap: { want: WANT.nameStrap, what: "name strap" },
  ticker: { want: WANT.ticker, what: "ticker" },
  breaking: { want: WANT.breaking, what: "breaking bar" },
  layout: { want: WANT.layout, what: "screen layout" },
  wipe: { want: WANT.wipe, what: "wipe" },
};
/** A quick key: the usual template of its kind at the playhead (a wipe at the nearest cut). */
export function quickAdd(kind: QuickKind) {
  const q = QUICK[kind];
  const t = pickTemplate(allTemplates(project()), q.want);
  if (!t) { toast.message(`No ${q.what} template yet`); return; }
  if (kind === "wipe") addWipeAtCut(t); else addTemplateAt(t);
}

// ── the playlist ─────────────────────────────────────────────────────────────

/** F1–F12: adds that playlist graphic at the playhead. False when the key has nothing on it. */
export function fireKey(key: string): boolean {
  const e = entryOn(project().newsroom?.playlist, key);
  if (!e) return false;
  const t = tplById(project(), e.template);
  if (!t) { toast.error(`${key}: its template isn't in this edit any more`); return true; }
  addTemplateAt(t, isWipe(t) ? undefined : program.frame, { values: e.values, label: `${key} ${e.name ?? t.name}`, fill: false });
  return true;
}

/** Puts a ready graphic on the next free F key. */
export function addToPlaylist(t: GfxTemplate, values: Record<string, GfxValue>, name?: string) {
  if ((project().newsroom?.playlist?.length ?? 0) >= 12) { toast.message("The playlist is full (F1–F12): remove one first"); return; }
  let key = "";
  try {
    host().apply("Add to playlist", (d) => {
      copyTemplateIn(d, t);
      const nr = ensureNewsroom(d);
      // hidden tags (Build's, the automatic tools') stay with the original, not the ready copy
      const clean = Object.fromEntries(Object.entries(values).filter(([k]) => !k.startsWith("_")));
      const l = addEntry(nr.playlist, { template: t.id, values: clean, name });
      if (l) { nr.playlist = l; key = l[l.length - 1].key; }
    });
  } catch (e) { toast.error(`Couldn't add it to the playlist: ${msg(e)}`); return; }
  if (key) toast.success(`On ${key}: ${name ?? graphicLabel(t, values)}`);
}
