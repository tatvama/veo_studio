import { Check, ChevronsDownUp, ChevronsUpDown, Clapperboard, PenLine, Sparkles, Zap } from "lucide-react";
import { motion } from "motion/react";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import type { Hook } from "../../lib/types";
import type { HookInsight } from "../../lib/types";
import { AnimatedNumber, Badge, Button, Input, ProgressRing, Skeleton, rise } from "../ui";
import { HookInsights } from "./HookInsights";
import { Fact, RoomEmpty } from "./kit";
import { radioKeys, scoreTone, TONE_TEXT_SM, TONE_VAR, TONE_BG } from "./util";
import { pad, WorkPanel } from "./workspace";

/** Hook types and score names come from the writer as keys; these are their on-screen labels (translated with t). */
const HOOK_LABELS: Record<string, string> = {
  question: "question", bold_claim: "bold claim", visual_shock: "visual shock", pattern_break: "pattern break",
  story: "story", curiosity_gap: "curiosity gap", custom: "custom",
  curiosity: "curiosity", clarity: "clarity", visual: "visual", platform_fit: "platform fit",
};

/**
 * The opening hook: pick one of the writer's options (or write your own). It becomes shot 1. Each option is a selectable
 * card with a score ring and mono sub-scores; once one is chosen the list can fold down to just that option.
 */
export function HookSection({ eid, hooks, selected, canEdit, busy, angle, onAngle, custom, onCustom, onWrite, onSelect, onUseCustom, onInsight, index, n }: {
  eid: number; hooks: Hook[]; selected: number | null; canEdit: boolean; busy: string;
  angle: string; onAngle: (v: string) => void; custom: string; onCustom: (v: string) => void;
  onWrite: () => void; onSelect: (i: number) => void; onUseCustom: () => void; onInsight: (h: HookInsight) => void; index?: number; n?: number;
}) {
  const t = useT();
  const writing = busy === "hooks";
  const [folded, setFolded] = useState(false);
  const submit = (e: FormEvent) => { e.preventDefault(); if (custom.trim() && busy !== "custom") onUseCustom(); };
  const chosen = selected !== null ? hooks[selected] : undefined;
  const fold = folded && !!chosen && !writing;

  return (
    <WorkPanel id="hook" index={index} n={n} kicker={t("Opening")} icon={<Zap />} title={t("Hook — the first 1.5–3 seconds")} description={t("Pick the strongest opening. It becomes shot 1.")}
      badge={hooks.length > 0 ? <span className="mono rounded bg-raised px-1.5 text-2xs font-medium leading-4 text-dim">{hooks.length}</span> : undefined}
      actions={
        <>
          {canEdit && !fold && (
            <>
              <div className={cn("max-w-full transition-[width] duration-200", angle.length > 24 ? "w-72" : "w-56")}>
                <Input placeholder={t("Angle (optional): funnier, scarier…")} aria-label={t("Hook angle")} value={angle} onChange={(e) => onAngle(e.target.value)} className="h-8!" />
              </div>
              <Button size="sm" variant={hooks.length ? "secondary" : "primary"} loading={writing} icon={<Sparkles className="size-3.5 text-ai" />} onClick={onWrite}>
                {hooks.length ? t("More hooks") : t("Write hooks")}
              </Button>
            </>
          )}
          {!!chosen && (
            <Button size="sm" variant="ghost" aria-expanded={!fold} icon={fold ? <ChevronsUpDown className="size-3.5" /> : <ChevronsDownUp className="size-3.5" />} onClick={() => setFolded(!fold)}>
              {fold ? t("Show all options") : t("Fold options")}
            </Button>
          )}
        </>
      }>
      {fold && chosen && selected !== null ? (
        <HookCard eid={eid} hook={chosen} index={selected} selected canEdit={false} compact onSelect={() => undefined} />
      ) : (
        <>
          <HookInsights onUse={canEdit ? onInsight : undefined} />

          {!hooks.length && !writing ? (
            <RoomEmpty icon={<Zap />} title={t("No hooks yet")} sub={t("Write hooks to choose a strong opening.")} />
          ) : (
            <div role="radiogroup" aria-label={t("Hook options")} aria-busy={writing || undefined} onKeyDown={radioKeys(false) as (e: KeyboardEvent<HTMLElement>) => void}
              className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,16.5rem),1fr))]">
              {hooks.map((h, i) => (
                <HookCard key={`${i}-${h.text}`} eid={eid} hook={h} index={i} selected={selected === i} canEdit={canEdit} onSelect={() => onSelect(i)} />
              ))}
              {writing && Array.from({ length: hooks.length ? 2 : 6 }, (_, i) => (
                <div key={`sk-${i}`} aria-hidden className="rounded-xl border border-line bg-panel p-3.5">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-2"><Skeleton className="h-4 w-20" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" /></div>
                    <Skeleton className="size-10 !rounded-full" />
                  </div>
                  <Skeleton className="mt-3 h-3 w-2/3" />
                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2"><Skeleton className="h-6" /><Skeleton className="h-6" /><Skeleton className="h-6" /><Skeleton className="h-6" /></div>
                </div>
              ))}
            </div>
          )}

          {canEdit && (
            <form onSubmit={submit} className="mt-4 flex gap-2">
              <div className="relative min-w-0 flex-1">
                <PenLine aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-dim" />
                <Input className="pl-9" placeholder={t("…or write your own hook")} aria-label={t("Your own hook")} value={custom} onChange={(e) => onCustom(e.target.value)} />
              </div>
              <Button type="submit" disabled={!custom.trim()} loading={busy === "custom"}>{t("Use")}</Button>
            </form>
          )}
        </>
      )}
    </WorkPanel>
  );
}

