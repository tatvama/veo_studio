import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { isDesktop } from "../../../lib/desktop";
import { useCheckout, useCheckoutHeartbeat, type CutLock } from "../../../lib/finish";
import { useT } from "../../../lib/i18n";
import { ProjectContext, useProjectCtx } from "../context";

/** "since 10:42", or "since 9 Oct, 18:05" when it isn't today. */
export function sinceLabel(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const today = new Date().toDateString() === d.toDateString();
  return today ? time : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

export const clientLabel = (c?: string) => (c === "desktop" ? "desktop" : c === "web" ? "the web" : c || "another app");

/** The slim strip above a read-only cut: who has it, where and since when. */
export function CutLockBanner({ lock, pid }: { lock: CutLock; pid?: number }) {
  const t = useT();
  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-warn/30 bg-warn/10 px-4 py-1.5 text-xs">
      <span className="grid size-5 shrink-0 place-items-center rounded-md bg-warn/20 text-warn"><Lock className="size-3" strokeWidth={2.5} /></span>
      <span className="min-w-0 flex-1 text-ink">
        {t("Checked out by {name} on {client} since {since} — read-only until they check in", {
          name: lock.user?.name ?? t("someone"), client: t(clientLabel(lock.client)), since: sinceLabel(lock.acquired_at),
        })}
        {lock.machine && <span className="mono ml-2 text-2xs text-dim">{lock.machine}</span>}
      </span>
      {pid ? <Link to={`/p/${pid}/finish`} className="shrink-0 font-medium text-accent-ink hover:underline">{t("Pro finishing")}</Link> : null}
    </div>
  );
}

/**
 * Wraps a cut editor (the timeline, the mixer): while someone else has the cut checked out it shows the banner and hands
 * its children a project context with `canEdit: false`, so every edit control turns read-only in one place. On the
 * desktop it also keeps my own checkout alive (heartbeat).
 */
export function CutGuard({ children, link = true }: { children: ReactNode; link?: boolean }) {
  const ctx = useProjectCtx();
  const { lock, lockedByOther } = useCheckout(ctx.eid);
  useCheckoutHeartbeat(ctx.eid, isDesktop && !!lock?.mine);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {lockedByOther && lock && <CutLockBanner lock={lock} pid={link ? ctx.project.id : undefined} />}
      <div className="relative min-h-0 flex-1">
        <ProjectContext.Provider value={lockedByOther ? { ...ctx, canEdit: false } : ctx}>{children}</ProjectContext.Provider>
      </div>
    </div>
  );
}
