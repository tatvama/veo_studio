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
  /** additive "auto" (the default, docs/DESKTOP.md §4.3): the server's screens with an offline copy, else the app's own */
  uiSource: UiSource;
  /** additive (desktop-shell): the user picked uiSource in the Studio server window (an unpicked old "bundled" moves to "auto") */
  uiSourceChosen?: boolean;
  /** additive (desktop-shell): theme, accent, density, scale, motion, contrast and the Windows 11 backdrop of every window */
  appearance: AppearanceSettings;
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
  /**
   * additive: automatic backups of open edits to the studio (POST /api/edits/{studioProjectId}/backups) while signed in,
   * every `minutes` (5..120, default 10), only when the edit changed since the last one and it has a studio project.
   */
  editorBackups: { auto: boolean; minutes: number };
  /** additive: folders the user added to the LUT browser (editor.addLutFolder); only these are ever listed */
  lutFolders: string[];
  /** additive (desktop-mcp, docs/EDITOR.md §13): the local MCP server for AI assistants, its folders and watch folders */
  assistants: AssistantsSettings;
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
  /** additive (edit exports): the loudness target and what the mix measured after normalising (LUFS), and the gain applied */
  loudness?: { preset: LoudnessPreset; target: number; measured?: number; gainDb: number };
}

export interface UpdateState {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "none" | "error" | "disabled";
  version?: string;
  /** 0..1 while downloading */
  progress?: number;
  error?: string;
  /** additive (desktop-shell): the update's release notes (plain text or HTML from GitHub), when the updater has them */
  releaseNotes?: string;
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
 *
 * additive `bits` (absent = 8): the frame format the encoder wants. 10 → send `engine.readYuv420p10()` when the engine has
 * it: planar 4:2:0 as a Uint16Array of W·H·1.5 samples (Y plane, then U, then V; W/2 × H/2 each), little-endian, the
 * value in the low 10 bits (FFmpeg yuv420p10le), BT.709 limited range (Y 64..940, U/V 64..960), i.e. W·H·3 bytes.
 * 8 → `readYuv420()` as before (W·H·1.5 bytes). `engine.frame()` takes either size whatever `bits` says: the first frame
 * decides the format, and every frame after it must have the same size.
 */
export type GpuRenderJob =
  | { kind: "plan"; plan: unknown; w: number; h: number; fps: number; frames: number; bits?: 8 | 10 }
  | { kind: "composition"; project: EditProject; sequenceId: string; range: { in: number; out: number }; w: number; h: number; fps: number; frames: number;
      bits?: 8 | 10;
      /** additive (News Room delivery, docs/EDITOR.md §16.11): what the window does to the edit before drawing it */
      news?: NewsGpuOptions };

/**
 * additive (News Room delivery): a news export's drawing options for the GPU render window
 * (frontend/src/editor/newsroom/delivery/window.ts applies them in this order: language, ratio, graphics only).
 * `alpha`: the frame is drawn on a transparent background and sent as RGBA8 (W·H·4 bytes, straight alpha, rows top
 * first, `engine.readRgba()`) instead of YUV.
 */
export interface NewsGpuOptions {
  alpha?: boolean;
  /** "graphics": only the News Room graphics tracks (`Track.gfxRole`); "all" (default): the whole picture. */
  only?: "graphics" | "all";
  /** With only "graphics": just these roles ("ticker", "bug" …) or clips (a loop of one ticker). */
  roles?: string[]; clipIds?: string[];
  /** The other ratio of a both-ratio edit (newsroom/companion.ts companionProject). */
  ratio?: "16:9" | "9:16" | "1:1" | "4:5";
  /** A language version: each graphic's `langs[lang]` values. */
  lang?: string;
  /** "#rrggbb" behind graphics-only pictures that aren't transparent. */
  background?: string;
}

// ── Tatvam Editor document (docs/EDITOR.md §2; a copy of frontend/src/editor/model/types.ts, extras marked additive) ──

/** additive (editor-motion): "bezier" shapes a segment with the keyframes' out / in handles; "bounce" / "elastic" are ease-out presets. */
export type Easing = "linear" | "ease_in" | "ease_out" | "ease_in_out" | "hold" | "bezier" | "bounce" | "elastic";
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
  /** additive: the video codec and bit depth from the probe (automatic proxies use them) */
  codec?: string; bitDepth?: number;
}
export interface Sequence {
  id: string; name: string; width: number; height: number; fps: number; sampleRate: 48000;
  tracks: Track[]; clips: TimelineClip[]; transitions: Transition[];
  markers: Marker[]; inPoint?: number; outPoint?: number; playhead: number;
  workArea?: { zoom: number; scroll: number };
  /** additive: the studio episode this sequence was imported from (importEpisode) */
  source?: { pid: number; eid: number; lang: string; cutVersion?: number | null };
  /** additive: audio effects on the master (the whole mix, after the buses and ducking), in order; keyframes in sequence frames */
  masterEffects?: EffectInstance[];
  /** additive (editor-motion): magnetic timeline mode (V1 is the primary storyline) */
  magnetic?: boolean;
  /** additive (editor-motion): a multicam source sequence; angle i is video track i and audio track i */
  multicam?: { angles: { name: string; mediaId?: string }[]; syncedBy: "audio" | "in" | "timeline" };
}
export interface Track {
  id: string; kind: "video" | "audio"; name: string; index: number;
  locked: boolean; hidden: boolean; muted: boolean; solo: boolean; targeted: boolean; syncLock: boolean;
  height: number; volume: number; pan: number;
  /**
   * additive: what the track carries, for the export mix's auto-ducking (music and ambience are ducked under
   * dialogue). A clip's own `role` wins over its track's. Unset: guessed from the track name (Music / BGM / Score →
   * music; Dialogue / Voice / VO / Narration / Dub → dialogue; Ambience / Amb / Room tone → ambience; SFX / FX / Foley →
   * sfx), else none (neither ducks nor is ducked).
   */
  role?: TrackRole;
  /** additive: audio effects on the track's sum (after its clips are mixed, before ducking), in order; same ids as clips. */
  effects?: EffectInstance[];
}
/** The Essential Sound tag of a clip or track (docs/EDITOR.md §11.1). */
export type AudioRole = "dialogue" | "music" | "sfx" | "ambience";
export type TrackRole = AudioRole;
/**
 * A generator clip's sound (docs/EDITOR.md §11.1; param names and defaults as frontend/src/editor/audiofx/registry.ts
 * GENERATORS), on an audio track (main/editor-audio.ts generatorSource). Each param is a `Param` (keyframeable, like
 * effect params) or a bare value (a constant). Keyframes: `level` follows them; the others use their first keyframe.
 *  - tone  {wave: "sine" | "square" | "sawtooth" | "triangle", frequency Hz 1000, sweepTo Hz 0 (0 = steady), sweep: "log" | "linear", level dB −18}
 *  - noise {color: "white" | "pink" | "brown" | "blue" | "violet" | "velvet", level dB −24, density 0.05 (velvet), seed 1}
 *  - dtmf  {digits "0123456789*#" (0-9 * # A-D, ≤ 32), tone ms 100, gap ms 60, level dB −12}
 */
