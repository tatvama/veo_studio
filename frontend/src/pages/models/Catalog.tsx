import { AlertTriangle, Boxes, ChevronsDown, FilterX, RefreshCw } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Empty, Progress, Skeleton, Spinner } from "../../components/ui";
import { isTypingTarget } from "../../components/shell/keys";
import { useT } from "../../lib/i18n";
import { rich } from "../admin/shared/rich";
import type { AIModel } from "../../lib/types";
import { KNOWN_PROVIDERS, PAGE_SIZE, providerLabel, useCatalogPages, useNewModels, useTaskCounts, type CatalogCtl } from "./catalogData";
import { FilterBar } from "./FilterBar";
import { ModelCard, ModelRow, useModelPatch } from "./ModelCard";
import ModelDetail from "./ModelDetail";
import NewModels from "./NewModels";

function useMedia(query: string) {
  const [match, setMatch] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const h = () => setMatch(mq.matches);
    h();
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [query]);
  return match;
}

function CardSkeleton() {
  return (
    <div aria-hidden className="overflow-hidden rounded-xl border border-line bg-panel">
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="space-y-2.5 p-3">
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-3 w-2/5" />
        <div className="flex gap-1.5"><Skeleton className="h-5 w-14" /><Skeleton className="h-5 w-10" /><Skeleton className="h-5 w-10" /></div>
        <div className="flex items-center justify-between border-t border-line pt-3"><Skeleton className="h-4 w-20" /><Skeleton className="h-5 w-10 rounded-full" /></div>
      </div>
    </div>
  );
}

