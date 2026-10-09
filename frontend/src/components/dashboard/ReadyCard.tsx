import { ArrowRight, Check, Clapperboard, Film, PackageCheck, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";
import { LANG_NAMES } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { EpisodeDashboard } from "../../lib/v3";
import { Badge, Meter, Panel } from "../ui";

/** "Timeline ready" and "Latest export" rows, each linking to its page. */
export function ReadyCard({ d, pid, index, className }: { d: EpisodeDashboard; pid: number; index?: number; className?: string }) {
  const t = useT();
  const x = d.latest_export;
  const withVideo = Math.max(0, d.shots.total - d.shots.remaining);
  return (
    <Panel index={index} className={className} eyebrow={t("Delivery")} icon={<PackageCheck />} flush>
      <ul className="mt-3 divide-y divide-line border-t border-line">
        <Row to={`/p/${pid}/timeline`} ok={d.timeline_ready} icon={Film} title={t("Timeline")} word={d.timeline_ready ? t("Ready") : t("Waiting")}
          action={t("Open timeline")}
          sub={d.timeline_ready ? t("Every included shot has a video, so the cut can be assembled.")
            : d.shots.total ? t("{n} shots still need a video before the full cut.", { n: d.shots.remaining }) : t("No shots yet.")}>
          {!d.timeline_ready && d.shots.total > 0 && <Meter className="mt-2" filled={Math.round((withVideo / d.shots.total) * 12)} total={12} tone="accent" />}
        </Row>
        <Row to={`/p/${pid}/export`} ok={!!x} icon={Clapperboard} title={t("Latest export")} word={x ? (x.approved ? t("Approved") : t("Not approved")) : t("None yet")}
          action={x ? t("Open export") : t("Render")}
          sub={x ? <span className="flex flex-wrap items-center gap-1.5"><span className="mono">#{x.id}</span><Badge>{x.preset}</Badge><Badge>{t(LANG_NAMES[x.language] ?? x.language)}</Badge></span> : t("No final render yet.")} />
      </ul>
    </Panel>
  );
}

function Row({ to, ok, icon: Icon, title, word, sub, action, children }: {
  to: string; ok: boolean; icon: LucideIcon; title: string; word: string; sub: ReactNode; action: string; children?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3.5">
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg border", ok ? "border-ok/40 bg-ok/10 text-ok" : "border-line bg-raised text-mute")}><Icon className="size-4" /></span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          {title}
          <span className={cn("mono inline-flex items-center gap-1 text-2xs uppercase tracking-wider", ok ? "text-ok" : "text-dim")}>{ok && <Check className="size-3" strokeWidth={3} />}{word}</span>
        </p>
        <div className="mt-0.5 text-xs text-mute">{sub}</div>
        {children}
      </div>
      <Link to={to} className="inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg px-2 text-xs font-medium text-accent-ink hover:bg-hover max-sm:size-10">
        <span className="max-sm:sr-only">{action}</span><ArrowRight className="size-3.5" />
      </Link>
    </li>
  );
}
