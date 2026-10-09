import "../../styles/home.css";
import { clsx } from "clsx";
import {
  Activity as ActivityIcon, BadgeCheck, BookUser, CircleCheck, CircleX, Clapperboard, Coins, Cpu, ListPlus, MessageSquare, ShieldAlert,
  ShieldCheck, Sparkles, SquarePen, type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useActivity, useProjects } from "../../lib/queries";
import type { EventRow } from "../../lib/types";
import { agoT } from "../growth/common";
import { Button, Panel, Skeleton } from "../ui";
import { firstName, type Tone } from "./util";

const SHOWN = 14;

/** Human names for the job types the backend can create (same wording as the project's Activity page). */
function jobName(type: unknown): string {
  const key = String(type ?? "");
  const map: Record<string, string> = {
    keyframe: tr("Keyframe"), video: tr("Video"), qc: tr("QC review"), voice: tr("Voice"), lipsync: tr("Lip-sync"), voicelock: tr("Voice lock"),
    music: tr("Music"), sfx: tr("Sound effects"), character_sheet: tr("Character sheet"), character_outfit: tr("Outfit"),
    character_expressions: tr("Expressions"), location_images: tr("Location images"), voice_design: tr("Voice design"),
    voice_preview: tr("Voice preview"), omni_edit: tr("Omni edit"), animatic: tr("Animatic"), export: tr("Export"), dub: tr("Dub episode"),
    autopilot: tr("Autopilot"), marketing: tr("Marketing pack"), search_index: tr("Search index"), publish_youtube: tr("YouTube upload"),
    fetch_metrics: tr("YouTube analytics"), train_identity: tr("Identity training"),
  };
  return map[key] ?? (key ? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : tr("Job"));
}

interface Line { icon: LucideIcon; tone: Tone; text: string; usd?: number; system?: boolean }

function describe(e: EventRow): Line {
  const p = e.payload || {};
  switch (e.type) {
    case "jobs.created": {
      const n = Number(p.count ?? 0);
      return { icon: ListPlus, tone: "info", text: n === 1 ? tr("started {n} job", { n }) : tr("started {n} jobs", { n }), usd: p.total_usd ? Number(p.total_usd) : undefined };
    }
    case "job.updated": {
      const st = String(p.status ?? "");
      const word = st === "succeeded" ? tr("finished") : st === "failed" ? tr("failed") : st === "cancelled" ? tr("was cancelled") : tr(st);
      return { icon: st === "failed" ? CircleX : st === "succeeded" ? CircleCheck : Cpu, tone: st === "failed" ? "bad" : st === "succeeded" ? "ok" : "neutral", system: true, text: `${jobName(p.type)} ${word}` };
    }
    case "approval.requested":
      return { icon: ShieldAlert, tone: "warn", text: tr("asked for approval"), usd: p.amount_usd ? Number(p.amount_usd) : undefined };
    case "approval.decided": {
      const ok = String(p.status ?? "") === "approved";
      return { icon: ok ? ShieldCheck : ShieldAlert, tone: ok ? "ok" : "bad", text: tr("{status} approval #{id}", { status: tr(String(p.status ?? "")), id: p.approval_id ?? "" }) };
    }
    case "comment.created":
      return { icon: MessageSquare, tone: "accent", text: tr("commented") };
    case "shot.updated":
      return { icon: SquarePen, tone: "neutral", text: p.status ? tr("marked a shot {status}", { status: tr(String(p.status)) }) : tr("edited a shot") };
    case "project.created":
      return { icon: Sparkles, tone: "accent", text: tr("created the project “{title}”", { title: p.title ?? "" }) };
    case "export.updated": {
      const st = String(p.status ?? "");
      const id = p.export_id ?? "";
      if (p.approved !== undefined && p.approved !== null) {
        return { icon: BadgeCheck, tone: p.approved ? "ok" : "neutral", text: p.approved ? tr("approved render #{id}", { id }) : tr("removed the approval from render #{id}", { id }) };
      }
      const word = st === "ready" ? tr("is ready") : st === "failed" ? tr("failed") : st === "running" ? tr("started rendering") : tr(st);
      return { icon: Clapperboard, tone: st === "ready" ? "ok" : st === "failed" ? "bad" : "accent", system: !e.user, text: `${tr("Render #{id}", { id })} ${word}` };
    }
    case "budget.alert":
      return { icon: Coins, tone: "bad", system: true, text: tr("team budget reached {pct}%", { pct: p.threshold ?? "" }) };
    case "bible.updated":
      return { icon: BookUser, tone: "info", text: tr("updated the bible") };
    default:
      return { icon: ActivityIcon, tone: "neutral", text: e.type };
  }
}

