import { clsx } from "clsx";
import {
  Activity, Bot, Check, ChevronDown, ChevronLeft, Compass, Ellipsis, FileText, Gauge, Keyboard, ListOrdered, Plus, Search, SlidersHorizontal,
} from "lucide-react";
import { motion } from "motion/react";
import { Fragment } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MOD } from "../../components/shell/keys";
import type { ProjectArea } from "../../components/shell/nav";
import { PresenceBar } from "../../components/shell/PresenceBar";
import { NotificationsButton } from "../../components/shell/telemetry";
import { UserMenu } from "../../components/shell/UserMenu";
import { IconButton, Menu, ScrollStrip, Select, Tooltip } from "../../components/ui";
import { LANG_SHORT, usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useAuthStatus } from "../../lib/queries";
import { useUI } from "../../lib/store";
import type { Episode, Project } from "../../lib/types";
import { useProjectCtx } from "./context";
import type { StepView } from "./flow";
import type { StageState } from "./pipeline";
import { SegmentedLinks } from "./StepBar";

export interface HeaderProps {
  project: Project; episode?: Episode; pid: number; episodes: Episode[];
  /** The steps shown in the stepper (own-material projects may leave out Story), numbered as shown. */
  steps: StepView[];
  /** Where the open page belongs, and the page itself. */
  area?: ProjectArea; tab: string;
  title: string; onTitle: (v: string) => void; onSaveTitle: () => void; onAddEpisode: () => void;
  /** Whether the Director is on screen, and how the button opens or closes it. */
  directorOpen: boolean; onToggleDirector: () => void;
  /** Own-material projects: whether the Story step is shown, and the switch ("⋯" menu). */
  story?: { shown: boolean; set: (on: boolean) => void };
}

/** A step's number in a circle: a tick once it is done, accent while it is under way or open. */
function StepBadge({ n, state, active }: { n: number; state: StageState; active?: boolean }) {
  return (
    <span className={clsx("mono relative z-[1] grid size-5 shrink-0 place-items-center rounded-full border text-2xs font-semibold transition-colors",
      state === "done" ? "border-ok/40 bg-ok/15 text-ok"
        : active ? "border-accent/60 bg-accent/15 text-accent-ink"
        : state === "progress" ? "border-accent/45 bg-panel text-accent-ink"
        : "border-line bg-panel text-mute")}>
      {state === "done" ? <Check className="size-3" strokeWidth={3} /> : n}
    </span>
  );
}

/** 1 Story · 2 Cast · 3 Shots · 4 Edit · 5 Deliver: where you are, how far each step got, one click to any of them. */
function Stepper({ pid, steps, area }: { pid: number; steps: StepView[]; area?: ProjectArea }) {
  const t = useT();
  return (
    <ScrollStrip className="min-w-0" follow='[aria-current="step"]' role="navigation" aria-label={t("Project steps")}>
      <ol className="flex items-center">
        {steps.map((s, i) => {
          const on = area === s.id;
          return (
            <Fragment key={s.id}>
              {i > 0 && <li aria-hidden className={clsx("mx-0.5 h-px w-2.5 shrink-0", s.stage.state === "done" || steps[i - 1].stage.state === "done" ? "bg-ok/40" : "bg-line")} />}
              <li className="shrink-0">
                <Tooltip content={[s.blurb, s.stage.hint].filter(Boolean).join(" · ")} side="bottom" delay={500}>
                  <Link to={`/p/${pid}/${s.to}`} data-tour={`step-${s.id}`} aria-current={on ? "step" : undefined} aria-label={t("Step {n}: {label}", { n: i + 1, label: s.label })}
                    className={clsx("relative flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50 max-sm:h-10 max-sm:min-w-10 max-sm:justify-center",
                      on ? "text-ink" : "text-mute hover:bg-hover hover:text-ink")}>
                    {on && (
                      <motion.span layoutId={`stepper-${pid}`} transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.7 }}
                        className="absolute inset-0 rounded-lg border border-accent/30 bg-accent/10" />
                    )}
                    <StepBadge n={i + 1} state={s.stage.state} active={on} />
                    <span className={clsx("relative", !on && "sr-only @min-[80rem]:not-sr-only")}>{s.label}</span>
                  </Link>
                </Tooltip>
              </li>
            </Fragment>
          );
        })}
      </ol>
    </ScrollStrip>
  );
}

/**
 * The project's "⋯" menu: the pages that are not steps (Overview, the brief, the activity log), search and help, and for
 * projects made from your own material whether the Story step shows.
 */
