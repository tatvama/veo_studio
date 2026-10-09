import { AlertTriangle, Boxes, CheckCircle2, Clock, Coins, Gauge, RadioTower, RefreshCw, Sparkles } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { agoT } from "../../components/growth/common";
import { Button, Metric, Panel, Skeleton, StatusDot } from "../../components/ui";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import type { AIModel, ModelList } from "../../lib/types";
import { useEnabledEngines } from "./catalogData";
import { perSecond, rateText } from "./modelMeta";

import "../../styles/console.css";
import "../../styles/models.css";

const TONE = { live: "ok", mock: "warn", missing: "bad" } as const;

function Cell({ onClick, lit, children }: { onClick?: () => void; lit?: boolean; children: ReactNode }) {
  if (!onClick) return <div>{children}</div>;
  return <button type="button" onClick={onClick} data-lit={lit || undefined} className="hub-kpi-btn">{children}</button>;
}

/** Name of an engine with the price per second, for the "cheapest / fastest" cells. */
function pickName(m: AIModel | undefined) {
  return m ? m.display_name || m.endpoint : "";
}

/**
 * The catalog's KPI strip: how many engines there are and which are on, whether the providers behind them are live or
 * placeholders, and what the enabled ones cost. Cells that count catalog states double as shortcuts into the catalog.
 */
