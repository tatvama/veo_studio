/** Right-click menu for the canvas, positioned at the pointer and kept inside the viewport. Arrow keys and Enter work. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../../lib/cn";

export interface CtxItem {
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** divider above this item */
  separator?: boolean;
  tone?: "ai";
}

export function ContextMenu({ at, items, onClose }: { at: { x: number; y: number }; items: CtxItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  const [cursor, setCursor] = useState(() => items.findIndex((i) => !i.disabled));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, m = 8;
    setPos({ x: Math.max(m, Math.min(at.x, window.innerWidth - w - m)), y: Math.max(m, Math.min(at.y, window.innerHeight - h - m)) });
  }, [at]);

  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        setCursor((c) => {
          let n = c;
          for (let k = 0; k < items.length; k++) { n = (n + dir + items.length) % items.length; if (!items[n].disabled) break; }
          return n;
        });
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const it = items[cursor];
        if (it && !it.disabled) { onClose(); it.onClick(); }
      }
    };
    const close = () => onClose();
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("wheel", close);
    };
  }, [items, cursor, onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="pst-ctx hud fixed z-[85] min-w-[220px] rounded-xl border border-line bg-raised p-1 shadow-pop"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (
        <div key={i}>
          {it.separator && i > 0 && <div className="my-1 h-px bg-line" />}
          <button
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onMouseEnter={() => setCursor(i)}
            onClick={() => { onClose(); it.onClick(); }}
            className={cn(
              "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors disabled:opacity-40",
              i === cursor && !it.disabled && "bg-hover",
              it.danger ? "text-bad" : it.tone === "ai" ? "text-ai" : "text-ink",
            )}
          >
            <span className={cn("grid size-4 shrink-0 place-items-center", it.tone === "ai" ? "text-ai" : "text-mute")}>{it.icon}</span>
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.shortcut && <span className="mono shrink-0 text-2xs text-dim">{it.shortcut}</span>}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
