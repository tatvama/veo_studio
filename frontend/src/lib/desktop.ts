/**
 * Tatvam Desktop: the typed bridge the Electron preload puts on `window.tatvamDesktop` (docs/DESKTOP.md §5), and small
 * hooks around it. In a plain browser the bridge is absent: `desktop()` returns null, every hook returns empty data and
 * nothing throws, so pages can render their web version from the same code.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

// ── types (docs/DESKTOP.md §4 and §5) ────────────────────────────────────────

export type PanelId = "program" | "source" | "timeline" | "scopes" | "mixer" | "notes" | "media" | "renders" | "bible";
export const PANEL_IDS: readonly PanelId[] = ["program", "source", "timeline", "scopes", "mixer", "notes", "media", "renders", "bible"];

export interface Workspace { id: string; name: string; builtIn: boolean; panels: { panel: PanelId; display?: number; fullscreen?: boolean }[] }

/** `settings.json` in the app's userData (§4 main/config.ts). */
export interface DesktopSettings {
  serverUrl: string;
  gatewayPort: number;
  uiSource: "bundled" | "server";
  libraryRoot: string;
  /** {project id: folder}; only projects moved to their own folder are listed. */
  projectFolders: Record<string, string>;
  /** {folder: template} (§3.1). */
  naming: Record<string, string>;
  pullScope: "approved" | "cut";
  proxyMode: boolean;
  /** Encoder preferences (e.g. a preferred hardware encoder). */
  encoder: Record<string, unknown>;
  workspaces: Workspace[];
  windowState: Record<string, unknown>;
}

export interface SyncStatus {
  pid: number;
  phase: "idle" | "manifest" | "downloading" | "renaming" | "cleaning" | "done" | "stopped" | "error" | (string & {});
  total: number; done: number; bytes: number; bytesTotal: number;
  current?: string;
  errors: string[];
  /** Synced files in the project folder after the last pass (the bridge adds it; older builds don't). */
  inFolder?: number;
}

/** The machine check (main/ffmpeg.ts). The shape is loose on purpose: the page shows whatever the check reports. */
export interface MachineReport {
  hostname?: string; os?: string; cpu?: string; cores?: number;
  ramBytes?: number;
  gpus?: { name: string; vendor?: string; vramBytes?: number; driver?: string }[];
  /** Encoders FFmpeg offers, and whether a test encode worked on this machine. */
  encoders?: { id: string; label?: string; hardware?: boolean; ok: boolean; note?: string }[];
  nvenc?: boolean;
  ffmpeg?: { path?: string; version?: string };
  disk?: { path?: string; freeBytes?: number; totalBytes?: number; kind?: string };
  displays?: { id: number; label: string; width?: number; height?: number; scaleFactor?: number; primary?: boolean }[];
  /** This PC against the baseline (RTX 3060, 32 GB RAM, NVMe SSD). */
  baseline?: { label?: string; items?: { label: string; value: string; baseline: string; ok: boolean }[] };
  verdict?: "ok" | "warn" | "bad" | (string & {});
  notes?: string[];
  checkedAt?: string;
}

/** §4.1. `hardware` names the hardware encoder used for this preset on this machine (or false for software). */
export interface RenderPreset { id: string; label: string; w: number; h: number; fps: number; codec: string; container: string; hardware?: string | boolean }

export interface RenderJob {
  id: string; pid: number; eid: number; lang: string; preset: string;
  status: "queued" | "preparing" | "downloading" | "rendering" | "uploading" | "done" | "failed" | "cancelled";
  /** 0..1 */
  progress: number;
  step: string;
  eta_s?: number;
  /** Local path of the finished file. */
  output?: string;
  error?: string;
  uploaded?: boolean;
  /** The Export row the upload created (Render Center). */
  export_id?: number;
  /** Render version of that Export, when the bridge knows it (else the page looks it up in the episode's exports). */
  version?: number;
}

export interface UpdateState {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "none" | "error" | "disabled" | (string & {});
  version?: string; progress?: number; error?: string;
}

export interface DisplayInfo { id: number; label: string; bounds: { x: number; y: number; width: number; height: number }; primary: boolean; scaleFactor: number }
export interface DesktopInfo {
  appVersion: string; serverUrl: string; gatewayUrl: string; libraryRoot: string; uiSource: string; packaged: boolean;
  /** Not in §5: the computer's name when the app reports it (used as the checkout's `machine`). */
  machine?: string;
}
export interface ImportsStatus { watching: boolean; pending: number; ingested: number; failed: string[] }
export interface FolderUsage { folders: Record<string, { files: number; bytes: number }>; freeBytes: number }
export interface OfflineStatus { online: boolean; queued: number; lastError?: string }

