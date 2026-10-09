import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { BadgeCheck, ChevronsUpDown, Clapperboard, Eye, GitCompare, MessageSquareText, Share2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { LoadError } from "../../components/growth/common";
import ReviewLinksModal from "../../components/growth/ReviewLinksModal";
import { ReviewWorkspace, WORKSPACE_WIDE, type NewComment } from "../../components/review/ReviewWorkspace";
import { fpsOf, formatTC, relTime, useElementWidth, type RComment } from "../../components/review/utils";
import { WipeCompare, type CompareSource } from "../../components/review/WipeCompare";
import { RoomEmpty, RoomHeader, RoomPage } from "../../components/room/kit";
import { Alert, Badge, Button, Menu, Panel, Segmented, Skeleton, StatusDot, Tooltip } from "../../components/ui";
import { api } from "../../lib/api";
import { LANG_NAMES, LANG_SHORT, secs } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useAuthStatus, useEpisode, useSettings } from "../../lib/queries";
import type { Comment, ExportRow } from "../../lib/types";
import { useProjectCtx } from "./context";
import "../../styles/review.css";

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

/** One cell of the status strip: mono eyebrow over a value. */
function Cell({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <p className="eyebrow truncate">{label}</p>
      <div className="mt-1.5 flex min-w-0 items-center gap-x-1.5 whitespace-nowrap text-sm leading-tight">{children}</div>
    </div>
  );
}

