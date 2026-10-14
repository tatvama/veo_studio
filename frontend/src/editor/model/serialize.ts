/**
 * Reading and writing `.tatvamedit` files: `parseProject` validates whatever it is given (a hand-edited or older
 * file), fills missing fields with defaults, drops what can't be repaired and reports it. Pure.
 *
 * Every object keeps the fields this code doesn't know (each one starts as a copy of what was read), so what another
 * builder or a newer Tatvam adds round-trips. Only the fields the editor relies on are checked: a malformed required
 * field gets its default, a malformed optional one is dropped.
 */
import { DEFAULT_AUTOSAVE_S, defaultAudio, defaultMotion, newSequence, TRACK_H } from "./defaults.ts";
import { uid } from "./ids.ts";
import { normalize, ctxOf } from "./ops.ts";
import { FPS_LIST } from "./time.ts";
import type { Bin, ClipSource, EditProject, EffectInstance, Keyframe, Marker, MediaItem, Param, Sequence, TimelineClip, TitleSpec, Track, Transition } from "./types.ts";

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
const isNum = (x: unknown) => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isPair = (x: unknown) => Array.isArray(x) && x.length === 2 && x.every(isNum);
const isNums = (x: unknown) => Array.isArray(x) && x.every(isNum);
/** Sets an optional field, or removes it (a malformed value read from the file goes). */
function opt(o: Obj, key: string, value: unknown) { if (value === undefined) delete o[key]; else o[key] = value; }

const KEY_EASES = ["linear", "ease_in", "ease_out", "ease_in_out", "hold", "bezier", "bounce", "elastic"];
const ROLES = ["dialogue", "music", "sfx", "ambience"];
const BLENDS = ["normal", "add", "multiply", "screen", "overlay", "lighten", "darken"];
/** News Room (docs/EDITOR.md §16): graphics track roles. */
const GFX_ROLES = ["background", "layout", "board", "strap", "ticker", "bug", "wipe"];

function keyframe(k: Obj): Keyframe<unknown> {
  const x: Obj = { ...k, frame: Math.round(k.frame as number), value: k.value, ease: KEY_EASES.includes(k.ease as string) ? k.ease : "linear" };
  // bezier handles and motion-path tangents (editor-motion)
  opt(x, "out", isPair(k.out) ? k.out : undefined);
  opt(x, "in", isPair(k.in) ? k.in : undefined);
  opt(x, "tangentOut", isNums(k.tangentOut) ? k.tangentOut : undefined);
  opt(x, "tangentIn", isNums(k.tangentIn) ? k.tangentIn : undefined);
  return x as unknown as Keyframe<unknown>;
}

function param<T>(v: unknown, d: T, ok: (x: unknown) => boolean): Param<T> {
  if (!isObj(v)) return { value: d };
  const out: Obj = { ...v, value: ok(v.value) ? v.value : d };
  const ks = arr(v.keyframes).filter((k): k is Obj => isObj(k) && isNum(k.frame) && ok(k.value)).map(keyframe).sort((a, b) => a.frame - b.frame);
  opt(out, "keyframes", ks.length ? ks : undefined);
  return out as Param<T>;
}
/** Any-valued params (effects, generators: numbers, strings for selects, arrays …); a bare value becomes a Param. */
const params = (v: unknown): Record<string, Param<unknown>> =>
  Object.fromEntries(Object.entries(isObj(v) ? v : {}).map(([k, p]) => [k, isObj(p) && "value" in p ? param(p, p.value, () => true) : { value: p }]));

function effect(e: Obj): EffectInstance {
  const x: Obj = { ...e, id: str(e.id, uid("e")), type: str(e.type, "unknown"), enabled: bool(e.enabled, true), params: params(e.params) };
  opt(x, "mask", isObj(e.mask) ? e.mask : undefined);
  return x as unknown as EffectInstance;
}
const effects = (v: unknown) => arr(v).filter(isObj).map(effect);

function marker(v: unknown): Marker | null {
  if (!isObj(v) || !isNum(v.frame)) return null;
  const m: Obj = { ...v, id: str(v.id, uid("m")), frame: Math.max(0, int(v.frame, 0)), duration: Math.max(0, int(v.duration, 0)), name: str(v.name, ""), color: str(v.color, "#22d3ee") };
  opt(m, "comment", isStr(v.comment) ? v.comment : undefined);
  opt(m, "kind", ["beat", "chapter", "comment", "scene"].includes(v.kind as string) ? v.kind : undefined);
  return m as unknown as Marker;
}

