/**
 * Audio effect auditions (preview-polish): a short sample played through an effect (or a chain preset) with a
 * Before / After switch, so what you hear is the real effect — the preview's own WebAudio effects (audiofx/graph.ts)
 * rendered offline (audiofx/offline.ts renderOffline) with the effect's default parameters, as a seamless loop (the
 * sample twice, the second pass kept, so reverbs and echoes are in steady state).
 *
 * The sample is the selected audio clip's first 4 s (from its in point) when there is one, else a procedural loop
 * (audioSample.ts: a music loop, or a voice-like phrase for voice tools). One audition plays at a time, at a polite
 * level (−6 dB), through an AnalyserNode the wave bars draw from; it stops when another starts or the program plays.
 */
import { renderOffline } from "../audiofx/offline";
import { audioFxDef, type AudioParamValue } from "../audiofx/registry";
import { kindOf } from "../model/ops";
import { program } from "../playback/transport";
import { audioUrlFor, ed, project, seq } from "../store";
import { audioSample, peaks, sampleKindFor, AUDIO_SAMPLE_LABEL, SAMPLE_RATE, SAMPLE_SECONDS, type AudioSampleKind } from "./audioSample";
import { versionOf } from "./keys";
import { scheduler } from "./service";

export interface AuditionChain {
  /** Stable per row: "fx:<id>" or "preset:<id>". */
  key: string;
  effects: { id: string; values?: Record<string, AudioParamValue> }[];
  /** The registry group or the preset group (picks the procedural sample). */
  group?: string;
}

/** A sample: procedural, or the user's clip. */
export interface AuditionSample { key: string; label: string; ch: Float32Array[] }

export interface Audition {
  key: string; sample: AuditionSample;
  before: Float32Array[]; after: Float32Array[];
  /** Peaks of the after signal (the static mini waveform). */
  peaks: number[];
  /** Effects WebAudio can't play the export's way (heard dry here). */
  dry: string[];
}

const SR = SAMPLE_RATE;

// ── samples ─────────────────────────────────────────────────────────────────────────────────────────────

export function proceduralSample(kind: AudioSampleKind): AuditionSample {
  return { key: `proc:${kind}`, label: AUDIO_SAMPLE_LABEL[kind], ch: audioSample(kind) };
}

let decodeCtx: OfflineAudioContext | null = null;
const decoder = () => (decodeCtx ??= new OfflineAudioContext(2, SR, SR));

/** The WAV's fmt and data positions from its first bytes. */
function wavLayout(b: DataView): { channels: number; rate: number; bits: number; format: number; dataAt: number; dataLen: number } | null {
  if (b.byteLength < 44 || b.getUint32(0, false) !== 0x52494646 || b.getUint32(8, false) !== 0x57415645) return null;
  let p = 12, fmt: { channels: number; rate: number; bits: number; format: number } | null = null;
  while (p + 8 <= b.byteLength) {
    const id = b.getUint32(p, false), len = b.getUint32(p + 4, true);
    if (id === 0x666d7420) fmt = { format: b.getUint16(p + 8, true), channels: b.getUint16(p + 10, true), rate: b.getUint32(p + 12, true), bits: b.getUint16(p + 22, true) };
    else if (id === 0x64617461) return fmt ? { ...fmt, dataAt: p + 8, dataLen: len } : null;
    p += 8 + len + (len & 1);
  }
  return null;
}

/** A WAV header for `len` data bytes in a format. */
function wavHeader(f: { channels: number; rate: number; bits: number; format: number }, len: number): Uint8Array {
  const h = new DataView(new ArrayBuffer(44)), ba = f.channels * (f.bits / 8);
  h.setUint32(0, 0x52494646, false); h.setUint32(4, 36 + len, true); h.setUint32(8, 0x57415645, false);
  h.setUint32(12, 0x666d7420, false); h.setUint32(16, 16, true); h.setUint16(20, f.format === 0xfffe ? (f.bits === 32 ? 3 : 1) : f.format, true);
  h.setUint16(22, f.channels, true); h.setUint32(24, f.rate, true); h.setUint32(28, f.rate * ba, true); h.setUint16(32, ba, true); h.setUint16(34, f.bits, true);
  h.setUint32(36, 0x64617461, false); h.setUint32(40, len, true);
  return new Uint8Array(h.buffer);
}

