import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, CircleAlert, Coins, Swords, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { usePolicy, useShotEngines } from "../../lib/queries";
import type { Shot, SubmitResult } from "../../lib/types";
import { useGenerate } from "../Generate";
import { AnimatedNumber, Button, Empty, Modal, SearchField, Segmented, Skeleton } from "../ui";
import { CapChips, NewTag, ProviderBadge } from "./Chips";
import { videoPurpose, type EnginePurpose } from "./EnginePicker";
import { engineShort, isAutoEngine } from "./util";

import "../../styles/console.css";

const MAX = 4;
const letter = (i: number) => String.fromCharCode(65 + i);

/**
 * Generate the same shot with 2–4 engines side by side. The modal is the cost confirmation: it lists each engine's
 * estimate and the total before anything is spent; the server still applies budget limits (may send it for approval).
 */
export default function ShootoutModal({ shot, open, onClose, onStarted, purpose: purposeProp }: {
  shot: Shot; open: boolean; onClose: () => void; onStarted?: () => void; purpose?: EnginePurpose;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { submit } = useGenerate();
  const audioDriven = shot.effective_voice_mode === "audio_driven" && !purposeProp;
  const [listPurpose, setListPurpose] = useState<EnginePurpose>(purposeProp ?? videoPurpose(shot));
  const purpose = purposeProp ?? listPurpose;
  const { data, isLoading } = useShotEngines(open ? shot.id : null, purpose);
  const { data: policy } = usePolicy();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");

  const engines = data?.engines ?? [];
  const byId = useMemo(() => Object.fromEntries(engines.map((e) => [e.id, e])), [engines]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? engines.filter((e) => `${e.display_name} ${e.id} ${e.family} ${e.maker}`.toLowerCase().includes(needle)) : engines;
  }, [engines, q]);

  // sensible default: the shot's pinned engine + the first engines of its auto chain
  const [seededFor, setSeededFor] = useState("");
  useEffect(() => {
    const k = `${shot.id}|${purpose}`;
    if (!open) { setSeededFor(""); return; }
    if (!data || seededFor === k) return;
    const seed = [...(isAutoEngine(shot.engine) ? [] : [shot.engine]), ...data.auto_chain].filter((id, i, a) => byId[id] && a.indexOf(id) === i);
    const fill = engines.map((e) => e.id).filter((id) => !seed.includes(id));
    setPicked([...seed, ...fill].slice(0, 2));
    setSeededFor(k);
  }, [open, shot.id, purpose, data, seededFor]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX ? p : [...p, id]));
  const total = picked.reduce((a, id) => a + (byId[id]?.estimate_usd ?? 0), 0);
  const ok = picked.length >= 2 && picked.length <= MAX;
  const nameOf = (id: string) => byId[id]?.display_name ?? policy?.models[id]?.display_name ?? engineShort(id);

  const run = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      const res = await submit(() => api.post<SubmitResult>(`/api/shots/${shot.id}/shootout`, { engines: picked }), tr("Shootout {code}", { code: shot.code }));
      if (res) {
        qc.invalidateQueries({ queryKey: ["shot", shot.id] });
        qc.invalidateQueries({ queryKey: ["episode"] });
        onStarted?.();
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} wide
      title={<span className="flex items-center gap-2"><Swords className="size-4 text-accent-ink" />{t("Engine shootout · {code}", { code: shot.code })}</span>}
      footer={<>
        <span className="mr-auto flex items-center gap-2 self-center text-xs text-mute">
          <span className="mono">{t("{n} of {max} picked", { n: picked.length, max: MAX })}</span>
          <span aria-hidden className="h-3 w-px bg-line" />
          <span className="mono font-medium text-money"><AnimatedNumber value={total} format={(n) => usd(n)} duration={0.5} /></span>
        </span>
        <Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="primary" disabled={!ok} loading={busy} icon={<Coins className="size-4" />} onClick={run}>
          {t("Run shootout · {usd}", { usd: usd(total) })}
        </Button>
      </>}>
      <div className="space-y-4">
        <p className="max-w-3xl text-sm text-mute">
          {t("Each engine makes one take of this shot from the same prompt and keyframe. Takes aren't put in the cut automatically — compare them in Takes and pick the winner. Wins are credited to the engine in the Model Hub.")}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {audioDriven && (
            <>
              <Segmented value={listPurpose} onChange={setListPurpose} options={[
                { value: "dialogue", label: t("Talking-clip engines") }, { value: "video", label: t("Visual-only engines") },
              ]} />
              <span className="min-w-0 flex-1 basis-60 text-2xs text-dim">{t("This shot is audio-driven: talking-clip engines animate the voice track; visual-only engines need lip-sync afterwards.")}</span>
            </>
          )}
          {engines.length > 8 && <SearchField value={q} onChange={setQ} placeholder={t("Search engines…")} className="ml-auto w-56" aria-label={t("Search engines…")} />}
        </div>

        {isLoading ? (
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
        ) : !engines.length ? (
          <Empty title={t("No engines available")} sub={t("Enable some video engines in the Model Hub first.")} />
        ) : (
          <div className="grid max-h-[46vh] gap-2.5 overflow-y-auto p-1 sm:grid-cols-2 lg:grid-cols-3" role="group" aria-label={t("Engines")}>
            {shown.map((e) => {
              const on = picked.includes(e.id);
              const full = !on && picked.length >= MAX;
              const order = picked.indexOf(e.id);
              return (
                <motion.button key={e.id} type="button" onClick={() => toggle(e.id)} disabled={full} aria-pressed={on}
                  whileHover={full ? undefined : { y: -2 }} whileTap={full ? undefined : { scale: 0.99 }} transition={{ duration: 0.15, ease: "easeOut" }}
                  className={clsx("hud relative flex flex-col gap-2 rounded-xl border p-3 text-left transition-[border-color,background-color,box-shadow] disabled:cursor-not-allowed disabled:opacity-45",
                    on ? "border-accent bg-accent/10 shadow-glow" : "border-line bg-panel hover:border-dim/60 hover:bg-raised")}>
                  <span className="flex items-start gap-2.5">
                    <span className={clsx("mono mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border text-xs font-bold transition-colors",
                      on ? "border-accent bg-accent text-black" : "border-line text-transparent")}>
                      {on ? letter(order) : <Check className="size-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        <span className="truncate text-sm font-semibold">{e.display_name}</span>
                        <NewTag model={e} />
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-2xs text-dim">
                        <ProviderBadge model={e} />
                        <span className="truncate">{[e.maker, e.family].filter(Boolean).join(" · ")}</span>
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="mono block text-sm font-semibold text-money">{e.estimate_usd != null ? usd(e.estimate_usd) : "—"}</span>
                      <span className="mono block text-2xs text-dim">{e.price_label}</span>
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-2">
                    <CapChips model={e} />
                    {data?.auto_chain.includes(e.id) && <span className="mono ml-auto text-2xs text-dim">{t("in Auto chain")}</span>}
                  </span>
                </motion.button>
              );
            })}
            {!shown.length && <p className="col-span-full py-6 text-center text-sm text-mute">{t("No engines match “{q}”.", { q })}</p>}
          </div>
        )}

        <AnimatePresence initial={false}>
          {picked.length > 0 && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="cx-block">
                <ul className="flex flex-wrap gap-2 p-2.5" aria-label={t("Your lineup")}>
                  <AnimatePresence initial={false}>
                    {picked.map((id, i) => (
                      <motion.li key={id} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ duration: 0.16 }}
                        className="flex items-center gap-2 rounded-lg border border-line bg-panel py-1 pl-1 pr-1.5 text-sm">
                        <span className="mono grid size-6 place-items-center rounded-md bg-accent text-xs font-bold text-black">{letter(i)}</span>
                        <span className="max-w-[220px] truncate">{nameOf(id)}</span>
                        <span className="mono text-money">{usd(byId[id]?.estimate_usd ?? 0)}</span>
                        <button type="button" onClick={() => toggle(id)} aria-label={t("Remove {name}", { name: nameOf(id) })}
                          className="grid size-5 place-items-center rounded text-dim transition-colors hover:bg-hover hover:text-ink"><X className="size-3.5" /></button>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
                <div className="flex items-center justify-between border-t border-line px-3 py-2 text-sm">
                  <span className="eyebrow">{t("Total estimate")}</span>
                  <span className="mono text-lg font-semibold text-money"><AnimatedNumber value={total} format={(n) => usd(n)} duration={0.5} /></span>
                </div>
              </div>
              <p className="mt-2 flex items-start gap-1.5 text-xs text-dim">
                <CircleAlert className="mt-px size-3.5 shrink-0" />
                {t("Estimates use list prices. If this goes over your limit it is sent to a producer for approval instead of running.")}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
        {picked.length === 1 && <p className="text-xs text-warn">{t("Pick at least one more engine.")}</p>}
      </div>
    </Modal>
  );
}