function media(v: unknown, warn: (s: string) => void): MediaItem | null {
  if (!isObj(v) || typeof v.id !== "string" || typeof v.path !== "string") { warn("A media item without an id or path was dropped"); return null; }
  const kind = v.kind === "audio" || v.kind === "image" ? v.kind : "video";
  const m: Obj = {
    ...v, id: v.id, binId: typeof v.binId === "string" ? v.binId : null, name: str(v.name, v.path.split(/[\\/]/).pop() || "Media"), kind, path: v.path,
    duration: Math.max(0, num(v.duration, 0)), fps: num(v.fps, 0), width: int(v.width, 0), height: int(v.height, 0),
    hasAudio: bool(v.hasAudio, kind !== "image"), markers: arr(v.markers).map(marker).filter((x): x is Marker => !!x),
  };
  for (const k of ["url", "thumb", "filmstrip", "proxyPath", "proxyUrl", "colorLabel", "comment", "studioKey"]) opt(m, k, isStr(v[k]) ? v[k] : undefined);
  for (const k of ["audioChannels", "seconds", "sampleRate", "inPoint", "outPoint"]) opt(m, k, isNum(v[k]) ? v[k] : undefined);
  opt(m, "peaks", Array.isArray(v.peaks) ? (v.peaks as unknown[]).filter(isNum) : undefined);
  for (const k of ["missing", "offline"]) opt(m, k, typeof v[k] === "boolean" ? v[k] : undefined);
  return m as unknown as MediaItem;
}

function track(v: unknown, i: number): Track | null {
  if (!isObj(v)) return null;
  const kind = v.kind === "audio" ? "audio" : "video";
  const t: Obj = {
    ...v, id: str(v.id, uid(kind === "video" ? "v" : "a")), kind, name: str(v.name, `${kind === "video" ? "V" : "A"}${i + 1}`), index: int(v.index, i),
    locked: bool(v.locked, false), hidden: bool(v.hidden, false), muted: bool(v.muted, false), solo: bool(v.solo, false),
    targeted: bool(v.targeted, false), syncLock: bool(v.syncLock, true), height: Math.max(20, Math.min(400, int(v.height, TRACK_H[kind]))),
    volume: num(v.volume, 0), pan: Math.max(-1, Math.min(1, num(v.pan, 0))),
  };
  // editor-audio: the track's Essential Sound role and its effects
  opt(t, "role", ROLES.includes(v.role as string) ? v.role : undefined);
  opt(t, "effects", Array.isArray(v.effects) ? effects(v.effects) : undefined);
  // News Room: a graphics track
  opt(t, "gfxRole", GFX_ROLES.includes(v.gfxRole as string) ? v.gfxRole : undefined);
  return t as unknown as Track;
}

/** A title: kept as written; editor-looks' karaoke words are checked (a malformed word goes), template / look /
 *  shape must be what they say. */
function title(t: Obj): TitleSpec {
  const x: Obj = { ...t };
  const k = t.karaoke;
  opt(x, "karaoke", isObj(k) && Array.isArray(k.words)
    ? { ...k, words: k.words.filter((w): w is Obj => isObj(w) && isNum(w.start) && isNum(w.end) && isStr(w.text)).map((w) => ({ ...w })) } : undefined);
  opt(x, "template", isStr(t.template) ? t.template : undefined);
  opt(x, "look", isObj(t.look) ? t.look : undefined);
  opt(x, "shape", isObj(t.shape) && isStr(t.shape.kind) ? t.shape : undefined);
  return x as unknown as TitleSpec;
}

