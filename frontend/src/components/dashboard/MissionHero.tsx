import { ArrowRight, Bot, Check, Gauge, type LucideIcon } from "lucide-react";
import { useMemo, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "../../lib/cn";
import { LANG_SHORT, secs } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useUI } from "../../lib/store";
import type { Episode, Project } from "../../lib/types";
import type { EpisodeDashboard } from "../../lib/v3";
import type { Stage, StageState } from "../../pages/project/pipeline";
import { getProjectTabs } from "../shell/nav";
import { openDirector } from "../shell/keys";
import { Badge, Button, Panel, ProgressRing, Skeleton, Tag } from "../ui";
import { flightKeys, flightTab, stageCredit, type ActionGo, type MissionAction } from "./mission";
import { TEXT, WASH } from "./tone";

const EPISODE_TONE: Record<string, "neutral" | "info" | "accent" | "ok"> = { draft: "neutral", scripted: "info", in_production: "accent", approved: "ok", delivered: "ok" };

const CHIP: Record<StageState, string> = {
  done: "border-ok/45 text-ok", progress: "border-accent/60 text-accent-ink", todo: "border-line text-dim", none: "border-line text-dim",
};
const WORD: Record<StageState, string> = { done: "text-ok", progress: "text-accent-ink", todo: "text-dim", none: "text-dim" };

