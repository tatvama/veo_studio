import { cn } from "../../lib/cn";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Moves focus into the panel, keeps Tab inside it and hands focus back to whatever opened it. */
function useFocusTrap(active: boolean, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const id = window.setTimeout(() => {
      const root = ref.current;
      if (!root || root.contains(document.activeElement)) return;
      (root.querySelector<HTMLElement>("[data-autofocus]") ?? root).focus({ preventScroll: true });
    }, 40);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const root = ref.current;
      if (!root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) { e.preventDefault(); root.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("keydown", key);
      previous?.focus?.({ preventScroll: true });
    };
  }, [active, ref]);
}

/**
 * Right-hand spec sheet that springs in over a dimmed backdrop. Escape and a click on the backdrop call `onClose`
 * (the caller decides whether to confirm). On phones it fills the screen.
 */
export function SlideOver({ open, onClose, label, children, width = 600 }: {
  open: boolean; onClose: () => void; label: string; children: ReactNode; width?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const labelId = useId();
  useFocusTrap(open, panel);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <motion.div key="backdrop" className="veo-backdrop absolute inset-0 backdrop-blur-[2px]" onMouseDown={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
          <motion.aside
            key="panel" ref={panel} role="dialog" aria-modal="true" aria-labelledby={labelId} tabIndex={-1}
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 380, damping: 40, mass: 0.9 }}
            style={{ maxWidth: width }}
            className={cn("relative flex h-full w-full flex-col border-l border-line bg-panel outline-none")}
          >
            <span aria-hidden className="edge-light pointer-events-none absolute inset-x-0 top-0 z-30 h-px" />
            <span id={labelId} className="sr-only">{label}</span>
            {children}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
