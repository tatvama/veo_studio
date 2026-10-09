import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { CastStrip } from "../../components/dashboard/CastStrip";
import { ImpactPanel } from "../../components/dashboard/ImpactPanel";
import { LiveQueue } from "../../components/dashboard/LiveQueue";
import { missionAction } from "../../components/dashboard/mission";
import { MissionHero, MissionHeroSkeleton } from "../../components/dashboard/MissionHero";
import { ProjectStrip } from "../../components/dashboard/ProjectStrip";
import { ReadyCard } from "../../components/dashboard/ReadyCard";
import { SeasonsCard } from "../../components/dashboard/SeasonsCard";
import { ShotMap } from "../../components/dashboard/ShotMap";
import { SpendCard } from "../../components/dashboard/SpendCard";
import { StatTiles, StatTilesSkeleton } from "../../components/dashboard/StatTiles";
import { LoadError, RoomPage } from "../../components/room/kit";
import { Panel, Skeleton } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { useEpisode, useSettings } from "../../lib/queries";
import type { AutopilotState } from "../../lib/types";
import { useEpisodeDashboard } from "../../lib/v3";
import { useProjectCtx } from "./context";
import { nextStep } from "./nextStep";
import { usePipeline } from "./pipeline";

/**
 * Mission overview: the project's flight-control screen and the page a project opens on. A hero with the flight path and the next
 * best action, a telemetry strip, then a bento of the shot map, spend, delivery, change impact, cast, seasons and the whole project.
 */
export default function DashboardPage() {
  const t = useT();
  const nav = useNavigate();
  const { project, eid, lang, setEpisode, canEdit, canReview, canProduce } = useProjectCtx();
  const { data: d, isLoading, isError, refetch } = useEpisodeDashboard(eid);
  const { data: episode, isLoading: epLoading, isError: epError, refetch: refetchEpisode } = useEpisode(eid, lang);
  const { data: settings } = useSettings();
  const { stages } = usePipeline(project, episode);

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

  return (
    <RoomPage width="full" className="!pt-4">
      <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-12">
        {episode || d ? <div className="col-span-full"><MissionHero project={project} episode={episode} d={d} stages={stages} action={action} index={0} /></div>
          : epError ? <div className="col-span-full"><LoadError what={t("Couldn't load the episode")} onRetry={() => refetchEpisode()} /></div>
          : <div className="col-span-full"><MissionHeroSkeleton /></div>}

        {failed ? (
          <div className="col-span-full"><LoadError what={t("Couldn't load the dashboard")} onRetry={() => refetch()} /></div>
        ) : isLoading || !d ? (
          <>
            <div className="col-span-full"><StatTilesSkeleton /></div>
            <Panel className="@2xl:col-span-2 @5xl:col-span-8" eyebrow="···"><Skeleton className="h-56" /></Panel>
            <Panel className="@5xl:col-span-4" eyebrow="···"><Skeleton className="h-56" /></Panel>
          </>
        ) : (
          <>
            <div className="col-span-full"><StatTiles d={d} pid={project.id} canProduce={canProduce} index={1} /></div>
            <ShotMap className="@2xl:col-span-2 @5xl:col-span-8" index={2} episode={episode} loading={epLoading} error={epError} onRetry={() => refetchEpisode()} pid={project.id} />
            <SpendCard className="@5xl:col-span-4" index={3} d={d} project={project} />
            <div className="grid min-w-0 content-start gap-4 @5xl:col-span-5">
              <LiveQueue index={4} pid={project.id} shots={episode?.shots ?? []} />
              <ReadyCard index={5} d={d} pid={project.id} />
            </div>
            <ImpactPanel className="@2xl:col-span-2 @5xl:col-span-7" index={6} eid={eid} pid={project.id} canEdit={canEdit} canReview={canReview} />
            <CastStrip className="col-span-full" index={7} pid={project.id} cast={project.cast ?? []} />
            <SeasonsCard className="@2xl:col-span-2 @5xl:col-span-7" index={8} pid={project.id} currentEid={eid} canEdit={canEdit} onOpenEpisode={openEpisode} />
            <ProjectStrip className="@2xl:col-span-2 @5xl:col-span-5" index={9} pid={project.id} currentEid={eid} onOpenEpisode={switchEpisode} />
          </>
        )}
      </div>
    </RoomPage>
  );
}
