import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ChevronRight, Download, FilterX, RefreshCw, ScrollText } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { agoT, CopyButton, fmtDateTime } from "../../../components/growth/common";
import { Button, Empty, IconButton, Metric, Panel, SearchField, Skeleton } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import type { AuditRow } from "../../../lib/types";
import { ChipGroup } from "../shared/ChipGroup";
import { FilterSelect } from "../shared/FilterSelect";
import { MiniAvatar } from "../shared/MiniAvatar";
import { Pill } from "../shared/Pill";
import { JsonView, flatEntries } from "./JsonView";
import { CATEGORIES, actionLabel, categoryOf, catInfo, csvCell } from "./meta";
import "../../../styles/admin.css";
import "../../../styles/console.css";

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

const SENSITIVE = new Set(["settings", "apikey", "integration"]);

const stamp = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
};

/** The action as a toned chip: the category's icon and the readable name. */
function ActionChip({ action }: { action: string }) {
  const t = useT();
  const { icon: Icon, tone, label } = catInfo(action);
  return <Pill tone={tone} title={`${t(label)} · ${action}`}><Icon aria-hidden /><span className="truncate">{actionLabel(action)}</span></Pill>;
}

/** What changed: readable fields on the left, the raw JSON (with a copy button) on the right. */
function Detail({ row }: { row: AuditRow }) {
  const t = useT();
  const flat = flatEntries(row.detail);
  const json = JSON.stringify(row.detail, null, 2);
  return (
    <div className="ad-detail anim-fade grid gap-4 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      <div className="min-w-0">
        <p className="eyebrow mb-2.5">{t("Summary")}</p>
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-dim">{t("When")}</dt><dd className="mono text-ink">{fmtDateTime(row.created_at)}</dd>
          <dt className="text-dim">{t("Action")}</dt><dd className="mono break-all text-ink">{row.action}</dd>
          {row.user && <><dt className="text-dim">{t("User")}</dt><dd className="truncate text-ink">{row.user.name} · <span className="mono">{row.user.email}</span></dd></>}
          {row.ip && <><dt className="text-dim">{t("IP address")}</dt><dd className="mono text-ink">{row.ip}</dd></>}
          {flat.map(([k, v]) => <Fragment key={k}><dt className="mono truncate text-dim" title={k}>{k}</dt><dd className="break-words text-ink">{v}</dd></Fragment>)}
        </dl>
      </div>
      <div className="relative min-w-0">
        <JsonView value={row.detail} className="cx-scroll max-h-72 rounded-lg border border-line bg-bg p-3 pr-10 font-mono text-2xs leading-relaxed text-mute" />
        <div className="absolute right-1.5 top-1.5"><CopyButton size="icon" text={json} what={t("Details")} className="bg-bg/80 backdrop-blur" /></div>
      </div>
    </div>
  );
}