function HookCard({ eid, hook: h, index, selected, canEdit, onSelect, compact }: {
  eid: number; hook: Hook; index: number; selected: boolean; canEdit: boolean; onSelect: () => void; compact?: boolean;
}) {
  const t = useT();
  const r = rise(index);
  const total = h.total || 0;
  const tone = scoreTone(total);
  const scores = Object.entries(h.scores ?? {}).filter(([, v]) => typeof v === "number");
  const type = h.type || "custom";
  const body = (
    <>
      {selected && !compact && (
        <motion.span aria-hidden layoutId={`hook-sel-${eid}`} transition={{ type: "spring", stiffness: 420, damping: 34 }}
          className="pointer-events-none absolute -inset-px rounded-xl border-2 border-accent bg-accent/6 shadow-[0_0_18px_-6px_var(--color-accent)]" />
      )}
      <div className="relative flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className={cn("mono inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-2xs leading-none tracking-wider",
              selected ? "border-accent/40 bg-accent/10 text-accent-ink" : "border-line bg-raised/70 text-mute")}>
              <span aria-hidden className={cn("size-1.5 rounded-full", selected ? "bg-accent shadow-[0_0_6px_var(--color-accent)]" : "border border-dim/70")} />
              OPT {pad(index + 1)}
            </span>
            <Badge tone="info">{t(HOOK_LABELS[type] ?? type.replace(/_/g, " "))}</Badge>
            {selected && <Fact tone="accent" icon={<Check strokeWidth={3} />}>{t("Selected")}</Fact>}
          </div>
          <p className={cn("text-sm font-medium leading-snug", compact ? "line-clamp-2" : "line-clamp-4")} title={h.text}>{h.text}</p>
        </div>
        {total > 0 && (
          <ProgressRing value={total / 10} size={compact ? 44 : 48} stroke={4} tone={TONE_VAR[tone]}>
            <span className="mono"><AnimatedNumber value={total} format={(n) => n.toFixed(1)} duration={0.7} /></span>
          </ProgressRing>
        )}
      </div>
      {h.visual && !compact && (
        <p className="relative mt-2.5 flex items-start gap-1.5 text-xs leading-snug text-mute">
          <Clapperboard aria-hidden className="mt-px size-3.5 shrink-0 text-dim" />
          <span className="line-clamp-2">{h.visual}</span>
        </p>
      )}
      {scores.length > 0 && !compact && (
        <div className="relative mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-line/70 pt-3">
          {scores.map(([k, v], i) => <MiniScore key={k} label={t(HOOK_LABELS[k] ?? k.replace(/_/g, " "))} value={v} delay={i * 0.04} />)}
        </div>
      )}
    </>
  );
  return (
    <div {...r}>
      {compact ? (
        <div className="relative rounded-xl border border-accent/40 bg-accent/5 p-3.5">{body}</div>
      ) : (
        <button type="button" role="radio" aria-checked={selected} disabled={!canEdit} onClick={onSelect}
          className={cn("hud group relative flex h-full w-full flex-col rounded-xl border bg-panel p-3.5 text-left transition-colors disabled:cursor-default",
            canEdit && "lift", selected ? "border-transparent" : "border-line", canEdit && !selected && "hover:border-dim/60")}>
          {body}
        </button>
      )}
    </div>
  );
}

/** A sub-score: mono label, mono value in its status colour and a hairline bar that fills in. */
function MiniScore({ label, value, delay = 0 }: { label: string; value: number; delay?: number }) {
  const tone = scoreTone(value);
  return (
    <div className="min-w-0" role="img" aria-label={`${label}: ${value.toFixed(1)} / 10`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="eyebrow truncate !tracking-wider">{label}</span>
        <span className={cn("mono shrink-0 text-xs font-semibold", TONE_TEXT_SM[tone])}>{value.toFixed(1)}</span>
      </div>
      <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-line">
        <motion.div className={cn("h-full rounded-full", TONE_BG[tone])} initial={{ width: 0 }} animate={{ width: `${Math.max(Math.min(value * 10, 100), 3)}%` }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1], delay }} />
      </div>
    </div>
  );
}
