import { clsx } from "clsx";
import { ArrowUpRight, Ban, CloudUpload, Cpu, FolderOpen, Play, Rocket } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { SectionCard } from "../../../components/room/kit";
import { Badge, Button, Progress, Select, Skeleton, Toggle } from "../../../components/ui";
import { dcall, eta, isDesktop, useDesktopQuery, useRenderJobs, type RenderJob, type RenderPreset } from "../../../lib/desktop";
import { LANG_NAMES } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import type { ExportRow, Project } from "../../../lib/types";
import { Quiet, Sub } from "./parts";

const ACTIVE = new Set<RenderJob["status"]>(["queued", "preparing", "downloading", "rendering", "uploading"]);
const STATUS_TONE: Record<RenderJob["status"], "accent" | "ok" | "bad" | "neutral" | "info"> = {
  queued: "neutral", preparing: "info", downloading: "info", rendering: "accent", uploading: "accent", done: "ok", failed: "bad", cancelled: "neutral",
};

const hwLabel = (p: RenderPreset) => {
  if (!p.hardware) return "Software";
  if (p.hardware === true) return "Hardware";
  const h = String(p.hardware).toLowerCase();
  return h.includes("nvenc") ? "NVENC" : h.includes("qsv") ? "Quick Sync" : h.includes("amf") ? "AMF" : String(p.hardware);
};

/** Desktop: local 4K renders with hardware encoding, uploaded to the Render Center. Web: a pointer to server renders. */
export function RenderCard({ project, eid, lang, exports, canEdit, className }: {
  project: Project; eid: number; lang: string; exports: ExportRow[]; canEdit: boolean; className?: string;
}) {
  const t = useT();
  if (!isDesktop) {
    return (
      <SectionCard className={className} icon={<Rocket />} title={t("Render")}
        description={t("Server renders (up to 1080p) are made in Export and land in the Render Center.")}>
        <div className="space-y-3">
          <Link to={`/p/${project.id}/export`}><Button variant="outline" iconRight={<ArrowUpRight className="size-3.5" />}>{t("Open Export")}</Button></Link>
          <p className="text-xs text-dim">{t("Tatvam Desktop renders 4K masters on this computer's graphics card (NVENC, Quick Sync or AMF) and uploads them to the same Render Center.")}</p>
        </div>
      </SectionCard>
    );
  }
  return <LocalRender project={project} eid={eid} lang={lang} exports={exports} canEdit={canEdit} className={className} />;
}

