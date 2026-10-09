import { CircleCheck, Clock3, Hourglass, Radio, ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import { cn } from "../../lib/cn";
import { usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useJobs } from "../../lib/queries";
import { useUI } from "../../lib/store";
import type { Job, Shot } from "../../lib/types";
import { LoadError } from "../room/kit";
import { Button, Panel, Progress, Skeleton } from "../ui";
import { jobName } from "./jobs";

const RANK: Record<string, number> = { running: 0, queued: 1, awaiting_approval: 2, proposed: 3 };
const MAX_ROWS = 6;

function Lead({ status }: { status: string }) {
  if (status === "running") return <span className="eq shrink-0" aria-hidden><i /><i /><i /><i /></span>;
  if (status === "awaiting_approval") return <ShieldAlert className="size-4 shrink-0 text-warn" aria-hidden />;
  if (status === "proposed") return <Hourglass className="size-4 shrink-0 text-dim" aria-hidden />;
  return <Clock3 className="size-4 shrink-0 text-info" aria-hidden />;
}

/** The jobs of this project that are running or waiting right now. */
export function LiveQueue({ pid, shots, index, className }: { pid: number; shots: Shot[]; index?: number; className?: string }) {
  const t = useT();
  const setTrayOpen = useUI((u) => u.setTrayOpen);
  const { data, isLoading, isError, refetch } = useJobs(pid);
  const code = useMemo(() => new Map(shots.map((s) => [s.id, s.code])), [shots]);
  const rows = useMemo(() => [...(data ?? [])].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || b.id - a.id), [data]);
  const running = rows.filter((j) => j.status === "running").length;
  const queued = rows.filter((j) => j.status === "queued").length;
  const waiting = rows.filter((j) => j.status === "awaiting_approval" || j.status === "proposed").length;
  const eyebrow = t("Live queue");
  const status = (s: string) => ({ running: t("running"), queued: t("queued"), awaiting_approval: t("awaiting approval"), proposed: t("proposed") } as Record<string, string>)[s] ?? s.replaceAll("_", " ");

  const tray = <Button size="sm" variant="ghost" onClick={() => setTrayOpen(true)}>{t("Job tray")}</Button>;

  if (isError && !data) return <Panel index={index} className={className} eyebrow={eyebrow} icon={<Radio />}><LoadError what={t("Couldn't load the queue")} onRetry={() => refetch()} /></Panel>;
  if (isLoading || !data) return <Panel index={index} className={className} eyebrow={eyebrow} icon={<Radio />}><div className="space-y-2" aria-busy="true"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div></Panel>;

  return (
    <Panel index={index} className={className} tone={running ? "accent" : undefined} eyebrow={eyebrow} icon={<Radio />} actions={tray}>
      {!rows.length ? (
        <div className="flex items-center gap-3 rounded-lg border border-dashed border-line px-3 py-3.5">
          <span className="eq is-idle" aria-hidden><i /><i /><i /><i /></span>
          <div className="min-w-0"><p className="flex items-center gap-1.5 text-sm font-medium"><CircleCheck className="size-4 text-ok" aria-hidden />{t("The queue is clear")}</p>
            <p className="mt-0.5 text-xs text-mute">{t("Jobs you start show up here while they run.")}</p></div>
        </div>
      ) : (
        <>
          <p className="mono mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs uppercase tracking-wider text-dim">
            {running > 0 && <span className="inline-flex items-center gap-1.5 text-accent-ink"><span className="live-dot" />{t("{n} running", { n: running })}</span>}
            {queued > 0 && <span>{t("{n} queued", { n: queued })}</span>}
            {waiting > 0 && <span className="text-warn">{t("{n} waiting", { n: waiting })}</span>}
          </p>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {rows.slice(0, MAX_ROWS).map((j) => <Row key={j.id} j={j} shotCode={j.shot_id ? code.get(j.shot_id) : undefined} status={status(j.status)} />)}
          </ul>
          {rows.length > MAX_ROWS && (
            <button type="button" onClick={() => setTrayOpen(true)} className="mono mt-2 text-2xs uppercase tracking-wider text-accent-ink hover:underline">
              {t("+{n} more in the job tray", { n: rows.length - MAX_ROWS })}
            </button>
          )}
        </>
      )}
    </Panel>
  );
}

function Row({ j, shotCode, status }: { j: Job; shotCode?: string; status: string }) {
  const live = j.status === "running";
  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <Lead status={j.status} />
        <p className="min-w-0 flex-1 truncate text-sm font-medium" title={j.label}>
          {jobName(j.type)}{shotCode && <span className="mono ml-1.5 text-2xs font-normal text-dim">{shotCode}</span>}
        </p>
        <span className={cn("mono shrink-0 text-2xs uppercase tracking-wider", live ? "text-accent-ink" : j.status === "awaiting_approval" ? "text-warn" : "text-dim")}>{status}</span>
        {j.cost_estimate > 0 && <span className="mono shrink-0 text-2xs text-money">{usd(j.cost_estimate)}</span>}
      </div>
      {live && <Progress className="mt-2" size="sm" value={j.progress} indeterminate={!(j.progress > 0)} />}
      {j.message && live && <p className="mt-1 truncate text-2xs text-dim" title={j.message}>{j.message}</p>}
    </li>
  );
}
