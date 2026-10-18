import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Estimate } from "./types";

/**
 * Prices before paid work (CLAUDE.md: paid work goes through jobs with estimates). Batches (keyframes, videos, voices,
 * produce, autopilot…) are priced by POST /api/episodes/{eid}/estimate; one-item actions that have no batch form (a shot's
 * extension or end frame, a take's edit, a character's sheet, a place's pictures, an episode's sound design…) by
 * POST /api/estimate. Both answer in the same shape, which the cost dialog (components/Generate) shows.
 */

/** One episode batch, as the "generate" action takes it: `{ action, shot_ids, quality, steps, … }`. */
export const estimateBatch = (eid: number, body: Record<string, unknown>, silent = false) =>
  api.post<Estimate>(`/api/episodes/${eid}/estimate`, body, { silent });

export type QuoteAction =
  | "extend" | "endframe" | "edit" | "enhance" | "sheet" | "expressions" | "lighting" | "outfit" | "variations"
  | "voice_design" | "voice_preview" | "location_images" | "sfx" | "table_read";

/** One single-item action, named by the item it acts on (`shot_id`, `take_id`, `character_id`, …) plus its options. */
export const quote = (body: { action: QuoteAction } & Record<string, unknown>, silent = false) =>
  api.post<Estimate>("/api/estimate", body, { silent });

/** Backend words in price lines and job names, and the plain words the UI uses for them. Longest first. */
const PLAIN: [string, string][] = [
  ["Cast looks & voices", "Cast pictures & voices"], ["Voices & lip-sync", "Voices & mouth sync"], ["Final export", "Final film"],
  ["Extensions", "Longer clips"], ["Keyframes", "Pictures"], ["Keyframe", "Picture"], ["Lip-sync", "Mouth sync"], ["lip-sync", "mouth sync"],
];

/** A price line or job name from the server in the UI's plain words ("Keyframes · 3" reads "Pictures · 3"). */
export function plainLabel(label: string): string {
  let out = label;
  for (const [from, to] of PLAIN) if (out.includes(from)) out = out.split(from).join(to);
  return out;
}

/**
 * A batch price to show on a button before it is pressed ("Make the cast · $0.24"). Quiet: a batch that can't run yet
 * (no shots) just has no price. Re-priced when `deps` change (what the price depends on: shots, looks, videos…).
 */
export function useBatchEstimate(eid: number, body: Record<string, unknown> | null, deps: unknown[] = []) {
  return useQuery({
    queryKey: ["estimate", eid, body, ...deps],
    queryFn: () => estimateBatch(eid, body ?? {}, true),
    enabled: !!eid && !!body,
    staleTime: 30_000,
    retry: false,
  });
}
