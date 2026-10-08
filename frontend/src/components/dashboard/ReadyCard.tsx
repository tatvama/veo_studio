import { clsx } from "clsx";
import { ArrowRight, CheckCircle2, Circle, Clapperboard, Film } from "lucide-react";
import { Link } from "react-router-dom";
import { LANG_NAMES } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { EpisodeDashboard } from "../../lib/v3";
import { SectionCard } from "../room/kit";
import { Badge } from "../ui";

/** "Timeline ready" and "Latest export" rows, each linking to its page. */
export function ReadyCard({ d, pid, index }: { d: EpisodeDashboard; pid: number; index?: number }) {
  const t = useT();
  const x = d.latest_export;
  return (
    <SectionCard index={index} icon={<Film />} title={t("Finishing")}>
      <ul className="divide-y divide-line">
        <Row to={`/p/${pid}/timeline`} ok={d.timeline_ready} icon={<Film className="size-4" />} title={t("Timeline")}
          sub={d.timeline_ready ? t("Every included shot has a video — the cut can be assembled.") : d.shots.total ? t("{n} shots still need a video before the full cut.", { n: d.shots.total - (d.shots.approved + d.shots.in_review) }) : t("No shots yet.")}
          action={t("Open timeline")} />
        <Row to={`/p/${pid}/export`} ok={!!x} icon={<Clapperboard className="size-4" />} title={t("Latest export")}
          sub={x ? <span className="flex flex-wrap items-center gap-1.5">{t("Export #{id}", { id: x.id })}<Badge>{x.preset}</Badge><Badge>{t(LANG_NAMES[x.language] ?? x.language)}</Badge>
            {x.approved ? <Badge tone="ok" dot>{t("approved")}</Badge> : <Badge tone="warn" dot>{t("not approved")}</Badge>}</span> : t("No final render yet.")}
          action={x ? t("Open export") : t("Render")} />
      </ul>
    </SectionCard>
  );
}

function Row({ to, ok, icon, title, sub, action }: { to: string; ok: boolean; icon: React.ReactNode; title: string; sub: React.ReactNode; action: string }) {
  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <span className={clsx("grid size-8 shrink-0 place-items-center rounded-lg", ok ? "bg-ok/12 text-ok" : "bg-raised text-mute")}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {title}
          {ok ? <CheckCircle2 className="size-3.5 text-ok" aria-label="ready" /> : <Circle className="size-3.5 text-dim" aria-hidden />}
        </p>
        <div className="text-xs text-mute">{sub}</div>
      </div>
      <Link to={to} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-accent-ink hover:bg-hover">{action}<ArrowRight className="size-3.5" /></Link>
    </li>
  );
}
