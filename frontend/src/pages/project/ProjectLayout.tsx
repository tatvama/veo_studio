import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowRight, Bot, Check, ChevronLeft, CirclePause, FolderSearch, Lightbulb, ListChecks, ListMinus, Plus, Rocket, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { toast } from "sonner";
import AgentPanel from "../../components/AgentPanel";
import JobTray from "../../components/JobTray";
import { MOD, openDirector } from "../../components/shell/keys";
import { PresenceBar } from "../../components/shell/PresenceBar";
import { getProjectPhases, getProjectTabs } from "../../components/shell/nav";
import { Badge, Button, Empty, IconButton, PageSkeleton, ScrollStrip, Select, Skeleton, Spinner, Tooltip, useDocumentTitle } from "../../components/ui";
import { api } from "../../lib/api";
import { LANG_SHORT, usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useReportView } from "../../lib/collab";
import { useAuthStatus, useEpisode, useProject, useSettings } from "../../lib/queries";
import { useUI } from "../../lib/store";
import { ROLE_RANK, type AutopilotState, type Episode } from "../../lib/types";
import { ProjectContext, type ProjectCtx } from "./context";
import { nextStep, type NextStep } from "./nextStep";
import { usePipeline, type StageState } from "./pipeline";
import Storyboard from "./Storyboard";

/** Projects made from your own material (shot by shot, or an imported script) show just these steps. */
const SIMPLE_TABS = ["studio", "bible", "shots", "export"];

const ActivityPage = lazy(() => import("./Activity"));
const DashboardPage = lazy(() => import("./Dashboard"));
const WorldPage = lazy(() => import("./World"));
const CampaignPage = lazy(() => import("./Campaign"));
const BiblePage = lazy(() => import("./Bible"));
const BriefPage = lazy(() => import("./Brief"));
const ExportPage = lazy(() => import("./Export"));
const ReviewPage = lazy(() => import("./Review"));
const ScenesPage = lazy(() => import("./Scenes"));
const ShotListPage = lazy(() => import("./ShotList"));
const StudioPage = lazy(() => import("./studio/Studio"));
const StoryPage = lazy(() => import("./Story"));
const TimelinePage = lazy(() => import("./Timeline"));

