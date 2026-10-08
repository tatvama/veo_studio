import { clsx } from "clsx";
import { ChartLine, ChevronDown, Eye } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useT } from "../../lib/i18n";
import { useHookInsights } from "../../lib/queries";
import type { HookInsight } from "../../lib/types";
import { Button } from "../ui";

/** Tiny audience-retention sparkline. Points are [elapsed ratio 0–1, audience watch ratio]. */
export function RetentionSparkline({ points, width = 120, height = 28, className }: {
  points: [number, number][]; width?: number; height?: number; className?: string;
}) {
  if (!points?.length) return <span className={clsx("inline-block text-2xs text-dim", className)} style={{ width }}>—</span>;
  const maxY = Math.max(1, ...points.map((p) => p[1]));
  const pad = 2;
  const x = (v: number) => pad + Math.max(0, Math.min(1, v)) * (width - pad * 2);
  const y = (v: number) => pad + (1 - Math.max(0, v) / maxY) * (height - pad * 2);
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const line = sorted.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  const area = `${line} L${x(sorted[sorted.length - 1][0]).toFixed(1)},${height - pad} L${x(sorted[0][0]).toFixed(1)},${height - pad} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={clsx("shrink-0 overflow-visible", className)} aria-hidden>
      <line x1={pad} x2={width - pad} y1={y(0.5)} y2={y(0.5)} className="stroke-line" strokeDasharray="2 3" strokeWidth={1} />
      <path d={area} className="fill-accent/15" />
      <motion.path d={line} fill="none" className="stroke-accent" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round"
        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.6, ease: "easeOut" }} />
    </svg>
  );
}

/** Our best-retaining published hooks (YouTube Analytics) — shown next to hook writing. */
export function HookInsights({ onUse, limit = 5 }: { onUse?: (hook: HookInsight) => void; limit?: number }) {
  const t = useT();
  const { data } = useHookInsights();
  const [open, setOpen] = useState(false);
  const rows = (data ?? []).filter((r) => r.avg_view_pct !== null).slice(0, limit);
  if (!rows.length) return null;

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-line bg-bg/40">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-hover/50">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent-ink"><ChartLine className="size-4" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t("What kept viewers watching")}</span>
          <span className="block truncate text-xs text-mute">{t("Your top {n} hooks by average view %", { n: rows.length })}</span>
        </span>
        <ChevronDown className={clsx("size-4 shrink-0 text-mute transition-transform duration-200", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
            <ul className="divide-y divide-line/60 border-t border-line">
              {rows.map((r, i) => (
                <li key={`${r.export_id}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-raised text-2xs font-semibold tabular-nums text-mute">{i + 1}</span>
                  <p className="min-w-0 flex-1 basis-48 text-sm leading-snug">{r.hook}</p>
                  <RetentionSparkline points={r.retention} className="hidden @lg:block" />
                  <div className="w-16 shrink-0 text-right">
                    <p className="text-sm font-semibold tabular-nums text-accent-ink">{(r.avg_view_pct ?? 0).toFixed(0)}%</p>
                    <p className="flex items-center justify-end gap-0.5 text-2xs text-dim"><Eye className="size-3" />{r.views.toLocaleString()}</p>
                  </div>
                  {onUse && <Button size="sm" variant="ghost" onClick={() => onUse(r)}>{t("Use as angle")}</Button>}
                </li>
              ))}
            </ul>
            <p className="border-t border-line px-3.5 py-2 text-2xs text-dim">{t("The hook writer already learns from these automatically. Dashed line = 50% still watching.")}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
