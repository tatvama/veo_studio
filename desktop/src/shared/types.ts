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
  options: { effects: boolean; captions: boolean; music: boolean; upscaled: boolean; localUpscale: boolean; upload: boolean;
    /** auto: the GPU engine when the cut uses a GPU-only transition or effect, else FFmpeg. */
    engine?: RenderEngine };
  /** Which engine drew the picture. */
  engineUsed?: "gpu" | "ffmpeg";
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
  /** additive: "edit" = a Tatvam Editor sequence export (pid/eid are its studio episode's, or 0) */
  kind?: "episode" | "edit";
  /** additive (edit exports): the .tatvamedit file, the sequence and its name */
  editPath?: string;
  sequenceId?: string;
  sequenceName?: string;
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

export type RenderEngine = "auto" | "gpu" | "ffmpeg";

export interface RenderJobInput {
  pid: number; eid: number; lang: string; preset: string; effects?: boolean; captions?: boolean;
  music?: boolean; upscaled?: boolean; localUpscale?: boolean; upload?: boolean; engine?: RenderEngine;
}

/**
 * What the GPU render window gets (docs/ENGINE.md §5, docs/EDITOR.md §5). Either the full-size render plan of a studio
 * episode, or a Tatvam Editor project (media `url`s filled) with the sequence to draw. Frame `i` is at
 * t = i / fps on the plan; for a composition at t = range.in / sequence.fps + i / fps (seconds on the sequence).
 * `range` is in sequence frames, out exclusive.
 */
export type GpuRenderJob =
  | { kind: "plan"; plan: unknown; w: number; h: number; fps: number; frames: number }
  | { kind: "composition"; project: EditProject; sequenceId: string; range: { in: number; out: number }; w: number; h: number; fps: number; frames: number };

// ── Tatvam Editor document (docs/EDITOR.md §2; a copy of frontend/src/editor/model/types.ts, extras marked additive) ──

export type Easing = "linear" | "ease_in" | "ease_out" | "ease_in_out" | "hold";
export type BlendMode = "normal" | "add" | "multiply" | "screen" | "overlay" | "lighten" | "darken";
export interface MaskSpec { shape: "rect" | "ellipse"; x: number; y: number; w: number; h: number; rotation?: number; feather?: number; invert?: boolean }

export interface EditProject {
  format: "tatvam-edit"; version: 1; id: string; name: string; created: string; modified: string;
  bins: Bin[]; media: MediaItem[]; sequences: Sequence[]; activeSequenceId: string;
  settings: { copyMedia: boolean; proxy: "off" | "auto" | "always"; autosaveSeconds: number };
  studioProjectId?: number;
}
export interface Bin { id: string; name: string; parentId: string | null; color?: string }
export interface MediaItem {
  id: string; binId: string | null; name: string; kind: "video" | "audio" | "image";
  /** Absolute local path at runtime (on disk: relative to the edit folder when inside it). */
  path: string;
  /** Runtime only: the gateway URL (/__media/<id>/<name>). */
  url?: string;
  /** Length in source frames at `fps` (video: its frame rate; audio: its sample rate; images: 0). */
  duration: number; fps: number; width: number; height: number; hasAudio: boolean; audioChannels?: number;
  /** Runtime: gateway URLs; on disk: paths relative to the edit folder (Cache/<id>/thumb.jpg …). */
  thumb?: string; filmstrip?: string;
  peaks?: number[]; proxyPath?: string; missing?: boolean;
  markers: Marker[]; inPoint?: number; outPoint?: number;
  colorLabel?: string; comment?: string; offline?: boolean;
  studioKey?: string;
  /** additive: length in seconds, the audio sample rate, the proxy's gateway URL (runtime) */
  seconds?: number; sampleRate?: number; proxyUrl?: string;
}
export interface Sequence {
  id: string; name: string; width: number; height: number; fps: number; sampleRate: 48000;
  tracks: Track[]; clips: TimelineClip[]; transitions: Transition[];
  markers: Marker[]; inPoint?: number; outPoint?: number; playhead: number;
  workArea?: { zoom: number; scroll: number };
  /** additive: the studio episode this sequence was imported from (importEpisode) */
  source?: { pid: number; eid: number; lang: string; cutVersion?: number | null };
}
export interface Track {
  id: string; kind: "video" | "audio"; name: string; index: number;
  locked: boolean; hidden: boolean; muted: boolean; solo: boolean; targeted: boolean; syncLock: boolean;
  height: number; volume: number; pan: number;
}
export type ClipSource =
  | { type: "media"; mediaId: string; in: number }
  | { type: "title"; text: TitleSpec }
  | { type: "color"; color: string }
  | { type: "adjustment" }
  | { type: "nested"; sequenceId: string; in: number };
