/**
 * The editor's state (docs/EDITOR.md §3): the document with its undo history, selection, tool, zoom and scroll,
 * clipboard and save state, in one zustand store. The document is the single source of truth; every change goes
 * through `exec` (one undo step) or a gesture (`begin` → `preview`… → `commit`). The playheads live in clocks
 * (playback/transport.ts), not here, so moving them never re-renders the timeline.
 */
import { create } from "zustand";
import * as H from "./model/commands";
import { magnetizeProject } from "./model/magnetic";
import { activeSequence, ctxOf, updateSequence, withLinked, type Clipboard, type Ctx } from "./model/ops";
import type { EditProject, MediaItem, Sequence } from "./model/types";

export type Tool = "select" | "trackFwd" | "trackBack" | "ripple" | "roll" | "rate" | "razor" | "slip" | "slide" | "pen" | "hand" | "zoom" | "text";
export type Focus = "timeline" | "program" | "source" | "project" | "effects" | "controls" | "mixer" | "text" | "graph" | "other";

export const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: "select", label: "Selection", key: "V" },
  { id: "trackFwd", label: "Track select forward", key: "A" },
  { id: "trackBack", label: "Track select backward", key: "Shift+A" },
  { id: "ripple", label: "Ripple edit", key: "B" },
  { id: "roll", label: "Rolling edit", key: "N" },
  { id: "rate", label: "Rate stretch", key: "R" },
  { id: "razor", label: "Razor", key: "C" },
  { id: "slip", label: "Slip", key: "Y" },
  { id: "slide", label: "Slide", key: "U" },
  { id: "pen", label: "Pen (keyframes)", key: "P" },
  { id: "hand", label: "Hand", key: "H" },
  { id: "zoom", label: "Zoom", key: "Z" },
  { id: "text", label: "Type (new title)", key: "T" },
];

export interface EditorState {
  h: H.HistoryState;
  /** The .tatvamedit file (null: the in-memory demo). */
  path: string | null;
  demo: boolean;
  /** The document as last saved; dirty = h.present !== saved. */
  saved: EditProject;
  saving: boolean; savedAt: string | null; saveError: string | null;
  /** Runtime media URLs (bridge.mediaUrl / demo), by media id; never saved. */
  urls: Record<string, string>;
  selection: string[];
  selTransition: string | null;
  selMarker: string | null;
  tool: Tool;
  snapping: boolean;
  /** Linked selection: clicking one half of an A/V pair selects both. */
  linked: boolean;
  /** Pixels per frame, and the timeline's horizontal scroll in pixels. */
  zoom: number; scroll: number;
  clipboard: Clipboard | null;
  /** The media item in the Source monitor. */
  sourceId: string | null;
  focus: Focus;
  /** A frame the timeline shows a snap line at while dragging. */
  snapLine: number | null;
  /** Additive (editor-motion): snap to beat markers / to audio transients (with snapping on). */
  snapBeats: boolean; snapTransients: boolean;
  /** Additive (editor-motion): sequences open as timeline tabs, and the nesting path to the active one (breadcrumbs). */
  tabs: string[]; crumbs: string[];
  /** Additive (editor-motion): the Source monitor shows the multicam angles of the clip under the playhead. */
  multicamView: boolean;
}

const empty = (p: EditProject): EditorState => ({
  h: H.initHistory(p), path: null, demo: false, saved: p, saving: false, savedAt: null, saveError: null, urls: {},
  selection: [], selTransition: null, selMarker: null, tool: "select", snapping: true, linked: true, zoom: 2, scroll: 0,
  clipboard: null, sourceId: null, focus: "timeline", snapLine: null,
  snapBeats: true, snapTransients: false, tabs: p.activeSequenceId ? [p.activeSequenceId] : [], crumbs: [], multicamView: false,
});

export const useEditor = create<EditorState>(() => empty({
  format: "tatvam-edit", version: 1, id: "", name: "", created: "", modified: "", bins: [], media: [], sequences: [], activeSequenceId: "",
  settings: { copyMedia: false, proxy: "off", autosaveSeconds: 10 },
}));

