/**
 * Tatvam Desktop: the typed bridge the Electron preload puts on `window.tatvamDesktop` (docs/DESKTOP.md §5), and small
 * hooks around it. In a plain browser the bridge is absent: `desktop()` returns null, every hook returns empty data and
 * nothing throws, so pages can render their web version from the same code.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { EditProject, MediaItem, TimelineClip } from "../editor/model/types";

// ── types (docs/DESKTOP.md §4 and §5) ────────────────────────────────────────

export type PanelId = "program" | "source" | "timeline" | "scopes" | "mixer" | "notes" | "media" | "renders" | "bible";
export const PANEL_IDS: readonly PanelId[] = ["program", "source", "timeline", "scopes", "mixer", "notes", "media", "renders", "bible"];

export interface Workspace { id: string; name: string; builtIn: boolean; panels: { panel: PanelId; display?: number; fullscreen?: boolean }[] }

/** `settings.json` in the app's userData (§4 main/config.ts). */
export interface DesktopSettings {
  serverUrl: string;
  gatewayPort: number;
  /** additive "auto" (docs/DESKTOP.md §4.3, the default): the server's screens with an offline copy */
  uiSource: UiSource;
  /** additive (desktop-shell) */
  appearance?: AppearanceSettings;
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

/** auto: the GPU engine when the cut uses a GPU-only transition or effect, else FFmpeg. */
export type RenderEngine = "auto" | "gpu" | "ffmpeg";

/** What the hidden GPU render window gets from the desktop (docs/ENGINE.md §5): the full-size render plan and the frame count. */
/** `bits` (absent = 8): 10 → send `readYuv420p10()` (yuv420p10le, BT.709 limited), else `readYuv420()`. */
export interface GpuRenderJob { plan: unknown; w: number; h: number; fps: number; frames: number; bits?: 8 | 10 }

export interface RenderJob {
  /** Which engine drew the picture (newer desktop builds). */
  engineUsed?: "gpu" | "ffmpeg";
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
  /** additive (desktop-shell): the update's release notes, when the updater has them */
  releaseNotes?: string;
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

/** AI upscale on this PC (Real-ESRGAN): fast = its video model, best = x4plus (most natural detail, much slower). */
export type UpscaleModel = "fast" | "best";
export interface UpscaleTool {
  installed: boolean; version: string; sizeBytes: number; installing?: boolean; progress?: number; error?: string;
  gpus?: { index: number; name: string }[]; gpu?: { index: number; name: string } | null; platformSupported: boolean;
}
export interface UpscaleJob {
  id: string; pid: number; eid: number; shotId: number; code: string; takeId: number; model: UpscaleModel;
  from: [number, number]; to: [number, number]; scale: number;
  status: "queued" | "preparing" | "extracting" | "upscaling" | "encoding" | "uploading" | "done" | "failed" | "cancelled";
  progress: number; step: string; frames?: number; framesDone?: number; fps?: number; eta_s?: number; elapsed_s?: number;
  error?: string; uploadedTakeId?: number; createdAt: string; finishedAt?: string;
}
export interface LocalUpscaleEstimate {
  items: { shotId: number; code: string; takeId: number; from: [number, number]; to: [number, number]; seconds: number; frames: number;
    scale: number; minutes: number }[];
  skipped: { shot_id: number; code: string; reason: string }[];
  totalMinutes: number;
  measured: boolean;
}

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
                 music?: boolean; upscaled?: boolean; localUpscale?: boolean; upload?: boolean; engine?: RenderEngine }): Promise<string>;
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
         onUpdate(cb: (u: UpdateState) => void): () => void; onMenu(cb: (action: string) => void): () => void;
         /** additive (docs/DESKTOP.md §4.3; missing in older desktop builds): which screens are running, and checking for new ones */
         uiStatus?(): Promise<UiStatus>; onUiStatus?(cb: (s: UiStatus) => void): () => void; checkUi?(): Promise<UiStatus>;
         /** additive (desktop-shell): the updater's state without a check, restart into the update, the installed version's notes */
         updateState?(): Promise<UpdateState>; installUpdate?(): Promise<void>; releaseNotes?(): Promise<ReleaseNotes> };
  offline: { status(): Promise<OfflineStatus>; onChange(cb: (s: OfflineStatus) => void): () => void; flush(): Promise<void> };
  /** AI upscale on this PC's graphics card; results upload as the shots' upscale takes. Missing in older desktop builds. */
  /** The hidden GPU render window's side of a desktop GPU render. Missing in older desktop builds. */
  engine?: {
    job(id: string): Promise<GpuRenderJob>;
    frame(id: string, index: number, yuv420: Uint8Array | Uint16Array): Promise<void>;
    done(id: string): Promise<void>;
    fail(id: string, message: string): Promise<void>;
  };
  upscale?: {
    tool(): Promise<UpscaleTool>;
    install(): Promise<UpscaleTool>;
    onTool(cb: (t: UpscaleTool) => void): () => void;
    estimate(opts: { pid: number; eid: number; targetH: number; model: UpscaleModel; shotIds?: number[] }): Promise<LocalUpscaleEstimate>;
    start(opts: { pid: number; eid: number; targetH: number; model: UpscaleModel; shotIds?: number[] }): Promise<string[]>;
    list(): Promise<UpscaleJob[]>;
    cancel(id: string): Promise<void>;
    onProgress(cb: (j: UpscaleJob) => void): () => void;
  };
  /** Tatvam Editor (docs/EDITOR.md §5): edit projects on this PC. Missing in older desktop builds. */
  editor?: EditorBridge;
  /** additive (desktop-shell; missing in older desktop builds): appearance of every window, applied live */
  appearance?: AppearanceBridge;
  /** additive (desktop-shell): Start / Settings / first run, the title bar menu, drops, jobs, disk, storage, crash recovery */
  shell?: ShellBridge;
  /** additive (desktop-shell): the notification centre */
  notifications?: NotificationsBridge;
  /** additive (desktop-mcp; missing in older desktop builds): AI assistants over the local MCP server, auto edit, watch folders */
  assistants?: AssistantsBridge;
}

