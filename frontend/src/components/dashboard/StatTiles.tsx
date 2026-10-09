import { Activity, ArrowRight } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { secs, usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useProjectDashboard, type EpisodeDashboard } from "../../lib/v3";
import { Meter, Metric, Panel, Skeleton, Sparkline } from "../ui";

/** A cell of the strip: hairlines come from the grid's gap, so any column count draws clean dividers. */
function Cell({ children, spark, stroke = "var(--color-accent)" }: { children: ReactNode; spark?: number[]; stroke?: string }) {
  const t = useT();
  return (
    <div className="min-w-0 bg-panel p-4">
      {children}
      {spark && spark.length > 1 && (
        <div className="mt-3 flex items-center gap-2"><Sparkline data={spark} width={96} height={22} stroke={stroke} /><span className="text-2xs text-dim">{t("per episode")}</span></div>
      )}
    </div>
  );
}

/** Coverage as a segmented meter, capped at 24 cells so a long episode still reads. */
function Coverage({ value, total, tone }: { value: number; total: number; tone: "ok" | "accent" | "info" }) {
  if (total <= 0) return null;
  const n = Math.min(total, 24);
  return <Meter className="mt-3" filled={Math.min(n, Math.round((value / total) * n))} total={n} tone={tone} />;
}

/** The KPI strip: eight readouts in one panel. Sparklines only where the project has a real series (one point per episode). */
export function StatTiles({ d, pid, canProduce, index }: { d: EpisodeDashboard; pid: number; canProduce: boolean; index?: number }) {
  const t = useT();
  const { data: proj } = useProjectDashboard(pid);
  const series = useMemo(() => {
    const eps = proj?.episodes ?? [];
    return {
      approved: eps.length >= 2 ? eps.map((e) => e.footage.approved_s) : undefined,
      perSecond: eps.filter((e) => e.spend.per_approved_second !== null).length >= 2 ? eps.filter((e) => e.spend.per_approved_second !== null).map((e) => e.spend.per_approved_second as number) : undefined,
    };
  }, [proj]);

  const planned = d.footage.planned_s || 0;
  const allDone = d.shots.total > 0 && d.shots.approved === d.shots.total;
  const footageDone = planned > 0 && d.footage.approved_s >= planned;
  const stale = d.footage.stale_takes;
  const jobs = d.queue.active_jobs;
  const approvals = d.queue.pending_approvals;
  const perSecond = d.spend.per_approved_second;

  return (
    <Panel index={index} eyebrow={t("Telemetry")} icon={<Activity />} flush bodyClassName="overflow-hidden rounded-b-xl"
      actions={<span className="mono text-2xs text-dim">{t("{n} shots in this episode", { n: d.shots.total })}</span>}>
      <div className="mt-3.5 grid grid-cols-2 gap-px border-t border-line bg-line @2xl:grid-cols-4 @7xl:grid-cols-8">
        <Cell>
          <Metric label={t("Approved shots")} size="sm" value={d.shots.approved} unit={`/ ${d.shots.total}`} tone={allDone ? "ok" : "neutral"}
            sub={d.shots.in_review ? <span className="text-info">{t("{n} in review", { n: d.shots.in_review })}</span> : d.shots.total ? t("{p}% of all shots", { p: Math.round((d.shots.approved / d.shots.total) * 100) }) : t("nothing to approve yet")} />
          <Coverage value={d.shots.approved} total={d.shots.total} tone="ok" />
        </Cell>
        <Cell spark={series.approved}>
          <Metric label={t("Approved footage")} size="sm" value={d.footage.approved_s} format={secs} tone={footageDone ? "ok" : "neutral"}
            sub={planned ? t("of {s} planned", { s: secs(planned) }) : t("nothing planned yet")} />
          <Coverage value={d.footage.approved_s} total={planned} tone="accent" />
        </Cell>
        <Cell>
          <Metric label={t("Generated")} size="sm" value={d.footage.generated_s} format={secs}
            sub={d.footage.rejected_takes ? t("{n} takes rejected", { n: d.footage.rejected_takes }) : t("every video take, kept or not")} />
        </Cell>
        <Cell>
          <Metric label={t("Regen rate")} size="sm" value={d.footage.regeneration_rate * 100} format={(n) => `${Math.round(n)}%`} tone={d.footage.regeneration_rate > 0.5 ? "warn" : "neutral"}
            sub={t("extra video takes per shot with video")} />
        </Cell>
        <Cell>
          <Metric label={t("Stale takes")} size="sm" value={stale} tone={stale ? "warn" : "ok"}
            sub={stale ? (
              <button type="button" onClick={() => document.getElementById("mission-impact")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="inline-flex items-center gap-1 rounded text-warn underline-offset-2 hover:underline">{t("Review impact")}<ArrowRight className="size-3" /></button>
            ) : t("every take matches its shot")} />
        </Cell>
        <Cell>
          <Metric label={t("Active jobs")} size="sm" value={jobs} tone={jobs ? "accent" : "neutral"}
            sub={<><span className={jobs ? "eq" : "eq is-idle"} aria-hidden><i /><i /><i /><i /></span>{jobs ? t("queued or running") : t("queue is clear")}</>} />
        </Cell>
        <Cell>
          <Metric label={t("Approvals")} size="sm" value={approvals} tone={approvals ? "warn" : "neutral"}
            sub={approvals && canProduce ? (
              <Link to="/approvals" className="inline-flex items-center gap-1 rounded text-warn underline-offset-2 hover:underline">{t("Open approvals")}<ArrowRight className="size-3" /></Link>
            ) : approvals ? t("waiting for a producer") : t("nothing waiting")} />
        </Cell>
        <Cell spark={series.perSecond} stroke="var(--color-money)">
          <Metric label={t("Cost / second")} size="sm" tone="money" value={perSecond === null ? "—" : usd(perSecond)} unit={perSecond === null ? undefined : "/s"}
            sub={t("spend ÷ approved seconds")} />
        </Cell>
      </div>
    </Panel>
  );
}

export function StatTilesSkeleton() {
  return (
    <Panel eyebrow="···" flush bodyClassName="overflow-hidden rounded-b-xl">
      <div className="mt-3.5 grid grid-cols-2 gap-px border-t border-line bg-line @2xl:grid-cols-4 @7xl:grid-cols-8" aria-busy="true">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="bg-panel p-4"><Skeleton className="h-2.5 w-20" /><Skeleton className="mt-3 h-6 w-16" /><Skeleton className="mt-2.5 h-2.5 w-28" /></div>
        ))}
      </div>
    </Panel>
  );
}
