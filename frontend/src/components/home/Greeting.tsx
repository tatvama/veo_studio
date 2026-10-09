import { clsx } from "clsx";
import { Plus } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useT } from "../../lib/i18n";
import { useJobs } from "../../lib/queries";
import type { UserBrief } from "../../lib/types";
import { useWorkload } from "../shell/telemetry";
import { Button, rise, Skeleton } from "../ui";
import { useAttention } from "./useAttention";
import { firstName, useClock, useNow } from "./util";

/** The top of the Command Center: time-of-day greeting, date and clock, and a one-line read of what is happening now. */
export function Greeting({ user, canCreate, onNew }: { user: UserBrief | null | undefined; canCreate: boolean; onNew: () => void }) {
  const t = useT();
  const now = useNow();
  const { date, time } = useClock(now);
  const jobsQ = useJobs(undefined, "active");
  const { running, waiting } = useWorkload();
  const att = useAttention();
  const r = rise(0);

  const h = now.getHours();
  const hello = h < 12 ? t("Good morning") : h < 17 ? t("Good afternoon") : t("Good evening");
  const name = firstName(user);
  const busy = running.length > 0;
  const loading = jobsQ.isLoading || att.loading;

  const parts: ReactNode[] = [];
  if (running.length) {
    parts.push(<span key="run" className="text-accent-ink">{running.length === 1 ? t("{n} job running", { n: 1 }) : t("{n} jobs running", { n: running.length })}</span>);
  }
  if (waiting.length) {
    parts.push(<span key="wait" className="text-ink">{waiting.length === 1 ? t("{n} job queued", { n: 1 }) : t("{n} jobs queued", { n: waiting.length })}</span>);
  }
  if (att.approvals.length) {
    const txt = att.approvals.length === 1 ? t("{n} approval waiting", { n: 1 }) : t("{n} approvals waiting", { n: att.approvals.length });
    parts.push(att.deciding > 0
      ? <Link key="apr" to="/approvals" className="text-warn underline-offset-2 hover:underline">{txt}</Link>
      : <span key="apr" className="text-warn">{txt}</span>);
  }

  return (
    <header style={r.style} className={clsx("mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-4", r.className)}>
      <div className="min-w-0 flex-1 basis-80">
        <p className="eyebrow flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="flex items-center gap-2 !text-accent-ink"><span aria-hidden className={clsx("live-dot", !busy && "is-idle")} />{t("Command center")}</span>
          <span aria-hidden className="text-line">/</span>
          <span className="num">{date}</span>
          <span aria-hidden className="text-line">/</span>
          <span className="num">{time}</span>
        </p>
        <h1 className="mt-2.5 text-balance text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
          {hello}{name && <>, <span className="text-gradient">{name}</span></>}
        </h1>
        <div className="mt-1.5 min-h-5 text-sm text-mute" aria-live="polite">
          {loading ? <Skeleton className="mt-1 h-3.5 w-64 max-w-full" /> : parts.length ? (
            <p>{parts.map((p, i) => <Fragment key={i}>{i > 0 && ", "}{p}</Fragment>)}.</p>
          ) : (
            <p>{t("All systems idle")}.{canCreate && <> {t("Ready when you are.")}</>}</p>
          )}
        </div>
      </div>
      {canCreate && (
        <Button variant="outline" icon={<Plus className="size-4" />} onClick={onNew} className="shrink-0">{t("New production")}</Button>
      )}
    </header>
  );
}
