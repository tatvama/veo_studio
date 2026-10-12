/**
 * Small controls shared by the editor's panels: the context menu (one host, nested submenus, keyboard), a timecode
 * field you can type into, a number you scrub by dragging, and a compact icon button with a tooltip.
 */
import { clsx } from "clsx";
import { Check, ChevronRight } from "lucide-react";
import { forwardRef, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Tooltip } from "../components/ui";
import { parseTimecode, toTimecode } from "./model/time";

// ── context menu ─────────────────────────────────────────────────────────────

export interface MenuItem {
  label?: ReactNode; icon?: ReactNode; shortcut?: string; onClick?: () => void; disabled?: boolean; danger?: boolean; checked?: boolean;
  separator?: boolean; hint?: ReactNode;
  /** A submenu (or a promise of one, loaded when it opens). */
  items?: MenuItem[] | (() => Promise<MenuItem[]>);
}

let menuState: { x: number; y: number; items: MenuItem[] } | null = null;
const menuSubs = new Set<() => void>();
const emitMenu = () => menuSubs.forEach((f) => f());

/** Opens the context menu at the pointer (or at an element). */
export function openMenu(at: { clientX: number; clientY: number } | DOMRect, items: (MenuItem | false | null | undefined)[]) {
  const list = items.filter(Boolean) as MenuItem[];
  if (!list.length) return;
  const x = "clientX" in at ? at.clientX : at.left, y = "clientY" in at ? at.clientY : at.bottom + 2;
  menuState = { x, y, items: list };
  emitMenu();
}
export const closeMenu = () => { if (menuState) { menuState = null; emitMenu(); } };

/** Mount once (EditorApp / EditorHome). */
export function MenuHost() {
  const st = useSyncExternalStore((cb) => { menuSubs.add(cb); return () => { menuSubs.delete(cb); }; }, () => menuState, () => menuState);
  useEffect(() => {
    if (!st) return;
    const down = (e: MouseEvent) => { if (!(e.target as Element).closest?.("[data-ctxmenu]")) closeMenu(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); closeMenu(); } };
    const blur = () => closeMenu();
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", blur);
    return () => { window.removeEventListener("mousedown", down, true); window.removeEventListener("keydown", key, true); window.removeEventListener("blur", blur); window.removeEventListener("resize", blur); };
  }, [st]);
  if (!st) return null;
  return createPortal(<MenuList items={st.items} x={st.x} y={st.y} root />, document.body);
}

function MenuList({ items, x, y, root, flipX }: { items: MenuItem[]; x: number; y: number; root?: boolean; flipX?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y, ready: false });
  const [open, setOpen] = useState<number | null>(null);
  const [cursor, setCursor] = useState(-1);
  const [sub, setSub] = useState<{ i: number; items: MenuItem[]; x: number; y: number; flipX: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    let nx = x, ny = y;
    if (nx + w > window.innerWidth - 6) nx = flipX !== undefined ? flipX - w : window.innerWidth - w - 6;
    if (ny + h > window.innerHeight - 6) ny = Math.max(6, window.innerHeight - h - 6);
    setPos({ x: Math.max(6, nx), y: ny, ready: true });
  }, [x, y, flipX, items]);
  useEffect(() => { if (root) ref.current?.focus(); }, [root]);
  const openSub = async (i: number, el: HTMLElement) => {
    const it = items[i];
    if (!it.items) { setSub(null); return; }
    const r = el.getBoundingClientRect();
    setOpen(i);
    const list = typeof it.items === "function" ? await it.items() : it.items;
    setSub({ i, items: list.length ? list : [{ label: "Nothing here", disabled: true }], x: r.right - 2, y: r.top - 4, flipX: r.left + 2 });
  };
  const run = (it: MenuItem) => { if (it.disabled || it.items) return; closeMenu(); it.onClick?.(); };
  const focusable = items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter((i) => i >= 0);
  return (
    <>
      <div ref={ref} data-ctxmenu role="menu" tabIndex={-1}
        className="hud fixed z-[90] min-w-[200px] max-w-[320px] rounded-lg border border-line bg-raised py-1 text-xs shadow-pop outline-none"
        style={{ left: pos.x, top: pos.y, opacity: pos.ready ? 1 : 0 }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const k = focusable.indexOf(cursor);
            const n = focusable[(k + (e.key === "ArrowDown" ? 1 : -1) + focusable.length) % focusable.length];
            setCursor(n ?? -1);
          } else if (e.key === "Enter" && cursor >= 0) { e.preventDefault(); run(items[cursor]); }
          else if (e.key === "ArrowRight" && cursor >= 0 && items[cursor].items) { const el = ref.current?.querySelectorAll<HTMLElement>("[data-mi]")[cursor]; if (el) void openSub(cursor, el); }
          else if (e.key === "ArrowLeft" && !root) closeMenu();
        }}>
        {items.map((it, i) => it.separator && !it.label ? <div key={i} className="my-1 h-px bg-line" /> : (
          <div key={i}>
            {it.separator && <div className="my-1 h-px bg-line" />}
            <button type="button" data-mi role="menuitem" disabled={it.disabled}
              onMouseEnter={(e) => { setCursor(i); if (it.items) void openSub(i, e.currentTarget); else { setSub(null); setOpen(null); } }}
              onClick={(e) => { if (it.items) void openSub(i, e.currentTarget); else run(it); }}
              className={clsx("flex w-full items-center gap-2 px-2.5 py-1.5 text-left disabled:opacity-40",
                (cursor === i || open === i) && !it.disabled && "bg-hover", it.danger ? "text-red-300" : "text-ink")}>
              <span className="grid size-3.5 shrink-0 place-items-center text-mute">{it.checked ? <Check className="size-3.5 text-accent-ink" /> : it.icon}</span>
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.hint && <span className="shrink-0 text-2xs text-dim">{it.hint}</span>}
              {it.shortcut && <span className="mono shrink-0 pl-3 text-2xs text-dim">{it.shortcut}</span>}
              {it.items && <ChevronRight className="size-3.5 shrink-0 text-dim" />}
            </button>
          </div>
        ))}
      </div>
      {sub && <MenuList key={sub.i} items={sub.items} x={sub.x} y={sub.y} flipX={sub.flipX} />}
    </>
  );
}

