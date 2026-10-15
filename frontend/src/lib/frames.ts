/** Start and end frames (backend core/frames.py, api/frames.py): a shot's end frame, a scene's storyboard frames made in
 *  order, synced shots that start exactly on the end frame before, and the image engine a project's frames use. */
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Shot, SubmitResult } from "./types";

/** How a linked shot continues: from the clip's last frame, as an extension of it, or exactly on its end frame. */
export type LinkMode = "last_frame" | "extend" | "end_frame";

export interface FramesEngine {
  id: string; provider: string; display_name: string; family: string; tier: string; price_label?: string;
  provider_mode: "live" | "mock" | "missing"; builtin: boolean; est_usd: number; max_refs: number; in_chain: boolean;
}
export interface FramesEngines { engines: FramesEngine[]; current: string; auto_first: string | null; google_first: boolean }

export interface FramesStep { shot_id: number; code: string; kind: "keyframe" | "endframe"; copy: boolean; forced: boolean }
export interface FramesPlan {
  steps: FramesStep[]; images: number; copies: number; total_usd: number; engine: string; engine_label: string; shots: string[];
}
export interface StoryboardBody {
  scene_ids?: number[]; shot_ids?: number[]; end_frames: boolean; sync: boolean; redo: boolean; engine?: string; hero?: boolean;
}

export const useFramesEngines = (pid: number, enabled = true) =>
  useQuery({ queryKey: ["frames-engines", pid], queryFn: () => api.get<FramesEngines>(`/api/projects/${pid}/frames-engines`),
             enabled: !!pid && enabled, staleTime: 30_000 });
export const setFramesEngine = (pid: number, engine: string) =>
  api.put<{ frames_engine: string }>(`/api/projects/${pid}/frames-engine`, { engine });
export const framesPlan = (eid: number, body: StoryboardBody) =>
  api.post<FramesPlan>(`/api/episodes/${eid}/storyboard-frames/plan`, body, { silent: true });
export const startStoryboard = (eid: number, body: StoryboardBody) =>
  api.post<SubmitResult & { plan: FramesPlan }>(`/api/episodes/${eid}/storyboard-frames`, body);
export const makeEndFrame = (sid: number) => api.post<SubmitResult>(`/api/shots/${sid}/endframe`, {});
export const uploadEndFrame = (sid: number, file: File) => api.upload<Shot>(`/api/shots/${sid}/endframe/upload`, file);
export const clearEndFrame = (sid: number) => api.del<Shot & { archived: number }>(`/api/shots/${sid}/endframe`);

/** A shot's link as the shot card shows it: synced (starts on an end frame) or not. */
export const isSynced = (s: Pick<Shot, "frames_link">) => !!s.frames_link;
