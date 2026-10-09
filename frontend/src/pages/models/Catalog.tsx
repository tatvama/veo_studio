import { AlertTriangle, Boxes, ChevronsDown, FilterX, GitCompareArrows, RefreshCw, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MODE_LABELS, STATUS_LABELS, TASK_LABELS } from "../../components/hub/util";
import { Button, Empty, Progress, Skeleton, Spinner } from "../../components/ui";
import { isTypingTarget } from "../../components/shell/keys";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import { rich } from "../admin/shared/rich";
import type { AIModel } from "../../lib/types";
import {
  KNOWN_PROVIDERS, PAGE_SIZE, providerLabel, useCatalogMeta, useCatalogPages, useNewModels, useProviderCounts, useTaskCounts, type CatalogCtl,
} from "./catalogData";
import { FilterBar } from "./FilterBar";
import { FilterRail } from "./FilterRail";
import { CAP_DEFS, PRICE_BANDS, SPEED_OPTS, matchesRefine, refineActive, refineFacets } from "./modelMeta";
import { ModelCard, ModelRow, useModelPatch } from "./ModelCard";
import ModelCompare, { COMPARE_MAX } from "./ModelCompare";
import ModelDetail from "./ModelDetail";
import NewModels from "./NewModels";

import "../../styles/console.css";
import "../../styles/models.css";

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(17.5rem,1fr))] gap-4";

function CardSkeleton() {
  return (
    <div aria-hidden className="space-y-3 rounded-xl border border-line bg-panel p-3.5">
      <div className="flex items-center justify-between"><Skeleton className="h-3 w-20" /><Skeleton className="h-5 w-16" /></div>
      <div className="flex gap-3"><Skeleton className="size-11 shrink-0" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-3 w-1/2" /></div></div>
      <Skeleton className="h-8 w-full" />
      <div className="flex gap-1.5"><Skeleton className="h-5 w-14" /><Skeleton className="h-5 w-16" /><Skeleton className="h-5 w-12" /></div>
      <div className="grid grid-cols-2 gap-4"><Skeleton className="h-6" /><Skeleton className="h-6" /></div>
      <div className="flex items-center justify-between border-t border-line pt-3"><Skeleton className="h-6 w-20" /><Skeleton className="h-6 w-11 rounded-full" /></div>
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div aria-hidden className="space-y-1.5 rounded-xl border border-line bg-panel p-3">
      {Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}
    </div>
  );
}