function LocalRender({ project, eid, lang: ctxLang, exports, canEdit, className }: {
  project: Project; eid: number; lang: string; exports: ExportRow[]; canEdit: boolean; className?: string;
}) {
  const t = useT();
  const presets = useDesktopQuery(["render-presets"], (d) => d.render.presets(), { staleTime: 60_000 });
  const jobs = useRenderJobs().filter((j) => j.pid === project.id);
  const [preset, setPreset] = useState<string>("");
  const [lang, setLang] = useState(ctxLang);
  const [opts, setOpts] = useState({ effects: true, captions: true, music: true, upscaled: true, localUpscale: false, upload: true });
  const [busy, setBusy] = useState(false);
  const list = presets.data ?? [];
  const chosen = list.find((p) => p.id === preset) ?? list[0];
  const set = (k: keyof typeof opts) => (v: boolean) => setOpts((o) => ({ ...o, [k]: v }));

  const start = async () => {
    if (!chosen) return;
    setBusy(true);
    const id = await dcall(t("Render"), (d) => d.render.start({ pid: project.id, eid, lang, preset: chosen.id, ...opts }));
    setBusy(false);
    if (id) toast.success(t("{preset} render started", { preset: chosen.label }));
  };
  const versionOf = (j: RenderJob) => j.version ?? exports.find((x) => x.id === j.export_id)?.version ?? null;

  return (
    <SectionCard className={className} icon={<Rocket />} title={t("Render")}
      description={t("Renders exactly what the server would (same plan, same mix) at up to 4K, on this computer's graphics card.")}>
      <div className="@container space-y-4">
        <Sub title={t("Preset")}>
          {presets.isLoading ? <Skeleton className="h-24" /> : !list.length ? <Quiet>{t("No presets: FFmpeg wasn't found. Run the machine check below.")}</Quiet> : (
            <div className="grid gap-1.5 @xl:grid-cols-2">
              {list.map((p) => {
                const on = chosen?.id === p.id;
                return (
                  <button key={p.id} type="button" aria-pressed={on} onClick={() => setPreset(p.id)}
                    className={clsx("flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
                      on ? "border-accent/50 bg-accent/10" : "border-line hover:border-dim/50 hover:bg-hover")}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{p.label}</p>
                      <p className="mono mt-0.5 truncate text-2xs text-dim">{p.w}×{p.h} · {p.fps} fps · {p.codec} · .{p.container}</p>
                    </div>
                    <Badge tone={p.hardware ? "ok" : "neutral"}><Cpu className="size-3" />{t(hwLabel(p))}</Badge>
                  </button>
                );
              })}
            </div>
          )}
        </Sub>

        <Sub title={t("Options")}>
          <div className="grid gap-x-4 gap-y-2.5 @md:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <span className="w-20 shrink-0 text-xs text-mute">{t("Language")}</span>
              <Select value={lang} onChange={(e) => setLang(e.target.value)} className="!h-8 text-xs">
                {project.languages.map((l) => <option key={l} value={l}>{t(LANG_NAMES[l] ?? l)}</option>)}
              </Select>
            </label>
            <span />
            <Toggle checked={opts.effects} onChange={set("effects")} label={<span className="text-sm">{t("Effects and looks")}</span>} />
            <Toggle checked={opts.captions} onChange={set("captions")} label={<span className="text-sm">{t("Burn in captions")}</span>} />
            <Toggle checked={opts.music} onChange={set("music")} label={<span className="text-sm">{t("Music")}</span>} />
            <Toggle checked={opts.upscaled} onChange={set("upscaled")} label={<span className="text-sm">{t("Use AI upscales")}</span>} />
            <Toggle checked={opts.localUpscale} onChange={set("localUpscale")} label={<span className="text-sm">{t("Local upscale (light sharpen)")}</span>} />
            <Toggle checked={opts.upload} onChange={set("upload")} label={<span className="text-sm">{t("Upload when done")}</span>} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<Play className="size-4" fill="currentColor" />} loading={busy} disabled={!chosen || !canEdit} onClick={start}>
              {chosen ? t("Render {preset}", { preset: chosen.label }) : t("Render")}
            </Button>
            {!canEdit && <span className="text-xs text-dim">{t("Creators and producers can render.")}</span>}
            <span className="text-2xs text-dim">{t("No AI runs here; nothing is charged.")}</span>
          </div>
        </Sub>

        <Sub title={t("Renders on this computer")} actions={jobs.length > 0 ? <span className="mono text-2xs text-dim">{jobs.length}</span> : undefined}>
          {!jobs.length ? <Quiet>{t("No local renders yet.")}</Quiet> : (
            <ul className="space-y-1.5">
              {jobs.map((j) => <JobRow key={j.id} j={j} pid={project.id} version={versionOf(j)} label={list.find((p) => p.id === j.preset)?.label ?? j.preset} />)}
            </ul>
          )}
        </Sub>
      </div>
    </SectionCard>
  );
}

/** One local render: status, step, progress and ETA, and what can be done with it. */
export function JobRow({ j, pid, version, label }: { j: RenderJob; pid: number; version: number | null; label: string }) {
  const t = useT();
  const active = ACTIVE.has(j.status);
  return (
    <li className="rounded-lg border border-line bg-raised/30 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label} <span className="mono text-2xs font-normal text-dim">{j.lang.toUpperCase()} · E{j.eid}</span></span>
        <Badge tone={STATUS_TONE[j.status] ?? "neutral"} dot>{t(j.status)}</Badge>
        {active && <Button size="sm" variant="ghost" icon={<Ban className="size-3.5" />} onClick={() => void dcall(t("Cancel render"), (d) => d.render.cancel(j.id))}>{t("Cancel")}</Button>}
        {j.output && <Button size="sm" variant="ghost" icon={<FolderOpen className="size-3.5" />} onClick={() => void dcall(t("Show file"), (d) => d.render.reveal(j.id))}>{t("Show")}</Button>}
        {j.status === "done" && !j.uploaded && (
          <Button size="sm" variant="outline" icon={<CloudUpload className="size-3.5" />} onClick={() => void dcall(t("Upload"), (d) => d.render.upload(j.id))}>{t("Upload")}</Button>
        )}
      </div>
      {active && (
        <div className="mt-2 flex items-center gap-3">
          <Progress value={j.progress} className="flex-1" indeterminate={j.status === "queued" || j.status === "preparing"} />
          <span className="mono shrink-0 text-2xs tabular-nums text-mute">{Math.round((j.progress || 0) * 100)}%{j.eta_s ? ` · ${eta(j.eta_s)}` : ""}</span>
        </div>
      )}
      {(j.step || j.error) && <p className={clsx("mono mt-1 truncate text-2xs", j.error ? "text-bad" : "text-dim")} title={j.error || j.step}>{j.error || j.step}</p>}
      {j.uploaded && (
        <Link to={`/p/${pid}/export`} className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-accent-ink hover:underline">
          {version ? t("v{n} in Render Center", { n: version }) : t("In Render Center")}<ArrowUpRight className="size-3" />
        </Link>
      )}
    </li>
  );
}
