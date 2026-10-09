import { BarChart3, ChevronRight, FolderKanban, Gauge, Users } from "lucide-react";
import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { Empty, Panel, Segmented } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { MiniAvatar } from "../shared/MiniAvatar";
import { SERIES, brandMark, brandName } from "../shared/brands";
import { kindLabel, money, type CostSummary, type ServiceRow } from "./data";
import "../../../styles/admin.css";
import "../../../styles/console.css";

/** Share of the total as a hairline bar plus a mono percentage. */
function Share({ share, color = "var(--color-money)" }: { share: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, share));
  return (
    <div className="flex min-w-[7.5rem] items-center gap-2">
      <span className="ad-bar flex-1" style={{ ["--p" as string]: `${pct * 100}%`, ["--c" as string]: color }}><i /></span>
      <span className="mono w-9 shrink-0 text-right text-2xs text-dim">{Math.round(pct * 100)}%</span>
    </div>
  );
}

const NothingYet = () => {
  const t = useT();
  return <p className="px-4 py-10 text-center text-sm text-dim">{t("Nothing spent yet this month.")}</p>;
};

/** Spend by service: a data grid, one row per service that opens into the kinds of work it did. */
export function ServicesPanel({ services, total, className, index }: { services: ServiceRow[]; total: number; className?: string; index?: number }) {
  const t = useT();
  const [metricPick, setMetricPick] = useState<"spend" | "calls" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const metric = metricPick ?? (total > 0 ? "spend" : "calls");
  const of = (s: { usd: number; count: number }) => (metric === "spend" ? s.usd : s.count);
  const sum = services.reduce((n, s) => n + of(s), 0);
  const calls = (n: number) => n.toLocaleString();

  return (
    <Panel flush bodyClassName="overflow-hidden rounded-b-xl" index={index} className={className} icon={<BarChart3 />} eyebrow={t("Breakdown")} title={t("Spend by service")}
      actions={services.length > 0 ? (
        <Segmented size="sm" value={metric} onChange={setMetricPick} aria-label={t("Measure")} options={[
          { value: "spend", label: t("Spend") }, { value: "calls", label: t("Calls") },
        ]} />
      ) : undefined}>
      {!services.length ? (
        <div className="p-4 pt-3"><Empty icon={<Gauge className="size-7" />} title={t("Nothing spent yet this month.")} sub={t("Spending shows up here as soon as the team generates something.")} /></div>
      ) : (
        <div className="cx-scroll mt-3 max-h-[28rem] border-t border-line">
          <table className="cx-table">
            <thead>
              <tr>
                <th className="cx-stick">{t("Service")}</th>
                <th className="cx-r">{t("Calls")}</th>
                <th className="cx-r">{t("Spend")}</th>
                <th>{t("Share")}</th>
              </tr>
            </thead>
            <tbody>
              {services.map((s, i) => {
                const tone = SERIES[i % SERIES.length];
                const isOpen = open === s.provider;
                const kmax = Math.max(1, ...s.kinds.map(of));
                return (
                  <Fragment key={s.provider}>
                    <tr>
                      <td className="cx-stick">
                        <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : s.provider)}
                          className="-my-1.5 flex min-h-8 w-full items-center gap-2 rounded-md py-1.5 text-left font-medium max-sm:min-h-10">
                          <ChevronRight aria-hidden className={`size-3.5 shrink-0 text-dim transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`} />
                          <span aria-hidden className={`mono grid size-6 shrink-0 place-items-center rounded-md text-2xs font-semibold uppercase ${tone.soft}`}>{brandMark(s.provider)}</span>
                          <span className="truncate">{brandName(s.provider)}</span>
                        </button>
                      </td>
                      <td className="cx-r text-mute">{calls(s.count)}</td>
                      <td className="cx-r text-money">{money(s.usd)}</td>
                      <td><Share share={sum > 0 ? of(s) / sum : 0} color={tone.stroke} /></td>
                    </tr>
                    {isOpen && s.kinds.map((k) => (
                      <tr key={`${s.provider}:${k.kind}`} className="anim-fade">
                        <td className="cx-stick !pl-[3.25rem] text-xs text-mute">{k.kind === "llm" ? t("Writing") : kindLabel(k.kind)}</td>
                        <td className="cx-r text-xs text-mute">{calls(k.count)}</td>
                        <td className="cx-r text-xs text-money">{money(k.usd)}</td>
                        <td><Share share={of(k) / kmax} color={tone.stroke} /></td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** Spend by project (each links to its storyboard). */
export function ProjectsPanel({ rows, total, className, index }: { rows: CostSummary["by_project"]; total: number; className?: string; index?: number }) {
  const t = useT();
  return (
    <Panel flush bodyClassName="overflow-hidden rounded-b-xl" index={index} className={className} icon={<FolderKanban />} eyebrow={t("Breakdown")} title={t("By project")}>
      {!rows.length ? <NothingYet /> : (
        <div className="cx-scroll mt-3 max-h-[19rem] border-t border-line">
          <table className="cx-table is-dense">
            <thead><tr><th className="cx-stick">{t("Project")}</th><th className="cx-r">{t("Spend")}</th><th>{t("Share")}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.project_id ?? "none"}>
                  <td className="cx-stick max-w-[14rem]">
                    {r.project_id
                      ? <Link to={`/p/${r.project_id}/storyboard`} className="-my-2 block truncate py-2 font-medium hover:text-accent-ink hover:underline">{r.title}</Link>
                      : <span className="block truncate text-mute">{t("Not in a project (library, previews)")}</span>}
                  </td>
                  <td className="cx-r text-money">{money(r.usd)}</td>
                  <td><Share share={total > 0 ? r.usd / total : 0} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** Spend by person (the system's automatic work is its own row). */
export function PeoplePanel({ rows, total, meId, className, index }: { rows: CostSummary["by_user"]; total: number; meId?: number; className?: string; index?: number }) {
  const t = useT();
  return (
    <Panel flush bodyClassName="overflow-hidden rounded-b-xl" index={index} className={className} icon={<Users />} eyebrow={t("Breakdown")} title={t("By person")}>
      {!rows.length ? <NothingYet /> : (
        <div className="cx-scroll mt-3 max-h-[19rem] border-t border-line">
          <table className="cx-table is-dense">
            <thead><tr><th className="cx-stick">{t("Person")}</th><th className="cx-r">{t("Spend")}</th><th>{t("Share")}</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.user?.id ?? `sys-${i}`}>
                  <td className="cx-stick max-w-[14rem]">
                    {r.user ? (
                      <span className="flex min-w-0 items-center gap-2">
                        <MiniAvatar name={r.user.name || r.user.email} size={22} />
                        <span className="truncate font-medium">{r.user.name || r.user.email}</span>
                        {r.user.id === meId && <span className="shrink-0 text-xs text-dim">{t("(you)")}</span>}
                      </span>
                    ) : <span className="text-mute">{t("Automatic (system)")}</span>}
                  </td>
                  <td className="cx-r text-money">{money(r.usd)}</td>
                  <td><Share share={total > 0 ? r.usd / total : 0} color="var(--color-info)" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
