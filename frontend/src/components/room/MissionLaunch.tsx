import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check, CirclePause, Loader2, Play, Rocket, Square } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { tr, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import type { AutopilotState, Project } from "../../lib/types";
import { defaultStops } from "../AutopilotPanel";
import { useGenerate } from "../Generate";
import { Badge, Button, Segmented, Skeleton, Tooltip } from "../ui";
import { WorkPanel } from "./workspace";

/**
 * Autopilot as a mission launch: the milestones are a stepper, the "stop for my approval" gates sit between the steps (click one
 * to arm it), and one button launches the run. Same behaviour as the old Autopilot panel: pick how far it goes, choose where it
 * pauses for approval, watch it by milestone, continue after a stop, stop after the current step.
 */
export function MissionLaunch({ project, eid, canEdit, index }: { project: Project; eid: number; canEdit: boolean; index?: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { generate } = useGenerate();
  const { data: settings } = useSettings();
  const milestones = settings?.catalog.autopilot?.milestones ?? [];
  const labels = settings?.catalog.autopilot?.labels ?? {};
  const stageOrder = settings?.catalog.autopilot?.stages ?? [];
  // runs saved before milestones existed only know their stages: place them by stage
  const containing = (stage?: string) => {
    const i = stage ? stageOrder.indexOf(stage) : -1;
    return i < 0 ? undefined : milestones.find((m) => i <= stageOrder.indexOf(m.until)) ?? milestones[milestones.length - 1];
  };
  const raw = (project.autopilot || {}) as AutopilotState;
  const ap: AutopilotState = {
    ...raw,
    milestone: raw.milestone ?? containing(raw.stage)?.id,
    through: milestones.some((m) => m.id === raw.through) ? raw.through : containing((raw as { stages?: string[] }).stages?.at(-1) ?? raw.stage)?.id,
  };
  const [target, setTarget] = useState<string>("final");
  const [stops, setStops] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const chosenStops = stops ?? defaultStops(milestones, target);
  const running = ap.status === "running";
  const paused = ap.status === "paused";
  const ended = ap.status === "failed" || ap.status === "cancelled" || ap.status === "stopped";
  const finished = ap.status === "finished";
  const pausedAt = milestones.find((m) => m.id === ap.paused_after);
  const nextAfterPause = pausedAt ? milestones[milestones.indexOf(pausedAt) + 1] : undefined;
  const curIdx = milestones.findIndex((m) => m.id === ap.milestone);
  const targetIdx = milestones.findIndex((m) => m.id === target);
  const targetLabel = milestones.find((m) => m.id === target)?.label ?? target;
  const idle = canEdit && !running && !paused;
  /** which milestone the stepper runs to: the active run's, else the one about to be launched */
  const reachIdx = milestones.findIndex((m) => m.id === (ap.status ? ap.through : target));

  const run = () => generate(eid, { action: "autopilot", through: target, pause_after: chosenStops.filter((s) => s !== target) },
    tr("Autopilot → {m}", { m: tr(targetLabel) }));
  const resume = () => generate(eid, { action: "autopilot", resume: true }, tr("Autopilot: continue"));
  const stop = async () => {
    if (!ap.job_id) return;
    setBusy(true);
    try {
      await api.post(`/api/jobs/${ap.job_id}/cancel`, {});
      toast.info(tr("Stopping Autopilot after the current step"));
      qc.invalidateQueries({ queryKey: ["project", project.id] });
    } catch { /* api toasts */ } finally { setBusy(false); }
  };
  const toggleStop = (id: string) => setStops(chosenStops.includes(id) ? chosenStops.filter((x) => x !== id) : [...chosenStops, id]);

  const status = running ? <Badge tone="ai"><span className="eq" aria-hidden><i /><i /><i /><i /></span>{t("Running")}</Badge>
    : paused ? <Badge tone="warn" dot>{t("Waiting for you")}</Badge>
    : ended ? <Badge tone="bad" dot>{t("Stopped")}</Badge>
    : finished ? <Badge tone="ok" dot>{t("Finished")}</Badge>
    : <Badge tone="neutral" dot>{t("Ready")}</Badge>;

  return (
    <WorkPanel id="autopilot" index={index} tone="ai" icon={<Rocket />} kicker={t("Mission launch")} title={t("Autopilot")} badge={status}
      description={t("Makes the episode for you, milestone by milestone, and can stop after each one so you approve before it spends more. One budget approval up front; it stops if spending goes 50% over the estimate.")}
      className="border-ai/25">
      {!settings ? (
        <div className="grid gap-3 @2xl:grid-cols-4" aria-busy="true">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : (
        <div className="space-y-5">
          {/* the stepper: milestones with an approval gate between each pair */}
          <ol className="flex flex-col gap-3.5 @2xl:flex-row @2xl:gap-0" aria-label={t("Milestones")} style={{ "--n": milestones.length } as CSSProperties}>
            {milestones.map((m, i) => {
              const inRun = reachIdx >= i;
              const done = !!ap.status && (finished || paused ? i <= curIdx : i < curIdx);
              const now = running && i === curIdx;
              const gate = i < milestones.length - 1 && i < (idle ? targetIdx : reachIdx);
              const armed = idle ? chosenStops.includes(m.id) : paused && pausedAt?.id === m.id;
              const gateLabel = armed ? t("Stops for your approval after {m}", { m: t(m.label) }) : t("Stop for my approval after {m}", { m: t(m.label) });
              return (
                <li key={m.id} className="relative flex min-w-0 flex-1 gap-3 @2xl:flex-col @2xl:gap-2.5">
                  <div className="flex items-center @2xl:w-full">
                    <span className={cn("relative z-[1] grid size-6 shrink-0 place-items-center rounded-full border text-2xs font-semibold transition-colors",
                      done ? "border-ok/50 bg-ok/15 text-ok" : now ? "border-ai bg-ai/20 text-ai shadow-[0_0_12px_-2px_var(--color-ai)]"
                        : paused && pausedAt?.id === m.id ? "border-warn/60 bg-warn/15 text-warn" : inRun ? "border-line bg-raised text-mute" : "border-line bg-bg text-dim")}>
                      {done ? <Check className="size-3.5" strokeWidth={3} /> : now ? <Loader2 className="size-3.5 animate-spin" /> : <span className="mono">{i + 1}</span>}
                    </span>
                    {i < milestones.length - 1 && (
                      <span className="relative mx-1 hidden h-6 flex-1 items-center @2xl:flex">
                        <span aria-hidden className={cn("h-px w-full", done ? "bg-ok/50" : inRun ? "rm-rule" : "bg-line/60")} />
                        {gate && (
                          <span className="absolute inset-0 grid place-items-center">
                            <GateButton armed={armed} disabled={!idle} label={gateLabel} onClick={() => toggleStop(m.id)} />
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 @2xl:pr-4">
                    <p className={cn("text-xs font-medium", !inRun && "text-dim")}>
                      {t(m.label)}
                      {now && ap.stage && <span className="ml-1.5 font-normal text-ai">· {t(labels[ap.stage] ?? ap.stage)}</span>}
                    </p>
                    <p className="mt-0.5 text-2xs leading-snug text-dim">{t(m.description)}</p>
                    {gate && (
                      <span className="mt-1.5 flex @2xl:hidden">
                        <GateButton armed={armed} disabled={!idle} label={gateLabel} onClick={() => toggleStop(m.id)} wide>{armed ? t("Stops here for approval") : t("Stop for approval")}</GateButton>
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          {paused && pausedAt && (
            <div className="rounded-lg border border-warn/40 bg-warn/8 p-3.5">
              <p className="flex items-center gap-1.5 text-sm font-semibold"><CirclePause className="size-4 text-warn" />{t("{m} is ready for your review", { m: t(pausedAt.label) })}</p>
              <p className="mt-1 text-xs text-mute">{t("Check it and change anything you like. When you're happy, continue{next}.", { next: nextAfterPause ? ` ${tr("to {m}", { m: tr(nextAfterPause.label) })}` : "" })}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link to={`/p/${project.id}/${pausedAt.tab}`}><Button size="sm" iconRight={<ArrowRight className="size-3.5" />}>{t("Review {m}", { m: t(pausedAt.label) })}</Button></Link>
                {canEdit && <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} onClick={resume}>{t("Continue")}</Button>}
              </div>
            </div>
          )}
          {ended && (
            <div className="rounded-lg border border-bad/30 bg-bad/8 p-3 text-xs">
              <p className="flex items-center gap-1.5 font-semibold text-red-300"><AlertTriangle className="size-3.5" />
                {ap.status === "cancelled" ? t("Autopilot was stopped") : t("Autopilot stopped before finishing")}
              </p>
              {ap.error && <p className="mt-1 text-mute">{ap.error}</p>}
              <p className="mt-1 text-dim">{t("Running it again picks up where it left off; finished work is kept.")}</p>
            </div>
          )}
          {finished && (
            <p className="flex items-center gap-1.5 text-xs text-green-300"><Check className="size-3.5" />
              {ap.through ? t("Last run finished: {m}", { m: t(milestones.find((m) => m.id === ap.through)?.label ?? "") }) : t("Last run finished")}
            </p>
          )}

          {idle && (
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-t border-line pt-4">
              <div className="min-w-0 space-y-1.5">
                <p className="eyebrow">{t("Run automatically until")}</p>
                <Segmented size="sm" value={target} aria-label={t("Run automatically until")}
                  onChange={(v) => { setTarget(v); setStops(null); }}
                  options={milestones.map((m) => ({ value: m.id, label: t(m.label), title: t(m.description) }))} />
                {targetIdx > 0 && <p className="text-2xs text-dim">{t("Click a gate between two steps to stop there for your approval.")}</p>}
              </div>
              <Button variant="primary" icon={<Rocket className="size-4" />} onClick={run}>
                {ended ? t("Try again → {m}", { m: t(targetLabel) }) : t("Run → {m}", { m: t(targetLabel) })}
              </Button>
            </div>
          )}
          {canEdit && running && (
            <div className="border-t border-line pt-4">
              <Button variant="outline" loading={busy} icon={<Square className="size-3.5" />} onClick={stop}>{t("Stop after this step")}</Button>
            </div>
          )}

          {!!ap.log?.length && (
            <details className="group/log rounded-lg border border-line bg-bg/40">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-mute">{t("What it did ({n})", { n: ap.log.length })}</summary>
              <ol className="max-h-48 space-y-1 overflow-y-auto border-t border-line px-3 py-2 text-xs text-mute">
                {ap.log.slice().reverse().map((l, i) => <li key={i} className={cn("mono leading-relaxed", i === 0 && "text-ink")}>{l}</li>)}
              </ol>
            </details>
          )}
        </div>
      )}
    </WorkPanel>
  );
}

/** The approval gate between two milestones: lit (violet, with a pause mark) when the run will stop there. */
function GateButton({ armed, disabled, label, onClick, wide, children }: {
  armed: boolean; disabled?: boolean; label: string; onClick: () => void; wide?: boolean; children?: React.ReactNode;
}) {
  const btn = (
    <button type="button" aria-pressed={armed} aria-label={label} disabled={disabled} onClick={onClick}
      className={cn("pointer-events-auto inline-flex items-center justify-center gap-1.5 rounded-md border text-2xs font-medium transition-colors disabled:cursor-default",
        wide ? "h-7 px-2" : "size-7", armed ? "border-ai/60 bg-ai/15 text-ai shadow-[0_0_10px_-3px_var(--color-ai)]" : "border-line bg-panel text-dim enabled:hover:border-ai/40 enabled:hover:text-ai")}>
      <CirclePause className="size-3.5" />{children}
    </button>
  );
  return wide ? btn : <Tooltip content={label}>{btn}</Tooltip>;
}
