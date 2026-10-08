import { Gauge } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ImpactPanel } from "../../components/dashboard/ImpactPanel";
import { ProjectStrip } from "../../components/dashboard/ProjectStrip";
import { ReadyCard } from "../../components/dashboard/ReadyCard";
import { SeasonsCard } from "../../components/dashboard/SeasonsCard";
import { SpendCard } from "../../components/dashboard/SpendCard";
import { StatTiles, StatTilesSkeleton } from "../../components/dashboard/StatTiles";
import { Fact, LoadError, RoomHeader, RoomPage } from "../../components/room/kit";
import { Skeleton } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { useEpisodeDashboard } from "../../lib/v3";
import { useProjectCtx } from "./context";

/** Production dashboard: progress, footage, spend and the cost of every approved second, plus change impact and seasons. */
export default function DashboardPage() {
  const t = useT();
  const nav = useNavigate();
  const { project, eid, setEpisode, canEdit, canReview } = useProjectCtx();
  const { data: d, isLoading, isError, refetch } = useEpisodeDashboard(eid);
  const ep = project.episodes.find((e) => e.id === eid);
  const openEpisode = (id: number) => { setEpisode(id); nav(`/p/${project.id}/story`); };

  return (
    <RoomPage width="full">
      <RoomHeader icon={<Gauge />} title={t("Dashboard")} description={t("Progress, footage, spend and what still needs doing.")}
        status={d && (
          <span className="flex flex-wrap items-center gap-1.5">
            <Fact tone="accent">E{String(d.number).padStart(2, "0")} · {d.title || t("Untitled")}</Fact>
            <Fact>{t(d.status.replaceAll("_", " "))}</Fact>
            {ep?.season !== undefined && <Fact>{t("Season {n}", { n: ep.season })}</Fact>}
          </span>
        )} />

      {isError && !d ? (
        <LoadError what={t("Couldn't load the dashboard")} onRetry={() => refetch()} />
      ) : isLoading || !d ? (
        <div className="space-y-5">
          <StatTilesSkeleton />
          <div className="grid gap-5 @4xl:grid-cols-2" aria-busy="true"><Skeleton className="h-72 !rounded-xl" /><Skeleton className="h-72 !rounded-xl" /></div>
        </div>
      ) : (
        <div className="space-y-5">
          <StatTiles d={d} />
          <div className="grid items-start gap-5 @4xl:grid-cols-2">
            <SpendCard d={d} project={project} index={1} />
            <div className="space-y-5">
              <ReadyCard d={d} pid={project.id} index={2} />
              <ImpactPanel eid={eid} pid={project.id} canEdit={canEdit} canReview={canReview} index={3} />
            </div>
          </div>
          <SeasonsCard pid={project.id} currentEid={eid} canEdit={canEdit} onOpenEpisode={openEpisode} index={4} />
          <ProjectStrip pid={project.id} currentEid={eid} onOpenEpisode={openEpisode} index={5} />
        </div>
      )}
    </RoomPage>
  );
}
