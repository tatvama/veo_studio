import { clsx } from "clsx";
import { CheckCircle2, CircleAlert, Info, ScanSearch, TriangleAlert, Wrench } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { ago } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ContinuityReport } from "../../lib/types";
import { Badge, Button, Segmented } from "../ui";
import { PanelHead, RoomEmpty, SectionCard } from "./kit";
import { useContinuityCheck } from "./util";

type Sev = "high" | "medium" | "low";
const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
const SEV_STYLE: Record<Sev, { bar: string; badge: "bad" | "warn" | "info"; label: string; icon: ReactNode }> = {
  high: { bar: "bg-bad", badge: "bad", label: "High", icon: <CircleAlert className="size-3" /> },
  medium: { bar: "bg-warn", badge: "warn", label: "Medium", icon: <TriangleAlert className="size-3" /> },
  low: { bar: "bg-info", badge: "info", label: "Low", icon: <Info className="size-3" /> },
};
const sevOf = (s: string): Sev => (s?.toLowerCase() in SEV_STYLE ? (s.toLowerCase() as Sev) : "medium");

/**
 * Continuity report with severity colours and a severity filter. Shared by the Story page (inside the writers' room tabs,
 * `bare`) and the Scenes page (a card in the side column, `compact`).
 */
export function ContinuityPanel({ eid, report, canRun, hint, className, compact, bare, index }: {
  eid: number; report: Partial<ContinuityReport> | undefined; canRun: boolean; hint?: string; className?: string; compact?: boolean; bare?: boolean; index?: number;
}) {
  const t = useT();
  const { run, running } = useContinuityCheck(eid);
  const [filter, setFilter] = useState<"all" | Sev>("all");
  const issues = [...(report?.issues ?? [])].sort((a, b) => (SEV_ORDER[sevOf(a.severity)] ?? 1) - (SEV_ORDER[sevOf(b.severity)] ?? 1));
  const counts = { high: 0, medium: 0, low: 0 } as Record<Sev, number>;
  issues.forEach((i) => counts[sevOf(i.severity)]++);
  const active = filter !== "all" && !counts[filter] ? "all" : filter;
  const shown = active === "all" ? issues : issues.filter((i) => sevOf(i.severity) === active);
  const checked = !!report?.at || report?.ok !== undefined;
  const desc = hint ?? t("Checks props, wardrobe, time of day and who's in frame across scenes and shots.");
  const action = canRun && (
    <Button size="sm" loading={running} icon={<ScanSearch className="size-3.5" />} onClick={run}>
      {checked ? t("Re-check") : t("Check continuity")}
    </Button>
  );

  const body = (
    <>
      {!checked ? (
        <RoomEmpty icon={<ScanSearch className="size-7" />} title={t("Not checked yet")} sub={t("Run a check after planning scenes or shots.")} />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
            {issues.length ? (
              <Segmented value={active} onChange={setFilter} aria-label={t("Filter by severity")}
                options={(["all", "high", "medium", "low"] as const).filter((f) => f === "all" || counts[f]).map((f) => ({
                  value: f,
                  label: (
                    <span className="flex items-center gap-1.5">
                      {f !== "all" && <span className={clsx("size-1.5 rounded-full", SEV_STYLE[f].bar)} />}
                      {f === "all" ? t("All") : t(SEV_STYLE[f].label)}
                      <span className="tabular-nums text-dim">{f === "all" ? issues.length : counts[f]}</span>
                    </span>
                  ),
                }))} />
            ) : (
              <motion.span initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
                className="flex items-center gap-2 rounded-lg border border-ok/30 bg-ok/8 px-3 py-2 text-sm font-medium text-green-300">
                <CheckCircle2 className="size-4" />{t("No continuity issues found")}
              </motion.span>
            )}
            {report?.at && <span className="ml-auto text-dim" title={new Date(report.at).toLocaleString()}>{ago(report.at)}</span>}
          </div>

          {issues.length > 0 && (
            <ul className={clsx("space-y-2", compact && "max-h-[60vh] overflow-y-auto pr-1")}>
              <AnimatePresence initial={false}>
                {shown.map((i) => {
                  const sev = SEV_STYLE[sevOf(i.severity)];
                  return (
                    <motion.li key={`${i.where}|${i.problem}`} layout="position"
                      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}
                      className="relative overflow-hidden rounded-lg border border-line bg-bg/40 py-2.5 pl-4 pr-3">
                      <span className={clsx("absolute inset-y-0 left-0 w-1", sev.bar)} />
                      <div className="mb-1.5 flex flex-wrap items-center gap-2">
                        <Badge tone={sev.badge}>{sev.icon}{t(sev.label)}</Badge>
                        {i.where && <code className="max-w-full truncate rounded bg-raised px-1.5 py-0.5 font-mono text-2xs text-mute">{i.where}</code>}
                      </div>
                      <p className="text-sm leading-snug">{i.problem}</p>
                      {i.fix && (
                        <p className="mt-1.5 flex gap-1.5 text-xs leading-snug text-mute">
                          <Wrench className="mt-0.5 size-3 shrink-0 text-dim" /><span><span className="font-medium text-ink">{t("Fix")}:</span> {i.fix}</span>
                        </p>
                      )}
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          )}
        </div>
      )}
    </>
  );

  if (bare) {
    return (
      <div className={className}>
        <PanelHead title={t("Continuity")} description={desc} actions={action} />
        {body}
      </div>
    );
  }
  return (
    <SectionCard index={index} className={className} icon={<ScanSearch />} title={t("Continuity")} description={desc} actions={action}>{body}</SectionCard>
  );
}
