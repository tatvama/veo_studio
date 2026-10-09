import { clsx } from "clsx";
import { IndianRupee, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { useCurrency, type CurrencyMode } from "../../lib/currency";
import { useT } from "../../lib/i18n";
import { Popover, Segmented, Tooltip } from "../ui";
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

const chip = "flex h-8 items-center gap-2 rounded-lg border border-line bg-raised/60 px-2.5 text-xs outline-none transition-colors hover:border-accent/40 hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50";

/** The live USD to INR rate in the top bar. Opens the currency switch and the rate details. */
export function RateChip() {
  const t = useT();
  const inr = useCurrency((s) => s.inr);
  const asOf = useCurrency((s) => s.asOf);
  const source = useCurrency((s) => s.source);
  const stale = useCurrency((s) => s.stale);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Tooltip content={inr ? t("1 US dollar = {r} rupees", { r: inr.toFixed(2) }) : t("Currency")} side="bottom" disabled={open}>
        <button ref={ref} aria-label={t("Currency")} aria-expanded={open} onClick={() => setOpen((v) => !v)} className={clsx(chip, open && "border-accent/50 bg-hover")}>
          {stale ? <TriangleAlert className="size-3.5 text-warn" /> : inr ? <span className="live-dot" aria-hidden /> : <IndianRupee className="size-3.5 text-mute" />}
          <span className="mono hidden text-ink lg:inline">{inr ? <>$1<span className="text-dim"> = </span>₹{inr.toFixed(2)}</> : t("USD only")}</span>
        </button>
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="bottom-end" width={320} className="p-3">
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
      </Popover>
    </>
  );
}
