/**
 * Pure helpers for the Model Hub: how a catalog entry is read as a spec sheet (capability flags, price per second,
 * speed tier, track record) and the client-side "refine" filters (capability / price band / speed) that the API cannot
 * filter on. No React in here, so the card, table, detail and compare views all agree on the numbers.
 */
import { Fingerprint, MessageSquareText, Mic, Speech, Volume2, type LucideIcon } from "lucide-react";
import { usd } from "../../lib/format";
import type { AIModel } from "../../lib/types";

/* ── capabilities ───────────────────────────────────────────────────────────── */

export type CapKey = "native_audio" | "speech_in_video" | "audio_driven" | "lora_input" | "lipsync_to_audio";
export interface CapDef { key: CapKey; label: string; title: string; icon: LucideIcon }

/** Labels and titles are the English i18n keys the rest of the hub already uses. */
export const CAP_DEFS: readonly CapDef[] = [
  { key: "native_audio", label: "audio", title: "Generates its own sound", icon: Volume2 },
  { key: "speech_in_video", label: "speaks", title: "Speaks the line itself: voice and lips in one pass (Google route)", icon: MessageSquareText },
  { key: "audio_driven", label: "audio-driven", title: "Animates the face from a voice track you give it", icon: Mic },
  { key: "lora_input", label: "identity", title: "Accepts a trained identity (LoRA) for a locked face", icon: Fingerprint },
  { key: "lipsync_to_audio", label: "lip-sync", title: "Re-syncs the lips of an existing clip to given audio", icon: Speech },
];
export const CAP_KEYS = CAP_DEFS.map((d) => d.key) as readonly CapKey[];

/** Which flags make sense for a kind of engine: those are shown "unlit" when missing, so cards of one kind compare at a glance. */
const RELEVANT: Record<string, readonly CapKey[]> = {
  video: CAP_KEYS, avatar: CAP_KEYS,
  lipsync: ["lipsync_to_audio", "audio_driven"],
  image: ["lora_input"], edit: ["native_audio", "lora_input"], train: ["lora_input"],
};

export function hasCap(m: Pick<AIModel, "capabilities">, key: CapKey): boolean {
  return !!(m.capabilities ?? {})[key];
}

/** Capability chips for a model: every flag it has (lit) plus the flags its kind normally has (unlit). */
export function capRows(m: Pick<AIModel, "capabilities" | "task">): { def: CapDef; on: boolean }[] {
  const rel = RELEVANT[m.task] ?? [];
  return CAP_DEFS.filter((d) => hasCap(m, d.key) || rel.includes(d.key)).map((d) => ({ def: d, on: hasCap(m, d.key) }));
}

/* ── price ──────────────────────────────────────────────────────────────────── */

const TIME_BASED = ["video", "avatar", "lipsync", "edit"];
export const isTimeBased = (m: Pick<AIModel, "task">) => TIME_BASED.includes(m.task);

const unitOf = (m: Pick<AIModel, "price_unit">) => (m.price_unit || "").toLowerCase();
const perSecondUnit = (u: string) => u.includes("second") || u === "s" || u === "sec";
const perMinuteUnit = (u: string) => u.includes("minute");

/**
 * USD per second of output. The server estimate is 0 while a provider runs in placeholder mode, so fall back to the
 * list price (per second / per minute units) before giving up. `exact` is false when it was spread from a per-run price.
 */
export function perSecond(m: Pick<AIModel, "est_8s_usd" | "price_usd" | "price_unit" | "task" | "builtin">): { value: number | null; exact: boolean } {
  if (!isTimeBased(m)) return { value: null, exact: false };
  const u = unitOf(m);
  if (m.price_usd != null && perSecondUnit(u)) return { value: m.price_usd, exact: true };
  if (m.price_usd != null && perMinuteUnit(u)) return { value: m.price_usd / 60, exact: true };
  if (m.est_8s_usd != null && m.est_8s_usd > 0) return { value: m.est_8s_usd / 8, exact: !!m.builtin };
  return { value: null, exact: false };
}

/** USD for an 8 second clip, or null when the engine isn't priced per clip. */
export function clipUsd(m: Pick<AIModel, "est_8s_usd" | "price_usd" | "price_unit" | "task" | "builtin">): number | null {
  if (m.est_8s_usd != null && m.est_8s_usd > 0) return m.est_8s_usd;
  const p = perSecond(m).value;
  return p != null ? p * 8 : null;
}

