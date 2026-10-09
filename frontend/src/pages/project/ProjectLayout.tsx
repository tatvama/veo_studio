import { useQueryClient } from "@tanstack/react-query";
import { FolderSearch } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { toast } from "sonner";
import AgentPanel from "../../components/AgentPanel";
import JobTray from "../../components/JobTray";
import { openDirector } from "../../components/shell/keys";
import { getProjectTabs } from "../../components/shell/nav";
import { Button, Empty, PageSkeleton, Skeleton, Spinner, useDocumentTitle } from "../../components/ui";
import { api } from "../../lib/api";
import { useReportView } from "../../lib/collab";
import { tr, useT } from "../../lib/i18n";
import { useAuthStatus, useEpisode, useProject, useSettings } from "../../lib/queries";
import { useUI } from "../../lib/store";
import { ROLE_RANK, type AutopilotState, type Episode } from "../../lib/types";
import { ProjectContext, type ProjectCtx } from "./context";
import { nextStep } from "./nextStep";
import { PipelineRail, PipelineStrip, type RailProps } from "./PipelineRail";
import { usePipeline } from "./pipeline";
import Storyboard from "./Storyboard";

/** Projects made from your own material (shot by shot, or an imported script) show just these steps. */
const SIMPLE_TABS = ["dashboard", "studio", "bible", "shots", "export"];

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

/**
 * A project's workspace: the pipeline rail on the left, the current stage in the middle, the Director docked on the
 * right. The overview ("Mission") is where a project opens; the rail's next-step card says what to do next.
 */
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

  // Below ~1100px the Director floats over the page, so it only opens when asked (toggle or Ctrl/⌘+J), never by default.
  const [floatOpen, setFloatOpen] = useState(false);
  const agentSeen = useRef(true);
  useEffect(() => { if (agentSeen.current) { agentSeen.current = false; return; } setFloatOpen(ui.agentOpen); }, [ui.agentOpen]);
  useEffect(() => {
    const open = () => setFloatOpen(true);
    window.addEventListener("veo:director-open", open);
    return () => window.removeEventListener("veo:director-open", open);
  }, []);
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
      <div className="flex h-full">
        <div className="hidden w-[15.5rem] shrink-0 space-y-3 border-r border-line bg-panel/70 p-3 lg:block">
          <Skeleton className="h-6 w-40" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" />
          {Array.from({ length: 9 }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}
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
  // Below ~1100px there isn't room for a docked Director: float it over the page instead of squeezing the content.
  const floatAgent = vw < 1100;
  const showAgent = ui.agentOpen && !(drawerOpen && narrow) && (!floatAgent || floatOpen);
  // The buttons show what is on screen. If the panel is "open" in settings but hidden (floating below 1100px, or the shot drawer
  // has the room), a click brings it up instead of closing something nobody can see.
  const toggleDirector = () => {
    if (ui.agentOpen && !showAgent) { openDirector(); return; }
    ui.toggleAgent();
  };
  const ownMaterial = project.workflow === "shots" || project.workflow === "script";
  const simple = ownMaterial && !fullTabs;
  const shown = simple ? tabs.filter((tb) => SIMPLE_TABS.includes(tb.to)).map((tb) => (tb.to === "bible" ? { ...tb, label: t("Characters") } : tb)) : tabs;

  const rail: RailProps = {
    project, episode, pid, episodes, tabs: shown, stages: pipeline.stages, simple, ownMaterial, onToggleFull: toggleFull,
    step, showStep: !!step && hiddenTip !== stepKey && step.tab !== tab && (!simple || SIMPLE_TABS.includes(step.tab)), onHideStep: () => setHiddenTip(stepKey),
    title, onTitle: setTitle, onSaveTitle: saveTitle, onAddEpisode: addEpisode,
    autopilot: { running: apRunning, paused: apPaused, label: tr(settings?.catalog.autopilot?.labels[ap.stage ?? ""] ?? ap.stage ?? "") },
    directorOpen: showAgent, onToggleDirector: toggleDirector,
  };

  return (
    <ProjectContext.Provider value={ctx}>
      <div className="relative flex h-full">
        <PipelineRail {...rail} />
        <div className="flex min-w-0 flex-1 flex-col">
          <PipelineStrip {...rail} />
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
                      {/* a project opens on its mission overview (own-material projects on their workspace) */}
                      <Route index element={episode ? <Navigate to={`/p/${pid}/${simple ? ((episode.shots ?? []).length ? "studio" : "shots") : "dashboard"}`} replace /> : <div className="p-8"><Spinner /></div>} />
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
                      <Route path="*" element={<Navigate to={`/p/${pid}/dashboard`} replace />} />
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
