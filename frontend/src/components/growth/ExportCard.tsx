import { clsx } from "clsx";
import {
  AlertTriangle, BadgeCheck, Bot, ChevronDown, Clapperboard, Download, Ellipsis, ExternalLink, Eye, FileText, Hourglass, Link2,
  Loader2, MessageSquareText, MonitorPlay, Play, RefreshCw, Share2, Timer, TriangleAlert, Upload,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LANG_NAMES, LANG_SHORT, secs } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ExportRow, Job } from "../../lib/types";
import { Badge, Button, IconButton, Menu, Progress, type MenuItemDef } from "../ui";
import { agoT, downloadUrl, fmtDateTime, listItem } from "./common";

export interface ExportMetrics { views: number; avg_view_pct: number | null }
/** The API also returns the id of the job that made the render. */
export type RenderRow = ExportRow & { job_id?: number | null };
export interface PresetInfo { label: string; aspect: string | null; w: number; h: number }

/** Width (px) of the thumbnail frame for portrait / square / landscape renders. */
function thumbWidth(ratio: number) {
  return ratio < 0.9 ? 84 : ratio > 1.2 ? 156 : 104;
}

function Thumb({ x, ratio, ready, onPlay }: { x: RenderRow; ratio: number; ready: boolean; onPlay: () => void }) {
  const t = useT();
  const failed = x.status === "failed";
  return (
    <button
      type="button"
      disabled={!ready}
      onClick={onPlay}
      aria-label={ready ? t("Play") : undefined}
      aria-hidden={!ready || undefined}
      tabIndex={ready ? 0 : -1}
      className="group relative shrink-0 self-start overflow-hidden rounded-lg bg-black ring-1 ring-inset ring-white/10 disabled:cursor-default"
      style={{ width: `min(${thumbWidth(ratio)}px, 34cqw)`, aspectRatio: String(ratio) }}
    >
      {x.thumb_url && ready ? (
        <img src={x.thumb_url} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
      ) : ready ? (
        <span className="grid size-full place-items-center bg-raised text-dim"><Clapperboard className="size-6" /></span>
      ) : (
        <span className={clsx("skeleton grid size-full place-items-center rounded-none", failed ? "text-bad" : "text-dim")}>
          {failed ? <AlertTriangle className="relative z-10 size-6" /> : <Loader2 className="relative z-10 size-5 animate-spin" />}
        </span>
      )}
      {ready && (
        <>
          <span className="absolute inset-0 grid place-items-center bg-black/0 transition-colors duration-200 group-hover:bg-black/35">
            <span className="grid size-9 place-items-center rounded-full bg-black/55 text-white opacity-80 ring-1 ring-white/25 backdrop-blur-sm transition-[transform,opacity,background-color] duration-200 group-hover:scale-110 group-hover:bg-accent group-hover:text-black group-hover:opacity-100">
              <Play className="ml-0.5 size-4" fill="currentColor" />
            </span>
          </span>
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-px font-mono text-2xs font-medium tabular-nums text-white">{secs(x.duration_s)}</span>
        </>
      )}
    </button>
  );
}

/** Thin status line used under the title while a render or an upload is in flight. */
function JobLine({ icon, label, job, tone = "accent" }: { icon: React.ReactNode; label: string; job?: Job | null; tone?: "accent" | "info" }) {
  const pct = job ? Math.round((job.progress ?? 0) * 100) : null;
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-ink">
        <span className={tone === "info" ? "text-info" : "text-accent-ink"}>{icon}</span>
        <span className="min-w-0 truncate">{job?.message || label}</span>
        {pct !== null && pct > 0 && <span className="ml-auto font-mono tabular-nums text-mute">{pct}%</span>}
      </p>
      {job && job.progress > 0 ? <Progress value={job.progress} size="sm" tone={tone} /> : <Progress indeterminate size="sm" tone={tone} />}
    </div>
  );
}

