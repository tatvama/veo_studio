/**
 * The desktop bridge, `window.tatvamDesktop` (docs/DESKTOP.md §5).
 *
 * The frontend keeps a copy of this interface: names and shapes here must stay identical to §5.
 * Additions are allowed (marked "additive"); renames are not.
 */

export type PanelId = "program" | "source" | "timeline" | "scopes" | "mixer" | "notes" | "media" | "renders" | "bible";

export type PullScope = "approved" | "cut";

export interface Bounds { x: number; y: number; width: number; height: number }

export interface WindowStateEntry {
  bounds?: Bounds;
  /** Electron display id the window was last on. */
  displayId?: number;
  maximized?: boolean;
  fullscreen?: boolean;
}

export interface WorkspacePanel {
  panel: PanelId;
  /** Display index: 0 = primary, 1 = the next screen (left to right), … Falls back to the primary when missing. */
  display?: number;
  fullscreen?: boolean;
  clean?: boolean;
  bounds?: Bounds;
}

export interface Workspace {
  id: string;
  name: string;
  builtIn: boolean;
  /** Display index for the main window (0 = primary). */
  mainDisplay?: number;
  panels: WorkspacePanel[];
}

export type EncoderPreference = "auto" | "nvenc" | "qsv" | "amf" | "software";

export interface DesktopSettings {
  serverUrl: string;
  gatewayPort: number;
  uiSource: "bundled" | "server";
  libraryRoot: string;
  /** Project folders that were moved away from the library root: {pid: absolute path}. */
  projectFolders: Record<string, string>;
  /** Folder → file name template (§3.1). Keys: Takes, Audio, Music, Renders, Captions, Bible, Imports, Media. */
  naming: Record<string, string>;
  pullScope: PullScope;
  proxyMode: boolean;
  encoder: {
    prefer: EncoderPreference;
    /** Allow 10-bit HEVC when the probe says it works (YouTube 4K preset). */
    hevc10bit: boolean;
    /** Constant quality of the intermediate segments (lower = better). */
    intermediateCq: number;
  };
  /** An FFmpeg build to use instead of the bundled one ("" = find one). */
  ffmpegPath: string;
  workspaces: Workspace[];
  windowState: { main?: WindowStateEntry; panels: Record<string, WindowStateEntry> };
  /** Re-sync automatically on server events while a sync is active. */
  autoSync: boolean;
  /** Imports watchers to restore on start: {pid: eid}. */
  watching: Record<string, number>;
}

/** The frontend copy of these types is frontend/src/lib/desktop.ts; fields marked "additive" are extras it may ignore. */
export type SyncPhase = "idle" | "manifest" | "downloading" | "renaming" | "cleaning" | "done" | "stopped" | "error";

export interface SyncStatus {
  pid: number;
  phase: SyncPhase;
  total: number;
  done: number;
  bytes: number;
  bytesTotal: number;
  current?: string;
  errors: string[];
  /** additive: true while a sync (or the automatic re-sync it set up) is active for this project */
  active?: boolean;
  /** additive */
  scope?: PullScope;
  /** additive */
  episodeId?: number;
  /** additive: synced files in the project folder after the last pass */
  inFolder?: number;
  /** additive: files renamed into cut order / parked in Cache/_unlinked by this pass */
  renamed?: number;
  unlinked?: number;
  startedAt?: string;
  finishedAt?: string;
  folder?: string;
}

export interface MachineReport {
  hostname?: string;
  os?: string;
  cpu?: string;
  cores?: number;
  ramBytes?: number;
  gpus?: { name: string; vendor?: string; vramBytes?: number; driver?: string }[];
  /** Encoders FFmpeg offers, and whether a test encode worked on this machine. */
  encoders?: { id: string; label?: string; hardware?: boolean; ok: boolean; note?: string }[];
  nvenc?: boolean;
  ffmpeg?: { path?: string; version?: string; source?: string };
  disk?: { path?: string; freeBytes?: number; totalBytes?: number; kind?: string };
  displays?: { id: number; label: string; width?: number; height?: number; scaleFactor?: number; primary?: boolean }[];
  /** This PC against the baseline (RTX 3060, 32 GB RAM, NVMe SSD). */
  baseline?: { label?: string; items?: { label: string; value: string; baseline: string; ok: boolean }[] };
  verdict?: "ok" | "warn" | "bad";
  notes?: string[];
  checkedAt?: string;
  /** additive: one plain-English sentence */
  summary?: string;
}

