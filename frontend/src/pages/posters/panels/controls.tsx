/**
 * Shared form controls for the Poster Studio panels. Dense (28 px rows), scrubbable, keyboard friendly and built from
 * theme tokens only. Colours *inside* pickers (hue bars, swatches, gradients) are design data and can be anything.
 *
 * Continuous controls call `onChange` many times per gesture; callers pass a stable `coalesce` key to the store
 * (e.g. `${layerId}:opacity`) so one drag is one undo step.
 */
import { ArrowLeftRight, ChevronRight, Minus, Pipette, Plus } from "lucide-react";
import {
  useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent,
  type ReactNode,
} from "react";
import { IconButton, Popover, Segmented, Tooltip } from "../../../components/ui";
import { cn } from "../../../lib/cn";
import { useT } from "../../../lib/i18n";
import type { Gradient, GradientStop, Paint } from "../types";
import {
  CHECKER, QUICK_COLORS, alphaOf, colorAt, gradientCss, hex6, hsvToRgb, isTransparent, normColor, parseColor, partner, rgbToHsv,
  sortStops, toHex, withAlpha, type Hsv,
} from "./right/color";

// ── numbers ──────────────────────────────────────────────

const clamp = (v: number, a = -Infinity, b = Infinity) => Math.min(b, Math.max(a, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

export function decimalsOf(x: number): number {
  const s = String(+x.toFixed(6));
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}
const snapTo = (v: number, unit: number) => +(Math.round(v / unit) * unit).toFixed(decimalsOf(unit));

/** Evaluate what was typed into a number box: numbers, + − × ÷ and brackets ("1080/2", "24*1.5"). Units are ignored. */
export function evalExpr(input: string): number | null {
  const src = input.trim().replace(/,/g, ".").replace(/\s+/g, "").replace(/(px|%|°|deg|pt)$/i, "").replace(/[×x]/g, "*").replace(/÷/g, "/");
  if (!src) return null;
  let i = 0;
  const factor = (): number | null => {
    if (src[i] === "-") { i++; const f = factor(); return f === null ? null : -f; }
    if (src[i] === "+") { i++; return factor(); }
    if (src[i] === "(") {
      i++;
      const v = expr();
      if (src[i] !== ")") return null;
      i++;
      return v;
    }
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const term = (): number | null => {
    let v = factor();
    while (v !== null && (src[i] === "*" || src[i] === "/")) {
      const op = src[i++];
      const r = factor();
      if (r === null) return null;
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const expr = (): number | null => {
    let v = term();
    while (v !== null && (src[i] === "+" || src[i] === "-")) {
      const op = src[i++];
      const r = term();
      if (r === null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const v = expr();
  return v !== null && i === src.length && Number.isFinite(v) ? v : null;
}

/**
 * Drag a 0…1 position (or a 2D point) out of an element. Used by sliders, pads, bars. With `unclamped`, positions
 * outside the element are reported as they are (a dial keeps tracking the angle when the pointer leaves it).
 */
export function usePointerPad(onMove: (fx: number, fy: number, e: RPointerEvent<HTMLElement>) => void, onEnd?: () => void, unclamped = false) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef({ onMove, onEnd });
  cb.current = { onMove, onEnd };
  const active = useRef<number | null>(null);
  const fire = (e: RPointerEvent<HTMLElement>) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return;
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    cb.current.onMove(unclamped ? fx : clamp01(fx), unclamped ? fy : clamp01(fy), e);
  };
  const end = (e: RPointerEvent<HTMLElement>) => {
    if (active.current !== e.pointerId) return;
    active.current = null;
    cb.current.onEnd?.();
  };
  return {
    ref,
    handlers: {
      onPointerDown: (e: RPointerEvent<HTMLElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).focus?.({ preventScroll: true });
        e.currentTarget.setPointerCapture(e.pointerId);
        active.current = e.pointerId;
        fire(e);
      },
      onPointerMove: (e: RPointerEvent<HTMLElement>) => { if (active.current === e.pointerId) fire(e); },
      onPointerUp: end,
      onPointerCancel: end,
    },
  };
}

/** Pointer handlers that turn a horizontal drag into value changes (2 px per step; Shift ×10, Alt ×0.1). */
function useScrub(o: { value: number; step: number; min?: number; max?: number; disabled?: boolean; onScrub: (v: number) => void; onEnd?: (v: number) => void }) {
  const opts = useRef(o);
  opts.current = o;
  const st = useRef<{ id: number; x: number; acc: number; last: number; moved: boolean } | null>(null);
  const finish = (e: RPointerEvent<HTMLElement>) => {
    const s = st.current;
    if (!s || s.id !== e.pointerId) return;
    st.current = null;
    document.body.style.cursor = "";
    if (s.moved) opts.current.onEnd?.(s.last);
  };
  return {
    onPointerDown: (e: RPointerEvent<HTMLElement>) => {
      if (opts.current.disabled || e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.style.cursor = "ew-resize";
      st.current = { id: e.pointerId, x: e.clientX, acc: opts.current.value, last: opts.current.value, moved: false };
    },
    onPointerMove: (e: RPointerEvent<HTMLElement>) => {
      const s = st.current;
      if (!s || s.id !== e.pointerId) return;
      const dx = e.clientX - s.x;
      s.x = e.clientX;
      if (!dx) return;
      s.moved = true;
      const { step, min, max } = opts.current;
      const unit = step * (e.altKey ? 0.1 : 1);
      s.acc = clamp(s.acc + (dx / 2) * unit * (e.shiftKey ? 10 : 1), min, max);
      const v = clamp(snapTo(s.acc, unit), min, max);
      if (v !== s.last) { s.last = v; opts.current.onScrub(v); }
    },
    onPointerUp: finish,
    onPointerCancel: finish,
  };
}

interface NumInputProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** decimals shown (defaults to the step's) */
  precision?: number;
  /** shown = value × scale (e.g. 100 for a 0…1 opacity shown as percent) */
  scale?: number;
  suffix?: string;
  disabled?: boolean;
  mixed?: boolean;
  className?: string;
  "aria-label"?: string;
}

/** A bare number box: type a value or a sum, arrows step it (Shift ×10), Enter commits, Esc reverts. */
export function NumInput({ value, onChange, min, max, step = 1, precision, scale = 1, suffix, disabled, mixed, className, ...rest }: NumInputProps) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  // Enter and Esc blur the box themselves; the blur that follows must not commit a second time
  const handled = useRef(false);
  const shownStep = step * scale;
  const dec = precision ?? decimalsOf(shownStep);
  const fmt = (v: number) => (Number.isFinite(v) ? String(+(v * scale).toFixed(dec)) : "");
  const commit = (s: string | null) => {
    setDraft(null);
    if (s === null) return;
    const n = evalExpr(s);
    if (n === null) return;
    const v = clamp(n / scale, min, max);
    if (v !== value) onChange(+v.toFixed(Math.max(dec + decimalsOf(1 / scale), 4)));
  };
  const key = (e: RKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { commit(draft); handled.current = true; (e.target as HTMLInputElement).blur(); }
    else if (e.key === "Escape") { setDraft(null); handled.current = true; e.stopPropagation(); (e.target as HTMLInputElement).blur(); }
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      const base = draft !== null ? (evalExpr(draft) ?? value * scale) / scale : value;
      const v = clamp(snapTo(base + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1), step), min, max);
      onChange(v);
      setDraft(fmt(v));
    }
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      spellCheck={false}
      disabled={disabled}
      aria-label={rest["aria-label"]}
      value={draft ?? (mixed ? "" : fmt(value))}
      placeholder={mixed ? t("Mixed") : undefined}
      onFocus={(e) => { setDraft(mixed ? "" : fmt(value)); requestAnimationFrame(() => e.target.select()); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (handled.current) handled.current = false; else commit(draft); }}
      onKeyDown={key}
      className={cn("mono min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-dim disabled:opacity-50", suffix ? "pr-0" : "", className)}
    />
  );
}

const box = "flex h-7 min-w-0 items-center rounded-md border border-line bg-raised transition-[border-color,box-shadow] hover:border-dim/40 focus-within:border-accent/70 focus-within:ring-[3px] focus-within:ring-accent/15";

/**
 * Number field with a scrubbable label: drag the label left/right to change the value (Shift ×10, Alt fine),
 * or type into it (sums work). With `live={false}` a scrub only applies when the pointer is released.
 */
export function NumberField({ label, title, value, onChange, min, max, step = 1, precision, scale, suffix, disabled, mixed, live = true, className }: {
  label: ReactNode; title?: string; live?: boolean; className?: string;
} & NumInputProps) {
  const t = useT();
  const [preview, setPreview] = useState<number | null>(null);
  const scrub = useScrub({
    value, step, min, max, disabled,
    onScrub: (v) => (live ? onChange(v) : setPreview(v)),
    onEnd: (v) => { if (!live) { setPreview(null); onChange(v); } },
  });
  const tip = `${title ?? (typeof label === "string" ? label : "")}${title || typeof label === "string" ? " · " : ""}${t("drag to change, Shift for ×10")}`;
  return (
    <div className={cn(box, disabled && "opacity-50", className)}>
      <span
        {...scrub}
        title={tip}
        aria-hidden
        className={cn("flex h-full shrink-0 select-none items-center pl-2 pr-1.5 text-2xs font-medium text-dim touch-none",
          disabled ? "cursor-not-allowed" : "cursor-ew-resize hover:text-accent-ink")}
      >
        {label}
      </span>
      <NumInput value={preview ?? value} onChange={onChange} min={min} max={max} step={step} precision={precision} scale={scale}
        disabled={disabled} mixed={mixed && preview === null} aria-label={title ?? (typeof label === "string" ? label : undefined)} />
      {suffix && <span className="shrink-0 pr-2 text-2xs text-dim">{suffix}</span>}
    </div>
  );
}

// ── sliders ──────────────────────────────────────────────

/** A slim theme-coloured slider. `origin` fills from a centre value (for −/+ ranges such as brightness). */
export function Slider({ value, min, max, step = 0.01, onChange, origin, disabled, defaultValue, className, "aria-label": ariaLabel }: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void; origin?: number; disabled?: boolean;
  defaultValue?: number; className?: string; "aria-label"?: string;
}) {
  const span = max - min || 1;
  const pos = (v: number) => clamp01((v - min) / span);
  const pad = usePointerPad((fx) => { if (!disabled) onChange(clamp(snapTo(min + fx * span, step), min, max)); });
  const p = pos(value), o = pos(origin ?? min);
  const key = (e: RKeyboardEvent<HTMLDivElement>) => {
    const big = e.shiftKey || e.key === "PageUp" || e.key === "PageDown" ? 10 : 1;
    let v: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "PageUp") v = value + step * big;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "PageDown") v = value - step * big;
    else if (e.key === "Home") v = min;
    else if (e.key === "End") v = max;
    if (v === null || disabled) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(clamp(snapTo(v, step), min, max));
  };
  return (
    <div
      ref={pad.ref}
      {...pad.handlers}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={+value.toFixed(4)}
      aria-disabled={disabled || undefined}
      onKeyDown={key}
      onDoubleClick={() => defaultValue !== undefined && !disabled && onChange(defaultValue)}
      className={cn("group relative h-5 min-w-0 flex-1 touch-none select-none outline-none", disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer", className)}
    >
      <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-line" />
      <span className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent" style={{ left: `${Math.min(o, p) * 100}%`, width: `${Math.abs(p - o) * 100}%` }} />
      {origin !== undefined && origin !== min && <span className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-dim/60" style={{ left: `${o * 100}%` }} />}
      <span
        className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-panel shadow-sm transition-[box-shadow] group-hover:shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-accent)_18%,transparent)] group-focus-visible:shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-accent)_30%,transparent)]"
        style={{ left: `${p * 100}%` }}
      />
    </div>
  );
}

