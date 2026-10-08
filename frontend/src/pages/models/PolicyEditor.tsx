import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { keepPreviousData, useQueries, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  AlertTriangle, ChevronDown, Crown, FastForward, GripVertical, Image as ImageIcon, Lock, MessagesSquare, Plus, RotateCcw, Route, Scale, Search, Speech, Volume2,
  Wand2, X, Zap, CornerDownRight, type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CHAIN_FIT, CHAIN_HELP, MODE_LABELS, engineShort, fitsChain } from "../../components/hub/util";
import { Badge, Button, Card, Empty, Modal, SearchField, Skeleton, Tooltip, rise } from "../../components/ui";
import { api } from "../../lib/api";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { usePolicy } from "../../lib/queries";
import type { AIModel, ModelList, ModelPolicy } from "../../lib/types";
import { UnsavedBar } from "../admin/shared/UnsavedBar";
import { useFlash } from "../admin/shared/useFlash";
import { ModeChips, ProviderBadge, StatusBadge } from "./ModelCard";

import { Pill } from "../admin/shared/Pill";
type Chains = Record<string, string[]>;
const ORDER = ["video.saver", "video.balanced", "video.hero", "dialogue", "lipsync", "image", "edit", "extend"];

const CHAIN_ICON: Record<string, LucideIcon> = {
  "video.saver": Zap, "video.balanced": Scale, "video.hero": Crown, dialogue: MessagesSquare, lipsync: Speech, image: ImageIcon, edit: Wand2, extend: FastForward,
};

