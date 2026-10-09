import {
  AudioLines, BadgeCheck, Boxes, Clapperboard, FileCheck, FileText, KeyRound, Link2, Music, Plug, ScanFace, ScrollText, SlidersHorizontal, UserCog, UserRound,
  type LucideIcon,
} from "lucide-react";
import { tr } from "../../../lib/i18n";
import type { ConsentRow } from "../../../lib/types";

export type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info";

/** Audit actions look like "settings.update": the part before the first dot is the category. */
export const CATEGORIES: Record<string, { label: string; tone: Tone; icon: LucideIcon }> = {
  settings: { label: "Settings", tone: "warn", icon: SlidersHorizontal },
  apikey: { label: "API keys", tone: "warn", icon: KeyRound },
  integration: { label: "Integrations", tone: "warn", icon: Plug },
  user: { label: "Team", tone: "info", icon: UserCog },
  models: { label: "Models", tone: "info", icon: Boxes },
  export: { label: "Exports", tone: "accent", icon: Clapperboard },
  review_link: { label: "Review links", tone: "accent", icon: Link2 },
  consent: { label: "Consents", tone: "ok", icon: FileCheck },
  approval: { label: "Approvals", tone: "ok", icon: BadgeCheck },
  character: { label: "Characters", tone: "neutral", icon: UserRound },
};

export const categoryOf = (action: string) => action.split(".")[0];
export const catInfo = (action: string) => CATEGORIES[categoryOf(action)] ?? { label: "Other", tone: "neutral" as Tone, icon: ScrollText };

export const ACTION_LABELS: Record<string, string> = {
  "settings.update": "Settings changed", "apikey.set": "API key saved", "apikey.delete": "API key removed",
  "integration.youtube.connect": "YouTube connected", "integration.remove": "Integration removed", "user.create": "User added",
  "user.update": "User changed", "export.publish": "Render published", "review_link.create": "Review link created",
  "consent.add": "Consent recorded", "approval.approve": "Spending approved", "character.lock": "Character locked",
  "character.train": "Identity training started", "models.update": "Model changed", "models.policy": "Engine policy changed",
};

/** A readable name for any action, translated when we know it. */
export function actionLabel(action: string): string {
  if (ACTION_LABELS[action]) return tr(ACTION_LABELS[action]);
  const words = action.replace(/[._]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const TONE_SOFT: Record<Tone, string> = {
  neutral: "bg-raised text-mute", accent: "bg-accent/12 text-accent-ink", ok: "bg-ok/12 text-ok", warn: "bg-warn/12 text-warn", bad: "bg-bad/12 text-bad", info: "bg-info/12 text-info",
};

export const CONSENT_KINDS: Record<string, string> = {
  voice_replication: "Voice replication", likeness: "Likeness (face / body)", music: "Music rights", other: "Other",
};

export function csvCell(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const KIND_ICON: Record<string, LucideIcon> = { voice_replication: AudioLines, likeness: ScanFace, music: Music, other: FileText };

export type ExpiryState = "none" | "valid" | "soon" | "expired";

/** Where a consent stands: no expiry, valid, running out within 30 days, or expired; plus the days left and how much of its term is used. */
export function expiry(c: ConsentRow): { state: ExpiryState; days: number; used: number } {
  if (!c.expires_on) return { state: "none", days: 0, used: 0 };
  const end = new Date(`${c.expires_on}T23:59:59`).getTime();
  if (Number.isNaN(end)) return { state: "none", days: 0, used: 0 };
  const now = Date.now();
  const days = Math.ceil((end - now) / 86_400_000);
  const start = new Date(c.created_at).getTime();
  const used = Number.isNaN(start) || end <= start ? 1 : Math.max(0, Math.min(1, (now - start) / (end - start)));
  return { state: end < now ? "expired" : days <= 30 ? "soon" : "valid", days, used };
}
