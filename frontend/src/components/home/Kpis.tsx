import "../../styles/home.css";
import { clsx } from "clsx";
import { ArrowUpRight } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useJobs, useProjects, useSettings } from "../../lib/queries";
import { useWorkload } from "../shell/telemetry";
import { Meter, Metric, Panel, Progress, ProgressRing, Skeleton } from "../ui";
import { useAttention } from "./useAttention";
import { meterCells, useProjectStats } from "./stats";
import { weeklyCounts } from "./util";

/** How many of the most recently updated productions feed the "shots approved" figure. */
const SHOT_SCOPE = 16;

/** One cell of the strip. With `to` the whole cell is a link (a hairline highlight and an arrow appear on hover). */
function Kpi({ to, children, className }: { to?: string; children: ReactNode; className?: string }) {
  const cls = clsx("group/k relative -m-2 block min-w-0 rounded-lg p-2 outline-none", className);
  if (!to) return <div className={cls}>{children}</div>;
  return (
    <Link to={to} className={clsx(cls, "transition-colors hover:bg-hover/40 focus-visible:ring-2 focus-visible:ring-accent/50")}>
      {children}
      <ArrowUpRight aria-hidden className="absolute right-2 top-2 size-3.5 text-dim opacity-0 transition-opacity group-hover/k:opacity-100 group-focus-visible/k:opacity-100" />
    </Link>
  );
}

function KpiSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="min-w-0">
      <p className="eyebrow truncate">{label}</p>
      <Skeleton className="mt-2.5 h-[1.65rem] w-24" />
      <Skeleton className="mt-2.5 h-3 w-28" />
    </div>
  );
}

/** Four equalizer bars, taller than the telemetry ones so they read as a number's companion. */
function Eq({ active }: { active: boolean }) {
  return <span aria-hidden className={clsx("eq", !active && "is-idle")} style={{ height: 20, gap: 3 }}><i style={{ width: 3 }} /><i style={{ width: 3 }} /><i style={{ width: 3 }} /><i style={{ width: 3 }} /></span>;
}

