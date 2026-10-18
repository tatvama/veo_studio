import { useQueryClient } from "@tanstack/react-query";
import { Eraser, FileDown, FolderInput, FolderOpen, FolderSync, HardDrive, RefreshCw, Square } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SectionCard } from "../../../components/room/kit";
import { Badge, Button, Progress, Segmented, Skeleton, Toggle, Tooltip } from "../../../components/ui";
import { bytes, dcall, type TatvamDesktop, useDesktopInfo, useDesktopQuery, useDesktopSettings, useSyncStatus } from "../../../lib/desktop";
import { useT } from "../../../lib/i18n";
import { ConfirmDialog } from "../../admin/shared/ConfirmDialog";
import { PathLine, Quiet, Sub } from "./parts";

/** Folders in the order the project folder lists them (docs/DESKTOP.md §3). */
const FOLDER_ORDER = ["Takes", "Audio", "Audio/Voice", "Audio/Music", "Audio/SFX", "Captions", "Imports", "Proxies", "Renders", "Cache", "Bible",
  "Bible/Characters", "Bible/Locations", "Bible/Props", "Media", "Edits"];
const CLEANABLE = { cache: "Cache", proxies: "Proxies", renders: "Renders" } as const;
type Cleanable = keyof typeof CLEANABLE;

const PHASES: Record<string, string> = {
  idle: "Idle", manifest: "Reading the manifest", downloading: "Downloading", renaming: "Renaming in series", cleaning: "Cleaning up",
  done: "Up to date", stopped: "Stopped", error: "Failed",
};
const RUNNING = new Set(["manifest", "downloading", "renaming", "cleaning"]);

