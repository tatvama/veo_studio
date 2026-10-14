/**
 * Spectrum frames for the audio-reactive visualiser (docs/EDITOR.md §15.4): for every video frame of a sequence's
 * frame rate, `bands` log-spaced bands from 30 Hz to 16 kHz plus the frame's level, one byte each. Computed once per
 * media + fps + bands from 32 kHz mono (FFmpeg's on the desktop, an OfflineAudioContext's in a plain browser) with a
 * 2048-point Hann FFT centred on the frame, and stored in a sidecar (`<edit>/.tatvam/spectrum-…json`), so the preview
 * and the export draw the very same numbers.
 *
 * Frame n covers media time [n / fps, (n + 1) / fps). A band's value is the peak amplitude of its FFT bins (a
 * full-scale sine reads 0 dB), or the amplitude interpolated at its centre when it holds no bin; the level is the
 * frame's RMS. Bytes map −96 … 0 dB to 0 … 255. Pure: no DOM.
 */
import { ampDb, fft, fromBase64, hann, powDb, SampleQueue, toBase64 } from "./dsp.ts";
import { fpsExact } from "../model/time.ts";

export const SPECTRUM_RATE = 32000;
export const SPECTRUM_FFT = 2048;
export const SPECTRUM_BANDS = 64;
export const SPECTRUM_FMIN = 30;
export const SPECTRUM_FMAX = 16000;
export const SPECTRUM_FLOOR_DB = -96;
export const SPECTRUM_FORMAT = "tatvam-spectrum";

export interface SpectrumData {
  mediaId: string; fps: number; bands: number; fMin: number; fMax: number;
  frames: number;
  /** frames × (bands + 1) bytes: the bands, then the level. */
  data: Uint8Array;
}

/** What a sidecar holds (JSON). `source` identifies the media file it was made from (size, mtime), so a relink redoes it. */
export interface SpectrumSidecar {
  format: typeof SPECTRUM_FORMAT; version: 1;
  mediaId: string; fps: number; bands: number; fMin: number; fMax: number; rate: number; fft: number; floorDb: number;
  frames: number; data: string;
  source?: { size: number; mtimeMs: number };
}

export const toByte = (db: number) => Math.max(0, Math.min(255, Math.round(((db - SPECTRUM_FLOOR_DB) / -SPECTRUM_FLOOR_DB) * 255)));
export const fromByte = (b: number) => SPECTRUM_FLOOR_DB + (b / 255) * -SPECTRUM_FLOOR_DB;

/** The frame-rate part of a sidecar name / cache key: 25 → "25", 29.97 → "29.97". */
export const fpsTag = (fps: number) => String(Math.round(fps * 1000) / 1000);
/** The cache key of a media's frames at a frame rate and band count. */
export const spectrumKey = (mediaId: string, fps: number, bands = SPECTRUM_BANDS) => `${mediaId}|${fpsTag(fps)}|${bands}`;
/** Its sidecar name (letters, digits, _ . -; at most 64). */
export function spectrumSidecarName(mediaId: string, fps: number, bands = SPECTRUM_BANDS): string {
  const id = mediaId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 36) || "media";
  return `spectrum-${id}-${fpsTag(fps)}-${bands}`.replace(/\.\.+/g, ".").slice(0, 64);
}

/** Band edges (bands + 1 frequencies, log-spaced). */
export function bandEdges(bands = SPECTRUM_BANDS, fMin = SPECTRUM_FMIN, fMax = SPECTRUM_FMAX): number[] {
  const r = Math.log(fMax / fMin);
  return Array.from({ length: bands + 1 }, (_, i) => fMin * Math.exp((r * i) / bands));
}