export default function PolicyEditor({ admin }: { admin: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: policy, isLoading } = usePolicy();
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

  if (isLoading || !policy) {
    return (
      <div className="space-y-4" aria-busy>
        <Skeleton className="h-16 w-full rounded-xl" />
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-72 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-line bg-panel px-4 py-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent-ink"><Route className="size-4" /></span>
        <p className="min-w-[240px] flex-1 text-sm text-mute">
          {t("Each job tries its chain top to bottom. The first enabled engine that supports the shot wins; if it fails (safety block, bad input) the next one is tried. A shot can still pin its own engine.")}
        </p>
        {admin ? (
          <Button size="sm" variant="outline" icon={<RotateCcw className="size-3.5" />} onClick={resetAll}>{t("Reset all to default")}</Button>
        ) : (
          <Badge><Lock className="size-3" />{t("Only admins can change routing")}</Badge>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {keys.map((k, i) => {
          const r = rise(i);
          return (
            <div key={k} className={clsx("min-w-0", r.className)} style={r.style}>
              <ChainCard chain={k} label={policy.labels[k] ?? k} ids={chains[k] ?? []} defaults={policy.defaults[k] ?? []}
                lookup={lookup} admin={admin} changed={changed(k)}
                onChange={(ids) => setChain(k, ids)} onAdd={() => setAdding(k)} />
            </div>
          );
        })}
      </div>

      <div className="h-20" aria-hidden />
      {admin && (
        <UnsavedBar show={dirty} saved={savedFlash && !dirty} saving={saving} onDiscard={() => setChains(server)} onSave={save}
          saveLabel={t("Save policy")} savedLabel={t("Routing policy saved")}
          message={changedCount === 1 ? t("1 chain changed. New engines are switched on when you save.") : t("{n} chains changed. New engines are switched on when you save.", { n: changedCount })} />
      )}

      <AddModelModal
        chain={adding} label={adding ? t(policy.labels[adding] ?? adding) : ""} already={adding ? chains[adding] ?? [] : []}
        onClose={() => setAdding(null)}
        onPick={(m) => { if (adding) { setExtra((e) => ({ ...e, [m.id]: m })); setChain(adding, [...(chains[adding] ?? []), m.id]); } }} />
    </div>
  );
}

/* ── chain card ─────────────────────────────────────────────────────────────── */

function ChainCard({ chain, label, ids, defaults, lookup, admin, changed, onChange, onAdd }: {
  chain: string; label: string; ids: string[]; defaults: string[]; lookup: Record<string, AIModel>; admin: boolean; changed: boolean;
  onChange: (ids: string[]) => void; onAdd: () => void;
}) {
  const t = useT();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = ids.indexOf(String(e.active.id));
    const to = ids.indexOf(String(e.over.id));
    if (from < 0 || to < 0) return;
    onChange(arrayMove(ids, from, to));
  };
  const isDefault = JSON.stringify(ids) === JSON.stringify(defaults);
  const fit = CHAIN_FIT[chain];
  const Icon = CHAIN_ICON[chain] ?? Route;

  return (
    <Card className={clsx("flex flex-col transition-colors duration-200", changed && "border-warn/50")}>
      <div className="flex items-start gap-3 border-b border-line px-4 py-3.5">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-raised text-mute"><Icon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{t(label)}</h3>
            <Badge className="tabular-nums">{ids.length === 1 ? t("1 engine") : t("{n} engines", { n: ids.length })}</Badge>
            {changed && <Pill tone="warn" dot>{t("Changed")}</Pill>}
          </div>
          <p className="mt-0.5 text-xs text-mute">{t(CHAIN_HELP[chain] ?? "")}</p>
          {fit && (
            <p className="mt-1.5 flex flex-wrap items-center gap-1 text-2xs text-dim">
              {t("Needs")}: {fit.modes.map((x) => <span key={x} className="rounded border border-line bg-raised px-1 py-px text-mute">{t(MODE_LABELS[x] ?? x)}</span>)}
            </p>
          )}
        </div>
        {admin && !isDefault && (
          <Tooltip content={t("Reset this chain to the default order")}>
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => onChange([...defaults])}>{t("Reset")}</Button>
          </Tooltip>
        )}
      </div>

      <div className="flex-1 px-3 pb-2 pt-3">
        {!ids.length ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-warn/40 bg-warn/5 px-4 py-6 text-center">
            <AlertTriangle className="size-5 text-warn" />
            <p className="text-sm text-amber-300">{t("Empty chain — jobs of this kind will fail unless a shot pins an engine.")}</p>
            {admin && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={onAdd}>{t("Add engine")}</Button>}
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <ol className="list-none">
                <AnimatePresence initial={false}>
                  {ids.map((id, i) => (
                    <motion.li key={id} layout="position" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
                      <ChainStep id={id} index={i} last={i === ids.length - 1} m={lookup[id]} admin={admin} onRemove={() => onChange(ids.filter((x) => x !== id))} />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ol>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {admin && !!ids.length && (
        <div className="border-t border-line px-3 py-2">
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={onAdd}>{t("Add engine")}</Button>
        </div>
      )}
    </Card>
  );
}

function ChainStep({ id, index, last, m, admin, onRemove }: { id: string; index: number; last: boolean; m: AIModel | undefined; admin: boolean; onRemove: () => void }) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !admin });
  const warn = !m ? t("Not in the catalog yet — run a sync")
    : m.status === "retired" ? t("Retired by the provider — skipped")
      : m.provider_mode === "missing" ? t("Provider has no API key — skipped")
        : m.capabilities?.usable === false ? t("Inputs couldn't be mapped — skipped") : "";
  const first = index === 0;
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}
      className={clsx("relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-2.5", isDragging && "opacity-95")}>
      <div className="flex flex-col items-center">
        <span className={clsx("grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums",
          first ? "bg-accent text-black shadow-glow" : "border border-line bg-raised text-mute")}>{index + 1}</span>
        {!last && (
          <>
            <span aria-hidden className="mt-1 w-px flex-1 border-l border-dashed border-dim/40" />
            <ChevronDown aria-hidden className="-mb-1 size-3.5 shrink-0 text-dim" />
          </>
        )}
      </div>
      <div className={clsx(!last && "pb-0.5")}>
        <div className={clsx("group flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-xl border px-2.5 py-2 transition-[border-color,box-shadow,background-color] duration-150",
          isDragging ? "border-accent bg-raised shadow-pop" : "border-line bg-raised/40 hover:border-dim/40 hover:bg-raised/70")}>
          {admin ? (
            <button {...attributes} {...listeners} aria-label={t("Drag to reorder")}
              className="-ml-1 grid size-7 shrink-0 cursor-grab touch-none place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink active:cursor-grabbing">
              <GripVertical className="size-4" />
            </button>
          ) : null}
          <div className="min-w-0 flex-1 basis-40">
            <p className="text-2xs font-medium uppercase tracking-wide text-dim">{first ? t("First choice") : t("Fallback {n}", { n: index })}</p>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium" title={id}>{m?.display_name || engineShort(id)}</span>
              {m?.capabilities?.native_audio && <Volume2 className="size-3.5 shrink-0 text-ok" aria-label={t("Native audio")} />}
              {m && (m.status === "new" || m.status === "disabled") && (
                <span title={t("Will be switched on when you save")} className="shrink-0"><StatusBadge status={m.status} /></span>
              )}
            </div>
            {warn ? (
              <p className="mt-0.5 flex items-center gap-1 text-2xs text-amber-300" title={warn}><AlertTriangle className="size-3 shrink-0" /><span className="truncate">{warn}</span></p>
            ) : m ? (
              <div className="mt-1 flex flex-wrap items-center gap-1.5"><ProviderBadge m={m} /><ModeChips modes={m.capabilities?.modes} max={3} /></div>
            ) : null}
          </div>
          {m && (
            <div className="shrink-0 text-right">
              <p className="text-sm font-semibold tabular-nums">{m.est_8s_usd != null ? usd(m.est_8s_usd) : <span className="text-dim">{m.price_label}</span>}</p>
              {m.est_8s_usd != null && <p className="text-2xs text-dim">{t("per 8s")}</p>}
            </div>
          )}
          {admin && (
            <button type="button" onClick={onRemove} aria-label={t("Remove from chain")} title={t("Remove from chain")}
              className="grid size-7 shrink-0 place-items-center rounded-md text-dim transition-colors hover:bg-bad/12 hover:text-bad">
              <X className="size-4" />
            </button>
          )}
        </div>
        {!last && (
          <p className="flex items-center gap-1 py-1.5 pl-2 text-2xs text-dim"><CornerDownRight className="size-3" />{t("If it fails, the next one is tried")}</p>
        )}
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
        <div className="max-h-[50vh] space-y-1 overflow-y-auto pr-1">
          {loading && Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}
          {!loading && !list.length && <Empty title={t("Nothing to add")} sub={t("No other catalog engines fit this chain. Try a sync, or show unsuitable engines.")} />}
          {!loading && list.map((m) => (
            <button key={m.id} type="button" onClick={() => { onPick(m); toast.success(tr("Added {name}", { name: m.display_name })); }}
              className="group flex w-full items-center gap-3 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-line hover:bg-raised">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{m.display_name}</span>
                  {m.status !== "enabled" && <StatusBadge status={m.status} />}
                  {m.capabilities?.native_audio && <Volume2 className="size-3.5 shrink-0 text-ok" />}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <ProviderBadge m={m} />
                  <ModeChips modes={m.capabilities?.modes} max={4} />
                </div>
              </div>
              <span className="shrink-0 text-sm font-medium tabular-nums text-mute">{m.est_8s_usd != null ? usd(m.est_8s_usd) : m.price_label}</span>
              <span className="grid size-7 shrink-0 place-items-center rounded-md text-dim transition-colors group-hover:bg-accent/15 group-hover:text-accent-ink"><Plus className="size-4" /></span>
            </button>
          ))}
        </div>
        {showAll && total > 100 && <p className="text-2xs text-dim">{t("Showing the first 100 — refine your search to find others.")}</p>}
        <p className="text-2xs text-dim"><Search className="mr-1 inline size-3" />{t("Engines you add are switched on when the policy is saved.")}</p>
      </div>
    </Modal>
  );
}
