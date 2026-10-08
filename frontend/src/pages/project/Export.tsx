import { useQueryClient } from "@tanstack/react-query";
import { BarChart3, Clapperboard, MonitorPlay } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useGenerate } from "../../components/Generate";
import { LoadError, Notice, useActiveJobs } from "../../components/growth/common";
import ExportCard, { PendingRenderCard, type ExportMetrics, type RenderRow } from "../../components/growth/ExportCard";
import MarketingPanel from "../../components/growth/MarketingPanel";
import NewRender from "../../components/growth/NewRender";
import PublishModal from "../../components/growth/PublishModal";
import { SoundDesignCard } from "../../components/growth/RenderOptions";
import ReviewLinksModal from "../../components/growth/ReviewLinksModal";
import { CutdownCard, DubCard } from "../../components/growth/Tools";
import { Badge, Button, Empty, InView, Modal, Page, PageHeader, rise, Segmented, Skeleton } from "../../components/ui";
import { api } from "../../lib/api";
import { LANG_NAMES, LANG_SHORT, secs } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useEpisode, useHookInsights, useIntegrations, useSettings } from "../../lib/queries";
import type { SubmitResult } from "../../lib/types";
import { useProjectCtx } from "./context";

type Filter = "all" | "final" | "animatic";

/** True while the element is short enough to stay pinned in view (a column taller than the screen must scroll normally). */
function useFitsInView<T extends HTMLElement>(): [(el: T | null) => void, boolean] {
  const [el, setEl] = useState<T | null>(null);
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    if (!el) return;
    const scroller = el.closest<HTMLElement>("[data-page-scroller]");
    if (!scroller) return;
    const measure = () => setFits(el.offsetHeight <= scroller.clientHeight - 40);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, fits];
}

