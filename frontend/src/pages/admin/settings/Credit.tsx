import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Info, RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { agoT } from "../../../components/growth/common";
import { Button, Skeleton, Tooltip } from "../../../components/ui";
import { api } from "../../../lib/api";
import { usd } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useProviderCredit } from "../../../lib/queries";
import type { ProviderCredit } from "../../../lib/types";
import { brandName } from "../shared/brands";

/** Providers whose balance the studio can read (the server's credit.METERED). */
export const METERED = ["openrouter", "byteplus"];

/** "14:30", with the date as well when it isn't today. */
function untilText(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = d.toDateString() === new Date().toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/** Why a balance is unknown, in plain words: the provider's own message, or what the key can't show. */
function unknownWhy(c: ProviderCredit | undefined, t: ReturnType<typeof useT>): string {
  if (c?.error) return c.error;
  if (c?.provider === "openrouter" && c.checked_at) {
    return t("A normal OpenRouter key can only show its own spending limit, and this key has none. The account's credit needs a management key.");
  }
  return c?.checked_at ? t("The provider didn't report a balance.") : t("Not checked yet.");
}

/**
 * Balance strip under an OpenRouter / BytePlus row: what is left, when it was read, and whether the router is skipping the
 * provider for lack of credit. Admins can read the balances again (after a top-up), which also lifts the skip.
 */
export function CreditLine({ provider, isAdmin }: { provider: string; isAdmin: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading, isError, isFetching, refetch } = useProviderCredit();
  const [busy, setBusy] = useState(false);
  const c = data?.providers.find((p) => p.provider === provider);
  // a normal OpenRouter key reports only what its own spending limit still allows, not the account's credit
  const keyLimitOnly = provider === "openrouter" && c?.usd != null && c.detail?.credits_usd == null && c.detail?.limit_usd != null;

  const recheck = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ providers: ProviderCredit[] }>("/api/providers/credit/refresh");
      qc.setQueryData(["provider-credit"], res);
      await qc.invalidateQueries({ queryKey: ["provider-credit"] });
      const still = res.providers.find((p) => p.provider === provider);
      if (still?.held) toast.warning(t("{name} still has no credit", { name: brandName(provider) }), { description: t("Jobs keep using other routes until it is topped up.") });
      else toast.success(t("Balances checked again"));
    } catch {
      /* already toasted */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cx-block mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="eyebrow">{t("Balance")}</span>
        {isLoading ? <Skeleton className="h-4 w-20 self-center" /> : isError && !data ? (
          <span className="text-xs text-mute">
            {t("Couldn't read the balance.")}{" "}
            <button type="button" className="font-medium text-accent-ink hover:underline disabled:opacity-50" disabled={isFetching} onClick={() => void refetch()}>{t("Try again")}</button>
          </span>
        ) : c?.usd != null ? (
          <>
            <span className={clsx("mono text-sm font-medium", c.usd <= 0 ? "text-red-300" : "text-money")}>{usd(c.usd)}</span>
            {keyLimitOnly && <span className="text-2xs text-dim">{t("left on this key's spending limit")}</span>}
          </>
        ) : (
          <Tooltip content={<>{unknownWhy(c, t)} {t("Work is never stopped because a balance is unknown.")}</>}>
            <span tabIndex={0} className="inline-flex cursor-help items-center gap-1 rounded text-xs text-mute outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
              {t("Balance unknown")}<Info aria-hidden className="size-3 text-dim" />
            </span>
          </Tooltip>
        )}
        {c?.checked_at && <span className="mono text-2xs text-dim">{t("checked {ago}", { ago: agoT(c.checked_at) })}</span>}
      </div>
      {isAdmin && (
        <Button size="sm" variant="ghost" className="max-sm:h-10" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={() => void recheck()}>
          {t("Re-check balance")}
        </Button>
      )}
      {c?.held && (
        <p title={c.hold_reason || undefined} className="flex w-full items-start gap-1.5 text-xs text-amber-300">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {c.hold_until ? t("Skipped: no credit until {time}.", { time: untilText(c.hold_until) }) : t("Skipped: no credit.")}{" "}
            <span className="text-mute">{t("Jobs use another route meanwhile. Top up, then re-check the balance.")}</span>
          </span>
        </p>
      )}
    </div>
  );
}