/** Streams 32 kHz mono samples in, spectrum frames out (frame by frame as soon as its window is complete). */
export class SpectrumBuilder {
  readonly fps: number; readonly bands: number; readonly rate: number;
  private spf: number;
  private q = new SampleQueue();
  private next = 0;
  private out: Uint8Array[] = [];
  private win = hann(SPECTRUM_FFT);
  private winSum: number;
  private re = new Float64Array(SPECTRUM_FFT); private im = new Float64Array(SPECTRUM_FFT); private mag = new Float64Array(SPECTRUM_FFT / 2 + 1);
  private span: Float64Array;
  private bins: { k0: number; k1: number; fc: number }[];

  constructor(fps: number, bands = SPECTRUM_BANDS, rate = SPECTRUM_RATE) {
    this.fps = fps; this.bands = bands; this.rate = rate;
    this.spf = rate / fpsExact(fps);
    this.winSum = this.win.reduce((s, x) => s + x, 0);
    this.span = new Float64Array(Math.ceil(this.spf) + 1);
    const df = rate / SPECTRUM_FFT;
    const e = bandEdges(bands, SPECTRUM_FMIN, Math.min(SPECTRUM_FMAX, rate / 2));
    const top = SPECTRUM_FFT / 2;
    this.bins = Array.from({ length: bands }, (_, b) => ({ k0: Math.min(top, Math.ceil(e[b] / df)), k1: Math.min(top, Math.ceil(e[b + 1] / df) - 1), fc: Math.sqrt(e[b] * e[b + 1]) / df }));
  }

  get frames() { return this.out.length; }

  push(x: Float32Array) {
    this.q.push(x);
    this.drain(false);
  }

  /** The rest of the frames (the last one may be partial) and the data. */
  finish(): { frames: number; data: Uint8Array } {
    this.drain(true);
    const stride = this.bands + 1;
    const data = new Uint8Array(this.out.length * stride);
    this.out.forEach((f, i) => data.set(f, i * stride));
    return { frames: this.out.length, data };
  }

  private drain(final: boolean) {
    const total = this.q.total;
    const N = SPECTRUM_FFT;
    for (;;) {
      const n = this.next;
      const s0 = Math.floor(n * this.spf);
      if (s0 >= total) break;
      const centre = Math.round((n + 0.5) * this.spf);
      const w0 = centre - N / 2;
      const s1 = Math.floor((n + 1) * this.spf);
      if (!final && (w0 + N > total || s1 > total)) break;
      this.out.push(this.frame(s0, s1, w0, total));
      this.next++;
      this.q.drop(Math.min(Math.round((this.next + 0.5) * this.spf) - N / 2, Math.floor(this.next * this.spf)));
    }
  }

  private frame(s0: number, s1: number, w0: number, total: number): Uint8Array {
    const N = SPECTRUM_FFT;
    const { re, im, win, mag } = this;
    const f = new Uint8Array(this.bands + 1);
    // level: RMS over the frame's own samples
    const len = Math.max(1, Math.min(s1, total) - s0);
    const sp = this.span.subarray(0, len);
    this.q.read(s0, sp);
    let e = 0;
    for (let i = 0; i < len; i++) e += sp[i] * sp[i];
    f[this.bands] = toByte(powDb(e / len) + 3.0103); // RMS of a full-scale sine (−3 dBFS) reads 0, like the bands
    this.q.read(w0, re);
    for (let i = 0; i < N; i++) { re[i] *= win[i]; im[i] = 0; }
    fft(re, im);
    const k = 2 / this.winSum;
    for (let i = 0; i <= N / 2; i++) mag[i] = Math.hypot(re[i], im[i]) * k;
    for (let b = 0; b < this.bands; b++) {
      const { k0, k1, fc } = this.bins[b];
      let m = 0;
      if (k1 >= k0) for (let i = k0; i <= k1 && i <= N / 2; i++) { if (mag[i] > m) m = mag[i]; }
      else {
        const i0 = Math.min(N / 2 - 1, Math.floor(fc)), t = fc - i0;
        m = mag[i0] * (1 - t) + mag[i0 + 1] * t;
      }
      f[b] = toByte(ampDb(m));
    }
    return f;
  }
}

