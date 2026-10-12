/**
 * The export side's view of a sequence (docs/EDITOR.md §12): per track, the clips in time order with what each
 * exchange format needs worked out once — the file behind it, the source range in SEQUENCE frames (the unit every
 * format here writes), the constant speed (a ramp is flattened to its average), the transitions on its edges, the
 * media's markers inside the clip, and the "Tatvam: …" notes for what the formats can't hold. Pure.
 */
import type { EditProject, Marker, MediaItem, Sequence, TimelineClip, Track, Transition } from "../model/types.ts";
import {
  effectLabel, fpsExact, generatorOf, GENERATOR_LABELS, hasRamp, kindOfPath, mediaRate, rampAverage, type LabelFn, type TatvamNote,
} from "./common.ts";

export interface ExportOptions {
  /** "Tatvam: <label>" names for effects (the audio registry's labels); default: the effect id. */
  labelFor?: LabelFn;
  /** The local file of a media item; null when it isn't on this PC (default: its path unless it is "studio:…"). */
  pathFor?(m: MediaItem): string | null;
  /** Rendered generator clips (clip id → a WAV file). Without one a generator clip becomes a gap and a marker. */
  generated?: Record<string, { path: string; seconds: number }>;
  /** Audio tracks replaced by one stem each (track id → a WAV from frame 0): Send to Audition. */
  stems?: Record<string, { path: string; seconds: number; name?: string }>;
  /** Video track indexes to keep (default: all). */
  videoTracks?: number[];
  /** Audio clip fades as edge transitions (fade from / to nothing) where nothing abuts that edge (XML, EDL). */
  fadesAsTransitions?: boolean;
}

export interface XFile {
  key: string; path: string; name: string; kind: "video" | "audio" | "image";
  /** Seconds (0 = unknown / a still). */
  seconds: number;
  /** The file's frame rate (audio and stills: the sequence's). */
  fps: number;
  width: number; height: number; hasAudio: boolean; channels: number; sampleRate: number;
  media?: MediaItem;
}

export interface XNoteOut { label: string; note: TatvamNote }

export interface XItem {
  clip: TimelineClip; kind: "video" | "audio"; trackIndex: number;
  start: number; end: number;
  what: "file" | "nested" | "title" | "color" | "adjustment" | "gap";
  file?: XFile; nested?: Sequence;
  /** Lowest source position the clip shows (at its cut edges), in sequence frames of source time. */
  srcIn: number;
  /** Source length between the cuts, in sequence frames (duration × speed). */
  span: number;
  speed: number; reverse: boolean;
  /** Source length available (sequence frames; Infinity = no limit). */
  available: number;
  tin?: Transition; tout?: Transition;
  /** Clip-level things the formats have no slot for (written as "Tatvam: …" markers by XML). */
  notes: XNoteOut[];
  /** The media item's markers inside the clip, in sequence frames of source time. */
  markers: Marker[];
}

export interface XTrack { track: Track; kind: "video" | "audio"; index: number; items: XItem[]; transitions: Transition[] }
export interface XSeq { seq: Sequence; fps: number; tracks: XTrack[]; end: number; warnings: string[]; notes: { at: number; label: string; note: TatvamNote }[] }

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

export function motionIsDefault(c: TimelineClip, seq: Sequence, pic?: { width: number; height: number }): boolean {
  const m = c.motion;
  if (!m) return true;
  const w = pic?.width || seq.width, h = pic?.height || seq.height;
  const plain = (p: { keyframes?: unknown[] } | undefined) => !p?.keyframes?.length;
  return plain(m.position) && plain(m.scale) && plain(m.rotation) && plain(m.anchor)
    && near(m.position.value[0], seq.width / 2) && near(m.position.value[1], seq.height / 2)
    && near(m.scale.value, 100) && near(m.rotation.value, 0)
    && near(m.anchor.value[0], w / 2) && near(m.anchor.value[1], h / 2) && m.uniformScale !== false;
}

export const opacityIsDefault = (c: TimelineClip) => !c.motion?.opacity?.keyframes?.length && near(c.motion?.opacity?.value ?? 100, 100);

/** Every sequence a sequence uses (nested), itself first. */
export function sequencesUsed(p: EditProject, seqId: string): Sequence[] {
  const out: Sequence[] = [];
  const walk = (id: string) => {
    const s = p.sequences.find((x) => x.id === id);
    if (!s || out.includes(s)) return;
    out.push(s);
    for (const c of s.clips) if (c.source.type === "nested") walk(c.source.sequenceId);
  };
  walk(seqId);
  return out;
}

