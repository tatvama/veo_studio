import {
  Activity as ActivityIcon, ArrowUpRight, BadgeCheck, BookUser, CircleCheck, CircleX, Clapperboard, Coins, Cpu, Film, ListFilter, ListPlus,
  MessageSquare, RefreshCw, ShieldAlert, ShieldCheck, Sparkles, SquarePen, TriangleAlert, type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { jobName, TAKE_JOBS } from "../../components/dashboard/jobs";
import { SOFT, TEXT, type Tone } from "../../components/dashboard/tone";
import { relTime } from "../../components/review/utils";
import { LoadError, RoomEmpty, RoomHeader, RoomPage } from "../../components/room/kit";
import { Avatar, Button, Panel, rise, ScrollStrip, Select, Skeleton } from "../../components/ui";
import { cn } from "../../lib/cn";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useActivity } from "../../lib/queries";
import { useUI } from "../../lib/store";
import type { EventRow } from "../../lib/types";
import { useProjectCtx } from "./context";

type Group = "all" | "jobs" | "takes" | "comments" | "exports" | "approvals" | "edits";

/** Which filters an event belongs to. An event can sit in more than one (a video job is both a job and a take). */
function groupsOf(e: EventRow): Group[] {
  switch (e.type) {
    case "jobs.created": return ["jobs"];
    case "job.updated": return TAKE_JOBS.has(String(e.payload?.type ?? "")) ? ["jobs", "takes"] : ["jobs"];
    case "export.updated": return ["exports"];
    case "comment.created": return ["comments"];
    case "approval.requested": case "approval.decided": case "budget.alert": return ["approvals"];
    case "shot.updated": return ["takes", "edits"];
    case "bible.updated": case "project.created": return ["edits"];
    default: return [];
  }
}

const GROUP_ICON: Record<Group, LucideIcon> = {
  all: ListFilter, jobs: Cpu, takes: Film, comments: MessageSquare, exports: Clapperboard, approvals: ShieldCheck, edits: SquarePen,
};

interface Described { icon: LucideIcon; tone: Tone; text: ReactNode; detail?: ReactNode; system?: boolean }

const money = (v: unknown) => <span className="mono text-money">{usd(Number(v) || 0)}</span>;

