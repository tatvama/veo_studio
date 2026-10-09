/**
 * Left-panel UI state shared between its tabs (zustand). The active tab itself lives in the editor store (`leftTab`).
 * Small conveniences (collapsed, last category) are remembered per browser; per-design choices are kept per design id.
 */
import { create } from "zustand";
import type { UploadResult } from "../../api";
import type { TemplateCategory } from "../../templates";

export type AiMode = "background" | "character" | "element" | "product";

export interface UploadRow { key: string; name: string; progress: number; error?: string }

interface LeftState {
  collapsed: boolean;
  category: TemplateCategory | "All";
  /** brand kit chosen in the Brand tab, per design (undefined: not chosen yet, fall back to the design's kit) */
  brandKit: Record<number, number | null>;
  aiMode: AiMode;
  aiCharacterId: number | null;
  /** images uploaded in this session, per design (so a removed upload can be brought back) */
  uploads: Record<number, UploadResult[]>;
  /** uploads in flight */
  uploading: UploadRow[];
  /** the last AI brief's background prompt and style, per design (the doc only keeps the brief text) */
  briefPlan: Record<number, { prompt: string; style: string }>;

  setCollapsed(v: boolean): void;
  setCategory(c: TemplateCategory | "All"): void;
  setBrandKit(designId: number, kitId: number | null): void;
  setAiMode(m: AiMode): void;
  setAiCharacter(id: number | null): void;
  addUpload(designId: number, u: UploadResult): void;
  setUploading(fn: (rows: UploadRow[]) => UploadRow[]): void;
  setBriefPlan(designId: number, plan: { prompt: string; style: string }): void;
}

const read = <T,>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ }
};

export const useLeft = create<LeftState>((set, get) => ({
  collapsed: read("poster-left-collapsed", false),
  category: read<TemplateCategory | "All">("poster-left-category", "All"),
  brandKit: {},
  aiMode: "background",
  aiCharacterId: null,
  uploads: {},
  uploading: [],
  briefPlan: {},

  setCollapsed: (collapsed) => { write("poster-left-collapsed", collapsed); set({ collapsed }); },
  setCategory: (category) => { write("poster-left-category", category); set({ category }); },
  setBrandKit: (designId, kitId) => set({ brandKit: { ...get().brandKit, [designId]: kitId } }),
  setAiMode: (aiMode) => set({ aiMode }),
  setAiCharacter: (aiCharacterId) => set({ aiCharacterId }),
  addUpload: (designId, u) => {
    const cur = get().uploads[designId] ?? [];
    if (cur.some((x) => x.asset === u.asset)) return;
    set({ uploads: { ...get().uploads, [designId]: [u, ...cur] } });
  },
  setUploading: (fn) => set({ uploading: fn(get().uploading) }),
  setBriefPlan: (designId, plan) => set({ briefPlan: { ...get().briefPlan, [designId]: plan } }),
}));

const NO_UPLOADS: UploadResult[] = [];
export const uploadsOf = (designId: number) => (s: LeftState) => s.uploads[designId] ?? NO_UPLOADS;
