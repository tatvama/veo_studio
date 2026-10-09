import { Check, Circle } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useId, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { Metric, rise } from "../ui";
import type { Tone as CastTone } from "./util";
import "../../styles/room.css";

/*
 * Shared building blocks of the writing + casting workspaces (Brief, Story, Scenes, Bible, Shot list, World).
 *
 *   Workspace      content on the left, a sticky rail on the right (an outline, or a stack of panels)
 *   Outline        mono list of section anchors with scroll-spy and completion ticks
 *   WorkPanel      the standard block: lit edge, HUD brackets, a mono "01 · KICKER" label, title, description, actions
 *   StatStrip      one hairline-divided row of Metrics (the KPI strip under a page header)
 *   ViewSwitch     in-page view switcher (segmented tabs with a sliding highlight and mono counts)
 *   IdChip / code  "CH-012", "SC03": ids are always mono
 *   SpeakerChip    a speaker name as a small-caps chip in its cast colour
 */

export const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** "CH-012", "PR-004": a stable, readable id for something that has a numeric key. */
export const code = (prefix: string, n: number, w = 3) => `${prefix}-${pad(n, w)}`;
/** "SC03" for the (zero-based) scene index. */
export const sceneCode = (i: number) => `SC${pad(i + 1)}`;

type Tone = "neutral" | "accent" | "money" | "ai" | "ok" | "warn" | "bad" | "info";
/** `.eyebrow` sets its own (unlayered) colour, so the tone colours must be important to win over it. */
const TEXT: Record<Tone, string> = {
  neutral: "!text-dim", accent: "!text-accent-ink", money: "!text-money", ai: "!text-ai", ok: "!text-ok", warn: "!text-warn", bad: "!text-bad", info: "!text-info",
};

const reducedMotion = () => typeof document !== "undefined" && (document.documentElement.dataset.motion === "reduced"
  || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches));

/** Scrolls a section into view inside the page's own scroller (smooth unless the user asked for less motion). */
export function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
}

/**
 * Which section is "current" while the page scrolls: the last one whose top has passed `offset` px below the scroller's top
 * edge (and the last section once the page is scrolled to the end). `ids` are element ids, in page order.
 */
