import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Activity, Coins, PiggyBank, RefreshCw, Sliders, TrendingUp, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, AnimatedNumber, Badge, Button, Metric, Page, PageHeader, Panel, ProgressRing, Segmented, Skeleton, rise } from "../../components/ui";
import { api } from "../../lib/api";
import { usd } from "../../lib/format";
import { useT, useUiLanguage } from "../../lib/i18n";
import { useAuthStatus, useCosts, useProjects, useUsers } from "../../lib/queries";
import "../../styles/admin.css";
import "../../styles/console.css";
import { PeoplePanel, ProjectsPanel, ServicesPanel } from "./money/Breakdown";
import { BudgetMeter, budgetState } from "./money/Gauge";
import { Ledger } from "./money/Ledger";
import { SpendChart } from "./money/SpendChart";
import {
  addDays, costPerVideoSecond, dailySeries, groupServices, localDay, money, type CostSummary, type LedgerRow,
} from "./money/data";
import { Pill } from "./shared/Pill";

const LEDGER_LIMIT = 200;

/* ── loading ────────────────────────────────────────────────────────────────── */

function CostsSkeleton() {
  return (
    <Page width="wide">
      <div className="mb-6 flex items-center gap-3"><Skeleton className="size-10 rounded-lg" /><div className="space-y-2"><Skeleton className="h-6 w-32" /><Skeleton className="h-3.5 w-80 max-w-[60vw]" /></div></div>
      <div aria-busy="true" className="grid gap-4">
        <Skeleton className="h-24 rounded-xl" />
        <div className="grid gap-4 lg:grid-cols-12">
          <Skeleton className="h-72 rounded-xl lg:col-span-5" />
          <Skeleton className="h-72 rounded-xl lg:col-span-7" />
        </div>
        <div className="grid gap-4 lg:grid-cols-12">
          <Skeleton className="h-80 rounded-xl lg:col-span-7" />
          <Skeleton className="h-80 rounded-xl lg:col-span-5" />
        </div>
        <Skeleton className="h-96 rounded-xl" />
      </div>
    </Page>
  );
}

/* ── page ───────────────────────────────────────────────────────────────────── */

