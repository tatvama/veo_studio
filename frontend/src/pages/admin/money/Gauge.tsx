import { motion } from "motion/react";
import type { ReactNode } from "react";

/**
 * 270° budget gauge: grey track, a faint arc for money reserved by running jobs and a solid arc for what's spent.
 * Both arcs draw themselves in. `children` sits in the middle.
 */
export function BudgetGauge({ spent, reserved, cap, size = 184, stroke = 14, color = "var(--color-accent)", children, label }: {
  spent: number; reserved: number; cap: number; size?: number; stroke?: number; color?: string; children?: ReactNode; label: string;
}) {
  const r = (size - stroke) / 2;
  const c = size / 2;
  const pt = (deg: number) => [c + r * Math.cos((deg * Math.PI) / 180), c + r * Math.sin((deg * Math.PI) / 180)];
  const [x0, y0] = pt(135);
  const [x1, y1] = pt(45);
  const d = `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 1 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const sp = cap > 0 ? clamp(spent / cap) : 0;
  const rs = cap > 0 ? clamp((spent + reserved) / cap) : 0;
  return (
    <div role="img" aria-label={label} className="relative shrink-0" style={{ width: size, height: size * 0.88 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute left-0 top-0 overflow-visible" aria-hidden>
        <path d={d} pathLength={1} fill="none" stroke="var(--color-line)" strokeWidth={stroke} strokeLinecap="round" />
        {rs > sp && (
          <motion.path d={d} fill="none" stroke={color} strokeOpacity={0.32} strokeWidth={stroke} strokeLinecap="round"
            initial={{ pathLength: 0 }} animate={{ pathLength: rs }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: 0.1 }} />
        )}
        {sp > 0 && (
          <motion.path d={d} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
            initial={{ pathLength: 0 }} animate={{ pathLength: sp }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} />
        )}
      </svg>
      <div className="absolute inset-x-0 flex flex-col items-center justify-center text-center" style={{ top: size * 0.3, height: size * 0.4 }}>{children}</div>
    </div>
  );
}