export interface Motion {
  /** Pixels in the sequence frame (centre = [width/2, height/2]). */
  position: Param<[number, number]>;
  /** Percent; 100 = fitted inside the frame. */
  scale: Param<number>;
  rotation: Param<number>;
  anchor: Param<[number, number]>;
  /** Percent 0..100. */
  opacity: Param<number>;
  blend: BlendMode; uniformScale: boolean;
}
export interface ClipAudio { gain: Param<number>; pan: Param<number>; fadeIn: number; fadeOut: number }
export interface TimelineClip {
  id: string; trackId: string; start: number; duration: number; source: ClipSource;
  speed: number; reverse: boolean; enabled: boolean; name: string; colorLabel?: string; linkId?: string;
  motion: Motion; effects: EffectInstance[]; audio?: ClipAudio; timeRemap?: Param<number>;
}
export interface Keyframe<T> { frame: number; value: T; ease: Easing }
export type Param<T> = { value: T; keyframes?: Keyframe<T>[] };
export interface EffectInstance { id: string; type: string; enabled: boolean; params: Record<string, Param<unknown>>; mask?: MaskSpec }
export interface Transition {
  id: string; trackId: string; at: number; duration: number; alignment: "center" | "start" | "end";
  /** xfade id | "gl:<name>" | "audio:constant_power" | "audio:constant_gain" */
  type: string; params?: Record<string, unknown>; easing: Easing; fromClipId?: string; toClipId?: string;
}
export interface Marker { id: string; frame: number; duration: number; name: string; color: string; comment?: string }
export interface TitleSpec {
  text: string; font: string; size: number; color: string; weight: number; align: "left" | "center" | "right";
  outline?: { color: string; width: number }; shadow?: { color: string; blur: number; x: number; y: number };
  background?: { color: string; padding: number; radius: number }; box: [number, number, number, number];
  animIn?: "none" | "fade" | "slide_up" | "typewriter" | "pop"; animOut?: "none" | "fade" | "slide_down";
}

export interface EditListEntry { path: string; name: string; modified: string; thumb?: string; /** additive */ recent?: boolean }
export interface EditPreset { width: number; height: number; fps: number }
export type AnalyzeKind = "silence" | "scenes" | "beats" | "loudness";
export interface AnalyzeOptions { noiseDb?: number; minMs?: number; threshold?: number }
export type AnalyzeResult =
  | { kind: "silence"; segments: { start: number; end: number }[]; duration: number }
  | { kind: "scenes"; cuts: number[]; duration: number }
  | { kind: "beats"; beats: number[]; bpm: number; duration: number }
  | { kind: "loudness"; lufs: number | null; lra: number | null; truePeak: number | null };
export interface ShaderEntry { id: string; name: string; kind: "transition" | "effect"; glsl: string }
export interface LutEntry { id: string; name: string; /** additive */ path?: string; url?: string; size?: number }

/** The Tatvam Editor's side of the bridge (docs/EDITOR.md §5, §8). Paths are the .tatvamedit file of the edit. */
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
  importEpisode(pid: number, eid: number, path: string): Promise<{ sequenceId: string; project: EditProject }>;
  /** Starts the export; resolves with the RenderJob id (progress on render.onProgress, job.kind "edit"). */
  export(path: string, sequenceId: string, opts: { preset: string; range: "all" | "inout"; upload?: boolean }): Promise<string>;
  importLut(path: string): Promise<LutEntry | null>;
  importShader(path: string, kind: "transition" | "effect"): Promise<{ id: string; name: string } | null>;
  /** additive: the custom shaders imported on this PC (the engine registers them at load). */
  shaders(): Promise<ShaderEntry[]>;
  analyze(path: string, mediaId: string, kind: AnalyzeKind, opts?: AnalyzeOptions): Promise<AnalyzeResult>;
  uploadAsset(path: string, mediaId: string, projectId: number): Promise<{ key: string; url: string; duration: number }>;
  importStudioAsset(path: string, key: string, name?: string): Promise<MediaItem>;
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
  /** AI upscale on this PC's graphics card (Real-ESRGAN, installed on demand); results upload as the shots' upscale takes. */
  upscale: {
    tool(): Promise<UpscaleTool>;
    install(): Promise<UpscaleTool>;
    onTool(cb: (t: UpscaleTool) => void): () => void;
    estimate(opts: { pid: number; eid: number; targetH: number; model: UpscaleModel; shotIds?: number[] }): Promise<LocalUpscaleEstimate>;
    start(opts: { pid: number; eid: number; targetH: number; model: UpscaleModel; shotIds?: number[] }): Promise<string[]>;
    list(): Promise<UpscaleJob[]>;
    cancel(id: string): Promise<void>;
    onProgress(cb: (j: UpscaleJob) => void): () => void;
  };
  /** The GPU render window's side of a desktop GPU render (only that hidden window calls these). */
  engine: {
    job(id: string): Promise<GpuRenderJob>;
    frame(id: string, index: number, yuv420: Uint8Array): Promise<void>;
    done(id: string): Promise<void>;
    fail(id: string, message: string): Promise<void>;
  };
  /** The Tatvam Editor (docs/EDITOR.md §5). */
  editor: EditorBridge;
}

