import { CloudUpload, MonitorPlay } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { toast } from "sonner";
import { LoadError } from "../../components/growth/common";
import { RoomHeader, RoomPage } from "../../components/room/kit";
import { Alert, Badge, Button, Skeleton } from "../../components/ui";
import { dcall, isDesktop, useDesktopInfo, useOffline } from "../../lib/desktop";
import { useCheckout, useCheckoutHeartbeat } from "../../lib/finish";
import { secs } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useEpisode } from "../../lib/queries";
import { useProjectCtx } from "./context";
import { CheckoutCard } from "./finish/CheckoutCard";
import { DesktopPromo } from "./finish/DesktopPromo";
import { FolderCard } from "./finish/FolderCard";
import { MachineCard } from "./finish/MachineCard";
import { NamingCard } from "./finish/NamingCard";
import { NotesCard } from "./finish/NotesCard";
import { RenderCard } from "./finish/RenderCard";
import { UpscaleCard } from "./finish/UpscaleCard";
import { VersionsCard } from "./finish/VersionsCard";
import { WindowsCard } from "./finish/WindowsCard";

/** Desktop only: the gateway lost the studio server; cut edits wait in its queue. */
function OfflineAlert() {
  const t = useT();
  const s = useOffline();
  const [busy, setBusy] = useState(false);
  if (!s || (s.online && !s.queued)) return null;
  const flush = async () => {
    setBusy(true);
    const ok = await dcall(t("Sync edits"), (d) => d.offline.flush().then(() => true));
    setBusy(false);
    if (ok) toast.success(t("Queued edits sent"));
  };
  return (
    <Alert tone={s.online ? "info" : "warn"} className="mb-4"
      title={s.online ? t("{n} edits made offline are waiting to sync", { n: s.queued }) : t("Working offline")}
      action={s.online && s.queued > 0 ? <Button size="sm" variant="outline" icon={<CloudUpload className="size-3.5" />} loading={busy} onClick={flush}>{t("Send now")}</Button> : undefined}>
      {s.online
        ? t("They go to the server in the order you made them.")
        : t("The studio server can't be reached. Keep cutting: {n} edits are queued and sync when it's back. AI work needs the server.", { n: s.queued })}
      {s.lastError && <span className="mono mt-1 block text-2xs text-dim">{s.lastError}</span>}
    </Alert>
  );
}

/**
 * Step 4 · Edit › Finishing room: check the cut out, keep versions, and finish it — locally in 4K on Tatvam Desktop (folder,
 * file names, renders, screens, this machine), or from the web (checkout, versions, AI upscale, review notes, pop-outs).
 */
export default function FinishPage() {
  const t = useT();
  const { project, eid, lang, canEdit, canProduce } = useProjectCtx();
  const { data: ep, isLoading, isError, refetch, isFetching } = useEpisode(eid, lang);
  const { data: info } = useDesktopInfo();
  const { lock } = useCheckout(eid);
  useCheckoutHeartbeat(eid, isDesktop && !!lock?.mine);
  const { hash } = useLocation();
  useEffect(() => { // e.g. Help → Machine check opens #machine
    if (hash && ep) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hash, ep]);

  if (isError && !ep) return <RoomPage width="full"><LoadError title={t("We couldn't load this episode")} onRetry={() => refetch()} retrying={isFetching} className="mt-10" /></RoomPage>;
  if (isLoading || !ep) {
    return (
      <RoomPage width="full">
        <div className="mb-5 flex items-center gap-3"><Skeleton className="size-10" /><div className="space-y-2"><Skeleton className="h-5 w-40" /><Skeleton className="h-3.5 w-72" /></div></div>
        <div className="grid gap-4 @4xl:grid-cols-12">
          <Skeleton className="h-56 rounded-xl @4xl:col-span-5" /><Skeleton className="h-56 rounded-xl @4xl:col-span-7" />
          <Skeleton className="h-72 rounded-xl @4xl:col-span-7" /><Skeleton className="h-72 rounded-xl @4xl:col-span-5" />
        </div>
      </RoomPage>
    );
  }

  const shots = (ep.shots ?? []).filter((s) => s.include);
  const total = ep.total_duration_s ?? shots.reduce((a, s) => a + (s.duration_s || 0), 0);
  const epName = ep.title || t("Episode {n}", { n: ep.number });
  const exports = ep.exports ?? [];
  const pid = project.id;

  return (
    <RoomPage width="full">
      <RoomHeader icon={<MonitorPlay />} title={t("Finishing room")}
        description={`${epName} · ${t("{n} shots", { n: shots.length })} · ${secs(total)} · ${t("Check out the cut, keep versions, and finish it in 4K.")}`}
        status={isDesktop
          ? <Badge tone="accent" dot>{t("Tatvam Desktop")}{info?.appVersion ? ` ${info.appVersion}` : ""}</Badge>
          : <Badge tone="neutral">{t("Web")}</Badge>} />
      {isDesktop && <OfflineAlert />}

      <div className="grid gap-4 @4xl:grid-cols-12 @4xl:items-start">
        <CheckoutCard className="@4xl:col-span-5" eid={eid} canEdit={canEdit} canProduce={canProduce} />
        <VersionsCard className="@4xl:col-span-7" eid={eid} canEdit={canEdit} />

        {isDesktop ? (
          <>
            <FolderCard className="@4xl:col-span-7" pid={pid} eid={eid} lang={lang} />
            <NamingCard className="@4xl:col-span-5" pid={pid} />
            <RenderCard className="@4xl:col-span-7" project={project} eid={eid} lang={lang} exports={exports} canEdit={canEdit} />
            <UpscaleCard className="@4xl:col-span-5" pid={pid} eid={eid} canEdit={canEdit} />
            <WindowsCard className="@4xl:col-span-7" pid={pid} eid={eid} />
            <MachineCard className="@4xl:col-span-5" pid={pid} />
            <NotesCard className="@4xl:col-span-12" eid={eid} pid={pid} />
          </>
        ) : (
          <>
            <DesktopPromo className="@4xl:col-span-12" pid={pid} eid={eid} />
            <UpscaleCard className="@4xl:col-span-7" pid={pid} eid={eid} canEdit={canEdit} />
            <RenderCard className="@4xl:col-span-5" project={project} eid={eid} lang={lang} exports={exports} canEdit={canEdit} />
            <NotesCard className="@4xl:col-span-7" eid={eid} pid={pid} />
            <WindowsCard className="@4xl:col-span-5" pid={pid} eid={eid} />
          </>
        )}
      </div>
    </RoomPage>
  );
}
