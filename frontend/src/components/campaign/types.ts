/** Ads & Reels: local types, constants and query hooks for the campaign endpoints (api/campaign.py). */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { SubmitResult, TeamStatus } from "../../lib/types";

export type Aspect = "9:16" | "16:9" | "1:1";
export const ASPECTS: Aspect[] = ["9:16", "16:9", "1:1"];
/** aspect → export preset key (catalog EXPORT_PRESETS) */
export const ASPECT_PRESET: Record<Aspect, string> = { "9:16": "shorts", "16:9": "youtube", "1:1": "square" };
export const ASPECT_RATIO: Record<Aspect, number> = { "9:16": 9 / 16, "16:9": 16 / 9, "1:1": 1 };
export const DURATIONS = [6, 10, 15, 30, 45, 60, 90] as const;

export interface CampaignBrief { product: string; audience: string; tone: string }
export interface CampaignBody {
  languages: string[]; aspects: Aspect[]; durations: number[]; brand_kit_id: number | null; cta: string; captions: boolean;
  publish: boolean; brief: CampaignBrief; redub?: boolean;
}
export interface BrandFacts {
  brand_kit_id: number | null; name: string; logo_path: string; logo_url: string; colors: string[]; tagline: string; cta: string;
  website: string; fonts: Record<string, string>; product_assets: { label: string; path: string; url: string }[];
  end_card: { enabled?: boolean; seconds?: number; text?: string }; locked_at: string;
}
export interface PlanItem { label: string; usd: number; kind: "dub" | "cutdown" | "export"; language?: string; aspect?: string; duration?: number }
export interface CampaignEstimate {
  total_usd: number; count: number; items: PlanItem[]; variants: Variant[]; episode_length_s: number; languages: string[];
  aspects: Aspect[]; durations: number[]; skipped_durations: number[];
  budget: { ok: boolean; needs_role: string | null; reason: string }; team: TeamStatus;
}
export interface VariantExport {
  id: number; url: string; thumb_url: string; srt_url: string; preset: string; language: string; status: string; duration_s: number;
  warnings: string[]; episode_id: number; published: Record<string, { status?: string; url?: string; video_id?: string }>; approved_by: number | null;
}
export type VariantStatus = "planned" | "queued" | "running" | "ready" | "failed";
export interface Variant {
  language: string; aspect: Aspect; preset: string; duration: number; cut: boolean; status: VariantStatus; export_id: number | null;
  episode_id: number | null; job_id?: number; error?: string; export?: VariantExport | null;
}
export type CampaignStatus = "none" | "running" | "done" | "partial" | "failed" | "cancelled" | "stopped";
export interface CampaignState {
  status: CampaignStatus; job_id?: number; brand_facts: BrandFacts | null; brief?: Partial<CampaignBrief>; languages?: string[];
  aspects?: Aspect[]; durations?: number[]; captions?: boolean; variants: Variant[]; cuts?: Record<string, number>; started_at?: string;
  finished_at?: string | null; failed?: number; error?: string; progress?: { done: number; failed: number; total: number };
  job?: { id: number; status: string; progress: number; message: string; error: string } | null;
}
export interface Highlight { start_s: number; end_s: number; seconds: number; shot_codes: string[]; reasons: string[]; score: number; reason: string }
export interface HighlightsOut { episode_id: number; total_s: number; highlights: Highlight[] }

export const useCampaign = (eid: number | undefined) =>
  useQuery({
    queryKey: ["campaign", eid],
    queryFn: () => api.get<CampaignState>(`/api/episodes/${eid}/campaign`),
    enabled: !!eid,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 4_000 : 30_000),
  });

export const useHighlights = (eid: number | undefined) =>
  useQuery({ queryKey: ["highlights", eid], queryFn: () => api.get<HighlightsOut>(`/api/episodes/${eid}/highlights`), enabled: !!eid, staleTime: 15_000 });

export const useCampaignEstimate = (eid: number, body: CampaignBody, enabled: boolean) =>
  useQuery({
    queryKey: ["campaign-estimate", eid, body],
    queryFn: () => api.post<CampaignEstimate>(`/api/episodes/${eid}/campaign/estimate`, body, { silent: true }),
    enabled: enabled && !!eid,
    staleTime: 30_000,
    retry: false,
  });

export const startCampaign = (eid: number, body: CampaignBody) => api.post<SubmitResult>(`/api/episodes/${eid}/campaign`, body);
export const makeCutdowns = (eid: number, body: { count: number; seconds: number }) =>
  api.post<{ episode_ids: number[] }>(`/api/episodes/${eid}/cutdowns`, body);
export const stopJob = (jid: number) => api.post(`/api/jobs/${jid}/cancel`);

/** How many renders a choice makes: languages × aspects × (full length + each cut-down). */
export const variantCount = (b: Pick<CampaignBody, "languages" | "aspects" | "durations">) =>
  Math.max(1, b.languages.length) * Math.max(1, b.aspects.length) * (1 + b.durations.length);