export interface RenderPreset {
  id: string;
  label: string;
  /** Size for a 16:9 project (swapped for 9:16, square for 1:1) unless `orientation` is "vertical". */
  w: number;
  h: number;
  fps: number;
  codec: string;
  container: string;
  /** The hardware encoder this PC uses for it (e.g. "hevc_nvenc"), or false for a software encoder. */
  hardware?: string | false;
  /** additive */
  orientation?: "project" | "vertical";
  tenBit?: boolean;
  note?: string;
  /** additive: the encoder this PC will use, hardware or not */
  encoder?: string;
}

export type RenderState = "queued" | "preparing" | "downloading" | "rendering" | "uploading" | "done" | "failed" | "cancelled";

export interface RenderUploadState {
  state: "idle" | "uploading" | "done" | "failed";
  uploadId?: string;
  received?: number;
  size?: number;
  error?: string;
}

export interface RenderJob {
  id: string;
  pid: number;
  eid: number;
  lang: string;
  preset: string;
  status: RenderState;
  /** 0..1 (the upload's progress while uploading) */
  progress: number;
  /** What it's doing now, in words */
  step: string;
  eta_s?: number;
  /** Local path of the finished file. */
  output?: string;
  error?: string;
  uploaded?: boolean;
  /** The Export row the upload created (Render Center). */
  export_id?: number;
  /** Export.version from the upload. */
  version?: number;
  // ── additive ──
  stepId?: string;
  options: { effects: boolean; captions: boolean; music: boolean; upscaled: boolean; localUpscale: boolean; upload: boolean };
  elapsed_s?: number;
  speed?: string;
  w?: number;
  h?: number;
  fps?: number;
  encoder?: string;
  codec?: string;
  /** The v-number in the local file name. */
  localVersion?: number;
  cutVersion?: number;
  fingerprint?: string;
  duration_s?: number;
  srt?: string;
  warnings: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  upload: RenderUploadState;
}

export interface UpdateState {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "none" | "error" | "disabled";
  version?: string;
  /** 0..1 while downloading */
  progress?: number;
  error?: string;
}

export interface OfflineStatus { online: boolean; queued: number; lastError?: string }

export interface DesktopInfo {
  appVersion: string; serverUrl: string; gatewayUrl: string; libraryRoot: string; uiSource: string; packaged: boolean;
  /** additive: the computer's name (the checkout's `machine`) */
  machine?: string;
}

export interface DisplayInfo { id: number; label: string; bounds: Bounds; primary: boolean; scaleFactor: number }

export interface PanelWindowInfo { id: number; panel: string; display: number; fullscreen: boolean }

export interface ProxyStatus { pid: number; running: boolean; total: number; done: number; current: string; errors: string[] }

export interface RenderJobInput {
  pid: number; eid: number; lang: string; preset: string; effects?: boolean; captions?: boolean;
  music?: boolean; upscaled?: boolean; localUpscale?: boolean; upload?: boolean;
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
    usage(pid: number): Promise<{ folders: Record<string, { files: number; bytes: number }>; freeBytes: number }>;
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
  imports: { status(pid: number): Promise<{ watching: boolean; pending: number; ingested: number; failed: string[] }>;
             setWatching(pid: number, eid: number, on: boolean): Promise<void> };
  media: { machineCheck(): Promise<MachineReport>; proxies(pid: number, on: boolean): Promise<void>;
           proxyMode(on: boolean): Promise<void>;
           /** additive */ proxyStatus(pid: number): Promise<ProxyStatus>;
           /** additive */ onProxyProgress(cb: (s: ProxyStatus) => void): () => void };
  render: {
    presets(): Promise<RenderPreset[]>;
    start(job: RenderJobInput): Promise<string>;
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
    list(): Promise<PanelWindowInfo[]>;
    moveToDisplay(windowId: number, display: number, fullscreen?: boolean): Promise<void>;
    close(windowId: number): Promise<void>;
    workspaces(): Promise<Workspace[]>;
    saveWorkspace(name: string): Promise<Workspace>;
    applyWorkspace(id: string): Promise<void>;
    deleteWorkspace(id: string): Promise<void>;
    exportWorkspaces(): Promise<string | null>; importWorkspaces(): Promise<number>;
  };
  app: { openExternal(url: string): Promise<void>; revealLogs(): Promise<void>; checkForUpdates(): Promise<UpdateState>;
         /** Opens the native Studio server window (server address, UI source, FFmpeg): the UI can't set those itself. */
         openConnection(): Promise<void>;
         onUpdate(cb: (u: UpdateState) => void): () => void; onMenu(cb: (action: string) => void): () => void };
  offline: { status(): Promise<OfflineStatus>; onChange(cb: (s: OfflineStatus) => void): () => void; flush(): Promise<void> };
}