function ExportSkeleton() {
  return (
    <Page width="wide">
      <div className="mb-6 flex items-center gap-3"><Skeleton className="size-10 rounded-xl" /><div className="space-y-2"><Skeleton className="h-6 w-32" /><Skeleton className="h-3.5 w-64" /></div></div>
      <div className="grid gap-6 lg:grid-cols-[430px_minmax(0,1fr)]">
        <div className="space-y-4 rounded-xl border border-line bg-panel p-5">
          <div className="flex gap-3"><Skeleton className="size-9 rounded-xl" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-28" /><Skeleton className="h-3 w-full" /></div></div>
          <div className="grid grid-cols-2 gap-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className={`h-[62px] rounded-xl ${i === 4 ? "col-span-2" : ""}`} />)}</div>
          <Skeleton className="h-40 rounded-xl" />
          <div className="flex justify-end gap-2"><Skeleton className="h-9 w-24" /><Skeleton className="h-9 w-24" /></div>
        </div>
        <div className="space-y-3">
          <Skeleton className="h-6 w-28" />
          {[0, 1].map((i) => (
            <div key={i} className="flex gap-4 rounded-xl border border-line bg-panel p-4"><Skeleton className="h-[148px] w-[84px] shrink-0" />
              <div className="flex-1 space-y-3"><Skeleton className="h-4 w-48" /><Skeleton className="h-3 w-64" /><Skeleton className="h-3 w-32" /><div className="flex gap-2 pt-2"><Skeleton className="h-7 w-20" /><Skeleton className="h-7 w-24" /><Skeleton className="h-7 w-16" /></div></div>
            </div>
          ))}
        </div>
      </div>
    </Page>
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
  const { data: integ } = useIntegrations();
  const [filter, setFilter] = useState<Filter>("all");
  const [formRef, formFits] = useFitsInView<HTMLDivElement>();
  const [listRef, listFits] = useFitsInView<HTMLElement>();
  const [playing, setPlaying] = useState<RenderRow | null>(null);
  const [publishing, setPublishing] = useState<RenderRow | null>(null);
  const [sharing, setSharing] = useState<RenderRow | null>(null);
  const webhook = !!settings?.settings.make_webhook_url;

  const metricsJobs = useActiveJobs((j) => j.type === "fetch_metrics", undefined,
    () => qc.invalidateQueries({ queryKey: ["hook-insights"] }));
  const uploads = useActiveJobs((j) => j.type === "publish_youtube" && j.project_id === project.id, project.id);
  const renderJobs = useActiveJobs((j) => (j.type === "export" || j.type === "animatic") && j.episode_id === eid, project.id);
  const dubJobs = useActiveJobs((j) => j.type === "dub" && j.episode_id === eid, project.id);
  // When the layout is stacked, bring the Renders list into view after the person starts a render (so they see it appear).
  const lastAsk = useRef(0);
  const prevJobs = useRef(renderJobs.length);
  useEffect(() => {
    const n = renderJobs.length;
    if (n > prevJobs.current && Date.now() - lastAsk.current < 10_000) {
      const list = document.getElementById("renders-section");
      const form = document.getElementById("new-render");
      if (list && form && list.getBoundingClientRect().top >= form.getBoundingClientRect().bottom - 1) list.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    prevJobs.current = n;
  }, [renderJobs.length]);
  const metricsById = useMemo(() => {
    const m: Record<number, ExportMetrics> = {};
    for (const r of insights ?? []) m[r.export_id] = { views: r.views, avg_view_pct: r.avg_view_pct };
    return m;
  }, [insights]);

  if (isError && !ep) return <Page width="wide"><LoadError title={t("We couldn't load this episode")} onRetry={() => refetch()} retrying={isFetching} className="mt-10" /></Page>;
  if (isLoading || !ep) return <ExportSkeleton />;

  const shots = (ep.shots ?? []).filter((s) => s.include);
  const allExports = (ep.exports ?? []) as RenderRow[];
  const presets = settings?.catalog.export_presets ?? {};
  const hasAnimatics = allExports.some((x) => x.kind !== "final");
  const exports = filter === "all" ? allExports : allExports.filter((x) => (filter === "final" ? x.kind === "final" : x.kind !== "final"));
  const anyPublished = allExports.some((x) => x.published?.youtube?.video_id);
  const hasYouTube = (integ?.accounts ?? []).some((a) => a.provider === "youtube");
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

  return (
    <Page width="wide" className="!py-5 sm:!py-6">
      <PageHeader
        className="!mb-4"
        icon={<Clapperboard className="size-5" />}
        title={t("Export")}
        subtitle={`${epName} · ${t("{n} shots", { n: shots.length })} · ${secs(total)} · ${project.aspect}`}
      />

      <div className="@container space-y-6">
        <div className="grid items-start gap-6 @3xl:grid-cols-[minmax(340px,min(38%,440px))_minmax(0,1fr)]">
          <div id="new-render" ref={formRef} {...rise(1)} className={`${rise(1).className} scroll-mt-4 ${formFits ? "@3xl:sticky @3xl:top-4" : ""}`}>
            <NewRender project={project} episode={ep} lang={lang} canEdit={canEdit} presets={presets} webhook={webhook} onRequested={() => { lastAsk.current = Date.now(); }} />
          </div>

          <section id="renders-section" ref={listRef} {...rise(2)} className={`${rise(2).className} min-w-0 scroll-mt-4 ${listFits ? "@3xl:sticky @3xl:top-4" : ""}`} aria-labelledby="renders-h">
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2 id="renders-h" className="text-base font-semibold tracking-tight">{t("Renders")}</h2>
              <Badge>{allExports.length}</Badge>
              <div className="flex-1" />
              {hasAnimatics && (
                <Segmented size="sm" value={filter} onChange={setFilter} aria-label={t("Show")} options={filterOptions} />
              )}
              {canProduce && anyPublished && (
                <Button size="sm" variant="outline" className="max-sm:h-10" icon={<BarChart3 className="size-3.5" />} loading={metricsJobs.length > 0} onClick={refreshMetrics}>
                  {t("Refresh metrics")}
                </Button>
              )}
            </div>

            {canProduce && !hasYouTube && integ && (
              <Notice tone="neutral" icon={<MonitorPlay className="mt-0.5 size-4 shrink-0 text-mute" />} className="mb-3 !py-2.5 text-xs"
                action={<Link to="/settings#integrations" className="whitespace-nowrap text-xs font-medium text-accent-ink hover:underline">{t("Connect YouTube to publish")}</Link>}>
                {t("Publish finished renders straight to your channel.")}
              </Notice>
            )}

            {!exports.length && !pending.length ? (
              <Empty icon={<Clapperboard className="size-7" />}
                title={filter === "all" ? t("No renders yet") : t("No {kind} renders", { kind: filter === "final" ? t("final") : t("animatic") })}
                sub={t("Make an animatic to check timing, then render the final.")}
                action={canEdit ? <Button variant="primary" icon={<Clapperboard className="size-4" />}
                  onClick={() => document.getElementById("new-render")?.scrollIntoView({ behavior: "smooth", block: "start" })}>{t("Start a render")}</Button> : undefined} />
            ) : (
              <div className="space-y-3">
                <AnimatePresence initial={false}>
                  {pending.map((j) => (
                    <PendingRenderCard key={`job-${j.id}`} job={j} kind={j.type === "export" ? "final" : "animatic"}
                      language={String(j.payload?.language ?? lang)} preset={presets[String(j.payload?.preset ?? "")]} />
                  ))}
                  {exports.map((x) => (
                    <ExportCard key={x.id} x={x} pid={project.id} preset={presets[x.preset]} canProduce={canProduce} canEdit={canEdit}
                      metrics={metricsById[x.id]} job={renderJobs.find((j) => j.id === x.job_id) ?? null}
                      upload={uploads.find((j) => Number(j.payload?.export_id) === x.id) ?? null}
                      onPlay={() => setPlaying(x)} onPublish={() => setPublishing(x)} onLinks={() => setSharing(x)}
                      onApprove={() => approve(x)} onRerender={() => rerender(x)} />
                  ))}
                </AnimatePresence>
              </div>
            )}
          </section>
        </div>

        <div className="grid items-start gap-6 @3xl:grid-cols-2">
          <InView><DubCard project={project} episode={ep} canEdit={canEdit} jobs={dubJobs} onDub={dub} /></InView>
          <div className="space-y-6">
            {canEdit && ep.kind !== "cutdown" && <InView delay={0.05}><CutdownCard onCreate={makeCuts} /></InView>}
            <InView delay={0.1}><SoundDesignCard project={project} episode={ep} canEdit={canEdit} /></InView>
          </div>
        </div>

        <InView><MarketingPanel project={project} episode={ep} canEdit={canEdit} /></InView>
      </div>

      <Modal open={!!playing} onClose={() => setPlaying(null)} size={playing && presets[playing.preset]?.w && presets[playing.preset].w < presets[playing.preset].h * 0.9 ? "md" : "lg"}
        title={playing ? `${playing.kind === "final" ? t("Final") : t("Animatic")} · ${t(LANG_NAMES[playing.language] ?? playing.language)} · ${secs(playing.duration_s)}` : ""}>
        {playing && <video src={playing.url} controls autoPlay playsInline className="mx-auto max-h-[72vh] max-w-full rounded-xl bg-black" />}
      </Modal>
      {canProduce && <PublishModal x={publishing} onClose={() => setPublishing(null)} project={project} episode={ep} />}
      <ReviewLinksModal x={sharing} onClose={() => setSharing(null)} pid={project.id} canEdit={canEdit} />
    </Page>
  );
}
