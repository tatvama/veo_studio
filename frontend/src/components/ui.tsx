import { cn } from "../lib/cn";
import { AlertTriangle, CheckCircle2, Info, Loader2, Search, Sparkles, X, XCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type RefObject,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import { ScrollStrip } from "./kit/ScrollStrip";
import { Tooltip } from "./kit/Tooltip";

// New building blocks (components/kit) are re-exported here so pages import everything from "components/ui".
export { Tooltip } from "./kit/Tooltip";
export { AnimatedNumber, InView, Reveal, rise, type EnterKind } from "./kit/Motion";
export { ProgressRing, Sparkline, Stat } from "./kit/Stat";
export { Meter, Metric, Panel, StatusDot, Tag } from "./kit/Hud";
export { Page, PageHeader, PageSkeleton, Section, useDocumentTitle } from "./kit/Page";
export { Avatar, AvatarStack, initials } from "./kit/Avatar";
export { Menu, Popover, type MenuItemDef, type Placement } from "./kit/Popover";
export { ScrollStrip } from "./kit/ScrollStrip";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";

/** CSS press feedback shared by buttons (transform only, GPU-friendly). */
const press = "transition-[color,background-color,border-color,box-shadow,transform,opacity,filter] duration-150 ease-out active:scale-[0.97] disabled:active:scale-100";

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant; size?: "sm" | "md" | "lg"; loading?: boolean; icon?: ReactNode; iconRight?: ReactNode; block?: boolean;
}>(function Button({ variant = "secondary", size = "md", loading, icon, iconRight, block, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium select-none whitespace-nowrap", press,
        "disabled:opacity-45 disabled:cursor-not-allowed",
        size === "sm" && "h-7 px-2.5 text-xs", size === "md" && "h-9 px-3.5 text-sm", size === "lg" && "h-11 px-5 text-base",
        block && "w-full",
        variant === "primary" && "btn-primary text-black",
        variant === "secondary" && "border border-line bg-raised text-ink hover:border-dim/40 hover:bg-hover",
        variant === "outline" && "border border-line text-ink hover:border-dim/50 hover:bg-hover",
        variant === "ghost" && "text-mute hover:bg-hover hover:text-ink",
        variant === "danger" && "border border-bad/30 bg-bad/12 text-red-300 hover:bg-bad/22",
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
      {!loading && iconRight}
    </button>
  );
});

/** Square icon-only button. `title` becomes both the accessible name and an animated tooltip. */
export function IconButton({ title, className, children, active, shortcut, tipSide, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean; shortcut?: ReactNode; tipSide?: "top" | "bottom" | "left" | "right";
}) {
  const btn = (
    <button
      aria-label={title}
      className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-mute hover:bg-hover hover:text-ink disabled:opacity-45", press,
        active && "bg-hover text-ink", className)}
      {...rest}
    >
      {children}
    </button>
  );
  return title ? <Tooltip content={title} shortcut={shortcut} side={tipSide} disabled={rest.disabled}>{btn}</Tooltip> : btn;
}

const field = "w-full rounded-lg border border-line bg-panel px-3 text-sm text-ink placeholder:text-dim transition-[border-color,box-shadow,background-color] duration-150 hover:border-dim/40 focus:border-accent/70 focus:outline-none focus:ring-[3px] focus:ring-accent/15 disabled:opacity-50 disabled:hover:border-line";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(field, "h-9", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(field, "py-2 leading-relaxed resize-y min-h-[72px]", className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(field, "h-9", className)} {...rest}>{children}</select>;
}

/** Text input with a leading magnifier and a clear button. `className` sizes the whole control. */
export const SearchField = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
  value: string; onChange: (v: string) => void; shortcut?: ReactNode;
}>(function SearchField({ value, onChange, className, shortcut, ...rest }, ref) {
  const t = useT();
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-dim" />
      <input ref={ref} type="search" value={value} onChange={(e) => onChange(e.target.value)}
        className={cn(field, "h-9 pl-9 pr-8 [&::-webkit-search-cancel-button]:hidden")} {...rest} />
      <AnimatePresence>
        {value ? (
          <motion.button key="x" type="button" aria-label={t("Clear")} onClick={() => onChange("")}
            initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={{ duration: 0.12 }}
            className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-dim hover:bg-hover hover:text-ink">
            <X className="size-3.5" />
          </motion.button>
        ) : shortcut ? <span key="k" className="absolute right-2.5 top-1/2 -translate-y-1/2">{shortcut}</span> : null}
      </AnimatePresence>
    </div>
  );
});

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block space-y-1.5", className)}>
      <span className="block text-xs font-medium text-mute">{label}</span>
      {children}
      {hint && <span className="block text-2xs leading-snug text-dim">{hint}</span>}
    </label>
  );
}