/** IPC channel names shared by the preload and the main process. */
export const IPC = {
  info: "tatvam:info",
  settingsGet: "tatvam:settings.get",
  settingsSet: "tatvam:settings.set",
  libChooseRoot: "tatvam:library.chooseRoot",
  libProjectFolder: "tatvam:library.projectFolder",
  libChooseProjectFolder: "tatvam:library.chooseProjectFolder",
  libOpen: "tatvam:library.open",
  libUsage: "tatvam:library.usage",
  libClean: "tatvam:library.clean",
  namingGet: "tatvam:naming.get",
  namingSet: "tatvam:naming.set",
  namingPreview: "tatvam:naming.preview",
  namingTokens: "tatvam:naming.tokens",
  syncStart: "tatvam:sync.start",
  syncStop: "tatvam:sync.stop",
  syncStatus: "tatvam:sync.status",
  syncProgress: "tatvam:sync.progress",
  importsStatus: "tatvam:imports.status",
  importsSetWatching: "tatvam:imports.setWatching",
  machineCheck: "tatvam:media.machineCheck",
  proxies: "tatvam:media.proxies",
  proxyMode: "tatvam:media.proxyMode",
  proxyStatus: "tatvam:media.proxyStatus",
  proxyProgress: "tatvam:media.proxyProgress",
  renderPresets: "tatvam:render.presets",
  renderStart: "tatvam:render.start",
  renderCancel: "tatvam:render.cancel",
  renderList: "tatvam:render.list",
  renderProgress: "tatvam:render.progress",
  renderReveal: "tatvam:render.reveal",
  renderUpload: "tatvam:render.upload",
  edlWrite: "tatvam:edl.write",
  winDisplays: "tatvam:windows.displays",
  winPopOut: "tatvam:windows.popOut",
  winList: "tatvam:windows.list",
  winMove: "tatvam:windows.moveToDisplay",
  winClose: "tatvam:windows.close",
  wsList: "tatvam:windows.workspaces",
  wsSave: "tatvam:windows.saveWorkspace",
  wsApply: "tatvam:windows.applyWorkspace",
  wsDelete: "tatvam:windows.deleteWorkspace",
  wsExport: "tatvam:windows.exportWorkspaces",
  wsImport: "tatvam:windows.importWorkspaces",
  openExternal: "tatvam:app.openExternal",
  revealLogs: "tatvam:app.revealLogs",
  checkUpdates: "tatvam:app.checkForUpdates",
  update: "tatvam:app.update",
  menu: "tatvam:app.menu",
  offlineStatus: "tatvam:offline.status",
  offlineChange: "tatvam:offline.change",
  offlineFlush: "tatvam:offline.flush",
  openConnection: "tatvam:app.openConnection",
} as const;

/** Channels of the Studio server window (main/connect.ts); they answer that window only. */
export const CONNECT_IPC = {
  get: "tatvam:connect.get",
  test: "tatvam:connect.test",
  chooseFfmpeg: "tatvam:connect.chooseFfmpeg",
  save: "tatvam:connect.save",
  close: "tatvam:connect.close",
} as const;

/** Settings the web UI may change through the bridge. The server address, UI source, FFmpeg path and folders are
 * changed only by native windows and dialogs: they decide where the session cookie goes and which program runs. */
export const RENDERER_SETTINGS = ["naming", "pullScope", "proxyMode", "encoder", "autoSync"] as const;