const toStereo = (b: AudioBuffer, from: number, n: number): Float32Array[] => {
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(Math.min(c, b.numberOfChannels - 1)); out[c].set(d.subarray(from, Math.min(d.length, from + n))); }
  return out;
};

/** `seconds` of a media URL from `start`: WAV files by byte range (any length), others decoded whole (≤ 3 min). */
async function readSpan(url: string, start: number, seconds: number, mediaSeconds: number): Promise<Float32Array[] | null> {
  const n = Math.round(seconds * SR);
  try {
    const head = await fetch(url, { headers: { Range: "bytes=0-131071" }, credentials: "include" });
    if (!head.ok) return null;
    const hb = await head.arrayBuffer();
    const lay = wavLayout(new DataView(hb));
    if (lay && lay.bits >= 8) {
      const ba = lay.channels * (lay.bits / 8);
      const a = lay.dataAt + Math.floor(start * lay.rate) * ba, len = Math.min(lay.dataLen - (a - lay.dataAt), Math.ceil(seconds * lay.rate) * ba);
      if (len <= ba) return null;
      let body: ArrayBuffer;
      if (head.status === 200 && hb.byteLength >= a + len) body = hb.slice(a, a + len);
      else {
        const r = await fetch(url, { headers: { Range: `bytes=${a}-${a + len - 1}` }, credentials: "include" });
        if (!r.ok) return null;
        const all = await r.arrayBuffer();
        body = r.status === 206 ? all : all.slice(a, a + len);
      }
      const bytes = new Uint8Array(44 + body.byteLength);
      bytes.set(wavHeader(lay, body.byteLength)); bytes.set(new Uint8Array(body), 44);
      const buf = await decoder().decodeAudioData(bytes.buffer);
      return toStereo(buf, 0, n);
    }
    if (!(mediaSeconds > 0 && mediaSeconds <= 180)) return null;
    const whole = head.status === 200 ? hb : await (await fetch(url, { credentials: "include" })).arrayBuffer();
    const buf = await decoder().decodeAudioData(whole);
    return toStereo(buf, Math.round(start * buf.sampleRate), n);
  } catch { return null; }
}

const clipSamples = new Map<string, Promise<AuditionSample | null>>();

/** The selected audio clip's first 4 s (from its in point), or null. */
export function selectedClipSample(): { key: string; load: () => Promise<AuditionSample | null>; name: string } | null {
  const s = seq(), sel = ed().selection;
  const c = s.clips.find((x) => sel.includes(x.id) && x.source.type === "media" && (kindOf(s, x) === "audio" || !!x.audio));
  if (!c || c.source.type !== "media") return null;
  const mediaId = c.source.mediaId, inFrames = c.source.in;
  const m = project().media.find((x) => x.id === mediaId);
  if (!m || (!m.hasAudio && m.kind !== "audio")) return null;
  const url = audioUrlFor(m);
  if (!url) return null;
  const start = m.fps > 0 ? inFrames / m.fps : 0;
  const key = `clip:${m.id}@${start.toFixed(2)}`;
  const mediaSeconds = m.seconds ?? (m.fps > 0 ? m.duration / m.fps : 0);
  return {
    key, name: c.name,
    load: () => {
      let p = clipSamples.get(key);
      if (!p) {
        p = readSpan(url, start, SAMPLE_SECONDS, mediaSeconds).then((ch) => (ch ? { key, label: `your clip “${c.name}”`, ch } : null));
        clipSamples.set(key, p);
        if (clipSamples.size > 6) clipSamples.delete(clipSamples.keys().next().value as string);
      }
      return p;
    },
  };
}

