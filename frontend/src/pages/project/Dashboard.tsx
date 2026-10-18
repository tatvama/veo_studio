import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CastStrip } from "../../components/dashboard/CastStrip";
import { ImpactPanel } from "../../components/dashboard/ImpactPanel";
import { LiveQueue } from "../../components/dashboard/LiveQueue";
import { missionAction } from "../../components/dashboard/mission";
import { MissionHero, MissionHeroSkeleton } from "../../components/dashboard/MissionHero";
import { ProblemsCard } from "../../components/dashboard/ProblemsCard";
import { ProjectStrip } from "../../components/dashboard/ProjectStrip";
import { ReadyCard } from "../../components/dashboard/ReadyCard";
import { SeasonsCard } from "../../components/dashboard/SeasonsCard";
import { ShotMap } from "../../components/dashboard/ShotMap";
import { SpendCard } from "../../components/dashboard/SpendCard";
import { StatTiles } from "../../components/dashboard/StatTiles";
import { LoadError, RoomPage } from "../../components/room/kit";
import { Panel, Skeleton } from "../../components/ui";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { useEpisode, useSettings } from "../../lib/queries";
import type { AutopilotState } from "../../lib/types";
import { useEpisodeDashboard } from "../../lib/v3";
import { useProjectCtx } from "./context";
import { useNextStepRunner } from "./NextBar";
import { nextStep } from "./nextStep";
import { usePipeline } from "./pipeline";

const MORE_KEY = "veo:overview-more";

/**
 * The Overview: where the project stands, in four blocks on top: progress through the steps with the next step, what is
 * wrong (problems), and what it has cost. Everything else (numbers, the shot map, the queue, delivery, change impact, the
 * cast, seasons, the whole project) is folded under "More", and remembered open or closed.
 */
export default function DashboardPage() {
  const t = useT();
  const nav = useNavigate();
  const { project, eid, lang, setEpisode, canEdit, canReview, canProduce } = useProjectCtx();
  const { data: d, isLoading, isError, refetch } = useEpisodeDashboard(eid);
  const { data: episode, isLoading: epLoading, isError: epError, refetch: refetchEpisode } = useEpisode(eid, lang);
  const { data: settings } = useSettings();
  const { stages } = usePipeline(project, episode);
  const [more, setMoreState] = useState(() => { try { return localStorage.getItem(MORE_KEY) === "1"; } catch { return false; } });
  const setMore = (v: boolean) => { setMoreState(v); try { localStorage.setItem(MORE_KEY, v ? "1" : "0"); } catch { /* storage blocked */ } };

  const step = useMemo(
    () => nextStep(project, episode, (project.autopilot || {}) as AutopilotState, settings?.catalog.autopilot),
    [project, episode, settings?.catalog.autopilot],
  );
  const action = useMemo(
    () => missionAction({ pid: project.id, episode, d, step, canProduce, canReview }),
    [project.id, episode, d, step, canProduce, canReview],
  );

  /** Seasons open an episode to work on it; the whole-project list just switches the overview to it. */
  const openEpisode = (id: number) => { setEpisode(id); nav(`/p/${project.id}/story`); };
  const switchEpisode = (id: number) => {
    setEpisode(id);
    document.querySelector("[data-page-scroller]")?.scrollTo({ top: 0, behavior: "smooth" });
  };
  const failed = isError && !d;
  const runner = useNextStepRunner(step, episode);
  const tabOf = (go: { kind: string; tab?: string }) => (go.kind === "tab" && go.tab ? go.tab : "dashboard");
  // the next step can point at a panel folded under "More" (the change impact): open it, then scroll there
  useEffect(() => {
    const h = () => showImpact();
    window.addEventListener("veo:show-impact", h);
    return () => window.removeEventListener("veo:show-impact", h);
  });
  const stale = (d?.footage.stale_takes ?? 0) > 0;
  /** The out-of-date takes: open "More" (the change-impact panel is there) and bring it into view. */
  const showImpact = () => {
    setMore(true);
    window.setTimeout(() => document.getElementById("mission-impact")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  return (
    <RoomPage width="full" className="!pt-4">
      <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-12">
        {episode || d ? <div className="col-span-full"><MissionHero project={project} episode={episode} d={d} stages={stages} action={action} index={0}
          onMake={(a) => void runner.run(a.make, tabOf(a.go))} makePrice={runner.price} busy={runner.busy} /></div>
          : epError ? <div className="col-span-full"><LoadError what={t("Couldn't load the episode")} onRetry={() => refetchEpisode()} /></div>
          : <div className="col-span-full"><MissionHeroSkeleton /></div>}

        {failed ? (
          <div className="col-span-full"><LoadError what={t("Couldn't load the overview")} onRetry={() => refetch()} /></div>
        ) : isLoading || !d ? (
          <>
            <Panel className="@2xl:col-span-2 @5xl:col-span-7" eyebrow="···"><Skeleton className="h-32" /></Panel>
            <Panel className="@2xl:col-span-2 @5xl:col-span-5" eyebrow="···"><Skeleton className="h-32" /></Panel>
          </>
        ) : (
          <>
            <ProblemsCard className="@2xl:col-span-2 @5xl:col-span-7" index={1} d={d} episode={episode} pid={project.id} canProduce={canProduce} onImpact={showImpact}
              onMake={runner.openMake} />
            <SpendCard className="@2xl:col-span-2 @5xl:col-span-5" index={2} d={d} project={project} />

            <div className="col-span-full">
              <button type="button" onClick={() => setMore(!more)} aria-expanded={more} aria-controls="overview-more"
                className="group flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left text-sm font-medium text-mute transition-colors hover:text-ink">
                <span aria-hidden className="h-px flex-1 bg-line" />
                <span className="flex items-center gap-1.5">{more ? t("Less") : t("More")}<span className="text-2xs font-normal text-dim">{t("numbers, shot map, queue, delivery, changes, cast, seasons")}</span>
                  <ChevronDown className={cn("size-4 transition-transform", more && "rotate-180")} /></span>
                <span aria-hidden className="h-px flex-1 bg-line" />
              </button>
            </div>

            {more && (
              <div id="overview-more" className="col-span-full grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-12">
                <div className="col-span-full"><StatTiles d={d} pid={project.id} canProduce={canProduce} index={3} /></div>
                <ShotMap className="@2xl:col-span-2 @5xl:col-span-8" index={4} episode={episode} loading={epLoading} error={epError} onRetry={() => refetchEpisode()} pid={project.id} />
                <div className="grid min-w-0 content-start gap-4 @2xl:col-span-2 @5xl:col-span-4">
                  <LiveQueue index={5} pid={project.id} shots={episode?.shots ?? []} />
                  <ReadyCard index={6} d={d} pid={project.id} />
                </div>
                <ImpactPanel className={cn("@2xl:col-span-2 @5xl:col-span-7", stale && "ring-1 ring-warn/30")} index={7} eid={eid} pid={project.id} canEdit={canEdit} canReview={canReview} />
                <SeasonsCard className="@2xl:col-span-2 @5xl:col-span-5" index={8} pid={project.id} currentEid={eid} canEdit={canEdit} onOpenEpisode={openEpisode} />
                <CastStrip className="col-span-full" index={9} pid={project.id} cast={project.cast ?? []} />
                <ProjectStrip className="col-span-full" index={10} pid={project.id} currentEid={eid} onOpenEpisode={switchEpisode} />
              </div>
            )}
          </>
        )}
      </div>
      {runner.modal}
    </RoomPage>
  );
}
