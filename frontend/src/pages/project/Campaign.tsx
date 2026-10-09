import { Loader2, Megaphone } from "lucide-react";
import { useRef } from "react";
import { useSearchParams } from "react-router-dom";
import AdsWizard from "../../components/campaign/AdsWizard";
import CampaignBoard, { STATUS_TONE, statusLabel } from "../../components/campaign/CampaignBoard";
import Reels from "../../components/campaign/Reels";
import { useCampaign, useHighlights } from "../../components/campaign/types";
import { LoadError, RoomHeader, RoomPage } from "../../components/room/kit";
import { Badge, Panel, Skeleton, Tabs } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { useEpisode } from "../../lib/queries";
import { useProjectCtx } from "./context";
import "../../styles/console.css";

type Tab = "ads" | "reels";

/** Ads & Reels: a campaign wizard (every language × aspect variant with locked brand facts) and the reels highlight flow. */
export default function CampaignPage() {
  const t = useT();
  const { project, eid, lang, canEdit, setEpisode } = useProjectCtx();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "reels" ? "reels" : "ads";
  const setTab = (v: Tab) => { const p = new URLSearchParams(params); if (v === "ads") p.delete("tab"); else p.set("tab", v); setParams(p, { replace: true }); };
  const { data: ep, isLoading, isError, refetch } = useEpisode(eid, lang);
  const campaign = useCampaign(eid);
  const { data: hl } = useHighlights(eid);
  const wizard = useRef<HTMLElement>(null);
  const board = useRef<HTMLDivElement>(null);

  const cs = campaign.data?.status;
  const header = (
    <RoomHeader icon={<Megaphone size={18} />} title={t("Ads & Reels")} description={t("One brief, every language and aspect ratio. Reels cut from what you already made.")}
      status={cs && cs !== "none" ? <Badge tone={STATUS_TONE[cs]} dot={cs !== "running"}>{cs === "running" && <Loader2 className="size-3 animate-spin" />}{statusLabel(t, cs)}</Badge> : undefined} />
  );

  if (isError && !ep) return <RoomPage>{header}<LoadError onRetry={() => refetch()} /></RoomPage>;
  if (isLoading || !ep) {
    return (
      <RoomPage>
        {header}
        <div className="space-y-4" aria-hidden>
          <Skeleton className="h-9 w-56" />
          <Panel flush><div className="cx-kpis">{Array.from({ length: 4 }, (_, i) => <div key={i}><Skeleton className="mb-3 h-3 w-20" /><Skeleton className="h-7 w-16" /></div>)}</div></Panel>
          <Panel><Skeleton className="mb-4 h-11 w-full" /><div className="grid gap-4 md:grid-cols-[1fr_16rem]"><Skeleton className="h-44" /><Skeleton className="h-44" /></div></Panel>
          <Panel><Skeleton className="h-32" /></Panel>
        </div>
      </RoomPage>
    );
  }

  const variants = campaign.data?.variants.length ?? 0;
  return (
    <RoomPage>
      {header}
      <Tabs value={tab} onChange={setTab} className="mb-4" tabs={[
        { value: "ads", label: t("Ads"), count: variants || undefined },
        { value: "reels", label: t("Reels"), count: hl?.highlights.length || undefined },
      ]} />
      {tab === "ads" ? (
        <div className="space-y-4">
          <AdsWizard project={project} episode={ep} eid={eid} canEdit={canEdit} index={1} wizardRef={wizard}
            onStarted={() => board.current?.scrollIntoView({ behavior: "smooth", block: "start" })} />
          <div ref={board} className="scroll-mt-4">
            <CampaignBoard state={campaign.data} isLoading={campaign.isLoading} isError={campaign.isError} refetch={() => campaign.refetch()} pid={project.id} canEdit={canEdit} index={2} eid={eid}
              onNew={() => wizard.current?.scrollIntoView({ behavior: "smooth", block: "start" })} />
          </div>
        </div>
      ) : (
        <Reels project={project} episode={ep} eid={eid} canEdit={canEdit} setEpisode={setEpisode} />
      )}
    </RoomPage>
  );
}