// ── renders ─────────────────────────────────────────────────────────────────────────────────────────────

const renders = new Map<string, Promise<Audition>>();
const PEAKS_LS = "tatvam-editor:afx-peaks:v1";
const storedPeaks: Record<string, number[]> = (() => { try { return JSON.parse(localStorage.getItem(PEAKS_LS) || "{}"); } catch { return {}; } })();
const peakSubs = new Set<() => void>();

const chainSig = (c: AuditionChain) => versionOf(c.effects);
export const peaksKey = (c: AuditionChain, sampleKey: string) => `${c.key}|${chainSig(c)}|${sampleKey}`;
export const knownPeaks = (c: AuditionChain, sampleKey: string): number[] | undefined => storedPeaks[peaksKey(c, sampleKey)];
export function onPeaks(cb: () => void) { peakSubs.add(cb); return () => { peakSubs.delete(cb); }; }

/** The procedural sample a chain plays when no clip is selected. */
export const sampleKindOf = (c: AuditionChain): AudioSampleKind => sampleKindFor(c.key.startsWith("preset:") ? c.key : c.effects.map((e) => e.id).join(" "), c.group ?? audioFxDef(c.effects[0]?.id ?? "")?.group ?? "");

/** A chain on a sample: the before signal, the after loop (steady state) and its peaks (cached). */
export function audition(c: AuditionChain, sample: AuditionSample): Promise<Audition> {
  const key = peaksKey(c, sample.key);
  let p = renders.get(key);
  if (!p) {
    p = (async () => {
      const dry = c.effects.filter((e) => audioFxDef(e.id)?.preview !== "realtime").map((e) => audioFxDef(e.id)?.label ?? e.id);
      const live = c.effects.filter((e) => audioFxDef(e.id)?.preview === "realtime");
      const x = sample.ch, n = x[0].length;
      let after: Float32Array[] = x;
      if (live.length) {
        const two = x.map((ch) => { const d = new Float32Array(n * 2); d.set(ch); d.set(ch, n); return d; });
        const out = await renderOffline(two, SR, live.map((e) => ({ id: e.id, values: e.values })), 0);
        after = out.map((ch) => ch.slice(n, 2 * n));
      }
      const pk = peaks(after, 48);
      if (sample.key.startsWith("proc:")) {
        storedPeaks[key] = pk;
        try { localStorage.setItem(PEAKS_LS, JSON.stringify(storedPeaks)); } catch { /* full */ }
      }
      peakSubs.forEach((f) => f());
      return { key, sample, before: x, after, peaks: pk, dry };
    })();
    renders.set(key, p);
    p.catch(() => renders.delete(key));
    while (renders.size > 24) renders.delete(renders.keys().next().value as string);
  }
  return p;
}

/** Renders a chain's waveform in idle time (for rows on screen). */
export function wantPeaks(c: AuditionChain, wanted: () => boolean) {
  const kind = sampleKindOf(c);
  const sk = `proc:${kind}`;
  if (knownPeaks(c, sk)) return;
  scheduler.add({ key: `afx:${peaksKey(c, sk)}`, priority: 4, wanted, run: () => audition(c, proceduralSample(kind)).catch(() => undefined) });
}

// ── playback ────────────────────────────────────────────────────────────────────────────────────────────

export const PREVIEW_GAIN = 0.5;
type Which = "before" | "after";
interface Playing { key: string; which: Which; a: Audition; src: AudioBufferSourceNode; gain: GainNode; started: number; offset: number; until: number }

class AuditionPlayer {
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  private out: GainNode | null = null;
  private cur: Playing | null = null;
  private subs = new Set<() => void>();
  private stopTimer = 0;
  /** "loading" while the sample renders. */
  pending: string | null = null;
  constructor() { program.subscribeState(() => { if (program.playing) this.stop(); }); }

