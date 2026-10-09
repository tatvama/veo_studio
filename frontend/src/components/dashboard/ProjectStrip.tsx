import { FolderKanban } from "lucide-react";
import { cn } from "../../lib/cn";
import { secs, usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useProjectDashboard } from "../../lib/v3";
import { LoadError } from "../room/kit";
import { Panel, ProgressRing, Skeleton } from "../ui";

/** The whole project at a glance: totals on top, then every episode with its approved/total shots and spend. Click one to switch to it. */
export function ProjectStrip({ pid, currentEid, onOpenEpisode, index, className }: {
  pid: number; currentEid: number; onOpenEpisode: (eid: number) => void; index?: number; className?: string;
}) {
  const t = useT();
  const { data, isLoading, isError, refetch } = useProjectDashboard(pid);
  const head = { index, className, eyebrow: t("Whole project"), icon: <FolderKanban /> };
  if (isError && !data) return <Panel {...head}><LoadError what={t("Couldn't load the project overview")} onRetry={() => refetch()} /></Panel>;
  if (isLoading || !data) return <Panel {...head}><div className="space-y-2" aria-busy="true">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div></Panel>;

  const total = data.shots.total;
  const cap = data.spend.budget_cap_usd;
  return (
    <Panel {...head}>
      <div className="@container"><dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line @sm:grid-cols-3">
        <Pair label={t("Shots")} value={`${data.shots.approved}/${total}`} />
        <Pair label={t("Approved")} value={secs(data.footage.approved_s)} />
        <Pair label={t("Spent")} money value={cap ? `${usd(data.spend.total_usd)} / ${usd(cap)}` : usd(data.spend.total_usd)} />
        {data.spend.per_approved_second !== null && <Pair label={t("Per second")} money value={usd(data.spend.per_approved_second)} />}
        {data.footage.stale_takes > 0 && <Pair label={t("Stale")} value={String(data.footage.stale_takes)} warn />}
        {data.queue.active_jobs > 0 && <Pair label={t("Jobs")} value={String(data.queue.active_jobs)} accent />}
      </dl></div>

      {!data.episodes.length ? <p className="mt-3 text-xs text-dim">{t("No episodes yet.")}</p> : (
        <ul className="mt-3 max-h-[22rem] space-y-1.5 overflow-y-auto pr-0.5" aria-label={t("Episodes")}>
          {data.episodes.map((e) => {
            const on = e.episode_id === currentEid;
            const ratio = e.shots.total ? e.shots.approved / e.shots.total : 0;
            const done = e.shots.total > 0 && e.shots.approved === e.shots.total;
            return (
              <li key={e.episode_id}>
                <button type="button" onClick={() => onOpenEpisode(e.episode_id)} aria-current={on ? "true" : undefined} title={t("Switch to this episode")}
                  className={cn("flex w-full items-center gap-3 rounded-lg border p-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50",
                    on ? "border-accent/50 bg-accent/8" : "border-line hover:border-dim/60 hover:bg-hover")}>
                  <ProgressRing value={ratio} size={36} stroke={3.5} tone={done ? "var(--color-ok)" : "var(--color-accent)"}>
                    <span className="mono text-2xs">{e.shots.total ? `${e.shots.approved}/${e.shots.total}` : "—"}</span>
                  </ProgressRing>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" title={e.title}><span className="mono text-accent-ink">E{String(e.number).padStart(2, "0")}</span> {e.title || t("Untitled")}</span>
                    <span className="mono block truncate text-2xs text-dim">
                      {secs(e.footage.approved_s)} {t("approved")}{e.footage.stale_takes ? <span className="text-warn"> · {t("{n} stale", { n: e.footage.stale_takes })}</span> : null}
                    </span>
                  </span>
                  <span className="mono shrink-0 text-xs text-money">{usd(e.spend.total_usd)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function Pair({ label, value, warn, money, accent }: { label: string; value: string; warn?: boolean; money?: boolean; accent?: boolean }) {
  return (
    <div className="min-w-0 bg-panel px-3 py-2">
      <dt className="eyebrow truncate">{label}</dt>
      <dd className={cn("mono mt-1.5 truncate text-sm font-medium", warn ? "text-warn" : money ? "text-money" : accent ? "text-accent-ink" : "text-ink")}>{value}</dd>
    </div>
  );
}
