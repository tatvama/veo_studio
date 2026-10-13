/**
 * The desktop status bar (every main window): the connection (online, offline, edits waiting to be sent), which screens
 * are running (docs/DESKTOP.md §4.3), the job queue, the folder sync, the graphics card, low disk space, an AI
 * assistant at work (desktop-mcp) and the notification bell. In the editor the same items sit in its own status strip
 * (DesktopStatusSlot).
 */
import { clsx } from "clsx";
import { Bot, Cpu, HardDrive, ListChecks, MonitorCog, RefreshCw, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Progress, Tooltip } from "../components/ui";
import { bytes, desktop, eta, type GpuSummary, type JobItem } from "../lib/desktop";
import { ago, useAssistantEditing, useDisk, useJobs, useOfflineStatus, useUiStatus } from "./bridge";
import { BellButton } from "./NotificationCenter";
import { setOverlay, useShellUi } from "./state";

function Connection() {
  const o = useOfflineStatus();
  const d = desktop();
  if (!o) return null;
  const label = o.online ? (o.queued ? `Sending ${o.queued}` : "Online") : o.queued ? `Offline · ${o.queued} queued` : "Offline";
  return (
    <Tooltip side="top" content={o.online ? "Connected to the studio server" : `${o.lastError ?? "The studio server can't be reached"}. Cut edits are kept and sent when it's back.`}>
      <button type="button" className="desk-sb-item" onClick={() => void d?.offline.flush()} aria-label={`Connection: ${label}. Click to retry now`}>
        <span className={clsx("dot", !o.online && "off", o.online && o.queued > 0 && "warn")} />{label}
      </button>
    </Tooltip>
  );
}

function Screens() {
  const s = useUiStatus();
  if (!s) return null;
  const short = s.serving === "cache" ? (s.online ? `Screens ${s.build?.slice(0, 6) ?? ""}` : `Offline screens ${s.build?.slice(0, 6) ?? ""}`)
    : s.serving === "bundled" ? `Screens · app ${s.version ?? ""}` : "Screens · live";
  const tone = s.lastError || !s.originOk ? "warn" : s.serving === "cache" && s.online ? "" : "info";
  return (
    <Tooltip side="top" content={<span className="block max-w-xs">{s.label}{s.lastCheck ? ` · checked ${ago(s.lastCheck)}` : ""}{s.notice ? `. ${s.notice}` : ""}{s.lastError ? `. ${s.lastError}` : ""}{!s.originOk && s.originReason ? `. ${s.originReason}` : ""}</span>}>
      <button type="button" className="desk-sb-item" onClick={() => void desktop()?.shell?.open("settings", { section: "server" })} aria-label={`Screens: ${s.label}`}>
        {s.checking ? <RefreshCw className="size-3 animate-spin" /> : <MonitorCog className={clsx("size-3.5", tone === "warn" && "text-warn", tone === "info" && "text-info")} />}{short}
        {s.progress && s.progress.total > 0 && <span className="desk-sb-bar"><i style={{ width: `${Math.round((s.progress.done / s.progress.total) * 100)}%` }} /></span>}
      </button>
    </Tooltip>
  );
}

function Jobs() {
  const j = useJobs();
  const { overlay } = useShellUi();
  if (!j) return null;
  const active = j.running + j.queued;
  const label = active ? `${j.running} running${j.queued ? ` · ${j.queued} queued` : ""}` : "No jobs";
  return (
    <button type="button" className="desk-sb-item" aria-expanded={overlay === "jobs"} aria-label={`Job queue: ${label}`} onClick={() => setOverlay(overlay === "jobs" ? null : "jobs")}>
      <ListChecks className={clsx("size-3.5", j.error && "text-bad", active > 0 && !j.error && "text-accent-ink")} />{label}
      {j.progress !== null && <span className="desk-sb-bar"><i style={{ width: `${Math.round(j.progress * 100)}%` }} /></span>}
    </button>
  );
}

function Sync() {
  const j = useJobs();
  const s = j?.items.find((i) => i.kind === "sync");
  if (!s) return null;
  const live = ["manifest", "downloading", "renaming", "cleaning"].includes(s.status);
  return (
    <Tooltip side="top" content={s.label}>
      <span className="desk-sb-item"><RefreshCw className={clsx("size-3", live && "animate-spin", s.status === "error" && "text-bad")} />
        {live ? `Syncing ${Math.round(s.progress * 100)}%` : s.status === "error" ? "Sync failed" : "Synced"}</span>
    </Tooltip>
  );
}

