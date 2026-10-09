import { clsx } from "clsx";
import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";
import { Link } from "react-router-dom";
import { ScrollStrip } from "../../components/ui";
import { useT } from "../../lib/i18n";
import type { Continue, StepView } from "./flow";

/**
 * The band above a step's page: which step this is and what it is for, the step's pages as a segmented control, and a
 * "Continue to …" button once the step is in good shape. On phones the step strip above already names the step, so only
 * the pages and the button show (and nothing at all when there is neither).
 */
export function StepBar({ pid, step, tab, cont, total }: { pid: number; step: StepView; tab: string; cont: Continue | null; total: number }) {
  const t = useT();
  const many = step.tabs.length > 1;
  return (
    <div className={clsx("relative z-10 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-panel/60 px-3 py-2 backdrop-blur sm:px-4",
      !many && !cont && "max-sm:hidden")}>
      <div className="min-w-0 flex-1 basis-64 max-sm:hidden">
        <h2 className="flex min-w-0 items-baseline gap-2">
          <span className="mono shrink-0 text-2xs font-medium uppercase tracking-wider text-accent-ink">{t("Step {n} of {m}", { n: step.n, m: total })}</span>
          <span className="truncate text-base font-semibold tracking-tight">{step.label}</span>
        </h2>
        <p className="truncate text-xs text-mute" title={step.blurb}>{step.blurb}</p>
      </div>
      {many && (
        <ScrollStrip className="max-w-full" role="navigation" aria-label={t("{step} pages", { step: step.label })}>
          <div className="inline-flex gap-0.5 rounded-lg border border-line bg-panel p-0.5">
            {step.tabs.map((x) => {
              const on = x.to === tab;
              return (
                <Link key={x.to} to={`/p/${pid}/${x.to}`} aria-current={on ? "page" : undefined}
                  className={clsx("relative flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50",
                    on ? "text-ink" : "text-mute hover:text-ink")}>
                  {on && (
                    <motion.span layoutId={`sub-${pid}-${step.id}`} transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.7 }}
                      className="absolute inset-0 rounded-md bg-raised shadow-[0_0_0_1px_var(--color-line),0_0_12px_-6px_var(--color-accent)]">
                      <span aria-hidden className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />
                    </motion.span>
                  )}
                  <x.icon className="relative size-4" />
                  <span className="relative">{x.label}</span>
                </Link>
              );
            })}
          </div>
        </ScrollStrip>
      )}
      {cont && (
        <Link to={`/p/${pid}/${cont.to}`}
          className="btn-primary ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-black outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          {cont.label}<ArrowRight className="size-4" />
        </Link>
      )}
    </div>
  );
}