/** Label, slider and an editable readout in one row. Double-click the label or the slider to reset. */
export function SliderRow({ label, value, min, max, step = 0.01, onChange, scale = 1, suffix, precision, origin, defaultValue, disabled, hint }: {
  label: ReactNode; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; scale?: number; suffix?: string;
  precision?: number; origin?: number; defaultValue?: number; disabled?: boolean; hint?: string;
}) {
  return (
    <div className="grid grid-cols-[4.75rem_minmax(0,1fr)_3.5rem] items-center gap-2" title={hint}>
      <span className="truncate text-2xs text-mute" onDoubleClick={() => defaultValue !== undefined && !disabled && onChange(defaultValue)}>{label}</span>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} origin={origin} defaultValue={defaultValue} disabled={disabled}
        aria-label={typeof label === "string" ? label : undefined} />
      <div className={cn(box, "px-1.5", disabled && "opacity-50")}>
        <NumInput value={value} onChange={onChange} min={min} max={max} step={step} scale={scale} precision={precision} disabled={disabled}
          className="text-right" aria-label={typeof label === "string" ? label : undefined} />
        {suffix && <span className="shrink-0 pl-0.5 text-2xs text-dim">{suffix}</span>}
      </div>
    </div>
  );
}

// ── angles ───────────────────────────────────────────────

