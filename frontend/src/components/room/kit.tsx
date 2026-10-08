import { clsx } from "clsx";
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Loader2, RotateCcw, Save, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef,
  type InputHTMLAttributes, type ReactNode, type RefObject, type TextareaHTMLAttributes,
} from "react";
import { useT } from "../../lib/i18n";
import { Alert, Button, IconButton, Kbd, Tooltip, rise } from "../ui";
import { MOD } from "../shell/keys";
import { TONE_BG, TONE_TEXT_SM } from "./util";

/* Small building blocks shared by the four writers' room tabs (Brief, Story, Scenes, Bible). */

const WIDTH = { narrow: "max-w-3xl", default: "max-w-5xl", wide: "max-w-6xl", full: "max-w-[1500px]" } as const;
export type RoomWidth = keyof typeof WIDTH;

/**
 * Scrolling frame for a project tab. It is itself a size container, so everything inside can use `@2xl:`-style variants
 * and adapt to the room left once the Director panel is docked. `footer` (an <ActionBar/>) sticks to the bottom edge.
 */
export function RoomPage({ children, width = "wide", footer, className, scrollRef }: {
  children: ReactNode; width?: RoomWidth; footer?: ReactNode; className?: string; scrollRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={scrollRef} className="@container h-full scroll-pb-20 overflow-y-auto overscroll-contain" data-page-scroller>
      <div className={clsx("mx-auto w-full px-4 pb-12 pt-5 @2xl:px-6 @2xl:pt-6", WIDTH[width], className)}>{children}</div>
      {footer}
    </div>
  );
}

/** Compact in-page header for a project tab (the project header above already owns the big title). */
export function RoomHeader({ icon, title, description, actions, status }: {
  icon: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode; status?: ReactNode;
}) {
  const r = rise(0);
  return (
    <header {...r} className={clsx("mb-5 flex flex-wrap items-center gap-x-4 gap-y-3", r.className)}>
      <div className="flex min-w-0 flex-1 basis-72 items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent-ink ring-1 ring-inset ring-accent/20 [&>svg]:size-5">{icon}</span>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold leading-tight tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 line-clamp-2 max-w-3xl text-sm text-mute">{description}</p>}
        </div>
      </div>
      {(status || actions) && <div className="flex flex-wrap items-center gap-x-3 gap-y-2">{status}{actions}</div>}
    </header>
  );
}