export function ProjectMenu({ pid, area, story }: { pid: number; area?: ProjectArea; story?: HeaderProps["story"] }) {
  const t = useT();
  const nav = useNavigate();
  const startTour = useUI((s) => s.startTour);
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);
  const setShortcutsOpen = useUI((s) => s.setShortcutsOpen);
  return (
    <Menu placement="bottom-end" width={240} items={[
      { label: t("Overview"), icon: <Gauge className="size-4" />, active: area === "home", onClick: () => nav(`/p/${pid}/dashboard`) },
      { label: t("Brief & format"), icon: <FileText className="size-4" />, onClick: () => nav(`/p/${pid}/brief`) },
      { label: t("Activity log"), icon: <Activity className="size-4" />, active: area === "log", onClick: () => nav(`/p/${pid}/activity`) },
      story ? { label: story.shown ? t("Hide the Story step") : t("Show the Story step (write with AI)"), icon: <ListOrdered className="size-4" />,
        separator: true, onClick: () => story.set(!story.shown) } : null,
      { label: t("Search everything"), icon: <Search className="size-4" />, shortcut: `${MOD} K`, separator: true, onClick: () => setPaletteOpen(true) },
      { label: t("Keyboard shortcuts"), icon: <Keyboard className="size-4" />, shortcut: "?", onClick: () => setShortcutsOpen(true) },
      { label: t("Take the tour"), icon: <Compass className="size-4" />, onClick: () => startTour() },
    ]} trigger={(tp) => (
      <Tooltip content={t("Project menu")} side="bottom">
        <button type="button" {...tp} aria-label={t("Project menu")}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-mute transition-colors hover:bg-hover hover:text-ink max-sm:size-10">
          <Ellipsis className="size-4" />
        </button>
      </Tooltip>
    )} />
  );
}

