/**
 * Version history (docs/EDITOR.md §10), the one place for both kinds of backup: the edit's backups on this PC
 * (`<Name>.tatvamedit.bak.1..10`, through bridge.editor.versions / restoreVersion) and on the studio (GET/POST
 * /api/edits/{pid}/backups, restore with /backups/{bid}/restore → {backup, project}), newest first, with the device,
 * clip and sequence counts and the date, and "back up to the studio now" (sent with this PC's name as `device`).
 * Restoring asks first; it becomes one undo step (Ctrl+Z brings the current state back), and the media still on this
 * PC keeps playing.
 */
import { clsx } from "clsx";
import { Cloud, CloudUpload, HardDrive, History, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, Modal } from "../../components/ui";
import { api } from "../../lib/api";
import { desktop, editorBridge } from "../../lib/desktop";
import { useEditorHost } from "../host";
import { useVisible } from "../moods/ui";
import { forDisk, parseProject } from "../model/serialize";
import type { EditProject } from "../model/types";
import { resolveLutUrls, resolveUrls, save } from "../session";
import { ed, exec, isDirty, project, setFocus, useProject } from "../store";

interface LocalVersion { id: string; file: string; time: string; size: number; summary?: { name: string; modified: string; sequences: number; clips: number; media: number; duration: number } }
interface ServerBackup { id: number; project_id?: number; created_at: string | null; size: number; name: string; clip_count?: number; sequence_count?: number; duration?: number; device?: string; note?: string; by?: { name?: string; email?: string } | null; deduped?: boolean }
type VersionBridge = {
  versions?(path: string): Promise<LocalVersion[]>;
  restoreVersion?(path: string, id: string): Promise<{ path: string; project: EditProject; backup: string }>;
  backupNow?(path: string, projectId: number): Promise<{ uploadedAt: string; bytes: number }>;
};
type Pending = { kind: "local"; v: LocalVersion } | { kind: "server"; b: ServerBackup };

