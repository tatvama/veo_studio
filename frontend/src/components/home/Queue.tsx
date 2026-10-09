import { clsx } from "clsx";
import { Hourglass, ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useJobs, useProjects } from "../../lib/queries";
import type { Job } from "../../lib/types";
import { useWorkload } from "../shell/telemetry";
import { Button, Panel, Progress, Skeleton, StatusDot, Tag } from "../ui";

const ORDER: Record<string, number> = { running: 0, queued: 1, awaiting_approval: 2, proposed: 3 };

function Row({ job, project }: { job: Job; project: string }) {
  const t = useT();
  const running = job.status === "running";
  const label: Record<string, string> = { running: t("running"), queued: t("queued"), awaiting_approval: t("awaiting approval"), proposed: t("proposed") };
  const to = job.project_id ? `/p/${job.project_id}/${job.shot_id ? "storyboard" : "activity"}` : undefined;
  const body = (
    <>
      <span className="flex items-center gap-2">
        {running ? <StatusDot tone="accent" live /> : job.status === "awaiting_approval" ? <ShieldAlert className="size-3.5 shrink-0 text-warn" aria-hidden /> : <Hourglass className="size-3.5 shrink-0 text-dim" aria-hidden />}
        <span className="min-w-0 flex-1 truncate text-sm">{job.label || job.type.replace(/_/g, " ")}</span>
        <span className={clsx("mono shrink-0 text-2xs", running ? "text-accent-ink" : job.status === "awaiting_approval" ? "text-warn" : "text-dim")}>
          {running ? `${Math.round((job.progress || 0) * 100)}%` : label[job.status] ?? job.status}
        </span>
      </span>
      {running && <Progress value={job.progress} indeterminate={!job.progress} size="sm" className="mt-1.5" />}
      <span className="mt-1 flex items-center gap-2 text-2xs text-dim">
        <span className="min-w-0 flex-1 truncate">{project}{running && job.message ? ` · ${job.message}` : ""}</span>
        {job.cost_estimate > 0 && <span className="mono shrink-0 text-money">{usd(job.cost_estimate)}</span>}
      </span>
    </>
  );
  const cls = "block px-4 py-2.5 outline-none transition-colors focus-visible:bg-hover/60";
  return to
    ? <Link to={to} className={clsx(cls, "hover:bg-hover/60")}>{body}</Link>
    : <div className={cls}>{body}</div>;
}

/** Everything running or waiting across every project, as a compact queue with progress bars. */
export function LiveQueue({ index, className }: { index?: number; className?: string }) {
  const t = useT();
  const jobsQ = useJobs(undefined, "active");
  const { jobs, running, waiting } = useWorkload();
  const activeQ = useProjects(false);
  const archivedQ = useProjects(true);
  const titles = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of [...(archivedQ.data ?? []), ...(activeQ.data ?? [])]) m.set(p.id, p.title);
    return m;
  }, [activeQ.data, archivedQ.data]);
  const rows = useMemo(
    () => [...jobs].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || b.id - a.id).slice(0, 40),
    [jobs],
  );
  const busy = running.length > 0;

  return (
    <Panel index={index} className={className} flush tone={busy ? "accent" : undefined}
      eyebrow={t("Live queue")}
      icon={<span aria-hidden className={clsx("eq", !busy && "is-idle")}><i /><i /><i /><i /></span>}
      actions={<><Tag k={t("running")} tone={busy ? "accent" : "neutral"}>{running.length}</Tag><Tag k={t("queued")}>{waiting.length}</Tag></>}>
      <div className="pt-2.5">
        {jobsQ.isLoading ? (
          <div aria-busy="true" className="space-y-3 px-4 pb-4 pt-1">
            {[0, 1, 2].map((i) => <div key={i} className="space-y-1.5"><Skeleton className="h-3.5 w-4/5" /><Skeleton className="h-1.5 w-full rounded-full" /></div>)}
          </div>
        ) : jobsQ.isError ? (
          <div className="flex items-center justify-between gap-3 px-4 pb-4 pt-1 text-sm text-mute">
            <span>{t("Couldn't load the queue")}</span>
            <Button size="sm" variant="outline" onClick={() => void jobsQ.refetch()}>{t("Try again")}</Button>
          </div>
        ) : !rows.length ? (
          <div className="flex items-center gap-3 px-4 pb-4 pt-1">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised/60"><span aria-hidden className="eq is-idle"><i /><i /><i /><i /></span></span>
            <p className="min-w-0 text-xs leading-relaxed text-mute"><span className="block text-sm text-ink">{t("Nothing is running.")}</span>{t("Generations you start appear here.")}</p>
          </div>
        ) : (
          <div className="max-h-72 divide-y divide-line overflow-y-auto border-t border-line">
            {rows.map((j) => <Row key={j.id} job={j} project={j.project_id ? titles.get(j.project_id) ?? t("Project #{n}", { n: j.project_id }) : t("Shared library")} />)}
          </div>
        )}
      </div>
    </Panel>
  );
}
