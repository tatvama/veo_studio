import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowUpRight, Check, CircleCheck, CircleX, Clock, FilterX, FolderOpen, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { agoT, fmtDateTime } from "../../components/growth/common";
import { Alert, Avatar, Badge, Button, Empty, Meter, Metric, Modal, Page, PageHeader, Panel, SearchField, Skeleton } from "../../components/ui";
import { api } from "../../lib/api";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useApprovals, useAuthStatus, useCosts, useUsers } from "../../lib/queries";
import { ROLE_RANK, type Approval, type Role } from "../../lib/types";
import "../../styles/admin.css";
import "../../styles/console.css";
import { ChipGroup } from "./shared/ChipGroup";
import { FilterSelect } from "./shared/FilterSelect";
import { Pill } from "./shared/Pill";

type Status = "pending" | "approved" | "rejected";
type Sort = "newest" | "oldest" | "amount";
type ApprovalRow = Approval & { decided_by?: number | null; decided_at?: string | null };

const DAY = 86_400_000;
/** The animated list (cards leave and the rest slide up) is only used for short lists. */
const ANIMATE_MAX = 40;

function useRoleLabel() {
  const t = useT();
  const labels: Record<Role, string> = { admin: t("Admin"), producer: t("Producer"), creator: t("Creator"), reviewer: t("Reviewer"), viewer: t("Viewer") };
  return (r: Role) => labels[r] ?? r;
}

const whoOf = (a: ApprovalRow) => a.requested_by_user?.name?.trim() || a.requested_by_user?.email || tr("Someone");

/** The request's price against what is left of the team budget: a segmented meter with the words beside it. */
function BudgetFit({ amount, left }: { amount: number; left: number | null }) {
  const t = useT();
  if (left === null) return null;
  const over = amount > left;
  const share = left > 0 ? amount / left : 1;
  const tone = over ? "bad" : share >= 0.5 ? "warn" : "money";
  return (
    <div className="mt-2 space-y-1.5">
      <Meter filled={over ? 10 : Math.max(1, Math.ceil(share * 10))} total={10} tone={tone} className="w-full max-w-[11rem] @min-[760px]:ml-auto" />
      <p className={clsx("flex items-center gap-1 text-2xs @min-[760px]:justify-end", over ? "font-medium text-bad" : "text-dim")}>
        {over && <TriangleAlert className="size-3 shrink-0" aria-hidden />}
        <span className="mono">{over ? t("More than the {usd} left", { usd: usd(left) }) : t("{n}% of the {usd} left", { n: Math.round(share * 100), usd: usd(left) })}</span>
      </p>
    </div>
  );
}

