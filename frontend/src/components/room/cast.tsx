import { Check, Circle, Loader2, ScanFace, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { LANG_NAMES, LANG_SHORT } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { Project } from "../../lib/types";
import { SHEET_VIEWS } from "../../lib/v3";
import { Avatar, Meter, Progress } from "../ui";
import { VIEW_LABEL, coversEpisode, strictnessLevel, type StrictnessLevel } from "./look";
import { IDENTITY_STATUS } from "./util";
import "../../styles/casting.css";

/*
 * Local building blocks of the casting workspace (Bible, character file, outfits, versions, locations, style).
 * The shared page primitives (Workspace, WorkPanel, StatStrip, Outline, ViewSwitch, IdChip) live in workspace.tsx.
 */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Squeezes a count into a segmented Meter of at most `max` cells (a non-zero count always lights at least one). */
export function scaleMeter(filled: number, total: number, max = 8): { filled: number; total: number } {
  const tot = Math.max(1, total);
  if (tot <= max) return { filled: Math.max(0, Math.min(filled, tot)), total: tot };
  const f = Math.round((filled / tot) * max);
  return { filled: filled > 0 ? Math.max(1, f) : 0, total: max };
}

// ── voices ───────────────────────────────────────────────────────────────────

/** The languages a character already has a voice for (the list payload carries voices as objects or as plain language codes). */
export function voicedLanguages(voices: unknown[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const v of voices ?? []) {
    const l = typeof v === "string" ? v : (v as { language?: string } | null)?.language;
    if (l) out.add(l);
  }
  return out;
}

/** Project languages as mono chips: voiced = bright, still missing = dashed and dim. */
export function LangChips({ languages, voiced, className }: { languages: string[]; voiced: Set<string>; className?: string }) {
  const t = useT();
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {languages.map((l) => {
        const on = voiced.has(l);
        const state = on ? t("voiced") : t("no voice yet");
        return (
          <span key={l} title={`${LANG_NAMES[l] ?? l}: ${state}`}
            className={cn("mono inline-flex h-5 items-center rounded border px-1 text-2xs font-semibold leading-none",
              on ? "border-line bg-raised text-ink" : "border-dashed border-line text-dim/80")}>
            {LANG_SHORT[l] ?? l.toUpperCase()}<span className="sr-only">: {state}</span>
          </span>
        );
      })}
    </span>
  );
}

// ── lock level ───────────────────────────────────────────────────────────────

const LEVEL_TONE = { lenient: "warn", balanced: "accent", strict: "ok" } as const;
const LEVEL_FILL = { lenient: 1, balanced: 2, strict: 3 } as const;
export const LEVEL_TEXT: Record<StrictnessLevel, string> = { lenient: "text-amber-300", balanced: "text-accent-ink", strict: "text-green-300" };

/** Lock strictness as a 3-segment meter (lenient / balanced / strict). Unknown strictness (list payloads) shows an empty meter. */
export function LockMeter({ strictness, className }: { strictness: number | undefined; className?: string }) {
  const known = typeof strictness === "number";
  const level = strictnessLevel(strictness);
  return <Meter filled={known ? LEVEL_FILL[level] : 0} total={3} tone={LEVEL_TONE[level]} className={className} />;
}

// ── reference pack ───────────────────────────────────────────────────────────

type AssetLike = { kind: string; approved?: boolean; archived?: boolean };
export type PackState = "approved" | "made" | "missing";
export interface PackPart { key: string; label: string; state: PackState }

