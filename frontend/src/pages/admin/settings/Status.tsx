import { Check, Lock } from "lucide-react";
import { Link } from "react-router-dom";
import "../../../styles/console.css";
import "../../../styles/settings.css";
import { AnimatedNumber, Metric, Panel, Progress } from "../../../components/ui";
import { usd } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import type { ProviderStatus, TeamStatus } from "../../../lib/types";

/** What the saved key list says (admins only): how many services have a key and where the key lives. */
export interface KeyStats { loading: boolean; present: number; total: number; saved: number; env: number }

/**
 * The system strip at the top of the console: engines live vs placeholder, keys present, this month's spend, unsaved changes.
 * Every cell is a mono KPI; cells reflow from four across to two on phones.
 */
export function StatusStrip({ providers, keys, team, changeCount, dirtySections, errorCount, isAdmin }: {
  providers: ProviderStatus[]; keys: KeyStats | null; team: TeamStatus; changeCount: number; dirtySections: number; errorCount: number; isAdmin: boolean;
}) {
  const t = useT();
  // keys that run no generation themselves (the BytePlus asset library) are not engines
  const engines = providers.filter((p) => p.engine !== false);
  const total = engines.length;
  const live = engines.filter((p) => p.mode === "live").length;
  const mock = engines.filter((p) => p.mode === "mock").length;
  const missing = engines.filter((p) => p.mode === "missing").length;
  const enginesTone = total === 0 ? "neutral" : live === total ? "ok" : missing > 0 && live === 0 ? "bad" : "warn";
  const enginesSub = total === 0
    ? t("No services reported")
    : live === total
    ? t("All engines live")
    : [mock > 0 && t("{n} placeholder", { n: mock }), missing > 0 && t("{n} no key", { n: missing })].filter(Boolean).join(" · ");
  const capPct = team.cap_usd ? Math.round((team.spent_usd / team.cap_usd) * 100) : 0;
  const unsavedTone = errorCount > 0 ? "bad" : changeCount > 0 ? "warn" : "ok";

  return (
    <div role="group" aria-label={t("System status")}>
      <Panel flush index={1}>
        <div className="cx-kpis max-sm:grid-cols-2 max-sm:[&>*:last-child:nth-child(odd)]:col-span-2">
          <Metric size="sm" label={t("Engines")} value={`${live}/${total}`} tone={enginesTone}
            sub={<><span aria-hidden className={live === total && total > 0 ? "live-dot" : "live-dot is-warn"} /><span className="mono">{enginesSub}</span></>} />

          {isAdmin && keys && (
            <Metric size="sm" label={t("API keys")} value={keys.loading ? "—" : `${keys.present}/${keys.total}`}
              tone={keys.loading ? "neutral" : keys.present === keys.total ? "ok" : "warn"}
              sub={keys.loading ? t("Checking…") : <span className="mono">{t("{a} saved here · {b} from .env", { a: keys.saved, b: keys.env })}</span>} />
          )}

          <Metric size="sm" label={t("This month")} value={team.spent_usd} format={(n) => usd(n)} tone="money"
            sub={team.cap_usd ? <><span className="mono">{capPct}%</span>{t("of {cap} cap", { cap: usd(team.cap_usd) })}</> : t("No cap set")} />

          {isAdmin ? (
            <Metric size="sm" label={t("Unsaved changes")} value={changeCount} tone={unsavedTone}
              sub={errorCount > 0
                ? <span className="mono">{t("{n} need fixing", { n: errorCount })}</span>
                : changeCount > 0
                  ? <><span aria-hidden className="live-dot is-warn" /><span className="mono">{dirtySections === 1 ? t("In 1 section") : t("In {n} sections", { n: dirtySections })}</span></>
                  : <><Check aria-hidden className="size-3 text-ok" />{t("All changes saved")}</>} />
          ) : (
            <Metric size="sm" label={t("Access")} value={t("Read-only")} tone="info"
              sub={<><Lock aria-hidden className="size-3" />{t("Only admins can change these")}</>} />
          )}
        </div>
      </Panel>
    </div>
  );
}

/** Spend instrument for the Budget section: this month's spend against the cap, with a tick for every alert level that is set. */
export function SpendGauge({ spent, cap, reserved, thresholds }: { spent: number; cap: number; reserved: number; thresholds: number[] | null }) {
  const t = useT();
  const pct = cap ? (spent / cap) * 100 : 0;
  const tone = pct >= 100 ? "bad" : pct >= 80 ? "warn" : "accent";
  const ticks = (thresholds ?? []).filter((n) => n > 0 && n <= 100);
  return (
    <div className="cx-block mb-5 p-4" data-tone="money">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="eyebrow">{t("This month")}</p>
          <p className="mono mt-2 flex flex-wrap items-baseline gap-x-2 text-2xl font-medium leading-none tracking-tight text-money">
            <AnimatedNumber value={spent} format={(n) => usd(n)} />
            <span className="text-sm font-normal text-dim">{cap ? t("spent of {cap}", { cap: usd(cap) }) : t("spent")}</span>
          </p>
        </div>
        <Link to="/costs" className="-my-2 py-2 text-xs font-medium text-accent-ink hover:underline">{t("See all costs")} →</Link>
      </div>
      <div className="relative mt-4" style={{ paddingBottom: ticks.length ? "1.25rem" : 0 }}>
        <Progress value={cap ? spent / cap : 0} size="lg" tone={tone} />
        {ticks.map((n) => (
          <span key={n} aria-hidden className="absolute top-0 h-2.5 w-px bg-ink/45" style={{ left: `${n}%` }}>
            <span className="mono absolute left-0 top-3.5 -translate-x-1/2 text-2xs text-dim">{n}%</span>
          </span>
        ))}
      </div>
      <p className="mt-2 text-xs text-dim">{t("{usd} reserved for running jobs", { usd: usd(reserved) })}</p>
    </div>
  );
}
