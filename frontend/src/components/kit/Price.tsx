import { clsx } from "clsx";
import { useT } from "../../lib/i18n";
import { Money } from "./Money";

/**
 * The price at the end of a button's label: "Make pictures · $0.20" (or "· free"). Nothing while it is not known yet, so
 * the label never shows a wrong figure; the cost dialog still shows the price before anything is spent.
 */
export function PriceSuffix({ usd, className }: { usd: number | null | undefined; className?: string }) {
  const t = useT();
  if (usd === null || usd === undefined) return null;
  return (
    <span className={clsx("mono whitespace-nowrap font-normal opacity-90", className)}>
      · {usd > 0 ? <Money v={usd} /> : t("free")}
    </span>
  );
}
