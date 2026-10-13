/**
 * The visualiser as a generated picture (docs/EDITOR.md §15.4), through editor/engine.ts like every other generated
 * picture, so the program monitor, `get_frame` and the hidden export window draw it the same way:
 *  - `withVisualizers` (called by buildComposition) turns each visualiser clip of the composition into a custom
 *    source URL `gen:viz:<path><clip id>` and records what to draw: the settings, the spectrum frames' key, and how
 *    the clip's time maps to the audio's media time (an audio clip's own position, trim and speed);
 *  - `makeVisualizerCanvas` is that custom source: a canvas drawn per spectrum frame, `version(t)` changing only when
 *    the frame (or, for particles, the video frame) does or a GPU reset blanked the canvas, `bounds(t)` the box it
 *    draws in.
 * The spectrum frames live in a cache here: the editor fills it from the desktop's sidecar (or the page's own
 * analysis) through `setSpectrumLoader`; an export's project carries them (`project.spectra`, put there by the
 * desktop), so the render window draws the very same numbers.
 */
import type { Composition, CustomSource } from "../../engine/index.ts";
import { watchCanvas } from "../../engine/sources/canvasLoss.ts";
import type { CompositionResult } from "../model/toComposition.ts";
import { fpsExact, framesToSeconds } from "../model/time.ts";
import type { EditProject, Sequence, TimelineClip } from "../model/types.ts";
import { clipEnd } from "../model/ops.ts";
import { frameAt, fromSidecar, spectrumKey, type SpectrumData } from "./spectrum.ts";
import { drawVisualizer, frameValues, visualizerSettings, type VisualizerSettings, type VisualizerSource } from "./visualizer.ts";

export interface VisualizerGenerated {
  kind: "visualizer";
  /** Spectrum cache key ("" when the visualiser has no audio). */
  key: string; mediaId: string; fps: number; bands: number;
  settings: VisualizerSettings; width: number; height: number;
  /** Media seconds = offset + source time · rate; the audio plays media seconds [lo, hi) (silence outside). */
  offset: number; rate: number; lo: number; hi: number;
  /** The sequence's frame rate (particles move per video frame). */
  seqFps: number;
}
export const isVisualizerGenerated = (g: unknown): g is VisualizerGenerated => !!g && typeof g === "object" && (g as { kind?: unknown }).kind === "visualizer";

// ── the spectrum cache ─────────────────────────────────────────────────────────────────────────────────────

export interface SpectrumRequest { mediaId: string; fps: number; bands: number; key: string }
export type SpectrumLoader = (req: SpectrumRequest) => Promise<SpectrumData | null>;

const spectra = new Map<string, SpectrumData>();
let generation = 0;
const subs = new Set<() => void>();
let loader: SpectrumLoader | null = null;
const pending = new Map<string, Promise<SpectrumData | null>>();
const failedAt = new Map<string, number>();

/** Where missing spectrum frames come from (the editor sets it: desktop sidecar / analysis, or the page's own). */
export function setSpectrumLoader(fn: SpectrumLoader | null) { loader = fn; }
/** Called when frames arrive (the editor redraws). */
export function onSpectra(cb: () => void) { subs.add(cb); return () => { subs.delete(cb); }; }
export const cachedSpectrum = (key: string) => spectra.get(key) ?? null;

export function putSpectrum(d: SpectrumData, notify = true) {
  spectra.set(spectrumKey(d.mediaId, d.fps, d.bands), d);
  failedAt.delete(spectrumKey(d.mediaId, d.fps, d.bands));
  generation++;
  if (spectra.size > 64) spectra.delete(spectra.keys().next().value as string);
  if (notify) subs.forEach((f) => { try { f(); } catch { /* a listener's problem */ } });
}
/** Drops a media's frames (its file changed). */
export function forgetSpectra(mediaId?: string) {
  for (const k of [...spectra.keys()]) if (!mediaId || k.startsWith(`${mediaId}|`)) spectra.delete(k);
  generation++;
}

