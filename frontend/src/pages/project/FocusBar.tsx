import { clsx } from "clsx";
import { Bot, ChevronLeft, Plus } from "lucide-react";
import { motion } from "motion/react";
import { Link } from "react-router-dom";
import { MOD } from "../../components/shell/keys";
import type { StepId } from "../../components/shell/nav";
import { PresenceBar } from "../../components/shell/PresenceBar";
import { IconButton, Select, Tooltip } from "../../components/ui";
import { LANG_SHORT, usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { Project } from "../../lib/types";
import { useProjectCtx } from "./context";
import type { StepView } from "./flow";
import { ProjectMenu, type RailProps } from "./PipelineRail";
import { SegmentedLinks } from "./StepBar";

/** The focused workspace's sections, in the order a shot-by-shot film is made: the shots, the cast in them, the cut, the export. */
const ORDER: StepId[] = ["shots", "cast", "edit", "deliver"];

/**
 * The header of a project made from your own material (built shot by shot, or an imported script). One row in place of the
 * pipeline rail and the step bar: back to all projects, the title, episode and language; Shots · Cast · Edit · Export with
 * the open section's views beside them; and the Director, which floats over the page only when asked for. The brief, the
 * Overview and the full five steps sit in the "⋯" menu. On narrow screens the sections drop to a second row.
 */
export function FocusBar(p: RailProps & { tab: string }) {
  const t = useT();
  const ctx = useProjectCtx();
  const { project, pid, episodes } = p;
  const sections = ORDER.map((id) => p.steps.find((s) => s.id === id)).filter((s): s is StepView => !!s);
  const name = (s: StepView) => (s.id === "deliver" ? t("Export") : s.label);
  const open = sections.find((s) => s.id === p.area);
  const views = open && open.tabs.length > 1 ? open : null;
  return (
    <header className="@container relative z-10 shrink-0 border-b border-line bg-panel/70 backdrop-blur" aria-label={t("Project")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:px-5 lg:h-14 lg:flex-nowrap lg:py-0">
        {/* identity: back, title, episode, language (the title gives way first when the row gets tight) */}
        <div className="flex min-w-0 items-center gap-1.5 max-lg:flex-1">
          <Tooltip content={t("All projects")} side="bottom">
            <Link to="/" aria-label={t("All projects")} className="grid size-8 shrink-0 place-items-center rounded-md text-mute transition-colors hover:bg-hover hover:text-ink">
              <ChevronLeft className="size-4" />
            </Link>
          </Tooltip>
          <input value={p.title} onChange={(e) => p.onTitle(e.target.value)} onBlur={p.onSaveTitle}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} disabled={!ctx.canEdit} aria-label={t("Project title")} title={p.title}
            className="w-60 min-w-20 truncate rounded-md border border-transparent bg-transparent px-1.5 py-1 text-base font-semibold tracking-tight outline-none transition-colors hover:border-line focus:border-accent/60 focus:bg-raised disabled:hover:border-transparent max-lg:flex-1" />
          {(episodes.length > 1 || project.type === "series") && (
            <>
              <Select value={ctx.eid} onChange={(e) => ctx.setEpisode(Number(e.target.value))} className="h-8 w-auto max-w-[6rem] shrink-0 text-xs sm:max-w-[8rem] @min-[80rem]:max-w-[10rem]" aria-label={t("Episode")}>
                {episodes.map((e) => (
                  <option key={e.id} value={e.id}>{e.kind === "cutdown" ? "✂ " : ""}{project.type === "series" || e.kind === "cutdown" ? `E${String(e.number).padStart(2, "0")} · ` : ""}{e.title || t("Untitled")}</option>
                ))}
              </Select>
              {ctx.canEdit && project.type === "series" && <span className="max-sm:hidden"><IconButton title={t("Add episode")} onClick={p.onAddEpisode}><Plus className="size-4" /></IconButton></span>}
            </>
          )}
          <Languages project={project} id={`focus-lang-${pid}`} className="max-lg:hidden" />
        </div>

        <span aria-hidden className="hidden h-6 w-px shrink-0 bg-line lg:block" />

        {/* the sections, and the open section's views (on phones: the open section named, the views on a row of their own) */}
        <div className="flex min-w-0 flex-wrap items-center gap-2 max-lg:order-last max-lg:basis-full lg:shrink-0 lg:flex-nowrap">
          <SegmentedLinks pid={pid} active={p.area} layoutId={`focus-${pid}`} label={t("Project sections")} labels="max-sm:hidden" keepActive
            items={sections.map((s) => ({ key: s.id, to: s.to, label: name(s), icon: s.icon, tour: `step-${s.id}`, tip: s.blurb }))} />
          {views && (
            <SegmentedLinks pid={pid} active={p.tab} layoutId={`focus-view-${pid}-${views.id}`} label={t("{step} pages", { step: name(views) })}
              labels="hidden max-sm:inline @min-[88rem]:inline" className="max-sm:order-last max-sm:basis-full"
              items={views.tabs.map((x) => ({ key: x.to, to: x.to, label: x.label, icon: x.icon }))} />
          )}
          {/* on narrow screens the language moves down here, next to the sections */}
          <Languages project={project} id={`focus-lang-row-${pid}`} className="ml-auto lg:hidden" />
        </div>

        <span aria-hidden className="flex-1 max-lg:hidden" />

        {/* who else is here, spend, the Director, the menu */}
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden xl:block"><PresenceBar projectId={pid} shotCode={(id) => p.episode?.shots?.find((s) => s.id === id)?.code} /></span>
          <Tooltip content={t("Spent on this project")} side="bottom">
            <span className="mono hidden rounded-md border border-line bg-raised/50 px-1.5 py-0.5 text-2xs text-money sm:max-lg:inline @min-[80rem]:inline">{usd(project.spent_usd)}</span>
          </Tooltip>
          <Tooltip content={`${t("Director")} (${MOD}+J)`} side="bottom">
            <button data-tour="director" onClick={p.onToggleDirector} aria-pressed={p.directorOpen} aria-label={t("Director")}
              className={clsx("flex h-8 items-center gap-1.5 rounded-lg border px-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ai/50",
                p.directorOpen ? "border-ai/40 bg-ai/12 text-ai" : "border-line bg-raised/60 text-mute hover:border-ai/40 hover:text-ai")}>
              <Bot className="size-4 shrink-0" />
              <span className="hidden text-sm font-medium @min-[80rem]:inline">{t("Director")}</span>
            </button>
          </Tooltip>
          <ProjectMenu pid={pid} area={p.area} placement="bottom-end" side="bottom" focus={p.focus} />
        </div>
      </div>
    </header>
  );
}

/** The working language as a small segmented switch (★ marks the project's main language). */
function Languages({ project, id, className }: { project: Project; id: string; className?: string }) {
  const t = useT();
  const ctx = useProjectCtx();
  if (project.languages.length < 2) return null;
  return (
    <div className={clsx("flex shrink-0 rounded-md border border-line bg-raised/50 p-0.5", className)} role="radiogroup" aria-label={t("Working language")}>
      {project.languages.map((l) => (
        <button key={l} role="radio" aria-checked={ctx.lang === l} onClick={() => ctx.setLang(l)}
          className={clsx("mono relative h-6 rounded px-1.5 text-2xs font-medium transition-colors", ctx.lang === l ? "text-[var(--on-accent)]" : "text-mute hover:text-ink")}>
          {ctx.lang === l && <motion.span layoutId={id} className="absolute inset-0 rounded bg-accent" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
          <span className="relative">{LANG_SHORT[l]}{l === project.primary_language ? "★" : ""}</span>
        </button>
      ))}
    </div>
  );
}
