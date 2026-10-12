import { ChevronLeft, FolderSearch } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ErrorBoundary } from "../../components/shell/ErrorBoundary";
import { Button, Empty, Select, Spinner, useDocumentTitle } from "../../components/ui";
import { usePanelBeacon } from "../../lib/bus";
import { useReportView } from "../../lib/collab";
import { PANEL_IDS, type PanelId } from "../../lib/desktop";
import { useT } from "../../lib/i18n";
import { useLiveEvents } from "../../lib/live";
import { useAuthStatus, useProject, useProjects } from "../../lib/queries";
import { useUI } from "../../lib/store";
import { ROLE_RANK, type Episode } from "../../lib/types";
import { ProjectContext, type ProjectCtx } from "../project/context";
import { CutGuard } from "../project/finish/CutGuard";
import { NotesList } from "../project/finish/NotesCard";
import { PANEL_META } from "./meta";

const ProgramPanel = lazy(() => import("./panels/Program"));
const SourcePanel = lazy(() => import("./panels/Source"));
const ScopesPanel = lazy(() => import("./panels/Scopes"));
const MixerPanel = lazy(() => import("./panels/Mixer"));
const MediaPanel = lazy(() => import("./panels/Media"));
const RendersPanel = lazy(() => import("./panels/Renders"));
const BiblePanel = lazy(() => import("./panels/Bible"));
const TimelinePage = lazy(() => import("../project/Timeline"));

/** Panels always run on the dark ground (they sit next to footage), whatever the studio's theme. */
function useDarkGround() {
  useEffect(() => {
    const root = document.documentElement;
    const before = root.dataset.theme;
    root.dataset.theme = "dark";
    root.style.colorScheme = "dark";
    return () => { if (before) root.dataset.theme = before; root.style.colorScheme = before ?? ""; };
  }, []);
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center bg-bg p-6">{children}</div>;
}

