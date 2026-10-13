/**
 * Shared pieces of the interchange converters (docs/EDITOR.md §12): frame rates as FCP's timebase + NTSC flag,
 * SMPTE timecode (drop-frame at 29.97 / 59.94), file paths ↔ file:// URLs, marker colours, decibels, keyframe values,
 * ids, and the "Tatvam: <name>" data markers that carry what an exchange format has no slot for.
 *
 * Self-contained on purpose (only `import type` from the editor model): the desktop's main process bundles these
 * converters too, so they must not pull in the editor's runtime modules. Pure.
 */
import type { Easing, EffectInstance, Marker, MediaItem, Param, Sequence, TimelineClip, Track, Transition } from "../model/types.ts";

// ── frame rates ──────────────────────────────────────────────────────────────

export const FPS_LIST = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;

export function fpsRational(fps: number): [number, number] {
  if (Math.abs(fps - 23.976) < 0.01) return [24000, 1001];
  if (Math.abs(fps - 29.97) < 0.01) return [30000, 1001];
  if (Math.abs(fps - 59.94) < 0.01) return [60000, 1001];
  if (Math.abs(fps - 47.952) < 0.01) return [48000, 1001];
  if (Number.isInteger(fps) && fps > 0) return [fps, 1];
  const f = fps > 0 && Number.isFinite(fps) ? fps : 30;
  return [Math.round(f * 1000), 1000];
}
export const fpsExact = (fps: number) => { const [n, d] = fpsRational(fps); return n / d; };
export const nominalFps = (fps: number) => Math.round(fpsExact(fps));
export const isNtsc = (fps: number) => fpsRational(fps)[1] === 1001;
export const isDropFrame = (fps: number) => { const [n, d] = fpsRational(fps); return d === 1001 && (n === 30000 || n === 60000); };

/** FCP's <rate>: integer timebase and the NTSC (×1000/1001) flag. */
export const rateOf = (fps: number) => ({ timebase: nominalFps(fps), ntsc: isNtsc(fps) });
/** A rate back to the editor's fps (snapped to the editor's list when it is one of them). */
export function fpsFromRate(timebase: number, ntsc: boolean): number {
  const tb = timebase > 0 && Number.isFinite(timebase) ? timebase : 25;
  const f = ntsc ? (tb * 1000) / 1001 : tb;
  return snapFps(f);
}
/** 23.976023… → 23.976, 29.97… → 29.97; anything else rounded to 3 decimals. */
export function snapFps(f: number): number {
  if (!(f > 0) || !Number.isFinite(f)) return 25;
  for (const s of FPS_LIST) if (Math.abs(fpsExact(s) - f) < 0.002 || Math.abs(s - f) < 0.002) return s;
  return Math.round(f * 1000) / 1000;
}
/** The sequence rates the editor has; others go to the nearest one (with `changed`). */
export function editorFps(f: number): { fps: number; changed: boolean } {
  const s = snapFps(f);
  if ((FPS_LIST as readonly number[]).includes(s)) return { fps: s, changed: false };
  const best = [...FPS_LIST].sort((a, b) => Math.abs(a - s) - Math.abs(b - s))[0];
  return { fps: best, changed: true };
}

export const framesToSeconds = (frames: number, fps: number) => { const [n, d] = fpsRational(fps); return (frames * d) / n; };
export const secondsToFrames = (s: number, fps: number) => s * fpsExact(fps);
/** Rounded to 1e-6 (keeps whole numbers whole after a rate conversion). */
export const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
export const r3 = (v: number) => Math.round(v * 1000) / 1000;

// ── timecode ─────────────────────────────────────────────────────────────────

const two = (v: number) => String(v).padStart(2, "0");

