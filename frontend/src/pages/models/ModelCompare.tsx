import { Check, Minus, X } from "lucide-react";
import { MODE_LABELS, TASK_LABELS, TIER_LABELS, durationsText } from "../../components/hub/util";
import { Badge, Button, IconButton, Meter, Modal } from "../../components/ui";
import { usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { AIModel } from "../../lib/types";
import { CAP_DEFS, clipUsd, hasCap, perSecond, rateText, speedCells, successPct } from "./modelMeta";
import { ProviderBadge, StateBadge, StatusBadge, TASK_ICON, modelSubtitle } from "./ModelCard";

import "../../styles/console.css";
import "../../styles/models.css";

/** The most engines that can be compared side by side. */
export const COMPARE_MAX = 3;

/** Side-by-side spec table for 2–3 engines: price, speed, rating, track record and every capability flag. */
export default function ModelCompare({ models, open, onClose, onRemove, onOpen, onClear }: {
  models: AIModel[]; open: boolean; onClose: () => void; onRemove: (m: AIModel) => void; onOpen: (m: AIModel) => void; onClear: () => void;
}) {
  const t = useT();
  const rates = models.map((m) => perSecond(m).value);
  const lowest = Math.min(...rates.filter((x): x is number => x != null));
  const best = (v: number | null) => v != null && Number.isFinite(lowest) && models.length > 1 && v === lowest;
  const ratedBest = Math.max(...models.map((m) => m.rating ?? -1));

  const row = (label: string, cell: (m: AIModel, i: number) => React.ReactNode, num?: boolean) => (
    <tr key={label}>
      <th scope="row" className="cx-stick whitespace-nowrap bg-panel text-left text-xs font-medium text-mute">{label}</th>
      {models.map((m, i) => <td key={m.id} className={num ? "mono" : undefined}>{cell(m, i)}</td>)}
    </tr>
  );

  return (
    <Modal open={open} onClose={onClose} size="xl" title={t("Compare engines")}
      footer={<>
        <Button variant="ghost" onClick={onClear}>{t("Clear selection")}</Button>
        <Button variant="primary" onClick={onClose}>{t("Done")}</Button>
      </>}>
      {models.length < 2 && <p className="mb-3 text-sm text-mute">{t("Pick at least two engines to compare.")}</p>}
      <div className="cx-scroll max-h-[60vh] rounded-xl border border-line">
        <table className="cx-table" aria-label={t("Compare engines")}>
          <thead>
            <tr>
              <th className="cx-stick" scope="col"><span className="sr-only">{t("Spec")}</span></th>
              {models.map((m) => (
                <th key={m.id} scope="col" className="min-w-[13rem] !font-sans !normal-case !tracking-normal">
                  <span className="flex items-center justify-between gap-2">
                    <button type="button" onClick={() => onOpen(m)} className="min-w-0 truncate text-left text-sm font-semibold text-ink hover:text-accent-ink" title={m.display_name}>{m.display_name || m.endpoint}</button>
                    <IconButton title={t("Remove {name}", { name: m.display_name })} onClick={() => onRemove(m)} className="size-6"><X className="size-3.5" /></IconButton>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row(t("Maker"), (m) => <span className="mono text-xs text-mute">{modelSubtitle(m)}</span>)}
            {row(t("Provider"), (m) => <span className="flex flex-wrap items-center gap-1.5"><ProviderBadge m={m} /><StateBadge m={m} /></span>)}
            {row(t("Task"), (m) => { const I = TASK_ICON[m.task]; return <span className="inline-flex items-center gap-1.5">{I && <I className="size-3.5 text-dim" aria-hidden />}{t(TASK_LABELS[m.task] ?? m.task)}</span>; })}
            {row(t("Status"), (m) => <StatusBadge status={m.status} />)}
            {row(t("Price per second"), (m) => {
              const { value, exact } = perSecond(m);
              return value != null
                ? <span className="inline-flex items-center gap-1.5"><span className="text-money">{exact ? "" : "~"}{rateText(value)}</span>{best(value) && <Badge tone="ok">{t("lowest")}</Badge>}</span>
                : <span className="text-dim">{m.price_label}</span>;
            }, true)}
            {row(t("8 s clip"), (m) => { const c = clipUsd(m); return c != null ? <span className="text-money">{usd(c)}</span> : <span className="text-dim">—</span>; }, true)}
            {row(t("Speed"), (m) => (
              <span className="flex items-center gap-2"><span className="w-16"><Meter filled={speedCells(m.tier)} total={3} tone="accent" /></span>
                <span className="mono text-2xs text-mute">{m.tier ? t(TIER_LABELS[m.tier] ?? m.tier) : "—"}</span></span>
            ))}
            {row(t("Rating"), (m) => m.rating != null
              ? <span className="inline-flex items-center gap-1.5">{m.rating.toFixed(1)}{models.length > 1 && m.rating === ratedBest && <Badge tone="ok">{t("highest")}</Badge>}</span>
              : <span className="text-dim">—</span>, true)}
            {row(t("Uses"), (m) => (m.uses || 0).toLocaleString(), true)}
            {row(t("Success rate"), (m) => { const s = successPct(m); return s != null ? `${s}%` : <span className="text-dim">—</span>; }, true)}
            {row(t("Shootout wins"), (m) => (m.wins || 0).toLocaleString(), true)}
            {CAP_DEFS.map((d) => row(t(d.label), (m) => hasCap(m, d.key)
              ? <span className="inline-flex items-center gap-1.5 text-accent-ink"><Check className="size-3.5" aria-hidden />{t("Yes")}</span>
              : <span className="inline-flex items-center gap-1.5 text-dim"><Minus className="size-3.5" aria-hidden />{t("No")}</span>))}
            {row(t("Reference images"), (m) => (m.capabilities?.max_refs ? String(m.capabilities.max_refs) : "—"), true)}
            {row(t("Durations"), (m) => durationsText(m.capabilities?.durations) || "—", true)}
            {row(t("Resolutions"), (m) => (m.capabilities?.resolutions ?? []).join(" · ") || "—", true)}
            {row(t("Modes"), (m) => (
              <span className="flex flex-wrap gap-1">{(m.capabilities?.modes ?? []).map((x) => <span key={x} title={t(MODE_LABELS[x] ?? x)} className="mono rounded-md border border-line bg-raised/60 px-1.5 py-0.5 text-2xs leading-none text-mute">{x}</span>)}
                {!(m.capabilities?.modes ?? []).length && <span className="text-dim">—</span>}</span>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