export class FileTable {
  private byKey = new Map<string, XFile>();
  private project: EditProject;
  private opts: ExportOptions;
  private warn: (s: string) => void;
  constructor(project: EditProject, opts: ExportOptions, warn: (s: string) => void) { this.project = project; this.opts = opts; this.warn = warn; }
  forMedia(m: MediaItem, seqFps: number): XFile {
    let f = this.byKey.get(m.id);
    if (f) return f;
    const local = this.opts.pathFor ? this.opts.pathFor(m) : m.path.startsWith("studio:") ? null : m.path;
    if (!local) this.warn(`"${m.name}" isn't on this PC (studio media): it's written without a file path, so it opens offline`);
    else if (m.missing) this.warn(`"${m.name}" is missing on this PC: the file keeps its last known path`);
    const seconds = m.seconds ?? (m.kind !== "image" && m.fps > 0 ? m.duration / fpsExact(m.fps) : 0);
    f = {
      key: m.id, path: local ?? "", name: m.name, kind: m.kind, seconds,
      fps: m.kind === "video" && m.fps > 0 ? m.fps : seqFps, width: m.width, height: m.height, hasAudio: m.hasAudio,
      channels: m.audioChannels ?? (m.hasAudio ? 2 : 0), sampleRate: m.sampleRate ?? (m.kind === "audio" && m.fps > 0 ? m.fps : 48000), media: m,
    };
    this.byKey.set(m.id, f);
    return f;
  }
  forPath(key: string, file: string, seconds: number, seqFps: number, name?: string): XFile {
    let f = this.byKey.get(key);
    if (f) return f;
    f = { key, path: file, name: name ?? file.split(/[\\/]/).pop() ?? file, kind: kindOfPath(file) ?? "audio", seconds, fps: seqFps, width: 0, height: 0,
      hasAudio: true, channels: 2, sampleRate: 48000 };
    this.byKey.set(key, f);
    return f;
  }
  all(): XFile[] { return [...this.byKey.values()]; }
  media(id: string) { return this.project.media.find((m) => m.id === id); }
}

