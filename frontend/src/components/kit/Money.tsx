import { clsx } from "clsx";
import { MONEY_JOIN, rupees, splitMoney, useCurrency } from "../../lib/currency";

/** "~$12.40 ≈ ₹1,201" → ["~$12.40", "₹1,201"]; null when the text is anything else (more than one amount, no rupees, plain text). */
export function splitMoneyText(text: string): [string, string] | null {
  const i = text.indexOf(MONEY_JOIN);
  if (i < 1) return null;
  const rest = text.slice(i + MONEY_JOIN.length);
  return /^[<~]?₹[\d,.]+(?:k|L|Cr)?$/.test(rest) ? [text.slice(0, i), rest] : null;
}

/** The rupee part of a figure: small, same colour but fainter, and never broken across lines. */
const sub = "mono whitespace-nowrap text-[0.55em] font-normal opacity-65";

/**
 * Renders a string from `usd()` for a big figure: "$12.40 ≈ ₹1,201" becomes the dollars large and the rupees small beside
 * them, wrapping under them when the tile is narrow. Anything else is returned as it is.
 */
export function MoneyText({ text }: { text: string }) {
  const parts = splitMoneyText(text);
  if (!parts) return <>{text}</>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
      <span className="whitespace-nowrap">{parts[0]}</span>
      <span className={sub}>{parts[1]}</span>
    </span>
  );
}

/**
 * A dollar amount in the user's currency mode, styled for big figures: the main currency large, the other one small beside
 * or under it. For running text use `usd()` from lib/format instead (it returns a plain string).
 */
export function Money({ v, digits = 2, stack = false, className, subClassName }: {
  v: number | null | undefined; digits?: number; /** put the second currency on its own line under the first */ stack?: boolean; className?: string; subClassName?: string;
}) {
  useCurrency((s) => `${s.mode}:${s.inr}`); // re-render when the mode or rate changes
  if (v === null || v === undefined) return <span className={className}>—</span>;
  const m = splitMoney(v, digits);
  if (!m.inr || m.mode === "usd") return <span className={className}>{m.usd}</span>;
  if (m.mode === "inr") return <span className={className}>{m.inr}</span>;
  return (
    <span className={clsx(stack ? "inline-flex flex-col items-start leading-none" : "inline-flex flex-wrap items-baseline gap-x-1.5", className)}>
      <span className="whitespace-nowrap">{m.usd}</span>
      <span className={clsx(sub, stack && "mt-1 leading-none", subClassName)}>{m.inr}</span>
    </span>
  );
}

/** "≈ ₹9,688": the rupee value of a dollar amount someone is typing. Nothing when the mode is USD, there is no rate, or the field is empty. */
export function RupeeHint({ v, className }: { v: unknown; className?: string }) {
  const mode = useCurrency((s) => s.mode);
  const rate = useCurrency((s) => s.inr);
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  if (!rate || mode === "usd" || !Number.isFinite(n) || n <= 0) return null;
  const r = n * rate;
  return <span className={clsx("mono block text-2xs text-dim", className)}>≈ {rupees(r, r < 100 ? 2 : 0)}</span>;
}