export default function Catalog({ admin, ctl, active }: { admin: boolean; ctl: CatalogCtl; active: boolean }) {
  const t = useT();
  const { filters, refine, sort, view, filtered, update, updateRefine, clear } = ctl;
  const refining = refineActive(refine);

  const list = useCatalogPages(filters, sort);
  const { models, total } = list;
  const counts = useTaskCounts(filters);
  const newQ = useNewModels(true);
  const meta = useCatalogMeta();
  const { data: settings } = useSettings();
  const { setEnabled, busy } = useModelPatch();
  const fresh = useMemo(() => (newQ.data?.models ?? []).filter((m) => m.status === "new"), [newQ.data]);
  const providers = useMemo(() => {
    const set = new Set<string>([...KNOWN_PROVIDERS, ...models.map((m) => m.provider)]);
    return [...set].sort((a, b) => providerLabel(a).localeCompare(providerLabel(b)));
  }, [models]);
  const providerCounts = useProviderCounts(filters, providers);
  const providerModes = useMemo(() => Object.fromEntries((settings?.providers ?? []).map((p) => [p.provider, p.mode])), [settings]);

  // capability / price / speed are applied here, on the models that are loaded (the API cannot filter on them)
  const visible = useMemo(() => (refining ? models.filter((m) => matchesRefine(m, refine)) : models), [models, refine, refining]);
  const facets = useMemo(() => refineFacets(models, refine), [models, refine]);

  // detail drawer (keeps the last model so the exit animation still shows content)
  const [openModel, setOpenModel] = useState<AIModel | null>(null);
  const lastModel = useRef<AIModel | null>(null);
  if (openModel) lastModel.current = openModel;
  const closeDetail = useCallback(() => setOpenModel(null), []);

  // compare tray: up to three engines side by side
  const [cmp, setCmp] = useState<AIModel[]>([]);
  const [cmpOpen, setCmpOpen] = useState(false);
  const toggleCompare = useCallback((m: AIModel) => setCmp((c) => (c.some((x) => x.id === m.id) ? c.filter((x) => x.id !== m.id) : c.length >= COMPARE_MAX ? c : [...c, m])), []);
  const byId = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);
  const cmpModels = useMemo(() => cmp.map((c) => byId.get(c.id) ?? c), [cmp, byId]);
  const cmpIds = useMemo(() => new Set(cmp.map((c) => c.id)), [cmp]);
  const compareFull = cmp.length >= COMPARE_MAX;
  useEffect(() => { if (cmpOpen && cmp.length < 2) setCmpOpen(false); }, [cmpOpen, cmp.length]);

  // the filter rail folds into a sheet on phones
  const [railOpen, setRailOpen] = useState(false);

  // "/" jumps to the search box
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [active]);

  // the filter bar gets a border once the page has scrolled under it
  const anchor = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = anchor.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting && !!e.rootBounds && e.boundingClientRect.top < e.rootBounds.top), { threshold: [0, 1] });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // changing a filter while scrolled down brings the new results into view
  const serverKey = `${filters.task}|${filters.status}|${filters.provider}|${filters.mode}|${filters.q}|${sort}`;
  const filterKey = `${serverKey}|${refine.cap.join(",")}|${refine.price.join(",")}|${refine.speed.join(",")}`;
  const firstKey = useRef(filterKey);
  useEffect(() => {
    if (firstKey.current === filterKey) return;
    firstKey.current = filterKey;
    if (stuck) anchor.current?.scrollIntoView({ block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  // infinite scroll: load the next page when the sentinel gets within reach
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const { hasNextPage, isFetchingNextPage, isPlaceholderData, fetchNextPage } = list;
  const canLoad = !!hasNextPage && !isFetchingNextPage && !isPlaceholderData && active;
  useEffect(() => {
    const el = sentinel;
    if (!el || !canLoad) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) void fetchNextPage(); }, { rootMargin: "0px 0px 520px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [sentinel, canLoad, fetchNextPage, models.length]);

  // refinements and "load all" need every page: keep fetching while there is more
  const [loadAll, setLoadAll] = useState(false);
  const serverKeyRef = useRef(serverKey);
  useEffect(() => { if (serverKeyRef.current !== serverKey) { serverKeyRef.current = serverKey; setLoadAll(false); } }, [serverKey]);
  const wantAll = (refining || loadAll) && active;
  useEffect(() => {
    if (wantAll && canLoad) void fetchNextPage();
  }, [wantAll, canLoad, fetchNextPage, models.length]);

  const enableNew = useCallback((m: AIModel) => void setEnabled(m, true), [setEnabled]);
  const dismissNew = useCallback((m: AIModel) => void setEnabled(m, false), [setEnabled]);
  const reviewNew = useCallback(() => update({ status: "new" }), [update]);
  const showNew = fresh.length > 0 && filters.status !== "new";
  const shown = visible.length;
  const grand = refining ? (hasNextPage ? total : visible.length) : total;
  const stillLoading = refining && (!!hasNextPage || isFetchingNextPage);

  // applied filters as removable chips
  const applied = useMemo(() => {
    const out: { key: string; label: string; clear: () => void }[] = [];
    if (filters.q) out.push({ key: "q", label: `“${filters.q}”`, clear: () => update({ q: "" }) });
    if (filters.task) out.push({ key: "task", label: t(TASK_LABELS[filters.task] ?? filters.task), clear: () => update({ task: "" }) });
    if (filters.provider) out.push({ key: "provider", label: providerLabel(filters.provider), clear: () => update({ provider: "" }) });
    if (filters.status) out.push({ key: "status", label: t(STATUS_LABELS[filters.status] ?? filters.status), clear: () => update({ status: "" }) });
    if (filters.mode) out.push({ key: "mode", label: t(MODE_LABELS[filters.mode] ?? filters.mode), clear: () => update({ mode: "" }) });
    for (const k of refine.cap) out.push({ key: `cap-${k}`, label: t(CAP_DEFS.find((d) => d.key === k)?.label ?? k), clear: () => updateRefine({ cap: refine.cap.filter((x) => x !== k) }) });
    for (const k of refine.price) out.push({ key: `price-${k}`, label: t(PRICE_BANDS.find((b) => b.value === k)?.label ?? k), clear: () => updateRefine({ price: refine.price.filter((x) => x !== k) }) });
    for (const k of refine.speed) out.push({ key: `speed-${k}`, label: t(SPEED_OPTS.find((s) => s.value === k)?.label ?? k), clear: () => updateRefine({ speed: refine.speed.filter((x) => x !== k) }) });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, refine, t, update, updateRefine]);

  const partial = hasNextPage ? { loaded: models.length, total, loading: isFetchingNextPage || loadAll, onLoadAll: () => setLoadAll(true) } : null;
  const isTable = view === "list";

  return (
    <div className="space-y-4">
      <AnimatePresence initial={false}>
        {showNew && (
          <NewModels key="new" models={fresh} count={Math.max(fresh.length, newQ.data?.total ?? 0)} admin={admin} busyId={busy}
            onEnable={enableNew} onDismiss={dismissNew} onOpen={setOpenModel} onReviewAll={reviewNew} />
        )}
      </AnimatePresence>

      <div ref={anchor} aria-hidden className="-mb-4 h-px" />
      <div className={cn(
        "z-10 -mx-4 bg-bg/85 px-4 py-3 backdrop-blur-md transition-[box-shadow,border-color] duration-200 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8",
        "border-b md:[@media(min-height:620px)]:sticky md:[@media(min-height:620px)]:top-0",
        stuck ? "border-line" : "border-transparent",
      )}>
        <FilterBar ref={searchRef} ctl={ctl} counts={counts} railOpen={railOpen} onToggleRail={() => setRailOpen((v) => !v)} />
      </div>

      <div className="cx-split hub-split">
        <aside aria-label={t("Filters")} className={cn(!railOpen && "max-[899px]:hidden")}>
          <FilterRail ctl={ctl} providers={providers} taskCounts={counts} providerCounts={providerCounts} statusCounts={meta.data?.counts ?? {}}
            providerModes={providerModes} facets={facets} partial={partial} />
        </aside>

        <div className="min-w-0 space-y-4">
          <div className="space-y-2">
            <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1" aria-live="polite">
              <p className="text-sm text-mute">
                {list.isLoading ? t("Loading models…") : list.isError && !models.length ? null : (
                  <>{rich(t("Showing {a} of {b} models"), { a: <b className="mono font-semibold text-ink">{shown.toLocaleString()}</b>, b: <b className="mono font-semibold text-ink">{grand.toLocaleString()}</b> })}
                    {filtered && <span className="text-dim"> · {t("filtered")}</span>}</>
                )}
              </p>
              {((list.isFetching && !list.isFetchingNextPage) || stillLoading) && <Spinner className="size-3.5" />}
              {stillLoading && <span className="text-2xs text-dim">{t("Loading every model to apply these filters…")}</span>}
              {filtered && <Button size="sm" variant="ghost" icon={<FilterX className="size-3.5" />} onClick={clear}>{t("Clear filters")}</Button>}
            </div>
            {applied.length > 0 && (
              <ul aria-label={t("Applied filters")} className="flex flex-wrap items-center gap-1.5">
                {applied.map((a) => (
                  <li key={a.key}>
                    <button type="button" className="cx-chip is-on max-sm:h-10" onClick={a.clear} aria-label={t("Remove filter {name}", { name: a.label })}>
                      {a.label}<X aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {list.isLoading || (!visible.length && stillLoading) ? (
            isTable ? <RowsSkeleton /> : <div className={GRID}>{Array.from({ length: 9 }, (_, i) => <CardSkeleton key={i} />)}</div>
          ) : list.isError && !models.length ? (
            <Empty icon={<AlertTriangle className="size-8" />} title={t("Couldn't load the catalog")} sub={t("Check your connection and try again.")}
              action={<Button icon={<RefreshCw className="size-4" />} onClick={() => list.refetch()}>{t("Try again")}</Button>} />
          ) : !visible.length ? (
            <Empty icon={<Boxes className="size-8" />} title={filtered ? t("No models match these filters") : t("No models yet")}
              sub={filtered ? t("Try a broader search or clear the filters.") : t("Run a sync to pull the latest engines from the providers.")}
              action={filtered ? <Button onClick={clear}>{t("Clear filters")}</Button> : undefined} />
          ) : (
            <div className={isPlaceholderData ? "opacity-60 transition-opacity" : "transition-opacity"}>
              {!isTable ? (
                <div className={GRID}>
                  {visible.map((m, i) => (
                    // content-visibility keeps a long catalog cheap; the padding (undone by the margin) leaves room for the corner brackets
                    <div key={m.id} className="-m-1 p-1 [contain-intrinsic-size:auto_372px] [content-visibility:auto]">
                      <ModelCard m={m} index={i} admin={admin} busy={busy === m.id} onToggle={setEnabled} onOpen={setOpenModel}
                        open={openModel?.id === m.id} comparing={cmpIds.has(m.id)} compareFull={compareFull} onCompare={toggleCompare} />
                    </div>
                  ))}
                  {isFetchingNextPage && Array.from({ length: 6 }, (_, i) => <CardSkeleton key={`sk${i}`} />)}
                </div>
              ) : (
                <div className="cx-scroll max-h-[max(22rem,calc(100dvh-13rem))] rounded-xl border border-line bg-panel">
                  <table className="cx-table" aria-label={t("Models")}>
                    <thead>
                      <tr>
                        <th className="cx-stick">{t("Model")}</th>
                        <th>{t("Provider")}</th>
                        <th>{t("Task")}</th>
                        <th>{t("Capabilities")}</th>
                        <th className="cx-r">{t("Per second")}</th>
                        <th className="cx-r">{t("8 s clip")}</th>
                        <th>{t("Tier")}</th>
                        <th className="cx-r">{t("Rating")}</th>
                        <th className="cx-r">{t("Uses")}</th>
                        <th>{t("Status")}</th>
                        <th className="w-px"><span className="sr-only">{t("Actions")}</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((m) => (
                        <ModelRow key={m.id} m={m} admin={admin} busy={busy === m.id} onToggle={setEnabled} onOpen={setOpenModel}
                          open={openModel?.id === m.id} comparing={cmpIds.has(m.id)} compareFull={compareFull} onCompare={toggleCompare} />
                      ))}
                    </tbody>
                  </table>
                  <div ref={setSentinel} aria-hidden className="h-px" />
                </div>
              )}
            </div>
          )}

          {models.length > 0 && (
            <div ref={isTable ? undefined : setSentinel} className="flex flex-col items-center gap-3 pb-6 pt-2 text-center">
              <p className="text-sm text-mute">
                {rich(t("Showing {a} of {b}"), { a: <b className="mono font-semibold text-ink">{shown.toLocaleString()}</b>, b: <b className="mono font-semibold text-ink">{grand.toLocaleString()}</b> })}
              </p>
              <Progress value={total ? models.length / total : 1} size="sm" className="w-48" />
              {hasNextPage ? (
                <Button icon={<ChevronsDown className="size-4" />} loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                  {t("Load {n} more", { n: Math.min(PAGE_SIZE, total - models.length) })}
                </Button>
              ) : models.length > PAGE_SIZE ? <p className="text-xs text-dim">{t("That's everything.")}</p> : null}
            </div>
          )}
        </div>
      </div>

      {/* compare tray: sticks to the bottom of the screen while engines are picked */}
      <div className="pointer-events-none sticky bottom-4 z-20 h-0">
        <AnimatePresence>
          {cmp.length > 0 && (
            <motion.div key="tray" role="region" aria-label={t("Compare engines")}
              initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 16, opacity: 0, transition: { duration: 0.14 } }}
              transition={{ type: "spring", stiffness: 430, damping: 36, mass: 0.8 }}
              className="pointer-events-auto absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-raised/95 px-3 py-2.5 backdrop-blur-md">
              <span className="eyebrow flex items-center gap-1.5"><GitCompareArrows className="size-3.5" aria-hidden />{t("Compare")}
                <span className="mono normal-case tracking-normal text-mute">{cmp.length}/{COMPARE_MAX}</span></span>
              <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                {cmpModels.map((m) => (
                  <li key={m.id}>
                    <button type="button" className="cx-chip is-on max-w-[14rem] max-sm:h-10" onClick={() => toggleCompare(m)} aria-label={t("Remove {name}", { name: m.display_name })}>
                      <span className="truncate">{m.display_name || m.endpoint}</span><X aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
              {cmp.length < 2 && <span className="text-2xs text-dim">{t("Pick at least two engines to compare.")}</span>}
              <div className="flex shrink-0 gap-2">
                <Button variant="ghost" onClick={() => setCmp([])}>{t("Clear")}</Button>
                <Button variant="primary" disabled={cmp.length < 2} icon={<GitCompareArrows className="size-4" />} onClick={() => setCmpOpen(true)}>{t("Compare engines")}</Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <ModelCompare models={cmpModels} open={cmpOpen} onClose={() => setCmpOpen(false)} onClear={() => { setCmp([]); setCmpOpen(false); }}
        onRemove={toggleCompare} onOpen={(m) => { setCmpOpen(false); setOpenModel(m); }} />
      {lastModel.current && (
        <ModelDetail model={lastModel.current} open={!!openModel} admin={admin} onClose={closeDetail}
          compare={{ on: !!openModel && cmpIds.has(openModel.id), full: compareFull, toggle: () => { if (openModel) toggleCompare(openModel); } }} />
      )}
    </div>
  );
}
