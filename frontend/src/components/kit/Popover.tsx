import { cn } from "../../lib/cn";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end" | "right-start" | "right-end" | "left-start" | "left-end";
const GAP = 6;
const MARGIN = 8;

/**
 * Floating panel anchored to another element (portal, flips when there's no room, closes on outside click / Esc).
 *   const ref = useRef(null);  <button ref={ref}/>  <Popover open anchor={ref} onClose placement="bottom-end">…</Popover>
 */
export function Popover({ open, onClose, anchor, placement = "bottom-start", children, className, width, matchWidth }: {
  open: boolean; onClose: () => void; anchor: RefObject<HTMLElement | null>; placement?: Placement; children: ReactNode;
  className?: string; width?: number; matchWidth?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string; minWidth?: number } | null>(null);

  const compute = useCallback(() => {
    const a = anchor.current;
    const p = panel.current;
    if (!a || !p) return;
    const r = a.getBoundingClientRect();
    const w = p.offsetWidth, h = p.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let [main, cross] = placement.split("-") as ["bottom" | "top" | "left" | "right", "start" | "end"];
    // flip on the main axis when there's no room
    if (main === "bottom" && r.bottom + GAP + h > vh - MARGIN && r.top - GAP - h > MARGIN) main = "top";
    else if (main === "top" && r.top - GAP - h < MARGIN && r.bottom + GAP + h < vh - MARGIN) main = "bottom";
    else if (main === "right" && r.right + GAP + w > vw - MARGIN && r.left - GAP - w > MARGIN) main = "left";
    else if (main === "left" && r.left - GAP - w < MARGIN && r.right + GAP + w < vw - MARGIN) main = "right";
    let left: number, top: number;
    if (main === "bottom" || main === "top") {
      top = main === "bottom" ? r.bottom + GAP : r.top - GAP - h;
      left = cross === "start" ? r.left : r.right - w;
    } else {
      left = main === "right" ? r.right + GAP : r.left - GAP - w;
      top = cross === "start" ? r.top : r.bottom - h;
    }
    left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
    top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN));
    const origin = `${main === "right" ? "left" : main === "left" ? "right" : cross === "start" ? "left" : "right"} ${main === "bottom" ? "top" : main === "top" ? "bottom" : cross === "start" ? "top" : "bottom"}`;
    setPos({ left, top, origin, minWidth: matchWidth ? r.width : undefined });
  }, [anchor, placement, matchWidth]);

  useLayoutEffect(() => { if (open) compute(); else setPos(null); }, [open, compute, children]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); anchor.current?.focus?.(); } };
    const reflow = () => compute();
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", reflow);
    window.addEventListener("scroll", reflow, true);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", reflow);
      window.removeEventListener("scroll", reflow, true);
    };
  }, [open, onClose, anchor, compute]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panel}
          role="dialog"
          initial={{ opacity: 0, scale: 0.97, y: -4 }}
          animate={{ opacity: pos ? 1 : 0, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
          transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
          style={{ position: "fixed", left: pos?.left ?? 0, top: pos?.top ?? 0, width, minWidth: pos?.minWidth, transformOrigin: pos?.origin }}
          className={cn("z-[80] rounded-xl border border-line bg-raised shadow-pop", className)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export interface MenuItemDef {
  label: ReactNode; icon?: ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean; shortcut?: ReactNode;
  /** Renders a divider above this item. */
  separator?: boolean; active?: boolean;
}

/** Dropdown menu: `<Menu trigger={(props) => <IconButton {...props}/>} items={[…]} />`. Arrow keys + Enter work. */
export function Menu({ trigger, items, placement = "bottom-end", width = 208 }: {
  trigger: (p: { ref: RefObject<HTMLButtonElement | null>; onClick: () => void; "aria-haspopup": "menu"; "aria-expanded": boolean }) => ReactNode;
  items: (MenuItemDef | false | null | undefined)[]; placement?: Placement; width?: number;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const list = items.filter(Boolean) as MenuItemDef[];
  const close = useCallback(() => setOpen(false), []);

  // The latest items/cursor, read by the key handler without re-subscribing on every change.
  const live = useRef({ list, cursor });
  live.current = { list, cursor };

  // Start on the first enabled item each time the menu opens.
  useEffect(() => {
    if (open) setCursor(Math.max(0, live.current.list.findIndex((i) => !i.disabled)));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      const { list: l, cursor: c } = live.current;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        let n = c;
        for (let k = 0; k < l.length; k++) { n = (n + dir + l.length) % l.length; if (!l[n].disabled) break; }
        setCursor(n);
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        setCursor(e.key === "Home" ? 0 : l.length - 1);
      } else if (e.key === "Enter") {
        const it = l[c];
        if (it && !it.disabled) { e.preventDefault(); close(); it.onClick?.(); }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, close]);

  return (
    <>
      {trigger({ ref, onClick: () => setOpen((v) => !v), "aria-haspopup": "menu", "aria-expanded": open })}
      <Popover open={open} onClose={close} anchor={ref} placement={placement} width={width} className="p-1">
        <div role="menu" className="flex flex-col">
          {list.map((it, i) => (
            <div key={i}>
              {it.separator && i > 0 && <div className="my-1 h-px bg-line" />}
              <button
                role="menuitem"
                disabled={it.disabled}
                onMouseEnter={() => setCursor(i)}
                onClick={() => { close(); it.onClick?.(); }}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors disabled:opacity-40",
                  i === cursor && "bg-hover",
                  it.danger ? "text-bad" : it.active ? "text-accent-ink" : "text-ink",
                )}
              >
                {it.icon && <span className="grid size-4 shrink-0 place-items-center text-mute">{it.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.shortcut && <span className="flex shrink-0 gap-0.5 text-dim">{it.shortcut}</span>}
              </button>
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}
