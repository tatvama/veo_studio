import { clsx } from "clsx";
import { motion } from "motion/react";
import { useId, type CSSProperties, type InputHTMLAttributes, type ReactNode } from "react";
import "../../../styles/production.css";

/** Small building blocks shared by the storyboard, the shot inspector, the studio and the timeline. */

export type Tone = "neutral" | "accent" | "money" | "ai" | "ok" | "warn" | "bad" | "info";

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-ink", accent: "text-accent-ink", money: "text-money", ai: "text-ai", ok: "text-ok", warn: "text-warn", bad: "text-bad", info: "text-info",
};
export const TONE_BG: Record<Tone, string> = {
  neutral: "bg-dim", accent: "bg-accent", money: "bg-money", ai: "bg-ai", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-info",
};

const SPRING = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } as const;

/** A range slider with a lit fill (the fill is a CSS variable, see production.css). */
export function Rng({ className, min, max, value, style, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "min" | "max" | "value"> & {
  min: number; max: number; value: number;
}) {
  const f = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  return <input type="range" min={min} max={max} value={value} className={clsx("rng min-w-0", !/(^|\s)(@\w+:)?w-/.test(className ?? "") && "w-full", className)} style={{ ...style, "--fill": `${f * 100}%` } as CSSProperties} {...rest} />;
}

/** One cell of an instrument strip: an eyebrow label over a mono value, optionally with a thin lit bar under it. */
export function Cell({ label, children, tone = "neutral", className, title, bar }: {
  label: ReactNode; children: ReactNode; tone?: Tone; className?: string; title?: string; bar?: { frac: number; tone?: Tone };
}) {
  const barTone: Tone = bar?.tone ?? (tone === "neutral" ? "accent" : tone);
  return (
    <div title={title} className={clsx("flex min-w-0 flex-col justify-center gap-1.5 px-3 py-1", className)}>
      <span className="eyebrow truncate">{label}</span>
      <span className={clsx("mono flex items-baseline gap-1 text-[0.95rem] font-medium leading-none", TONE_TEXT[tone])}>{children}</span>
      {bar && (
        <span aria-hidden className="block h-[2px] w-full rounded-full bg-line">
          <span className={clsx("block h-full rounded-full transition-[width] duration-500", TONE_BG[barTone], TONE_TEXT[barTone])}
            style={{ width: `${Math.max(0, Math.min(1, bar.frac)) * 100}%`, boxShadow: "0 0 6px -1px currentColor" }} />
        </span>
      )}
    </div>
  );
}

export interface RailOption<T> { value: T; label: ReactNode; count?: number | string; icon?: ReactNode; title?: string; disabled?: boolean }

/**
 * A compact segmented rail: a hairline group whose active segment is lit (accent tint, a glowing underline). Used as radio
 * group (filters, modes) or as tab list (the inspector). Counts are mono.
 */
export function RailSeg<T extends string | number>({ value, options, onChange, kind = "radio", label, className, size = "md", grow }: {
  value: T; options: RailOption<T>[]; onChange: (v: T) => void; kind?: "radio" | "tab"; label?: string; className?: string; size?: "sm" | "md"; grow?: boolean;
}) {
  const id = useId();
  const tab = kind === "tab";
  return (
    <div role={tab ? "tablist" : "radiogroup"} aria-label={label}
      className={clsx("inline-flex max-w-full items-center gap-0.5 rounded-lg border border-line bg-panel/70 p-0.5", grow && "flex w-full", className)}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button key={String(o.value)} type="button" role={tab ? "tab" : "radio"} {...(tab ? { "aria-selected": on } : { "aria-checked": on })}
            data-active={on || undefined} title={o.title} disabled={o.disabled} onClick={() => onChange(o.value)}
            className={clsx("relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-45",
              size === "sm" ? "h-6 px-2 text-2xs pointer-coarse:h-8" : "h-7 px-2.5 text-xs pointer-coarse:h-9", grow && "flex-1",
              on ? "text-ink" : "text-mute hover:text-ink")}>
            {on && (
              <motion.span layoutId={`rs-${id}`} transition={SPRING} className="absolute inset-0 rounded-md bg-accent/12 ring-1 ring-inset ring-accent/35">
                <span aria-hidden className="absolute inset-x-2 -bottom-px h-px bg-accent shadow-[0_0_8px_var(--color-accent)]" />
              </motion.span>
            )}
            {o.icon && <span className={clsx("relative [&>svg]:size-3.5", on && "text-accent-ink")}>{o.icon}</span>}
            <span className="relative">{o.label}</span>
            {o.count !== undefined && o.count !== "" && (
              <span className={clsx("mono relative text-2xs font-medium leading-none", on ? "text-accent-ink" : "text-dim")}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** An on/off segment that sits in the same family as <RailSeg>: a LED and a label. */
export function RailToggle({ on, onClick, icon, children, title, className }: {
  on: boolean; onClick: () => void; icon?: ReactNode; children: ReactNode; title?: string; className?: string;
}) {
  return (
    <button type="button" aria-pressed={on} title={title} onClick={onClick}
      className={clsx("inline-flex h-[34px] items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium outline-none pointer-coarse:h-11 transition-colors focus-visible:ring-2 focus-visible:ring-accent/60",
        on ? "border-accent/40 bg-accent/12 text-accent-ink" : "border-line bg-panel/70 text-mute hover:border-dim/50 hover:text-ink", className)}>
      {icon && <span className="[&>svg]:size-3.5">{icon}</span>}
      {children}
      <span aria-hidden className={clsx("led", on && "is-on")} />
    </button>
  );
}

/** Two digits, for mono timecodes. */
export const p2 = (n: number) => String(Math.floor(n)).padStart(2, "0");

/** 8 → "00:08", 65 → "01:05": a duration as a timecode chip. */
export function fmtDur(s: number): string {
  const v = Math.max(0, Number.isFinite(s) ? s : 0);
  const whole = Math.floor(v);
  const frac = Math.round((v - whole) * 10);
  return `${p2(whole / 60)}:${p2(whole % 60)}${frac ? `.${frac}` : ""}`;
}
