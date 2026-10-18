import { clsx } from "clsx";
import { AudioLines, Film, Image as ImageIcon, Loader2, Mic, Pause, Play, ScanFace } from "lucide-react";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Avatar, Button, Tooltip } from "../../../components/ui";
import { usd } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import type { Character } from "../../../lib/types";
import { useEstimate } from "./data";
import { STEP_LABEL, type Dot, type StepId } from "./model";

const STEP_ICON: Record<StepId, typeof Film> = { picture: ImageIcon, video: Film, voice: Mic, mouth: ScanFace, sound: AudioLines };

const DOT_TONE: Record<Dot["state"], string> = {
  done: "border-ok/45 bg-ok/12 text-ok",
  running: "border-accent/60 bg-accent/15 text-accent-ink shadow-[0_0_12px_-2px_var(--color-accent)]",
  failed: "border-bad/55 bg-bad/12 text-bad",
  stale: "border-warn/50 bg-warn/12 text-warn",
  empty: "border-dashed border-line text-dim hover:border-accent/50 hover:text-accent-ink",
  none: "border-transparent text-dim/40",
};

/** What a dot says, in words (keys for t()). */
function dotWords(d: Dot): string {
  switch (d.state) {
    case "done": return d.need === "optional" ? "made (optional)" : "made";
    case "running": return "being made now";
    case "failed": return "failed";
    case "stale": return "out of date";
    case "empty": return d.need === "optional" ? "not needed: the video engine speaks the lines" : "not made yet";
    case "none": return "nothing to make";
  }
}

/**
 * The five steps of a shot: Picture → Video → Voice → Mouth sync → Sound. A click runs that one step for the shot after its
 * price (the cost dialog). "none" dots (nothing to make) can't be clicked.
 */