export interface GeneratorSpec { generator: "tone" | "noise" | "dtmf"; params: Record<string, Param<unknown> | number | string> }
export type ClipSource =
  | { type: "media"; mediaId: string; in: number }
  | { type: "title"; text: TitleSpec }
  | { type: "color"; color: string }
  | { type: "adjustment" }
  | { type: "nested"; sequenceId: string; in: number }
  /** additive: a generated sound (tone, noise, DTMF), see GeneratorSpec */
  | ({ type: "generate" } & GeneratorSpec);
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
  /** additive: the Essential Sound tag (wins over the track's role for ducking) */
  role?: AudioRole;
  /** additive (editor-motion): magnetic timeline: the V1 clip this one is connected to, and its start minus that clip's */
  connectedTo?: string; connectOffset?: number;
  /** additive (editor-motion): a multicam clip (nested clip of a multicam sequence): the angle shown and the angle heard (default `angle`) */
  multicam?: { angle: number; audioAngle?: number };
}
export interface Keyframe<T> {
  frame: number; value: T; ease: Easing;
  /** additive (editor-motion), ease "bezier": cubic-bezier(out[0], out[1], next.in[0], next.in[1]) over the segment (fractions of its time and change) */
  out?: [number, number]; in?: [number, number];
  /** additive (editor-motion): motion-path tangents of number-pair keyframes */
  tangentOut?: number[]; tangentIn?: number[];
}
export type Param<T> = { value: T; keyframes?: Keyframe<T>[] };
/**
 * Audio effects (docs/EDITOR.md §11, §11.1) on audio clips, video clips' sound, tracks (`Track.effects`) and the master
 * (`Sequence.masterEffects`). The export maps every id to FFmpeg in main/editor-audiofx.ts, whose `AUDIO_FX` catalogue
 * lists each id's parameters (name, default, range, unit). Ids may carry the "audio:" prefix; older ids are aliases
 * ("audio:eq" = eq3, "noise_gate" = gate, "invert" = invert_polarity, "surround_reverb" = reverb). Units: dB, Hz,
 * attack / release in seconds (values above 2 read as ms), delays in ms, amounts 0..1. Keyframes on params of filters
 * that take commands are exported (asendcmd); others use their first keyframe with a warning.
 */
export type AudioEffectType =
  | "gain" | "compressor" | "multiband" | "limiter" | "gate" | "expander" | "deesser" | "auto_level" | "speech_level"
  | "tube_compressor" | "loudness_maximizer" | "mastering" | "dc_offset"
  | "eq3" | "eq_graphic" | "eq_param" | "highpass" | "lowpass" | "bandpass" | "notch" | "dehum" | "tilt" | "virtual_bass" | "exciter" | "crystalizer"
  | "denoise" | "denoise_wavelet" | "denoise_nl" | "declick" | "declip" | "dialogue_enhance" | "voice_enhance" | "trim_silence"
  | "noise_print" | "hiss_reduction" | "dereverb" | "center_extract"
  | "pitch_shift" | "time_stretch" | "chipmunk" | "deep_voice" | "robot" | "alien" | "pitch_bend"
  | "reverb" | "echo" | "stereo_widen" | "haas" | "mono" | "auto_pan" | "doppler"
  | "chorus" | "flanger" | "phaser" | "tremolo" | "vibrato" | "distortion" | "bitcrusher" | "lofi" | "telephone" | "radio" | "megaphone"
  | "walkie_talkie" | "underwater" | "next_room" | "vinyl" | "guitar_amp"
  | "channel_swap" | "left_only" | "right_only" | "invert_polarity" | "mono_to_stereo" | "delay_sync" | "silence";
export interface EffectInstance { id: string; type: string; enabled: boolean; params: Record<string, Param<unknown>>; mask?: MaskSpec }
export interface Transition {
  id: string; trackId: string; at: number; duration: number; alignment: "center" | "start" | "end";
  /** xfade id | "gl:<name>" | "audio:constant_power" | "audio:constant_gain" */
  type: string; params?: Record<string, unknown>; easing: Easing; fromClipId?: string; toClipId?: string;
}
export interface Marker { id: string; frame: number; duration: number; name: string; color: string; comment?: string;
  /** additive (editor-motion) */ kind?: "beat" | "chapter" | "comment" | "scene" }
export interface TitleSpec {
  text: string; font: string; size: number; color: string; weight: number; align: "left" | "center" | "right";
  outline?: { color: string; width: number }; shadow?: { color: string; blur: number; x: number; y: number };
  background?: { color: string; padding: number; radius: number }; box: [number, number, number, number];
  animIn?: "none" | "fade" | "slide_up" | "typewriter" | "pop"; animOut?: "none" | "fade" | "slide_down";
}

