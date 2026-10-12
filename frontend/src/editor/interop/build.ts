/**
 * An imported timeline (ir.ts) → a new edit project: media items (files that aren't there become offline media you
 * can relink), sequences with their tracks, clips, transitions and markers, A/V links, and the notes for effects the
 * editor doesn't have (markers on the clip's media). The factories mirror model/defaults.ts (kept local: the desktop
 * bundles this file). The editor's parseProject() normalises the result when it opens. Pure.
 */
import type { Bin, EditProject, Marker, MediaItem, Motion, Sequence, TimelineClip, Track, Transition } from "../model/types.ts";
import { editorFps, fpsExact, makeIds, MARKER_COLORS, r3, type IdFn } from "./common.ts";
import type { IrDoc, IrMarker, IrMedia } from "./ir.ts";

export interface BuildOptions { name?: string; ids?: IdFn; now?: string; bin?: string }
export interface BuildResult {
  project: EditProject; warnings: string[];
  /** IR media key → the media item's id. */
  mediaIds: Record<string, string>;
}

const TRACK_H = { video: 56, audio: 48 } as const;

function track(kind: "video" | "audio", index: number, ids: IdFn): Track {
  return {
    id: ids(kind === "video" ? "v" : "a"), kind, name: `${kind === "video" ? "V" : "A"}${index + 1}`, index,
    locked: false, hidden: false, muted: false, solo: false, targeted: index === 0, syncLock: true,
    height: TRACK_H[kind], volume: 0, pan: 0,
  };
}

function motion(seq: { width: number; height: number }, pic?: { width: number; height: number }): Motion {
  const w = pic?.width || seq.width, h = pic?.height || seq.height;
  return {
    position: { value: [seq.width / 2, seq.height / 2] }, scale: { value: 100 }, rotation: { value: 0 },
    anchor: { value: [w / 2, h / 2] }, opacity: { value: 100 }, blend: "normal", uniformScale: true,
  };
}

/** The media item's units for a time in seconds (video frames, audio samples). */
const unitsPerSecond = (m: MediaItem, seqFps: number) => (m.kind === "image" ? 0 : m.fps > 0 ? fpsExact(m.fps) : fpsExact(seqFps));

function mediaItem(m: IrMedia, ids: IdFn, seqFps: number, binId: string | null): MediaItem {
  const kind = m.kind;
  const fps = kind === "image" ? 0 : kind === "audio" ? (m.sampleRate && m.sampleRate > 0 ? m.sampleRate : 48000) : (m.fps && m.fps > 0 ? m.fps : seqFps);
  const it: MediaItem = {
    id: ids("m"), binId, name: m.name || "Media", kind, path: m.path,
    duration: kind === "image" || !(m.seconds && m.seconds > 0) ? 0 : Math.round(m.seconds * fpsExact(fps)),
    fps, width: kind === "audio" ? 0 : Math.round(m.width ?? 0), height: kind === "audio" ? 0 : Math.round(m.height ?? 0),
    hasAudio: m.hasAudio ?? kind === "audio", markers: [],
  };
  if (m.channels && m.channels > 0) it.audioChannels = m.channels;
  if (m.sampleRate && m.sampleRate > 0) it.sampleRate = m.sampleRate;
  if (m.seconds && m.seconds > 0) it.seconds = r3(m.seconds);
  if (!m.path) { it.missing = true; it.offline = true; }
  const ups = unitsPerSecond(it, seqFps) || fpsExact(seqFps);
  for (const k of m.markers ?? []) it.markers.push(mediaMarker(k, ups, ids));
  return it;
}

function mediaMarker(k: IrMarker, ups: number, ids: IdFn): Marker {
  const x: Marker = { id: ids("m"), frame: Math.max(0, Math.round(k.at * ups)), duration: Math.max(0, Math.round(k.duration * ups)), name: k.name, color: k.color || MARKER_COLORS[0] };
  if (k.comment) x.comment = k.comment;
  if (k.kind) x.kind = k.kind;
  return x;
}

