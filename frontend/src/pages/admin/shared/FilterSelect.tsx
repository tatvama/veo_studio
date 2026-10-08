import { clsx } from "clsx";
import type { ReactNode } from "react";

/** A compact labelled dropdown: "Status  Any ▾". Sized by its longest option so the label is never cut off. */
export function FilterSelect({ label, value, onChange, children, active, className }: {
  label: string; value: string; onChange: (v: string) => void; children: ReactNode; active?: boolean; className?: string;
}) {
  return (
    <label className={clsx(
      "inline-flex h-9 min-w-0 max-w-full items-center gap-1.5 rounded-lg border bg-panel pl-2.5 text-sm transition-[border-color,box-shadow] duration-150",
      "focus-within:border-accent/70 focus-within:ring-[3px] focus-within:ring-accent/15 hover:border-dim/40",
      active ? "border-accent/45" : "border-line", className,
    )}>
      <span className="shrink-0 text-xs text-dim">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
        className={clsx("h-full min-w-0 flex-1 cursor-pointer rounded-r-lg bg-transparent pr-8 text-sm font-medium focus:outline-none", active ? "text-accent-ink" : "text-ink")}>
        {children}
      </select>
    </label>
  );
}
