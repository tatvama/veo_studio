import { animate, motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { MoneyText } from "./Money";

/**
 * Entrance animation, CSS-only so it stays cheap on big grids.
 *   <div {...rise(i)}>…</div>          fade + rise, staggered by index (capped at 14 siblings)
 *   <div {...rise(i, "pop")}>…</div>   scale-in instead
 */
export type EnterKind = "rise" | "fade" | "pop" | "left" | "right";
export function rise(i = 0, kind: EnterKind = "rise"): { className: string; style: CSSProperties } {
  return { className: `anim-${kind}`, style: { "--i": Math.min(i, 14) } as CSSProperties };
}

/** Wrapper form of rise(): <Reveal i={index}>…</Reveal>. */
export function Reveal({ children, i = 0, kind = "rise", as, className, style }: {
  children: ReactNode; i?: number; kind?: EnterKind; as?: ElementType; className?: string; style?: CSSProperties;
}) {
  const Tag = (as ?? "div") as ElementType;
  const r = rise(i, kind);
  return <Tag className={cn(r.className, className)} style={{ ...r.style, ...style }}>{children}</Tag>;
}

/** Fades a block in the first time it scrolls into view (use for sections below the fold). */
export function InView({ children, className, delay = 0, y = 14 }: { children: ReactNode; className?: string; delay?: number; y?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, margin: "0px 0px -8% 0px" });
  const reduce = useReducedMotion();
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={reduce ? false : { opacity: 0, y }}
      animate={seen || reduce ? { opacity: 1, y: 0 } : undefined}
      transition={{ duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** A number that counts up (or down) to its value. Falls back to the plain value with reduced motion. */
export function AnimatedNumber({ value, format = (n) => Math.round(n).toLocaleString(), duration = 0.9, className }: {
  value: number; format?: (n: number) => string; duration?: number; className?: string;
}) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  const from = useRef(reduce ? value : 0);
  useEffect(() => {
    if (reduce) { setShown(value); from.current = value; return; }
    const controls = animate(from.current, value, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setShown(v),
      onComplete: () => { from.current = value; },
    });
    return () => { from.current = shown; controls.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration, reduce]);
  return <span className={cn("tabular-nums", className)}><MoneyText text={format(shown)} /></span>;
}
