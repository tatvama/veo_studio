import { clsx } from "clsx";
import {
  ArrowRight, Bot, Check, ChevronLeft, ChevronsLeft, ChevronsRight, CirclePause, Clapperboard, Compass, Ellipsis, FileText, Gauge, History, Lightbulb,
  ListOrdered, Plus, Rocket, X,
} from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { isTypingTarget, MOD, TOGGLE_RAIL_EVENT } from "../../components/shell/keys";
import type { ProjectArea } from "../../components/shell/nav";
import { PresenceBar } from "../../components/shell/PresenceBar";
import { Badge, IconButton, Menu, ScrollStrip, Select, Tooltip, type Placement } from "../../components/ui";
import { LANG_SHORT, usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useUI } from "../../lib/store";
import type { Episode, Project } from "../../lib/types";
import { useProjectCtx } from "./context";
import type { StepView } from "./flow";
import type { NextStep } from "./nextStep";
import type { StageState } from "./pipeline";

const COLLAPSE_KEY = "veo:pipeRail";

/** A step's number in a circle: a tick once it is done, accent while it is under way or open. */
function StepBadge({ n, state, active, small }: { n: number; state: StageState; active?: boolean; small?: boolean }) {
  return (
    <span className={clsx("mono relative z-[1] grid shrink-0 place-items-center rounded-full border font-semibold transition-colors",
      small ? "size-5 text-2xs" : "size-7 text-xs",
      state === "done" ? "border-ok/40 bg-ok/15 text-ok"
        : active ? "border-accent/60 bg-accent/15 text-accent-ink"
        : state === "progress" ? "border-accent/45 bg-panel text-accent-ink"
        : "border-line bg-panel text-mute",
      active && state === "done" && "ring-2 ring-accent/35")}>
      {state === "done" ? <Check className={small ? "size-3" : "size-3.5"} strokeWidth={3} /> : n}
    </span>
  );
}

/** The highlight behind the open item; it glides between items. */
function ActivePill({ pid }: { pid: number }) {
  return (
    <motion.span layoutId={`pipe-active-${pid}`} transition={{ type: "spring", stiffness: 520, damping: 40 }}
      className="absolute inset-0 rounded-lg border border-accent/25 bg-gradient-to-r from-accent/15 via-accent/5 to-transparent">
      <span className="absolute -left-px bottom-2 top-2 w-[3px] rounded-r-full bg-accent shadow-[0_0_10px_var(--color-accent)]" />
    </motion.span>
  );
}

const itemCls = (active: boolean, collapsed: boolean) => clsx(
  "group relative flex items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50",
  collapsed ? "mx-auto size-9 justify-center" : "gap-2.5 pl-2 pr-2.5",
  active ? "text-ink" : "text-mute hover:bg-hover/70 hover:text-ink",
);

function HomeItem({ pid, active, collapsed }: { pid: number; active: boolean; collapsed: boolean }) {
  const t = useT();
  return (
    <Tooltip content={t("Overview")} side="right" delay={collapsed ? 150 : 700}>
      <Link to={`/p/${pid}/dashboard`} aria-current={active ? "page" : undefined} aria-label={collapsed ? t("Overview") : undefined}
        className={clsx(itemCls(active, collapsed), !collapsed && "h-9")}>
        {active && <ActivePill pid={pid} />}
        <span className={clsx("relative z-[1] grid size-7 shrink-0 place-items-center rounded-md border bg-panel transition-colors",
          active ? "border-accent/50 bg-accent/10 text-accent-ink" : "border-line text-mute")}>
          <Gauge className="size-4" />
        </span>
        {!collapsed && <span className="relative min-w-0 flex-1 truncate text-sm font-medium">{t("Overview")}</span>}
      </Link>
    </Tooltip>
  );
}

