import { clsx } from "clsx";
import { motion } from "motion/react";
import { useId, type ComponentType, type ReactNode } from "react";
import { ScrollStrip } from "../../../components/ui";

const SPRING = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } as const;

export interface ChipItem { value: string; label: ReactNode; icon?: ComponentType<{ className?: string }>; count?: number; disabled?: boolean }

/** Single-choice filter chips with a sliding highlight; scrolls sideways when there are too many. */
export function ChipGroup({ items, value, onChange, label, className }: {
  items: ChipItem[]; value: string; onChange: (v: string) => void; label: string; className?: string;
}) {
  const id = useId();
  return (
    <ScrollStrip role="radiogroup" aria-label={label} className={clsx("-mx-1 flex gap-1.5 px-1 py-0.5", className)}>
      {items.map(({ value: v, label: text, icon: Icon, count, disabled }) => {
        const on = value === v;
        const empty = disabled || (count === 0 && !on);
        return (
          <button key={v || "all"} type="button" role="radio" aria-checked={on} data-active={on} disabled={empty} onClick={() => onChange(v)}
            className={clsx("relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors",
              on ? "border-accent/45 text-ink" : "border-line text-mute hover:border-dim/50 hover:text-ink", empty && "cursor-not-allowed opacity-40")}>
            {on && <motion.span layoutId={`chip-${id}`} transition={SPRING} className="absolute inset-0 rounded-full bg-accent/12" />}
            {Icon && <Icon className={clsx("relative size-3.5", on && "text-accent-ink")} />}
            <span className="relative">{text}</span>
            {count !== undefined && <span className={clsx("relative text-xs tabular-nums", on ? "text-accent-ink" : "text-dim")}>{count.toLocaleString()}</span>}
          </button>
        );
      })}
    </ScrollStrip>
  );
}