/** The frames for a media at a frame rate and band count: cached, else loaded once (a failure waits 20 s before a retry). */
export function requestSpectrum(mediaId: string, fps: number, bands: number): Promise<SpectrumData | null> {
  const key = spectrumKey(mediaId, fps, bands);
  const hit = spectra.get(key);
  if (hit) return Promise.resolve(hit);
  const p = pending.get(key);
  if (p) return p;
  if (!loader || Date.now() - (failedAt.get(key) ?? 0) < 20_000) return Promise.resolve(null);
  const run = loader({ mediaId, fps, bands, key }).then((d) => {
    if (d) putSpectrum(d); else failedAt.set(key, Date.now());
    return d;
  }, () => { failedAt.set(key, Date.now()); return null; }).finally(() => pending.delete(key));
  pending.set(key, run);
  return run;
}

// ── the composition pass ───────────────────────────────────────────────────────────────────────────────────

/** What a visualiser clip draws, from its sequence and the project's media. */
export function visualizerGenerated(project: EditProject, seq: Sequence, c: TimelineClip, width: number, height: number): VisualizerGenerated {
  const src = c.source as VisualizerSource;
  const s = visualizerSettings(src);
  const fps = seq.fps;
  let mediaId = "", offset = s.offset, rate = 1, lo = 0, hi = 1e9;
  const a = src.audioClipId ? seq.clips.find((x) => x.id === src.audioClipId) : undefined;
  if (a && a.source.type === "media") {
    const aSrc = a.source;
    mediaId = aSrc.mediaId;
    const m = project.media.find((x) => x.id === aSrc.mediaId);
    const mfps = m && m.fps > 0 ? m.fps : fps;
    const aIn = framesToSeconds(aSrc.in, mfps);
    const sp = a.speed > 0 ? a.speed : 1;
    rate = sp;
    offset = aIn + (framesToSeconds(c.start, fps) - framesToSeconds(a.start, fps)) * sp;
    lo = aIn; hi = aIn + framesToSeconds(a.duration, fps) * sp;
    if (!a.enabled) hi = lo;
  } else if (a && a.source.type === "nested") {
    // a nested sequence's sound (an audiogram's dialogue mix, templates/audiogram.ts): the visualiser draws the first
    // audio clip inside the nested clip's window (silence before and after it)
    const ns = project.sequences.find((x) => x.id === (a.source as { sequenceId: string }).sequenceId);
    const win0 = Math.round(a.source.in), win1 = win0 + a.duration;
    const audio = new Set(ns ? ns.tracks.filter((t) => t.kind === "audio").map((t) => t.id) : []);
    const inner = ns?.clips.filter((x) => audio.has(x.trackId) && x.source.type === "media" && x.enabled && clipEnd(x) > win0 && x.start < win1)
      .sort((x, y) => x.start - y.start)[0];
    if (ns && inner && inner.source.type === "media" && a.speed === 1 && fpsExact(ns.fps) === fpsExact(fps)) {
      const iSrc = inner.source;
      mediaId = iSrc.mediaId;
      const m = project.media.find((x) => x.id === iSrc.mediaId);
      const mfps = m && m.fps > 0 ? m.fps : fps;
      const iIn = framesToSeconds(iSrc.in, mfps);
      const sp = inner.speed > 0 ? inner.speed : 1;
      rate = sp;
      // nested frame of the visualiser's start, then that frame's media time in the inner clip
      offset = iIn + framesToSeconds(win0 + (c.start - a.start) - inner.start, fps) * sp;
      lo = iIn + framesToSeconds(Math.max(0, win0 - inner.start), fps) * sp;
      hi = iIn + framesToSeconds(Math.min(clipEnd(inner), win1) - inner.start, fps) * sp;
      if (!a.enabled) hi = lo;
    }
  } else if (src.mediaId) mediaId = src.mediaId;
  const key = mediaId ? spectrumKey(mediaId, fps, s.bands) : "";
  return { kind: "visualizer", key, mediaId, fps, bands: s.bands, settings: s, width, height, offset, rate, lo, hi, seqFps: fps };
}

