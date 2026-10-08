import { clsx } from "clsx";
import { Check } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Input, InView, Toggle, rise } from "../../../components/ui";
import { useT } from "../../../lib/i18n";

/* ── section card ───────────────────────────────────────────────────────────── */

/** One settings section: icon + title + description, then the rows. `id` is the deep-link / scroll-spy anchor. */
export function SettingsCard({ id, icon, title, sub, children, index = 0, className }: {
  id: string; icon: ReactNode; title: string; sub?: ReactNode; children: ReactNode; index?: number; className?: string;
}) {
  const body = (
    <div className={clsx("rounded-xl border border-line bg-panel p-5", className)}>
      <div className="mb-4 flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent-ink ring-1 ring-inset ring-accent/20">{icon}</span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {sub && <p className="mt-0.5 text-sm text-mute">{sub}</p>}
        </div>
      </div>
      {children}
    </div>
  );
  const r = rise(index);
  return (
    <section id={id} className="scroll-mt-16 lg:scroll-mt-6">
      {index < 2 ? <div className={r.className} style={r.style}>{body}</div> : <InView y={12}>{body}</InView>}
    </section>
  );
}

/* ── rows ───────────────────────────────────────────────────────────────────── */

/** Container for a list of rows (hairlines between them). */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("divide-y divide-line [&>*]:py-3.5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0", className)}>{children}</div>;
}

/** Label + description on the left, the control on the right (stacked on narrow screens or with `stack`). */
export function Row({ label, hint, children, stack, align = "center", className }: {
  label: ReactNode; hint?: ReactNode; children: ReactNode; stack?: boolean; align?: "center" | "start"; className?: string;
}) {
  return (
    <div className={clsx("flex gap-x-6 gap-y-2.5", stack ? "flex-col" : clsx("flex-col sm:flex-row sm:justify-between", align === "start" ? "sm:items-start" : "sm:items-center"), className)}>
      <div className={clsx("min-w-0", !stack && "sm:max-w-[56%]")}>
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-mute">{hint}</p>}
      </div>
      <div className={clsx(stack ? "w-full" : "shrink-0")}>{children}</div>
    </div>
  );
}