export interface EditListEntry { path: string; name: string; modified: string; thumb?: string; /** additive */ recent?: boolean }
export interface EditPreset { width: number; height: number; fps: number }
export type AnalyzeKind = "silence" | "scenes" | "beats" | "loudness" | "sync";
export interface AnalyzeOptions {
  noiseDb?: number; minMs?: number; threshold?: number;
  /** loudness: measure only [in, out) of the media (seconds, sample-accurate); default the whole file */
  in?: number; out?: number;
  /** sync: the other media item's id (required) */
  against?: string;
  /** sync: the largest offset to look for, seconds (1..60, default 60) */
  maxOffset?: number;
}
export type AnalyzeResult =
  | { kind: "silence"; segments: { start: number; end: number }[]; duration: number }
  | { kind: "scenes"; cuts: number[]; duration: number }
  | { kind: "beats"; beats: number[]; bpm: number; duration: number }
  | { kind: "loudness"; lufs: number | null; lra: number | null; truePeak: number | null }
  /**
   * sync (multicam): `offset` = the seconds on the `against` (reference) clip's clock where this media starts: the
   * same moment is at `t` in this media and at `t + offset` in `against`. To line them up, start this media `offset`
   * seconds after the reference's start (negative: before it). `confidence` is the normalised cross-correlation at the peak (0..1: above ~0.3 is a
   * clear match of the same sound); additive `margin` (0..1) is how far the peak stands above the next best one.
   */
  | { kind: "sync"; offset: number; confidence: number; margin?: number; against?: string };
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
  export(path: string, sequenceId: string, opts: EditExportOptions): Promise<string>;
  /**
   * additive: several exports in one go, queued through the same GPU export path, one RenderJob each (in order); resolves
   * with their ids. Each item may name another sequence of the edit (e.g. the 9:16 one) and the output's base name.
   */
  exportBatch(path: string, sequenceId: string, items: EditBatchItem[]): Promise<string[]>;
  importLut(path: string): Promise<LutEntry | null>;
  importShader(path: string, kind: "transition" | "effect"): Promise<{ id: string; name: string } | null>;
  /** additive: the custom shaders imported on this PC (the engine registers them at load). */
  shaders(): Promise<ShaderEntry[]>;
  analyze(path: string, mediaId: string, kind: AnalyzeKind, opts?: AnalyzeOptions): Promise<AnalyzeResult>;
  uploadAsset(path: string, mediaId: string, projectId: number): Promise<{ key: string; url: string; duration: number }>;
  importStudioAsset(path: string, key: string, name?: string): Promise<MediaItem>;

  // ── additive (wave 3, desktop-tools) ──
  /**
   * Slow motion / frame-rate conversion with RIFE on the graphics card (tools "rife"). Resolves when the new clip is in
   * the edit's Media folder, with its MediaItem (thumbnail, filmstrip, peaks; same bin as the source; not yet in the
   * saved file: add it like an import). Progress on onJob (kind "interpolate").
   */
  interpolate(path: string, mediaId: string, opts: InterpolateOptions): Promise<MediaItem>;
  /** Speech to text on this PC with whisper.cpp (tools "whisper" / "whisper-cuda" + a model). Progress on onJob (kind "transcribe"). */
  transcribeLocal(path: string, mediaId: string, opts: TranscribeOptions): Promise<LocalTranscript>;
  /** The local tool jobs (interpolate, transcribe) of this session, newest first. */
  jobs(): Promise<EditorJob[]>;
  /** Stop a queued or running job (its promise rejects with "cancelled"). */
  cancelJob(id: string): Promise<void>;
  onJob(cb: (j: EditorJob) => void): () => void;
  /** A media item changed in the background: an automatic proxy is ready (proxyPath / proxyUrl set). */
  onMediaUpdate(cb: (u: { path: string; item: MediaItem }) => void): () => void;
  /** The edit's backups (`<file>.bak.1..10`), newest first. */
  versions(path: string): Promise<EditVersion[]>;
  /** Bring a backup back: the current file is kept as a backup first. Returns the restored project (runtime form). */
  restoreVersion(path: string, id: string): Promise<{ path: string; project: EditProject; backup: string }>;
  /**
   * Upload the saved .tatvamedit to the studio now (POST /api/edits/{projectId}/backups, multipart "file").
   * `projectId` defaults to the edit's studioProjectId (an edit without one can't be backed up yet).
   */
  backupNow(path: string, projectId?: number): Promise<EditBackupResult>;
  /** Automatic studio backups of this edit (settings.editorBackups) and how the last one went. */
  backupStatus(path: string): Promise<EditBackupStatus>;
  /** The page closed this edit: automatic backups for it stop (they also stop 30 minutes after its last save). */
  close(path: string): Promise<void>;
  /**
   * One clip's sound with its trims, speed and audio effects (no gain, pan, fades, track or master effects: the preview
   * adds those) rendered through the export's own FFmpeg graph into `Cacheudio\<hash>.wav`, cached by a hash of the
   * source (path, size, time), the trims and the effect parameters. For effects WebAudio can't play the same way.
   * `clip` (optional) is the page's current copy of the clip, so unsaved effect changes preview at once; without it the
   * saved edit's clip is used. `url` is a gateway /__media URL of the 48 kHz stereo float WAV.
   */
  renderAudioPreview(path: string, sequenceId: string, clipId: string, clip?: TimelineClip): Promise<{ url: string; duration: number; cached: boolean;
    warnings: string[] }>;
  /**
   * The built-in impulse responses (reverb presets and the guitar cabinet), written on first use to userData/irs and
   * served at `/__media/irs/<preset>.wav` (48 kHz stereo 32-bit float, unit energy per channel: use a ConvolverNode with
   * normalize = false, as the export's afir runs with irnorm=-1).
   */
  impulseResponses(): Promise<{ id: string; label: string; url: string; seconds: number }[]>;
  /** additive (editor-looks): add a LUT folder with a folder picker (remembered); null when cancelled */
  addLutFolder(): Promise<LutFolder | null>;
  /** the LUT folders with their .cube / .3dl files */
  lutFolders(): Promise<LutFolder[]>;
  removeLutFolder(path: string): Promise<void>;
  /** copy a LUT from one of the LUT folders into the edit's LUTs\ folder (.3dl converted to .cube); `url` loads it in any window */
  importLutFile(editPath: string, file: string): Promise<LutEntry>;
  /**
   * additive (editor-looks): write a .cube the page made into the edit's LUTs\ folder (safe unique name, ≤ 8 MB, the
   * same content reused) and serve it: `url` = /__media/<mediaId>/<name>, loadable in every window including the export one.
   */
  writeLut(editPath: string, name: string, cubeText: string): Promise<{ mediaId: string; url: string; file: string }>;
  /** additive: JSON stored with the edit at <edit folder>/.tatvam/<name>.json (name: letters, digits, _ . -); null when there is none */
  readSidecar(editPath: string, name: string): Promise<unknown>;
  writeSidecar(editPath: string, name: string, json: unknown): Promise<{ bytes: number }>;
  /** additive (editor-interop, docs/EDITOR.md §12): Premiere Pro / Audition / EDL / OTIO / markers interchange */
  interop: InteropBridge;
}
export interface LutFolder { path: string; files: { name: string; relPath: string; size: number }[] }

