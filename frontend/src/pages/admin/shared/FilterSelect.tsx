import { clsx } from "clsx";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

/** A compact labelled dropdown: "STATUS  Any ▾". Sized by its longest option so the label is never cut off. */
export function FilterSelect({ label, value, onChange, children, active, className, compact }: {
  label: string; value: string; onChange: (v: string) => void; children: ReactNode; active?: boolean; className?: string;
  /** 32px tall (36px by default; 40px on phones either way): for dense toolbars above data grids. */
  compact?: boolean;
}) {
  return (
    <label className={clsx(
      "relative inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border bg-raised pl-2.5 text-xs transition-[border-color,box-shadow] duration-150 max-sm:h-10", compact ? "h-8" : "h-9",
      "focus-within:border-accent/70 focus-within:ring-[3px] focus-within:ring-accent/15 hover:border-dim/50",
      active ? "border-accent/45" : "border-line", className,
    )}>
      <span className="eyebrow shrink-0 !tracking-[0.1em]">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
        className={clsx("h-full min-w-0 flex-1 cursor-pointer appearance-none rounded-r-lg bg-transparent pr-7 text-xs font-medium focus:outline-none", active ? "text-accent-ink" : "text-ink")}>
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2 size-3.5 text-dim" />
    </label>
  );
}
