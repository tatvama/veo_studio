import { cn } from "../../lib/cn";
import { motion } from "motion/react";
import { useId, type ReactNode } from "react";
import { AnimatedNumber, rise } from "./Motion";

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info";
const toneText: Record<Tone, string> = {
  neutral: "text-ink", accent: "text-accent-ink", ok: "text-ok", warn: "text-warn", bad: "text-bad", info: "text-info",
};
const toneIcon: Record<Tone, string> = {
  neutral: "bg-raised text-mute", accent: "bg-accent/12 text-accent-ink", ok: "bg-ok/12 text-ok",
  warn: "bg-warn/12 text-warn", bad: "bg-bad/12 text-bad", info: "bg-info/12 text-info",
};

/** KPI tile: icon chip, label, big (optionally counting-up) value and a small caption. */
export function Stat({ label, value, format, sub, icon, tone = "neutral", index = 0, className, children }: {
  label: ReactNode; value: number | string; format?: (n: number) => string; sub?: ReactNode; icon?: ReactNode; tone?: Tone;
  index?: number; className?: string; children?: ReactNode;
}) {
  const r = rise(index);
  return (
    <div {...r} className={cn("hud group relative overflow-hidden rounded-xl border border-line bg-panel p-4", r.className, className)}>
      <span aria-hidden className="edge-light pointer-events-none absolute inset-x-0 top-0 h-px opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
      <div className="flex items-center gap-2">
        {icon && <span className={cn("grid size-7 shrink-0 place-items-center rounded-md", toneIcon[tone])}>{icon}</span>}
        <span className="eyebrow min-w-0 truncate">{label}</span>
      </div>
      <div className={cn("mono mt-3 text-[1.65rem] font-medium leading-none tracking-tight", toneText[tone])}>
        {typeof value === "number" ? <AnimatedNumber value={value} format={format} /> : value}
      </div>
      {sub && <p className="mt-1.5 text-2xs text-dim">{sub}</p>}
      {children}
    </div>
  );
}

/** Tiny inline trend line (no axes). Draws itself in. */
export function Sparkline({ data, width = 96, height = 28, className, stroke = "var(--color-accent)" }: {
  data: number[]; width?: number; height?: number; className?: string; stroke?: string;
}) {
  const id = useId();
  if (data.length < 2) return <svg width={width} height={height} className={className} aria-hidden />;
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const pad = 2;
  const pts = data.map((v, i) => [pad + (i * (width - pad * 2)) / (data.length - 1), pad + (1 - (v - min) / span) * (height - pad * 2)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${height} L${pts[0][0].toFixed(1)} ${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="1" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <motion.path d={line} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} />
    </svg>
  );
}

/** Circular progress (0–1) with an optional centre label. */
export function ProgressRing({ value, size = 36, stroke = 3.5, children, className, tone = "var(--color-accent)" }: {
  value: number; size?: number; stroke?: number; children?: ReactNode; className?: string; tone?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className={cn("relative inline-grid place-items-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line)" strokeWidth={stroke} />
        <motion.circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - v) }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }} />
      </svg>
      {children !== undefined && <span className="absolute text-2xs font-semibold tabular-nums">{children}</span>}
    </div>
  );
}
