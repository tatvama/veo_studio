/**
 * Exact video source (export): mp4box.js demuxes the file, a WebCodecs VideoDecoder (hardware preferred) decodes in
 * order, and decoded frames wait in a small ring keyed by timestamp. getFrame(t) returns the frame whose time is the
 * closest at or before t + half a frame, so frame i of the export is the same source frame FFmpeg's fps filter
 * picks. H.264 and HEVC (and VP9 / AV1 in MP4) go through the decoder; anything it can't decode (or a decoder that
 * fails mid-way) falls back to a <video> with seek-and-wait.
 */
import type { Frame, FrameSource } from "./source";
import { LiveVideo } from "./live.ts";
import { avccSps, matrixName, spsColour, type VideoColour } from "./sps.ts";
import { RefCache } from "../refcache.ts";

interface RawSample { cts: number; dur: number; key: boolean; data: Uint8Array; timescale: number }
interface Sample { ts: number; dur: number; key: boolean; data: Uint8Array }
export interface Demuxed {
  codec: string; width: number; height: number; description?: Uint8Array; samples: Sample[]; pts: number[]; byTs: Map<number, number>;
  /** The stream's colour description (colr box, else the H.264 SPS). */
  colour: VideoColour;
}

/** Demuxed files by URL, held while an ExactVideo (or a lab probe) uses them: two clips of one file share one, and a
 *  file nobody uses any more is let go (a long edit's media would otherwise stay in memory for the session). */
const demuxed = new RefCache<Demuxed>(load);
/** Decoded frames kept (hardware decoders stall when the page holds too many of their surfaces). */
const RING = 6;
const REORDER = 16;

/** Demux a whole MP4 (shared per URL). Pair every call with releaseDemux(url) once done with the samples. */
export function acquireDemux(url: string): Promise<Demuxed> { return demuxed.acquire(url); }
export function releaseDemux(url: string): void { demuxed.release(url); }
/** How many files are demuxed right now (the lab, tests). */
export const demuxedCount = () => demuxed.size;

/** The sample table of a track: times in µs from the earliest sample, the sorted presentation times and the index by
 *  time. A loop rather than Math.min(...spread): a long file has more samples than one call can take arguments. */
export function sampleTable(raw: RawSample[]): Pick<Demuxed, "samples" | "pts" | "byTs"> {
  let min = Infinity;
  for (const s of raw) if (s.cts < min) min = s.cts;
  const samples: Sample[] = new Array(raw.length);
  const byTs = new Map<number, number>();
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    const ts = Math.round(((s.cts - min) / s.timescale) * 1e6);
    samples[i] = { ts, dur: Math.round((s.dur / s.timescale) * 1e6), key: s.key, data: s.data };
    byTs.set(ts, i);
  }
  const pts = new Array<number>(samples.length);
  for (let i = 0; i < samples.length; i++) pts[i] = samples[i].ts;
  pts.sort((a, b) => a - b);
  return { samples, pts, byTs };
}

async function load(url: string): Promise<Demuxed> {
  const MP4Box = await import("mp4box");
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const file = MP4Box.createFile();
  const raw: RawSample[] = [];
  let info: { codec: string; width: number; height: number; id: number } | null = null;
  let error = "";
  file.onError = (_m: string, msg: string) => { error = msg; };
  file.onReady = (movie) => {
    const v = movie.videoTracks[0];
    if (!v) { error = "no video track"; return; }
    info = { codec: v.codec, width: v.video?.width ?? v.track_width, height: v.video?.height ?? v.track_height, id: v.id };
    file.setExtractionOptions(v.id, null, { nbSamples: 100000 });
    file.start();
  };
  file.onSamples = (_id, _u, samples) => {
    for (const s of samples) if (s.data) raw.push({ cts: s.cts, dur: s.duration, key: !!s.is_sync, data: s.data, timescale: s.timescale });
  };
  file.appendBuffer(MP4Box.MP4BoxBuffer.fromArrayBuffer(buf, 0), true);
  file.flush();
  if (error || !info) throw new Error(`${url}: ${error || "not an MP4 file"}`);
  const inf = info as { codec: string; width: number; height: number; id: number };
  let description: Uint8Array | undefined;
  let colour: VideoColour = { tagged: false };
  const trak = file.getTrackById(inf.id) as unknown as { mdia: { minf: { stbl: { stsd: { entries: Record<string, { write(s: unknown): void } | undefined>[] } } } } };
  for (const e of trak.mdia.minf.stbl.stsd.entries) {
    const colr = e.colr as unknown as { colour_type?: string; matrix_coefficients?: number; colour_primaries?: number; transfer_characteristics?: number; full_range_flag?: number } | undefined;
    if (colr?.colour_type === "nclx" && colr.matrix_coefficients !== 2) {
      colour = { tagged: true, matrix: colr.matrix_coefficients, primaries: colr.colour_primaries, transfer: colr.transfer_characteristics, fullRange: !!colr.full_range_flag };
    }
    const box = e.avcC || e.hvcC || e.vpcC || e.av1C;
    if (box) {
      const ds = new MP4Box.DataStream(undefined, 0, MP4Box.Endianness.BIG_ENDIAN);
      box.write(ds);
      description = new Uint8Array((ds as unknown as { buffer: ArrayBuffer }).buffer, 8);  // without the box header
      if (!colour.tagged && e.avcC) {
        for (const sps of avccSps(description)) { try { const c = spsColour(sps); if (c.tagged || c.fullRange) colour = c; } catch { /* odd SPS */ } }
      }
      break;
    }
  }
  if (!raw.length) throw new Error(`${url}: no video samples`);
  return { codec: inf.codec, width: inf.width, height: inf.height, description, ...sampleTable(raw), colour };
}

