import { clsx } from "clsx";
import { CirclePause, ExternalLink, Mic, RotateCcw, TriangleAlert, Wand2, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useGenerate } from "../../components/Generate";
import { Button, IconButton } from "../../components/ui";
import { tr, useT } from "../../lib/i18n";
import { useEpisode } from "../../lib/queries";
import { useUI } from "../../lib/store";
import { useCanvasInfo } from "./canvas/data";
import { STEP_LABEL, stepBody } from "./canvas/model";
import { useProjectCtx } from "./context";
import { collectFixes, FIX_LABEL, OPEN_SHOT_EVENT, type FixItem } from "./problems";
import { TryEngineButton } from "./TryEngine";

/**
 * Opens a shot from anywhere: over the canvas when it is on screen (it listens for OPEN_SHOT_EVENT), else in the Grid
 * view's shot panel.
 */
export function useOpenShot() {
  const nav = useNavigate();
  const { project } = useProjectCtx();
  const setSelectedShot = useUI((s) => s.setSelectedShot);
  return (shotId: number) => {
    const ev = new CustomEvent(OPEN_SHOT_EVENT, { detail: { shotId }, cancelable: true });
    if (!window.dispatchEvent(ev)) return; // the canvas took it (preventDefault)
    setSelectedShot(shotId);
    nav(`/p/${project.id}/storyboard`);
  };
}

/**
 * The episode's problems you can act on: the last run's (what it couldn't make, and why) and the shots' failed steps,
 * merged (pages/project/problems.ts). Re-read with the episode, so a fixed one drops off.
 */
export function useFixes(): FixItem[] {
  const { eid, lang } = useProjectCtx();
  const { data: info } = useCanvasInfo(eid, lang);
  const { data: episode } = useEpisode(eid, lang);
  const shots = (episode?.shots ?? []);
  const codes = new Map(shots.map((s) => [s.id, s.code]));
  const included = episode ? new Set(shots.filter((s) => s.include).map((s) => s.id)) : undefined;
  return collectFixes(info?.run_problems, info?.shots, codes, included);
}

/**
 * Each problem in plain words with its one-click fix: Retry (priced), Try another engine (priced per engine), Make the
 * voice, Open the shot, or Make it for me (a budget stop: carry on). `limit` shows the first few and a "more" line.
 */
export function FixList({ items, limit, onContinue, onDone, className }: {
  items: FixItem[]; limit?: number; onContinue?: () => void;
  /** After a fix starts or a shot opens (e.g. close the popover it sits in). */
  onDone?: () => void; className?: string;
}) {
  const t = useT();
  const [all, setAll] = useState(false);
  const shown = limit && !all ? items.slice(0, limit) : items;
  if (!items.length) return null;
  return (
    <div className={className}>
      <ul className="divide-y divide-line">
        {shown.map((p) => <FixRow key={p.key} p={p} onContinue={onContinue} onDone={onDone} />)}
      </ul>
      {limit && items.length > limit && !all && (
        <button type="button" onClick={() => setAll(true)} className="mt-1.5 text-xs font-medium text-accent-ink hover:underline">
          {t("Show all {n}", { n: items.length })}
        </button>
      )}
    </div>
  );
}

function FixRow({ p, onContinue, onDone }: { p: FixItem; onContinue?: () => void; onDone?: () => void }) {
  const t = useT();
  const { eid, canEdit } = useProjectCtx();
  const { generate } = useGenerate();
  const open = useOpenShot();
  const [busy, setBusy] = useState(false);
  const what = [p.code, p.kind ? t(STEP_LABEL[p.kind]) : p.step === "budget" ? t("Budget") : p.step === "export" ? t("Final film") : p.step]
    .filter(Boolean).join(" · ");
  const failed = p.from === "step" || (p.kind != null && p.action !== "open");
  const icon = p.action === "continue" ? <CirclePause className="size-4 text-warn" />
    : failed ? <XCircle className="size-4 text-bad" /> : <TriangleAlert className="size-4 text-warn" />;
  const make = async (kind: NonNullable<FixItem["kind"]>) => {
    if (!p.shotId) return;
    setBusy(true);
    try {
      await generate(eid, stepBody(kind, p.shotId), tr("{step} · {code}", { step: tr(STEP_LABEL[kind]), code: p.code }));
      onDone?.();
    } catch { /* the api layer showed the error */ } finally { setBusy(false); }
  };
  const go = () => { if (p.shotId) { open(p.shotId); onDone?.(); } };

  let primary: ReactNode = null;
  if (canEdit && p.action === "retry" && p.kind && p.shotId) {
    primary = <Button size="sm" icon={<RotateCcw className="size-3.5" />} loading={busy} onClick={() => void make(p.kind!)}
      title={t("Make it again (you see the price first)")}>{t(FIX_LABEL.retry)}</Button>;
  } else if (canEdit && p.action === "voice" && p.shotId) {
    primary = <Button size="sm" icon={<Mic className="size-3.5" />} loading={busy} onClick={() => void make("voice")}
      title={t("Make the shot's voice (you see the price first)")}>{t(FIX_LABEL.voice)}</Button>;
  } else if (canEdit && p.action === "continue" && onContinue) {
    primary = <Button size="sm" icon={<Wand2 className="size-3.5 text-ai" />} onClick={() => { onContinue(); onDone?.(); }}
      title={t("Carry on: only what is missing is made, after its price")}>{t(FIX_LABEL.continue)}</Button>;
  } else if (p.action === "open" && p.shotId) {
    primary = <Button size="sm" icon={<ExternalLink className="size-3.5" />} onClick={go}>{t(FIX_LABEL.open)}</Button>;
  }
  const engine = canEdit && p.engine && p.shotId
    ? <TryEngineButton shotId={p.shotId} code={p.code} variant={p.action === "engine" ? "primary" : "outline"} onPicked={onDone} />
    : null;
  return (
    <li className="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        {what && <p className="mono text-2xs font-semibold uppercase tracking-wide text-mute">{what}</p>}
        <p className="text-sm leading-snug">{p.reason}</p>
        {p.next && <p className="mt-0.5 text-2xs leading-snug text-dim">{p.next}</p>}
        <div className={clsx("flex flex-wrap items-center gap-1.5", (primary || engine || (p.shotId && p.action !== "open")) && "mt-1.5")}>
          {p.action === "engine" ? <>{engine}{primary}</> : <>{primary}{engine}</>}
          {p.shotId && p.action !== "open" && (
            <IconButton title={t("Open the shot")} onClick={go} className="size-7"><ExternalLink className="size-3.5" /></IconButton>
          )}
        </div>
      </div>
    </li>
  );
}
