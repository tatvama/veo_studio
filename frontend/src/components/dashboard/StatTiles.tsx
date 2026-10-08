import { Check, Clapperboard, CheckCircle2, Clock3, Cpu, Eye, Film, History, ListTodo, RefreshCw, ShieldAlert } from "lucide-react";
import { secs } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { EpisodeDashboard } from "../../lib/v3";
import { AnimatedNumber, ProgressRing, Skeleton, Stat } from "../ui";

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** The KPI row of the episode dashboard: shots, footage, regeneration, stale takes and the queue. */
export function StatTiles({ d }: { d: EpisodeDashboard }) {
  const t = useT();
  const planned = d.footage.planned_s || 0;
  const ratio = planned > 0 ? Math.min(1, d.footage.approved_s / planned) : 0;
  const allDone = d.shots.total > 0 && d.shots.approved === d.shots.total;
  return (
    <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,11.5rem),1fr))]">
      <Stat index={0} icon={<Clapperboard className="size-4" />} label={t("Shots")} value={d.shots.total}
        sub={d.shots.generating ? t("{n} generating now", { n: d.shots.generating }) : t("in this episode")} />
      <Stat index={1} icon={<CheckCircle2 className="size-4" />} label={t("Approved")} value={d.shots.approved} tone={allDone ? "ok" : "neutral"}
        sub={d.shots.total ? t("{p} of all shots", { p: pct(d.shots.approved / d.shots.total) }) : t("nothing to approve yet")} />
      <Stat index={2} icon={<Eye className="size-4" />} label={t("In review")} value={d.shots.in_review} tone={d.shots.in_review ? "info" : "neutral"} sub={t("video ready, waiting for a decision")} />
      <Stat index={3} icon={<ListTodo className="size-4" />} label={t("Remaining")} value={d.shots.remaining} tone={d.shots.remaining ? "warn" : "ok"} sub={t("no video yet")} />

      <Stat index={4} icon={<Film className="size-4" />} label={t("Approved footage")} value={secs(d.footage.approved_s)} tone={allDone ? "ok" : "accent"}
        sub={planned ? t("of {s} planned", { s: secs(planned) }) : t("nothing planned yet")}>
        <div className="mt-3 flex items-center gap-3">
          <ProgressRing value={ratio} size={40} stroke={4} tone={allDone ? "var(--color-ok)" : "var(--color-accent)"}>
            {allDone ? <Check className="size-3.5 text-ok" strokeWidth={3} /> : <AnimatedNumber value={ratio * 100} format={(n) => `${Math.round(n)}`} duration={0.6} />}
          </ProgressRing>
          <span className="text-xs text-mute">{t("{p} of the planned running time is approved", { p: pct(ratio) })}</span>
        </div>
      </Stat>
      <Stat index={5} icon={<Cpu className="size-4" />} label={t("Generated footage")} value={secs(d.footage.generated_s)}
        sub={d.footage.rejected_takes ? t("{n} takes rejected", { n: d.footage.rejected_takes }) : t("every video take, kept or not")} />
      <Stat index={6} icon={<RefreshCw className="size-4" />} label={t("Regeneration rate")} value={d.footage.regeneration_rate} format={(n) => `${Math.round(n * 100)}%`}
        tone={d.footage.regeneration_rate > 0.5 ? "warn" : "neutral"} sub={t("extra video takes per shot with video")} />
      <Stat index={7} icon={<History className="size-4" />} label={t("Stale takes")} value={d.footage.stale_takes} tone={d.footage.stale_takes ? "warn" : "ok"}
        sub={d.footage.stale_takes ? t("the shot changed after they were made") : t("everything matches its shot")} />

      <Stat index={8} icon={<Clock3 className="size-4" />} label={t("Active jobs")} value={d.queue.active_jobs} tone={d.queue.active_jobs ? "info" : "neutral"} sub={t("queued or running")} />
      <Stat index={9} icon={<ShieldAlert className="size-4" />} label={t("Pending approvals")} value={d.queue.pending_approvals} tone={d.queue.pending_approvals ? "warn" : "neutral"} sub={t("spend waiting for a producer")} />
      <Stat index={10} icon={<Film className="size-4" />} label={t("Renders in queue")} value={d.queue.renders} tone={d.queue.renders ? "info" : "neutral"} sub={t("exports and animatics")} />
    </div>
  );
}

export function StatTilesSkeleton() {
  return (
    <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,11.5rem),1fr))]" aria-busy="true">
      {Array.from({ length: 11 }, (_, i) => (
        <div key={i} className="rounded-xl border border-line bg-panel p-4">
          <div className="flex items-center gap-2"><Skeleton className="size-7" /><Skeleton className="h-3 w-20" /></div>
          <Skeleton className="mt-3 h-7 w-16" /><Skeleton className="mt-2 h-2.5 w-28" />
        </div>
      ))}
    </div>
  );
}
