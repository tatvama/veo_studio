/** A finished render as a monitor tile: aspect-correct preview, a mono spec line and a tidy action row. */
import { clsx } from "clsx";
import {
  AlertTriangle, BadgeCheck, Bot, ChevronDown, Clapperboard, Download, Ellipsis, ExternalLink, Eye, FileText, Link2, Loader2,
  Megaphone, MessageSquareText, MonitorPlay, Play, RefreshCw, Share2, Timer, TriangleAlert, Upload,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import "../../styles/console.css";
import "../../styles/export.css";
import { LANG_NAMES, LANG_SHORT, secs } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ExportRow, Job } from "../../lib/types";
import { Badge, Button, IconButton, Menu, type MenuItemDef } from "../ui";
import { agoT, clock, downloadUrl, fmtDateTime, listItem, SweepBar } from "./common";

export interface ExportMetrics { views: number; avg_view_pct: number | null }
/** The API also returns the id of the job that made the render. */
export type RenderRow = ExportRow & { job_id?: number | null };
export interface PresetInfo { label: string; aspect: string | null; w: number; h: number }

/** The preview bed: the render's thumbnail letterboxed to its true shape, with timecode and tags overlaid. */
function Monitor({ x, ratio, ready, preset, onPlay }: { x: RenderRow; ratio: number; ready: boolean; preset?: PresetInfo; onPlay: () => void }) {
  const t = useT();
  const failed = x.status === "failed";
  const isFinal = x.kind === "final";
  return (
    <div className="hud xp-frame">
      <div className="cx-monitor">
        <button
          type="button"
          disabled={!ready}
          onClick={onPlay}
          aria-label={ready ? t("Play") : undefined}
          aria-hidden={!ready || undefined}
          tabIndex={ready ? 0 : -1}
          className="group/play relative block h-44 w-full disabled:cursor-default max-sm:h-52"
        >
          {x.thumb_url && ready ? (
            <img src={x.thumb_url} alt="" loading="lazy" className="size-full object-contain transition-transform duration-500 group-hover/play:scale-[1.02]" />
          ) : (
            <span className="grid size-full place-items-center">
              <span className={clsx("grid place-items-center rounded-md border border-dashed", ratio > 1.2 ? "w-40" : "h-28", failed ? "border-bad/50 text-bad" : "border-white/25 text-dim")}
                style={{ aspectRatio: String(ratio) }}>
                {ready ? <Clapperboard className="size-6" /> : failed ? <AlertTriangle className="size-6" /> : <Loader2 className="size-5 animate-spin" />}
              </span>
            </span>
          )}
          {ready && (
            <span className="absolute inset-0 grid place-items-center bg-black/0 transition-colors duration-200 group-hover/play:bg-black/35 group-focus-visible/play:bg-black/35">
              <span className="grid size-10 place-items-center rounded-full bg-black/55 text-white opacity-75 ring-1 ring-white/25 backdrop-blur-sm transition-[transform,opacity,background-color] duration-200 group-hover/play:scale-110 group-hover/play:bg-accent group-hover/play:text-black group-hover/play:opacity-100 group-focus-visible/play:opacity-100">
                <Play className="ml-0.5 size-4" fill="currentColor" />
              </span>
            </span>
          )}
        </button>
        <span className="mono pointer-events-none absolute left-2 top-2 z-[1] rounded bg-black/65 px-1.5 py-0.5 text-2xs uppercase leading-none tracking-wider text-white">
          {isFinal ? t("Final") : t("Animatic")}
        </span>
        <span className="mono pointer-events-none absolute right-2 top-2 z-[1] rounded bg-black/65 px-1.5 py-0.5 text-2xs leading-none tracking-wider text-white">
          {LANG_SHORT[x.language] ?? x.language}
        </span>
        {preset && (
          <span className="mono pointer-events-none absolute bottom-2 left-2 z-[1] rounded bg-black/65 px-1.5 py-0.5 text-2xs leading-none text-white">
            {preset.aspect ?? t("fast")}
          </span>
        )}
        {ready && (
          <span className="mono pointer-events-none absolute bottom-2 right-2 z-[1] rounded bg-black/65 px-1.5 py-0.5 text-2xs leading-none text-white">{clock(x.duration_s)}</span>
        )}
      </div>
    </div>
  );
}

