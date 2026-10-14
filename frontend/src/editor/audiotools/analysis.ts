/**
 * Where the audio tools get their numbers (docs/EDITOR.md §15.4): Tatvam Desktop's analysis
 * (`bridge.editor.audioAnalysis`, `analyze(…, "loudness", {in, out})`) when it is there, else the page decodes the
 * media itself (OfflineAudioContext, resampled to the analysis rate) and runs the same pure code. Media seconds
 * throughout.
 */
import { editorBridge, type AudioAnalysisResult } from "../../lib/desktop";
import { Biquad, kWeighting, measureLoudness } from "../audiofx/loudness";
import type { MediaItem, TimelineClip } from "../model/types";
import { framesToSeconds } from "../model/time";
import { audioUrlFor, ed, project, seq } from "../store";
import { detectBreaths, type BreathRange } from "./breaths";
import { lufsOfPower } from "../audiofx/loudness";
import { FEATURE_RATE, featuresOf } from "./features";
import { findRoomTone, quietThreshold, silenceSegments, type RoomTone } from "./roomtone";
import { fromSidecar, SPECTRUM_FMAX, SPECTRUM_FMIN, SPECTRUM_RATE, spectrumOf, type SpectrumData } from "./spectrum";

const mediaOf = (id: string) => project().media.find((m) => m.id === id);

/** A clip's media and the stretch of it the clip plays (media seconds, out exclusive). */
export function clipRange(c: TimelineClip): { media: MediaItem; in: number; out: number } | null {
  if (c.source.type !== "media") return null;
  const m = mediaOf(c.source.mediaId);
  if (!m) return null;
  const s = seq();
  const mfps = m.fps > 0 ? m.fps : s.fps;
  const a = framesToSeconds(c.source.in, mfps);
  return { media: m, in: a, out: a + framesToSeconds(c.duration, s.fps) * (c.speed > 0 ? c.speed : 1) };
}

const desk = () => {
  const b = editorBridge(), path = ed().path;
  return b && path && !ed().demo ? { b, path } : null;
};

// ── the page's own decoding ───────────────────────────────────────────────────────────────────────────────

const decoded = new Map<string, Promise<Float32Array[] | null>>();
/** A media's channels at `rate` (decoded once per media and rate; the whole file). */
async function decode(m: MediaItem, rate: number): Promise<Float32Array[] | null> {
  const url = audioUrlFor(m);
  if (!url) return null;
  const key = `${m.id}|${rate}|${url}`;
  let p = decoded.get(key);
  if (!p) {
    p = (async () => {
      try {
        const buf = await (await fetch(url, { credentials: "include" })).arrayBuffer();
        const a = await new OfflineAudioContext(1, 1, rate).decodeAudioData(buf);
        return Array.from({ length: Math.min(2, a.numberOfChannels) }, (_, c) => a.getChannelData(c));
      } catch { return null; }
    })();
    decoded.set(key, p);
    if (decoded.size > 6) decoded.delete(decoded.keys().next().value as string);
  }
  return p;
}
/** Mono samples of a media at `rate`. */
async function decodeMono(m: MediaItem, rate: number): Promise<Float32Array | null> {
  const ch = await decode(m, rate);
  if (!ch?.length) return null;
  if (ch.length === 1) return ch[0];
  const out = new Float32Array(ch[0].length);
  for (let i = 0; i < out.length; i++) out[i] = (ch[0][i] + ch[1][i]) / 2;
  return out;
}
const slice = (x: Float32Array, rate: number, a = 0, b = Infinity) => x.subarray(Math.max(0, Math.floor(a * rate)), Math.min(x.length, Math.ceil(b * rate)));

// ── loudness ───────────────────────────────────────────────────────────────────────────────────────────────

/** Ungated K-weighted loudness of samples (LUFS): for clips too short for BS.1770's 400 ms blocks (SFX hits). */
export function shortLoudness(ch: Float32Array[], fs: number): number {
  const [s, h] = kWeighting(fs);
  let e = 0, n = 0;
  for (const x of ch) {
    const a = new Biquad(s), b = new Biquad(h);
    for (let i = 0; i < x.length; i++) { const y = b.step(a.step(x[i])); e += y * y; }
    n = Math.max(n, x.length);
  }
  return n ? lufsOfPower(e / n) : -Infinity;
}

