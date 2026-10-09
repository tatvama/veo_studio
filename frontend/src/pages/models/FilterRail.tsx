import { FilterX, LayoutGrid, SlidersHorizontal } from "lucide-react";
import { memo, type ReactNode } from "react";
import { MODES, MODE_LABELS, STATUS_LABELS, TASK_LABELS } from "../../components/hub/util";
import { Button, Panel, ScrollStrip, StatusDot } from "../../components/ui";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { CATALOG_TASKS, providerLabel, type CatalogCtl } from "./catalogData";
import { CAP_DEFS, PRICE_BANDS, SPEED_OPTS, refineActive, type refineFacets } from "./modelMeta";
import { TASK_ICON } from "./ModelCard";

import "../../styles/console.css";
import "../../styles/models.css";

type Counts = Record<string, number | undefined>;
type Mode = "live" | "mock" | "missing";

/** One single-choice row of the rail: [icon] label ........ count. `value` "" is the "all" row. */
function Opt({ on, onPick, label, count, icon, disabled, title }: { on: boolean; onPick: () => void; label: ReactNode; count?: number; icon?: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} disabled={disabled} onClick={onPick} title={title} className="hub-opt">
      {icon}
      <span className="hub-opt-label">{label}</span>
      {count !== undefined && <span className="cx-n">{count.toLocaleString()}</span>}
    </button>
  );
}

function Section({ title, children, note, className }: { title: string; children: ReactNode; note?: ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-1.5", className)}>
      <h3 className="eyebrow px-0.5">{title}</h3>
      {children}
      {note && <p className="px-0.5 text-2xs leading-4 text-dim">{note}</p>}
    </section>
  );
}

/** A multi-select chip (capabilities, price bands, speed tiers). */
function Pick({ on, onToggle, children, count, tone, title, disabled }: {
  on: boolean; onToggle: () => void; children: ReactNode; count?: number; tone?: "money"; title?: string; disabled?: boolean;
}) {
  return (
    <button type="button" aria-pressed={on} data-tone={tone} title={title} disabled={disabled} onClick={onToggle} className="cx-chip disabled:cursor-not-allowed disabled:opacity-40 max-sm:h-10">
      {children}
      {count !== undefined && <span className="cx-n">{count.toLocaleString()}</span>}
    </button>
  );
}

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** The task filter as a horizontal chip strip: the phone version of the first rail section. */
export const TaskStrip = memo(function TaskStrip({ value, onChange, counts, className }: { value: string; onChange: (v: string) => void; counts: Counts; className?: string }) {
  const t = useT();
  const items = [{ value: "", label: t("All"), Icon: LayoutGrid }, ...CATALOG_TASKS.map((k) => ({ value: k as string, label: t(TASK_LABELS[k] ?? k), Icon: TASK_ICON[k] ?? LayoutGrid }))];
  return (
    <ScrollStrip role="radiogroup" aria-label={t("Task")} className={cn("-mx-1 flex gap-1.5 px-1 py-0.5", className)}>
      {items.map(({ value: v, label, Icon }) => {
        const on = value === v;
        const n = counts[v];
        return (
          <button key={v || "all"} type="button" role="radio" aria-checked={on} data-active={on} disabled={n === 0 && !on} onClick={() => onChange(v)}
            className={cn("cx-chip disabled:cursor-not-allowed disabled:opacity-40 max-sm:h-10", on && "is-on")}>
            <Icon aria-hidden />{label}{n !== undefined && <span className="cx-n">{n.toLocaleString()}</span>}
          </button>
        );
      })}
    </ScrollStrip>
  );
});

/**
 * The catalog's filter rail: task, provider, status and input mode (answered by the API, kept in the URL) and capability,
 * price and speed (applied here to the loaded models). Every option shows how many models it would leave.
 */