  private ensure() {
    if (!this.ctx) {
      try { this.ctx = new AudioContext({ sampleRate: SR, latencyHint: "interactive" }); } catch { this.ctx = new AudioContext(); }
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024; this.analyser.smoothingTimeConstant = 0.6;
      this.out = this.ctx.createGain(); this.out.gain.value = PREVIEW_GAIN;
      this.analyser.connect(this.out).connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
    return this.ctx;
  }
  private emit() { this.subs.forEach((f) => f()); }
  subscribe(cb: () => void) { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  get key() { return this.cur?.key ?? null; }
  get which(): Which { return this.cur?.which ?? "after"; }
  get audition() { return this.cur?.a ?? null; }
  /** Seconds into the loop. */
  position(): number { const c = this.cur, x = this.ctx; if (!c || !x) return 0; return (c.offset + (x.currentTime - c.started)) % SAMPLE_SECONDS; }

  private buffer(a: Audition, which: Which): AudioBuffer {
    const ctx = this.ensure();
    const ch = which === "after" ? a.after : a.before;
    const b = ctx.createBuffer(2, ch[0].length, SR);
    b.copyToChannel(ch[0] as Float32Array<ArrayBuffer>, 0); b.copyToChannel((ch[1] ?? ch[0]) as Float32Array<ArrayBuffer>, 1);
    return b;
  }

  private start(key: string, a: Audition, which: Which, offset: number, loops: number) {
    const ctx = this.ensure();
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = this.buffer(a, which); src.loop = true;
    g.gain.setValueAtTime(0, ctx.currentTime); g.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.015);
    src.connect(g).connect(this.analyser!);
    src.start(ctx.currentTime, offset % SAMPLE_SECONDS);
    const until = ctx.currentTime + loops * SAMPLE_SECONDS - offset;
    this.cur = { key, which, a, src, gain: g, started: ctx.currentTime, offset, until };
    window.clearTimeout(this.stopTimer);
    this.stopTimer = window.setTimeout(() => { if (this.cur?.src === src) this.stop(); }, (until - ctx.currentTime) * 1000);
  }

  private fadeOut(p: Playing) {
    const t = this.ctx!.currentTime;
    try { p.gain.gain.cancelScheduledValues(t); p.gain.gain.setValueAtTime(p.gain.gain.value, t); p.gain.gain.linearRampToValueAtTime(0, t + 0.02); p.src.stop(t + 0.03); } catch { /* stopped */ }
  }

  /** Plays a chain (after) on the sample, looping `loops` times; stops whatever played. */
  async play(c: AuditionChain, sample: AuditionSample | Promise<AuditionSample | null>, loops = 3, which: Which = "after") {
    this.stop();
    this.pending = c.key; this.emit();
    this.ensure();
    try {
      const s = (await sample) ?? proceduralSample(sampleKindOf(c));
      const a = await audition(c, s);
      if (this.pending !== c.key) return;
      this.pending = null;
      this.start(c.key, a, which, 0, loops);
    } catch (e) { console.warn("[preview] audition", e); if (this.pending === c.key) this.pending = null; }
    this.emit();
  }

  /** Before / after at the same place in the loop. */
  setWhich(which: Which) {
    const p = this.cur;
    if (!p || p.which === which) return;
    const off = this.position(), left = Math.max(1, Math.round((p.until - this.ctx!.currentTime) / SAMPLE_SECONDS));
    this.fadeOut(p);
    this.start(p.key, p.a, which, off, left);
    this.emit();
  }

  stop(key?: string) {
    if (key && this.cur?.key !== key && this.pending !== key) return;
    this.pending = null;
    if (this.cur) { this.fadeOut(this.cur); this.cur = null; }
    window.clearTimeout(this.stopTimer);
    this.emit();
  }
}

export const auditions = new AuditionPlayer();
