export const LANG_NAMES: Record<string, string> = { en: "English", hi: "Hindi", kn: "Kannada", te: "Telugu", ta: "Tamil" };
export const LANG_SHORT: Record<string, string> = { en: "EN", hi: "HI", kn: "KN", te: "TE", ta: "TA" };

export function usd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "—";
  if (v > 0 && v < 0.01) return "<$0.01";
  return `$${v.toFixed(digits)}`;
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
  saver: { label: "Saver", price: "~$0.05/s", desc: "Approved keyframe → Veo 3.1 Lite (720p)" },
  balanced: { label: "Balanced", price: "~$0.10/s", desc: "Veo 3.1 Fast with up to 3 reference images" },
  hero: { label: "Hero", price: "~$0.40/s", desc: "Veo 3.1 Standard, 1080p — key moments only" },
};

export const VOICE_MODES: Record<string, string> = {
  auto: "Auto", native: "Native (Veo voice)", audio_first: "Audio-first + lip-sync", voice_lock: "Voice lock (ElevenLabs)",
  narration: "Narration", none: "No speech",
};

export const SHOT_MODES: Record<string, string> = {
  auto: "Auto", text_to_video: "Text → video", interpolate: "First + last frame", reference_to_video: "Reference images",
};
