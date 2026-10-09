import { clsx } from "clsx";
import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState, type ReactNode } from "react";

/** Sections the user opened / closed, remembered for the session (so moving between shots keeps the layout they chose). */
const remembered = new Map<string, boolean>();

/**
 * A titled instrument block that folds. Used for the inspector's sections so a long shot form stays scannable:
 * the header (an eyebrow title, an icon chip, a count and a one-line summary) says what is inside even when closed.
 * `memo` is a stable name: when given, the open / closed choice is remembered.
 */
export function Collapse({ title, icon, badge, summary, actions, defaultOpen = true, children, className, flush, memo }: {
  title: ReactNode; icon?: ReactNode; badge?: ReactNode; summary?: ReactNode; actions?: ReactNode; defaultOpen?: boolean;
  children: ReactNode; className?: string; flush?: boolean; memo?: string;
}) {
  const [open, setOpen] = useState(() => (memo ? remembered.get(memo) : undefined) ?? defaultOpen);
  const id = useId();
  const toggle = () => setOpen((o) => { if (memo) remembered.set(memo, !o); return !o; });
  return (
    <section className={clsx("hud relative rounded-xl border bg-panel/70 transition-colors", open ? "border-line" : "border-line/80", className)}>
      <span aria-hidden className={clsx("edge-light pointer-events-none absolute inset-x-4 top-0 h-px transition-opacity duration-300", open ? "opacity-60" : "opacity-0")} />
      <div className="flex items-center gap-1 pr-2">
        <button type="button" aria-expanded={open} aria-controls={id} onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
          {icon && (
            <span className={clsx("grid size-6 shrink-0 place-items-center rounded-md border transition-colors [&>svg]:size-3.5",
              open ? "border-accent/30 bg-accent/10 text-accent-ink" : "border-line bg-raised text-mute")}>{icon}</span>
          )}
          <span className="eyebrow shrink-0 !text-ink">{title}</span>
          {badge}
          {summary ? <span className="min-w-0 flex-1 truncate text-2xs text-dim">{summary}</span> : <span className="flex-1" />}
          <ChevronDown className={clsx("size-4 shrink-0 text-dim transition-transform duration-200", open && "rotate-180")} />
        </button>
        {actions}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div id={id} key="body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
            <div className={clsx("border-t border-line/70", !flush && "p-3")}>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