// ── interchange (main/editor-interop.ts; frontend/src/editor/interop) ──

/** premiere-xml / audition-xml / audition-stems: FCP 7 XML (xmeml 4); edl: CMX 3600; otio: OpenTimelineIO JSON. */
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
  /** A markers CSV: its text, for the open edit's sequence (frontend interop/markers.ts fromMarkersCsv). */
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

/** Export loudness targets (integrated LUFS / true peak dBTP): measured, then normalised with a true-peak limiter. */
export type LoudnessPreset = "youtube" | "instagram" | "spotify" | "apple" | "ebu_r128" | "ott" | "off";
export interface DuckingOptions {
  /** dB below which the dialogue doesn't duck the music (default -30) */
  threshold?: number;
  /** compression ratio while ducking (default 8) */
  ratio?: number;
  /** ms (default 20 / 350) */
  attack?: number; release?: number;
}
export interface EditExportOptions {
  preset: string; range: "all" | "inout"; upload?: boolean;
  /** additive: default "ebu_r128" for broadcast1080, else "youtube" (−14 LUFS) */
  loudness?: LoudnessPreset;
  /** additive: duck music tracks under dialogue tracks (default true; only when both kinds exist) */
  ducking?: boolean | DuckingOptions;
  /** additive: the output's base name instead of the sequence name (`<name>_v###.<ext>`) */
  name?: string;
}
export interface EditBatchItem {
  preset: string;
  /** another sequence of the edit (default: the batch's sequenceId) */
  sequenceId?: string;
  name?: string;
  range?: "all" | "inout";
  loudness?: LoudnessPreset;
  ducking?: boolean | DuckingOptions;
  upload?: boolean;
}

export type InterpolateModel = "rife-v4.6" | "rife-v4" | "rife-v3.1" | "rife-v2.4" | "rife-anime" | "rife-UHD";
export interface InterpolateOptions {
  /** New frames per source frame: 2, 4 or 8. Without it: fps / source fps (default 2). */
  factor?: 2 | 4 | 8;
  /**
   * The new clip's frame rate (1..240). Alone: a frame-rate conversion at the same speed (24 → 60). With factor: the
   * rate the factor× frames play at (factor 4 at the source rate = a 4× slow-motion clip, 4× as long).
   * Default: source fps × factor (a smooth high-frame-rate clip at real speed: play it at 1/factor speed for slow motion).
   */
  fps?: number;
  /** Media seconds (out exclusive); default the whole clip. */
  in?: number; out?: number;
  /** default "rife-v4.6" */
  model?: InterpolateModel;
  /** Drop the sound instead of stretching it to the new length (atempo chain). */
  dropAudio?: boolean;
  /** additive: the job id to use (so the page can cancel before the first onJob event) */
  jobId?: string;
}
export interface TranscribeOptions {
  /** "auto" or a language code: hi, kn, te, ta, en … (whisper's codes) */
  language: string;
  model: "base" | "large-v3-turbo-q5";
  /** The CUDA build (default: when it is installed and an NVIDIA card is present); false = CPU. */
  cuda?: boolean;
  /** Media seconds (out exclusive); default the whole clip. Times in the result are media seconds either way. */
  in?: number; out?: number;
  /** additive: translate into English (whisper -tr) */
  translate?: boolean;
  /** additive: initial prompt (names, spellings) */
  prompt?: string;
  jobId?: string;
}
export interface TranscriptWord { start: number; end: number; text: string; /** additive: token probability 0..1 (lowest of the word) */ p?: number }
export interface TranscriptSegment { start: number; end: number; text: string; words: TranscriptWord[] }
export interface LocalTranscript {
  /** The language whisper used (detected with "auto") */
  language: string;
  segments: TranscriptSegment[];
  // additive
  model: string; device: "cuda" | "cpu";
  /** processing seconds, audio seconds, and the real-time factor (processing / audio; < 1 is faster than real time) */
  seconds: number; duration: number; rtf: number;
  warnings?: string[];
}
export type EditorJobKind = "interpolate" | "transcribe";
export type EditorJobState = "queued" | "preparing" | "extracting" | "processing" | "encoding" | "importing" | "done" | "failed" | "cancelled";
export interface EditorJob {
  id: string; kind: EditorJobKind; editPath: string; mediaId: string; name: string;
  status: EditorJobState;
  /** 0..1 */
  progress: number;
  step: string;
  eta_s?: number; elapsed_s?: number;
  /** interpolate: output frames a second on the GPU; transcribe: audio seconds per second (× real time) */
  speed?: number;
  frames?: number; framesDone?: number;
  /** e.g. "NVIDIA GeForce GTX 1660 Ti", "CUDA", "CPU" */
  device?: string;
  error?: string;
  /** interpolate, when done: the new media item's id */
  resultMediaId?: string;
  createdAt: string; finishedAt?: string;
}
export interface EditVersion {
  /** Stable for the backup's content (it survives the .bak renumbering) */
  id: string;
  /** e.g. "My-Edit.tatvamedit.bak.3" */
  file: string;
  /** when the backup was made (ISO) */
  time: string;
  /** bytes */
  size: number;
  summary: { name: string; modified: string; sequences: number; clips: number; media: number;
    /** seconds: the active sequence's length */ duration: number };
}
export interface EditBackupResult { uploadedAt: string; bytes: number; /** the server's answer */ backup: unknown }
export interface EditBackupStatus {
  auto: boolean; minutes: number; signedIn: boolean; studioProjectId: number | null;
  lastAt?: string; lastError?: string; nextAt?: string;
}

