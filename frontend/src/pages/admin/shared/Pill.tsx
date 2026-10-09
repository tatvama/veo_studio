import { clsx } from "clsx";
import type { ReactNode } from "react";

const TONES = {
  neutral: "border-line bg-raised text-mute",
  accent: "border-accent/30 bg-accent/8 text-accent-ink",
  ok: "border-ok/30 bg-ok/8 text-green-300",
  warn: "border-warn/30 bg-warn/8 text-amber-300",
  bad: "border-bad/30 bg-bad/8 text-red-300",
  info: "border-info/30 bg-info/8 text-sky-300",
} as const;
const DOTS = { neutral: "bg-dim", accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-info" } as const;

/**
 * Status chip with a lighter tint than <Badge>, so the 11px text keeps AA contrast in the light theme too.
 * Same props as Badge (tone, dot, title, className).
 */
export function Pill({ tone = "neutral", dot, title, className, children }: {
  tone?: keyof typeof TONES; dot?: boolean; title?: string; className?: string; children: ReactNode;
}) {
  return (
    <span title={title} className={clsx("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs font-medium leading-none", TONES[tone], className)}>
      {dot && <span className={clsx("size-1.5 rounded-full", DOTS[tone])} />}
      {children}
    </span>
  );
}
