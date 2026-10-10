import { clsx } from "clsx";
import { Check, ChevronDown, Circle, ListChecks, Loader2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState } from "react";
import { useT } from "../../lib/i18n";
import type { AgentPlanStep, AgentStep } from "../../lib/types";
import "../../styles/console.css";

const EASE = [0.22, 1, 0.36, 1] as const;

/** Done, failed, or still running (a step that never finished on a saved message shows as a plain dot). */
function StepIcon({ ok, live }: { ok: boolean | null; live?: boolean }) {
  if (ok === true) return <Check aria-hidden className="mt-px size-3 shrink-0 text-ok" />;
  if (ok === false) return <X aria-hidden className="mt-px size-3 shrink-0 text-bad" />;
  if (live) return <Loader2 aria-hidden className="mt-px size-3 shrink-0 animate-spin text-ai" />;
  return <Circle aria-hidden className="mt-px size-3 shrink-0 text-dim" />;
}

/** The tool calls of one turn, one line each. */
export function StepList({ steps, live, className }: { steps: AgentStep[]; live?: boolean; className?: string }) {
  const t = useT();
  return (
    <ul className={clsx("space-y-1", className)}>
      {steps.map((s, i) => (
        <li key={i} className={clsx("flex items-start gap-1.5 text-2xs leading-snug", s.ok === null && live ? "text-ink" : "text-mute")}>
          <StepIcon ok={s.ok} live={live} />
          <span className="min-w-0 break-words">{s.label}</span>
          {s.ok === false && <span className="sr-only">{t("Failed")}</span>}
        </li>
      ))}
    </ul>
  );
}

/** The Director's working checklist (update_plan): done, in progress, still to do. */
export function PlanChecklist({ plan, live, className }: { plan: AgentPlanStep[]; live?: boolean; className?: string }) {
  const t = useT();
  const done = plan.filter((p) => p.status === "done").length;
  return (
    <div className={clsx("cx-block px-3 py-2", className)} data-tone="ai">
      <p className="mono mb-1.5 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-[0.14em] text-ai">
        <ListChecks aria-hidden className="size-3" />{t("Plan")}
        <span className="flex-1" />
        <span className="tabular-nums tracking-normal text-dim">{done}/{plan.length}</span>
      </p>
      <ul className="space-y-1">
        {plan.map((p, i) => (
          <li key={i} className={clsx("flex items-start gap-1.5 text-2xs leading-snug",
            p.status === "done" ? "text-mute" : p.status === "doing" ? "text-ink" : "text-dim")}>
            {p.status === "done" ? <Check aria-hidden className="mt-px size-3 shrink-0 text-ok" />
              : p.status === "doing" ? (live ? <Loader2 aria-hidden className="mt-px size-3 shrink-0 animate-spin text-ai" />
                : <span aria-hidden className="mt-[3px] size-2 shrink-0 rounded-full bg-ai" />)
                : <Circle aria-hidden className="mt-px size-3 shrink-0" />}
            <span className={clsx("min-w-0 break-words", p.status === "done" && "line-through decoration-dim/60")}>{p.text}</span>
            <span className="sr-only">{p.status === "done" ? t("Done") : p.status === "doing" ? t("In progress") : t("To do")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** On a finished Director message: "N steps", folded; open it to see each tool call and how it went. */
export function StepsDisclosure({ steps }: { steps: AgentStep[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const id = useId();
  const failed = steps.filter((s) => s.ok === false).length;
  return (
    <div className="cx-block mt-2 overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="mono flex h-7 w-full items-center gap-1.5 px-3 text-2xs font-medium uppercase tracking-[0.14em] text-dim transition-colors hover:text-ink focus-visible:text-ink"
      >
        <ListChecks aria-hidden className="size-3 text-ai" />
        {steps.length === 1 ? t("1 step") : t("{n} steps", { n: steps.length })}
        {failed > 0 && <span className="normal-case tracking-normal text-bad">· {t("{n} failed", { n: failed })}</span>}
        <span className="flex-1" />
        <ChevronDown aria-hidden className={clsx("size-3.5 transition-transform duration-200", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={id}
            key="steps"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="overflow-hidden"
          >
            <StepList steps={steps} className="border-t border-line/60 px-3 py-2" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
