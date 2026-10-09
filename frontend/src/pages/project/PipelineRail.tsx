import { clsx } from "clsx";
import {
  ArrowRight, Bot, Check, ChevronLeft, ChevronsLeft, ChevronsRight, CirclePause, Lightbulb, ListChecks, ListMinus, Plus, Rocket, X,
} from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { isTypingTarget, MOD, TOGGLE_RAIL_EVENT } from "../../components/shell/keys";
import { PresenceBar } from "../../components/shell/PresenceBar";
import { getProjectPhases, type ProjectTab } from "../../components/shell/nav";
import { Badge, IconButton, ScrollStrip, Select, Tooltip } from "../../components/ui";
import { LANG_SHORT, usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useUI } from "../../lib/store";
import type { Episode, Project } from "../../lib/types";
import { useProjectCtx } from "./context";
import type { NextStep } from "./nextStep";
import type { Stage, StageState } from "./pipeline";

const COLLAPSE_KEY = "veo:pipeRail";

/** The status mark at the end of a stage row. */
export function StageMark({ state }: { state: StageState }) {
  if (state === "none") return null;
  if (state === "done") return <span className="grid size-4 shrink-0 place-items-center rounded-full bg-ok/15 text-ok"><Check className="size-2.5" strokeWidth={3} /></span>;
  if (state === "progress") return <span className="size-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_22%,transparent)]" />;
  return <span className="size-1.5 shrink-0 rounded-full border border-dim/70" />;
}

const chipTone: Record<StageState, string> = {
  done: "border-ok/30 text-ok", progress: "border-accent/40 text-accent-ink", todo: "border-line text-mute", none: "border-line text-mute",
};

function PipeItem({ tab, pid, stage, collapsed }: { tab: ProjectTab; pid: number; stage?: Stage; collapsed: boolean }) {
  const state = stage?.state ?? "none";
  const link = (
    <NavLink
      to={`/p/${pid}/${tab.to}`}
      data-tour={`tab-${tab.to}`}
      aria-label={tab.label}
      className={({ isActive }) => clsx(
        "group relative flex h-9 items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50",
        collapsed ? "mx-auto w-9 justify-center" : "gap-2.5 pl-2 pr-2.5",
        isActive ? "text-ink" : "text-mute hover:bg-hover/70 hover:text-ink",
      )}
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.span layoutId={`pipe-active-${pid}`} transition={{ type: "spring", stiffness: 520, damping: 40 }}
              className="absolute inset-0 rounded-lg border border-accent/25 bg-gradient-to-r from-accent/15 via-accent/5 to-transparent">
              <span className="absolute -left-px bottom-2 top-2 w-[3px] rounded-r-full bg-accent shadow-[0_0_10px_var(--color-accent)]" />
            </motion.span>
          )}
          <span className={clsx("relative z-[1] grid size-7 shrink-0 place-items-center rounded-md border bg-panel transition-colors", chipTone[state],
            isActive && "border-accent/50 bg-accent/10 text-accent-ink")}>
            <tab.icon className="size-4" />
          </span>
          {!collapsed && <span className="relative min-w-0 flex-1 truncate text-sm font-medium">{tab.label}</span>}
          {!collapsed && <span className="relative"><StageMark state={state} /></span>}
        </>
      )}
    </NavLink>
  );
  return (
    <Tooltip content={`${tab.label}${stage?.hint ? ` · ${stage.hint}` : ""}`} side="right" delay={collapsed ? 150 : 700}>{link}</Tooltip>
  );
}

export interface RailProps {
  project: Project; episode?: Episode; pid: number; episodes: Episode[];
  tabs: ProjectTab[]; stages: Record<string, Stage>; simple: boolean; ownMaterial: boolean; onToggleFull: () => void;
  step: NextStep | null; showStep: boolean; onHideStep: () => void;
  title: string; onTitle: (v: string) => void; onSaveTitle: () => void; onAddEpisode: () => void;
  autopilot: { running: boolean; paused: boolean; label: string };
}

/** Groups the visible tabs under their phase, in pipeline order. */
function usePhases(tabs: ProjectTab[], simple: boolean) {
  const t = useT();
  return useMemo(() => {
    const phases = getProjectPhases(t);
    const out = phases.map((p, i) => ({ ...p, index: i, tabs: tabs.filter((x) => x.phase === p.id) })).filter((p) => p.tabs.length);
    return simple ? out.map((p) => ({ ...p, label: p.label })) : out;
  }, [t, tabs, simple]);
}

/**
 * The project's spine: identity and controls on top, the production pipeline as a vertical flow, and the next step
 * plus the Director pinned at the bottom. Collapses to icons; the choice is remembered.
 */