/** Normalise degrees to (-180, 180] ("signed") or [0, 360) ("unsigned"). */
export function normAngle(a: number, mode: "signed" | "unsigned" = "signed"): number {
  let v = ((a % 360) + 360) % 360;
  if (mode === "signed" && v > 180) v -= 360;
  return +v.toFixed(2);
}

/** A little dial: drag around it to set an angle (Shift snaps to 15°). 0° points right, angles grow clockwise. */
export function AngleDial({ value, onChange, mode = "signed", size = 28, disabled }: {
  value: number; onChange: (v: number) => void; mode?: "signed" | "unsigned"; size?: number; disabled?: boolean;
}) {
  const t = useT();
  const pad = usePointerPad((fx, fy, e) => {
    if (disabled) return;
    let a = (Math.atan2(fy - 0.5, fx - 0.5) * 180) / Math.PI;
    a = e.shiftKey ? Math.round(a / 15) * 15 : Math.round(a);
    onChange(normAngle(a, mode));
  }, undefined, true);
  const key = (e: RKeyboardEvent<HTMLDivElement>) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!d || disabled) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(normAngle(value + d * (e.shiftKey ? 15 : 1), mode));
  };
  return (
    <div
      ref={pad.ref}
      {...pad.handlers}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={t("Angle")}
      aria-valuenow={value}
      onKeyDown={key}
      onDoubleClick={() => !disabled && onChange(0)}
      title={t("Drag to turn · Shift snaps to 15°")}
      className={cn("relative shrink-0 touch-none rounded-full border border-line bg-raised outline-none transition-colors hover:border-dim/50 focus-visible:border-accent/70",
        disabled ? "opacity-50" : "cursor-grab active:cursor-grabbing")}
      style={{ width: size, height: size }}
    >
      <span className="absolute left-1/2 top-1/2 h-px origin-left bg-accent" style={{ width: size / 2 - 3, transform: `rotate(${value}deg)` }} />
      <span className="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent" />
    </div>
  );
}