/** "$0.050" under ten cents, otherwise "$0.40". Mono figures, so the decimals stay aligned. */
export const rateText = (v: number) => usd(v, v < 0.1 ? 3 : 2);

/** True when the provider is not live and the number on screen comes from the list price, not a metered estimate. */
export const isListPrice = (m: Pick<AIModel, "provider_mode">) => m.provider_mode !== "live";

export interface PriceBand { value: string; label: string; test: (clip: number | null) => boolean }
/** Price bands over the cost of an 8 second clip. Labels are English i18n keys. */
export const PRICE_BANDS: readonly PriceBand[] = [
  { value: "lt50", label: "Under $0.50", test: (c) => c != null && c < 0.5 },
  { value: "50-150", label: "$0.50 – $1.50", test: (c) => c != null && c >= 0.5 && c < 1.5 },
  { value: "150-300", label: "$1.50 – $3", test: (c) => c != null && c >= 1.5 && c < 3 },
  { value: "gt300", label: "Over $3", test: (c) => c != null && c >= 3 },
  { value: "none", label: "Not priced per clip", test: (c) => c == null },
];
export const PRICE_KEYS = PRICE_BANDS.map((b) => b.value);

/* ── speed / quality / track record ─────────────────────────────────────────── */

export interface SpeedOpt { value: string; label: string; cells: number }
/** There is no latency feed, so speed is read from the engine's tier: draft = fast, premium = best quality but slower. */
export const SPEED_OPTS: readonly SpeedOpt[] = [
  { value: "draft", label: "Fast (draft)", cells: 3 },
  { value: "standard", label: "Balanced (standard)", cells: 2 },
  { value: "premium", label: "Quality (premium)", cells: 1 },
];
export const SPEED_KEYS = SPEED_OPTS.map((s) => s.value);
export const speedCells = (tier: string | undefined) => SPEED_OPTS.find((s) => s.value === tier)?.cells ?? 0;

export function successPct(m: Pick<AIModel, "uses" | "failures">): number | null {
  const total = (m.uses || 0) + (m.failures || 0);
  return total ? Math.round(((m.uses || 0) / total) * 100) : null;
}

/* ── client-side refinements ────────────────────────────────────────────────── */

export interface Refine { cap: string[]; price: string[]; speed: string[] }
export const NO_REFINE: Refine = { cap: [], price: [], speed: [] };
export const refineCount = (r: Refine) => r.cap.length + r.price.length + r.speed.length;
export const refineActive = (r: Refine) => refineCount(r) > 0;

/** Capabilities must all be present (AND); a price band or a speed tier may be any of the chosen ones (OR). */
export function matchesRefine(m: AIModel, r: Refine): boolean {
  if (r.cap.length && !r.cap.every((k) => hasCap(m, k as CapKey))) return false;
  if (r.price.length) {
    const clip = clipUsd(m);
    if (!PRICE_BANDS.some((b) => r.price.includes(b.value) && b.test(clip))) return false;
  }
  if (r.speed.length && !r.speed.includes(m.tier)) return false;
  return true;
}

/** Counts per refine option over a list of models, each section counted against the other sections' choices. */
export function refineFacets(models: AIModel[], r: Refine) {
  const cap: Record<string, number> = {}, price: Record<string, number> = {}, speed: Record<string, number> = {};
  for (const d of CAP_DEFS) cap[d.key] = models.filter((m) => matchesRefine(m, { ...r, cap: r.cap.includes(d.key) ? r.cap : [...r.cap, d.key] })).length;
  const noPrice = models.filter((m) => matchesRefine(m, { ...r, price: [] }));
  for (const b of PRICE_BANDS) price[b.value] = noPrice.filter((m) => b.test(clipUsd(m))).length;
  const noSpeed = models.filter((m) => matchesRefine(m, { ...r, speed: [] }));
  for (const s of SPEED_OPTS) speed[s.value] = noSpeed.filter((m) => m.tier === s.value).length;
  return { cap, price, speed };
}

/** The headline of a card: the description, or the kind of engine and its input modes when the provider gave none. */
export function purposeText(m: Pick<AIModel, "description">): string {
  return (m.description || "").replace(/\s+/g, " ").trim();
}