/** frame → HH:MM:SS:FF (HH:MM:SS;FF drop-frame at 29.97 / 59.94 unless dropFrame is false). */
export function toTimecode(frame: number, fps: number, dropFrame = isDropFrame(fps)): string {
  const neg = frame < 0;
  let f = Math.round(Math.abs(frame));
  const nom = nominalFps(fps);
  const df = dropFrame && isDropFrame(fps);
  if (df) {
    const drop = Math.round(nom / 15);
    const per10 = Math.round(fpsExact(fps) * 600);
    const perMin = nom * 60 - drop;
    const d = Math.floor(f / per10);
    const m = f % per10;
    f += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / perMin) : 0);
  }
  const ff = f % nom;
  const totalS = Math.floor(f / nom);
  return `${neg ? "-" : ""}${two(Math.floor(totalS / 3600))}:${two(Math.floor(totalS / 60) % 60)}:${two(totalS % 60)}${df ? ";" : ":"}${two(ff)}`;
}

/** HH:MM:SS:FF / HH:MM:SS;FF / HH:MM:SS.FF (dropframe when `;` is used or `dropFrame` is set at 29.97/59.94) → frame. */
export function parseTimecode(s: string, fps: number, dropFrame?: boolean): number | null {
  const m = /^\s*(-)?(\d{1,3})[:;.](\d{1,2})[:;.](\d{1,2})([:;.,])(\d{1,3})\s*$/.exec(s);
  if (!m) return null;
  const [h, mi, se, fr] = [m[2], m[3], m[4], m[6]].map((x) => parseInt(x, 10));
  const nom = nominalFps(fps);
  const df = isDropFrame(fps) && (dropFrame ?? (m[5] === ";" || m[5] === ","));
  let f = ((h * 60 + mi) * 60 + se) * nom + fr;
  if (df) {
    const drop = Math.round(nom / 15);
    const totalMin = h * 60 + mi;
    f -= drop * (totalMin - Math.floor(totalMin / 10));
  }
  return m[1] ? -f : f;
}

/** Seconds as a clock: "0:05", "1:02:05" (YouTube chapters). */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds + 1e-6));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

// ── paths and URLs ───────────────────────────────────────────────────────────

const encSeg = (seg: string) => encodeURIComponent(seg).replace(/%2C/gi, ",").replace(/%40/g, "@").replace(/%2B/gi, "+")
  .replace(/%3D/gi, "=").replace(/%26/g, "&").replace(/%24/g, "$");

/**
 * An absolute path as a file URL. `localhost`: file://localhost/D:/Media/My%20clip.mp4 (FCP 7 XML; Premiere reads it);
 * `triple`: file:///D:/Media/My%20clip.mp4 (OTIO). UNC paths keep their server: file://server/share/x.mp4.
 */
export function pathToUrl(p: string, style: "localhost" | "triple" = "localhost"): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return p;
  const s = p.replace(/\\/g, "/");
  if (s.startsWith("//")) {
    const [host, ...rest] = s.slice(2).split("/");
    return `file://${host}/${rest.map(encSeg).join("/")}`;
  }
  const m = /^([A-Za-z]):\/?(.*)$/.exec(s);
  const head = style === "localhost" ? "file://localhost/" : "file:///";
  if (m) return `${head}${m[1].toUpperCase()}:/${m[2].split("/").map(encSeg).join("/")}`;
  return `${head}${s.replace(/^\/+/, "").split("/").map(encSeg).join("/")}`;
}

/** A file URL (or a plain path) back to a path: Windows paths with backslashes, others as they are. */
export function urlToPath(u: string): string {
  let s = u.trim();
  if (!/^file:/i.test(s)) return s;
  s = s.replace(/^file:/i, "");
  let host = "";
  if (s.startsWith("//")) {
    const rest = s.slice(2);
    const slash = rest.indexOf("/");
    host = slash < 0 ? rest : rest.slice(0, slash);
    s = slash < 0 ? "/" : rest.slice(slash);
  }
  let dec: string;
  try { dec = decodeURIComponent(s); } catch { dec = s; }
  if (host && host.toLowerCase() !== "localhost") return `\\\\${host}${dec.replace(/\//g, "\\")}`;
  const drive = /^\/?([A-Za-z])[:|](\/.*)?$/.exec(dec);
  if (drive) return `${drive[1].toUpperCase()}:${(drive[2] ?? "\\").replace(/\//g, "\\")}`;
  return dec;
}

