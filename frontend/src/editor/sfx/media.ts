/**
 * Generated sounds as media of the edit (docs/EDITOR.md §15.1). A sound is rendered (in a worker on the page), encoded
 * as a 24-bit WAV and, on the desktop, written into `<edit>\Audio\SFX\<preset>_<seed>.wav` by
 * `bridge.editor.writeGeneratedMedia` (the same content is reused, never written twice), which returns the probed
 * MediaItem. In a browser (the demo) it stays an in-memory object URL. Preview and export both play that WAV.
 *
 * Everything that changes the document goes through the EditorHost as one undoable command. Node-safe: the bridge is
 * read from `globalThis`, the worker is only loaded on a page.
 */
import type { EditorBridge } from "../../lib/desktop.ts";
import type { EditorHost, EditProject, MediaItem, Sequence, Track } from "../model/types.ts";
import { mediaSpan } from "../model/defaults.ts";
import { uid } from "../model/ids.ts";
import { addTrack, clipEnd, clipsFromMedia, ctxOf, placeClips, tracksOf } from "../model/ops.ts";
import { DEFAULT_SEED, isCustom, renderSfx, resolveValues, sfxKey, sfxPreset, SFX_SAMPLE_RATE } from "./engine.ts";
import { peaksOf } from "./level.ts";
import { encodeWav } from "./wav.ts";

export const SFX_BIN = "Sound effects";
export const SFX_TRACK = "SFX";

/** The bridge method (missing in older desktop builds). */
type GenBridge = Pick<EditorBridge, "writeGeneratedMedia">;
const bridge = (): GenBridge | null => (globalThis as { tatvamDesktop?: { editor?: GenBridge } }).tatvamDesktop?.editor ?? null;

/** How sounds are rendered for media: in a worker on a page (when it can load), else right here. */
export type SfxRenderer = (id: string, values: Record<string, number>, seed: number) => Promise<Float32Array[]>;
let renderer: SfxRenderer = async (id, values, seed) => {
  if (typeof window !== "undefined" && typeof Worker !== "undefined") {
    try { const m = await import("./client.ts"); return (await m.renderInWorker(id, values, seed)).channels; } catch { /* render here */ }
  }
  return renderSfx(id, values, seed);
};
export function setSfxRenderer(r: SfxRenderer) { renderer = r; }

/** `<preset>_<seed>.wav`: the file name the desktop saves a sound under. */
export const sfxFileName = (id: string, seed: number) => `${id}_${Math.trunc(seed) >>> 0}.wav`;
const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

/** The bin name of a sound: the preset's name, then the seed when it isn't the default and "custom" for edited params. */
export function sfxMediaName(id: string, values: Record<string, number> = {}, seed = DEFAULT_SEED): string {
  const p = sfxPreset(id);
  const s = Math.trunc(seed) >>> 0;
  return `${p?.name ?? id}${s !== DEFAULT_SEED ? ` #${s}` : ""}${isCustom(id, values) ? " (custom)" : ""}`;
}
function sfxComment(id: string, values: Record<string, number>, seed: number): string {
  const v = resolveValues(id, values);
  return `Generated sound effect ${id}, seed ${Math.trunc(seed) >>> 0}: ${Object.entries(v).map(([k, x]) => `${k} ${Number(x.toPrecision(4))}`).join(", ")}`;
}

/** Sounds already made this session: `<edit path>|<sound key>` → media. */
const made = new Map<string, MediaItem>();
let warnedOld = false;

/**
 * Renders and saves a sound, returning its MediaItem (not yet in the project: `ensureSfxMedia` / `placeSfx` add it).
 * The same preset, values and seed give the same item again (and the project's own copy when it has one).
 */
export async function prepareSfxMedia(host: EditorHost, id: string, values: Record<string, number> = {}, seed = DEFAULT_SEED): Promise<MediaItem> {
  if (!sfxPreset(id)) throw new Error(`No sound effect "${id}"`);
  const v = resolveValues(id, values), s = Math.trunc(seed) >>> 0, key = sfxKey(id, v, s), path = host.path(), memoKey = `${path}|${key}`;
  const memo = made.get(memoKey);
  if (memo) return host.project().media.find((m) => samePath(m.path, memo.path)) ?? memo;
  const ch = await renderer(id, v, s);
  const bytes = encodeWav(ch, SFX_SAMPLE_RATE);
  const name = sfxMediaName(id, v, s), comment = sfxComment(id, v, s);
  const b = bridge();
  let item: MediaItem;
  if (path && b?.writeGeneratedMedia) {
    const got = await b.writeGeneratedMedia(path, sfxFileName(id, s), bytes, "audio");
    item = host.project().media.find((m) => samePath(m.path, got.path)) ?? { ...got, name, comment, peaks: got.peaks?.length ? got.peaks : peaksOf(ch, 200) };
  } else {
    if (path && !warnedOld) { warnedOld = true; host.toast("This version of Tatvam Desktop can't save generated sounds into the edit yet: they play for this session only", "warn"); }
    const frames = ch[0].length;
    item = {
      id: uid("m"), binId: null, name, kind: "audio", path: `memory:sfx/${key}/${sfxFileName(id, s)}`,
      url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: "audio/wav" })),
      duration: frames, fps: SFX_SAMPLE_RATE, width: 0, height: 0, hasAudio: true, audioChannels: 2, sampleRate: SFX_SAMPLE_RATE,
      seconds: Math.round((frames / SFX_SAMPLE_RATE) * 1000) / 1000, markers: [], peaks: peaksOf(ch, 200), comment,
    };
  }
  made.set(memoKey, item);
  return item;
}

