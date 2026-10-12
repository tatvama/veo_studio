/**
 * The Tatvam Editor document on the desktop side (docs/EDITOR.md §1, §2): new projects and sequences (the same
 * defaults as frontend/src/editor/model/defaults.ts), validation of a .tatvamedit file, the on-disk ↔ runtime
 * conversion (relative paths and cache files on disk; absolute paths and gateway URLs at runtime), frame maths, export
 * ranges and names. Pure: no file system writes, no Electron. Unit tests: test/editor.test.ts.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { EditPreset, EditProject, MediaItem, Motion, Sequence, TimelineClip, Track } from "../shared/types.ts";
import { pathKey, safePart } from "./naming.ts";

export const EDIT_EXT = ".tatvamedit";
export const FORMAT = "tatvam-edit";
export const FPS_LIST = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;
export const TRACK_H = { video: 56, audio: 48 } as const;
export const DEFAULT_AUTOSAVE_S = 10;
export const MEDIA_PREFIX = "/__media/";

export const VIDEO_EXTS = ["mp4", "mov", "mkv", "webm", "m4v", "avi"];
export const AUDIO_EXTS = ["wav", "mp3", "aac", "m4a", "flac", "ogg"];
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff"];
/** Extra files the editor may serve: its own cache (thumbs, filmstrips, peaks, proxies) and LUTs. */
const CACHE_EXTS = ["json", "cube"];

export function mediaKindOf(file: string): "video" | "audio" | "image" | null {
  const e = path.extname(file).slice(1).toLowerCase();
  if (VIDEO_EXTS.includes(e)) return "video";
  if (AUDIO_EXTS.includes(e)) return "audio";
  if (IMAGE_EXTS.includes(e)) return "image";
  return null;
}
export const isServable = (file: string) => mediaKindOf(file) !== null || CACHE_EXTS.includes(path.extname(file).slice(1).toLowerCase());

export const MEDIA_FILTERS = [
  { name: "Media", extensions: [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS] },
  { name: "Video", extensions: VIDEO_EXTS },
  { name: "Audio", extensions: AUDIO_EXTS },
  { name: "Images", extensions: IMAGE_EXTS },
];

export class EditorError extends Error {}

