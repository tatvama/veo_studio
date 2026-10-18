import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { Link } from "react-router-dom";
import { ScrollStrip, Tooltip } from "../../components/ui";

export interface Segment {
  /** What `active` is compared with; `to` is the page under /p/:pid/ the segment opens. */
  key: string; to: string; label: string; icon: LucideIcon;
  tour?: string; tip?: string;
}

/**
 * Links as a segmented control; the lit one glides between them. `labels` sets when the names show (a class such as
 * "hidden @5xl:inline"), for every link or, with `keepActive`, for all but the lit one; hidden names become tooltips.
 */
export function SegmentedLinks({ pid, items, active, layoutId, label, labels, keepActive, className }: {
  pid: number; items: Segment[]; active?: string; layoutId: string; label: string; labels?: string; keepActive?: boolean; className?: string;
}) {
  return (
    <ScrollStrip className={clsx("min-w-0 max-w-full", className)} role="navigation" aria-label={label}>
      <div className="inline-flex gap-0.5 rounded-lg border border-line bg-panel p-0.5">
        {items.map((x) => {
          const on = x.key === active;
          const hide = keepActive && on ? undefined : labels;
          const link = (
            <Link key={x.key} to={`/p/${pid}/${x.to}`} aria-current={on ? "page" : undefined} data-tour={x.tour} aria-label={hide ? x.label : undefined}
              className={clsx("relative flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50",
                on ? "text-ink" : "text-mute hover:text-ink")}>
              {on && (
                <motion.span layoutId={layoutId} transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.7 }}
                  className="absolute inset-0 rounded-md bg-raised shadow-[0_0_0_1px_var(--color-line),0_0_12px_-6px_var(--color-accent)]">
                  <span aria-hidden className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />
                </motion.span>
              )}
              <x.icon className="relative size-4" />
              <span className={clsx("relative", hide)}>{x.label}</span>
            </Link>
          );
          const tip = x.tip ?? (hide ? x.label : undefined);
          return tip ? <Tooltip key={x.key} content={tip} side="bottom" delay={hide ? 150 : 700}>{link}</Tooltip> : link;
        })}
      </div>
    </ScrollStrip>
  );
}
