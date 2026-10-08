import { clsx } from "clsx";
import {
  Activity as ActivityIcon, BadgeCheck, BookUser, CircleCheck, CircleX, Clapperboard, Coins, Cpu, ListPlus, MessageSquare, ShieldAlert,
  ShieldCheck, Sparkles, SquarePen, TriangleAlert, type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Chip, LoadError } from "../../components/growth/common";
import { relTime } from "../../components/review/utils";
import { Avatar, Button, Empty, Page, PageHeader, rise, Select, Skeleton } from "../../components/ui";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useActivity } from "../../lib/queries";
import type { EventRow } from "../../lib/types";
import { useProjectCtx } from "./context";

type Tone = "ok" | "bad" | "warn" | "info" | "accent" | "neutral";
type Group = "all" | "jobs" | "renders" | "comments" | "approvals" | "edits";

const TONE_CHIP: Record<Tone, string> = {
  ok: "bg-ok/12 text-ok ring-ok/25", bad: "bg-bad/12 text-bad ring-bad/25", warn: "bg-warn/12 text-warn ring-warn/25",
  info: "bg-info/12 text-info ring-info/25", accent: "bg-accent/12 text-accent-ink ring-accent/25", neutral: "bg-raised text-mute ring-line",
};

/** Solid little badge that sits on a person's avatar. */
const TONE_BADGE: Record<Tone, string> = {
  ok: "bg-ok text-black", bad: "bg-bad text-white", warn: "bg-warn text-black", info: "bg-info text-black", accent: "bg-accent text-black", neutral: "bg-raised text-ink",
};

const GROUP_OF: Record<string, Exclude<Group, "all">> = {
  "jobs.created": "jobs", "job.updated": "jobs", "export.updated": "renders", "comment.created": "comments",
  "approval.requested": "approvals", "approval.decided": "approvals", "budget.alert": "approvals",
  "shot.updated": "edits", "bible.updated": "edits", "project.created": "edits",
};

/** Human names for the job types the backend can create. */
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

interface Described { icon: LucideIcon; tone: Tone; text: ReactNode; detail?: ReactNode; system?: boolean }

function describe(e: EventRow): Described {
  const p = e.payload || {};
  switch (e.type) {
    case "jobs.created": {
      const n = Number(p.count ?? 0);
      const cost = p.total_usd ? ` · ${usd(p.total_usd)}` : "";
      return { icon: ListPlus, tone: "info", text: <>{n === 1 ? tr("started {n} job", { n }) : tr("started {n} jobs", { n })}{cost} <span className="text-mute">— {tr(p.status ?? "queued")}</span></> };
    }
    case "job.updated": {
      const st = String(p.status ?? "");
      const word = st === "succeeded" ? tr("finished") : st === "failed" ? tr("failed") : st === "cancelled" ? tr("was cancelled") : tr(st);
      return {
        icon: st === "failed" ? CircleX : st === "succeeded" ? CircleCheck : Cpu, tone: st === "failed" ? "bad" : st === "succeeded" ? "ok" : "neutral", system: true,
        text: <><b className="font-semibold text-ink">{jobName(p.type)}</b> {word} <span className="text-dim">#{p.job_id}</span></>,
        detail: p.error ? <span className="line-clamp-2 text-red-300">{String(p.error).slice(0, 200)}</span> : undefined,
      };
    }
    case "approval.requested":
      return { icon: ShieldAlert, tone: "warn", text: <>{tr("asked for approval: {amount} — {summary}", { amount: usd(p.amount_usd), summary: p.summary ?? "" })}</> };
    case "approval.decided": {
      const ok = String(p.status ?? "") === "approved";
      return { icon: ok ? ShieldCheck : ShieldAlert, tone: ok ? "ok" : "bad", text: <>{tr("{status} approval #{id}", { status: tr(String(p.status ?? "")), id: p.approval_id })}</> };
    }
    case "comment.created":
      return {
        icon: MessageSquare, tone: "accent", text: <>{tr("commented")}</>,
        detail: p.excerpt ? <span className="line-clamp-3 italic text-mute">“{p.excerpt}”</span> : undefined,
      };
    case "shot.updated":
      return { icon: SquarePen, tone: "neutral", text: <>{p.status ? tr("marked a shot {status}", { status: tr(String(p.status)) }) : tr("edited a shot")}</> };
    case "project.created":
      return { icon: Sparkles, tone: "accent", text: <>{tr("created the project “{title}”", { title: p.title ?? "" })}</> };
    case "export.updated": {
      const st = String(p.status ?? "");
      const id = p.export_id;
      if (p.approved !== undefined && p.approved !== null) {
        return { icon: BadgeCheck, tone: p.approved ? "ok" : "neutral", text: <>{p.approved ? tr("approved render #{id}", { id }) : tr("removed the approval from render #{id}", { id })}</> };
      }
      const word = st === "ready" ? tr("is ready") : st === "failed" ? tr("failed") : st === "running" ? tr("started rendering") : tr(st);
      return { icon: Clapperboard, tone: st === "ready" ? "ok" : st === "failed" ? "bad" : "accent", system: !e.user, text: <>{tr("Render #{id}", { id })} {word}</> };
    }
    case "budget.alert":
      return { icon: Coins, tone: "bad", system: true, text: <>{tr("team budget reached {pct}%", { pct: p.threshold })}</> };
    case "bible.updated":
      return { icon: BookUser, tone: "info", text: <>{tr("updated the bible")}</> };
    default:
      return { icon: TriangleAlert, tone: "neutral", text: <>{e.type}</> };
  }
}

