/** Shared helpers for the Model Hub, engine picker and shootouts. Labels are English i18n keys — wrap with t()/tr(). */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useAuthStatus } from "../../lib/queries";
import type { AIModel, ModelList, Take } from "../../lib/types";

export const TASKS = ["video", "avatar", "lipsync", "edit", "image", "tts", "music", "train"] as const;
export const TASK_LABELS: Record<string, string> = {
  video: "Video", avatar: "Avatar", lipsync: "Lip-sync", edit: "Edit", image: "Image", tts: "Speech", music: "Music",
  train: "Training", other: "Other",
};
export const MODES = ["t2v", "i2v", "ref2v", "flf", "a2v", "lipsync", "extend", "edit", "t2i", "i2i", "tts"] as const;
export const MODE_LABELS: Record<string, string> = {
  t2v: "Text → video", i2v: "Image → video", ref2v: "References → video", flf: "First + last frame", a2v: "Audio → video",
  lipsync: "Lip-sync", extend: "Extend", edit: "Edit", t2i: "Text → image", i2i: "Image → image", tts: "Speech",
};
export const STATUS_LABELS: Record<string, string> = { new: "New", enabled: "Enabled", disabled: "Disabled", retired: "Retired" };
export const STATUS_TONE: Record<string, "accent" | "ok" | "neutral" | "bad"> = { new: "accent", enabled: "ok", disabled: "neutral", retired: "bad" };
export const TIERS = ["draft", "standard", "premium"] as const;
export const TIER_LABELS: Record<string, string> = { draft: "Draft", standard: "Standard", premium: "Premium" };
export const PRICE_UNITS = ["second", "video", "image", "request", "minute", "1k_chars"] as const;

/** "fal:fal-ai/kling-video/v3/pro/image-to-video" → "kling-video v3 pro image-to-video" */
export function engineShort(id: string | null | undefined): string {
  if (!id) return "";
  const path = id.includes(":") ? id.split(":").slice(1).join(":") : id;
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "fal-ai" && parts.length > 1) parts.shift();
  return parts.join(" ").replaceAll("_", " ");
}

export function isAutoEngine(engine: string | null | undefined) {
  return !engine || engine === "auto";
}

/** Which engine made a take (v2 takes carry params.engine / engine_label). */
export function takeEngine(t: Take | null | undefined): string {
  if (!t) return "";
  return t.params?.engine_label || (t.params?.engine ? engineShort(t.params.engine) : "") || t.model || t.provider || "";
}

export function durationsText(d: AIModel["capabilities"]["durations"]): string {
  if (!d) return "";
  if (Array.isArray(d)) return d.length ? `${d.map((x) => `${x}`).join("/")}s` : "";
  if (d.min != null && d.max != null) return `${d.min}–${d.max}s`;
  if (d.max != null) return `≤${d.max}s`;
  if (d.min != null) return `≥${d.min}s`;
  return "";
}

export function dateText(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Recently discovered (first seen within `days`) and not a built-in. */
export function isFresh(m: Pick<AIModel, "first_seen" | "builtin" | "status">, days = 14): boolean {
  if (m.status === "new") return true;
  if (m.builtin || !m.first_seen) return false;
  const t = new Date(m.first_seen).getTime();
  return !Number.isNaN(t) && Date.now() - t < days * 86_400_000;
}

export function isVideoUrl(u: string) {
  return /\.(mp4|webm|mov)(\?|#|$)/i.test(u);
}

/** Visible tags (sync stores fal's updated_at timestamp as the last tag). */
export function visibleTags(tags: string[] | null | undefined): string[] {
  return (tags ?? []).filter((x) => x && !/^\d{4}-\d{2}-\d{2}T/.test(x));
}

export function useIsAdmin(): boolean {
  const { data } = useAuthStatus();
  return data?.user?.role === "admin";
}

export function modelQs(params: Record<string, string | undefined>): string {
  return new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
}

/** Same cache key as queries.ts `useModels`, plus polling / enabled options. */
export function useModelList(params: { task?: string; status?: string; q?: string; provider?: string; mode?: string } = {},
  opts: { refetchInterval?: number | false; enabled?: boolean } = {}) {
  const qs = modelQs(params);
  return useQuery({
    queryKey: ["models", qs],
    queryFn: () => api.get<ModelList>(`/api/models${qs ? `?${qs}` : ""}`),
    refetchInterval: opts.refetchInterval,
    enabled: opts.enabled ?? true,
    staleTime: 20_000,
  });
}

/** Chain → what a model must support to be placed in it. */
export const CHAIN_FIT: Record<string, { tasks?: string[]; modes: string[] }> = {
  "video.saver": { tasks: ["video"], modes: ["t2v", "i2v", "ref2v", "flf"] },
  "video.balanced": { tasks: ["video"], modes: ["t2v", "i2v", "ref2v", "flf"] },
  "video.hero": { tasks: ["video"], modes: ["t2v", "i2v", "ref2v", "flf"] },
  dialogue: { tasks: ["avatar", "video"], modes: ["a2v"] },
  lipsync: { tasks: ["lipsync"], modes: ["lipsync"] },
  image: { tasks: ["image"], modes: ["t2i", "i2i"] },
  edit: { modes: ["edit"] },
  extend: { modes: ["extend"] },
};

export const CHAIN_HELP: Record<string, string> = {
  "video.saver": "Cheapest clips — drafts, B-roll and background shots.",
  "video.balanced": "The default for most shots: a good look at a fair price.",
  "video.hero": "Key moments where quality matters more than cost.",
  dialogue: "Speaking shots: turns the voice track into a talking clip in one pass.",
  lipsync: "Re-dubs an existing clip so the lips match a new language.",
  image: "Keyframes, character sheets and location plates.",
  edit: "Changes a finished clip from a written instruction.",
  extend: "Continues a clip for a few more seconds.",
};

export function fitsChain(m: AIModel, chain: string): boolean {
  const fit = CHAIN_FIT[chain];
  if (!fit) return true;
  if (m.status === "retired") return false;
  if (fit.tasks && !fit.tasks.includes(m.task)) return false;
  const modes = m.capabilities?.modes ?? [];
  return fit.modes.some((x) => modes.includes(x));
}

/** Pointer capture that never throws (the pointer may already be gone when a drag ends or a test dispatches synthetic events). */
export function capturePointer(el: Element, id: number) {
  try { el.setPointerCapture(id); } catch { /* the pointer is no longer active */ }
}
export function releasePointer(el: Element, id: number) {
  try { if (el.hasPointerCapture(id)) el.releasePointerCapture(id); } catch { /* ignore */ }
}
