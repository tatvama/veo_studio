import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { AlertTriangle, ArrowRight, Check, ChevronDown, Cpu, Wand2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { usePolicy, useShotEngines } from "../../lib/queries";
import type { Shot } from "../../lib/types";
import { SearchField, Segmented, Spinner } from "../ui";
import { CapChips, NewTag, ProviderBadge } from "./Chips";
import { engineShort, isAutoEngine } from "./util";

import "../../styles/console.css";

export type EnginePurpose = "video" | "dialogue" | "lipsync";

/** Purpose for a shot's main video engine: audio-driven speaking shots list talking-clip (a2v) engines. */
export function videoPurpose(shot: Shot): EnginePurpose {
  return shot.effective_voice_mode === "audio_driven" ? "dialogue" : "video";
}

/**
 * Per-shot engine choice.
 * - Saved mode (default, purpose video/dialogue): PATCH /api/shots/{sid} {engine} — the shot's video jobs use it.
 * - Controlled mode (`value` + `onChange`, used for lip-sync): the choice is passed with the next run only.
 * `embedded` is for use inside a card that already has its own heading.
 */
export default function EnginePicker({ shot, purpose: purposeProp, canEdit, value, onChange, label, defaultOpen = false, embedded }: {
  shot: Shot; purpose?: EnginePurpose; canEdit: boolean; value?: string; onChange?: (id: string) => void; label?: string; defaultOpen?: boolean;
  embedded?: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const controlled = !!onChange;
  const audioDriven = shot.effective_voice_mode === "audio_driven";
  const [listPurpose, setListPurpose] = useState<EnginePurpose>(purposeProp ?? videoPurpose(shot));
  const purpose = purposeProp === "lipsync" ? "lipsync" : listPurpose;
  const { data, isLoading } = useShotEngines(shot.id, purpose);
  // speaking shots can pin either a talking-clip or a visual-only engine: load the other list too, for names / validity
  const otherPurpose: EnginePurpose | null = audioDriven && purpose !== "lipsync" ? (purpose === "dialogue" ? "video" : "dialogue") : null;
  const { data: other } = useShotEngines(otherPurpose ? shot.id : null, otherPurpose ?? "video");
  const { data: policy } = usePolicy();
  const [open, setOpen] = useState(defaultOpen);
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  const current = controlled ? (value || "auto") : (isAutoEngine(shot.engine) ? "auto" : shot.engine);
  const engines = data?.engines ?? [];
  const byId = useMemo(() => Object.fromEntries(engines.map((e) => [e.id, e])), [engines]);
  const allById = useMemo(() => ({ ...Object.fromEntries((other?.engines ?? []).map((e) => [e.id, e])), ...byId }), [other, byId]);
  const chainKey = purpose === "lipsync" ? "lipsync" : data?.chain ?? "";
  const autoChain = (purpose === "lipsync" ? policy?.chains.lipsync : data?.auto_chain) ?? [];
  const chainLabel = policy?.labels[chainKey] ?? chainKey;
  const nameOf = (id: string) => allById[id]?.display_name || policy?.models[id]?.display_name || engineShort(id);
  const autoFirst = autoChain.find((id) => allById[id]);
  const chosen = current !== "auto" ? allById[current] ?? policy?.models[current] : undefined;
  const pinnedMissing = current !== "auto" && !isLoading && !allById[current] && (!otherPurpose || !!other);

  // open on the list that contains the pinned engine
  useEffect(() => {
    if (otherPurpose && current !== "auto" && data && other && !byId[current] && other.engines.some((e) => e.id === current)) setListPurpose(otherPurpose);
  }, [data, other, current]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? engines.filter((e) => `${e.display_name} ${e.id} ${e.family} ${e.maker}`.toLowerCase().includes(needle)) : engines;
  }, [engines, q]);

  const pick = async (id: string) => {
    if (id === current) { setOpen(false); return; }
    if (controlled) {
      onChange!(id);
      setOpen(false);
      return;
    }
    setSaving(id);
    try {
      await api.patch(`/api/shots/${shot.id}`, { engine: id === "auto" ? "" : id });
      qc.invalidateQueries({ queryKey: ["shot", shot.id] });
      qc.invalidateQueries({ queryKey: ["shot-engines", shot.id] });
      qc.invalidateQueries({ queryKey: ["episode"] });
      toast.success(id === "auto" ? tr("{code}: engine set to Auto", { code: shot.code }) : tr("{code}: engine set to {name}", { code: shot.code, name: nameOf(id) }));
      setOpen(false);
    } catch {
      /* api() showed the error */
    } finally {
      setSaving(null);
    }
  };

  const autoPrice = autoFirst && allById[autoFirst]?.estimate_usd != null ? `~${usd(allById[autoFirst].estimate_usd)}` : undefined;

  return (
    <div className={clsx("overflow-hidden rounded-xl border transition-colors", open ? "border-accent/40" : "border-line", embedded ? "bg-panel" : "bg-raised/35")}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-hover/50">
        <span className={clsx("grid size-8 shrink-0 place-items-center rounded-lg", current === "auto" ? "bg-raised text-mute" : "bg-accent/12 text-accent-ink")}>
          {current === "auto" ? <Wand2 className="size-4" /> : <Cpu className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="eyebrow block">{label ?? t("Engine")}</span>
          <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-sm">
            {current === "auto" ? (
              <span className="min-w-0 truncate">
                <span className="font-semibold">{t("Auto")}</span>
                <span className="text-mute"> · {autoFirst ? t("{name} first", { name: nameOf(autoFirst) }) : t(chainLabel)}</span>
              </span>
            ) : (
              <>
                <span className="min-w-0 truncate font-semibold">{nameOf(current)}</span>
                {chosen && <ProviderBadge model={chosen} className="shrink-0" />}
              </>
            )}
          </span>
        </span>
        {chosen?.estimate_usd != null && <span className="mono shrink-0 text-sm font-medium text-money">{usd(chosen.estimate_usd)}</span>}
        {current === "auto" && autoPrice && <span className="mono shrink-0 text-xs text-money">{autoPrice}</span>}
        {pinnedMissing && <AlertTriangle className="size-4 shrink-0 text-warn" aria-label={t("Pinned engine unavailable")} />}
        <ChevronDown className={clsx("size-4 shrink-0 text-dim transition-transform duration-200", open && "rotate-180")} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
            <div className="space-y-2 border-t border-line px-2 pb-2 pt-2">
              {audioDriven && purposeProp !== "lipsync" && (
                <div className="flex flex-wrap items-center gap-2 px-1">
                  <Segmented value={listPurpose} onChange={setListPurpose} options={[
                    { value: "dialogue", label: t("Talking clip"), title: t("Engines that animate the voice track (audio → video)") },
                    { value: "video", label: t("Visual only"), title: t("Regular video engines; voice and lip-sync run afterwards") },
                  ]} />
                  {listPurpose === "video" && <span className="text-2xs text-dim">{t("A visual-only engine turns off audio-driven acting for this shot.")}</span>}
                </div>
              )}
              {pinnedMissing && (
                <p className="cx-block flex items-start gap-1.5 px-2 py-1.5 text-2xs text-warn">
                  <AlertTriangle className="mt-px size-3 shrink-0" />
                  {t("The pinned engine isn't enabled or can't make this shot right now. Pick another or go back to Auto.")}
                </p>
              )}
              {engines.length > 8 && (
                <div className="px-1"><SearchField value={q} onChange={setQ} placeholder={t("Search engines…")} className="w-full" aria-label={t("Search engines…")} /></div>
              )}
              <div className="max-h-72 space-y-0.5 overflow-y-auto pr-0.5" role="listbox" aria-label={label ?? t("Engine")}>
                <Row selected={current === "auto"} disabled={!canEdit} busy={saving === "auto"} onClick={() => pick("auto")}
                  lead={<span className="grid size-8 place-items-center rounded-lg border border-line bg-raised text-mute"><Wand2 className="size-4" /></span>}
                  title={<span className="font-medium">{t("Auto")} <span className="font-normal text-dim">· {t(chainLabel)}</span></span>}
                  sub={autoChain.length ? (
                    <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                      {autoChain.slice(0, 4).map((id, i) => (
                        <span key={id} className="inline-flex items-center gap-1">{i > 0 && <ArrowRight className="size-3 text-dim" />}{nameOf(id)}</span>
                      ))}
                      {autoChain.length > 4 && <span>…</span>}
                    </span>
                  ) : t("Uses the team's routing policy")}
                  price={autoPrice} />
                {isLoading && <div className="px-3 py-3"><Spinner /></div>}
                {filtered.map((e) => (
                  <Row key={e.id} selected={current === e.id} disabled={!canEdit} busy={saving === e.id} onClick={() => pick(e.id)}
                    title={<span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                      <span className="truncate font-medium">{e.display_name}</span><NewTag model={e} /><ProviderBadge model={e} />
                    </span>}
                    sub={<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-dim">{[e.maker, e.family].filter(Boolean).join(" · ")}</span><CapChips model={e} />
                    </span>}
                    price={e.estimate_usd != null ? usd(e.estimate_usd) : e.price_label} priceHint={e.price_label} priceSub={e.estimate_usd != null ? e.price_label : undefined} />
                ))}
                {!isLoading && !engines.length && (
                  <p className="px-3 py-3 text-xs text-mute">
                    {t("No enabled engine can make this kind of shot.")} <Link to="/models" className="text-accent-ink hover:underline">{t("Open the Model Hub")}</Link>
                  </p>
                )}
                {!!q && !filtered.length && engines.length > 0 && <p className="px-3 py-3 text-xs text-mute">{t("No engines match “{q}”.", { q })}</p>}
              </div>
              {!canEdit && <p className="px-1 text-2xs text-dim">{t("Your role can view but not change the engine.")}</p>}
              {controlled && <p className="px-1 text-2xs text-dim">{t("Used for the next run from this panel.")}</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Row({ selected, disabled, busy, onClick, lead, title, sub, price, priceHint, priceSub }: {
  selected: boolean; disabled: boolean; busy: boolean; onClick: () => void; lead?: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode;
  price?: string; priceHint?: string; priceSub?: string;
}) {
  return (
    <button type="button" role="option" aria-selected={selected} disabled={disabled || busy} onClick={onClick}
      className={clsx("flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors disabled:cursor-default",
        selected ? "border-accent/40 bg-accent/10" : "border-transparent hover:bg-hover disabled:hover:bg-transparent")}>
      <span className={clsx("flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
        selected ? "border-accent bg-accent text-black" : "border-line")}>
        {busy ? <Spinner className="size-3 text-black" /> : selected ? <motion.span initial={{ scale: 0.3 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 600, damping: 22 }}><Check className="size-3" strokeWidth={3} /></motion.span> : null}
      </span>
      {lead}
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block text-sm">{title}</span>
        {sub && <span className="block text-2xs text-mute">{sub}</span>}
      </span>
      {price && (
        <span className="shrink-0 text-right" title={priceHint}>
          <span className="mono block text-sm font-medium text-money">{price}</span>
          {priceSub && <span className="mono block text-2xs text-dim">{priceSub}</span>}
        </span>
      )}
    </button>
  );
}
