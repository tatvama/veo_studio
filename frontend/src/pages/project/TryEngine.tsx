import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Repeat2, UserRound } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useGenerate } from "../../components/Generate";
import { Badge, Button, Popover, Skeleton } from "../../components/ui";
import { api } from "../../lib/api";
import { quote } from "../../lib/estimates";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useShotAlternatives } from "../../lib/queries";
import type { ShotOption, SubmitResult } from "../../lib/types";

/**
 * "Try another engine" for a shot whose last video failed or was blocked: the other video engines that can make it
 * (Model Hub engines with the right modes, not the ones that failed), each priced for this shot. Picking one shows the
 * cost dialog, then makes this shot only on that engine: a hand-picked engine runs as picked ("Google first" doesn't
 * move it). Nothing else changes: the shot keeps its own engine setting.
 */
export function useTryEngine(shotId: number, code: string) {
  const qc = useQueryClient();
  const { priced } = useGenerate();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (o: ShotOption) => {
    setBusy(o.id);
    try {
      const r = await priced({
        quote: () => quote({ action: "recover", shot_id: shotId, engine: o.id }),
        run: () => api.post<SubmitResult>(`/api/shots/${shotId}/recover`, { engine: o.id }),
        what: tr("{code} on {engine}", { code, engine: o.display_name }),
      });
      if (r) {
        for (const k of ["shot", "episode", "shot-alternatives", "board"]) qc.invalidateQueries({ queryKey: [k] });
      }
      return r;
    } finally { setBusy(null); }
  };
  return { busy, run };
}

export function OptionTags({ o }: { o: ShotOption }) {
  const t = useT();
  return (
    <>
      {o.uses_registered && (
        <Badge tone="ok" title={t("Uses the characters registered with BytePlus, so Seedance keeps their look")}>
          <UserRound className="size-3" />{t("Keeps the cast")}
        </Badge>
      )}
      {o.provider_mode === "mock" && <Badge tone="warn" title={t("Provider is in mock mode — no real generation")}>{t("placeholder")}</Badge>}
    </>
  );
}

/**
 * The button and its list. `label` defaults to "Try another engine"; `compact` draws it small for a shot card.
 */
export function TryEngineButton({ shotId, code, label, compact, variant = "outline", className, onPicked }: {
  shotId: number; code: string; label?: ReactNode; compact?: boolean; variant?: "primary" | "secondary" | "outline" | "ghost";
  className?: string; onPicked?: () => void;
}) {
  const t = useT();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useShotAlternatives(shotId, "recover", open);
  const { busy, run } = useTryEngine(shotId, code);
  const opts = data?.options ?? [];
  const failedOn = data?.failed?.engine_labels ?? [];
  const pick = async (o: ShotOption) => {
    setOpen(false);
    const r = await run(o);
    if (r) onPicked?.();
  };
  return (
    <>
      {compact ? (
        <button ref={anchor} type="button" aria-haspopup="dialog" aria-expanded={open} disabled={!!busy}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
          className={clsx("nodrag inline-flex h-6 shrink-0 items-center gap-1 rounded border border-white/25 px-1.5 text-2xs font-medium hover:bg-white/10 disabled:opacity-50", className)}>
          <Repeat2 className="size-3" />{label ?? t("Other engine")}
        </button>
      ) : (
        <Button ref={anchor} size="sm" variant={variant} icon={<Repeat2 className="size-3.5" />} loading={!!busy} aria-haspopup="dialog" aria-expanded={open}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} className={clsx("nodrag", className)}>
          {label ?? t("Try another engine")}
        </Button>
      )}
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-start" width={380} className="p-1.5">
        <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <p className="px-1.5 pb-1 pt-0.5 text-xs font-semibold">{t("Make {code} on another engine", { code })}</p>
          <p className="px-1.5 pb-1.5 text-2xs leading-snug text-dim">
            {failedOn.length ? t("Not {engines}: it failed there. ", { engines: failedOn.join(", ") }) : ""}
            {t("Only this shot, on the engine you pick. You see the price first.")}
          </p>
          {isLoading ? <div className="space-y-1 p-1"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
            : isError ? <p className="px-1.5 py-2 text-xs text-bad">{t("Couldn't load the engines. Try again.")}</p>
            : !opts.length ? (
              <p className="px-1.5 py-2 text-xs leading-snug text-mute">
                {t("No other engine can make this shot.")}{" "}
                <Link to="/models" className="font-medium text-accent-ink hover:underline">{t("Switch one on in Model Hub")}</Link>
              </p>
            ) : (
              <ul role="menu" className="max-h-72 overflow-y-auto">
                {opts.map((o) => (
                  <li key={o.id}>
                    <button type="button" role="menuitem" disabled={!!busy} onClick={() => void pick(o)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-hover disabled:opacity-50">
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5"><span className="truncate">{o.display_name}</span><OptionTags o={o} /></span>
                        <span className="mono block text-2xs text-dim">{o.provider} · {o.resolution} · {o.seconds}s</span>
                      </span>
                      <span className="mono shrink-0 text-xs text-money">{usd(o.est_usd)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </div>
      </Popover>
    </>
  );
}