/** Runs a mission action: a tab, a path, a shot in the storyboard, or a scroll to a panel on this page. */
export function useGo(pid: number) {
  const nav = useNavigate();
  const setSelectedShot = useUI((u) => u.setSelectedShot);
  return (go: ActionGo) => {
    if (go.kind === "tab") nav(`/p/${pid}/${go.tab}`);
    else if (go.kind === "path") nav(go.to);
    else if (go.kind === "shot") { setSelectedShot(go.shotId); nav(`/p/${pid}/storyboard`); }
    else document.getElementById(go.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
}

interface Waypoint { key: string; label: string; icon: LucideIcon; stage: Stage; credit: number; current: boolean; live: boolean; to: string }

/** The flight path: the stages as a track of nodes. Horizontal on wide panels, a vertical list on narrow ones. */
function FlightPath({ items }: { items: Waypoint[] }) {
  const t = useT();
  const word = (w: Waypoint) => (w.stage.state === "done" ? t("Done") : w.stage.state === "progress" ? t("Active") : w.current ? t("Next") : t("To do"));
  const fallback = (w: Waypoint) => w.stage.hint ?? (w.stage.state === "done" ? t("Complete") : w.stage.state === "progress" ? t("In progress") : t("Not started"));
  return (
    <ol aria-label={t("Production flight path")} className="grid gap-0 @2xl/hero:grid-cols-[repeat(var(--n),minmax(0,1fr))]" style={{ "--n": items.length } as CSSProperties}>
      {items.map((w, i) => {
        const Icon = w.icon;
        const state = w.stage.state;
        const last = i === items.length - 1;
        const fill = state === "done" ? 100 : state === "progress" ? Math.round(w.credit * 100) : 0;
        return (
          <li key={w.key} className="relative pb-3 last:pb-0 @2xl/hero:pb-0">
            {!last && (
              <span aria-hidden className="pointer-events-none absolute -bottom-1 left-[1.34rem] top-[2.75rem] w-px bg-line @2xl/hero:bottom-auto @2xl/hero:left-1/2 @2xl/hero:top-[1.375rem] @2xl/hero:h-px @2xl/hero:w-full">
                <span className={cn("absolute left-0 top-0 block h-[var(--f)] w-full bg-gradient-to-b from-accent to-accent-2 @2xl/hero:h-full @2xl/hero:w-[var(--f)] @2xl/hero:bg-gradient-to-r",
                  w.live && "sweep")} style={{ "--f": `${fill}%` } as CSSProperties} />
              </span>
            )}
            <Link to={`/p/${w.to}`} aria-label={`${w.label}: ${word(w)}`}
              className="group/node relative z-10 flex items-start gap-3 rounded-lg p-1 outline-none transition-colors hover:bg-hover/50 focus-visible:ring-2 focus-visible:ring-accent/50 @2xl/hero:flex-col @2xl/hero:items-center @2xl/hero:gap-2 @2xl/hero:px-1.5">
              <span className={cn("relative grid size-9 shrink-0 place-items-center rounded-lg border bg-panel transition-[border-color,box-shadow] group-hover/node:border-accent/60", CHIP[state],
                w.current && "shadow-[0_0_18px_-4px_var(--color-accent)]", w.live && "gen-ring")}>
                <Icon className="size-4" />
                {state === "done" && (
                  <span aria-hidden className="absolute -right-1 -top-1 grid size-3.5 place-items-center rounded-full bg-ok text-[var(--on-accent)] ring-2 ring-panel"><Check className="size-2.5" strokeWidth={3.5} /></span>
                )}
                {state === "progress" && <span aria-hidden className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-accent ring-2 ring-panel" />}
              </span>
              <span className="min-w-0 flex-1 @2xl/hero:w-full @2xl/hero:flex-none @2xl/hero:text-center">
                <span className={cn("block truncate text-sm font-medium @2xl/hero:text-xs", state === "todo" && !w.current ? "text-mute" : "text-ink")}>{w.label}</span>
                <span className={cn("mono mt-0.5 block text-2xs uppercase tracking-wider", WORD[state])}>{word(w)}</span>
                <span className="mt-0.5 line-clamp-2 block text-2xs leading-snug text-dim">{fallback(w)}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

export function MissionHeroSkeleton() {
  return (
    <Panel eyebrow="···" index={0} flush>
      <div className="space-y-5 p-5" aria-busy="true">
        <div className="flex items-center justify-between gap-4"><div className="space-y-3"><Skeleton className="h-7 w-72 max-w-[60vw]" /><Skeleton className="h-5 w-56" /></div><Skeleton className="size-[88px] rounded-full" /></div>
        <div className="grid grid-cols-4 gap-3 sm:grid-cols-7">{Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>
      </div>
    </Panel>
  );
}

/**
 * The hero band: which episode this is, the flight path through the pipeline, overall completion, and the one next best action.
 */
export function MissionHero({ project, episode, d, stages, action, index = 0 }: {
  project: Project; episode: Episode | undefined; d: EpisodeDashboard | undefined; stages: Record<string, Stage>; action: MissionAction | null; index?: number;
}) {
  const t = useT();
  const go = useGo(project.id);
  const keys = flightKeys(project);
  const tabs = useMemo(() => getProjectTabs(t), [t]);

  const items: Waypoint[] = keys.map((k) => {
    const tab = tabs.find((x) => x.to === k);
    return { key: k, label: tab?.label ?? k, icon: tab?.icon ?? Gauge, stage: stages[k] ?? { state: "todo" as StageState }, credit: stageCredit(k, stages[k], project, episode),
      current: false, live: (k === "storyboard" && (d?.shots.generating ?? 0) > 0) || (k === "export" && (d?.queue.renders ?? 0) > 0), to: `${project.id}/${flightTab(project, k)}` };
  });
  const now = items.findIndex((w) => w.stage.state !== "done");
  if (now >= 0) items[now].current = true;

  const done = items.filter((w) => w.stage.state === "done").length;
  const active = items.filter((w) => w.stage.state === "progress").length;
  const completion = items.length ? items.reduce((a, w) => a + w.credit, 0) / items.length : 0;
  const pct = Math.round(completion * 100);
  const allDone = items.length > 0 && done === items.length;

  const series = project.type === "series" || episode?.kind === "cutdown";
  const number = episode?.number ?? d?.number;
  const title = episode?.title || d?.title || (series ? "" : project.title) || t("Untitled");
  const status = d?.status ?? episode?.status;
  const running = (d?.queue.active_jobs ?? 0) > 0;
  const planned = d?.footage.planned_s ?? 0;

  return (
    <Panel index={index} tone="accent" flush eyebrow={t("Mission control")} icon={<Gauge />}
      actions={running ? (
        <span className="mono inline-flex items-center gap-2 text-2xs uppercase tracking-wider text-accent-ink">
          <span className="eq"><i /><i /><i /><i /></span>{t("{n} running", { n: d?.queue.active_jobs ?? 0 })}
        </span>
      ) : (
        <span className="mono inline-flex items-center gap-2 text-2xs uppercase tracking-wider text-dim"><span className="live-dot is-idle" />{t("Idle")}</span>
      )}>
      <div className="@container/hero relative">
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-b-xl">
          <div className="absolute -right-24 -top-24 size-80 rounded-full bg-accent/[0.06] blur-3xl" />
          <div className="absolute -bottom-32 left-1/3 size-72 rounded-full bg-accent-2/[0.05] blur-3xl" />
        </div>

        <div className="relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-3 px-4 pt-3 @2xl/hero:px-5">
          <h1 className="min-w-0 self-end text-balance text-2xl font-semibold leading-tight tracking-tight @2xl/hero:text-[1.7rem]">
            {series && number !== undefined && <><span className="mono text-accent-ink">E{String(number).padStart(2, "0")}</span><span className="mx-2 text-dim">·</span></>}
            {title}
          </h1>

          <div className="row-span-2 flex items-center gap-4 self-center" role="group" aria-label={t("Overall completion")}>
            <div className="hidden text-right sm:block">
              <p className="eyebrow">{t("Completion")}</p>
              <p className="mono mt-1.5 text-sm text-mute"><span className="text-ink">{done}</span> / {items.length} {t("stages")}</p>
              <p className="mt-0.5 text-2xs text-dim">{active > 0 ? t("{n} in progress", { n: active }) : allDone ? t("All stages done") : t("Nothing in progress")}</p>
            </div>
            <ProgressRing value={completion} size={88} stroke={5} tone={allDone ? "var(--color-ok)" : "var(--color-accent)"}>
              <span className={cn("mono text-xl font-semibold leading-none tracking-tight", allDone ? "text-ok" : "text-gradient")}>{pct}<span className="ml-px text-xs">%</span></span>
            </ProgressRing>
          </div>

          <div className="flex min-w-0 flex-wrap content-start items-center gap-1.5 self-start">
            {status && <Badge tone={EPISODE_TONE[status] ?? "neutral"} dot className="capitalize">{t(status.replaceAll("_", " "))}</Badge>}
            {episode?.season !== undefined && series && <Tag k={t("Season")}>{episode.season}</Tag>}
            <Tag k={t("Lang")}>{project.languages.map((l) => LANG_SHORT[l] ?? l).join(" ")}</Tag>
            <Tag k={t("Aspect")}>{project.aspect}</Tag>
            {planned > 0 && <Tag k={t("Runtime")}>{secs(planned)}</Tag>}
          </div>
        </div>

        <div className="relative px-3 pb-4 pt-5 @2xl/hero:px-4">
          <p className="eyebrow mb-3 flex items-center gap-2 px-1.5">{t("Flight path")}<span aria-hidden className="h-px flex-1 bg-line" /></p>
          <FlightPath items={items} />
        </div>

        {action && (
          <div role="status" className={cn("relative flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line bg-gradient-to-r to-transparent px-4 py-3 @2xl/hero:px-5", WASH[action.tone])}>
            <div className="min-w-0 flex-1 basis-72">
              <p className={cn("eyebrow flex items-center gap-1.5", TEXT[action.tone])}>
                <ArrowRight className="size-3" />{t("Next best action")}<span aria-hidden className="text-dim">/</span>{action.kicker}
              </p>
              <p className="mt-1.5 text-sm leading-snug">{action.text}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => openDirector()} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-ai transition-colors hover:bg-ai/10 max-sm:hidden">
                <Bot className="size-4" />{t("Ask the Director")}
              </button>
              {action.secondary && <Button variant="ghost" onClick={() => go(action.secondary!.go)}>{action.secondary.label}</Button>}
              <Button variant="primary" iconRight={<ArrowRight className="size-4" />} onClick={() => go(action.go)}>{action.label}</Button>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