/** The seven stations of a complete reference pack: five sheet angles, expressions, lighting. `label` is an English key (pass it through t()). */
export function packOf(assets: readonly AssetLike[] | undefined): PackPart[] {
  const refs = (assets ?? []).filter((a) => !a.archived && a.kind !== "identity_test" && a.kind !== "training");
  const stateOf = (has: AssetLike[]): PackState => (has.some((a) => a.approved) ? "approved" : has.length ? "made" : "missing");
  return [
    ...SHEET_VIEWS.map((k) => ({ key: k, label: VIEW_LABEL[k], state: stateOf(refs.filter((a) => a.kind === k)) })),
    { key: "expressions", label: "Expressions", state: stateOf(refs.filter((a) => a.kind === "expression")) },
    { key: "lighting", label: "Lighting", state: stateOf(refs.filter((a) => a.kind === "lighting")) },
  ];
}
export const packDone = (pack: PackPart[]) => pack.filter((p) => p.state === "approved").length;

const PACK_SEG: Record<PackState, string> = {
  approved: "bg-ok shadow-[0_0_6px_-1px_var(--color-ok)]", made: "bg-warn/70", missing: "cs-hatch bg-line",
};

/** The pack as one segmented bar: approved = lit, generated but not approved = amber, not made = hatched. */
export function PackBar({ pack, className, thick }: { pack: PackPart[]; className?: string; thick?: boolean }) {
  const t = useT();
  return (
    <span role="img" aria-label={t("pack {a}/{n}", { a: packDone(pack), n: pack.length })} className={cn("flex gap-[3px]", className)}>
      {pack.map((p) => <span key={p.key} className={cn("flex-1 rounded-[2px]", thick ? "h-2" : "h-1.5", PACK_SEG[p.state])} />)}
    </span>
  );
}

