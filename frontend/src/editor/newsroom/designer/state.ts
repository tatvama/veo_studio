/**
 * The Template Designer's state (docs/EDITOR.md §16.8): the working copy with its own undo, the selection, the view,
 * preview values and look, and a separate clock for the preview playhead (so playback only redraws the stages and
 * the scrubber). One Designer is open at a time.
 */
import { create } from "zustand";
import type { ChannelLook, GfxRatio, GfxTemplate, GfxValue } from "../types.ts";
import { history, ratiosOf, type History } from "./doc.ts";

export type DesignerMode = "template" | "clip";
export interface DesignerState {
  open: boolean;
  mode: DesignerMode;
  /** "Change only this one": the graphic clip being changed. */
  clipId?: string;
  /** The template as opened (built-in, the edit's, the library's): the source of a new copy, and of the clip's overrides. */
  base: GfxTemplate;
  h: History<GfxTemplate>;
  /** The working copy as last saved (dirty = h.present !== saved). */
  saved: GfxTemplate;
  /** The design being edited (selection, inspector, nudges). */
  ratio: GfxRatio;
  view: "both" | "single";
  sel: string | null;
  tab: "layers" | "fields";
  /** Inspector changes go to both ratios or just this one. */
  scope: "all" | "this";
  values: Record<string, GfxValue>;
  look: ChannelLook;
  /** Zoom in the single view (1 = fit). */
  zoom: number;
  bg: "dark" | "checker" | "light";
  onSaved?: (t: GfxTemplate) => void;
}

const EMPTY: GfxTemplate = { id: "", name: "", category: "Straps", role: "strap", seconds: 6, timing: { in: 0.6, out: 0.4 }, fields: [], designs: {}, version: 1 };

export const useDesigner = create<DesignerState>(() => ({
  open: false, mode: "template", base: EMPTY, h: history.init(EMPTY), saved: EMPTY, ratio: "16:9", view: "both", sel: null, tab: "layers",
  scope: "all", values: {}, look: undefined as unknown as ChannelLook, zoom: 1, bg: "dark",
}));
export const ds = () => useDesigner.getState();
export const tplNow = () => ds().h.present;
export const isDirty = (s: DesignerState = ds()) => s.h.present !== s.saved;

export function openSession(o: { mode: DesignerMode; clipId?: string; base: GfxTemplate; working: GfxTemplate; values: Record<string, GfxValue>; look: ChannelLook; onSaved?: (t: GfxTemplate) => void }) {
  const rs = ratiosOf(o.working);
  useDesigner.setState({
    open: true, mode: o.mode, clipId: o.clipId, base: o.base, h: history.init(o.working), saved: o.working, ratio: rs[0] ?? "16:9",
    view: rs.length > 1 ? "both" : "single", sel: null, tab: "layers", scope: "all", values: o.values, look: o.look, zoom: 1, onSaved: o.onSaved,
  });
  clock.setState({ t: Math.min(2, previewLength(o.working) * 0.4), playing: false });
}
export const closeSession = () => { clock.setState({ playing: false }); useDesigner.setState({ open: false, onSaved: undefined }); };

let gestureN = 0;
/** A fresh coalescing key for one drag / slider gesture. */
export const gestureKey = (what: string) => `${what}#${++gestureN}`;

/** A locked template (fill-in only) can't be changed until it's unlocked. */
export const isReadOnly = (s: DesignerState = ds()) => s.mode === "template" && !!s.h.present.locked;

/**
 * One change to the working copy (one undo step; the same `key` within a moment is merged, like a drag). Ignored
 * while the template is locked, unless `force` (unlocking itself).
 */
export function change(fn: (t: GfxTemplate) => GfxTemplate, key?: string, force = false) {
  useDesigner.setState((s) => {
    if (!force && isReadOnly(s)) return {};
    const next = fn(s.h.present);
    if (next === s.h.present) return {};
    const h = history.push(s.h, next, key);
    return { h, sel: s.sel && !layerExists(next, s.sel) ? null : s.sel };
  });
}
const layerExists = (t: GfxTemplate, id: string) => ratiosOf(t).some((r) => t.designs[r]!.layers.some((l) => l.id === id));

export function undo() { useDesigner.setState((s) => { const h = history.undo(s.h); return { h, sel: s.sel && !layerExists(h.present, s.sel) ? null : s.sel }; }); }
export function redo() { useDesigner.setState((s) => { const h = history.redo(s.h); return { h, sel: s.sel && !layerExists(h.present, s.sel) ? null : s.sel }; }); }
export const select = (sel: string | null, ratio?: GfxRatio) => useDesigner.setState((s) => ({ sel, ratio: ratio ?? s.ratio }));
/** After a save: the working copy becomes the new clean state (and, for a new template, the new base). */
export const markSaved = (t: GfxTemplate, asBase = false) => useDesigner.setState((s) => ({ saved: t, h: { ...s.h, present: t }, ...(asBase ? { base: t } : {}) }));
/** Replaces the working copy (import, duplicate) with a fresh history. */
export const replaceWorking = (t: GfxTemplate, base = t) => useDesigner.setState({ base, h: history.init(t), saved: t, sel: null, ratio: ratiosOf(t)[0] ?? "16:9", view: ratiosOf(t).length > 1 ? "both" : "single" });

// ── the preview clock ────────────────────────────────────────────────────────

export interface ClockState { t: number; playing: boolean; loop: boolean }
export const clock = create<ClockState>(() => ({ t: 1.5, playing: false, loop: true }));
/** Seconds the preview plays: the template's length, or 8 s (12 s for loops) when it runs to the sequence end. */
export const previewLength = (t: Pick<GfxTemplate, "seconds" | "loop">) => (t.seconds > 0 ? t.seconds : t.loop ? 12 : 8);