/** The media item in a draft project (added, with the "Sound effects" bin, when it isn't there). */
function intoDraft(d: EditProject, item: MediaItem): MediaItem {
  const have = d.media.find((m) => samePath(m.path, item.path));
  if (have) return have;
  let bin = d.bins.find((x) => x.name === SFX_BIN && !x.parentId);
  if (!bin) { bin = { id: uid("b"), name: SFX_BIN, parentId: null }; d.bins.push(bin); }
  const m: MediaItem = { ...item, binId: bin.id };
  d.media.push(m);
  return m;
}

/** Adds a prepared sound to the edit's media, in the "Sound effects" bin: one undo step (none when it's there). */
export function ensureSfxMedia(host: EditorHost, item: MediaItem): MediaItem {
  const have = host.project().media.find((m) => samePath(m.path, item.path));
  if (have) return have;
  host.apply(`Add sound effect ${item.name}`, (d) => { intoDraft(d, item); });
  return host.project().media.find((m) => samePath(m.path, item.path)) ?? item;
}

/** Renders, saves (desktop: bridge.editor.writeGeneratedMedia) and imports a sound into the edit; returns the MediaItem. */
export async function addSfxMedia(host: EditorHost, id: string, values: Record<string, number> = {}, seed = DEFAULT_SEED): Promise<MediaItem> {
  return ensureSfxMedia(host, await prepareSfxMedia(host, id, values, seed));
}

const isSfxTrack = (t: Track) => t.kind === "audio" && (t.role === "sfx" || /^sfx(\s+\d+)?$/i.test(t.name));

/**
 * The SFX track for a sound at [at, at + len): `prefer` when it's an unlocked audio track, else the first SFX track
 * (role "sfx") that is free there, else a new one ("SFX", "SFX 2" …) on top of the audio tracks.
 */
export function sfxTrack(s: Sequence, at: number, len: number, prefer?: string): { seq: Sequence; trackId: string } {
  const want = prefer ? s.tracks.find((t) => t.id === prefer && t.kind === "audio" && !t.locked) : undefined;
  if (want) return { seq: s, trackId: want.id };
  const sfx = tracksOf(s, "audio").filter((t) => isSfxTrack(t) && !t.locked);
  const free = sfx.find((t) => !s.clips.some((c) => c.trackId === t.id && c.start < at + len && clipEnd(c) > at));
  if (free) return { seq: s, trackId: free.id };
  const r = addTrack(s, "audio");
  const name = sfx.length ? `${SFX_TRACK} ${sfx.length + 1}` : SFX_TRACK;
  return { seq: { ...r.seq, tracks: r.seq.tracks.map((t) => (t.id === r.trackId ? { ...t, name, role: "sfx" as const } : t)) }, trackId: r.trackId };
}

export interface PlaceSfxOpts { at: number; trackId?: string; gainDb?: number; name?: string; label?: string }

/** Puts a prepared sound on the timeline at `at` (sequence frames) on an SFX track, adding the media (and its bin) when
 *  they're new and the track when it's missing: ONE undo step. Returns the new clip's id ("" when nothing was placed). */
export function placeSfx(host: EditorHost, item: MediaItem, o: PlaceSfxOpts): string {
  let clipId = "";
  const name = o.name ?? item.name;
  host.apply(o.label ?? `Add sound effect ${name}`, (d) => {
    const m = intoDraft(d, item);
    const i = d.sequences.findIndex((x) => x.id === d.activeSequenceId);
    if (i < 0) return;
    const at = Math.max(0, Math.round(o.at)), s0 = d.sequences[i];
    const len = mediaSpan(m, s0.fps).frames;
    const r = sfxTrack(s0, at, len, o.trackId);
    const cs = clipsFromMedia(r.seq, m, at, { audioTrackId: r.trackId, video: false, audio: true, name });
    if (!cs.length) return;
    const c = cs[0];
    c.role = "sfx";
    if (o.gainDb !== undefined && c.audio) c.audio = { ...c.audio, gain: { value: Math.round(o.gainDb * 10) / 10 } };
    clipId = c.id;
    d.sequences[i] = placeClips(r.seq, ctxOf(d), cs, "overwrite");
  });
  return clipId;
}
