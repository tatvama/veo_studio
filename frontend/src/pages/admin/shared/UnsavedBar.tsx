import { clsx } from "clsx";
import { CheckCircle2, RotateCcw, Save, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { Button } from "../../../components/ui";
import { useT } from "../../../lib/i18n";

/**
 * The docked console bar: sticks to the bottom of the page scroller without taking up layout space, slides up while there
 * is something to save ("N unsaved" + the message, Discard, one primary Save) and briefly turns into a "Saved" confirmation afterwards.
 * Put it as the last child of the page content (and leave ~5rem of bottom padding).
 * `count` adds a mono counter chip, `shortcut` a keyboard hint (e.g. Ctrl S) next to the buttons; both are optional.
 */
export function UnsavedBar({ show, saved, message, error, saving, onDiscard, onSave, saveLabel, savedLabel, extra, className, count, shortcut }: {
  show: boolean; saved?: boolean; message: ReactNode; error?: ReactNode; saving?: boolean;
  onDiscard: () => void; onSave: () => void; saveLabel?: ReactNode; savedLabel?: ReactNode; extra?: ReactNode; className?: string;
  count?: number; shortcut?: ReactNode;
}) {
  const t = useT();
  const visible = show || !!saved;
  return (
    <div className={clsx("pointer-events-none sticky bottom-3 z-20 h-0 max-sm:bottom-2", className)}>
      <div className="absolute inset-x-0 bottom-0">
        <AnimatePresence>
          {visible && (
            <motion.div
              key="bar" role="status" aria-live="polite"
              initial={{ y: 30, opacity: 0, scale: 0.98 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: 20, opacity: 0, transition: { duration: 0.16, ease: "easeIn" } }}
              transition={{ type: "spring", stiffness: 430, damping: 36, mass: 0.8 }}
              className={clsx(
                "hud pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-panel/95 px-3.5 py-2 shadow-pop backdrop-blur-md transition-colors duration-300",
                show ? (error ? "border-bad/40" : "border-warn/35") : "border-ok/40",
              )}
            >
              <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-70" />
              <AnimatePresence mode="wait" initial={false}>
                {show ? (
                  <motion.div key="dirty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}
                    className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="flex min-w-0 flex-1 items-center gap-2.5 text-sm max-sm:basis-full">
                      {error ? <TriangleAlert aria-hidden className="size-4 shrink-0 text-bad" /> : <span aria-hidden className="live-dot is-warn shrink-0" />}
                      {count !== undefined && !error && (
                        <span className="mono shrink-0 rounded-md border border-warn/30 bg-warn/10 px-1.5 py-0.5 text-2xs font-medium leading-none text-amber-300">{count}</span>
                      )}
                      <span className={clsx("min-w-0", error && "text-red-300")}>{error ?? message}</span>
                    </span>
                    {extra}
                    <div className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:justify-end">
                      {shortcut && <span className="hidden items-center gap-1 text-2xs text-dim md:flex" aria-hidden>{shortcut}</span>}
                      <Button variant="ghost" className="max-sm:h-10" icon={<RotateCcw className="size-4" />} onClick={onDiscard} disabled={saving}>{t("Discard")}</Button>
                      <Button variant="primary" className="max-sm:h-10" icon={<Save className="size-4" />} loading={saving} disabled={!!error} onClick={onSave}>{saveLabel ?? t("Save changes")}</Button>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div key="saved" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
                    className="flex items-center gap-2 py-1.5 text-sm font-medium text-green-300">
                    <CheckCircle2 className="size-4" />{savedLabel ?? t("All changes saved")}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
