/** The render queue of the Export page: the header status strip and a job table (status, progress, elapsed / ETA, cost). */
import { clsx } from "clsx";
import { Clapperboard, Hourglass, ListOrdered, MonitorPlay, RefreshCw, ShieldCheck, Wand2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import "../../styles/console.css";
import { LANG_NAMES, usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { Job } from "../../lib/types";
import { Button, Panel, StatusDot } from "../ui";
import { clock, EqBars, etaSeconds, SweepBar, useNow } from "./common";
import type { PresetInfo, RenderRow } from "./ExportCard";

export type QueueState = "running" | "queued" | "waiting" | "uploading" | "failed";

export interface QueueItem {
  key: string;
  /** Id of the render row, when it already has one. */
  exportId: number | null;
  jobId: number | null;
  kind: "final" | "animatic" | "upload";
  language: string;
  preset?: PresetInfo;
  presetKey: string;
  state: QueueState;
  job: Job | null;
  /** When the render was requested (used for the elapsed readout when there is no job object). */
  createdAt?: string;
  /** First warning of a failed render. */
  reason?: string;
  onRetry?: () => unknown;
}

const ORDER: Record<QueueState, number> = { running: 0, uploading: 1, queued: 2, waiting: 3, failed: 4 };

/** Merge renders that are in flight (or failed), jobs without a row yet and YouTube uploads into one list. */
export function buildQueue({ pending, exports, renderJobs, uploads, presets, lang, onRerender }: {
  pending: Job[]; exports: RenderRow[]; renderJobs: Job[]; uploads: Job[]; presets: Record<string, PresetInfo>; lang: string;
  onRerender?: (x: RenderRow) => unknown;
}): QueueItem[] {
  const stateOf = (j?: Job | null): QueueState =>
    !j ? "running" : j.status === "awaiting_approval" || j.status === "proposed" ? "waiting" : j.status === "queued" ? "queued" : "running";
  const out: QueueItem[] = [];
  for (const j of pending) {
    const presetKey = String(j.payload?.preset ?? "");
    out.push({
      key: `job-${j.id}`, exportId: null, jobId: j.id, kind: j.type === "export" ? "final" : "animatic", language: String(j.payload?.language ?? lang),
      preset: presets[presetKey], presetKey, state: stateOf(j), job: j,
    });
  }
  for (const x of exports) {
    if (x.status === "ready") continue;
    const job = renderJobs.find((j) => j.id === x.job_id) ?? null;
    const failed = x.status === "failed";
    out.push({
      key: `render-${x.id}`, exportId: x.id, jobId: x.job_id ?? null, kind: x.kind === "final" ? "final" : "animatic", language: x.language,
      preset: presets[x.preset], presetKey: x.preset, state: failed ? "failed" : stateOf(job), job, createdAt: x.created_at, reason: failed ? x.warnings?.[0] : undefined,
      onRetry: failed && onRerender ? () => onRerender(x) : undefined,
    });
  }
  for (const u of uploads) {
    const xid = Number(u.payload?.export_id);
    const x = exports.find((e) => e.id === xid);
    out.push({
      key: `upload-${u.id}`, exportId: Number.isFinite(xid) ? xid : null, jobId: u.id, kind: "upload", language: x?.language ?? lang,
      preset: x ? presets[x.preset] : undefined, presetKey: x?.preset ?? "", state: "uploading", job: u,
    });
  }
  return out.sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.jobId ?? 0) - (a.jobId ?? 0));
}

export interface RenderCounts { running: number; queued: number; finished: number; failed: number }

export function countQueue(items: QueueItem[], finished: number): RenderCounts {
  return {
    running: items.filter((i) => i.state === "running" && i.kind !== "upload").length,
    queued: items.filter((i) => i.state === "queued" || i.state === "waiting").length,
    finished,
    failed: items.filter((i) => i.state === "failed").length,
  };
}