function describe(e: EventRow): Described {
  const p = e.payload || {};
  switch (e.type) {
    case "jobs.created": {
      const n = Number(p.count ?? 0);
      return { icon: ListPlus, tone: "info", text: <>{n === 1 ? tr("started {n} job", { n }) : tr("started {n} jobs", { n })}{p.total_usd ? <> · {money(p.total_usd)}</> : null} <span className="text-dim">/ {tr(p.status ?? "queued")}</span></> };
    }
    case "job.updated": {
      const st = String(p.status ?? "");
      const word = st === "succeeded" ? tr("finished") : st === "failed" ? tr("failed") : st === "cancelled" ? tr("was cancelled") : tr(st);
      return {
        icon: st === "failed" ? CircleX : st === "succeeded" ? CircleCheck : Cpu, tone: st === "failed" ? "bad" : st === "succeeded" ? "ok" : "neutral", system: true,
        text: <><b className="font-semibold text-ink">{jobName(p.type)}</b> {word} <span className="mono text-dim">#{p.job_id}</span></>,
        detail: p.error ? <span className="line-clamp-2 text-bad">{String(p.error).slice(0, 200)}</span> : undefined,
      };
    }
    case "approval.requested":
      return { icon: ShieldAlert, tone: "warn", text: <>{tr("asked for approval: {amount} — {summary}", { amount: usd(p.amount_usd), summary: p.summary ?? "" })}</> };
    case "approval.decided": {
      const ok = String(p.status ?? "") === "approved";
      return { icon: ok ? ShieldCheck : ShieldAlert, tone: ok ? "ok" : "bad", text: <>{tr("{status} approval #{id}", { status: tr(String(p.status ?? "")), id: p.approval_id })}</> };
    }
    case "comment.created":
      return { icon: MessageSquare, tone: "accent", text: <>{tr("commented")}</>, detail: p.excerpt ? <span className="line-clamp-3 italic text-mute">“{p.excerpt}”</span> : undefined };
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

/** The thing an event is about, when the payload says which. */
function target(e: EventRow, pid: number): { to: string; label: string; shotId?: number } | null {
  const p = e.payload || {};
  switch (e.type) {
    case "job.updated": case "shot.updated":
      if (p.shot_id) return { to: `/p/${pid}/storyboard`, label: tr("Shot"), shotId: Number(p.shot_id) };
      return e.type === "job.updated" && p.type === "export" ? { to: `/p/${pid}/export`, label: tr("Export") } : null;
    case "comment.created":
      return p.target_type === "shot" ? { to: `/p/${pid}/storyboard`, label: tr("Shot"), shotId: Number(p.target_id) } : { to: `/p/${pid}/review`, label: tr("Review") };
    case "export.updated": return { to: `/p/${pid}/export`, label: tr("Export") };
    case "approval.requested": case "approval.decided": return { to: "/approvals", label: tr("Approvals") };
    case "bible.updated": return { to: `/p/${pid}/bible`, label: tr("Bible") };
    case "budget.alert": return { to: "/costs", label: tr("Costs") };
    case "project.created": return { to: `/p/${pid}/brief`, label: tr("Brief") };
    default: return null;
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

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

function FeedSkeleton() {
  return (
    <div aria-hidden className="space-y-6">
      {[0, 1].map((g) => (
        <div key={g}>
          <Skeleton className="mb-3 h-3 w-24" />
          <div className="space-y-3">
            {Array.from({ length: g ? 3 : 4 }, (_, i) => (
              <div key={i} className="grid grid-cols-[3.25rem_2rem_minmax(0,1fr)] gap-x-3">
                <Skeleton className="ml-auto mt-2 h-3 w-9" /><Skeleton className="size-8" /><Skeleton className="h-12 w-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Events per day for the last two weeks: a little bar chart. */
function Pulse({ events }: { events: EventRow[] }) {
  const t = useT();
  const DAYS = 14;
  const { bars, max, started, failed, spend, total } = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const bars = Array.from({ length: DAYS }, (_, i) => { const d = new Date(today); d.setDate(today.getDate() - (DAYS - 1 - i)); return { d, n: 0 }; });
    let started = 0, failed = 0, spend = 0, total = 0;
    for (const e of events) {
      const d = new Date(e.created_at); d.setHours(0, 0, 0, 0);
      const i = Math.round((d.getTime() - bars[0].d.getTime()) / 86400000);
      if (i >= 0 && i < DAYS) { bars[i].n++; total++; }
      if (e.type === "jobs.created") { started += Number(e.payload?.count ?? 0); spend += Number(e.payload?.total_usd ?? 0); }
      if (e.type === "job.updated" && e.payload?.status === "failed") failed++;
    }
    return { bars, max: Math.max(1, ...bars.map((b) => b.n)), started, failed, spend, total };
  }, [events]);
  return (
    <Panel eyebrow={t("Pulse")} icon={<ActivityIcon />} actions={<span className="mono text-2xs text-dim">{t("14 days")}</span>}>
      <p className="mono flex items-baseline gap-1.5 text-[1.65rem] font-medium leading-none tracking-tight">{total}<span className="text-sm font-normal text-dim">{t("events")}</span></p>
      <div className="mt-4 flex h-14 items-end gap-1" role="img" aria-label={t("Events per day, last 14 days")}>
        {bars.map((b, i) => (
          <span key={i} title={`${b.d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${b.n}`}
            className={cn("min-h-[3px] flex-1 rounded-[2px]", i === DAYS - 1 ? "bg-accent shadow-[0_0_8px_-1px_var(--color-accent)]" : b.n ? "bg-accent/45" : "bg-line")}
            style={{ height: `${Math.max(6, (b.n / max) * 100)}%` }} />
        ))}
      </div>
      <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-xs">
        <div className="flex items-baseline justify-between gap-3"><dt className="text-mute">{t("Jobs started")}</dt><dd className="mono">{started}</dd></div>
        <div className="flex items-baseline justify-between gap-3"><dt className="text-mute">{t("Jobs failed")}</dt><dd className={cn("mono", failed ? "text-bad" : "text-dim")}>{failed}</dd></div>
        <div className="flex items-baseline justify-between gap-3"><dt className="text-mute">{t("Spend started")}</dt><dd className="mono text-money">{usd(spend)}</dd></div>
      </dl>
    </Panel>
  );
}

export default function ActivityPage() {
  const { project } = useProjectCtx();
  const t = useT();
  const nav = useNavigate();
  const setSelectedShot = useUI((u) => u.setSelectedShot);
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
  const people = useMemo(() => {
    const c = new Map<string, number>();
    for (const e of events) if (e.user?.name) c.set(e.user.name, (c.get(e.user.name) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [events]);
  const systemCount = events.filter((e) => !e.user).length;
  const counts = useMemo(() => {
    const c: Record<Group, number> = { all: events.length, jobs: 0, takes: 0, comments: 0, exports: 0, approvals: 0, edits: 0 };
    for (const e of events) for (const g of groupsOf(e)) c[g]++;
    return c;
  }, [events]);

  const filtered = useMemo(() => events.filter((e) => {
    if (group !== "all" && !groupsOf(e).includes(group)) return false;
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

  const chips: { value: Group; label: string }[] = [
    { value: "all", label: t("All") }, { value: "jobs", label: t("Jobs") }, { value: "takes", label: t("Takes") }, { value: "comments", label: t("Comments") },
    { value: "exports", label: t("Exports") }, { value: "approvals", label: t("Approvals") }, { value: "edits", label: t("Edits") },
  ];
  const filtering = group !== "all" || who !== "all";
  const go = (to: string, shotId?: number) => { if (shotId) setSelectedShot(shotId); nav(to); };
  let index = 0;

  return (
    <RoomPage width="wide">
      <RoomHeader icon={<ActivityIcon />} title={t("Activity")} description={t("Jobs, takes, comments, exports and approvals in this project, newest first.")}
        actions={<Button variant="outline" size="sm" loading={isFetching && !isLoading} icon={<RefreshCw className="size-3.5" />} onClick={() => refetch()}>{t("Refresh")}</Button>} />

      <div className="grid items-start gap-4 @4xl:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0">
          <div className="sticky top-2 z-20 mb-5 flex items-center gap-2 rounded-xl border border-line bg-panel/90 p-1.5 backdrop-blur">
            <ScrollStrip className="min-w-0 flex-1" role="group" aria-label={t("Event type")}>
              <div className="flex w-max gap-1">
                {chips.map((c) => {
                  const on = group === c.value;
                  const Icon = GROUP_ICON[c.value];
                  return (
                    <button key={c.value} type="button" aria-pressed={on} data-active={on || undefined} onClick={() => setGroup(c.value)}
                      className={cn("mono inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-2xs font-medium uppercase tracking-wider transition-colors max-sm:h-10",
                        on ? "border-accent/45 bg-accent/12 text-accent-ink" : "border-transparent text-mute hover:bg-hover hover:text-ink")}>
                      <Icon className="size-3.5" />{c.label}
                      {!isLoading && <span className={cn("tabular-nums", on ? "text-accent-ink" : "text-dim")}>{counts[c.value]}</span>}
                    </button>
                  );
                })}
              </div>
            </ScrollStrip>
            {(people.length > 0 || systemCount > 0) && (
              <Select value={who} onChange={(e) => setWho(e.target.value)} aria-label={t("Person")} className="!h-8 !w-32 shrink-0 text-xs max-sm:!h-10 @4xl:hidden">
                <option value="all">{t("Everyone")}</option>
                {people.map(([n]) => <option key={n} value={n}>{n}</option>)}
                {systemCount > 0 && <option value="__system">{t("System")}</option>}
              </Select>
            )}
          </div>

          {isError && !data ? <LoadError what={t("We couldn't load the activity")} onRetry={() => refetch()} /> : isLoading ? <FeedSkeleton /> : !events.length ? (
            <RoomEmpty icon={<ActivityIcon />} title={t("No activity yet")} sub={t("Events from jobs, comments and renders show up here as your team works.")} className="py-14" />
          ) : !filtered.length ? (
            <RoomEmpty icon={<ListFilter />} title={t("Nothing matches these filters")} className="py-14"
              action={filtering ? <Button variant="outline" size="sm" onClick={() => { setGroup("all"); setWho("all"); }}>{t("Clear filters")}</Button> : undefined} />
          ) : (
            <div key={`${group}|${who}`} className="space-y-7">
              {days.map((day) => (
                <section key={day.key} aria-label={day.label}>
                  <h2 className="eyebrow mb-3 flex items-center gap-3">
                    <span className="text-ink">{day.label}</span>
                    <span>{day.items.length === 1 ? t("1 event") : t("{n} events", { n: day.items.length })}</span>
                    <span aria-hidden className="h-px flex-1 bg-line" />
                  </h2>
                  <ol>
                    {day.items.map((e) => {
                      const d = describe(e);
                      const Icon = d.icon;
                      const i = index++;
                      const isFresh = fresh.has(e.id);
                      const r = rise(i);
                      const link = target(e, project.id);
                      const actor = e.user?.name ?? (e.type === "comment.created" ? String(e.payload?.by ?? "").replace(/\s*\(client\)$/, "") : "");
                      const client = e.type === "comment.created" && !e.user && /\(client\)$/.test(String(e.payload?.by ?? ""));
                      const person = !!actor && !d.system;
                      return (
                        <li key={e.id} className={cn("group/ev grid grid-cols-[3.25rem_2rem_minmax(0,1fr)] gap-x-3 pb-3", isFresh ? "anim-pop" : i < 14 && r.className)}
                          style={i < 14 && !isFresh ? r.style : undefined}>
                          <time dateTime={e.created_at} title={`${new Date(e.created_at).toLocaleString()} · ${relTime(e.created_at)}`}
                            className="mono pt-2 text-right text-2xs tabular-nums text-dim">{clock(e.created_at)}</time>
                          <span className="relative">
                            <span className={cn("relative z-10 grid size-8 place-items-center rounded-lg border", SOFT[d.tone], isFresh && "pulse-ring")}><Icon className="size-4" /></span>
                            <span aria-hidden className="absolute -bottom-3 left-1/2 top-8 w-px -translate-x-1/2 bg-line group-last/ev:hidden" />
                          </span>
                          <div className="min-w-0 rounded-lg border border-line bg-panel/70 px-3 py-2 transition-colors hover:border-dim/40">
                            <div className="flex items-start gap-2">
                              <p className="min-w-0 flex-1 text-sm leading-snug">
                                {person ? (
                                  <span className="mr-1.5 inline-flex items-center gap-1.5 align-middle">
                                    <Avatar name={actor} size={20} />
                                    <b className="font-semibold text-ink">{actor}</b>
                                    {client && <span className="mono rounded border border-info/30 bg-info/10 px-1 py-px text-2xs uppercase tracking-wider text-info">{t("Client")}</span>}
                                  </span>
                                ) : (
                                  <span className="eyebrow mr-1.5 inline-flex items-center gap-1 align-middle"><Cpu className="size-3" />{t("System")}</span>
                                )}
                                <span className={d.tone === "bad" ? TEXT.bad : "text-mute"}>{d.text}</span>
                              </p>
                              {link && (
                                <button type="button" onClick={() => go(link.to, link.shotId)} title={t("Open {what}", { what: link.label })}
                                  className="mono inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-2xs uppercase tracking-wider text-accent-ink transition-colors hover:bg-hover max-sm:h-10">
                                  {link.label}<ArrowUpRight className="size-3" />
                                </button>
                              )}
                            </div>
                            {d.detail && <div className="mt-1.5 rounded-md border-l-2 border-line bg-raised/50 py-1 pl-2.5 pr-2 text-xs leading-relaxed">{d.detail}</div>}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
              {events.length >= 100 && <p className="mono pb-2 text-center text-2xs uppercase tracking-wider text-dim">{t("Showing the latest {n} events.", { n: events.length })}</p>}
            </div>
          )}
        </div>

        <aside className="space-y-4 @4xl:sticky @4xl:top-2" aria-label={t("Activity summary")}>
          <Pulse events={events} />
          {(people.length > 0 || systemCount > 0) && (
            <Panel eyebrow={t("People")} className="hidden @4xl:block" flush>
              <ul className="px-1.5 pb-1.5 pt-3">
                {[["all", t("Everyone"), events.length] as const, ...people.map(([n, c]) => [n, n, c] as const), ...(systemCount ? [["__system", t("System"), systemCount] as const] : [])].map(([key, label, n]) => (
                  <li key={key}>
                    <button type="button" aria-pressed={who === key} onClick={() => setWho(key)}
                      className={cn("flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm transition-colors", who === key ? "bg-accent/10 text-ink" : "text-mute hover:bg-hover hover:text-ink")}>
                      {key === "all" ? <span className="grid size-5 place-items-center rounded-full bg-raised text-dim"><ListFilter className="size-3" /></span>
                        : key === "__system" ? <span className="grid size-5 place-items-center rounded-full bg-raised text-dim"><Cpu className="size-3" /></span>
                        : <Avatar name={label} size={20} />}
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      <span className="mono text-2xs text-dim">{n}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </aside>
      </div>
    </RoomPage>
  );
}
