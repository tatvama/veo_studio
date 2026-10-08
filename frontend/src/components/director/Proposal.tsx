import { clsx } from "clsx";
import { Check, Clock, Wallet, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { AgentMessage } from "../../lib/types";
import { AnimatedNumber, Button } from "../ui";

export type ProposalData = NonNullable<AgentMessage["data"]["proposals"]>[number];
/** What happened to a proposal in this session (the server only tells us whether jobs are still waiting). */
export type Decision = "approved" | "rejected" | "escalated";

/** A paid step the Director proposes: what, how many jobs, the price as a chip, and Approve / Reject. */
export function Proposal({ p, decision, busy, canEdit, onApprove, onReject }: {
  p: ProposalData; decision?: Decision; busy?: "approve" | "reject"; canEdit: boolean; onApprove: () => void; onReject: () => void;
}) {
  const t = useT();
  const pending = !!p.pending && !decision;
  const state = pending ? "pending" : decision ?? "done";
  const jobs = p.count === 1 ? t("1 job") : t("{n} jobs", { n: p.count });

  const tone = {
    pending: "border-accent/40 bg-accent/5",
    approved: "border-ok/30 bg-ok/5",
    escalated: "border-warn/30 bg-warn/5",
    rejected: "border-line bg-panel",
    done: "border-line bg-panel",
  }[state];
  const iconTone = {
    pending: "bg-accent/15 text-accent-ink",
    approved: "bg-ok/15 text-ok",
    escalated: "bg-warn/15 text-warn",
    rejected: "bg-raised text-dim",
    done: "bg-raised text-mute",
  }[state];
  const Icon = state === "approved" || state === "done" ? Check : state === "rejected" ? X : state === "escalated" ? Clock : Wallet;
  const label = {
    pending: t("waiting for your OK"),
    approved: t("Approved"),
    escalated: t("Sent to a producer for approval"),
    rejected: t("Rejected"),
    done: t("handled"),
  }[state];

  return (
    <div className={clsx("overflow-hidden rounded-xl border text-sm transition-colors duration-300", tone)}>
      <div className="flex items-start gap-2.5 p-3">
        <span className={clsx("grid size-8 shrink-0 place-items-center rounded-lg transition-colors duration-300", iconTone)}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={state}
              initial={{ scale: 0.5, opacity: 0, rotate: -30 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              exit={{ scale: 0.5, opacity: 0 }}
              transition={{ type: "spring", stiffness: 520, damping: 30 }}
              className="grid place-items-center"
            >
              <Icon className="size-4" />
            </motion.span>
          </AnimatePresence>
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-snug">{p.what}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-2xs text-mute">
            <span>{jobs}</span>
            <span aria-hidden className="text-dim">·</span>
            <span className="inline-flex items-center gap-1">
              {pending && <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-accent" />}
              {label}
            </span>
          </p>
          {p.reason && (pending || state === "escalated") && <p className="mt-1 text-2xs leading-snug text-dim">{p.reason}</p>}
        </div>
        <span
          className={clsx(
            "shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums transition-colors duration-300",
            pending ? "border-accent/30 bg-accent/12 text-accent-ink" : "border-line bg-raised text-mute",
            state === "rejected" && "line-through decoration-dim/70",
          )}
        >
          {pending ? <AnimatedNumber value={p.total_usd} format={(n) => usd(n)} duration={0.6} /> : usd(p.total_usd)}
        </span>
      </div>
      <AnimatePresence initial={false}>
        {pending && canEdit && (
          <motion.div
            key="actions"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="flex gap-2 border-t border-accent/20 px-3 py-2.5">
              <Button size="sm" variant="primary" className="flex-1" icon={<Check className="size-3.5" />} loading={busy === "approve"} disabled={!!busy} onClick={onApprove}>{t("Approve")}</Button>
              <Button size="sm" variant="outline" className="flex-1" icon={<X className="size-3.5" />} loading={busy === "reject"} disabled={!!busy} onClick={onReject}>{t("Reject")}</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