/** One line under the header: the next thing to do, with a button that goes there. */
function NextStepBar({ step, pid, onHide }: { step: NextStep; pid: number; onHide: () => void }) {
  const t = useT();
  const tones = {
    accent: "border-accent/25 bg-accent/6 text-accent-ink", info: "border-info/25 bg-info/8 text-sky-300",
    warn: "border-warn/30 bg-warn/8 text-amber-300", ok: "border-ok/25 bg-ok/8 text-green-300",
  };
  return (
    <div role="status" className={clsx("flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-1.5 text-xs", tones[step.tone])}>
      {step.tone === "warn" ? <CirclePause className="size-3.5 shrink-0" /> : step.tone === "info" ? <Rocket className="size-3.5 shrink-0" /> : <Lightbulb className="size-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 text-ink">{step.text}</span>
      {step.secondary && (
        <Link to={`/p/${pid}/${step.secondary.tab}`} className="shrink-0 font-medium text-mute underline-offset-2 hover:text-ink hover:underline">{step.secondary.label}</Link>
      )}
      <Link to={`/p/${pid}/${step.tab}`}>
        <Button size="sm" variant="primary" className="!h-7" iconRight={<ArrowRight className="size-3.5" />}>{step.action}</Button>
      </Link>
      <button type="button" onClick={onHide} aria-label={t("Hide this tip")}
        className="grid size-6 shrink-0 place-items-center rounded text-dim transition-colors hover:bg-hover hover:text-ink"><X className="size-3.5" /></button>
    </div>
  );
}

/** Small status mark after a tab label. */
function StageMark({ state }: { state: StageState }) {
  if (state === "none") return null;
  if (state === "done") {
    return <span className="grid size-3.5 place-items-center rounded-full bg-ok/15 text-ok"><Check className="size-2.5" strokeWidth={3} /></span>;
  }
  if (state === "progress") return <span className="size-1.5 rounded-full bg-accent shadow-[0_0_0_3px_rgb(249_115_22/0.18)]" />;
  return <span className="size-1.5 rounded-full border border-dim/70" />;
}

export default function ProjectLayout() {
  const t = useT();
  const pid = Number(useParams().pid);
  const qc = useQueryClient();
  const { data: project, isLoading, error } = useProject(pid);
  const { data: auth } = useAuthStatus();
  const ui = useUI();
  const [title, setTitle] = useState("");
  const loc = useLocation();
  const [vw, setVw] = useState(() => window.innerWidth);
  // On smaller screens the shot drawer and the Director panel don't fit together; the drawer wins (Ctrl/⌘+J brings the Director back).
  const narrow = vw < 1760;
  const drawerOpen = !!ui.selectedShot && loc.pathname.endsWith("/storyboard");
  const tab = loc.pathname.split("/")[3] || "index";
  const tabs = getProjectTabs(t);
  const phases = getProjectPhases(t);
  const { data: settings } = useSettings();
  const [hiddenTip, setHiddenTip] = useState("");
  const fullKey = `veo:fullTabs:${pid}`;
  const [fullTabs, setFullTabs] = useState(() => { try { return localStorage.getItem(fullKey) === "1"; } catch { return false; } });
  useEffect(() => { try { setFullTabs(localStorage.getItem(fullKey) === "1"); } catch { /* storage blocked */ } }, [fullKey]);
  const toggleFull = () => {
    const v = !fullTabs;
    setFullTabs(v);
    try { localStorage.setItem(fullKey, v ? "1" : "0"); } catch { /* storage blocked */ }
  };

  useEffect(() => { if (project) setTitle(project.title); }, [project?.title]);
  useEffect(() => {
    const h = () => setVw(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);

  const episodes: Episode[] = project?.episodes ?? [];
  const eid = useMemo(() => {
    const want = ui.episode[pid];
    return episodes.find((e) => e.id === want)?.id ?? episodes[0]?.id ?? 0;
  }, [episodes, ui.episode, pid]);
  const lang = project && project.languages.includes(ui.language[pid]) ? ui.language[pid] : project?.primary_language ?? "en";
  const { data: episode } = useEpisode(eid || undefined, lang);
  useReportView(pid || null, loc.pathname.split("/")[3] || "index");
  const pipeline = usePipeline(project, episode);

  const tabLabel = tabs.find((x) => x.to === tab)?.label;
  useDocumentTitle(tabLabel, project?.title);

  // Ctrl/⌘+J opens the Director (Ctrl/⌘+K is the global command palette).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        openDirector();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="space-y-3 border-b border-line bg-panel/60 px-4 py-3">
          <div className="flex items-center gap-3"><Skeleton className="h-6 w-6" /><Skeleton className="h-6 w-64" /><Skeleton className="h-5 w-14" /></div>
          <div className="flex gap-2">{Array.from({ length: 9 }, (_, i) => <Skeleton key={i} className="h-7 w-20" />)}</div>
        </div>
        <div className="grid flex-1 grid-cols-2 gap-4 p-6 md:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-video" />)}</div>
      </div>
    );
  }
  if (error || !project) {
    return (
      <div className="mx-auto flex h-full max-w-lg items-center px-6">
        <div className="w-full">
          <Empty icon={<FolderSearch className="size-7" />} title={t("Project not found")} sub={t("It may have been archived or deleted, or you may not have access to it.")}
            action={<Link to="/"><Button variant="primary">{t("Back to projects")}</Button></Link>} />
        </div>
      </div>
    );
  }

  const role = auth?.user?.role ?? "viewer";
  const ctx: ProjectCtx = {
    project, eid, lang,
    setLang: (l) => ui.setLanguage(pid, l),
    setEpisode: (e) => ui.setEpisode(pid, e),
    canEdit: ROLE_RANK[role] >= ROLE_RANK.creator,
    canReview: ROLE_RANK[role] >= ROLE_RANK.reviewer,
    canProduce: ROLE_RANK[role] >= ROLE_RANK.producer,
  };

  const saveTitle = async () => {
    if (title.trim() && title !== project.title) {
      await api.patch(`/api/projects/${pid}`, { title });
      qc.invalidateQueries({ queryKey: ["project", pid] });
    }
  };

  const addEpisode = async () => {
    const e = await api.post<Episode>(`/api/projects/${pid}/episodes`, {});
    await qc.invalidateQueries({ queryKey: ["project", pid] });
    ctx.setEpisode(e.id);
    toast.success(tr("Episode {n} added", { n: e.number }));
  };

  const ap = (project.autopilot || {}) as AutopilotState;
  const apRunning = ap.status === "running";
  const apPaused = ap.status === "paused";
  const step = nextStep(project, episode, ap, settings?.catalog.autopilot);
  const stepKey = step ? `${pid}:${eid}:${step.text}` : "";
  const showAgent = ui.agentOpen && !(drawerOpen && narrow);
  // Below ~1100px there isn't room for a docked Director: float it over the page instead of squeezing the content.
  const floatAgent = vw < 1100;
  const pct = pipeline.done / pipeline.total;
  const ownMaterial = project.workflow === "shots" || project.workflow === "script";
  const simple = ownMaterial && !fullTabs;
  const shown = simple
    ? tabs.filter((tb) => SIMPLE_TABS.includes(tb.to)).map((tb) => (tb.to === "bible" ? { ...tb, label: t("Characters") } : tb))
    : tabs;

  return (
    <ProjectContext.Provider value={ctx}>
      <div className="relative flex h-full">
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="relative border-b border-line bg-panel/70 px-4 pt-3 backdrop-blur @container">
            <div className="flex items-center gap-2 @2xl:gap-3">
              <Tooltip content={t("All projects")} side="bottom">
                <Link to="/" className="grid size-8 shrink-0 place-items-center rounded-lg text-mute transition-colors hover:bg-hover hover:text-ink" aria-label={t("All projects")}>
                  <ChevronLeft className="size-5" />
                </Link>
              </Tooltip>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                disabled={!ctx.canEdit}
                aria-label={t("Project title")}
                title={title}
                className="min-w-[8rem] max-w-[26rem] flex-1 truncate rounded-lg border border-transparent bg-transparent px-2 py-1 text-lg font-semibold tracking-tight outline-none transition-colors hover:border-line focus:border-accent/60 focus:bg-raised disabled:hover:border-transparent"
              />
              <div className="hidden items-center gap-1.5 @3xl:flex">
                <Badge tone="accent" className="capitalize">{project.type}</Badge>
                <Badge>{project.aspect}</Badge>
              </div>
              {apRunning && (
                <Link to={`/p/${pid}/brief`}><Badge tone="info" className="pulse-ring shrink-0"><Rocket className="size-3" />{t("Autopilot")}
                  <span className="hidden @2xl:inline">: {t(settings?.catalog.autopilot?.labels[ap.stage ?? ""] ?? ap.stage ?? "")}</span></Badge></Link>
              )}
              {apPaused && <Link to={`/p/${pid}/brief`}><Badge tone="warn" className="shrink-0"><CirclePause className="size-3" />{t("Autopilot waiting for you")}</Badge></Link>}
              <div className="flex-1" />
              {episodes.length > 1 || project.type === "series" ? (
                <div className="flex items-center gap-1">
                  <Select value={eid} onChange={(e) => ctx.setEpisode(Number(e.target.value))} className="h-8 w-28 text-xs @4xl:w-56" aria-label={t("Episode")}>
                    {episodes.map((e) => (
                      <option key={e.id} value={e.id}>{e.kind === "cutdown" ? "✂ " : ""}{project.type === "series" || e.kind === "cutdown" ? `E${String(e.number).padStart(2, "0")} · ` : ""}{e.title || t("Untitled")}</option>
                    ))}
                  </Select>
                  {ctx.canEdit && project.type === "series" && <IconButton title={t("Add episode")} onClick={addEpisode}><Plus className="size-4" /></IconButton>}
                </div>
              ) : null}
              <div className="flex rounded-lg border border-line bg-panel p-0.5" role="radiogroup" aria-label={t("Working language")}>
                {project.languages.map((l) => (
                  <button key={l} role="radio" aria-checked={lang === l} onClick={() => ctx.setLang(l)}
                    className={clsx("relative h-6 min-w-8 rounded-md px-2 text-xs font-semibold transition-colors", lang === l ? "text-black" : "text-mute hover:text-ink")}>
                    {lang === l && <motion.span layoutId={`proj-lang-${pid}`} className="absolute inset-0 rounded-md bg-accent" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
                    <span className="relative">{LANG_SHORT[l]}{l === project.primary_language ? "★" : ""}</span>
                  </button>
                ))}
              </div>
              <PresenceBar projectId={pid} shotCode={(id) => episode?.shots?.find((s) => s.id === id)?.code} />
              <Tooltip content={t("Spent on this project")} side="bottom">
                <span className="hidden rounded-lg border border-line bg-raised/60 px-2 py-1 text-xs font-medium tabular-nums text-mute @4xl:inline-block">{usd(project.spent_usd)}</span>
              </Tooltip>
              <IconButton data-tour="director" title={t("Director")} shortcut={<><span>{MOD}</span><span>J</span></>} tipSide="bottom" active={ui.agentOpen} onClick={ui.toggleAgent}><Bot className="size-4" /></IconButton>
            </div>

            <div className="mt-2 flex items-center gap-3">
              <ScrollStrip className="min-w-0 flex-1" aria-label={t("Project sections")} role="navigation">
                <div className="flex items-end gap-0.5">
                  {shown.map((tb, i) => {
                    const st = simple ? undefined : pipeline.stages[tb.to];
                    const phase = phases.find((ph) => ph.id === tb.phase);
                    const phaseStart = !simple && !!phase && (i === 0 || shown[i - 1].phase !== tb.phase);
                    const divider = phaseStart && i > 0 ? (
                      <span key={`div-${tb.phase}`} aria-hidden className="mx-1 mb-2 h-4 w-px shrink-0 self-end bg-line" />
                    ) : null;
                    const phaseLabel = phaseStart ? (
                      <span key={`ph-${tb.phase}`} aria-hidden
                        className="hidden shrink-0 self-center pr-1 text-[0.625rem] font-semibold uppercase tracking-wider text-dim @5xl:inline">
                        {phase!.label}
                      </span>
                    ) : null;
                    const link = (
                      <NavLink key={tb.to} to={`/p/${pid}/${tb.to}`} data-tour={`tab-${tb.to}`} aria-label={tb.label}
                        className={({ isActive }) => clsx("group relative flex shrink-0 items-center gap-1.5 rounded-t-lg px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50",
                          isActive ? "text-ink" : "text-mute hover:bg-hover/60 hover:text-ink")}>
                        {({ isActive }) => (
                          <>
                            <tb.icon className={clsx("size-4 shrink-0 transition-colors", isActive && "text-accent-ink")} />
                            <span className={clsx(!isActive && "hidden @4xl:inline")}>{tb.label}</span>
                            {st && <StageMark state={st.state} />}
                            {isActive && (
                              <motion.span layoutId={`proj-tab-${pid}`} className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-accent"
                                transition={{ type: "spring", stiffness: 500, damping: 38 }} />
                            )}
                          </>
                        )}
                      </NavLink>
                    );
                    return [
                      divider, phaseLabel,
                      <Tooltip key={tb.to} content={`${phase ? `${phase.label} · ` : ""}${tb.label}${st?.hint ? ` · ${st.hint}` : ""}`} side="bottom" delay={500}>{link}</Tooltip>,
                    ];
                  })}
                </div>
              </ScrollStrip>
              {!simple && <span className="hidden shrink-0 pb-1 text-2xs text-dim @5xl:block">{t("{a} of {b} steps done", { a: pipeline.done, b: pipeline.total })}</span>}
              {ownMaterial && (
                <Tooltip content={simple ? t("Show every step (brief, story, scenes, timeline, review…)") : t("Back to the short list: characters, shots, storyboard, export")} side="bottom">
                  <button type="button" onClick={toggleFull}
                    className="mb-1 inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-2xs font-medium text-mute transition-colors hover:bg-hover hover:text-ink">
                    {simple ? <ListChecks className="size-3.5" /> : <ListMinus className="size-3.5" />}
                    {simple ? t("All steps") : t("Simple view")}
                  </button>
                </Tooltip>
              )}
            </div>
            <div className="absolute inset-x-0 bottom-0 h-px bg-line" aria-hidden>
              <motion.div className="h-px bg-accent/80" initial={false} animate={{ width: `${Math.max(pct * 100, 0)}%` }} transition={{ type: "spring", stiffness: 120, damping: 24 }} />
            </div>
          </header>
          {step && step.tab !== tab && hiddenTip !== stepKey && !(tab === "index") && (!simple || SIMPLE_TABS.includes(step.tab)) && (
            <NextStepBar step={step} pid={pid} onHide={() => setHiddenTip(stepKey)} />
          )}
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {eid ? (
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={tab}
                  className="h-full"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                >
                  <Suspense fallback={<div className="h-full overflow-hidden"><PageSkeleton cards={4} /></div>}>
                    <Routes location={loc}>
                      {/* open on the step that comes next, not an empty page */}
                      <Route index element={episode ? <Navigate to={`/p/${pid}/${simple ? ((episode.shots ?? []).length ? "studio" : "shots") : step?.tab ?? "storyboard"}`} replace /> : <div className="p-8"><Spinner /></div>} />
                      <Route path="brief" element={<BriefPage />} />
                      <Route path="story" element={<StoryPage />} />
                      <Route path="scenes" element={<ScenesPage />} />
                      <Route path="bible" element={<BiblePage />} />
                      <Route path="shots" element={<ShotListPage />} />
                      <Route path="studio" element={<StudioPage />} />
                      <Route path="storyboard" element={<Storyboard />} />
                      <Route path="timeline" element={<TimelinePage />} />
                      <Route path="export" element={<ExportPage />} />
                      <Route path="review" element={<ReviewPage />} />
                      <Route path="activity" element={<ActivityPage />} />
                      <Route path="dashboard" element={<DashboardPage />} />
                      <Route path="world" element={<WorldPage />} />
                      <Route path="campaign" element={<CampaignPage />} />
                      <Route path="*" element={<Navigate to={`/p/${pid}/storyboard`} replace />} />
                    </Routes>
                  </Suspense>
                </motion.div>
              </AnimatePresence>
            ) : <div className="p-8"><Spinner /></div>}
            <AnimatePresence initial={false}>
              {showAgent && floatAgent && (
                <div key="agent-float" className="absolute inset-y-0 right-0 z-40 flex min-h-0 max-w-full shadow-modal"><AgentPanel key="agent" /></div>
              )}
            </AnimatePresence>
          </div>
          <JobTray projectId={pid} />
        </div>
        <AnimatePresence initial={false}>
          {showAgent && !floatAgent && <AgentPanel key="agent" />}
        </AnimatePresence>
      </div>
    </ProjectContext.Provider>
  );
}
