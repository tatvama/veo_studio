/**
 * Data layer of the Model Hub catalog: URL-backed filters, a paged (infinite) list query, per-task facet counts,
 * the "new models" strip and cache patching. The API pages with `limit` / `offset` and returns `total` (matches before paging).
 * Grouped (the default) lists one card per model with its routes through every provider; `total` then counts cards.
 */
import { keepPreviousData, useInfiniteQuery, useQueries, useQuery, type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import type { AIModel, ModelList, ModelRoute } from "../../lib/types";
import { CAP_KEYS, NO_REFINE, PRICE_KEYS, SPEED_KEYS, refineActive, refineCount, type Refine } from "./modelMeta";

export { NO_REFINE, type Refine };
export const PAGE_SIZE = 48;

export type Sort = "newest" | "name" | "price" | "rating" | "uses";
export const SORTS: readonly Sort[] = ["newest", "name", "price", "rating", "uses"];
export type View = "grid" | "list";
const VIEWS: readonly View[] = ["grid", "list"];
const GROUP_PREFS = ["on", "off"] as const;

export interface Filters { q: string; task: string; status: string; provider: string; mode: string }
export const NO_FILTERS: Filters = { q: "", task: "", status: "", provider: "", mode: "" };

/** Every task the catalog can contain (the order of the chips). */
export const CATALOG_TASKS = ["video", "avatar", "lipsync", "edit", "image", "tts", "music", "train", "other"] as const;

/** Providers the studio knows about. Others that show up in the data are added to the filter automatically. */
export const KNOWN_PROVIDERS = ["google", "byteplus", "openrouter", "fal", "sync", "elevenlabs", "sarvam"] as const;
const PROVIDER_LABELS: Record<string, string> = { fal: "fal.ai", google: "Google", sync: "sync.so", elevenlabs: "ElevenLabs", sarvam: "Sarvam AI",
  openrouter: "OpenRouter", byteplus: "BytePlus" };
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
  /** Refinements the API cannot filter on (capability, price band, speed tier). Applied to the loaded models in the browser. */
  refine: Refine;
  sort: Sort;
  view: View;
  /** One card per model (its routes through every provider together) instead of one per engine. */
  group: boolean;
  /** True when anything other than sort / view differs from the defaults. */
  filtered: boolean;
  update: (patch: Partial<Filters>) => void;
  updateRefine: (patch: Partial<Refine>) => void;
  clear: () => void;
  setSort: (s: Sort) => void;
  setView: (v: View) => void;
  setGroup: (on: boolean) => void;
}

const REFINE_PARAMS = ["cap", "price", "speed"] as const;
const listParam = (raw: string | null, allowed: readonly string[]) => (raw ? raw.split(",").filter((x) => allowed.includes(x)) : []);

/** Filters live in the URL (shareable, survive reloads); sort, view and grouping are remembered per browser. */
export function useCatalogFilters(): CatalogCtl {
  const [sp, setSp] = useSearchParams();
  const [sort, setSortState] = useState<Sort>(() => readPref("veo-hub-sort", "newest", SORTS));
  const [view, setViewState] = useState<View>(() => readPref("veo-hub-view", "grid", VIEWS));
  const [group, setGroupState] = useState(() => readPref("veo-hub-group", "on", GROUP_PREFS) === "on");
  const filters = useMemo<Filters>(() => ({
    q: sp.get("q") ?? "", task: sp.get("task") ?? "", status: sp.get("status") ?? "", provider: sp.get("provider") ?? "", mode: sp.get("mode") ?? "",
  }), [sp]);
  const capParam = sp.get("cap"), priceParam = sp.get("price"), speedParam = sp.get("speed");
  const refine = useMemo<Refine>(() => ({
    cap: listParam(capParam, CAP_KEYS), price: listParam(priceParam, PRICE_KEYS), speed: listParam(speedParam, SPEED_KEYS),
  }), [capParam, priceParam, speedParam]);
  const update = useCallback((patch: Partial<Filters>) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
      return next;
    }, { replace: true });
  }, [setSp]);
  const updateRefine = useCallback((patch: Partial<Refine>) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) { if (v && v.length) next.set(k, v.join(",")); else next.delete(k); }
      return next;
    }, { replace: true });
  }, [setSp]);
  const clear = useCallback(() => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const k of [...Object.keys(NO_FILTERS), ...REFINE_PARAMS]) next.delete(k);
      return next;
    }, { replace: true });
  }, [setSp]);
  const setSort = useCallback((s: Sort) => { setSortState(s); writePref("veo-hub-sort", s); }, []);
  const setView = useCallback((v: View) => { setViewState(v); writePref("veo-hub-view", v); }, []);
  const setGroup = useCallback((on: boolean) => { setGroupState(on); writePref("veo-hub-group", on ? "on" : "off"); }, []);
  const filtered = !!(filters.q || filters.task || filters.status || filters.provider || filters.mode) || refineActive(refine);
  // one stable object, so memoised children only re-render when a filter really changes
  return useMemo(() => ({ filters, refine, sort, view, group, filtered, update, updateRefine, clear, setSort, setView, setGroup }),
    [filters, refine, sort, view, group, filtered, update, updateRefine, clear, setSort, setView, setGroup]);
}

/** How many filters (other than the task chips) are on: the number on the phone "Filters" button. */
export function activeFilterCount(f: Filters, r: Refine): number {
  return [f.status, f.provider, f.mode].filter(Boolean).length + refineCount(r);
}

