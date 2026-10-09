import { clsx } from "clsx";
import { Check } from "lucide-react";
import { useContext, type CSSProperties, type ReactNode } from "react";
import "../../../styles/console.css";
import "../../../styles/settings.css";
import { RupeeHint } from "../../../components/kit/Money";
import { InView, Input, Panel, Toggle } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { SECTION_GROUP, SECTION_IDS } from "./Nav";
import { SectionStateContext, StatusGlyph } from "./state";

/* ── section panel ──────────────────────────────────────────────────────────── */

/**
 * One settings section: a HUD panel with an eyebrow ("03 / STUDIO DEFAULTS"), the title, and on the right the unsaved count
 * and the section's health. The panel is also a size container, so its rows and tables adapt to its own width.
 * `id` is the deep-link / scroll-spy anchor. The lit section (scroll-spy) gets the lit edge.
 */
export function SettingsCard({ id, icon, title, sub, children, index = 0, className }: {
  id: string; icon: ReactNode; title: string; sub?: ReactNode; children: ReactNode; index?: number; className?: string;
}) {
  const t = useT();
  const { active, status, dirty } = useContext(SectionStateContext);
  const st = status[id];
  const n = dirty[id] ?? 0;
  const pos = SECTION_IDS.indexOf(id);
  const eyebrow = (
    <>
      <span className="text-accent-ink">{String(pos + 1).padStart(2, "0")}</span>
      <span aria-hidden className="text-dim">/</span>
      <span className="truncate">{t(SECTION_GROUP[id] ?? "")}</span>
    </>
  );
  const actions = (n > 0 || st?.label) ? (
    <>
      {n > 0 && (
        <span title={t("Unsaved changes")} className="st-unsaved mono text-amber-300">
          <i aria-hidden className="st-dot" />
          {t("{n} unsaved", { n })}
        </span>
      )}
      {st?.label && <StatusGlyph status={st} word />}
    </>
  ) : undefined;
  const panel = (
    <Panel id={id} icon={icon} eyebrow={eyebrow} title={title} actions={actions} tone={active === id ? "accent" : undefined}
      index={index < 2 ? index + 2 : undefined} bodyClassName="@container" className={clsx("scroll-mt-16 min-[900px]:scroll-mt-4", className)}>
      {sub && <p className="mb-4 max-w-3xl text-xs leading-relaxed text-mute">{sub}</p>}
      {children}
    </Panel>
  );
  return index < 2 ? panel : <InView y={10}>{panel}</InView>;
}

/* ── rows ───────────────────────────────────────────────────────────────────── */

/** Container for a list of rows (hairlines between them). */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("st-rows", className)}>{children}</div>;
}

/**
 * The control grid: label + hint on the left, the control in a shared column on the right, one column on narrow panels
 * (or with `stack`). `changed` lights the amber gutter bar and a dot: this value is not saved yet.
 */
export function Row({ label, hint, children, stack, align = "center", changed, className }: {
  label: ReactNode; hint?: ReactNode; children: ReactNode; stack?: boolean; align?: "center" | "start"; changed?: boolean; className?: string;
}) {
  const t = useT();
  return (
    <div className={clsx("st-row", className)} data-stack={stack ? "true" : undefined} data-align={align} data-changed={changed ? "true" : undefined}>
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium">
          {changed && (
            <>
              <i aria-hidden className="st-dot" />
              <span className="sr-only">{t("Unsaved changes")}</span>
            </>
          )}
          <span className="min-w-0">{label}</span>
        </p>
        {hint && <div className="mt-0.5 max-w-[62ch] text-xs leading-relaxed text-mute">{hint}</div>}
      </div>
      <div className="st-ctl">{children}</div>
    </div>
  );
}

export function SwitchRow({ label, hint, checked, onChange, disabled, changed }: {
  label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; changed?: boolean;
}) {
  const t = useT();
  return (
    <Row label={label} hint={hint} align="start" changed={changed}>
      <span className="flex items-center gap-2.5">
        <Toggle checked={checked} disabled={disabled} onChange={onChange} label={<span className="sr-only">{label}</span>} />
        <span aria-hidden className={clsx("mono min-w-7 text-2xs font-medium uppercase tracking-wider", checked ? "text-accent-ink" : "text-dim")}>{checked ? t("On") : t("Off")}</span>
      </span>
    </Row>
  );
}

/* ── inputs ─────────────────────────────────────────────────────────────────── */

/** Money input: the dollar sign is amber (it is a cost), the figure is mono. */
export function Dollar({ value, onChange, disabled, placeholder, className, label, invalid }: {
  value: unknown; onChange: (v: string) => void; disabled?: boolean; placeholder?: string; className?: string; label: string; invalid?: boolean;
}) {
  return (
    <div className={className ?? "w-full max-w-44"}>
      <div className="relative">
        <span aria-hidden className="mono pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-money">$</span>
        <Input className={clsx("pl-6 font-mono tabular-nums", invalid && "border-bad/60 focus:border-bad")} inputMode="decimal" disabled={disabled} placeholder={placeholder} aria-label={label} aria-invalid={invalid || undefined}
          value={value === null || value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value)} />
      </div>
      <RupeeHint v={value} className="mt-1 pl-1" />
    </div>
  );
}