// ── local tools (main/tools.ts) ──
export type ToolId = "realesrgan" | "rife" | "whisper" | "whisper-cuda" | "whisper-model:base" | "whisper-model:large-v3-turbo-q5";
export interface ToolStatus {
  id: ToolId; label: string; installed: boolean; version: string;
  /** Download size of the pinned file */
  sizeBytes: number;
  installing: boolean;
  /** 0..1 while installing, 1 when installed */
  progress: number;
  error?: string;
  /** Windows only for now */
  platformSupported: boolean;
  /**
   * Vulkan tools (realesrgan, rife): the card they run on (the dedicated one); whisper-cuda: the NVIDIA card (null = none,
   * so transcription uses the CPU build). Absent when it isn't known yet (not installed).
   */
  gpu?: { index: number; name: string } | null;
  // additive
  kind: "program" | "model";
  license: string;
  /** one sentence on what it is for */
  note: string;
  /**
   * additive: runtime files the tool needs that aren't on this PC (whisper-cuda: cudart64_12 / cublas64_12 / cublasLt64_12,
   * which the CUDA 12.4 zip ships next to whisper-cli.exe); without them it runs on the CPU.
   */
  missing?: string[];
  /** additive (whisper-cuda): what it needs ("An NVIDIA graphics card with driver 551.61 or newer") and this PC's driver (null: no NVIDIA card) */
  requirement?: string;
  driver?: string | null;
  /** additive (whisper-cuda): installed and usable here (card, driver and runtime all there) */
  ready?: boolean;
  /** additive: an older build of this tool is installed (the CUDA 11.8 one): install to replace it */
  outdated?: boolean;
}

export interface ToolsBridge {
  status(): Promise<ToolStatus[]>;
  /** Download the pinned file, check its size and SHA-256, unpack into userData/tools; resolves when installed. */
  install(id: ToolId): Promise<ToolStatus>;
  remove(id: ToolId): Promise<ToolStatus>;
  onProgress(cb: (t: ToolStatus) => void): () => void;
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
         onUpdate(cb: (u: UpdateState) => void): () => void; onMenu(cb: (action: string) => void): () => void;
         /** additive (docs/DESKTOP.md §4.3): which screens are running, the last check and any error */
         uiStatus(): Promise<UiStatus>; onUiStatus(cb: (s: UiStatus) => void): () => void;
         /** additive: ask the server for its newest screens now */
         checkUi(): Promise<UiStatus>;
         /** additive: the updater's state without starting a check, restart into a downloaded update, the installed version's notes */
         updateState(): Promise<UpdateState>; installUpdate(): Promise<void>; releaseNotes(): Promise<ReleaseNotes> };
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
    /** 8-bit I420 (Uint8Array, W·H·1.5 bytes) or 10-bit yuv420p10le (Uint16Array, W·H·1.5 samples): see GpuRenderJob.bits */
    frame(id: string, index: number, yuv420: Uint8Array | Uint16Array): Promise<void>;
    done(id: string): Promise<void>;
    fail(id: string, message: string): Promise<void>;
  };
  /** The Tatvam Editor (docs/EDITOR.md §5). */
  editor: EditorBridge;
  /** additive: local tools installed on demand (RIFE, whisper.cpp CPU / CUDA, whisper models, Real-ESRGAN). */
  tools: ToolsBridge;
  /** additive (desktop-shell): appearance of every window, applied live through one broadcast */
  appearance: AppearanceBridge;
  /** additive (desktop-shell): start / settings / onboarding, the title bar menu, drops, jobs, disk, storage, crash recovery */
  shell: ShellBridge;
  /** additive (desktop-shell): the notification centre (native Windows toasts plus an in-app history) */
  notifications: NotificationsBridge;
  /** additive (desktop-mcp): AI assistants over the local MCP server, auto edit and watch folders (docs/EDITOR.md §13) */
  assistants: AssistantsBridge;
  /** additive (News Room, docs/EDITOR.md §16.9): look / template library, data fetch, graphics export */
  newsroom: NewsroomBridge;
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
  editorInteropExport: "tatvam:editor.interop.exportFile",
  editorInteropImport: "tatvam:editor.interop.importFile",
  editorInteropFindApps: "tatvam:editor.interop.findApps",
  editorInteropOpenIn: "tatvam:editor.interop.openIn",
  editorExportBatch: "tatvam:editor.exportBatch",
  editorInterpolate: "tatvam:editor.interpolate",
  editorTranscribeLocal: "tatvam:editor.transcribeLocal",
  editorJobs: "tatvam:editor.jobs",
  editorCancelJob: "tatvam:editor.cancelJob",
  editorJob: "tatvam:editor.job",
  editorMediaUpdate: "tatvam:editor.mediaUpdate",
  editorVersions: "tatvam:editor.versions",
  editorRestoreVersion: "tatvam:editor.restoreVersion",
  editorBackupNow: "tatvam:editor.backupNow",
  editorBackupStatus: "tatvam:editor.backupStatus",
  editorClose: "tatvam:editor.close",
  editorRenderAudioPreview: "tatvam:editor.renderAudioPreview",
  editorImpulseResponses: "tatvam:editor.impulseResponses",
  editorAddLutFolder: "tatvam:editor.addLutFolder",
  editorLutFolders: "tatvam:editor.lutFolders",
  editorRemoveLutFolder: "tatvam:editor.removeLutFolder",
  editorImportLutFile: "tatvam:editor.importLutFile",
  editorReadSidecar: "tatvam:editor.readSidecar",
  editorWriteLut: "tatvam:editor.writeLut",
  editorWriteSidecar: "tatvam:editor.writeSidecar",
  toolsStatus: "tatvam:tools.status",
  toolsInstall: "tatvam:tools.install",
  toolsRemove: "tatvam:tools.remove",
  toolsProgress: "tatvam:tools.progress",
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
export const RENDERER_SETTINGS = ["naming", "pullScope", "proxyMode", "encoder", "autoSync", "editorBackups"] as const;