function source(s: Obj): ClipSource | null {
  if (s.type === "media" && isStr(s.mediaId)) return { ...s, type: "media", mediaId: s.mediaId, in: num(s.in, 0) } as ClipSource;
  if (s.type === "title" && isObj(s.text)) return { ...s, type: "title", text: title(s.text) } as ClipSource;
  if (s.type === "color") return { ...s, type: "color", color: str(s.color, "#000000") } as ClipSource;
  if (s.type === "adjustment") return { ...s, type: "adjustment" } as ClipSource;
  if (s.type === "nested" && isStr(s.sequenceId)) return { ...s, type: "nested", sequenceId: s.sequenceId, in: num(s.in, 0) } as ClipSource;
  // editor-audio: a generated sound (tone, noise, DTMF …) with its params
  if (s.type === "generate" && isStr(s.generator)) return { ...s, type: "generate", generator: s.generator, params: params(s.params) } as ClipSource;
  // News Room: a broadcast graphic (template id + values; the rest of the instance is kept as written)
  if (s.type === "graphic" && isObj(s.gfx) && isStr(s.gfx.template)) {
    const g: Obj = { ...s.gfx, template: s.gfx.template, values: isObj(s.gfx.values) ? { ...s.gfx.values } : {} };
    opt(g, "look", isStr(s.gfx.look) ? s.gfx.look : undefined);
    opt(g, "ratios", Array.isArray(s.gfx.ratios) ? (s.gfx.ratios as unknown[]).filter(isStr) : undefined);
    for (const k of ["overrides", "bind", "langs"]) opt(g, k, isObj(s.gfx[k]) ? s.gfx[k] : undefined);
    opt(g, "seed", isNum(s.gfx.seed) ? s.gfx.seed : undefined);
    return { ...s, type: "graphic", gfx: g } as unknown as ClipSource;
  }
  // audio-tools2: an audio-reactive visualiser (its settings are clamped where it is drawn; malformed optional ones go)
  if (s.type === "visualizer" && (isStr(s.audioClipId) || isStr(s.mediaId))) {
    const x: Obj = { ...s, type: "visualizer", style: str(s.style, "bars"),
      colors: Array.isArray(s.colors) && s.colors.length && s.colors.every(isStr) ? [...s.colors] : ["#22d3ee", "#a78bfa", "#f0abfc"] };
    for (const k of ["audioClipId", "mediaId", "background"]) opt(x, k, isStr(s[k]) ? s[k] : undefined);
    for (const k of ["glow", "smoothing", "freqMin", "freqMax", "sensitivity", "bars", "thickness", "offset", "bands"]) opt(x, k, isNum(s[k]) ? s[k] : undefined);
    opt(x, "gradient", typeof s.gradient === "boolean" ? s.gradient : undefined);
    opt(x, "box", Array.isArray(s.box) && s.box.length === 4 && s.box.every(isNum) ? [...s.box] : undefined);
    return x as unknown as ClipSource;
  }
  return null;
}

function clip(v: unknown, seq: Sequence, warn: (s: string) => void): TimelineClip | null {
  if (!isObj(v) || !isObj(v.source) || typeof v.trackId !== "string") return null;
  const t = seq.tracks.find((x) => x.id === v.trackId);
  if (!t) { warn(`A clip on a missing track was dropped (${str(v.name, "clip")})`); return null; }
  const src = source(v.source);
  if (!src) { warn("A clip with an unknown source was dropped"); return null; }
  const mo = isObj(v.motion) ? v.motion : {};
  const dm = defaultMotion(seq);
  const c: Obj = {
    ...v, id: str(v.id, uid("c")), trackId: t.id, start: Math.max(0, int(v.start, 0)), duration: Math.max(1, int(v.duration, 1)), source: src,
    speed: Math.max(0.01, num(v.speed, 1)), reverse: bool(v.reverse, false), enabled: bool(v.enabled, true), name: str(v.name, "Clip"),
    motion: {
      ...mo,
      position: param(mo.position, dm.position.value, isPair), scale: param(mo.scale, 100, isNum), rotation: param(mo.rotation, 0, isNum),
      anchor: param(mo.anchor, dm.anchor.value, isPair), opacity: param(mo.opacity, 100, isNum),
      blend: BLENDS.includes(mo.blend as string) ? mo.blend : "normal", uniformScale: bool(mo.uniformScale, true),
    },
    effects: effects(v.effects),
  };
  opt(c, "colorLabel", isStr(v.colorLabel) ? v.colorLabel : undefined);
  opt(c, "linkId", isStr(v.linkId) ? v.linkId : undefined);
  if (t.kind === "audio" || isObj(v.audio)) {
    const a = isObj(v.audio) ? v.audio : {};
    const d = defaultAudio();
    c.audio = { ...a, gain: param(a.gain, 0, isNum), pan: param(a.pan, 0, isNum), fadeIn: Math.max(0, int(a.fadeIn, d.fadeIn)), fadeOut: Math.max(0, int(a.fadeOut, d.fadeOut)) };
  } else delete c.audio;
  opt(c, "timeRemap", isObj(v.timeRemap) ? param(v.timeRemap, 100, isNum) : undefined);
  opt(c, "connectedTo", isStr(v.connectedTo) ? v.connectedTo : undefined);
  opt(c, "connectOffset", isStr(v.connectedTo) && isNum(v.connectOffset) ? int(v.connectOffset, 0) : undefined);
  if (isObj(v.multicam) && isNum(v.multicam.angle)) {
    const m: Obj = { ...v.multicam, angle: Math.max(0, int(v.multicam.angle, 0)) };
    opt(m, "audioAngle", isNum(v.multicam.audioAngle) ? Math.max(0, int(v.multicam.audioAngle, 0)) : undefined);
    c.multicam = m;
  } else delete c.multicam;
  // editor-audio: the clip's Essential Sound role
  opt(c, "role", ROLES.includes(v.role as string) ? v.role : undefined);
  // News Room: shown in a screen layout's box
  if (isObj(v.slot) && isNum(v.slot.index)) {
    const sl: Obj = { ...v.slot, index: Math.max(0, int(v.slot.index, 0)) };
    opt(sl, "fit", v.slot.fit === "cover" || v.slot.fit === "contain" ? v.slot.fit : undefined);
    opt(sl, "zoom", isNum(v.slot.zoom) ? v.slot.zoom : undefined);
    opt(sl, "offset", isPair(v.slot.offset) ? v.slot.offset : undefined);
    c.slot = sl;
  } else delete c.slot;
  // audio-tools2: room tone placed by Room-tone fill
  opt(c, "roomTone", v.roomTone === true ? true : undefined);
  // auto-sfx: what placed this sound (a re-run replaces it)
  opt(c, "autoSfx", isObj(v.autoSfx) && isStr(v.autoSfx.rule) && isStr(v.autoSfx.sourceId) ? { ...v.autoSfx } : undefined);
  return c as unknown as TimelineClip;
}

