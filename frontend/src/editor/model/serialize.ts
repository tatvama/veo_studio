/**
 * Reading and writing `.tatvamedit` files: `parseProject` validates whatever it is given (a hand-edited or older
 * file), fills missing fields with defaults, drops what can't be repaired and reports it. Pure.
 */
import { DEFAULT_AUTOSAVE_S, defaultAudio, defaultMotion, newSequence, TRACK_H } from "./defaults.ts";
import { uid } from "./ids.ts";
import { normalize, ctxOf } from "./ops.ts";
import { FPS_LIST } from "./time.ts";
import type { Bin, EditProject, Marker, MediaItem, Param, Sequence, TimelineClip, Track, Transition } from "./types.ts";

export const FORMAT = "tatvam-edit";
export const VERSION = 1;

export class ProjectError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const int = (v: unknown, d: number) => Math.round(num(v, d));
const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function param<T>(v: unknown, d: T, ok: (x: unknown) => boolean): Param<T> {
  if (!isObj(v)) return { value: d };
  const value = ok(v.value) ? (v.value as T) : d;
  const ks = arr(v.keyframes).filter((k): k is Obj => isObj(k) && typeof k.frame === "number" && ok(k.value))
    .map((k) => ({ frame: Math.round(k.frame as number), value: k.value as T, ease: (["linear", "ease_in", "ease_out", "ease_in_out", "hold"].includes(k.ease as string) ? k.ease : "linear") as "linear" }))
    .sort((a, b) => a.frame - b.frame);
  return ks.length ? { value, keyframes: ks } : { value };
}
const isNum = (x: unknown) => typeof x === "number" && Number.isFinite(x);
const isPair = (x: unknown) => Array.isArray(x) && x.length === 2 && x.every(isNum);

function marker(v: unknown): Marker | null {
  if (!isObj(v) || !isNum(v.frame)) return null;
  const m: Marker = { id: str(v.id, uid("m")), frame: Math.max(0, int(v.frame, 0)), duration: Math.max(0, int(v.duration, 0)), name: str(v.name, ""), color: str(v.color, "#22d3ee") };
  if (typeof v.comment === "string") m.comment = v.comment;
  return m;
}

function media(v: unknown, warn: (s: string) => void): MediaItem | null {
  if (!isObj(v) || typeof v.id !== "string" || typeof v.path !== "string") { warn("A media item without an id or path was dropped"); return null; }
  const kind = v.kind === "audio" || v.kind === "image" ? v.kind : "video";
  const m: MediaItem = {
    id: v.id, binId: typeof v.binId === "string" ? v.binId : null, name: str(v.name, v.path.split(/[\\/]/).pop() || "Media"), kind, path: v.path,
    duration: Math.max(0, num(v.duration, 0)), fps: num(v.fps, 0), width: int(v.width, 0), height: int(v.height, 0),
    hasAudio: bool(v.hasAudio, kind !== "image"), markers: arr(v.markers).map(marker).filter((x): x is Marker => !!x),
  };
  for (const k of ["url", "thumb", "filmstrip", "proxyPath", "proxyUrl", "colorLabel", "comment", "studioKey"] as const) if (typeof v[k] === "string") m[k] = v[k] as string;
  for (const k of ["audioChannels", "seconds", "sampleRate"] as const) if (isNum(v[k])) m[k] = v[k] as number;
  if (Array.isArray(v.peaks)) m.peaks = (v.peaks as unknown[]).filter(isNum) as number[];
  if (isNum(v.inPoint)) m.inPoint = v.inPoint as number;
  if (isNum(v.outPoint)) m.outPoint = v.outPoint as number;
  if (typeof v.missing === "boolean") m.missing = v.missing;
  if (typeof v.offline === "boolean") m.offline = v.offline;
  return m;
}

function track(v: unknown, i: number): Track | null {
  if (!isObj(v)) return null;
  const kind = v.kind === "audio" ? "audio" : "video";
  return {
    id: str(v.id, uid(kind === "video" ? "v" : "a")), kind, name: str(v.name, `${kind === "video" ? "V" : "A"}${i + 1}`), index: int(v.index, i),
    locked: bool(v.locked, false), hidden: bool(v.hidden, false), muted: bool(v.muted, false), solo: bool(v.solo, false),
    targeted: bool(v.targeted, false), syncLock: bool(v.syncLock, true), height: Math.max(20, Math.min(400, int(v.height, TRACK_H[kind]))),
    volume: num(v.volume, 0), pan: Math.max(-1, Math.min(1, num(v.pan, 0))),
  };
}

