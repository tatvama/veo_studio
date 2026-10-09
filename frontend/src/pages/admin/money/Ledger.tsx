import { clsx } from "clsx";
import { FilterX, ReceiptText, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { agoT, fmtDateTime } from "../../../components/growth/common";
import { Button, Empty, Panel, SearchField, Skeleton } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { ChipGroup } from "../shared/ChipGroup";
import { FilterSelect } from "../shared/FilterSelect";
import { MiniAvatar } from "../shared/MiniAvatar";
import { Pill } from "../shared/Pill";
import { rich } from "../shared/rich";
import { SERIES, brandMark, brandName } from "../shared/brands";
import { fmtUnits, kindLabel, money, type LedgerRow } from "./data";
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

type Kind = "all" | "paid" | "mock";

/** Every charge, newest first: search, filter by service / type / person / paid-or-mock, sticky header, totals. */
export function Ledger({ rows, loading, projectTitle, userName, error, onRetry, className, index }: {
  rows: LedgerRow[] | undefined; loading: boolean; projectTitle: Record<number, string>; userName: Record<number, string>;
  error?: boolean; onRetry?: () => void; className?: string; index?: number;
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

  const frame = { index, className, bodyClassName: "overflow-hidden rounded-b-xl", icon: <ReceiptText />, eyebrow: t("Ledger"), title: t("Every charge") };

  if (loading) {
    return (
      <Panel flush {...frame}>
        <div aria-busy="true" className="mt-3 space-y-2 border-t border-line p-3">
          <Skeleton className="h-8 w-full" />
          {Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-8 w-full" style={{ opacity: 1 - i * 0.1 }} />)}
        </div>
      </Panel>
    );
  }
  if (error && !all.length) {
    return (
      <Panel flush {...frame}>
        <div className="p-4 pt-3">
          <Empty icon={<ReceiptText className="size-7" />} title={t("Couldn't load the charges")} sub={t("Check your connection and try again.")}
            action={onRetry ? <Button icon={<RefreshCw className="size-4" />} onClick={onRetry}>{t("Try again")}</Button> : undefined} />
        </div>
      </Panel>
    );
  }
  if (!all.length) {
    return (
      <Panel flush {...frame}>
        <div className="p-4 pt-3"><Empty icon={<ReceiptText className="size-8" />} title={t("No charges yet")} sub={t("Every image, video, voice and lip-sync you generate will show up here with its cost.")} /></div>
      </Panel>
    );
  }

  const serviceChip = (r: LedgerRow) => {
    const idx = Math.max(0, providers.indexOf(r.provider)) % SERIES.length;
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span aria-hidden className={clsx("mono grid size-5 shrink-0 place-items-center rounded-md text-2xs font-semibold uppercase", SERIES[idx].soft)}>{brandMark(r.provider)}</span>
        <span className="truncate">{brandName(r.provider)}</span>
      </span>
    );
  };
  const personCell = (r: LedgerRow) => r.user_id
    ? <span className="inline-flex min-w-0 items-center gap-1.5"><MiniAvatar name={userName[r.user_id] ?? `#${r.user_id}`} size={20} /><span className="truncate">{userName[r.user_id] ?? `#${r.user_id}`}</span></span>
    : <span className="text-dim">{t("System")}</span>;
  const projectCell = (r: LedgerRow) => r.project_id
    ? <Link to={`/p/${r.project_id}/storyboard`} className="-my-2 truncate py-2 hover:text-accent-ink hover:underline">{projectTitle[r.project_id] ?? t("Project #{n}", { n: r.project_id })}</Link>
    : <span className="text-dim">—</span>;

  return (
    <Panel flush {...frame} actions={<span className="hidden text-2xs text-dim sm:inline">{t("The latest 200 charges, newest first.")}</span>}>
      <div className="ad-bar-row mt-3 border-t border-line">
        <SearchField value={text} onChange={setText} placeholder={t("Search model, project, person…")} aria-label={t("Search charges")} className="min-w-[200px] flex-1 sm:max-w-xs [&_input]:h-8 max-sm:[&_input]:h-10" />
        <FilterSelect compact label={t("Service")} value={provider} active={!!provider} onChange={setProvider}>
          <option value="">{t("All")}</option>
          {providers.map((p) => <option key={p} value={p}>{brandName(p)}</option>)}
        </FilterSelect>
        <FilterSelect compact label={t("Type")} value={kind} active={!!kind} onChange={setKind}>
          <option value="">{t("All")}</option>
          {kinds.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
        </FilterSelect>
        <FilterSelect compact label={t("Who")} value={who} active={!!who} onChange={setWho}>
          <option value="">{t("Everyone")}</option>
          <option value="system">{t("System")}</option>
          {people.map((id) => <option key={id} value={String(id)}>{userName[id] ?? `#${id}`}</option>)}
        </FilterSelect>
        {mockCount > 0 && (
          <ChipGroup label={t("Charge kind")} value={paid} onChange={(v) => setPaid(v as Kind)} items={[
            { value: "all", label: t("All"), count: all.length },
            { value: "paid", label: t("Paid"), count: all.length - mockCount, tone: "money" },
            { value: "mock", label: t("Mock"), count: mockCount, title: t("Free placeholder output — no real charge") },
          ]} />
        )}
        {filtered && <Button size="sm" variant="ghost" icon={<FilterX className="size-3.5" />} onClick={clear} className="max-sm:h-10">{t("Clear filters")}</Button>}
      </div>

      {!shown.length ? (
        <p className="px-4 py-12 text-center text-sm text-dim">{t("No charges match these filters.")}</p>
      ) : wide ? (
        <div className="cx-scroll max-h-[34rem]">
          <table className="cx-table">
            <thead>
              <tr>
                <th>{t("When")}</th><th>{t("Service")}</th><th>{t("Type")}</th><th>{t("Model")}</th><th>{t("Project")}</th><th>{t("Who")}</th>
                <th className="cx-r">{t("Amount")}</th><th className="cx-r">{t("Cost")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className={clsx(r.mock && "text-mute")}>
                  <td className="cx-mono whitespace-nowrap" title={fmtDateTime(r.created_at)}>{agoT(r.created_at)}</td>
                  <td className="max-w-[10rem]">{serviceChip(r)}</td>
                  <td className="whitespace-nowrap">{kindLabel(r.kind)}</td>
                  <td className="cx-mono max-w-[12rem] truncate" title={r.model}>{r.model || "—"}</td>
                  <td className="max-w-[11rem]"><div className="flex min-w-0">{projectCell(r)}</div></td>
                  <td className="max-w-[9.5rem]">{personCell(r)}</td>
                  <td className="cx-r text-mute">{fmtUnits(r.units, r.unit_type)}</td>
                  <td className="cx-r">
                    <span className="inline-flex items-center justify-end gap-1.5">
                      {r.mock && <Pill tone="info" title={t("Free placeholder output — no real charge")}>{t("mock")}</Pill>}
                      <span className={clsx(r.usd > 0 ? "text-money" : "text-dim")}>{money(r.usd)}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="max-h-[34rem] divide-y divide-line overflow-auto overscroll-contain">
          {visible.map((r) => (
            <li key={r.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{kindLabel(r.kind)}</p>
                  <p className="mt-0.5 text-xs text-mute">{serviceChip(r)}</p>
                </div>
                <div className="mono shrink-0 text-right text-sm">
                  <p className="inline-flex items-center gap-1.5">{r.mock && <Pill tone="info">{t("mock")}</Pill>}<span className={r.usd > 0 ? "text-money" : "text-dim"}>{money(r.usd)}</span></p>
                  <p className="text-xs text-dim">{fmtUnits(r.units, r.unit_type)}</p>
                </div>
              </div>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-dim">
                <span className="mono" title={fmtDateTime(r.created_at)}>{agoT(r.created_at)}</span>
                {r.project_id ? <span>· {projectTitle[r.project_id] ?? t("Project #{n}", { n: r.project_id })}</span> : null}
                <span>· {r.user_id ? userName[r.user_id] ?? `#${r.user_id}` : t("System")}</span>
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="ad-foot">
        <span>
          <span className="mono">{t("Showing {a} of {b} charges", { a: visible.length, b: shown.length })}</span>
          {mockCount > 0 && <> · {rich(t("{badge} rows were free placeholders."), { badge: <Pill tone="info">{t("mock")}</Pill> })}</>}
        </span>
        <span className="flex items-center gap-3">
          {visible.length < shown.length && <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + 60)} className="max-sm:h-10">{t("Show more")}</Button>}
          <span className="mono">{rich(t("Total: {amount}"), { amount: <b className="font-semibold text-money">{money(total)}</b> })}</span>
        </span>
      </div>
    </Panel>
  );
}