function RequestCard({ a, index, left, onDecide }: {
  a: ApprovalRow; index: number; left: number | null; onDecide: (a: ApprovalRow, approve: boolean) => void;
}) {
  const t = useT();
  const roleLabel = useRoleLabel();
  const who = whoOf(a);
  const stale = Date.now() - new Date(a.created_at).getTime() > DAY;
  const mine = a.can_decide;

  return (
    <Panel flush index={index} tone={mine ? "accent" : undefined}>
      <article className="@container">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-3 p-4 @min-[760px]:grid-cols-[minmax(0,1fr)_13rem_14rem] @min-[760px]:items-center">
          {/* what it is, who asked, how old */}
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {a.project_id ? (
                <Link to={`/p/${a.project_id}/storyboard`} className="group/link -my-1 inline-flex min-w-0 max-w-full items-center gap-1.5 py-1 text-sm font-semibold tracking-tight hover:text-accent-ink">
                  <FolderOpen className="size-4 shrink-0 text-mute" aria-hidden />
                  <span className="truncate">{a.project_title || t("Project #{n}", { n: a.project_id })}</span>
                  <ArrowUpRight className="size-3.5 shrink-0 text-dim transition-transform group-hover/link:-translate-y-px group-hover/link:translate-x-px" aria-hidden />
                </Link>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold tracking-tight"><FolderOpen className="size-4 text-mute" aria-hidden />{t("Shared library")}</span>
              )}
              <span className="mono text-2xs text-dim">#{a.id}</span>
            </div>

            {a.summary && (
              <div>
                <p className="eyebrow">{t("What will be made")}</p>
                <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-sm leading-relaxed" title={a.summary}>{a.summary}</p>
              </div>
            )}

            {a.reason && (
              <p className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/8 px-2.5 py-2 text-xs leading-relaxed">
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" aria-hidden />
                <span className="min-w-0"><span className="font-medium">{t("Why it needs approval:")}</span> <span className="text-mute">{a.reason}</span></span>
              </p>
            )}

            <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-mute">
              <span className="inline-flex items-center gap-1.5"><Avatar name={who} size={20} />{who}</span>
              <Pill tone={stale ? "warn" : "neutral"} title={stale ? `${t("Waiting for more than a day")} · ${fmtDateTime(a.created_at)}` : fmtDateTime(a.created_at)}>
                {stale ? <TriangleAlert aria-hidden /> : <Clock aria-hidden />}<span className="mono">{agoT(a.created_at)}</span>
              </Pill>
              <Badge tone="info" title={t("The lowest role that can decide this request")}>{t("Needs {role}", { role: roleLabel(a.needs_role) })}</Badge>
            </p>
          </div>

          {/* price */}
          <div className="@min-[760px]:text-right">
            <p className="eyebrow">{t("estimated cost")}</p>
            <p className="mono mt-1.5 text-2xl font-medium leading-none tracking-tight text-money">{usd(a.amount_usd)}</p>
            <BudgetFit amount={a.amount_usd} left={left} />
          </div>

          {/* decide */}
          <div className="@min-[760px]:justify-self-end">
            {a.can_decide ? (
              <div className="flex gap-2 @max-[759px]:w-full">
                <Button variant="danger" icon={<X className="size-4" />} className="h-10 flex-1 sm:h-9 @min-[760px]:flex-none" onClick={() => onDecide(a, false)}>{t("Reject")}</Button>
                <Button variant="primary" icon={<Check className="size-4" />} className="h-10 flex-1 sm:h-9 @min-[760px]:flex-none" onClick={() => onDecide(a, true)}>{t("Approve")}</Button>
              </div>
            ) : (
              <p className="max-w-[12rem] text-xs text-mute @min-[760px]:text-right">{t("Waiting for {role} approval.", { role: roleLabel(a.needs_role) })}</p>
            )}
          </div>
        </div>
      </article>
    </Panel>
  );
}