export function NumberInput({ value, onChange, min, max, step, disabled, label, className, invalid }: {
  value: unknown; onChange: (v: string) => void; min?: number; max?: number; step?: number; disabled?: boolean; label: string; className?: string; invalid?: boolean;
}) {
  return (
    <div className={clsx("w-full max-w-44", className)}>
      <Input type="number" min={min} max={max} step={step} disabled={disabled} aria-label={label} aria-invalid={invalid || undefined}
        className={clsx("font-mono tabular-nums", invalid && "border-bad/60 focus:border-bad")}
        value={value === null || value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/* ── slider ─────────────────────────────────────────────────────────────────── */

/** One look for every range input: accent-filled track, round thumb. The value sits beside it in a mono readout. */
const RANGE =
  "h-6 w-full cursor-pointer appearance-none bg-transparent outline-none disabled:cursor-not-allowed max-sm:h-8 " +
  "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full " +
  "[&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--color-accent)_var(--p),var(--color-line)_var(--p))] " +
  "[&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full " +
  "[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-accent [&::-webkit-slider-thumb]:bg-panel [&::-webkit-slider-thumb]:shadow-sm " +
  "[&::-webkit-slider-thumb]:transition-transform hover:[&::-webkit-slider-thumb]:scale-110 active:[&::-webkit-slider-thumb]:scale-95 " +
  "focus-visible:[&::-webkit-slider-thumb]:ring-4 focus-visible:[&::-webkit-slider-thumb]:ring-accent/25 " +
  "[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-line " +
  "[&::-moz-range-progress]:h-1.5 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-accent " +
  "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-accent [&::-moz-range-thumb]:bg-panel";

export function SliderRow({ label, hint, value, onChange, min, max, step, left, right, disabled, format, changed }: {
  label: string; hint?: ReactNode; value: number; onChange: (v: number) => void; min: number; max: number; step: number;
  left: string; right: string; disabled?: boolean; format?: (v: number) => string; changed?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <Row label={label} hint={hint} changed={changed} className={clsx("transition-opacity", disabled && "opacity-55")}>
      <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3">
        <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} aria-label={label} className={RANGE}
          style={{ "--p": `${pct}%` } as CSSProperties} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="mono min-w-[3.25rem] rounded-lg border border-line bg-raised px-2 py-1 text-center text-xs font-medium tabular-nums">{(format ?? ((v) => v.toFixed(2)))(value)}</span>
        <div className="flex justify-between text-2xs text-dim"><span>{left}</span><span>{right}</span></div>
      </div>
    </Row>
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
            className={clsx("cx-chip max-sm:h-10 disabled:cursor-not-allowed disabled:opacity-60", locked && !disabled && "cursor-default")}>
            {on ? <Check strokeWidth={3} /> : <span aria-hidden className="size-3.5 rounded-full border border-dim" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── option cards ───────────────────────────────────────────────────────────── */

/** Pick one of a few long options (each with a description): a grid of selectable spec cards. */
export function Choice({ options, value, onChange, disabled, ariaLabel }: {
  options: { value: string; label: string; desc: string }[]; value: string; onChange: (v: string) => void; disabled?: boolean; ariaLabel: string;
}) {
  const t = useT();
  return (
    <div className="grid gap-2 @2xl:grid-cols-2" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => onChange(o.value)}
            className={clsx("relative flex items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60 @2xl:[&:last-child:nth-child(odd)]:col-span-2",
              on ? "border-accent/50 bg-accent/[0.07]" : "border-line hover:border-dim/50 hover:bg-hover/50")}>
            {on && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />}
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

/** Pick one of a few short options (quality tier, caption style): compact tiles, with an optional mono line (a price) under the name. */
export function TileGroup({ options, value, onChange, disabled, ariaLabel }: {
  options: { value: string; label: ReactNode; sub?: ReactNode; title?: string }[]; value: string; onChange: (v: string) => void; disabled?: boolean; ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,8.5rem),1fr))]">
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} disabled={disabled} title={o.title} onClick={() => onChange(o.value)}
            className={clsx("relative flex min-h-11 flex-col items-start justify-center gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60",
              on ? "border-accent/50 bg-accent/[0.07]" : "border-line hover:border-dim/50 hover:bg-hover/50")}>
            {on && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />}
            <span className="flex w-full items-center gap-1.5 text-sm font-medium">
              {on && <Check aria-hidden className="size-3.5 shrink-0 text-accent-ink" strokeWidth={3} />}
              <span className="min-w-0 truncate">{o.label}</span>
            </span>
            {o.sub && <span className="mono text-2xs">{o.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}