/** Short random ids with a type prefix, like the frontend's uid(): "c_k3j9x2ab". */
export function uid(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 8)}`;
}

// ── frames (exact rationals for the NTSC rates, as frontend/src/editor/model/time.ts) ──
export function fpsRational(fps: number): [number, number] {
  if (Math.abs(fps - 23.976) < 0.01) return [24000, 1001];
  if (Math.abs(fps - 29.97) < 0.01) return [30000, 1001];
  if (Math.abs(fps - 59.94) < 0.01) return [60000, 1001];
  if (Number.isInteger(fps) && fps > 0) return [fps, 1];
  const f = fps > 0 && Number.isFinite(fps) ? fps : 30;
  return [Math.round(f * 1000), 1000];
}
export const fpsExact = (fps: number) => { const [n, d] = fpsRational(fps); return n / d; };
export function framesToSeconds(frames: number, fps: number): number {
  const [n, d] = fpsRational(fps);
  return (frames * d) / n;
}
export function secondsToFrames(s: number, fps: number): number {
  const [n, d] = fpsRational(fps);
  return Math.round((s * n) / d + 1e-9);
}
/** A probed frame rate snapped to the editor's list (23.98 → 23.976, 29.97 …), else rounded to 3 decimals. */
export function normalizeFps(f: number): number {
  if (!(f > 0) || !Number.isFinite(f)) return 0;
  for (const s of FPS_LIST) if (Math.abs(f - s) < 0.006 || (s % 1 !== 0 && Math.abs(f - s) < 0.011)) return s;
  return Math.round(f * 1000) / 1000;
}

// ── factories (frontend/src/editor/model/defaults.ts) ──
export function newTrack(kind: "video" | "audio", index: number, over: Partial<Track> = {}): Track {
  return {
    id: uid(kind === "video" ? "v" : "a"), kind, name: `${kind === "video" ? "V" : "A"}${index + 1}`, index,
    locked: false, hidden: false, muted: false, solo: false, targeted: index === 0, syncLock: true,
    height: TRACK_H[kind], volume: 0, pan: 0, ...over,
  };
}

export function newSequence(name: string, preset: EditPreset, tracks = { video: 3, audio: 3 }): Sequence {
  const ts: Track[] = [];
  for (let i = 0; i < tracks.video; i++) ts.push(newTrack("video", i));
  for (let i = 0; i < tracks.audio; i++) ts.push(newTrack("audio", i));
  return {
    id: uid("s"), name, width: preset.width, height: preset.height, fps: preset.fps, sampleRate: 48000,
    tracks: ts, clips: [], transitions: [], markers: [], playhead: 0, workArea: { zoom: 0, scroll: 0 },
  };
}

export function newProject(name: string, preset: EditPreset, now = new Date().toISOString()): EditProject {
  const seq = newSequence("Sequence 01", preset);
  return {
    format: FORMAT, version: 1, id: uid("p"), name, created: now, modified: now,
    bins: [], media: [], sequences: [seq], activeSequenceId: seq.id,
    settings: { copyMedia: false, proxy: "off", autosaveSeconds: DEFAULT_AUTOSAVE_S },
  };
}

export function defaultMotion(seq: { width: number; height: number }, pic?: { width: number; height: number }): Motion {
  const w = pic?.width || seq.width;
  const h = pic?.height || seq.height;
  return {
    position: { value: [seq.width / 2, seq.height / 2] }, scale: { value: 100 }, rotation: { value: 0 },
    anchor: { value: [w / 2, h / 2] }, opacity: { value: 100 }, blend: "normal", uniformScale: true,
  };
}

export function baseClip(seq: { width: number; height: number }, track: Track, start: number, duration: number, source: TimelineClip["source"],
  name: string, pic?: { width: number; height: number }): TimelineClip {
  const c: TimelineClip = { id: uid("c"), trackId: track.id, start, duration, source, speed: 1, reverse: false, enabled: true, name,
    motion: defaultMotion(seq, pic), effects: [] };
  if (track.kind === "audio") c.audio = { gain: { value: 0 }, pan: { value: 0 }, fadeIn: 0, fadeOut: 0 };
  return c;
}

export function validatePreset(p: unknown): EditPreset {
  const o = (p ?? {}) as Partial<EditPreset>;
  const w = Number(o.width);
  const h = Number(o.height);
  const fps = Number(o.fps);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 16 || h < 16 || w > 8192 || h > 8192 || w % 2 || h % 2) {
    throw new EditorError("The sequence size must be even whole numbers between 16 and 8192");
  }
  if (!FPS_LIST.some((f) => Math.abs(f - fps) < 1e-6)) throw new EditorError(`The frame rate must be one of ${FPS_LIST.join(", ")}`);
  return { width: w, height: h, fps };
}

/** The edit's folder and file name: naming.safePart, no reserved device names, at most 80 characters. */
export function safeEditName(name: string): string {
  let s = safePart(String(name ?? "").trim()).slice(0, 80).replace(/[-.]+$/, "");
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(s)) s = `_${s}`;
  if (!s) throw new EditorError("Give the edit a name");
  return s;
}

// ── validation ──
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Check a parsed .tatvamedit and fill what older or hand-made files may lack. Throws EditorError. */
export function validateProject(raw: unknown): EditProject {
  if (!isObj(raw) || raw.format !== FORMAT) throw new EditorError("This isn't a Tatvam edit (.tatvamedit) file");
  if (typeof raw.version !== "number") throw new EditorError("The edit file has no version");
  if (raw.version > 1) throw new EditorError(`This edit was saved by a newer Tatvam (format ${raw.version}): update the app to open it`);
  if (raw.version !== 1) throw new EditorError(`Unknown edit format version ${raw.version}`);
  if (typeof raw.id !== "string" || !raw.id) throw new EditorError("The edit file has no id");
  if (!Array.isArray(raw.sequences) || !raw.sequences.length) throw new EditorError("The edit file has no sequences");
  const p = raw as unknown as EditProject;
  p.name = typeof p.name === "string" && p.name ? p.name : "Untitled";
  p.bins = Array.isArray(p.bins) ? p.bins.filter((b) => isObj(b) && typeof b.id === "string") : [];
  p.media = Array.isArray(p.media) ? p.media : [];
  for (const m of p.media) {
    if (!isObj(m) || typeof m.id !== "string" || typeof m.path !== "string" || !["video", "audio", "image"].includes(m.kind as string)) {
      throw new EditorError("The edit file has a broken media item");
    }
    if (!Array.isArray(m.markers)) m.markers = [];
    if (m.binId === undefined) m.binId = null;
  }
  for (const s of p.sequences) {
    if (!isObj(s) || typeof s.id !== "string" || !Array.isArray(s.tracks) || !Array.isArray(s.clips)) {
      throw new EditorError("The edit file has a broken sequence");
    }
    if (!(Number(s.width) > 0) || !(Number(s.height) > 0) || !(Number(s.fps) > 0)) throw new EditorError(`Sequence ${s.name || s.id} has no size or frame rate`);
    if (!Array.isArray(s.transitions)) s.transitions = [];
    if (!Array.isArray(s.markers)) s.markers = [];
    if (typeof s.playhead !== "number") s.playhead = 0;
    s.sampleRate = 48000;
  }
  if (!p.sequences.some((s) => s.id === p.activeSequenceId)) p.activeSequenceId = p.sequences[0].id;
  const st = isObj(p.settings) ? p.settings : ({} as EditProject["settings"]);
  p.settings = {
    copyMedia: Boolean(st.copyMedia), proxy: st.proxy === "auto" || st.proxy === "always" ? st.proxy : "off",
    autosaveSeconds: Number(st.autosaveSeconds) > 0 ? Number(st.autosaveSeconds) : DEFAULT_AUTOSAVE_S,
  };
  if (typeof p.created !== "string") p.created = new Date(0).toISOString();
  if (typeof p.modified !== "string") p.modified = p.created;
  return p;
}

// ── disk ↔ runtime ──
export function isInside(dir: string, file: string): boolean {
  const d = pathKey(path.resolve(dir));
  const f = pathKey(path.resolve(file));
  return f === d || f.startsWith(`${d}/`);
}
/** "Media/a.mp4" for a file inside the edit folder, else the absolute path. */
export function relOrAbs(dir: string, file: string): string {
  return isInside(dir, file) ? path.relative(dir, file).split(path.sep).join("/") : file;
}
export function absOf(dir: string, p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.join(dir, ...p.split("/"));
}
const isRuntimeRef = (s: string) => s.startsWith(MEDIA_PREFIX) || /^(data|blob|https?):/i.test(s);

/**
 * The runtime project: absolute paths, `missing` set from the file system, `url` / thumb / filmstrip / proxyUrl as
 * gateway URLs (`register(file)` registers a file and returns its URL).
 */
export function toRuntime(project: EditProject, dir: string, io: { exists(file: string): boolean; register(file: string): string }): EditProject {
  const p = structuredClone(project);
  for (const m of p.media) {
    delete m.url;
    delete m.proxyUrl;
    if (m.path.startsWith("studio:")) {
      m.missing = true;
    } else {
      m.path = absOf(dir, m.path);
      m.missing = !io.exists(m.path);
      if (!m.missing) m.url = io.register(m.path);
    }
    for (const k of ["thumb", "filmstrip"] as const) {
      const v = m[k];
      if (!v || isRuntimeRef(v)) continue;
      const f = absOf(dir, v);
      if (io.exists(f)) m[k] = io.register(f);
      else delete m[k];
    }
    if (m.proxyPath) {
      m.proxyPath = absOf(dir, m.proxyPath);
      if (io.exists(m.proxyPath)) m.proxyUrl = io.register(m.proxyPath);
    }
  }
  return p;
}

/** The on-disk project: runtime-only fields dropped, cache URLs back to relative paths, paths inside the folder relative. */
export function toDisk(project: EditProject, dir: string, resolveUrl: (url: string) => string | null): EditProject {
  const p = structuredClone(project);
  for (const m of p.media) {
    delete m.url;
    delete m.proxyUrl;
    delete m.missing;
    if (!m.path.startsWith("studio:") && path.isAbsolute(m.path)) m.path = relOrAbs(dir, m.path);
    for (const k of ["thumb", "filmstrip"] as const) {
      const v = m[k];
      if (!v) continue;
      if (v.startsWith(MEDIA_PREFIX)) {
        const f = resolveUrl(v);
        if (f) m[k] = relOrAbs(dir, f);
        else delete m[k];
      } else if (/^(data|blob|https?):/i.test(v)) {
        delete m[k];
      }
    }
    if (m.proxyPath && path.isAbsolute(m.proxyPath)) m.proxyPath = relOrAbs(dir, m.proxyPath);
  }
  return p;
}

/** The id in a /__media/<id>/<name> URL. */
export function mediaIdOfUrl(url: string): string | null {
  const m = /^\/__media\/([A-Za-z0-9_-]{8,64})(?:\/|$)/.exec(url);
  return m ? m[1] : null;
}

// ── sequences ──
export function clipEnd(c: TimelineClip): number {
  return c.start + c.duration;
}
export function sequenceEnd(seq: Sequence): number {
  return seq.clips.reduce((m, c) => (c.enabled === false ? m : Math.max(m, clipEnd(c))), 0);
}
/** The export range in sequence frames (out exclusive): the whole sequence, or its in/out marks. */
export function exportRange(seq: Sequence, range: "all" | "inout"): { in: number; out: number } {
  const end = sequenceEnd(seq);
  if (range === "inout" && (seq.inPoint !== undefined || seq.outPoint !== undefined)) {
    const a = Math.max(0, Math.round(seq.inPoint ?? 0));
    const b = seq.outPoint !== undefined ? Math.round(seq.outPoint) + 1 : end; // the out mark is the last frame shown
    if (b > a) return { in: a, out: b };
  }
  if (end <= 0) throw new EditorError("The sequence is empty: there is nothing to export");
  return { in: 0, out: end };
}

/**
 * Output size for an edit export: "project" presets keep the sequence's shape with the preset's short side (a 1080p
 * sequence on YouTube 4K → 3840×2160, a vertical one → 2160×3840); vertical presets are used as they are.
 */
export function editDims(preset: { w: number; h: number; orientation: "project" | "vertical" }, seqW: number, seqH: number): { w: number; h: number } {
  if (preset.orientation === "vertical") return { w: preset.w, h: preset.h };
  const short = Math.min(preset.w, preset.h);
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return seqW >= seqH ? { w: even((short * seqW) / seqH), h: short } : { w: short, h: even((short * seqH) / seqW) };
}

/** `<Sequence name>_v###.<ext>`: the next version not yet in `existing` (file names in Renders\). */
export function renderName(seqName: string, ext: string, existing: string[]): string {
  const base = safePart(seqName || "Sequence").slice(0, 100) || "Sequence";
  let v = 0;
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_v(\\d+)\\.`, "i");
  for (const n of existing) {
    const m = re.exec(n);
    if (m) v = Math.max(v, Number(m[1]));
  }
  return `${base}_v${String(v + 1).padStart(3, "0")}.${ext.replace(/^\./, "")}`;
}

/** A .tatvamedit.bak.N backup name. */
export const bakName = (file: string, n: number) => `${file}.bak.${n}`;
export const MAX_BACKUPS = 10;
export const BACKUP_EVERY_MS = 60_000;

/** tatvam://editor[?path=…] → the editor route (and the file it opens, which becomes openable). null = not an editor link. */
export function editorDeepLink(url: string): { urlPath: string; file?: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "tatvam:") return null;
    const action = (u.hostname || u.pathname.replace(/^\/+/, "").split("/")[0]).toLowerCase();
    if (action !== "editor") return null;
    const file = u.searchParams.get("path");
    if (!file) return { urlPath: "/editor" };
    if (!file.toLowerCase().endsWith(EDIT_EXT) || !path.isAbsolute(file)) return { urlPath: "/editor" };
    return { urlPath: `/editor/edit?path=${encodeURIComponent(file)}`, file };
  } catch {
    return null;
  }
}

/** The media item of a project by id. */
export function mediaById(p: EditProject, id: string): MediaItem | undefined {
  return p.media.find((m) => m.id === id);
}
