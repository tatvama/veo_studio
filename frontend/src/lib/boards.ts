/** Character boards and per-character image engines (bible.py board endpoints, hub.py /engines/image). */
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { SubmitResult } from "./types";

// ── image engines (the per-character engine picker) ─────────────────────────
export interface ImageEngine {
  id: string; provider: string; display_name: string; family: string; tier: string; price_label: string; price_source: string;
  provider_mode: "live" | "mock" | "missing"; builtin: boolean; route_key: string;
  /** USD per image (0 when the provider runs without a key, i.e. mock placeholders) */
  est_usd: number;
  /** images one request can make (a whole board in one go); 0 = one at a time */
  group_max: number; max_refs: number; in_chain: boolean; modes: string[];
}
export interface ImageEngines { engines: ImageEngine[]; chain: string[]; auto_first: string | null; google_first: boolean }
export const useImageEngines = (enabled = true) =>
  useQuery({ queryKey: ["engines", "image"], queryFn: () => api.get<ImageEngines>("/api/engines/image"), enabled, staleTime: 30_000 });

// ── splitting an uploaded board ─────────────────────────────────────────────
export const BOARD_KINDS = ["front", "three_quarter", "profile", "back", "full_body", "expression", "outfit", "other"] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];
export const BOARD_KIND_LABEL: Record<BoardKind, string> = {
  front: "Front", three_quarter: "Three-quarter", profile: "Profile", back: "Back", full_body: "Full body",
  expression: "Expression", outfit: "Outfit", other: "Other",
};
export const OUTFIT_ANGLES = ["front", "three_quarter", "profile", "back", "full_body"] as const;

export interface BoardPanel {
  id?: number; x: number; y: number; w: number; h: number; kind: BoardKind | string; name?: string; view?: string;
  description?: string; keep?: boolean;
}
export interface BoardState {
  status?: "detected" | "labelling" | "awaiting_approval" | "ready" | "failed" | "saved";
  width?: number; height?: number; clean?: boolean; method?: "gutters" | "regions" | "vision" | ""; background?: string | null;
  panels?: BoardPanel[]; error?: string; saved_asset_ids?: number[];
}
export interface BoardUpload { asset_id: number; board: BoardState; jobs: SubmitResult | { status: "failed"; reason: string; jobs: []; total_usd: 0 } }

export const uploadBoard = (cid: number, file: File, projectId?: number | null, aiMade = false) => {
  const fd = new FormData();
  fd.append("file", file);
  if (projectId) fd.append("project_id", String(projectId));
  fd.append("ai_made", aiMade ? "true" : "false");
  return api.post<BoardUpload>(`/api/characters/${cid}/board`, fd);
};
export const relabelBoard = (aid: number, body: { panels?: BoardPanel[]; find_boxes?: boolean; project_id?: number | null }) =>
  api.post<{ asset_id: number; board: BoardState; jobs: SubmitResult }>(`/api/character-assets/${aid}/board/label`, body);
export const saveBoardViews = (aid: number, panels: BoardPanel[]) =>
  api.post<{ saved: number[] }>(`/api/character-assets/${aid}/board/save`, { panels });

// ── a whole board in one request (BytePlus Seedream) ───────────────────────
export interface BoardOptions {
  engines: { id: string; display_name: string; provider: string; provider_mode: string; price_usd: number; max_images: number }[];
  default_engine: string | null; references: number; panels: string[]; default_panels: string[];
}
export const useBoardOptions = (cid: number, enabled: boolean) =>
  useQuery({ queryKey: ["board-options", cid], queryFn: () => api.get<BoardOptions>(`/api/characters/${cid}/sheet/board`), enabled });
export const generateBoard = (cid: number, body: { project_id?: number | null; engine?: string | null; panels: string[];
  outfit_name?: string; outfit_description?: string; fill_missing?: boolean }) =>
  api.post<SubmitResult>(`/api/characters/${cid}/sheet/board`, body);

/** "expression:happy" → "Happy"; "outfit:full_body" → "Outfit · Full body"; "three_quarter" → "Three-quarter" */
export function panelLabel(key: string): string {
  const [kind, rest] = key.split(":");
  const view = (k: string) => BOARD_KIND_LABEL[k as BoardKind] ?? k.replace(/_/g, " ");
  if (kind === "expression") return rest.charAt(0).toUpperCase() + rest.slice(1);
  if (kind === "outfit") return `Outfit · ${view(rest)}`;
  return view(kind);
}