/** The pack bar with a station under every segment: the compact legend of what is approved, generated or still missing. */
export function PackStations({ pack }: { pack: PackPart[] }) {
  const t = useT();
  return (
    <ul aria-label={t("Pack completeness")} className="grid grid-cols-4 gap-x-1.5 gap-y-3 @xl:grid-cols-7">
      {pack.map((p) => (
        <li key={p.key} className="min-w-0">
          <span aria-hidden className={cn("block h-2 rounded-[2px]", PACK_SEG[p.state])} />
          <span className={cn("mt-1.5 flex items-center gap-1 text-2xs leading-tight [&>svg]:size-3 [&>svg]:shrink-0",
            p.state === "approved" ? "text-green-300" : p.state === "made" ? "text-amber-300" : "text-dim")}>
            {p.state === "approved" ? <Check strokeWidth={3} /> : p.state === "made" ? <Circle /> : <Circle strokeDasharray="2 2.5" />}
            <span className="min-w-0 truncate" title={t(p.label)}>{t(p.label)}</span>
            <span className="sr-only">: {p.state === "approved" ? t("approved") : p.state === "made" ? t("generated, not approved") : t("missing")}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── identity ─────────────────────────────────────────────────────────────────

const ID_TEXT = { neutral: "text-dim", info: "text-sky-300", ok: "text-green-300", bad: "text-red-300" } as const;

/** Identity status as an icon and a word (never colour alone). */
export function IdMark({ status, className }: { status: keyof typeof IDENTITY_STATUS | undefined; className?: string }) {
  const t = useT();
  const s = IDENTITY_STATUS[status ?? "none"] ?? IDENTITY_STATUS.none;
  const busy = status === "training" || status === "preparing";
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium [&>svg]:size-3.5 [&>svg]:shrink-0", ID_TEXT[s.tone], className)}>
      {busy ? <Loader2 className="animate-spin" /> : status === "failed" ? <X strokeWidth={3} /> : <ScanFace />}
      {t(s.label)}
    </span>
  );
}

// ── portrait ─────────────────────────────────────────────────────────────────

/** A portrait in a HUD frame: brackets on the outside, a faint scanline well on the inside (empty slots keep the texture). */
export function Portrait({ src, name, avatar = 64, ratio = "aspect-[3/4]", className, imgClassName, children, alt, placeholder }: {
  src?: string; name: string; avatar?: number; ratio?: string; className?: string; imgClassName?: string; children?: ReactNode; alt?: string;
  /** what fills the well when there is no image (initials by default) */ placeholder?: ReactNode;
}) {
  return (
    <span className={cn("hud relative block rounded-lg", className)}>
      <span className={cn("rm-scan relative block w-full overflow-hidden rounded-lg border border-line bg-raised", ratio)}>
        {src ? <img src={src} alt={alt ?? ""} loading="lazy" className={cn("size-full object-cover", imgClassName)} /> : (
          <span className="grid size-full place-items-center bg-gradient-to-br from-accent/10 via-transparent to-transparent">{placeholder ?? <Avatar name={name} size={avatar} />}</span>
        )}
        {children}
      </span>
    </span>
  );
}

// ── jobs ─────────────────────────────────────────────────────────────────────

/** "Work is running" strip: equalizer, what it is doing, a mono percentage and a progress bar. */
export function JobStrip({ label, right, progress }: { label: ReactNode; right: ReactNode; progress: number }) {
  return (
    <div role="status" className="rounded-lg border border-info/30 bg-info/8 p-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-2 text-sky-300">
          <span aria-hidden className="eq shrink-0"><i /><i /><i /><i /></span>
          <span className="truncate">{label}</span>
        </span>
        <span className="mono shrink-0 text-mute">{right}</span>
      </div>
      <Progress value={progress} tone="info" />
    </div>
  );
}

/** Mono group header: eyebrow title, a count, an optional hint and a dashed leader. */
export function GroupHead({ title, count, hint }: { title: ReactNode; count?: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <h3 className="eyebrow min-w-0 truncate !text-mute">{title}</h3>
      {count !== undefined && <span className="mono text-2xs text-dim">{count}</span>}
      {hint && <span className="text-2xs text-dim">{hint}</span>}
      <span aria-hidden className="rm-rule hidden h-px min-w-6 flex-1 @md:block" />
    </div>
  );
}

// ── episode axis ─────────────────────────────────────────────────────────────

/** How many episodes the axis spans: the project's episodes (cut-downs aside), or further if a range reaches past them. */
export function episodeTotal(project: Project | null | undefined, ranges: { from?: number | null; to?: number | null }[]): number {
  let n = project ? project.episodes.filter((e) => e.kind !== "cutdown").length : 0;
  for (const r of ranges) n = Math.max(n, r.from ?? 0, r.to ?? 0);
  return n;
}

/** Position of an episode range on an axis of `total` episodes. Open ends (no first / no last episode) run to the edge and fade out. */
function spanOf(from: number | null | undefined, to: number | null | undefined, total: number) {
  const a = Math.min(total, Math.max(1, from ?? 1));
  const b = Math.max(a, Math.min(total, to ?? total));
  return { left: ((a - 1) / total) * 100, width: ((b - a + 1) / total) * 100, openL: from == null && to != null, openR: to == null && from != null };
}

export type BarTone = "neutral" | "accent" | "now";
const BAR: Record<BarTone, string> = {
  neutral: "border-dim/40 bg-hover",
  accent: "border-accent/45 bg-accent/15",
  now: "border-accent bg-accent/35 shadow-[0_0_10px_-3px_var(--color-accent)]",
};

function Bar({ from, to, total, tone, className }: { from?: number | null; to?: number | null; total: number; tone: BarTone; className?: string }) {
  const s = spanOf(from, to, total);
  return (
    <span aria-hidden className={cn("absolute rounded-[3px] border", BAR[tone], s.openL && "cs-open-l", s.openR && "cs-open-r", className)}
      style={{ left: `${s.left}%`, width: `${s.width}%`, minWidth: 6 }} />
  );
}

/** One episode range on a thin track (used on every version of the timeline). The current episode is a lit column. */
export function RangeBar({ total, from, to, current, tone = "neutral", className }: {
  total: number; from?: number | null; to?: number | null; current?: number; tone?: BarTone; className?: string;
}) {
  if (total < 1) return null;
  return (
    <span aria-hidden className={cn("cs-ticks relative block h-4 rounded-[3px] border border-line bg-bg/40", className)} style={{ "--n": total } as CSSProperties}>
      {current !== undefined && current >= 1 && current <= total && (
        <span className="absolute inset-y-0 border-x border-accent/40 bg-accent/10" style={{ left: `${((current - 1) / total) * 100}%`, width: `${100 / total}%` }} />
      )}
      <Bar from={from} to={to} total={total} tone={tone} className="inset-y-0.5" />
    </span>
  );
}

export interface AxisRow { key: string | number; label: ReactNode; sr?: string; from?: number | null; to?: number | null; tone?: "accent" | "neutral"; meta?: ReactNode }

/**
 * Episode coverage: a mono axis E01..EN with one bar per row (an outfit) spanning its episode range, and the current episode
 * marked as a lit column. The rows' labels are real text (screen readers get each range from `sr`); the track is decoration.
 */
export function EpisodeAxis({ total, current, rows, label }: { total: number; current?: number; rows: AxisRow[]; label: string }) {
  const step = Math.max(1, Math.ceil(total / 10));
  const marks = Array.from({ length: total }, (_, i) => i + 1).filter((n) =>
    n === current || ((n - 1) % step === 0 && (current === undefined || step === 1 || Math.abs(n - current) > 1)));
  const curOn = current !== undefined && current >= 1 && current <= total;
  return (
    <div role="group" aria-label={label} className="flex gap-3">
      <div className="w-[min(10rem,34%)] shrink-0">
        <div className="h-5" />
        {rows.map((r) => (
          <div key={r.key} className="flex h-7 min-w-0 items-center gap-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            {r.meta}
            {r.sr && <span className="sr-only">{r.sr}</span>}
          </div>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <div aria-hidden className="relative h-5">
          {marks.map((n) => (
            <span key={n} className={cn("mono absolute top-0 -translate-x-1/2 text-2xs leading-5", n === current ? "font-semibold text-accent-ink" : "text-dim")}
              style={{ left: `${((n - 0.5) / total) * 100}%` }}>E{pad2(n)}</span>
          ))}
        </div>
        <div aria-hidden className="cs-ticks relative rounded-[3px] border-y border-line bg-bg/40" style={{ "--n": total } as CSSProperties}>
          {curOn && (
            <span className="absolute inset-y-0 border-x border-accent/40 bg-accent/10" style={{ left: `${((current! - 1) / total) * 100}%`, width: `${100 / total}%` }} />
          )}
          {rows.map((r) => (
            <div key={r.key} className="relative h-7">
              <Bar from={r.from} to={r.to} total={total} className="inset-y-1.5"
                tone={coversEpisode(r.from, r.to, current) ? "now" : r.tone ?? "neutral"} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── vitals ───────────────────────────────────────────────────────────────────

/** One cell of the vitals row on a character's ID card: a mono label, a value and an optional visual. It jumps to its section. */
export function Vital({ label, onClick, title, children }: { label: ReactNode; onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={title}
      className="flex min-h-14 w-full flex-col items-start justify-between gap-2 p-3 text-left transition-colors hover:bg-hover/40 sm:min-h-12 @md:px-4">
      <span className="eyebrow">{label}</span>
      <span className="flex w-full min-w-0 flex-col gap-1.5">{children}</span>
    </button>
  );
}

/** A compact mono code for an episode range: "ALL", "E04", "E02–05", "E04+", "≤E03". */
export function rangeCode(from?: number | null, to?: number | null): string {
  if (from == null && to == null) return "ALL";
  if (from != null && to == null) return `E${pad2(from)}+`;
  if (from == null && to != null) return `≤E${pad2(to)}`;
  if (from === to) return `E${pad2(from as number)}`;
  return `E${pad2(from as number)}–${pad2(to as number)}`;
}