/** News Room document (docs/EDITOR.md §16): the containers it relies on are checked; looks and templates are kept as
 *  written (they are the edit's own copies), entries that aren't objects go. */
function newsroom(v: Obj): NonNullable<EditProject["newsroom"]> {
  const objs = (x: unknown) => Object.fromEntries(Object.entries(isObj(x) ? x : {}).filter(([, y]) => isObj(y)));
  const list = (x: unknown) => arr(x).filter(isObj);
  const set = isObj(v.settings) ? v.settings : {};
  const n: Obj = {
    ...v, version: 1, look: str(v.look, "look.classic_red"), looks: objs(v.looks), templates: objs(v.templates),
    ratio: v.ratio === "9:16" || v.ratio === "both" ? v.ratio : "16:9",
    rundown: list(v.rundown), people: list(v.people), places: list(v.places), sources: list(v.sources), data: objs(v.data),
    settings: {
      ...set, safeGuides: bool(set.safeGuides, true), collision: bool(set.collision, true), readSpeed: Math.max(0.5, num(set.readSpeed, 3)),
      tickerSpeed: set.tickerSpeed === "slow" || set.tickerSpeed === "fast" ? set.tickerSpeed : "normal", aiLabel: bool(set.aiLabel, true),
    },
  };
  opt(n, "airTime", isStr(v.airTime) ? v.airTime : undefined);
  opt(n, "langs", Array.isArray(v.langs) ? (v.langs as unknown[]).filter(isStr) : undefined);
  opt(n, "playlist", Array.isArray(v.playlist) ? list(v.playlist) : undefined);
  return n as unknown as NonNullable<EditProject["newsroom"]>;
}

function transition(v: unknown): Transition | null {
  if (!isObj(v) || typeof v.trackId !== "string" || !isNum(v.at)) return null;
  const t: Obj = {
    ...v, id: str(v.id, uid("t")), trackId: v.trackId, at: int(v.at, 0), duration: Math.max(1, int(v.duration, 1)),
    alignment: v.alignment === "start" || v.alignment === "end" ? v.alignment : "center", type: str(v.type, "fade"),
    easing: ["linear", "ease_in", "ease_out", "ease_in_out"].includes(v.easing as string) ? v.easing : "linear",
  };
  opt(t, "params", isObj(v.params) ? v.params : undefined);
  opt(t, "fromClipId", isStr(v.fromClipId) ? v.fromClipId : undefined);
  opt(t, "toClipId", isStr(v.toClipId) ? v.toClipId : undefined);
  return t as unknown as Transition;
}