/** One cell of the status strip: dot + word, then a big mono figure. */
function StripCell({ label, tone, live, children, className, title }: {
  label: string; tone?: "accent" | "info" | "ok" | "bad"; live?: boolean; children: ReactNode; className?: string; title?: string;
}) {
  return (
    <div className={clsx("min-w-0 bg-panel px-3 py-2", className)} title={title}>
      <p className="eyebrow flex min-w-0 items-center gap-1.5">{tone && <StatusDot tone={tone} live={live} />}<span className="truncate">{label}</span></p>
      <div className="mono mt-1.5 flex items-center gap-2 text-lg font-medium leading-none">{children}</div>
    </div>
  );
}

/** Mono counts (running / queued / finished / failed) and the total render spend, for the page header. */
export function RenderStatusStrip({ counts, spend }: { counts: RenderCounts; spend: number }) {
  const t = useT();
  const live = counts.running > 0;
  return (
    <div role="group" aria-label={t("Render status")}
      className="grid w-[calc(100cqw-2rem)] grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line @xl:w-auto @xl:grid-cols-5">
      <StripCell label={t("Running")} tone="accent" live={live}>
        <span className={live ? "text-accent-ink" : "text-ink"}>{counts.running}</span><EqBars idle={!live} />
      </StripCell>
      <StripCell label={t("Queued")} tone="info"><span>{counts.queued}</span></StripCell>
      <StripCell label={t("Finished")} tone="ok"><span>{counts.finished}</span></StripCell>
      <StripCell label={t("Failed")} tone="bad"><span className={counts.failed > 0 ? "text-bad" : undefined}>{counts.failed}</span></StripCell>
      <StripCell label={t("Spend")} className="col-span-2 @xl:col-span-1" title={t("Total render spend for this episode")}>
        <span className="text-money">{usd(spend)}</span>
      </StripCell>
    </div>
  );
}

const STATE_TONE = { running: "accent", uploading: "info", queued: "info", waiting: "warn", failed: "bad" } as const;

function Row({ it, now }: { it: QueueItem; now: number }) {
  const t = useT();
  const [retrying, setRetrying] = useState(false);
  const j = it.job;
  const live = it.state === "running" || it.state === "uploading";
  const pct = j && j.progress > 0 ? j.progress : null;
  const startIso = j ? (j.started_at ?? j.created_at) : it.createdAt;
  const since = startIso ? (now - new Date(startIso).getTime()) / 1000 : null;
  const eta = j ? etaSeconds(j, now) : null;
  const cost = j ? j.cost_actual || j.cost_estimate : null;
  const word = { running: t("Running"), queued: t("Queued"), waiting: t("Waiting for approval"), uploading: t("Uploading"), failed: t("Failed") }[it.state];
  const kindName = it.kind === "final" ? t("Final") : it.kind === "animatic" ? t("Animatic") : t("YouTube upload");
  const lang = t(LANG_NAMES[it.language] ?? it.language);
  const Icon = it.kind === "upload" ? MonitorPlay : it.kind === "final" ? Clapperboard : Wand2;
  const idText = it.exportId ? `#${it.exportId}` : it.jobId ? `J${it.jobId}` : "—";

  const retry = async () => {
    if (!it.onRetry) return;
    setRetrying(true);
    try { await it.onRetry(); } finally { setRetrying(false); }
  };

  return (
    <tr data-state={it.state}>
      <td className="cx-mono cx-stick cx-fit" title={it.exportId ? t("Render {id}", { id: it.exportId }) : t("Job {id}", { id: it.jobId ?? "" })}>{idText}</td>
      <td>
        <div className="flex min-w-0 max-w-[16rem] items-center gap-2.5 max-sm:max-w-[10.5rem]">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-line bg-raised text-mute"><Icon className="size-3.5" /></span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium leading-tight">{kindName} · {lang}</p>
            <p className="mono truncate text-2xs text-dim">{it.preset ? <>{t(it.preset.label)}{it.preset.w ? ` · ${it.preset.w}×${it.preset.h}` : ""}</> : it.presetKey || "—"}</p>
          </div>
        </div>
      </td>
      <td>
        <span className={clsx("inline-flex items-center gap-2 whitespace-nowrap text-xs font-medium",
          it.state === "failed" ? "text-bad" : it.state === "waiting" ? "text-warn" : it.state === "running" ? "text-accent-ink" : "text-ink")}>
          <StatusDot tone={STATE_TONE[it.state]} live={live} />{word}
        </span>
      </td>
      <td className="min-w-44">
        {it.state === "failed" ? (
          <p className="max-w-[18rem] truncate text-xs text-mute" title={it.reason}>{it.reason || "—"}</p>
        ) : it.state === "waiting" ? (
          <p className="flex max-w-[18rem] items-center gap-1.5 text-xs text-mute" title={t("A producer needs to approve the spend before this starts.")}>
            <ShieldCheck className="size-3.5 shrink-0 text-warn" /><span className="truncate">{t("A producer needs to approve the spend before this starts.")}</span>
          </p>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <SweepBar value={it.state === "queued" ? null : pct} dim={it.state === "queued"} tone={it.state === "uploading" ? "info" : "accent"}
                label={it.state === "uploading" ? t("Uploading to YouTube…") : t("Rendering…")} />
              <span className="mono w-9 shrink-0 text-right text-xs text-mute">{pct !== null ? `${Math.round(pct * 100)}%` : "—"}</span>
            </div>
            {j?.message && <p className="max-w-[18rem] truncate text-2xs text-dim" title={j.message}>{j.message}</p>}
          </div>
        )}
      </td>
      <td className="cx-r">
        {since !== null && it.state !== "failed" && it.state !== "waiting" ? (
          <span title={t("Elapsed / time left")}>
            <span className={live ? "text-ink" : "text-dim"}>{clock(since)}</span>
            {eta !== null && <span className="text-dim"> / ~{clock(eta)}</span>}
          </span>
        ) : <span className="text-dim">—</span>}
      </td>
      <td className="cx-r text-money">{cost !== null ? usd(cost) : <span className="text-dim">—</span>}</td>
      <td className="cx-fit">
        {it.onRetry && (
          <Button size="sm" variant="outline" className="max-sm:h-10" icon={<RefreshCw className="size-3.5" />} loading={retrying} onClick={retry}>{t("Render again")}</Button>
        )}
      </td>
    </tr>
  );
}