export const ed = () => useEditor.getState();
const set = (patch: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)) => useEditor.setState(patch as never);

// ── reading ──────────────────────────────────────────────────────────────────

export const project = () => ed().h.present;
export const seq = (): Sequence => activeSequence(project());
export const ctx = (): Ctx => ctxOf(project());
export const isDirty = (s: EditorState = ed()) => s.h.present !== s.saved;
export const useProject = () => useEditor((s) => s.h.present);
export const useSequence = () => useEditor((s) => activeSequence(s.h.present));
export const useDirty = () => useEditor((s) => s.h.present !== s.saved);

/** URL to preview a media item from: the runtime map, the proxy (when proxies are on), else what the bridge put on it. */
export const urlFor = (m: MediaItem) => {
  const s = ed();
  if (s.urls[m.id]) return s.urls[m.id];
  if (m.proxyUrl && s.h.present.settings.proxy !== "off") return m.proxyUrl;
  return m.url;
};
/** Sound of a media item for the preview mixer (the demo's procedural clips have theirs on the side). */
export const audioUrlFor = (m: MediaItem) => {
  const s = ed();
  const u = s.urls[`audio:${m.id}`] ?? urlFor(m);
  return u && !u.startsWith("demo:") ? u : undefined;
};

// ── loading ──────────────────────────────────────────────────────────────────

export function loadProject(p: EditProject, opts: { path: string | null; demo?: boolean; urls?: Record<string, string> }) {
  const s = activeSequence(p);
  useEditor.setState({ ...empty(p), path: opts.path, demo: !!opts.demo, urls: opts.urls ?? {},
    zoom: s?.workArea?.zoom && s.workArea.zoom > 0 ? s.workArea.zoom : 2, scroll: s?.workArea?.scroll ?? 0 });
}

// ── commands ─────────────────────────────────────────────────────────────────

/** Selection that still exists after a change. */
function pruneSelection(s: EditorState, p: EditProject): Partial<EditorState> {
  const sq = activeSequence(p);
  if (!sq) return {};
  const ids = new Set(sq.clips.map((c) => c.id));
  const sel = s.selection.filter((id) => ids.has(id));
  const tr = s.selTransition && sq.transitions.some((t) => t.id === s.selTransition) ? s.selTransition : null;
  const mk = s.selMarker && sq.markers.some((m) => m.id === s.selMarker) ? s.selMarker : null;
  return sel.length === s.selection.length && tr === s.selTransition && mk === s.selMarker ? {} : { selection: sel, selTransition: tr, selMarker: mk };
}

/** A command that leaves magnetic sequences magnetic (V1 closed up, connected clips riding along: model/magnetic.ts). */
const magnetic = (run: (p: EditProject) => EditProject) => (p: EditProject) => {
  const n = run(p);
  return n === p ? n : magnetizeProject(p, n, ctxOf(n));
};

/** Runs one undoable command on the whole project. */
export function exec(label: string, run: (p: EditProject) => EditProject, coalesce?: string) {
  set((s) => {
    const h = H.exec(s.h, H.command(label, magnetic(run), coalesce));
    return h === s.h ? {} : { h, ...pruneSelection(s, h.present) };
  });
}

/** Runs one undoable command on the active sequence. */
export function seqExec(label: string, fn: (s: Sequence, c: Ctx) => Sequence, coalesce?: string) {
  const id = project().activeSequenceId;
  exec(label, (p) => updateSequence(p, id, fn), coalesce);
}

/** A drag: begin, then preview(fn) on every move (fn starts from the document as the drag began), then commit. */
export const gesture = {
  begin(label: string) { set((s) => ({ h: H.begin(s.h, label) })); },
  preview(fn: (p: EditProject) => EditProject) { set((s) => { const h = H.preview(s.h, magnetic(fn)); return h === s.h ? {} : { h }; }); },
  previewSeq(fn: (s: Sequence, c: Ctx) => Sequence) {
    const id = project().activeSequenceId;
    gesture.preview((p) => updateSequence(p, id, fn));
  },
  commit(label?: string) { set((s) => { const h = H.commit(s.h, Date.now(), label); return { h, snapLine: null, ...pruneSelection(s, h.present) }; }); },
  cancel() { set((s) => ({ h: H.cancel(s.h), snapLine: null })); },
  active: () => !!ed().h.gesture,
};