export interface EditListEntry { path: string; name: string; modified: string; thumb?: string; /** additive */ recent?: boolean }
export interface EditPreset { width: number; height: number; fps: number }
export type AnalyzeKind = "silence" | "scenes" | "beats" | "loudness";
export interface AnalyzeOptions {
  noiseDb?: number; minMs?: number; threshold?: number;
  /** additive (wave 3, loudness): the media range to measure in seconds (out exclusive); older desktop builds measure the whole file */
  in?: number; out?: number;
}
export type AnalyzeResult =
  | { kind: "silence"; segments: { start: number; end: number }[]; duration: number }
  | { kind: "scenes"; cuts: number[]; duration: number }
  | { kind: "beats"; beats: number[]; bpm: number; duration: number }
  | { kind: "loudness"; lufs: number | null; lra: number | null; truePeak: number | null };
export interface ShaderEntry { id: string; name: string; kind: "transition" | "effect"; glsl: string }
export interface LutEntry { id: string; name: string; /** additive */ path?: string; url?: string; size?: number }

/** The Tatvam Editor's side of the bridge (docs/EDITOR.md §5, §8; same as desktop/src/shared/types.ts). Paths are the
 *  .tatvamedit file of the edit. export, importEpisode and proxy read the SAVED file: save first. */
