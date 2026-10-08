import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { AlertTriangle, ArrowRight, Check, CirclePause, Loader2, Play, Rocket, Square } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../lib/api";
import { tr, useT } from "../lib/i18n";
import { useSettings } from "../lib/queries";
import type { AutopilotState, Milestone, Project } from "../lib/types";
import { useGenerate } from "./Generate";
import { Badge, Button, Segmented, Toggle } from "./ui";

/** Default approval stops for a run to `target`: every milestone before it. */
export function defaultStops(milestones: Milestone[], target: string): string[] {
  const i = milestones.findIndex((m) => m.id === target);
  return milestones.slice(0, Math.max(i, 0)).map((m) => m.id);
}

/**
 * Autopilot in one place: pick how far it goes and where it stops for your approval, watch it by milestone, continue
 * after a stop. The same milestones (from the server) are used everywhere.
 */
export function AutopilotPanel({ project, eid, canEdit }: { project: Project; eid: number; canEdit: boolean }) {
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
  const pausedAt = milestones.find((m) => m.id === ap.paused_after);
  const nextAfterPause = pausedAt ? milestones[milestones.indexOf(pausedAt) + 1] : undefined;
  const curIdx = milestones.findIndex((m) => m.id === ap.milestone);
  const targetLabel = milestones.find((m) => m.id === target)?.label ?? target;

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

  return (
    <div id="autopilot" className="scroll-mt-4 overflow-hidden rounded-xl border border-line bg-panel">
      <div className="bg-gradient-to-b from-accent/10 to-transparent p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight"><Rocket className="size-4 text-accent-ink" />{t("Autopilot")}</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-mute">
          {t("Makes the episode for you, milestone by milestone, and can stop after each one so you approve before it spends more. One budget approval up front; it stops if spending goes 50% over the estimate.")}
        </p>

        {/* progress by milestone */}
        <ol className="mt-4 space-y-1.5" aria-label={t("Milestones")}>
          {milestones.map((m, i) => {
            const isTarget = milestones.findIndex((x) => x.id === (ap.status ? ap.through : target)) >= i;
            const done = ap.status && (ap.status === "finished" ? i <= curIdx : paused ? i <= curIdx : i < curIdx);
            const now = running && i === curIdx;
            return (
              <li key={m.id} className={clsx("flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors", now && "bg-accent/8")}>
                <span className={clsx("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-2xs font-semibold",
                  done ? "bg-ok/20 text-ok" : now ? "bg-accent text-black" : isTarget ? "bg-raised text-mute" : "bg-raised/50 text-dim")}>
                  {done ? <Check className="size-3" strokeWidth={3} /> : now ? <Loader2 className="size-3 animate-spin" /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={clsx("text-xs font-medium", !isTarget && "text-dim")}>{t(m.label)}
                    {now && ap.stage && <span className="ml-1.5 font-normal text-accent-ink">· {t(labels[ap.stage] ?? ap.stage)}</span>}
                    {paused && pausedAt?.id === m.id && <Badge tone="warn" className="ml-1.5">{t("waiting for you")}</Badge>}
                  </p>
                  <p className="text-2xs text-dim">{t(m.description)}</p>
                </div>
              </li>
            );
          })}
        </ol>

        {paused && pausedAt && (
          <div className="mt-4 rounded-lg border border-warn/40 bg-warn/8 p-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold"><CirclePause className="size-4 text-warn" />{t("{m} is ready for your review", { m: t(pausedAt.label) })}</p>
            <p className="mt-1 text-xs text-mute">{t("Check it and change anything you like. When you're happy, continue{next}.", { next: nextAfterPause ? ` ${tr("to {m}", { m: tr(nextAfterPause.label) })}` : "" })}</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Link to={`/p/${project.id}/${pausedAt.tab}`}><Button size="sm" iconRight={<ArrowRight className="size-3.5" />}>{t("Review {m}", { m: t(pausedAt.label) })}</Button></Link>
              {canEdit && <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} onClick={resume}>{t("Continue")}</Button>}
            </div>
          </div>
        )}
        {ended && (
          <div className="mt-4 rounded-lg border border-bad/30 bg-bad/8 p-3 text-xs">
            <p className="flex items-center gap-1.5 font-semibold text-red-300"><AlertTriangle className="size-3.5" />
              {ap.status === "cancelled" ? t("Autopilot was stopped") : t("Autopilot stopped before finishing")}
            </p>
            {ap.error && <p className="mt-1 text-mute">{ap.error}</p>}
            <p className="mt-1 text-dim">{t("Running it again picks up where it left off; finished work is kept.")}</p>
          </div>
        )}
        {ap.status === "finished" && (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-ok"><Check className="size-3.5" />
            {ap.through ? t("Last run finished: {m}", { m: t(milestones.find((m) => m.id === ap.through)?.label ?? "") }) : t("Last run finished")}
          </p>
        )}

        {canEdit && !running && !paused && (
          <div className="mt-4 space-y-3 border-t border-line/70 pt-4">
            <div>
              <p className="mb-1.5 text-xs font-medium text-mute">{t("Run automatically until")}</p>
              <Segmented size="sm" value={target} aria-label={t("Run automatically until")}
                onChange={(v) => { setTarget(v); setStops(null); }}
                options={milestones.map((m) => ({ value: m.id, label: t(m.label), title: t(m.description) }))} />
            </div>
            {milestones.findIndex((m) => m.id === target) > 0 && (
              <div className="flex flex-col items-start gap-1.5">
                <p className="text-xs font-medium text-mute">{t("Stop for my approval after")}</p>
                {milestones.slice(0, milestones.findIndex((m) => m.id === target)).map((m) => (
                  <Toggle key={m.id} checked={chosenStops.includes(m.id)}
                    onChange={(v) => setStops(v ? [...chosenStops, m.id] : chosenStops.filter((x) => x !== m.id))}
                    label={<span className="text-xs">{t(m.label)}</span>} />
                ))}
              </div>
            )}
            <Button variant="primary" block icon={<Rocket className="size-4" />} onClick={run}>
              {ended ? t("Try again → {m}", { m: t(targetLabel) }) : t("Run → {m}", { m: t(targetLabel) })}
            </Button>
          </div>
        )}
        {canEdit && running && (
          <Button className="mt-4" block variant="outline" loading={busy} icon={<Square className="size-3.5" />} onClick={stop}>{t("Stop after this step")}</Button>
        )}
      </div>
      {!!ap.log?.length && (
        <details className="border-t border-line p-4">
          <summary className="cursor-pointer text-xs font-medium text-mute">{t("What it did ({n})", { n: ap.log.length })}</summary>
          <ol className="mt-2 max-h-48 space-y-1 overflow-y-auto border-l border-line pl-3 text-xs text-mute">
            {ap.log.slice().reverse().map((l, i) => <li key={i} className={clsx(i === 0 && "text-ink")}>{l}</li>)}
          </ol>
        </details>
      )}
    </div>
  );
}
