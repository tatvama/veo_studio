import { ArrowRight, CirclePause, Clapperboard, FileText, Lightbulb, Rocket, TriangleAlert, Users, Wand2 } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import JobTray from "../../components/JobTray";
import { useGenerate } from "../../components/Generate";
import { Button, Popover, Tooltip } from "../../components/ui";
import { useBatchEstimate } from "../../lib/estimates";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import type { Episode } from "../../lib/types";
import { useProjectCtx } from "./context";
import { FixList, useFixes } from "./FixList";
import { isOwnMaterial } from "./flow";
import { openImport } from "./importEvent";
import { MakeItForMe } from "./MakeItForMe";
import { makeBody, type Make, type NextStep } from "./nextStep";
import { problemCountLabel } from "./problems";

/**
 * Runs a next step: opens its page, or starts what it makes (the cast, "Make it for me", the script import), always with
 * the price first. `modal` is the "Make it for me" dialog to render; `price` is what the step's button starts, when it costs.
 */
export function useNextStepRunner(step: NextStep | null, episode: Episode | undefined) {
  const nav = useNavigate();
  const { project, eid, canEdit } = useProjectCtx();
  const { generate } = useGenerate();
  const [make, setMake] = useState(false);
  const [busy, setBusy] = useState(false);
  const shots = (episode?.shots ?? []).filter((s) => s.include);
  const videos = shots.filter((s) => s.video).length;
  // the price of what the primary button starts (re-priced as shots, pictures and videos come in)
  const body = canEdit ? makeBody(step?.make) : null;
  const { data: est } = useBatchEstimate(eid, body, [shots.length, videos, shots.filter((s) => s.keyframe).length, (project.cast ?? []).filter((c) => c.avatar_url).length]);
  const price = est && est.count > 0 && est.total_usd > 0 ? usd(est.total_usd) : null;

  const run = async (m: Make | undefined, tab: string) => {
    if (!m || !canEdit) { nav(`/p/${project.id}/${tab}`); return; }
    if (m === "import") { if (!shots.length) nav(`/p/${project.id}/shots`); openImport(); return; }
    if (m === "cast") {
      nav(`/p/${project.id}/bible`);
      setBusy(true);
      try { await generate(eid, { action: "produce", steps: ["cast"] }, tr("Make the cast")); } finally { setBusy(false); }
      return;
    }
    if (m === "final") {  // after a quick draft: the drafts remade as finished clips, the film rendered (price first)
      setBusy(true);
      try { await generate(eid, makeBody("final")!, tr("Make the final film")); } finally { setBusy(false); }
      return;
    }
    setMake(true);
  };
  const modal = <MakeItForMe open={make} onClose={() => setMake(false)} hasShots={shots.length > 0} />;
  return { run, busy, price, modal, openMake: () => setMake(true), shots };
}

/**
 * The bar at the bottom of every project screen (44 px): on the left what is being made right now (click for the job list
 * with costs, retry and cancel); on the right the next step in plain words, its price when it costs money, and one primary
 * button. "Make it for me" is always one click away.
 */
export function NextBar({ step, episode }: { step: NextStep | null; episode?: Episode }) {
  const t = useT();
  const { project, canEdit } = useProjectCtx();
  const { run: go, busy, price, modal, openMake, shots } = useNextStepRunner(step, episode);
  // no live AI service: everything is made as a free placeholder (the status strip said so outside projects)
  const { data: settings } = useSettings();
  const engines = (settings?.providers ?? []).filter((p) => p.engine !== false);
  const placeholder = engines.length > 0 && !engines.some((p) => p.mode === "live");

  const icon = step?.tone === "warn" ? <CirclePause className="size-3.5 text-warn" /> : step?.tone === "info" ? <Rocket className="size-3.5 text-ai" />
    : <Lightbulb className="size-3.5 text-accent-ink" />;
  const primaryIcon = step?.make === "cast" ? <Users className="size-3.5" /> : step?.make === "import" ? <FileText className="size-3.5" />
    : step?.make === "final" ? <Clapperboard className="size-3.5" /> : step?.make ? <Wand2 className="size-3.5" /> : undefined;
  // "Make it for me" stays one click away when the primary button is something else
  // (not before an own-material project has shots: there is no idea to make a film from, only a script to bring)
  const offerMake = canEdit && !!episode && (shots.length > 0 || !isOwnMaterial(project))
    && step?.make !== "all" && step?.make !== "watch" && step?.secondary?.make !== "watch";

  return (
    <div className="@container relative z-[45] flex h-11 shrink-0 items-stretch border-t border-line bg-panel" role="region" aria-label={t("Next step")}>
      <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-40" />
      <div className="flex min-w-0 basis-[38%] @max-[40rem]:basis-auto @max-[40rem]:flex-none">
        <JobTray projectId={project.id} inline />
        {placeholder && (
          <Tooltip content={t("No AI service is live: everything is made as a free placeholder. Add keys in Settings.")} side="top">
            <Link to="/settings" className="mono my-auto mr-2 hidden shrink-0 rounded-md border border-warn/30 bg-warn/10 px-1.5 py-0.5 text-2xs text-warn @min-[56rem]:inline">{t("Placeholder mode")}</Link>
          </Tooltip>
        )}
      </div>
      {step && (
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 border-l border-line pl-3 pr-2 sm:pr-3">
          <ProblemsChip onContinue={openMake} />
          <p className="hidden min-w-0 flex-1 items-center justify-end gap-1.5 text-right text-xs text-mute @min-[44rem]:flex" title={step.text}>
            {icon}<span className="truncate">{step.text}</span>
          </p>
          {step.secondary && (
            <Button size="sm" variant="ghost" className="max-sm:hidden" onClick={() => void go(step.secondary!.make, step.secondary!.tab)}>{step.secondary.label}</Button>
          )}
          {offerMake && (
            <Tooltip content={t("Let the studio make the rest (you see the price first)")} side="top">
              <Button size="sm" variant="ghost" icon={<Wand2 className="size-3.5 text-ai" />} className="max-md:hidden" onClick={openMake}>{t("Make it for me")}</Button>
            </Tooltip>
          )}
          <Button size="sm" variant="primary" icon={primaryIcon} iconRight={!step.make ? <ArrowRight className="size-3.5" /> : undefined} loading={busy}
            onClick={() => void go(step.make, step.tab)} className="shrink-0">
            {step.action}{price && <span className="mono">· {price}</span>}
          </Button>
        </div>
      )}
      {modal}
    </div>
  );
}

/**
 * "3 problems": what the last run couldn't make and the shots' failed steps, each with its fix (FixList), one click
 * away on every project screen. Hidden when there are none.
 */
function ProblemsChip({ onContinue }: { onContinue: () => void }) {
  const t = useT();
  const items = useFixes();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}
        title={t("What didn't get made, and how to fix it")}
        className="mono inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-bad/40 bg-bad/10 px-2 text-2xs font-semibold text-bad transition-colors hover:bg-bad/20">
        <TriangleAlert className="size-3.5" />{t(problemCountLabel(items.length), { n: items.length })}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="top-end" width={400} className="p-3">
        <p className="eyebrow mb-2 !text-bad">{t(problemCountLabel(items.length), { n: items.length })}</p>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <FixList items={items} onContinue={onContinue} onDone={() => setOpen(false)} />
        </div>
      </Popover>
    </>
  );
}
