import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { BadgeCheck, ChevronsUpDown, Clapperboard, GitCompare, MessageSquareText, Share2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { LoadError } from "../../components/growth/common";
import ReviewLinksModal from "../../components/growth/ReviewLinksModal";
import { ReviewWorkspace, WORKSPACE_WIDE, type NewComment } from "../../components/review/ReviewWorkspace";
import { fpsOf, relTime, useElementWidth, type RComment } from "../../components/review/utils";
import { WipeCompare, type CompareSource } from "../../components/review/WipeCompare";
import { Alert, Badge, Button, Empty, Menu, Segmented, Skeleton, Tooltip } from "../../components/ui";
import { api } from "../../lib/api";
import { LANG_NAMES, LANG_SHORT, secs } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useEpisode, useSettings } from "../../lib/queries";
import type { Comment, ExportRow } from "../../lib/types";
import { useProjectCtx } from "./context";

type Mode = "review" | "compare";

/** Same cache key as `useComments` (so live events refresh it) but disabled until a render is chosen. */
const useExportComments = (pid: number, xid: number | undefined) =>
  useQuery({
    queryKey: ["comments", pid, "export", xid],
    queryFn: () => api.get<Comment[]>(`/api/comments?project_id=${pid}&target_type=export&target_id=${xid}`),
    enabled: !!xid,
  });

function toRComment(c: Comment): RComment {
  const guest = !!c.guest_name && (!c.user || c.user.id === 0);
  return {
    id: c.id, body: c.body, timecode: c.timecode ?? null, drawing: Array.isArray(c.drawing) ? c.drawing : [], resolved: c.resolved,
    created_at: c.created_at, author: guest ? c.guest_name! : (c.user?.name ?? tr("Guest")), guest,
  };
}

/** Small frame-shaped thumbnail (portrait, landscape or square) of a render. */
function MiniThumb({ x, ratio }: { x: ExportRow; ratio: number }) {
  const h = 40;
  const w = Math.round(Math.min(72, Math.max(24, h * ratio)));
  return (
    <span className="relative grid shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-black" style={{ width: w, height: h }}>
      {x.thumb_url ? <img src={x.thumb_url} alt="" className="size-full object-cover" /> : <Clapperboard className="size-4 text-dim" />}
    </span>
  );
}

