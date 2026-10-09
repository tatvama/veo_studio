import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { keepPreviousData, useQueries, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CheckCircle2, Crown, FastForward, GripVertical, Image as ImageIcon, Lock, MessagesSquare, Plus, RefreshCw, RotateCcw,
  Route, Save, Scale, Search, Speech, Volume2, Wand2, X, Zap, type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CHAIN_FIT, CHAIN_HELP, MODE_LABELS, engineShort, fitsChain } from "../../components/hub/util";
import { Badge, Button, Empty, IconButton, Modal, Panel, SearchField, Skeleton, StatusDot, Tag, Tooltip, rise } from "../../components/ui";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { usePolicy } from "../../lib/queries";
import type { AIModel, ModelList, ModelPolicy } from "../../lib/types";
import { useFlash } from "../admin/shared/useFlash";
import { clipUsd, perSecond, rateText, successPct } from "./modelMeta";
import { ModeChips, PriceBlock, ProviderBadge, StatusBadge } from "./ModelCard";

import "../../styles/console.css";
import "../../styles/models.css";

type Chains = Record<string, string[]>;
const ORDER = ["video.saver", "video.balanced", "video.hero", "dialogue", "lipsync", "image", "edit", "extend"];

const CHAIN_ICON: Record<string, LucideIcon> = {
  "video.saver": Zap, "video.balanced": Scale, "video.hero": Crown, dialogue: MessagesSquare, lipsync: Speech, image: ImageIcon, edit: Wand2, extend: FastForward,
};

export default function PolicyEditor({ admin }: { admin: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: policy, isLoading, isError, refetch } = usePolicy();
  const [chains, setChains] = useState<Chains>({});
  const [server, setServer] = useState<Chains>({});
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [extra, setExtra] = useState<Record<string, AIModel>>({}); // engines added in this session
  const [savedFlash, flashSaved] = useFlash();

  const serverJson = JSON.stringify(policy?.chains ?? {});
  useEffect(() => {
    const next = JSON.parse(serverJson) as Chains;
    if (JSON.stringify(chains) === JSON.stringify(server)) setChains(next); // keep local edits if any
    setServer(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverJson]);

  const dirty = JSON.stringify(chains) !== JSON.stringify(server);
  const changed = (k: string) => JSON.stringify(chains[k] ?? []) !== JSON.stringify(server[k] ?? []);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const lookup = useMemo(() => {
    const map: Record<string, AIModel> = { ...extra };
    for (const [id, m] of Object.entries(policy?.models ?? {})) map[id] = { ...map[id], ...m };
    return map;
  }, [extra, policy]);

  const keys = useMemo(() => {
    const ks = Object.keys(policy?.labels ?? policy?.defaults ?? {});
    return [...ORDER.filter((k) => ks.includes(k)), ...ks.filter((k) => !ORDER.includes(k))];
  }, [policy]);

  const changedCount = keys.filter(changed).length;

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put<ModelPolicy>("/api/models/policy", { chains });
      qc.setQueryData(["models", "policy"], res);
      setServer(res.chains);
      setChains(res.chains);
      qc.invalidateQueries({ queryKey: ["models"] }); // models placed in a chain are switched on
      qc.invalidateQueries({ queryKey: ["shot-engines"] });
      flashSaved();
    } catch {
      /* api() showed the error */
    } finally {
      setSaving(false);
    }
  };

  const resetAll = () => policy && setChains(JSON.parse(JSON.stringify(policy.defaults)));
  const setChain = (k: string, ids: string[]) => setChains((c) => ({ ...c, [k]: ids }));

  if (isError && !policy) {
    return (
      <Empty icon={<AlertTriangle className="size-8" />} title={t("Couldn't load the routing policy")} sub={t("Check your connection and try again.")}
        action={<Button icon={<RefreshCw className="size-4" />} onClick={() => void refetch()}>{t("Try again")}</Button>} />
    );
  }
  if (isLoading || !policy) {
    return (
      <div className="space-y-4" aria-busy>
        <Skeleton className="h-16 w-full rounded-xl" />
        {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-52 rounded-xl" />)}
      </div>
    );
  }

  const engineTotal = keys.reduce((n, k) => n + (chains[k]?.length ?? 0), 0);

  return (
    <div className="space-y-4">
      <Panel index={0} bodyClassName="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="hud grid size-10 shrink-0 place-items-center rounded-lg border border-accent/25 bg-accent/10 text-accent-ink"><Route className="size-5" aria-hidden /></span>
        <div className="min-w-[240px] flex-1">
          <p className="text-sm text-mute">
            {t("Each job tries its chain top to bottom. The first enabled engine that supports the shot wins; if it fails (safety block, bad input) the next one is tried. A shot can still pin its own engine.")}
          </p>
          <p className="mono mt-1.5 text-2xs text-dim">{keys.length} {t("chains")} · {engineTotal} {t("engines")}</p>
        </div>
        {admin ? (
          <Button size="sm" variant="outline" icon={<RotateCcw className="size-3.5" />} onClick={resetAll}>{t("Reset all to default")}</Button>
        ) : (
          <Badge><Lock className="size-3" />{t("Only admins can change routing")}</Badge>
        )}
      </Panel>

      <div className="space-y-4">
        {keys.map((k, i) => {
          const r = rise(i);
          return (
            <div key={k} className={cn("min-w-0", r.className)} style={r.style}>
              <ChainCard chain={k} label={policy.labels[k] ?? k} ids={chains[k] ?? []} defaults={policy.defaults[k] ?? []}
                lookup={lookup} admin={admin} changed={changed(k)}
                onChange={(ids) => setChain(k, ids)} onAdd={() => setAdding(k)} />
            </div>
          );
        })}
      </div>

      <div className="h-20" aria-hidden />
      {admin && (
        <PolicyBar show={dirty} saved={savedFlash && !dirty} saving={saving} onDiscard={() => setChains(server)} onSave={save}
          message={changedCount === 1 ? t("1 chain changed. New engines are switched on when you save.") : t("{n} chains changed. New engines are switched on when you save.", { n: changedCount })} />
      )}

      <AddModelModal
        chain={adding} label={adding ? t(policy.labels[adding] ?? adding) : ""} already={adding ? chains[adding] ?? [] : []}
        onClose={() => setAdding(null)}
        onPick={(m) => { if (adding) { setExtra((e) => ({ ...e, [m.id]: m })); setChain(adding, [...(chains[adding] ?? []), m.id]); } }} />
    </div>
  );
}

