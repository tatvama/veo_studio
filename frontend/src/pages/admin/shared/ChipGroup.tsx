import { clsx } from "clsx";
import { type ComponentType, type ReactNode } from "react";
import { ScrollStrip } from "../../../components/ui";
import "../../../styles/console.css";

export interface ChipItem {
  value: string; label: ReactNode; icon?: ComponentType<{ className?: string }>; count?: number; disabled?: boolean;
  /** Tints the lit state (state colours only: ok / warn / bad, or money / ai). */
  tone?: "ai" | "money" | "ok" | "warn" | "bad";
  /** Native tooltip. */
  title?: string;
}

/** Single-choice filter chips (`cx-chip`); scrolls sideways when there are too many. */
export function ChipGroup({ items, value, onChange, label, className }: {
  items: ChipItem[]; value: string; onChange: (v: string) => void; label: string; className?: string;
}) {
  return (
    <ScrollStrip role="radiogroup" aria-label={label} className={clsx("-mx-1 flex gap-1.5 px-1 py-0.5", className)}>
      {items.map(({ value: v, label: text, icon: Icon, count, disabled, tone, title }) => {
        const on = value === v;
        const empty = disabled || (count === 0 && !on);
        return (
          <button key={v || "all"} type="button" role="radio" aria-checked={on} data-active={on} data-tone={tone} title={title} disabled={empty} onClick={() => onChange(v)}
            className={clsx("cx-chip", on && "is-on", empty && "cursor-not-allowed opacity-40")}>
            {Icon && <Icon className="size-3.5" />}
            <span>{text}</span>
            {count !== undefined && <span className="cx-n">{count.toLocaleString()}</span>}
          </button>
        );
      })}
    </ScrollStrip>
  );
}