export default function Catalog({ admin, ctl, active }: { admin: boolean; ctl: CatalogCtl; active: boolean }) {
  const t = useT();
  const { filters, sort, view, filtered, update, clear } = ctl;
  const isMd = useMedia("(min-width: 768px)");
  const shownView = isMd ? view : "grid";

  const list = useCatalogPages(filters, sort);
  const { models, total } = list;
  const counts = useTaskCounts(filters);
  const newQ = useNewModels(true);
  const { setEnabled, busy } = useModelPatch();
  const fresh = useMemo(() => (newQ.data?.models ?? []).filter((m) => m.status === "new"), [newQ.data]);
  const providers = useMemo(() => {
    const set = new Set<string>([...KNOWN_PROVIDERS, ...models.map((m) => m.provider)]);
    return [...set].sort((a, b) => providerLabel(a).localeCompare(providerLabel(b)));
  }, [models]);

  // detail drawer (keeps the last model so the exit animation still shows content)
  const [openModel, setOpenModel] = useState<AIModel | null>(null);
  const lastModel = useRef<AIModel | null>(null);
  if (openModel) lastModel.current = openModel;
  const closeDetail = useCallback(() => setOpenModel(null), []);

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
  const filterKey = `${filters.task}|${filters.status}|${filters.provider}|${filters.mode}|${filters.q}|${sort}`;
  const firstKey = useRef(filterKey);
  useEffect(() => {
    if (firstKey.current === filterKey) return;
    firstKey.current = filterKey;
    if (stuck) anchor.current?.scrollIntoView({ block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  // infinite scroll: load the next page when the sentinel gets within reach
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, isPlaceholderData, fetchNextPage } = list;
  const canLoad = !!hasNextPage && !isFetchingNextPage && !isPlaceholderData && active;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canLoad) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) void fetchNextPage(); }, { rootMargin: "0px 0px 520px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [canLoad, fetchNextPage, models.length]);

  const enableNew = useCallback((m: AIModel) => void setEnabled(m, true), [setEnabled]);
  const dismissNew = useCallback((m: AIModel) => void setEnabled(m, false), [setEnabled]);
  const reviewNew = useCallback(() => update({ status: "new" }), [update]);
  const showNew = fresh.length > 0 && filters.status !== "new";
  const shown = models.length;

  return (
    <div className="space-y-5">
      <AnimatePresence initial={false}>
        {showNew && (
          <NewModels key="new" models={fresh} count={Math.max(fresh.length, newQ.data?.total ?? 0)} admin={admin} busyId={busy}
            onEnable={enableNew} onDismiss={dismissNew} onOpen={setOpenModel} onReviewAll={reviewNew} />
        )}
      </AnimatePresence>

      <div ref={anchor} aria-hidden className="-mb-5 h-px" />
      <div className={[
        "z-10 -mx-4 bg-bg/85 px-4 py-3 backdrop-blur-md transition-[box-shadow,border-color] duration-200 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8",
        "border-b md:[@media(min-height:620px)]:sticky md:[@media(min-height:620px)]:top-0",
        stuck ? "border-line shadow-card" : "border-transparent",
      ].join(" ")}>
        <FilterBar ref={searchRef} ctl={ctl} providers={providers} counts={counts} showView={isMd} />
      </div>

      <div className="-my-1 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1" aria-live="polite">
        <p className="text-sm text-mute">
          {list.isLoading ? t("Loading models…") : (
            <>{rich(t("Showing {a} of {b} models"), { a: <b className="font-semibold tabular-nums text-ink">{shown.toLocaleString()}</b>, b: <b className="font-semibold tabular-nums text-ink">{total.toLocaleString()}</b> })}
              {filtered && <span className="text-dim"> · {t("filtered")}</span>}</>
          )}
        </p>
        {(list.isFetching && !list.isFetchingNextPage) && <Spinner className="size-3.5" />}
        {filtered && <Button size="sm" variant="ghost" icon={<FilterX className="size-3.5" />} onClick={clear}>{t("Clear filters")}</Button>}
      </div>

      {list.isLoading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">{Array.from({ length: 12 }, (_, i) => <CardSkeleton key={i} />)}</div>
      ) : list.isError && !models.length ? (
        <Empty icon={<AlertTriangle className="size-8" />} title={t("Couldn't load the catalog")} sub={t("Check your connection and try again.")}
          action={<Button icon={<RefreshCw className="size-4" />} onClick={() => list.refetch()}>{t("Try again")}</Button>} />
      ) : !models.length ? (
        <Empty icon={<Boxes className="size-8" />} title={filtered ? t("No models match these filters") : t("No models yet")}
          sub={filtered ? t("Try a broader search or clear the filters.") : t("Run a sync to pull the latest engines from the providers.")}
          action={filtered ? <Button onClick={clear}>{t("Clear filters")}</Button> : undefined} />
      ) : (
        <div className={isPlaceholderData ? "opacity-60 transition-opacity" : "transition-opacity"}>
          {shownView === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
              {models.map((m, i) => (
                <ModelCard key={m.id} m={m} index={i} admin={admin} busy={busy === m.id} onToggle={setEnabled} onOpen={setOpenModel} />
              ))}
              {isFetchingNextPage && Array.from({ length: 6 }, (_, i) => <CardSkeleton key={`sk${i}`} />)}
            </div>
          ) : (
            <Card className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left">
                <thead className="border-b border-line bg-raised/50 text-2xs uppercase tracking-wide text-dim">
                  <tr>
                    <th className="py-2.5 pl-3 pr-2 font-medium">{t("Model")}</th>
                    <th className="px-2 font-medium">{t("Provider")}</th>
                    <th className="px-2 font-medium">{t("Task")}</th>
                    <th className="hidden px-2 font-medium xl:table-cell">{t("Modes")}</th>
                    <th className="hidden px-2 font-medium lg:table-cell">{t("Capabilities")}</th>
                    <th className="px-2 text-right font-medium">{t("8s clip")}</th>
                    <th className="px-2 font-medium">{t("Status")}</th>
                    <th className="hidden px-2 font-medium xl:table-cell">{t("Track record")}</th>
                    <th className="py-2.5 pl-2 pr-3 text-right font-medium">{t("On")}</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <ModelRow key={m.id} m={m} admin={admin} busy={busy === m.id} onToggle={setEnabled} onOpen={setOpenModel} />
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      )}

      {models.length > 0 && (
        <div ref={sentinel} className="flex flex-col items-center gap-3 pb-6 pt-2 text-center">
          <p className="text-sm text-mute">
            {rich(t("Showing {a} of {b}"), { a: <b className="font-semibold tabular-nums text-ink">{shown.toLocaleString()}</b>, b: <b className="font-semibold tabular-nums text-ink">{total.toLocaleString()}</b> })}
          </p>
          <Progress value={total ? shown / total : 1} size="sm" className="w-48" />
          {hasNextPage ? (
            <Button icon={<ChevronsDown className="size-4" />} loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
              {t("Load {n} more", { n: Math.min(PAGE_SIZE, total - shown) })}
            </Button>
          ) : shown > PAGE_SIZE ? <p className="text-xs text-dim">{t("That's everything.")}</p> : null}
        </div>
      )}

      {lastModel.current && <ModelDetail model={lastModel.current} open={!!openModel} admin={admin} onClose={closeDetail} />}
    </div>
  );
}
