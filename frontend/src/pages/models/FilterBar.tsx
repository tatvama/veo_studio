import { clsx } from "clsx";
import { LayoutGrid, List, SlidersHorizontal } from "lucide-react";
import { forwardRef, memo, useEffect, useState, type Ref } from "react";
import { MODES, MODE_LABELS, STATUS_LABELS, TASK_LABELS } from "../../components/hub/util";
import { Button, Kbd, SearchField, Segmented } from "../../components/ui";
import { ChipGroup, type ChipItem } from "../admin/shared/ChipGroup";
import { FilterSelect } from "../admin/shared/FilterSelect";
import { useT } from "../../lib/i18n";
import { CATALOG_TASKS, providerLabel, type CatalogCtl, type Sort } from "./catalogData";
import { TASK_ICON } from "./ModelCard";

export const TaskChips = memo(function TaskChips({ value, onChange, counts }: { value: string; onChange: (v: string) => void; counts: Record<string, number | undefined> }) {
  const t = useT();
  const items: ChipItem[] = [
    { value: "", label: t("All"), icon: LayoutGrid, count: counts[""] },
    ...CATALOG_TASKS.map((k) => ({ value: k as string, label: t(TASK_LABELS[k] ?? k), icon: TASK_ICON[k] ?? LayoutGrid, count: counts[k] })),
  ];
  return <ChipGroup label={t("Task")} value={value} onChange={onChange} items={items} />;
});

const SORT_LABELS: Record<Sort, string> = {
  newest: "Newest first", name: "Name A–Z", price: "Cheapest first", rating: "Best rated", uses: "Most used",
};

/** The search box keeps its own text and tells the URL about it after a pause, so typing never re-renders the catalog. */
function SearchBox({ value, onCommit, inputRef }: { value: string; onCommit: (v: string) => void; inputRef: Ref<HTMLInputElement> }) {
  const t = useT();
  const [q, setQ] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => { const v = q.trim(); if (v !== value) onCommit(v); }, 250);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  useEffect(() => { if (value !== q.trim()) setQ(value); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [value]);
  return (
    <SearchField ref={inputRef} value={q} onChange={setQ} placeholder={t("Search name, family, endpoint…")} aria-label={t("Search models")}
      className="min-w-[220px] max-w-lg flex-1 max-sm:min-w-0 max-sm:max-w-none" shortcut={<Kbd>/</Kbd>} />
  );
}

const Controls = memo(function Controls({ ctl, providers, counts, open }: { ctl: CatalogCtl; providers: string[]; counts: Record<string, number | undefined>; open: boolean }) {
  const t = useT();
  const { filters, sort, update, setSort } = ctl;
  return (
    <>
      <div className={clsx("min-w-0 grid-cols-2 gap-2 max-sm:w-full sm:flex sm:flex-wrap sm:items-center", open ? "grid" : "max-sm:hidden")}>
        <FilterSelect label={t("Status")} value={filters.status} active={!!filters.status} onChange={(v) => update({ status: v })}>
          <option value="">{t("Any")}</option>
          {(["new", "enabled", "disabled", "retired"] as const).map((x) => <option key={x} value={x}>{t(STATUS_LABELS[x])}</option>)}
        </FilterSelect>
        <FilterSelect label={t("Provider")} value={filters.provider} active={!!filters.provider} onChange={(v) => update({ provider: v })}>
          <option value="">{t("All")}</option>
          {providers.map((x) => <option key={x} value={x}>{providerLabel(x)}</option>)}
        </FilterSelect>
        <FilterSelect label={t("Mode")} value={filters.mode} active={!!filters.mode} onChange={(v) => update({ mode: v })}>
          <option value="">{t("All")}</option>
          {MODES.map((x) => <option key={x} value={x}>{t(MODE_LABELS[x])}</option>)}
        </FilterSelect>
        <FilterSelect label={t("Sort")} value={sort} onChange={(v) => setSort(v as Sort)}>
          {(Object.keys(SORT_LABELS) as Sort[]).map((x) => <option key={x} value={x}>{t(SORT_LABELS[x])}</option>)}
        </FilterSelect>
      </div>
      <div className="min-w-0 basis-full"><TaskChips value={filters.task} onChange={(v) => update({ task: v })} counts={counts} /></div>
    </>
  );
});

export const FilterBar = forwardRef<HTMLInputElement, {
  ctl: CatalogCtl; providers: string[]; counts: Record<string, number | undefined>; showView: boolean;
}>(function FilterBar({ ctl, providers, counts, showView }, searchRef) {
  const t = useT();
  const { filters, view, update, setView } = ctl;
  const [open, setOpen] = useState(false); // the dropdowns fold away on phones
  const active = [filters.status, filters.provider, filters.mode].filter(Boolean).length;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5">
      <SearchBox value={filters.q} onCommit={(v) => update({ q: v })} inputRef={searchRef} />
      <Button variant="outline" className="sm:hidden" aria-expanded={open} icon={<SlidersHorizontal className="size-4" />} onClick={() => setOpen((v) => !v)}>
        {t("Filters")}{active > 0 && <span className="grid size-5 place-items-center rounded-full bg-accent text-2xs font-semibold text-black">{active}</span>}
      </Button>
      {showView && (
        <Segmented value={view} onChange={setView} aria-label={t("Layout")} className="ml-auto xl:order-last" options={[
          { value: "grid", label: <span className="flex h-5 items-center gap-1"><LayoutGrid className="size-3.5" /><span className="hidden xl:inline">{t("Cards")}</span></span>, title: t("Cards") },
          { value: "list", label: <span className="flex h-5 items-center gap-1"><List className="size-3.5" /><span className="hidden xl:inline">{t("List")}</span></span>, title: t("Dense list") },
        ]} />
      )}
      <Controls ctl={ctl} providers={providers} counts={counts} open={open} />
    </div>
  );
});