export function AngleField({ value, onChange, label, mode = "signed", disabled, className }: {
  value: number; onChange: (v: number) => void; label?: ReactNode; mode?: "signed" | "unsigned"; disabled?: boolean; className?: string;
}) {
  const t = useT();
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <AngleDial value={value} onChange={onChange} mode={mode} disabled={disabled} />
      <NumberField label={label ?? "∠"} title={t("Angle")} value={value} onChange={(v) => onChange(normAngle(v, mode))} step={1} suffix="°" disabled={disabled}
        className="flex-1" />
    </div>
  );
}

// ── toggles, sections, rows ──────────────────────────────

/** Compact switch (the panels' density; the kit Toggle is for forms). */
export function Switch({ checked, onChange, disabled, "aria-label": ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; "aria-label"?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border p-px outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-45",
        checked ? "border-transparent bg-accent" : "border-line bg-raised hover:bg-hover")}
    >
      <span className={cn("block size-3 rounded-full shadow-sm transition-transform duration-150", checked ? "translate-x-3 bg-white" : "translate-x-0 bg-mute")} />
    </button>
  );
}

export function ToggleRow({ label, checked, onChange, hint, icon, disabled }: {
  label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode; icon?: ReactNode; disabled?: boolean;
}) {
  return (
    <div className={cn("flex min-h-7 items-center gap-2", disabled && "opacity-50")}>
      {icon && <span className="grid size-4 shrink-0 place-items-center text-dim [&>svg]:size-3.5">{icon}</span>}
      <div className="min-w-0 flex-1">
        <span className="block truncate text-xs text-ink">{label}</span>
        {hint && <span className="block text-2xs leading-snug text-dim">{hint}</span>}
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} aria-label={typeof label === "string" ? label : undefined} />
    </div>
  );
}

/** Small uppercase label for a group of fields, with optional actions on the right. */
export function SectionTitle({ children, actions, className }: { children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-6 items-center gap-2", className)}>
      <span className="eyebrow min-w-0 flex-1 truncate">{children}</span>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}

const sectionState = new Map<string, boolean>();
const readOpen = (id: string | undefined, dflt: boolean) => {
  if (!id) return dflt;
  if (sectionState.has(id)) return sectionState.get(id)!;
  try { const v = localStorage.getItem(`poster:sec:${id}`); return v === null ? dflt : v === "1"; } catch { return dflt; }
};
const writeOpen = (id: string | undefined, v: boolean) => {
  if (!id) return;
  sectionState.set(id, v);
  try { localStorage.setItem(`poster:sec:${id}`, v ? "1" : "0"); } catch { /* storage blocked */ }
};

/**
 * A collapsible block of the property panel. `toggle` puts a switch in the header for optional features (shadow,
 * stroke…): the fields only show while it is on. The open/closed state is remembered per `id`.
 */
export function PropSection({ title, id, children, actions, toggle, defaultOpen = true, className }: {
  title: ReactNode; id?: string; children?: ReactNode; actions?: ReactNode; defaultOpen?: boolean; className?: string;
  toggle?: { checked: boolean; onChange: (v: boolean) => void };
}) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));
  const body = useId();
  const show = open && (!toggle || toggle.checked) && children;
  return (
    <section className={cn("border-b border-line px-3 py-2", className)}>
      <div className="flex h-7 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={body}
          onClick={() => { setOpen(!open); writeOpen(id, !open); }}
          className="eyebrow -ml-1 flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-left outline-none transition-colors hover:text-ink focus-visible:text-ink"
        >
          <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />
          <span className="truncate">{title}</span>
        </button>
        {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
        {toggle && (
          <Switch checked={toggle.checked} aria-label={typeof title === "string" ? title : undefined}
            onChange={(v) => { toggle.onChange(v); if (v && !open) { setOpen(true); writeOpen(id, true); } }} />
        )}
      </div>
      {show && <div id={body} className="space-y-2 pb-1 pt-1.5">{children}</div>}
    </section>
  );
}