function clip(v: unknown, seq: Sequence, warn: (s: string) => void): TimelineClip | null {
  if (!isObj(v) || !isObj(v.source) || typeof v.trackId !== "string") return null;
  const t = seq.tracks.find((x) => x.id === v.trackId);
  if (!t) { warn(`A clip on a missing track was dropped (${str(v.name, "clip")})`); return null; }
  const s = v.source;
  let source: TimelineClip["source"];
  if (s.type === "media" && typeof s.mediaId === "string") source = { type: "media", mediaId: s.mediaId, in: num(s.in, 0) };
  else if (s.type === "title" && isObj(s.text)) source = { type: "title", text: s.text as never };
  else if (s.type === "color") source = { type: "color", color: str(s.color, "#000000") };
  else if (s.type === "adjustment") source = { type: "adjustment" };
  else if (s.type === "nested" && typeof s.sequenceId === "string") source = { type: "nested", sequenceId: s.sequenceId, in: num(s.in, 0) };
  else { warn("A clip with an unknown source was dropped"); return null; }
  const mo = isObj(v.motion) ? v.motion : {};
  const dm = defaultMotion(seq);
  const c: TimelineClip = {
    id: str(v.id, uid("c")), trackId: t.id, start: Math.max(0, int(v.start, 0)), duration: Math.max(1, int(v.duration, 1)), source,
    speed: Math.max(0.01, num(v.speed, 1)), reverse: bool(v.reverse, false), enabled: bool(v.enabled, true), name: str(v.name, "Clip"),
    motion: {
      position: param(mo.position, dm.position.value, isPair), scale: param(mo.scale, 100, isNum), rotation: param(mo.rotation, 0, isNum),
      anchor: param(mo.anchor, dm.anchor.value, isPair), opacity: param(mo.opacity, 100, isNum),
      blend: (["normal", "add", "multiply", "screen", "overlay", "lighten", "darken"].includes(mo.blend as string) ? mo.blend : "normal") as "normal",
      uniformScale: bool(mo.uniformScale, true),
    },
    effects: arr(v.effects).filter(isObj).map((e) => ({
      id: str(e.id, uid("e")), type: str(e.type, "unknown"), enabled: bool(e.enabled, true),
      params: Object.fromEntries(Object.entries(isObj(e.params) ? e.params : {}).map(([k, p]) => [k, isObj(p) && "value" in p ? param(p, p.value, () => true) : { value: p }])),
      ...(isObj(e.mask) ? { mask: e.mask as never } : {}),
    })),
  };
  if (typeof v.colorLabel === "string") c.colorLabel = v.colorLabel;
  if (typeof v.linkId === "string") c.linkId = v.linkId;
  if (t.kind === "audio" || isObj(v.audio)) {
    const a = isObj(v.audio) ? v.audio : {};
    const d = defaultAudio();
    c.audio = { gain: param(a.gain, 0, isNum), pan: param(a.pan, 0, isNum), fadeIn: Math.max(0, int(a.fadeIn, d.fadeIn)), fadeOut: Math.max(0, int(a.fadeOut, d.fadeOut)) };
  }
  if (isObj(v.timeRemap)) c.timeRemap = param(v.timeRemap, 100, isNum);
  return c;
}

function transition(v: unknown): Transition | null {
  if (!isObj(v) || typeof v.trackId !== "string" || !isNum(v.at)) return null;
  const t: Transition = {
    id: str(v.id, uid("t")), trackId: v.trackId, at: int(v.at, 0), duration: Math.max(1, int(v.duration, 1)),
    alignment: v.alignment === "start" || v.alignment === "end" ? v.alignment : "center", type: str(v.type, "fade"),
    easing: (["linear", "ease_in", "ease_out", "ease_in_out"].includes(v.easing as string) ? v.easing : "linear") as "linear",
  };
  if (isObj(v.params)) t.params = v.params;
  if (typeof v.fromClipId === "string") t.fromClipId = v.fromClipId;
  if (typeof v.toClipId === "string") t.toClipId = v.toClipId;
  return t;
}

function sequence(v: unknown, warn: (s: string) => void): Sequence | null {
  if (!isObj(v)) return null;
  const fps = FPS_LIST.find((f) => Math.abs(f - num(v.fps, 25)) < 0.01) ?? 25;
  const base = newSequence(str(v.name, "Sequence"), { width: Math.max(16, int(v.width, 1920)), height: Math.max(16, int(v.height, 1080)), fps }, { video: 0, audio: 0 });
  const seq: Sequence = { ...base, id: str(v.id, base.id) };
  let tracks = arr(v.tracks).map(track).filter((x): x is Track => !!x);
  // indexes 0..n-1 per kind, in their stored order
  const fix = (kind: Track["kind"]) => tracks.filter((t) => t.kind === kind).sort((a, b) => a.index - b.index).map((t, i) => ({ ...t, index: i }));
  tracks = [...fix("video"), ...fix("audio")];
  if (!tracks.some((t) => t.kind === "video")) tracks.unshift({ ...newSequence("", base, { video: 1, audio: 0 }).tracks[0] });
  if (!tracks.some((t) => t.kind === "audio")) tracks.push({ ...newSequence("", base, { video: 0, audio: 1 }).tracks[0] });
  seq.tracks = tracks;
  seq.clips = arr(v.clips).map((c) => clip(c, seq, warn)).filter((x): x is TimelineClip => !!x);
  // no two clips with one id
  const seen = new Set<string>();
  seq.clips = seq.clips.map((c) => { if (seen.has(c.id)) return { ...c, id: uid("c") }; seen.add(c.id); return c; });
  seq.transitions = arr(v.transitions).map(transition).filter((x): x is Transition => !!x);
  seq.markers = arr(v.markers).map(marker).filter((x): x is Marker => !!x).sort((a, b) => a.frame - b.frame);
  if (isNum(v.inPoint)) seq.inPoint = int(v.inPoint, 0);
  if (isNum(v.outPoint)) seq.outPoint = int(v.outPoint, 0);
  seq.playhead = Math.max(0, int(v.playhead, 0));
  if (isObj(v.workArea)) seq.workArea = { zoom: num(v.workArea.zoom, 0), scroll: num(v.workArea.scroll, 0) };
  if (isObj(v.source) && isNum(v.source.pid) && isNum(v.source.eid)) {
    seq.source = { pid: v.source.pid as number, eid: v.source.eid as number, lang: str(v.source.lang, "") };
    if (isNum(v.source.cutVersion) || v.source.cutVersion === null) seq.source.cutVersion = v.source.cutVersion as number | null;
  }
  return seq;
}