/** Frames of whole samples (tests, the page). */
export function spectrumOf(samples: Float32Array, fps: number, bands = SPECTRUM_BANDS, rate = SPECTRUM_RATE): { frames: number; data: Uint8Array } {
  const b = new SpectrumBuilder(fps, bands, rate);
  b.push(samples);
  return b.finish();
}

export function toSidecar(d: SpectrumData, source?: SpectrumSidecar["source"]): SpectrumSidecar {
  return { format: SPECTRUM_FORMAT, version: 1, mediaId: d.mediaId, fps: d.fps, bands: d.bands, fMin: d.fMin, fMax: d.fMax, rate: SPECTRUM_RATE,
    fft: SPECTRUM_FFT, floorDb: SPECTRUM_FLOOR_DB, frames: d.frames, data: toBase64(d.data), ...(source ? { source } : {}) };
}

/** A sidecar's frames, or null when it isn't one (or doesn't fit what it says). */
export function fromSidecar(j: unknown): SpectrumData | null {
  if (!j || typeof j !== "object") return null;
  const s = j as Partial<SpectrumSidecar>;
  if (s.format !== SPECTRUM_FORMAT || s.version !== 1 || typeof s.data !== "string" || typeof s.mediaId !== "string") return null;
  const bands = Number(s.bands), frames = Number(s.frames), fps = Number(s.fps);
  if (!Number.isInteger(bands) || bands < 4 || bands > 256 || !Number.isInteger(frames) || frames < 0 || !(fps > 0)) return null;
  let data: Uint8Array;
  try { data = fromBase64(s.data); } catch { return null; }
  if (data.length !== frames * (bands + 1)) return null;
  return { mediaId: s.mediaId, fps, bands, fMin: Number(s.fMin) || SPECTRUM_FMIN, fMax: Number(s.fMax) || SPECTRUM_FMAX, frames, data };
}

/** The spectrum frame shown at media time `t` seconds (−1 before the start). */
export const frameAt = (t: number, fps: number) => (t < 0 ? -1 : Math.floor(t * fpsExact(fps) + 1e-4));

// ── which frames an edit needs (the desktop's export fills them in) ─────────────────────────────────────────

/** The fields of a visualiser clip source this module reads (model/types.ts ClipSource "visualizer"). */
export interface VisualizerRef { type: "visualizer"; audioClipId?: string; mediaId?: string; bands?: number }
type ClipLike = { id: string; source: { type: string } };

/** The media a visualiser clip draws: its audio clip's media (same sequence), else its own mediaId. */
export function visualizerMedia(clips: ClipLike[], src: VisualizerRef): string | null {
  if (src.audioClipId) {
    const a = clips.find((c) => c.id === src.audioClipId);
    const s = a?.source as { type: string; mediaId?: string } | undefined;
    if (s?.type === "media" && typeof s.mediaId === "string") return s.mediaId;
  }
  return typeof src.mediaId === "string" && src.mediaId ? src.mediaId : null;
}

/** Every (media, fps, bands) the visualisers of a project need. */
export function spectraNeeded(project: { sequences: { fps: number; clips: ClipLike[] }[] }): { mediaId: string; fps: number; bands: number; key: string }[] {
  const out = new Map<string, { mediaId: string; fps: number; bands: number; key: string }>();
  for (const s of project.sequences) {
    for (const c of s.clips) {
      if (c.source.type !== "visualizer") continue;
      const src = c.source as VisualizerRef;
      const mediaId = visualizerMedia(s.clips, src);
      if (!mediaId) continue;
      const bands = Number.isInteger(src.bands) && src.bands! >= 8 && src.bands! <= 128 ? src.bands! : SPECTRUM_BANDS;
      const key = spectrumKey(mediaId, s.fps, bands);
      out.set(key, { mediaId, fps: s.fps, bands, key });
    }
  }
  return [...out.values()];
}
