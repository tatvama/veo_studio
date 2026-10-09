import { MONEY_JOIN, rupees, splitMoney, useCurrency } from "./currency";

export const LANG_NAMES: Record<string, string> = { en: "English", hi: "Hindi", kn: "Kannada", te: "Telugu", ta: "Tamil" };
export const LANG_SHORT: Record<string, string> = { en: "EN", hi: "HI", kn: "KN", te: "TE", ta: "TA" };

/**
 * A dollar amount as text, in the user's currency mode: "$12.40 ≈ ₹1,201" (both), "$12.40" (usd) or "₹1,201" (inr).
 * `digits` is the USD precision (0 for whole-dollar caps). Falls back to USD alone until a rate is known.
 */
export function usd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "—";
  const m = splitMoney(v, digits);
  if (!m.inr || m.mode === "usd") return m.usd;
  return m.mode === "inr" ? m.inr : `${m.usd}${MONEY_JOIN}${m.inr}`;
}

/** Dollars only, whatever the mode: for values that are defined in USD (budget caps typed in, price per second). */
export function usdOnly(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "—";
  return splitMoney(v, digits).usd;
}

/** Rupees only, for a dollar amount ("—" until the rate is known). */
export function inr(v: number | null | undefined, digits?: number): string {
  const { inr: rate } = useCurrency.getState();
  if (v === null || v === undefined || !rate) return "—";
  return rupees(v * rate, digits);
}

/** A price per second: "~$0.05/s ≈ ₹4.84/s" (both), "$0.05/s" or "₹4.84/s". Three decimals under ten cents, trailing zero trimmed. */
export function usdPerSec(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const s = usd(v, v < 0.1 ? 3 : 2).replace(/(\.\d\d)0(?=\D|$)/g, "$1");
  return s.split(MONEY_JOIN).map((x) => `${x}/s`).join(MONEY_JOIN);
}

export function ago(iso?: string | null): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function secs(v: number | undefined | null): string {
  if (!v) return "0s";
  if (v < 60) return `${Math.round(v * 10) / 10}s`;
  const m = Math.floor(v / 60);
  return `${m}m ${Math.round(v - m * 60)}s`;
}

export const JOB_STATUS_COLOR: Record<string, string> = {
  proposed: "text-accent-2", queued: "text-info", running: "text-accent-ink", awaiting_approval: "text-warn",
  succeeded: "text-ok", failed: "text-bad", cancelled: "text-dim",
};

export const QUALITY_INFO: Record<string, { label: string; price: string; desc: string }> = {
  saver: { label: "Saver", get price() { return `~${usdPerSec(0.05)}`; }, desc: "Approved keyframe → Veo 3.1 Lite (720p)" },
  balanced: { label: "Balanced", get price() { return `~${usdPerSec(0.1)}`; }, desc: "Veo 3.1 Fast with up to 3 reference images" },
  hero: { label: "Hero", get price() { return `~${usdPerSec(0.4)}`; }, desc: "Veo 3.1 Standard, 1080p — key moments only" },
};

export const VOICE_MODES: Record<string, string> = {
  auto: "Auto", native: "Native (Veo voice)", audio_first: "Audio-first + lip-sync", voice_lock: "Voice lock (ElevenLabs)",
  narration: "Narration", none: "No speech",
};

export const SHOT_MODES: Record<string, string> = {
  auto: "Auto", text_to_video: "Text → video", interpolate: "First + last frame", reference_to_video: "Reference images",
};