export const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
export const extOf = (p: string) => { const b = baseName(p); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i + 1).toLowerCase() : ""; };

const VIDEO_EXTS = ["mp4", "mov", "mkv", "webm", "m4v", "avi", "mxf", "mpg", "mpeg", "mts", "m2ts", "r3d", "braw"];
const AUDIO_EXTS = ["wav", "mp3", "aac", "m4a", "flac", "ogg", "aif", "aiff", "wma"];
const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff", "bmp", "psd", "exr", "dpx", "tga"];
export function kindOfPath(p: string): "video" | "audio" | "image" | null {
  const e = extOf(p);
  return VIDEO_EXTS.includes(e) ? "video" : AUDIO_EXTS.includes(e) ? "audio" : IMAGE_EXTS.includes(e) ? "image" : null;
}

// ── colours ──────────────────────────────────────────────────────────────────

export const MARKER_COLORS = ["#22d3ee", "#fbbf24", "#34d399", "#fb7185", "#a78bfa", "#60a5fa", "#f97316", "#e5e7eb"];

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 || h.length === 4 ? h.slice(0, 3).split("").map((c) => c + c).join("") : h.slice(0, 6);
  const v = parseInt(full.padEnd(6, "0"), 16);
  return Number.isFinite(v) ? [(v >> 16) & 255, (v >> 8) & 255, v & 255] : [255, 255, 255];
}
export const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("")}`;

/** OTIO's marker colour names with a representative RGB. */
export const OTIO_COLORS: [string, string][] = [
  ["PINK", "#fb7185"], ["RED", "#ef4444"], ["ORANGE", "#f97316"], ["YELLOW", "#fbbf24"], ["GREEN", "#34d399"], ["CYAN", "#22d3ee"],
  ["BLUE", "#60a5fa"], ["PURPLE", "#a78bfa"], ["MAGENTA", "#d04fb4"], ["BLACK", "#111111"], ["WHITE", "#e5e7eb"],
];
function nearest(hex: string, list: [string, string][]): string {
  const [r, g, b] = hexToRgb(hex);
  let best = list[0][0], bd = Infinity;
  for (const [name, h] of list) {
    const [x, y, z] = hexToRgb(h);
    const d = (r - x) ** 2 + (g - y) ** 2 + (b - z) ** 2;
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}
export const otioColor = (hex: string) => nearest(hex, OTIO_COLORS);
export const otioColorHex = (name: string) => OTIO_COLORS.find(([n]) => n === String(name).toUpperCase())?.[1] ?? MARKER_COLORS[0];

/** Premiere's eight marker colours (its scripting order); a colour index 0..7 → hex. */
export const PREMIERE_MARKER_COLORS: [string, string][] = [
  ["Green", "#34d399"], ["Red", "#ef4444"], ["Purple", "#a78bfa"], ["Orange", "#f97316"], ["Yellow", "#fbbf24"], ["White", "#e5e7eb"],
  ["Blue", "#60a5fa"], ["Cyan", "#22d3ee"],
];

/** Premiere's clip label colours (the editor's LABEL_COLORS ids, model/defaults.ts). */
export const LABELS = ["violet", "iris", "caribbean", "lavender", "cerulean", "forest", "rose", "mango", "purple", "blue", "teal", "magenta",
  "tan", "green", "brown", "yellow"];
export const SOUND_ROLES = ["dialogue", "music", "sfx", "ambience"] as const;
export type SoundRole = (typeof SOUND_ROLES)[number];
/** A role read from a file (untrusted text) → one of the editor's, else undefined. */
export const asRole = (x: unknown): SoundRole | undefined => (SOUND_ROLES as readonly unknown[]).includes(x) ? (x as SoundRole) : undefined;
export const roleLabel = (r: string) => (r === "sfx" ? "SFX" : r[0].toUpperCase() + r.slice(1));
export function roleOf(label: string): SoundRole | null {
  const l = label.trim().toLowerCase();
  if (l === "dialog" || l === "dialogue" || l === "voice" || l === "vo") return "dialogue";
  if (l === "music" || l === "score") return "music";
  if (l === "sfx" || l === "sound effects" || l === "effects" || l === "fx") return "sfx";
  if (l === "ambience" || l === "ambient" || l === "room tone") return "ambience";
  return null;
}

// ── levels ───────────────────────────────────────────────────────────────────

export const dbToLin = (db: number) => (db <= -96 ? 0 : 10 ** (db / 20));
export const linToDb = (v: number) => (v <= 1e-5 ? -96 : 20 * Math.log10(v));

/** A parameter's value at a (clip-relative) frame: linear between keyframes (hold keeps), held before / after. */
export function valueAt(p: Param<number> | undefined, f: number, d = 0): number {
  if (!p) return d;
  const ks = p.keyframes ?? [];
  if (!ks.length) return Number.isFinite(Number(p.value)) ? Number(p.value) : d;
  if (f <= ks[0].frame) return Number(ks[0].value);
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], b = ks[i + 1];
    if (f >= a.frame && f <= b.frame) {
      if (a.ease === "hold" || b.frame <= a.frame) return Number(a.value);
      return Number(a.value) + ((Number(b.value) - Number(a.value)) * (f - a.frame)) / (b.frame - a.frame);
    }
  }
  return Number(ks[ks.length - 1].value);
}
export const keyed = (p: Param<unknown> | undefined) => !!p?.keyframes?.length;

/** Average speed multiplier of a speed ramp over the clip (1 without one); straight segments, holds kept. */
export function rampAverage(c: Pick<TimelineClip, "timeRemap" | "duration">): number {
  const p = c.timeRemap;
  if (!p) return 1;
  let s = 0;
  const n = Math.max(1, c.duration);
  for (let f = 0; f < n; f++) s += Math.max(0, Math.min(1000, valueAt(p, f + 0.5, 100))) / 100;
  return s / n;
}
export function hasRamp(c: Pick<TimelineClip, "timeRemap">): boolean {
  return !!c.timeRemap && (!!c.timeRemap.keyframes?.length || Math.abs(Number(c.timeRemap.value) - 100) > 1e-6);
}

// ── ids ──────────────────────────────────────────────────────────────────────

export type IdFn = (prefix: string) => string;
/** Random ids like the editor's ("c_k3j9x2ab"); `seed` makes them repeatable (tests). */
export function makeIds(seed?: number): IdFn {
  let s = seed ?? null, k = 0;
  return (prefix: string) => {
    k++;
    let r: string;
    if (s !== null) { s = (s * 1103515245 + 12345) & 0x7fffffff; r = s.toString(36).padStart(6, "0").slice(-6); }
    else {
      const c = (globalThis as { crypto?: { getRandomValues?(a: Uint32Array): Uint32Array } }).crypto;
      if (c?.getRandomValues) { const a = new Uint32Array(2); c.getRandomValues(a); r = (a[0].toString(36) + a[1].toString(36)).slice(0, 8); }
      else r = Math.random().toString(36).slice(2, 10);
    }
    return `${prefix}_${r}${(k % 1296).toString(36).padStart(2, "0")}`;
  };
}

// ── the model's optional fields (added by other parts of the editor; read loosely) ──

export type Role = SoundRole;
export const clipRole = (c: TimelineClip) => (c as { role?: string }).role;
export const trackRole = (t: Track) => (t as { role?: string }).role;
export const trackEffects = (t: Track): EffectInstance[] => ((t as { effects?: EffectInstance[] }).effects ?? []);
export const masterEffects = (s: Sequence): EffectInstance[] => ((s as { masterEffects?: EffectInstance[] }).masterEffects ?? []);
/** A generator clip's source ("generate"; "generator" tolerated): the kind and its params. */
export function generatorOf(c: TimelineClip): { generator: string; params: Record<string, Param<unknown>> } | null {
  const s = c.source as unknown as { type: string; generator?: string; params?: Record<string, Param<unknown>> };
  return (s.type === "generate" || s.type === "generator") && typeof s.generator === "string" ? { generator: s.generator, params: s.params ?? {} } : null;
}
export const GENERATOR_LABELS: Record<string, string> = { tone: "Tone", noise: "Noise", dtmf: "DTMF tones" };

// ── "Tatvam: <name>" data markers ───────────────────────────────────────────

/** What an exchange format can't carry, kept as a marker named "Tatvam: <label>" with the exact data as JSON in the
 *  comment. Tatvam reads them back (the effect returns as it was); other apps show them as notes. */
export type TatvamNote =
  | { kind: "effect"; effect: EffectInstance }
  | { kind: "motion"; motion: TimelineClip["motion"] }
  | { kind: "timeRemap"; timeRemap: Param<number> }
  | { kind: "transition"; side: "in" | "out"; type: string; params?: Record<string, unknown>; easing?: Easing; alignment?: Transition["alignment"] }
  | { kind: "source"; source: TimelineClip["source"] }
  | { kind: "clip"; colorLabel?: string; role?: string; blend?: string }
  | { kind: "tracks"; tracks: TrackNote[]; masterEffects?: EffectInstance[] }
  | { kind: "item"; track: string; start: number; duration?: number; source: TimelineClip["source"]; name: string; effects?: EffectInstance[];
      motion?: TimelineClip["motion"]; enabled?: boolean };
export interface TrackNote {
  kind: "video" | "audio"; index: number; name?: string; volume?: number; pan?: number; solo?: boolean; muted?: boolean; hidden?: boolean;
  role?: string; effects?: EffectInstance[];
}

export const NOTE_PREFIX = "Tatvam: ";
export function noteMarker(label: string, note: TatvamNote): { name: string; comment: string } {
  return { name: `${NOTE_PREFIX}${label}`, comment: JSON.stringify({ tatvam: 1, ...note }) };
}
/** The data of a "Tatvam: …" marker, or null for an ordinary marker. */
export function readNote(name: string, comment: string | undefined): TatvamNote | null {
  if (!name.startsWith(NOTE_PREFIX) || !comment) return null;
  const s = comment.trim();
  if (!s.startsWith("{")) return null;
  try {
    const v = JSON.parse(s) as { tatvam?: number; kind?: string };
    return v && v.tatvam === 1 && typeof v.kind === "string" ? (v as unknown as TatvamNote) : null;
  } catch {
    return null;
  }
}

/** The label of an effect for its marker: the registry's label when the caller gives one, else its id. */
export type LabelFn = (type: string) => string | undefined;
export function effectLabel(type: string, labelFor?: LabelFn): string {
  const l = labelFor?.(type);
  if (l) return l;
  return type.startsWith("audio:") ? type.slice(6) : type;
}

// ── the media item's rate for clip positions ───────────────────────────────

/** Source frames per second of a media item (audio: its sample rate; images / unknown: the sequence's rate). */
export const mediaRate = (m: MediaItem | undefined, seqFps: number) => (m && m.fps > 0 && m.kind !== "image" ? fpsExact(m.fps) : fpsExact(seqFps));

/** A deterministic UUID-looking string from any text (FCP's <uuid>). */
export function uuidOf(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9, h4 = 0x7f4a7c15;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822507) >>> 0;
    h3 = Math.imul(h3 ^ c, 3266489909) >>> 0; h4 = Math.imul(h4 ^ c, 668265263) >>> 0;
  }
  const hex = [h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The editor's default title (model/defaults.ts defaultTitle). */
export function defaultTitleSpec(text: string): Extract<TimelineClip["source"], { type: "title" }>["text"] {
  return {
    text, font: "Inter Variable", size: 96, color: "#ffffff", weight: 700, align: "center",
    shadow: { color: "#000000aa", blur: 12, x: 0, y: 4 }, box: [0.1, 0.38, 0.8, 0.24], animIn: "fade", animOut: "fade",
  };
}

export const isMarkerKind = (k: unknown): k is Marker["kind"] => k === "beat" || k === "chapter" || k === "comment" || k === "scene";
