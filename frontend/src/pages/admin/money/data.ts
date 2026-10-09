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

// ── time series helpers (pure, presentation only) ───────────────────────────────────────────────────────────────

/** One local calendar day: `day` is local midnight in ms. */
export interface DayPoint { day: number; usd: number; count: number }

export const localDay = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
export const addDays = (ms: number, n: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
export const dayIndex = (from: number, day: number) => Math.round((day - from) / 86_400_000);

/** Spend per local day from `from` to `to` (both local midnights, inclusive), empty days filled with zero. */
export function dailySeries(rows: LedgerRow[], from: number, to: number): DayPoint[] {
  const out: DayPoint[] = [];
  const at = new Map<number, DayPoint>();
  for (let d = from; d <= to; d = addDays(d, 1)) { const p = { day: d, usd: 0, count: 0 }; out.push(p); at.set(d, p); }
  for (const r of rows) {
    const t = Date.parse(r.created_at);
    if (Number.isNaN(t)) continue;
    const p = at.get(localDay(t));
    if (p) { p.usd += r.usd; p.count += 1; }
  }
  return out;
}

/** Paid video cost per generated second, from the loaded ledger rows (null when there is no paid video). */
export function costPerVideoSecond(rows: LedgerRow[]): number | null {
  let usd = 0, sec = 0;
  for (const r of rows) if (r.kind === "video" && !r.mock && r.unit_type === "seconds" && r.units > 0) { usd += r.usd; sec += r.units; }
  return sec > 0 ? usd / sec : null;
}

/** Compact money for chart axes: $0, $2.5, $40, $1.2k. */
export function axisMoney(v: number): string {
  if (v >= 1000) return `$${+(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  if (v < 1) return `$${+v.toFixed(2)}`;
  return `$${+v.toFixed(v < 10 ? 1 : 0)}`;
}

/** A round upper bound and tick step for an axis that starts at zero (about `n` ticks). */
export function niceScale(max: number, n = 4): { max: number; step: number } {
  if (!(max > 0)) return { max: 1, step: 0.25 };
  const raw = max / n;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
  return { max: Math.ceil(max / step) * step, step };
}

export interface ServiceRow { provider: string; usd: number; count: number; kinds: { kind: string; usd: number; count: number }[] }

/** Spend grouped per service (the API reports one row per service + type); every "llm:*" kind collapses into one "Writing" line. */
export function groupServices(byProvider: CostSummary["by_provider"] | undefined): ServiceRow[] {
  const map = new Map<string, ServiceRow>();
  for (const r of byProvider ?? []) {
    const key = r.provider || "system";
    const s = map.get(key) ?? { provider: key, usd: 0, count: 0, kinds: [] };
    s.usd += r.usd; s.count += r.count;
    const kind = r.kind.startsWith("llm:") ? "llm" : r.kind;
    const k = s.kinds.find((x) => x.kind === kind);
    if (k) { k.usd += r.usd; k.count += r.count; } else s.kinds.push({ kind, usd: r.usd, count: r.count });
    map.set(key, s);
  }
  const list = [...map.values()];
  list.forEach((s) => s.kinds.sort((a, b) => b.usd - a.usd || b.count - a.count));
  return list.sort((a, b) => b.usd - a.usd || b.count - a.count);
}