/**
 * A project from parsed JSON (or a JSON string). Throws ProjectError when it isn't an edit at all or is from a newer
 * version; otherwise repairs what it can and lists what it changed in `warnings`.
 */
export function parseProject(input: unknown): { project: EditProject; warnings: string[] } {
  const warnings: string[] = [];
  const warn = (s: string) => { if (!warnings.includes(s)) warnings.push(s); };
  let v = input;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { throw new ProjectError("The file isn't valid JSON"); }
  }
  if (!isObj(v)) throw new ProjectError("The file isn't a Tatvam edit");
  if (v.format !== undefined && v.format !== FORMAT) throw new ProjectError("The file isn't a Tatvam edit");
  if (num(v.version, 1) > VERSION) throw new ProjectError(`This edit was saved by a newer Tatvam (format ${v.version}); update the app to open it`);
  const bins: Bin[] = arr(v.bins).filter(isObj).filter((b) => typeof b.id === "string")
    .map((b) => ({ id: b.id as string, name: str(b.name, "Bin"), parentId: typeof b.parentId === "string" ? b.parentId : null, ...(typeof b.color === "string" ? { color: b.color } : {}) }));
  const binIds = new Set(bins.map((b) => b.id));
  for (const b of bins) if (b.parentId && !binIds.has(b.parentId)) b.parentId = null;
  const mediaList = arr(v.media).map((m) => media(m, warn)).filter((x): x is MediaItem => !!x)
    .map((m) => (m.binId && !binIds.has(m.binId) ? { ...m, binId: null } : m));
  let seqs = arr(v.sequences).map((s) => sequence(s, warn)).filter((x): x is Sequence => !!x);
  if (!seqs.length) { seqs = [newSequence("Sequence 01", { width: 1920, height: 1080, fps: 25 })]; warn("The edit had no sequence; an empty one was added"); }
  const set = isObj(v.settings) ? v.settings : {};
  const t = new Date().toISOString();
  const project: EditProject = {
    format: FORMAT, version: VERSION, id: str(v.id, uid("p")), name: str(v.name, "Untitled edit"), created: str(v.created, t), modified: str(v.modified, t),
    bins, media: mediaList, sequences: seqs,
    activeSequenceId: seqs.some((s) => s.id === v.activeSequenceId) ? (v.activeSequenceId as string) : seqs[0].id,
    settings: {
      copyMedia: bool(set.copyMedia, false), proxy: set.proxy === "auto" || set.proxy === "always" ? set.proxy : "off",
      autosaveSeconds: Math.max(0, int(set.autosaveSeconds, DEFAULT_AUTOSAVE_S)),
    },
  };
  if (isNum(v.studioProjectId)) project.studioProjectId = v.studioProjectId as number;
  // clips pointing at media or sequences that aren't there
  const mids = new Set(project.media.map((m) => m.id)), sids = new Set(project.sequences.map((s) => s.id));
  const ctx = ctxOf(project);
  project.sequences = project.sequences.map((s) => {
    const clips = s.clips.filter((c) => {
      if (c.source.type === "media" && !mids.has(c.source.mediaId)) { warn("Clips whose media is not in the project were removed"); return false; }
      if (c.source.type === "nested" && (!sids.has(c.source.sequenceId) || c.source.sequenceId === s.id)) { warn("Nested clips whose sequence is missing were removed"); return false; }
      return true;
    });
    return normalize({ ...s, clips }, ctx);
  });
  return { project, warnings };
}

/**
 * The project as it goes to `bridge.editor.save`: exactly what open() / importMedia() gave (the bridge turns the
 * runtime gateway URLs back into paths relative to the edit folder). Only the editor's own runtime state is left out.
 */
export function forDisk(p: EditProject): EditProject {
  return p;
}