// ── additive (desktop-shell, wave 3): screens from the server, appearance, the shell, notifications ──

/** Where the screens come from (docs/DESKTOP.md §4.3). */
export type UiSource = "auto" | "bundled" | "server";

export interface UiStatus {
  /** the setting */
  source: UiSource;
  /** what new windows get: a saved server build ("cache"), the copy inside the app, or the server live ("remote") */
  serving: "cache" | "bundled" | "remote";
  /** "Server build 3f2a9c, 12 Oct", "Offline copy of server build 3f2a9c", "Built into the app 3.1.0" */
  label: string;
  /** the build new windows get (the server build id, or "bundled-<hash>") */
  build?: string;
  builtAt?: string;
  version?: string;
  online: boolean;
  checking: boolean;
  /** the server's current build, from its last manifest */
  serverBuild?: string;
  lastCheck?: string;
  lastError?: string;
  /** e.g. "Update Tatvam Desktop to get the newest screens" */
  notice?: string;
  /** may screens be fetched from this server (HTTPS, loopback or a private network), and why not */
  originOk: boolean;
  originReason?: string;
  /** bytes while a new build is fetched */
  progress?: { done: number; total: number };
  /** the saved builds of this server, newest first */
  kept?: string[];
}

export type ThemeChoice = "dark" | "light" | "system";
export interface AppearanceSettings {
  theme: ThemeChoice;
  /** "system" (the Windows accent colour), "tatvam" (the brand cyan) or "#rrggbb" */
  accent: string;
  density: "comfortable" | "compact";
  /** UI scale in percent, 80..150 (each window's zoom) */
  scale: number;
  reduceMotion: boolean;
  highContrast: boolean;
  /** the Windows 11 backdrop: mica, acrylic, or none (solid) */
  material: "mica" | "acrylic" | "none";
}
export interface AppearanceState extends AppearanceSettings {
  /** the theme in use (system resolved) */
  dark: boolean;
  /** the accent in use, #rrggbb */
  accentColor: string;
  systemAccent: string | null;
  materialSupported: boolean;
  materialInUse: "mica" | "acrylic" | "none";
  /** height of the custom title bar in CSS pixels (0 when the window has the system frame) */
  titleBarHeight: number;
  platform: string;
}
export interface AppearanceBridge {
  get(): Promise<AppearanceState>;
  set(patch: Partial<AppearanceSettings>): Promise<AppearanceState>;
  onChange(cb: (s: AppearanceState) => void): () => void;
}

export type NotificationKind = "render" | "ai" | "sync" | "update" | "download" | "system";
/** What clicking a notification opens: a window and the item in it. */
export interface NotificationTarget {
  /** a gateway path the main window navigates to (e.g. /p/3/finish#renders) */
  url?: string;
  /** the Settings window at a section */
  settings?: string;
  /** a render job (its page, or the file in Explorer) */
  renderId?: string;
  /** a Tatvam Editor edit */
  editPath?: string;
  /** show this file in Explorer */
  reveal?: string;
}
export interface DesktopNotification {
  id: string; kind: NotificationKind; title: string; body?: string;
  tone?: "ok" | "error" | "warn" | "info";
  at: string; read: boolean;
  target?: NotificationTarget;
}
export interface NotificationsBridge {
  list(): Promise<DesktopNotification[]>;
  onChange(cb: (list: DesktopNotification[]) => void): () => void;
  /** a notification from a page (e.g. an AI job the studio page saw finish) */
  show(n: { kind: NotificationKind; title: string; body?: string; tone?: DesktopNotification["tone"]; target?: NotificationTarget }): Promise<DesktopNotification | null>;
  markRead(id?: string): Promise<void>;
  clear(): Promise<void>;
  /** focus the window and item it points at */
  open(id: string): Promise<void>;
}