/** A clip's integrated loudness over its own range (LUFS; null when it can't be measured). Clips under 0.6 s are
 *  measured in the page, ungated (an SFX hit has no full 400 ms block). */
export async function clipLoudness(c: TimelineClip): Promise<number | null> {
  const r = clipRange(c);
  if (!r) return null;
  const short = r.out - r.in < 0.6;
  const d = desk();
  if (d && !short) {
    try {
      const x = await d.b.analyze(d.path, r.media.id, "loudness", { in: r.in, out: r.out });
      if (x.kind === "loudness" && x.lufs !== null && Number.isFinite(x.lufs) && x.lufs > -69) return x.lufs;
    } catch { /* measure here */ }
  }
  const rate = 48000;
  const ch = await decode(r.media, rate);
  if (!ch?.length) return null;
  // the channels as the mix gets them: a mono source pans with constant power, so it measures as one channel
  const parts = ch.map((x) => slice(x, rate, r.in, r.out));
  if (!parts[0].length) return null;
  const l = short ? shortLoudness(parts, rate) : measureLoudness(parts, rate).lufs;
  return Number.isFinite(l) && l > -69 ? Math.round(l * 10) / 10 : null;
}

// ── breaths and room tone ────────────────────────────────────────────────────────────────────────────────

export async function analyzeBreaths(m: MediaItem, range: { in: number; out: number }, threshold: number): Promise<{ breaths: BreathRange[]; speech: { start: number; end: number }[]; noiseFloorDb: number; source: "desktop" | "page" } | null> {
  const d = desk();
  if (d?.b.audioAnalysis) {
    const r = await d.b.audioAnalysis(d.path, m.id, "breaths", { in: range.in, out: range.out, threshold });
    if (r.kind === "breaths") return { ...r, source: "desktop" };
  }
  const x = await decodeMono(m, FEATURE_RATE);
  if (!x) return null;
  const f = featuresOf(slice(x, FEATURE_RATE, range.in, range.out));
  const res = detectBreaths(f, { threshold });
  const sh = (t: number) => Math.round((t + range.in) * 1000) / 1000;
  return { breaths: res.breaths.map((b) => ({ ...b, start: sh(b.start), end: sh(b.end) })), speech: res.speech.map((s) => ({ start: sh(s.start), end: sh(s.end) })),
    noiseFloorDb: res.noiseFloorDb, source: "page" };
}

export async function analyzeRoomTone(m: MediaItem, opts: { minS?: number; maxS?: number } = {}): Promise<{ stretch: RoomTone | null; thresholdDb: number; source: "desktop" | "page" } | null> {
  const d = desk();
  if (d?.b.audioAnalysis) {
    const r = await d.b.audioAnalysis(d.path, m.id, "roomtone", opts);
    if (r.kind === "roomtone") return { stretch: r.stretch, thresholdDb: r.thresholdDb, source: "desktop" };
  }
  const x = await decodeMono(m, FEATURE_RATE);
  if (!x) return null;
  const f = featuresOf(x, FEATURE_RATE, { spectral: false });
  const thr = quietThreshold(f.rms);
  return { stretch: findRoomTone(f.rms, f.hopS, silenceSegments(f.rms, f.hopS, thr, 0.5), opts), thresholdDb: thr, source: "page" };
}

// ── spectrum frames ───────────────────────────────────────────────────────────────────────────────────────

/** The visualiser's frames for a media: the desktop's sidecar (made when missing), else decoded here. */
export async function loadSpectrum(mediaId: string, fps: number, bands: number): Promise<SpectrumData | null> {
  const m = mediaOf(mediaId);
  if (!m || (!m.hasAudio && m.kind !== "audio")) return null;
  const d = desk();
  if (d?.b.audioAnalysis) {
    const r: AudioAnalysisResult = await d.b.audioAnalysis(d.path, mediaId, "spectrum", { fps, bands });
    return r.kind === "spectrum" ? fromSidecar(r.spectrum) : null;
  }
  const x = await decodeMono(m, SPECTRUM_RATE);
  if (!x) return null;
  const s = spectrumOf(x, fps, bands);
  return { mediaId, fps, bands, fMin: SPECTRUM_FMIN, fMax: SPECTRUM_FMAX, frames: s.frames, data: s.data };
}