export interface TatvamDesktop {
  version: string; platform: string;
  info(): Promise<DesktopInfo>;
  settings: { get(): Promise<DesktopSettings>; set(patch: Partial<DesktopSettings>): Promise<DesktopSettings> };
  library: {
    chooseRoot(): Promise<string | null>;
    projectFolder(pid: number): Promise<{ path: string; exists: boolean; custom: boolean }>;
    chooseProjectFolder(pid: number): Promise<string | null>;   // pick + move existing files
    open(pid: number, sub?: string): Promise<void>;
    usage(pid: number): Promise<FolderUsage>;
    clean(pid: number, what: ("cache" | "proxies" | "renders")[]): Promise<{ removedBytes: number }>;
  };
  naming: {
    get(): Promise<Record<string, string>>; set(t: Record<string, string>): Promise<void>;
    preview(pid: number): Promise<{ from: string; to: string }[]>;   // rename plan
    tokens(): Promise<{ token: string; help: string }[]>;
  };
  sync: {
    start(pid: number, opts?: { scope?: "approved" | "cut"; episodeId?: number }): Promise<void>;
    stop(pid: number): Promise<void>;
    status(pid: number): Promise<SyncStatus>;
    onProgress(cb: (s: SyncStatus) => void): () => void;
  };
  imports: { status(pid: number): Promise<ImportsStatus>;
             setWatching(pid: number, eid: number, on: boolean): Promise<void> };
  media: { machineCheck(): Promise<MachineReport>; proxies(pid: number, on: boolean): Promise<void>;
           proxyMode(on: boolean): Promise<void> };
  render: {
    presets(): Promise<RenderPreset[]>;
    start(job: { pid: number; eid: number; lang: string; preset: string; effects?: boolean; captions?: boolean;
                 music?: boolean; upscaled?: boolean; localUpscale?: boolean; upload?: boolean }): Promise<string>;
    cancel(id: string): Promise<void>;
    list(): Promise<RenderJob[]>;
    onProgress(cb: (j: RenderJob) => void): () => void;
    reveal(id: string): Promise<void>;
    upload(id: string): Promise<void>;
  };
  edl: { write(pid: number, eid: number, lang: string): Promise<{ edl: string; fcpxml: string }> };
  windows: {
    displays(): Promise<DisplayInfo[]>;
    popOut(panel: PanelId, opts?: { pid?: number; eid?: number; display?: number; fullscreen?: boolean; clean?: boolean }): Promise<number>;
    list(): Promise<{ id: number; panel: string; display: number; fullscreen: boolean }[]>;
    moveToDisplay(windowId: number, display: number, fullscreen?: boolean): Promise<void>;
    close(windowId: number): Promise<void>;
    workspaces(): Promise<Workspace[]>;
    saveWorkspace(name: string): Promise<Workspace>;
    applyWorkspace(id: string): Promise<void>;
    deleteWorkspace(id: string): Promise<void>;
    exportWorkspaces(): Promise<string | null>; importWorkspaces(): Promise<number>;
  };
  app: { openExternal(url: string): Promise<void>; revealLogs(): Promise<void>; checkForUpdates(): Promise<UpdateState>;
         /** The native Studio server window (server address, interface, FFmpeg): the page can open it but not set those. */
         openConnection(): Promise<void>;
         onUpdate(cb: (u: UpdateState) => void): () => void; onMenu(cb: (action: string) => void): () => void };
  offline: { status(): Promise<OfflineStatus>; onChange(cb: (s: OfflineStatus) => void): () => void; flush(): Promise<void> };
}

declare global {
  interface Window { tatvamDesktop?: TatvamDesktop }
}

// ── access ───────────────────────────────────────────────────────────────────

/** The bridge, or null in a plain browser. */
export function desktop(): TatvamDesktop | null {
  return (typeof window !== "undefined" && window.tatvamDesktop) || null;
}

/** True inside the desktop app (the preload runs before any page script, so this is fixed for the page's life). */
export const isDesktop = !!desktop();

/** Deep link that opens a project (and episode) in Tatvam Desktop. */
export const desktopLink = (pid: number, eid?: number) => `tatvam://open?project=${pid}${eid ? `&episode=${eid}` : ""}`;

/** A browser pop-out of a panel (works without the desktop app, too). */
export const panelUrl = (panel: PanelId, q: { pid?: number; eid?: number; clean?: boolean } = {}) => {
  const p = new URLSearchParams();
  if (q.pid) p.set("pid", String(q.pid));
  if (q.eid) p.set("eid", String(q.eid));
  if (q.clean) p.set("clean", "1");
  const s = p.toString();
  return `/desktop/panel/${panel}${s ? `?${s}` : ""}`;
};

function message(e: unknown): string {
  if (e instanceof Error) return e.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");
  return String(e ?? "");
}