export default function CostsPage() {
  const t = useT();
  const uiLang = useUiLanguage();
  const { data: auth } = useAuthStatus();
  const me = auth?.user ?? null;
  const { data: raw, isLoading, isError, refetch } = useCosts();
  const summary = raw as CostSummary | undefined;
  const { data: ledger, isLoading: ledgerLoading, isError: ledgerError, refetch: refetchLedger } = useQuery({
    queryKey: ["costs", "ledger"],
    queryFn: () => api.get<LedgerRow[]>(`/api/costs/ledger?limit=${LEDGER_LIMIT}`),
  });
  const { data: projects } = useProjects();
  const { data: users } = useUsers();
  const [modePick, setModePick] = useState<"daily" | "cumulative" | null>(null);

  const projectTitle = useMemo(() => Object.fromEntries((projects ?? []).map((p) => [p.id, p.title])) as Record<number, string>, [projects]);
  const userName = useMemo(() => Object.fromEntries((users ?? []).map((u) => [u.id, u.name || u.email.split("@")[0]])) as Record<number, string>, [users]);

  const loc = uiLang === "en" ? "en" : `${uiLang}-IN`;
  const monthName = (() => {
    try { return new Date().toLocaleString(loc, { month: "long" }); } catch { return new Date().toLocaleString("en", { month: "long" }); }
  })();
  const monthYear = (() => {
    try { return new Date().toLocaleString(loc, { month: "long", year: "numeric" }); } catch { return monthName; }
  })();

  // spend grouped per service (the API reports one row per service + type)
  const services = useMemo(() => groupServices(summary?.by_provider), [summary]);

  // the daily series comes from the loaded ledger rows (the latest charges), clipped to this month
  const series = useMemo(() => {
    const rows = ledger ?? [];
    const now = new Date();
    const today = localDay(now.getTime());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const truncated = rows.length >= LEDGER_LIMIT;
    let from = monthStart;
    if (truncated) {
      const times = rows.map((r) => Date.parse(r.created_at)).filter((x) => Number.isFinite(x));
      if (times.length) {
        const oldest = localDay(Math.min(...times));
        // the oldest day is only partly loaded: start the day after it
        if (oldest >= monthStart) from = Math.min(today, addDays(oldest, 1));
      }
    }
    return { days: dailySeries(rows, from, today), from, monthStart, monthDays, truncated, today };
  }, [ledger]);

  const perSecond = useMemo(() => costPerVideoSecond(ledger ?? []), [ledger]);

  if (isError && !summary) {
    return (
      <Page width="wide">
        <PageHeader icon={<Coins className="size-5" />} title={t("Costs")} subtitle={t("What the team has spent on AI services in {month}. Totals reset on the 1st of each month.", { month: monthName })} />
        <Alert tone="bad" title={t("Couldn't load the costs")} action={<Button size="sm" variant="outline" icon={<RefreshCw className="size-3.5" />} onClick={() => void refetch()}>{t("Try again")}</Button>}>
          {t("Check your connection and try again.")}
        </Alert>
      </Page>
    );
  }
  if (isLoading || !summary) return <CostsSkeleton />;

  const { team, mine } = summary;
  const total = team.spent_usd;
  const byProject = [...summary.by_project].sort((a, b) => b.usd - a.usd);
  const byUser = [...summary.by_user].sort((a, b) => b.usd - a.usd);
  const mineLimit = mine.limit_usd;
  const minePct = mineLimit ? mine.spent_usd / mineLimit : 0;
  const cap = team.cap_usd;
  const pct = cap > 0 ? (team.spent_usd / cap) * 100 : 0;
  const state = budgetState(pct);
  const StateIcon = state.icon;
  const fillVar = state.tone === "bad" ? "var(--color-bad)" : state.tone === "warn" ? "var(--color-warn)" : "var(--color-accent)";
  const allMock = !!ledger?.length && ledger.every((r) => r.mock);
  const isAdmin = me?.role === "admin";

  const now = new Date();
  const day = now.getDate();
  const daysInMonth = series.monthDays;
  const projected = team.spent_usd > 0 ? (team.spent_usd / day) * daysInMonth : 0;
  const overPace = cap > 0 && projected > cap;

  // series for the sparklines and the chart
  const days = series.days;
  const todayPoint = days[days.length - 1];
  const loadedSum = days.reduce((n, d) => n + d.usd, 0);
  const base = series.truncated && series.from > series.monthStart ? Math.max(0, team.spent_usd - loadedSum) : 0;
  const dailySpark = days.slice(-14).map((d) => d.usd);
  const cumSpark = (() => { let run = base; return days.map((d) => (run += d.usd)); })().slice(-14);

  const mode = modePick ?? (cap > 0 ? "cumulative" : "daily");
  const peak = days.reduce((m, d) => (d.usd > m.usd ? d : m), days[0] ?? { day: series.today, usd: 0, count: 0 });
  const dayLabel = (ms: number) => new Date(ms).toLocaleDateString(loc, { day: "numeric", month: "short" });
  const summaryText = [
    mode === "daily"
      ? t("Spend per day in {month}. {usd} in the days shown; the busiest day was {day} at {peak}.", { month: monthName, usd: money(loadedSum), day: dayLabel(peak.day), peak: money(peak.usd) })
      : cap > 0
        ? t("Running spend in {month}: {usd} so far, against a cap of {cap}.", { month: monthName, usd: money(team.spent_usd), cap: usd(cap) })
        : t("Running spend in {month}: {usd} so far.", { month: monthName, usd: money(team.spent_usd) }),
    series.truncated ? t("Drawn from the latest {n} charges.", { n: LEDGER_LIMIT }) : "",
  ].filter(Boolean).join(" ");

  const a1 = rise(1);
  let r = 1;

  return (
    <Page width="wide">
      <PageHeader
        icon={<Coins className="size-5" />}
        title={t("Costs")}
        subtitle={t("What the team has spent on AI services in {month}. Totals reset on the 1st of each month.", { month: monthName })}
        actions={<>
          <Badge className="mono h-7 px-2.5 text-xs">{monthYear}</Badge>
          {isAdmin && <Link to="/settings#budget"><Button variant="outline" size="sm" icon={<Sliders className="size-3.5" />}>{t("Budget settings")}</Button></Link>}
        </>}
      />

      {allMock && (
        <div className={clsx("mb-4", a1.className)} style={a1.style}>
          <Alert tone="info" title={t("Nothing has been charged yet")}>
            {t("Every charge so far came from mock providers (free placeholders), so the totals are $0.00.")}{" "}
            {isAdmin && <Link to="/settings#keys" className="font-medium text-ink underline decoration-accent/60 underline-offset-2 hover:decoration-accent">{t("Add real API keys")}</Link>}
          </Alert>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4">
        {/* KPI strip */}
        <Panel flush index={r++} bodyClassName="rounded-xl">
          <div className="ad-kpis">
            <Metric label={t("Today")} tone="money" value={todayPoint?.usd ?? 0} format={(n) => money(n)} spark={dailySpark.length > 1 ? dailySpark : undefined}
              sub={t("{n} charges", { n: (todayPoint?.count ?? 0).toLocaleString() })} />
            <Metric label={t("This month")} tone="money" value={team.spent_usd} format={(n) => money(n)} spark={cumSpark.length > 1 ? cumSpark : undefined}
              sub={cap > 0 ? t("of {cap}", { cap: usd(cap) }) : t("no cap set")} />
            {cap > 0 ? (
              <Metric label={t("Budget left")} tone={state.tone === "ok" ? "money" : state.tone} value={Math.max(0, team.remaining_usd ?? 0)} format={(n) => money(n)}
                sub={<span className="ad-state" data-tone={state.tone}><StateIcon aria-hidden />{t(state.word)}</span>} />
            ) : (
              <Metric label={t("Budget left")} value="—" sub={t("No cap set")} />
            )}
            <Metric label={t("Reserved")} tone="money" value={team.reserved_usd} format={(n) => money(n)} sub={t("queued or running")} />
            <Metric label={t("Month-end pace")} tone={overPace ? "warn" : "money"} value={projected} format={(n) => money(n)}
              sub={projected > 0 ? (overPace ? <span className="ad-state" data-tone="warn"><TrendingUp aria-hidden />{t("over the cap")}</span> : t("at this pace")) : t("not enough data yet")} />
            <Metric label={t("Per video second")} tone="money" value={perSecond === null ? "—" : perSecond} format={(n) => money(n)} sub={t("paid video, latest charges")} />
          </div>
        </Panel>

        {/* budget + trend */}
        <div className="@container min-w-0">
          <div className="grid grid-cols-1 gap-4 @min-[900px]:grid-cols-12">
            <Panel index={r++} className="@min-[900px]:col-span-5" icon={<PiggyBank />} eyebrow={t("Budget")} title={t("Team budget")} tone={cap > 0 ? state.tone : undefined}
              actions={cap > 0 ? <Pill tone={state.tone}><StateIcon aria-hidden />{t(state.word)}</Pill> : <Pill>{t("No cap set")}</Pill>}>
              {cap > 0 ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
                    <div>
                      <p className="mono text-4xl font-medium leading-none tracking-tight"><AnimatedNumber value={Math.round(pct)} format={(n) => `${Math.round(n)}%`} /></p>
                      <p className="mt-1.5 text-xs text-mute">{t("used")}</p>
                    </div>
                    <div className="text-right">
                      <p className="mono text-xl font-medium leading-none text-money"><AnimatedNumber value={team.spent_usd} format={(n) => usd(n)} /></p>
                      <p className="mono mt-1.5 text-2xs text-dim">{t("of {cap} this month", { cap: usd(cap) })}</p>
                    </div>
                  </div>
                  <BudgetMeter spent={team.spent_usd} reserved={team.reserved_usd} cap={cap} tone={state.tone}
                    label={t("{n}% of the team budget used", { n: Math.round(pct) })} />
                  <dl className="grid grid-cols-3 gap-3">
                    <div>
                      <dt className="flex items-center gap-1.5 text-xs text-mute"><span aria-hidden className="size-2 rounded-[2px]" style={{ background: fillVar }} />{t("Spent")}</dt>
                      <dd className="mono mt-1 text-sm font-medium text-money">{usd(team.spent_usd)}</dd>
                    </div>
                    <div title={t("Money set aside for jobs that are queued, running or waiting for approval")}>
                      <dt className="flex items-center gap-1.5 text-xs text-mute"><span aria-hidden className="size-2 rounded-[2px] opacity-40" style={{ background: fillVar }} />{t("Reserved")}</dt>
                      <dd className="mono mt-1 text-sm font-medium text-money">{usd(team.reserved_usd)}</dd>
                    </div>
                    <div>
                      <dt className="flex items-center gap-1.5 text-xs text-mute"><span aria-hidden className="size-2 rounded-[2px] bg-line" />{t("Left")}</dt>
                      <dd className={clsx("mono mt-1 text-sm font-medium", (team.remaining_usd ?? 0) <= 0 ? "text-bad" : "text-money")}>{usd(team.remaining_usd)}</dd>
                    </div>
                  </dl>
                  {projected > 0 && (
                    <p className={clsx("flex items-start gap-1.5 text-xs", projected > cap ? "ad-tx font-medium" : "text-mute")} data-tone="warn">
                      <TrendingUp className="mt-px size-3.5 shrink-0" aria-hidden />
                      <span>
                        {projected > cap
                          ? t("At this pace the month ends around {usd} — over the cap.", { usd: usd(projected) })
                          : t("At this pace the month ends around {usd}.", { usd: usd(projected) })}
                      </span>
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <p className="mono text-4xl font-medium leading-none tracking-tight text-money"><AnimatedNumber value={team.spent_usd} format={(n) => usd(n)} /></p>
                    <p className="mt-1.5 text-sm text-mute">{t("spent this month")}{team.reserved_usd > 0 ? ` · ${t("{usd} reserved for running jobs", { usd: usd(team.reserved_usd) })}` : ""}</p>
                  </div>
                  <div className="cx-block px-3 py-2.5 text-sm text-mute">
                    <p>{t("No team cap is set.")}</p>
                    {isAdmin && <Link to="/settings#budget" className="font-medium text-accent-ink hover:underline">{t("Set one in Settings")}</Link>}
                  </div>
                </div>
              )}

              {/* my spending */}
              <div className="cx-block mt-4 flex items-center gap-3 p-3" data-tone={mineLimit != null && minePct >= 1 ? "bad" : undefined}>
                {mineLimit != null && mineLimit > 0 ? (
                  <ProgressRing value={minePct} size={44} stroke={4} tone={minePct >= 1 ? "var(--color-bad)" : minePct >= 0.8 ? "var(--color-warn)" : "var(--color-accent)"}>
                    <span className="mono">{Math.round(minePct * 100)}%</span>
                  </ProgressRing>
                ) : (
                  <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-raised text-mute"><Wallet className="size-5" aria-hidden /></span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="eyebrow">{t("My spending")}</p>
                  <p className="mono mt-1.5 text-base font-medium leading-none text-money">
                    <AnimatedNumber value={mine.spent_usd} format={(n) => usd(n)} />
                    <span className="ml-1.5 text-xs font-normal text-dim">{mineLimit != null ? t("of {limit}", { limit: usd(mineLimit) }) : t("this month")}</span>
                  </p>
                  <p className={clsx("mt-1.5 text-xs", mineLimit != null && minePct >= 0.8 ? "ad-tx font-medium" : "text-mute")} data-tone={minePct >= 1 ? "bad" : "warn"}>
                    {mineLimit != null && mineLimit > 0
                      ? (minePct >= 1
                        ? t("You've reached your limit. New work will ask a producer for approval.")
                        : t("{usd} left this month.", { usd: usd(Math.max(0, mineLimit - mine.spent_usd)) }))
                      : t("You don't have a personal monthly limit. The team cap still applies.")}
                  </p>
                </div>
              </div>
            </Panel>

            <Panel index={r++} className="@min-[900px]:col-span-7" icon={<Activity />} eyebrow={t("Trend")} title={t("Spend over time")}
              actions={(
                <Segmented size="sm" value={mode} onChange={setModePick} aria-label={t("Chart type")} options={[
                  { value: "daily", label: t("Per day") }, { value: "cumulative", label: t("Running total") },
                ]} />
              )}>
              {ledgerLoading ? (
                <Skeleton className="h-56 w-full" />
              ) : ledgerError && !(ledger ?? []).length ? (
                <div className="flex h-56 flex-col items-center justify-center gap-3 text-center">
                  <p className="text-sm text-mute">{t("Couldn't load the charges")}</p>
                  <Button size="sm" variant="outline" icon={<RefreshCw className="size-3.5" />} onClick={() => void refetchLedger()}>{t("Try again")}</Button>
                </div>
              ) : !(ledger ?? []).length ? (
                <div className="grid h-56 place-items-center text-center text-sm text-dim">{t("Nothing spent yet this month.")}</div>
              ) : (
                <>
                  <SpendChart days={days} monthStart={series.monthStart} monthDays={series.monthDays} mode={mode} cap={cap > 0 ? cap : undefined}
                    base={base} projected={projected > 0 ? projected : undefined} summary={summaryText} />
                  {series.truncated && <p className="mt-2 text-2xs text-dim">{t("Drawn from the latest {n} charges.", { n: LEDGER_LIMIT })}</p>}
                </>
              )}
            </Panel>
          </div>
        </div>

        {/* breakdowns */}
        <div className="@container min-w-0">
          <div className="grid grid-cols-1 gap-4 @min-[900px]:grid-cols-12">
            <ServicesPanel services={services} total={total} index={r++} className="@min-[900px]:col-span-7" />
            <div className="grid min-w-0 grid-cols-1 content-start gap-4 @min-[900px]:col-span-5">
              <ProjectsPanel rows={byProject} total={total} index={r++} />
              <PeoplePanel rows={byUser} total={total} meId={me?.id} index={r++} />
            </div>
          </div>
        </div>

        {/* ledger */}
        <Ledger rows={ledger} loading={ledgerLoading} error={ledgerError} onRetry={() => void refetchLedger()} projectTitle={projectTitle} userName={userName} index={r++} />
      </div>
    </Page>
  );
}