/** Decided requests: a compact data grid. */
function HistoryTable({ rows, status, nameOf }: { rows: ApprovalRow[]; status: Exclude<Status, "pending">; nameOf: (id: number | null | undefined) => string | null }) {
  const t = useT();
  return (
    <Panel flush bodyClassName="overflow-hidden rounded-b-xl" eyebrow={t("History")} icon={status === "approved" ? <CircleCheck /> : <CircleX />} title={status === "approved" ? t("Approved") : t("Rejected")}>
      <div className="cx-scroll mt-3 max-h-[36rem] border-t border-line">
        <table className="cx-table">
          <thead>
            <tr>
              <th className="cx-stick">{t("Decision")}</th><th>{t("Project")}</th><th>{t("Requested by")}</th><th>{t("What will be made")}</th>
              <th className="cx-r">{t("Cost")}</th><th>{t("Requested")}</th><th>{t("Decided")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const by = nameOf(a.decided_by);
              const who = whoOf(a);
              return (
                <tr key={a.id}>
                  <td className="cx-stick">
                    {a.status === "approved"
                      ? <Pill tone="ok"><CircleCheck aria-hidden />{t("Approved")}</Pill>
                      : <Pill tone="bad"><CircleX aria-hidden />{t("Rejected")}</Pill>}
                  </td>
                  <td className="max-w-[13rem]">
                    {a.project_id
                      ? <Link to={`/p/${a.project_id}/storyboard`} className="-my-2 block truncate py-2 font-medium hover:text-accent-ink hover:underline">{a.project_title || t("Project #{n}", { n: a.project_id })}</Link>
                      : <span className="text-mute">{t("Shared library")}</span>}
                  </td>
                  <td className="max-w-[11rem]"><span className="inline-flex min-w-0 items-center gap-1.5"><Avatar name={who} size={20} /><span className="truncate">{who}</span></span></td>
                  <td className="max-w-[18rem]"><span className="block truncate text-mute" title={a.summary}>{a.summary || "—"}</span></td>
                  <td className="cx-r text-money">{usd(a.amount_usd)}</td>
                  <td className="cx-mono whitespace-nowrap" title={fmtDateTime(a.created_at)}>{agoT(a.created_at)}</td>
                  <td className="whitespace-nowrap text-xs text-mute" title={a.decided_at ? fmtDateTime(a.decided_at) : undefined}>
                    {by || a.decided_at ? (
                      <>
                        {by ? (a.status === "approved" ? t("Approved by {name}", { name: by }) : t("Rejected by {name}", { name: by })) : (a.status === "approved" ? t("Approved") : t("Rejected"))}
                        {a.decided_at && <span className="mono text-dim"> · {agoT(a.decided_at)}</span>}
                      </>
                    ) : <span className="text-dim">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function CardSkeleton() {
  return (
    <div aria-hidden className="grid gap-4 rounded-xl border border-line bg-panel p-4 md:grid-cols-[1fr_12rem_9rem]">
      <div className="space-y-2.5"><Skeleton className="h-4 w-2/5" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" /><Skeleton className="h-5 w-3/5" /></div>
      <div className="space-y-2"><Skeleton className="ml-auto h-7 w-24" /><Skeleton className="ml-auto h-1.5 w-40" /></div>
      <div className="flex gap-2 md:justify-end"><Skeleton className="h-9 w-20" /><Skeleton className="h-9 w-24" /></div>
    </div>
  );
}

function KpiSkeleton() {
  return (
    <Panel flush bodyClassName="rounded-xl">
      <div className="ad-kpis" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => <div key={i}><Skeleton className="h-2.5 w-20" /><Skeleton className="mt-3 h-7 w-24" /><Skeleton className="mt-2 h-2.5 w-28" /></div>)}
      </div>
    </Panel>
  );
}

export default function ApprovalsPage() {
  const t = useT();
  const qc = useQueryClient();
  const roleLabel = useRoleLabel();
  const { data: auth } = useAuthStatus();
  const me = auth?.user ?? null;
  const canApprove = me ? ROLE_RANK[me.role] >= ROLE_RANK.producer : false;
  const [tab, setTab] = useState<Status>("pending");
  const pendingQ = useApprovals("pending");
  const approvedQ = useApprovals("approved");
  const rejectedQ = useApprovals("rejected");
  const { data: users } = useUsers();
  const { data: costs } = useCosts();
  const [asking, setAsking] = useState<{ a: ApprovalRow; approve: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [onlyMine, setOnlyMine] = useState(false);

  const active = { pending: pendingQ, approved: approvedQ, rejected: rejectedQ }[tab];
  const all = (active.data ?? []) as ApprovalRow[];
  const nameOf = (id: number | null | undefined): string | null => {
    if (!id) return null;
    const u = users?.find((x) => x.id === id);
    return u ? u.name || u.email.split("@")[0] : null;
  };

  const pending = (pendingQ.data ?? []) as ApprovalRow[];
  const myPending = pending.filter((a) => a.can_decide);
  const sum = (xs: ApprovalRow[]) => xs.reduce((s, a) => s + (a.amount_usd || 0), 0);
  const oldest = pending.reduce<string | null>((o, a) => (!o || a.created_at < o ? a.created_at : o), null);
  const staleCount = pending.filter((a) => Date.now() - new Date(a.created_at).getTime() > DAY).length;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const decidedToday = (xs: ApprovalRow[] | undefined) => (xs ?? []).filter((a) => a.decided_at && new Date(a.decided_at).getTime() >= startOfToday).length;
  const approvedToday = decidedToday(approvedQ.data as ApprovalRow[] | undefined);
  const rejectedToday = decidedToday(rejectedQ.data as ApprovalRow[] | undefined);
  const left = costs?.team && costs.team.cap_usd > 0 ? Math.max(0, costs.team.remaining_usd ?? 0) : null;

  const needle = text.trim().toLowerCase();
  const rows = useMemo(() => {
    const list = all.filter((a) =>
      (!onlyMine || tab !== "pending" || a.can_decide)
      && (!needle || `${a.project_title} ${a.summary} ${a.reason} ${a.requested_by_user?.name ?? ""} ${a.requested_by_user?.email ?? ""}`.toLowerCase().includes(needle)));
    if (sort === "oldest") return [...list].sort((x, y) => x.created_at.localeCompare(y.created_at));
    if (sort === "amount") return [...list].sort((x, y) => (y.amount_usd || 0) - (x.amount_usd || 0));
    return list;
  }, [all, needle, sort, onlyMine, tab]);
  const filtered = !!(needle || (onlyMine && tab === "pending") || sort !== "newest");
  const clear = () => { setText(""); setSort("newest"); setOnlyMine(false); };

  const EMPTY: Record<Status, { title: string; sub: string }> = {
    pending: {
      title: t("Nothing waiting for approval"),
      sub: t("When someone's work would go over a spending limit, it appears here for a producer or admin to approve."),
    },
    approved: { title: t("No approved requests yet"), sub: t("Requests you approve will be listed here.") },
    rejected: { title: t("No rejected requests"), sub: t("Requests that were turned down will be listed here.") },
  };

  const decide = async () => {
    if (!asking) return;
    const { a, approve } = asking;
    setBusy(true);
    setAsking(null);
    // Instant feedback: move the card to its new tab straight away, then confirm with the server (and roll back if it fails).
    const key = (s: string) => ["approvals", s];
    const before = qc.getQueryData<ApprovalRow[]>(key("pending"));
    const to = approve ? "approved" : "rejected";
    qc.setQueryData<ApprovalRow[]>(key("pending"), (old) => old?.filter((x) => x.id !== a.id));
    qc.setQueryData<ApprovalRow[]>(key(to), (old) => old && [{ ...a, status: to, decided_at: new Date().toISOString(), decided_by: me?.id ?? null }, ...old]);
    try {
      await api.post<ApprovalRow>(`/api/approvals/${a.id}/decide`, { approve });
      if (approve) toast.success(tr("Approved {usd}", { usd: usd(a.amount_usd) }), { description: tr("The work has been queued and will start shortly.") });
      else toast.success(tr("Request rejected"), { description: tr("The waiting work was cancelled. Nothing was charged.") });
    } catch {
      if (before) qc.setQueryData(key("pending"), before); // the api helper already showed the error
    } finally {
      setBusy(false);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["approvals"] }),
        qc.invalidateQueries({ queryKey: ["jobs"] }),
        qc.invalidateQueries({ queryKey: ["costs"] }),
        qc.invalidateQueries({ queryKey: ["notifications"] }),
      ]);
    }
  };

  const approving = asking?.approve ?? true;
  const ask = asking?.a;
  const kpisLoading = pendingQ.isLoading;
  const animated = tab === "pending" && rows.length <= ANIMATE_MAX;

  return (
    <Page width="wide">
      <PageHeader
        title={t("Approvals")}
        subtitle={t("Work that would go over a spending limit waits here until a producer or admin says yes.")}
        icon={<ShieldCheck className="size-5" />}
      />

      {!canApprove && (
        <Alert tone="info" icon={<ShieldCheck className="size-4" />} className="mb-4">
          {t("Only producers and admins can approve spending. You can still see what's waiting here.")}
        </Alert>
      )}

      {/* KPI strip */}
      <div className="mb-4">
        {kpisLoading ? <KpiSkeleton /> : (
          <Panel flush index={1} bodyClassName="rounded-xl">
            <div className="ad-kpis">
              <Metric label={t("Waiting")} value={pending.length} sub={canApprove ? t("{n} for you", { n: myPending.length }) : t("for a producer or admin")} />
              <Metric label={t("Money at stake")} tone="money" value={sum(pending)} format={(n) => usd(n)}
                sub={canApprove && myPending.length !== pending.length ? t("{usd} is yours to decide", { usd: usd(sum(myPending)) }) : t("estimated cost")} />
              <Metric label={t("Oldest waiting")} tone={staleCount > 0 ? "warn" : "neutral"} value={oldest ? agoT(oldest) : "—"}
                sub={staleCount > 0 ? <span className="ad-state" data-tone="warn"><TriangleAlert aria-hidden />{t("{n} over a day", { n: staleCount })}</span> : t("nothing overdue")} />
              <Metric label={t("Decided today")} value={approvedToday + rejectedToday}
                sub={<span className="mono">{t("{a} approved · {r} rejected", { a: approvedToday, r: rejectedToday })}</span>} />
            </div>
          </Panel>
        )}
      </div>

      {/* filters */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <ChipGroup label={t("Status")} value={tab} onChange={(v) => setTab(v as Status)} className="min-w-0 max-w-full"
          items={[
            { value: "pending", label: t("Waiting"), count: pendingQ.data?.length, tone: "warn", icon: Clock },
            { value: "approved", label: t("Approved"), count: approvedQ.data?.length, tone: "ok", icon: CircleCheck },
            { value: "rejected", label: t("Rejected"), count: rejectedQ.data?.length, tone: "bad", icon: CircleX },
          ]} />
        <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {canApprove && tab === "pending" && (
            <button type="button" aria-pressed={onlyMine} onClick={() => setOnlyMine((v) => !v)} className="cx-chip">
              {t("I can decide")} <span className="cx-n">{myPending.length}</span>
            </button>
          )}
          <SearchField value={text} onChange={setText} placeholder={t("Search requests…")} aria-label={t("Search requests")} className="min-w-[180px] flex-1 sm:w-56 sm:flex-none [&_input]:h-8 max-sm:[&_input]:h-10" />
          <FilterSelect compact label={t("Sort")} value={sort} active={sort !== "newest"} onChange={(v) => setSort(v as Sort)}>
            <option value="newest">{t("Newest first")}</option>
            <option value="oldest">{t("Oldest first")}</option>
            <option value="amount">{t("Highest cost")}</option>
          </FilterSelect>
          {filtered && <Button size="sm" variant="ghost" icon={<FilterX className="size-3.5" />} onClick={clear} className="max-sm:h-10">{t("Clear filters")}</Button>}
        </div>
      </div>

      <div key={tab}>
        {active.isLoading ? (
          <div aria-busy="true" className="space-y-3">{Array.from({ length: 3 }, (_, i) => <CardSkeleton key={i} />)}</div>
        ) : active.isError ? (
          <Alert tone="bad" title={t("Couldn't load approvals")} action={<Button size="sm" variant="outline" onClick={() => void active.refetch()}>{t("Try again")}</Button>}>
            {t("Check your connection and try again.")}
          </Alert>
        ) : !all.length ? (
          <Empty icon={<ShieldCheck className="size-7" />} title={EMPTY[tab].title} sub={EMPTY[tab].sub} />
        ) : !rows.length ? (
          <Empty icon={<FilterX className="size-7" />} title={t("No requests match these filters.")} action={<Button variant="outline" onClick={clear}>{t("Clear filters")}</Button>} />
        ) : tab === "pending" ? (
          <div className="space-y-3">
            {animated ? (
              <AnimatePresence initial={false} mode="popLayout">
                {rows.map((a, i) => (
                  <motion.div key={a.id} layout="position" exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.18 } }} transition={{ type: "spring", stiffness: 420, damping: 38 }}>
                    <RequestCard a={a} index={i} left={left} onDecide={(x, approve) => setAsking({ a: x, approve })} />
                  </motion.div>
                ))}
              </AnimatePresence>
            ) : rows.map((a) => <RequestCard key={a.id} a={a} index={0} left={left} onDecide={(x, approve) => setAsking({ a: x, approve })} />)}
          </div>
        ) : (
          <HistoryTable rows={rows} status={tab} nameOf={nameOf} />
        )}
      </div>

      <Modal
        open={!!asking}
        onClose={() => setAsking(null)}
        size="sm"
        title={approving ? t("Approve {usd}?", { usd: usd(ask?.amount_usd) }) : t("Reject this request?")}
        footer={(
          <>
            {/* focus lands on the safe choice: Cancel when rejecting, the action itself when approving */}
            <Button variant="ghost" onClick={() => setAsking(null)} data-autofocus={approving ? undefined : ""}>{t("Cancel")}</Button>
            {approving ? (
              <Button variant="primary" icon={<Check className="size-4" />} loading={busy} onClick={() => void decide()} data-autofocus>{t("Approve and start")}</Button>
            ) : (
              <Button variant="danger" icon={<X className="size-4" />} loading={busy} onClick={() => void decide()}>{t("Reject request")}</Button>
            )}
          </>
        )}
      >
        {ask && (
          <div className="space-y-4">
            <div className="cx-block flex items-end justify-between gap-3 px-3 py-3" data-tone="money">
              <div className="min-w-0">
                <p className="eyebrow">{t("Project")}</p>
                <p className="mt-1.5 truncate text-sm font-medium">{ask.project_title || (ask.project_id ? t("Project #{n}", { n: ask.project_id }) : t("Shared library"))}</p>
              </div>
              <span className="mono text-2xl font-medium leading-none text-money">{usd(ask.amount_usd)}</span>
            </div>
            {ask.summary && <p className="cx-block whitespace-pre-line px-3 py-2.5 text-sm leading-relaxed">{ask.summary}</p>}
            <p className="text-sm leading-relaxed text-mute">
              {approving
                ? t("The work will be queued and start shortly. The cost counts against the team budget.")
                : t("Reject this {usd} request? The waiting work will be cancelled and nothing will be charged.", { usd: usd(ask.amount_usd) })}
            </p>
            {approving && <p className="text-2xs text-dim">{t("Needs {role}", { role: roleLabel(ask.needs_role) })}</p>}
          </div>
        )}
      </Modal>
    </Page>
  );
}