export default function HubKpis({ meta, error, onRetry, onShow }: { meta: ModelList | undefined; error: boolean; onRetry: () => void; onShow: (status: string) => void }) {
  const t = useT();
  const { data: settings } = useSettings();
  const enabledQ = useEnabledEngines();
  const counts = meta?.counts ?? {};
  const total = (counts.enabled ?? 0) + (counts.new ?? 0) + (counts.disabled ?? 0);
  const last = meta?.last_sync ?? {};
  const providers = settings?.providers ?? [];
  const live = providers.filter((p) => p.mode === "live").length;
  const mock = providers.filter((p) => p.mode === "mock").length;
  const missing = providers.filter((p) => p.mode === "missing").length;

  const econ = useMemo(() => {
    const priced = (enabledQ.data?.models ?? [])
      .map((m) => ({ m, v: perSecond(m).value }))
      .filter((x): x is { m: AIModel; v: number } => x.v != null && x.v > 0)
      .sort((a, b) => a.v - b.v);
    const draft = priced.find((x) => x.m.tier === "draft");
    return { cheapest: priced[0], fastest: draft, max: priced[priced.length - 1], n: priced.length };
  }, [enabledQ.data]);

  if (error && !meta) {
    return (
      <Panel className="mb-6" bodyClassName="flex flex-wrap items-center gap-3">
        <AlertTriangle className="size-4 shrink-0 text-bad" aria-hidden />
        <p className="min-w-0 flex-1 text-sm text-mute">{t("Couldn't load the catalog")}</p>
        <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={onRetry}>{t("Try again")}</Button>
      </Panel>
    );
  }
  if (!meta) {
    return (
      <Panel flush className="mb-6">
        <div className="hub-kpis-wrap" aria-busy>
          <div className="hub-kpis">{Array.from({ length: 6 }, (_, i) => <div key={i}><Skeleton className="mb-3 h-3 w-20" /><Skeleton className="h-7 w-16" /></div>)}</div>
        </div>
      </Panel>
    );
  }

  const econLoading = enabledQ.isLoading;
  return (
    <Panel flush className="mb-6" index={1}>
      <div className="hub-kpis-wrap">
        <div className="hub-kpis">
          <Cell onClick={() => onShow("")}>
            <Metric label={<span className="flex items-center gap-1.5"><Boxes className="size-3" aria-hidden />{t("In catalog")}</span>} value={total}
              sub={counts.retired ? t("{n} retired", { n: counts.retired }) : t("Across all providers")} />
          </Cell>
          <Cell onClick={() => onShow("enabled")}>
            <Metric tone="ok" label={<span className="flex items-center gap-1.5"><CheckCircle2 className="size-3" aria-hidden />{t("Enabled")}</span>} value={counts.enabled ?? 0}
              sub={counts.disabled ? t("{n} disabled", { n: counts.disabled }) : t("Ready to use")} />
          </Cell>
          <Cell onClick={() => onShow("new")} lit={!!counts.new}>
            <Metric tone={counts.new ? "accent" : "neutral"} label={<span className="flex items-center gap-1.5"><Sparkles className="size-3" aria-hidden />{t("New to review")}</span>} value={counts.new ?? 0}
              sub={counts.new ? t("{n} waiting for review", { n: counts.new }) : last.new_count ? t("{n} found in the last sync", { n: last.new_count }) : t("Nothing waiting")} />
          </Cell>
          <Cell>
            <Metric tone={providers.length && live === providers.length ? "ok" : mock || missing ? "warn" : "neutral"}
              label={<span className="flex items-center gap-1.5"><RadioTower className="size-3" aria-hidden />{t("Providers live")}</span>}
              value={providers.length ? `${live}/${providers.length}` : "—"}
              sub={!providers.length ? t("Not reported yet") : mock || missing
                ? [mock ? t("{n} placeholder", { n: mock }) : "", missing ? t("{n} no key", { n: missing }) : ""].filter(Boolean).join(" · ") : t("All connected")} />
          </Cell>
          <Cell>
            <Metric tone="money" label={<span className="flex items-center gap-1.5"><Coins className="size-3" aria-hidden />{t("Cheapest")}</span>}
              value={econLoading ? "…" : econ.cheapest ? rateText(econ.cheapest.v) : "—"} unit={econ.cheapest ? "/s" : undefined}
              sub={<span className="truncate" title={pickName(econ.cheapest?.m)}>{econ.cheapest ? pickName(econ.cheapest.m) : t("No priced engine enabled")}</span>} />
          </Cell>
          <Cell>
            <Metric tone="money" label={<span className="flex items-center gap-1.5"><Gauge className="size-3" aria-hidden />{t("Fastest")}</span>}
              value={econLoading ? "…" : econ.fastest ? rateText(econ.fastest.v) : "—"} unit={econ.fastest ? "/s" : undefined}
              sub={<span className="truncate" title={pickName(econ.fastest?.m)}>{econ.fastest ? pickName(econ.fastest.m) : t("No draft-tier engine enabled")}</span>} />
          </Cell>
        </div>
      </div>

      <div className="mono flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line px-4 py-2.5 text-2xs text-dim">
        {providers.length > 0 && (
          <ul aria-label={t("Providers")} className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {providers.map((p) => (
              <li key={p.provider} className="inline-flex items-center gap-1.5">
                <StatusDot tone={TONE[p.mode]} live={p.mode === "live"} />
                <span className="text-mute">{p.label}</span>
                <span className={cn("uppercase tracking-wider", p.mode === "live" ? "text-ok" : p.mode === "mock" ? "text-warn" : "text-bad")}>
                  {p.mode === "live" ? t("Live") : p.mode === "mock" ? t("Placeholder") : t("No API key")}
                </span>
              </li>
            ))}
          </ul>
        )}
        <span className="ml-auto inline-flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {econ.cheapest && econ.max && econ.n > 1 && (
            <span title={t("Enabled engines priced per second")}>{t("Cost range")} <span className="text-money">{rateText(econ.cheapest.v)} – {rateText(econ.max.v)}</span> /s</span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <Clock className="size-3" aria-hidden />{t("Last sync")} <span className="text-mute">{last.at ? agoT(last.at) : t("Never")}</span>
            {last.at && [last.total != null && t("{n} listed", { n: last.total }), last.priced != null && t("{n} priced", { n: last.priced })].filter(Boolean).map((s, i) => <span key={i}>· {s}</span>)}
          </span>
        </span>
      </div>
    </Panel>
  );
}
