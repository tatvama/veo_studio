import { LayoutGrid, SlidersHorizontal, Table2 } from "lucide-react";
import { forwardRef, useEffect, useState, type Ref } from "react";
import { Button, Kbd, SearchField, Segmented, Select } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { activeFilterCount, type CatalogCtl, type Sort } from "./catalogData";
import { TaskStrip } from "./FilterRail";

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
      className="min-w-[220px] max-w-lg flex-1 max-sm:w-full max-sm:min-w-0 max-sm:max-w-none max-sm:basis-full" shortcut={<Kbd>/</Kbd>} />
  );
}

/**
 * The catalog toolbar: search, sort and layout. Below 900px the filter rail folds into a sheet, so this row also carries the
 * "Filters" button and the task chips.
 */
export const FilterBar = forwardRef<HTMLInputElement, {
  ctl: CatalogCtl; counts: Record<string, number | undefined>; railOpen: boolean; onToggleRail: () => void;
}>(function FilterBar({ ctl, counts, railOpen, onToggleRail }, searchRef) {
  const t = useT();
  const { filters, refine, view, sort, update, setView, setSort } = ctl;
  const active = activeFilterCount(filters, refine);
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5">
        <SearchBox value={filters.q} onCommit={(v) => update({ q: v })} inputRef={searchRef} />
        <Button variant="outline" className="min-[900px]:hidden max-sm:h-10" aria-expanded={railOpen} icon={<SlidersHorizontal className="size-4" />} onClick={onToggleRail}>
          {t("Filters")}{active > 0 && <span className="mono grid size-5 place-items-center rounded-md bg-accent text-2xs font-semibold text-black">{active}</span>}
        </Button>
        <label className="ml-auto flex items-center gap-2 text-xs text-dim max-sm:ml-0 max-sm:min-w-0 max-sm:flex-1">
          <span className="eyebrow">{t("Sort")}</span>
          <Select value={sort} aria-label={t("Sort")} onChange={(e) => setSort(e.target.value as Sort)} className="w-auto min-w-0 max-sm:h-10 max-sm:flex-1">
            {(Object.keys(SORT_LABELS) as Sort[]).map((x) => <option key={x} value={x}>{t(SORT_LABELS[x])}</option>)}
          </Select>
        </label>
        <Segmented value={view} onChange={setView} aria-label={t("Layout")} options={[
          { value: "grid", label: <span className="flex h-6 items-center gap-1.5 max-sm:h-8"><LayoutGrid className="size-3.5" /><span className="hidden lg:inline">{t("Cards")}</span></span>, title: t("Cards") },
          { value: "list", label: <span className="flex h-6 items-center gap-1.5 max-sm:h-8"><Table2 className="size-3.5" /><span className="hidden lg:inline">{t("Table")}</span></span>, title: t("Table") },
        ]} />
      </div>
      <TaskStrip value={filters.task} onChange={(v) => update({ task: v })} counts={counts} className="min-[900px]:hidden" />
    </div>
  );
});

