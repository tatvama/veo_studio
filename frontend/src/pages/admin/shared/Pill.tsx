import { clsx } from "clsx";
import type { ReactNode } from "react";
import "../../../styles/admin.css";

export type PillTone = "neutral" | "accent" | "money" | "ai" | "ok" | "warn" | "bad" | "info";

/**
 * Status chip with a lighter tint than <Badge>: the text is the tone mixed with ink, so the 11px text keeps AA contrast in
 * both themes. Same props as Badge (tone, dot, title, className). Pair a tone with an icon or a dot, never colour alone.
 */
export function Pill({ tone = "neutral", dot, title, className, children }: {
  tone?: PillTone; dot?: boolean; title?: string; className?: string; children: ReactNode;
}) {
  return (
    <span title={title} data-tone={tone} className={clsx("ad-pill", className)}>
      {dot && <span aria-hidden className="ad-pill-dot" />}
      {children}
    </span>
  );
}