/** A labelled row: label on the left, control(s) on the right. */
export function Row({ label, children, className, title }: { label: ReactNode; children: ReactNode; className?: string; title?: string }) {
  return (
    <div className={cn("grid min-h-7 grid-cols-[4.75rem_minmax(0,1fr)] items-center gap-2", className)} title={title}>
      <span className="truncate text-2xs text-mute">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

/** A small square icon toggle (flip, lock, italic…). */
export function IconToggle({ title, active, onClick, children, disabled, className, shortcut }: {
  title: string; active?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean; className?: string; shortcut?: ReactNode;
}) {
  return (
    <IconButton title={title} shortcut={shortcut} active={active} aria-pressed={active} disabled={disabled} onClick={onClick}
      className={cn("size-7 rounded-md border border-transparent [&>svg]:size-3.5", active && "border-accent/40 bg-accent/12 text-accent-ink hover:bg-accent/18 hover:text-accent-ink", className)}>
      {children}
    </IconButton>
  );
}

export const miniInput = "h-7 w-full min-w-0 rounded-md border border-line bg-raised px-2 text-xs text-ink placeholder:text-dim outline-none transition-[border-color,box-shadow] hover:border-dim/40 focus:border-accent/70 focus:ring-[3px] focus:ring-accent/15 disabled:opacity-50";

export function MiniSelect<T extends string | number>({ value, onChange, options, className, disabled, "aria-label": ariaLabel, groups }: {
  value: T; onChange: (v: T) => void; options?: { value: T; label: string }[]; className?: string; disabled?: boolean; "aria-label"?: string;
  groups?: { label: string; options: { value: T; label: string }[] }[];
}) {
  const all = groups ? groups.flatMap((g) => g.options) : options ?? [];
  return (
    <select
      value={String(value)}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => { const hit = all.find((o) => String(o.value) === e.target.value); if (hit) onChange(hit.value); }}
      className={cn(miniInput, "cursor-pointer pr-6", className)}
    >
      {groups
        ? groups.map((g) => <optgroup key={g.label} label={g.label}>{g.options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}</optgroup>)
        : all.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  );
}

// ── colour ───────────────────────────────────────────────

interface EyeDropperCtor { new (): { open(): Promise<{ sRGBHex: string }> } }
const eyeDropper = (): EyeDropperCtor | null => (typeof window !== "undefined" && "EyeDropper" in window ? (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper : null);

/** A swatch over the transparency checkerboard. */
export function Swatch({ color, className, style, children }: { color: string; className?: string; style?: CSSProperties; children?: ReactNode }) {
  return (
    <span className={cn("relative block overflow-hidden rounded-[5px] ring-1 ring-inset ring-line", className)} style={{ ...CHECKER, ...style }}>
      <span className="absolute inset-0" style={{ background: color }} />
      {children}
    </span>
  );
}

const NoneMark = () => (
  <span aria-hidden className="absolute inset-0 grid place-items-center">
    <span className="h-px w-[140%] rotate-45 bg-bad" />
  </span>
);

/** Saturation/value square, hue and alpha bars, hex entry, eyedropper and swatches. */
export function ColorPicker({ value, onChange, palette, allowTransparent = true }: {
  value: string; onChange: (v: string) => void; palette?: string[]; allowTransparent?: boolean;
}) {
  const t = useT();
  const parsed = parseColor(value) ?? { rgb: { r: 255, g: 255, b: 255 }, alpha: 1 };
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(parsed.rgb));
  const sent = useRef(value);
  useEffect(() => {
    if (value === sent.current) return;
    sent.current = value;
    const p = parseColor(value);
    if (p) setHsv(rgbToHsv(p.rgb));
  }, [value]);
  const alpha = parsed.alpha;
  const emit = (h: Hsv, a = alpha) => {
    setHsv(h);
    const out = toHex(hsvToRgb(h), a);
    sent.current = out;
    onChange(out);
  };
  const setHex = (hex: string) => {
    const p = parseColor(hex);
    if (!p) return;
    const h = rgbToHsv(p.rgb);
    // keep the hue on greys so dragging back out of black/white doesn't jump to red
    emit(h.s < 0.001 || h.v < 0.001 ? { ...h, h: hsv.h } : h, p.alpha);
  };
  const sv = usePointerPad((fx, fy) => emit({ ...hsv, s: fx, v: 1 - fy }));
  const hue = usePointerPad((fx) => emit({ ...hsv, h: Math.min(359.9, fx * 360) }));
  const alp = usePointerPad((fx) => emit(hsv, Math.round(fx * 100) / 100));
  const pure = toHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 }));
  const opaque = toHex(hsvToRgb(hsv));
  const svKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    const d = e.shiftKey ? 0.1 : 0.01;
    const m: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] };
    const mv = m[e.key];
    if (!mv) return;
    e.preventDefault();
    e.stopPropagation();
    emit({ ...hsv, s: clamp01(hsv.s + mv[0]), v: clamp01(hsv.v + mv[1]) });
  };
  const ED = eyeDropper();
  const chips = (list: string[], label: string, withNone = false) => (
    <div>
      <div className="eyebrow mb-1.5">{label}</div>
      <div className="flex flex-wrap gap-1">
        {list.map((c, i) => (
          <button key={`${c}-${i}`} type="button" title={c} onClick={() => setHex(c)}
            className={cn("rounded-[6px] outline-none ring-offset-1 ring-offset-raised transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-accent",
              normColor(c) === normColor(value) && "ring-2 ring-accent")}>
            <Swatch color={c} className="size-5" />
          </button>
        ))}
        {withNone && (
          <button type="button" title={t("Transparent")} onClick={() => setHex(withAlpha(opaque, 0))}
            className="rounded-[6px] outline-none ring-offset-1 ring-offset-raised transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-accent">
            <Swatch color="transparent" className="size-5"><NoneMark /></Swatch>
          </button>
        )}
      </div>
    </div>
  );
  return (
    <div className="w-[15rem] space-y-2.5 p-2.5">
      <div
        ref={sv.ref}
        {...sv.handlers}
        role="slider"
        tabIndex={0}
        aria-label={t("Saturation and brightness")}
        aria-valuetext={`${Math.round(hsv.s * 100)}% ${Math.round(hsv.v * 100)}%`}
        onKeyDown={svKey}
        className="relative h-36 cursor-crosshair touch-none rounded-lg outline-none ring-1 ring-inset ring-line focus-visible:ring-2 focus-visible:ring-accent"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${pure}` }}
      >
        <span className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.45)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: opaque }} />
      </div>
      <div ref={hue.ref} {...hue.handlers} aria-hidden className="relative h-3 cursor-pointer touch-none rounded-full ring-1 ring-inset ring-line"
        style={{ background: "linear-gradient(90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}>
        <span className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.45)]"
          style={{ left: `${(hsv.h / 360) * 100}%`, background: pure }} />
      </div>
      <div ref={alp.ref} {...alp.handlers} aria-hidden className="relative h-3 cursor-pointer touch-none rounded-full ring-1 ring-inset ring-line" style={CHECKER}>
        <span className="absolute inset-0 rounded-full" style={{ background: `linear-gradient(90deg, ${withAlpha(opaque, 0)}, ${opaque})` }} />
        <span className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.45)]"
          style={{ left: `${alpha * 100}%`, background: withAlpha(opaque, alpha) }} />
      </div>
      <div className="flex items-center gap-1.5">
        <HexInput value={value} onChange={setHex} className="flex-1" />
        <div className={cn(box, "w-[3.25rem] px-1.5")}>
          <NumInput value={alpha} onChange={(a) => emit(hsv, a)} min={0} max={1} step={0.01} scale={100} className="text-right" aria-label={t("Opacity")} />
          <span className="pl-0.5 text-2xs text-dim">%</span>
        </div>
        {ED && (
          <IconButton title={t("Pick a colour from the screen")} className="size-7 rounded-md border border-line bg-raised"
            onClick={() => { new ED().open().then((r) => setHex(withAlpha(r.sRGBHex, alpha))).catch(() => { /* cancelled */ }); }}>
            <Pipette className="size-3.5" />
          </IconButton>
        )}
        <Tooltip content={t("System colour picker")}>
          <label className="relative grid size-7 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-md border border-line bg-raised hover:border-dim/50">
            <span className="size-3.5 rounded-full" style={{ background: "conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }} />
            <input type="color" value={hex6(value)} aria-label={t("System colour picker")} className="absolute inset-0 cursor-pointer opacity-0"
              onChange={(e) => setHex(withAlpha(e.target.value, alpha || 1))} />
          </label>
        </Tooltip>
      </div>
      {!!palette?.length && chips(palette, t("Document"))}
      {chips(QUICK_COLORS, t("Colours"), allowTransparent)}
    </div>
  );
}

/** Hex text box: accepts #rgb, #rrggbb, #rrggbbaa and rgb(); invalid input snaps back. */
export function HexInput({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const handled = useRef(false);
  const shown = (normColor(value) ?? value).replace(/^#/, "").toUpperCase();
  const commit = () => {
    if (draft !== null) {
      const n = normColor(draft.trim());
      if (n && n !== normColor(value)) onChange(n);
    }
    setDraft(null);
  };
  return (
    <div className={cn(box, className)}>
      <span className="pl-2 text-2xs text-dim">#</span>
      <input
        spellCheck={false}
        aria-label={t("Hex colour")}
        value={draft ?? shown}
        onFocus={(e) => { setDraft(shown); requestAnimationFrame(() => e.target.select()); }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (handled.current) handled.current = false; else commit(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { commit(); handled.current = true; (e.target as HTMLInputElement).blur(); }
          if (e.key === "Escape") { setDraft(null); handled.current = true; e.stopPropagation(); (e.target as HTMLInputElement).blur(); }
        }}
        className="mono min-w-0 flex-1 bg-transparent px-1 text-xs uppercase text-ink outline-none"
      />
    </div>
  );
}

/**
 * Colour row: a swatch that opens the full picker, the hex code, and the opacity. `palette` adds the document's
 * colours to the picker. Transparent colours are written as #rrggbb00.
 */
export function ColorField({ value, onChange, palette, allowTransparent = true, className, compact, label }: {
  value: string; onChange: (v: string) => void; palette?: string[]; allowTransparent?: boolean; className?: string;
  /** just the swatch (for tight rows) */
  compact?: boolean;
  label?: string;
}) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const none = isTransparent(value);
  const swatch = (
    <button ref={ref} type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}
      aria-label={label ? `${label}: ${value}` : t("Pick a colour")}
      className={cn("shrink-0 rounded-md outline-none ring-offset-1 ring-offset-panel focus-visible:ring-2 focus-visible:ring-accent", open && "ring-2 ring-accent")}>
      <Swatch color={value} className="size-7">{none && <NoneMark />}</Swatch>
    </button>
  );
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {swatch}
      {!compact && (
        <>
          <HexInput value={withAlpha(value, 1)} className="flex-1"
            onChange={(v) => onChange(alphaOf(v) < 1 ? v : withAlpha(v, alphaOf(value) || 1))} />
          <div className={cn(box, "w-[3.25rem] px-1.5")}>
            <NumInput value={alphaOf(value)} onChange={(a) => onChange(withAlpha(value, a))} min={0} max={1} step={0.01} scale={100}
              className="text-right" aria-label={t("Opacity")} />
            <span className="pl-0.5 text-2xs text-dim">%</span>
          </div>
        </>
      )}
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="left-start">
        <ColorPicker value={value} onChange={onChange} palette={palette} allowTransparent={allowTransparent} />
      </Popover>
    </div>
  );
}

// ── gradients & paint ────────────────────────────────────

/**
 * Gradient editor: linear or radial, an angle dial for linear, and 2–4 stops on a preview bar. Drag stops to move
 * them, click the bar to add one (up to 4), select a stop to recolour it; Delete removes the selected stop.
 */
export function GradientEditor({ value, onChange, palette }: { value: Gradient; onChange: (g: Gradient) => void; palette?: string[] }) {
  const t = useT();
  const [sel, setSel] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; index: number } | null>(null);
  const stops = value.stops;
  const cur = Math.min(sel, stops.length - 1);
  const setStops = (next: GradientStop[]) => onChange({ ...value, stops: next });
  const offsetAt = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect();
    return r ? Math.round(clamp01((clientX - r.left) / r.width) * 100) / 100 : 0;
  };
  const addAt = (offset: number) => {
    if (stops.length >= 4) return;
    const next = [...stops, { offset, color: colorAt(stops, offset) }];
    setStops(next);
    setSel(next.length - 1);
  };
  const remove = (i: number) => {
    if (stops.length <= 2) return;
    setStops(stops.filter((_, k) => k !== i));
    setSel(Math.max(0, i - 1));
  };
  const reverse = () => setStops(stops.map((s) => ({ ...s, offset: +(1 - s.offset).toFixed(3) })));
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Segmented size="sm" value={value.type} onChange={(type) => onChange({ ...value, type })} aria-label={t("Gradient type")}
          options={[{ value: "linear", label: t("Linear") }, { value: "radial", label: t("Radial") }]} />
        <span className="flex-1" />
        <IconButton title={t("Reverse")} onClick={reverse} className="size-7 rounded-md"><ArrowLeftRight className="size-3.5" /></IconButton>
        <IconButton title={t("Add stop")} onClick={() => addAt(0.5)} disabled={stops.length >= 4} className="size-7 rounded-md"><Plus className="size-3.5" /></IconButton>
        <IconButton title={t("Remove stop")} onClick={() => remove(cur)} disabled={stops.length <= 2} className="size-7 rounded-md"><Minus className="size-3.5" /></IconButton>
      </div>
      <div className="px-1.5 pb-3">
        <div
          ref={bar}
          title={stops.length < 4 ? t("Click to add a stop") : undefined}
          onPointerDown={(e) => { if (e.target === e.currentTarget && e.button === 0) addAt(offsetAt(e.clientX)); }}
          className={cn("relative h-6 rounded-md ring-1 ring-inset ring-line", stops.length < 4 && "cursor-copy")}
          style={CHECKER}
        >
          <span className="pointer-events-none absolute inset-0 rounded-md" style={{ background: gradientCss(value, true) }} />
          {stops.map((s, i) => (
            <button
              key={i}
              type="button"
              aria-label={`${t("Stop")} ${i + 1}, ${Math.round(s.offset * 100)}%`}
              aria-pressed={i === cur}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { id: e.pointerId, index: i };
                setSel(i);
              }}
              onPointerMove={(e) => {
                if (drag.current?.id !== e.pointerId) return;
                const o = offsetAt(e.clientX);
                if (o !== stops[i].offset) setStops(stops.map((x, k) => (k === i ? { ...x, offset: o } : x)));
              }}
              onPointerUp={() => { drag.current = null; }}
              onPointerCancel={() => { drag.current = null; }}
              onKeyDown={(e) => {
                if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); remove(i); }
                const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                if (d) {
                  e.preventDefault();
                  e.stopPropagation();
                  setStops(stops.map((x, k) => (k === i ? { ...x, offset: +clamp01(x.offset + d * (e.shiftKey ? 0.1 : 0.01)).toFixed(2) } : x)));
                }
              }}
              className={cn("absolute top-1/2 h-8 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none rounded-[4px] border-2 shadow-[0_0_0_1px_rgb(0_0_0/0.35)] outline-none",
                i === cur ? "z-[1] border-accent" : "border-white")}
              style={{ left: `${s.offset * 100}%`, background: s.color }}
            />
          ))}
        </div>
      </div>
      {stops[cur] && (
        <div className="flex items-center gap-1.5">
          <ColorField value={stops[cur].color} palette={palette} className="flex-1"
            onChange={(c) => setStops(stops.map((x, k) => (k === cur ? { ...x, color: c } : x)))} />
          <NumberField label={t("At")} title={t("Stop position")} value={stops[cur].offset} min={0} max={1} step={0.01} scale={100} suffix="%"
            onChange={(o) => setStops(stops.map((x, k) => (k === cur ? { ...x, offset: o } : x)))} className="w-[4.5rem]" />
        </div>
      )}
      {value.type === "linear" && (
        <Row label={t("Angle")}>
          <AngleField value={value.angle} mode="unsigned" onChange={(angle) => onChange({ ...value, angle })} className="flex-1" />
        </Row>
      )}
    </div>
  );
}

export type PaintMode = "solid" | "gradient" | "none";

export const paintMode = (p: Paint | null | undefined, allowNone = false): PaintMode =>
  p == null ? "none" : typeof p !== "string" ? "gradient" : allowNone && isTransparent(p) ? "none" : "solid";

/**
 * Fill editor: solid ⇄ gradient (⇄ none). Switching keeps what it can: a solid becomes the first stop of a new
 * gradient, a gradient's first stop becomes the solid; the last of each is remembered while the panel is open.
 */
export function PaintField({ value, onChange, allowNone, palette }: {
  value: Paint | null | undefined; onChange: (p: Paint | null) => void; allowNone?: boolean; palette?: string[];
}) {
  const t = useT();
  const mode = paintMode(value, allowNone);
  const lastSolid = useRef<string>(typeof value === "string" && !isTransparent(value) ? value : "#ffffff");
  const lastGrad = useRef<Gradient | null>(value && typeof value !== "string" ? value : null);
  if (typeof value === "string" && !isTransparent(value)) lastSolid.current = value;
  if (value && typeof value !== "string") lastGrad.current = value;
  const to = (m: PaintMode) => {
    if (m === mode) return;
    if (m === "none") onChange(null);
    else if (m === "solid") onChange(value && typeof value !== "string" ? sortStops(value.stops)[0]?.color ?? lastSolid.current : lastSolid.current);
    else {
      const base = typeof value === "string" && !isTransparent(value) ? value : lastSolid.current;
      onChange(lastGrad.current ?? {
        type: "linear", angle: 90,
        stops: [{ offset: 0, color: base }, { offset: 1, color: palette?.find((c) => normColor(c) !== normColor(base)) ?? partner(base) }],
      });
    }
  };
  const options: { value: PaintMode; label: string }[] = [
    { value: "solid", label: t("Solid") }, { value: "gradient", label: t("Gradient") }, ...(allowNone ? [{ value: "none" as const, label: t("None") }] : []),
  ];
  return (
    <div className="space-y-2">
      <Segmented size="sm" value={mode} onChange={to} options={options} className="w-full [&>button]:flex-1" aria-label={t("Fill type")} />
      {mode === "solid" && typeof value === "string" && <ColorField value={value} onChange={onChange} palette={palette} />}
      {mode === "gradient" && value && typeof value !== "string" && <GradientEditor value={value} onChange={onChange} palette={palette} />}
    </div>
  );
}
