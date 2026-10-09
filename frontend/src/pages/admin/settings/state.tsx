import { Circle, CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { createContext, type ReactNode } from "react";
import { StatusDot } from "../../../components/ui";
import { cn as clsx } from "../../../lib/cn";

/** Health of one settings section, shown as a small glyph + word in the section list and the panel header. */
export type StatusTone = "ok" | "warn" | "bad" | "info" | "idle";
export interface SectionStatus { tone: StatusTone; label: string }

/** What every section panel needs to know about the page: which one is lit, how healthy each is, and its unsaved count. */
export interface SectionState { active: string; status: Record<string, SectionStatus>; dirty: Record<string, number> }
export const SectionStateContext = createContext<SectionState>({ active: "", status: {}, dirty: {} });

const GLYPH = { ok: CircleCheck, warn: TriangleAlert, bad: CircleAlert, info: Info, idle: Circle } as const;
/** Icons and dots use the status tokens; words use the tuned -300 shades so 11px text keeps contrast in the light theme. */
const GLYPH_COLOR: Record<StatusTone, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", info: "text-info", idle: "text-dim" };
const WORD_COLOR: Record<StatusTone, string> = { ok: "text-green-300", warn: "text-amber-300", bad: "text-red-300", info: "text-sky-300", idle: "text-dim" };

/** Status icon plus its word. The word is visible when `word` is set, and always available to screen readers and as a tooltip. */
export function StatusGlyph({ status, word, className }: { status: SectionStatus; word?: boolean; className?: string }) {
  const Icon = GLYPH[status.tone];
  return (
    <span title={status.label} className={clsx("inline-flex min-w-0 items-center gap-1.5", className)}>
      <Icon aria-hidden className={clsx("size-3.5 shrink-0", GLYPH_COLOR[status.tone])} />
      <span className={clsx(word ? "mono max-w-44 truncate text-2xs max-sm:sr-only" : "sr-only", word && WORD_COLOR[status.tone])}>{status.label}</span>
    </span>
  );
}

/** Dot + word for a state ("Live", "No key"…). `live` adds the pulsing ping. */
export function StateTag({ tone, live, children, title, className }: {
  tone: StatusTone; live?: boolean; children: ReactNode; title?: string; className?: string;
}) {
  return (
    <span title={title} className={clsx("mono inline-flex items-center gap-1.5 text-2xs", WORD_COLOR[tone], className)}>
      {live ? <span aria-hidden className={clsx("live-dot", tone === "warn" && "is-warn", tone === "bad" && "is-bad", tone === "idle" && "is-idle")} /> : <StatusDot tone={tone === "idle" ? "neutral" : tone} />}
      {children}
    </span>
  );
}