/** The working language as a small segmented switch (★ marks the project's main language). */
function Languages({ project, className }: { project: Project; className?: string }) {
  const t = useT();
  const ctx = useProjectCtx();
  if (project.languages.length < 2) return null;
  return (
    <div className={clsx("flex shrink-0 rounded-md border border-line bg-raised/50 p-0.5", className)} role="radiogroup" aria-label={t("Working language")}>
      {project.languages.map((l) => (
        <button key={l} role="radio" aria-checked={ctx.lang === l} onClick={() => ctx.setLang(l)}
          className={clsx("mono relative h-6 rounded px-1.5 text-2xs font-medium transition-colors max-sm:h-9 max-sm:min-w-9", ctx.lang === l ? "text-[var(--on-accent)]" : "text-mute hover:text-ink")}>
          {ctx.lang === l && <motion.span layoutId={`hdr-lang-${project.id}`} className="absolute inset-0 rounded bg-accent" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
          <span className="relative">{LANG_SHORT[l]}{l === project.primary_language ? "★" : ""}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The one header of every project screen (48 px on laptops): back home, the title (and episode, language), the steps as a
 * compact stepper, the open step's views (writers' and specialists' tools under "Advanced"), what the project has spent,
 * search, the Director, the "⋯" menu and your account. On phones it wraps to a second row for the steps.
 */
export function ProjectHeader(p: HeaderProps) {
  const t = useT();
  const ctx = useProjectCtx();
  const { data: auth } = useAuthStatus();
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);
  const { project, pid, episodes } = p;
  const open = p.steps.find((s) => s.id === p.area);
  const main = open ? open.tabs.filter((x) => !x.advanced || x.to === p.tab) : [];
  const advanced = open ? open.tabs.filter((x) => x.advanced && x.to !== p.tab) : [];
  const nav = useNavigate();
  return (
    <header className="@container relative z-30 shrink-0 border-b border-line bg-panel/85 backdrop-blur-xl" aria-label={t("Project")}>
      <span aria-hidden className="edge-light pointer-events-none absolute inset-x-0 bottom-0 h-px opacity-50" />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2 py-1.5 sm:px-3 lg:h-12 lg:flex-nowrap lg:py-0">
        {/* identity: back home, title, episode, language */}
        <div className="flex min-w-0 items-center gap-1 max-lg:flex-1">
          <Tooltip content={t("Home: all projects")} side="bottom">
            <Link to="/" aria-label={t("Home: all projects")} className="grid size-8 shrink-0 place-items-center rounded-lg text-mute transition-colors hover:bg-hover hover:text-ink max-sm:size-10">
              <ChevronLeft className="size-4" />
            </Link>
          </Tooltip>
          <input value={p.title} onChange={(e) => p.onTitle(e.target.value)} onBlur={p.onSaveTitle}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} disabled={!ctx.canEdit} aria-label={t("Project title")} title={p.title}
            className="w-44 min-w-16 truncate rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[0.95rem] font-semibold tracking-tight outline-none transition-colors hover:border-line focus:border-accent/60 focus:bg-raised disabled:hover:border-transparent max-lg:flex-1 max-sm:h-10 lg:@max-[72rem]:w-28 @min-[96rem]:w-56" />
          {(episodes.length > 1 || project.type === "series") && (
            <>
              <Select value={ctx.eid} onChange={(e) => ctx.setEpisode(Number(e.target.value))} className="h-8 w-auto max-w-[7rem] shrink-0 text-xs max-sm:h-10" aria-label={t("Episode")}>
                {episodes.map((e) => (
                  <option key={e.id} value={e.id}>{e.kind === "cutdown" ? "✂ " : ""}{project.type === "series" || e.kind === "cutdown" ? `E${String(e.number).padStart(2, "0")} · ` : ""}{e.title || t("Untitled")}</option>
                ))}
              </Select>
              {ctx.canEdit && project.type === "series" && <span className="max-sm:hidden"><IconButton title={t("Add episode")} onClick={p.onAddEpisode}><Plus className="size-4" /></IconButton></span>}
            </>
          )}
          <Languages project={project} />
        </div>

        <span aria-hidden className="hidden h-6 w-px shrink-0 bg-line lg:block" />

        {/* the steps, then the open step's views */}
        <div className="flex min-w-0 items-center gap-1.5 max-lg:order-last max-lg:basis-full lg:shrink">
          <Tooltip content={t("Overview")} side="bottom">
            <Link to={`/p/${pid}/dashboard`} aria-label={t("Overview")} aria-current={p.area === "home" ? "page" : undefined}
              className={clsx("grid size-8 shrink-0 place-items-center rounded-lg transition-colors max-sm:size-10",
                p.area === "home" ? "bg-accent/10 text-accent-ink ring-1 ring-accent/30" : "text-mute hover:bg-hover hover:text-ink")}>
              <Gauge className="size-4" />
            </Link>
          </Tooltip>
          <Stepper pid={pid} steps={p.steps} area={p.area} />
          {(main.length > 1 || advanced.length > 0) && <span aria-hidden className="mx-0.5 hidden h-6 w-px shrink-0 bg-line sm:block" />}
          {main.length > 1 && open && (
            <SegmentedLinks pid={pid} active={p.tab} layoutId={`views-${pid}-${open.id}`} label={t("{step} views", { step: open.label })} keepActive
              labels="hidden @min-[100rem]:inline" className="max-sm:hidden"
              items={main.map((x) => ({ key: x.to, to: x.to, label: x.label, icon: x.icon }))} />
          )}
          {main.length > 1 && open && (
            /* phones: the views as a select, so the steps keep the row */
            <Select value={p.tab} onChange={(e) => nav(`/p/${pid}/${e.target.value}`)} className="h-8 w-auto shrink-0 text-xs max-sm:h-10 sm:hidden" aria-label={t("{step} views", { step: open.label })}>
              {main.map((x) => <option key={x.to} value={x.to}>{x.label}</option>)}
            </Select>
          )}
          {advanced.length > 0 && (
            <Menu placement="bottom-start" width={232} items={advanced.map((x) => ({
              label: x.label, icon: <x.icon className="size-4" />, onClick: () => nav(`/p/${pid}/${x.to}`),
            }))} trigger={(tp) => (
              <Tooltip content={t("Tools for writers and specialists")} side="bottom">
                <button type="button" {...tp} className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-mute transition-colors hover:bg-hover hover:text-ink max-sm:h-10 max-sm:min-w-10 max-sm:justify-center">
                  <SlidersHorizontal className="size-3.5" /><span className="sr-only @min-[80rem]:not-sr-only">{t("Advanced")}</span><ChevronDown className="size-3" />
                </button>
              </Tooltip>
            )} />
          )}
        </div>

        <span aria-hidden className="flex-1 max-lg:hidden" />

        {/* who else is here, spend, search, the Director, the menu, notifications and the account */}
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="hidden @min-[100rem]:block"><PresenceBar projectId={pid} shotCode={(id) => p.episode?.shots?.find((s) => s.id === id)?.code} /></span>
          <Tooltip content={t("Spent on this project")} side="bottom">
            <Link to="/costs" className="mono hidden rounded-md border border-line bg-raised/50 px-1.5 py-0.5 text-2xs text-money transition-colors hover:border-money/40 max-lg:sm:inline @min-[72rem]:inline">{usd(project.spent_usd)}</Link>
          </Tooltip>
          <IconButton title={`${t("Search")} (${MOD}+K)`} tipSide="bottom" onClick={() => setPaletteOpen(true)} className="max-sm:hidden"><Search className="size-4" /></IconButton>
          <Tooltip content={`${t("Director")} (${MOD}+J)`} side="bottom">
            <button data-tour="director" onClick={p.onToggleDirector} aria-pressed={p.directorOpen} aria-label={t("Director")}
              className={clsx("flex h-8 items-center gap-1.5 rounded-lg border px-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ai/50 max-sm:h-10 max-sm:px-3",
                p.directorOpen ? "border-ai/40 bg-ai/12 text-ai" : "border-line bg-raised/60 text-mute hover:border-ai/40 hover:text-ai")}>
              <Bot className="size-4 shrink-0" />
              <span className="hidden text-sm font-medium @min-[72rem]:inline">{t("Director")}</span>
            </button>
          </Tooltip>
          <ProjectMenu pid={pid} area={p.area} story={p.story} />
          <span className="hidden @min-[72rem]:block"><NotificationsButton /></span>
          {auth?.user && <UserMenu user={auth.user} expanded={false} placement="bottom-end" dense />}
        </div>
      </div>
    </header>
  );
}