export class ExactVideo implements FrameSource {
  readonly kind = "video" as const;
  readonly ready: Promise<void>;
  private url: string;
  private fps: number;
  private d: Demuxed | null = null;
  private dec: VideoDecoder | null = null;
  private config: VideoDecoderConfig | null = null;
  private fallback: LiveVideo | null = null;
  private ring = new Map<number, VideoFrame>();
  private fed = 0;
  private flushed = false;
  private outMax = -1;
  private err: Error | null = null;
  private signal: (() => void) | null = null;
  private want = -1;
  private lastOut = 0;
  private version = 0;
  /** The last frame handed out; null once its VideoFrame was closed (never handed out again). */
  private last: Frame | null = null;
  private buf: Uint8Array | null = null;
  /** Holding the demuxed file (released on dispose, or once the <video> fallback takes over). */
  private held = false;
  private disposed = false;
  /** Hand the GPU the decoded planes (exact colour) instead of the browser's RGB conversion. */
  raw = true;
  /** "hardware" / "software" / "fallback" once known. */
  path = "";
  /** The stream's colour description, once demuxed. */
  get colour(): VideoColour | undefined { return this.d?.colour; }

  constructor(url: string, fps = 24) {
    this.url = url;
    this.fps = fps;
    this.ready = this.init();
    this.ready.catch(() => undefined);
  }

  private async init() {
    try {
      if (typeof VideoDecoder === "undefined") throw new Error("WebCodecs isn't available");
      this.held = true;
      const d = await acquireDemux(this.url);
      if (this.disposed) return;
      const base: VideoDecoderConfig = { codec: d.codec, codedWidth: d.width, codedHeight: d.height, description: d.description, optimizeForLatency: false };
      for (const hw of ["prefer-hardware", "no-preference"] as HardwareAcceleration[]) {
        const c = { ...base, hardwareAcceleration: hw };
        if ((await VideoDecoder.isConfigSupported(c)).supported) { this.config = c; this.path = hw === "prefer-hardware" ? "hardware" : "software"; break; }
      }
      if (this.disposed) return;
      if (!this.config) throw new Error(`${d.codec} can't be decoded here`);
      this.d = d;
      this.open();
    } catch (e) {
      if (this.disposed) return;
      console.warn("[engine] exact decode unavailable, seeking a <video> instead:", (e as Error).message);
      await this.useFallback();
    }
  }

  /** From now on the frames come from a <video> (WebCodecs can't decode the file, or its decoder failed). */
  private async useFallback() {
    this.path = "fallback";
    this.closeDecoder();
    this.releaseDemux();
    this.d = null;
    if (!this.fallback) this.fallback = new LiveVideo(this.url, this.fps);
    await this.fallback.ready;
  }

  private releaseDemux() {
    if (!this.held) return;
    this.held = false;
    releaseDemux(this.url);
  }

  /** Closes a decoded frame; the Frame that wrapped it is forgotten so it is never handed out again. */
  private closeFrame(f: VideoFrame) {
    if (this.last?.image === f) this.last = null;
    try { f.close(); } catch { /* closed already */ }
  }

  private closeDecoder() {
    for (const f of this.ring.values()) this.closeFrame(f);
    this.ring.clear();
    // closing an already closed codec (after an error) throws InvalidStateError
    try { this.dec?.close(); } catch { /* closed already */ }
    this.dec = null;
  }

