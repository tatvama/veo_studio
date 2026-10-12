import { BadgeCheck, Clapperboard, Laptop, Play, Rocket } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Modal, Panel } from "../../../components/ui";
import { isDesktop, useDesktopQuery, useRenderJobs } from "../../../lib/desktop";
import { LANG_SHORT, secs } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useEpisode, useSettings } from "../../../lib/queries";
import type { ExportRow } from "../../../lib/types";
import { useProjectCtx } from "../../project/context";
import { JobRow } from "../../project/finish/RenderCard";

/** Local render jobs (desktop) and the Render Center's renders of this episode, newest version first. */
export default function RendersPanel() {
  const t = useT();
  const { project, eid, lang } = useProjectCtx();
  const { data: ep } = useEpisode(eid, lang);
  const { data: settings } = useSettings();
  const presets = settings?.catalog.export_presets ?? {};
  const desktopPresets = useDesktopQuery(["render-presets"], (d) => d.render.presets(), { staleTime: 60_000 });
  const jobs = useRenderJobs().filter((j) => j.pid === project.id);
  const [playing, setPlaying] = useState<ExportRow | null>(null);
  const exports = [...(ep?.exports ?? [])].sort((a, b) => (b.version ?? 0) - (a.version ?? 0) || b.id - a.id);
  const presetLabel = (x: ExportRow) => {
    if (x.preset.startsWith("desktop:")) {
      const id = x.preset.slice(8);
      return desktopPresets.data?.find((p) => p.id === id)?.label ?? id;
    }
    return presets[x.preset]?.label ?? x.preset;
  };

  return (
    <div className="@container h-full overflow-y-auto p-3">
      <div className="grid gap-3 @3xl:grid-cols-2">
        {isDesktop && (
          <Panel eyebrow={t("On this computer")} icon={<Laptop />} actions={<span className="mono text-2xs text-dim">{jobs.length}</span>}>
            {jobs.length ? (
              <ul className="space-y-1.5">
                {jobs.map((j) => (
                  <JobRow key={j.id} j={j} pid={project.id} label={desktopPresets.data?.find((p) => p.id === j.preset)?.label ?? j.preset}
                    version={j.version ?? exports.find((x) => x.id === j.export_id)?.version ?? null} />
                ))}
              </ul>
            ) : <p className="text-xs text-dim">{t("No local renders yet. Start one in the Finishing room.")}</p>}
          </Panel>
        )}
        <Panel eyebrow={t("Render Center")} icon={<Rocket />}
          actions={<Link to={`/p/${project.id}/export`} className="text-2xs font-medium text-accent-ink hover:underline">{t("Open Export")}</Link>}>
          {exports.length ? (
            <ul className="divide-y divide-line/60">
              {exports.map((x) => (
                <li key={x.id} className="flex items-center gap-2.5 py-2">
                  <button type="button" disabled={!x.url} onClick={() => setPlaying(x)} aria-label={t("Play")}
                    className="relative grid h-10 w-16 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-black disabled:opacity-50">
                    {x.thumb_url ? <img src={x.thumb_url} alt="" className="size-full object-cover" /> : <Clapperboard className="size-4 text-dim" />}
                    {x.url && <Play className="absolute size-4 text-white drop-shadow" fill="currentColor" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                      <span className="mono">{x.version ? `v${x.version}` : `#${x.id}`}</span>
                      <span className="truncate text-mute">{x.kind === "final" ? t("Final") : t("Animatic")} · {presetLabel(x)}</span>
                    </p>
                    <p className="mono mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-dim">
                      <span>{LANG_SHORT[x.language] ?? x.language}</span><span>{secs(x.duration_s)}</span>
                      {x.options?.w && x.options?.h && <span>{x.options.w}×{x.options.h}</span>}
                      {x.options?.cut_version && <span>{t("cut v{n}", { n: x.options.cut_version })}</span>}
                    </p>
                  </div>
                  {x.options?.source === "desktop" && <Badge tone="info">{t("desktop")}</Badge>}
                  {x.approved_by ? <Badge tone="ok"><BadgeCheck className="size-3" />{t("approved")}</Badge> : x.status !== "ready" ? <Badge tone="neutral">{t(x.status)}</Badge> : null}
                </li>
              ))}
            </ul>
          ) : <p className="text-xs text-dim">{t("No renders of this episode yet.")}</p>}
        </Panel>
      </div>
      <Modal open={!!playing} onClose={() => setPlaying(null)} size="lg" title={playing ? `${playing.version ? `v${playing.version}` : `#${playing.id}`} · ${presetLabel(playing)}` : ""}>
        {playing && <video src={playing.url} controls autoPlay playsInline className="mx-auto max-h-[72vh] max-w-full rounded-lg bg-black" />}
      </Modal>
    </div>
  );
}