function dayLabel(d: Date): string {
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return tr("Today");
  if (diff === 1) return tr("Yesterday");
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function FeedSkeleton() {
  return (
    <div aria-hidden className="space-y-7">
      {[0, 1].map((g) => (
        <div key={g}>
          <Skeleton className="mb-3 h-3 w-20" />
          <div className="space-y-4">
            {Array.from({ length: g ? 3 : 4 }, (_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2 pt-1"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-3 w-24" /></div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ActivityPage() {
  const { project } = useProjectCtx();
  const t = useT();
  const { data, isLoading, isError, refetch, isFetching } = useActivity(project.id);
  const [group, setGroup] = useState<Group>("all");
  const [who, setWho] = useState("all");

  // New events that arrive while the page is open get a small entrance animation (the first load uses the stagger).
  const seen = useRef<Set<number> | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!data) return;
    if (seen.current === null) { seen.current = new Set(data.map((e) => e.id)); return; }
    const added = data.filter((e) => !seen.current!.has(e.id)).map((e) => e.id);
    if (!added.length) return;
    added.forEach((id) => seen.current!.add(id));
    setFresh((f) => new Set([...f, ...added]));
    const timer = setTimeout(() => setFresh(new Set()), 2600);
    return () => clearTimeout(timer);
  }, [data]);

  const events = data ?? [];
  const people = useMemo(() => [...new Set(events.map((e) => e.user?.name).filter(Boolean) as string[])].sort(), [events]);
  const hasSystem = events.some((e) => !e.user);
  const counts = useMemo(() => {
    const c: Record<Group, number> = { all: events.length, jobs: 0, renders: 0, comments: 0, approvals: 0, edits: 0 };
    for (const e of events) { const g = GROUP_OF[e.type]; if (g) c[g]++; }
    return c;
  }, [events]);

  const filtered = useMemo(() => events.filter((e) => {
    if (group !== "all" && GROUP_OF[e.type] !== group) return false;
    if (who === "all") return true;
    if (who === "__system") return !e.user;
    return e.user?.name === who;
  }), [events, group, who]);

  const days = useMemo(() => {
    const out: { key: string; label: string; items: EventRow[] }[] = [];
    for (const e of filtered) {
      const d = new Date(e.created_at);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      let g = out[out.length - 1];
      if (!g || g.key !== key) { g = { key, label: dayLabel(d), items: [] }; out.push(g); }
      g.items.push(e);
    }
    return out;
  }, [filtered]);

  const groups: { value: Group; label: string }[] = [
    { value: "all", label: t("All") }, { value: "jobs", label: t("Jobs") }, { value: "renders", label: t("Renders") },
    { value: "comments", label: t("Comments") }, { value: "approvals", label: t("Approvals") }, { value: "edits", label: t("Edits") },
  ];
  const filtering = group !== "all" || who !== "all";
  let index = 0;

  return (
    <Page width="narrow" className="!py-5 sm:!py-6">
      <PageHeader className="!mb-4" icon={<ActivityIcon className="size-5" />} title={t("Activity")}
        subtitle={t("Jobs, renders, comments and approvals in this project, newest first.")} />

      <div className="sticky top-0 z-10 -mx-4 mb-5 flex flex-wrap items-center gap-2 border-b border-line/70 bg-bg/85 px-4 py-2.5 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div role="group" aria-label={t("Event type")} className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {groups.map((g) => (
            <Chip key={g.value} active={group === g.value} onClick={() => setGroup(g.value)} count={isLoading ? undefined : counts[g.value]}>{g.label}</Chip>
          ))}
        </div>
        {(people.length > 0 || hasSystem) && (
          <Select value={who} onChange={(e) => setWho(e.target.value)} aria-label={t("Person")} className="!h-8 !w-36 shrink-0 text-xs">
            <option value="all">{t("Everyone")}</option>
            {people.map((n) => <option key={n} value={n}>{n}</option>)}
            {hasSystem && <option value="__system">{t("System")}</option>}
          </Select>
        )}
      </div>

      {isError && !data ? <LoadError title={t("We couldn't load the activity")} onRetry={() => refetch()} retrying={isFetching} /> : isLoading ? <FeedSkeleton /> : !events.length ? (
        <Empty icon={<ActivityIcon className="size-7" />} title={t("No activity yet")} sub={t("Events from jobs, comments and renders show up here as your team works.")} />
      ) : !filtered.length ? (
        <Empty icon={<ActivityIcon className="size-7" />} title={t("Nothing matches these filters")}
          action={filtering ? <Button variant="outline" onClick={() => { setGroup("all"); setWho("all"); }}>{t("Clear filters")}</Button> : undefined} />
      ) : (
        <div key={`${group}|${who}`} className="space-y-7">
          {days.map((day) => (
            <section key={day.key} aria-label={day.label}>
              <h2 className="mb-1 flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-mute">
                {day.label}<span className="font-normal normal-case tracking-normal text-dim">· {day.items.length === 1 ? t("1 event") : t("{n} events", { n: day.items.length })}</span>
              </h2>
              <ol className="relative">
                <span aria-hidden className="absolute bottom-3 left-4 top-3 w-px bg-line" />
                {day.items.map((e) => {
                  const d = describe(e);
                  const Icon = d.icon;
                  const i = index++;
                  const isFresh = fresh.has(e.id);
                  const r = rise(i);
                  const actor = e.user?.name ?? (e.type === "comment.created" ? String(e.payload?.by ?? "").replace(/\s*\(client\)$/, "") : "");
                  const client = e.type === "comment.created" && !e.user && /\(client\)$/.test(String(e.payload?.by ?? ""));
                  const person = !!actor && !d.system;
                  return (
                    <li key={e.id} className={clsx("group relative flex gap-3 py-2.5", isFresh ? "anim-pop" : i < 14 && r.className)}
                      style={i < 14 && !isFresh ? r.style : undefined}>
                      {/* who did it (avatar) with the kind of event as a small badge; system events show the kind itself */}
                      <span className={clsx("relative z-10 shrink-0", isFresh && "pulse-ring rounded-full")}>
                        {person ? (
                          <>
                            <Avatar name={actor} size={32} />
                            <span className={clsx("absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full ring-2 ring-bg", TONE_BADGE[d.tone])}><Icon className="size-2.5" strokeWidth={2.6} /></span>
                          </>
                        ) : (
                          <span className={clsx("grid size-8 place-items-center rounded-full ring-1 ring-inset", TONE_CHIP[d.tone])}><Icon className="size-4" /></span>
                        )}
                      </span>
                      <div className="min-w-0 flex-1 pt-1">
                        <div className="flex items-start gap-2">
                          <p className="min-w-0 flex-1 text-sm leading-snug">
                            {person && (
                              <span className="mr-1.5 inline-flex items-center gap-1.5">
                                <b className="font-semibold text-ink">{actor}</b>
                                {client && <span className="rounded bg-info/12 px-1 py-px text-2xs font-medium text-sky-300">{t("Client")}</span>}
                              </span>
                            )}
                            <span className={clsx(d.tone === "bad" ? "text-red-300" : "text-mute")}>{d.text}</span>
                          </p>
                          <time dateTime={e.created_at} title={new Date(e.created_at).toLocaleString()} className="shrink-0 pt-0.5 text-2xs tabular-nums text-dim">
                            {relTime(e.created_at)}
                          </time>
                        </div>
                        {d.detail && <div className="mt-1 rounded-lg border-l-2 border-line bg-raised/40 py-1 pl-2.5 pr-2 text-xs leading-relaxed">{d.detail}</div>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
          {events.length >= 100 && <p className="pb-2 text-center text-xs text-dim">{t("Showing the latest {n} events.", { n: events.length })}</p>}
        </div>
      )}
    </Page>
  );
}
