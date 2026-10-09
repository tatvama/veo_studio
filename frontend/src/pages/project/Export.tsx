import { useQueryClient } from "@tanstack/react-query";
import { Clapperboard, Film } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useGenerate } from "../../components/Generate";
import { LoadError, useActiveJobs } from "../../components/growth/common";
import { BrandPanel } from "../../components/growth/BrandPreview";
import ExportCard, { type ExportMetrics, type RenderRow } from "../../components/growth/ExportCard";
import MarketingPanel from "../../components/growth/MarketingPanel";
import NewRender, { useRenderHistory } from "../../components/growth/NewRender";
import PublishModal from "../../components/growth/PublishModal";
import { SoundDesignCard } from "../../components/growth/RenderOptions";
import RenderQueue, { buildQueue, countQueue, RenderStatusStrip } from "../../components/growth/RenderQueue";
import ReviewLinksModal from "../../components/growth/ReviewLinksModal";
import ReviewPanel from "../../components/growth/ReviewPanel";
import { CutdownCard, DubCard } from "../../components/growth/Tools";
import { YouTubePanel } from "../../components/growth/YouTubeIntegration";
import { RoomEmpty, RoomHeader, RoomPage } from "../../components/room/kit";
import { Button, Modal, Panel, Segmented, Skeleton } from "../../components/ui";
import "../../styles/console.css";
import "../../styles/export.css";
import { api } from "../../lib/api";
import { LANG_NAMES, LANG_SHORT, secs } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useEpisode, useHookInsights, useSettings } from "../../lib/queries";
import type { SubmitResult } from "../../lib/types";
import { useProjectCtx } from "./context";

type Filter = "all" | "final" | "animatic";

/** Placeholder with the shape of the console: header strip, the compose panel, side panels and the queue. */
function ExportSkeleton() {
  return (
    <RoomPage width="full">
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3" aria-busy="true">
        <div className="flex min-w-0 flex-1 basis-72 items-center gap-3">
          <Skeleton className="size-10" />
          <div className="space-y-2"><Skeleton className="h-5 w-24" /><Skeleton className="h-3.5 w-64 max-w-full" /></div>
        </div>
        <Skeleton className="h-14 w-full rounded-xl @xl:w-96" />
      </div>
      <div className="grid gap-4 @2xl:grid-cols-2 @4xl:grid-cols-12">
        <div className="space-y-4 rounded-xl border border-line bg-panel p-4 @2xl:col-span-2 @4xl:col-span-8">
          <Skeleton className="h-3 w-20" />
          <div className="grid gap-2.5 @md:grid-cols-2 @3xl:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[88px] rounded-xl" />)}</div>
          <div className="grid gap-2.5 @md:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div>
          <div className="flex justify-end gap-2"><Skeleton className="h-9 w-24" /><Skeleton className="h-9 w-28" /></div>
        </div>
        <div className="space-y-4 @2xl:col-span-2 @4xl:col-span-4">
          <div className="space-y-3 rounded-xl border border-line bg-panel p-4"><Skeleton className="h-3 w-16" /><Skeleton className="mx-auto h-56 w-40 rounded-xl" /></div>
          <div className="space-y-3 rounded-xl border border-line bg-panel p-4"><Skeleton className="h-3 w-16" /><Skeleton className="h-10 rounded-lg" /><Skeleton className="h-16 rounded-lg" /></div>
        </div>
        <div className="space-y-3 rounded-xl border border-line bg-panel p-4 @2xl:col-span-2 @4xl:col-span-12"><Skeleton className="h-3 w-24" /><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
      </div>
    </RoomPage>
  );
}