export function buildProject(doc: IrDoc, opts: BuildOptions = {}): BuildResult {
  const ids = opts.ids ?? makeIds();
  const warnings = [...doc.warnings];
  const warn = (s: string) => { if (!warnings.includes(s)) warnings.push(s); };
  const mainIr = doc.sequences.find((s) => s.key === doc.main) ?? doc.sequences[0];
  if (!mainIr) throw new Error("The file has no sequence in it");
  const t = opts.now ?? new Date().toISOString();
  const bins: Bin[] = [];
  let binId: string | null = null;
  if (doc.media.length && opts.bin !== "") {
    binId = ids("b");
    bins.push({ id: binId, name: opts.bin ?? doc.name ?? "Imported media", parentId: null });
  }
  const mainFps = editorFps(mainIr.fps).fps;
  const media: MediaItem[] = [];
  const byKey = new Map<string, MediaItem>();
  for (const m of doc.media) {
    if (byKey.has(m.key)) continue;
    const it = mediaItem(m, ids, mainFps, binId);
    media.push(it);
    byKey.set(m.key, it);
  }
  const seqIds = new Map(doc.sequences.map((s) => [s.key, ids("s")]));
  const sequences: Sequence[] = [];
  for (const ir of doc.sequences) {
    const { fps, changed } = editorFps(ir.fps);
    if (changed) warn(`"${ir.name}" is ${ir.fps} fps, which the editor doesn't have: it opens at ${fps} fps (clip positions keep their frame numbers)`);
    const seq: Sequence = {
      id: seqIds.get(ir.key)!, name: ir.name || "Sequence", width: Math.max(16, Math.round(ir.width || 1920)), height: Math.max(16, Math.round(ir.height || 1080)),
      fps, sampleRate: 48000, tracks: [], clips: [], transitions: [], markers: [], playhead: 0, workArea: { zoom: 0, scroll: 0 },
    };
    // tracks: as many as the file names, at least one of each kind
    const count = (kind: "video" | "audio") => Math.max(1, ...ir.tracks.filter((x) => x.kind === kind).map((x) => x.index + 1), ...ir.clips.filter((c) => c.kind === kind).map((c) => c.track + 1));
    for (const kind of ["video", "audio"] as const) {
      for (let i = 0; i < count(kind); i++) {
        const tr = track(kind, i, ids);
        const it = ir.tracks.find((x) => x.kind === kind && x.index === i);
        if (it) {
          if (it.name) tr.name = it.name;
          if (it.locked) tr.locked = true;
          if (it.enabled === false) { if (kind === "video") tr.hidden = true; else tr.muted = true; }
          if (it.extra) Object.assign(tr, it.extra, { id: tr.id, kind, index: i });
        }
        seq.tracks.push(tr);
      }
    }
    const trackId = (kind: "video" | "audio", i: number) => seq.tracks.find((x) => x.kind === kind && x.index === i)!.id;
    const refs = new Map<string, string>();
    const links = new Map<string, string[]>();
    for (const c of ir.clips) {
      let source: TimelineClip["source"] | null = null;
      let pic: { width: number; height: number } | undefined;
      let m: MediaItem | undefined;
      if (c.media) {
        m = byKey.get(c.media.key);
        if (!m) { warn(`"${c.name}" points at a file that isn't in the list; it was left out`); continue; }
        source = { type: "media", mediaId: m.id, in: Math.max(0, r3(c.media.in * unitsPerSecond(m, fps))) };
        if (m.width && m.height) pic = { width: m.width, height: m.height };
      } else if (c.nested) {
        const sid = seqIds.get(c.nested.key);
        if (!sid || sid === seq.id) { warn(`The nested clip "${c.name}" points at a sequence that isn't in the file; it was left out`); continue; }
        source = { type: "nested", sequenceId: sid, in: Math.max(0, r3(c.nested.in)) };
        const ns = doc.sequences.find((s) => s.key === c.nested!.key);
        if (ns) pic = { width: ns.width, height: ns.height };
      } else if (c.source) {
        source = c.source;
      }
      if (!source) { warn(`"${c.name}" has no media; it was left out`); continue; }
      const id = ids("c");
      const clip: TimelineClip = {
        id, trackId: trackId(c.kind, c.track), start: Math.max(0, Math.round(c.start)), duration: Math.max(1, Math.round(c.duration)), source,
        speed: c.speed && c.speed > 0 ? r3(c.speed) || 1 : 1, reverse: !!c.reverse, enabled: c.enabled !== false, name: c.name || m?.name || "Clip",
        motion: motion(seq, pic), effects: c.effects ? structuredClone(c.effects) : [],
      };
      if (c.opacity) clip.motion.opacity = c.opacity;
      if (c.blend) clip.motion.blend = c.blend;
      if (c.kind === "audio") clip.audio = { gain: c.gain ?? { value: 0 }, pan: c.pan ?? { value: 0 }, fadeIn: 0, fadeOut: 0 };
      if (c.extra) {
        const { id: _i, trackId: _t, source: _s, ...rest } = c.extra as TimelineClip;
        void _i; void _t; void _s;
        Object.assign(clip, structuredClone(rest));
      }
      seq.clips.push(clip);
      refs.set(c.ref, id);
      if (c.link) links.set(c.link, [...(links.get(c.link) ?? []), id]);
      // effects the editor doesn't have: markers on the clip's media (or on the sequence for nested clips)
      for (const n of c.notes ?? []) {
        if (m) {
          const at = Math.max(0, Math.round(source.type === "media" ? source.in : 0));
          if (!m.markers.some((x) => x.frame === at && x.name === n.name)) m.markers.push({ id: ids("m"), frame: at, duration: 0, name: n.name, color: "#fb7185", ...(n.comment ? { comment: n.comment } : {}) });
        } else {
          seq.markers.push({ id: ids("m"), frame: clip.start, duration: 0, name: `${clip.name}: ${n.name}`, color: "#fb7185", ...(n.comment ? { comment: n.comment } : {}) });
        }
      }
    }
    for (const group of links.values()) {
      if (group.length < 2) continue;
      const lid = ids("l");
      for (const cid of group) { const c = seq.clips.find((x) => x.id === cid); if (c) c.linkId = lid; }
    }
    for (const tr of ir.transitions) {
      const x: Transition = {
        id: ids("t"), trackId: trackId(tr.kind, tr.track), at: Math.round(tr.at), duration: Math.max(1, Math.round(tr.duration)), alignment: tr.alignment,
        type: tr.type, easing: tr.easing ?? "linear",
      };
      if (tr.params && Object.keys(tr.params).length) x.params = tr.params;
      if (tr.from && refs.has(tr.from)) x.fromClipId = refs.get(tr.from);
      if (tr.to && refs.has(tr.to)) x.toClipId = refs.get(tr.to);
      if (!x.fromClipId && !x.toClipId) continue;
      seq.transitions.push(x);
    }
    for (const k of ir.markers) {
      const mk: Marker = { id: ids("m"), frame: Math.max(0, Math.round(k.at)), duration: Math.max(0, Math.round(k.duration)), name: k.name, color: k.color || MARKER_COLORS[0] };
      if (k.comment) mk.comment = k.comment;
      if (k.kind) mk.kind = k.kind;
      seq.markers.push(mk);
    }
    seq.markers.sort((a, b) => a.frame - b.frame);
    if (ir.masterEffects?.length) (seq as Sequence & { masterEffects?: unknown }).masterEffects = structuredClone(ir.masterEffects);
    sequences.push(seq);
  }
  const main = sequences[doc.sequences.indexOf(mainIr)];
  const project: EditProject = {
    format: "tatvam-edit", version: 1, id: ids("p"), name: opts.name || doc.name || main.name, created: t, modified: t,
    bins, media, sequences: [main, ...sequences.filter((s) => s !== main)], activeSequenceId: main.id,
    settings: { copyMedia: false, proxy: "off", autosaveSeconds: 10 },
  };
  return { project, warnings, mediaIds: Object.fromEntries([...byKey].map(([k, v]) => [k, v.id])) };
}

