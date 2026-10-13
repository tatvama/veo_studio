/**
 * The Tatvam Editor document (docs/EDITOR.md §2). Plain JSON, saved as `<Name>.tatvamedit`.
 * All times are integer frames at the sequence's frame rate; a source position is in source frames at the media's own
 * rate. Pure types: no runtime code, so Node's type stripping runs the model tests as written.
 */

export type Fps = 23.976 | 24 | 25 | 29.97 | 30 | 50 | 59.94 | 60;

/** Keyframe / transition easing. The first four match the engine; "hold" keeps the value until the next keyframe.
 *  Additive (keyframes only, editor-motion): "bezier" shapes the segment with the keyframes' `out` / `in` handles,
 *  "bounce" / "elastic" are ease-out presets. toComposition bakes these three into per-frame keys for the engine. */
export type Easing = "linear" | "ease_in" | "ease_out" | "ease_in_out" | "hold" | "bezier" | "bounce" | "elastic";
export type BlendMode = "normal" | "add" | "multiply" | "screen" | "overlay" | "lighten" | "darken";

/** x, y = centre and w, h = size as fractions of the frame (engine FxMask). */
export interface MaskSpec { shape: "rect" | "ellipse"; x: number; y: number; w: number; h: number; rotation?: number; feather?: number; invert?: boolean }

export interface EditProject {
  format: "tatvam-edit"; version: 1; id: string; name: string; created: string; modified: string;
  bins: Bin[]; media: MediaItem[]; sequences: Sequence[]; activeSequenceId: string;
  settings: { copyMedia: boolean; proxy: "off" | "auto" | "always"; autosaveSeconds: number };
  /** The studio project that carries this edit's AI costs, budget and approvals (§8; made on first AI use). */
  studioProjectId?: number;
  /** Additive: .cube LUTs imported into this edit (bridge.editor.importLut); looks use them as "lut:<id>". */
  luts?: { id: string; name: string; path?: string; size?: number; /** runtime: its gateway URL, when the bridge fills it */ url?: string }[];
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
  /** Additive (editor-motion): magnetic timeline mode. V1 is the primary storyline: its gaps close by themselves and
   *  clips on other tracks connected to a V1 clip (`connectedTo`) ride along with it (model/magnetic.ts). */
  magnetic?: boolean;
  /** Additive (editor-motion): this sequence is a multicam source. Angle i is video track i (and audio track i),
   *  synced by `syncedBy` (model/multicam.ts). */
  multicam?: { angles: { name: string; mediaId?: string }[]; syncedBy: "audio" | "in" | "timeline" };
  /** Additive (editor-audio, docs/EDITOR.md §11): audio effects on the master (the whole mix), in order. Their
   *  keyframes are in sequence frames. */
  masterEffects?: EffectInstance[];
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
  /** Additive (editor-audio / desktop): what an audio track carries (export ducking, Essential Sound). Unset: guessed
   *  from its name. */
  role?: AudioRole;
  /** Additive (editor-audio, §11): audio effects on the track's sum, in order (keyframes in sequence frames). */
  effects?: EffectInstance[];
}

/** The Essential Sound tag of a clip or an audio track (docs/EDITOR.md §11.1). */
export type AudioRole = "dialogue" | "music" | "sfx" | "ambience";

