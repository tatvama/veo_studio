import { CircleCheck, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { axisMoney } from "./data";
import { usd } from "../../../lib/format";
import "../../../styles/admin.css";

export type BudgetTone = "ok" | "warn" | "bad";

/** Where a budget stands: the tone, the word and the icon (state is never shown by colour alone). */
export function budgetState(pct: number): { tone: BudgetTone; word: string; icon: LucideIcon } {
  if (pct >= 100) return { tone: "bad", word: "Over budget", icon: OctagonAlert };
  if (pct >= 80) return { tone: "warn", word: "Getting close", icon: TriangleAlert };
  return { tone: "ok", word: "On track", icon: CircleCheck };
}

const FILL: Record<BudgetTone, string> = { ok: "var(--color-accent)", warn: "var(--color-warn)", bad: "var(--color-bad)" };

/**
 * Segmented budget meter: lit cells for what is spent, dim cells for money reserved by running jobs, empty cells for what is
 * left. Ticks under the bar mark the 80 % warning line and the cap. `label` is the accessible text.
 */
export function BudgetMeter({ spent, reserved, cap, tone, label, cells = 40 }: {
  spent: number; reserved: number; cap: number; tone: BudgetTone; label: string; cells?: number;
}) {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const sp = cap > 0 ? clamp(spent / cap) : 0;
  const held = cap > 0 ? clamp((spent + reserved) / cap) : 0;
  const spentCells = spent > 0 ? Math.max(1, Math.round(sp * cells)) : 0;
  const heldCells = Math.max(spentCells, Math.round(held * cells));
  return (
    <div>
      <div role="img" aria-label={label} className="ad-seg" style={{ ["--c" as string]: FILL[tone] }}>
        {Array.from({ length: cells }, (_, i) => <i key={i} className={i < spentCells ? "is-spent" : i < heldCells ? "is-held" : undefined} />)}
      </div>
      <div aria-hidden className="mono relative mt-1.5 h-4 text-2xs text-dim">
        <span className="absolute left-0">{axisMoney(0)}</span>
        <span className="absolute -translate-x-1/2" style={{ left: "80%" }}>80%</span>
        <span className="absolute right-0">{usd(cap, 0)}</span>
      </div>
    </div>
  );
}