export const FilterRail = memo(function FilterRail({ ctl, providers, taskCounts, providerCounts, statusCounts, providerModes, facets, partial }: {
  ctl: CatalogCtl; providers: string[]; taskCounts: Counts; providerCounts: Counts; statusCounts: Counts; providerModes: Record<string, Mode | undefined>;
  facets: ReturnType<typeof refineFacets>; partial?: { loaded: number; total: number; loading: boolean; onLoadAll: () => void } | null;
}) {
  const t = useT();
  const { filters, refine, update, updateRefine, clear, filtered } = ctl;
  return (
    <Panel eyebrow={t("Filters")} icon={<SlidersHorizontal />} bodyClassName="space-y-5"
      actions={filtered ? <Button size="sm" variant="ghost" icon={<FilterX className="size-3.5" />} onClick={clear}>{t("Clear all")}</Button> : undefined}>
      <Section title={t("Task")} className="max-[899px]:hidden">
        <div role="radiogroup" aria-label={t("Task")} className="space-y-0.5">
          <Opt on={!filters.task} onPick={() => update({ task: "" })} label={t("All")} count={taskCounts[""]} icon={<LayoutGrid aria-hidden />} />
          {CATALOG_TASKS.map((k) => {
            const Icon = TASK_ICON[k] ?? LayoutGrid;
            const n = taskCounts[k];
            return <Opt key={k} on={filters.task === k} onPick={() => update({ task: k })} label={t(TASK_LABELS[k] ?? k)} count={n} icon={<Icon aria-hidden />} disabled={n === 0 && filters.task !== k} />;
          })}
        </div>
      </Section>

      <Section title={t("Provider")}>
        <div role="radiogroup" aria-label={t("Provider")} className="space-y-0.5">
          <Opt on={!filters.provider} onPick={() => update({ provider: "" })} label={t("All")} count={providerCounts[""]} />
          {providers.map((p) => {
            const mode = providerModes[p];
            const n = providerCounts[p];
            return (
              <Opt key={p} on={filters.provider === p} onPick={() => update({ provider: p })} count={n} disabled={n === 0 && filters.provider !== p}
                title={mode ? `${providerLabel(p)} · ${mode === "live" ? t("Live") : mode === "mock" ? t("Placeholder") : t("No API key")}` : providerLabel(p)}
                label={<span className="flex items-center gap-2"><StatusDot tone={mode === "live" ? "ok" : mode === "mock" ? "warn" : mode === "missing" ? "bad" : "neutral"} />
                  <span className="truncate">{providerLabel(p)}</span>
                  {mode && mode !== "live" && <span className="sr-only">{mode === "mock" ? t("Placeholder") : t("No API key")}</span>}</span>} />
            );
          })}
        </div>
      </Section>

      <Section title={t("Status")}>
        <div role="radiogroup" aria-label={t("Status")} className="space-y-0.5">
          <Opt on={!filters.status} onPick={() => update({ status: "" })} label={t("Any")} />
          {(["new", "enabled", "disabled", "retired"] as const).map((x) => (
            <Opt key={x} on={filters.status === x} onPick={() => update({ status: x })} label={t(STATUS_LABELS[x])} count={statusCounts[x]} />
          ))}
        </div>
      </Section>

      <Section title={t("Mode")}>
        <div role="radiogroup" aria-label={t("Mode")} className="flex flex-wrap gap-1.5">
          <button type="button" role="radio" aria-checked={!filters.mode} onClick={() => update({ mode: "" })} className={cn("cx-chip max-sm:h-10", !filters.mode && "is-on")}>{t("All")}</button>
          {MODES.map((x) => (
            <button key={x} type="button" role="radio" aria-checked={filters.mode === x} title={t(MODE_LABELS[x])} onClick={() => update({ mode: x })}
              className={cn("cx-chip mono max-sm:h-10", filters.mode === x && "is-on")}>{x}</button>
          ))}
        </div>
      </Section>

      <Section title={t("Capabilities")} note={refine.cap.length > 1 ? t("Engines must have all of the selected capabilities.") : undefined}>
        <div role="group" aria-label={t("Capabilities")} className="flex flex-wrap gap-1.5">
          {CAP_DEFS.map((d) => {
            const on = refine.cap.includes(d.key);
            const n = facets.cap[d.key];
            return (
              <Pick key={d.key} on={on} title={t(d.title)} count={n} disabled={n === 0 && !on} onToggle={() => updateRefine({ cap: toggle(refine.cap, d.key) })}>
                <d.icon aria-hidden />{t(d.label)}
              </Pick>
            );
          })}
        </div>
      </Section>

      <Section title={t("Price per 8 s clip")}>
        <div role="group" aria-label={t("Price per 8 s clip")} className="flex flex-wrap gap-1.5">
          {PRICE_BANDS.map((b) => {
            const on = refine.price.includes(b.value);
            const n = facets.price[b.value];
            return <Pick key={b.value} on={on} tone="money" count={n} disabled={n === 0 && !on} onToggle={() => updateRefine({ price: toggle(refine.price, b.value) })}>{t(b.label)}</Pick>;
          })}
        </div>
      </Section>

      <Section title={t("Speed")} note={t("Estimated from the engine's tier: draft is fastest, premium is the best quality.")}>
        <div role="group" aria-label={t("Speed")} className="flex flex-wrap gap-1.5">
          {SPEED_OPTS.map((s) => {
            const on = refine.speed.includes(s.value);
            const n = facets.speed[s.value];
            return <Pick key={s.value} on={on} count={n} disabled={n === 0 && !on} onToggle={() => updateRefine({ speed: toggle(refine.speed, s.value) })}>{t(s.label)}</Pick>;
          })}
        </div>
      </Section>

      {partial && (
        <div className="cx-block space-y-2 p-2.5">
          <p className="text-2xs leading-4 text-mute">
            {refineActive(refine) ? t("Applying these filters to every model — {a} of {b} loaded.", { a: partial.loaded, b: partial.total }) : t("These counts cover the {a} of {b} models loaded so far.", { a: partial.loaded, b: partial.total })}
          </p>
          {!refineActive(refine) && <Button size="sm" variant="outline" loading={partial.loading} onClick={partial.onLoadAll}>{t("Load all")}</Button>}
        </div>
      )}
    </Panel>
  );
});
