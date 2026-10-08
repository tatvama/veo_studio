import { clsx } from "clsx";
import { FolderKanban } from "lucide-react";
import { secs, usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useProjectDashboard } from "../../lib/v3";
import { LoadError, SectionCard } from "../room/kit";
import { ProgressRing, ScrollStrip, Skeleton } from "../ui";

/** Compact strip of every episode: approved/total shots and spend; the whole-project totals on the left. */
export function ProjectStrip({ pid, currentEid, onOpenEpisode, index }: { pid: number; currentEid: number; onOpenEpisode: (eid: number) => void; index?: number }) {
  const t = useT();
  const { data, isLoading, isError, refetch } = useProjectDashboard(pid);
  const head = { icon: <FolderKanban />, title: t("Whole project"), description: t("Every episode at a glance. Click one to switch to it.") };
  if (isError && !data) return <SectionCard index={index} {...head}><LoadError what={t("Couldn't load the project overview")} onRetry={() => refetch()} /></SectionCard>;
  if (isLoading || !data) return <SectionCard index={index} {...head}><div className="flex gap-2" aria-busy="true">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16 w-44 shrink-0" />)}</div></SectionCard>;

  const total = data.shots.total;
  const cap = data.spend.budget_cap_usd;
  return (
    <SectionCard index={index} {...head}
      actions={<dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-mute">
        <Pair label={t("Shots")} value={`${data.shots.approved}/${total}`} />
        <Pair label={t("Approved")} value={secs(data.footage.approved_s)} />
        <Pair label={t("Spent")} value={cap ? `${usd(data.spend.total_usd)} / ${usd(cap)}` : usd(data.spend.total_usd)} />
        {data.spend.per_approved_second !== null && <Pair label={t("Per second")} value={usd(data.spend.per_approved_second)} />}
        {data.footage.stale_takes > 0 && <Pair label={t("Stale")} value={String(data.footage.stale_takes)} warn />}
      </dl>}>
      {!data.episodes.length ? <p className="text-xs text-dim">{t("No episodes yet.")}</p> : (
        <ScrollStrip className="flex gap-2 pb-1" aria-label={t("Episodes")}>
          {data.episodes.map((e) => {
            const on = e.episode_id === currentEid;
            const ratio = e.shots.total ? e.shots.approved / e.shots.total : 0;
            const done = e.shots.total > 0 && e.shots.approved === e.shots.total;
            return (
              <button key={e.episode_id} type="button" onClick={() => onOpenEpisode(e.episode_id)} aria-current={on ? "true" : undefined}
                className={clsx("flex w-48 shrink-0 items-center gap-2.5 rounded-lg border p-2.5 text-left transition-colors",
                  on ? "border-accent/50 bg-accent/8" : "border-line hover:border-dim/60 hover:bg-hover")}>
                <ProgressRing value={ratio} size={34} stroke={3.5} tone={done ? "var(--color-ok)" : "var(--color-accent)"}>
                  <span className="text-2xs">{e.shots.total ? `${e.shots.approved}/${e.shots.total}` : "—"}</span>
                </ProgressRing>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium" title={e.title}><span className="font-mono text-dim">E{String(e.number).padStart(2, "0")}</span> {e.title || t("Untitled")}</span>
                  <span className="block text-2xs tabular-nums text-mute">{usd(e.spend.total_usd)} · {secs(e.footage.approved_s)}{e.footage.stale_takes ? ` · ${t("{n} stale", { n: e.footage.stale_takes })}` : ""}</span>
                </span>
              </button>
            );
          })}
        </ScrollStrip>
      )}
    </SectionCard>
  );
}

function Pair({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt>{label}</dt>
      <dd className={clsx("font-semibold tabular-nums", warn ? "text-amber-300" : "text-ink")}>{value}</dd>
    </div>
  );
}