const ago = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso), s = (Date.now() - d.getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const kb = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} kB`);

/** A restored document over the open edit: its id and studio project kept, media still here keep their runtime links. */
function merged(current: EditProject, restored: EditProject): EditProject {
  const have = new Map(current.media.map((m) => [m.id, m]));
  const media = restored.media.map((m) => {
    const h = have.get(m.id);
    return h && h.path === m.path ? { ...m, url: h.url ?? m.url, proxyUrl: h.proxyUrl ?? m.proxyUrl, thumb: h.thumb ?? m.thumb, filmstrip: h.filmstrip ?? m.filmstrip, peaks: h.peaks ?? m.peaks } : m;
  });
  const ids = new Set(restored.sequences.map((s) => s.id));
  return { ...restored, id: current.id, studioProjectId: current.studioProjectId ?? restored.studioProjectId, media,
    activeSequenceId: ids.has(restored.activeSequenceId) ? restored.activeSequenceId : restored.sequences[0]?.id ?? current.activeSequenceId };
}

/** The edit as it goes to the studio: runtime-only links left out. */
const backupDoc = (p: EditProject): EditProject => ({ ...forDisk(p), media: p.media.map((m) => { const x = { ...m }; delete x.url; delete x.proxyUrl; return x; }) });

export default function VersionsPanel() {
  const host = useEditorHost();
  const p = useProject();
  const pid = p.studioProjectId ?? null;
  const root = useRef<HTMLDivElement>(null);
  const visible = useVisible(root);
  const b = editorBridge() as unknown as VersionBridge | null;
  const path = ed().path;
  const [local, setLocal] = useState<LocalVersion[] | null>(null);
  const [remote, setRemote] = useState<ServerBackup[] | null>(null);
  const [remoteErr, setRemoteErr] = useState("");
  const [busy, setBusy] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [note, setNote] = useState("");

  const load = async () => {
    if (b?.versions && path) setLocal(await b.versions(path).catch(() => []));
    else setLocal(null);
    // the studio project as it is now (a backup may have just made it)
    const id = project().studioProjectId ?? null;
    if (id) {
      try { setRemote(await api.get<ServerBackup[]>(`/api/edits/${id}/backups`, { silent: true })); setRemoteErr(""); }
      catch (e) { setRemote(null); setRemoteErr((e as Error).message); }
    } else setRemote(null);
  };
  useEffect(() => { if (visible) void load(); }, [visible, pid, path]);

  const restore = async (x: Pending) => {
    setBusy("restore");
    try {
      let doc: unknown;
      let label = "";
      if (x.kind === "local") {
        if (!b?.restoreVersion || !path) throw new Error("Restoring needs Tatvam Desktop");
        const r = await b.restoreVersion(path, x.v.id);
        doc = r.project; label = `Restore version of ${ago(x.v.time)}`;
      } else {
        const r = await api.post<{ project: unknown }>(`/api/edits/${x.b.project_id ?? pid}/backups/${x.b.id}/restore`, {});
        doc = r.project; label = `Restore studio backup of ${ago(x.b.created_at)}`;
      }
      const { project: restored, warnings } = parseProject(doc);
      exec(label, (cur) => merged(cur, restored));
      void resolveUrls(); void resolveLutUrls();
      for (const w of warnings.slice(0, 2)) toast.warning(w);
      toast.success(`${label.replace(/^Restore /, "Restored ")} · Ctrl+Z goes back`);
      setPending(null);
      void load();
    } catch (e) { toast.error(`Restore failed: ${String((e as Error).message).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "")}`); }
    setBusy("");
  };

  /** Saves on this PC first (a .bak too), then sends the document to the studio with this PC's name. */
  const backupNow = async () => {
    setBusy("backup");
    try {
      let id = pid;
      if (!id) {
        // the edit's studio project, made the way the AI tools make it
        const load = import.meta.glob("../ai/api.ts")["../ai/api.ts"];
        const m = load ? ((await load()) as { ensureStudioProject?: (h: typeof host) => Promise<number> }) : null;
        if (!m?.ensureStudioProject) throw new Error("Studio backups need the studio connection");
        id = await m.ensureStudioProject(host);
      }
      if (b && path && isDirty()) await save();
      const fd = new FormData();
      const name = `${(project().name || "edit").replace(/[\\/:*?"<>|]/g, "_")}.tatvamedit`;
      fd.append("file", new Blob([JSON.stringify(backupDoc(project()))], { type: "application/json" }), name);
      const machine = await desktop()?.info().then((i) => i.machine ?? "").catch(() => "");
      fd.append("device", (machine || (desktop() ? "Tatvam Desktop" : "Browser")).slice(0, 120));
      if (note.trim()) fd.append("note", note.trim().slice(0, 200));
      const r = await api.post<ServerBackup>(`/api/edits/${id}/backups`, fd, { silent: true });
      toast.success(r.deduped ? "Already backed up: nothing changed since the last backup" : "Backed up on the studio");
      setNote("");
      void load();
    } catch (e) { toast.error(`Backup failed: ${(e as Error).message}`); }
    setBusy("");
  };

  const row = "pn-row items-start gap-2 py-1.5";
  return (
    <div ref={root} className="pn" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar gap-2">
        <History className="size-3.5 text-dim" /><span className="text-2xs text-dim">Versions of “{p.name}”</span>
        <button type="button" className="ed-ibtn ml-auto" title="Refresh" onClick={() => void load()}><RefreshCw className="size-3.5" /></button>
      </div>
      <div className="pn-scroll" data-versions>
        <div className="pn-section cursor-default"><HardDrive className="size-3" />On this PC{local ? <span className="mono ml-auto text-dim">{local.length}</span> : null}</div>
        {local === null && <p className="px-3 py-2 text-2xs text-dim">{b?.versions ? "Save the edit to start its backups." : "Tatvam Desktop keeps the last 10 saves of every edit (.bak copies); this build can't list them."}</p>}
        {local?.length === 0 && <p className="px-3 py-2 text-2xs text-dim">No backups yet: they're made as you save (at most one a minute).</p>}
        {local?.map((v) => (
          <div key={v.id} className={row}>
            <div className="min-w-0 flex-1">
              <p className="text-xs">{ago(v.time)} <span className="text-dim">· {new Date(v.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></p>
              <p className="text-[10px] text-dim">{v.summary ? `${v.summary.sequences} sequence${v.summary.sequences === 1 ? "" : "s"} · ${v.summary.clips} clips · ${v.summary.media} media · ${Math.round(v.summary.duration)} s` : v.file} · {kb(v.size)}</p>
            </div>
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setPending({ kind: "local", v })}>Restore</Button>
          </div>
        ))}
        <div className="pn-section mt-1 cursor-default"><Cloud className="size-3" />On the studio{remote ? <span className="mono ml-auto text-dim">{remote.length}</span> : null}</div>
        {!pid && <p className="px-3 pt-2 text-2xs text-dim">The first backup gives the edit its studio project (the one the AI tools and shared comments use).</p>}
        <div className="flex items-center gap-2 px-3 py-1.5">
          <input className="ed-field min-w-0 flex-1" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <Button size="sm" variant="secondary" loading={busy === "backup"} icon={<CloudUpload className="size-3.5" />} onClick={() => void backupNow()}>Back up now</Button>
        </div>
        {remoteErr && <p className="truncate px-3 text-[10px] text-red-300" title={remoteErr}>{remoteErr}</p>}
        {remote?.length === 0 && <p className="px-3 py-2 text-2xs text-dim">No studio backups yet.</p>}
        {remote?.map((x) => (
          <div key={x.id} className={row}>
            <div className="min-w-0 flex-1">
              <p className="text-xs">{ago(x.created_at)} <span className="text-dim">· {x.created_at ? new Date(x.created_at).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}</span></p>
              <p className="text-[10px] text-dim">{x.device || "Unknown device"}{x.by?.name ? ` · ${x.by.name}` : ""}</p>
              <p className="text-[10px] text-dim">{[x.sequence_count !== undefined ? `${x.sequence_count} sequences` : "", x.clip_count !== undefined ? `${x.clip_count} clips` : "", x.duration ? `${Math.round(x.duration)} s` : "", kb(x.size)].filter(Boolean).join(" · ")}{x.note ? ` · ${x.note}` : ""}</p>
            </div>
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setPending({ kind: "server", b: x })}>Restore</Button>
          </div>
        ))}
      </div>
      <Modal open={!!pending} onClose={() => setPending(null)} title="Restore this version?" size="sm"
        footer={<><Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
          <Button variant="primary" loading={busy === "restore"} onClick={() => pending && void restore(pending)}>Restore</Button></>}>
        <div className="space-y-2 text-sm text-mute">
          <p>The edit goes back to the {pending?.kind === "server" ? "studio backup" : "backup"} from <span className="text-ink">{pending ? ago(pending.kind === "local" ? pending.v.time : pending.b.created_at) : ""}</span>.</p>
          <p className={clsx("text-xs")}>{pending?.kind === "local" ? "The current file is kept as a backup first. " : ""}It's one step in the history: Ctrl+Z brings back what you have now.</p>
        </div>
      </Modal>
      {busy === "restore" && <div className="absolute inset-0 grid place-items-center bg-black/30"><Loader2 className="size-5 animate-spin" /></div>}
    </div>
  );
}