/** The project's local folder: where it is, what's in it, what to pull from the server, the sync, and the Imports watch. */
export function FolderCard({ pid, eid, lang, className }: { pid: number; eid: number; lang: string; className?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: info } = useDesktopInfo();
  const { data: settings } = useDesktopSettings();
  const folder = useDesktopQuery(["folder", pid], (d) => d.library.projectFolder(pid));
  const usage = useDesktopQuery(["usage", pid], (d) => d.library.usage(pid), { refetchInterval: 30_000 });
  const imports = useDesktopQuery(["imports", pid], (d) => d.imports.status(pid), { refetchInterval: 5_000 });
  const sync = useSyncStatus(pid);
  const [busy, setBusy] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState<Cleanable | null>(null);
  const scope = settings?.pullScope ?? "approved";
  const running = !!sync && RUNNING.has(sync.phase);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["desktop", "folder", pid] });
    qc.invalidateQueries({ queryKey: ["desktop", "usage", pid] });
    qc.invalidateQueries({ queryKey: ["desktop", "info"] });
    qc.invalidateQueries({ queryKey: ["desktop", "settings"] });
  };
  const act = async <T,>(what: string, label: string, fn: (d: TatvamDesktop) => Promise<T>) => {
    setBusy(what);
    const r = await dcall<T>(label, fn);
    setBusy(null);
    return r;
  };

  const chooseRoot = async () => { if (await act("root", t("Library folder"), (d) => d.library.chooseRoot())) { refresh(); toast.success(t("Library folder changed")); } };
  const move = async () => { if (await act("move", t("Move folder"), (d) => d.library.chooseProjectFolder(pid))) { refresh(); toast.success(t("Project folder moved")); } };
  const setScope = async (v: "approved" | "cut") => {
    await dcall(t("Pull scope"), (d) => d.settings.set({ pullScope: v }));
    qc.invalidateQueries({ queryKey: ["desktop", "settings"] });
  };
  const start = () => act("sync", t("Sync"), (d) => d.sync.start(pid, { scope, episodeId: eid }));
  const stop = () => act("stop", t("Stop sync"), (d) => d.sync.stop(pid));
  const clean = async () => {
    if (!cleaning) return;
    const r = await act("clean", t("Clean"), (d) => d.library.clean(pid, [cleaning]));
    setCleaning(null);
    if (r) toast.success(t("Freed {size}", { size: bytes(r.removedBytes) }));
    qc.invalidateQueries({ queryKey: ["desktop", "usage", pid] });
  };
  const watch = async (on: boolean) => {
    await act("watch", t("Imports"), (d) => d.imports.setWatching(pid, eid, on));
    qc.invalidateQueries({ queryKey: ["desktop", "imports", pid] });
  };
  const edl = async () => {
    const r = await act("edl", t("EDL"), (d) => d.edl.write(pid, eid, lang));
    if (r) toast.success(t("EDL and FCPXML written to Edits"), { description: r.edl });
  };

  const rows = Object.entries(usage.data?.folders ?? {}).sort(([a], [b]) => {
    const ia = FOLDER_ORDER.indexOf(a), ib = FOLDER_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const total = rows.reduce((a, [, v]) => a + v.bytes, 0);
  const pct = sync ? (sync.bytesTotal > 0 ? sync.bytes / sync.bytesTotal : sync.total > 0 ? sync.done / sync.total : 0) : 0;

  return (
    <SectionCard className={className} icon={<HardDrive />} title={t("Local folder")}
      description={t("Takes, audio, renders and Cast stills mirrored on this computer, named in cut order. Premiere and DaVinci can open it.")}
      actions={<Button size="sm" variant="outline" icon={<FolderOpen className="size-3.5" />} onClick={() => void dcall(t("Open folder"), (d) => d.library.open(pid))}>{t("Open")}</Button>}>
      <div className="space-y-4">
        <Sub title={t("Where")}>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-mute">{t("Library")}</span>
              <PathLine path={info?.libraryRoot || settings?.libraryRoot} className="flex-1" />
              <Button size="sm" variant="ghost" loading={busy === "root"} onClick={chooseRoot}>{t("Change…")}</Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-mute">{t("This project")}</span>
              {folder.isLoading ? <Skeleton className="h-6 flex-1" /> : <PathLine path={folder.data?.path} className="flex-1" />}
              {folder.data?.custom && <Badge tone="info">{t("own folder")}</Badge>}
              {folder.data && !folder.data.exists && <Badge tone="warn">{t("not created yet")}</Badge>}
              <Tooltip content={t("Pick a new folder; the files already synced move with it")}>
                <Button size="sm" variant="ghost" icon={<FolderInput className="size-3.5" />} loading={busy === "move"} onClick={move}>{t("Change…")}</Button>
              </Tooltip>
            </div>
          </div>
        </Sub>

        <Sub title={t("Sync from the studio")} actions={running
          ? <Button size="sm" variant="outline" icon={<Square className="size-3" fill="currentColor" />} loading={busy === "stop"} onClick={stop}>{t("Stop")}</Button>
          : <Button size="sm" variant="primary" icon={<FolderSync className="size-3.5" />} loading={busy === "sync"} onClick={start}>{t("Sync now")}</Button>}>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-xs text-mute">{t("Pull")}</span>
              <Segmented size="sm" value={scope} onChange={(v) => void setScope(v)} aria-label={t("Pull scope")}
                options={[{ value: "approved", label: t("Approved") }, { value: "cut", label: t("Everything in the cut") }]} />
              <span className="text-2xs text-dim">{scope === "approved"
                ? t("Approved and hand-picked takes, music, approved renders and Cast stills.")
                : t("The current take of every shot in the cut, to start before approval.")}</span>
            </div>
            {sync ? (
              <div className="rounded-lg border border-line bg-raised/40 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone={sync.phase === "error" ? "bad" : sync.phase === "done" ? "ok" : running ? "accent" : "neutral"} dot>{t(PHASES[sync.phase] ?? sync.phase)}</Badge>
                  <span className="mono tabular-nums text-mute">{sync.total === 0 && sync.inFolder != null
                    ? t("{n} files in series", { n: sync.inFolder }) : `${sync.done}/${sync.total} ${t("files")}`}</span>
                  {sync.bytesTotal > 0 && <span className="mono tabular-nums text-dim">{bytes(sync.bytes)} / {bytes(sync.bytesTotal)}</span>}
                </div>
                <Progress value={running ? pct : sync.phase === "done" ? 1 : pct} indeterminate={sync.phase === "manifest"} tone={sync.phase === "error" ? "bad" : sync.phase === "done" ? "ok" : "accent"} />
                {sync.current && running && <p className="mono mt-2 truncate text-2xs text-dim" title={sync.current}>{sync.current}</p>}
                {sync.errors?.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {sync.errors.slice(0, 5).map((e, i) => <li key={i} className="mono truncate text-2xs text-bad" title={String(e)}>{String(e)}</li>)}
                    {sync.errors.length > 5 && <li className="text-2xs text-dim">{t("+{n} more", { n: sync.errors.length - 5 })}</li>}
                  </ul>
                )}
              </div>
            ) : <Quiet>{t("Not synced yet on this computer.")}</Quiet>}
          </div>
        </Sub>

        <Sub title={t("On disk")} actions={<span className="mono text-2xs text-dim">{t("{size} free", { size: bytes(usage.data?.freeBytes) })}</span>}>
          {usage.isLoading ? <Skeleton className="h-24" /> : rows.length ? (
            <div className="overflow-hidden rounded-lg border border-line">
              <table className="w-full text-xs">
                <thead className="bg-raised text-2xs uppercase tracking-wide text-dim">
                  <tr><th className="px-3 py-1.5 text-left font-medium">{t("Folder")}</th><th className="px-3 py-1.5 text-right font-medium">{t("Files")}</th><th className="px-3 py-1.5 text-right font-medium">{t("Size")}</th><th className="w-8" /></tr>
                </thead>
                <tbody>
                  {rows.map(([name, v]) => (
                    <tr key={name} className="border-t border-line/60">
                      <td className="px-3 py-1.5">{name}</td>
                      <td className="mono px-3 py-1.5 text-right tabular-nums text-mute">{v.files}</td>
                      <td className="mono px-3 py-1.5 text-right tabular-nums">{bytes(v.bytes)}</td>
                      <td className="pr-1.5 text-right">
                        <button type="button" title={t("Open {folder}", { folder: name })} onClick={() => void dcall(t("Open folder"), (d) => d.library.open(pid, name))}
                          className="grid size-6 place-items-center rounded text-dim hover:bg-hover hover:text-ink"><FolderOpen className="size-3" /></button>
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-line bg-raised/40 font-medium">
                    <td className="px-3 py-1.5">{t("Total")}</td><td /><td className="mono px-3 py-1.5 text-right tabular-nums">{bytes(total)}</td><td />
                  </tr>
                </tbody>
              </table>
            </div>
          ) : <Quiet>{t("Nothing on disk yet.")}</Quiet>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {(Object.keys(CLEANABLE) as Cleanable[]).map((k) => (
              <Button key={k} size="sm" variant="ghost" icon={<Eraser className="size-3.5" />} onClick={() => setCleaning(k)}>
                {k === "cache" ? t("Clean cache") : k === "proxies" ? t("Clean proxies") : t("Clean uploaded renders")}
              </Button>
            ))}
            <span className="flex-1" />
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => qc.invalidateQueries({ queryKey: ["desktop", "usage", pid] })}>{t("Refresh")}</Button>
          </div>
        </Sub>

        <Sub title={t("Imports and edits")}>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Toggle checked={!!imports.data?.watching} disabled={busy === "watch" || !imports.data} onChange={(v) => void watch(v)}
                label={<span className="text-sm">{t("Watch the Imports folder")}</span>} />
              {imports.data && (
                <span className="mono flex flex-wrap gap-x-3 text-2xs tabular-nums text-mute">
                  <span>{t("{n} waiting", { n: imports.data.pending })}</span>
                  <span className="text-ok">{t("{n} added", { n: imports.data.ingested })}</span>
                  {imports.data.failed.length > 0 && <span className="text-bad" title={imports.data.failed.join("\n")}>{t("{n} failed", { n: imports.data.failed.length })}</span>}
                </span>
              )}
            </div>
            <p className="text-2xs leading-relaxed text-dim">{t("Drop a file in Imports and it is uploaded to this episode's media once it stops growing, ready for a layer.")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" icon={<FileDown className="size-3.5" />} loading={busy === "edl"} onClick={edl}>{t("Write EDL + FCPXML")}</Button>
              <span className="text-2xs text-dim">{t("Into Edits/, pointing at the series-named files.")}</span>
            </div>
          </div>
        </Sub>
      </div>

      <ConfirmDialog open={!!cleaning} onClose={() => setCleaning(null)} busy={busy === "clean"} onConfirm={clean}
        title={cleaning === "renders" ? t("Clean uploaded renders?") : cleaning === "proxies" ? t("Clean proxies?") : t("Clean the cache?")}
        confirmLabel={t("Clean")}>
        {cleaning === "renders" ? t("Renders that are already in the Render Center are removed from this computer. Renders that haven't uploaded stay.")
          : cleaning === "proxies" ? t("Proxies are rebuilt when proxy mode needs them.")
          : t("Cached files are downloaded again when they're needed.")}
      </ConfirmDialog>
    </SectionCard>
  );
}