/**
 * A media item replaced by what probing the real file found (the desktop's import): its id, bin, name and markers
 * stay; clip in points and markers are rescaled when the file's rate differs from what the exchange file said.
 */
export function rebaseMedia(project: EditProject, mediaId: string, probed: MediaItem): EditProject {
  const old = project.media.find((m) => m.id === mediaId);
  if (!old) return project;
  const k = old.kind !== "image" && probed.kind !== "image" && old.fps > 0 && probed.fps > 0 ? fpsExact(probed.fps) / fpsExact(old.fps) : 1;
  const scale = (v: number) => (k === 1 ? v : r3(v * k));
  const item: MediaItem = {
    ...probed, id: old.id, binId: old.binId, name: old.name || probed.name,
    markers: [...old.markers.map((m) => ({ ...m, frame: Math.round(scale(m.frame)), duration: Math.round(scale(m.duration)) })),
      ...probed.markers.filter((p) => !old.markers.some((m) => m.name === p.name && Math.abs(Math.round(scale(m.frame)) - p.frame) < 1))],
  };
  if (old.colorLabel && !item.colorLabel) item.colorLabel = old.colorLabel;
  if (old.comment && !item.comment) item.comment = old.comment;
  delete item.offline;
  return {
    ...project,
    media: project.media.map((m) => (m.id === mediaId ? item : m)),
    sequences: project.sequences.map((s) => ({
      ...s,
      clips: s.clips.map((c) => (c.source.type === "media" && c.source.mediaId === mediaId && k !== 1 ? { ...c, source: { ...c.source, in: scale(c.source.in) } } : c)),
    })),
  };
}
