import { useQueryClient } from "@tanstack/react-query";
import { Calculator, Cpu, Download, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge, Button, IconButton, Progress, Segmented, Skeleton } from "../../../components/ui";
import { bytes, dcall, eta, useUpscaleJobs, useUpscaleTool, type LocalUpscaleEstimate, type UpscaleJob, type UpscaleModel } from "../../../lib/desktop";
import { skipLabel } from "../../../lib/finish";
import { secs } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { Quiet } from "./parts";

const wh = (v?: [number, number]) => (v && v.length === 2 ? `${v[0]}×${v[1]}` : "—");
const ACTIVE: UpscaleJob["status"][] = ["queued", "preparing", "extracting", "upscaling", "encoding", "uploading"];
const mins = (m: number) => (m < 1 ? "< 1 min" : m < 90 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);

/**
 * AI upscale on this PC's graphics card (Tatvam Desktop): Real-ESRGAN, installed once on demand. Free, slower than the
 * cloud, and every upscaled clip is uploaded as the shot's upscale take, so renders and the rest of the team use it.
 */
export function LocalUpscale({ pid, eid, target, canEdit }: { pid: number; eid: number; target: number; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const tool = useUpscaleTool();
  const jobs = useUpscaleJobs().filter((j) => j.eid === eid);
  const [model, setModel] = useState<UpscaleModel>("fast");
  const [est, setEst] = useState<LocalUpscaleEstimate | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const done = useRef(new Set<string>());

  // a finished upscale is a new take: refresh the episode (and the estimate, which now skips that shot)
  useEffect(() => {
    const fresh = jobs.filter((j) => j.status === "done" && !done.current.has(j.id));
    if (!fresh.length) return;
    for (const j of fresh) done.current.add(j.id);
    qc.invalidateQueries({ queryKey: ["episode", eid] });
  }, [jobs, eid, qc]);

  const install = async () => {
    setBusy("install");
    const r = await dcall(t("Install the upscaler"), (d) => d.upscale!.install());
    setBusy(null);
    if (r?.installed) toast.success(t("Real-ESRGAN is ready on this PC"));
  };
  const estimate = async (m = model) => {
    setBusy("estimate");
    const r = await dcall(t("Estimate"), (d) => d.upscale!.estimate({ pid, eid, targetH: target, model: m }));
    setBusy(null);
    if (r) setEst(r);
  };
  const start = async () => {
    setBusy("start");
    const ids = await dcall(t("Upscale"), (d) => d.upscale!.start({ pid, eid, targetH: target, model }));
    setBusy(null);
    if (ids?.length) { toast.success(t("Upscaling {n} shots on this PC", { n: ids.length })); setEst(null); }
    else if (ids) toast.message(t("Nothing new to upscale"));
  };
  useEffect(() => { if (est) void estimate(); }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tool) return <Skeleton className="h-24" />;
  if (!tool.platformSupported) return <Quiet>{t("Upscaling on this PC works on Windows for now. Use the cloud upscaler instead.")}</Quiet>;
  if (!tool.installed) {
    return (
      <div className="space-y-2 rounded-lg border border-line bg-raised/40 p-3">
        <p className="text-sm text-ink">{t("Upscale with AI on this PC's graphics card, free.")}</p>
        <p className="text-2xs leading-relaxed text-dim">
          {t("Uses Real-ESRGAN (open source, BSD licence). Install it once: {size} from github.com/xinntao/Real-ESRGAN, checked against its fingerprint before it's used.",
            { size: bytes(tool.sizeBytes) })}
        </p>
        {tool.installing && <Progress value={tool.progress ?? 0} size="sm" />}
        {tool.error && <p className="text-2xs text-bad">{tool.error}</p>}
        <Button variant="primary" size="sm" icon={<Download className="size-3.5" />} loading={busy === "install" || !!tool.installing}
          onClick={() => void install()}>{tool.installing ? t("Installing… {p}%", { p: Math.round((tool.progress ?? 0) * 100) }) : t("Install the upscaler")}</Button>
      </div>
    );
  }

  const running = jobs.filter((j) => ACTIVE.includes(j.status));
  const recent = jobs.filter((j) => !ACTIVE.includes(j.status)).slice(0, 6);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-mute">
          <Cpu className="size-3.5 shrink-0" />
          <span className="truncate">{t("Real-ESRGAN {v} on {gpu}", { v: tool.version, gpu: tool.gpu?.name ?? t("the graphics card") })}</span>
        </span>
        <Segmented size="sm" value={model} aria-label={t("Upscale model")} onChange={(m) => { setModel(m); if (est) void estimate(m); }}
          options={[{ value: "fast", label: t("Fast") }, { value: "best", label: t("Best detail") }]} />
      </div>
      <p className="text-2xs leading-relaxed text-dim">
        {model === "fast"
          ? t("Real-ESRGAN's video model: sharper edges and texture with little flicker. On a GTX 1660 Ti about 2 minutes per 6-second shot to 4K.")
          : t("Real-ESRGAN x4plus: the most natural detail, but very slow (about 20 seconds a frame on a GTX 1660 Ti). Best kept for a hero shot.")}
      </p>

      {!est ? (
        <Button variant="outline" icon={<Calculator className="size-4" />} loading={busy === "estimate"} onClick={() => void estimate()}>
          {t("Estimate the time")}
        </Button>
      ) : (
        <>
          {est.items.length ? (
            <div className="max-h-56 overflow-y-auto rounded-lg border border-line">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-raised text-2xs uppercase tracking-wide text-dim">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">{t("Shot")}</th>
                    <th className="px-3 py-1.5 text-left font-medium">{t("From → to")}</th>
                    <th className="px-3 py-1.5 text-right font-medium">{t("Frames")}</th>
                    <th className="px-3 py-1.5 text-right font-medium">{t("Time")}</th>
                  </tr>
                </thead>
                <tbody>
                  {est.items.map((i) => (
                    <tr key={i.shotId} className="border-t border-line/60">
                      <td className="mono px-3 py-1.5">{i.code}</td>
                      <td className="mono px-3 py-1.5 text-mute">{wh(i.from)} → <span className="text-ink">{wh(i.to)}</span> <span className="text-dim">×{i.scale}</span></td>
                      <td className="mono px-3 py-1.5 text-right tabular-nums text-mute">{i.frames}</td>
                      <td className="mono px-3 py-1.5 text-right tabular-nums">≈ {mins(i.minutes)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-line bg-raised/50 font-medium">
                    <td className="px-3 py-1.5">{t("{n} shots", { n: est.items.length })}</td>
                    <td className="px-3 py-1.5 text-2xs font-normal text-dim">{est.measured ? t("timed on this PC") : t("first guess for this PC")}</td>
                    <td className="mono px-3 py-1.5 text-right tabular-nums">{secs(est.items.reduce((a, i) => a + i.seconds, 0))}</td>
                    <td className="mono px-3 py-1.5 text-right tabular-nums">≈ {mins(est.totalMinutes)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : <Quiet>{t("Nothing to upscale: every shot already meets {h}p or has a fresh upscale.", { h: target })}</Quiet>}
          {est.skipped.length > 0 && (
            <details className="rounded-lg border border-line px-3 py-2 text-xs">
              <summary className="cursor-pointer text-mute">{t("{n} skipped", { n: est.skipped.length })}</summary>
              <ul className="mt-1.5 space-y-0.5">{est.skipped.map((s, i) => <li key={i} className="mono text-2xs text-dim">{skipLabel(s)}</li>)}</ul>
            </details>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {est.items.length > 0 && (
              <Button variant="primary" icon={<Cpu className="size-4" />} disabled={!canEdit} loading={busy === "start"} onClick={() => void start()}>
                {t("Upscale {n} shots on this PC · free", { n: est.items.length })}
              </Button>
            )}
            <Button variant="ghost" loading={busy === "estimate"} onClick={() => void estimate()}>{t("Estimate again")}</Button>
          </div>
        </>
      )}

      {(running.length > 0 || recent.length > 0) && (
        <ul className="divide-y divide-line/60 rounded-lg border border-line">
          {[...running, ...recent].map((j) => (
            <li key={j.id} className="space-y-1.5 px-3 py-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="mono">{j.code} <span className="text-dim">{wh(j.from)} → {wh(j.to)}</span></span>
                <span className="flex items-center gap-1.5">
                  <Badge tone={j.status === "done" ? "ok" : j.status === "failed" ? "bad" : j.status === "cancelled" ? "neutral" : "accent"} dot>
                    {j.status === "done" ? t("Uploaded") : j.status === "failed" ? t("Failed") : j.status === "cancelled" ? t("Cancelled") : t(j.status)}
                  </Badge>
                  {ACTIVE.includes(j.status) && (
                    <IconButton title={t("Cancel")} className="!size-6" onClick={() => void dcall(t("Cancel"), (d) => d.upscale!.cancel(j.id))}>
                      <Square className="size-3" />
                    </IconButton>
                  )}
                </span>
              </div>
              {ACTIVE.includes(j.status) && <Progress value={j.progress} size="sm" />}
              <p className="text-2xs text-dim">
                {j.error ?? j.step}
                {j.fps ? ` · ${j.fps} fps` : ""}
                {ACTIVE.includes(j.status) && j.eta_s ? ` · ${t("{t} left", { t: eta(j.eta_s) })}` : ""}
                {j.status === "done" && j.elapsed_s ? ` · ${t("took {t}", { t: eta(j.elapsed_s) })}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