export type ClipSource =
  | { type: "media"; mediaId: string; /** source frames */ in: number }
  | { type: "title"; text: TitleSpec }
  | { type: "color"; color: string }
  | { type: "adjustment" }
  | { type: "nested"; sequenceId: string; in: number }
  /** Additive (editor-audio, §11.1): a generated sound on an audio track (no picture). Params as
   *  editor/audiofx/registry.ts GENERATORS (keyframeable Params; the desktop also takes bare values). */
  | { type: "generate"; generator: "tone" | "noise" | "dtmf"; params: Record<string, Param<unknown>> };

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
  /** Speed ramp (editor-motion, model/remap.ts): the speed in % of `speed` (100 = the clip's speed, 0 = a freeze) as a
   *  keyframed curve over clip frames. The source advances by its integral; linked A/V halves carry the same curve. */
  timeRemap?: Param<number>;
  /** Additive (editor-motion): magnetic timeline. The V1 clip this clip is connected to, and its start minus that
   *  clip's start (frames). */
  connectedTo?: string; connectOffset?: number;
  /** Additive (editor-motion): a multicam clip (a nested clip of a `Sequence.multicam` sequence): the angle shown
   *  (0-based video track of that sequence) and the angle heard (audio track; default = `angle`). */
  multicam?: { angle: number; audioAngle?: number };
  /** Additive (editor-audio, §11.1): the Essential Sound tag (wins over its track's role). */
  role?: AudioRole;
}

export interface Keyframe<T> {
  /** clip-relative frame */ frame: number; value: T; ease: Easing;
  /** Additive (editor-motion), ease "bezier": the segment to the next keyframe is cubic-bezier(out[0], out[1], next.in[0],
   *  next.in[1]) — time and progress as fractions of the segment (progress may overshoot). Missing = straight. */
  out?: [number, number];
  /** The incoming handle of the segment from the previous keyframe (used when that keyframe's ease is "bezier"). */
  in?: [number, number];
  /** Additive (editor-motion), number pairs (position): spatial tangents of the motion path, value-space offsets leaving
   *  and arriving at this keyframe (the path between keyframes is a cubic bezier; missing = straight lines). */
  tangentOut?: number[]; tangentIn?: number[];
}
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

export interface Marker {
  id: string; frame: number; duration: number; name: string; color: string; comment?: string;
  /** Additive (editor-motion): what made the marker. "beat" markers (the AI panel's beat detection) are snap points. */
  kind?: "beat" | "chapter" | "comment" | "scene";
}

export interface TitleSpec {
  text: string; font: string; size: number; color: string; weight: number; align: "left" | "center" | "right";
  outline?: { color: string; width: number }; shadow?: { color: string; blur: number; x: number; y: number };
  background?: { color: string; padding: number; radius: number };
  /** x, y, w, h as fractions 0..1 of the frame. */
  box: [number, number, number, number];
  animIn?: "none" | "fade" | "slide_up" | "typewriter" | "pop"; animOut?: "none" | "fade" | "slide_down";
  /** Additive (editor-looks, render/title.ts): word-by-word karaoke highlight. */
  karaoke?: KaraokeSpec;
  /** Additive (editor-looks): the title template it came from (editor/templates/titles.ts). */
  template?: string;
  /** Additive (editor-looks): richer animation and decoration (render/title.ts). */
  look?: TitleLook;
  /** Additive (editor-looks): a shape, sticker or emoji drawn in the box (stickers and shapes are title clips). */
  shape?: ShapeSpec;
}

/** Karaoke captions: word times are seconds from the clip's start; `color` = words not reached yet. */
export interface KaraokeSpec { words: { start: number; end: number; text: string }[]; color: string; highlightColor: string; mode: "word" | "fill" | "bounce" }
/** Template titles: in / out / loop animation ids (render/title.ts), per letter / word / line, decoration, a sub line. */
export interface TitleLook {
  in?: string; out?: string; inDur?: number; outDur?: number; loop?: string; stagger?: "none" | "char" | "word" | "line";
  decor?: { kind: string; color: string; color2?: string; size?: number };
  gradient?: [string, string]; tracking?: number; upper?: boolean; italic?: boolean; glow?: { color: string; blur: number };
  sub?: { text: string; size: number; color: string; font?: string; weight?: number };
  /** Counts from → to over the clip; "#" in the text is replaced by the number. */
  count?: { from: number; to: number };
}
export interface ShapeSpec { kind: string; fill?: string; stroke?: string; strokeWidth?: number; radius?: number; emoji?: string; rotation?: number; direction?: "left" | "right" | "up" | "down" }

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