/** The one card shape used for every block: title row (icon, title, description, actions) + body. */
export function SectionCard({ title, description, icon, actions, children, className, bodyClassName, id, index, flush }: {
  title?: ReactNode; description?: ReactNode; icon?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string;
  bodyClassName?: string; id?: string; index?: number; flush?: boolean;
}) {
  const r = index === undefined ? null : rise(index);
  const head = title || actions;
  return (
    <section id={id} {...(r ? { style: r.style } : {})}
      className={clsx("scroll-mt-4 rounded-xl border border-line bg-panel", r?.className, className)}>
      {head && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-4 @md:px-5">
          <div className="min-w-0 flex-1 basis-56">
            {title && (
              <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                {icon && <span className="shrink-0 text-accent-ink [&>svg]:size-4">{icon}</span>}
                <span className="min-w-0">{title}</span>
              </h2>
            )}
            {description && <p className="mt-0.5 text-xs leading-relaxed text-mute">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {children !== undefined && (
        <div className={clsx(flush ? "" : "px-4 pb-4 @md:px-5 @md:pb-5", head && !flush && "pt-4", !head && !flush && "pt-4 @md:pt-5", bodyClassName)}>{children}</div>
      )}
    </section>
  );
}

/** Title + description + actions row at the top of a panel that lives inside a tabbed card. */
export function PanelHead({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={clsx("mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2", className)}>
      <div className="min-w-0 flex-1 basis-56">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-mute">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Like the kit's Field, with a slot on the right of the label row (character counters, small actions). */
export function RField({ label, hint, right, children, className, htmlFor }: {
  label: ReactNode; hint?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; htmlFor?: string;
}) {
  return (
    <div className={clsx("block space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="min-w-0 text-xs font-medium text-mute">{label}</label>
        {right}
      </div>
      {children}
      {hint && <p className="text-2xs leading-snug text-dim">{hint}</p>}
    </div>
  );
}

/** "42 / 140" — turns amber once past the soft limit. Limits are guidance, never enforced. */
export function Counter({ value, limit, unit }: { value: number; limit?: number; unit?: string }) {
  const over = limit !== undefined && value > limit;
  return (
    <span className={clsx("shrink-0 text-2xs tabular-nums", over ? TONE_TEXT_SM.warn : "text-dim")} aria-live="off">
      {value}{limit !== undefined && ` / ${limit}`}{unit ? ` ${unit}` : ""}
    </span>
  );
}

export type SaveState = "clean" | "dirty" | "saving" | "saved";

/** Quiet save indicator: Unsaved changes → Saving… → Saved → All changes saved. */
export function SaveStatus({ state, className }: { state: SaveState; className?: string }) {
  const t = useT();
  return (
    <span role="status" className={clsx("inline-flex h-6 items-center overflow-hidden text-xs font-medium", className)}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={state} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.14 }}
          className={clsx("inline-flex items-center gap-1.5", state === "dirty" ? TONE_TEXT_SM.warn : state === "saved" ? TONE_TEXT_SM.ok : "text-dim")}>
          {state === "dirty" && <><span className="size-1.5 rounded-full bg-warn" />{t("Unsaved changes")}</>}
          {state === "saving" && <><Loader2 className="size-3.5 animate-spin" />{t("Saving…")}</>}
          {state === "saved" && <><Check className="size-3.5" strokeWidth={2.5} />{t("Saved")}</>}
          {state === "clean" && <><Check className="size-3.5 opacity-60" />{t("All changes saved")}</>}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** "← Cast / Ravi" row at the top of a detail view, with optional previous / next arrows through the list. */
export function DetailBar({ backLabel, onBack, name, pos }: {
  backLabel: string; onBack: () => void; name?: string; pos?: { index: number; total: number; onPrev: () => void; onNext: () => void; prevLabel: string; nextLabel: string };
}) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={onBack} className="-ml-1.5 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-mute transition-colors hover:bg-hover hover:text-ink">
        <ArrowLeft className="size-4" />{backLabel}
      </button>
      {name && <span aria-hidden className="text-dim">/</span>}
      {name && <span className="min-w-0 truncate text-sm font-medium" title={name}>{name}</span>}
      <div className="flex-1" />
      {pos && (
        <div className="flex items-center gap-1">
          <IconButton title={pos.prevLabel} onClick={pos.onPrev}><ChevronLeft className="size-4" /></IconButton>
          <span className="min-w-10 text-center text-xs tabular-nums text-dim">{pos.index + 1} / {pos.total}</span>
          <IconButton title={pos.nextLabel} onClick={pos.onNext}><ChevronRight className="size-4" /></IconButton>
        </div>
      )}
    </div>
  );
}

/** Floating "Unsaved changes · Discard · Save" pill, pinned near the bottom of the scrolling page. Takes no layout space. */
export function FloatingSaveBar({ show, state, onSave, onDiscard, saving, disabled }: {
  show: boolean; state: SaveState; onSave: () => void; onDiscard: () => void; saving?: boolean; disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="pointer-events-none sticky bottom-3 z-20 h-0">
      <AnimatePresence>
        {show && (
          <motion.div key="savebar" initial={{ opacity: 0, y: 16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }} className="absolute inset-x-0 bottom-0 flex justify-center">
            <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-xl border border-line bg-raised/95 py-2 pl-4 pr-2 shadow-pop backdrop-blur">
              <SaveStatus state={state} className="mr-1" />
              <Button variant="ghost" size="sm" icon={<Undo2 className="size-3.5" />} onClick={onDiscard} disabled={saving || disabled}>{t("Discard")}</Button>
              <Tooltip content={t("Save changes")} shortcut={<><Kbd>{MOD}</Kbd><Kbd>S</Kbd></>} side="top">
                <Button variant="primary" size="sm" loading={saving} disabled={disabled} onClick={onSave} icon={<Save className="size-3.5" />}>{t("Save changes")}</Button>
              </Tooltip>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Bar pinned to the bottom of the scrolling page (only sticky when the window is tall enough to spare the room). */
export function ActionBar({ children, width = "wide", className }: { children: ReactNode; width?: RoomWidth; className?: string }) {
  return (
    <div className={clsx("z-20 border-t border-line bg-bg/85 backdrop-blur-md [@media(min-height:620px)]:sticky [@media(min-height:620px)]:bottom-0", className)}>
      <div className={clsx("mx-auto flex w-full flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 @2xl:px-6", WIDTH[width])}>{children}</div>
    </div>
  );
}

/** Textarea that grows with its content (no inner scrollbar). */
export const AutoText = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function AutoText({ className, value, rows = 1, ...rest }, ref) {
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement);
  const lastWidth = useRef(0);
  const fit = useCallback(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = "0px";
    const cs = getComputedStyle(el);
    const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    el.style.height = `${el.scrollHeight + border}px`;
  }, []);
  useLayoutEffect(() => { fit(); }, [value, fit]);
  useEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w && w !== lastWidth.current) { lastWidth.current = w; fit(); }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);
  return <textarea ref={inner} rows={rows} value={value} className={clsx("block w-full resize-none overflow-hidden", className)} {...rest} />;
});

/** Text input that is exactly as wide as what is typed in it (at least `minCh` characters wide). */
export const AutoInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { minCh?: number }>(function AutoInput({ className, value, placeholder, minCh = 4, ...rest }, ref) {
  const text = String(value ?? "") || String(placeholder ?? "");
  return (
    <span className="inline-grid max-w-full align-middle">
      <span aria-hidden className={clsx("invisible col-start-1 row-start-1 overflow-hidden whitespace-pre", className)} style={{ minWidth: `${minCh}ch` }}>{text}</span>
      <input ref={ref} value={value} placeholder={placeholder} className={clsx("col-start-1 row-start-1 w-0 min-w-full", className)} {...rest} />
    </span>
  );
});

/** Labelled score bar (0–10). `marker` draws the pass mark on the track. */
export function ScoreBar({ label, value, max = 10, tone, delay = 0, marker, layout = "stacked" }: {
  label: ReactNode; value: number; max?: number; tone: "ok" | "warn" | "bad"; delay?: number; marker?: number; layout?: "stacked" | "inline";
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const track = (
    <div className="relative">
      <div className="h-1.5 overflow-hidden rounded-full bg-line">
        <motion.div className={clsx("h-full rounded-full", TONE_BG[tone])} initial={{ width: 0 }} animate={{ width: `${Math.max(pct, 2)}%` }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1], delay }} />
      </div>
      {marker !== undefined && <span aria-hidden className="absolute -top-[3px] h-[12px] w-px rounded-full bg-mute/60" style={{ left: `${Math.min(100, (marker / max) * 100)}%` }} />}
    </div>
  );
  const num = <span className={clsx("shrink-0 text-xs font-semibold tabular-nums", TONE_TEXT_SM[tone])}>{value.toFixed(1)}</span>;
  if (layout === "inline") {
    return (
      <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_2rem] items-center gap-3 text-xs">
        <span className="truncate text-mute" title={typeof label === "string" ? label : undefined}>{label}</span>
        {track}
        <span className="text-right">{num}</span>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-mute" title={typeof label === "string" ? label : undefined}>{label}</span>
        {num}
      </div>
      {track}
    </div>
  );
}

/** "Couldn't load this" with a retry button — for when a page's data request fails. */
export function LoadError({ onRetry, what }: { onRetry: () => void; what?: string }) {
  const t = useT();
  return (
    <Alert tone="bad" title={what ?? t("Couldn't load this page")}
      action={<Button size="sm" variant="outline" icon={<RotateCcw className="size-3.5" />} onClick={onRetry}>{t("Retry")}</Button>}>
      {t("Check your connection and try again.")}
    </Alert>
  );
}

/** Compact empty state for use inside a card or panel (the kit's <Empty> is page-sized). */
export function RoomEmpty({ icon, title, sub, action, className }: { icon?: ReactNode; title: ReactNode; sub?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx("anim-fade flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-8 text-center", className)}>
      {icon && <span className="mb-3 grid size-11 place-items-center rounded-xl border border-line bg-raised text-mute shadow-card [&>svg]:size-5">{icon}</span>}
      <p className="text-sm font-medium">{title}</p>
      {sub && <p className="mt-1 max-w-md text-xs leading-relaxed text-mute">{sub}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Tiny round icon + text pill used for status facts ("3 scenes", "Locked"). */
export function Fact({ icon, children, tone = "neutral", className }: {
  icon?: ReactNode; children: ReactNode; tone?: "neutral" | "ok" | "warn" | "bad" | "info" | "accent"; className?: string;
}) {
  const tones = {
    neutral: "border-line bg-raised text-mute", ok: "border-ok/30 bg-ok/8 text-green-300", warn: "border-warn/30 bg-warn/8 text-amber-300",
    bad: "border-bad/30 bg-bad/8 text-red-300", info: "border-info/30 bg-info/8 text-sky-300", accent: "border-accent/30 bg-accent/8 text-accent-ink",
  };
  return (
    <span className={clsx("inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs font-medium leading-none [&>svg]:size-3 [&>svg]:shrink-0", tones[tone], className)}>
      {icon}<span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
