/**
 * Poster editor state (zustand). One editor at a time. Every change to the document goes through `commit`, which
 * records undo history; rapid changes with the same `coalesce` key (a slider drag, typing) fold into one undo step.
 */
import { create } from "zustand";
import { align, cloneLayers, distribute, emptyDoc, moveLayers, refitImage, smartResize, type AlignMode } from "./doc";
import type { AiKind, Alternative, Background, Design, DesignDoc, ImageLayer, Layer } from "./types";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";
export type LeftTab = "templates" | "ai" | "text" | "elements" | "photos" | "cast" | "brand";
export type RightTab = "design" | "layers";

interface Snapshot { doc: DesignDoc; width: number; height: number; format?: string }

export interface TrackedJob { layerId: string; kind: AiKind; variation: number; /** the jobs started together */ batch: string; size: number }

export interface EditorState {
  design: Design | null;
  doc: DesignDoc;
  width: number;
  height: number;
  /** bumped on every document change; autosave watches it */
  rev: number;
  selection: string[];
  hover: string | null;
  editingTextId: string | null;
  zoom: number;
  fit: number;
  past: Snapshot[];
  future: Snapshot[];
  save: SaveState;
  saveError: string;
  leftTab: LeftTab;
  rightTab: RightTab;
  clipboard: Layer[];
  snap: boolean;
  showSafe: boolean;
  showGrid: boolean;
  jobs: Record<number, TrackedJob>;

  load(design: Design): void;
  reset(): void;
  commit(fn: (doc: DesignDoc) => DesignDoc | void, coalesce?: string): void;
  patchLayer(id: string, patch: Partial<Layer>, coalesce?: string): void;
  patchLayers(patches: Record<string, Partial<Layer>>, coalesce?: string): void;
  addLayers(layers: Layer[], opts?: { select?: boolean; index?: number }): void;
  removeLayers(ids?: string[]): void;
  duplicate(ids?: string[]): void;
  copy(ids?: string[]): void;
  paste(): void;
  order(to: "front" | "back" | "forward" | "backward", ids?: string[]): void;
  reorder(from: number, to: number): void;
  alignSelected(mode: AlignMode): void;
  distributeSelected(axis: "h" | "v"): void;
  setBackground(bg: Partial<Background>, coalesce?: string): void;
  resize(width: number, height: number, opts?: { smart?: boolean; format?: string }): void;
  replaceDoc(doc: DesignDoc, width?: number, height?: number, meta?: Partial<Design>): void;
  setMeta(patch: Partial<Design>): void;
  undo(): void;
  redo(): void;
  select(ids: string[], mode?: "set" | "add" | "toggle"): void;
  selectAll(): void;
  setHover(id: string | null): void;
  setEditingText(id: string | null): void;
  setZoom(z: number): void;
  setFit(f: number): void;
  setLeftTab(t: LeftTab): void;
  setRightTab(t: RightTab): void;
  toggle(flag: "snap" | "showSafe" | "showGrid"): void;
  setSave(s: SaveState, error?: string): void;
  markSaved(revision: number): void;
  trackJobs(jobIds: number[], layerId: string, kind: AiKind): void;
  applyJobResult(jobId: number, r: { src: string; asset: string; width: number; height: number; engine?: string; face_match?: number | null; prompt?: string }): void;
  failJob(jobId: number, error: string): void;
  useAlternative(layerId: string, index: number): void;
}

const MAX_HISTORY = 120;
const COALESCE_MS = 900;
let lastKey = "";
let lastAt = 0;

const snap = (s: Pick<EditorState, "doc" | "width" | "height" | "design">): Snapshot =>
  ({ doc: structuredClone(s.doc), width: s.width, height: s.height, format: s.design?.format });

/** one entry per picture, so a take is never listed twice */
const uniqueAlts = (alts: Alternative[]) => alts.filter((a, i, arr) => !!(a.asset || a.src) && arr.findIndex((b) => (b.asset || b.src) === (a.asset || a.src)) === i);

