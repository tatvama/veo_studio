import { clsx } from "clsx";
import { Check, Clock, Wallet, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { AgentMessage } from "../../lib/types";
import "../../styles/console.css";
import { AnimatedNumber, Button } from "../ui";

export type ProposalData = NonNullable<AgentMessage["data"]["proposals"]>[number];
/** What happened to a proposal in this session (the server only tells us whether jobs are still waiting). */
export type Decision = "approved" | "rejected" | "escalated";

/**
 * A paid step the Director proposes, as an "action card": a mono eyebrow with the state, what it is and how many jobs,
 * the price in amber mono on the right, and Approve / Reject underneath while it waits for you.
 */
export function Proposal({ p, decision, busy, canEdit, onApprove, onReject }: {
  p: ProposalData; decision?: Decision; busy?: "approve" | "reject"; canEdit: boolean; onApprove: () => void; onReject: () => void;
}) {
  const t = useT();
  const pending = !!p.pending && !decision;
  const state = pending ? "pending" : decision ?? "done";
  const jobs = p.count === 1 ? t("1 job") : t("{n} jobs", { n: p.count });

  const blockTone = state === "pending" ? "money" : state === "approved" ? "ok" : undefined;
  const eyebrowTone = {
    pending: "text-money", approved: "text-ok", escalated: "text-warn", rejected: "text-dim", done: "text-mute",
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
    <div
      data-tone={blockTone}
      className={clsx("cx-block hud text-sm transition-colors duration-300", state === "escalated" && "!border-warn/35")}
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5">
        <p className={clsx("mono flex min-w-0 items-center gap-1.5 text-2xs font-medium uppercase tracking-[0.14em]", eyebrowTone)}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={state}
              initial={{ scale: 0.5, opacity: 0, rotate: -30 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              exit={{ scale: 0.5, opacity: 0 }}
              transition={{ type: "spring", stiffness: 520, damping: 30 }}
              className="grid shrink-0 place-items-center"
            >
              <Icon className="size-3.5" />
            </motion.span>
          </AnimatePresence>
          <span className="truncate">{t("Proposal")}</span>
        </p>
        <span className="mono flex min-w-0 items-center gap-1.5 text-2xs text-mute">
          {pending && <span aria-hidden className="live-dot is-warn shrink-0" />}
          <span className="truncate">{label}</span>
        </span>
      </div>

      <div className="flex items-start gap-3 px-3 pb-3 pt-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-snug">{p.what}</p>
          <p className="mono mt-1 text-2xs text-dim">{jobs}</p>
          {p.reason && (pending || state === "escalated") && <p className="mt-1.5 text-2xs leading-snug text-dim">{p.reason}</p>}
        </div>
        <div className="shrink-0 text-right">
          <p className="mono text-2xs uppercase tracking-[0.14em] text-dim">{t("Cost")}</p>
          <p className={clsx("mono mt-1 text-lg font-medium leading-none transition-colors duration-300", pending ? "text-money" : "text-mute",
            state === "rejected" && "line-through decoration-dim/70")}>
            {pending ? <AnimatedNumber value={p.total_usd} format={(n) => usd(n)} duration={0.6} /> : usd(p.total_usd)}
          </p>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {pending && canEdit && (
          <motion.div
            key="actions"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden rounded-b-[0.5625rem]"
          >
            <div className="grid grid-cols-2 gap-2 border-t border-line bg-raised/40 px-3 py-2.5">
              <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} loading={busy === "approve"} disabled={!!busy} onClick={onApprove}>{t("Approve")}</Button>
              <Button size="sm" variant="outline" icon={<X className="size-3.5" />} loading={busy === "reject"} disabled={!!busy} onClick={onReject}>{t("Reject")}</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