export default function ExportCard({
  x, pid, preset, canProduce, canEdit, metrics, job, upload, onPlay, onPublish, onLinks, onApprove, onRerender,
}: {
  x: RenderRow; pid: number; preset?: PresetInfo; canProduce: boolean; canEdit: boolean; metrics?: ExportMetrics;
  job?: Job | null; upload?: Job | null; onPlay: () => void; onPublish: () => void; onLinks: () => void;
  onApprove: () => Promise<void>; onRerender?: () => void;
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
    !!onRerender && canEdit && { label: t("Render again"), icon: <RefreshCw className="size-4" />, onClick: onRerender, separator: true },
  ];

  return (
    <motion.article
      layout="position"
      {...listItem}
      className={clsx("@container relative rounded-xl border border-line bg-panel p-3 transition-shadow hover:shadow-lift @md:p-4", !ready && !failed && "gen-ring")}
    >
      <div className="flex gap-3 @md:gap-4">
        <Thumb x={x} ratio={ratio} ready={ready} onPlay={onPlay} />

        <div className="min-w-0 flex-1 space-y-2.5">
          {/* title + status */}
          <div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="text-sm font-semibold leading-tight tracking-tight">{isFinal ? t("Final") : t("Animatic")} · {langName}</h3>
              {approved && <Badge tone="ok"><BadgeCheck className="size-3" />{t("approved")}</Badge>}
              {yt && <Badge tone="info"><MonitorPlay className="size-3" />{t("On YouTube")}</Badge>}
              {uploading && <Badge tone="accent"><Loader2 className="size-3 animate-spin" />{t("Uploading")}</Badge>}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-mute">
              <Badge tone={isFinal ? "accent" : "neutral"}>{LANG_SHORT[x.language] ?? x.language}</Badge>
              <Badge>{presetLabel}</Badge>
              {x.ai_disclosure && <span title={t("Labelled as AI-generated when published")}><Badge><Bot className="size-3" />{t("AI label")}</Badge></span>}
              {preset?.w ? <span className="text-dim">{preset.w}×{preset.h}</span> : null}
              {ready && <span className="text-dim" title={fmtDateTime(x.created_at)}>· {agoT(x.created_at)}</span>}
            </div>
          </div>

          {/* in flight */}
          {!ready && !failed && <JobLine icon={<Hourglass className="size-3.5" />} label={t("Rendering…")} job={job} />}
          {uploading && <JobLine icon={<Upload className="size-3.5" />} label={t("Uploading to YouTube…")} job={upload} tone="info" />}

          {/* failed */}
          {failed && (
            <div className="flex items-start gap-2 rounded-lg border border-bad/30 bg-bad/8 px-2.5 py-2 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-bad" />
              <p className="min-w-0 flex-1 text-mute"><b className="font-semibold text-red-300">{t("Failed")}</b>{warnings[0] ? `: ${warnings[0]}` : ""}</p>
            </div>
          )}

          {/* warnings */}
          {ready && warnings.length > 0 && (
            <div>
              <button type="button" onClick={() => setShowWarnings((v) => !v)} aria-expanded={showWarnings}
                className="-my-1 inline-flex h-7 items-center gap-1 rounded-md bg-warn/10 px-2 text-xs font-medium text-amber-300 transition-colors max-sm:h-9 hover:bg-warn/18">
                <TriangleAlert className="size-3" />{warnings.length === 1 ? t("1 warning") : t("{n} warnings", { n: warnings.length })}
                <ChevronDown className={clsx("size-3 transition-transform", showWarnings && "rotate-180")} />
              </button>
              <AnimatePresence initial={false}>
                {showWarnings && (
                  <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}
                    className="overflow-hidden text-xs text-mute">
                    {warnings.map((w, i) => <li key={i} className="mt-1 flex gap-1.5"><span className="text-amber-300">•</span><span className="min-w-0">{w}</span></li>)}
                  </motion.ul>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* published */}
          {yt && (
            <div className="rounded-lg border border-line bg-raised/50 px-2.5 py-2 text-xs">
              <div className="flex items-center gap-1.5">
                <MonitorPlay className="size-3.5 shrink-0 text-info" />
                <span className="min-w-0 flex-1 truncate font-medium" title={yt.title}>{yt.title || t("YouTube video")}</span>
                {yt.url && (
                  <a href={yt.url} target="_blank" rel="noreferrer" aria-label={t("Open on YouTube")} title={yt.url}
                    className="grid size-6 shrink-0 place-items-center rounded-md text-mute transition-colors hover:bg-hover hover:text-ink"><ExternalLink className="size-3.5" /></a>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-mute">
                <span>{yt.status === "uploaded" ? t("Uploaded") : yt.status}{yt.at ? ` · ${agoT(yt.at)}` : ""}</span>
                {metrics ? (
                  <>
                    <span className="inline-flex items-center gap-1" title={t("Views")}><Eye className="size-3" />{metrics.views.toLocaleString()}</span>
                    {metrics.avg_view_pct != null && (
                      <span className="inline-flex items-center gap-1" title={t("Average percentage viewed")}><Timer className="size-3" />{t("{n}% watched", { n: Math.round(metrics.avg_view_pct) })}</span>
                    )}
                  </>
                ) : <span className="text-dim">{t("No analytics yet")}</span>}
              </div>
            </div>
          )}
          {otherPlatforms.map(([k, v]) => (
            <p key={k} className="flex items-center gap-1.5 text-xs text-mute"><Link2 className="size-3" />{k}: {v.status}{v.url && <> · <a href={v.url} target="_blank" rel="noreferrer" className="underline hover:text-ink">{t("open")}</a></>}</p>
          ))}

          {/* actions */}
          {ready && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {primary === "publish" && <Button size="sm" variant="primary" className="max-sm:h-10" icon={<Upload className="size-3.5" />} disabled={uploading} onClick={onPublish}>{t("Publish")}</Button>}
              {primary === "youtube" && <Button size="sm" variant="primary" className="max-sm:h-10" icon={<MonitorPlay className="size-3.5" />} onClick={openYouTube}>{t("Open on YouTube")}</Button>}
              {primary === "review" && <Button size="sm" variant="primary" className="max-sm:h-10" icon={<MessageSquareText className="size-3.5" />} onClick={review}>{t("Review")}</Button>}
              <Menu
                width={220}
                placement="bottom-start"
                trigger={(p) => <Button {...p} size="sm" variant="outline" className="max-sm:h-10" icon={<Download className="size-3.5" />} iconRight={<ChevronDown className="size-3 text-dim" />}>{t("Download")}</Button>}
                items={downloads}
              />
              <Button size="sm" variant="outline" className="max-sm:h-10" icon={<Share2 className="size-3.5" />} onClick={onLinks}>{t("Share")}</Button>
              {more.some(Boolean) && (
                <Menu
                  width={220}
                  trigger={(p) => <IconButton {...p} title={t("More")} className="!size-7 max-sm:!size-10"><Ellipsis className="size-4" /></IconButton>}
                  items={more}
                />
              )}
              {approving && <Loader2 className="size-3.5 animate-spin text-mute" />}
            </div>
          )}
          {failed && onRerender && canEdit && (
            <Button size="sm" variant="outline" className="max-sm:h-10" icon={<RefreshCw className="size-3.5" />} onClick={onRerender}>{t("Render again")}</Button>
          )}
        </div>
      </div>
    </motion.article>
  );
}

/** A render that is queued (or waiting for approval) and has no row yet. */
export function PendingRenderCard({ job, preset, kind, language }: { job: Job; preset?: PresetInfo; kind: "final" | "animatic"; language: string }) {
  const t = useT();
  const ratio = preset?.w && preset?.h ? preset.w / preset.h : 9 / 16;
  const waiting = job.status === "awaiting_approval" || job.status === "proposed";
  return (
    <motion.article layout="position" {...listItem} className="@container relative rounded-xl border border-dashed border-line bg-panel p-3 @md:p-4">
      <div className="flex gap-3 @md:gap-4">
        <span className="skeleton grid shrink-0 place-items-center self-start rounded-lg text-dim ring-1 ring-inset ring-white/5" style={{ width: `min(${thumbWidth(ratio)}px, 34cqw)`, aspectRatio: String(ratio) }}>
          <Hourglass className="relative z-10 size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold leading-tight tracking-tight">{kind === "final" ? t("Final") : t("Animatic")} · {t(LANG_NAMES[language] ?? language)}</h3>
            <Badge tone={waiting ? "warn" : "neutral"} dot>{waiting ? t("Waiting for approval") : t("Queued")}</Badge>
          </div>
          <p className="text-xs text-mute">{t(preset?.label ?? "")}{preset?.w ? <span className="text-dim"> · {preset.w}×{preset.h}</span> : null}</p>
          {!waiting && <Progress indeterminate size="sm" />}
          {waiting && <p className="text-xs text-mute">{t("A producer needs to approve the spend before this starts.")}</p>}
        </div>
      </div>
    </motion.article>
  );
}