function StepItem({ s, pid, active, collapsed }: { s: StepView; pid: number; active: boolean; collapsed: boolean }) {
  const t = useT();
  const pages = s.tabs.map((x) => x.label).join(" · ");
  const tip = collapsed ? [`${s.n}. ${s.label}`, s.stage.hint ?? pages].join(" · ") : s.stage.hint;
  return (
    <li>
      <Tooltip content={tip} side="right" delay={collapsed ? 150 : 700} disabled={!tip}>
        <Link to={`/p/${pid}/${s.to}`} data-tour={`step-${s.id}`} aria-current={active ? "step" : undefined}
          aria-label={collapsed ? t("Step {n}: {label}", { n: s.n, label: s.label }) : undefined}
          className={clsx(itemCls(active, collapsed), !collapsed && "min-h-11 py-1")}>
          {active && <ActivePill pid={pid} />}
          <StepBadge n={s.n} state={s.stage.state} active={active} />
          {!collapsed && (
            <span className="relative min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{s.label}</span>
              <span className="block truncate text-2xs text-dim">{pages}</span>
            </span>
          )}
        </Link>
      </Tooltip>
    </li>
  );
}

/**
 * The project's "⋯" menu: the pages that are not steps. In the focused shot workspace it also leads to the Overview and the
 * brief (format, languages, quality, budget); for own-material projects it switches between that workspace and the five steps.
 */
export function ProjectMenu({ pid, area, placement, side, focus }: {
  pid: number; area?: ProjectArea; placement: Placement; side: "right" | "bottom"; focus?: FocusSwitch;
}) {
  const t = useT();
  const nav = useNavigate();
  const startTour = useUI((s) => s.startTour);
  return (
    <Menu placement={placement} width={224} items={[
      ...(focus?.on ? [
        { label: t("Overview"), icon: <Gauge className="size-4" />, active: area === "home", onClick: () => nav(`/p/${pid}/dashboard`) },
        { label: t("Brief & format"), icon: <FileText className="size-4" />, active: area === "story", onClick: () => nav(`/p/${pid}/brief`) },
      ] : []),
      { label: t("Activity log"), icon: <History className="size-4" />, active: area === "log", onClick: () => nav(`/p/${pid}/activity`) },
      ...(focus ? [focus.on
        ? { label: t("Show all five steps"), icon: <ListOrdered className="size-4" />, onClick: () => focus.set(false) }
        : { label: t("Shot-by-shot view"), icon: <Clapperboard className="size-4" />, onClick: () => focus.set(true) }] : []),
      { label: t("Take the tour"), icon: <Compass className="size-4" />, onClick: () => startTour() },
    ]} trigger={(tp) => (
      <Tooltip content={t("Project menu")} side={side}>
        <button type="button" {...tp} aria-label={t("Project menu")}
          className="grid size-7 shrink-0 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink">
          <Ellipsis className="size-4" />
        </button>
      </Tooltip>
    )} />
  );
}

/** Own-material projects: whether the focused shot workspace is on, and the switch between it and the five steps. */
export interface FocusSwitch { on: boolean; set: (on: boolean) => void }

export interface RailProps {
  project: Project; episode?: Episode; pid: number; episodes: Episode[];
  /** The five steps with this project's pages, progress and links; `area` is where the open page belongs. */
  steps: StepView[]; area?: ProjectArea;
  step: NextStep | null; showStep: boolean; onHideStep: () => void;
  title: string; onTitle: (v: string) => void; onSaveTitle: () => void; onAddEpisode: () => void;
  autopilot: { running: boolean; paused: boolean; label: string };
  /** Whether the Director panel is on screen right now, and how the buttons open or close it. */
  directorOpen: boolean; onToggleDirector: () => void;
  focus?: FocusSwitch;
}

/**
 * The project's spine: identity and controls on top, then the Overview and the five numbered steps, and the next step plus
 * the Director pinned at the bottom. Collapses to icons; the choice is remembered.
 */