const BARS = 44;
/** Downsample the audio peaks to a fixed number of bars (0-1, tallest = 1). Empty when there is nothing usable. */
function peakBars(peaks: number[] | undefined): number[] {
  if (!peaks || peaks.length < 4) return [];
  const step = peaks.length / BARS;
  const raw = Array.from({ length: BARS }, (_, i) => {
    const a = Math.floor(i * step), b = Math.max(a + 1, Math.floor((i + 1) * step));
    let m = 0;
    for (let k = a; k < b && k < peaks.length; k++) m = Math.max(m, Math.abs(Number(peaks[k]) || 0));
    return m;
  });
  const top = Math.max(...raw, 1e-6);
  return raw.map((v) => Math.max(0.1, v / top));
}

/** A tiny audio-level strip under the monitor. */
function Peaks({ peaks }: { peaks?: number[] }) {
  const bars = useMemo(() => peakBars(peaks), [peaks]);
  if (!bars.length) return null;
  return (
    <div aria-hidden className="mt-2 flex h-4 items-end gap-px px-0.5">
      {bars.map((v, i) => <i key={i} className="block flex-1 rounded-[1px] bg-accent/45" style={{ height: `${Math.round(v * 100)}%` }} />)}
    </div>
  );
}

/** Thin status line used under the title while an upload is in flight. */
function JobLine({ icon, label, job, tone = "accent" }: { icon: React.ReactNode; label: string; job?: Job | null; tone?: "accent" | "info" }) {
  const pct = job ? Math.round((job.progress ?? 0) * 100) : null;
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-ink">
        <span className={tone === "info" ? "text-info" : "text-accent-ink"}>{icon}</span>
        <span className="min-w-0 truncate">{job?.message || label}</span>
        {pct !== null && pct > 0 && <span className="mono ml-auto text-mute">{pct}%</span>}
      </p>
      <SweepBar value={job && job.progress > 0 ? job.progress : null} tone={tone} label={label} />
    </div>
  );
}