// ── local AI upscale (main/aiupscale.ts) ──

/** fast: Real-ESRGAN's video model (2×/3×/4×, made for video, little flicker); best: Real-ESRGAN x4plus (most natural
 * detail, many times slower). */
export type UpscaleModel = "fast" | "best";

export interface UpscaleTool {
  installed: boolean;
  version: string;
  /** Download size of the pinned build. */
  sizeBytes: number;
  installing?: boolean;
  /** 0..1 while installing */
  progress?: number;
  error?: string;
  /** Vulkan devices Real-ESRGAN sees, and the one it uses (the dedicated card when there is one). */
  gpus?: { index: number; name: string }[];
  gpu?: { index: number; name: string } | null;
  platformSupported: boolean;
}

export type UpscaleState = "queued" | "preparing" | "extracting" | "upscaling" | "encoding" | "uploading" | "done" | "failed" | "cancelled";

export interface UpscaleJob {
  id: string; pid: number; eid: number; shotId: number; code: string; takeId: number;
  model: UpscaleModel; from: [number, number]; to: [number, number]; scale: number;
  status: UpscaleState;
  /** 0..1 */
  progress: number;
  step: string;
  frames?: number; framesDone?: number;
  /** Frames per second Real-ESRGAN is managing on this card. */
  fps?: number;
  eta_s?: number;
  elapsed_s?: number;
  error?: string;
  /** The upscale take the server made from the upload. */
  uploadedTakeId?: number;
  createdAt: string; finishedAt?: string;
}

export interface LocalUpscaleEstimate {
  items: { shotId: number; code: string; takeId: number; from: [number, number]; to: [number, number]; seconds: number; frames: number;
    scale: number; minutes: number }[];
  skipped: { shot_id: number; code: string; reason: string }[];
  totalMinutes: number;
  /** Measured on this PC (true) or the starting guess (false). */
  measured: boolean;
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
  upTool: "tatvam:upscale.tool",
  upInstall: "tatvam:upscale.install",
  upToolChange: "tatvam:upscale.toolChange",
  upEstimate: "tatvam:upscale.estimate",
  upStart: "tatvam:upscale.start",
  upList: "tatvam:upscale.list",
  upCancel: "tatvam:upscale.cancel",
  upProgress: "tatvam:upscale.progress",
  engineJob: "tatvam:engine.job",
  engineFrame: "tatvam:engine.frame",
  engineDone: "tatvam:engine.done",
  engineFail: "tatvam:engine.fail",
  editorList: "tatvam:editor.list",
  editorCreate: "tatvam:editor.create",
  editorOpen: "tatvam:editor.open",
  editorSave: "tatvam:editor.save",
  editorImportMedia: "tatvam:editor.importMedia",
  editorMediaUrl: "tatvam:editor.mediaUrl",
  editorRelink: "tatvam:editor.relink",
  editorProxy: "tatvam:editor.proxy",
  editorImportEpisode: "tatvam:editor.importEpisode",
  editorExport: "tatvam:editor.export",
  editorImportLut: "tatvam:editor.importLut",
  editorImportShader: "tatvam:editor.importShader",
  editorShaders: "tatvam:editor.shaders",
  editorAnalyze: "tatvam:editor.analyze",
  editorUploadAsset: "tatvam:editor.uploadAsset",
  editorImportStudioAsset: "tatvam:editor.importStudioAsset",
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