export const StepDots = memo(function StepDots({ dots, onRun, canEdit, size = "sm", className }: {
  dots: Dot[]; onRun: (step: StepId) => void; canEdit: boolean; size?: "sm" | "lg"; className?: string;
}) {
  const t = useT();
  return (
    <div role="group" aria-label={t("Steps")} className={clsx("flex items-center", size === "lg" ? "gap-1.5" : "gap-1", className)}>
      {dots.map((d, i) => {
        const Icon = STEP_ICON[d.step];
        const what = `${t(STEP_LABEL[d.step])}: ${t(dotWords(d))}`;
        const action = d.state === "running" || d.state === "none" || !canEdit ? ""
          : d.state === "done" ? t("Click to make it again (you see the price first)") : t("Click to make it (you see the price first)");
        const tip = [what, d.error, d.staleReason, action].filter(Boolean).join(" · ");
        return (
          <span key={d.step} className="contents">
            {i > 0 && size === "lg" && <span aria-hidden className="h-px w-1.5 shrink-0 bg-line" />}
            <Tooltip content={tip}>
              <button type="button" aria-label={tip} disabled={!canEdit || d.state === "none" || d.state === "running"}
                onClick={(e) => { e.stopPropagation(); onRun(d.step); }}
                className={clsx("nodrag relative grid shrink-0 place-items-center rounded-md border transition-colors disabled:cursor-default",
                  size === "lg" ? "size-10" : "h-7 flex-1", DOT_TONE[d.state])}>
                <Icon className={size === "lg" ? "size-4" : "size-3.5"} />
                {d.state === "running" && <span aria-hidden className="live-dot absolute right-0.5 top-0.5 !size-1.5 !bg-accent" />}
                {d.state === "failed" && <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-bad" />}
                {d.state === "stale" && <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-warn" />}
              </button>
            </Tooltip>
          </span>
        );
      })}
    </div>
  );
});

/** Faces of the cast in a shot (up to `max`, then "+n"). */
export function Faces({ people, max = 4, size = 22 }: { people: Character[]; max?: number; size?: number }) {
  const t = useT();
  if (!people.length) return <span className="text-2xs text-dim">{t("No cast")}</span>;
  return (
    <span className="flex items-center -space-x-1.5" aria-label={people.map((c) => c.name).join(", ")}>
      {people.slice(0, max).map((c) => <Avatar key={c.id} name={c.name} src={c.avatar_url} size={size} className="ring-2 ring-panel" />)}
      {people.length > max && <span className="mono grid place-items-center rounded-full bg-raised text-2xs text-mute ring-2 ring-panel" style={{ width: size, height: size }}>+{people.length - max}</span>}
    </span>
  );
}

/**
 * A paid action's button with its price on it: "Make scene · $1.20". The price is an estimate (nothing is spent); the click
 * goes through generate(), which shows the cost dialog. `lazy`: the price is only fetched once the pointer or focus
 * reaches the button (rows of scenes don't each ask for a price up front).
 */
export function PriceButton({ eid, body, label, onRun, lazy, disabled, variant = "primary", size = "sm", icon, block, className, title, doneLabel }: {
  eid: number; body: Record<string, unknown> | null; label: string; onRun: () => Promise<void>; lazy?: boolean; disabled?: boolean;
  variant?: "primary" | "secondary" | "outline" | "ghost"; size?: "sm" | "md"; icon?: ReactNode; block?: boolean; className?: string;
  title?: string;
  /** Shown (disabled) when the estimate finds nothing to make. */
  doneLabel?: string;
}) {
  const [armed, setArmed] = useState(!lazy);
  const [busy, setBusy] = useState(false);
  const est = useEstimate(eid, body, armed && !disabled);
  const nothing = est.data?.count === 0;
  const price = est.data && est.data.count > 0 ? usd(est.data.total_usd) : est.isFetching ? "…" : "";
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try { await onRun(); } finally { setBusy(false); }
  };
  const btn = (
    <Button variant={variant} size={size} block={block} loading={busy} icon={icon} disabled={disabled || (nothing && !!doneLabel)}
      onPointerEnter={() => setArmed(true)} onFocus={() => setArmed(true)} onClick={() => void run()}
      className={clsx("nodrag", className)}>
      {nothing && doneLabel ? doneLabel : label}
      {!(nothing && doneLabel) && price && (
        <span className={clsx("mono rounded px-1 text-2xs tabular-nums", variant === "primary" ? "bg-black/15" : "bg-money/10 text-money")}>{price}</span>
      )}
    </Button>
  );
  return title ? <Tooltip content={title}>{btn}</Tooltip> : btn;
}

/** One shared player: starting a piece stops the one before. */
let playing: { audio: HTMLAudioElement; stop: () => void } | null = null;

/** Play / pause a piece of music. */
export function PlayChip({ url, label, className }: { url: string; label: ReactNode; className?: string }) {
  const t = useT();
  const [on, setOn] = useState(false);
  const [loading, setLoading] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { audio.current?.pause(); }, []);
  const toggle = () => {
    if (!url) return;
    if (on) { audio.current?.pause(); setOn(false); return; }
    playing?.stop();
    const a = audio.current ?? new Audio(url);
    audio.current = a;
    a.onended = () => setOn(false);
    a.onwaiting = () => setLoading(true);
    a.onplaying = () => setLoading(false);
    playing = { audio: a, stop: () => { a.pause(); setOn(false); } };
    void a.play().catch(() => setOn(false));
    setOn(true);
  };
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); toggle(); }} disabled={!url} aria-pressed={on}
      aria-label={on ? t("Pause the music") : t("Play the music")}
      className={clsx("nodrag inline-flex h-7 items-center gap-1.5 rounded-lg border border-ai/35 bg-ai/10 px-2 text-2xs font-medium text-ai transition-colors hover:bg-ai/20 disabled:opacity-50", className)}>
      {loading ? <Loader2 className="size-3 animate-spin" /> : on ? <Pause className="size-3" /> : <Play className="size-3" />}
      {label}
    </button>
  );
}
