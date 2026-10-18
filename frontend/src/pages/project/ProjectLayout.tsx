import { useQueryClient } from "@tanstack/react-query";
import { FolderSearch, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import AgentPanel from "../../components/AgentPanel";
import { ImportWizard } from "../../components/board/ImportWizard";
import { openDirector } from "../../components/shell/keys";
import { areaOf, getProjectTabs } from "../../components/shell/nav";
import { Button, Empty, IconButton, PageSkeleton, Skeleton, Spinner, useDocumentTitle } from "../../components/ui";
import { api } from "../../lib/api";
import { useReportView } from "../../lib/collab";
import { tr, useT } from "../../lib/i18n";
import { useAuthStatus, useEpisode, useProject, useSettings } from "../../lib/queries";
import { useUI } from "../../lib/store";
import { ROLE_RANK, type AutopilotState, type Episode } from "../../lib/types";
import { ProjectContext, type ProjectCtx } from "./context";
import { buildSteps, isOwnMaterial, useFullFlow, useLastTabs } from "./flow";
import { IMPORT_EVENT } from "./importEvent";
import { NextBar } from "./NextBar";
import { nextStep } from "./nextStep";
import { usePipeline } from "./pipeline";
import { ProjectHeader } from "./ProjectHeader";
import Storyboard from "./Storyboard";

/**
 * Step-level addresses open the step's first page. Every page keeps its old address (/p/:pid/bible, /shots, /storyboard…),
 * which is now a page of its step, so existing links, toasts and Autopilot milestones land without a redirect.
 */
const STEP_ALIASES: Record<string, string> = { overview: "dashboard", cast: "bible", edit: "timeline", deliver: "export" };

/** Redirects a step-level address to its page, keeping the query, hash and state. */
function Alias({ pid, to }: { pid: number; to: string }) {
  const loc = useLocation();
  return <Navigate to={{ pathname: `/p/${pid}/${to}`, search: loc.search, hash: loc.hash }} state={loc.state} replace />;
}

const ActivityPage = lazy(() => import("./Activity"));
const DashboardPage = lazy(() => import("./Dashboard"));
const WorldPage = lazy(() => import("./World"));
const CampaignPage = lazy(() => import("./Campaign"));
const PostersGallery = lazy(() => import("../posters/Gallery"));
const BiblePage = lazy(() => import("./Bible"));
const BriefPage = lazy(() => import("./Brief"));
const CanvasPage = lazy(() => import("./canvas/Canvas"));
const ExportPage = lazy(() => import("./Export"));
const FinishPage = lazy(() => import("./Finish"));
const ReviewPage = lazy(() => import("./Review"));
const ScenesPage = lazy(() => import("./Scenes"));
const ShotListPage = lazy(() => import("./ShotList"));
const StudioPage = lazy(() => import("./studio/Studio"));
const StoryPage = lazy(() => import("./Story"));
const TimelinePage = lazy(() => import("./Timeline"));

/** From this width the Director docks as a side panel that makes room for itself; below it, it opens over the page. */
const DOCK_MIN = 1280;

/**
 * A project's workspace, the same for every project: one header on top (back, title, the steps as a stepper, the open
 * step's views, spend, the Director), the open page, and the Next bar at the bottom (what is being made, and the next step
 * with its price). The Director docks on the right on laptops and wider (the page makes room), and opens over the page on
 * smaller screens. Projects made from your own material leave out the Story step unless you ask for it.
 */
export default function ProjectLayout() {
  const t = useT();
  const pid = Number(useParams().pid);
  const qc = useQueryClient();
  const navigate = useNavigate();
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
  const lastTabs = useLastTabs(pid, tab);
  // own-material projects: whether the Story step shows (remembered per project)
  const [storyShown, setStoryShown] = useFullFlow(pid);

  // Where the Director opens over the page, it only opens when asked (its button or Ctrl/⌘+J), never by default.
  const [floatOpen, setFloatOpen] = useState(false);
  const agentShown = useRef(false);
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

  // The import wizard, for the whole project: a script pasted on Home arrives as navigation state and is read at once;
  // "Import script" anywhere (the Next bar, empty pages) asks for it with an event.
  const [importing, setImporting] = useState<{ text: string } | null>(null);
  useEffect(() => {
    const st = loc.state as { importScript?: string } | null;
    if (!st || typeof st.importScript !== "string") return;
    setImporting({ text: st.importScript });
    navigate({ pathname: loc.pathname, search: loc.search }, { replace: true, state: null });
  }, [loc.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = (e: Event) => setImporting({ text: (e as CustomEvent<{ text?: string }>).detail?.text ?? "" });
    window.addEventListener(IMPORT_EVENT, h);
    return () => window.removeEventListener(IMPORT_EVENT, h);
  }, []);

  const episodes: Episode[] = project?.episodes ?? [];
  const eid = useMemo(() => {
    const want = ui.episode[pid];
    return episodes.find((e) => e.id === want)?.id ?? episodes[0]?.id ?? 0;
  }, [episodes, ui.episode, pid]);
  const lang = project && project.languages.includes(ui.language[pid]) ? ui.language[pid] : project?.primary_language ?? "en";
  const { data: episode } = useEpisode(eid || undefined, lang);
  useReportView(pid || null, tab);
  const pipeline = usePipeline(project, episode);

  const tabLabel = tabs.find((x) => x.to === tab)?.label;
  useDocumentTitle(tabLabel, project?.title);

  // Ctrl/⌘+J opens the Director and puts you in its box; pressed again from inside it, it closes the panel.
  // (Ctrl/⌘+K is the global command palette.)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        if (agentShown.current && document.activeElement?.closest("[data-director]")) useUI.getState().setAgentOpen(false);
        else openDirector();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel/85 px-3">
          <Skeleton className="size-8" /><Skeleton className="h-6 w-44" /><Skeleton className="h-8 w-[28rem] max-w-[40vw]" />
        </div>
        <div className="grid flex-1 grid-cols-2 content-start gap-4 p-6 md:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-video" />)}</div>
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
  const step = nextStep(project, episode, ap, settings?.catalog.autopilot);
  const own = isOwnMaterial(project);
  const area = areaOf(tab);
  const all = buildSteps(t, project, episode, pipeline.stages, { current: tab, last: lastTabs });
  // own material: the Story step only once it has writing in it, while you are on it, or when you asked for it
  const storyBusy = all.find((s) => s.id === "story")?.tabs.some((x) => x.to !== "brief");
  const steps = own && !storyShown && !storyBusy && area !== "story" ? all.filter((s) => s.id !== "story") : all;

  // The Director docks on laptops and wider (the page makes room); on smaller screens it opens over the page, with a close.
  const floatAgent = vw < DOCK_MIN;
  const showAgent = ui.agentOpen && !(drawerOpen && narrow) && (!floatAgent || floatOpen);
  agentShown.current = showAgent;
  // The buttons show what is on screen. If the panel is "open" in settings but hidden (floating and not asked for yet, or the
  // shot drawer has the room), a click brings it up instead of closing something nobody can see.
  const toggleDirector = () => {
    if (ui.agentOpen && !showAgent) { openDirector(); return; }
    ui.toggleAgent();
  };
  const hasShots = (episode?.shots ?? []).some((s) => s.include);

  return (
    <ProjectContext.Provider value={ctx}>
      <div className="relative flex h-full">
        <div className="flex min-w-0 flex-1 flex-col">
          <ProjectHeader project={project} episode={episode} pid={pid} episodes={episodes} steps={steps} area={area} tab={tab}
            title={title} onTitle={setTitle} onSaveTitle={saveTitle} onAddEpisode={addEpisode}
            directorOpen={showAgent} onToggleDirector={toggleDirector}
            story={own ? { shown: storyShown || !!storyBusy, set: setStoryShown } : undefined} />
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
                      {/* a project opens on its overview (own-material projects on their shots) */}
                      <Route index element={episode ? <Navigate to={`/p/${pid}/${own ? "canvas" : "dashboard"}`} replace /> : <div className="p-8"><Spinner /></div>} />
                      <Route path="brief" element={<BriefPage />} />
                      <Route path="story" element={<StoryPage />} />
                      <Route path="scenes" element={<ScenesPage />} />
                      <Route path="bible" element={<BiblePage />} />
                      <Route path="canvas" element={<CanvasPage />} />
                      <Route path="shots" element={<ShotListPage />} />
                      <Route path="studio" element={<StudioPage />} />
                      <Route path="storyboard" element={<Storyboard />} />
                      <Route path="timeline" element={<TimelinePage />} />
                      <Route path="finish" element={<FinishPage />} />
                      <Route path="export" element={<ExportPage />} />
                      <Route path="review" element={<ReviewPage />} />
                      <Route path="activity" element={<ActivityPage />} />
                      <Route path="dashboard" element={<DashboardPage />} />
                      <Route path="world" element={<WorldPage />} />
                      <Route path="campaign" element={<CampaignPage />} />
                      <Route path="posters" element={<PostersGallery projectId={pid} />} />
                      {Object.entries(STEP_ALIASES).map(([from, to]) => <Route key={from} path={from} element={<Alias pid={pid} to={to} />} />)}
                      <Route path="*" element={<Navigate to={`/p/${pid}/dashboard`} replace />} />
                    </Routes>
                  </Suspense>
                </motion.div>
              </AnimatePresence>
            ) : <div className="p-8"><Spinner /></div>}
            <AnimatePresence initial={false}>
              {showAgent && floatAgent && (
                // Over the page: a clear close button, Esc closes it too (menus it opens render elsewhere and handle their own Esc)
                <div key="agent-float" className="absolute inset-y-0 right-0 z-40 flex min-h-0 max-w-full shadow-modal"
                  onKeyDown={(e) => {
                    if (e.key !== "Escape" || e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
                    e.stopPropagation();
                    ui.setAgentOpen(false);
                  }}>
                  <IconButton title={t("Close the Director (Esc)")} onClick={() => ui.setAgentOpen(false)}
                    className="absolute -left-10 top-2 z-10 !size-8 rounded-full border border-line bg-panel shadow-pop max-sm:hidden"><X className="size-4" /></IconButton>
                  <AgentPanel key="agent" />
                </div>
              )}
            </AnimatePresence>
          </div>
          <NextBar step={step} episode={episode} />
        </div>
        <AnimatePresence initial={false}>
          {showAgent && !floatAgent && <AgentPanel key="agent" />}
        </AnimatePresence>
      </div>
      <ImportWizard open={!!importing} onClose={() => setImporting(null)} eid={eid} projectId={pid} hasShots={hasShots}
        initialText={importing?.text || undefined}
        onDone={() => {
          for (const k of ["board", "episode", "project", "characters"]) qc.invalidateQueries({ queryKey: [k] });
          // next: the people the script names become the cast (with "Make the cast" and its price on the Cast page)
          navigate(`/p/${pid}/bible`, { state: { fromImport: true } });
        }} />
    </ProjectContext.Provider>
  );
}
