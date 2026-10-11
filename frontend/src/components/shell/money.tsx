import { TriangleAlert } from "lucide-react";
import { useCurrency, type CurrencyMode } from "../../lib/currency";
import { useT } from "../../lib/i18n";
import { Segmented } from "../ui";
import { usePrefActions } from "./prefs";

/** USD / INR / both: how every cost figure in the studio is shown. */
export function CurrencySwitch({ signedIn = true, size = "sm" }: { signedIn?: boolean; size?: "sm" | "md" }) {
  const t = useT();
  const mode = useCurrency((s) => s.mode);
  const { setCurrency } = usePrefActions(signedIn);
  return (
    <Segmented<CurrencyMode>
      size={size}
      value={mode}
      onChange={setCurrency}
      aria-label={t("Currency")}
      options={[
        { value: "both", title: t("Show dollars and rupees"), label: t("Both") },
        { value: "usd", title: t("Show dollars only"), label: "$ USD" },
        { value: "inr", title: t("Show rupees only"), label: "₹ INR" },
      ]}
    />
  );
}

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The currency switch and the live USD to INR rate, with where it came from (the top bar's status chip opens it). */
export function RateDetails() {
  const t = useT();
  const inr = useCurrency((s) => s.inr);
  const asOf = useCurrency((s) => s.asOf);
  const source = useCurrency((s) => s.source);
  const stale = useCurrency((s) => s.stale);
  return (
    <>
      <p className="eyebrow pb-2">{t("Currency")}</p>
      <CurrencySwitch />
      <div className="mt-3 rounded-lg border border-line bg-raised/50 p-3">
        {inr ? (
          <>
            <p className="mono text-lg text-ink">$1 = ₹{inr.toFixed(4)}</p>
            <p className="mt-1 text-xs text-dim">
              {t("Mid-market rate")}{asOf ? ` · ${when(asOf)}` : ""}{source ? ` · ${source}` : ""}
            </p>
            {stale && <p className="mt-2 flex items-start gap-1.5 text-xs text-warn"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" />{t("Could not refresh the rate; showing the last one received.")}</p>}
          </>
        ) : (
          <p className="text-sm text-mute">{t("The exchange rate is not available right now, so only dollars are shown.")}</p>
        )}
      </div>
      <p className="mt-2 px-0.5 text-2xs leading-relaxed text-dim">{t("Costs are billed in US dollars. Rupees are an estimate at this rate, refreshed every 15 minutes.")}</p>
    </>
  );
}
