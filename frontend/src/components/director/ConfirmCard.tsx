import { clsx } from "clsx";
import { AlertTriangle, Check, X } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { AgentMessage } from "../../lib/types";
import { Button } from "../ui";

export type ConfirmData = NonNullable<AgentMessage["data"]["confirmations"]>[number];

/**
 * Something the Director would do that replaces work you already have (a rewrite, a re-plan): it waits here for
 * "Yes, do it" or "Cancel" instead of happening straight away.
 */
export function ConfirmCard({ item, busy, canEdit, onAnswer }: {
  item: ConfirmData; busy?: "yes" | "no"; canEdit: boolean; onAnswer: (approve: boolean) => void;
}) {
  const t = useT();
  const pending = item.status === "pending";
  const tone = { pending: "border-warn/40 bg-warn/5", done: "border-ok/30 bg-ok/5", declined: "border-line bg-panel", failed: "border-bad/30 bg-bad/5" }[item.status];
  const Icon = item.status === "done" ? Check : item.status === "pending" ? AlertTriangle : X;
  const label = { pending: t("waiting for your OK"), done: t("Done"), declined: t("Cancelled"), failed: t("Failed") }[item.status];
  return (
    <div className={clsx("overflow-hidden rounded-xl border text-sm transition-colors duration-300", tone)}>
      <div className="flex items-start gap-2.5 p-3">
        <span className={clsx("grid size-8 shrink-0 place-items-center rounded-lg",
          item.status === "done" ? "bg-ok/15 text-ok" : pending ? "bg-warn/15 text-warn" : item.status === "failed" ? "bg-bad/15 text-bad" : "bg-raised text-dim")}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className={clsx("font-medium leading-snug", item.status === "declined" && "text-mute line-through decoration-dim/70")}>{item.what}?</p>
          <p className="mt-0.5 text-2xs leading-snug text-mute">{pending ? item.detail : item.result || item.detail}</p>
          <p className="mt-1 inline-flex items-center gap-1 text-2xs text-dim">
            {pending && <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-warn" />}{label}
          </p>
        </div>
      </div>
      {pending && canEdit && (
        <div className="flex gap-2 border-t border-warn/20 px-3 py-2.5">
          <Button size="sm" variant="primary" className="flex-1" icon={<Check className="size-3.5" />} loading={busy === "yes"} disabled={!!busy}
            onClick={() => onAnswer(true)}>{t("Yes, do it")}</Button>
          <Button size="sm" variant="outline" className="flex-1" icon={<X className="size-3.5" />} loading={busy === "no"} disabled={!!busy}
            onClick={() => onAnswer(false)}>{t("Cancel")}</Button>
        </div>
      )}
    </div>
  );
}
