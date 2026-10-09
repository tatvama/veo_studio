import { clsx } from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Popover } from "../../../../components/ui";
import { useT } from "../../../../lib/i18n";

/** Where a context menu opens: at a point (right-click) or next to an element (the "…" button, the keyboard). */
export type MenuAnchor = { x: number; y: number } | HTMLElement;

export interface CtxItem {
  label: ReactNode; icon?: ReactNode; hint?: ReactNode; onClick?: () => void; disabled?: boolean; danger?: boolean;
  /** A divider above this item. */
  separator?: boolean; active?: boolean;
  /** A submenu (opens as a page inside the menu, with a back row). */
  children?: CtxItem[];
}

/**
 * Right-click menu with submenus. Arrow keys move, → opens a submenu, ← / Backspace go back, Enter / Space choose,
 * Esc closes. Submenus are shown as pages inside the same panel (no flyouts), so they also work on touch.
 */
export function ContextMenu({ open, anchor, onClose, items, width = 248, label, returnFocus }: {
  open: boolean; anchor: MenuAnchor | null; onClose: () => void; items: (CtxItem | false | null | undefined)[]; width?: number;
  /** Accessible name of the menu. */ label: string;
  /** Element to focus again once the menu closes (the clip that opened it). */ returnFocus?: HTMLElement | null;
}) {
  const t = useT();
  const vref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [path, setPath] = useState<number[]>([]);
  const [cursor, setCursor] = useState(0);
  const point = anchor && !(anchor instanceof HTMLElement) ? anchor : null;
  // Popover reads anchor.current when it lays itself out: resolve the virtual point lazily so it is mounted by then
  const anchorRef = useMemo(() => ({ get current() { return anchor instanceof HTMLElement ? anchor : vref.current; } }), [anchor]);

  const root = items.filter(Boolean) as CtxItem[];
  const trail: CtxItem[] = [];
  let list = root;
  for (const i of path) {
    const it = list[i];
    if (!it?.children) break;
    trail.push(it);
    list = it.children;
  }
  const firstEnabled = (l: CtxItem[]) => Math.max(0, l.findIndex((i) => !i.disabled));

  useEffect(() => {
    if (!open) return;
    setPath([]);
    setCursor(firstEnabled(root));
    const id = window.setTimeout(() => panel.current?.focus({ preventScroll: true }), 20);
    return () => window.clearTimeout(id);
  }, [open]);

  const close = () => {
    onClose();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  const enter = (i: number) => {
    const it = list[i];
    if (!it || it.disabled) return;
    if (it.children) { setPath([...path, i]); setCursor(firstEnabled(it.children)); return; }
    close();
    it.onClick?.();
  };
  const back = () => {
    const next = path.slice(0, -1);
    const last = path[path.length - 1] ?? 0;
    setPath(next);
    setCursor(last);
  };
  const key = (e: RKeyboardEvent) => {
    const n = list.length;
    if (!n) return;
    const move = (dir: 1 | -1) => {
      let c = cursor;
      for (let k = 0; k < n; k++) { c = (c + dir + n) % n; if (!list[c].disabled) break; }
      setCursor(c);
    };
    switch (e.key) {
      case "ArrowDown": move(1); break;
      case "ArrowUp": move(-1); break;
      case "Home": setCursor(firstEnabled(list)); break;
      case "End": setCursor(n - 1); break;
      case "ArrowRight": if (list[cursor]?.children) enter(cursor); else return; break;
      case "ArrowLeft": case "Backspace": if (path.length) back(); else return; break;
      case "Enter": case " ": enter(cursor); break;
      case "Escape": if (path.length) { back(); break; } return;  // the popover closes on Esc at the top level
      case "Tab": close(); return;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
      {point && createPortal(<div ref={vref} aria-hidden className="pointer-events-none fixed size-0" style={{ left: point.x, top: point.y }} />, document.body)}
      <Popover open={open && !!anchor} onClose={close} anchor={anchorRef} placement="bottom-start" width={width} className="p-1">
        <div ref={panel} role="menu" aria-label={label} tabIndex={-1} onKeyDown={key} className="flex max-h-[min(70vh,440px)] flex-col overflow-y-auto outline-none">
          {trail.length > 0 && (
            <button type="button" role="menuitem" onClick={back} onMouseEnter={() => setCursor(-1)}
              className="eyebrow mb-1 flex w-full items-center gap-2 rounded-md border-b border-line px-2 py-1.5 text-left !text-mute hover:bg-hover hover:!text-ink">
              <ChevronLeft className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{trail[trail.length - 1].label}</span>
              <span className="text-2xs font-normal text-dim">{t("Back")}</span>
            </button>
          )}
          {list.map((it, i) => (
            <div key={i}>
              {it.separator && i > 0 && <div className="my-1 h-px bg-line" />}
              <button type="button" role="menuitem" tabIndex={-1} disabled={it.disabled} aria-disabled={it.disabled || undefined}
                aria-haspopup={it.children ? "menu" : undefined} onMouseEnter={() => setCursor(i)} onClick={() => enter(i)}
                className={clsx("flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors disabled:opacity-40",
                  i === cursor && "bg-hover", it.danger ? "text-bad" : it.active ? "text-accent-ink" : "text-ink")}>
                {it.icon && <span className="grid size-4 shrink-0 place-items-center text-mute">{it.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.hint && <span className="mono shrink-0 text-2xs tabular-nums text-dim">{it.hint}</span>}
                {it.children && <ChevronRight className="size-3.5 shrink-0 text-dim" />}
              </button>
            </div>
          ))}
          {!list.length && <p className="px-2.5 py-2 text-xs text-dim">{t("Nothing here yet.")}</p>}
        </div>
      </Popover>
    </>
  );
}