export default function RenderQueue({ items, className }: { items: QueueItem[]; className?: string }) {
  const t = useT();
  const active = items.some((i) => i.state === "running" || i.state === "uploading");
  const ticking = items.some((i) => i.state !== "failed" && i.state !== "waiting");
  const now = useNow(ticking);
  const live = items.filter((i) => i.state !== "failed").length;
  const failed = items.length - live;

  return (
    <Panel id="renders-section" index={2} className={className} eyebrow={t("Queue")} icon={<ListOrdered />} title={t("Render queue")} flush
      actions={
        <span className="mono inline-flex items-center gap-2 text-2xs text-dim" role="status">
          <EqBars idle={!active} />
          {live > 0 ? t("{n} active", { n: live }) : t("Idle")}{failed > 0 && <span className="text-bad"> · {t("{n} failed", { n: failed })}</span>}
        </span>
      }>
      {items.length ? (
        <div className="cx-scroll mt-3 max-h-80 border-t border-line">
          <table className="cx-table" aria-label={t("Render queue")}>
            <thead>
              <tr>
                <th className="cx-stick">{t("Job")}</th>
                <th>{t("Render")}</th>
                <th>{t("Status")}</th>
                <th>{t("Progress")}</th>
                <th className="cx-r">{t("Elapsed / ETA")}</th>
                <th className="cx-r">{t("Cost")}</th>
                <th><span className="sr-only">{t("Actions")}</span></th>
              </tr>
            </thead>
            <tbody>{items.map((it) => <Row key={it.key} it={it} now={now} />)}</tbody>
          </table>
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-3 px-4 pb-4 pt-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-dim"><Hourglass className="size-4" /></span>
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("The queue is clear")}</p>
            <p className="text-xs text-mute">{t("Renders you start appear here while they run.")}</p>
          </div>
        </div>
      )}
    </Panel>
  );
}