export function Card({ className, children, interactive, ...rest }: { className?: string; children: ReactNode; interactive?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  const clickable = interactive ?? !!rest.onClick;
  return (
    <div
      className={cn("rounded-xl border border-line bg-panel",
        clickable && "hud lift cursor-pointer hover:border-accent/40",
        className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {sub && <p className="mt-0.5 text-sm text-mute">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const badgeTones = {
  neutral: "bg-raised text-mute border-line",
  accent: "bg-accent/12 text-accent-ink border-accent/30",
  money: "bg-money/12 text-money border-money/30",
  ai: "bg-ai/12 text-ai border-ai/30",
  ok: "bg-ok/15 text-green-300 border-ok/30",
  warn: "bg-warn/15 text-amber-300 border-warn/30",
  bad: "bg-bad/15 text-red-300 border-bad/30",
  info: "bg-info/15 text-sky-300 border-info/30",
};
const dotTones = { neutral: "bg-dim", accent: "bg-accent", money: "bg-money", ai: "bg-ai", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-info" };

export function Badge({ tone = "neutral", children, className, title, dot }: {
  tone?: keyof typeof badgeTones; children: ReactNode; className?: string; title?: string; dot?: boolean;
}) {
  return (
    <span title={title} className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-2xs font-medium leading-none", badgeTones[tone], className)}>
      {dot && <span className={cn("size-1.5 rounded-full", dotTones[tone])} />}
      {children}
    </span>
  );
}

/** Inline message block (info / warning / error / success / tip). */
export function Alert({ tone = "info", icon, title, children, action, className }: {
  tone?: "info" | "warn" | "bad" | "ok" | "accent"; icon?: ReactNode; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string;
}) {
  const Icon = { info: Info, warn: AlertTriangle, bad: XCircle, ok: CheckCircle2, accent: Sparkles }[tone];
  const tones = {
    info: "border-info/25 bg-info/8 [--alert:var(--color-info)]", warn: "border-warn/30 bg-warn/8 [--alert:var(--color-warn)]",
    bad: "border-bad/30 bg-bad/8 [--alert:var(--color-bad)]", ok: "border-ok/25 bg-ok/8 [--alert:var(--color-ok)]",
    accent: "border-accent/30 bg-accent/8 [--alert:var(--color-accent-ink)]",
  };
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={cn("flex items-start gap-3 rounded-xl border px-3.5 py-3 text-sm", tones[tone], className)}>
      <span className="mt-0.5 shrink-0 text-[color:var(--alert)]">{icon ?? <Icon className="size-4" />}</span>
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn("text-mute", title && "mt-0.5")}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin text-mute", className)} />;
}

/** Shimmering placeholder block (theme-aware). */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden className={cn("skeleton", !/rounded/.test(className ?? "") && "rounded-lg", className)} style={style} />;
}

/** A few lines of shimmering text; the last line is shorter. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden className={cn("space-y-2", className)}>
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} className="h-3" style={{ width: i === lines - 1 && lines > 1 ? "62%" : "100%" }} />)}
    </div>
  );
}

export function Empty({ icon, title, sub, action }: { icon?: ReactNode; title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line px-6 py-14 text-center"
    >
      {icon && (
        <div className="relative mb-4">
          <span aria-hidden className="anim-glow absolute inset-0 -m-4 rounded-full bg-accent/12 blur-2xl" />
          <div className="anim-float relative grid size-14 place-items-center rounded-2xl border border-line bg-raised text-mute shadow-card">{icon}</div>
        </div>
      )}
      <p className="font-medium">{title}</p>
      {sub && <p className="mt-1 max-w-md text-sm text-mute">{sub}</p>}
      {action && <div className="mt-5">{action}</div>}
    </motion.div>
  );
}

const THUMB = { type: "spring", stiffness: 640, damping: 34, mass: 0.6 } as const;

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cn("inline-flex items-center gap-2.5 text-sm select-none", disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={typeof label === "string" ? label : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border p-0.5 transition-colors duration-200",
          // invisible padding grows the click target a little without changing the look
          "before:absolute before:-inset-x-1.5 before:-inset-y-2.5 before:content-['']",
          checked ? "border-transparent bg-accent" : "border-line bg-raised hover:bg-hover")}
      >
        <motion.span
          initial={false}
          animate={{ x: checked ? 20 : 0 }}
          transition={THUMB}
          className={cn("block size-[18px] rounded-full shadow-sm", checked ? "bg-white" : "bg-mute")}
        />
      </button>
      {label}
    </label>
  );
}

const SPRING = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } as const;

export function Segmented<T extends string | number>({ value, options, onChange, size = "md", className, "aria-label": ariaLabel }: {
  value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; size?: "sm" | "md"; className?: string; "aria-label"?: string;
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("inline-flex max-w-full rounded-lg border border-line bg-panel p-0.5", className)}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn("relative rounded-md font-medium transition-colors", size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm",
              on ? "text-ink" : "text-mute hover:text-ink")}
          >
            {on && <motion.span layoutId={`seg-${id}`} transition={SPRING} className="absolute inset-0 rounded-md bg-raised shadow-sm ring-1 ring-inset ring-line" />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange, className }: {
  value: T; tabs: { value: T; label: ReactNode; count?: number | string }[]; onChange: (v: T) => void; className?: string;
}) {
  const id = useId();
  return (
    <ScrollStrip role="tablist" className={cn("flex gap-1 border-b border-line", className)}>
      {tabs.map((t) => {
        const on = value === t.value;
        return (
          <button
            key={t.value}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.value)}
            className={cn("relative -mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2 text-sm font-medium transition-colors", on ? "text-ink" : "text-mute hover:text-ink")}
          >
            {t.label}
            {t.count !== undefined && t.count !== "" && (
              <span className={cn("mono rounded-md px-1.5 py-px text-2xs font-medium transition-colors", on ? "bg-accent/15 text-accent-ink" : "bg-raised text-dim")}>{t.count}</span>
            )}
            {on && <motion.span layoutId={`tab-${id}`} transition={SPRING} className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-accent shadow-[0_0_10px_var(--color-accent)]" />}
          </button>
        );
      })}
    </ScrollStrip>
  );
}

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Moves focus into a dialog, keeps Tab inside it, and gives focus back to what opened it. */
function useFocusTrap(active: boolean, ref: RefObject<HTMLElement | null>, returnTo: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return;
    const id = window.setTimeout(() => {
      const root = ref.current;
      if (!root || root.contains(document.activeElement)) return;
      const first = root.querySelector<HTMLElement>("[data-autofocus]")
        ?? root.querySelector<HTMLElement>("[data-modal-body] " + FOCUSABLE)
        ?? root.querySelector<HTMLElement>("[data-modal-footer] " + FOCUSABLE)
        ?? root;
      first.focus({ preventScroll: true });
    }, 30);
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
      const back = returnTo.current;
      if (back && back !== document.body && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [active, ref, returnTo]);
}

const MODAL_W = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-3xl", xl: "max-w-5xl" } as const;

export function Modal({ open, onClose, title, children, footer, wide, size }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; size?: keyof typeof MODAL_W;
}) {
  const t = useT();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  // Keep the last open content so the exit animation doesn't flash empty when the caller clears its state.
  const last = useRef({ title, children, footer });
  if (open) last.current = { title, children, footer };
  const shown = last.current;

  // Remember who opened the dialog while it is still focused (children with autoFocus steal focus before effects run).
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) opener.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;

  useFocusTrap(open, dialog, opener);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="modal"
          className="veo-backdrop fixed inset-0 z-50 flex items-end justify-center p-0 backdrop-blur-sm sm:items-center sm:p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onMouseDown={onClose}
        >
          <motion.div
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.96, y: 18 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "hud relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-panel shadow-modal outline-none sm:max-h-[90vh] sm:rounded-2xl",
              MODAL_W[size ?? (wide ? "xl" : "md")],
            )}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <span aria-hidden className="edge-light pointer-events-none absolute inset-x-0 top-0 h-px" />
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
              <h3 id={titleId} className="min-w-0 truncate font-semibold tracking-tight">{shown.title}</h3>
              <IconButton title={t("Close")} onClick={onClose} className="-mr-1.5"><X className="size-4" /></IconButton>
            </div>
            <div data-modal-body className="overflow-y-auto px-5 py-4">{shown.children}</div>
            {shown.footer && <div data-modal-footer className="flex flex-wrap justify-end gap-2 border-t border-line bg-raised/40 px-5 py-3">{shown.footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function Progress({ value, className, indeterminate, size = "md", tone = "accent" }: {
  value?: number; className?: string; indeterminate?: boolean; size?: "sm" | "md" | "lg"; tone?: "accent" | "ok" | "warn" | "bad" | "info";
}) {
  const bar = { accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-info" }[tone];
  const pct = Math.max(2, Math.min(100, (value ?? 0) * 100));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      className={cn("relative w-full overflow-hidden rounded-full bg-line", size === "sm" ? "h-1" : size === "lg" ? "h-2.5" : "h-1.5", className)}
    >
      {indeterminate ? (
        <div className={cn("absolute inset-y-0 left-0 w-2/5 rounded-full", bar)} style={{ animation: "bar-indeterminate 1.3s ease-in-out infinite" }} />
      ) : (
        <motion.div className={cn("h-full rounded-full", bar)} initial={false} animate={{ width: `${pct}%` }} transition={{ type: "spring", stiffness: 160, damping: 26 }} style={{ boxShadow: "0 0 8px -1px currentColor" }} />
      )}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex min-w-[1.25rem] items-center justify-center rounded border border-line bg-raised px-1 font-mono text-2xs leading-[1.15rem] text-mute shadow-[0_1px_0_var(--color-line)]">{children}</kbd>;
}