/** `group=true` in the query string when grouping is on (left out otherwise). */
const groupArg = (group: boolean) => (group ? "true" : undefined);

/** The paged list. Pages load on demand; changing a filter keeps the previous results on screen until the new ones arrive. */
export function useCatalogPages(f: Filters, sort: Sort, group: boolean) {
  const q = useInfiniteQuery({
    queryKey: ["models", "catalog", f, sort, group],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.get<ModelList>(`/api/models?${qsOf({ ...f, sort, group: groupArg(group), limit: PAGE_SIZE, offset: pageParam })}`),
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

/** How many models match the current search / status / provider / mode for each task (the chip counts; cards when grouped). */
export function useTaskCounts(f: Filters, group: boolean): Record<string, number | undefined> {
  const tasks = ["", ...CATALOG_TASKS];
  const rest = { q: f.q, status: f.status, provider: f.provider, mode: f.mode, group: groupArg(group) };
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

/** How many models match the current search / status / task / mode for each provider (the provider rail counts; cards when grouped). */
export function useProviderCounts(f: Filters, providers: string[], group: boolean): Record<string, number | undefined> {
  const list = ["", ...providers];
  const rest = { q: f.q, status: f.status, task: f.task, mode: f.mode, group: groupArg(group) };
  const results = useQueries({
    queries: list.map((provider) => ({
      queryKey: ["models", "facet", "provider", { ...rest, provider }],
      queryFn: () => api.get<ModelList>(`/api/models?${qsOf({ ...rest, provider, limit: 1 })}`),
      select: (d: ModelList) => d.total,
      placeholderData: keepPreviousData,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    })),
  });
  const key = list.join(",") + "|" + results.map((r) => r.data ?? "").join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => Object.fromEntries(list.map((p, i) => [p, results[i].data])), [key]);
}

/**
 * Every enabled engine, cheapest first (one request, shared by the KPI strip). Independent of the catalog filters, so the
 * "cheapest / fastest / cost range" tiles always describe what the studio can actually use today.
 */
export function useEnabledEngines() {
  return useQuery({
    queryKey: ["models", "enabled-engines"],
    queryFn: () => api.get<ModelList>("/api/models?status=enabled&sort=price&limit=400"),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

/** An engine as one route of its model (the shape of `routes` / `other_routes` entries). */
export function routeOf(m: AIModel): ModelRoute {
  return {
    id: m.id, provider: m.provider, display_name: m.display_name, provider_mode: m.provider_mode, est_8s_usd: m.est_8s_usd,
    price_usd: m.price_usd, price_unit: m.price_unit, modes: m.capabilities?.modes ?? [], status: m.status, endpoint: m.endpoint,
    price_label: m.price_label, route_key_set: typeof m.param_overrides?.route_key === "string",
  };
}

/** Refresh one engine's entry wherever a card or an engine lists it as a route (`routes`, `other_routes`). */
function patchRoutes(x: AIModel, res: AIModel): AIModel {
  const fix = (list?: ModelRoute[]) => (list?.some((r) => r.id === res.id) ? list.map((r) => (r.id === res.id ? { ...r, ...routeOf(res) } : r)) : list);
  const routes = fix(x.routes), other = fix(x.other_routes);
  if (routes === x.routes && other === x.other_routes) return x;
  return { ...x, routes, other_routes: other, routes_on: routes ? routes.filter((r) => r.status === "enabled").length : x.routes_on };
}

/** Merge a PATCH / GET response into every cached list (flat lists and infinite pages alike) and every route list holding it. */
export function patchModelInCache(qc: QueryClient, res: AIModel) {
  const one = (x: AIModel) => patchRoutes(x.id === res.id ? { ...x, ...res } : x, res);
  const swap = (list: AIModel[]) => list.map(one);
  qc.setQueriesData({ queryKey: ["models"] }, (old: any) => {
    if (!old || typeof old !== "object") return old;
    if (Array.isArray(old.models)) return { ...old, models: swap(old.models) };
    if (Array.isArray(old.pages)) return { ...old, pages: old.pages.map((p: any) => (p && Array.isArray(p.models) ? { ...p, models: swap(p.models) } : p)) };
    return old;
  });
  qc.setQueriesData({ queryKey: ["model"] }, (old: AIModel | undefined) => (old && typeof old === "object" && old.id ? one(old) : old));
}

/**
 * Every route of one engine's model, switched-off ones too, for the model page: the grouped list filtered to its route key,
 * and the card holding this engine picked out. Null when the engine isn't merged; the page then falls back on `other_routes`.
 */
export function useRouteCard(m: Pick<AIModel, "id" | "task" | "route_key">) {
  const key = m.route_key ?? "";
  const id = m.id;
  return useQuery({
    queryKey: ["models", "routes", m.task, key],
    queryFn: () => api.get<ModelList>(`/api/models?${qsOf({ group: "true", task: m.task, route_key: key, sort: "name", limit: 1000 })}`),
    select: (d: ModelList) => d.models.find((c) => c.id === id || c.routes?.some((r) => r.id === id)) ?? null,
    enabled: !!key,
    staleTime: 30_000,
  });
}

/** Refresh counts, strips and engine pickers after a change without re-fetching every page the user has loaded. */
export function refreshAfterModelChange(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["models"], predicate: (q) => q.queryKey[1] !== "catalog" });
  qc.invalidateQueries({ queryKey: ["models", "catalog"], refetchType: "none" });
  qc.invalidateQueries({ queryKey: ["shot-engines"] });
}
