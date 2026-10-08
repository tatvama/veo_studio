import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { BarChart3, ChevronDown, Coins, FolderKanban, Gauge, PiggyBank, Sliders, TrendingUp, Users, Wallet } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Alert, AnimatedNumber, Badge, Button, Card, Empty, Page, PageHeader, Progress, Segmented, Skeleton, rise } from "../../components/ui";
import { api } from "../../lib/api";
import { usd } from "../../lib/format";
import { useT, useUiLanguage } from "../../lib/i18n";
import { useAuthStatus, useCosts, useProjects, useUsers } from "../../lib/queries";
import { BudgetGauge } from "./money/Gauge";
import { Ledger } from "./money/Ledger";
import { kindLabel, money, type CostSummary, type LedgerRow } from "./money/data";
import { SERIES, brandMark, brandName } from "./shared/brands";
import { MiniAvatar } from "./shared/MiniAvatar";

import { Pill } from "./shared/Pill";
/* ── small pieces ───────────────────────────────────────────────────────────── */

function CardTitle({ icon, title, actions }: { icon: ReactNode; title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><span className="text-mute">{icon}</span>{title}</h2>
      {actions}
    </div>
  );
}

/** One row of "name … value" with a share bar underneath. */
function ShareRow({ lead, value, share, tone = "bg-accent/75", index }: { lead: ReactNode; value: string; share: number; tone?: string; index: number }) {
  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3 text-sm">
        <div className="min-w-0 flex-1">{lead}</div>
        <span className="shrink-0 font-medium tabular-nums">{value}</span>
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-dim">{Math.round(share * 100)}%</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
        <motion.div className={clsx("h-full rounded-full", tone)} initial={{ width: 0 }} animate={{ width: `${Math.max(share, 0) * 100}%` }}
          transition={{ duration: 0.7, delay: 0.05 + index * 0.04, ease: [0.22, 1, 0.36, 1] }} />
      </div>
    </li>
  );
}

function CostsSkeleton() {
  return (
    <Page width="wide">
      <div className="mb-6 flex items-center gap-3"><Skeleton className="size-10 rounded-xl" /><div className="space-y-2"><Skeleton className="h-6 w-32" /><Skeleton className="h-3.5 w-80" /></div></div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-60 rounded-xl lg:col-span-2" />
        <Skeleton className="h-60 rounded-xl" />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Skeleton className="h-80 rounded-xl xl:col-span-3" />
        <div className="space-y-4 xl:col-span-2"><Skeleton className="h-36 rounded-xl" /><Skeleton className="h-36 rounded-xl" /></div>
      </div>
      <Skeleton className="mt-4 h-96 rounded-xl" />
    </Page>
  );
}

/* ── page ───────────────────────────────────────────────────────────────────── */

