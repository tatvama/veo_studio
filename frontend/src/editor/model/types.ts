/**
 * The Tatvam Editor document (docs/EDITOR.md §2). Plain JSON, saved as `<Name>.tatvamedit`.
 * All times are integer frames at the sequence's frame rate; a source position is in source frames at the media's own
 * rate. Pure types: no runtime code, so Node's type stripping runs the model tests as written.
 */

export type Fps = 23.976 | 24 | 25 | 29.97 | 30 | 50 | 59.94 | 60;

/** Keyframe / transition easing. The first four match the engine; "hold" keeps the value until the next keyframe. */
export type Easing = "linear" | "ease_in" | "ease_out" | "ease_in_out" | "hold";
export type BlendMode = "normal" | "add" | "multiply" | "screen" | "overlay" | "lighten" | "darken";

/** x, y = centre and w, h = size as fractions of the frame (engine FxMask). */
export interface MaskSpec { shape: "rect" | "ellipse"; x: number; y: number; w: number; h: number; rotation?: number; feather?: number; invert?: boolean }

export interface EditProject {
  format: "tatvam-edit"; version: 1; id: string; name: string; created: string; modified: string;
  bins: Bin[]; media: MediaItem[]; sequences: Sequence[]; activeSequenceId: string;
  settings: { copyMedia: boolean; proxy: "off" | "auto" | "always"; autosaveSeconds: number };
  /** The studio project that carries this edit's AI costs, budget and approvals (§8; made on first AI use). */
  studioProjectId?: number;
}

export interface Bin { id: string; name: string; parentId: string | null; color?: string }

export interface MediaItem {
  id: string; binId: string | null; name: string; kind: "video" | "audio" | "image";
  /** Absolute local path at runtime (or "studio:<key>" for studio media); the bridge stores it relative on disk. */
  path: string;
  /** Runtime only: the gateway URL (/__media/<id>/<name>) the bridge fills on open / import. */
  url?: string;
  /** Length in source frames at `fps`: video at its frame rate, AUDIO at its sample rate (positions in samples),
   *  images fps 0 / duration 0 (no limit; the editor picks a still length). */
  duration: number; fps: number; width: number; height: number; hasAudio: boolean; audioChannels?: number;
  /** Runtime: gateway URLs (on disk relative; the bridge converts both ways). Filmstrip = a horizontal sprite of
   *  equally spaced frames; peaks = 0..1 values evenly spread over the media. */
  thumb?: string; filmstrip?: string; peaks?: number[]; proxyPath?: string; missing?: boolean;
  /** Source monitor marks (source frames). */
  markers: Marker[]; inPoint?: number; outPoint?: number;
  colorLabel?: string; comment?: string; offline?: boolean;
  /** Storage key of this file once uploaded to the studio for an AI tool (§8). */
  studioKey?: string;
  /** Additive (desktop): length in seconds, the audio sample rate, the proxy's gateway URL (runtime). */
  seconds?: number; sampleRate?: number; proxyUrl?: string;
}

export interface Sequence {
  id: string; name: string; width: number; height: number; fps: number; sampleRate: 48000;
  /** Video tracks V1..Vn (V1 bottom) and audio tracks A1..An. */
  tracks: Track[];
  clips: TimelineClip[];
  /** At cuts on one track (or a clip's start or end edge). */
  transitions: Transition[];
  markers: Marker[]; inPoint?: number; outPoint?: number; playhead: number;
  workArea?: { zoom: number; scroll: number };
  /** Additive (desktop): the studio episode this sequence was imported from (importEpisode). */
  source?: { pid: number; eid: number; lang: string; cutVersion?: number | null };
}

export interface Track {
  id: string; kind: "video" | "audio"; name: string;
  /** 0-based position within its kind: V1 / A1 = 0. */
  index: number;
  locked: boolean; hidden: boolean; muted: boolean; solo: boolean; targeted: boolean; syncLock: boolean;
  height: number;
  /** dB */
  volume: number;
  /** -1..1 */
  pan: number;
}