export function PipelineRail(p: RailProps) {
  const t = useT();
  const ctx = useProjectCtx();
  const ui = useUI();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* storage blocked */ } }, [collapsed]);
  useEffect(() => {
    const toggle = () => setCollapsed((v) => !v);
    const key = (e: KeyboardEvent) => { if (e.key === "[" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) { e.preventDefault(); toggle(); } };
    window.addEventListener(TOGGLE_RAIL_EVENT, toggle);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener(TOGGLE_RAIL_EVENT, toggle); window.removeEventListener("keydown", key); };
  }, []);
  const phases = usePhases(p.tabs, p.simple);
  const { project, pid, episodes } = p;
  const lang = ctx.lang;

  const director = (
    <Tooltip content={`${t("Director")} (${MOD}+J)`} side="right" disabled={!collapsed}>
      <button data-tour="director" onClick={ui.toggleAgent} aria-pressed={ui.agentOpen}
        className={clsx("group flex items-center gap-2 rounded-lg border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ai/50",
          collapsed ? "mx-auto size-9 justify-center" : "h-9 w-full px-2.5",
          ui.agentOpen ? "border-ai/40 bg-ai/12 text-ai" : "border-line bg-raised/60 text-mute hover:border-ai/40 hover:text-ai")}>
        <Bot className="size-4 shrink-0" />
        {!collapsed && <><span className="flex-1 text-left text-sm font-medium">{t("Director")}</span><span className="mono text-2xs text-dim">{MOD}J</span></>}
      </button>
    </Tooltip>
  );

  return (
    <aside data-pipeline-rail data-collapsed={collapsed ? "1" : "0"} className={clsx("relative z-20 hidden shrink-0 flex-col border-r border-line bg-panel/70 backdrop-blur transition-[width] duration-200 ease-out lg:flex", collapsed ? "w-[3.75rem]" : "w-[15.5rem]")}
      aria-label={t("Project pipeline")}>
      {/* identity */}
      <div className={clsx("border-b border-line", collapsed ? "flex flex-col items-center gap-1.5 py-2.5" : "space-y-2.5 p-3")}>
        <div className={clsx("flex items-center gap-1", collapsed && "flex-col")}>
          <Tooltip content={t("All projects")} side="right"><Link to="/" aria-label={t("All projects")} className="grid size-7 place-items-center rounded-md text-mute transition-colors hover:bg-hover hover:text-ink"><ChevronLeft className="size-4" /></Link></Tooltip>
          {!collapsed && <span className="eyebrow flex-1">{t("Project")}</span>}
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

      {/* pipeline */}
      <nav aria-label={t("Project sections")} className="no-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 py-2">
        {phases.map((ph) => {
          const tracked = ph.tabs.filter((x) => p.stages[x.to] && p.stages[x.to].state !== "none");
          const done = tracked.filter((x) => p.stages[x.to].state === "done").length;
          const numbered = ph.id !== "mission" && ph.id !== "log";
          return (
            <section key={ph.id} className="mb-2">
              {!collapsed ? (
                <header className="flex items-center gap-2 px-2 pb-1 pt-2">
                  <span className="eyebrow">{numbered ? `${String(ph.index).padStart(2, "0")} ` : ""}{ph.label}</span>
                  <span aria-hidden className="h-px flex-1 bg-line" />
                  {!p.simple && tracked.length > 0 && <span className="mono text-2xs text-dim">{done}/{tracked.length}</span>}
                </header>
              ) : <span aria-hidden className="mx-auto my-2 block h-px w-6 bg-line" />}
              <div className="relative flex flex-col gap-0.5">
                {!collapsed && ph.tabs.length > 1 && <span aria-hidden className="absolute bottom-4 left-[1.0625rem] top-4 w-px bg-line" />}
                {ph.tabs.map((tb) => <PipeItem key={tb.to} tab={tb} pid={pid} stage={p.simple ? undefined : p.stages[tb.to]} collapsed={collapsed} />)}
              </div>
            </section>
          );
        })}
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
        {p.ownMaterial && !collapsed && (
          <button type="button" onClick={p.onToggleFull} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-2xs font-medium text-mute transition-colors hover:bg-hover hover:text-ink">
            {p.simple ? <ListChecks className="size-3.5" /> : <ListMinus className="size-3.5" />}{p.simple ? t("Show all steps") : t("Simple view")}
          </button>
        )}
      </div>
    </aside>
  );
}

/** Below 1024 px there is no room for the rail: a compact title row and a scrolling strip of stages instead. */
export function PipelineStrip(p: RailProps) {
  const t = useT();
  const ctx = useProjectCtx();
  const ui = useUI();
  const phases = usePhases(p.tabs, p.simple);
  const flat = phases.flatMap((ph) => ph.tabs);
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
        <IconButton data-tour="director" title={t("Director")} active={ui.agentOpen} onClick={ui.toggleAgent}><Bot className="size-4" /></IconButton>
      </div>
      <ScrollStrip className="px-2 pb-1 pt-1.5" aria-label={t("Project sections")} role="navigation">
        <div className="flex items-center gap-1">
          {flat.map((tb) => {
            const st = p.simple ? undefined : p.stages[tb.to];
            return (
              <NavLink key={tb.to} to={`/p/${p.pid}/${tb.to}`} data-tour={`tab-${tb.to}`} aria-label={tb.label}
                className={({ isActive }) => clsx("flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50",
                  isActive ? "border-accent/40 bg-accent/12 text-accent-ink" : "border-transparent text-mute hover:bg-hover hover:text-ink")}>
                <tb.icon className="size-4" />{tb.label}{st && <StageMark state={st.state} />}
              </NavLink>
            );
          })}
        </div>
      </ScrollStrip>
    </header>
  );
}