export default function ReviewPage() {
  const { project, eid, lang, canEdit, canReview, canProduce } = useProjectCtx();
  const t = useT();
  const qc = useQueryClient();
  const { data: ep, isLoading, isError, refetch, isFetching } = useEpisode(eid, lang);
  const { data: settings } = useSettings();
  const presets = settings?.catalog.export_presets ?? {};
  const [params, setParams] = useSearchParams();
  const [shareOpen, setShareOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const mode: Mode = params.get("mode") === "compare" ? "compare" : "review";
  const [areaRef, areaWidth] = useElementWidth<HTMLDivElement>();
  const wide = areaWidth >= WORKSPACE_WIDE + 40; // the area has 24–40 px of side padding

  const ready = useMemo(() => (ep?.exports ?? []).filter((x) => x.status === "ready" && x.url), [ep?.exports]);
  const want = Number(params.get("export")) || null;
  const current: ExportRow | undefined = ready.find((x) => x.id === want) ?? ready.find((x) => x.kind === "final") ?? ready[0];
  const fps = fpsOf(current?.options?.fps);
  const preset = current ? presets[current.preset] : undefined;
  const aspectHint = preset?.w && preset?.h ? preset.w / preset.h : undefined;

  useEffect(() => {
    if (want && ep && ready.length && !ready.some((x) => x.id === want)) {
      toast.info(t("That render isn't in this episode (or isn't ready yet) — showing the latest one."));
    }
  }, [want, ep?.id, ready.length]);

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v === null) next.delete(k); else next.set(k, v);
    setParams(next, { replace: true });
  };

  const kindLabel = (x: ExportRow) => (x.kind === "final" ? t("Final") : t("Animatic"));
  const label = (x: ExportRow) =>
    `#${x.id} · ${kindLabel(x)} · ${LANG_SHORT[x.language] ?? x.language} · ${presets[x.preset]?.label ?? x.preset} · ${secs(x.duration_s)}`;
  const short = (x: ExportRow) => `${kindLabel(x)} ${LANG_SHORT[x.language] ?? x.language} · ${presets[x.preset]?.aspect ?? x.preset} · #${x.id}`;

  const { data: rawComments, isLoading: loadingComments, isError: commentsError, refetch: refetchComments } = useExportComments(project.id, current?.id);
  const comments = useMemo(() => (current ? (rawComments ?? []).filter((c) => c.target_type === "export" && c.target_id === current.id).map(toRComment) : []),
    [rawComments, current?.id]);

  const addComment = async (c: NewComment) => {
    if (!current) return;
    await api.post<Comment>("/api/comments", { project_id: project.id, target_type: "export", target_id: current.id, ...c });
    await qc.invalidateQueries({ queryKey: ["comments", project.id] });
    toast.success(t("Comment added"));
  };
  const resolve = async (c: RComment) => {
    await api.post<Comment>(`/api/comments/${c.id}/resolve`);
    await qc.invalidateQueries({ queryKey: ["comments", project.id] });
    toast.success(c.resolved ? t("Comment reopened") : t("Comment resolved"));
  };
  const approve = async () => {
    if (!current) return;
    setApproving(true);
    try {
      const x = await api.post<ExportRow>(`/api/exports/${current.id}/approve`);
      await qc.invalidateQueries({ queryKey: ["episode", eid] });
      toast.success(x.approved_by ? t("Render approved") : t("Approval removed"));
    } catch {
      /* api client already showed the error */
    } finally {
      setApproving(false);
    }
  };

  const sources: CompareSource[] = useMemo(() => ready.map((x) => ({
    id: x.id, src: x.url, label: label(x), short: short(x), peaks: x.peaks, duration: x.duration_s,
  })), [ready, presets]);
  const compareB = useMemo(() => {
    if (!current) return undefined;
    const others = ready.filter((x) => x.id !== current.id);
    return (others.find((x) => x.preset === current.preset && x.language === current.language && x.kind === current.kind)
      ?? others.find((x) => x.language !== current.language) ?? others[0])?.id;
  }, [ready, current?.id]);

  // ── loading / error / empty ──
  if (isError && !ep) return <div className="h-full overflow-y-auto p-6"><LoadError title={t("We couldn't load this episode")} onRetry={() => refetch()} retrying={isFetching} className="mt-8" /></div>;
  if (isLoading || !ep) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <Skeleton className="h-10 w-7" /><div className="space-y-1.5"><Skeleton className="h-3.5 w-40" /><Skeleton className="h-3 w-56" /></div>
          <div className="flex-1" /><Skeleton className="h-8 w-40" /><Skeleton className="h-8 w-28" />
        </div>
        <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Skeleton className="min-h-[280px] rounded-xl" />
          <Skeleton className="hidden rounded-xl lg:block" />
        </div>
      </div>
    );
  }
  if (!current) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <div className="mx-auto max-w-xl pt-6">
          <Empty icon={<MessageSquareText className="size-7" />} title={t("Nothing to review yet")}
            sub={t("Render an animatic or a final in Export — every ready render can be reviewed here with frame-accurate comments.")}
            action={<Link to={`/p/${project.id}/export`}><Button variant="primary" icon={<Clapperboard className="size-4" />}>{t("Go to Export")}</Button></Link>} />
        </div>
      </div>
    );
  }

  const approved = !!current.approved_by;
  const title = `${kindLabel(current)} · ${t(LANG_NAMES[current.language] ?? current.language)}`;
  const meta = `${preset?.label ? t(preset.label) : current.preset} · ${secs(current.duration_s)} · ${relTime(current.created_at)}`;

  const pickerBody = (
    <>
      <MiniThumb x={current} ratio={aspectHint ?? 9 / 16} />
      <span className="min-w-0 text-left">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold leading-tight">{title}</span>
          <AnimatePresence initial={false}>
            {approved && (
              <motion.span key="ok" initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} transition={{ duration: 0.18 }}>
                <Badge tone="ok"><BadgeCheck className="size-3" />{t("Approved")}</Badge>
              </motion.span>
            )}
          </AnimatePresence>
        </span>
        <span className="mt-0.5 block truncate text-xs text-mute">{meta}</span>
      </span>
    </>
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto overscroll-contain" data-page-scroller>
      <h1 className="sr-only">{t("Review")} · {title}</h1>
      {/* header */}
      <div className="z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-bg/85 px-3 py-2 backdrop-blur sm:sticky sm:top-0 sm:px-4 lg:px-5">
        {ready.length > 1 ? (
          <Menu
            placement="bottom-start"
            width={320}
            trigger={(p) => (
              <button type="button" {...p} aria-label={t("Switch render")}
                className="group -ml-1.5 flex min-w-0 max-w-full items-center gap-3 rounded-xl border border-transparent px-1.5 py-1 transition-colors hover:border-line hover:bg-hover/60 aria-expanded:border-line aria-expanded:bg-hover/60">
                {pickerBody}
                <ChevronsUpDown className="size-4 shrink-0 text-dim transition-colors group-hover:text-ink" />
              </button>
            )}
            items={ready.map((x) => ({
              label: `${kindLabel(x)} · ${t(LANG_NAMES[x.language] ?? x.language)} · ${presets[x.preset]?.aspect ?? t(presets[x.preset]?.label ?? x.preset)}`,
              active: x.id === current.id,
              icon: x.approved_by ? <BadgeCheck className="size-4 text-ok" /> : <Clapperboard className="size-4" />,
              shortcut: <span className="font-mono text-2xs">#{x.id}</span>,
              onClick: () => setParam("export", String(x.id)),
            }))}
          />
        ) : (
          <div className="flex min-w-0 items-center gap-3">{pickerBody}</div>
        )}
        <div className="flex-1" />
        <Segmented value={mode} onChange={(m) => setParam("mode", m === "compare" ? "compare" : null)} aria-label={t("Review mode")} options={[
          { value: "review", label: <span className="flex items-center gap-1.5"><MessageSquareText className="size-3.5" /><span className="max-sm:sr-only">{t("Review")}</span></span> },
          { value: "compare", label: <span className="flex items-center gap-1.5"><GitCompare className="size-3.5" /><span className="max-sm:sr-only">{t("Compare")}</span></span>, title: ready.length < 2 ? t("Needs two ready renders") : undefined },
        ]} />
        {canEdit && <Button size="sm" icon={<Share2 className="size-3.5" />} onClick={() => setShareOpen(true)}>{t("Client link")}</Button>}
        {canProduce && (
          <Tooltip content={current.kind !== "final" ? t("Only final renders can be approved") : ""} disabled={current.kind === "final"}>
            <span className="inline-flex">
              <Button size="sm" variant={approved ? "outline" : "primary"} loading={approving} onClick={approve} disabled={current.kind !== "final"}
                icon={<BadgeCheck className={clsx("size-3.5", approved && "text-ok")} />}>
                {approved ? t("Unapprove") : t("Approve export")}
              </Button>
            </span>
          </Tooltip>
        )}
      </div>

      {mode === "compare" && ready.length < 2 && (
        <div className="px-3 pt-3 sm:px-4 lg:px-5">
          <Alert tone="info">{t("Compare needs at least two ready renders of this episode — render another version or language in Export.")}</Alert>
        </div>
      )}

      {/* workspace: fills the height when wide, flows (and the page scrolls) when stacked */}
      <div ref={areaRef} className={clsx("px-3 pb-3 pt-3 sm:px-4 lg:px-5", wide ? "min-h-[460px] flex-1" : "flex-none")}>
        <AnimatePresence mode="wait" initial={false}>
          {mode === "compare" && ready.length >= 2 ? (
            <motion.div key={`compare-${current.id}`} className={wide ? "h-full" : undefined} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
              <WipeCompare sources={sources} initialA={current.id} initialB={compareB} fps={fps} layout={wide ? "wide" : "stacked"} />
            </motion.div>
          ) : (
            <motion.div key={`review-${current.id}`} className={wide ? "h-full" : undefined} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
              <ReviewWorkspace
                layout={wide ? "wide" : "stacked"}
                src={current.url}
                poster={current.thumb_url || undefined}
                fps={fps}
                peaks={current.peaks}
                durationHint={current.duration_s}
                aspectHint={aspectHint}
                comments={comments}
                loadingComments={loadingComments}
                commentsError={commentsError}
                onRetryComments={() => refetchComments()}
                canComment={canReview}
                shortcutsExtra={[["D", t("Draw on the frame")], ["C", t("Write a comment")], ["Ctrl + Z", t("Undo stroke")], ["Esc", t("Stop drawing / deselect")]]}
                notice={!canReview ? <p className="shrink-0 border-b border-line bg-raised/40 px-3.5 py-2 text-xs text-mute">{t("Viewers can read comments; reviewers and up can add them.")}</p> : undefined}
                onAdd={addComment}
                onResolve={canReview ? resolve : undefined}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <ReviewLinksModal x={shareOpen ? current : null} onClose={() => setShareOpen(false)} pid={project.id} canEdit={canEdit} />
    </div>
  );
}
