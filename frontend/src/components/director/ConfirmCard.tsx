import { clsx } from "clsx";
import { AlertTriangle, Check, X } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { AgentMessage } from "../../lib/types";
import "../../styles/console.css";
import { Button } from "../ui";

export type ConfirmData = NonNullable<AgentMessage["data"]["confirmations"]>[number];

/**
 * Something the Director would do that replaces work you already have (a rewrite, a re-plan): it waits here as an
 * action card for "Yes, do it" or "Cancel" instead of happening straight away.
 */
export function ConfirmCard({ item, busy, canEdit, onAnswer }: {
  item: ConfirmData; busy?: "yes" | "no"; canEdit: boolean; onAnswer: (approve: boolean) => void;
}) {
  const t = useT();
  const pending = item.status === "pending";
  const Icon = item.status === "done" ? Check : item.status === "pending" ? AlertTriangle : X;
  const label = { pending: t("waiting for your OK"), done: t("Done"), declined: t("Cancelled"), failed: t("Failed") }[item.status];
  const tone = { pending: "text-warn", done: "text-ok", declined: "text-dim", failed: "text-bad" }[item.status];
  return (
    <div
      data-tone={item.status === "done" ? "ok" : item.status === "failed" ? "bad" : undefined}
      className={clsx("cx-block hud text-sm transition-colors duration-300", pending && "!border-warn/40")}
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5">
        <p className={clsx("mono flex min-w-0 items-center gap-1.5 text-2xs font-medium uppercase tracking-[0.14em]", tone)}>
          <Icon className="size-3.5 shrink-0" /><span className="truncate">{t("Confirm")}</span>
        </p>
        <span className="mono flex min-w-0 items-center gap-1.5 text-2xs text-mute">
          {pending && <span aria-hidden className="live-dot is-warn shrink-0" />}
          <span className="truncate">{label}</span>
        </span>
      </div>
      <div className="px-3 pb-3 pt-2">
        <p className={clsx("font-medium leading-snug", item.status === "declined" && "text-mute line-through decoration-dim/70")}>{item.what}?</p>
        <p className="mt-1 text-2xs leading-snug text-mute">{pending ? item.detail : item.result || item.detail}</p>
      </div>
      {pending && canEdit && (
        <div className="grid grid-cols-2 gap-2 rounded-b-[0.5625rem] border-t border-line bg-raised/40 px-3 py-2.5">
          <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} loading={busy === "yes"} disabled={!!busy}
            onClick={() => onAnswer(true)}>{t("Yes, do it")}</Button>
          <Button size="sm" variant="outline" icon={<X className="size-3.5" />} loading={busy === "no"} disabled={!!busy}
            onClick={() => onAnswer(false)}>{t("Cancel")}</Button>
        </div>
      )}
    </div>
  );
}