export function SwitchRow({ label, hint, checked, onChange, disabled }: {
  label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  const t = useT();
  return (
    <Row label={label} hint={hint} align="start">
      <span className="flex items-center gap-2 text-xs font-medium text-mute">
        <Toggle checked={checked} disabled={disabled} onChange={onChange} label={<span className="sr-only">{label}</span>} />
        <span className="w-6" aria-hidden>{checked ? t("On") : t("Off")}</span>
      </span>
    </Row>
  );
}

/* ── inputs ─────────────────────────────────────────────────────────────────── */

export function Dollar({ value, onChange, disabled, placeholder, className, label, invalid }: {
  value: unknown; onChange: (v: string) => void; disabled?: boolean; placeholder?: string; className?: string; label: string; invalid?: boolean;
}) {
  return (
    <div className={clsx("relative", className ?? "w-40")}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-dim">$</span>
      <Input className={clsx("pl-6 tabular-nums", invalid && "border-bad/60 focus:border-bad")} inputMode="decimal" disabled={disabled} placeholder={placeholder} aria-label={label} aria-invalid={invalid || undefined}
        value={value === null || value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function NumberInput({ value, onChange, min, max, step, disabled, label, className, invalid }: {
  value: unknown; onChange: (v: string) => void; min?: number; max?: number; step?: number; disabled?: boolean; label: string; className?: string; invalid?: boolean;
}) {
  return (
    <div className={clsx("w-28", className)}>
      <Input type="number" min={min} max={max} step={step} disabled={disabled} aria-label={label} aria-invalid={invalid || undefined}
        className={clsx("tabular-nums", invalid && "border-bad/60 focus:border-bad")}
        value={value === null || value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/* ── slider ─────────────────────────────────────────────────────────────────── */

/** One look for every range input: accent-filled track, round thumb, value badge. */
const RANGE =
  "h-5 w-full cursor-pointer appearance-none bg-transparent outline-none disabled:cursor-not-allowed " +
  "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full " +
  "[&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--color-accent)_var(--p),var(--color-line)_var(--p))] " +
  "[&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full " +
  "[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-accent [&::-webkit-slider-thumb]:bg-panel [&::-webkit-slider-thumb]:shadow-md " +
  "[&::-webkit-slider-thumb]:transition-transform hover:[&::-webkit-slider-thumb]:scale-110 active:[&::-webkit-slider-thumb]:scale-95 " +
  "focus-visible:[&::-webkit-slider-thumb]:ring-4 focus-visible:[&::-webkit-slider-thumb]:ring-accent/25 " +
  "[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-line " +
  "[&::-moz-range-progress]:h-1.5 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-accent " +
  "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-accent [&::-moz-range-thumb]:bg-panel";

export function SliderRow({ label, hint, value, onChange, min, max, step, left, right, disabled, format }: {
  label: string; hint?: ReactNode; value: number; onChange: (v: number) => void; min: number; max: number; step: number;
  left: string; right: string; disabled?: boolean; format?: (v: number) => string;
}) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <div className={clsx("transition-opacity", disabled && "opacity-55")}>
      <div className="mb-1.5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          {hint && <p className="mt-0.5 text-xs leading-relaxed text-mute">{hint}</p>}
        </div>
        <span className="shrink-0 rounded-md border border-line bg-raised px-2 py-0.5 font-mono text-xs font-medium tabular-nums">{(format ?? ((v) => v.toFixed(2)))(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} aria-label={label} className={RANGE}
        style={{ "--p": `${pct}%` } as CSSProperties} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="mt-0.5 flex justify-between text-2xs text-dim"><span>{left}</span><span>{right}</span></div>
    </div>
  );
}

/* ── toggle chips ───────────────────────────────────────────────────────────── */

/** A row of on/off chips (multi-select): languages, kinds… Each chip is a toggle button, so it works with the keyboard. */
export function ToggleChips({ options, value, onChange, disabled, ariaLabel, min = 0 }: {
  options: { value: string; label: string; hint?: string }[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; ariaLabel: string;
  /** Keep at least this many chips on (the last one can't be switched off). */
  min?: number;
}) {
  const toggle = (v: string) => {
    const on = value.includes(v);
    if (on && value.length <= min) return;
    onChange(on ? value.filter((x) => x !== v) : [...value, v]);
  };
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.value);
        const locked = on && value.length <= min;
        return (
          <button key={o.value} type="button" aria-pressed={on} disabled={disabled} title={o.hint} onClick={() => toggle(o.value)}
            className={clsx("inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              on ? "border-accent/50 bg-accent/10 text-ink" : "border-line text-mute hover:border-dim/50 hover:text-ink", locked && !disabled && "cursor-default")}>
            <span className={clsx("grid size-3.5 place-items-center rounded-full border transition-colors", on ? "border-accent bg-accent text-black" : "border-dim")}>
              {on && <Check className="size-2.5" strokeWidth={3.5} />}
            </span>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── radio cards ────────────────────────────────────────────────────────────── */

export function Choice({ options, value, onChange, disabled, ariaLabel }: {
  options: { value: string; label: string; desc: string }[]; value: string; onChange: (v: string) => void; disabled?: boolean; ariaLabel: string;
}) {
  const t = useT();
  return (
    <div className="space-y-2" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => onChange(o.value)}
            className={clsx("flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-[border-color,background-color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-60",
              on ? "border-accent/60 bg-accent/8 shadow-[0_0_0_3px_rgb(249_115_22/0.08)]" : "border-line hover:border-dim/50 hover:bg-hover/50")}>
            <span className={clsx("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition-colors", on ? "border-accent bg-accent text-black" : "border-dim")}>
              {on && <Check className="size-3" strokeWidth={3} />}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t(o.label)}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-mute">{t(o.desc)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
