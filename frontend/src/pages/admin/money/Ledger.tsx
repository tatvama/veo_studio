import { clsx } from "clsx";
import { FilterX, ReceiptText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { agoT, fmtDateTime } from "../../../components/growth/common";
import { Button, Card, Empty, SearchField, Segmented, Skeleton } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { FilterSelect } from "../shared/FilterSelect";
import { MiniAvatar } from "../shared/MiniAvatar";
import { rich } from "../shared/rich";
import { SERIES, brandMark, brandName } from "../shared/brands";
import { fmtUnits, kindLabel, money, type LedgerRow } from "./data";

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

type Kind = "all" | "paid" | "mock";

/** Every charge, newest first: search, filter by service / type / person / paid-or-mock, sticky header, totals. */
export function Ledger({ rows, loading, projectTitle, userName }: {
  rows: LedgerRow[] | undefined; loading: boolean; projectTitle: Record<number, string>; userName: Record<number, string>;
}) {
  const t = useT();
  const wide = useMedia("(min-width: 768px)");
  const [text, setText] = useState("");
  const [provider, setProvider] = useState("");
  const [kind, setKind] = useState("");
  const [who, setWho] = useState("");
  const [paid, setPaid] = useState<Kind>("all");
  const [limit, setLimit] = useState(60);

  const all = rows ?? [];
  const providers = useMemo(() => [...new Set(all.map((r) => r.provider).filter(Boolean))].sort(), [all]);
  const kinds = useMemo(() => [...new Set(all.map((r) => r.kind).filter(Boolean))].sort((a, b) => kindLabel(a).localeCompare(kindLabel(b))), [all]);
  const people = useMemo(() => [...new Set(all.map((r) => r.user_id).filter((x): x is number => !!x))], [all]);
  const mockCount = all.filter((r) => r.mock).length;
  const filtered = !!(text || provider || kind || who || paid !== "all");
  const needle = text.trim().toLowerCase();

  const shown = useMemo(() => all.filter((r) =>
    (!provider || r.provider === provider)
    && (!kind || r.kind === kind)
    && (!who || (who === "system" ? !r.user_id : String(r.user_id) === who))
    && (paid === "all" || (paid === "mock" ? r.mock : !r.mock))
    && (!needle || `${r.model} ${kindLabel(r.kind)} ${brandName(r.provider)} ${r.project_id ? projectTitle[r.project_id] ?? "" : ""} ${r.user_id ? userName[r.user_id] ?? "" : "system"}`.toLowerCase().includes(needle))),
  [all, provider, kind, who, paid, needle, projectTitle, userName]);
  useEffect(() => setLimit(60), [provider, kind, who, paid, needle]);
  const visible = shown.slice(0, limit);
  const total = shown.reduce((n, r) => n + r.usd, 0);
  const clear = () => { setText(""); setProvider(""); setKind(""); setWho(""); setPaid("all"); };

  if (loading) {
    return (
      <Card className="overflow-hidden">
        <div className="space-y-3 p-4">
          <Skeleton className="h-9 w-full" />
          {Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-9 w-full" style={{ opacity: 1 - i * 0.1 }} />)}
        </div>
      </Card>
    );
  }
  if (!all.length) {
    return <Empty icon={<ReceiptText className="size-8" />} title={t("No charges yet")} sub={t("Every image, video, voice and lip-sync you generate will show up here with its cost.")} />;
  }

  const serviceChip = (r: LedgerRow) => {
    const idx = Math.max(0, providers.indexOf(r.provider)) % SERIES.length;
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span aria-hidden className={clsx("grid size-5 shrink-0 place-items-center rounded-md text-2xs font-semibold uppercase", SERIES[idx].soft)}>{brandMark(r.provider)}</span>
        <span className="truncate">{brandName(r.provider)}</span>
      </span>
    );
  };
  const personCell = (r: LedgerRow) => r.user_id
    ? <span className="inline-flex min-w-0 items-center gap-1.5"><MiniAvatar name={userName[r.user_id] ?? `#${r.user_id}`} size={22} /><span className="truncate">{userName[r.user_id] ?? `#${r.user_id}`}</span></span>
    : <span className="text-dim">{t("System")}</span>;
  const projectCell = (r: LedgerRow) => r.project_id
    ? <Link to={`/p/${r.project_id}/storyboard`} className="-my-1.5 truncate py-1.5 hover:text-accent-ink hover:underline">{projectTitle[r.project_id] ?? t("Project #{n}", { n: r.project_id })}</Link>
    : <span className="text-dim">—</span>;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <SearchField value={text} onChange={setText} placeholder={t("Search model, project, person…")} aria-label={t("Search charges")} className="min-w-[200px] flex-1 sm:max-w-xs" />
        <FilterSelect label={t("Service")} value={provider} active={!!provider} onChange={setProvider}>
          <option value="">{t("All")}</option>
          {providers.map((p) => <option key={p} value={p}>{brandName(p)}</option>)}
        </FilterSelect>
        <FilterSelect label={t("Type")} value={kind} active={!!kind} onChange={setKind}>
          <option value="">{t("All")}</option>
          {kinds.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
        </FilterSelect>
        <FilterSelect label={t("Who")} value={who} active={!!who} onChange={setWho}>
          <option value="">{t("Everyone")}</option>
          <option value="system">{t("System")}</option>
          {people.map((id) => <option key={id} value={String(id)}>{userName[id] ?? `#${id}`}</option>)}
        </FilterSelect>
        {mockCount > 0 && (
          <Segmented value={paid} onChange={setPaid} aria-label={t("Charge kind")} options={[
            { value: "all", label: t("All") }, { value: "paid", label: t("Paid") }, { value: "mock", label: t("Mock"), title: t("Free placeholder output — no real charge") },
          ]} />
        )}
        {filtered && <Button size="sm" variant="ghost" icon={<FilterX className="size-3.5" />} onClick={clear}>{t("Clear filters")}</Button>}
      </div>

      {!shown.length ? (
        <p className="px-4 py-12 text-center text-sm text-dim">{t("No charges match these filters.")}</p>
      ) : wide ? (
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full min-w-[860px] border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-[1]">
              <tr className="text-left text-xs font-medium text-mute [&>th]:border-b [&>th]:border-line [&>th]:bg-panel [&>th]:px-4 [&>th]:py-2.5">
                <th>{t("When")}</th><th>{t("Service")}</th><th>{t("Type")}</th><th>{t("Model")}</th><th>{t("Project")}</th><th>{t("Who")}</th>
                <th className="text-right">{t("Amount")}</th><th className="text-right">{t("Cost")}</th>
              </tr>
            </thead>
            <tbody className="[&>tr>td]:border-b [&>tr>td]:border-line/70 [&>tr>td]:px-4 [&>tr>td]:py-2.5 [&>tr:last-child>td]:border-0">
              {visible.map((r) => (
                <tr key={r.id} className={clsx("transition-colors hover:bg-hover/50", r.mock && "text-mute")}>
                  <td className="whitespace-nowrap text-mute" title={fmtDateTime(r.created_at)}>{agoT(r.created_at)}</td>
                  <td className="max-w-[160px]">{serviceChip(r)}</td>
                  <td className="whitespace-nowrap">{kindLabel(r.kind)}</td>
                  <td className="max-w-[200px] truncate font-mono text-xs" title={r.model}>{r.model || "—"}</td>
                  <td className="max-w-[170px]"><div className="flex min-w-0">{projectCell(r)}</div></td>
                  <td className="max-w-[150px]">{personCell(r)}</td>
                  <td className="whitespace-nowrap text-right tabular-nums text-mute">{fmtUnits(r.units, r.unit_type)}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">
                    <span className="inline-flex items-center justify-end gap-1.5">
                      {r.mock && <Pill tone="info" title={t("Free placeholder output — no real charge")}>{t("mock")}</Pill>}
                      <span className={clsx(r.usd > 0 && "font-medium")}>{money(r.usd)}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {visible.map((r) => (
            <li key={r.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{kindLabel(r.kind)}</p>
                  <p className="mt-0.5 text-xs text-mute">{serviceChip(r)}</p>
                </div>
                <div className="shrink-0 text-right text-sm tabular-nums">
                  <p className="inline-flex items-center gap-1.5">{r.mock && <Pill tone="info">{t("mock")}</Pill>}<span className="font-medium">{money(r.usd)}</span></p>
                  <p className="text-xs text-dim">{fmtUnits(r.units, r.unit_type)}</p>
                </div>
              </div>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-dim">
                <span title={fmtDateTime(r.created_at)}>{agoT(r.created_at)}</span>
                {r.project_id ? <span>· {projectTitle[r.project_id] ?? t("Project #{n}", { n: r.project_id })}</span> : null}
                <span>· {r.user_id ? userName[r.user_id] ?? `#${r.user_id}` : t("System")}</span>
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-raised/30 px-4 py-2.5 text-xs text-mute">
        <span>
          {t("Showing {a} of {b} charges", { a: visible.length, b: shown.length })}
          {mockCount > 0 && <> · {rich(t("{badge} rows were free placeholders."), { badge: <Pill tone="info">{t("mock")}</Pill> })}</>}
        </span>
        <span className="flex items-center gap-3">
          {visible.length < shown.length && <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + 60)}>{t("Show more")}</Button>}
          <span className="tabular-nums">{rich(t("Total: {amount}"), { amount: <b className="font-semibold text-ink">{money(total)}</b> })}</span>
        </span>
      </div>
    </Card>
  );
}
