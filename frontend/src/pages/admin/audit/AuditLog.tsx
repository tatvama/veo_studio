import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ChevronRight, Download, FilterX, RefreshCw, ScrollText } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { agoT, CopyButton, fmtDateTime } from "../../../components/growth/common";
import { Button, Card, Empty, IconButton, SearchField, Skeleton } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import type { AuditRow } from "../../../lib/types";
import { ChipGroup } from "../shared/ChipGroup";
import { FilterSelect } from "../shared/FilterSelect";
import { MiniAvatar } from "../shared/MiniAvatar";
import { JsonView, flatEntries } from "./JsonView";
import { CATEGORIES, TONE_SOFT, actionLabel, categoryOf, catInfo, csvCell } from "./meta";

import { Pill } from "../shared/Pill";
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

function ActionIcon({ action }: { action: string }) {
  const { icon: Icon, tone } = catInfo(action);
  return <span aria-hidden className={clsx("grid size-8 shrink-0 place-items-center rounded-lg", TONE_SOFT[tone])}><Icon className="size-4" /></span>;
}

/** What changed: readable fields on the left, the raw JSON (with a copy button) on the right. */
function Detail({ row }: { row: AuditRow }) {
  const t = useT();
  const flat = flatEntries(row.detail);
  const json = JSON.stringify(row.detail, null, 2);
  return (
    <div className="grid gap-4 border-t border-line bg-raised/30 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      <div className="min-w-0">
        <h4 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-dim">{t("Summary")}</h4>
        <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-dim">{t("When")}</dt><dd className="text-ink">{fmtDateTime(row.created_at)}</dd>
          <dt className="text-dim">{t("Action")}</dt><dd className="font-mono text-ink">{row.action}</dd>
          {row.user && <><dt className="text-dim">{t("User")}</dt><dd className="truncate text-ink">{row.user.name} · {row.user.email}</dd></>}
          {row.ip && <><dt className="text-dim">{t("IP address")}</dt><dd className="font-mono text-ink">{row.ip}</dd></>}
          {flat.map(([k, v]) => <Fragment key={k}><dt className="truncate text-dim" title={k}>{k}</dt><dd className="break-words text-ink">{v}</dd></Fragment>)}
        </dl>
      </div>
      <div className="relative min-w-0">
        <JsonView value={row.detail} className="max-h-72 overflow-auto rounded-lg border border-line bg-bg p-3 pr-10 font-mono text-2xs leading-relaxed text-mute" />
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
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField value={text} onChange={setText} placeholder={t("Search target, IP, details…")} aria-label={t("Search the audit log")} className="min-w-[220px] flex-1 sm:max-w-sm" />
          <FilterSelect label={t("Action")} value={action} active={!!action} onChange={setAction}>
            <option value="">{t("All")}</option>
            {actions.map((a) => <option key={a} value={a}>{actionLabel(a)}</option>)}
          </FilterSelect>
          <FilterSelect label={t("User")} value={userId} active={!!userId} onChange={setUserId}>
            <option value="">{t("Everyone")}</option>
            <option value="system">{t("System / guest")}</option>
            {users.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </FilterSelect>
          <FilterSelect label={t("Show")} value={String(limit)} onChange={(v) => setLimit(Number(v))}>
            {[300, 1000, 2000].map((n) => <option key={n} value={n}>{t("Last {n}", { n })}</option>)}
          </FilterSelect>
          {filtered && <Button size="sm" variant="ghost" icon={<FilterX className="size-3.5" />} onClick={clear}>{t("Clear filters")}</Button>}
          <div className="ml-auto flex items-center gap-1.5">
            <IconButton title={t("Refresh")} onClick={() => qc.invalidateQueries({ queryKey: ["audit"] })}><RefreshCw className={clsx("size-4", isFetching && "animate-spin")} /></IconButton>
            <Button variant="outline" icon={<Download className="size-4" />} disabled={!shown.length} onClick={downloadCsv}>{t("Export CSV")}</Button>
          </div>
        </div>

        {cats.length > 1 && (
          <ChipGroup label={t("Category")} value={category} onChange={(v) => { setCategory(v); setAction(""); }}
            items={[{ value: "", label: t("All"), icon: ScrollText, count: rows.length },
              ...cats.map(([key, n]) => ({ value: key, label: t(CATEGORIES[key]?.label ?? key), icon: CATEGORIES[key]?.icon ?? ScrollText, count: n }))]} />
        )}
      </div>

      {isLoading ? (
        <Card className="overflow-hidden">
          <div className="space-y-2.5 p-4">{Array.from({ length: 9 }, (_, i) => <Skeleton key={i} className="h-11 w-full" style={{ opacity: 1 - i * 0.08 }} />)}</div>
        </Card>
      ) : isError ? (
        <Empty icon={<ScrollText className="size-8" />} title={t("Couldn't load the audit log")} sub={t("Check your connection and try again.")}
          action={<Button icon={<RefreshCw className="size-4" />} onClick={() => refetch()}>{t("Try again")}</Button>} />
      ) : !rows.length ? (
        <Empty icon={<ScrollText className="size-8" />} title={t("Nothing logged yet")}
          sub={t("Sensitive actions — settings, API keys, users, publishing, consents — are recorded here.")} />
      ) : (
        <Card className="overflow-clip">
          {!shown.length ? (
            <p className="px-4 py-14 text-center text-sm text-dim">{t("No entries match these filters.")}</p>
          ) : wide ? (
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead className="sticky top-0 z-[2]">
                <tr className="text-left text-xs font-medium text-mute [&>th]:border-b [&>th]:border-line [&>th]:bg-panel/95 [&>th]:px-3 [&>th]:py-2.5 [&>th]:backdrop-blur">
                  <th className="w-10" />
                  <th className="w-32">{t("When")}</th>
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
                      <tr onClick={() => toggle(r)} className={clsx("transition-colors [&>td]:border-b [&>td]:border-line/70 [&>td]:px-3 [&>td]:py-2.5", detail && "cursor-pointer", isOpen ? "bg-hover/50" : "hover:bg-hover/30")}>
                        <td className="w-10 pl-3">
                          {detail && (
                            <button type="button" aria-expanded={isOpen} aria-label={isOpen ? t("Hide details") : t("Show details")} onClick={(e) => { e.stopPropagation(); toggle(r); }}
                              className="grid size-7 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink">
                              <ChevronRight className={clsx("size-4 transition-transform duration-200", isOpen && "rotate-90")} />
                            </button>
                          )}
                        </td>
                        <td className="whitespace-nowrap" title={fmtDateTime(r.created_at)}>
                          <span className="block text-ink">{agoT(r.created_at)}</span>
                          <span className="block text-2xs text-dim">{new Date(r.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                        </td>
                        <td>
                          <span className="flex items-center gap-2.5">
                            <ActionIcon action={r.action} />
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{actionLabel(r.action)}</span>
                              <span className="block truncate font-mono text-2xs text-dim">{r.action}</span>
                            </span>
                          </span>
                        </td>
                        <td className="max-w-[240px]"><span className="block truncate" title={r.target}>{r.target || <span className="text-dim">—</span>}</span></td>
                        <td className="whitespace-nowrap">
                          {r.user
                            ? <span className="inline-flex items-center gap-2" title={r.user.email}><MiniAvatar name={r.user.name || r.user.email} size={24} />{r.user.name || r.user.email}</span>
                            : <span className="text-dim">{t("System / guest")}</span>}
                        </td>
                        <td className="hidden whitespace-nowrap font-mono text-xs text-mute lg:table-cell">{r.ip || "—"}</td>
                      </tr>
                      <AnimatePresence initial={false}>
                        {isOpen && (
                          <tr key={`d${r.id}`}>
                            <td colSpan={6} className="border-b border-line/70 p-0">
                              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden"><Detail row={r} /></motion.div>
                            </td>
                          </tr>
                        )}
                      </AnimatePresence>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <ul className="divide-y divide-line">
              {shown.map((r) => {
                const isOpen = open === r.id;
                return (
                  <li key={r.id}>
                    <button type="button" onClick={() => toggle(r)} aria-expanded={hasDetail(r) ? isOpen : undefined} className="flex w-full items-start gap-3 px-4 py-3 text-left">
                      <ActionIcon action={r.action} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{actionLabel(r.action)}</span>
                        {r.target && <span className="block truncate text-xs text-mute">{r.target}</span>}
                        <span className="mt-0.5 block text-2xs text-dim">{agoT(r.created_at)} · {r.user?.name || r.user?.email || t("System / guest")}</span>
                      </span>
                      {hasDetail(r) && <ChevronRight className={clsx("mt-1 size-4 shrink-0 text-dim transition-transform", isOpen && "rotate-90")} />}
                    </button>
                    <AnimatePresence initial={false}>
                      {isOpen && <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="overflow-hidden"><Detail row={r} /></motion.div>}
                    </AnimatePresence>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex items-center justify-between border-t border-line bg-raised/30 px-4 py-2.5 text-xs text-dim">
            <span>{t("Showing {a} of {b} entries", { a: shown.length, b: rows.length })}</span>
            {filtered && <Pill tone="accent">{t("filtered")}</Pill>}
          </div>
        </Card>
      )}
    </div>
  );
}