export const canUndoNow = () => H.canUndo(ed().h);
export const canRedoNow = () => H.canRedo(ed().h);
export function undo() { set((s) => { const h = H.undo(s.h); return { h, ...pruneSelection(s, h.present) }; }); }
export function redo() { set((s) => { const h = H.redo(s.h); return { h, ...pruneSelection(s, h.present) }; }); }
export function jumpHistory(i: number) { set((s) => { const h = H.jumpTo(s.h, i); return { h, ...pruneSelection(s, h.present) }; }); }

/** Replaces the document without an undo step (the save stamp, a relinked path the bridge reports). */
export function replaceProject(p: EditProject, markSaved = false) {
  set((s) => ({ h: H.replace(s.h, p), ...(markSaved ? { saved: p } : {}) }));
}

// ── selection ────────────────────────────────────────────────────────────────

export type SelectMode = "set" | "add" | "toggle" | "remove";

export function select(ids: string[], mode: SelectMode = "set", opts: { linked?: boolean } = {}) {
  set((s) => {
    const linked = opts.linked ?? s.linked;
    const sq = activeSequence(s.h.present);
    const all = linked && sq ? withLinked(sq, ids) : ids;
    let next: string[];
    if (mode === "set") next = all;
    else if (mode === "add") next = [...new Set([...s.selection, ...all])];
    else if (mode === "remove") next = s.selection.filter((x) => !all.includes(x));
    else {
      const on = ids.every((x) => s.selection.includes(x));
      next = on ? s.selection.filter((x) => !all.includes(x)) : [...new Set([...s.selection, ...all])];
    }
    return { selection: next, selTransition: null, selMarker: mode === "set" ? null : s.selMarker };
  });
}
export const selectTransition = (id: string | null) => set({ selTransition: id, selection: id ? [] : ed().selection });
export const selectMarker = (id: string | null) => set({ selMarker: id });
export const clearSelection = () => set({ selection: [], selTransition: null, selMarker: null });

export const setTool = (tool: Tool) => set({ tool });
export const setFocus = (focus: Focus) => { if (ed().focus !== focus) set({ focus }); };
export const toggleSnapping = () => set((s) => ({ snapping: !s.snapping }));
export const toggleLinked = () => set((s) => ({ linked: !s.linked }));
export const setView = (patch: { zoom?: number; scroll?: number }) => set((s) => ({
  zoom: patch.zoom !== undefined ? Math.max(0.002, Math.min(60, patch.zoom)) : s.zoom,
  scroll: patch.scroll !== undefined ? Math.max(0, patch.scroll) : s.scroll,
}));
export const setSnapLine = (f: number | null) => { if (ed().snapLine !== f) set({ snapLine: f }); };
export const setClipboard = (clipboard: Clipboard | null) => set({ clipboard });
export const setSource = (id: string | null) => set({ sourceId: id });
export const setUrls = (urls: Record<string, string>) => set((s) => ({ urls: { ...s.urls, ...urls } }));
export const setSaveState = (patch: Partial<Pick<EditorState, "saving" | "savedAt" | "saveError" | "saved" | "path">>) => set(patch);

// ── editor-motion view state ─────────────────────────────────────────────────

export const toggleSnapBeats = () => set((s) => ({ snapBeats: !s.snapBeats }));
export const toggleSnapTransients = () => set((s) => ({ snapTransients: !s.snapTransients }));
export const setMulticamView = (on: boolean) => set({ multicamView: on });
/** Timeline tabs and breadcrumbs (actions.openSequence keeps them in step). */
export const setTabs = (tabs: string[], crumbs?: string[]) => set((s) => ({ tabs, crumbs: crumbs ?? s.crumbs }));
