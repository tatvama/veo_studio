import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowUpRight, Check, CircleCheck, CircleX, Clock, FolderOpen, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { agoT, fmtDateTime } from "../../components/growth/common";
import { AnimatedNumber, Alert, Avatar, Badge, Button, Empty, Modal, Page, PageHeader, Skeleton, Tabs, rise } from "../../components/ui";
import { api } from "../../lib/api";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useApprovals, useAuthStatus, useUsers } from "../../lib/queries";
import { ROLE_RANK, type Approval, type Role } from "../../lib/types";

type Status = "pending" | "approved" | "rejected";
type ApprovalRow = Approval & { decided_by?: number | null; decided_at?: string | null };

const DAY = 86_400_000;

function useRoleLabel() {
  const t = useT();
  const labels: Record<Role, string> = { admin: t("Admin"), producer: t("Producer"), creator: t("Creator"), reviewer: t("Reviewer"), viewer: t("Viewer") };
  return (r: Role) => labels[r] ?? r;
}

function ApprovalCard({ a, index, decidedByName, onDecide }: {
  a: ApprovalRow; index: number; decidedByName: string | null; onDecide: (a: ApprovalRow, approve: boolean) => void;
}) {
  const t = useT();
  const roleLabel = useRoleLabel();
  const r = rise(index);
  const pending = a.status === "pending";
  const who = a.requested_by_user?.name?.trim() || a.requested_by_user?.email || t("Someone");
  const stale = pending && Date.now() - new Date(a.created_at).getTime() > DAY;
  const mine = pending && a.can_decide;
  const stripe = pending ? "bg-warn" : a.status === "approved" ? "bg-ok" : "bg-bad";

  return (
    <div className={r.className} style={r.style}>
      <article className={clsx("relative overflow-hidden rounded-xl border bg-panel shadow-card transition-[border-color,box-shadow] duration-200", mine ? "border-accent/30 hover:shadow-lift" : "border-line")}>
        <span aria-hidden className={clsx("absolute inset-y-0 left-0 w-1", stripe)} />
        <div className="space-y-4 p-4 pl-5 sm:p-5 sm:pl-6">
          {/* who / where / how much */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1.5">
              {a.project_id ? (
                <Link to={`/p/${a.project_id}/storyboard`} className="group/link inline-flex max-w-full items-center gap-1.5 font-semibold tracking-tight hover:text-accent-ink">
                  <FolderOpen className="size-4 shrink-0 text-mute" />
                  <span className="truncate">{a.project_title || t("Project #{n}", { n: a.project_id })}</span>
                  <ArrowUpRight className="size-3.5 shrink-0 text-dim transition-transform group-hover/link:-translate-y-px group-hover/link:translate-x-px" />
                </Link>
              ) : (
                <span className="inline-flex items-center gap-1.5 font-semibold tracking-tight"><FolderOpen className="size-4 text-mute" />{t("Shared library")}</span>
              )}
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mute">
                <span className="inline-flex items-center gap-1.5"><Avatar name={who} size={18} />{who}</span>
                <span aria-hidden className="text-dim">·</span>
                <span className={clsx("inline-flex items-center gap-1", stale && "font-medium text-amber-300")} title={fmtDateTime(a.created_at)}>
                  <Clock className="size-3" />{agoT(a.created_at)}
                </span>
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-2xl font-semibold leading-none tracking-tight tabular-nums">{usd(a.amount_usd)}</p>
              <p className="mt-1.5 text-2xs text-dim">{t("estimated cost")}</p>
            </div>
          </div>

          {a.summary && (
            <div>
              <p className="text-2xs font-semibold uppercase tracking-[0.1em] text-dim">{t("What will be made")}</p>
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed">{a.summary}</p>
            </div>
          )}

          {a.reason && (
            <div className="flex items-start gap-2.5 rounded-lg border border-warn/30 bg-warn/8 px-3 py-2.5 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
              <p className="min-w-0 leading-relaxed"><span className="font-medium">{t("Why it needs approval:")}</span> <span className="text-mute">{a.reason}</span></p>
            </div>
          )}

          {/* status / actions */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-line/70 pt-3.5">
            {pending ? (
              <Badge tone="warn" title={t("The lowest role that can decide this request")}><Clock className="size-3" />{t("Needs {role}", { role: roleLabel(a.needs_role) })}</Badge>
            ) : a.status === "approved" ? (
              <Badge tone="ok"><CircleCheck className="size-3" />{t("Approved")}</Badge>
            ) : (
              <Badge tone="bad"><CircleX className="size-3" />{t("Rejected")}</Badge>
            )}

            {pending ? (
              a.can_decide ? (
                <div className="flex w-full gap-2 sm:w-auto">
                  <Button variant="danger" icon={<X className="size-4" />} className="h-10 flex-1 sm:h-9 sm:flex-none" onClick={() => onDecide(a, false)}>{t("Reject")}</Button>
                  <Button variant="primary" icon={<Check className="size-4" />} className="h-10 flex-1 sm:h-9 sm:flex-none" onClick={() => onDecide(a, true)}>{t("Approve")}</Button>
                </div>
              ) : (
                <p className="text-xs text-mute">{t("Waiting for {role} approval.", { role: roleLabel(a.needs_role) })}</p>
              )
            ) : (decidedByName || a.decided_at) ? (
              <p className="text-xs text-dim">
                {decidedByName
                  ? (a.status === "approved" ? t("Approved by {name}", { name: decidedByName }) : t("Rejected by {name}", { name: decidedByName }))
                  : (a.status === "approved" ? t("Approved") : t("Rejected"))}
                {a.decided_at && <> · {agoT(a.decided_at)}</>}
              </p>
            ) : null}
          </div>
        </div>
      </article>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div aria-hidden className="space-y-4 rounded-xl border border-line bg-panel p-5">
      <div className="flex justify-between gap-6">
        <div className="w-1/2 space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/2" /></div>
        <Skeleton className="h-7 w-20" />
      </div>
      <div className="space-y-2"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" /></div>
      <div className="flex justify-between border-t border-line/70 pt-3.5"><Skeleton className="h-5 w-28" /><Skeleton className="h-9 w-40" /></div>
    </div>
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
  const [asking, setAsking] = useState<{ a: ApprovalRow; approve: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const active = { pending: pendingQ, approved: approvedQ, rejected: rejectedQ }[tab];
  const rows = (active.data ?? []) as ApprovalRow[];
  const nameOf = (id: number | null | undefined): string | null => {
    if (!id) return null;
    const u = users?.find((x) => x.id === id);
    return u ? u.name || u.email.split("@")[0] : null;
  };

  const myPending = (pendingQ.data ?? []).filter((a) => a.can_decide);
  const pendingTotal = myPending.reduce((s, a) => s + (a.amount_usd || 0), 0);
  const oldest = myPending.reduce<string | null>((o, a) => (!o || a.created_at < o ? a.created_at : o), null);

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

  return (
    <Page width="default">
      <PageHeader
        title={t("Approvals")}
        subtitle={t("Work that would go over a spending limit waits here until a producer or admin says yes.")}
        icon={<ShieldCheck className="size-5" />}
      />

      {!canApprove && (
        <Alert tone="info" icon={<ShieldCheck className="size-4" />} className="mb-5">
          {t("Only producers and admins can approve spending. You can still see what's waiting here.")}
        </Alert>
      )}

      <AnimatePresence initial={false}>
        {canApprove && myPending.length > 0 && (
          <motion.div key="summary" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-accent/25 bg-accent/8 px-4 py-3 text-sm">
              <span className="flex items-center gap-2 font-medium">
                <span className="grid size-7 place-items-center rounded-lg bg-accent/15 text-accent-ink"><Clock className="size-4" /></span>
                <span><AnimatedNumber value={myPending.length} duration={0.5} /> {t("waiting for you")}</span>
              </span>
              <span className="text-mute">{t("Total")} <b className="font-semibold text-ink"><AnimatedNumber value={pendingTotal} duration={0.6} format={(n) => usd(n)} /></b></span>
              {oldest && <span className="text-mute">{t("Oldest")} <b className="font-semibold text-ink">{agoT(oldest)}</b></span>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Tabs<Status>
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "pending", label: t("Waiting"), count: pendingQ.data?.length },
          { value: "approved", label: t("Approved"), count: approvedQ.data?.length },
          { value: "rejected", label: t("Rejected"), count: rejectedQ.data?.length },
        ]}
      />

      <div key={tab}>
        {active.isLoading ? (
          <div aria-busy="true" className="space-y-3">{Array.from({ length: 3 }, (_, i) => <CardSkeleton key={i} />)}</div>
        ) : active.isError ? (
          <Alert tone="bad" title={t("Couldn't load approvals")} action={<Button size="sm" variant="outline" onClick={() => void active.refetch()}>{t("Try again")}</Button>}>
            {t("Check your connection and try again.")}
          </Alert>
        ) : !rows.length ? (
          <Empty icon={<ShieldCheck className="size-7" />} title={EMPTY[tab].title} sub={EMPTY[tab].sub} />
        ) : (
          <div className="space-y-3">
            <AnimatePresence initial={false} mode="popLayout">
              {rows.map((a, i) => (
                <motion.div key={a.id} layout="position" exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.18 } }} transition={{ type: "spring", stiffness: 420, damping: 38 }}>
                  <ApprovalCard a={a} index={i} decidedByName={nameOf(a.decided_by)} onDecide={(x, approve) => setAsking({ a: x, approve })} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
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
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-sm text-mute">{ask.project_title || (ask.project_id ? t("Project #{n}", { n: ask.project_id }) : t("Shared library"))}</span>
              <span className="text-2xl font-semibold tabular-nums">{usd(ask.amount_usd)}</span>
            </div>
            {ask.summary && <p className="whitespace-pre-line rounded-lg border border-line bg-raised/50 px-3 py-2.5 text-sm leading-relaxed">{ask.summary}</p>}
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