export function PipelineRail(p: RailProps) {
  const t = useT();
  const ctx = useProjectCtx();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* storage blocked */ } }, [collapsed]);
  useEffect(() => {
    const toggle = () => setCollapsed((v) => !v);
    const key = (e: KeyboardEvent) => { if (e.key === "[" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) { e.preventDefault(); toggle(); } };
    window.addEventListener(TOGGLE_RAIL_EVENT, toggle);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener(TOGGLE_RAIL_EVENT, toggle); window.removeEventListener("keydown", key); };
  }, []);
  const { project, pid, episodes } = p;
  const lang = ctx.lang;
  const counted = p.steps.filter((s) => s.stage.state !== "none");
  const done = counted.filter((s) => s.stage.state === "done").length;

  const director = (
    <Tooltip content={`${t("Director")} (${MOD}+J)`} side="right" disabled={!collapsed}>
      <button data-tour="director" onClick={p.onToggleDirector} aria-pressed={p.directorOpen}
        className={clsx("group flex items-center gap-2 rounded-lg border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ai/50",
          collapsed ? "mx-auto size-9 justify-center" : "h-9 w-full px-2.5",
          p.directorOpen ? "border-ai/40 bg-ai/12 text-ai" : "border-line bg-raised/60 text-mute hover:border-ai/40 hover:text-ai")}>
        <Bot className="size-4 shrink-0" />
        {!collapsed && <><span className="flex-1 text-left text-sm font-medium">{t("Director")}</span><span className="mono text-2xs text-dim">{MOD}J</span></>}
      </button>
    </Tooltip>
  );

  return (
    <aside data-pipeline-rail data-tour-rail data-collapsed={collapsed ? "1" : "0"} className={clsx("relative z-20 hidden shrink-0 flex-col border-r border-line bg-panel/70 backdrop-blur transition-[width] duration-200 ease-out lg:flex", collapsed ? "w-[3.75rem]" : "w-[15.5rem]")}
      aria-label={t("Project pipeline")}>
      {/* identity */}
      <div className={clsx("border-b border-line", collapsed ? "flex flex-col items-center gap-1.5 py-2.5" : "space-y-2.5 p-3")}>
        <div className={clsx("flex items-center gap-1", collapsed && "flex-col")}>
          <Tooltip content={t("All projects")} side="right"><Link to="/" aria-label={t("All projects")} className="grid size-7 place-items-center rounded-md text-mute transition-colors hover:bg-hover hover:text-ink"><ChevronLeft className="size-4" /></Link></Tooltip>
          {!collapsed && <span className="eyebrow flex-1">{t("Project")}</span>}
          <ProjectMenu pid={pid} area={p.area} placement={collapsed ? "right-start" : "bottom-end"} side="right" focus={p.focus} />
          <Tooltip content={collapsed ? t("Expand pipeline") : t("Collapse pipeline")} side="right">
            <button onClick={() => setCollapsed((v) => !v)} aria-label={collapsed ? t("Expand pipeline") : t("Collapse pipeline")}
              className="grid size-7 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink">
              {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
            </button>
          </Tooltip>
        </div>
        {!collapsed ? (
          <>
            <input value={p.title} onChange={(e) => p.onTitle(e.target.value)} onBlur={p.onSaveTitle}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} disabled={!ctx.canEdit} aria-label={t("Project title")} title={p.title}
              className="w-full truncate rounded-md border border-transparent bg-transparent px-1.5 py-1 text-base font-semibold tracking-tight outline-none transition-colors hover:border-line focus:border-accent/60 focus:bg-raised disabled:hover:border-transparent" />
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="accent" className="capitalize">{project.type}</Badge>
              <Badge>{project.aspect}</Badge>
              {p.autopilot.running && <Link to={`/p/${pid}/brief`}><Badge tone="info" className="pulse-ring"><Rocket className="size-3" />{t("Autopilot")}: {p.autopilot.label}</Badge></Link>}
              {p.autopilot.paused && <Link to={`/p/${pid}/brief`}><Badge tone="warn"><CirclePause className="size-3" />{t("Autopilot waiting")}</Badge></Link>}
            </div>
            {(episodes.length > 1 || project.type === "series") && (
              <div className="flex items-center gap-1.5">
                <Select value={ctx.eid} onChange={(e) => ctx.setEpisode(Number(e.target.value))} className="h-8 min-w-0 flex-1 text-xs" aria-label={t("Episode")}>
                  {episodes.map((e) => (
                    <option key={e.id} value={e.id}>{e.kind === "cutdown" ? "✂ " : ""}{project.type === "series" || e.kind === "cutdown" ? `E${String(e.number).padStart(2, "0")} · ` : ""}{e.title || t("Untitled")}</option>
                  ))}
                </Select>
                {ctx.canEdit && project.type === "series" && <IconButton title={t("Add episode")} onClick={p.onAddEpisode}><Plus className="size-4" /></IconButton>}
              </div>
            )}
            <div className="flex rounded-md border border-line bg-raised/50 p-0.5" role="radiogroup" aria-label={t("Working language")}>
              {project.languages.map((l) => (
                <button key={l} role="radio" aria-checked={lang === l} onClick={() => ctx.setLang(l)}
                  className={clsx("mono relative h-6 flex-1 rounded px-1.5 text-2xs font-medium transition-colors", lang === l ? "text-[var(--on-accent)]" : "text-mute hover:text-ink")}>
                  {lang === l && <motion.span layoutId={`proj-lang-${pid}`} className="absolute inset-0 rounded bg-accent shadow-[0_0_10px_-2px_var(--color-accent)]" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
                  <span className="relative">{LANG_SHORT[l]}{l === project.primary_language ? "★" : ""}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2">
              <PresenceBar projectId={pid} shotCode={(id) => p.episode?.shots?.find((s) => s.id === id)?.code} />
              <Tooltip content={t("Spent on this project")} side="right"><span className="mono rounded-md border border-line bg-raised/50 px-1.5 py-0.5 text-2xs text-money">{usd(project.spent_usd)}</span></Tooltip>
            </div>
          </>
        ) : (
          <Tooltip content={project.title} side="right">
            <span className="hud grid size-9 place-items-center rounded-lg border border-accent/25 bg-accent/10 text-sm font-semibold text-accent-ink">{(project.title || "?").trim().charAt(0).toUpperCase()}</span>
          </Tooltip>
        )}
      </div>

      {/* the overview, then the five steps */}
      <nav aria-label={t("Project steps")} className="no-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 py-2">
        <HomeItem pid={pid} active={p.area === "home"} collapsed={collapsed} />
        {!collapsed ? (
          <header className="flex items-center gap-2 px-2 pb-1 pt-3">
            <span className="eyebrow">{t("Steps")}</span>
            <span aria-hidden className="h-px flex-1 bg-line" />
            {counted.length > 0 && <span className="mono text-2xs text-dim">{done}/{counted.length}</span>}
          </header>
        ) : <span aria-hidden className="mx-auto my-2 block h-px w-6 bg-line" />}
        <ol className="relative flex flex-col gap-0.5">
          {!collapsed && <span aria-hidden className="absolute bottom-[22px] left-[21.5px] top-[22px] w-px bg-line" />}
          {p.steps.map((s) => <StepItem key={s.id} s={s} pid={pid} active={p.area === s.id} collapsed={collapsed} />)}
        </ol>
      </nav>

      {/* next step + director */}
      <div className={clsx("space-y-2 border-t border-line", collapsed ? "py-2.5" : "p-3")}>
        {!collapsed && p.step && p.showStep && (
          <div role="status" className={clsx("hud relative rounded-lg border p-2.5 text-xs",
            p.step.tone === "warn" ? "border-warn/30 bg-warn/8" : p.step.tone === "info" ? "border-info/25 bg-info/8" : p.step.tone === "ok" ? "border-ok/25 bg-ok/8" : "border-accent/25 bg-accent/6")}>
            <button type="button" onClick={p.onHideStep} aria-label={t("Hide this tip")} className="absolute right-1 top-1 grid size-5 place-items-center rounded text-dim transition-colors hover:bg-hover hover:text-ink"><X className="size-3" /></button>
            <p className="eyebrow mb-1.5 flex items-center gap-1.5 !text-accent-ink">{p.step.tone === "warn" ? <CirclePause className="size-3" /> : p.step.tone === "info" ? <Rocket className="size-3" /> : <Lightbulb className="size-3" />}{t("Next step")}</p>
            <p className="pr-4 leading-snug text-ink">{p.step.text}</p>
            <Link to={`/p/${pid}/${p.step.tab}`} className="mt-2 inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-xs font-semibold text-[var(--on-accent)] shadow-[0_0_14px_-4px_var(--color-accent)] transition-[filter] hover:brightness-110">
              {p.step.action}<ArrowRight className="size-3.5" />
            </Link>
          </div>
        )}
        {director}
      </div>
    </aside>
  );
}

/** Below 1024 px there is no room for the rail: a compact title row and a scrolling strip of the steps instead. */
export function PipelineStrip(p: RailProps) {
  const t = useT();
  const ctx = useProjectCtx();
  const chip = (on: boolean) => clsx("flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50",
    on ? "border-accent/40 bg-accent/12 text-accent-ink" : "border-transparent text-mute hover:bg-hover hover:text-ink");
  return (
    <header className="shrink-0 border-b border-line bg-panel/80 backdrop-blur lg:hidden">
      <div className="flex items-center gap-2 px-3 pt-2">
        <Link to="/" aria-label={t("All projects")} className="grid size-7 shrink-0 place-items-center rounded-md text-mute hover:bg-hover hover:text-ink"><ChevronLeft className="size-4" /></Link>
        <input value={p.title} onChange={(e) => p.onTitle(e.target.value)} onBlur={p.onSaveTitle} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          disabled={!ctx.canEdit} aria-label={t("Project title")} className="min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-1.5 py-1 text-base font-semibold tracking-tight outline-none focus:border-accent/60 focus:bg-raised" />
        {p.episodes.length > 1 && (
          <Select value={ctx.eid} onChange={(e) => ctx.setEpisode(Number(e.target.value))} className="h-8 w-24 text-xs" aria-label={t("Episode")}>
            {p.episodes.map((e) => <option key={e.id} value={e.id}>E{String(e.number).padStart(2, "0")}</option>)}
          </Select>
        )}
        <div className="flex rounded-md border border-line bg-raised/50 p-0.5" role="radiogroup" aria-label={t("Working language")}>
          {p.project.languages.map((l) => (
            <button key={l} role="radio" aria-checked={ctx.lang === l} onClick={() => ctx.setLang(l)}
              className={clsx("mono h-6 rounded px-1.5 text-2xs font-medium", ctx.lang === l ? "bg-accent text-[var(--on-accent)]" : "text-mute")}>{LANG_SHORT[l]}</button>
          ))}
        </div>
        <ProjectMenu pid={p.pid} area={p.area} placement="bottom-end" side="bottom" focus={p.focus} />
        <IconButton data-tour="director" title={t("Director")} active={p.directorOpen} onClick={p.onToggleDirector}><Bot className="size-4" /></IconButton>
      </div>
      <ScrollStrip className="px-2 pb-1.5 pt-1.5" aria-label={t("Project steps")} role="navigation">
        <div className="flex items-center gap-1">
          <Link to={`/p/${p.pid}/dashboard`} aria-current={p.area === "home" ? "page" : undefined} aria-label={t("Overview")} title={t("Overview")} className={chip(p.area === "home")}>
            <Gauge className="size-4" />
          </Link>
          {p.steps.map((s) => {
            const on = p.area === s.id;
            return (
              <Link key={s.id} to={`/p/${p.pid}/${s.to}`} data-tour={`step-${s.id}`} aria-current={on ? "page" : undefined}
                title={s.stage.hint} className={chip(on)}>
                <StepBadge n={s.n} state={s.stage.state} active={on} small />{s.label}
              </Link>
            );
          })}
        </div>
      </ScrollStrip>
    </header>
  );
}
