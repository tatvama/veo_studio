import { clsx } from "clsx";
import type { ReactNode } from "react";

/** Toggleable filter pill with an optional icon and count. Used by the project and search filters. */
export function FilterChip({ active, onClick, children, count, icon, title, className }: {
  active: boolean; onClick: () => void; children: ReactNode; count?: number | string; icon?: ReactNode; title?: string; className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        "inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-xs font-medium transition-[color,background-color,border-color,transform] duration-150 active:scale-95 sm:h-8 sm:px-3",
        active ? "border-accent/50 bg-accent/12 text-ink" : "border-line bg-panel text-mute hover:border-dim/50 hover:bg-hover hover:text-ink",
        className,
      )}
    >
      {icon && <span className={clsx("grid shrink-0 place-items-center [&>svg]:size-3.5", active ? "text-accent-ink" : "text-dim")}>{icon}</span>}
      {children}
      {count !== undefined && count !== "" && <span className={clsx("tabular-nums", active ? "text-accent-ink" : "text-dim")}>{count}</span>}
    </button>
  );
}

/** Dark translucent pill that stays readable on top of any picture, in both themes. */
export function MediaPill({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={clsx("inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-1 text-2xs font-medium leading-none text-white backdrop-blur-sm", className)}>
      {children}
    </span>
  );
}

/** Small uppercase label used above groups of controls. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={clsx("text-2xs font-semibold uppercase tracking-[0.1em] text-dim", className)}>{children}</p>;
}