export default function ExportCard({
  x, pid, preset, canProduce, canEdit, metrics, upload, onPlay, onPublish, onLinks, onApprove, onRerender, onMarketing,
}: {
  x: RenderRow; pid: number; preset?: PresetInfo; canProduce: boolean; canEdit: boolean; metrics?: ExportMetrics;
  job?: Job | null; upload?: Job | null; onPlay: () => void; onPublish: () => void; onLinks: () => void;
  onApprove: () => Promise<void>; onRerender?: () => void; onMarketing?: () => void;
}) {
  const t = useT();
  const nav = useNavigate();
  const [approving, setApproving] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const ready = x.status === "ready";
  const failed = x.status === "failed";
  const isFinal = x.kind === "final";
  const approved = !!x.approved_by;
  const yt = x.published?.youtube;
  const uploading = !!upload;
  const otherPlatforms = Object.entries(x.published ?? {}).filter(([k]) => k !== "youtube");
  const ratio = preset?.w && preset?.h ? preset.w / preset.h : 9 / 16;
  const presetLabel = t(preset?.label ?? x.preset);
  const warnings = x.warnings ?? [];
  const langName = t(LANG_NAMES[x.language] ?? x.language);

  const approve = async () => {
    setApproving(true);
    try { await onApprove(); } finally { setApproving(false); }
  };
  const review = () => nav(`/p/${pid}/review?export=${x.id}`);
  const openYouTube = () => yt?.url && window.open(yt.url, "_blank", "noopener,noreferrer");

  // The next step in the delivery flow gets the one prominent button; everything else lives in menus.
  const primary: "publish" | "youtube" | "review" =
    canProduce && isFinal && approved && !yt ? "publish" : yt?.url ? "youtube" : "review";

  const downloads: MenuItemDef[] = [
    { label: t("Video (MP4)"), icon: <Clapperboard className="size-4" />, onClick: () => downloadUrl(x.url) },
    x.srt_url ? { label: t("Subtitles (SRT)"), icon: <FileText className="size-4" />, onClick: () => downloadUrl(x.srt_url) } : null,
  ].filter(Boolean) as MenuItemDef[];

  const more: (MenuItemDef | false)[] = [
    primary !== "review" && { label: t("Review"), icon: <MessageSquareText className="size-4" />, onClick: review },
    canProduce && isFinal && { label: approved ? t("Unapprove") : t("Approve final"), icon: <BadgeCheck className="size-4" />, onClick: approve, separator: primary !== "review" },
    canProduce && isFinal && primary !== "publish" && {
      label: yt ? t("Publish again") : t("Publish"), icon: <Upload className="size-4" />, onClick: onPublish, disabled: uploading,
    },
    !!yt?.url && primary !== "youtube" && { label: t("Open on YouTube"), icon: <ExternalLink className="size-4" />, onClick: openYouTube },
    !!onMarketing && { label: t("Marketing pack"), icon: <Megaphone className="size-4" />, onClick: onMarketing, separator: true },
    !!onRerender && canEdit && { label: t("Render again"), icon: <RefreshCw className="size-4" />, onClick: onRerender, separator: true },
  ];

  const spec = [
    preset?.w ? `${preset.w}×${preset.h}` : null,
    secs(x.duration_s),
    LANG_SHORT[x.language] ?? x.language,
  ].filter(Boolean).join(" · ");

  return (
    <motion.article layout="position" {...listItem} className={clsx("@container group/tile flex min-w-0 flex-col rounded-xl border border-line bg-panel p-2.5", uploading && "gen-ring")}>
      <Monitor x={x} ratio={ratio} ready={ready} preset={preset} onPlay={onPlay} />
      {ready && <Peaks peaks={x.peaks} />}

      <div className="mt-2.5 min-w-0 flex-1 space-y-2.5 px-0.5">
        {/* title + state */}
        <div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold leading-tight tracking-tight">{isFinal ? t("Final") : t("Animatic")} · {langName}</h3>
            {approved && <Badge tone="ok"><BadgeCheck className="size-3" />{t("approved")}</Badge>}
            {yt && <Badge tone="info"><MonitorPlay className="size-3" />{t("On YouTube")}</Badge>}
            {uploading && <Badge tone="accent"><Loader2 className="size-3 animate-spin" />{t("Uploading")}</Badge>}
            {x.ai_disclosure && <span title={t("Labelled as AI-generated when published")}><Badge tone="ai"><Bot className="size-3" />{t("AI label")}</Badge></span>}
          </div>
          <p className="mt-1 truncate text-xs text-mute" title={presetLabel}>{presetLabel}</p>
          <p className="mono mt-1 flex flex-wrap items-center gap-x-1.5 text-2xs text-dim" title={fmtDateTime(x.created_at)}>
            <span>#{x.id}</span><span aria-hidden>·</span><span>{spec}</span>{ready && <><span aria-hidden>·</span><span>{agoT(x.created_at)}</span></>}
          </p>
        </div>

        {uploading && <JobLine icon={<Upload className="size-3.5" />} label={t("Uploading to YouTube…")} job={upload} tone="info" />}

        {/* warnings */}
        {ready && warnings.length > 0 && (
          <div>
            <button type="button" onClick={() => setShowWarnings((v) => !v)} aria-expanded={showWarnings}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-warn/10 px-2 text-xs font-medium text-warn transition-colors hover:bg-warn/20 max-sm:h-9">
              <TriangleAlert className="size-3" />{warnings.length === 1 ? t("1 warning") : t("{n} warnings", { n: warnings.length })}
              <ChevronDown className={clsx("size-3 transition-transform", showWarnings && "rotate-180")} />
            </button>
            <AnimatePresence initial={false}>
              {showWarnings && (
                <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}
                  className="overflow-hidden text-xs text-mute">
                  {warnings.map((w, i) => <li key={i} className="mt-1 flex gap-1.5"><span className="text-warn">•</span><span className="min-w-0">{w}</span></li>)}
                </motion.ul>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* published */}
        {yt && (
          <div className="cx-block px-2.5 py-2 text-xs">
            <div className="flex items-center gap-1.5">
              <MonitorPlay className="size-3.5 shrink-0 text-info" />
              <span className="min-w-0 flex-1 truncate font-medium" title={yt.title}>{yt.title || t("YouTube video")}</span>
              {yt.url && (
                <a href={yt.url} target="_blank" rel="noreferrer" aria-label={t("Open on YouTube")} title={yt.url}
                  className="grid size-6 shrink-0 place-items-center rounded-md text-mute transition-colors hover:bg-hover hover:text-ink max-sm:size-9"><ExternalLink className="size-3.5" /></a>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-mute">
              <span>{yt.status === "uploaded" ? t("Uploaded") : yt.status}{yt.at ? ` · ${agoT(yt.at)}` : ""}</span>
              {metrics ? (
                <>
                  <span className="mono inline-flex items-center gap-1" title={t("Views")}><Eye className="size-3" />{metrics.views.toLocaleString()}</span>
                  {metrics.avg_view_pct != null && (
                    <span className="mono inline-flex items-center gap-1" title={t("Average percentage viewed")}><Timer className="size-3" />{t("{n}% watched", { n: Math.round(metrics.avg_view_pct) })}</span>
                  )}
                </>
              ) : <span className="text-dim">{t("No analytics yet")}</span>}
            </div>
          </div>
        )}
        {otherPlatforms.map(([k, v]) => (
          <p key={k} className="flex items-center gap-1.5 text-xs text-mute"><Link2 className="size-3" />{k}: {v.status}{v.url && <> · <a href={v.url} target="_blank" rel="noreferrer" className="underline hover:text-ink">{t("open")}</a></>}</p>
        ))}
      </div>

      {/* actions */}
      {ready && (
        <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-2.5">
          {primary === "publish" && <Button size="sm" variant="primary" className="h-8 min-w-0 flex-1 max-sm:h-10" icon={<Upload className="size-3.5" />} disabled={uploading} onClick={onPublish}>{t("Publish")}</Button>}
          {primary === "youtube" && <Button size="sm" variant="primary" className="h-8 min-w-0 flex-1 max-sm:h-10" icon={<MonitorPlay className="size-3.5" />} onClick={openYouTube}>{t("Open on YouTube")}</Button>}
          {primary === "review" && <Button size="sm" variant="primary" className="h-8 min-w-0 flex-1 max-sm:h-10" icon={<MessageSquareText className="size-3.5" />} onClick={review}>{t("Review")}</Button>}
          <Menu
            width={220}
            trigger={(p) => <IconButton {...p} title={t("Download")} className="border border-line max-sm:!size-10"><Download className="size-4" /></IconButton>}
            items={downloads}
          />
          <IconButton title={t("Share")} className="border border-line max-sm:!size-10" onClick={onLinks}><Share2 className="size-4" /></IconButton>
          {more.some(Boolean) && (
            <Menu
              width={220}
              trigger={(p) => <IconButton {...p} title={t("More")} className="border border-line max-sm:!size-10"><Ellipsis className="size-4" /></IconButton>}
              items={more}
            />
          )}
          {approving && <Loader2 className="size-3.5 animate-spin text-mute" />}
        </div>
      )}
      {failed && onRerender && canEdit && (
        <Button size="sm" variant="outline" className="mt-3 max-sm:h-10" icon={<RefreshCw className="size-3.5" />} onClick={onRerender}>{t("Render again")}</Button>
      )}
    </motion.article>
  );
}