/**
 * Runs a bridge call and toasts a failure ("Sync: disk full"). Resolves to undefined when the bridge is missing or the call
 * failed, so callers can `if (r === undefined) return`.
 */
export async function dcall<T>(what: string, fn: (d: TatvamDesktop) => Promise<T>): Promise<T | undefined> {
  const d = desktop();
  if (!d) return undefined;
  try {
    return await fn(d);
  } catch (e) {
    toast.error(`${what}: ${message(e) || "failed"}`);
    return undefined;
  }
}

/** A react-query read of the bridge (cached under ["desktop", ...key]); disabled in the browser. */
export function useDesktopQuery<T>(key: unknown[], fn: (d: TatvamDesktop) => Promise<T>, opts: { enabled?: boolean; refetchInterval?: number | false; staleTime?: number } = {}) {
  return useQuery({
    queryKey: ["desktop", ...key],
    queryFn: () => {
      const d = desktop();
      if (!d) throw new Error("Tatvam Desktop is not running");
      return fn(d);
    },
    enabled: isDesktop && (opts.enabled ?? true),
    refetchInterval: opts.refetchInterval,
    staleTime: opts.staleTime ?? 5_000,
    retry: false,
  });
}

// ── hooks ────────────────────────────────────────────────────────────────────

export const useDesktopInfo = () => useDesktopQuery(["info"], (d) => d.info(), { staleTime: Infinity });
export const useDesktopSettings = () => useDesktopQuery(["settings"], (d) => d.settings.get());

/** The project's sync: the current status, then every progress event for it. */
export function useSyncStatus(pid: number): SyncStatus | null {
  const [s, setS] = useState<SyncStatus | null>(null);
  useEffect(() => {
    const d = desktop();
    if (!d || !pid) return;
    let alive = true;
    d.sync.status(pid).then((v) => { if (alive) setS(v); }).catch(() => undefined);
    let off: (() => void) | undefined;
    try { off = d.sync.onProgress((v) => { if (alive && v.pid === pid) setS(v); }); } catch { /* old bridge */ }
    return () => { alive = false; off?.(); };
  }, [pid]);
  return s;
}

/** Every local render job, kept live from the bridge's progress events. */
export function useRenderJobs(): RenderJob[] {
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  useEffect(() => {
    const d = desktop();
    if (!d) return;
    let alive = true;
    d.render.list().then((v) => { if (alive) setJobs(v ?? []); }).catch(() => undefined);
    let off: (() => void) | undefined;
    try {
      off = d.render.onProgress((j) => {
        if (!alive) return;
        setJobs((list) => (list.some((x) => x.id === j.id) ? list.map((x) => (x.id === j.id ? { ...x, ...j } : x)) : [j, ...list]));
      });
    } catch { /* old bridge */ }
    return () => { alive = false; off?.(); };
  }, []);
  return jobs;
}

/** The gateway's connection to the studio server and its queue of cut edits made offline (null in the browser). */
export function useOffline(): OfflineStatus | null {
  const [s, setS] = useState<OfflineStatus | null>(null);
  useEffect(() => {
    const d = desktop();
    if (!d) return;
    let alive = true;
    d.offline.status().then((v) => { if (alive) setS(v); }).catch(() => undefined);
    let off: (() => void) | undefined;
    try { off = d.offline.onChange((v) => { if (alive) setS(v); }); } catch { /* old bridge */ }
    return () => { alive = false; off?.(); };
  }, []);
  return s;
}

// ── formatting ───────────────────────────────────────────────────────────────

/** 1536 → "1.5 KB", 3.2e9 → "3.0 GB". */
export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function eta(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "";
  const v = Math.max(0, Math.round(s));
  const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), r = v % 60;
  const two = (x: number) => String(x).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

/** Desktop render presets as the Render Center names them (Export.preset is "desktop:<id>", docs/DESKTOP.md §4.1). */
const DESKTOP_PRESET_LABELS: Record<string, string> = {
  yt4k: "YouTube 4K", yt4k_h264: "YouTube 4K (H.264)", social4k: "Shorts / Reels 4K", master_prores: "Master ProRes 422 HQ",
  broadcast1080: "Broadcast 1080p25", review1080: "Review 1080p", av1_4k: "AV1 4K",
};

/** A render's preset label: the server preset's label, or "Desktop · YouTube 4K" for a desktop render. */
export function renderPresetLabel(preset: string, presets: Record<string, { label?: string }>): string {
  if (preset.startsWith("desktop:")) return `Desktop · ${DESKTOP_PRESET_LABELS[preset.slice(8)] ?? preset.slice(8)}`;
  return presets[preset]?.label ?? preset;
}

/** "v3" when the render has a version number (renders since the finishing room), else its id "#12". */
export const renderTag = (x: { id: number; version?: number | null }) => (x.version ? `v${x.version}` : `#${x.id}`);