export const useEditor = create<EditorState>((set, get) => {
  /** apply a document change with undo history */
  const change = (next: Partial<Pick<EditorState, "doc" | "width" | "height" | "selection">>, coalesce?: string) => {
    const s = get();
    const now = Date.now();
    const merge = !!coalesce && coalesce === lastKey && now - lastAt < COALESCE_MS;
    lastKey = coalesce ?? "";
    lastAt = now;
    set({
      ...(merge ? {} : { past: [...s.past.slice(-(MAX_HISTORY - 1)), snap(s)], future: [] }),
      ...next,
      rev: s.rev + 1,
      save: s.save === "conflict" ? "conflict" : "dirty",
    });
  };
  const ids = (given?: string[]) => given ?? get().selection;
  const mapLayers = (doc: DesignDoc, fn: (l: Layer) => Layer): DesignDoc => ({ ...doc, layers: doc.layers.map(fn) });

  return {
    design: null, doc: emptyDoc(), width: 1080, height: 1350, rev: 0, selection: [], hover: null, editingTextId: null,
    zoom: 0.5, fit: 0.5, past: [], future: [], save: "idle", saveError: "", leftTab: "templates", rightTab: "design",
    clipboard: [], snap: true, showSafe: true, showGrid: false, jobs: {},

    load: (design) => {
      lastKey = "";
      set({ design: { ...design, doc: undefined }, doc: design.doc ?? emptyDoc(), width: design.width, height: design.height,
        rev: 0, selection: [], hover: null, editingTextId: null, past: [], future: [], save: "saved", saveError: "", jobs: {} });
    },
    reset: () => set({ design: null, doc: emptyDoc(), selection: [], past: [], future: [], save: "idle", jobs: {}, rev: 0 }),

    commit: (fn, coalesce) => {
      const draft = structuredClone(get().doc);
      const out = fn(draft) ?? draft;
      change({ doc: out }, coalesce);
    },
    patchLayer: (id, patch, coalesce) => change({ doc: mapLayers(get().doc, (l) => (l.id === id ? { ...l, ...patch } as Layer : l)) }, coalesce),
    patchLayers: (patches, coalesce) => change({ doc: mapLayers(get().doc, (l) => (patches[l.id] ? { ...l, ...patches[l.id] } as Layer : l)) }, coalesce),
    addLayers: (layers, opts = {}) => {
      if (!layers.length) return;
      const doc = get().doc;
      const arr = [...doc.layers];
      arr.splice(opts.index ?? arr.length, 0, ...layers);
      change({ doc: { ...doc, layers: arr }, ...(opts.select !== false ? { selection: layers.map((l) => l.id) } : {}) });
    },
    removeLayers: (given) => {
      const del = new Set(ids(given));
      if (!del.size) return;
      const doc = get().doc;
      change({ doc: { ...doc, layers: doc.layers.filter((l) => !del.has(l.id) || l.locked) }, selection: [] });
    },
    duplicate: (given) => {
      const want = new Set(ids(given));
      const doc = get().doc;
      const picked = doc.layers.filter((l) => want.has(l.id));
      if (!picked.length) return;
      const copies = cloneLayers(picked);
      const top = Math.max(...picked.map((l) => doc.layers.indexOf(l))) + 1;
      const arr = [...doc.layers];
      arr.splice(top, 0, ...copies);
      change({ doc: { ...doc, layers: arr }, selection: copies.map((c) => c.id) });
    },
    copy: (given) => {
      const want = new Set(ids(given));
      set({ clipboard: structuredClone(get().doc.layers.filter((l) => want.has(l.id))) });
    },
    paste: () => {
      const clip = get().clipboard;
      if (!clip.length) return;
      get().addLayers(cloneLayers(clip, 32));
    },
    order: (to, given) => {
      const doc = get().doc;
      change({ doc: { ...doc, layers: moveLayers(doc.layers, ids(given), to) } });
    },
    reorder: (from, to) => {
      const doc = get().doc;
      if (from === to || from < 0 || to < 0 || from >= doc.layers.length || to >= doc.layers.length) return;
      const arr = [...doc.layers];
      const [m] = arr.splice(from, 1);
      arr.splice(to, 0, m);
      change({ doc: { ...doc, layers: arr } });
    },
    alignSelected: (mode) => {
      const { doc, width, height, selection } = get();
      const sel = doc.layers.filter((l) => selection.includes(l.id) && !l.locked);
      if (!sel.length) return;
      const moves = align(sel, mode, { x: 0, y: 0, width, height });
      change({ doc: mapLayers(doc, (l) => (moves.has(l.id) ? { ...l, ...moves.get(l.id)! } : l)) });
    },
    distributeSelected: (axis) => {
      const { doc, selection } = get();
      const moves = distribute(doc.layers.filter((l) => selection.includes(l.id) && !l.locked), axis);
      if (!moves.size) return;
      change({ doc: mapLayers(doc, (l) => (moves.has(l.id) ? { ...l, ...moves.get(l.id)! } : l)) });
    },
    setBackground: (bg, coalesce) => {
      const doc = get().doc;
      change({ doc: { ...doc, background: { ...doc.background, ...bg } } }, coalesce);
    },
    resize: (width, height, opts = {}) => {
      const s = get();
      const doc = opts.smart === false ? s.doc : smartResize(s.doc, s.width, s.height, width, height);
      change({ doc, width: Math.round(width), height: Math.round(height) });
      if (opts.format && s.design) set({ design: { ...s.design, format: opts.format } });
    },
    replaceDoc: (doc, width, height, meta) => {
      const s = get();
      change({ doc, width: width ?? s.width, height: height ?? s.height, selection: [] });
      if (meta && s.design) set({ design: { ...s.design, ...meta } });
    },
    setMeta: (patch) => {
      const s = get();
      if (!s.design) return;
      set({ design: { ...s.design, ...patch }, rev: s.rev + 1, save: s.save === "conflict" ? "conflict" : "dirty" });
    },
    undo: () => {
      const s = get();
      const prev = s.past[s.past.length - 1];
      if (!prev) return;
      lastKey = "";
      const ok = new Set(prev.doc.layers.map((l) => l.id));
      set({ past: s.past.slice(0, -1), future: [snap(s), ...s.future].slice(0, MAX_HISTORY), doc: prev.doc, width: prev.width,
        height: prev.height, design: s.design && prev.format ? { ...s.design, format: prev.format } : s.design, selection: s.selection.filter((i) => ok.has(i)), rev: s.rev + 1, save: "dirty", editingTextId: null });
    },
    redo: () => {
      const s = get();
      const next = s.future[0];
      if (!next) return;
      lastKey = "";
      const ok = new Set(next.doc.layers.map((l) => l.id));
      set({ future: s.future.slice(1), past: [...s.past, snap(s)].slice(-MAX_HISTORY), doc: next.doc, width: next.width,
        height: next.height, design: s.design && next.format ? { ...s.design, format: next.format } : s.design, selection: s.selection.filter((i) => ok.has(i)), rev: s.rev + 1, save: "dirty", editingTextId: null });
    },
    select: (want, mode = "set") => {
      const cur = get().selection;
      if (mode === "set") set({ selection: want });
      else if (mode === "add") set({ selection: [...new Set([...cur, ...want])] });
      else set({ selection: [...cur.filter((i) => !want.includes(i)), ...want.filter((i) => !cur.includes(i))] });
    },
    selectAll: () => set({ selection: get().doc.layers.filter((l) => !l.locked && l.visible).map((l) => l.id) }),
    setHover: (hover) => set({ hover }),
    setEditingText: (editingTextId) => set({ editingTextId }),
    setZoom: (z) => set({ zoom: Math.min(8, Math.max(0.05, z)) }),
    setFit: (fit) => set({ fit }),
    setLeftTab: (leftTab) => set({ leftTab }),
    setRightTab: (rightTab) => set({ rightTab }),
    toggle: (flag) => set({ [flag]: !get()[flag] } as Pick<EditorState, typeof flag>),
    setSave: (save, saveError = "") => set({ save, saveError }),
    markSaved: (revision) => {
      const s = get();
      set({ save: "saved", saveError: "", design: s.design ? { ...s.design, revision } : s.design });
    },

    trackJobs: (jobIds, layerId, kind) => {
      const jobs = { ...get().jobs };
      const batch = jobIds.join(",");
      jobIds.forEach((id, i) => { jobs[id] = { layerId, kind, variation: i, batch, size: jobIds.length }; });
      set({ jobs });
      const doc = get().doc;
      set({ doc: mapLayers(doc, (l) => (l.id === layerId && l.type === "image"
        ? { ...l, pending: { jobIds: [...(l.pending?.jobIds ?? []), ...jobIds], kind } } : l)) });
    },
    applyJobResult: (jobId, r) => {
      const s = get();
      const t = s.jobs[jobId];
      if (!t) return;
      const jobs = { ...s.jobs };
      delete jobs[jobId];
      const alt: Alternative = { src: r.src, asset: r.asset, width: r.width, height: r.height };
      // the first take of a batch to arrive replaces the picture (the old one is kept as a take); later takes queue up
      const firstToLand = Object.values(s.jobs).filter((j) => j.batch === t.batch).length === t.size;
      const doc = mapLayers(s.doc, (l) => {
        if (l.id !== t.layerId || l.type !== "image") return l;
        const img = l as ImageLayer;
        const left = (img.pending?.jobIds ?? []).filter((j) => j !== jobId);
        const old: Alternative[] = img.src ? [{ src: img.src, asset: img.asset, width: img.naturalWidth ?? 0, height: img.naturalHeight ?? 0 }] : [];
        let next: ImageLayer = firstToLand
          ? refitImage({ ...img, src: r.src, asset: r.asset, alternatives: uniqueAlts([...(img.alternatives ?? []), ...old]).filter((a) => (a.asset || a.src) !== (r.asset || r.src)) }, r.width, r.height)
          : { ...img, alternatives: uniqueAlts([...(img.alternatives ?? []), alt]) };
        next = { ...next, pending: left.length ? { ...img.pending!, jobIds: left } : null,
          ai: { ...(img.ai ?? { kind: t.kind, prompt: r.prompt ?? "" }), kind: t.kind, engine: r.engine, faceMatch: r.face_match ?? null } };
        return next;
      });
      // AI results land outside undo history as a fresh step, so the user can undo back to the empty frame
      set({ jobs, past: [...s.past, snap(s)].slice(-MAX_HISTORY), future: [], doc, rev: s.rev + 1, save: "dirty" });
    },
    failJob: (jobId, _error) => {
      const s = get();
      const t = s.jobs[jobId];
      if (!t) return;
      const jobs = { ...s.jobs };
      delete jobs[jobId];
      // a failed take no longer counts towards its batch, so the next one to land still fills the picture
      for (const k of Object.keys(jobs)) if (jobs[+k].batch === t.batch) jobs[+k] = { ...jobs[+k], size: jobs[+k].size - 1 };
      set({ jobs, doc: mapLayers(s.doc, (l) => {
        if (l.id !== t.layerId || l.type !== "image") return l;
        const left = (l.pending?.jobIds ?? []).filter((j) => j !== jobId);
        return { ...l, pending: left.length ? { ...l.pending!, jobIds: left } : null };
      }) });
    },
    useAlternative: (layerId, index) => {
      const l = get().doc.layers.find((x) => x.id === layerId);
      if (!l || l.type !== "image") return;
      const alts = [...(l.alternatives ?? [])];
      const pick = alts[index];
      if (!pick) return;
      alts[index] = { src: l.src, asset: l.asset, width: l.naturalWidth ?? 0, height: l.naturalHeight ?? 0 };
      const swapped = refitImage({ ...l, src: pick.src, asset: pick.asset, alternatives: alts }, pick.width, pick.height);
      get().patchLayer(layerId, swapped);
    },
  };
});

/** The selected layers, in stacking order. */
export const selectedLayers = (s: EditorState): Layer[] => s.doc.layers.filter((l) => s.selection.includes(l.id));