/** Frame of the page: the same ground as RoomPage, but a flex column of definite height so the monitor can fill the viewport. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="@container hud-bg flex h-full flex-col overflow-y-auto overscroll-contain" data-page-scroller>
      <div className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col px-4 pb-4 pt-5 @2xl:px-6 @2xl:pt-6">{children}</div>
    </div>
  );
}

export default function ReviewPage() {
  const { project, eid, lang, canEdit, canReview, canProduce } = useProjectCtx();
  const t = useT();
  const qc = useQueryClient();
  const { data: ep, isLoading, isError, refetch, isFetching } = useEpisode(eid, lang);
  const { data: settings } = useSettings();
  const { data: auth } = useAuthStatus();
  const presets = settings?.catalog.export_presets ?? {};
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [shareOpen, setShareOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const mode: Mode = params.get("mode") === "compare" ? "compare" : "review";
  const [areaRef, areaWidth] = useElementWidth<HTMLDivElement>();
  const wide = areaWidth >= WORKSPACE_WIDE;

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

  const headerIcon = <MessageSquareText />;

  // ── loading / error / empty ──
  if (isError && !ep) {
    return (
      <RoomPage width="full">
        <RoomHeader icon={headerIcon} title={t("Review")} description={t("Frame-accurate, timecoded comments on every ready render.")} />
        <LoadError title={t("We couldn't load this episode")} onRetry={() => refetch()} retrying={isFetching} className="mt-8" />
      </RoomPage>
    );
  }
  if (isLoading || !ep) {
    return (
      <RoomPage width="full">
        <RoomHeader icon={headerIcon} title={t("Review")} description={t("Frame-accurate, timecoded comments on every ready render.")} />
        <div aria-hidden className="space-y-3">
          <Skeleton className="h-14 w-full rounded-xl" />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <Skeleton className="aspect-video min-h-[280px] w-full rounded-xl lg:aspect-auto lg:h-[520px]" />
            <Skeleton className="hidden h-[520px] rounded-xl lg:block" />
          </div>
        </div>
      </RoomPage>
    );
  }
  if (!current) {
    return (
      <RoomPage width="full">
        <RoomHeader icon={headerIcon} title={t("Review")} description={t("Frame-accurate, timecoded comments on every ready render.")} />
        <RoomEmpty icon={<MessageSquareText />} title={t("Nothing to review yet")}
          sub={t("Render an animatic or a final in Export — every ready render can be reviewed here with frame-accurate comments.")}
          className="mx-auto max-w-xl py-12"
          action={<Button variant="primary" icon={<Clapperboard className="size-4" />} onClick={() => navigate(`/p/${project.id}/export`)}>{t("Go to Export")}</Button>} />
      </RoomPage>
    );
  }

  const approved = !!current.approved_by;
  const isFinal = current.kind === "final";
  const title = `${kindLabel(current)} · ${t(LANG_NAMES[current.language] ?? current.language)}`;
  const meta = `${preset?.label ? t(preset.label) : current.preset} · ${secs(current.duration_s)} · ${relTime(current.created_at)}`;
  const open = comments.filter((c) => !c.resolved).length;
  const status = approved
    ? { tone: "ok" as const, word: t("Approved"), live: false }
    : isFinal ? { tone: "info" as const, word: t("In review"), live: true } : { tone: "neutral" as const, word: t("Draft"), live: false };
  const approver = approved ? (current.approved_by === auth?.user?.id ? t("You") : `${t("User")} #${current.approved_by}`) : null;

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
        <span className="mono mt-1 block truncate text-2xs text-dim">{meta}</span>
      </span>
    </>
  );

  return (
    <Frame>
      <div className="[&>header]:mb-3">
        <RoomHeader
          icon={headerIcon}
          title={<>{t("Review")}<span className="sr-only"> · {title}</span></>}
          description={t("Frame-accurate, timecoded comments on every ready render.")}
          status={
            <Segmented value={mode} onChange={(m) => setParam("mode", m === "compare" ? "compare" : null)} aria-label={t("Review mode")} className="max-sm:[&_button]:py-2.5"
              options={[
                { value: "review", label: <span className="flex items-center gap-1.5"><MessageSquareText className="size-3.5" /><span className="max-sm:sr-only">{t("Review")}</span></span> },
                { value: "compare", label: <span className="flex items-center gap-1.5"><GitCompare className="size-3.5" /><span className="max-sm:sr-only">{t("Compare")}</span></span>, title: ready.length < 2 ? t("Needs two ready renders") : undefined },
              ]} />
          }
          actions={
            <>
              {canEdit && <Button size="sm" icon={<Share2 className="size-3.5" />} onClick={() => setShareOpen(true)} className="max-sm:h-10">{t("Client link")}</Button>}
              {canProduce && (
                <Tooltip content={!isFinal ? t("Only final renders can be approved") : ""} disabled={isFinal}>
                  <span className="inline-flex">
                    <Button size="sm" variant={approved ? "outline" : "primary"} loading={approving} onClick={approve} disabled={!isFinal} className="max-sm:h-10"
                      icon={<BadgeCheck className={clsx("size-3.5", approved && "text-ok")} />}>
                      {approved ? t("Unapprove") : t("Approve export")}
                    </Button>
                  </span>
                </Tooltip>
              )}
            </>
          }
        />
      </div>

      {/* status strip: which render, how long, where it stands, who signed it off */}
      <Panel flush index={1} className="mb-3 shrink-0">
        <div className="rv-strip">
          <div className="rv-strip-main">
            {ready.length > 1 ? (
              <Menu
                placement="bottom-start"
                width={320}
                trigger={(p) => (
                  <button type="button" {...p} aria-label={t("Switch render")}
                    className="group flex w-full min-w-0 items-center gap-3 rounded-lg border border-transparent px-1.5 py-1 transition-colors hover:border-line hover:bg-hover/60 aria-expanded:border-line aria-expanded:bg-hover/60 max-sm:min-h-11">
                    {pickerBody}
                    <ChevronsUpDown className="ml-auto size-4 shrink-0 text-dim transition-colors group-hover:text-ink" />
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
              <div className="flex min-w-0 items-center gap-3 px-1.5 py-1">{pickerBody}</div>
            )}
          </div>
          <Cell label={t("Version")}>
            <span className="mono font-medium text-ink">#{current.id}</span>
            <span className="truncate text-2xs text-dim">{kindLabel(current)} · {LANG_SHORT[current.language] ?? current.language}</span>
          </Cell>
          <Cell label={t("Length")}>
            <span className="mono font-medium text-ink">{formatTC(current.duration_s, fps, true)}</span>
            <span className="mono text-2xs text-dim">{t("{fps} fps", { fps })}</span>
          </Cell>
          <Cell label={t("Status")}>
            <StatusDot tone={status.tone} live={status.live} />
            <span className="truncate font-medium text-ink">{status.word}</span>
          </Cell>
          <Cell label={t("Sign-off")}>
            {approved ? (
              <>
                <BadgeCheck className="size-4 shrink-0 text-ok" />
                <span className="truncate font-medium text-ink">{approver}</span>
              </>
            ) : (
              <span className="truncate text-mute" title={isFinal ? t("Awaiting approval") : t("Only final renders can be approved")}>{isFinal ? t("Awaiting approval") : t("Finals only")}</span>
            )}
          </Cell>
          <Cell label={t("Open comments")}>
            <span className="mono font-medium text-ink">{open}</span>
            <span className="mono text-2xs text-dim">/ {comments.length}</span>
          </Cell>
        </div>
      </Panel>

      {mode === "compare" && ready.length < 2 && (
        <Alert tone="info" className="mb-3">{t("Compare needs at least two ready renders of this episode — render another version or language in Export.")}</Alert>
      )}

      {/* workspace: fills the height when wide, flows (and the page scrolls) when stacked */}
      <div ref={areaRef} className={clsx(wide ? "relative min-h-[520px] flex-1" : "flex-none")}>
        <AnimatePresence mode="wait" initial={false}>
          {mode === "compare" && ready.length >= 2 ? (
            <motion.div key={`compare-${current.id}`} className={wide ? "absolute inset-0" : undefined} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
              <WipeCompare sources={sources} initialA={current.id} initialB={compareB} fps={fps} layout={wide ? "wide" : "stacked"} />
            </motion.div>
          ) : (
            <motion.div key={`review-${current.id}`} className={wide ? "absolute inset-0" : undefined} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
              <ReviewWorkspace
                layout={wide ? "wide" : "stacked"}
                src={current.url}
                poster={current.thumb_url || undefined}
                fps={fps}
                peaks={current.peaks}
                durationHint={current.duration_s}
                aspectHint={aspectHint}
                monitorLabel={short(current)}
                comments={comments}
                loadingComments={loadingComments}
                commentsError={commentsError}
                onRetryComments={() => refetchComments()}
                canComment={canReview}
                shortcutsExtra={[["D", t("Draw on the frame")], ["C", t("Write a comment")], ["Ctrl + Z", t("Undo stroke")], ["Esc", t("Stop drawing / deselect")]]}
                notice={!canReview ? (
                  <p className="flex shrink-0 items-center gap-2 border-b border-line bg-raised/40 px-3.5 py-2 text-xs text-mute">
                    <Eye className="size-3.5 shrink-0 text-dim" />{t("Viewers can read comments; reviewers and up can add them.")}
                  </p>
                ) : undefined}
                onAdd={addComment}
                onResolve={canReview ? resolve : undefined}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <ReviewLinksModal x={shareOpen ? current : null} onClose={() => setShareOpen(false)} pid={project.id} canEdit={canEdit} />
    </Frame>
  );
}