/** The export view of one sequence. */
export function prepareSequence(p: EditProject, seq: Sequence, files: FileTable, opts: ExportOptions, warn: (s: string) => void): XSeq {
  const fps = seq.fps;
  const F = fpsExact(fps);
  const tracks: XTrack[] = [];
  const seqNotes: XSeq["notes"] = [];
  const ordered = [...seq.tracks].sort((a, b) => (a.kind === b.kind ? a.index - b.index : a.kind === "video" ? -1 : 1));
  for (const t of ordered) {
    if (t.kind === "video" && opts.videoTracks && !opts.videoTracks.includes(t.index)) continue;
    const stem = t.kind === "audio" ? opts.stems?.[t.id] : undefined;
    const clips = seq.clips.filter((c) => c.trackId === t.id).sort((a, b) => a.start - b.start);
    const transitions = seq.transitions.filter((x) => x.trackId === t.id);
    const xt: XTrack = { track: t, kind: t.kind, index: t.index, items: [], transitions: stem ? [] : transitions };
    tracks.push(xt);
    if (stem) {
      if (!clips.length) continue;
      const file = files.forPath(`stem:${t.id}`, stem.path, stem.seconds, fps, stem.name);
      const len = Math.max(1, Math.round(stem.seconds * F));
      const fake: TimelineClip = { ...clips[0], id: `stem_${t.id}`, start: 0, duration: len, speed: 1, reverse: false, enabled: true, name: stem.name ?? `${t.name} stem`,
        source: { type: "media", mediaId: `stem:${t.id}`, in: 0 }, audio: { gain: { value: 0 }, pan: { value: 0 }, fadeIn: 0, fadeOut: 0 }, effects: [] };
      delete fake.timeRemap; delete fake.linkId;
      xt.items.push({ clip: fake, kind: "audio", trackIndex: t.index, start: 0, end: len, what: "file", file, srcIn: 0, span: len, speed: 1, reverse: false,
        available: len, notes: [], markers: [] });
      continue;
    }
    for (const c of clips) {
      const notes: XNoteOut[] = [];
      const base = c.speed > 0 ? c.speed : 1;
      const ramp = hasRamp(c);
      const speed = ramp ? base * rampAverage(c) : base;
      if (ramp) {
        notes.push({ label: "Speed ramp", note: { kind: "timeRemap", timeRemap: structuredClone(c.timeRemap!) } });
        warn(`"${c.name}": its speed ramp is written as a constant ${Math.round(speed * 100)} % (the ramp is kept in a "Tatvam: Speed ramp" marker)`);
      }
      const item: XItem = {
        clip: c, kind: t.kind, trackIndex: t.index, start: c.start, end: c.start + c.duration, what: "gap", srcIn: 0, span: c.duration * speed,
        speed, reverse: !!c.reverse, available: Infinity, notes, markers: [],
        tin: transitions.find((x) => x.toClipId === c.id), tout: transitions.find((x) => x.fromClipId === c.id),
      };
      const gen = generatorOf(c);
      const s = c.source;
      let pic: { width: number; height: number } | undefined;
      if (s.type === "media") {
        const m = files.media(s.mediaId);
        if (!m) { warn(`"${c.name}" points at media that isn't in the edit; it was left out`); continue; }
        item.what = "file";
        item.file = files.forMedia(m, fps);
        const rate = mediaRate(m, fps);
        item.srcIn = (s.in / rate) * F;
        if (m.kind !== "image" && m.duration > 0) item.available = (m.duration / rate) * F;
        if (m.kind !== "image") {
          const lo = item.srcIn, hi = item.srcIn + item.span;
          item.markers = m.markers.map((k) => ({ ...k, frame: (k.frame / rate) * F, duration: (k.duration / rate) * F }))
            .filter((k) => k.frame >= lo - 1e-6 && k.frame < hi);
        }
        if (m.width && m.height) pic = { width: m.width, height: m.height };
      } else if (s.type === "nested") {
        const ns = p.sequences.find((x) => x.id === s.sequenceId);
        if (!ns) { warn(`The nested clip "${c.name}" points at a missing sequence; it was left out`); continue; }
        item.what = "nested";
        item.nested = ns;
        item.srcIn = s.in * (F / fpsExact(ns.fps));
        item.available = ns.clips.reduce((mx, x) => Math.max(mx, x.start + x.duration), 0) * (F / fpsExact(ns.fps));
        pic = { width: ns.width, height: ns.height };
      } else if (gen) {
        const g = opts.generated?.[c.id];
        const label = GENERATOR_LABELS[gen.generator] ?? gen.generator;
        notes.push({ label, note: { kind: "source", source: structuredClone(c.source) } });
        if (g) {
          item.what = "file";
          item.file = files.forPath(`gen:${c.id}`, g.path, g.seconds, fps, `${c.name || label}.wav`);
          item.srcIn = 0;
          item.span = c.duration;
          item.speed = 1;
          item.available = g.seconds * F;
        } else {
          warn(`"${c.name}" (${label}) wasn't rendered to a file: it's written as a gap with a "Tatvam: ${label}" marker`);
          seqNotes.push({ at: c.start, label, note: { kind: "item", track: `${t.kind === "video" ? "V" : "A"}${t.index + 1}`, start: c.start, duration: c.duration,
            source: structuredClone(c.source), name: c.name, ...(c.effects.length ? { effects: structuredClone(c.effects) } : {}), ...(c.enabled === false ? { enabled: false } : {}) } });
          item.what = "gap";
        }
      } else if (s.type === "title" || s.type === "color" || s.type === "adjustment") {
        item.what = s.type;
        item.available = Infinity;
      }
      // what the formats have no slot for
      if (!motionIsDefault(c, seq, pic)) notes.push({ label: "Motion", note: { kind: "motion", motion: structuredClone(c.motion) } });
      for (const e of c.effects ?? []) notes.push({ label: effectLabel(e.type, opts.labelFor), note: { kind: "effect", effect: structuredClone(e) } });
      xt.items.push(item);
    }
    if (opts.fadesAsTransitions && t.kind === "audio") {
      for (const it of xt.items) {
        const a = it.clip.audio;
        if (!a || it.what === "gap") continue;
        const prevAbuts = xt.items.some((x) => x !== it && x.what !== "gap" && x.end === it.start);
        const nextAbuts = xt.items.some((x) => x !== it && x.what !== "gap" && x.start === it.end);
        if (a.fadeIn > 0 && !it.tin && !prevAbuts) {
          it.tin = { id: `fi_${it.clip.id}`, trackId: t.id, at: it.start, duration: Math.min(a.fadeIn, it.end - it.start), alignment: "start", type: "audio:constant_gain", easing: "linear", toClipId: it.clip.id };
        }
        if (a.fadeOut > 0 && !it.tout && !nextAbuts) {
          it.tout = { id: `fo_${it.clip.id}`, trackId: t.id, at: it.end, duration: Math.min(a.fadeOut, it.end - it.start), alignment: "end", type: "audio:constant_gain", easing: "linear", fromClipId: it.clip.id };
        }
      }
    }
  }
  const end = seq.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  return { seq, fps, tracks, end, warnings: [], notes: seqNotes };
}

/** [first, end) frames of a transition (model/ops.ts transitionRange). */
export function transitionRange(tr: Pick<Transition, "at" | "duration" | "alignment">): [number, number] {
  if (tr.alignment === "start") return [tr.at, tr.at + tr.duration];
  if (tr.alignment === "end") return [tr.at - tr.duration, tr.at];
  const a = tr.at - Math.floor(tr.duration / 2);
  return [a, a + tr.duration];
}

/** How a Tatvam transition type maps onto the common exchange transitions. */
export function transitionKind(type: string): { kind: "dissolve" | "dip" | "xfade3db" | "xfade0db"; color?: string; exact: boolean } {
  if (type.startsWith("audio:")) {
    if (type === "audio:constant_gain") return { kind: "xfade0db", exact: true };
    return { kind: "xfade3db", exact: type === "audio:constant_power" };
  }
  if (type === "fadeblack") return { kind: "dip", color: "#000000", exact: true };
  if (type === "fadewhite") return { kind: "dip", color: "#ffffff", exact: true };
  return { kind: "dissolve", exact: type === "fade" };
}
