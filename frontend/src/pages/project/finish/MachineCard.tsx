import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { CircleAlert, CircleCheck, Cpu, FileText, Film, HardDrive, RefreshCw, Server, Stethoscope } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SectionCard } from "../../../components/room/kit";
import { Badge, Button, Skeleton, Toggle, Tooltip } from "../../../components/ui";
import { useDisk, useUiStatus } from "../../../desktop/bridge";
import { bytes, dcall, desktop, useDesktopInfo, useDesktopQuery, useDesktopSettings, type GpuSummary } from "../../../lib/desktop";
import { useT } from "../../../lib/i18n";
import { KV, Quiet, Sub } from "./parts";

/**
 * The machine check against the baseline (RTX 3060, 32 GB RAM, NVMe SSD), proxy mode, and the app itself. Without a
 * project (`pid` 0: the Start page, the first-run steps) "Build proxies" is left out; `summary` shows the graphics
 * card, the hardware encoder and the free disk at once, and the full check on demand.
 */
export function MachineCard({ pid = 0, className, variant = "full" }: { pid?: number; className?: string; variant?: "full" | "summary" }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: info } = useDesktopInfo();
  const { data: settings } = useDesktopSettings();
  // the check test-encodes on every hardware encoder, so it only runs when asked (and once per session)
  const check = useDesktopQuery(["machine"], (d) => d.media.machineCheck(), { enabled: false, staleTime: Infinity });
  const [busy, setBusy] = useState<string | null>(null);
  const r = check.data;

  const run = () => { void check.refetch().then((res) => { if (res.error) toast.error(t("Machine check: {e}", { e: String((res.error as Error).message ?? res.error) })); }); };
  const proxyMode = async (on: boolean) => {
    setBusy("proxy");
    await dcall(t("Proxy mode"), async (d) => { await d.media.proxyMode(on); await d.settings.set({ proxyMode: on }); });
    setBusy(null);
    qc.invalidateQueries({ queryKey: ["desktop", "settings"] });
  };
  const build = async () => {
    setBusy("build");
    const ok = await dcall(t("Proxies"), (d) => d.media.proxies(pid, true).then(() => true));
    setBusy(null);
    if (ok) toast.success(t("Building 1080p proxies in the background"));
  };
  const updates = async () => {
    setBusy("update");
    const u = await dcall(t("Updates"), (d) => d.app.checkForUpdates());
    setBusy(null);
    if (!u) return;
    if (u.state === "available" || u.state === "downloading") toast.success(t("Update {v} is downloading", { v: u.version ?? "" }));
    else if (u.state === "ready") toast.success(t("Update {v} is ready — restart to install", { v: u.version ?? "" }));
    else if (u.state === "disabled") toast.message(t("Updates are off in a development build"));
    else if (u.state === "error") toast.error(u.error ?? t("Couldn't check for updates"));
    else toast.success(t("Tatvam Desktop is up to date"));
  };

  const summary = variant === "summary";
  const ui = useUiStatus();
  const disk = useDisk();
  const [gpu, setGpu] = useState<GpuSummary | null>(null);
  const [hw, setHw] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!summary) return;
    void desktop()?.shell?.gpu().then(setGpu).catch(() => undefined);
    void desktop()?.render.presets().then((ps) => { const h = ps.find((p) => p.hardware)?.hardware; setHw(typeof h === "string" ? h : null); }).catch(() => setHw(null));
  }, [summary]);
  const ram = r?.ramBytes;
  const verdictTone = r?.verdict === "ok" ? "ok" : r?.verdict === "bad" ? "bad" : r?.verdict ? "warn" : "neutral";

  return (
    <SectionCard id="machine" className={className} icon={<Cpu />} title={t("This machine")}
      description={t("Graphics card, encoders, memory and disk against the editing baseline.")}
      actions={<Button size="sm" variant={r ? "ghost" : "outline"} icon={r ? <RefreshCw className="size-3.5" /> : <Stethoscope className="size-3.5" />} loading={check.isFetching} onClick={run}>
        {r ? t("Check again") : t("Run machine check")}
      </Button>}>
      <div className="space-y-4">
        {summary && (
          <div className="divide-y divide-line/60">
            <KV k={t("GPU")}>{gpu?.name ?? (gpu ? t("Unknown") : <Skeleton className="ml-auto h-3 w-32" />)}</KV>
            <KV k={t("Encoder")}>{hw === undefined ? <Skeleton className="ml-auto h-3 w-24" /> : hw ? `${hw} (hardware)` : t("Software (no hardware encoder found)")}</KV>
            {(disk?.drives ?? []).map((dr) => (
              <KV key={dr.path} k={<span className="inline-flex items-center gap-1"><HardDrive className="size-3" />{dr.label}</span>}>
                <span className={dr.low ? "text-warn" : undefined}>{bytes(dr.freeBytes)} free on {dr.path.replace(/\\$/, "")}</span>
              </KV>
            ))}
          </div>
        )}
        {check.isFetching && !r ? <Skeleton className="h-40" /> : !r ? (summary ? null : (
          <Quiet>{t("The check finds FFmpeg, lists the hardware encoders and test-encodes on NVENC, Quick Sync and AMF. It takes a few seconds.")}</Quiet>
        )) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {r.verdict && <Badge tone={verdictTone} dot>{r.verdict === "ok" ? t("Meets the baseline") : r.verdict === "bad" ? t("Below the baseline") : t("Partly below the baseline")}</Badge>}
              <Badge tone={r.nvenc ? "ok" : "neutral"}>{r.nvenc ? t("NVENC available") : t("No NVENC")}</Badge>
              {r.hostname && <span className="mono text-2xs text-dim">{r.hostname}</span>}
            </div>
            <div className="divide-y divide-line/60">
              {(r.gpus ?? []).map((g, i) => <KV key={i} k={i ? t("GPU {n}", { n: i + 1 }) : t("GPU")}>{g.name}{g.vramBytes ? ` · ${bytes(g.vramBytes)}` : ""}</KV>)}
              {r.cpu && <KV k={t("CPU")}>{r.cpu}{r.cores ? ` · ${r.cores} ${t("cores")}` : ""}</KV>}
              {ram !== undefined && <KV k={t("Memory")}>{bytes(ram)}</KV>}
              {r.disk && <KV k={t("Disk")}>{r.disk.kind ? `${r.disk.kind} · ` : ""}{t("{size} free", { size: bytes(r.disk.freeBytes) })}{r.disk.totalBytes ? ` / ${bytes(r.disk.totalBytes)}` : ""}</KV>}
              {r.ffmpeg && <KV k="FFmpeg">{r.ffmpeg.version ?? r.ffmpeg.path ?? "—"}</KV>}
              {(r.displays ?? []).length > 0 && <KV k={t("Screens")}>{(r.displays ?? []).map((d) => `${d.width ?? "?"}×${d.height ?? "?"}${d.primary ? "*" : ""}`).join(" · ")}</KV>}
            </div>
            {(r.encoders ?? []).length > 0 && (
              <Sub title={t("Encoders")}>
                <div className="flex flex-wrap gap-1">
                  {(r.encoders ?? []).map((e) => (
                    <Tooltip key={e.id} content={e.note || (e.ok ? t("Test encode worked") : t("Not usable on this machine"))}>
                      <span className={clsx("mono inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs",
                        e.ok ? "border-ok/30 bg-ok/10 text-ok" : "border-line bg-raised text-dim line-through")}>
                        {e.ok ? <CircleCheck className="size-3" /> : <CircleAlert className="size-3" />}{e.label ?? e.id}{e.hardware ? " · HW" : ""}
                      </span>
                    </Tooltip>
                  ))}
                </div>
              </Sub>
            )}
            {(r.baseline?.items ?? []).length > 0 && (
              <Sub title={r.baseline?.label ?? t("Against the baseline")}>
                <table className="w-full text-xs">
                  <tbody>
                    {(r.baseline?.items ?? []).map((b) => (
                      <tr key={b.label} className="border-t border-line/60 first:border-0">
                        <td className="py-1.5 text-mute">{b.label}</td>
                        <td className="mono py-1.5 text-right">{b.value}</td>
                        <td className="mono py-1.5 pl-3 text-right text-dim">{b.baseline}</td>
                        <td className="w-6 py-1.5 text-right">{b.ok ? <CircleCheck className="ml-auto size-3.5 text-ok" /> : <CircleAlert className="ml-auto size-3.5 text-warn" />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Sub>
            )}
            {(r.notes ?? []).map((n, i) => <p key={i} className="text-2xs leading-relaxed text-mute">{n}</p>)}
          </>
        )}

        {!summary && <Sub title={t("Proxies")}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Toggle checked={!!settings?.proxyMode} disabled={busy === "proxy"} onChange={(v) => void proxyMode(v)} label={<span className="text-sm">{t("Play 1080p proxies")}</span>} />
            {pid > 0 && <Button size="sm" variant="outline" icon={<Film className="size-3.5" />} loading={busy === "build"} onClick={build}>{t("Build proxies")}</Button>}
          </div>
          <p className="mt-1.5 text-2xs leading-relaxed text-dim">{t("On a slower machine the timeline plays light 1080p copies; renders always use the originals.")}</p>
        </Sub>}

        {!summary && <Sub title={t("App")}>
          <div className="divide-y divide-line/60">
            <KV k={t("Version")}>{info?.appVersion ?? desktop()?.version ?? "—"}{info && !info.packaged ? ` · ${t("dev")}` : ""}</KV>
            <KV k={t("Studio server")}>{info?.serverUrl ?? settings?.serverUrl ?? "—"}</KV>
            <KV k={t("Interface")}>{ui?.label ?? (info?.uiSource === "server" ? t("from the server") : info?.uiSource === "auto" ? t("automatic") : t("bundled"))}</KV>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={busy === "update"} onClick={updates}>{t("Check for updates")}</Button>
            <Button size="sm" variant="ghost" icon={<FileText className="size-3.5" />} onClick={() => void dcall(t("Logs"), (d) => d.app.revealLogs())}>{t("Show logs")}</Button>
            <Button size="sm" variant="ghost" icon={<Server className="size-3.5" />} onClick={() => void dcall(t("Studio server"), (d) => d.app.openConnection())}>{t("Change server…")}</Button>
          </div>
        </Sub>}
      </div>
    </SectionCard>
  );
}