const NODE: Record<Tone, string> = {
  neutral: "text-mute", accent: "text-accent-ink", money: "text-money", ai: "text-ai", ok: "text-ok", warn: "text-warn", bad: "text-bad", info: "text-info",
};

/** A compact timeline of the latest events from every project. */
export function Feed({ index, className }: { index?: number; className?: string }) {
  const t = useT();
  const q = useActivity();
  const activeQ = useProjects(false);
  const archivedQ = useProjects(true);
  const titles = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of [...(archivedQ.data ?? []), ...(activeQ.data ?? [])]) m.set(p.id, p.title);
    return m;
  }, [activeQ.data, archivedQ.data]);
  const events = useMemo(() => (q.data ?? []).slice(0, SHOWN), [q.data]);

  return (
    <Panel index={index} className={className} flush eyebrow={t("Activity")} icon={<ActivityIcon />}>
      <div className="pt-2.5">
        {q.isLoading ? (
          <div aria-busy="true" className="space-y-3.5 px-4 pb-4 pt-1">
            {[0, 1, 2, 3].map((i) => <div key={i} className="flex gap-3"><Skeleton className="size-[1.375rem] rounded-full" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3 w-4/5" /><Skeleton className="h-2.5 w-1/3" /></div></div>)}
          </div>
        ) : q.isError ? (
          <div className="flex items-center justify-between gap-3 px-4 pb-4 pt-1 text-sm text-mute">
            <span>{t("Couldn't load the activity")}</span>
            <Button size="sm" variant="outline" onClick={() => void q.refetch()}>{t("Try again")}</Button>
          </div>
        ) : !events.length ? (
          <p className="px-4 pb-4 pt-1 text-xs leading-relaxed text-mute"><span className="block text-sm text-ink">{t("No activity yet")}</span>{t("Everything your team does shows up here.")}</p>
        ) : (
          <div className="max-h-80 overflow-y-auto border-t border-line">
            <ol className="cc-rail mx-4 my-3">
              {events.map((e) => {
                const d = describe(e);
                const Icon = d.icon;
                const who = !d.system && e.user ? firstName(e.user) : "";
                const project = e.project_id ? titles.get(e.project_id) ?? t("Project #{n}", { n: e.project_id }) : "";
                const row = (
                  <>
                    <span aria-hidden className={clsx("relative z-10 mt-0.5 grid size-[1.375rem] shrink-0 place-items-center rounded-full border border-line bg-panel", NODE[d.tone])}><Icon className="size-3" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs leading-snug text-mute">
                        {who && <b className="font-medium text-ink">{who} </b>}{d.text}
                        {d.usd !== undefined && <span className="mono text-money"> · {usd(d.usd)}</span>}
                      </span>
                      <span className="mono mt-0.5 block truncate text-2xs text-dim">{project && <>{project} · </>}{agoT(e.created_at)}</span>
                    </span>
                  </>
                );
                const cls = "flex items-start gap-3 rounded-md py-1.5 pr-1 outline-none transition-colors";
                return (
                  <li key={e.id}>
                    {e.project_id
                      ? <Link to={`/p/${e.project_id}/activity`} className={clsx(cls, "hover:bg-hover/50 focus-visible:bg-hover/50")}>{row}</Link>
                      : <div className={cls}>{row}</div>}
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>
    </Panel>
  );
}
