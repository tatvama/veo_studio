/**
 * Factories: a new project, sequence, track and clip with every field filled, and the sequence presets. Pure.
 */
import { uid } from "./ids.ts";
import { FPS_LIST, fpsLabel, secondsToFrames } from "./time.ts";
import type {
  ClipAudio, EditProject, MediaItem, Motion, Sequence, SequencePreset, TimelineClip, TitleSpec, Track,
} from "./types.ts";

export const DEFAULT_AUTOSAVE_S = 10;
export const TRACK_H = { video: 56, audio: 48 } as const;
export const MIN_TRACK_H = 28;
export const MAX_TRACK_H = 220;
/** Default still / title / matte length (seconds). */
export const DEFAULT_STILL_S = 5;

const SIZES = [
  { id: "1080p", label: "HD 1080p", width: 1920, height: 1080 },
  { id: "4k", label: "UHD 4K", width: 3840, height: 2160 },
  { id: "vertical", label: "Vertical 9:16", width: 1080, height: 1920 },
  { id: "square", label: "Square 1:1", width: 1080, height: 1080 },
] as const;

/** Every size at every frame rate: "1080p-25" → HD 1080p · 25 fps. */
export const PRESETS: SequencePreset[] = SIZES.flatMap((s) => FPS_LIST.map((fps) => ({
  id: `${s.id}-${fps}`, label: `${s.label} · ${fpsLabel(fps)}`, width: s.width, height: s.height, fps,
})));
export const PRESET_SIZES = SIZES;
export const presetById = (id: string) => PRESETS.find((p) => p.id === id);

export const now = () => new Date().toISOString();

export function newTrack(kind: "video" | "audio", index: number, over: Partial<Track> = {}): Track {
  return {
    id: uid(kind === "video" ? "v" : "a"), kind, name: `${kind === "video" ? "V" : "A"}${index + 1}`, index,
    locked: false, hidden: false, muted: false, solo: false, targeted: index === 0, syncLock: true,
    height: TRACK_H[kind], volume: 0, pan: 0, ...over,
  };
}

export function newSequence(name: string, preset: { width: number; height: number; fps: number }, tracks = { video: 3, audio: 3 }): Sequence {
  const ts: Track[] = [];
  for (let i = 0; i < tracks.video; i++) ts.push(newTrack("video", i));
  for (let i = 0; i < tracks.audio; i++) ts.push(newTrack("audio", i));
  return {
    id: uid("s"), name, width: preset.width, height: preset.height, fps: preset.fps, sampleRate: 48000,
    tracks: ts, clips: [], transitions: [], markers: [], playhead: 0, workArea: { zoom: 0, scroll: 0 },
  };
}

export function newProject(name: string, preset: { width: number; height: number; fps: number } = PRESETS[0]): EditProject {
  const seq = newSequence("Sequence 01", preset);
  const t = now();
  return {
    format: "tatvam-edit", version: 1, id: uid("p"), name, created: t, modified: t,
    bins: [], media: [], sequences: [seq], activeSequenceId: seq.id,
    settings: { copyMedia: false, proxy: "off", autosaveSeconds: DEFAULT_AUTOSAVE_S },
  };
}

export function defaultMotion(seq: { width: number; height: number }, pic?: { width: number; height: number }): Motion {
  const w = pic?.width || seq.width, h = pic?.height || seq.height;
  return {
    position: { value: [seq.width / 2, seq.height / 2] }, scale: { value: 100 }, rotation: { value: 0 },
    anchor: { value: [w / 2, h / 2] }, opacity: { value: 100 }, blend: "normal", uniformScale: true,
  };
}

export const defaultAudio = (): ClipAudio => ({ gain: { value: 0 }, pan: { value: 0 }, fadeIn: 0, fadeOut: 0 });

export function defaultTitle(text = "Title"): TitleSpec {
  return {
    text, font: "Inter Variable", size: 96, color: "#ffffff", weight: 700, align: "center",
    shadow: { color: "#000000aa", blur: 12, x: 0, y: 4 }, box: [0.1, 0.38, 0.8, 0.24], animIn: "fade", animOut: "fade",
  };
}

/** A bare clip on a track (callers fill source / name / duration). */
export function baseClip(seq: Sequence, trackId: string, start: number, duration: number, source: TimelineClip["source"], name: string,
  pic?: { width: number; height: number }): TimelineClip {
  const track = seq.tracks.find((t) => t.id === trackId);
  const c: TimelineClip = {
    id: uid("c"), trackId, start, duration, source, speed: 1, reverse: false, enabled: true, name,
    motion: defaultMotion(seq, pic), effects: [],
  };
  if (track?.kind === "audio") c.audio = defaultAudio();
  return c;
}

/** Timeline length (sequence frames) of a media item between source in and out (images and titles: the still length). */
export function mediaSpan(m: MediaItem, seqFps: number, inPoint = m.inPoint, outPoint = m.outPoint): { in: number; frames: number } {
  if (m.kind === "image" || !(m.duration > 0)) return { in: 0, frames: secondsToFrames(DEFAULT_STILL_S, seqFps) };
  const a = Math.max(0, Math.min(inPoint ?? 0, m.duration - 1));
  const b = Math.max(a + 1, Math.min(outPoint !== undefined ? outPoint + 1 : m.duration, m.duration));
  const srcFps = m.fps > 0 ? m.fps : seqFps;
  return { in: a, frames: Math.max(1, Math.round(((b - a) * seqFps) / srcFps)) };
}

/** Clip label colours (Premiere's label set, as tokens the timeline maps to CSS). */
export const LABEL_COLORS: { id: string; label: string; css: string }[] = [
  { id: "violet", label: "Violet", css: "#8b7cf6" }, { id: "iris", label: "Iris", css: "#6f8df2" },
  { id: "caribbean", label: "Caribbean", css: "#2bb3a3" }, { id: "lavender", label: "Lavender", css: "#c08ff2" },
  { id: "cerulean", label: "Cerulean", css: "#3aa2e8" }, { id: "forest", label: "Forest", css: "#4f9d5d" },
  { id: "rose", label: "Rose", css: "#e2709a" }, { id: "mango", label: "Mango", css: "#f0a14a" },
  { id: "purple", label: "Purple", css: "#9b59d0" }, { id: "blue", label: "Blue", css: "#4169e1" },
  { id: "teal", label: "Teal", css: "#2a9d9a" }, { id: "magenta", label: "Magenta", css: "#d04fb4" },
  { id: "tan", label: "Tan", css: "#c4a57a" }, { id: "green", label: "Green", css: "#5fb760" },
  { id: "brown", label: "Brown", css: "#96705a" }, { id: "yellow", label: "Yellow", css: "#e2c541" },
];
export const MARKER_COLORS = ["#22d3ee", "#fbbf24", "#34d399", "#fb7185", "#a78bfa", "#60a5fa", "#f97316", "#e5e7eb"];