export type ClipSource =
  | { type: "media"; mediaId: string; /** source frames */ in: number }
  | { type: "title"; text: TitleSpec }
  | { type: "color"; color: string }
  | { type: "adjustment" }
  | { type: "nested"; sequenceId: string; in: number };

export interface Motion {
  /** Pixels in the sequence frame (centre = [width/2, height/2]). */
  position: Param<[number, number]>;
  /** Percent; 100 = fitted inside the frame. */
  scale: Param<number>;
  /** Degrees clockwise. */
  rotation: Param<number>;
  /** Pixels in the clip's own picture (centre = [w/2, h/2]). */
  anchor: Param<[number, number]>;
  /** Percent 0..100. */
  opacity: Param<number>;
  blend: BlendMode; uniformScale: boolean;
}

export interface ClipAudio {
  /** dB */
  gain: Param<number>;
  /** -1..1 */
  pan: Param<number>;
  /** Frames. */
  fadeIn: number; fadeOut: number;
}

export interface TimelineClip {
  id: string; trackId: string;
  /** Timeline frames. */
  start: number; duration: number;
  source: ClipSource;
  speed: number; reverse: boolean; enabled: boolean; name: string; colorLabel?: string;
  /** A/V halves of one piece of media (or clips grouped with Ctrl+G). */
  linkId?: string;
  motion: Motion;
  /** Video: in order. Audio: gain, EQ … */
  effects: EffectInstance[];
  audio?: ClipAudio;
  /** Speed ramps (later). */
  timeRemap?: Param<number>;
}

export interface Keyframe<T> { /** clip-relative frame */ frame: number; value: T; ease: Easing }
export type Param<T> = { value: T; keyframes?: Keyframe<T>[] };

export interface EffectInstance { id: string; type: string; enabled: boolean; params: Record<string, Param<unknown>>; mask?: MaskSpec }

export interface Transition {
  id: string; trackId: string;
  /** Timeline frame of the cut (or of the clip edge). */
  at: number;
  duration: number;
  alignment: "center" | "start" | "end";
  /** xfade id | "gl:<name>" | "audio:constant_power" | "audio:constant_gain" */
  type: string;
  params?: Record<string, unknown>; easing: Easing;
  fromClipId?: string; toClipId?: string;
}

export interface Marker { id: string; frame: number; duration: number; name: string; color: string; comment?: string }

export interface TitleSpec {
  text: string; font: string; size: number; color: string; weight: number; align: "left" | "center" | "right";
  outline?: { color: string; width: number }; shadow?: { color: string; blur: number; x: number; y: number };
  background?: { color: string; padding: number; radius: number };
  /** x, y, w, h as fractions 0..1 of the frame. */
  box: [number, number, number, number];
  animIn?: "none" | "fade" | "slide_up" | "typewriter" | "pop"; animOut?: "none" | "fade" | "slide_down";
}

/** Sequence presets (the editor home and New sequence). */
export interface SequencePreset { id: string; label: string; width: number; height: number; fps: number }

/**
 * How the AI tools (frontend/src/editor/ai/**) reach the editor (docs/EDITOR.md §8). The editor implements it in
 * editor/host.ts (`useEditorHost()`).
 */
export interface EditorHost {
  project(): EditProject; sequence(): Sequence; selection(): { clipIds: string[]; trackIds: string[] };
  playhead(): number; inOut(): { in?: number; out?: number };
  /** One undoable command: `mutate` edits a draft copy of the project. */
  apply(label: string, mutate: (draft: EditProject) => void): void;
  addMedia(items: MediaItem[], binName?: string): void;
  placeClip(opts: { mediaId: string; trackKind: "video" | "audio"; at: number; trackId?: string; newTrack?: boolean;
                    name?: string; duration?: number; mode?: "overwrite" | "insert" }): string;
  addTitleTrack(name: string, cues: { start: number; end: number; text: string }[], style?: Partial<TitleSpec>): void;
  path(): string; studioProjectId(): number | null; setStudioProjectId(id: number): void;
  toast(msg: string, kind?: "ok" | "warn" | "error"): void;
}
