import { clsx } from "clsx";
import { CheckCircle2, RotateCcw, Save } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { Button } from "../../../components/ui";
import { useT } from "../../../lib/i18n";

/**
 * Floating "unsaved changes" bar. Sticks to the bottom of the page scroller without taking up layout space,
 * slides up while there is something to save and briefly turns into a "Saved" confirmation afterwards.
 * Put it as the last child of the page content (and leave ~5rem of bottom padding).
 */
export function UnsavedBar({ show, saved, message, error, saving, onDiscard, onSave, saveLabel, savedLabel, extra, className }: {
  show: boolean; saved?: boolean; message: ReactNode; error?: ReactNode; saving?: boolean;
  onDiscard: () => void; onSave: () => void; saveLabel?: ReactNode; savedLabel?: ReactNode; extra?: ReactNode; className?: string;
}) {
  const t = useT();
  const visible = show || !!saved;
  return (
    <div className={clsx("pointer-events-none sticky bottom-4 z-20 h-0", className)}>
      <AnimatePresence>
        {visible && (
          <motion.div
            key="bar" role="status" aria-live="polite"
            initial={{ y: 30, opacity: 0, scale: 0.98 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: 20, opacity: 0, transition: { duration: 0.16, ease: "easeIn" } }}
            transition={{ type: "spring", stiffness: 430, damping: 36, mass: 0.8 }}
            className={clsx(
              "pointer-events-auto absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-raised/95 px-4 py-2.5 shadow-pop backdrop-blur-md transition-colors duration-300",
              show ? "border-accent/35" : "border-ok/40",
            )}
          >
            <AnimatePresence mode="wait" initial={false}>
              {show ? (
                <motion.div key="dirty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                    <span aria-hidden className={clsx("size-2 shrink-0 rounded-full", error ? "bg-bad" : "bg-warn")} />
                    <span className={clsx("min-w-0", error && "text-red-300")}>{error ?? message}</span>
                  </span>
                  {extra}
                  <div className="flex shrink-0 gap-2">
                    <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={onDiscard} disabled={saving}>{t("Discard")}</Button>
                    <Button variant="primary" icon={<Save className="size-4" />} loading={saving} disabled={!!error} onClick={onSave}>{saveLabel ?? t("Save changes")}</Button>
                  </div>
                </motion.div>
              ) : (
                <motion.div key="saved" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
                  className="flex items-center gap-2 py-1 text-sm font-medium text-green-300">
                  <CheckCircle2 className="size-4" />{savedLabel ?? t("All changes saved")}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