export default function ExportPage() {
  const t = useT();
  const { project, eid, lang, canEdit, canProduce, setEpisode } = useProjectCtx();
  const qc = useQueryClient();
  const { generate, submit } = useGenerate();
  const { data: ep, isLoading, isError, refetch, isFetching } = useEpisode(eid, lang);
  const { data: settings } = useSettings();
  const { data: insights } = useHookInsights();
  const { data: history } = useRenderHistory(project.id);
  const [filter, setFilter] = useState<Filter>("all");
  const [playing, setPlaying] = useState<RenderRow | null>(null);
  const [publishing, setPublishing] = useState<RenderRow | null>(null);
  const [sharing, setSharing] = useState<RenderRow | null>(null);
  const webhook = !!settings?.settings.make_webhook_url;

  const metricsJobs = useActiveJobs((j) => j.type === "fetch_metrics", undefined,
    () => qc.invalidateQueries({ queryKey: ["hook-insights"] }));
  const uploads = useActiveJobs((j) => j.type === "publish_youtube" && j.project_id === project.id, project.id);
  const renderJobs = useActiveJobs((j) => (j.type === "export" || j.type === "animatic") && j.episode_id === eid, project.id,
    () => qc.invalidateQueries({ queryKey: ["render-history", project.id] }));
  const dubJobs = useActiveJobs((j) => j.type === "dub" && j.episode_id === eid, project.id);
  // After the person starts a render, bring the queue into view if it is below the fold (so they see the job appear).
  const lastAsk = useRef(0);
  const prevJobs = useRef(renderJobs.length);
  useEffect(() => {
    const n = renderJobs.length;
    if (n > prevJobs.current && Date.now() - lastAsk.current < 10_000) {
      const list = document.getElementById("renders-section");
      const scroller = list?.closest<HTMLElement>("[data-page-scroller]");
      if (list && scroller && list.getBoundingClientRect().top > scroller.getBoundingClientRect().bottom - 120) {
        list.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
    prevJobs.current = n;
  }, [renderJobs.length]);
  const metricsById = useMemo(() => {
    const m: Record<number, ExportMetrics> = {};
    for (const r of insights ?? []) m[r.export_id] = { views: r.views, avg_view_pct: r.avg_view_pct };
    return m;
  }, [insights]);

  if (isError && !ep) return <RoomPage width="full"><LoadError title={t("We couldn't load this episode")} onRetry={() => refetch()} retrying={isFetching} className="mt-10" /></RoomPage>;
  if (isLoading || !ep) return <ExportSkeleton />;

  const shots = (ep.shots ?? []).filter((s) => s.include);
  const allExports = (ep.exports ?? []) as RenderRow[];
  const presets = settings?.catalog.export_presets ?? {};
  const finished = allExports.filter((x) => x.status === "ready");
  const hasAnimatics = allExports.some((x) => x.kind !== "final");
  const library = filter === "all" ? finished : finished.filter((x) => (filter === "final" ? x.kind === "final" : x.kind !== "final"));
  const knownJobs = new Set(allExports.map((x) => x.job_id));
  const pending = renderJobs.filter((j) => !knownJobs.has(j.id) && !allExports.some((x) => x.status === "running" && x.job_id === j.id));
  const epName = ep.title || t("Episode {n}", { n: ep.number });
  const total = ep.total_duration_s ?? shots.reduce((a, s) => a + (s.duration_s || 0), 0);

  const dub = async (l: string) => {
    if (!project.languages.includes(l)) {
      await api.patch(`/api/projects/${project.id}`, { languages: [...project.languages, l] });
      qc.invalidateQueries({ queryKey: ["project", project.id] });
    }
    await generate(eid, { action: "dub", language: l, preset: undefined }, t("Dub into {lang}", { lang: t(LANG_NAMES[l]) }));
  };

  const makeCuts = async (cuts: { count: number; seconds: number }) => {
    try {
      const r = await api.post<{ episode_ids: number[] }>(`/api/episodes/${eid}/cutdowns`, cuts);
      await qc.invalidateQueries({ queryKey: ["project", project.id] });
      toast.success(t("{n} cut-downs created — pick one from the episode menu", { n: r.episode_ids.length }));
      if (r.episode_ids[0]) setEpisode(r.episode_ids[0]);
    } catch {
      /* toasted */
    }
  };

  const approve = async (x: RenderRow) => {
    try {
      await api.post(`/api/exports/${x.id}/approve`);
      await qc.invalidateQueries({ queryKey: ["episode", eid] });
      toast.success(x.approved_by ? t("Approval removed") : t("Final render approved"));
    } catch {
      /* toasted */
    }
  };

  const rerender = (x: RenderRow) => generate(eid, {
    action: x.kind === "final" ? "export" : "animatic", language: x.language, preset: x.preset,
    captions: x.options?.captions !== false, music: x.options?.music !== false, publish: false,
  }, x.kind === "final"
    ? t("Export {preset} [{lang}]", { preset: t(presets[x.preset]?.label ?? x.preset), lang: LANG_SHORT[x.language] ?? x.language })
    : t("Animatic [{lang}]", { lang: LANG_SHORT[x.language] ?? x.language }));

  const refreshMetrics = () => submit(() => api.post<SubmitResult>("/api/metrics/refresh"), t("YouTube analytics"));
  const filterOptions: { value: Filter; label: string }[] = [
    { value: "all", label: t("All") }, { value: "final", label: t("Finals") }, { value: "animatic", label: t("Animatics") },
  ];

  const queue = buildQueue({ pending, exports: allExports, renderJobs, uploads, presets, lang, onRerender: canEdit ? rerender : undefined });
  const counts = countQueue(queue, finished.length);
  const spend = (history?.renders ?? []).filter((r) => r.episode_id === eid).reduce((a, r) => a + r.usd, 0);
  const newestFirst = [...finished].sort((a, b) => b.id - a.id);
  const goMarketing = () => document.getElementById("marketing-pack")?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <RoomPage width="full">
      <RoomHeader
        icon={<Clapperboard />}
        title={t("Export")}
        description={`${epName} · ${t("{n} shots", { n: shots.length })} · ${secs(total)} · ${project.aspect}`}
        status={<RenderStatusStrip counts={counts} spend={spend} />}
      />

      <div className="grid gap-4 @2xl:grid-cols-2 @4xl:grid-cols-12 @4xl:items-start">
        {/* compose + channel (the two wrappers only group on wide screens; below that the panels flow in one grid) */}
        <div className="contents @4xl:col-span-8 @4xl:flex @4xl:flex-col @4xl:gap-4">
          <div id="new-render" className="order-1 min-w-0 scroll-mt-4 @2xl:col-span-2 @4xl:order-none">
            <NewRender project={project} episode={ep} lang={lang} canEdit={canEdit} presets={presets} webhook={webhook} onRequested={() => { lastAsk.current = Date.now(); }} />
          </div>
          <YouTubePanel className="order-4 @4xl:order-none" exports={allExports} metrics={metricsById} canProduce={canProduce} refreshing={metricsJobs.length > 0} onRefreshMetrics={refreshMetrics} />
        </div>

        {/* brand + review */}
        <div className="contents @4xl:col-span-4 @4xl:flex @4xl:flex-col @4xl:gap-4">
          <BrandPanel className="order-5 @4xl:order-none" project={project} />
          <ReviewPanel className="order-6 @2xl:col-span-2 @4xl:order-none" renders={newestFirst} presets={presets} pid={project.id} canEdit={canEdit} onManage={(x) => setSharing(x)} />
        </div>

        {/* queue */}
        <div className="order-2 min-w-0 scroll-mt-4 @2xl:col-span-2 @4xl:order-none @4xl:col-span-12">
          <RenderQueue items={queue} />
        </div>

        {/* finished renders: a wall of monitors */}
        <Panel className="order-3 @2xl:col-span-2 @4xl:order-none @4xl:col-span-12" index={3} eyebrow={t("Library")} icon={<Film />} title={t("Finished renders")}
          actions={<>
            <span className="mono text-2xs text-dim" title={t("Renders")}>{library.length}</span>
            {hasAnimatics && (
              <Segmented size="sm" value={filter} onChange={setFilter} aria-label={t("Show")} options={filterOptions} className="max-sm:[&>button]:min-h-9" />
            )}
          </>}>
          {!library.length ? (
            <RoomEmpty icon={<Clapperboard />}
              title={filter === "all" ? (queue.length ? t("Nothing finished yet") : t("No renders yet")) : t("No {kind} renders", { kind: filter === "final" ? t("final") : t("animatic") })}
              sub={queue.length && filter === "all" ? t("Finished renders land here when the queue is done.") : t("Make an animatic to check timing, then render the final.")}
              action={canEdit ? <Button variant="outline" icon={<Clapperboard className="size-4" />}
                onClick={() => document.getElementById("new-render")?.scrollIntoView({ behavior: "smooth", block: "start" })}>{t("Start a render")}</Button> : undefined} />
          ) : (
            <div className="xp-tiles">
              <AnimatePresence initial={false}>
                {library.map((x) => (
                  <ExportCard key={x.id} x={x} pid={project.id} preset={presets[x.preset]} canProduce={canProduce} canEdit={canEdit}
                    metrics={metricsById[x.id]} upload={uploads.find((j) => Number(j.payload?.export_id) === x.id) ?? null}
                    onPlay={() => setPlaying(x)} onPublish={() => setPublishing(x)} onLinks={() => setSharing(x)}
                    onApprove={() => approve(x)} onRerender={() => rerender(x)} onMarketing={goMarketing} />
                ))}
              </AnimatePresence>
            </div>
          )}
        </Panel>

        {/* tools */}
        <div className="order-7 grid gap-4 @2xl:col-span-2 @2xl:grid-cols-2 @4xl:order-none @4xl:col-span-12 @4xl:grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))]">
          <DubCard project={project} episode={ep} canEdit={canEdit} jobs={dubJobs} onDub={dub} />
          {canEdit && ep.kind !== "cutdown" && <CutdownCard onCreate={makeCuts} />}
          <SoundDesignCard project={project} episode={ep} canEdit={canEdit} />
        </div>

        {/* AI copy */}
        <div className="order-8 min-w-0 @2xl:col-span-2 @4xl:order-none @4xl:col-span-12">
          <MarketingPanel project={project} episode={ep} canEdit={canEdit} />
        </div>
      </div>

      <Modal open={!!playing} onClose={() => setPlaying(null)} size={playing && presets[playing.preset]?.w && presets[playing.preset].w < presets[playing.preset].h * 0.9 ? "md" : "lg"}
        title={playing ? `${playing.kind === "final" ? t("Final") : t("Animatic")} · ${t(LANG_NAMES[playing.language] ?? playing.language)} · ${secs(playing.duration_s)}` : ""}>
        {playing && <video src={playing.url} controls autoPlay playsInline className="mx-auto max-h-[72vh] max-w-full rounded-lg bg-black" />}
      </Modal>
      {canProduce && <PublishModal x={publishing} onClose={() => setPublishing(null)} project={project} episode={ep} />}
      <ReviewLinksModal x={sharing} onClose={() => setSharing(null)} pid={project.id} canEdit={canEdit} />
    </RoomPage>
  );
}
