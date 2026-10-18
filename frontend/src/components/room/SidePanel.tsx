import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { PanelChromeProvider, type PanelChrome } from "./workspace";

/**
 * One part of a details panel (the Cast's right-hand column): a 44 px heading row with an icon, the title, a short summary
 * on the right and a chevron; the body folds open under it. WorkPanels inside draw without their card (`chrome`).
 */
export function SideSection({ id, icon, title, summary, defaultOpen = false, chrome = "bare", children, className }: {
  id?: string; icon?: ReactNode; title: ReactNode; summary?: ReactNode; defaultOpen?: boolean; chrome?: PanelChrome; children: ReactNode; className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section id={id} className={cn("scroll-mt-2 border-b border-line last:border-b-0", className)}>
      <h2>
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}
          className="flex min-h-11 w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-hover/40 focus-visible:bg-hover/40 focus-visible:outline-none">
          {icon && <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md border border-line bg-raised text-mute [&>svg]:size-3.5">{icon}</span>}
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">{title}</span>
          {summary !== undefined && summary !== null && summary !== "" && <span className="min-w-0 max-w-[45%] shrink-0 truncate text-right text-xs text-mute">{summary}</span>}
          <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-dim transition-transform duration-200", open && "rotate-180")} />
        </button>
      </h2>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div id={bodyId} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
            <div className="@container px-4 pb-4 pt-1"><PanelChromeProvider chrome={chrome}>{children}</PanelChromeProvider></div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