/** No project in the address: pick one. */
function ProjectPicker({ onPick }: { onPick: (pid: number) => void }) {
  const t = useT();
  const { data, isLoading } = useProjects();
  if (isLoading) return <Centered><Spinner /></Centered>;
  return (
    <Centered>
      <div className="w-full max-w-sm space-y-3">
        <p className="text-sm font-medium">{t("Which project?")}</p>
        <Select defaultValue="" onChange={(e) => e.target.value && onPick(Number(e.target.value))} aria-label={t("Project")}>
          <option value="" disabled>{t("Choose a project")}</option>
          {(data ?? []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </Select>
      </div>
    </Centered>
  );
}

function PanelBody({ panel, clean, pid, eid }: { panel: PanelId; clean: boolean; pid: number; eid: number }) {
  switch (panel) {
    case "program": return <ProgramPanel clean={clean} />;
    case "source": return <SourcePanel clean={clean} />;
    case "timeline": return <TimelinePage embedded />;
    case "scopes": return <ScopesPanel />;
    case "mixer": return <MixerPanel />;
    case "notes": return <div className="h-full overflow-y-auto p-3"><NotesList eid={eid} pid={pid} inPanel /></div>;
    case "media": return <MediaPanel />;
    case "renders": return <RendersPanel />;
    case "bible": return <BiblePanel />;
  }
}

/**
 * `/desktop/panel/:panel?pid=&eid=&clean=1` — one panel in its own window (a desktop pop-out or a browser window), outside
 * the studio shell: a slim header (panel, project, episode, back to the studio) unless `clean=1`, which shows the panel
 * alone. Windows talk to each other over the bus (lib/bus.ts).
 */
export default function PanelApp() {
  const t = useT();
  useDarkGround();
  const params = useParams();
  const panel = (PANEL_IDS as readonly string[]).includes(params.panel ?? "") ? (params.panel as PanelId) : null;
  const [search, setSearch] = useSearchParams();
  const pid = Number(search.get("pid")) || 0;
  const eidParam = Number(search.get("eid")) || 0;
  const clean = search.get("clean") === "1";
  const ui = useUI();
  const { data: project, isLoading, error } = useProject(pid);
  const { data: auth } = useAuthStatus();
  useLiveEvents(pid || null);
  useReportView(pid || null, "finish");

  const episodes: Episode[] = project?.episodes ?? [];
  const eid = useMemo(() => {
    const want = eidParam || ui.episode[pid];
    return episodes.find((e) => e.id === want)?.id ?? episodes[0]?.id ?? 0;
  }, [episodes, eidParam, ui.episode, pid]);
  usePanelBeacon(panel ?? "", panel && eid ? eid : undefined);
  const meta = panel ? PANEL_META[panel] : null;
  useDocumentTitle(meta ? t(meta.label) : t("Panel"), project?.title);

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(search);
    if (v === null) next.delete(k); else next.set(k, v);
    setSearch(next, { replace: true });
  };

  if (!panel) {
    return <Centered><Empty icon={<FolderSearch className="size-7" />} title={t("Unknown panel")} sub={PANEL_IDS.join(" · ")} /></Centered>;
  }
  if (!pid) return <ProjectPicker onPick={(p) => setParam("pid", String(p))} />;
  if (isLoading) return <Centered><Spinner /></Centered>;
  if (error || !project) {
    return <Centered><Empty icon={<FolderSearch className="size-7" />} title={t("Project not found")} action={<Link to="/"><Button variant="primary">{t("Back to projects")}</Button></Link>} /></Centered>;
  }
  if (!eid) return <Centered><p className="text-sm text-mute">{t("This project has no episodes yet.")}</p></Centered>;

  const role = auth?.user?.role ?? "viewer";
  const lang = project.languages.includes(ui.language[pid]) ? ui.language[pid] : project.primary_language;
  const ctx: ProjectCtx = {
    project, eid, lang,
    setLang: (l) => ui.setLanguage(pid, l),
    setEpisode: (e) => { ui.setEpisode(pid, e); setParam("eid", String(e)); },
    canEdit: ROLE_RANK[role] >= ROLE_RANK.creator,
    canReview: ROLE_RANK[role] >= ROLE_RANK.reviewer,
    canProduce: ROLE_RANK[role] >= ROLE_RANK.producer,
  };
  const Icon = meta!.icon;
  const ep = episodes.find((e) => e.id === eid);

  return (
    <ProjectContext.Provider value={ctx}>
      <div className={clean ? "flex h-full flex-col bg-black" : "flex h-full flex-col bg-bg"}>
        {!clean && (
          <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-3 py-1.5">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <span className="grid size-6 place-items-center rounded-md border border-accent/25 bg-accent/10 text-accent-ink"><Icon className="size-3.5" /></span>
              {t(meta!.label)}
            </span>
            <span className="min-w-0 truncate text-xs text-mute">{project.title}</span>
            {eidParam ? (
              <span className="mono text-2xs text-dim">{ep ? (ep.title ? `E${ep.number} · ${ep.title}` : t("Episode {n}", { n: ep.number })) : ""}</span>
            ) : (
              <Select value={eid} onChange={(e) => ctx.setEpisode(Number(e.target.value))} aria-label={t("Episode")} className="!h-7 w-auto text-xs">
                {episodes.map((e) => <option key={e.id} value={e.id}>{e.title ? `E${e.number} · ${e.title}` : t("Episode {n}", { n: e.number })}</option>)}
              </Select>
            )}
            {project.languages.length > 1 && (
              <Select value={lang} onChange={(e) => ctx.setLang(e.target.value)} aria-label={t("Language")} className="!h-7 w-auto text-xs">
                {project.languages.map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
              </Select>
            )}
            <span className="flex-1" />
            <Link to={`/p/${pid}/finish`} className="inline-flex items-center gap-1 text-xs font-medium text-mute transition-colors hover:text-ink">
              <ChevronLeft className="size-3.5" />{t("Back to studio")}
            </Link>
          </header>
        )}
        <div className="relative min-h-0 flex-1">
          <ErrorBoundary resetKey={`${panel}:${eid}`}>
            <Suspense fallback={<Centered><Spinner /></Centered>}>
              {/* the mixer edits the cut's mix, so it turns read-only while someone else has the cut (the timeline guards itself) */}
              {panel === "mixer"
                ? <CutGuard link={false}><PanelBody panel={panel} clean={clean} pid={pid} eid={eid} /></CutGuard>
                : <PanelBody panel={panel} clean={clean} pid={pid} eid={eid} />}
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </ProjectContext.Provider>
  );
}
