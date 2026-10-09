import { useQueries, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { FileCheck, FileText, Plus, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { agoT, fmtDate, fmtDateTime } from "../../../components/growth/common";
import { Avatar, Badge, Button, Empty, Metric, Panel, SearchField, Skeleton } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { useConsents } from "../../../lib/queries";
import type { Character } from "../../../lib/types";
import { ChipGroup } from "../shared/ChipGroup";
import { Pill } from "../shared/Pill";
import { ConsentDetail, ExpiryPill } from "./ConsentDetail";
import { ConsentModal } from "./ConsentModal";
import { CONSENT_KINDS, KIND_ICON, expiry, type ExpiryState } from "./meta";
import "../../../styles/admin.css";
import "../../../styles/console.css";

const STATE_RANK: Record<ExpiryState, number> = { expired: 0, soon: 1, valid: 2, none: 3 };

/** Signed consents as a data grid, most urgent first, with how long each one still runs. A row opens the full record. */
export function Consents({ canAdd }: { canAdd: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useConsents();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<"all" | "valid" | "soon" | "expired">("all");
  const [text, setText] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const rows = data ?? [];
  const charIds = [...new Set(rows.map((c) => c.character_id).filter((x): x is number => !!x))];
  const charQs = useQueries({
    queries: charIds.map((id) => ({
      queryKey: ["character", id],
      queryFn: () => api.get<Character>(`/api/characters/${id}`, { silent: true }),
      staleTime: 5 * 60_000,
    })),
  });
  const charName: Record<number, string> = {};
  charQs.forEach((q, i) => { if (q.data) charName[charIds[i]] = q.data.name; });

  const counts = { valid: 0, soon: 0, expired: 0 };
  for (const c of rows) {
    const s = expiry(c).state;
    if (s === "expired") counts.expired += 1;
    else if (s === "soon") counts.soon += 1;
    else counts.valid += 1;
  }
  const noFile = rows.filter((c) => !c.file_url).length;
  const needle = text.trim().toLowerCase();
  const shown = useMemo(() => rows.filter((c) => {
    const s = expiry(c).state;
    const okFilter = filter === "all" || (filter === "valid" ? s === "valid" || s === "none" : s === filter);
    return okFilter && (!needle || `${c.subject_name} ${c.kind} ${c.scope} ${charName[c.character_id ?? 0] ?? ""}`.toLowerCase().includes(needle));
  }).sort((a, b) => {
    const ea = expiry(a), eb = expiry(b);
    return STATE_RANK[ea.state] - STATE_RANK[eb.state] || ea.days - eb.days;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [rows, filter, needle, charQs.map((q) => q.dataUpdatedAt).join("|")]);
  const opened = rows.find((c) => c.id === openId) ?? null;

  const recordBtn = canAdd ? <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)} className="max-sm:h-10">{t("Record consent")}</Button> : undefined;

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
            <Metric label={t("Records")} value={rows.length} sub={t("signed consents")} />
            <Metric label={t("Valid")} value={counts.valid} sub={t("covered")} />
            <Metric label={t("Expiring soon")} tone={counts.soon > 0 ? "warn" : "neutral"} value={counts.soon}
              sub={counts.soon > 0 ? <span className="ad-state" data-tone="warn"><TriangleAlert aria-hidden />{t("renew soon")}</span> : t("nothing due")} />
            <Metric label={t("Expired")} tone={counts.expired > 0 ? "bad" : "neutral"} value={counts.expired}
              sub={counts.expired > 0 ? <span className="ad-state" data-tone="bad"><TriangleAlert aria-hidden />{t("needs renewal")}</span> : t("none expired")} />
            <Metric label={t("No signed file")} tone={noFile > 0 ? "warn" : "neutral"} value={noFile}
              sub={noFile > 0 ? <span className="ad-state" data-tone="warn"><FileText aria-hidden />{t("upload the release")}</span> : t("all on file")} />
          </div>
        )}
      </Panel>

      <Panel flush index={2} bodyClassName="overflow-hidden rounded-b-xl" icon={<FileCheck />} eyebrow={t("Records")} title={t("Consents")} actions={recordBtn}>
        <div className="ad-bar-row mt-3 border-t border-line">
          <ChipGroup label={t("Status")} value={filter} onChange={(v) => setFilter(v as typeof filter)} className="min-w-0 flex-1"
            items={[
              { value: "all", label: t("All"), count: rows.length },
              { value: "valid", label: t("Valid"), count: counts.valid, tone: "ok" },
              { value: "soon", label: t("Expiring in 30 days"), count: counts.soon, tone: "warn" },
              { value: "expired", label: t("Expired"), count: counts.expired, tone: "bad" },
            ]} />
          <SearchField value={text} onChange={setText} placeholder={t("Search consents…")} aria-label={t("Search consents")} className="w-full sm:w-60 [&_input]:h-8 max-sm:[&_input]:h-10" />
        </div>

        {isLoading ? (
          <div aria-busy="true" className="space-y-2 p-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-8 w-full" style={{ opacity: 1 - i * 0.12 }} />)}</div>
        ) : !rows.length ? (
          <div className="p-4"><Empty icon={<FileCheck className="size-8" />} title={t("No consents recorded")}
            sub={t("Keep a signed release for every real person whose voice or likeness you clone, and for licensed music.")}
            action={canAdd ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t("Record consent")}</Button> : undefined} /></div>
        ) : !shown.length ? (
          <p className="px-4 py-12 text-center text-sm text-dim">{t("No consents match these filters.")}</p>
        ) : (
          <div className="cx-scroll max-h-[min(72vh,46rem)]">
            <table className="cx-table">
              <thead>
                <tr>
                  <th className="cx-stick">{t("Person or rights holder")}</th><th>{t("Type")}</th><th>{t("Character")}</th><th>{t("Scope")}</th>
                  <th>{t("Status")}</th><th>{t("Expires on")}</th><th>{t("Recorded")}</th><th>{t("Signed document")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const e = expiry(c);
                  const Icon = KIND_ICON[c.kind] ?? FileText;
                  return (
                    <tr key={c.id} onClick={() => setOpenId(c.id)} data-selected={openId === c.id || undefined} className="cursor-pointer">
                      <td className="cx-stick max-w-[14rem]">
                        <button type="button" onClick={(ev) => { ev.stopPropagation(); setOpenId(c.id); }} aria-label={t("Consent from {name}", { name: c.subject_name })}
                          className="-my-1.5 flex min-h-8 w-full min-w-0 items-center gap-2 py-1.5 text-left font-medium hover:text-accent-ink max-sm:min-h-10">
                          <Avatar name={c.subject_name} size={22} />
                          <span className="truncate">{c.subject_name}</span>
                        </button>
                      </td>
                      <td className="whitespace-nowrap"><Badge><Icon className="size-3" aria-hidden />{t(CONSENT_KINDS[c.kind] ?? c.kind)}</Badge></td>
                      <td className="max-w-[10rem]">{c.character_id ? <Pill tone="info"><span className="truncate">{charName[c.character_id] ?? `#${c.character_id}`}</span></Pill> : <span className="text-dim">—</span>}</td>
                      <td className="max-w-[12rem]"><span className={clsx("block truncate", c.scope ? "text-mute" : "text-dim")} title={c.scope}>{c.scope || t("No scope written down.")}</span></td>
                      <td><ExpiryPill c={c} /></td>
                      <td className="whitespace-nowrap">
                        {e.state === "none" ? <span className="text-dim">—</span> : (
                          <span className="flex items-center gap-2">
                            <span className="mono text-xs text-ink">{fmtDate(c.expires_on)}</span>
                            <span className={clsx("mono text-2xs", e.state === "expired" || e.state === "soon" ? "ad-tx" : "text-dim")} data-tone={e.state === "expired" ? "bad" : "warn"}>
                              {e.state === "expired" ? t("expired") : t("{n}d left", { n: e.days })}
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="cx-mono whitespace-nowrap" title={fmtDateTime(c.created_at)}>{agoT(c.created_at)}</td>
                      <td className="whitespace-nowrap">
                        {c.file_url ? (
                          <a href={c.file_url} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}
                            className="-my-1.5 inline-flex min-h-8 items-center gap-1.5 py-1.5 text-xs font-medium text-mute hover:text-accent-ink hover:underline max-sm:min-h-10">
                            <FileText className="size-3.5" aria-hidden />{t("View signed file")}
                          </a>
                        ) : <span className="ad-state" data-tone="warn"><TriangleAlert aria-hidden />{t("No signed file")}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!!rows.length && (
          <div className="ad-foot">
            <span className="mono">{t("Showing {a} of {b} entries", { a: shown.length, b: rows.length })}</span>
          </div>
        )}
      </Panel>

      <ConsentDetail consent={opened} charName={opened?.character_id ? charName[opened.character_id] : undefined} onClose={() => setOpenId(null)} />
      {canAdd && <ConsentModal open={adding} onClose={() => setAdding(false)} onSaved={() => { void qc.invalidateQueries({ queryKey: ["consents"] }); void qc.invalidateQueries({ queryKey: ["audit"] }); }} />}
    </div>
  );
}
