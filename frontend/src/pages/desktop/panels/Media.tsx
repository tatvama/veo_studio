import { useQuery } from "@tanstack/react-query";
import { Film, FolderOpen, ImageIcon, Music2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, Panel, SearchField, Skeleton } from "../../../components/ui";
import { api } from "../../../lib/api";
import { bytes, dcall, isDesktop, useDesktopQuery, useSyncStatus } from "../../../lib/desktop";
import { useT } from "../../../lib/i18n";
import { useProjectCtx } from "../../project/context";
import type { LayersDoc, MediaItem } from "../../project/production/timeline/Layers";

/** Desktop: the project folder (sizes, open buttons, the series-named files). Everywhere: the episode's layer media. */
export default function MediaPanel() {
  const t = useT();
  const { project, eid } = useProjectCtx();
  const pid = project.id;
  const usage = useDesktopQuery(["usage", pid], (d) => d.library.usage(pid), { refetchInterval: 30_000 });
  const files = useDesktopQuery(["naming-preview", pid], (d) => d.naming.preview(pid));
  const sync = useSyncStatus(pid);
  const { data: layers, isLoading } = useQuery({ queryKey: ["layers", eid], queryFn: () => api.get<LayersDoc>(`/api/episodes/${eid}/layers`), enabled: !!eid });
  const [q, setQ] = useState("");
  const names = useMemo(() => (files.data ?? []).map((f) => f.to).filter((n) => !q || n.toLowerCase().includes(q.toLowerCase())), [files.data, q]);
  const media = (layers?.media ?? []).filter((m) => !q || m.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="@container h-full overflow-y-auto p-3">
      <SearchField value={q} onChange={setQ} placeholder={t("Filter files")} className="mb-3" />
      <div className="grid gap-3 @3xl:grid-cols-2">
        {isDesktop && (
          <Panel eyebrow={t("Local folder")} icon={<FolderOpen />}
            actions={<>
              {sync && <Badge tone={sync.phase === "error" ? "bad" : sync.phase === "done" ? "ok" : "neutral"}>{sync.phase}</Badge>}
              <button type="button" className="text-2xs font-medium text-accent-ink hover:underline" onClick={() => void dcall(t("Open folder"), (d) => d.library.open(pid))}>{t("Open")}</button>
            </>}>
            <ul className="mb-3 grid grid-cols-2 gap-1">
              {Object.entries(usage.data?.folders ?? {}).map(([name, v]) => (
                <li key={name}>
                  <button type="button" onClick={() => void dcall(t("Open folder"), (d) => d.library.open(pid, name))}
                    className="flex w-full items-center gap-2 rounded-md border border-line px-2 py-1 text-left text-xs hover:bg-hover">
                    <FolderOpen className="size-3.5 shrink-0 text-dim" />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    <span className="mono shrink-0 text-2xs text-dim">{v.files} · {bytes(v.bytes)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="eyebrow mb-1.5">{t("Files, in series")}</p>
            {files.isLoading ? <Skeleton className="h-24" /> : names.length ? (
              <ul className="max-h-[50vh] space-y-px overflow-y-auto">
                {names.slice(0, 400).map((n, i) => <li key={`${n}-${i}`} className="mono truncate text-2xs text-mute" title={n}>{n}</li>)}
                {names.length > 400 && <li className="text-2xs text-dim">{t("+{n} more", { n: names.length - 400 })}</li>}
              </ul>
            ) : <p className="text-xs text-dim">{t("Nothing synced yet.")}</p>}
          </Panel>
        )}
        <Panel eyebrow={t("Layer media")} icon={<Film />} actions={<span className="mono text-2xs text-dim">{layers?.media.length ?? 0}</span>}>
          {isLoading ? <Skeleton className="h-32" /> : media.length ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
              {media.map((m: MediaItem) => (
                <li key={m.src}>
                  <a href={m.url} target="_blank" rel="noreferrer" className="group block overflow-hidden rounded-lg border border-line hover:border-accent/40">
                    <span className="relative grid aspect-video place-items-center bg-black">
                      {m.thumb_url ? <img src={m.thumb_url} alt="" className="size-full object-cover" loading="lazy" />
                        : m.kind === "audio" ? <Music2 className="size-5 text-dim" /> : m.kind === "image" ? <ImageIcon className="size-5 text-dim" /> : <Film className="size-5 text-dim" />}
                    </span>
                    <span className="flex items-center gap-1 px-2 py-1">
                      <span className="min-w-0 flex-1 truncate text-2xs">{m.name}</span>
                      <span className="mono shrink-0 text-2xs text-dim">{m.kind === "image" ? t("picture") : `${m.duration.toFixed(1)}s`}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : <p className="text-xs text-dim">{t("No uploaded media on this episode. Drop files on a timeline layer, or in the Imports folder on the desktop.")}</p>}
        </Panel>
      </div>
    </div>
  );
}