export function AuditLog() {
  const t = useT();
  const qc = useQueryClient();
  const wide = useMedia("(min-width: 768px)");
  const [limit, setLimit] = useState(300);
  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: ["audit", limit],
    queryFn: () => api.get<AuditRow[]>(`/api/audit?limit=${limit}`),
  });
  const [category, setCategory] = useState("");
  const [action, setAction] = useState("");
  const [userId, setUserId] = useState("");
  const [text, setText] = useState("");
  const [open, setOpen] = useState<number | null>(null);

  const rows = data ?? [];
  const cats = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(categoryOf(r.action), (m.get(categoryOf(r.action)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const actions = useMemo(() => [...new Set(rows.filter((r) => !category || categoryOf(r.action) === category).map((r) => r.action))].sort(), [rows, category]);
  const users = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of rows) if (r.user) m.set(r.user.id, r.user.name || r.user.email);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);
  const needle = text.trim().toLowerCase();
  const shown = useMemo(() => rows.filter((r) =>
    (!category || categoryOf(r.action) === category)
    && (!action || r.action === action)
    && (!userId || (userId === "system" ? !r.user : String(r.user?.id) === userId))
    && (!needle || `${r.action} ${actionLabel(r.action)} ${r.target} ${r.ip} ${r.user?.name ?? ""} ${r.user?.email ?? ""} ${JSON.stringify(r.detail ?? {})}`.toLowerCase().includes(needle))),
  [rows, category, action, userId, needle]);
  const filtered = !!(category || action || userId || needle);
  const clear = () => { setCategory(""); setAction(""); setUserId(""); setText(""); };

  // the strip counts what is loaded (the latest N entries)
  const last24h = useMemo(() => rows.filter((r) => Date.now() - new Date(r.created_at).getTime() < 86_400_000).length, [rows]);
  const sensitive = useMemo(() => rows.filter((r) => SENSITIVE.has(categoryOf(r.action))).length, [rows]);
  const hasSystem = rows.some((r) => !r.user);

  const downloadCsv = () => {
    const head = ["time", "action", "target", "user", "email", "ip", "detail"];
    const lines = shown.map((r) => [r.created_at, r.action, r.target, r.user?.name ?? "", r.user?.email ?? "", r.ip, r.detail].map(csvCell).join(","));
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const toggle = (r: AuditRow) => { if (r.detail && Object.keys(r.detail).length) setOpen(open === r.id ? null : r.id); };
  const hasDetail = (r: AuditRow) => !!r.detail && Object.keys(r.detail).length > 0;

  return (
    <div className="space-y-4">
      {/* KPI strip */}
      <Panel flush index={1} bodyClassName="rounded-xl">
        {isLoading ? (
          <div className="ad-kpis" aria-busy="true">
            {Array.from({ length: 4 }, (_, i) => <div key={i}><Skeleton className="h-2.5 w-20" /><Skeleton className="mt-3 h-7 w-16" /></div>)}
          </div>
        ) : (
          <div className="ad-kpis">
            <Metric label={t("Entries loaded")} value={rows.length} sub={<span className="mono">{t("Last {n}", { n: limit })}</span>} />
            <Metric label={t("Last 24 hours")} value={last24h} sub={t("recorded actions")} />
            <Metric label={t("People")} value={users.length} sub={hasSystem ? t("plus system and guests") : t("who made changes")} />
            <Metric label={t("Sensitive changes")} tone={sensitive > 0 ? "warn" : "neutral"} value={sensitive} sub={t("settings, keys, integrations")} />
          </div>
        )}
      </Panel>

      <Panel flush index={2} bodyClassName="overflow-hidden rounded-b-xl" icon={<ScrollText />} eyebrow={t("Log")} title={t("Audit log")}
        actions={(
          <>
            <IconButton title={t("Refresh")} onClick={() => qc.invalidateQueries({ queryKey: ["audit"] })} className="max-sm:size-10"><RefreshCw className={clsx("size-4", isFetching && "animate-spin")} /></IconButton>
            <Button variant="outline" size="sm" icon={<Download className="size-3.5" />} disabled={!shown.length} onClick={downloadCsv} className="max-sm:h-10">{t("Export CSV")}</Button>
          </>
        )}>
        <div className="ad-bar-row mt-3 border-t border-line">
          <SearchField value={text} onChange={setText} placeholder={t("Search target, IP, details…")} aria-label={t("Search the audit log")} className="min-w-[200px] flex-1 sm:max-w-sm [&_input]:h-8 max-sm:[&_input]:h-10" />
          <FilterSelect compact label={t("Action")} value={action} active={!!action} onChange={setAction}>
            <option value="">{t("All")}</option>
            {actions.map((a) => <option key={a} value={a}>{actionLabel(a)}</option>)}
          </FilterSelect>
          <FilterSelect compact label={t("User")} value={userId} active={!!userId} onChange={setUserId}>
            <option value="">{t("Everyone")}</option>
            <option value="system">{t("System / guest")}</option>
            {users.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </FilterSelect>
          <FilterSelect compact label={t("Show")} value={String(limit)} onChange={(v) => setLimit(Number(v))}>
            {[300, 1000, 2000].map((n) => <option key={n} value={n}>{t("Last {n}", { n })}</option>)}
          </FilterSelect>
          {filtered && <Button size="sm" variant="ghost" icon={<FilterX className="size-3.5" />} onClick={clear} className="max-sm:h-10">{t("Clear filters")}</Button>}
        </div>
        {cats.length > 1 && (
          <div className="border-b border-line px-3 py-2">
            <ChipGroup label={t("Category")} value={category} onChange={(v) => { setCategory(v); setAction(""); }}
              items={[{ value: "", label: t("All"), icon: ScrollText, count: rows.length },
                ...cats.map(([key, n]) => ({ value: key, label: t(CATEGORIES[key]?.label ?? key), icon: CATEGORIES[key]?.icon ?? ScrollText, count: n }))]} />
          </div>
        )}

        {isLoading ? (
          <div aria-busy="true" className="space-y-2 p-3">{Array.from({ length: 9 }, (_, i) => <Skeleton key={i} className="h-8 w-full" style={{ opacity: 1 - i * 0.08 }} />)}</div>
        ) : isError ? (
          <div className="p-4"><Empty icon={<ScrollText className="size-8" />} title={t("Couldn't load the audit log")} sub={t("Check your connection and try again.")}
            action={<Button icon={<RefreshCw className="size-4" />} onClick={() => refetch()}>{t("Try again")}</Button>} /></div>
        ) : !rows.length ? (
          <div className="p-4"><Empty icon={<ScrollText className="size-8" />} title={t("Nothing logged yet")}
            sub={t("Sensitive actions — settings, API keys, users, publishing, consents — are recorded here.")} /></div>
        ) : !shown.length ? (
          <p className="px-4 py-14 text-center text-sm text-dim">{t("No entries match these filters.")}</p>
        ) : wide ? (
          <div className="cx-scroll max-h-[min(72vh,46rem)]">
            <table className="cx-table">
              <thead>
                <tr>
                  <th className="w-10"><span className="sr-only">{t("Details")}</span></th>
                  <th>{t("When")}</th>
                  <th>{t("Action")}</th>
                  <th>{t("Target")}</th>
                  <th>{t("User")}</th>
                  <th className="hidden lg:table-cell">{t("IP address")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const isOpen = open === r.id;
                  const detail = hasDetail(r);
                  return (
                    <Fragment key={r.id}>
                      <tr onClick={() => toggle(r)} data-selected={isOpen || undefined} className={clsx(detail && "cursor-pointer")}>
                        <td className="w-10 !pr-0">
                          {detail && (
                            <button type="button" aria-expanded={isOpen} aria-label={isOpen ? t("Hide details") : t("Show details")} onClick={(e) => { e.stopPropagation(); toggle(r); }}
                              className="-my-1 grid size-7 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink">
                              <ChevronRight className={clsx("size-4 transition-transform duration-150", isOpen && "rotate-90")} />
                            </button>
                          )}
                        </td>
                        <td className="whitespace-nowrap" title={fmtDateTime(r.created_at)}>
                          <span className="mono text-xs text-ink">{stamp(r.created_at)}</span>
                          <span className="mono ml-2 text-2xs text-dim">{agoT(r.created_at)}</span>
                        </td>
                        <td className="max-w-[17rem]">
                          <span className="flex min-w-0 items-center gap-2">
                            <ActionChip action={r.action} />
                            <span className="cx-mono hidden truncate 2xl:inline">{r.action}</span>
                          </span>
                        </td>
                        <td className="max-w-[18rem]"><span className="block truncate" title={r.target}>{r.target || <span className="text-dim">—</span>}</span></td>
                        <td className="whitespace-nowrap">
                          {r.user
                            ? <span className="inline-flex items-center gap-2" title={r.user.email}><MiniAvatar name={r.user.name || r.user.email} size={22} />{r.user.name || r.user.email}</span>
                            : <span className="text-dim">{t("System / guest")}</span>}
                        </td>
                        <td className="cx-mono hidden whitespace-nowrap lg:table-cell">{r.ip || "—"}</td>
                      </tr>
                      {isOpen && (
                        <tr key={`d${r.id}`}>
                          <td colSpan={6} className="!h-auto !border-b !p-0"><Detail row={r} /></td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <ul className="max-h-[min(72vh,46rem)] divide-y divide-line overflow-auto overscroll-contain">
            {shown.map((r) => {
              const isOpen = open === r.id;
              return (
                <li key={r.id}>
                  <button type="button" onClick={() => toggle(r)} aria-expanded={hasDetail(r) ? isOpen : undefined} className="flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left">
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center justify-between gap-2"><ActionChip action={r.action} /><span className="mono shrink-0 text-2xs text-dim">{agoT(r.created_at)}</span></span>
                      {r.target && <span className="mt-1.5 block truncate text-xs text-mute">{r.target}</span>}
                      <span className="mt-1 block text-2xs text-dim">{r.user?.name || r.user?.email || t("System / guest")}</span>
                    </span>
                    {hasDetail(r) && <ChevronRight className={clsx("mt-1 size-4 shrink-0 text-dim transition-transform duration-150", isOpen && "rotate-90")} aria-hidden />}
                  </button>
                  {isOpen && <Detail row={r} />}
                </li>
              );
            })}
          </ul>
        )}

        {!!rows.length && (
          <div className="ad-foot">
            <span className="mono">{t("Showing {a} of {b} entries", { a: shown.length, b: rows.length })}</span>
            {filtered && <Pill tone="accent">{t("filtered")}</Pill>}
          </div>
        )}
      </Panel>
    </div>
  );
}
