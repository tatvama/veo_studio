import { clsx } from "clsx";
import { ArrowUpRight, CircleCheck, Coins, MessageSquare, ShieldAlert } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useProjects } from "../../lib/queries";
import type { Approval, Notification, Role } from "../../lib/types";
import { agoT } from "../growth/common";
import { Badge, Button, Panel, Skeleton } from "../ui";
import { useAttention } from "./useAttention";

const MAX = 6;

type Item =
  | { kind: "approval"; at: string; a: Approval }
  | { kind: "note"; at: string; n: Notification };

function Row({ icon, tone, to, children, meta, aside }: {
  icon: ReactNode; tone: "warn" | "bad" | "accent"; to?: string; children: ReactNode; meta: ReactNode; aside?: ReactNode;
}) {
  const chip = { warn: "bg-warn/12 text-warn ring-warn/25", bad: "bg-bad/12 text-bad ring-bad/25", accent: "bg-accent/12 text-accent-ink ring-accent/25" }[tone];
  const inner = (
    <>
      <span aria-hidden className={clsx("mt-0.5 grid size-7 shrink-0 place-items-center rounded-md ring-1 ring-inset [&>svg]:size-3.5", chip)}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm leading-snug">{children}</span>
        <span className="mt-0.5 block text-2xs text-dim">{meta}</span>
      </span>
      {aside}
    </>
  );
  const cls = "flex items-start gap-3 px-4 py-2.5 outline-none transition-colors";
  return to ? <Link to={to} className={clsx(cls, "hover:bg-hover/60 focus-visible:bg-hover/60")}>{inner}</Link> : <div className={cls}>{inner}</div>;
}

/** Approvals waiting on this person, mentions and budget alerts, each with a direct link to where it gets resolved. */
export function Attention({ index, className }: { index?: number; className?: string }) {
  const t = useT();
  const att = useAttention();
  const activeQ = useProjects(false);
  const titles = useMemo(() => new Map((activeQ.data ?? []).map((p) => [p.id, p.title])), [activeQ.data]);
  const roles: Record<Role, string> = { admin: t("Admin"), producer: t("Producer"), creator: t("Creator"), reviewer: t("Reviewer"), viewer: t("Viewer") };

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [
      ...att.approvals.map((a): Item => ({ kind: "approval", at: a.created_at, a })),
      ...att.notes.map((n): Item => ({ kind: "note", at: n.created_at, n })),
    ];
    // money first (approvals, budget), then mentions, newest first inside each group
    const rank = (i: Item) => (i.kind === "approval" ? 0 : i.n.type === "budget" ? 1 : 2);
    return list.sort((x, y) => rank(x) - rank(y) || +new Date(y.at) - +new Date(x.at));
  }, [att.approvals, att.notes]);
  const shown = items.slice(0, MAX);
  const more = items.length - shown.length;
  const nothing = !att.loading && !att.error && items.length === 0;

  return (
    <Panel index={index} className={className} flush tone={items.length ? "warn" : undefined}
      eyebrow={t("Needs attention")} icon={<ShieldAlert />}
      actions={items.length ? <Badge tone="warn" className="mono">{items.length}</Badge> : undefined}>
      <div className="pt-2.5">
        {att.loading ? (
          <div aria-busy="true" className="space-y-3 px-4 pb-4 pt-1">
            {[0, 1].map((i) => <div key={i} className="flex gap-3"><Skeleton className="size-7 rounded-md" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-3 w-1/3" /></div></div>)}
          </div>
        ) : att.error ? (
          <div className="flex items-center justify-between gap-3 px-4 pb-4 pt-1 text-sm text-mute">
            <span>{t("Couldn't load this")}</span>
            <Button size="sm" variant="outline" onClick={att.retry}>{t("Try again")}</Button>
          </div>
        ) : nothing ? (
          <div className="flex items-center gap-3 px-4 pb-4 pt-1">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-ok/25 bg-ok/10 text-ok"><CircleCheck className="size-4" aria-hidden /></span>
            <p className="min-w-0 text-xs leading-relaxed text-mute"><span className="block text-sm text-ink">{t("All clear.")}</span>{t("Approvals, mentions and budget alerts show up here.")}</p>
          </div>
        ) : (
          <div className="divide-y divide-line border-t border-line">
            {shown.map((it) => {
              if (it.kind === "approval") {
                const a = it.a;
                const who = a.requested_by_user?.name?.trim() || a.requested_by_user?.email?.split("@")[0] || t("Someone");
                return (
                  <Row key={`a${a.id}`} tone="warn" icon={<ShieldAlert />} to={a.can_decide ? "/approvals" : undefined}
                    meta={<>{who} · {agoT(a.created_at)}{!a.can_decide && <> · {t("Waiting for {role} approval.", { role: roles[a.needs_role] ?? a.needs_role })}</>}</>}
                    aside={<span className="flex shrink-0 flex-col items-end gap-1.5">
                      <span className="mono text-sm font-medium text-money">{usd(a.amount_usd)}</span>
                      {a.can_decide && <span className="inline-flex items-center gap-0.5 text-2xs font-medium text-accent-ink">{t("Review")}<ArrowUpRight className="size-3" aria-hidden /></span>}
                    </span>}>
                    <span className="block truncate font-medium">{a.project_title || (a.project_id ? titles.get(a.project_id) : "") || t("Shared library")}</span>
                    {a.summary && <span className="line-clamp-1 text-xs text-mute">{a.summary}</span>}
                  </Row>
                );
              }
              const n = it.n;
              const budget = n.type === "budget";
              return (
                <Row key={`n${n.type}${n.id}`} tone={budget ? "bad" : "accent"} icon={budget ? <Coins /> : <MessageSquare />}
                  to={budget ? "/costs" : n.project_id ? `/p/${n.project_id}/storyboard` : undefined}
                  meta={<>{budget ? t("Budget") : (n.project_id && titles.get(n.project_id)) || t("Mention")} · {agoT(n.created_at)}</>}
                  aside={(budget || n.project_id) ? <ArrowUpRight className="mt-1 size-3.5 shrink-0 text-dim" aria-hidden /> : undefined}>
                  <span className="line-clamp-2">{n.text}</span>
                </Row>
              );
            })}
            {more > 0 && (
              <Link to="/approvals" className="flex items-center justify-between px-4 py-2 text-xs text-mute transition-colors hover:bg-hover/60 hover:text-ink">
                <span>{t("{n} more", { n: more })}</span><ArrowUpRight className="size-3.5" aria-hidden />
              </Link>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
