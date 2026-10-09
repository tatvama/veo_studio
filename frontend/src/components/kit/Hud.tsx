import { cn } from "../../lib/cn";
import type { ReactNode } from "react";
import { MoneyText } from "./Money";
import { AnimatedNumber, rise } from "./Motion";
import { Sparkline } from "./Stat";

type Tone = "neutral" | "accent" | "money" | "ai" | "ok" | "warn" | "bad" | "info";

const TEXT: Record<Tone, string> = {
  neutral: "text-ink", accent: "text-accent-ink", money: "text-money", ai: "text-ai", ok: "text-ok", warn: "text-warn", bad: "text-bad", info: "text-info",
};
const DOT: Record<Tone, string> = {
  neutral: "bg-dim", accent: "bg-accent", money: "bg-money", ai: "bg-ai", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-info",
};
const STROKE: Record<Tone, string> = {
  neutral: "var(--color-mute)", accent: "var(--color-accent)", money: "var(--color-money)", ai: "var(--color-ai)", ok: "var(--color-ok)",
  warn: "var(--color-warn)", bad: "var(--color-bad)", info: "var(--color-info)",
};

/**
 * The standard "instrument panel": hairline border, corner brackets, a mono eyebrow label with optional icon and actions.
 * Use it for every block on a dashboard so panels read as one family. `flush` removes body padding (tables, lists).
 */
export function Panel({ title, eyebrow, icon, actions, children, className, bodyClassName, flush, tone, index, id }: {
  title?: ReactNode; eyebrow?: ReactNode; icon?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string;
  bodyClassName?: string; flush?: boolean; tone?: Tone; index?: number; id?: string;
}) {
  const r = index === undefined ? null : rise(index);
  return (
    <section id={id} {...(r ? { style: r.style } : {})}
      className={cn("hud group/panel relative min-w-0 scroll-mt-4 rounded-xl border border-line bg-panel", r?.className, className)}>
      <span aria-hidden className={cn("edge-light pointer-events-none absolute inset-x-4 top-0 h-px transition-opacity duration-300",
        tone ? "opacity-70" : "opacity-0 group-hover/panel:opacity-100")} />
      {(title || eyebrow || actions) && (
        <header className="flex items-center justify-between gap-3 px-4 pt-3.5">
          <div className="min-w-0">
            {eyebrow && <p className={cn("eyebrow flex items-center gap-1.5", tone && TEXT[tone])}>{icon && <span className="[&>svg]:size-3.5">{icon}</span>}{eyebrow}</p>}
            {title && <h2 className={cn("truncate text-sm font-semibold tracking-tight", eyebrow && "mt-1.5")}>{title}</h2>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className={cn(flush ? "" : "p-4", (title || eyebrow || actions) && !flush && "pt-3", bodyClassName)}>{children}</div>}
    </section>
  );
}

/** A big mono number with a label, optional unit, delta and sparkline. The building block of KPI strips. */
export function Metric({ label, value, unit, format, delta, deltaTone, tone = "neutral", spark, sub, className, size = "md" }: {
  label: ReactNode; value: number | string; unit?: ReactNode; format?: (n: number) => string; delta?: ReactNode; deltaTone?: Tone;
  tone?: Tone; spark?: number[]; sub?: ReactNode; className?: string; size?: "sm" | "md" | "lg";
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="eyebrow truncate">{label}</p>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className={cn("mono flex items-baseline gap-1 font-medium leading-none tracking-tight", TEXT[tone], size === "lg" ? "text-4xl" : size === "sm" ? "text-xl" : "text-[1.65rem]")}>
            {typeof value === "number" ? <AnimatedNumber value={value} format={format} /> : <MoneyText text={value} />}
            {unit && <span className="text-sm font-normal text-dim">{unit}</span>}
          </p>
          {(delta || sub) && (
            <p className="mt-1.5 flex items-center gap-1.5 text-2xs text-dim">
              {delta && <span className={cn("mono", TEXT[deltaTone ?? "neutral"])}>{delta}</span>}{sub}
            </p>
          )}
        </div>
        {spark && spark.length > 1 && <Sparkline data={spark} width={84} height={30} stroke={STROKE[tone]} className="shrink-0 opacity-90" />}
      </div>
    </div>
  );
}

/** A status dot with an optional "live" ping. */
export function StatusDot({ tone = "ok", live, className }: { tone?: Tone; live?: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} aria-hidden>
      {live && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", DOT[tone])} />}
      <span className={cn("relative size-2 rounded-full", DOT[tone])} />
    </span>
  );
}

/** A compact mono tag: `KEY value`. For metadata rows (aspect, language, duration, version). */
export function Tag({ k, children, tone = "neutral", className }: { k?: ReactNode; children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span className={cn("mono inline-flex items-center gap-1.5 rounded-md border border-line bg-raised/60 px-1.5 py-0.5 text-2xs leading-none", className)}>
      {k && <span className="uppercase tracking-wider text-dim">{k}</span>}
      <span className={TEXT[tone]}>{children}</span>
    </span>
  );
}

/** A segmented horizontal meter (like a battery or flight-path): `filled` of `total` cells lit. */
export function Meter({ filled, total, tone = "accent", className }: { filled: number; total: number; tone?: Tone; className?: string }) {
  return (
    <span className={cn("flex gap-[3px]", className)} role="img" aria-label={`${filled} / ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={cn("h-1.5 flex-1 rounded-[2px] transition-colors", i < filled ? DOT[tone] : "bg-line")} style={i < filled ? { boxShadow: `0 0 6px -1px ${STROKE[tone]}` } : undefined} />
      ))}
    </span>
  );
}