export interface EditorBridge {
  list(): Promise<EditListEntry[]>;
  create(name: string, preset: EditPreset): Promise<{ path: string; project: EditProject }>;
  open(path?: string): Promise<{ path: string; project: EditProject } | null>;
  save(path: string, project: EditProject): Promise<{ modified: string }>;
  importMedia(path: string, files?: string[]): Promise<MediaItem[]>;
  pathsForDrop(files: File[]): string[];
  mediaUrl(path: string, file: string): Promise<string>;
  relink(path: string, mediaId: string): Promise<MediaItem | null>;
  /** Resolves when the proxy is made, with the item's proxyPath / proxyUrl set (the doc says void: the value is extra). */
  proxy(path: string, mediaId: string): Promise<MediaItem>;
  importEpisode(pid: number, eid: number, path: string): Promise<{ sequenceId: string; project: EditProject; warnings?: string[] }>;
  /** Starts the export; resolves with the RenderJob id (progress on render.onProgress, job.kind "edit"). */
  export(path: string, sequenceId: string, opts: { preset: string; range: "all" | "inout"; upload?: boolean }): Promise<string>;
  importLut(path: string): Promise<LutEntry | null>;
  importShader(path: string, kind: "transition" | "effect"): Promise<{ id: string; name: string } | null>;
  /** additive: the custom shaders imported on this PC (the engine registers them at load). */
  shaders(): Promise<ShaderEntry[]>;
  analyze(path: string, mediaId: string, kind: AnalyzeKind, opts?: AnalyzeOptions): Promise<AnalyzeResult>;
  uploadAsset(path: string, mediaId: string, projectId: number): Promise<{ key: string; url: string; duration: number }>;
  importStudioAsset(path: string, key: string, name?: string): Promise<MediaItem>;
  /**
   * additive (wave 3, desktop-tools; missing in older desktop builds): one clip's sound with its trims, speed and audio
   * effects (no gain, pan, fades, track or master effects: the preview adds those) rendered through the export's own
   * FFmpeg graph into `Cache\audio\<hash>.wav`, cached by a hash of the source, the trims and the effect parameters.
   * `clip` (optional) is the page's current copy of the clip, so unsaved effect changes preview at once. `url` is a
   * gateway /__media URL of the 48 kHz stereo float WAV.
   */
  renderAudioPreview?(path: string, sequenceId: string, clipId: string, clip?: TimelineClip): Promise<{ url: string; duration: number; cached: boolean;
    warnings: string[] }>;
  /**
   * additive (wave 3): the built-in impulse responses (reverb presets and the guitar cabinets), written on first use to
   * userData/irs and served at `/__media/irs/<preset>.wav` (48 kHz stereo float, unit energy per channel).
   */
  impulseResponses?(): Promise<{ id: string; label: string; url: string; seconds: number }[]>;
  /** additive (editor-interop, docs/EDITOR.md §12; missing in older desktop builds): Premiere Pro / Audition / EDL / OTIO interchange */
  interop?: InteropBridge;
}

// ── interchange (same as desktop/src/shared/types.ts) ──
export type InteropFormat = "premiere-xml" | "audition-xml" | "audition-stems" | "edl" | "otio" | "markers-csv" | "youtube-chapters";
export type InteropAppId = "premiere" | "audition";
export interface InteropApp { id: InteropAppId; name: string; path: string; version?: string; source: "registry" | "uninstall" | "program-files" }
export interface InteropExportResult {
  /** The file written (default: <edit folder>\Exports\Interchange\<sequence>.<ext>). */
  path: string; format: InteropFormat; warnings: string[];
  /** Files written with it: rendered generator clips, Audition stems. */
  files: string[];
  /** Studio-only media made local for the export: the edit's item `mediaId` now has this local copy. */
  pulled: { mediaId: string; item: MediaItem }[];
}
export type InteropImportResult =
  | { kind: "edit"; path: string; name: string; warnings: string[]; missing: number; sequences: number }
  /** A markers CSV: its text, for the open edit's sequence (editor/interop/markers.ts fromMarkersCsv). */
  | { kind: "markers"; name: string; text: string };
export interface InteropBridge {
  /** Writes the SAVED sequence (save first). outPath outside the edit's folder goes through a save dialog; null = cancelled. */
  exportFile(path: string, sequenceId: string, format: InteropFormat, outPath?: string): Promise<InteropExportResult | null>;
  /** No path: a file dialog. A timeline becomes a new edit (its path returned); a markers CSV comes back as text. */
  importFile(xmlPath?: string): Promise<InteropImportResult | null>;
  /** Premiere Pro and Audition on this PC (the newest of each); [] when neither is installed. */
  findApps(): Promise<InteropApp[]>;
  /** Opens an exported file in the app, or shows it in Explorer when the app isn't installed. */
  openIn(app: InteropAppId, file: string): Promise<{ opened: "app" | "folder"; app?: string; path: string }>;
}