function sequence(v: unknown, warn: (s: string) => void): Sequence | null {
  if (!isObj(v)) return null;
  const fps = FPS_LIST.find((f) => Math.abs(f - num(v.fps, 25)) < 0.01) ?? 25;
  const base = newSequence(str(v.name, "Sequence"), { width: Math.max(16, int(v.width, 1920)), height: Math.max(16, int(v.height, 1080)), fps }, { video: 0, audio: 0 });
  const o: Obj = { ...v, ...base, id: str(v.id, base.id) };
  const seq = o as unknown as Sequence;
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
  opt(o, "inPoint", isNum(v.inPoint) ? int(v.inPoint, 0) : undefined);
  opt(o, "outPoint", isNum(v.outPoint) ? int(v.outPoint, 0) : undefined);
  seq.playhead = Math.max(0, int(v.playhead, 0));
  if (isObj(v.workArea)) seq.workArea = { ...v.workArea, zoom: num(v.workArea.zoom, 0), scroll: num(v.workArea.scroll, 0) };
  if (isObj(v.source) && isNum(v.source.pid) && isNum(v.source.eid)) {
    const src: Obj = { ...v.source, pid: v.source.pid, eid: v.source.eid, lang: str(v.source.lang, "") };
    opt(src, "cutVersion", isNum(v.source.cutVersion) || v.source.cutVersion === null ? v.source.cutVersion : undefined);
    o.source = src;
  } else delete o.source;
  opt(o, "magnetic", v.magnetic === true ? true : undefined);
  if (isObj(v.multicam) && Array.isArray(v.multicam.angles)) {
    o.multicam = {
      ...v.multicam,
      angles: arr(v.multicam.angles).filter(isObj).map((a, i) => { const x: Obj = { ...a, name: str(a.name, `Angle ${i + 1}`) }; opt(x, "mediaId", isStr(a.mediaId) ? a.mediaId : undefined); return x; }),
      syncedBy: v.multicam.syncedBy === "in" || v.multicam.syncedBy === "timeline" ? v.multicam.syncedBy : "audio",
    };
  } else delete o.multicam;
  // editor-audio: effects on the master mix
  opt(o, "masterEffects", Array.isArray(v.masterEffects) ? effects(v.masterEffects) : undefined);
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
    .map((b) => { const x: Obj = { ...b, id: b.id, name: str(b.name, "Bin"), parentId: isStr(b.parentId) ? b.parentId : null }; opt(x, "color", isStr(b.color) ? b.color : undefined); return x as unknown as Bin; });
  const binIds = new Set(bins.map((b) => b.id));
  for (const b of bins) if (b.parentId && !binIds.has(b.parentId)) b.parentId = null;
  const mediaList = arr(v.media).map((m) => media(m, warn)).filter((x): x is MediaItem => !!x)
    .map((m) => (m.binId && !binIds.has(m.binId) ? { ...m, binId: null } : m));
  let seqs = arr(v.sequences).map((s) => sequence(s, warn)).filter((x): x is Sequence => !!x);
  if (!seqs.length) { seqs = [newSequence("Sequence 01", { width: 1920, height: 1080, fps: 25 })]; warn("The edit had no sequence; an empty one was added"); }
  const set = isObj(v.settings) ? v.settings : {};
  const t = new Date().toISOString();
  const o: Obj = {
    ...v, format: FORMAT, version: VERSION, id: str(v.id, uid("p")), name: str(v.name, "Untitled edit"), created: str(v.created, t), modified: str(v.modified, t),
    bins, media: mediaList, sequences: seqs,
    activeSequenceId: seqs.some((s) => s.id === v.activeSequenceId) ? (v.activeSequenceId as string) : seqs[0].id,
    settings: {
      ...set, copyMedia: bool(set.copyMedia, false), proxy: set.proxy === "auto" || set.proxy === "always" ? set.proxy : "off",
      autosaveSeconds: Math.max(0, int(set.autosaveSeconds, DEFAULT_AUTOSAVE_S)),
    },
  };
  const project = o as unknown as EditProject;
  opt(o, "studioProjectId", isNum(v.studioProjectId) ? v.studioProjectId : undefined);
  // imported and matched LUTs (editor-looks keeps more about them: their fields stay)
  const luts = arr(v.luts).filter(isObj).filter((l) => typeof l.id === "string").map((l) => {
    const x: Obj = { ...l, id: l.id, name: str(l.name, "LUT") };
    opt(x, "path", isStr(l.path) ? l.path : undefined);
    opt(x, "size", isNum(l.size) ? l.size : undefined);
    opt(x, "url", isStr(l.url) ? l.url : undefined);
    return x as unknown as NonNullable<EditProject["luts"]>[number];
  });
  opt(o, "luts", luts.length ? luts : undefined);
  opt(o, "newsroom", isObj(v.newsroom) ? newsroom(v.newsroom) : undefined);
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
