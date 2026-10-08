import { tr } from "../../lib/i18n";
import { LIGHTING_VARIANTS, SHEET_VIEWS } from "../../lib/v3";

/* Labels and small helpers shared by the Character Lab panels (reference pack, costumes, versions, lock). */

/** English keys (pass through t()) for the turnaround views and the user's own photos. */
export const VIEW_LABEL: Record<string, string> = {
  source: "Your photo", front: "Front", three_quarter: "Three-quarter", profile: "Profile", back: "Back", full_body: "Full body",
};
export const LIGHT_LABEL: Record<string, string> = { day: "Day", dusk: "Dusk", night_interior: "Night interior" };

/** The views a new outfit gets by default (mirrors the backend's OUTFIT_VIEWS). */
export const OUTFIT_VIEWS = ["front", "three_quarter", "full_body"] as const;

/** Sort order inside the "Views" group of the reference pack: the user's photo first, then the sheet angles. */
export const VIEW_ORDER: string[] = ["source", ...SHEET_VIEWS];
export const LIGHT_ORDER: string[] = [...LIGHTING_VARIANTS];

/** "All episodes", "Ep 3", "Ep 2–5", "Ep 4 onward", "Up to Ep 3" */
export function episodeRange(from?: number | null, to?: number | null): string {
  if (from == null && to == null) return tr("All episodes");
  if (from != null && to == null) return tr("Ep {n} onward", { n: from });
  if (from == null && to != null) return tr("Up to Ep {n}", { n: to });
  if (from === to) return tr("Ep {n}", { n: from as number });
  return tr("Ep {a}–{b}", { a: from as number, b: to as number });
}

/** Does an inclusive episode range (null = open) cover episode `n`? */
export function coversEpisode(from: number | null | undefined, to: number | null | undefined, n: number | undefined): boolean {
  if (n === undefined) return false;
  return (from == null || from <= n) && (to == null || n <= to);
}

/** "" → null, otherwise a whole number ≥ 1 (episode inputs). */
export function episodeNumber(s: string): number | null {
  const v = s.trim();
  if (!v) return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : null;
}

export type StrictnessLevel = "lenient" | "balanced" | "strict";
export const strictnessLevel = (s: number | undefined): StrictnessLevel => (s ?? 0.5) < 0.34 ? "lenient" : (s ?? 0.5) < 0.67 ? "balanced" : "strict";
export const LEVEL_LABEL: Record<StrictnessLevel, string> = { lenient: "Lenient", balanced: "Balanced", strict: "Strict" };
/** The lock is shown as "locked look" on cast cards from this strictness up. */
export const LOCKED_LOOK_AT = 0.7;