// ── timecode ─────────────────────────────────────────────────────────────────

/** A timecode readout; click (or focus + Enter) to type a new one. `frame` may be a live value. */
export function TimecodeField({ frame, fps, onChange, className, title, size = "md" }: {
  frame: number; fps: number; onChange?: (f: number) => void; className?: string; title?: string; size?: "sm" | "md" | "lg";
}) {
  const [edit, setEdit] = useState<string | null>(null);
  const text = toTimecode(frame, fps);
  const cls = clsx("ed-tc tabular-nums", size === "lg" ? "text-base" : size === "sm" ? "text-2xs" : "text-xs", className);
  if (edit !== null && onChange) {
    return (
      <input autoFocus value={edit} onChange={(e) => setEdit(e.target.value)} onBlur={() => setEdit(null)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") { const f = parseTimecode(edit, fps, frame); if (f !== null) onChange(Math.max(0, f)); setEdit(null); }
          if (e.key === "Escape") setEdit(null);
        }}
        className={clsx("ed-field w-[7.5rem]", cls)} />
    );
  }
  return (
    <button type="button" title={title ?? (onChange ? "Click to type a timecode (or +/- frames)" : undefined)} disabled={!onChange}
      onClick={() => setEdit(text)} className={clsx(cls, "rounded px-1 disabled:cursor-default", onChange && "hover:bg-hover")}>
      {text}
    </button>
  );
}

// ── scrubbable number ────────────────────────────────────────────────────────

/**
 * A number you drag left / right to change (Shift ×10, Ctrl ×0.1), or click to type. `onChange(v, done)` fires while
 * dragging (done false) and once at the end (done true).
 */
export function ScrubNumber({ value, onChange, min = -Infinity, max = Infinity, step = 1, digits, unit, className, animated, disabled, width }: {
  value: number; onChange: (v: number, done: boolean) => void; min?: number; max?: number; step?: number; digits?: number; unit?: string;
  className?: string; animated?: boolean; disabled?: boolean; width?: number;
}) {
  const [edit, setEdit] = useState<string | null>(null);
  const d = digits ?? (step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const shown = Number.isFinite(value) ? value.toFixed(d) : "—";
  if (edit !== null) {
    return (
      <input autoFocus value={edit} onChange={(e) => setEdit(e.target.value)} onBlur={() => setEdit(null)} style={{ width: width ?? 64 }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") { const v = parseFloat(edit); if (Number.isFinite(v)) onChange(clamp(v), true); setEdit(null); }
          if (e.key === "Escape") setEdit(null);
        }}
        className="ed-field ed-tc text-xs" />
    );
  }
  return (
    <span role="slider" aria-valuenow={value} tabIndex={disabled ? -1 : 0}
      className={clsx("scrub-num", animated && "anim", disabled && "pointer-events-none opacity-40", className)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); setEdit(shown); }
        else if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); onChange(clamp(value + (e.key === "ArrowUp" ? step : -step) * (e.shiftKey ? 10 : 1)), true); }
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const x0 = e.clientX, v0 = value;
        let moved = false, last = v0;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
          const dx = ev.clientX - x0;
          if (!moved && Math.abs(dx) < 3) return;
          moved = true;
          const k = ev.shiftKey ? 10 : ev.ctrlKey || ev.metaKey ? 0.1 : 1;
          last = clamp(Math.round((v0 + dx * step * k) / (step * (k < 1 ? 0.1 : 1))) * (step * (k < 1 ? 0.1 : 1)));
          onChange(last, false);
        };
        const up = () => {
          el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up);
          if (moved) onChange(last, true); else setEdit(shown);
        };
        el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
      }}>
      {shown}{unit && <span className="ml-0.5 text-dim">{unit}</span>}
    </span>
  );
}

// ── buttons ──────────────────────────────────────────────────────────────────

export const IBtn = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { title: string; shortcut?: string; on?: boolean; side?: "top" | "bottom" | "left" | "right" }>(
  function IBtn({ title, shortcut, on, side = "bottom", className, children, ...rest }, ref) {
    const b = (
      <button ref={ref} type="button" aria-label={title} aria-pressed={on === undefined ? undefined : on} className={clsx("ed-ibtn", className)} {...rest}>
        {children}
      </button>
    );
    return <Tooltip content={title} shortcut={shortcut ? <span className="mono">{shortcut}</span> : undefined} side={side} disabled={rest.disabled}>{b}</Tooltip>;
  },
);

/** "Ctrl+Shift+K" for the platform. */
export const kbd = (s: string) => (navigator.platform?.toLowerCase().includes("mac") ? s.replace(/Ctrl\+/g, "⌘").replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧") : s);

/** True when a key event happens in a text field (shortcuts stay out of the way). */
export function typing(e: KeyboardEvent | React.KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) return true;
  if (tag === "INPUT") { const type = (t as HTMLInputElement).type; return !["checkbox", "radio", "range", "button", "color"].includes(type); }
  return false;
}
