import { cn } from "../../lib/cn";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Side = "top" | "bottom" | "left" | "right";

/** After one tooltip has just closed, the next one opens instantly (like native toolbars). */
let lastClosed = 0;
const GAP = 8;
const MARGIN = 8;

interface Placed { rect: DOMRect; side: Side }

/**
 * Hover / keyboard-focus tooltip for the single element inside it.
 * Renders in a portal (never clipped by overflow), flips when there's no room and stays inside the viewport.
 * Touch devices don't get hover tooltips.
 */
export function Tooltip({ content, children, side = "top", delay = 380, shortcut, disabled, className }: {
  content: ReactNode; children: ReactNode; side?: Side; delay?: number; shortcut?: ReactNode; disabled?: boolean; className?: string;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [shift, setShift] = useState({ x: 0, y: 0 });

  const place = useCallback(() => {
    const el = anchor.current?.firstElementChild as HTMLElement | null;
    if (!el || !el.isConnected) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    let s = side;
    if (s === "top" && rect.top < 56) s = "bottom";
    else if (s === "bottom" && window.innerHeight - rect.bottom < 56) s = "top";
    else if (s === "right" && window.innerWidth - rect.right < 220) s = "left";
    else if (s === "left" && rect.left < 220) s = "right";
    setShift({ x: 0, y: 0 });
    setPlaced({ rect, side: s });
  }, [side]);

  const show = useCallback(() => {
    if (disabled || !content) return;
    window.clearTimeout(timer.current);
    const wait = Date.now() - lastClosed < 450 ? 0 : delay;
    timer.current = window.setTimeout(place, wait);
  }, [content, delay, disabled, place]);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setPlaced((p) => { if (p) lastClosed = Date.now(); return null; });
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Keep the bubble inside the viewport (measured after it mounts).
  useLayoutEffect(() => {
    if (!placed || !bubble.current) return;
    const b = bubble.current.getBoundingClientRect();
    let x = 0, y = 0;
    if (b.left < MARGIN) x = MARGIN - b.left;
    else if (b.right > window.innerWidth - MARGIN) x = window.innerWidth - MARGIN - b.right;
    if (b.top < MARGIN) y = MARGIN - b.top;
    else if (b.bottom > window.innerHeight - MARGIN) y = window.innerHeight - MARGIN - b.bottom;
    if (x || y) setShift({ x, y });
  }, [placed]);

  useEffect(() => {
    if (!placed) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide); };
  }, [placed, hide]);

  // Describe the child for screen readers while the tooltip is open.
  useEffect(() => {
    const el = anchor.current?.firstElementChild;
    if (!el) return;
    if (placed) el.setAttribute("aria-describedby", id);
    else if (el.getAttribute("aria-describedby") === id) el.removeAttribute("aria-describedby");
  }, [placed, id]);

  let style: React.CSSProperties = {};
  let origin = "center bottom";
  let enter = { x: 0, y: 4 };
  if (placed) {
    const { rect, side: s } = placed;
    if (s === "top") { style = { left: rect.left + rect.width / 2, top: rect.top - GAP, transform: "translate(-50%, -100%)" }; origin = "center bottom"; enter = { x: 0, y: 4 }; }
    if (s === "bottom") { style = { left: rect.left + rect.width / 2, top: rect.bottom + GAP, transform: "translate(-50%, 0)" }; origin = "center top"; enter = { x: 0, y: -4 }; }
    if (s === "right") { style = { left: rect.right + GAP, top: rect.top + rect.height / 2, transform: "translate(0, -50%)" }; origin = "left center"; enter = { x: -4, y: 0 }; }
    if (s === "left") { style = { left: rect.left - GAP, top: rect.top + rect.height / 2, transform: "translate(-100%, -50%)" }; origin = "right center"; enter = { x: 4, y: 0 }; }
  }

  return (
    <>
      <span
        ref={anchor}
        style={{ display: "contents" }}
        onPointerEnter={(e) => { if (e.pointerType !== "touch") show(); }}
        onPointerLeave={hide}
        onPointerDown={hide}
        onFocusCapture={(e) => { if ((e.target as HTMLElement).matches?.(":focus-visible")) show(); }}
        onBlurCapture={hide}
      >
        {children}
      </span>
      {createPortal(
        <AnimatePresence>
          {placed && (
            <div className="pointer-events-none fixed z-[90]" style={{ ...style, translate: `${shift.x}px ${shift.y}px` }}>
              <motion.div
                ref={bubble}
                id={id}
                role="tooltip"
                initial={{ opacity: 0, scale: 0.96, ...enter }}
                animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.08 } }}
                transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                style={{ transformOrigin: origin }}
                className={cn(
                  "flex max-w-[280px] items-center gap-2 rounded-md border border-line bg-raised/95 px-2.5 py-1.5 text-xs font-medium leading-snug text-ink shadow-pop backdrop-blur-md",
                  className,
                )}
              >
                <span>{content}</span>
                {shortcut && <span className="flex shrink-0 items-center gap-0.5 text-dim">{shortcut}</span>}
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