/**
 * The visualiser clips of a built composition (generic video tracks, nested ones too) become custom sources. Frames
 * the desktop attached to an export's project (`project.spectra`) go into the cache; missing ones are requested.
 */
export function withVisualizers(project: EditProject, sequenceId: string, r: CompositionResult): CompositionResult {
  const inline = (project as { spectra?: Record<string, unknown> }).spectra;
  if (inline && typeof inline === "object") {
    for (const v of Object.values(inline)) {
      const d = fromSidecar(v);
      if (d && !spectra.has(spectrumKey(d.mediaId, d.fps, d.bands))) putSpectrum(d, false);
    }
  }
  const seqs = new Map(project.sequences.map((s) => [s.id, s]));
  const root = seqs.get(sequenceId);
  if (!root) return r;
  const walk = (comp: Composition, seq: Sequence, path: string, depth: number) => {
    const byId = new Map(seq.clips.map((c) => [c.id, c]));
    for (const t of comp.tracks) {
      for (let i = 0; i < t.clips.length; i++) {
        const c = t.clips[i];
        const pc = byId.get(c.id);
        if (c.comp && pc?.source.type === "nested" && depth < 5) {
          const ns = seqs.get(pc.source.sequenceId);
          if (ns) walk(c.comp, ns, `${path}${c.id}/`, depth + 1);
          continue;
        }
        if (pc?.source.type !== "visualizer") continue;
        const g = visualizerGenerated(project, seq, pc, comp.width, comp.height);
        const url = `gen:viz:${path}${c.id}`;
        (r.generated as Record<string, unknown>)[url] = g;
        t.clips[i] = { ...c, type: "media", media: { url, kind: "video", width: comp.width, height: comp.height } };
        if (g.key && !spectra.has(g.key)) void requestSpectrum(g.mediaId, g.fps, g.bands);
      }
    }
  };
  walk(r.comp, root, "", 0);
  return r;
}

// ── the custom source ──────────────────────────────────────────────────────────────────────────────────────

/** The canvas a visualiser clip draws into (the engine uploads it only when `version` changes). */
export function makeVisualizerCanvas(g: VisualizerGenerated): CustomSource {
  const c = document.createElement("canvas");
  c.width = Math.max(2, g.width); c.height = Math.max(2, g.height);
  const ctx = c.getContext("2d")!;
  const specFps = fpsExact(g.fps);
  const frameOf = (t: number) => frameAt(g.offset + t * g.rate, g.fps);
  const inRange = (k: number) => { const mt = k / specFps; return mt >= g.lo - 1e-6 && mt < g.hi; };
  // a GPU reset brings the canvas back blank: drawn again (engine/sources/canvasLoss.ts)
  const restores = watchCanvas(c);
  const keyAt = (t: number) => {
    const d = g.key ? spectra.get(g.key) : undefined;
    return `${d ? generation : -1}|${restores()}|${frameOf(t)}|${g.settings.style === "particles" ? Math.floor(t * fpsExact(g.seqFps) + 1e-4) : ""}`;
  };
  let last = "", vKey = "", vNum = 0;
  let box: [number, number, number, number] | null = [0, 0, c.width, c.height];
  return {
    kind: "canvas", width: c.width, height: c.height,
    version(t: number) { const k = keyAt(t); if (k !== vKey) { vKey = k; vNum++; } return vNum; },
    draw(t: number) {
      const k = keyAt(t);
      if (k !== last) {
        last = k;
        const spec = g.key ? spectra.get(g.key) ?? null : null;
        const v = frameValues(spec, frameOf(t), g.settings, inRange);
        box = drawVisualizer(ctx, c.width, c.height, v, g.settings, t);
      }
      return c;
    },
    bounds: () => box,
  };
}