/** The five numbers that matter, in one instrument strip over a faint drifting colour band. */
export function Kpis({ canDecide }: { canDecide: boolean }) {
  const t = useT();
  const projectsQ = useProjects(false);
  const settingsQ = useSettings();
  const jobsQ = useJobs(undefined, "active");
  const { running, waiting, progress } = useWorkload();
  const att = useAttention();

  const projects = projectsQ.data;
  const recentIds = useMemo(
    () => [...(projects ?? [])].sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at)).slice(0, SHOT_SCOPE).map((p) => p.id),
    [projects],
  );
  const stats = useProjectStats(recentIds);
  const generating = useMemo(
    () => new Set([...running, ...waiting].filter((j) => j.status === "running" || j.status === "queued").map((j) => j.project_id).filter((x): x is number => !!x)).size,
    [running, waiting],
  );
  const spark = useMemo(() => weeklyCounts((projects ?? []).map((p) => p.created_at)), [projects]);

  const busy = running.length > 0;
  const team = settingsQ.data?.team;
  const capped = !!team && team.cap_usd > 0;
  const pct = team && capped ? Math.min(team.spent_usd / team.cap_usd, 1) : 0;
  const ring = pct >= 1 ? "var(--color-bad)" : pct >= 0.8 ? "var(--color-warn)" : "var(--color-money)";

  const shotsLoading = projectsQ.isLoading || (recentIds.length > 0 && stats.loaded === 0 && stats.pending > 0);
  const { cells, filled } = meterCells(stats.total, stats.approved);
  const shotPct = stats.total ? Math.round((stats.approved / stats.total) * 100) : 0;
  const partial = (projects?.length ?? 0) > SHOT_SCOPE;

  return (
    <Panel index={1} className="isolate" eyebrow={t("Mission overview")}
      actions={<span className="eyebrow flex items-center gap-2"><span aria-hidden className={clsx("live-dot", !busy && "is-idle")} />{busy ? t("live") : t("idle")}</span>}>
      <div aria-hidden className="cc-ground -z-10 rounded-xl" />
      <div className="@container relative">
        <div className="grid grid-cols-6 gap-x-6 gap-y-6 @5xl:grid-cols-5 @5xl:gap-x-0">
          {/* 1 · productions */}
          <div className="col-span-3 min-w-0 @max-md:[&_svg]:hidden @2xl:col-span-2 @5xl:col-span-1 @5xl:pr-5">
            {projectsQ.isLoading ? <KpiSkeleton label={t("Active productions")} /> : (
              <Kpi>
                <Metric label={t("Active productions")} value={projectsQ.isError ? "—" : (projects?.length ?? 0)} spark={projects && projects.length > 0 ? spark : undefined}
                  sub={generating > 0 ? t("{n} generating now", { n: generating }) : t("Nothing generating")} />
              </Kpi>
            )}
          </div>

          {/* 2 · shots approved */}
          <div className="col-span-3 min-w-0 @2xl:col-span-2 @5xl:col-span-1 @5xl:border-l @5xl:border-line @5xl:px-5" title={partial ? t("Across the {n} most recently updated productions", { n: SHOT_SCOPE }) : undefined}>
            {shotsLoading ? <KpiSkeleton label={t("Shots approved")} /> : (
              <Kpi>
                <Metric label={t("Shots approved")} value={stats.approved} unit={<span className="mono">/ {stats.total}</span>}
                  sub={<><Meter filled={filled} total={cells} tone={stats.total > 0 && stats.approved === stats.total ? "ok" : "accent"} className="w-20" /><span className="mono">{shotPct}%</span></>} />
              </Kpi>
            )}
          </div>

          {/* 3 · jobs running */}
          <div className="col-span-3 min-w-0 @2xl:col-span-2 @5xl:col-span-1 @5xl:border-l @5xl:border-line @5xl:px-5">
            {jobsQ.isLoading ? <KpiSkeleton label={t("Jobs running")} /> : (
              <Kpi>
                <Metric label={t("Jobs running")} value={running.length} unit={<Eq active={busy} />}
                  sub={busy
                    ? <><Progress value={progress} size="sm" className="w-16" /><span className="mono">{waiting.length} {t("queued")}</span></>
                    : <span>{t("idle")}{waiting.length > 0 && <span className="mono"> · {waiting.length} {t("queued")}</span>}</span>} />
              </Kpi>
            )}
          </div>

          {/* 4 · team spend vs cap (a full row on phones, last) */}
          <div className="order-5 col-span-6 min-w-0 @2xl:order-none @2xl:col-span-3 @5xl:col-span-1 @5xl:border-l @5xl:border-line @5xl:px-5">
            {settingsQ.isLoading ? <KpiSkeleton label={t("Team spend")} /> : (
              <Kpi to="/costs">
                <div className="flex items-start justify-between gap-2">
                  {team ? (
                    <Metric label={t("Team spend")} tone="money" value={team.spent_usd} format={(n) => usd(n, n >= 10_000 ? 0 : 2)} className="flex-1"
                      sub={capped ? (pct >= 1
                        ? <span className="text-bad">{t("Cap reached")}</span>
                        : <><span className="mono text-money">{usd(team.remaining_usd ?? Math.max(team.cap_usd - team.spent_usd, 0), 0)}</span>{t("left")}<span aria-hidden>·</span><span className="mono text-money">{usd(team.cap_usd, 0)}</span>{t("cap")}</>)
                        : t("No monthly cap")} />
                  ) : <Metric label={t("Team spend")} value="—" className="flex-1" />}
                  {capped && <ProgressRing value={pct} size={40} stroke={3.5} tone={ring} className="shrink-0">{Math.round(pct * 100)}%</ProgressRing>}
                </div>
              </Kpi>
            )}
          </div>

          {/* 5 · approvals waiting */}
          <div className="order-4 col-span-3 min-w-0 @2xl:order-none @2xl:col-span-3 @5xl:col-span-1 @5xl:border-l @5xl:border-line @5xl:pl-5">
            {att.loading ? <KpiSkeleton label={t("Approvals waiting")} /> : (
              <Kpi to={canDecide ? "/approvals" : undefined}>
                <Metric label={t("Approvals waiting")} value={att.approvals.length} tone={att.approvals.length > 0 ? "warn" : "neutral"}
                  sub={att.approvals.length === 0 ? t("All clear") : att.deciding > 0 ? t("{n} need you", { n: att.deciding }) : t("Waiting on a producer")} />
              </Kpi>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}