  private open() {
    this.closeDecoder();
    this.dec = new VideoDecoder({
      output: (f) => {
        const old = this.ring.get(f.timestamp);
        if (old) this.closeFrame(old);
        this.ring.set(f.timestamp, f);
        this.outMax = Math.max(this.outMax, f.timestamp);
        this.lastOut = performance.now();
        this.evict(this.want);  // the oldest go first: forward requests drop what they passed, backward ones find the frames before
        this.wake();
      },
      error: (e) => { this.err = e instanceof Error ? e : new Error(String(e)); this.wake(); },
    });
    this.dec.addEventListener("dequeue", () => this.wake());
    this.dec.configure(this.config!);
    this.fed = 0; this.flushed = false; this.outMax = -1;
  }

  private wake() { const s = this.signal; this.signal = null; s?.(); }
  private wait(ms = 100) { return new Promise<void>((res) => { this.signal = res; setTimeout(res, ms); }); }

  /** The presentation time (µs) to show for source time t. */
  private pick(t: number): number {
    const pts = this.d!.pts;
    const lim = Math.round((t + 0.5 / this.fps) * 1e6);
    let lo = 0, hi = pts.length - 1, best = pts[0];
    while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m] <= lim) { best = pts[m]; lo = m + 1; } else hi = m - 1; }
    return best;
  }

  private evict(keep: number) {
    if (this.ring.size <= RING) return;
    const ts = [...this.ring.keys()].sort((a, b) => a - b);
    for (const k of ts) {
      if (this.ring.size <= RING) break;
      if (k === keep) continue;
      this.closeFrame(this.ring.get(k)!);
      this.ring.delete(k);
    }
  }

  async exact(t: number): Promise<Frame | null> {
    await this.ready;
    if (this.fallback) return this.fallback.exact(t);
    const d = this.d!;
    const us = this.pick(t);
    const idx = d.byTs.get(us)!;
    let key = idx;
    while (key > 0 && !d.samples[key].key) key--;
    let restarts = 0;
    const restart = () => { restarts++; this.open(); this.fed = key; };
    if (!this.ring.has(us)) {
      if (key > this.fed || this.flushed || (this.outMax >= us) || this.fed > idx + REORDER) restart();
    }
    this.want = us;
    this.lastOut = performance.now();
    while (!this.ring.has(us)) {
      if (this.err) {
        // the decoder gave up on this file (a stream it can't handle after all): the <video> takes over for good
        const e = this.err; this.err = null;
        console.warn("[engine] exact decode failed, seeking a <video> instead:", e.message);
        try { await this.useFallback(); } catch (fe) { throw new Error(`${this.url}: ${e.message}; and the <video> fallback failed: ${(fe as Error).message}`); }
        return this.fallback!.exact(t);
      }
      if (performance.now() - this.lastOut > 5000) { this.open(); throw new Error(`${this.url}: the video decoder stopped answering`); }
      if (this.outMax >= us) {  // went past it (dropped or evicted): decode the GOP again, once
        if (restarts > 1) break;
        restart();
      }
      const dec = this.dec!;
      if (this.fed < d.samples.length && !this.flushed) {
        if (dec.decodeQueueSize >= 6) { await this.wait(); continue; }
        const s = d.samples[this.fed++];
        dec.decode(new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: s.ts, duration: s.dur, data: s.data }));
        if (this.fed > idx + 1 && dec.decodeQueueSize > 0) await this.wait(20);
      } else if (!this.flushed) { this.flushed = true; await dec.flush(); }
      else break;
    }
    let f = this.ring.get(us) ?? null;
    if (!f) {  // the nearest decoded frame at or before it
      const k = [...this.ring.keys()].filter((x) => x <= us).sort((a, b) => b - a)[0];
      f = k !== undefined ? this.ring.get(k)! : null;
    }
    if (!f) return this.last;  // null once its frame was closed: a closed frame is never handed out
    this.evict(us);
    this.version++;
    this.last = { image: f, width: f.displayWidth, height: f.displayHeight, version: this.version };
    if (this.raw && (f.format === "NV12" || f.format === "I420")) {
      try {
        const n = f.allocationSize();
        if (!this.buf || this.buf.length < n) this.buf = new Uint8Array(n);
        const layout = await f.copyTo(this.buf);
        const c = d.colour;
        this.last.yuv = { format: f.format, data: this.buf, layout: layout.map((l) => ({ offset: l.offset, stride: l.stride })),
          fullRange: c.fullRange ?? f.colorSpace.fullRange ?? false, ffmpeg601: !(c.tagged && matrixName(c.matrix) === "bt709") };
      } catch (e) { console.warn("[engine] copyTo failed, using the browser's RGB:", (e as Error).message); this.raw = false; }
    }
    return this.last;
  }

  live(): Frame | null { return this.last; }
  idle(): void { this.fallback?.idle(); }
  dispose(): void {
    this.disposed = true;
    this.closeDecoder();
    this.last = null;
    this.releaseDemux();
    this.fallback?.dispose();
  }
}