export interface ShellPrefs {
  /** per kind: show it (native toast + centre); `native` = Windows toasts at all */
  notifications: Record<NotificationKind, boolean> & { native: boolean };
  /** the tray icon: while jobs run (default), always, or never */
  tray: "auto" | "always" | "off";
  /** closing the main window while a render runs hides it to the tray instead of quitting */
  keepRendering: boolean;
  /** install a downloaded update when the app quits */
  autoInstallOnQuit: boolean;
  /** after a crash, offer to reopen the last windows */
  restoreWindows: boolean;
}
export interface ShellState {
  prefs: ShellPrefs;
  onboarded: boolean;
  /** the user chose to work without a server (local edits only) */
  offlineOnly: boolean;
  /** the installed version was updated since the last run: show "What's new" once */
  updatedFrom?: string;
  /** the last run ended without a clean quit */
  crashed?: { at: string; url?: string; panels: string[]; editPath?: string };
  appVersion: string;
}
export interface JobItem {
  id: string; kind: "render" | "upscale" | "editor" | "tool" | "sync"; label: string;
  /** 0..1 */
  progress: number; status: string; error?: string; eta_s?: number;
}
export interface JobsSummary { running: number; queued: number; items: JobItem[]; /** overall 0..1 while something runs */ progress: number | null; error: boolean }
export interface DiskDrive { path: string; label: string; freeBytes: number; totalBytes: number; low: boolean }
export interface DiskStatus { checkedAt: string; drives: DiskDrive[]; low: boolean; thresholdBytes: number }
export interface StorageItem { id: string; label: string; path: string; bytes: number; files: number; clearable: boolean; note?: string }
export interface StorageReport { items: StorageItem[]; disk: DiskStatus }
export interface DropEntry {
  path: string; name: string;
  type: "folder" | "edit" | "media" | "timeline" | "other";
  /** lower-case extension without the dot ("" for folders) */
  ext: string;
  /** folders: the media files directly inside (video, audio, images), sorted by name */
  media?: string[];
}
export interface DropInfo { entries: DropEntry[] }
export interface AiToolInfo { id: string; url: string; host: string; file: string; sizeBytes: number }
export interface AiToolsInfo {
  /** download source of every installable tool (the pins in main/tools.ts) */
  sources: AiToolInfo[];
  /** the MediaPipe models ship with the screens (no download) */
  mediapipe: { installed: boolean; sizeBytes: number; files: number; source: string };
}
export interface GpuSummary { name?: string; vendor?: string; driver?: string; features: Record<string, string> }
export interface ReleaseNotes { version: string; notes: string; source: "updater" | "bundled" | "none" }
export interface ShellBridge {
  state(): Promise<ShellState>;
  setPrefs(patch: Partial<ShellPrefs>): Promise<ShellState>;
  onState(cb: (s: ShellState) => void): () => void;
  finishOnboarding(opts?: { offlineOnly?: boolean }): Promise<ShellState>;
  /** the launcher (main window), the Settings window at a section, or the first-run steps */
  open(page: "start" | "settings" | "welcome", opts?: { section?: string }): Promise<void>;
  /** the application menu's submenu at a point in this window (the custom title bar's menu buttons) */
  popupMenu(menu: string, x: number, y: number): Promise<void>;
  /** files dropped from Explorer: the preload turns the File objects into paths; folders list their media */
  dropped(files: File[]): Promise<DropInfo>;
  /** a native folder picker: the folder and its media */
  pickFolder(title?: string): Promise<DropEntry | null>;
  jobs(): Promise<JobsSummary>;
  onJobs(cb: (j: JobsSummary) => void): () => void;
  disk(): Promise<DiskStatus>;
  onDisk(cb: (d: DiskStatus) => void): () => void;
  storage(): Promise<StorageReport>;
  clearStorage(id: string): Promise<{ removedBytes: number }>;
  aiTools(): Promise<AiToolsInfo>;
  gpu(): Promise<GpuSummary>;
  /** appearance only, the app's own preferences (shell.json), or every setting except the server, folders and workspaces */
  reset(scope: "appearance" | "app" | "all"): Promise<void>;
  /** after "Tatvam closed unexpectedly": reopen the last windows (true) or start fresh (false) */
  recover(reopen: boolean): Promise<void>;
}

/** IPC channels of the desktop-shell groups (app.uiStatus …, appearance, shell, notifications). */
export const SHELL_IPC = {
  uiStatus: "tatvam:app.uiStatus",
  uiStatusChange: "tatvam:app.uiStatusChange",
  uiCheck: "tatvam:app.checkUi",
  updateState: "tatvam:app.updateState",
  updateInstall: "tatvam:app.installUpdate",
  releaseNotes: "tatvam:app.releaseNotes",
  appearanceGet: "tatvam:appearance.get",
  appearanceSet: "tatvam:appearance.set",
  appearanceChange: "tatvam:appearance.change",
  state: "tatvam:shell.state",
  setPrefs: "tatvam:shell.setPrefs",
  stateChange: "tatvam:shell.stateChange",
  finishOnboarding: "tatvam:shell.finishOnboarding",
  open: "tatvam:shell.open",
  popupMenu: "tatvam:shell.popupMenu",
  dropped: "tatvam:shell.dropped",
  pickFolder: "tatvam:shell.pickFolder",
  jobs: "tatvam:shell.jobs",
  jobsChange: "tatvam:shell.jobsChange",
  disk: "tatvam:shell.disk",
  diskChange: "tatvam:shell.diskChange",
  storage: "tatvam:shell.storage",
  clearStorage: "tatvam:shell.clearStorage",
  aiTools: "tatvam:shell.aiTools",
  gpu: "tatvam:shell.gpu",
  reset: "tatvam:shell.reset",
  recover: "tatvam:shell.recover",
  notifList: "tatvam:notifications.list",
  notifChange: "tatvam:notifications.change",
  notifShow: "tatvam:notifications.show",
  notifRead: "tatvam:notifications.markRead",
  notifClear: "tatvam:notifications.clear",
  notifOpen: "tatvam:notifications.open",
} as const;

// ── additive (desktop-mcp, docs/EDITOR.md §13): AI assistants over the local MCP server, auto edit, watch folders ──

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
  /** lines in media seconds; `words` (whole words, punctuation attached) lets captions follow jump cuts */
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