export default function CostsPage() {
  const t = useT();
  const uiLang = useUiLanguage();
  const { data: auth } = useAuthStatus();
  const me = auth?.user ?? null;
  const { data: raw, isLoading } = useCosts();
  const summary = raw as CostSummary | undefined;
  const { data: ledger, isLoading: ledgerLoading } = useQuery({
    queryKey: ["costs", "ledger"],
    queryFn: () => api.get<LedgerRow[]>("/api/costs/ledger?limit=200"),
  });
  const { data: projects } = useProjects();
  const { data: users } = useUsers();
  const [metricPick, setMetricPick] = useState<"spend" | "calls" | null>(null);
  const [openService, setOpenService] = useState<string | null>(null);

  const projectTitle = useMemo(() => Object.fromEntries((projects ?? []).map((p) => [p.id, p.title])) as Record<number, string>, [projects]);
  const userName = useMemo(() => Object.fromEntries((users ?? []).map((u) => [u.id, u.name || u.email.split("@")[0]])) as Record<number, string>, [users]);

  const monthName = (() => {
    try { return new Date().toLocaleString(uiLang === "en" ? "en" : `${uiLang}-IN`, { month: "long" }); } catch { return new Date().toLocaleString("en", { month: "long" }); }
  })();
  const monthYear = (() => {
    try { return new Date().toLocaleString(uiLang === "en" ? "en" : `${uiLang}-IN`, { month: "long", year: "numeric" }); } catch { return monthName; }
  })();

  // spend grouped per service (the API reports one row per service + type)
  const services = useMemo(() => {
    const map = new Map<string, { provider: string; usd: number; count: number; kinds: { kind: string; usd: number; count: number }[] }>();
    for (const r of summary?.by_provider ?? []) {
      const key = r.provider || "system";
      const s = map.get(key) ?? { provider: key, usd: 0, count: 0, kinds: [] };
      s.usd += r.usd; s.count += r.count;
      // every kind of text-writing call ("llm:script", "llm:hooks"…) shows as one "Writing" line
      const kind = r.kind.startsWith("llm:") ? "llm" : r.kind;
      const k = s.kinds.find((x) => x.kind === kind);
      if (k) { k.usd += r.usd; k.count += r.count; } else s.kinds.push({ kind, usd: r.usd, count: r.count });
      map.set(key, s);
    }
    const list = [...map.values()];
    list.forEach((s) => s.kinds.sort((a, b) => b.usd - a.usd || b.count - a.count));
    return list.sort((a, b) => b.usd - a.usd || b.count - a.count);
  }, [summary]);

  if (isLoading || !summary) return <CostsSkeleton />;

  const { team, mine } = summary;
  const total = team.spent_usd;
  const byProject = [...summary.by_project].sort((a, b) => b.usd - a.usd);
  const byUser = [...summary.by_user].sort((a, b) => b.usd - a.usd);
  const mineLimit = mine.limit_usd;
  const minePct = mineLimit ? mine.spent_usd / mineLimit : 0;
  const cap = team.cap_usd;
  const pct = cap > 0 ? (team.spent_usd / cap) * 100 : 0;
  const tone = pct >= 100 ? "bad" : pct >= 80 ? "warn" : "accent";
  const gaugeColor = tone === "bad" ? "var(--color-bad)" : tone === "warn" ? "var(--color-warn)" : "var(--color-accent)";
  const allMock = !!ledger?.length && ledger.every((r) => r.mock);
  const isAdmin = me?.role === "admin";

  const metric = metricPick ?? (total > 0 ? "spend" : "calls");
  const metricOf = (s: { usd: number; count: number }) => (metric === "spend" ? s.usd : s.count);
  const metricTotal = services.reduce((n, s) => n + metricOf(s), 0);
  const metricMax = Math.max(1, ...services.map(metricOf));
  const fmtMetric = (s: { usd: number; count: number }) => (metric === "spend" ? money(s.usd) : t("{n} calls", { n: s.count.toLocaleString() }));

  const now = new Date();
  const day = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projected = team.spent_usd > 0 ? (team.spent_usd / day) * daysInMonth : 0;

  const statusBadge = cap > 0
    ? pct >= 100 ? <Pill tone="bad" dot>{t("Over budget")}</Pill> : pct >= 80 ? <Pill tone="warn" dot>{t("Getting close")}</Pill> : <Pill tone="ok" dot>{t("On track")}</Pill>
    : <Badge>{t("No cap set")}</Badge>;

  return (
    <Page width="wide">
      <PageHeader
        icon={<Coins className="size-5" />}
        title={t("Costs")}
        subtitle={t("What the team has spent on AI services in {month}. Totals reset on the 1st of each month.", { month: monthName })}
        actions={<>
          <Badge className="h-7 px-2.5 text-xs">{monthYear}</Badge>
          {isAdmin && <Link to="/settings#budget"><Button variant="outline" size="sm" icon={<Sliders className="size-3.5" />}>{t("Budget settings")}</Button></Link>}
        </>}
      />

      {allMock && (
        <div {...rise(1)} className={clsx("mb-4", rise(1).className)}>
          <Alert tone="info" title={t("Nothing has been charged yet")}>
            {t("Every charge so far came from mock providers (free placeholders), so the totals are $0.00.")}{" "}
            {isAdmin && <Link to="/settings#keys" className="font-medium text-ink underline decoration-accent/60 underline-offset-2 hover:decoration-accent">{t("Add real API keys")}</Link>}
          </Alert>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Team budget */}
        <Card className={clsx("p-5 lg:col-span-2", rise(2).className)} style={rise(2).style}>
          <CardTitle icon={<PiggyBank className="size-4" />} title={t("Team budget")} actions={statusBadge} />
          {cap > 0 ? (
            <div className="flex flex-wrap items-center gap-x-8 gap-y-5">
              <BudgetGauge spent={team.spent_usd} reserved={team.reserved_usd} cap={cap} color={gaugeColor}
                label={t("{n}% of the team budget used", { n: Math.round(pct) })}>
                <span className="text-3xl font-semibold leading-none tracking-tight tabular-nums"><AnimatedNumber value={Math.round(pct)} format={(n) => `${Math.round(n)}%`} /></span>
                <span className="mt-1 text-xs text-mute">{t("used")}</span>
              </BudgetGauge>
              <div className="min-w-[220px] flex-1">
                <p className="text-4xl font-semibold leading-none tracking-tight tabular-nums"><AnimatedNumber value={team.spent_usd} format={(n) => usd(n)} /></p>
                <p className="mt-1.5 text-sm text-mute">{t("of {cap} this month", { cap: usd(cap) })}</p>
                <dl className="mt-5 grid grid-cols-3 gap-3">
                  <div>
                    <dt className="flex items-center gap-1.5 text-xs text-mute"><span className="size-2 rounded-full" style={{ background: gaugeColor }} />{t("Spent")}</dt>
                    <dd className="mt-0.5 text-sm font-semibold tabular-nums">{usd(team.spent_usd)}</dd>
                  </div>
                  <div title={t("Money set aside for jobs that are queued, running or waiting for approval")}>
                    <dt className="flex items-center gap-1.5 text-xs text-mute"><span className="size-2 rounded-full opacity-40" style={{ background: gaugeColor }} />{t("Reserved")}</dt>
                    <dd className="mt-0.5 text-sm font-semibold tabular-nums">{usd(team.reserved_usd)}</dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-1.5 text-xs text-mute"><span className="size-2 rounded-full bg-line" />{t("Left")}</dt>
                    <dd className={clsx("mt-0.5 text-sm font-semibold tabular-nums", (team.remaining_usd ?? 0) <= 0 && "text-red-300")}>{usd(team.remaining_usd)}</dd>
                  </div>
                </dl>
                {projected > 0 && (
                  <p className={clsx("mt-4 flex items-center gap-1.5 text-xs", projected > cap ? "text-amber-300" : "text-mute")}>
                    <TrendingUp className="size-3.5 shrink-0" />
                    {projected > cap
                      ? t("At this pace the month ends around {usd} — over the cap.", { usd: usd(projected) })
                      : t("At this pace the month ends around {usd}.", { usd: usd(projected) })}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-4xl font-semibold leading-none tracking-tight tabular-nums"><AnimatedNumber value={team.spent_usd} format={(n) => usd(n)} /></p>
                <p className="mt-1.5 text-sm text-mute">{t("spent this month")}{team.reserved_usd > 0 ? ` · ${t("{usd} reserved for running jobs", { usd: usd(team.reserved_usd) })}` : ""}</p>
              </div>
              <div className="max-w-xs text-sm text-mute">
                <p>{t("No team cap is set.")}</p>
                {isAdmin && <Link to="/settings#budget" className="font-medium text-accent-ink hover:underline">{t("Set one in Settings")}</Link>}
              </div>
            </div>
          )}
        </Card>

        {/* My spending */}
        <Card className={clsx("flex flex-col p-5", rise(3).className)} style={rise(3).style}>
          <CardTitle icon={<Wallet className="size-4" />} title={t("My spending")} />
          <p className="text-4xl font-semibold leading-none tracking-tight tabular-nums"><AnimatedNumber value={mine.spent_usd} format={(n) => usd(n)} /></p>
          <p className="mt-1.5 text-sm text-mute">{mineLimit != null ? t("of {limit}", { limit: usd(mineLimit) }) : t("this month")}</p>
          <div className="mt-auto pt-5">
            {mineLimit != null && mineLimit > 0 ? (
              <>
                <Progress value={minePct} size="lg" tone={minePct >= 1 ? "bad" : minePct >= 0.8 ? "warn" : "accent"} />
                <p className={clsx("mt-2 text-xs", minePct >= 1 ? "text-red-300" : minePct >= 0.8 ? "text-amber-300" : "text-mute")}>
                  {minePct >= 1
                    ? t("You've reached your limit. New work will ask a producer for approval.")
                    : t("{usd} left this month.", { usd: usd(Math.max(0, mineLimit - mine.spent_usd)) })}
                </p>
              </>
            ) : (
              <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-xs text-mute">{t("You don't have a personal monthly limit. The team cap still applies.")}</p>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        {/* Spend by service */}
        <Card className={clsx("p-5 xl:col-span-3", rise(4).className)} style={rise(4).style}>
          <CardTitle icon={<BarChart3 className="size-4" />} title={t("Spend by service")}
            actions={services.length > 0 ? (
              <Segmented value={metric} onChange={setMetricPick} aria-label={t("Measure")} options={[
                { value: "spend", label: t("Spend") }, { value: "calls", label: t("Calls") },
              ]} />
            ) : undefined} />
          {!services.length ? (
            <Empty icon={<Gauge className="size-7" />} title={t("Nothing spent yet this month.")} sub={t("Spending shows up here as soon as the team generates something.")} />
          ) : (
            <ul className="space-y-1">
              {services.map((s, i) => {
                const tonePick = SERIES[i % SERIES.length];
                const open = openService === s.provider;
                const share = metricTotal > 0 ? metricOf(s) / metricTotal : 0;
                return (
                  <li key={s.provider} className="rounded-xl transition-colors hover:bg-hover/40">
                    <button type="button" aria-expanded={open} onClick={() => setOpenService(open ? null : s.provider)}
                      className="block w-full rounded-xl px-2.5 py-2.5 text-left">
                      <div className="flex items-center gap-3">
                        <span aria-hidden className={clsx("grid size-8 shrink-0 place-items-center rounded-lg text-xs font-semibold uppercase", tonePick.soft)}>{brandMark(s.provider)}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{brandName(s.provider)}</p>
                          <p className="text-2xs text-dim">{metric === "spend" ? t("{n} calls", { n: s.count.toLocaleString() }) : money(s.usd)}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold tabular-nums">{fmtMetric(s)}</p>
                          <p className="text-2xs tabular-nums text-dim">{Math.round(share * 100)}%</p>
                        </div>
                        <ChevronDown className={clsx("size-4 shrink-0 text-dim transition-transform duration-200", open && "rotate-180")} />
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
                        <motion.div className={clsx("h-full rounded-full", tonePick.bar)} initial={{ width: 0 }} animate={{ width: `${(metricOf(s) / metricMax) * 100}%` }}
                          transition={{ duration: 0.75, delay: 0.1 + i * 0.05, ease: [0.22, 1, 0.36, 1] }} />
                      </div>
                    </button>
                    <AnimatePresence initial={false}>
                      {open && (
                        <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden px-2.5">
                          <div className="mb-2.5 ml-11 space-y-1.5 border-l border-line pl-3.5 pt-0.5">
                            {s.kinds.map((k) => {
                              const v = metric === "spend" ? k.usd : k.count;
                              const mx = Math.max(1, ...s.kinds.map((x) => (metric === "spend" ? x.usd : x.count)));
                              return (
                                <li key={k.kind} className="flex items-center gap-3 text-xs">
                                  <span className="w-32 shrink-0 truncate text-mute">{k.kind === "llm" ? t("Writing") : kindLabel(k.kind)}</span>
                                  <span className="h-1 flex-1 overflow-hidden rounded-full bg-line"><span className={clsx("block h-full rounded-full opacity-70", tonePick.bar)} style={{ width: `${(v / mx) * 100}%` }} /></span>
                                  <span className="w-20 shrink-0 text-right tabular-nums text-ink">{metric === "spend" ? money(k.usd) : t("{n} calls", { n: k.count.toLocaleString() })}</span>
                                </li>
                              );
                            })}
                          </div>
                        </motion.ul>
                      )}
                    </AnimatePresence>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="space-y-4 xl:col-span-2">
          {/* By project */}
          <Card className={clsx("p-5", rise(5).className)} style={rise(5).style}>
            <CardTitle icon={<FolderKanban className="size-4" />} title={t("By project")} />
            {!byProject.length ? <p className="py-6 text-center text-sm text-dim">{t("Nothing spent yet this month.")}</p> : (
              <ul className="divide-y divide-line">
                {byProject.map((r, i) => (
                  <ShareRow key={r.project_id ?? "none"} index={i} value={money(r.usd)} share={total > 0 ? r.usd / total : 0}
                    lead={r.project_id ? (
                      <Link to={`/p/${r.project_id}/storyboard`} className="-my-1 block truncate py-1 font-medium hover:text-accent-ink hover:underline">{r.title}</Link>
                    ) : <span className="block truncate text-mute">{t("Not in a project (library, previews)")}</span>} />
                ))}
              </ul>
            )}
          </Card>

          {/* By person */}
          <Card className={clsx("p-5", rise(6).className)} style={rise(6).style}>
            <CardTitle icon={<Users className="size-4" />} title={t("By person")} />
            {!byUser.length ? <p className="py-6 text-center text-sm text-dim">{t("Nothing spent yet this month.")}</p> : (
              <ul className="divide-y divide-line">
                {byUser.map((r, i) => (
                  <ShareRow key={r.user?.id ?? `sys-${i}`} index={i} value={money(r.usd)} share={total > 0 ? r.usd / total : 0} tone="bg-info/75"
                    lead={r.user ? (
                      <span className="flex min-w-0 items-center gap-2">
                        <MiniAvatar name={r.user.name || r.user.email} size={26} />
                        <span className="truncate font-medium">{r.user.name}</span>
                        {r.user.id === me?.id && <span className="shrink-0 text-xs text-dim">{t("(you)")}</span>}
                      </span>
                    ) : <span className="text-mute">{t("Automatic (system)")}</span>} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {/* Ledger */}
      <section className={clsx("mt-8", rise(7).className)} style={rise(7).style}>
        <div className="mb-3">
          <h2 className="text-base font-semibold tracking-tight">{t("Every charge")}</h2>
          <p className="mt-0.5 text-sm text-mute">{t("The latest 200 charges, newest first.")}</p>
        </div>
        <Ledger rows={ledger} loading={ledgerLoading} projectTitle={projectTitle} userName={userName} />
      </section>
    </Page>
  );
}