function Gpu() {
  const [g, setG] = useState<GpuSummary | null>(null);
  useEffect(() => { void desktop()?.shell?.gpu().then(setG).catch(() => undefined); }, []);
  if (!g?.name) return null;
  const name = g.name.replace(/^(NVIDIA|AMD|Intel\(R\))\s+/i, "").replace(/\s*\(.*$/, "").replace(/Direct3D.*$/i, "").trim();
  const gl = g.features.webgl2 ?? g.features.webgl;
  return (
    <Tooltip side="top" content={<span className="block max-w-xs">{g.vendor ? `${g.vendor} · ` : ""}{g.name}{g.driver ? ` · driver ${g.driver}` : ""}{gl ? ` · WebGL2 ${gl.replace(/_/g, " ")}` : ""}</span>}>
      <span className="desk-sb-item"><Cpu className="size-3.5" />{name.slice(0, 28)}</span>
    </Tooltip>
  );
}

function Disk() {
  const d = useDisk();
  const low = d?.drives.filter((x) => x.low) ?? [];
  if (!low.length) return null;
  return (
    <Tooltip side="top" content={`Below ${Math.round((d?.thresholdBytes ?? 0) / 1024 ** 3)} GB free: ${low.map((x) => `${x.path} ${bytes(x.freeBytes)} free (${x.label})`).join(", ")}. Clear caches in Settings → Storage.`}>
      <button type="button" className="desk-sb-item text-warn" onClick={() => void desktop()?.shell?.open("settings", { section: "storage" })}>
        <HardDrive className="size-3.5" />Low disk {low[0].path.replace(/\\$/, "")} {bytes(low[0].freeBytes)}
      </button>
    </Tooltip>
  );
}

function Assistant() {
  const who = useAssistantEditing();
  if (!who) return null;
  return <span className="desk-sb-item text-ai" role="status"><Bot className="size-3.5" />{who} is editing</span>;
}

function Items({ compact }: { compact?: boolean }) {
  return (
    <>
      <Connection />
      <span className="desk-sb-sep" />
      <Screens />
      <span className="desk-sb-sep" />
      <Jobs />
      <Sync />
      <Assistant />
      {!compact && <span className="flex-1" />}
      <Disk />
      {!compact && <Gpu />}
      <BellButton />
    </>
  );
}

/** The bottom bar of the studio, the desktop pages and the editor's home. */
export function DesktopStatusBar() {
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--desk-status-h", "var(--desk-statusbar)");
    return () => { root.style.setProperty("--desk-status-h", "0px"); };
  }, []);
  return <footer className="desk-ui desk-statusbar" aria-label="Status bar"><Items /></footer>;
}

/** The same items inside the editor's own status strip (an additive mount in EditorApp's StatusStrip). */
export function DesktopStatusSlot() {
  if (!desktop()?.shell) return null;
  return <span className="desk-ui desk-statusbar slot"><Items compact /></span>;
}

function JobRow({ j }: { j: JobItem }) {
  const live = !["done", "failed", "cancelled", "idle", "error"].includes(j.status);
  const d = desktop();
  const cancel = j.kind === "render" && live ? () => void d?.render.cancel(j.id.replace(/^render:/, ""))
    : j.kind === "upscale" && live ? () => void d?.upscale?.cancel(j.id.replace(/^upscale:/, "")) : null;
  return (
    <li className="px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{j.label}</span>
        <span className={clsx("mono text-2xs", j.status === "failed" || j.status === "error" ? "text-red-300" : j.status === "done" ? "text-ok" : "text-dim")}>
          {live ? (j.status === "queued" ? "queued" : `${Math.round(j.progress * 100)}%${j.eta_s ? ` · ${eta(j.eta_s)} left` : ""}`) : j.status}
        </span>
        {cancel && <Tooltip content="Cancel"><button type="button" className="ed-ibtn" aria-label={`Cancel ${j.label}`} onClick={cancel}><X className="size-3.5" /></button></Tooltip>}
      </div>
      {live && <Progress value={j.progress} size="sm" indeterminate={j.status === "queued" || j.progress <= 0} className="mt-1.5" />}
      {j.error && <p className="mt-1 line-clamp-2 text-2xs text-red-300">{j.error}</p>}
    </li>
  );
}

export function JobsPanel() {
  const { overlay } = useShellUi();
  const j = useJobs();
  const panel = useRef<HTMLDivElement>(null);
  const open = overlay === "jobs";
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOverlay(null); };
    const down = (e: MouseEvent) => { const t = e.target as Element; if (!panel.current?.contains(t) && !t.closest?.("[aria-label^='Job queue']")) setOverlay(null); };
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", down, true);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("mousedown", down, true); };
  }, [open]);
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div ref={panel} key="desk-jobs" role="dialog" aria-label="Job queue"
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.16 }}
          className="desk-ui fixed bottom-[calc(var(--desk-statusbar)+6px)] left-2 z-[72] flex max-h-[min(60vh,480px)] w-[400px] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-modal">
          <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
            <ListChecks className="size-4 text-mute" /><p className="text-sm font-semibold">Job queue</p>
            <span className="flex-1" />
            {j && <span className="mono text-2xs text-dim">{j.running} running · {j.queued} queued</span>}
          </div>
          {!j || j.items.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-mute">Nothing is running. Renders, AI upscales, slow motion, transcripts, downloads and syncs show here.</div>
          ) : (
            <ul className="min-h-0 flex-1 divide-y divide-line/70 overflow-y-auto">{j.items.map((x) => <JobRow key={x.id} j={x} />)}</ul>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