/** The "unsaved changes" bar: sticks to the bottom of the page, turns into a "saved" confirmation for a moment afterwards. */
function PolicyBar({ show, saved, saving, message, onDiscard, onSave }: {
  show: boolean; saved: boolean; saving: boolean; message: string; onDiscard: () => void; onSave: () => void;
}) {
  const t = useT();
  return (
    <div className="pointer-events-none sticky bottom-4 z-20 h-0">
      <AnimatePresence>
        {(show || saved) && (
          <motion.div key="bar" role="status" aria-live="polite"
            initial={{ y: 30, opacity: 0, scale: 0.98 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: 20, opacity: 0, transition: { duration: 0.16, ease: "easeIn" } }}
            transition={{ type: "spring", stiffness: 430, damping: 36, mass: 0.8 }}
            className={cn("pointer-events-auto absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-raised/95 px-4 py-2.5 backdrop-blur-md",
              show ? "border-accent/35" : "border-ok/40")}>
            {show ? (
              <>
                <span className="flex min-w-0 flex-1 basis-56 items-center gap-2 text-sm"><span aria-hidden className="size-2 shrink-0 rounded-full bg-warn" />{message}</span>
                <div className="flex shrink-0 gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
                  <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={onDiscard} disabled={saving} className="max-sm:h-10">{t("Discard")}</Button>
                  <Button variant="primary" icon={<Save className="size-4" />} loading={saving} onClick={onSave} className="max-sm:h-10">{t("Save policy")}</Button>
                </div>
              </>
            ) : (
              <span className="flex items-center gap-2 py-1 text-sm font-medium text-ok"><CheckCircle2 className="size-4" />{t("Routing policy saved")}</span>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── chain ──────────────────────────────────────────────────────────────────── */

function ChainCard({ chain, label, ids, defaults, lookup, admin, changed, onChange, onAdd }: {
  chain: string; label: string; ids: string[]; defaults: string[]; lookup: Record<string, AIModel>; admin: boolean; changed: boolean;
  onChange: (ids: string[]) => void; onAdd: () => void;
}) {
  const t = useT();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const move = (from: number, to: number) => {
    if (from < 0 || to < 0 || from >= ids.length || to >= ids.length || from === to) return;
    onChange(arrayMove(ids, from, to));
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    move(ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
  };
  const isDefault = JSON.stringify(ids) === JSON.stringify(defaults);
  const fit = CHAIN_FIT[chain];
  const Icon = CHAIN_ICON[chain] ?? Route;

  return (
    <Panel tone={changed ? "warn" : undefined} icon={<Icon />} eyebrow={chain} title={t(label)}>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-64 space-y-1.5">
          <p className="text-xs text-mute">{t(CHAIN_HELP[chain] ?? "")}</p>
          {fit && (
            <span className="flex flex-wrap items-center gap-1 text-2xs text-dim">
              {t("Needs")}: {fit.modes.map((x) => <Tag key={x}><span title={t(MODE_LABELS[x] ?? x)}>{x}</span></Tag>)}
            </span>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Badge className="mono">{ids.length === 1 ? t("1 engine") : t("{n} engines", { n: ids.length })}</Badge>
          {changed && <Badge tone="warn" dot>{t("Changed")}</Badge>}
          {admin && !!ids.length && (
            <Button size="sm" variant="outline" className="max-sm:h-10" icon={<Plus className="size-3.5" />} onClick={onAdd}>{t("Add engine")}</Button>
          )}
          {admin && !isDefault && (
            <Tooltip content={t("Reset this chain to the default order")}>
              <Button size="sm" variant="ghost" className="max-sm:h-10" icon={<RotateCcw className="size-3.5" />} onClick={() => onChange([...defaults])}>{t("Reset")}</Button>
            </Tooltip>
          )}
        </div>
      </div>

      {!ids.length ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-warn/40 bg-warn/5 px-4 py-6 text-center">
          <AlertTriangle className="size-5 text-warn" aria-hidden />
          <p className="text-sm text-warn">{t("Empty chain — jobs of this kind will fail unless a shot pins an engine.")}</p>
          {admin && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={onAdd}>{t("Add engine")}</Button>}
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={rectSortingStrategy}>
            <ol aria-label={t("Engines in order")} className="flex list-none flex-wrap items-stretch gap-y-2 max-sm:flex-col">
              <AnimatePresence initial={false}>
                {ids.map((id, i) => (
                  <motion.li key={id} layout="position" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94 }}
                    transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }} className="flex items-stretch max-sm:flex-col">
                    <ChainNode id={id} index={i} count={ids.length} m={lookup[id]} admin={admin}
                      onMove={(to) => move(i, to)} onRemove={() => onChange(ids.filter((x) => x !== id))} />
                    {i < ids.length - 1 && (
                      <div aria-hidden className="hub-arrow">
                        <span className="mono text-2xs uppercase tracking-wider">{t("on fail")}</span>
                        <ArrowRight />
                      </div>
                    )}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          </SortableContext>
        </DndContext>
      )}
    </Panel>
  );
}

/** Why an engine in a chain would be skipped (or would be switched on at save). Empty when it is ready. */
function skipReason(m: AIModel | undefined, t: (s: string) => string): string {
  return !m ? t("Not in the catalog yet — run a sync")
    : m.status === "retired" ? t("Retired by the provider — skipped")
      : m.provider_mode === "missing" ? t("Provider has no API key — skipped")
        : m.capabilities?.usable === false ? t("Inputs couldn't be mapped — skipped") : "";
}

function ChainNode({ id, index, count, m, admin, onMove, onRemove }: {
  id: string; index: number; count: number; m: AIModel | undefined; admin: boolean; onMove: (to: number) => void; onRemove: () => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !admin });
  const warn = skipReason(m, t);
  const first = index === 0;
  const lastResort = count >= 3 && index === count - 1;
  const role = first ? t("Primary") : lastResort ? t("Last resort") : t("Fallback {n}", { n: index });
  const ok = m ? successPct(m) : null;
  const { value: ps, exact } = m ? perSecond(m) : { value: null, exact: false };
  const clip = m ? clipUsd(m) : null;
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}
      data-primary={first || undefined} data-skip={!!warn || undefined} data-dragging={isDragging || undefined}
      className="hub-node relative flex w-[17rem] flex-col gap-2.5 rounded-xl border border-line bg-raised/40 p-3 max-sm:w-full">
      <div className="flex items-center gap-1.5">
        {admin && (
          <button {...attributes} {...listeners} aria-label={t("Drag to reorder")}
            className="-ml-1 grid size-7 shrink-0 cursor-grab touch-none place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink active:cursor-grabbing max-sm:size-10">
            <GripVertical className="size-4" />
          </button>
        )}
        <span className={cn("mono grid size-6 shrink-0 place-items-center rounded-md text-xs font-semibold", first ? "bg-accent text-black" : "border border-line bg-raised text-mute")}>{index + 1}</span>
        <span className={cn("mono min-w-0 flex-1 truncate text-2xs font-medium uppercase tracking-wider", first ? "text-accent-ink" : "text-dim")} title={role}>{role}</span>
        {admin && (
          <span className="flex shrink-0 items-center">
            <IconButton title={t("Move earlier")} disabled={index === 0} onClick={() => onMove(index - 1)} className="size-6 max-sm:size-10">
              <ArrowLeft className="size-3.5 max-sm:hidden" /><ArrowUp className="size-3.5 sm:hidden" />
            </IconButton>
            <IconButton title={t("Move later")} disabled={index === count - 1} onClick={() => onMove(index + 1)} className="size-6 max-sm:size-10">
              <ArrowRight className="size-3.5 max-sm:hidden" /><ArrowDown className="size-3.5 sm:hidden" />
            </IconButton>
            <IconButton title={t("Remove from chain")} onClick={onRemove} className="size-6 hover:bg-bad/12 hover:text-bad max-sm:size-10"><X className="size-3.5" /></IconButton>
          </span>
        )}
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-semibold" title={id}>{m?.display_name || engineShort(id)}</span>
          {m?.capabilities?.native_audio && <Volume2 className="size-3.5 shrink-0 text-accent-ink" aria-label={t("Native audio")} />}
          {m && (m.status === "new" || m.status === "disabled") && (
            <span title={t("Will be switched on when you save")} className="shrink-0"><StatusBadge status={m.status} /></span>
          )}
        </div>
        {m && <div className="mt-1.5 flex flex-wrap items-center gap-1.5"><ProviderBadge m={m} /><ModeChips modes={m.capabilities?.modes} max={3} /></div>}
      </div>

      <div className="mt-auto flex items-end justify-between gap-3 border-t border-line pt-2.5">
        {m ? (
          ps != null || clip != null ? (
            <span className="mono min-w-0">
              <span className="flex items-baseline gap-1 text-money"><span className="text-sm font-medium">{ps != null ? `${exact ? "" : "~"}${rateText(ps)}` : usd(clip)}</span><span className="text-2xs text-dim">{ps != null ? "/s" : ""}</span></span>
              {clip != null && ps != null && <span className="mt-0.5 block text-2xs text-dim">{t("8 s clip")} <span className="text-money">{usd(clip)}</span></span>}
            </span>
          ) : <PriceBlock m={m} size="sm" />
        ) : <span className="text-2xs text-dim">—</span>}
        <div className="min-w-0 text-right">
          {warn ? (
            <p className="flex items-start justify-end gap-1 text-2xs text-warn" title={warn}><AlertTriangle className="mt-px size-3 shrink-0" aria-hidden /><span className="min-w-0 text-left">{warn}</span></p>
          ) : m ? (
            <>
              <p className="mono flex items-center justify-end gap-1.5 text-2xs text-mute"><StatusDot tone={m.provider_mode === "live" ? "ok" : "warn"} />{m.provider_mode === "live" ? t("Ready") : t("Placeholder")}</p>
              {ok != null && <p className="mono mt-0.5 text-2xs text-dim">{t("{n}% success", { n: ok })}</p>}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ── add dialog ─────────────────────────────────────────────────────────────── */

const qsOf = (o: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString();

function AddModelModal({ chain, label, already, onClose, onPick }: {
  chain: string | null; label: string; already: string[]; onClose: () => void; onPick: (m: AIModel) => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setQ(""); setDq(""); setShowAll(false); }, [chain]);
  useEffect(() => { const id = window.setTimeout(() => setDq(q.trim()), 220); return () => window.clearTimeout(id); }, [q]);

  // Suitable engines: one small query per mode the chain accepts (the API filters one mode at a time), merged here.
  const fit = chain ? CHAIN_FIT[chain] : undefined;
  const requests = useMemo(() => {
    if (!chain) return [];
    if (showAll || !fit) return [{ q: dq, limit: 100 }];
    return fit.modes.map((mode) => ({ q: dq, mode, task: fit.tasks?.join(","), limit: 100 }));
  }, [chain, fit, showAll, dq]);
  const results = useQueries({
    queries: requests.map((r) => ({
      queryKey: ["models", "add", r],
      queryFn: () => api.get<ModelList>(`/api/models?${qsOf({ ...r, sort: "uses" })}`),
      placeholderData: keepPreviousData,
      staleTime: 30_000,
      enabled: !!chain,
    })),
  });
  const loading = !!chain && results.some((r) => r.isLoading);
  const total = results.reduce((n, r) => n + (r.data?.total ?? 0), 0);
  const list = useMemo(() => {
    const seen = new Map<string, AIModel>();
    for (const r of results) for (const m of r.data?.models ?? []) seen.set(m.id, m);
    return [...seen.values()]
      .filter((m) => m.status !== "retired" && !already.includes(m.id) && (showAll || !chain || fitsChain(m, chain)))
      .sort((a, b) => Number(b.status === "enabled") - Number(a.status === "enabled") || (a.est_8s_usd ?? 99) - (b.est_8s_usd ?? 99) || a.display_name.localeCompare(b.display_name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join("|"), already, showAll, chain]);

  return (
    <Modal open={!!chain} onClose={onClose} title={tr("Add an engine to “{chain}”", { chain: label })} size="lg"
      footer={<Button variant="ghost" onClick={onClose}>{t("Done")}</Button>}>
      <div className="space-y-3">
        <SearchField value={q} onChange={setQ} placeholder={t("Search engines…")} aria-label={t("Search engines…")} data-autofocus />
        <label className="flex cursor-pointer items-center gap-2 text-xs text-mute">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          {t("Show engines that don't look suitable for this chain")}
        </label>
        <div className="max-h-[50vh] space-y-1.5 overflow-y-auto pr-1">
          {loading && Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
          {!loading && !list.length && <Empty title={t("Nothing to add")} sub={t("No other catalog engines fit this chain. Try a sync, or show unsuitable engines.")} />}
          {!loading && list.map((m) => {
            const { value, exact } = perSecond(m);
            return (
              <button key={m.id} type="button" onClick={() => { onPick(m); toast.success(tr("Added {name}", { name: m.display_name })); }}
                className="cx-block group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:border-accent/40 hover:bg-hover max-sm:min-h-14">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{m.display_name}</span>
                    {m.status !== "enabled" && <StatusBadge status={m.status} />}
                    {m.capabilities?.native_audio && <Volume2 className="size-3.5 shrink-0 text-accent-ink" aria-label={t("Native audio")} />}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <ProviderBadge m={m} />
                    <ModeChips modes={m.capabilities?.modes} max={4} />
                  </div>
                </div>
                <span className="mono shrink-0 text-right text-sm font-medium text-money">
                  {value != null ? <>{exact ? "" : "~"}{rateText(value)}<span className="text-2xs text-dim">/s</span></> : m.est_8s_usd ? usd(m.est_8s_usd) : <span className="text-dim">{m.price_label}</span>}
                </span>
                <span className="grid size-7 shrink-0 place-items-center rounded-md text-dim transition-colors group-hover:bg-accent/15 group-hover:text-accent-ink"><Plus className="size-4" /></span>
              </button>
            );
          })}
        </div>
        {showAll && total > 100 && <p className="text-2xs text-dim">{t("Showing the first 100 — refine your search to find others.")}</p>}
        <p className="text-2xs text-dim"><Search className="mr-1 inline size-3" />{t("Engines you add are switched on when the policy is saved.")}</p>
      </div>
    </Modal>
  );
}
