import { CheckCircle2, History, ShieldAlert, TriangleAlert, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useT } from "../../lib/i18n";
import { useJobs } from "../../lib/queries";
import { useUI } from "../../lib/store";
import type { Episode } from "../../lib/types";
import type { EpisodeDashboard } from "../../lib/v3";
import { FixList, useFixes } from "../../pages/project/FixList";
import { Button, Panel } from "../ui";
import { isQcFailedShot } from "./shotState";

/** How long a failed job counts as a problem here. */
const RECENT_MS = 24 * 60 * 60_000;

function Row({ icon, tone, text, action }: { icon: ReactNode; tone: "bad" | "warn"; text: string; action?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 first:pt-0 last:pb-0">
      <span className={tone === "bad" ? "text-bad" : "text-warn"}>{icon}</span>
      <span className="min-w-0 flex-1 text-sm">{text}</span>
      {action}
    </li>
  );
}

/**
 * What needs you, in one list: what the last run couldn't make and the shots' failed steps (each with its one-click fix:
 * retry, try another engine, make the voice, open the shot, or carry on), shots that failed the quality check, takes
 * out of date because their shot changed, spend waiting for a producer, and jobs that failed today. "No problems" when
 * there are none.
 */
export function ProblemsCard({ d, episode, pid, canProduce, onImpact, onMake, index, className }: {
  d: EpisodeDashboard | undefined; episode: Episode | undefined; pid: number; canProduce: boolean;
  /** Shows the out-of-date takes (the change-impact panel). */
  onImpact: () => void;
  /** Opens Make it for me (a run that stopped at the budget carries on from there). */
  onMake?: () => void; index?: number; className?: string;
}) {
  const t = useT();
  const nav = useNavigate();
  const setSelectedShot = useUI((s) => s.setSelectedShot);
  const setTrayOpen = useUI((s) => s.setTrayOpen);
  const fixes = useFixes();
  const { data: recent } = useJobs(pid, "");
  const failedJobs = (recent ?? []).filter((j) => j.status === "failed" && Date.now() - new Date(j.finished_at || j.created_at).getTime() < RECENT_MS).length;
  const qc = (episode?.shots ?? []).filter((s) => s.include && s.status !== "approved" && isQcFailedShot(s));
  const stale = d?.footage.stale_takes ?? 0;
  const approvals = canProduce ? d?.queue.pending_approvals ?? 0 : 0;
  const none = !fixes.length && !qc.length && !stale && !approvals && !failedJobs;
  return (
    <Panel index={index} className={className} tone={none ? "ok" : "warn"} eyebrow={t("Problems")} icon={none ? <CheckCircle2 /> : <TriangleAlert />}>
      {none ? (
        <p className="flex items-center gap-2 text-sm text-mute"><CheckCircle2 className="size-4 text-ok" />{t("No problems. Everything is on track.")}</p>
      ) : (
        <>
        {fixes.length > 0 && (
          <div className={(qc.length || stale || approvals || failedJobs) ? "mb-3 border-b border-line pb-3" : undefined}>
            <p className="mb-2 text-xs text-mute">{fixes.length === 1 ? t("1 thing didn't get made. Fix it in one click:") : t("{n} things didn't get made. Fix each in one click:", { n: fixes.length })}</p>
            <FixList items={fixes} limit={4} onContinue={onMake} />
          </div>
        )}
        <ul className="divide-y divide-line">
          {qc.length > 0 && (
            <Row icon={<XCircle className="size-4" />} tone="bad"
              text={qc.length === 1 ? t("{code} failed the quality check", { code: qc[0].code }) : t("{n} shots failed the quality check", { n: qc.length })}
              action={<Button size="sm" onClick={() => { setSelectedShot(qc[0].id); nav(`/p/${pid}/storyboard`); }}>{t("Open {code}", { code: qc[0].code })}</Button>} />
          )}
          {stale > 0 && (
            <Row icon={<History className="size-4" />} tone="warn"
              text={stale === 1 ? t("1 take is out of date: its shot changed") : t("{n} takes are out of date: their shots changed", { n: stale })}
              action={<Button size="sm" onClick={onImpact}>{t("See them")}</Button>} />
          )}
          {approvals > 0 && (
            <Row icon={<ShieldAlert className="size-4" />} tone="warn"
              text={approvals === 1 ? t("1 spend request is waiting for a producer") : t("{n} spend requests are waiting for a producer", { n: approvals })}
              action={<Button size="sm" onClick={() => nav("/approvals")}>{t("Open approvals")}</Button>} />
          )}
          {failedJobs > 0 && (
            <Row icon={<XCircle className="size-4" />} tone="bad"
              text={failedJobs === 1 ? t("1 job failed today") : t("{n} jobs failed today", { n: failedJobs })}
              action={<Button size="sm" onClick={() => setTrayOpen(true)}>{t("See why")}</Button>} />
          )}
        </ul>
        </>
      )}
    </Panel>
  );
}