/** The editor bridge, or null in a browser or an older desktop build. */
export const editorBridge = (): EditorBridge | null => desktop()?.editor ?? null;
/** Same, as a hook (the bridge never changes during a page's life). */
export function useEditorBridge(): EditorBridge | null {
  return editorBridge();
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

/** The local upscaler's install state, kept live while it downloads. */
export function useUpscaleTool(): UpscaleTool | null {
  const [s, setS] = useState<UpscaleTool | null>(null);
  useEffect(() => {
    const u = desktop()?.upscale;
    if (!u) return;
    let alive = true;
    u.tool().then((v) => { if (alive) setS(v); }).catch(() => undefined);
    const off = u.onTool((v) => { if (alive) setS(v); });
    return () => { alive = false; off(); };
  }, []);
  return s;
}

/** Local upscale jobs, kept live from the bridge's progress events. */
export function useUpscaleJobs(): UpscaleJob[] {
  const [jobs, setJobs] = useState<UpscaleJob[]>([]);
  useEffect(() => {
    const u = desktop()?.upscale;
    if (!u) return;
    let alive = true;
    u.list().then((v) => { if (alive) setJobs(v ?? []); }).catch(() => undefined);
    const off = u.onProgress((j) => {
      if (!alive) return;
      setJobs((list) => (list.some((x) => x.id === j.id) ? list.map((x) => (x.id === j.id ? { ...x, ...j } : x)) : [j, ...list]));
    });
    return () => { alive = false; off(); };
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
  yt4k: "YouTube 4K", yt4k_h264: "YouTube 4K (H.264)", social4k: "Shorts / Reels 4K", yt2k: "YouTube 2K", social2k: "Shorts / Reels 2K",
  master_prores: "Master ProRes 422 HQ",
  broadcast1080: "Broadcast 1080p25", review1080: "Review 1080p", av1_4k: "AV1 4K", draft720: "Draft 720p",
};

/** A render's preset label: the server preset's label, or "Desktop · YouTube 4K" for a desktop render. */
export function renderPresetLabel(preset: string, presets: Record<string, { label?: string }>): string {
  if (preset.startsWith("desktop:")) return `Desktop · ${DESKTOP_PRESET_LABELS[preset.slice(8)] ?? preset.slice(8)}`;
  return presets[preset]?.label ?? preset;
}

/** "v3" when the render has a version number (renders since the finishing room), else its id "#12". */
export const renderTag = (x: { id: number; version?: number | null }) => (x.version ? `v${x.version}` : `#${x.id}`);

// ── additive (desktop-shell, wave 3; same as desktop/src/shared/types.ts): screens, appearance, shell, notifications ──

/** Where the screens come from (docs/DESKTOP.md §4.3). */
export type UiSource = "auto" | "bundled" | "server";
export interface UiStatus {
  source: UiSource;
  /** what new windows get: a saved server build ("cache"), the copy inside the app, or the server live ("remote") */
  serving: "cache" | "bundled" | "remote";
  /** "Server build 3f2a9c, 12 Oct", "Offline copy of server build 3f2a9c", "Built into the app 3.1.0" */
  label: string;
  build?: string; builtAt?: string; version?: string;
  online: boolean; checking: boolean;
  serverBuild?: string; lastCheck?: string; lastError?: string; notice?: string;
  originOk: boolean; originReason?: string;
  progress?: { done: number; total: number };
  kept?: string[];
}
export type ThemeChoice = "dark" | "light" | "system";
export interface AppearanceSettings {
  theme: ThemeChoice;
  /** "system", "tatvam" or "#rrggbb" */
  accent: string;
  density: "comfortable" | "compact";
  /** 80..150 (%) */
  scale: number;
  reduceMotion: boolean;
  highContrast: boolean;
  material: "mica" | "acrylic" | "none";
}
export interface AppearanceState extends AppearanceSettings {
  dark: boolean; accentColor: string; systemAccent: string | null; materialSupported: boolean;
  materialInUse: "mica" | "acrylic" | "none"; titleBarHeight: number; platform: string;
}
export interface AppearanceBridge {
  get(): Promise<AppearanceState>;
  set(patch: Partial<AppearanceSettings>): Promise<AppearanceState>;
  onChange(cb: (s: AppearanceState) => void): () => void;
}
export type NotificationKind = "render" | "ai" | "sync" | "update" | "download" | "system";
export interface NotificationTarget { url?: string; settings?: string; renderId?: string; editPath?: string; reveal?: string }
export interface DesktopNotification {
  id: string; kind: NotificationKind; title: string; body?: string; tone?: "ok" | "error" | "warn" | "info"; at: string; read: boolean; target?: NotificationTarget;
}
export interface NotificationsBridge {
  list(): Promise<DesktopNotification[]>;
  onChange(cb: (list: DesktopNotification[]) => void): () => void;
  show(n: { kind: NotificationKind; title: string; body?: string; tone?: DesktopNotification["tone"]; target?: NotificationTarget }): Promise<DesktopNotification | null>;
  markRead(id?: string): Promise<void>;
  clear(): Promise<void>;
  open(id: string): Promise<void>;
}
export interface ShellPrefs {
  notifications: Record<NotificationKind, boolean> & { native: boolean };
  tray: "auto" | "always" | "off";
  keepRendering: boolean;
  autoInstallOnQuit: boolean;
  restoreWindows: boolean;
}
export interface ShellState {
  prefs: ShellPrefs; onboarded: boolean; offlineOnly: boolean; updatedFrom?: string;
  crashed?: { at: string; url?: string; panels: string[]; editPath?: string };
  appVersion: string;
}
export interface JobItem { id: string; kind: "render" | "upscale" | "editor" | "tool" | "sync"; label: string; progress: number; status: string; error?: string; eta_s?: number }
export interface JobsSummary { running: number; queued: number; items: JobItem[]; progress: number | null; error: boolean }
export interface DiskDrive { path: string; label: string; freeBytes: number; totalBytes: number; low: boolean }
export interface DiskStatus { checkedAt: string; drives: DiskDrive[]; low: boolean; thresholdBytes: number }
export interface StorageItem { id: string; label: string; path: string; bytes: number; files: number; clearable: boolean; note?: string }
export interface StorageReport { items: StorageItem[]; disk: DiskStatus }
export interface DropEntry { path: string; name: string; type: "folder" | "edit" | "media" | "timeline" | "other"; ext: string; media?: string[] }
export interface DropInfo { entries: DropEntry[] }
export interface AiToolInfo { id: string; url: string; host: string; file: string; sizeBytes: number }
export interface AiToolsInfo { sources: AiToolInfo[]; mediapipe: { installed: boolean; sizeBytes: number; files: number; source: string } }
export interface GpuSummary { name?: string; vendor?: string; driver?: string; features: Record<string, string> }
export interface ReleaseNotes { version: string; notes: string; source: "updater" | "bundled" | "none" }
export interface ShellBridge {
  state(): Promise<ShellState>;
  setPrefs(patch: Partial<ShellPrefs>): Promise<ShellState>;
  onState(cb: (s: ShellState) => void): () => void;
  finishOnboarding(opts?: { offlineOnly?: boolean }): Promise<ShellState>;
  open(page: "start" | "settings" | "welcome", opts?: { section?: string }): Promise<void>;
  popupMenu(menu: string, x: number, y: number): Promise<void>;
  dropped(files: File[]): Promise<DropInfo>;
  pickFolder(title?: string): Promise<DropEntry | null>;
  jobs(): Promise<JobsSummary>;
  onJobs(cb: (j: JobsSummary) => void): () => void;
  disk(): Promise<DiskStatus>;
  onDisk(cb: (d: DiskStatus) => void): () => void;
  storage(): Promise<StorageReport>;
  clearStorage(id: string): Promise<{ removedBytes: number }>;
  aiTools(): Promise<AiToolsInfo>;
  gpu(): Promise<GpuSummary>;
  reset(scope: "appearance" | "app" | "all"): Promise<void>;
  recover(reopen: boolean): Promise<void>;
}


// ── additive (desktop-mcp, docs/EDITOR.md §13; the same as desktop/src/shared/types.ts): AI assistants, auto edit, watch folders ──

/** read: look at edits, media, timelines and frames · edit: change edits · export: render files · spend: approve paid AI work */
export type AssistantScope = "read" | "edit" | "export" | "spend";
export const ASSISTANT_SCOPES: readonly AssistantScope[] = ["read", "edit", "export", "spend"];

/** The five auto edit styles (frontend/src/automation/autoedit). */
export type AutoEditStyle = "talking_head" | "montage" | "documentary" | "highlights" | "slideshow";

/** A watch folder (main/autowatch.ts): new files whose size held for 5 s go into the target edit with the style. */
export interface WatchFolder {
  id: string;
  folder: string;
  style: AutoEditStyle;
  /** the .tatvamedit the clips go into */
  editPath: string;
  /** "append": the new clips are cut in that style at the end of the auto edit; "rebuild": the auto edit is made again with every clip */
  mode: "append" | "rebuild";
  on: boolean;
  /** what the dialog chose (target length, format, music, captions, mood, transitions); nothing paid runs from a watch */
  options?: Record<string, unknown>;
  lastRun?: string;
  lastCount?: number;
  lastError?: string;
}

export interface AssistantsSettings {
  /** "Allow AI assistants to control Tatvam" (off by default) */
  enabled: boolean;
  /** 127.0.0.1:<port>/mcp (default 18110; TATVAM_MCP_PORT overrides it for a run) */
  port: number;
  /** folders assistants may read besides the library root (Settings → AI assistants → Folders, or "Always" on a prompt) */
  folders: string[];
  watches: WatchFolder[];
}

export interface AssistantToken {
  id: string; name: string; scopes: AssistantScope[]; created: string; lastUsed?: string;
  /** "tvd_ab12…": enough to tell tokens apart */
  hint: string;
}

export interface AssistantSession {
  id: string;
  /** the MCP app (clientInfo.name; known apps get their product name) */
  client: string;
  clientVersion?: string;
  tokenId: string; tokenName: string;
  since: string; lastCall?: string; lastTool?: string; calls: number;
  /** the edit it works on */
  edit?: string;
  /** a call is running now */
  busy: boolean;
}

export interface AssistantActivity {
  at: string; client: string; tokenName?: string; session?: string; tool: string; ok: boolean; ms?: number;
  /** one line: what it did, or why it was refused */
  summary?: string; edit?: string;
}

export interface AssistantsState {
  enabled: boolean; port: number; running: boolean;
  /** http://127.0.0.1:<port>/mcp */
  url: string;
  error?: string;
  paused: boolean;
  tokens: AssistantToken[];
  folders: string[];
  libraryRoot: string;
  sessions: AssistantSession[];
  watches: WatchFolder[];
  /** what an MCP app starts for the stdio relay: the app exe and its arguments (dev: electron.exe + the app folder) */
  command: { exe: string; args: string[] };
  /** tokens are encrypted with Windows' DPAPI (safeStorage) */
  encrypted: boolean;
}

/** "Claude Desktop wants to use D:\Shoots\Day1": Allow once (this session), Always (added to the folders) or Deny. */
export interface FolderPromptRequest { id: string; client: string; folder: string; why: string; expiresAt: string }
export type FolderAnswer = "once" | "always" | "deny";

/** A tool call the main process hands to the editor window that has the edit open (frontend/src/automation/bridge). */
export interface AssistantCall {
  id: string; tool: string; args: Record<string, unknown>;
  /** "Claude Desktop" */
  client: string;
  /** the undo label: "Assistant: <tool>" */
  label: string;
  /** the token's scopes (main checked them; the page's AI flows read "spend") */
  scopes: AssistantScope[];
}
export interface AssistantReply { ok: boolean; result?: unknown; error?: string }

export interface FolderFile { path: string; name: string; size: number; kind: "video" | "audio" | "image"; mtime: string }
export interface FolderListing { folder: string; files: FolderFile[]; skipped: number; truncated: boolean }

/** What auto edit knows about one media item (main/autoedit-analyze.ts plus editor.analyze; seconds of the media). */
export interface MediaAnalysis {
  mediaId: string; name: string; kind: "video" | "audio" | "image"; duration: number;
  hasAudio: boolean; width: number; height: number;
  silences?: { start: number; end: number }[];
  scenes?: number[];
  beats?: number[]; bpm?: number;
  loudness?: { lufs: number | null; lra: number | null; truePeak: number | null };
  black?: { start: number; end: number }[];
  freeze?: { start: number; end: number }[];
  blur?: { start: number; end: number }[];
  /** median blurdetect score (higher = softer) */
  blurScore?: number;
  clipped?: { start: number; end: number }[];
  /** RMS level (dBFS) and motion (scene score 0..1) per half second, for picking the best moments */
  energy?: number[]; motion?: number[];
  transcript?: { start: number; end: number; text: string; words?: { start: number; end: number; text: string }[] }[]; language?: string;
  /** creation_time / timecode tags, the file's modified time */
  created?: string; timecode?: string; mtime?: string;
  warnings?: string[];
}
export type AnalysisKindName = "silence" | "scenes" | "beats" | "loudness" | "quality" | "transcript";
/** A media item to analyse (its id in the edit and its file). */
export interface AnalyzeMediaRef { id: string; path: string; name: string; kind: "video" | "audio" | "image"; hasAudio: boolean; seconds?: number; width?: number; height?: number }

export interface AssistantsBridge {
  state(): Promise<AssistantsState>;
  onState(cb: (s: AssistantsState) => void): () => void;
  setEnabled(on: boolean): Promise<AssistantsState>;
  setPort(port: number): Promise<AssistantsState>;
  /** the token is shown once here, and can be copied again later from Settings (it is kept encrypted) */
  createToken(name: string, scopes: AssistantScope[]): Promise<{ token: string; info: AssistantToken }>;
  revokeToken(id: string): Promise<AssistantsState>;
  tokenValue(id: string): Promise<string>;
  /** a native folder picker; the folder is added to the list */
  addFolder(): Promise<AssistantsState>;
  removeFolder(folder: string): Promise<AssistantsState>;
  activity(limit?: number): Promise<AssistantActivity[]>;
  pause(on: boolean): Promise<AssistantsState>;
  /** end one session (or all) */
  stop(sessionId?: string): Promise<AssistantsState>;
  /** this window shows folder prompts (FolderPrompt is mounted) */
  promptHost(on: boolean): Promise<void>;
  onFolderPrompt(cb: (p: FolderPromptRequest | { id: string; closed: true }) => void): () => void;
  answerFolderPrompt(id: string, answer: FolderAnswer): Promise<void>;
  // ── auto edit (AutoEditDialog) ──
  /** a native folder picker, then its media files in series order */
  chooseFolder(): Promise<FolderListing | null>;
  /** the media files in a folder the user picked or dropped (recursive optional) */
  listFolder(folder: string, opts?: { recursive?: boolean }): Promise<FolderListing>;
  /** analysis for auto edit of media of an edit (free, on this PC); progress on onProgress */
  analyze(editPath: string, media: AnalyzeMediaRef[], kinds?: AnalysisKindName[]): Promise<MediaAnalysis[]>;
  onProgress(cb: (p: { task: string; done: number; total: number; current?: string }) => void): () => void;
  // ── watch folders ──
  /** without `folder` a native picker asks for it */
  addWatch(w: Partial<WatchFolder> & { style: AutoEditStyle; editPath: string; mode: WatchFolder["mode"] }): Promise<AssistantsState>;
  updateWatch(id: string, patch: Partial<Omit<WatchFolder, "id">>): Promise<AssistantsState>;
  removeWatch(id: string): Promise<AssistantsState>;
  // ── the editor window's side ──
  /** this window has the edit open (the bridge routes assistant tool calls here) */
  attach(path: string, info: { name: string; dirty: boolean }): Promise<void>;
  detach(path: string): Promise<void>;
  onCall(cb: (c: AssistantCall) => void): () => void;
  reply(id: string, r: AssistantReply): Promise<void>;
  /** a job the page runs for an assistant (an AI flow): progress and its end */
  jobUpdate(id: string, patch: { status?: string; progress?: number; message?: string; result?: unknown; error?: string }): Promise<void>;
}
