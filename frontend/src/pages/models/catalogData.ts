/**
 * Data layer of the Model Hub catalog: URL-backed filters, a paged (infinite) list query, per-task facet counts,
 * the "new models" strip and cache patching. The API pages with `limit` / `offset` and returns `total` (matches before paging).
 */
import { keepPreviousData, useInfiniteQuery, useQueries, useQuery, type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import type { AIModel, ModelList } from "../../lib/types";

export const PAGE_SIZE = 48;

export type Sort = "newest" | "name" | "price" | "rating" | "uses";
export const SORTS: readonly Sort[] = ["newest", "name", "price", "rating", "uses"];
export type View = "grid" | "list";
const VIEWS: readonly View[] = ["grid", "list"];

export interface Filters { q: string; task: string; status: string; provider: string; mode: string }
export const NO_FILTERS: Filters = { q: "", task: "", status: "", provider: "", mode: "" };

/** Every task the catalog can contain (the order of the chips). */
export const CATALOG_TASKS = ["video", "avatar", "lipsync", "edit", "image", "tts", "music", "train", "other"] as const;

/** Providers the studio knows about. Others that show up in the data are added to the filter automatically. */
export const KNOWN_PROVIDERS = ["fal", "google", "sync", "elevenlabs", "sarvam"] as const;
const PROVIDER_LABELS: Record<string, string> = { fal: "fal.ai", google: "Google", sync: "sync.so", elevenlabs: "ElevenLabs", sarvam: "Sarvam AI" };
export const providerLabel = (p: string) => PROVIDER_LABELS[p] ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : "—");

const qsOf = (o: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString();

function readPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* storage blocked */ }
}

export interface CatalogCtl {
  filters: Filters;
  sort: Sort;
  view: View;
  /** True when anything other than sort / view differs from the defaults. */
  filtered: boolean;
  update: (patch: Partial<Filters>) => void;
  clear: () => void;
  setSort: (s: Sort) => void;
  setView: (v: View) => void;
}

/** Filters live in the URL (shareable, survive reloads); sort and view are remembered per browser. */
export function useCatalogFilters(): CatalogCtl {
  const [sp, setSp] = useSearchParams();
  const [sort, setSortState] = useState<Sort>(() => readPref("veo-hub-sort", "newest", SORTS));
  const [view, setViewState] = useState<View>(() => readPref("veo-hub-view", "grid", VIEWS));
  const filters = useMemo<Filters>(() => ({
    q: sp.get("q") ?? "", task: sp.get("task") ?? "", status: sp.get("status") ?? "", provider: sp.get("provider") ?? "", mode: sp.get("mode") ?? "",
  }), [sp]);
  const update = useCallback((patch: Partial<Filters>) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
      return next;
    }, { replace: true });
  }, [setSp]);
  const clear = useCallback(() => update({ ...NO_FILTERS }), [update]);
  const setSort = useCallback((s: Sort) => { setSortState(s); writePref("veo-hub-sort", s); }, []);
  const setView = useCallback((v: View) => { setViewState(v); writePref("veo-hub-view", v); }, []);
  const filtered = !!(filters.q || filters.task || filters.status || filters.provider || filters.mode);
  // one stable object, so memoised children only re-render when a filter really changes
  return useMemo(() => ({ filters, sort, view, filtered, update, clear, setSort, setView }), [filters, sort, view, filtered, update, clear, setSort, setView]);
}

/** The paged list. Pages load on demand; changing a filter keeps the previous results on screen until the new ones arrive. */
export function useCatalogPages(f: Filters, sort: Sort) {
  const q = useInfiniteQuery({
    queryKey: ["models", "catalog", f, sort],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.get<ModelList>(`/api/models?${qsOf({ ...f, sort, limit: PAGE_SIZE, offset: pageParam })}`),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.models.length, 0);
      return last.models.length && loaded < last.total ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const models = useMemo(() => {
    const seen = new Set<string>();
    const out: AIModel[] = [];
    for (const p of q.data?.pages ?? []) for (const m of p.models) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
    return out;
  }, [q.data]);
  const total = q.data?.pages.length ? q.data.pages[q.data.pages.length - 1].total : 0;
  return { ...q, models, total };
}

/** Counts per status + last sync info (one tiny request). Polled while a sync runs. */
export function useCatalogMeta(refetchInterval: number | false = false) {
  return useQuery({
    queryKey: ["models", "meta"],
    queryFn: () => api.get<ModelList>("/api/models?limit=1"),
    staleTime: 20_000,
    refetchInterval,
  });
}

/** Models waiting for review (status "new"), newest first. */
export function useNewModels(enabled = true) {
  return useQuery({
    queryKey: ["models", "new"],
    queryFn: () => api.get<ModelList>("/api/models?status=new&sort=newest&limit=24"),
    staleTime: 30_000,
    enabled,
  });
}

/** How many models match the current search / status / provider / mode for each task (the chip counts). */
export function useTaskCounts(f: Filters): Record<string, number | undefined> {
  const tasks = ["", ...CATALOG_TASKS];
  const rest = { q: f.q, status: f.status, provider: f.provider, mode: f.mode };
  const results = useQueries({
    queries: tasks.map((task) => ({
      queryKey: ["models", "facet", { ...rest, task }],
      queryFn: () => api.get<ModelList>(`/api/models?${qsOf({ ...rest, task, limit: 1 })}`),
      select: (d: ModelList) => d.total,
      placeholderData: keepPreviousData,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    })),
  });
  const key = results.map((r) => r.data ?? "").join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => Object.fromEntries(tasks.map((task, i) => [task, results[i].data])), [key]);
}

/** Merge a PATCH / GET response into every cached list (flat lists and infinite pages alike). */
export function patchModelInCache(qc: QueryClient, res: AIModel) {
  const swap = (list: AIModel[]) => list.map((x) => (x.id === res.id ? { ...x, ...res } : x));
  qc.setQueriesData({ queryKey: ["models"] }, (old: any) => {
    if (!old || typeof old !== "object") return old;
    if (Array.isArray(old.models)) return { ...old, models: swap(old.models) };
    if (Array.isArray(old.pages)) return { ...old, pages: old.pages.map((p: any) => (p && Array.isArray(p.models) ? { ...p, models: swap(p.models) } : p)) };
    return old;
  });
  qc.setQueryData(["model", res.id], (old: AIModel | undefined) => (old ? { ...old, ...res } : old));
}

/** Refresh counts, strips and engine pickers after a change without re-fetching every page the user has loaded. */
export function refreshAfterModelChange(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["models"], predicate: (q) => q.queryKey[1] !== "catalog" });
  qc.invalidateQueries({ queryKey: ["models", "catalog"], refetchType: "none" });
  qc.invalidateQueries({ queryKey: ["shot-engines"] });
}
