import { tr } from "../../../lib/i18n";
import { usd } from "../../../lib/format";
import type { TeamStatus, UserBrief } from "../../../lib/types";

export interface CostSummary {
  team: TeamStatus;
  mine: { spent_usd: number; limit_usd: number | null };
  by_project: { project_id: number | null; title: string; usd: number }[];
  by_user: { user: UserBrief | null; usd: number }[];
  by_provider: { provider: string; kind: string; usd: number; count: number }[];
}

export interface LedgerRow {
  id: number; user_id: number | null; project_id: number | null; job_id: number | null; provider: string; model: string;
  kind: string; units: number; unit_type: string; usd: number; mock: boolean; created_at: string;
}

// Ledger `kind` values written by backend/app/providers/services.py and agents/director.py.
const KIND_LABELS: Record<string, string> = {
  video: "Video", video_edit: "Video edit", image: "Image", tts: "Voice", voice_design: "Voice design",
  voice_change: "Voice changer", isolation: "Voice cleanup", lipsync: "Lip-sync", music: "Music", agent: "Director chat",
  "llm:qc": "Quality check", sfx: "Sound effects", embedding: "Search index", train: "Identity training",
};

const titleCase = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function kindLabel(k: string): string {
  if (!k) return "—";
  if (KIND_LABELS[k]) return tr(KIND_LABELS[k]);
  if (k.startsWith("llm:")) return tr("Writing · {what}", { what: titleCase(k.slice(4)).toLowerCase() });
  return titleCase(k);
}

export function fmtUnits(units: number, type: string): string {
  if (!units) return "—";
  const n = Number.isInteger(units) ? units.toLocaleString() : units.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return `${n} ${type || ""}`.trim();
}

/** Money with a third decimal for tiny amounts, so $0.004 doesn't read as $0.00. */
export const money = (v: number) => usd(v, v > 0 && v < 0.1 ? 3 : 2);