/** IPC channels of the assistants group (main/mcp/index.ts). */
export const ASSISTANTS_IPC = {
  state: "tatvam:assistants.state",
  stateChange: "tatvam:assistants.stateChange",
  setEnabled: "tatvam:assistants.setEnabled",
  setPort: "tatvam:assistants.setPort",
  createToken: "tatvam:assistants.createToken",
  revokeToken: "tatvam:assistants.revokeToken",
  tokenValue: "tatvam:assistants.tokenValue",
  addFolder: "tatvam:assistants.addFolder",
  removeFolder: "tatvam:assistants.removeFolder",
  activity: "tatvam:assistants.activity",
  pause: "tatvam:assistants.pause",
  stop: "tatvam:assistants.stop",
  promptHost: "tatvam:assistants.promptHost",
  folderPrompt: "tatvam:assistants.folderPrompt",
  answerFolderPrompt: "tatvam:assistants.answerFolderPrompt",
  chooseFolder: "tatvam:assistants.chooseFolder",
  listFolder: "tatvam:assistants.listFolder",
  analyze: "tatvam:assistants.analyze",
  progress: "tatvam:assistants.progress",
  addWatch: "tatvam:assistants.addWatch",
  updateWatch: "tatvam:assistants.updateWatch",
  removeWatch: "tatvam:assistants.removeWatch",
  attach: "tatvam:assistants.attach",
  detach: "tatvam:assistants.detach",
  call: "tatvam:assistants.call",
  reply: "tatvam:assistants.reply",
  jobUpdate: "tatvam:assistants.jobUpdate",
} as const;

// ── News Room (docs/EDITOR.md §16.9; main/newsroom/**) ──

export type NewsLibraryKind = "look" | "template";
export interface NewsLibraryEntry { id: string; name: string; path: string; modified: string; bytes: number }
export interface NewsFetchResult { ok: boolean; status: number; type: string; text: string; finalUrl: string; error?: string }
export interface NewsExportOptions {
  /** The saved edit (save first) and its sequence. */
  editPath: string; sequenceId: string;
  /** Sequence frames [in, out); default the whole sequence. */
  range?: { in: number; out: number };
  /** Transparent graphics: ProRes 4444, WebM VP9 with alpha, or a PNG sequence; "mp4" = an ordinary picture. */
  codec: "prores4444" | "webm_alpha" | "png" | "mp4";
  /** "graphics" = graphics tracks only on a transparent background; "all" = the whole picture. */
  only: "graphics" | "all";
  /** The other ratio of a both-ratio edit ("9:16"). */
  ratio?: "16:9" | "9:16" | "1:1" | "4:5";
  /** Language version ("hi"). */
  lang?: string;
  /** Output file or folder; none = <edit>\Exports\News\<name>. */
  outPath?: string;
  name?: string;
  // ── additive (nr-delivery, docs/EDITOR.md §16.11) ──
  /** With only "graphics": just these graphics roles ("ticker", "bug" …) or these clips (a loop of one ticker). */
  roles?: string[]; clipIds?: string[];
  /** mp4: the render preset (desktop render presets, e.g. "broadcast1080"); default by the output's size. */
  preset?: string;
  /** mp4: the loudness target (default by preset: EBU R128 for broadcast1080, else YouTube −14). */
  loudness?: LoudnessPreset;
  /** mp4: broadcast-safe picture (legal range: Y 16–235, Cb/Cr 16–240; 64–940 / 64–960 at 10 bits). */
  legal?: boolean;
  /** Graphics only into an mp4 (no alpha): this colour behind them ("#rrggbb", default black). */
  background?: string;
  /**
   * Generated sequences (batch rows, news shorts, the preview reel) added to the saved edit for this export only
   * (never saved); `sequenceId` may name one of them. They use the edit's media and templates.
   */
  sequences?: unknown[];
  /** News Room templates the generated sequences use that the saved edit doesn't have yet (by id). */
  templates?: Record<string, unknown>;
}
/**
 * The export is queued as a render job (progress on `render.onProgress`, cancel with `render.cancel(jobId)`, show it with
 * `render.reveal(jobId)`); `path` is where the file (or, for "png", the folder of frames) will be written.
 */
export interface NewsExportResult { path: string; frames: number; seconds: number; /** additive */ jobId?: string; w?: number; h?: number; fps?: number }
export interface NewsroomBridge {
  /** The user's looks and templates in <library>\News\Looks | Templates (one JSON file each). */
  libraryList(kind: NewsLibraryKind): Promise<NewsLibraryEntry[]>;
  libraryRead(kind: NewsLibraryKind, id: string): Promise<string | null>;
  libraryWrite(kind: NewsLibraryKind, id: string, json: string): Promise<{ path: string }>;
  libraryDelete(kind: NewsLibraryKind, id: string): Promise<void>;
  /** Save dialog for a .tatvamlook / .tatvamgfx file; null = cancelled. */
  exportFile(kind: NewsLibraryKind, json: string, suggestedName: string): Promise<string | null>;
  /** Open dialog for a .tatvamlook / .tatvamgfx file; null = cancelled. */
  importFile(kind: NewsLibraryKind): Promise<{ name: string; json: string } | null>;
  /** GET a web address (http/https only, at most 10 MB, 20 s) from the main process (no CORS): RSS, JSON, sheet CSV. */
  fetchText(url: string): Promise<NewsFetchResult>;
  /** Reads a local text file (CSV, JSON, XML, TXT); no path = an open dialog; null = cancelled. */
  readTextFile(path?: string): Promise<{ path: string; name: string; text: string } | null>;
  /** Renders news graphics (transparent or not, a ratio, a language) to a file. */
  exportGraphics(o: NewsExportOptions): Promise<NewsExportResult | null>;
}
/** IPC channels of the News Room group (main/newsroom/ipc.ts). */
export const NEWSROOM_IPC = {
  libraryList: "tatvam:newsroom.libraryList",
  libraryRead: "tatvam:newsroom.libraryRead",
  libraryWrite: "tatvam:newsroom.libraryWrite",
  libraryDelete: "tatvam:newsroom.libraryDelete",
  exportFile: "tatvam:newsroom.exportFile",
  importFile: "tatvam:newsroom.importFile",
  fetchText: "tatvam:newsroom.fetchText",
  readTextFile: "tatvam:newsroom.readTextFile",
  exportGraphics: "tatvam:newsroom.exportGraphics",
} as const;