export function useScrollSpy(ids: string[], offset = 112): string {
  const [active, setActive] = useState(ids[0] ?? "");
  const key = ids.join("|");
  useEffect(() => {
    const list = key ? key.split("|") : [];
    if (!list.length) return;
    const first = list.map((id) => document.getElementById(id)).find((el): el is HTMLElement => !!el) ?? null;
    const scroller = first?.closest<HTMLElement>("[data-page-scroller]") ?? null;
    let raf = 0;
    const compute = () => {
      raf = 0;
      const top = (scroller ? scroller.getBoundingClientRect().top : 0) + offset;
      let cur = "";
      let last = "";
      for (const id of list) {
        const el = document.getElementById(id);
        if (!el) continue;
        last = id;
        if (!cur) cur = id;
        if (el.getBoundingClientRect().top <= top) cur = id;
      }
      const atEnd = !!scroller && scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      setActive(atEnd && last ? last : cur);
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(compute); };
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue);
    const warm = window.setTimeout(queue, 60);
    queue();
    return () => {
      target.removeEventListener("scroll", queue);
      window.removeEventListener("resize", queue);
      window.clearTimeout(warm);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [key, offset]);
  return active;
}

// ── Outline ───────────────────────────────────────────────────────────────────

export interface OutlineItem {
  id: string; label: ReactNode; icon?: ReactNode;
  /** done = a tick, warn = an amber dot (needs attention), todo = a hollow ring, none = nothing */
  state?: "done" | "warn" | "todo" | "none";
  /** a short mono value at the end of the row ("3", "12s") */
  meta?: ReactNode;
}

/** The slim right-hand outline: section anchors with scroll-spy and completion ticks. Hidden by its parent on narrow screens. */
export function Outline({ items, title, summary, offset, className }: {
  items: OutlineItem[]; title?: ReactNode; summary?: ReactNode; offset?: number; className?: string;
}) {
  const t = useT();
  const active = useScrollSpy(items.map((i) => i.id), offset);
  return (
    <nav aria-label={typeof title === "string" ? title : t("On this page")} className={cn("rm-outline text-xs", className)}>
      <div className="mb-2 flex items-baseline justify-between gap-2 px-3">
        <p className="eyebrow">{title ?? t("On this page")}</p>
        {summary && <span className="mono text-2xs text-dim">{summary}</span>}
      </div>
      <ol className="relative border-l border-line">
        {items.map((it, i) => {
          const on = active === it.id;
          return (
            <li key={it.id} className="relative">
              <a href={`#${it.id}`} aria-current={on ? "location" : undefined}
                onClick={(e) => { e.preventDefault(); scrollToSection(it.id); }}
                className={cn("group relative -ml-px flex min-h-7 items-center gap-2 border-l py-1 pl-3 pr-1.5 transition-colors",
                  on ? "border-accent bg-gradient-to-r from-accent/10 to-transparent text-ink" : "border-transparent text-mute hover:text-ink")}>
                <span className={cn("mono shrink-0 text-2xs transition-colors", on ? "text-accent-ink" : "text-dim")}>{pad(i + 1)}</span>
                <span className="min-w-0 flex-1 leading-snug">{it.label}</span>
                {it.meta !== undefined && it.meta !== "" && <span className="mono shrink-0 text-2xs text-dim">{it.meta}</span>}
                {it.state === "done" && <Check aria-label={t("Complete")} className="size-3 shrink-0 text-ok" strokeWidth={3} />}
                {it.state === "warn" && <span role="img" aria-label={t("Needs attention")} className="size-1.5 shrink-0 rounded-full bg-warn" />}
                {it.state === "todo" && <Circle aria-label={t("Not done yet")} className="size-2.5 shrink-0 text-dim/70" strokeWidth={2.5} />}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ── Workspace ─────────────────────────────────────────────────────────────────

const LAYOUT = {
  /** a slim outline rail (11rem); hidden below the breakpoint */
  outline: { grid: "@4xl:grid @4xl:grid-cols-[minmax(0,1fr)_11rem] @4xl:items-start @4xl:gap-5", rail: "hidden @4xl:block @4xl:sticky @4xl:top-4" },
  /** a panel rail (21rem) that stacks under the content below the breakpoint */
  panel: { grid: "@5xl:grid @5xl:grid-cols-[minmax(0,1fr)_21rem] @5xl:items-start @5xl:gap-5", rail: "@5xl:sticky @5xl:top-4 @5xl:max-h-[calc(100dvh-7.5rem)] @5xl:overflow-y-auto @5xl:pb-2 @5xl:pr-1" },
  /** a wide panel rail (25rem) for the script's writers' room */
  wide: { grid: "@5xl:grid @5xl:grid-cols-[minmax(0,1fr)_25rem] @5xl:items-start @5xl:gap-5", rail: "@5xl:sticky @5xl:top-4 @5xl:max-h-[calc(100dvh-7.5rem)] @5xl:overflow-y-auto @5xl:pb-2 @5xl:pr-1" },
} as const;

/**
 * Two panes: the work on the left, a sticky rail on the right. Both panes are size containers, so every panel inside adapts
 * to the room it actually has. `rail="outline"` is for long forms; `"panel"` / `"wide"` hold a stack of panels.
 */
export function Workspace({ children, rail, railKind = "outline", className, railClassName }: {
  children: ReactNode; rail?: ReactNode; railKind?: keyof typeof LAYOUT; className?: string; railClassName?: string;
}) {
  const L = LAYOUT[railKind];
  return (
    <div className={cn("@container", className)}>
      <div className={cn("flex flex-col gap-4", rail && L.grid)}>
        <div className="@container min-w-0 space-y-4">{children}</div>
        {rail && <aside className={cn("@container min-w-0 space-y-4", L.rail, railClassName)}>{rail}</aside>}
      </div>
    </div>
  );
}

// ── WorkPanel ─────────────────────────────────────────────────────────────────

/**
 * The standard block. Header: a mono eyebrow (`icon · 01 · KICKER`), the title, a one-line purpose and the actions (which
 * wrap on narrow panels). `tone` colours the eyebrow and keeps the lit edge on. `flush` removes body padding (lists, tables).
 */
export function WorkPanel({ n, kicker, title, description, icon, actions, badge, children, className, bodyClassName, id, index, flush, tone, hideHead }: {
  n?: number | string; kicker?: ReactNode; title?: ReactNode; description?: ReactNode; icon?: ReactNode; actions?: ReactNode; badge?: ReactNode;
  children?: ReactNode; className?: string; bodyClassName?: string; id?: string; index?: number; flush?: boolean; tone?: Tone; hideHead?: boolean;
}) {
  const r = index === undefined ? null : rise(index);
  const head = !hideHead && (title || actions || kicker || n !== undefined);
  const label = n !== undefined || kicker || icon;
  return (
    <section id={id} {...(r ? { style: r.style } : {})}
      className={cn("hud group/panel relative min-w-0 scroll-mt-4 rounded-xl border border-line bg-panel", r?.className, className)}>
      <span aria-hidden className={cn("edge-light pointer-events-none absolute inset-x-4 top-0 h-px transition-opacity duration-300",
        tone ? "opacity-70" : "opacity-0 group-hover/panel:opacity-100")} />
      {head && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2.5 px-4 pt-3.5 @md:px-5">
          <div className="min-w-0 flex-1 basis-56">
            {label && (
              <p className={cn("eyebrow flex items-center gap-1.5", tone ? TEXT[tone] : "")}>
                {icon && <span aria-hidden className="shrink-0 [&>svg]:size-3.5">{icon}</span>}
                {n !== undefined && <span className="mono">{typeof n === "number" ? pad(n) : n}</span>}
                {n !== undefined && kicker && <span aria-hidden className="opacity-50">/</span>}
                {kicker && <span className="truncate">{kicker}</span>}
              </p>
            )}
            {title && (
              <h2 className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold tracking-tight", label && "mt-1.5")}>
                <span className="min-w-0">{title}</span>{badge}
              </h2>
            )}
            {description && <p className="mt-1 text-xs leading-relaxed text-mute">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {children !== undefined && (
        <div className={cn(flush ? "" : "px-4 pb-4 @md:px-5 @md:pb-5", head && !flush && "pt-4", !head && !flush && "pt-4 @md:pt-5", bodyClassName)}>{children}</div>
      )}
    </section>
  );
}

// ── StatStrip ─────────────────────────────────────────────────────────────────

export interface StatCell {
  key: string; label: ReactNode; value: number | string; unit?: ReactNode; format?: (n: number) => string; sub?: ReactNode;
  tone?: Tone; /** an extra visual under the number (a Meter, a ring) */ visual?: ReactNode; wide?: boolean;
}

/** One hairline-divided row of Metrics. Cells wrap on narrow screens; the dividers survive any wrap. */
export function StatStrip({ cells, className, index, aside }: { cells: StatCell[]; className?: string; index?: number; aside?: ReactNode }) {
  const r = index === undefined ? null : rise(index);
  return (
    <section {...(r ? { style: r.style } : {})} className={cn("hud relative min-w-0 overflow-hidden rounded-xl border border-line bg-panel", r?.className, className)}>
      <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-70" />
      <div className="-ml-px -mt-px flex flex-wrap">
        {cells.map((c) => (
          <div key={c.key} className={cn("min-w-0 flex-1 basis-36 border-l border-t border-line p-3.5 @md:p-4", c.wide && "basis-56")}>
            <Metric label={c.label} value={c.value} unit={c.unit} format={c.format} sub={c.sub} tone={c.tone} size="sm" />
            {c.visual && <div className="mt-2.5">{c.visual}</div>}
          </div>
        ))}
        {aside && <div className="min-w-0 flex-1 basis-56 border-l border-t border-line p-3.5 @md:p-4">{aside}</div>}
      </div>
    </section>
  );
}

// ── ViewSwitch ────────────────────────────────────────────────────────────────

export interface ViewItem<T extends string> { value: T; label: ReactNode; icon?: ReactNode; count?: number | string; warn?: boolean }

/** In-page view switcher: a segmented tablist with a sliding highlight. (The pipeline rail owns stage navigation; this is for views.) */
export function ViewSwitch<T extends string>({ value, onChange, items, label, className, size = "md" }: {
  value: T; onChange: (v: T) => void; items: ViewItem<T>[]; label: string; className?: string; size?: "sm" | "md";
}) {
  const id = useId();
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
    const i = tabs.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    tabs[next].click();
  };
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKey}
      className={cn("rm-strip inline-flex max-w-full gap-0.5 rounded-lg border border-line bg-panel p-0.5", className)}>
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button key={it.value} type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1} onClick={() => onChange(it.value)}
            className={cn("relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm", on ? "text-ink" : "text-mute hover:text-ink")}>
            {on && (
              <motion.span layoutId={`view-${id}`} transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.7 }}
                className="absolute inset-0 rounded-md bg-raised shadow-[0_0_0_1px_var(--color-line),0_0_12px_-6px_var(--color-accent)]">
                <span aria-hidden className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />
              </motion.span>
            )}
            <span className="relative flex items-center gap-1.5 [&>svg]:size-4">{it.icon}{it.label}</span>
            {it.count !== undefined && it.count !== "" && (
              <span className={cn("mono relative rounded px-1 text-2xs leading-4", it.warn ? "bg-warn/15 text-warn" : on ? "bg-accent/15 text-accent-ink" : "bg-raised text-dim")}>{it.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── small marks ───────────────────────────────────────────────────────────────

/** A mono id chip: "CH-012". */
export function IdChip({ children, className, tone = "neutral" }: { children: ReactNode; className?: string; tone?: "neutral" | "accent" | "ai" }) {
  return (
    <span className={cn("mono inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-2xs font-medium leading-none tracking-wider",
      tone === "accent" ? "border-accent/30 bg-accent/10 text-accent-ink" : tone === "ai" ? "border-ai/30 bg-ai/10 text-ai" : "border-line bg-raised/70 text-mute", className)}>
      {children}
    </span>
  );
}

/** A speaker as a small-caps chip in their cast colour (the colour comes from useCastTones, so it matches everywhere). */
export function SpeakerChip({ name, tone, icon, className, title }: { name: ReactNode; tone?: CastTone; icon?: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} style={tone?.style as CSSProperties | undefined}
      className={cn("inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-raised/70 px-1.5 py-1 text-2xs font-semibold uppercase leading-none tracking-[0.12em]",
        tone?.className ?? "text-mute", className)}>
      {icon && <span aria-hidden className="shrink-0 [&>svg]:size-3">{icon}</span>}
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Mono label + value pair for dense facts ("LOC  Temple courtyard"). */
export function Kv({ k, children, className }: { k: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-baseline gap-1.5 text-xs", className)}>
      <span className="eyebrow shrink-0">{k}</span>
      <span className="min-w-0 truncate text-ink">{children}</span>
    </span>
  );
}
